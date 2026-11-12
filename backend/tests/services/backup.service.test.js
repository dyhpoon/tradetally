jest.mock('@vercel/blob', () => ({ put: jest.fn(), get: jest.fn(), del: jest.fn() }));

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('archiver', () => jest.fn());

jest.mock('../../src/services/analyticsCache', () => ({ invalidate: jest.fn() }));
jest.mock('../../src/services/optionStrategyGroupingService', () => ({
  rebuildUserGroupsSafe: jest.fn()
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    writeFile: jest.fn().mockResolvedValue(),
    stat: jest.fn().mockResolvedValue({ size: 0 }),
    access: jest.fn().mockResolvedValue()
  },
  createWriteStream: jest.fn()
}));

const path = require('path');
const db = require('../../src/config/database');
const fs = require('fs').promises;
const backupService = require('../../src/services/backup.service');
const contracts = require('../../../tests/fixtures/trading-calculation-contracts.json');

function createRestoreClient(columnsByTable = {}, user_ids = []) {
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql, params = []) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('FROM information_schema.columns')) {
        const columns = columnsByTable[params[0]] || [];
        return { rows: columns.map(column => ({ column_name: column, data_type: 'text' })) };
      }
      if (normalized.includes("tc.constraint_type = 'PRIMARY KEY'")) {
        return { rows: [{ column_name: 'id' }] };
      }
      if (normalized === 'SELECT id FROM users') return { rows: user_ids.map(id => ({ id })) };
      if (normalized.startsWith('SELECT timezone FROM users')) return { rows: [{ timezone: 'UTC' }] };
      if (normalized.startsWith('INSERT INTO')) return { rows: [{ id: 'restored-id' }] };
      return { rows: [] };
    })
  };
  db.connect.mockResolvedValue(client);
  return client;
}

