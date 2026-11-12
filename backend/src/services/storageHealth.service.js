const fs = require('fs').promises;
const path = require('path');
const imageStorage = require('../utils/imageStorage');

class StorageHealthService {
  constructor() {
    this.directories = {
      trade_images: path.resolve(__dirname, '../../uploads/trades'),
      diary_images: path.resolve(__dirname, '../../uploads/diary'),
      avatars: path.resolve(__dirname, '../../uploads/avatars')
    };
  }

  async inspectDirectory(directoryPath) {
    try {
      const stats = await fs.stat(directoryPath);
      return {
        exists: true,
        writable: stats.isDirectory(),
        path: directoryPath
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          exists: false,
          writable: false,
          path: directoryPath
        };
      }

      return {
        exists: false,
        writable: false,
        path: directoryPath,
        error: error.message
      };
    }
  }

  async getHealth() {
    if (imageStorage.isBlobStorage()) {
      const health = { status: 'OK', provider: 'vercel-blob', local_only_storage: false, directories: {}, warnings: [] };
      try {
        if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Blob upload token is not configured');
        await require('@vercel/blob').list({ limit: 1 });
      } catch (error) {
        health.status = 'ERROR';
        health.warnings.push('Private image storage is unavailable. Check the Blob connection and upload token.');
      }
      return health;
    }
    const directories = {};
    const warnings = [];

    for (const [key, directoryPath] of Object.entries(this.directories)) {
      directories[key] = await this.inspectDirectory(directoryPath);
    }

    warnings.push('Uploaded assets are stored on the app host filesystem.');

    const missingDirectories = Object.entries(directories)
      .filter(([, details]) => !details.exists)
      .map(([key]) => key);

    if (missingDirectories.length > 0) {
      warnings.push(`Upload directories are not initialized yet: ${missingDirectories.join(', ')}.`);
    }

    return {
      status: 'DEGRADED',
      local_only_storage: true,
      directories,
      warnings
    };
  }
}

module.exports = new StorageHealthService();
