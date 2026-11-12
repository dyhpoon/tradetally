jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/imageStorage', () => ({
  ...jest.requireActual('../src/utils/imageStorage'),
  cleanupPendingImages: jest.fn()
}));
jest.mock('../src/utils/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (_req, res) => res.status(429).json({ error: 'rate limited' }))
}));

const request = require('supertest');
const { app } = require('../src/server');
const imageStorage = require('../src/utils/imageStorage');
const db = require('../src/config/database');
const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = 'test-cron-secret';
  imageStorage.cleanupPendingImages.mockResolvedValue({ examined: 1000, deleted: 23, hasMore: true, cursor: 'private-cursor' });
});
afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

test.each([
  ['missing header', undefined],
  ['wrong token', 'Bearer wrong'],
  ['wrong scheme', 'bearer test-cron-secret'],
  ['extra token text', 'Bearer test-cron-secret extra']
])('rejects %s without running cleanup', async (_label, authorization) => {
  let call = request(app).get('/api/cron/cleanup-images');
  if (authorization) call = call.set('Authorization', authorization);
  const response = await call;

  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'Unauthorized' });
  expect(imageStorage.cleanupPendingImages).not.toHaveBeenCalled();
  expect(db.query).not.toHaveBeenCalled();
});

test('fails closed when CRON_SECRET is not configured', async () => {
  delete process.env.CRON_SECRET;
  const response = await request(app).get('/api/cron/cleanup-images').set('Authorization', 'Bearer test-cron-secret');

  expect(response.status).toBe(401);
  expect(imageStorage.cleanupPendingImages).not.toHaveBeenCalled();
});

test('runs one bounded cleanup before browser rate limits and returns only counts', async () => {
  const response = await request(app).get('/api/cron/cleanup-images?cursor=untrusted')
    .set('Authorization', 'Bearer test-cron-secret');

  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ examined: 1000, deleted: 23, hasMore: true });
  expect(imageStorage.cleanupPendingImages).toHaveBeenCalledTimes(1);
  expect(imageStorage.cleanupPendingImages).toHaveBeenCalledWith();
  expect(db.query).not.toHaveBeenCalled();
});