describe('backup service hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdir.mockResolvedValue();
  });

  test.each(contracts.backup_restore_cases)('restores calculation contract: $id', async ({ trade, expected }) => {
    db.query.mockResolvedValue({ rows: [{ timezone: 'UTC' }] });
    const row = { id: 'trade-1', user_id: 'user-1', ...trade };
    const client = createRestoreClient({ trades: Object.keys(row) }, ['user-1']);
    const result = await backupService.restoreFromBackup({ tables: { trades: [row] } });

    expect(result.results.trades).toEqual({ added: 1, skipped: 0, errors: 0 });
    const [sql, values] = client.query.mock.calls.find(([query]) => String(query).startsWith('INSERT INTO "trades"'));
    const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ').map(column => column.replaceAll('"', ''));
    const restored = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    expect(restored).toMatchObject(expected);
    expect(client.query).toHaveBeenCalledWith('SELECT timezone FROM users WHERE id = $1', ['user-1']);
  });

  test.each(['camel', 'snake'])('restores %s-case trade parents before their trades', async format => {
    const client = createRestoreClient({
      trades: ['id', 'user_id', 'broker_connection_id', 'position_group_id'],
      broker_connections: ['id', 'user_id'],
      trade_position_groups: ['id', 'user_id']
    }, ['user-1']);
    const result = await backupService.restoreFromBackup({ tables: {
      trades: [{ id: 'trade-1', user_id: 'user-1', broker_connection_id: 'broker-1', position_group_id: 'group-1' }],
      [format === 'camel' ? 'brokerConnections' : 'broker_connections']: [{ id: 'broker-1', user_id: 'user-1' }],
      [format === 'camel' ? 'tradePositionGroups' : 'trade_position_groups']: [{ id: 'group-1', user_id: 'user-1' }]
    } }, { clearExisting: true });

    const inserts = client.query.mock.calls.filter(([query]) => String(query).startsWith('INSERT INTO'));
    expect(inserts.map(([sql]) => sql.match(/INSERT INTO "([^"]+)"/)[1])).toEqual([
      'broker_connections', 'trade_position_groups', 'trades'
    ]);
    expect(result.results.other).toEqual({ added: 2, skipped: 0, errors: 0 });
    expect(result.results.trades.errors).toBe(0);
  });

  test('deleteOldBackups parameterizes retention and only unlinks safe backup paths', async () => {
    const safePath = path.join(backupService.backupDir, 'safe.json');

    db.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'backup-1', file_path: '../../etc/passwd' },
          { id: 'backup-2', file_path: safePath }
        ]
      })
      .mockResolvedValue({ rows: [] });

    const deletedCount = await backupService.deleteOldBackups('30');

    expect(deletedCount).toBe(2);

    const [selectQuery, selectParams] = db.query.mock.calls[0];
    expect(selectQuery).toContain("WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')");
    expect(selectParams).toEqual([30]);

    expect(fs.unlink).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith(safePath);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM backups WHERE id = $1', ['backup-1']);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM backups WHERE id = $1', ['backup-2']);
  });

  test('deleteOldBackups rejects invalid retention values', async () => {
    await expect(backupService.deleteOldBackups('0')).rejects.toThrow(
      'Retention days must be an integer between 1 and 365'
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  test('createFullSiteBackup ensures backup directory before writing file', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'backup-1',
          filename: 'backup.json',
          file_path: path.join(backupService.backupDir, 'backup.json'),
          status: 'completed'
        }]
      });

    await backupService.createFullSiteBackup('user-1', 'manual');

    expect(fs.mkdir).toHaveBeenCalledWith(backupService.backupDir, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.mkdir.mock.invocationCallOrder[0]).toBeLessThan(fs.writeFile.mock.invocationCallOrder[0]);
  });

  test('ignores a malicious backup table key before constructing SQL', async () => {
    const client = createRestoreClient();

    await backupService.restoreFromBackup({
      tables: { 'evil); DROP TABLE users;--': [{ id: 'row-1' }] },
      tableNameMapping: {}
    });

    const sql = client.query.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('evil)');
  });

  test('rejects a malicious table-name mapping before metadata or inserts', async () => {
    const client = createRestoreClient();

    await backupService.restoreFromBackup({
      tables: { activityEvents: [{ id: 'row-1' }] },
      tableNameMapping: { activityEvents: 'users; DROP TABLE users;--' }
    });

    const sql = client.query.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('INSERT INTO');
  });

  test('skips a backup table that does not exist in the target schema', async () => {
    const client = createRestoreClient();

    await backupService.restoreFromBackup({
      tables: { unknownTable: [{ id: 'row-1' }] },
      tableNameMapping: { unknownTable: 'unknown_table' }
    });

    expect(client.query.mock.calls.some(([query]) => String(query).startsWith('INSERT INTO'))).toBe(false);
  });

  test('skips a row with no recognized target columns', async () => {
    const client = createRestoreClient({ custom_table: ['id'] });

    const result = await backupService.restoreFromBackup({
      tables: { customTable: [{ unexpected: 'value' }] },
      tableNameMapping: { customTable: 'custom_table' }
    });

    expect(result.tableResults.custom_table.skipped).toBe(1);
    expect(client.query.mock.calls.some(([query]) => String(query).startsWith('INSERT INTO'))).toBe(false);
  });

  test('quotes validated table and column identifiers during a valid restore', async () => {
    const client = createRestoreClient({ custom_table: ['id', 'label'] });

    await backupService.restoreFromBackup({
      tables: { customTable: [{ id: 'row-1', label: 'Safe' }] },
      tableNameMapping: { customTable: 'custom_table' }
    });

    const insert = client.query.mock.calls.find(([query]) => String(query).startsWith('INSERT INTO'));
    expect(insert[0]).toContain('INSERT INTO "custom_table" ("id", "label")');
    expect(insert[0]).toContain('RETURNING "id"');
  });
});


