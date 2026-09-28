import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import jwt from 'jsonwebtoken';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';

describe('atomic sliding-window limiter with real Redis', () => {
  let redis: Awaited<ReturnType<typeof initRedis>>;
  let checkRateLimit: typeof import('@/infra/redis/commands').checkRateLimit;
  const keys = new Set<string>();
  function key(user: string, action = 'checkout') {
    const value = `peakpass:ratelimit:${action}:${user}`;
    keys.add(value);
    return value;
  }

  beforeAll(async () => {
    process.env.ENABLE_RATE_LIMITING = 'true';
    process.env.RATE_LIMIT_FAIL_MODE = 'closed';
    process.env.GRAPHQL_RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.GRAPHQL_RATE_LIMIT_WINDOW_MS = '60000';
    loadConfig();
    initLogger();
    redis = await initRedis();
    ({ checkRateLimit } = await import('@/infra/redis/commands'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (keys.size) await redis.del([...keys]);
    keys.clear();
  });
  afterAll(async () => { await closeRedis(); });

  it.each([[1, 20], [7, 40]])('admits exactly limit %i from %i concurrent requests', async (limit, requests) => {
    const user = randomUUID();
    const storageKey = key(user);
    const results = await Promise.all(Array.from({ length: requests }, () =>
      checkRateLimit(user, 'checkout', limit, 60000)));
    const stored = await redis.zCard(storageKey);
    const accepted = results.filter((result) => result.allowed);
    process.stdout.write(JSON.stringify({ pid: process.pid, limit, requests, accepted: accepted.length, stored,
      counts: results.map((result) => result.count) }) + '\n');
    expect(accepted).toHaveLength(limit);
    expect(stored).toBe(limit);
    expect(accepted.map((result) => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: limit }, (_, index) => index + 1));
    expect(results.filter((result) => !result.allowed).every((result) => result.count === limit)).toBe(true);
    expect(results.every((result) => result.redisAvailable)).toBe(true);
  });

  it('keeps distinct accepted members at one timestamp even when Math.random repeats', async () => {
    const user = randomUUID();
    const storageKey = key(user);
    jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const results = [];
    for (let index = 0; index < 5; index++) results.push(await checkRateLimit(user, 'checkout', 4, 1000));
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, true, false]);
    expect(results.map((result) => result.count)).toEqual([1, 2, 3, 4, 4]);
    expect(await redis.zCard(storageKey)).toBe(4);
    expect(await redis.zRangeWithScores(storageKey, 0, -1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ score: 1700000000000 }),
    ]));
  });

  it('isolates users and every existing action namespace', async () => {
    const user = randomUUID();
    const actions = ['checkout', 'reservation', 'webhook', 'graphql', 'demoSession', 'demoSettlement'] as const;
    for (const action of actions) {
      key(user, action === 'demoSession' ? 'demo-session' : action === 'demoSettlement' ? 'demo-settlement' : action);
      expect(await checkRateLimit(user, action, 1, 60000)).toMatchObject({ allowed: true, count: 1 });
      expect(await checkRateLimit(user, action, 1, 60000)).toMatchObject({ allowed: false, count: 1 });
    }
    const other = randomUUID();
    key(other);
    expect(await checkRateLimit(other, 'checkout', 1, 60000)).toMatchObject({ allowed: true, count: 1 });
    for (const storageKey of keys) expect(await redis.zCard(storageKey)).toBe(1);
  });

  it('removes the inclusive cutoff and reallows exactly when the window ends', async () => {
    const user = randomUUID();
    const storageKey = key(user);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    expect(await checkRateLimit(user, 'checkout', 1, 1000)).toEqual({
      allowed: true, count: 1, resetAt: 1700000001000, redisAvailable: true,
    });
    clock.mockReturnValue(1700000000999);
    expect(await checkRateLimit(user, 'checkout', 1, 1000)).toMatchObject({ allowed: false, count: 1 });
    clock.mockReturnValue(1700000001000);
    expect(await checkRateLimit(user, 'checkout', 1, 1000)).toEqual({
      allowed: true, count: 1, resetAt: 1700000002000, redisAvailable: true,
    });
    expect((await redis.zRangeWithScores(storageKey, 0, -1)).map((entry) => entry.score)).toEqual([1700000001000]);
  });

  it('rounds TTL up, never refreshes on rejection, expires, and reallows', async () => {
    const user = randomUUID();
    const storageKey = key(user);
    const started = performance.now();
    expect((await checkRateLimit(user, 'checkout', 1, 1100)).allowed).toBe(true);
    const initialTtl = await redis.pTTL(storageKey);
    expect(initialTtl).toBeGreaterThan(1100);
    expect(initialTtl).toBeLessThanOrEqual(2000);
    await delay(150);
    const before = await redis.pTTL(storageKey);
    expect((await checkRateLimit(user, 'checkout', 1, 1100)).allowed).toBe(false);
    const after = await redis.pTTL(storageKey);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    while (await redis.exists(storageKey)) {
      if (performance.now() - started > 3500) throw new Error('Rate-limit key became immortal');
      await delay(20);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect((await checkRateLimit(user, 'checkout', 1, 1100)).allowed).toBe(true);
    process.stdout.write(JSON.stringify({ pid: process.pid, initialTtl, before, after, expiredAfterMs: elapsed }) + '\n');
  }, 10000);

  it.each(['closed', 'open'] as const)('honors fail-%s on an actual Redis WRONGTYPE script error', async (mode) => {
    const user = randomUUID();
    const storageKey = key(user);
    await redis.set(storageKey, 'wrong-type', { EX: 30 });
    expect(await checkRateLimit(user, 'checkout', 1, 1000, mode)).toEqual({
      allowed: mode === 'open', count: 0, resetAt: 0, redisAvailable: false,
    });
    expect(await redis.get(storageKey)).toBe('wrong-type');
    expect(await redis.ping()).toBe('PONG');
  });

  it('returns real Fastify success/429 with unchanged limit, remaining and reset headers', async () => {
    const { getConfig } = await import('@/infra/config');
    const { initPostgresPool, closePostgresPool } = await import('@/infra/postgres/client');
    const { createApp } = await import('@/api/app');
    await initPostgresPool();
    const app = await createApp();
    const user = randomUUID();
    const storageKey = key(user, 'graphql');
    const token = jwt.sign({ sub: user }, getConfig().JWT_SECRET);
    try {
      await app.ready();
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const responses = [];
      for (let index = 0; index < 3; index++) responses.push(await app.inject({
        method: 'POST', url: '/graphql', payload: { query: '{ __typename }' },
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
      expect(responses.map((response) => response.headers['x-ratelimit-remaining'])).toEqual(['1', '0', '0']);
      for (const response of responses) {
        expect(response.headers['x-ratelimit-limit']).toBe('2');
        expect(response.headers['x-ratelimit-reset']).toBe(new Date(now + 60000).toISOString());
      }
      expect(responses[2].json().error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(await redis.zCard(storageKey)).toBe(2);
      process.stdout.write(JSON.stringify({ pid: process.pid, statuses: responses.map((response) => response.statusCode),
        remaining: responses.map((response) => response.headers['x-ratelimit-remaining']), stored: 2 }) + '\n');
    } finally {
      jest.restoreAllMocks();
      await app.close();
      await closePostgresPool();
    }
  });
});
