// Owns an entire disposable Compose project. No external DB/Redis target option by design.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, totalmem, freemem, platform, release, tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { analyzeRun } from './flash-sale-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REVISION = 'flash-sale-v2.3';
const defaults = { users: 12, rate: 2, 'think-ms': 20, retries: 1, 'retry-delay-ms': 100, 'replay-every': 3, quantity: 2, 'pre-vus': 10, 'max-vus': 20, 'pool-max': 10, 'sample-ms': 250, 'warmup-seconds': 0, 'drain-seconds': 30, 'limiter-max': 1000000 };

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: Object.fromEntries([...Object.keys(defaults), 'stock', 'seats', 'run-id'].map(k => [k, { type: 'string' }])) });
  const s = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = values[key] === undefined ? fallback : Number(values[key]);
    const min = ['think-ms', 'retries', 'retry-delay-ms', 'replay-every', 'warmup-seconds'].includes(key) ? 0 : 1;
    assert.ok(Number.isSafeInteger(value) && value >= min && value <= 1_000_000, `Invalid --${key}`);
    s[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  assert.ok(s.users >= 2 && s.users % s.rate === 0, '--users must be >=2 and divisible by --rate');
  // ponytail: a 1ms guard needs an arrival interval >1ms; validate finer scheduling above 999/s.
  assert.ok(s.rate <= 999, '--rate must be <=999 for this millisecond arrival model');
  assert.ok(s.quantity <= 100 && s.preVus <= s.maxVus && s.poolMax >= 2, 'Invalid quantity/VU/pool bounds');
  s.durationSeconds = s.users / s.rate;
  s.measurementSeconds = s.durationSeconds - s.warmupSeconds;
  assert.ok(s.measurementSeconds >= 2 && s.sampleMs <= 250 && s.drainSeconds <= 240, 'Invalid measurement/sampling/drain window');
  assert.ok(s.durationSeconds >= 2 && s.durationSeconds <= 3600 && s.thinkMs <= 10000 && s.retries <= 5 && s.retryDelayMs <= 10000, 'Run must last 2–3600 scheduled seconds; think/retry bounds exceeded');
  s.stock = values.stock ?? 'ample';
  assert.ok(['ample', 'limited'].includes(s.stock), '--stock must be ample or limited');
  s.seats = values.seats === undefined ? (s.stock === 'ample' ? s.users * s.quantity : Math.max(s.quantity, Math.floor(s.users / 2) * s.quantity)) : Number(values.seats);
  assert.ok(Number.isSafeInteger(s.seats) && s.seats > 0 && s.seats <= 2147483647, 'Invalid --seats');
  assert.ok(s.stock === 'ample' ? s.seats >= s.users * s.quantity : s.seats < s.users * s.quantity, 'Stock mode disagrees with offered quantity');
  s.runId = values['run-id'] ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  assert.match(s.runId, /^[a-z0-9][a-z0-9-]{2,40}$/, 'Unsafe --run-id');
  return s;
}

export function assertTarget(owner, target) {
  assert.ok(target.host === '127.0.0.1' && target.database === owner.database && target.project === owner.project && target.marker === owner.marker, 'Refusing unowned fixture target');
}

export function redact(text, secrets = []) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export const sourceHash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

export async function summarizeRaw(path, durationSeconds) {
  const arrivals = {}, responses = {};
  let started = 0, first, last, maxObservedVUs = 0, maxAllocatedVUs = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const point = JSON.parse(line);
    if (point.type !== 'Point') continue;
    if (point.metric === 'buyers_started') {
      const second = new Date(point.data.time).toISOString().slice(0, 19);
      arrivals[second] = (arrivals[second] ?? 0) + point.data.value;
      started += point.data.value; first ??= point.data.time; last = point.data.time;
    }
    if (point.metric === 'api_responses') {
      const t = point.data.tags, key = [t.stage, t.kind, t.flow, t.status, t.error_code].join('/');
      responses[key] = (responses[key] ?? 0) + point.data.value;
    }
    if (['vus', 'active_vus_at_arrival'].includes(point.metric)) maxObservedVUs = Math.max(maxObservedVUs, point.data.value);
    if (point.metric === 'vus_max') maxAllocatedVUs = Math.max(maxAllocatedVUs, point.data.value);
  }
  return { started, startedPerScheduledSecond: started / durationSeconds, first, last, arrivalsByUTCSecond: arrivals, maxObservedVUs, maxAllocatedVUs, responseKey: 'stage/kind/flow/status/error_code', responses };
}

