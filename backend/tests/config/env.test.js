const { validateEnv } = require('../../src/config/env');

const originalEnv = process.env;
afterEach(() => { process.env = originalEnv; });
beforeEach(() => {
  process.env = {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://journal.example.com',
    JWT_SECRET: 'local-test-secret-long-enough'
  };
});

test('accepts a PostgreSQL URL without separate database fields', () => {
  process.env.DATABASE_URL = 'postgresql://user:password@localhost/journal';
  expect(validateEnv().env.DATABASE_URL).toBe(process.env.DATABASE_URL);
});

test('still requires the local database fields without a URL', () => {
  expect(() => validateEnv()).toThrow('DB_HOST');
  Object.assign(process.env, { DB_HOST: 'localhost', DB_USER: 'user', DB_PASSWORD: '', DB_NAME: 'journal' });
  expect(() => validateEnv()).not.toThrow();
});

test('rejects a non-PostgreSQL connection URL', () => {
  process.env.DATABASE_URL = 'https://example.com';
  expect(() => validateEnv()).toThrow('DATABASE_URL');
});
