import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const ORIGINAL_ENV = process.env;
const JWT_SECRET = 'd'.repeat(32);
const DEMO_USER = {
  id: randomUUID(),
  email: 'user1@example.com',
};

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

    const response = await app.inject({ method: 'POST', url: '/demo/session' });
    expect(response.statusCode).toBe(404);
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
});
