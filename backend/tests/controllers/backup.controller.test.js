jest.mock('../../src/config/database', () => ({ query: jest.fn() }));

jest.mock('../../src/services/backup.service', () => ({
  getBackups: jest.fn(),
  getBackupById: jest.fn(),
  resolveBackupPath: jest.fn(),
  isBlobBackup: jest.fn(),
  getBackupBlob: jest.fn(),
  deleteBackupFile: jest.fn(),
  deleteOldBackups: jest.fn(),
  getBackupSettings: jest.fn(),
  getBackupHealth: jest.fn()
}));

const backupController = require('../../src/controllers/backup.controller');
const backupService = require('../../src/services/backup.service');

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    download: jest.fn()
  };
}

describe('backup controller hardening', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('getBackups rejects invalid limit values', async () => {
    const req = { query: { limit: '0' } };
    const res = createRes();
    const next = jest.fn();

    await backupController.getBackups(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Limit must be an integer between 1 and 100' });
    expect(next).not.toHaveBeenCalled();
    expect(backupService.getBackups).not.toHaveBeenCalled();
  });

  test('cleanupOldBackups rejects invalid retention days', async () => {
    const req = { body: { days: '500' } };
    const res = createRes();
    const next = jest.fn();

    await backupController.cleanupOldBackups(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Retention days must be an integer between 1 and 365' });
    expect(next).not.toHaveBeenCalled();
    expect(backupService.deleteOldBackups).not.toHaveBeenCalled();
  });

  test('downloadBackup rejects unsafe backup paths', async () => {
    backupService.getBackupById.mockResolvedValue({
      status: 'completed',
      file_path: '../../etc/passwd'
    });
    backupService.resolveBackupPath.mockImplementation(() => {
      throw new Error('Invalid backup path');
    });

    const req = { params: { id: 'backup-1' } };
    const res = createRes();
    const next = jest.fn();

    await backupController.downloadBackup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid backup path' });
    expect(next).not.toHaveBeenCalled();
  });

  test('getSettings includes backup health warnings', async () => {
    backupService.getBackupSettings.mockResolvedValue({
      enabled: false,
      schedule: 'daily',
      retention_days: 30,
      last_backup: null
    });
    backupService.getBackupHealth.mockResolvedValue({
      status: 'DEGRADED',
      warnings: ['Backups are disabled in backup settings.']
    });

    const req = {};
    const res = createRes();
    const next = jest.fn();

    await backupController.getSettings(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      enabled: false,
      schedule: 'daily',
      retention_days: 30,
      last_backup: null,
      health: {
        status: 'DEGRADED',
        warnings: ['Backups are disabled in backup settings.']
      }
    });
  });
});


describe('private backup downloads and deletion', () => {
  const { PassThrough } = require('stream');
  const db = require('../../src/config/database');
  const filePath = 'vercel-blob:backups/tradetally-backup-test.json';

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    backupService.getBackupById.mockResolvedValue({
      status: 'completed', file_path: filePath, filename: 'tradetally-backup-test.json'
    });
    backupService.resolveBackupPath.mockReturnValue(filePath);
    backupService.isBlobBackup.mockReturnValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test('streams JSON through the admin response with private no-store caching', async () => {
    const contents = JSON.stringify({ tables: { trades: [] } });
    backupService.getBackupBlob.mockResolvedValue({ stream: new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(contents)); controller.close(); }
    }) });
    const res = new PassThrough();
    res.attachment = jest.fn();
    res.setHeader = jest.fn();
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    const next = jest.fn();

    await backupController.downloadBackup({ params: { id: 'backup-1' } }, res, next);

    expect(Buffer.concat(chunks).toString()).toBe(contents);
    expect(res.attachment).toHaveBeenCalledWith('tradetally-backup-test.json');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(backupService.getBackupBlob).toHaveBeenCalledWith(filePath);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 404 if the private backup object is missing', async () => {
    backupService.getBackupBlob.mockResolvedValue(null);
    const res = createRes();
    const next = jest.fn();

    await backupController.downloadBackup({ params: { id: 'backup-1' } }, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Backup file not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('deletes the stored file before its metadata', async () => {
    backupService.deleteBackupFile.mockResolvedValue();
    db.query.mockResolvedValue({ rows: [] });
    const res = createRes();
    const next = jest.fn();

    await backupController.deleteBackup({ params: { id: 'backup-1' } }, res, next);

    expect(backupService.deleteBackupFile).toHaveBeenCalledWith(filePath);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM backups WHERE id = $1', ['backup-1']);
    expect(backupService.deleteBackupFile.mock.invocationCallOrder[0]).toBeLessThan(db.query.mock.invocationCallOrder[0]);
    expect(res.json).toHaveBeenCalledWith({ message: 'Backup deleted successfully' });
    expect(next).not.toHaveBeenCalled();
  });

  test('keeps metadata when storage deletion fails', async () => {
    const error = new Error('Storage unavailable');
    backupService.deleteBackupFile.mockRejectedValue(error);
    const res = createRes();
    const next = jest.fn();

    await backupController.deleteBackup({ params: { id: 'backup-1' } }, res, next);

    expect(db.query).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(error);
  });
});
