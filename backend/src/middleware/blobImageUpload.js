const path = require('path');
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const imageStorage = require('../utils/imageStorage');
const Trade = require('../models/Trade');
const Diary = require('../models/Diary');

const RECEIPT_AUDIENCE = 'tradetally-image-upload';
const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function ownsResource(req, kind) {
  if (!req.user?.id) return false;
  if (kind === 'avatars') return true;
  const resource = kind === 'trades'
    ? await Trade.findById(req.params.id, req.user.id)
    : await Diary.findById(req.params.id, req.user.id);
  return resource && String(resource.user_id) === String(req.user.id);
}

function resourceId(req, kind) {
  return String(kind === 'avatars' ? req.user.id : req.params.id);
}

function createUploadToken(kind) {
  return async (req, res, next) => {
    try {
      if (!imageStorage.isBlobStorage()) return res.status(404).json({ error: 'Direct uploads are not enabled' });
      if (!await ownsResource(req, kind)) return res.status(404).json({ error: 'Image owner not found' });
      const { filename, size } = req.body || {};
      const extension = typeof filename === 'string' ? path.extname(filename).slice(1).toLowerCase() : '';
      if (!Object.hasOwn(mimeTypes, extension) || filename.length > 255 || filename !== path.basename(filename)
          || filename.includes('\\') || !Number.isInteger(size) || size < 1 || size > imageStorage.MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'Choose a JPG, PNG or WebP image up to 50 MB' });
      }
      const owner = String(req.user.id);
      const resource = resourceId(req, kind);
      if (![owner, resource].every(value => /^[a-zA-Z0-9_-]+$/.test(value))) {
        return res.status(400).json({ error: 'Invalid image owner' });
      }
      const pathname = imageStorage.pendingPrefix() + kind + '/' + owner + '/' + resource + '/' + randomUUID() + '.' + extension;
      const contentType = mimeTypes[extension];
      const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');
      const clientToken = await generateClientTokenFromReadWriteToken({
        pathname, allowedContentTypes: [contentType], maximumSizeInBytes: size,
        validUntil: Date.now() + 10 * 60 * 1000, addRandomSuffix: false, allowOverwrite: false
      });
      const receipt = jwt.sign({ owner, resource, kind, pathname, filename, size, contentType }, process.env.JWT_SECRET, {
        algorithm: 'HS256', audience: RECEIPT_AUDIENCE, expiresIn: '15m'
      });
      res.json({ pathname, clientToken, receipt, contentType });
    } catch (error) {
      next(error);
    }
  };
}

function receiveImage(kind, multipart, handler) {
  return async (req, res, next) => {
    if (!req.body?.uploadReceipt) return multipart(req, res, error => error ? next(error) : handler(req, res, next));
    if (!imageStorage.isBlobStorage()) return res.status(400).json({ error: 'Direct uploads are not enabled' });
    let receipt;
    try {
      receipt = jwt.verify(req.body.uploadReceipt, process.env.JWT_SECRET, {
        algorithms: ['HS256'], audience: RECEIPT_AUDIENCE
      });
    } catch (_) {
      return res.status(400).json({ error: 'Upload authorization expired or is invalid. Please upload the image again.' });
    }
    if (receipt.owner !== String(req.user?.id) || receipt.kind !== kind
        || receipt.resource !== resourceId(req, kind)) {
      return res.status(403).json({ error: 'Upload belongs to another owner' });
    }
    try {
      if (!await ownsResource(req, kind)) return res.status(404).json({ error: 'Image owner not found' });
      let buffer;
      try {
        buffer = await imageStorage.readBlob(receipt.pathname);
      } finally {
        // Await removal before the controller sends a response and the function
        // can be suspended. Invalid images are removed too.
        try { await require('@vercel/blob').del(receipt.pathname); }
        catch (error) { console.error('Could not remove staged image:', error.message); }
      }
      if (buffer.length !== receipt.size) return res.status(400).json({ error: 'Uploaded image size does not match' });
      const file = { buffer, originalname: receipt.filename, mimetype: receipt.contentType, size: buffer.length };
      if (kind === 'avatars') req.file = file;
      else req.files = [file];
      await handler(req, res, next);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(400).json({ error: 'Upload is missing or already processed. Please upload it again.' });
      next(error);
    }
  };
}

module.exports = { createUploadToken, receiveImage };
