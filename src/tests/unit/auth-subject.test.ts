import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const ORIGINAL_ENV = process.env;
const JWT_SECRET = 'a'.repeat(32);
const LOWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPPER = LOWER.toUpperCase();

// A UUID compares without case in PostgreSQL but not in a string comparison or a Map lookup.
// The subject of a JWT is therefore brought to the lower-case form PostgreSQL returns, once,
// where the token is read. Ownership checks and DataLoader keys then see one value per user.
describe('the subject of a JWT', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', JWT_SECRET };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it('is lower-cased when it is a UUID and left alone when it is not', async () => {
    const { extractUserFromToken } = await import('@/api/middleware/auth');

    expect(extractUserFromToken(jwt.sign({ sub: UPPER }, JWT_SECRET))?.id).toBe(LOWER);
    expect(extractUserFromToken(jwt.sign({ sub: LOWER }, JWT_SECRET))?.id).toBe(LOWER);
    expect(extractUserFromToken(jwt.sign({ sub: 'Service-Account' }, JWT_SECRET))?.id).toBe(
      'Service-Account',
    );
  });

  it.each([
    ['upper-case subject, lower-case body', UPPER, LOWER],
    ['upper-case subject, upper-case body', UPPER, UPPER],
    ['lower-case subject, upper-case body', LOWER, UPPER],
  ])(
    'matches the userId of the body whatever the case (%s)',
    async (_name, subject, bodyUserId) => {
      const { jwtAuthMiddleware, assertBodyUserMatchesAuth } =
        await import('@/api/middleware/auth');
      const app = Fastify();
      app.addHook('preHandler', jwtAuthMiddleware);
      app.post<{ Body: { userId: string } }>('/probe', async (request) => {
        assertBodyUserMatchesAuth(request, request.body.userId);
        return { subject: request.user?.id };
      });

      const response = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: { authorization: `Bearer ${jwt.sign({ sub: subject }, JWT_SECRET)}` },
        payload: { userId: bodyUserId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ subject: LOWER });
      await app.close();
    },
  );

  it('still refuses a body that names another user', async () => {
    const { jwtAuthMiddleware, assertBodyUserMatchesAuth } = await import('@/api/middleware/auth');
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    app.post<{ Body: { userId: string } }>('/probe', async (request) => {
      assertBodyUserMatchesAuth(request, request.body.userId);
      return {};
    });

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { authorization: `Bearer ${jwt.sign({ sub: UPPER }, JWT_SECRET)}` },
      payload: { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
