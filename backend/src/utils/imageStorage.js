const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const namespaces = new Set(['trades', 'diary', 'avatars']);

function isBlobStorage() {
  return process.env.IMAGE_STORAGE_PROVIDER === 'vercel-blob';
}

function pendingPrefix() {
  const configuredEnvironment = process.env.IMAGE_STORAGE_ENV || process.env.VERCEL_ENV;
  const environment = ['production', 'preview'].includes(configuredEnvironment) ? configuredEnvironment : 'development';
  return 'pending/' + environment + '/';
}

async function cleanupPendingImages({ cursor } = {}) {
  const { list, del } = require('@vercel/blob');
  const result = await list({ prefix: pendingPrefix(), limit: 1000, ...(cursor ? { cursor } : {}) });
  const cutoff = Date.now() - 60 * 60 * 1000;
  const expired = result.blobs.filter(blob => blob.uploadedAt.getTime() < cutoff);
  if (expired.length) await del(expired.map(blob => blob.pathname));
  return { examined: result.blobs.length, deleted: expired.length, hasMore: result.hasMore, cursor: result.cursor };
}

function imageKey(directory, filename) {
  const namespace = path.basename(directory);
  if (!namespaces.has(namespace) || typeof filename !== 'string'
      || !/^[a-zA-Z0-9_-]+\.(webp|png|jpe?g)$/i.test(filename)) {
    throw new Error('Invalid image storage path');
  }
  return namespace + '/' + filename;
}

async function putImage(directory, filename, buffer, contentType) {
  return require('@vercel/blob').put(imageKey(directory, filename), buffer, {
    access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false
  });
}

async function deleteImage(directory, filename) {
  await require('@vercel/blob').del(imageKey(directory, filename));
}

async function readBlob(pathname) {
  const result = await require('@vercel/blob').get(pathname, { access: 'private', useCache: false });
  if (!result) {
    const error = new Error('Image not found');
    error.code = 'ENOENT';
    throw error;
  }
  if (result.blob.size > MAX_IMAGE_BYTES) {
    await result.stream.cancel();
    throw new Error('Image exceeds processing limit');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(result.stream)) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds processing limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readImage(directory, filename) {
  return readBlob(imageKey(directory, filename));
}

async function sendImage(res, directory, filename, contentType, isPublic = false) {
  const result = await require('@vercel/blob').get(imageKey(directory, filename), {
    access: 'private', useCache: false
  });
  if (!result) return res.status(404).json({ error: 'Image not found' });
  res.setHeader('Content-Type', contentType || 'image/webp');
  res.setHeader('Cache-Control', isPublic ? 'public, max-age=3600' : 'private, no-store');
  await pipeline(Readable.fromWeb(result.stream), res);
}

module.exports = { isBlobStorage, pendingPrefix, cleanupPendingImages, imageKey, putImage, deleteImage, readImage, readBlob, sendImage, MAX_IMAGE_BYTES };
