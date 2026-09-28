import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

describe('GraphQL ticket issue date from actual PostgreSQL', () => {
  let pool: Pool;
  let postgres: typeof import('@/infra/postgres/client');
  let loaders: typeof import('@/api/graphql/loaders');
  let schema: GraphQLSchema;
  const ids = {
    user: randomUUID(),
    event: randomUUID(),
    order: randomUUID(),
    ticket: randomUUID(),
  };
  const issuedAt = '2026-09-28T08:17:23.456Z';

  beforeAll(async () => {
    const { loadConfig } = await import('@/infra/config');
    loadConfig();
    const { initLogger } = await import('@/infra/logger');
    initLogger();
    postgres = await import('@/infra/postgres/client');
    pool = await postgres.initPostgresPool();
    loaders = await import('@/api/graphql/loaders');
    const { resolvers } = await import('@/api/graphql/resolvers');
    const { buildGraphQLSchema } = await import('@/api/graphql/types');
    schema = buildGraphQLSchema();
    (schema.getQueryType() as GraphQLObjectType).getFields().myTickets.resolve =
      resolvers.Query.myTickets;
    (schema.getType('Ticket') as GraphQLObjectType).getFields().issuedAt.resolve =
      resolvers.Ticket.issuedAt;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM tickets WHERE id = $1', [ids.ticket]);
      await pool.query('DELETE FROM orders WHERE id = $1', [ids.order]);
      await pool.query('DELETE FROM events WHERE id = $1', [ids.event]);
      await pool.query('DELETE FROM users WHERE id = $1', [ids.user]);
    }
    if (postgres) await postgres.closePostgresPool();
  });

  it('returns an exact ISO issuedAt for the ticket read by the authenticated myTickets resolver', async () => {
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      ids.user,
      `${ids.user}@graphql-date.test`,
    ]);
    await pool.query(
      `INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
       VALUES ($1, 'Date serialization', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', 5, 4, $2, 'published')`,
      [ids.event, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 5 }])],
    );
    await pool.query(
      `INSERT INTO orders (id, user_id, event_id, quantity, tier_id, unit_price, total_amount, status, idempotency_key)
       VALUES ($1, $2, $3, 1, 'general', 50, 50, 'paid', $4)`,
      [ids.order, ids.user, ids.event, randomUUID()],
    );
    await pool.query(
      `INSERT INTO tickets (id, order_id, event_id, user_id, ticket_number, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [ids.ticket, ids.order, ids.event, ids.user, `PASS-${ids.ticket}`, issuedAt],
    );
    const stored = await pool.query('SELECT created_at FROM tickets WHERE id = $1', [ids.ticket]);
    expect(stored.rows[0].created_at).toBeInstanceOf(Date);

    const result = await graphql({
      schema,
      source: '{ myTickets { id issuedAt } }',
      contextValue: loaders.createGraphQLContext(ids.user),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ myTickets: [{ id: ids.ticket, issuedAt }] });
  });
});
