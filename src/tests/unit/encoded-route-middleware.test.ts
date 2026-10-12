import Fastify from 'fastify';

// Fastify decodes the path before it picks a route, so `POST /%63heckouts` reaches the
// `/checkouts` handler. The global hooks must decide by the matched route, not by the raw URL.
const mockCheckRateLimit = jest.fn();
jest.mock('@/infra/redis/commands', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getIdempotencyResult: jest.fn(async () => null),
  setIdempotencyResult: jest.fn(),
  tryAcquireIdempotencyLock: jest.fn(async () => 'lock-token'),
}));

const ORIGINAL_ENV = process.env;
const ROUTES = ['/checkouts', '/reservations', '/graphql', '/webhooks/payments/settlement'];

async function buildApp() {
  const { webhookSignatureMiddleware } = await import('@/api/middleware/webhook-signature');
  const { rateLimitMiddleware } = await import('@/api/middleware/rateLimit');
  const { idempotencyMiddleware } = await import('@/api/middleware/idempotency');
  const app = Fastify();
  app.addHook('preHandler', webhookSignatureMiddleware);
  app.addHook('preHandler', rateLimitMiddleware);
  app.addHook('preHandler', idempotencyMiddleware);
  for (const url of ROUTES) {
    app.post(url, async () => ({ reached: url }));
  }
  return app;
}

describe('global hooks on a percent-encoded path', () => {
  beforeEach(() => {
    jest.resetModules();
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
      redisAvailable: true,
    });
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      JWT_SECRET: 'e'.repeat(32),
      WEBHOOK_SIGNING_SECRET: 'test-webhook-signing-secret',
      ENABLE_RATE_LIMITING: 'true',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it.each([
    ['/checkouts', 'checkout'],
    ['/%63heckouts', 'checkout'],
    ['/reservations', 'reservation'],
    ['/%72eservations', 'reservation'],
    ['/graphql', 'graphql'],
    ['/%67raphql', 'graphql'],
  ])('counts POST %s against the %s limit', async (url, action) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'idempotency-key': 'key-1' },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
      expect(mockCheckRateLimit.mock.calls[0][1]).toBe(action);
    } finally {
      await app.close();
    }
  });

  it('answers 503 on an encoded purchase path while the rate limiter has no Redis', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      count: 0,
      resetAt: 0,
      redisAvailable: false,
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/%63heckouts',
        headers: { 'idempotency-key': 'key-1' },
        payload: {},
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    } finally {
      await app.close();
    }
  });

  it('rejects an unsigned settlement webhook sent to an encoded path', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/%77ebhooks/payments/settlement',
        headers: { 'idempotency-key': 'key-1' },
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'MISSING_SIGNATURE' } });
    } finally {
      await app.close();
    }
  });

  it('requires an Idempotency-Key for a checkout sent to an encoded path', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/%63heckouts', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
    } finally {
      await app.close();
    }
  });
});
