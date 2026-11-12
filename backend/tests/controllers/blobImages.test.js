jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/models/User', () => ({ findById: jest.fn(), update: jest.fn() }));
jest.mock('../../src/models/Trade', () => ({ findById: jest.fn(), addAttachment: jest.fn(), deleteAttachment: jest.fn() }));
jest.mock('../../src/models/Diary', () => ({ findById: jest.fn(), addAttachment: jest.fn(), deleteAttachment: jest.fn() }));
jest.mock('@vercel/blob', () => ({ get: jest.fn(), put: jest.fn(), del: jest.fn(), list: jest.fn() }));
jest.mock('@vercel/blob/client', () => ({ generateClientTokenFromReadWriteToken: jest.fn(async () => 'limited-client-token') }));

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const { Readable } = require('stream');
const blob = require('@vercel/blob');
const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');
const db = require('../../src/config/database');
const User = require('../../src/models/User');
const Trade = require('../../src/models/Trade');
const Diary = require('../../src/models/Diary');
const { generateToken, clearAuthUserCache, TOKEN_PURPOSES } = require('../../src/middleware/auth');
const imageStorage = require('../../src/utils/imageStorage');

const app = express();
app.use(express.json());
app.use('/trades', require('../../src/routes/trade.routes'));
app.use('/diary', require('../../src/routes/diary.routes'));
app.use('/users', require('../../src/routes/user.routes'));

const owner = { id: 'owner', is_active: true, session_version: 2 };
const auth = (user = owner, options) => 'Bearer ' + generateToken(user, options);
let png;

function storedImage(buffer = png) {
  return { statusCode: 200, blob: { size: buffer.length }, stream: Readable.toWeb(Readable.from([buffer])) };
}

async function authorize(endpoint = '/trades/trade1/images', size = png.length) {
  return request(app).post(endpoint + '/upload-token').set('Authorization', auth()).send({ filename: 'chart.png', size });
}

beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer();
});

beforeEach(() => {
  jest.clearAllMocks();
  clearAuthUserCache();
  process.env.JWT_SECRET = 'blob-image-test-secret';
  process.env.IMAGE_STORAGE_PROVIDER = 'vercel-blob';
  process.env.IMAGE_STORAGE_ENV = 'preview';
  process.env.VERCEL_ENV = 'preview';
  User.findById.mockImplementation(async id => ({ ...owner, id }));
  User.update.mockImplementation(async (id, data) => ({ id, ...data }));
  Trade.findById.mockResolvedValue({ id: 'trade1', user_id: owner.id });
  Diary.findById.mockResolvedValue({ id: 'entry1', user_id: owner.id });
  Trade.addAttachment.mockImplementation(async (_id, data) => ({ id: 'image1', file_url: data.fileUrl }));
  Diary.addAttachment.mockImplementation(async (_id, data) => ({ id: 'image1', file_url: data.fileUrl }));
  blob.get.mockImplementation(async () => storedImage());
  blob.put.mockResolvedValue({});
  blob.del.mockResolvedValue(undefined);
  db.query.mockResolvedValue({ rows: [] });
});