export function verifySnapshot(data, users, settings, metrics, exitCode) {
    const count = name => metrics[name]?.count ?? 0;
    const e = data.events[0];
    const activeHolds = data.reservations.filter(r => r.status === 'active').reduce((n, r) => n + r.quantity, 0);
    const allocated = data.orders.filter(o => ['pending', 'paid', 'delivered'].includes(o.status)).reduce((n, o) => n + o.quantity, 0);
    const byUser = new Map(users.map(u => [u.id, u]));
    const paidOrders = data.orders.filter(o => o.status === 'paid');
    const orderById = new Map(data.orders.map(o => [o.id, o]));
    const providerFacts = data.payments.filter(p => p.provider_transaction_id !== null);
    const legalFact = p => {
      const o = orderById.get(p.order_id), u = byUser.get(o?.user_id);
      return !!o && !!u && p.provider_transaction_id === u.provider && p.idempotency_key === u.callbackKey
        && p.status === 'settled' && (o.status === 'paid' || (o.status === 'expired' && p.reconciliation_required === true));
    };
    const checks = {
      inventory: e.available_seats >= 0 && e.available_seats + activeHolds + allocated === e.total_seats,
      singleOrderPerBuyer: new Set(data.orders.map(o => o.user_id)).size === data.orders.length,
      singleReservationPerBuyer: new Set(data.reservations.map(r => r.user_id)).size === data.reservations.length,
      orderIdentity: data.orders.every(o => byUser.get(o.user_id)?.checkoutKey === o.idempotency_key && o.quantity === settings.quantity && o.event_id === e.id),
      reservationIdentity: data.reservations.every(r => byUser.has(r.user_id) && r.quantity === settings.quantity && r.event_id === e.id),
      reservationConversion: data.reservations.every(r => r.status !== 'converted' || data.orders.filter(o => o.reservation_id === r.id && o.user_id === r.user_id && o.quantity === r.quantity).length === 1),
      ticketOwnership: data.tickets.every(t => data.orders.some(o => o.id === t.order_id && o.user_id === t.user_id && o.event_id === t.event_id && o.status === 'paid') && t.status === 'active'),
      ticketQuantity: data.orders.every(o => data.tickets.filter(t => t.order_id === o.id).length === (o.status === 'paid' ? o.quantity : 0)),
      settlementIdentity: data.orders.every(o => o.status !== 'paid' || data.payments.filter(p => p.order_id === o.id && p.provider_transaction_id === byUser.get(o.user_id)?.provider && p.status === 'settled').length === 1),
      noExtraSettlementFacts: providerFacts.every(legalFact)
        && new Set(providerFacts.map(p => p.order_id)).size === providerFacts.length
        && new Set(providerFacts.map(p => p.provider_transaction_id)).size === providerFacts.length
        && data.callbackKeys.length === providerFacts.length
        && data.callbackKeys.every(k => providerFacts.some(p => p.order_id === k.order_id && p.idempotency_key === k.idempotency_key
          && p.provider_transaction_id === k.provider_transaction_id && k.callback_status === 'settled')),
      callbackIdentity: data.orders.every(o => o.status !== 'paid' || data.callbackKeys.filter(k => k.order_id === o.id && k.idempotency_key === byUser.get(o.user_id)?.callbackKey && k.provider_transaction_id === byUser.get(o.user_id)?.provider && k.callback_status === 'settled').length === 1),
      noUnfinishedOrdersOrHolds: activeHolds === 0 && data.orders.every(o => o.status === 'paid'),
      completionsMatchSQL: count('buyers_completed') === data.orders.filter(o => o.status === 'paid').length,
      offeredStarted: count('buyers_started') === settings.users && count('dropped_iterations') === 0,
      expectedPurchases: count('buyers_completed') === (settings.stock === 'ample' ? settings.users : Math.floor(settings.seats / settings.quantity)),
      noUnexpectedFailures: count('unexpected_failures') === 0 && count('replay_failures') === 0 && exitCode === 0,
    };
    const integrityNames = ['inventory', 'singleOrderPerBuyer', 'singleReservationPerBuyer', 'orderIdentity', 'reservationIdentity',
      'reservationConversion', 'ticketOwnership', 'ticketQuantity', 'settlementIdentity', 'noExtraSettlementFacts', 'callbackIdentity'];
    const ordersByStatus = {};
    for (const order of data.orders) ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
    return { checks, integrityPassed: integrityNames.every(k => checks[k]), integrityNames,
      passed: Object.values(checks).every(Boolean), counts: { offered: settings.users, started: count('buyers_started'),
        completed: count('buyers_completed'), dropped: count('dropped_iterations'), paidOrders: paidOrders.length,
        ordersByStatus, tickets: data.tickets.length, activeHolds },
      inventory: { available: e.available_seats, activeHolds, allocated, total: e.total_seats } };
}

