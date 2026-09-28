import Fastify, { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { Client, Pool, PoolClient } from 'pg';
import { once } from 'events';
import { randomUUID } from 'crypto';

describe('POST /events after a terminated PostgreSQL transaction backend', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let control: Client;
  let postgres: typeof import('@/infra/postgres/client');
  let services: typeof import('@/core/services/event.service');
  let token: string;
  const originalEnv = process.env;

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      DB_POOL_MAX: '1',
      DB_POOL_MIN: '1',
      ENABLE_ADMIN_EVENT_WRITE: 'true',
      ENFORCE_AUTH_USER_MATCH: 'true',
    };
    const { loadConfig } = await import('@/infra/config');
    const config = loadConfig();
    const { initLogger } = await import('@/infra/logger');
    initLogger();
    postgres = await import('@/infra/postgres/client');
    pool = await postgres.initPostgresPool();
    control = new Client({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
    });
    await control.connect();
    services = await import('@/core/services/event.service');
    const { jwtAuthMiddleware } = await import('@/api/middleware/auth');
    const { registerEventRoutes } = await import('@/api/rest/events');
    token = jwt.sign({ role: 'admin' }, config.JWT_SECRET, { subject: randomUUID() });
    app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    await registerEventRoutes(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (control) await control.end();
    if (postgres) await postgres.closePostgresPool();
    process.env = originalEnv;
  });

  it('discards the terminated transaction connection and creates the next event using the pool slot', async () => {
    let faultedClient: PoolClient | undefined;
    let release: jest.SpyInstance | undefined;
    let killedPid: number | undefined;
    let eventId: string | undefined;
    const originalCreate = services.EventService.prototype.createEvent;
    const create = jest
      .spyOn(services.EventService.prototype, 'createEvent')
      .mockImplementationOnce(async function (
        this: import('@/core/services/event.service').EventService,
        input,
        client,
      ) {
        if (!client) throw new Error('Expected route-owned transaction client');
        faultedClient = client;
        release = jest.spyOn(client, 'release');
        const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        killedPid = backend.rows[0].pid;
        const disconnected = once(client, 'error');
        const result = await control.query<{ terminated: boolean }>(
          'SELECT pg_terminate_backend($1) AS terminated',
          [killedPid],
        );
        expect(result.rows[0].terminated).toBe(true);
        await disconnected;
        return originalCreate.call(this, input, client);
      });
    const payload = {
      name: `Backend termination ${randomUUID()}`,
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-01T01:00:00Z',
      totalSeats: 5,
      pricing: [{ name: 'General', price: 50, quantity: 5 }],
    };
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/events',
        payload,
        headers: { authorization: `Bearer ${token}` },
      });

    try {
      const failed = await post();
      expect(failed.statusCode).toBe(500);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release!.mock.calls[0][0]).toBeInstanceOf(Error);
      const replacement = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(replacement.rows[0].pid).not.toBe(killedPid);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);

      const success = await post();
      eventId = success.json().id;
      expect(success.statusCode).toBe(201);
      const saved = await pool.query('SELECT available_seats FROM events WHERE id = $1', [eventId]);
      expect(saved.rows).toEqual([{ available_seats: 5 }]);
      expect(pool.waitingCount).toBe(0);
    } finally {
      create.mockRestore();
      // RED cleanup only: the original route leaks the terminated client.
      if (faultedClient && release?.mock.calls.length === 0) faultedClient.release(true);
      if (eventId) await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
  }, 30000);
});
