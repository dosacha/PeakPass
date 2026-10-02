// Run against a dedicated empty database; never resets or drops application data.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const image = process.argv[2];
assert.ok(image, 'Usage: node .github/scripts/production-image-check.mjs IMAGE');
for (const name of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_HOST', 'REDIS_PORT']) {
  assert.ok(process.env[name], `${name} is required`);
}
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const env = {
  ...process.env,
  NODE_ENV: 'production',
  JWT_SECRET: randomBytes(32).toString('hex'),
  API_KEY: randomBytes(32).toString('hex'),
  WEBHOOK_SIGNING_SECRET: randomBytes(32).toString('hex'),
  LOG_LEVEL: 'info',
  PORT: '3000',
  ENFORCE_AUTH_USER_MATCH: 'true',
  ENABLE_RATE_LIMITING: 'true',
  RATE_LIMIT_FAIL_MODE: 'closed',
};
const containerEnv = [
  'NODE_ENV', 'JWT_SECRET', 'API_KEY', 'WEBHOOK_SIGNING_SECRET', 'LOG_LEVEL', 'PORT',
  'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_PORT', 'REDIS_PASSWORD',
  'ENFORCE_AUTH_USER_MATCH', 'ENABLE_RATE_LIMITING', 'RATE_LIMIT_FAIL_MODE',
  'ENABLE_ADMISSION',
].filter((name) => env[name] !== undefined).flatMap((name) => ['--env', name]);
containerEnv.push('--env', `DB_HOST=${process.env.IMAGE_DB_HOST || process.env.DB_HOST}`,
  '--env', `REDIS_HOST=${process.env.IMAGE_REDIS_HOST || process.env.REDIS_HOST}`);
const network = process.env.IMAGE_NETWORK ? ['--network', process.env.IMAGE_NETWORK] : [];
function docker(args) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout.trim();
}
const history = async () => (await pool.query('SELECT * FROM migrations ORDER BY version')).rows;
let container;
try {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'")).rows;
  assert.equal(tables.length, 0, 'Use a dedicated empty database');
  if ((await pool.query("SELECT to_regclass('public.migrations') AS name")).rows[0].name) {
    assert.equal((await history()).length, 0, 'Use a database with no applied migrations');
  }
  console.log(docker(['run', '--rm', ...network, ...containerEnv, image, 'node', 'dist/infra/migrations/runner.js', 'up']));
  const applied = await history();
  assert.deepEqual(applied.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'Production image must apply migrations 001–013');
  for (const name of ['users', 'events', 'reservations', 'orders', 'tickets', 'payment_records', 'admission_events', 'admission_results']) {
    assert.equal((await pool.query('SELECT to_regclass($1) AS name', [`public.${name}`])).rows[0].name, name);
  }
  const rerun = docker(['run', '--rm', ...network, ...containerEnv, image, 'node', 'dist/infra/migrations/runner.js', 'up']);
  console.log(rerun);
  assert.match(rerun, /Total new: 0/);
  assert.deepEqual(await history(), applied, 'Rerun must leave migration history unchanged');
  const publish = process.env.IMAGE_NETWORK === 'host' ? [] : ['--publish', '127.0.0.1::3000'];
  container = docker(['run', '--detach', '--rm', ...network, ...containerEnv, ...publish, image]);
  const port = process.env.IMAGE_NETWORK === 'host' ? '3000' : docker(['port', container, '3000/tcp']).split(':').at(-1);
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) {
        const body = await response.json();
        assert.deepEqual(body.checks, { postgres: true, redis: true, admission: true });
        ready = true;
        break;
      }
    } catch { /* App may still be booting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Production app must become ready with PostgreSQL and Redis');
  const token = jwt.sign({ email: 'docker-check@example.test' }, env.JWT_SECRET, { subject: randomUUID(), expiresIn: '1m' });
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: '{ myOrders { id } }' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { myOrders: [] } });
  console.log('PASS: migrations 001–013, unchanged rerun, ready, signed GraphQL auth smoke');
} finally {
  if (container) docker(['stop', container]);
  await pool.end();
}
