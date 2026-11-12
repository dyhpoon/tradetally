const backgroundWorker = require('../workers/backgroundWorker');
const jobRecoveryService = require('./jobRecoveryService');
const globalEnrichmentCacheCleanupService = require('./globalEnrichmentCacheCleanupService');
const backupScheduler = require('./backupScheduler.service');
const newsScheduler = require('./newsScheduler');
const storageHealthService = require('./storageHealth.service');
const backupService = require('./backup.service');
const db = require('../config/database');
const { isBackgroundJobsDisabled } = require('../utils/runtimeScope');

async function buildHealthStatus() {
  const backgroundJobsDisabled = isBackgroundJobsDisabled();
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      database: 'OK',
      backgroundWorker: backgroundWorker.getStatus(),
      jobRecovery: jobRecoveryService.getStatus(),
      enrichmentCacheCleanup: globalEnrichmentCacheCleanupService.getStatus(),
      backupScheduler: backupScheduler.getStatus(),
      newsScheduler: backgroundJobsDisabled
        ? { status: 'DISABLED', running: false }
        : await newsScheduler.getPersistentStatus(),
      backups: { status: 'UNKNOWN' },
      storage: { status: 'UNKNOWN' }
    }
  };

  try {
    await db.query('SELECT 1');
  } catch (error) {
    health.services.database = 'ERROR';
    health.status = 'DEGRADED';
  }

  if (backgroundJobsDisabled || process.env.ENABLE_TRADE_ENRICHMENT === 'false') {
    health.services.backgroundWorker.status = 'DISABLED';
  } else if (!health.services.backgroundWorker.isRunning || !health.services.backgroundWorker.queueProcessing) {
    health.status = 'DEGRADED';
    health.services.backgroundWorker.status = 'ERROR';
  } else {
    health.services.backgroundWorker.status = 'OK';
  }

  if (backgroundJobsDisabled || process.env.ENABLE_JOB_RECOVERY === 'false') {
    health.services.jobRecovery.status = 'DISABLED';
  } else if (!health.services.jobRecovery.isRunning) {
    health.status = 'DEGRADED';
    health.services.jobRecovery.status = 'ERROR';
  } else {
    health.services.jobRecovery.status = 'OK';
  }

  if (backgroundJobsDisabled) {
    health.services.enrichmentCacheCleanup.status = 'DISABLED';
  }

  if (backgroundJobsDisabled || process.env.ENABLE_BACKUP_SCHEDULER === 'false') {
    health.services.backupScheduler.status = 'DISABLED';
  }

  try {
    health.services.backups = await backupService.getBackupHealth();
    if (health.services.backups.status !== 'OK') {
      health.status = 'DEGRADED';
    }
  } catch (error) {
    health.services.backups = {
      status: 'ERROR',
      error: error.message
    };
    health.status = 'DEGRADED';
  }

  try {
    health.services.storage = await storageHealthService.getHealth();
    if (health.services.storage.status !== 'OK') {
      health.status = 'DEGRADED';
    }
  } catch (error) {
    health.services.storage = {
      status: 'ERROR',
      error: error.message
    };
    health.status = 'DEGRADED';
  }

  return health;
}

module.exports = {
  buildHealthStatus
};
