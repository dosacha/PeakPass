import { execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { randomUUID, createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { RedisClientType } from 'redis';

const enabled = process.env.WAVE3_REDIS_DESTRUCTIVE === '1';
const suite = enabled ? describe : describe.skip;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Redis state transition timed out');
    await delay(20);
  }
}
function container(action: 'stop' | 'start' | 'pause' | 'unpause') {
  const name = process.env.WAVE3_REDIS_CONTAINER;
  const id = process.env.WAVE3_REDIS_CONTAINER_ID;
  if (!enabled || name !== 'peakpass-wave3-0928-redis' || !id ||
      process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '63532') {
    throw new Error('Requires explicit dedicated Wave3 Redis fixture opt-in');
  }
  const metadata = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
  if (metadata.Id !== id || metadata.Config.Labels['peakpass.task'] !== 'wave3') {
    throw new Error('Redis fixture ownership mismatch');
  }
  if (action === 'start' && metadata.State.Paused) execFileSync('docker', ['unpause', id], { windowsHide: true });
  execFileSync('docker', action === 'stop' ? ['stop', '-t', '0', id] : [action, id], { windowsHide: true });
  process.stdout.write(JSON.stringify({ action, time: new Date().toISOString(), pid: process.pid }) + '\n');
}

suite('terminal Redis recovery with real dedicated container and HTTP', () => {
  let redis: typeof import('@/infra/redis/client');
  let commands: typeof import('@/infra/redis/commands');
  let pg: typeof import('@/infra/postgres/client');
  let app: FastifyInstance;
  let clients: RedisClientType[];
  let connects: number;
  let retries: number[];
  let events: string[];
  let token: string;
  let input: { eventId: string; userId: string; tierId: string; quantity: number };
  const signingSecret = 'wave3-recovery-test-only-signing-secret';

  beforeEach(async () => {
    jest.resetModules();
    clients = []; connects = 0; retries = []; events = [];
    process.env.RATE_LIMIT_FAIL_MODE = 'closed';
    process.env.ENABLE_RATE_LIMITING = 'true';
    process.env.WEBHOOK_SIGNING_SECRET = signingSecret;
    process.env.RATE_LIMIT_MAX_REQUESTS = '1000';
    process.env.LOG_LEVEL = 'fatal';
    const library = await import('redis');
    const original = library.createClient;
    jest.spyOn(library, 'createClient').mockImplementation(((options: Parameters<typeof original>[0]) => {
      const strategy = options!.socket!.reconnectStrategy as (n: number, err: Error) => number | Error | false;
      options!.socket!.reconnectStrategy = (n, err) => { retries.push(n); return strategy(n, err); };
      const client = original(options) as RedisClientType;
      const connect = client.connect.bind(client);
      jest.spyOn(client, 'connect').mockImplementation(() => { connects++; return connect(); });
      const clientIndex = clients.length;
      const clientEvents = events;
      for (const event of ['error', 'end', 'reconnecting', 'ready']) {
        client.on(event, () => clientEvents.push(`${clientIndex}:${event}:${client.isOpen}:${client.isReady}`));
      }
      clients.push(client);
      return client;
    }) as typeof original);
    redis = await import('@/infra/redis/client');
    commands = await import('@/infra/redis/commands');
  });

  afterEach(async () => {
    // Restore the owned fixture even when the RED assertion fails.
    container('start');
    if (app) await app.close();
    if (pg) await pg.closePostgresPool();
    await redis.closeRedis().catch(() => undefined);
    for (const client of clients) if (client.isOpen) await client.disconnect();
    process.stdout.write(JSON.stringify({ pid: process.pid, factories: clients.length, connects, retries, events }) + '\n');
    jest.restoreAllMocks();
  });

  function request(url: string, orderId = randomUUID()) {
    if (url === '/webhooks/payments/settlement') {
      const payload = JSON.stringify({ orderId, providerTransactionId: randomUUID(), status: 'settled' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      return app.inject({ method: 'POST', url, payload, headers: {
        'content-type': 'application/json', 'idempotency-key': randomUUID(),
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': createHmac('sha256', signingSecret).update(`${timestamp}.${payload}`).digest('hex'),
      } });
    }
    return app.inject({ method: 'POST', url,
      payload: url === '/graphql' ? { query: '{ __typename }' } : input,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });
  }

  it('recovers after real retry exhaustion, shares failed/successful recreations, and restores HTTP/hold/lock use in the same PID', async () => {
    const pid = process.pid;
    const first = await redis.initRedis();
    pg = await import('@/infra/postgres/client');
    const pool = await pg.initPostgresPool();
    input = { eventId: randomUUID(), userId: randomUUID(), tierId: randomUUID(), quantity: 1 };
    await pool.query('INSERT INTO users(id,email) VALUES ($1,$2)', [input.userId, `${input.userId}@recovery.test`]);
    await pool.query(`INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'Recovery',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',20,20,$2,'published')`,
    [input.eventId, JSON.stringify([{ id: input.tierId, name: 'General', price: 50, quantity: 20 }])]);
    token = jwt.sign({ sub: input.userId }, (await import('@/infra/config')).getConfig().JWT_SECRET);
    app = await (await import('@/api/app')).createApp();
    await app.ready();
    expect((await app.inject('/ready')).statusCode).toBe(200);
    container('stop');
    await until(() => !first.isOpen);
    expect(first.isReady).toBe(false);
    expect(retries).toContain(11);
    process.stdout.write(JSON.stringify({ terminal: new Date().toISOString(), pid, isOpen: first.isOpen, isReady: first.isReady }) + '\n');

    const before = clients.length;
    const start = Date.now();
    const results = await Promise.all(['/reservations', '/checkouts', '/webhooks/payments/settlement', '/graphql'].map((url) => request(url)));
    for (const result of results) {
      expect(result.statusCode).toBe(503);
      expect(result.json().error.code).toBe('RATE_LIMIT_UNAVAILABLE');
      expect(result.headers['x-ratelimit-limit']).toBeUndefined();
    }
    expect(Date.now() - start).toBeLessThan(16000);
    const failedFactories = clients.length - before;
    expect(clients[clients.length - 1].isOpen).toBe(false);
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect(await commands.checkRateLimit('open-mode', 'graphql', 10, 1000, 'open')).toMatchObject({ allowed: true, redisAvailable: false });

    container('start');
    const beforeRecovery = clients.length;
    const recovered = await Promise.all(Array.from({ length: 20 }, (_, i) => commands.checkRateLimit(`recovered-${i}`, 'graphql', 10, 1000)));
    expect(recovered.every((result) => result.allowed && result.redisAvailable)).toBe(true);
    expect(failedFactories).toBe(1);
    expect(clients.length - beforeRecovery).toBe(1);
    expect(connects).toBe(clients.length);
    const current = redis.getRedis();
    expect(current).not.toBe(first);
    expect(first.isOpen).toBe(false);
    expect((await app.inject('/ready')).statusCode).toBe(200);
    expect((await request('/graphql')).statusCode).toBe(200);
    const reservation = await request('/reservations');
    expect(reservation.statusCode).toBe(201);
    expect(await commands.getReservationHold(reservation.json().id)).not.toBeNull();
    const checkoutKey = randomUUID();
    const checkout = await app.inject({ method: 'POST', url: '/checkouts', payload: input,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': checkoutKey } });
    expect(checkout.statusCode).toBe(201);
    const settlement = await request('/webhooks/payments/settlement', checkout.json().order.id);
    expect(settlement.statusCode).toBe(200);
    expect(settlement.json().tickets).toHaveLength(1);
    expect(await current.get(`peakpass:idempotency:checkout:${checkoutKey}`)).toBeNull();
    const key = randomUUID();
    const stale = await commands.tryAcquireIdempotencyLock('checkout', key, 1);
    // Observe expiry through Redis, not a sleep assumption.
    const expires = Date.now() + 3000;
    while (await current.exists(`peakpass:idempotency:lock:checkout:${key}`)) {
      if (Date.now() > expires) throw new Error('Lock TTL did not expire');
      await delay(20);
    }
    const owner = await commands.tryAcquireIdempotencyLock('checkout', key, 30);
    expect(owner).not.toBe(stale);
    await commands.releaseIdempotencyLock('checkout', key, stale!);
    expect(await current.get(`peakpass:idempotency:lock:checkout:${key}`)).toBe(owner);
    await commands.releaseIdempotencyLock('checkout', key, owner!);
    expect(await current.exists(`peakpass:idempotency:lock:checkout:${key}`)).toBe(0);
    expect(process.pid).toBe(pid);
    process.stdout.write(JSON.stringify({ recovered: new Date().toISOString(), pid, factories: clients.length, connects }) + '\n');
  }, 90000);

  it('bounds already-ready commands during actual Redis pause, retires their queue, and recovers in the same PID', async () => {
    const pid = process.pid;
    const first = await redis.initRedis();
    pg = await import('@/infra/postgres/client');
    await pg.initPostgresPool();
    app = await (await import('@/api/app')).createApp();
    await app.ready();
    input = { eventId: randomUUID(), userId: randomUUID(), tierId: randomUUID(), quantity: 1 };
    token = jwt.sign({ sub: input.userId }, (await import('@/infra/config')).getConfig().JWT_SECRET);
    expect((await app.inject('/ready')).statusCode).toBe(200);
    expect((await request('/graphql')).statusCode).toBe(200);
    container('pause');
    const started = Date.now();
    expect(first.isOpen && first.isReady).toBe(true);
    const queued = first.ping().then(() => 'replied', () => 'rejected');
    const requests = Promise.all([
      app.inject('/ready'),
      ...['/reservations', '/checkouts', '/webhooks/payments/settlement', '/graphql'].map((url) => request(url)),
    ]);
    let deadline: NodeJS.Timeout | undefined;
    try {
      const responses = await Promise.race([requests, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Ready-client outage exceeded 6500ms')), 6500);
      })]);
      expect(responses.map((response) => response.statusCode)).toEqual([503, 503, 503, 503, 503]);
      expect(responses[0].json().checks.redis).toBe(false);
      for (const response of responses.slice(1)) {
        expect(response.json().error.code).toBe('RATE_LIMIT_UNAVAILABLE');
        expect(response.headers['x-ratelimit-limit']).toBeUndefined();
      }
      expect(await queued).toBe('rejected');
      expect(first.isOpen).toBe(false);
      expect(first.isReady).toBe(false);
      expect(clients).toHaveLength(1);
      expect((await app.inject('/health')).statusCode).toBe(200);
      process.stdout.write(JSON.stringify({ phase: 'paused-timeout', pid, elapsedMs: Date.now() - started,
        statuses: responses.map((response) => response.statusCode), oldOpen: first.isOpen, oldReady: first.isReady }) + '\n');
    } finally {
      clearTimeout(deadline);
      container('unpause');
      await requests;
      await queued;
    }
    const responses = await Promise.all([app.inject('/ready'), request('/graphql')]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(clients).toHaveLength(2);
    expect(connects).toBe(2);
    expect(redis.getRedis()).not.toBe(first);
    expect(process.pid).toBe(pid);
    process.stdout.write(JSON.stringify({ phase: 'unpaused-recovered', pid, factories: clients.length, connects }) + '\n');

    // Shutdown while requests are stalled cancels their timers and permanently prevents recovery.
    container('pause');
    const stalled = Promise.all([app.inject('/ready'), request('/graphql')]);
    try {
      await delay(50);
      await redis.closeRedis();
      expect((await stalled).map((response) => response.statusCode)).toEqual([503, 503]);
      expect(await commands.checkRateLimit('closed-after-pause', 'graphql', 10, 1000)).toMatchObject({ redisAvailable: false });
      expect(clients).toHaveLength(2);
    } finally {
      container('unpause');
      await stalled;
    }
  }, 30000);
  it('shutdown during real reconnect prevents later command/probe/explicit-init recreation', async () => {
    const client = await redis.initRedis();
    container('stop');
    await until(() => events.some((event) => event.includes(':reconnecting:')));
    await expect(redis.initRedis()).rejects.toThrow('Redis unavailable');
    pg = await import('@/infra/postgres/client');
    await pg.initPostgresPool();
    app = await (await import('@/api/app')).createApp();
    await app.ready();
    await redis.closeRedis();
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
    const count = clients.length;
    expect(await commands.checkRateLimit('shutdown', 'graphql', 10, 1000)).toMatchObject({ allowed: false, redisAvailable: false });
    await expect(redis.initRedis()).rejects.toThrow();
    container('start');
    await delay(1100); // allow the already scheduled upstream callback to drain
    expect(client.isOpen).toBe(false);
    expect(client.isReady).toBe(false);
    expect(clients).toHaveLength(count);
  }, 30000);

  it('initial Redis absence rejects startup and closes resources', async () => {
    container('stop');
    await expect(redis.initRedis()).rejects.toThrow();
    expect(clients[0].isOpen).toBe(false);
    await expect(redis.closeRedis()).resolves.toBeUndefined();
  }, 30000);

  it.each(['reconnecting', 'recreating', 'startup'])('child process exits naturally during %s with real Redis outage', async (mode) => {
    if (mode === 'startup') container('stop');
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/redis-lifecycle-child.ts'), mode], {
      windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const states: string[] = [];
    let childErrors = '';
    child.stderr!.on('data', (data) => { childErrors += data; });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', (message: { state: string }) => states.push(message.state));
    try {
      if (mode !== 'startup') {
        await until(() => states.includes('ready'));
        container('stop');
        await until(() => states.includes(mode === 'recreating' ? 'terminal' : 'reconnecting'));
        if (mode === 'recreating') {
          child.send('recreate');
          await until(() => states.includes('recreating'));
        }
        child.send('close');
      }
      const result = await Promise.race([childExit, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child did not exit naturally: ${states}`)), 10000);
        childExit.then(() => clearTimeout(timer));
      })]);
      if (childErrors) process.stderr.write(childErrors);
      expect(result).toEqual({ code: mode === 'startup' ? 1 : 0, signal: null });
      expect(states).toContain(mode === 'startup' ? 'startup-rejected' : 'closed');
      process.stdout.write(JSON.stringify({ childPid: child.pid, mode, result, states, time: new Date().toISOString() }) + '\n');
    } finally {
      if (child.exitCode === null) child.kill(); // failed-test cleanup only
    }
  }, 30000);
});
