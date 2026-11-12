jest.mock('../src/config/database', () => ({
  query: jest.fn()
}));
jest.mock('../src/services/backup.service', () => ({
  getBackupHealth: jest.fn()
}));
jest.mock('../src/services/storageHealth.service', () => ({
  getHealth: jest.fn()
}));
jest.mock('../src/workers/backgroundWorker', () => ({
  getStatus: jest.fn()
}));
jest.mock('../src/services/jobRecoveryService', () => ({
  getStatus: jest.fn(),
  stop: jest.fn()
}));
jest.mock('../src/services/globalEnrichmentCacheCleanupService', () => ({
  getStatus: jest.fn(),
  stop: jest.fn()
}));
jest.mock('../src/services/backupScheduler.service', () => ({
  getStatus: jest.fn(),
  stopAll: jest.fn()
}));
jest.mock('../src/services/priceMonitoringService', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/optionsScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/brokerSync/brokerSyncScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/newsScheduler', () => ({
  stop: jest.fn(),
  getPersistentStatus: jest.fn()
}));
jest.mock('../src/services/earningsScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/symbolCategoryScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/gamificationScheduler', () => ({
  stopScheduler: jest.fn()
}));
jest.mock('../src/services/webhookEventBridge', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/stockScannerScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/services/watchlistPillarsScheduler', () => ({
  stop: jest.fn()
}));
jest.mock('../src/posthog-telemetry', () => ({
  initializePostHogTelemetry: jest.fn(),
  shutdown: jest.fn()
}));

const db = require('../src/config/database');
const backupService = require('../src/services/backup.service');
const storageHealthService = require('../src/services/storageHealth.service');
const backgroundWorker = require('../src/workers/backgroundWorker');
const jobRecoveryService = require('../src/services/jobRecoveryService');
const enrichmentCacheCleanupService = require('../src/services/globalEnrichmentCacheCleanupService');
const backupScheduler = require('../src/services/backupScheduler.service');
const newsScheduler = require('../src/services/newsScheduler');
const { buildHealthStatus } = require('../src/services/healthStatus.service');

describe('server health status', () => {
  const originalEnv = process.env;
  afterEach(() => { process.env = originalEnv; });
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL;
    delete process.env.SERVERLESS_RUNTIME;
    delete process.env.DISABLE_BACKGROUND_JOBS;
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    backupService.getBackupHealth.mockResolvedValue({ status: 'OK', storage_provider: 'vercel-blob' });
    backgroundWorker.getStatus.mockReturnValue({ isRunning: true, queueProcessing: true });
    jobRecoveryService.getStatus.mockReturnValue({ isRunning: true });
    enrichmentCacheCleanupService.getStatus.mockReturnValue({ isRunning: true });
    backupScheduler.getStatus.mockReturnValue({ isRunning: true, enabled: true });
    newsScheduler.getPersistentStatus.mockResolvedValue({
      running: true,
      lastSuccessDate: '2026-08-27T12:00:00.000Z',
      persisted: { lastSuccessAt: '2026-08-27T12:00:00.000Z', lastError: null }
    });
  });

  test('includes backup and storage sections and degrades status when either is not OK', async () => {
    backupService.getBackupHealth.mockResolvedValue({
      status: 'DEGRADED',
      warnings: ['Backups are disabled in backup settings.']
    });
    storageHealthService.getHealth.mockResolvedValue({
      status: 'DEGRADED',
      warnings: ['Images are stored on the application host.']
    });

    const health = await buildHealthStatus();

    expect(health.status).toBe('DEGRADED');
    expect(health.services.backups).toEqual({
      status: 'DEGRADED',
      warnings: ['Backups are disabled in backup settings.']
    });
    expect(health.services.storage).toEqual({
      status: 'DEGRADED',
      warnings: ['Images are stored on the application host.']
    });
    expect(health.services.newsScheduler).toEqual(expect.objectContaining({
      lastSuccessDate: '2026-08-27T12:00:00.000Z'
    }));
  });

  test('reports intentionally disabled workers without degrading healthy serverless services', async () => {
    process.env.SERVERLESS_RUNTIME = 'vercel';
    process.env.DISABLE_BACKGROUND_JOBS = 'true';
    backgroundWorker.getStatus.mockReturnValue({ isRunning: false, queueProcessing: false });
    jobRecoveryService.getStatus.mockReturnValue({ isRunning: false });
    storageHealthService.getHealth.mockResolvedValue({ status: 'OK' });

    const health = await buildHealthStatus();

    expect(health.status).toBe('OK');
    for (const name of ['backgroundWorker', 'jobRecovery', 'enrichmentCacheCleanup', 'backupScheduler', 'newsScheduler']) {
      expect(health.services[name].status).toBe('DISABLED');
    }
    expect(backupService.getBackupHealth).toHaveBeenCalledTimes(1);
    expect(health.services.backups).toEqual({ status: 'OK', storage_provider: 'vercel-blob' });
    expect(newsScheduler.getPersistentStatus).not.toHaveBeenCalled();
  });

  test('reports backup failures on Vercel even when the scheduler is disabled', async () => {
    process.env.SERVERLESS_RUNTIME = 'vercel';
    process.env.DISABLE_BACKGROUND_JOBS = 'true';
    backupService.getBackupHealth.mockResolvedValue({ status: 'DEGRADED', warnings: ['No successful backup has been recorded yet.'] });
    storageHealthService.getHealth.mockResolvedValue({ status: 'OK' });

    const health = await buildHealthStatus();

    expect(health.status).toBe('DEGRADED');
    expect(health.services.backupScheduler.status).toBe('DISABLED');
    expect(health.services.backups.status).toBe('DEGRADED');
  });

  test('still degrades disabled-worker deployments when the database or storage fails', async () => {
    process.env.SERVERLESS_RUNTIME = 'vercel';
    process.env.DISABLE_BACKGROUND_JOBS = 'true';
    db.query.mockRejectedValue(new Error('database unavailable'));
    storageHealthService.getHealth.mockResolvedValue({ status: 'ERROR' });

    const health = await buildHealthStatus();

    expect(health.status).toBe('DEGRADED');
    expect(health.services.database).toBe('ERROR');
    expect(health.services.storage.status).toBe('ERROR');
  });

});
