import { GraphQLError } from 'graphql';

jest.mock('@/infra/logger', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/infra/postgres/client', () => ({ getPostgresPool: jest.fn(() => ({})) }));

import { resolvers } from '@/api/graphql/resolvers';

// One malformed id in a batch makes PostgreSQL reject the whole `WHERE id IN (...)` query
// (SQLSTATE 22P02), so the well-formed ids requested with it would fail too.
describe('Query.event with an id that is not a UUID', () => {
  it('rejects the id as a validation error before the loader sees it', async () => {
    const load = jest.fn();
    const context = { loaders: { eventLoader: { load } } } as never;

    const failure = await resolvers.Query.event({}, { id: 'x' }, context).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(GraphQLError);
    expect((failure as GraphQLError).extensions).toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('passes a UUID on to the loader', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const load = jest.fn(async () => null);
    const context = { loaders: { eventLoader: { load } } } as never;

    await expect(resolvers.Query.event({}, { id }, context)).resolves.toBeNull();
    expect(load).toHaveBeenCalledWith(id);
  });

  // The loader finds its rows by the lower-case id that PostgreSQL returns.
  it('passes an upper-case UUID on in lower case', async () => {
    const load = jest.fn(async () => null);
    const context = { loaders: { eventLoader: { load } } } as never;

    await resolvers.Query.event({}, { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, context);

    expect(load).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});