export async function main(args = process.argv.slice(2)) {
  assert.equal(Object.keys(process.env).filter(k => k.startsWith('K6_')).length, 0, 'Inherited K6_* overrides must be removed before measuring');
  const settings = parseOptions(args);
  const project = `peakpass-fs-${settings.runId}`;
  const owner = { project, database: `fs_${settings.runId.replaceAll('-', '_')}`, marker: randomUUID() };
  const output = join(root, 'load-test/results/flash-sale', settings.runId);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite an earlier evidence run.
  const privateDir = await mkdtemp(join(tmpdir(), 'peakpass-fs-'));
  const secret = () => randomBytes(32).toString('hex');
  const env = { ...process.env, FS_DATABASE: owner.database, FS_DB_PASSWORD: secret(), FS_JWT_SECRET: secret(), FS_WEBHOOK_SECRET: secret(), FS_API_KEY: secret(),
    FS_IMAGE: `peakpass:fs-${settings.runId}`, FS_POOL_MAX: String(settings.poolMax), FS_SAMPLE_MS: String(settings.sampleMs),
    // Enough for all callbacks/replays/retries in one shared provider-IP window. Limiter stays ON.
    FS_RATE_LIMIT: String(settings.limiterMax) };
  const secrets = [env.FS_DB_PASSWORD, env.FS_JWT_SECRET, env.FS_WEBHOOK_SECRET, env.FS_API_KEY, owner.marker];
  const clean = text => redact(text, secrets);
  const save = (name, value) => writeFile(join(output, name), clean(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  const manifest = { revision: REVISION, runId: settings.runId, project, startedAt: new Date().toISOString(), settings,
    machine: { platform: platform(), release: release(), cpuModel: cpus()[0]?.model, logicalCPUs: cpus().length, memoryBytes: totalmem(), node: process.version },
    application: { poolMin: 2, poolMax: settings.poolMax, sampleMs: settings.sampleMs, logLevel: 'info', fastifyRequestLogLevel: 'info', auth: 'distinct HS256 JWT sub; HMAC SHA256 provider callbacks', enforceAuthUserMatch: true, demoSession: false,
      limiter: { enabled: true, failMode: 'closed', windowMs: 60000, maxRequests: Number(env.FS_RATE_LIMIT), scope: 'experiment only; callbacks share source IP' }, paymentWindowMinutes: 10, sweepIntervalMs: 500, sweepBatchSize: 20 }, commands: [] };
  let interrupted = false, cleaning = false, k6Pid;
  const children = new Set();
  const interrupt = () => { interrupted = true; for (const child of children) child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function command(binary, argv, logName, allowFailure = false) {
    if (interrupted && !cleaning) throw new Error('Run interrupted');
    const entry = { binary, argv, at: new Date().toISOString() };
    manifest.commands.push(entry);
    const child = spawn(binary, argv, { cwd: root, env, windowsHide: true });
    children.add(child);
    if (binary === 'k6' && argv[0] === 'run') k6Pid = child.pid;
    const log = logName ? createWriteStream(join(output, logName)) : null;
    const consume = async stream => {
      let tail = '';
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        const safe = clean(line) + '\n';
        if (log && !log.write(safe)) await once(log, 'drain');
        // Large app logs stay on disk. Callers only consume small metadata or this diagnostic tail.
        tail = (tail + safe).slice(-65536);
      }
      return tail;
    };
    const [stdout, stderr, [code]] = await Promise.all([consume(child.stdout), consume(child.stderr), once(child, 'close')]);
    children.delete(child);
    if (log) { log.end(); await once(log, 'finish'); }
    const result = { stdout, stderr, code };
    entry.exitCode = result.code;
    if (result.code !== 0 && !allowFailure) throw new Error(clean(`${binary} ${argv.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`));
    return result;
  }
  await writeFile(join(privateDir, 'empty.env'), '', { mode: 0o600 });
  const composeArgs = ['compose', '--env-file', join(privateDir, 'empty.env'), '-f', 'docker-compose.flash-sale.yml', '-p', project];
  const compose = (args, logName, allowFailure) => command('docker', [...composeArgs, ...args], logName, allowFailure);
  let owned = false, db, redis, fixture, monitor, resourceMonitor, monitoring = false, appStarted = false;
  const monitorStop = new AbortController();
  let failed;
  async function guard() {
    const result = await db.query('SELECT current_database() AS database, project, marker FROM flash_sale_run');
    assert.equal(result.rows.length, 1, 'Missing run marker');
    assertTarget(owner, { host: '127.0.0.1', ...result.rows[0] });
  }
  async function snapshot() {
    await guard();
    const id = fixture.eventId;
    const tables = {};
    for (const table of ['events', 'reservations', 'orders', 'tickets']) {
      tables[table] = (await db.query(`SELECT * FROM ${table} WHERE ${table === 'events' ? 'id' : 'event_id'} = $1 ORDER BY id`, [id])).rows;
    }
    tables.payments = (await db.query('SELECT p.* FROM payment_records p JOIN orders o ON o.id=p.order_id WHERE o.event_id=$1 ORDER BY p.id', [id])).rows;
    tables.callbackKeys = (await db.query('SELECT k.* FROM payment_callback_keys k JOIN orders o ON o.id=k.order_id WHERE o.event_id=$1 ORDER BY k.idempotency_key', [id])).rows;
    return tables;
  }
  async function clockCheck() {
    const before = Date.now();
    const remote = Number((await db.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms);
    const after = Date.now();
    (manifest.clockChecks ??= []).push({ at: new Date(after).toISOString(), offsetMs: remote - (before + after) / 2, roundTripMs: after - before });
  }
  async function evidenceStep(name, action) {
    try { await action(); }
    catch (err) { (manifest.evidenceErrors ??= []).push({ step: name, error: clean(err.message) }); failed ??= err; }
  }
  try {
    for (const [binary, argv, key] of [['git', ['rev-parse', 'HEAD'], 'commit'], ['git', ['status', '--porcelain'], 'workingTree'], ['k6', ['version'], 'k6'], ['docker', ['version', '--format', '{{json .}}'], 'dockerVersion'], ['docker', ['info', '--format', '{{json .}}'], 'dockerInfo']]) {
      const value = (await command(binary, argv)).stdout.trim();
      if (key === 'dockerInfo') { const info = JSON.parse(value); manifest.dockerResources = { cpus: info.NCPU, memoryBytes: info.MemTotal, os: info.OperatingSystem, architecture: info.Architecture }; }
      else manifest[key] = key === 'dockerVersion' ? JSON.parse(value) : value;
    }
    manifest.sourceHashAlgorithm = 'sha256-utf8-canonical-lf';
    manifest.sourceHashes = {}; manifest.rawSourceHashes = {};
    for (const file of ['load-test/flash-sale.js', 'load-test/flash-sale-fixture.mjs', 'load-test/flash-sale-analysis.mjs', 'load-test/flash-sale-check.mjs', 'docker-compose.flash-sale.yml', 'Dockerfile', 'package-lock.json', 'src/infra/config.ts', 'src/infra/postgres/client.ts']) {
      manifest.rawSourceHashes[file] = await fileHash(join(root, file));
      manifest.sourceHashes[file] = sourceHash(await readFile(join(root, file), 'utf8'));
    }
    for (const argv of [['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]]) {
      assert.equal((await command('docker', argv)).stdout.trim(), '', 'Compose project already owns resources; refusing reuse');
    }
    owned = true;
    console.log(`[${settings.runId}] Building and starting isolated PostgreSQL/Redis`);
    await compose(['build', 'app'], 'build.txt');
    await compose(['up', '-d', '--wait', 'postgres', 'redis'], 'services.txt');
    const port = async (service, number) => {
      const address = (await compose(['port', service, String(number)])).stdout.trim();
      assert.match(address, /^127\.0\.0\.1:\d+$/, 'Expected loopback-only published port');
      return Number(address.split(':').at(-1));
    };
    const dbPort = await port('postgres', 5432), redisPort = await port('redis', 6379);
    db = new pg.Client({ host: '127.0.0.1', port: dbPort, database: owner.database, user: 'flash_sale', password: env.FS_DB_PASSWORD, application_name: 'fs_observer', connectionTimeoutMillis: 5000, query_timeout: 5000 });
    await db.connect();
    const actualDB = (await db.query('SELECT current_database() AS name')).rows[0].name;
    assert.equal(actualDB, owner.database);
    assert.equal(Number((await db.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).rows[0].count), 0, 'Database must start empty');
    await db.query('CREATE TABLE flash_sale_run (project text NOT NULL, marker text NOT NULL)');
    await db.query('INSERT INTO flash_sale_run VALUES ($1,$2)', [project, owner.marker]);
    await guard();
    await compose(['run', '--rm', '--no-deps', 'app', 'node', 'dist/infra/migrations/runner.js', 'up'], 'migrations.txt');
    redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, reconnectStrategy: false, connectTimeout: 5000 }, disableOfflineQueue: true });
    redis.on('error', () => {});
    await redis.connect();
    manifest.postgresVersion = (await db.query('SELECT version()')).rows[0].version;
    manifest.redisVersion = (await redis.info('server')).match(/^redis_version:(.+)$/m)?.[1].trim();
    const users = Array.from({ length: settings.users }, () => {
      const id = randomUUID();
      return { id, token: jwt.sign({}, env.FS_JWT_SECRET, { subject: id, algorithm: 'HS256', expiresIn: '2h' }), checkoutKey: randomUUID(), callbackKey: randomUUID(), provider: randomUUID() };
    });
    fixture = { settings, eventId: randomUUID(), tierId: 'standard', users, sentinelUser: randomUUID(), sentinelEvent: randomUUID() };
    await db.query('BEGIN');
    try {
      // Synthetic addresses never leave the database; no production identities are used.
      await db.query("INSERT INTO users(id,email,name) SELECT x::uuid, x || '@example.invalid', 'Synthetic buyer' FROM unnest($1::text[]) x", [users.map(u => u.id)]);
      await db.query("INSERT INTO users(id,email,name) VALUES ($1,$2,'Unrelated sentinel')", [fixture.sentinelUser, `${fixture.sentinelUser}@example.invalid`]);
      for (const [id, seats, name] of [[fixture.eventId, settings.seats, project], [fixture.sentinelEvent, 7, 'Unrelated sentinel']]) {
        await db.query("INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status) VALUES ($1,$2,now()+interval '1 day',now()+interval '2 days',$3,$3,$4,'published')", [id, name, seats, JSON.stringify([{ id: fixture.tierId, name: 'Standard', price: 100, quantity: seats }])]);
      }
      await db.query('COMMIT');
    } catch (err) { await db.query('ROLLBACK'); throw err; }
    env.FS_FIXTURE = join(privateDir, 'fixture.json');
    env.FS_MODEL = JSON.stringify({ settings, eventId: fixture.eventId, tierId: fixture.tierId });
    await writeFile(env.FS_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
    manifest.fixture = { eventId: fixture.eventId, userIds: users.map(u => u.id), tierId: fixture.tierId, synthetic: true, sentinelEvent: fixture.sentinelEvent, sentinelUser: fixture.sentinelUser };
    await compose(['up', '-d', '--wait', 'app'], 'app-start.txt');
    appStarted = true;
    env.FS_BASE_URL = `http://127.0.0.1:${await port('app', 3000)}`;
    manifest.endpoints = { baseURL: env.FS_BASE_URL, dbHost: '127.0.0.1', dbPort, database: owner.database, redisHost: '127.0.0.1', redisPort };
    manifest.containers = [];
    for (const service of ['app', 'postgres', 'redis']) {
      const id = (await compose(['ps', '-q', service])).stdout.trim();
      const c = JSON.parse((await command('docker', ['inspect', id])).stdout)[0];
      assert.equal(c.Config.Labels['com.docker.compose.project'], project);
      const img = JSON.parse((await command('docker', ['image', 'inspect', c.Image])).stdout)[0];
      manifest.containers.push({ service, id, image: c.Image, repoDigests: img.RepoDigests, nanoCPUs: c.HostConfig.NanoCpus, memoryBytes: c.HostConfig.Memory, ports: c.NetworkSettings.Ports });
    }
    manifest.appNode = (await compose(['exec', '-T', 'app', 'node', '--version'])).stdout.trim();
    manifest.appNpm = (await compose(['exec', '-T', 'app', 'npm', '--version'])).stdout.trim();
    const before = await snapshot();
    const baseBody = { eventId: fixture.eventId, userId: users[0].id, tierId: fixture.tierId, quantity: settings.quantity };
    const negatives = [];
    for (const [name, route, body, headers, expected] of [
      ['invalid-jwt', '/reservations', baseBody, { Authorization: 'Bearer invalid' }, 401],
      ['user-mismatch', '/reservations', { ...baseBody, userId: users[1].id }, { Authorization: `Bearer ${users[0].token}` }, 403],
      ['invalid-hmac', '/webhooks/payments/settlement', { orderId: randomUUID(), providerTransactionId: randomUUID(), status: 'settled' }, { 'x-webhook-signature': '0'.repeat(64), 'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'Idempotency-Key': randomUUID() }, 401],
    ]) {
      const response = await fetch(env.FS_BASE_URL + route, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(10000) });
      await response.arrayBuffer();
      negatives.push({ kind: 'negative', name, status: response.status, expected });
    }
    await save('negative-checks.json', { checks: negatives, dataUnchanged: JSON.stringify(before) === JSON.stringify(await snapshot()) });
    assert.ok(negatives.every(n => n.status === n.expected), 'Authentication negative checks failed');
    assert.deepEqual(await snapshot(), before, 'Rejected requests changed fixture data');
    await save('redis-before.txt', await redis.info('commandstats'));
    await clockCheck();
    monitoring = true;
    monitor = (async () => {
      while (monitoring) {
        const at = new Date().toISOString();
        try {
          const activity = (await db.query(`SELECT count(*) FILTER (WHERE state='active')::int AS active,
            count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters
            FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND application_name <> 'fs_observer'`)).rows[0];
          const locks = (await db.query(`SELECT l.locktype, count(*)::int AS waiting,
            COALESCE(max(extract(epoch FROM (clock_timestamp()-l.waitstart))*1000),0)::float8 AS oldest_wait_ms
            FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database() AND a.application_name <> 'fs_observer' GROUP BY l.locktype`)).rows;
          const start = performance.now(); await redis.ping(); const redisPingRttMs = performance.now() - start;
          await appendFile(join(output, 'observations.jsonl'), JSON.stringify({ at, activity, locks, redisPingRttMs }) + '\n');
        } catch (err) { await appendFile(join(output, 'observations.jsonl'), JSON.stringify({ at, error: clean(err.message) }) + '\n'); }
        try { await delay(settings.sampleMs, undefined, { signal: monitorStop.signal }); } catch { break; }
      }
    })();
    let previousCpu = cpus();
    resourceMonitor = (async () => {
      while (monitoring) {
        const at = new Date().toISOString();
        try {
          let generator = null;
          if (k6Pid) {
            if (platform() === 'win32') {
              const r = await command('powershell.exe', ['-NoProfile', '-Command', `$all = @(Get-CimInstance Win32_Process -Filter "Name='k6.exe'"); $ids = @(${k6Pid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count); $p = @(Get-Process -Id $ids -ErrorAction SilentlyContinue); if ($p.Count) { [pscustomobject]@{ cpuSeconds=($p | Measure-Object CPU -Sum).Sum; memoryBytes=($p | Measure-Object WorkingSet64 -Sum).Sum; pids=@($p.Id); processes=@($p | ForEach-Object { [pscustomobject]@{ pid=$_.Id; path=$_.Path; cpuSeconds=$_.CPU; memoryBytes=$_.WorkingSet64; isShim=[bool]([Diagnostics.FileVersionInfo]::GetVersionInfo($_.Path).FileDescription -match 'ShimGen') } }) } | ConvertTo-Json -Depth 4 -Compress }`]);
              if (r.stdout.trim()) generator = JSON.parse(r.stdout);
            } else {
              const r = await command('ps', ['-p', String(k6Pid), '-o', 'cputime=', '-o', 'rss=', '-o', 'comm='], undefined, true);
              const [time, rss, ...name] = r.stdout.trim().split(/\s+/);
              if (time) { const process = { pid: k6Pid, path: name.join(' '), isShim: false, cpuSeconds: time.split(':').reduce((n, part) => n * 60 + Number(part), 0), memoryBytes: Number(rss) * 1024 }; generator = { ...process, processes: [process] }; }
            }
          }
          const r = await command('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...manifest.containers.map(c => c.id)]);
          const samples = r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
          const currentCpu = cpus();
          let idle = 0, total = 0;
          currentCpu.forEach((cpu, i) => { for (const key of Object.keys(cpu.times)) { const delta = cpu.times[key] - previousCpu[i].times[key]; total += delta; if (key === 'idle') idle += delta; } });
          previousCpu = currentCpu;
          await saveResource({ at, endedAt: new Date().toISOString(), generator, hostCpuPercent: total ? (1 - idle / total) * 100 : 0,
            hostFreeBytes: freemem(), harnessMemoryBytes: process.memoryUsage().rss,
            containers: samples.map(c => ({ service: manifest.containers.find(x => x.id.startsWith(c.ID))?.service, cpuPercent: parseFloat(c.CPUPerc), memoryPercent: parseFloat(c.MemPerc), memoryUsage: c.MemUsage })) });
        } catch (err) { await saveResource({ at, error: clean(err.message) }); }
        try { await delay(500, undefined, { signal: monitorStop.signal }); } catch { break; }
      }
    })();
    async function saveResource(value) { await appendFile(join(output, 'resources.jsonl'), JSON.stringify(value) + '\n'); }
    console.log(`[${settings.runId}] Real authenticated HTTP: ${settings.users} buyers, ${settings.rate}/s, ${settings.stock}`);
    manifest.loadStartedAt = new Date().toISOString();
    const result = await command('k6', ['run', '--out', `json=${join(output, 'k6-raw.jsonl')}`, '--summary-export', join(output, 'k6-summary.json'), 'load-test/flash-sale.js'], 'k6.txt', true);
    manifest.loadEndedAt = new Date().toISOString();
    manifest.k6ExitCode = result.code;
    await clockCheck();
    monitoring = false; monitorStop.abort(); await monitor; await resourceMonitor;
    await save('traffic.json', await summarizeRaw(join(output, 'k6-raw.jsonl'), settings.durationSeconds));
    await save('redis-after.txt', await redis.info('commandstats'));
    await compose(['stop', 'app'], 'app-stop.txt'); appStarted = false;
    const data = await snapshot();
    await save('sql-snapshot.json', data);
    const summary = JSON.parse(await readFile(join(output, 'k6-summary.json'), 'utf8'));
    const verification = verifySnapshot(data, users, settings, summary.metrics, result.code);
    const checks = verification.checks;
    await save('verification.json', verification);
    assert.ok(Object.values(checks).every(Boolean), `Post-run verification failed: ${Object.entries(checks).filter(([,v]) => !v).map(([k]) => k).join(', ')}`);
  } catch (err) { failed = err; manifest.error = clean(err.message); }
  finally {
    cleaning = true;
    monitoring = false; monitorStop.abort(); if (monitor) await monitor;
    if (resourceMonitor) await resourceMonitor;
    if (owned) {
      await evidenceStep('stop-app', async () => { if (appStarted) await compose(['stop', 'app'], 'app-stop.txt'); });
      await evidenceStep('app-logs', async () => {
        await compose(['logs', '--no-color', '--no-log-prefix', 'app'], 'app.jsonl');
        const poolSamples = [], retrySamples = [];
        for await (const line of createInterface({ input: createReadStream(join(output, 'app.jsonl')), crlfDelay: Infinity })) {
          let value; try { value = JSON.parse(line); } catch { continue; }
          if (value.metric === 'postgres_pool') poolSamples.push(value);
          if (value.msg === 'Serialization conflict, retrying transaction') retrySamples.push({ time: value.time, code: value.code, attempt: value.attempt });
        }
        await save('app-metrics.json', { poolSamples, retrySamples, transactionRetriesScheduled: retrySamples.length });
      });
      await evidenceStep('final-sql', async () => {
        if (db && fixture) { const data = await snapshot(); await save('sql-before-cleanup.json', data);
          try { await readFile(join(output, 'sql-snapshot.json')); } catch { await save('sql-snapshot.json', data); } }
      });
      try {
        if (db && fixture) {
          await guard();
          await db.query('BEGIN');
          try {
            const id = fixture.eventId;
            await db.query('DELETE FROM tickets WHERE event_id=$1', [id]);
            await db.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)', [id]);
            await db.query('DELETE FROM orders WHERE event_id=$1', [id]);
            await db.query('DELETE FROM reservations WHERE event_id=$1', [id]);
            await db.query('DELETE FROM events WHERE id=$1', [id]);
            await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [fixture.users.map(u => u.id)]);
            const remaining = (await db.query('SELECT (SELECT count(*) FROM events WHERE id=$1) AS event, (SELECT count(*) FROM users WHERE id=ANY($2::uuid[])) AS users, (SELECT available_seats FROM events WHERE id=$3) AS sentinel_seats, (SELECT count(*) FROM users WHERE id=$4) AS sentinel_users', [id, fixture.users.map(u => u.id), fixture.sentinelEvent, fixture.sentinelUser])).rows[0];
            assert.deepEqual(remaining, { event: '0', users: '0', sentinel_seats: 7, sentinel_users: '1' });
            await db.query('COMMIT');
            await save('cleanup.json', { passed: true, ...remaining });
          } catch (err) { await db.query('ROLLBACK'); throw err; }
        }
      } catch (err) { manifest.cleanupError = clean(err.message); failed ??= err; }
    }
    if (redis?.isOpen) await redis.disconnect();
    if (db) await db.end().catch(() => {});
    if (owned) {
      try { await compose(['down', '--volumes', '--remove-orphans'], 'teardown.txt'); }
      catch (err) { manifest.teardownError = clean(err.message); failed ??= err; }
    }
    // mkdtemp returned this exact directory, not a user-supplied/computed cleanup target.
    await rm(privateDir, { recursive: true, force: true });
    manifest.finishedAt = new Date().toISOString(); manifest.passed = !failed; manifest.smokePassed = !failed;
    try {
      const analysis = await analyzeRun(output, manifest);
      await save('analysis.json', analysis);
      if (['invalid-measurement', 'integrity-defect'].includes(analysis.classification)) {
        manifest.analysisError = analysis.classification + ': ' + analysis.invalidReasons.join(',');
        failed ??= new Error(manifest.analysisError); manifest.passed = false;
      }
    } catch (err) {
      manifest.analysisError = clean(err.message); manifest.passed = false; failed ??= err;
      await save('analysis.json', { revision: REVISION, runId: settings.runId, classification: 'invalid-measurement', error: clean(err.message) });
    }
    manifest.artifactHashes = {};
    for (const file of await readdir(output)) manifest.artifactHashes[file] = await fileHash(join(output, file));
    await save('manifest.json', manifest);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  if (failed) throw new Error(clean(failed.message));
  console.log(`PASS: ${output}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
