import { GraphQLError } from 'graphql';

jest.mock('@/infra/logger', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
const mockConnect = jest.fn();
jest.mock('@/infra/postgres/client', () => ({
  getPostgresPool: () => ({ connect: mockConnect }),
}));

import { resolvers } from '@/api/graphql/resolvers';

// A refused connection names the database host and port in its message. The resolvers that take
// a client themselves must turn it into the same generic error as any other failure.
describe('GraphQL resolvers when no database connection can be obtained', () => {
  const context = { userId: 'user-1' } as never;

  it.each([
    ['ticketByCode', () => resolvers.Query.ticketByCode({}, { code: 'PASS-2026-000001' }, context)],
    ['myOrders', () => resolvers.Query.myOrders({}, {}, context)],
    ['myTickets', () => resolvers.Query.myTickets({}, {}, context)],
  ])('%s answers a generic error without the database address', async (_name, run) => {
    mockConnect.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432'));

    const failure = await run().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(GraphQLError);
    expect((failure as GraphQLError).message).toBe('Internal server error');
    expect(JSON.stringify(failure)).not.toContain('10.1.2.3');
  });
});