test('upload authorization binds an exact private staging key and preserves the 50 MB limit', async () => {
  const response = await authorize(undefined, 50 * 1024 * 1024);
  expect(response.status).toBe(200);
  expect(response.body.pathname).toMatch(/^pending\/preview\/trades\/owner\/trade1\/[a-f0-9-]+\.png$/);
  expect(generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(expect.objectContaining({
    pathname: response.body.pathname, maximumSizeInBytes: 50 * 1024 * 1024,
    allowedContentTypes: ['image/png'], allowOverwrite: false, addRandomSuffix: false
  }));
  expect(jwt.verify(response.body.receipt, process.env.JWT_SECRET, { audience: 'tradetally-image-upload' }))
    .toMatchObject({ owner: 'owner', resource: 'trade1', kind: 'trades', pathname: response.body.pathname });
  expect((await authorize(undefined, 50 * 1024 * 1024 + 1)).status).toBe(400);
});

test('rejects another user’s public trade before authorizing an upload', async () => {
  Trade.findById.mockResolvedValue({ id: 'trade1', user_id: 'someone-else', is_public: true });
  expect((await authorize()).status).toBe(404);
  expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
});

test.each(['../chart.png', 'https://example.com/chart.png', 'chart.constructor'])('rejects invalid upload names %s', async filename => {
  const response = await request(app).post('/trades/trade1/images/upload-token')
    .set('Authorization', auth()).send({ filename, size: 10 });
  expect(response.status).toBe(400);
  expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
});

test.each([
  ['pre-2FA', { purpose: TOKEN_PURPOSES.PRE_2FA }],
  ['expired', { expiresIn: '-1s' }]
])('rejects %s sessions at upload authorization and finalization', async (_label, options) => {
  for (const suffix of ['/upload-token', '']) {
    const response = await request(app).post('/trades/trade1/images' + suffix)
      .set('Authorization', auth(owner, options)).send({ filename: 'chart.png', size: png.length, uploadReceipt: 'unused' });
    expect(response.status).toBe(401);
  }
  expect(blob.get).not.toHaveBeenCalled();
  expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
});

test('rejects a revoked session before finalization', async () => {
  User.findById.mockResolvedValue({ ...owner, session_version: 3 });
  const response = await request(app).post('/trades/trade1/images').set('Authorization', auth()).send({ uploadReceipt: 'unused' });
  expect(response.status).toBe(401);
  expect(blob.get).not.toHaveBeenCalled();
});

test.each([
  ['/trades/trade1/images', 'trades/'],
  ['/diary/entry1/images', 'diary/'],
  ['/users/avatar', 'avatars/']
])('finalizes %s through image validation into private storage and removes its original', async (endpoint, prefix) => {
  const token = await authorize(endpoint);
  expect(token.status).toBe(200);
  const response = await request(app).post(endpoint).set('Authorization', auth()).send({ uploadReceipt: token.body.receipt });
  expect(response.status).toBe(200);
  expect(blob.get).toHaveBeenCalledWith(token.body.pathname, { access: 'private', useCache: false });
  expect(blob.put).toHaveBeenCalledWith(expect.stringMatching(new RegExp('^' + prefix)), expect.any(Buffer), expect.objectContaining({ access: 'private' }));
  expect(blob.del).toHaveBeenCalledWith(token.body.pathname);
  expect(blob.del.mock.invocationCallOrder[0]).toBeLessThan(blob.put.mock.invocationCallOrder[0]);
  expect(JSON.stringify(response.body)).not.toContain('vercel-storage.com');
});

test('a receipt cannot be used for another resource, image type or user', async () => {
  const token = await authorize();
  for (const endpoint of ['/trades/trade2/images', '/diary/trade1/images', '/users/avatar']) {
    const response = await request(app).post(endpoint).set('Authorization', auth()).send({ uploadReceipt: token.body.receipt });
    expect(response.status).toBe(403);
  }
  const response = await request(app).post('/trades/trade1/images')
    .set('Authorization', auth({ ...owner, id: 'other' })).send({ uploadReceipt: token.body.receipt });
  expect(response.status).toBe(403);
  expect(blob.get).not.toHaveBeenCalled();
  expect(blob.del).not.toHaveBeenCalled();
});

test('expired or tampered receipts never fetch or delete a blob', async () => {
  const token = await authorize();
  const { exp, iat, aud, ...payload } = jwt.decode(token.body.receipt);
  const expired = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '-1s', audience: aud });
  for (const receipt of [expired, token.body.receipt + 'changed']) {
    expect((await request(app).post('/trades/trade1/images').set('Authorization', auth()).send({ uploadReceipt: receipt })).status).toBe(400);
  }
  expect(blob.get).not.toHaveBeenCalled();
  expect(blob.del).not.toHaveBeenCalled();
});

test('ownership is checked again after upload, before fetching the original', async () => {
  const token = await authorize();
  Trade.findById.mockResolvedValue(null);
  const response = await request(app).post('/trades/trade1/images').set('Authorization', auth()).send({ uploadReceipt: token.body.receipt });
  expect(response.status).toBe(404);
  expect(blob.get).not.toHaveBeenCalled();
});

test('invalid image bytes are removed without saving an attachment', async () => {
  const raw = Buffer.from('not an image');
  const token = await authorize(undefined, raw.length);
  blob.get.mockResolvedValue(storedImage(raw));
  const response = await request(app).post('/trades/trade1/images').set('Authorization', auth()).send({ uploadReceipt: token.body.receipt });
  expect(response.body.successfulUploads).toBe(0);
  expect(blob.del).toHaveBeenCalledWith(token.body.pathname);
  expect(blob.put).not.toHaveBeenCalled();
  expect(Trade.addAttachment).not.toHaveBeenCalled();
});

test('an oversized staging blob is rejected before consuming its body', async () => {
  const token = await authorize();
  const stored = storedImage();
  stored.blob.size = imageStorage.MAX_IMAGE_BYTES + 1;
  blob.get.mockResolvedValue(stored);
  const response = await request(app).post('/trades/trade1/images').set('Authorization', auth()).send({ uploadReceipt: token.body.receipt });
  expect(response.status).toBe(500);
  expect(blob.del).toHaveBeenCalledWith(token.body.pathname);
  expect(blob.put).not.toHaveBeenCalled();
});

test.each(['/trades/trade1/images/chart.webp', '/diary/entry1/images/chart.webp'])('private read %s rejects other owners before Blob access', async endpoint => {
  db.query.mockResolvedValue({ rows: [{ user_id: 'someone-else', is_public: false, file_type: 'image/webp' }] });
  const response = await request(app).get(endpoint).set('Authorization', auth());
  expect(response.status).toBe(403);
  expect(blob.get).not.toHaveBeenCalled();
});

