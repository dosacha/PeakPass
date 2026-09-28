import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

describe('GET /events pagination against PostgreSQL', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let postgres: typeof import('@/infra/postgres/client');
  let ids: string[] = [];
  const prefix = `Task12 ${randomUUID()} `;

  beforeAll(async () => {
    const { loadConfig } = await import('@/infra/config');
    loadConfig();
    const { initLogger } = await import('@/infra/logger');
    initLogger();
    postgres = await import('@/infra/postgres/client');
    pool = await postgres.initPostgresPool();
    const rows = await pool.query<{ id: string }>(`
      WITH base AS (SELECT COALESCE(MAX(starts_at), '2100-01-01'::timestamptz) AS starts_at FROM events)
      INSERT INTO events (name, starts_at, ends_at, total_seats, available_seats, status)
      SELECT $1 || n, base.starts_at + n * interval '1 day',
        base.starts_at + n * interval '1 day' + interval '1 hour', 1, 1, 'published'
      FROM base, generate_series(1, 105) AS n
      RETURNING id
    `, [prefix]);
    ids = rows.rows.map((row) => row.id);
    const { createApp } = await import('@/api/app');
    app = await createApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool && ids.length) await pool.query('DELETE FROM events WHERE id = ANY($1::uuid[])', [ids]);
    if (postgres) await postgres.closePostgresPool();
  });

  it.each(['101', '1000000', '0', '-1', '1.5', 'not-a-number'])(
    'returns validation 400 for limit %s before acquiring a DB connection',
    async (limit) => {
      const connect = jest.spyOn(pool, 'connect');
      try {
        const response = await app.inject({ method: 'GET', url: `/events?limit=${limit}` });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { code: 'VALIDATION_ERROR', details: { issues: [expect.objectContaining({ path: 'limit' })] } },
        });
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    },
  );

  it.each([
    ['/events?limit=1', 1, '105', '105'],
    ['/events?limit=100', 100, '105', '6'],
    ['/events', 20, '105', '86'],
    ['/events?limit=1&offset=100', 1, '5', '5'],
  ])('returns the expected PostgreSQL page for %s', async (url, count, first, last) => {
    const response = await app.inject({ method: 'GET', url: String(url) });
    expect(response.statusCode).toBe(200);
    const events = response.json();
    expect(events).toHaveLength(count);
    expect(events[0].name).toBe(prefix + first);
    expect(events[events.length - 1].name).toBe(prefix + last);
  });
});
