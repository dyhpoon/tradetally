jest.mock('@vercel/functions', () => ({ waitUntil: jest.fn() }));
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/imageProcessor', () => ({}));
jest.mock('../../src/utils/imageStorage', () => ({}));
jest.mock('../../src/utils/logger', () => ({ logImport: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
jest.mock('../../src/models/Trade', () => ({ create: jest.fn(), update: jest.fn() }));
jest.mock('../../src/models/User', () => ({ getSettings: jest.fn().mockResolvedValue({ timezone: 'UTC' }) }));
jest.mock('../../src/services/tierService', () => ({ canImportTrades: jest.fn().mockResolvedValue({ allowed: true, tier: 'pro' }) }));
jest.mock('../../src/services/feeProfileService', () => ({ getImportFeeConfiguration: jest.fn().mockResolvedValue({ assignments: [], feeRows: [] }) }));
jest.mock('../../src/utils/csvParser', () => ({
  parseCSV: jest.fn(),
  getCsvHeaderLine: jest.fn().mockReturnValue('Symbol'),
  getCsvSampleRows: jest.fn().mockReturnValue('TSLA'),
  detectBrokerFormat: jest.fn().mockReturnValue('generic')
}));
jest.mock('../../src/utils/currencyConverter', () => ({
  convertTradeToUSD: jest.fn(async trade => trade),
  userHasProAccess: jest.fn().mockResolvedValue(false)
}));
jest.mock('../../src/services/brokerFeeApplicationService', () => ({
  getBrokerLookupNames: jest.fn().mockReturnValue({ brokersToLookup: ['generic'], expandedBrokersToLookup: ['generic'] }),
  applyBrokerFeeSettingsToTrades: jest.fn(({ trades }) => trades)
}));
jest.mock('../../src/services/optionStrategyGroupingService', () => ({ rebuildUserGroupsSafe: jest.fn().mockResolvedValue() }));
jest.mock('../../src/services/analyticsCache', () => ({ invalidate: jest.fn().mockResolvedValue() }));
jest.mock('../../src/events/domainEvents', () => ({ publishInBackground: jest.fn() }));

const controller = require('../../src/controllers/trade.controller');
const db = require('../../src/config/database');
const Trade = require('../../src/models/Trade');
const { parseCSV } = require('../../src/utils/csvParser');
const { waitUntil } = require('@vercel/functions');
const originalEnv = process.env;

function parsedTrades() {
  return {
    trades: ['TSLA', 'AAPL'].map(symbol => ({
      symbol, side: 'long', quantity: 1, entryPrice: 100, exitPrice: 101,
      entryTime: '2026-09-17T14:00:00Z', exitTime: '2026-09-17T14:01:00Z',
      tradeDate: '2026-09-17', commission: 0, fees: 0
    })),
    diagnostics: { totalRows: 2, skippedRows: 0, invalidRows: 0, warnings: [] }
  };
}

function request() {
  return {
    user: { id: 'user' }, headers: { 'content-type': 'multipart/form-data' },
    body: { broker: 'generic', account_mode: 'none' },
    file: { originalname: 'trades.csv', buffer: Buffer.from('Symbol\nTSLA\nAAPL') }
  };
}

beforeEach(() => {
  process.env = { ...originalEnv, SERVERLESS_RUNTIME: 'vercel' };
  delete process.env.VERCEL;
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  Trade.create.mockResolvedValue({ id: 'trade' });
  parseCSV.mockResolvedValue(parsedTrades());
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

test('acknowledges the upload and attaches the full import promise to the Vercel request', async () => {
  let finishParsing;
  const parsing = new Promise(resolve => { finishParsing = resolve; });
  parseCSV.mockReturnValueOnce(parsing);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();

  await controller.importTrades(request(), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(202);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  expect(Trade.create).not.toHaveBeenCalled();
  finishParsing(parsedTrades());
  await waitUntil.mock.calls[0][0];

  expect(Trade.create).toHaveBeenCalledTimes(2);
  const completed = db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'completed'"));
  expect(completed[0]).toContain("AND status = 'processing'");
  expect(completed[1].slice(0, 2)).toEqual([2, 0]);
});

test('stops starting new rows at the deadline and reports partial counts without success', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  Trade.create.mockImplementationOnce(async () => {
    now += 240001;
    return { id: 'first-trade' };
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

  await controller.importTrades(request(), res, jest.fn());
  await waitUntil.mock.calls[0][0];

  expect(Trade.create).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(false);
  const failed = db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'failed'"));
  expect(failed[1][0].error).toContain('Some trades may already be saved');
  expect(failed[1].slice(2)).toEqual([1, 0]);
});

test('records a timeout while parsing is pending and prevents later trade writes', async () => {
  let finishParsing;
  parseCSV.mockReturnValueOnce(new Promise(resolve => { finishParsing = resolve; }));
  let fireTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementationOnce((callback, delay) => {
    expect(delay).toBe(240000);
    fireTimeout = callback;
    return {};
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

  await controller.importTrades(request(), res, jest.fn());
  await fireTimeout();

  const failed = db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'failed'"));
  expect(failed[0]).toContain("AND status = 'processing'");
  expect(failed[1][0].error).toContain('4-minute limit');
  finishParsing(parsedTrades());
  await waitUntil.mock.calls[0][0];
  expect(Trade.create).not.toHaveBeenCalled();
  expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(false);
});

test('marks imports interrupted by instance termination as failed only for their owner', async () => {
  db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
  db.query.mockResolvedValueOnce({ rows: [{ id: 'import', status: 'failed' }] });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

  await controller.getImportStatus({ params: { importId: 'import' }, user: { id: 'owner' } }, res, jest.fn());

  expect(db.query.mock.calls[0][0]).toContain('user_id = $2');
  expect(db.query.mock.calls[0][0]).toContain("INTERVAL '5 minutes'");
  expect(db.query.mock.calls[0][1].slice(0, 2)).toEqual(['import', 'owner']);
  expect(res.json).toHaveBeenCalledWith({ importLog: { id: 'import', status: 'failed' } });
});
