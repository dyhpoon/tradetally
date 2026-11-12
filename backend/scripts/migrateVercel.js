process.env.SERVERLESS_RUNTIME = 'vercel';

const directUrl = process.env.DATABASE_URL_UNPOOLED;
if (!directUrl) {
  throw new Error('DATABASE_URL_UNPOOLED is required to migrate the deployment database');
}
process.env.DATABASE_URL = directUrl;
const { migrate } = require('../src/utils/migrate');
const { ensurePostExitSchema } = require('../src/utils/ensurePostExitSchema');
const db = require('../src/config/database');

(async () => {
  try {
    await migrate();
    await ensurePostExitSchema();
  } finally {
    await db.pool.end();
  }
})().catch((error) => {
  console.error('Deployment database migration failed:', error.message);
  process.exitCode = 1;
});
