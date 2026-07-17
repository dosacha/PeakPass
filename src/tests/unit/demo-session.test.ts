import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const ORIGINAL_ENV = process.env;
const JWT_SECRET = 'd'.repeat(32);
const DEMO_USER = {
  id: randomUUID(),
  email: 'user1@example.com',
};

function createDemoToken(userId: string = DEMO_USER.id, role: string = 'demo'): string {
  return jwt.sign({ email: DEMO_USER.email, role }, JWT_SECRET, {
    subject: userId,
    expiresIn: 600,
  });
}

function createSettlementResult(orderId: string, userId: string, duplicate: boolean = false) {
  const now = new Date();
  return {
    order: {
      id: orderId,
      userId,
      eventId: randomUUID(),
      quantity: 1,
      tierId: 'general',
      unitPrice: '50.00',
      totalAmount: '50.00',
      status: 'paid' as const,
      idempotencyKey: randomUUID(),
      createdAt: now,
      updatedAt: now,
      paidAt: now,
    },
    tickets: [{
      id: randomUUID(),
      orderId,
      eventId: randomUUID(),
      userId,
      ticketNumber: `PASS-${randomUUID().slice(0, 8)}`,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    }],
    paymentStatus: 'settled',
    duplicate,
  };
}

async function loadDemoRoutes(overrides: NodeJS.ProcessEnv = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    JWT_SECRET,
    ENABLE_DEMO_SESSION: 'true',
    DEMO_USER_EMAIL: DEMO_USER.email,
    DEMO_SESSION_TTL_SECONDS: '600',
    ...overrides,
  };

  return import('@/api/rest/demo');
}

describe('live demo sessions', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('does not register the endpoint while disabled', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes({ ENABLE_DEMO_SESSION: 'false' });
    const app = Fastify();
    await registerDemoSessionRoutes(app);

    const [sessionResponse, settlementResponse] = await Promise.all([
      app.inject({ method: 'POST', url: '/demo/session' }),
      app.inject({ method: 'POST', url: '/demo/settlement' }),
    ]);
    expect(sessionResponse.statusCode).toBe(404);
    expect(settlementResponse.statusCode).toBe(404);
    await app.close();
  });

  it('issues a fixed-user JWT without trusting request body identity fields', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes();
    const findUserByEmail = jest.fn().mockResolvedValue(DEMO_USER);
    const app = Fastify();
    await registerDemoSessionRoutes(app, { findUserByEmail });

    const response = await app.inject({
      method: 'POST',
      url: '/demo/session',
      payload: { userId: 'attacker-controlled', email: 'other@example.com', role: 'admin' },
    });
    const body = response.json();
    const claims = jwt.verify(body.token, JWT_SECRET) as jwt.JwtPayload;

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(findUserByEmail).toHaveBeenCalledWith(DEMO_USER.email);
    expect(body).toMatchObject({ userId: DEMO_USER.id, email: DEMO_USER.email });
    expect(claims.sub).toBe(DEMO_USER.id);
    expect(claims.email).toBe(DEMO_USER.email);
    expect(claims.role).toBe('demo');
    expect(claims.exp! - claims.iat!).toBe(600);
    await app.close();
  });

  it('returns an explicit configuration error when the configured user is absent', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes();
    const app = Fastify();
    await registerDemoSessionRoutes(app, { findUserByEmail: async () => null });

    const response = await app.inject({ method: 'POST', url: '/demo/session' });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('DEMO_SESSION_UNAVAILABLE');
    await app.close();
  });

  it('requires a live demo JWT for demo settlement', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes();
    const { jwtAuthMiddleware } = await import('@/api/middleware/auth');
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    await registerDemoSessionRoutes(app, {
      processSettlement: async (request) => createSettlementResult(request.orderId, request.userId),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/demo/settlement',
      payload: { orderId: randomUUID() },
      headers: { 'Idempotency-Key': randomUUID() },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('settles only the authenticated demo user order with a validated idempotency key', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes();
    const { jwtAuthMiddleware } = await import('@/api/middleware/auth');
    const processSettlement = jest.fn(async (request) =>
      createSettlementResult(request.orderId, request.userId),
    );
    const orderId = randomUUID();
    const idempotencyKey = randomUUID();
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    await registerDemoSessionRoutes(app, { processSettlement });

    const response = await app.inject({
      method: 'POST',
      url: '/demo/settlement',
      payload: { orderId },
      headers: {
        Authorization: `Bearer ${createDemoToken()}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(processSettlement).toHaveBeenCalledWith({
      orderId,
      userId: DEMO_USER.id,
      idempotencyKey,
    });
    expect(response.json()).toMatchObject({
      order: { id: orderId, userId: DEMO_USER.id, status: 'paid' },
      paymentStatus: 'settled',
      duplicate: false,
    });
    await app.close();
  });

  it('rejects another user order without revealing it', async () => {
    const { assertDemoOrderOwnership, registerDemoSessionRoutes } = await loadDemoRoutes();
    const { jwtAuthMiddleware } = await import('@/api/middleware/auth');
    const otherUserId = randomUUID();
    const orderId = randomUUID();
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    await registerDemoSessionRoutes(app, {
      processSettlement: async (request) => {
        assertDemoOrderOwnership({ userId: otherUserId }, request.userId);
        return createSettlementResult(orderId, request.userId);
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/demo/settlement',
      payload: { orderId },
      headers: {
        Authorization: `Bearer ${createDemoToken()}`,
        'Idempotency-Key': randomUUID(),
      },
    });

    expect(response.statusCode).toBe(404);
    expect(() => assertDemoOrderOwnership({ userId: otherUserId }, DEMO_USER.id))
      .toThrow('Order not found');
    await app.close();
  });

  it('replays the same settlement and a new-key semantic duplicate without issuing more tickets', async () => {
    const { registerDemoSessionRoutes } = await loadDemoRoutes();
    const { jwtAuthMiddleware } = await import('@/api/middleware/auth');
    const orderId = randomUUID();
    const idempotencyKey = randomUUID();
    let ticketIssueCount = 0;
    let firstResult: ReturnType<typeof createSettlementResult> | null = null;
    const processSettlement = jest.fn(async (request) => {
      if (!firstResult) {
        ticketIssueCount += 1;
        firstResult = createSettlementResult(request.orderId, request.userId);
        return firstResult;
      }

      return { ...firstResult, duplicate: true };
    });
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    await registerDemoSessionRoutes(app, { processSettlement });

    const send = (key: string) => app.inject({
      method: 'POST',
      url: '/demo/settlement',
      payload: { orderId },
      headers: {
        Authorization: `Bearer ${createDemoToken()}`,
        'Idempotency-Key': key,
      },
    });
    const [first, replay, semanticDuplicate] = await Promise.all([
      send(idempotencyKey),
      send(idempotencyKey),
      send(randomUUID()),
    ]);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(semanticDuplicate.statusCode).toBe(200);
    expect(replay.json().tickets).toHaveLength(first.json().tickets.length);
    expect(semanticDuplicate.json().tickets).toHaveLength(first.json().tickets.length);
    expect(ticketIssueCount).toBe(1);
    await app.close();
  });
});
