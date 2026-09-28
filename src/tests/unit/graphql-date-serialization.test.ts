import { graphql, GraphQLObjectType } from 'graphql';
import { buildGraphQLSchema } from '@/api/graphql/types';
import { resolvers } from '@/api/graphql/resolvers';

jest.mock('@/infra/logger', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const issuedAt = '2026-09-28T08:17:23.456Z';

describe('Ticket.issuedAt through GraphQL String serialization', () => {
  it.each([
    ['PostgreSQL Date', new Date(issuedAt)],
    ['existing ISO string', issuedAt],
  ])('returns the exact ISO value for a %s', async (_label, createdAt) => {
    const schema = buildGraphQLSchema();
    const ticketType = schema.getType('Ticket') as GraphQLObjectType;
    ticketType.getFields().issuedAt.resolve = resolvers.Ticket.issuedAt;
    const result = await graphql({
      schema,
      source: '{ myTickets { id issuedAt } }',
      rootValue: { myTickets: [{ id: 'ticket-1', createdAt }] },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ myTickets: [{ id: 'ticket-1', issuedAt }] });
  });
});