test('an owner reads a private image through the existing API with no-store headers', async () => {
  db.query.mockResolvedValue({ rows: [{ user_id: 'owner', is_public: false, file_type: 'image/png' }] });
  const response = await request(app).get('/trades/trade1/images/chart.png').set('Authorization', auth());
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body).toEqual(png);
  expect(blob.get).toHaveBeenCalledWith('trades/chart.png', { access: 'private', useCache: false });
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("regexp_replace"), ['trade1', 'chart.png']);
});

test('streams private images larger than the Vercel buffered-response limit', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 1);
  blob.get.mockResolvedValue(storedImage(bytes));
  db.query.mockResolvedValue({ rows: [{ user_id: 'owner', is_public: false, file_type: 'image/png' }] });
  const response = await request(app).get('/trades/trade1/images/chart.png').set('Authorization', auth());
  expect(response.status).toBe(200);
  expect(response.headers['transfer-encoding']).toBe('chunked');
  expect(response.headers['content-length']).toBeUndefined();
  expect(response.body).toEqual(bytes);
});

test.each(['/trades/trade1/images/chart.webp', '/diary/entry1/images/chart.webp'])('query-token reads %s reject expired, pre-2FA and revoked sessions', async endpoint => {
  db.query.mockResolvedValue({ rows: [{ user_id: 'owner', is_public: false }] });
  for (const options of [{ expiresIn: '-1s' }, { purpose: TOKEN_PURPOSES.PRE_2FA }]) {
    const response = await request(app).get(endpoint).query({ token: generateToken(owner, options) });
    expect([401, 403]).toContain(response.status);
  }
  User.findById.mockResolvedValue({ ...owner, session_version: 3 });
  const response = await request(app).get(endpoint).query({ token: generateToken(owner) });
  expect([401, 403]).toContain(response.status);
  expect(blob.get).not.toHaveBeenCalled();
});

test('AI screenshot context reads only authorized private images', async () => {
  const { loadImageContext } = require('../../src/services/aiImageContext');
  db.query.mockResolvedValue({ rows: [{ id: 'image1', file_name: 'chart.png', file_url: '/api/trades/trade1/images/chart.png' }] });
  const context = await loadImageContext('owner', 'trade1', 'openai');
  expect(context.images).toHaveLength(1);
  expect((await sharp(Buffer.from(context.images[0].data, 'base64')).metadata()).format).toBe('jpeg');
  expect(blob.get).toHaveBeenCalledWith('trades/chart.png', { access: 'private', useCache: false });
  blob.get.mockClear();
  db.query.mockResolvedValue({ rows: [] });
  expect((await loadImageContext('other', 'trade1', 'openai')).images).toEqual([]);
  expect(blob.get).not.toHaveBeenCalled();
});

test.each([
  ['/trades/trade1/images/image1', 'trades/chart.webp'],
  ['/diary/entry1/images/image1', 'diary/chart.webp']
])('deleting %s removes the private blob', async (endpoint, key) => {
  db.query.mockResolvedValue({ rows: [{ file_url: '/' + key }] });
  const response = await request(app).delete(endpoint).set('Authorization', auth());
  expect(response.status).toBe(200);
  expect(blob.del).toHaveBeenCalledWith(key);
});

test('storage rejects URLs and traversal before calling Blob', async () => {
  for (const filename of ['../chart.webp', 'https://evil.example/chart.webp', 'chart.webp/secret']) {
    await expect(imageStorage.readImage('/uploads/trades', filename)).rejects.toThrow('Invalid image storage path');
  }
  expect(blob.get).not.toHaveBeenCalled();
});

test.each(['/trades/trade1/images/image1', '/diary/entry1/images/image1'])('deletion %s cannot remove another owner’s image', async endpoint => {
  db.query.mockResolvedValue({ rows: [] });
  expect((await request(app).delete(endpoint).set('Authorization', auth())).status).toBe(404);
  expect(blob.del).not.toHaveBeenCalled();
});

test('cleanup is bounded, environment scoped and preserves recent originals', async () => {
  blob.list.mockResolvedValue({ blobs: [
    { pathname: 'pending/preview/old.png', uploadedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    { pathname: 'pending/preview/recent.png', uploadedAt: new Date() }
  ], hasMore: true, cursor: 'next-page' });
  expect(await imageStorage.cleanupPendingImages()).toEqual({ examined: 2, deleted: 1, hasMore: true, cursor: 'next-page' });
  expect(blob.list).toHaveBeenCalledWith({ prefix: 'pending/preview/', limit: 1000 });
  expect(blob.del).toHaveBeenCalledWith(['pending/preview/old.png']);
});

test('storage health checks Blob access without requiring local upload folders', async () => {
  const healthService = require('../../src/services/storageHealth.service');
  process.env.BLOB_READ_WRITE_TOKEN = 'test-storage-token';
  blob.list.mockResolvedValue({ blobs: [] });
  expect(await healthService.getHealth()).toMatchObject({ status: 'OK', provider: 'vercel-blob', local_only_storage: false });
  blob.list.mockRejectedValueOnce(new Error('Provider access denied'));
  expect(await healthService.getHealth()).toMatchObject({ status: 'ERROR', warnings: [expect.stringContaining('unavailable')] });
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
