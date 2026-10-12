import crypto from 'crypto';
import type { ApolloServer } from '@apollo/server';
import type { FastifyInstance } from 'fastify';
import type { GraphQLContext } from '@/api/graphql/loaders';

// The global hooks (rate limit, webhook signature, idempotency) on the real application: which
// policy a request gets must follow the route that handles it, not the text of its URL.
//   - Fastify decodes the path before it picks a route, so `POST /%63heckouts` is a checkout.
//   - A lookup of an order is not a purchase and must not use up the purchase limit.
//   - A request that matches no route is a 404 and is not counted.
const mockCheckRateLimit = jest.fn();
jest.mock('@/infra/logger', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/infra/postgres/client', () => ({ getPostgresPool: jest.fn(() => ({})) }));
jest.mock('@/infra/redis/commands', () => ({
  ...jest.requireActual('@/infra/redis/commands'),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getIdempotencyResult: jest.fn(async () => null),
  setIdempotencyResult: jest.fn(),
  tryAcquireIdempotencyLock: jest.fn(async () => 'lock-token'),
  releaseIdempotencyLock: jest.fn(),
  deleteReservationHold: jest.fn(),
  setReservationHold: jest.fn(),
  getReservationHold: jest.fn(async () => null),
  invalidateEventCache: jest.fn(),
}));

describe('global hooks follow the matched route of the real application', () => {
  let app: FastifyInstance;
  let apollo: ApolloServer<GraphQLContext>;
  const originalEnv = process.env;
  const secret = 'encoded-route-test-webhook-secret';
  const orderId = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'e'.repeat(32),
      WEBHOOK_SIGNING_SECRET: secret,
      ENABLE_RATE_LIMITING: 'true',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
    const serverModule = await import('@/api/graphql/server');
    const createServer = serverModule.createApolloServer;
    jest.spyOn(serverModule, 'createApolloServer').mockImplementation(async () => {
      apollo = await createServer();
      return apollo;
    });
    app = await (await import('@/api/app')).createApp();
    await app.ready();
  });

  beforeEach(() => {
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
      redisAvailable: true,
    });
  });

  afterAll(async () => {
    await app?.close();
    await apollo?.stop();
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  function signed(payload: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(Buffer.from(payload))
      .digest('hex');
    return {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    };
  }

  it.each([
    ['/checkouts', 'checkout'],
    ['/%63heckouts', 'checkout'],
    ['/reservations', 'reservation'],
    ['/%72eservations', 'reservation'],
    ['/graphql', 'graphql'],
    ['/%67raphql', 'graphql'],
  ])('counts POST %s against the %s limit', async (url, action) => {
    await app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': 'key-1' },
      payload: {},
    });

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit.mock.calls[0][1]).toBe(action);
  });

  it.each(['/webhooks/payments/settlement', '/%77ebhooks/payments/settlement'])(
    'counts a signed POST %s against the webhook limit',
    async (url) => {
      const payload = '{}';
      await app.inject({
        method: 'POST',
        url,
        headers: { ...signed(payload), 'idempotency-key': 'key-1' },
        payload,
      });

      expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
      expect(mockCheckRateLimit.mock.calls[0][1]).toBe('webhook');
    },
  );

  it.each([
    ['GET', `/checkouts/${orderId}`],
    ['HEAD', `/checkouts/${orderId}`],
    ['GET', `/reservations/${orderId}`],
    ['HEAD', `/reservations/${orderId}`],
  ] as const)('does not count %s %s: a lookup is not a purchase', async (method, url) => {
    const response = await app.inject({ method, url });

    // No JWT is sent, so the route itself answers 401; the limiter was not asked.
    expect(response.statusCode).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/checkouts/x/y'],
    ['POST', '/%63heckouts/x/y'],
    ['PUT', '/checkouts'],
  ] as const)('does not count %s %s, which matches no route', async (method, url) => {
    const response = await app.inject({ method, url, payload: {} });

    expect(response.statusCode).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('answers a CORS preflight without counting it', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/checkouts',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(204);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('answers 503 on an encoded purchase path while the rate limiter has no Redis', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      count: 0,
      resetAt: 0,
      redisAvailable: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/%63heckouts',
      headers: { 'idempotency-key': 'key-1' },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
  });

  it('rejects an unsigned settlement webhook sent to an encoded path before counting it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/%77ebhooks/payments/settlement',
      headers: { 'idempotency-key': 'key-1' },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'MISSING_SIGNATURE' } });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key for a checkout sent to an encoded path', async () => {
    const response = await app.inject({ method: 'POST', url: '/%63heckouts', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
  });
});
