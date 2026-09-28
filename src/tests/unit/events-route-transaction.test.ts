import Fastify, { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { registerEventRoutes } from '@/api/rest/events';
import { jwtAuthMiddleware } from '@/api/middleware/auth';

const mockConfig = {
  ENABLE_ADMIN_EVENT_WRITE: true,
  ENFORCE_AUTH_USER_MATCH: true,
  JWT_SECRET: 'events-transaction-test-secret-32chars',
};
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { connect: jest.fn() };
jest.mock('@/infra/config', () => ({ getConfig: () => mockConfig }));
jest.mock('@/infra/logger', () => ({ getLogger: () => mockLogger }));
jest.mock('@/infra/postgres/client', () => ({ getPostgresPool: () => mockPool }));

const payload = {
  name: 'Transaction event',
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-10-01T01:00:00Z',
  totalSeats: 5,
  pricing: [{ name: 'General', price: 50, quantity: 5 }],
};
const event = {
  id: 'event-1',
  ...payload,
  startsAt: new Date(payload.startsAt),
  endsAt: new Date(payload.endsAt),
  availableSeats: 5,
  pricing: [{ id: 'tier-1', ...payload.pricing[0] }],
  status: 'published',
  createdAt: new Date('2026-09-28T00:00:00Z'),
  updatedAt: new Date('2026-09-28T00:00:00Z'),
};

describe('POST /events transaction connection ownership', () => {
  let app: FastifyInstance;
  let observedError: Error | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfig.ENABLE_ADMIN_EVENT_WRITE = true;
    observedError = undefined;
    mockClient.query.mockResolvedValue({ rows: [event], rowCount: 1 });
    mockPool.connect.mockResolvedValue(mockClient);
    app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    app.setErrorHandler((err, _request, reply) => {
      observedError = err;
      return reply.code(500).send({ error: 'Internal error' });
    });
    await registerEventRoutes(app);
  });

  afterEach(async () => {
    await app.close();
  });

  function post(role = 'admin') {
    const token = jwt.sign({ role }, mockConfig.JWT_SECRET, { subject: 'admin-1' });
    return app.inject({
      method: 'POST',
      url: '/events',
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('discards the client exactly once when INSERT and then ROLLBACK fail, retaining the INSERT error', async () => {
    const insertError = new Error('insert failed');
    const rollbackError = new Error('rollback failed');
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('INSERT')) throw insertError;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [], rowCount: 0 };
    });

    const response = await post();

    expect(response.statusCode).toBe(500);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalledWith(rollbackError);
    expect(observedError).toBe(insertError);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: rollbackError }),
      expect.any(String),
    );
  });

  it('commits a created event and releases the connection once', async () => {
    const response = await post();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'event-1', availableSeats: 5 });
    expect(mockClient.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'INSERT',
      'COMMIT',
    ]);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release.mock.calls[0][0]).toBeUndefined();
  });

  it.each(['BEGIN', 'INSERT'])(
    'rolls back a %s failure and releases the connection once',
    async (phase) => {
      const originalError = new Error(`${phase} failed`);
      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.trim().startsWith(phase)) throw originalError;
        return { rows: [], rowCount: 0 };
      });
      const response = await post();
      expect(response.statusCode).toBe(500);
      expect(observedError).toBe(originalError);
      expect(mockClient.query).toHaveBeenLastCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release.mock.calls[0][0]).toBeUndefined();
    },
  );

  it.each(['disabled', 'non-admin'])(
    'denies %s writes without acquiring a connection',
    async (reason) => {
      mockConfig.ENABLE_ADMIN_EVENT_WRITE = reason !== 'disabled';
      const response = await post(reason === 'non-admin' ? 'user' : 'admin');
      expect(response.statusCode).toBe(403);
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockClient.release).not.toHaveBeenCalled();
    },
  );
});
