process.env.SERVERLESS_RUNTIME = 'vercel';

require('dotenv').config();

process.env.DISABLE_BACKGROUND_JOBS ??= 'true';
process.env.ENABLE_PRICE_MONITORING ??= 'false';
process.env.ENABLE_BACKUP_SCHEDULER ??= 'false';
process.env.BILLING_ENABLED ??= 'false';
if (!process.env.FRONTEND_URL && process.env.VERCEL_URL) {
  process.env.FRONTEND_URL = `https://${process.env.VERCEL_URL}`;
}

const { validateEnv } = require('./src/config/env');
validateEnv();

// Schema migrations run once before deployment, never during a cold start.
module.exports = require('./src/server').app;