describe('private Blob backups', () => {
  const blob = require('@vercel/blob');
  const originalProvider = process.env.IMAGE_STORAGE_PROVIDER;
  const originalScheduler = process.env.ENABLE_BACKUP_SCHEDULER;
  const filePath = 'vercel-blob:backups/tradetally-backup-2026-11-13.json';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IMAGE_STORAGE_PROVIDER = 'vercel-blob';
    blob.put.mockResolvedValue({});
    blob.del.mockResolvedValue();
    db.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalProvider === undefined) delete process.env.IMAGE_STORAGE_PROVIDER;
    else process.env.IMAGE_STORAGE_PROVIDER = originalProvider;
    if (originalScheduler === undefined) delete process.env.ENABLE_BACKUP_SCHEDULER;
    else process.env.ENABLE_BACKUP_SCHEDULER = originalScheduler;
  });

  test('creates a private JSON object and stores its stable reference and UTF-8 size', async () => {
    const data = { version: '3.0', tables: { diary: [{ notes: '交易', image: 'diary/image.webp' }] } };
    jest.spyOn(backupService, 'fetchAllData').mockResolvedValue(data);
    db.query.mockResolvedValue({ rows: [{ id: 'backup-1', status: 'completed' }] });

    const result = await backupService.createFullSiteBackup('admin-1');
    const contents = JSON.stringify(data, null, 2);

    expect(blob.put).toHaveBeenCalledWith('backups/' + result.filename, contents, {
      access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false
    });
    expect(db.query.mock.calls[0][1]).toEqual([
      'admin-1', result.filename, 'vercel-blob:backups/' + result.filename,
      Buffer.byteLength(contents), 'manual', 'completed'
    ]);
    expect(result.size).toBe(Buffer.byteLength(contents));
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test('concurrent cloud backups receive distinct object names', async () => {
    jest.spyOn(backupService, 'fetchAllData').mockResolvedValue({ tables: {} });
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-11-13T00:00:00.000Z');
    db.query.mockResolvedValue({ rows: [{ status: 'completed' }] });

    const [first, second] = await Promise.all([
      backupService.createFullSiteBackup('admin-1'),
      backupService.createFullSiteBackup('admin-1')
    ]);

    expect(first.filename).not.toBe(second.filename);
    expect(blob.put).toHaveBeenCalledTimes(2);
  });

  test('records failed uploads without claiming a completed backup', async () => {
    jest.spyOn(backupService, 'fetchAllData').mockResolvedValue({ tables: {} });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    blob.put.mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(backupService.createFullSiteBackup('admin-1')).rejects.toThrow('Storage unavailable');

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([
      'admin-1', expect.any(String), expect.stringMatching(/^vercel-blob:backups\//),
      'manual', 'failed', 'Storage unavailable'
    ]);
  });

  test('reads private objects by validated pathname without accepting arbitrary URLs', async () => {
    const result = { stream: new ReadableStream() };
    blob.get.mockResolvedValue(result);
    await expect(backupService.getBackupBlob(filePath)).resolves.toBe(result);
    expect(blob.get).toHaveBeenCalledWith('backups/tradetally-backup-2026-11-13.json', {
      access: 'private', useCache: false
    });
  });

  test.each([
    'vercel-blob:backups/../trades/image.json',
    'vercel-blob:backups/%2e%2e/image.json',
    'vercel-blob:backups/backup.json?token=x',
    'vercel-blob:backups/backup.json#x',
    'vercel-blob:backups/backup.json/other.json',
    'vercel-blob:trades/image.json',
    'https://attacker.example/backups/backup.json',
    '../../etc/passwd'
  ])('rejects unsafe stored reference: %s', async unsafePath => {
    await expect(backupService.getBackupBlob(unsafePath)).rejects.toThrow('Invalid backup path');
    await expect(backupService.deleteBackupFile(unsafePath)).rejects.toThrow('Invalid backup path');
    expect(blob.get).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test('retention deletes the object before deleting its metadata', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'backup-1', file_path: filePath }] });

    await expect(backupService.deleteOldBackups(30)).resolves.toBe(1);

    expect(blob.del).toHaveBeenCalledWith('backups/tradetally-backup-2026-11-13.json');
    expect(blob.del.mock.invocationCallOrder[0]).toBeLessThan(db.query.mock.invocationCallOrder[1]);
    expect(db.query).toHaveBeenLastCalledWith('DELETE FROM backups WHERE id = $1', ['backup-1']);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test('retention keeps metadata when object deletion fails so it can be retried', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockResolvedValueOnce({ rows: [{ id: 'backup-1', file_path: filePath }] });
    blob.del.mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(backupService.deleteOldBackups(30)).resolves.toBe(0);

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('health reports durable storage, latest manual backup and disabled scheduling accurately', async () => {
    process.env.ENABLE_BACKUP_SCHEDULER = 'false';
    jest.spyOn(backupService, 'getBackupSettings').mockResolvedValue({ enabled: false, last_backup: null });
    const createdAt = '2026-01-01T00:00:00.000Z';
    db.query.mockResolvedValueOnce({ rows: [{ created_at: createdAt }] });

    const health = await backupService.getBackupHealth();

    expect(health).toMatchObject({
      scheduler_enabled: false, storage_provider: 'vercel-blob', local_only_storage: false,
      backup_dir: 'vercel-blob:backups/', includes_image_files: false, last_backup: createdAt
    });
    expect(health.warnings.join(' ')).toContain('Manual backups remain available');
    expect(health.warnings.join(' ')).not.toMatch(/No successful backup|stale|host filesystem/);
  });
});
