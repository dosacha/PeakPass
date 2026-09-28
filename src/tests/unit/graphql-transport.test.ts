import crypto from 'crypto';
import type { ApolloServer } from '@apollo/server';
import type { FastifyInstance } from 'fastify';
import type { GraphQLContext } from '@/api/graphql/loaders';

jest.mock('@/infra/logger', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/infra/postgres/client', () => ({ getPostgresPool: jest.fn(() => ({})) }));
jest.mock('@/api/graphql/resolvers', () => ({
  resolvers: {
    Query: {
      event: jest.fn(() => null),
      events: jest.fn(() => []),
    },
  },
}));

describe('GraphQL HTTP transport through createApp and Apollo', () => {
  let app: FastifyInstance;
  let apollo: ApolloServer<GraphQLContext>;
  let queryResolvers: { event: jest.Mock; events: jest.Mock };
  const originalEnv = process.env;
  const secret = 'transport-test-webhook-secret';
  const query = 'query A { a: event(id: "a") { id } } query B { b: event(id: "b") { id } }';

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      ENABLE_RATE_LIMITING: 'false',
      WEBHOOK_SIGNING_SECRET: secret,
    };
    const serverModule = await import('@/api/graphql/server');
    const createServer = serverModule.createApolloServer;
    jest.spyOn(serverModule, 'createApolloServer').mockImplementation(async () => {
      apollo = await createServer();
      return apollo;
    });
    queryResolvers = (await import('@/api/graphql/resolvers')).resolvers.Query as unknown as typeof queryResolvers;
    app = await (await import('@/api/app')).createApp();
    app.get('/transport-internal-error', async () => {
      throw Object.assign(new Error('internal failure'), { statusCode: 400 });
    });
    app.post('/webhooks/transport-probe', async (request) => ({
      raw: request.rawBody?.toString('utf8'),
      parsed: request.body,
    }));
    await app.ready();
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await app?.close();
    await apollo?.stop();
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('executes only named operation B from a multi-operation document', async () => {
    const response = await app.inject({
      method: 'POST', url: '/graphql', payload: { query, operationName: 'B' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { b: null } });
    expect(queryResolvers.event).toHaveBeenCalledTimes(1);
    expect(queryResolvers.event.mock.calls[0][1]).toEqual({ id: 'b' });
  });

  it.each([
    ['malformed JSON', '{'],
    ['null body', 'null'],
    ['array body', '[]'],
    ['string body', '"query"'],
    ['missing query', '{}'],
    ['numeric query', '{"query":123}'],
    ['blank query', '{"query":"  \\n "}'],
    ['numeric variables', '{"query":"{ events { id } }","variables":123}'],
    ['array variables', '{"query":"{ events { id } }","variables":[]}'],
    ['string variables', '{"query":"{ events { id } }","variables":"x"}'],
    ['numeric operationName', '{"query":"{ events { id } }","operationName":123}'],
    ['object operationName', '{"query":"{ events { id } }","operationName":{}}'],
  ])('rejects %s with 400 before any resolver runs', async (_name, payload) => {
    const response = await app.inject({
      method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json' }, payload,
    });
    expect(response.statusCode).toBe(400);
    expect(queryResolvers.event).not.toHaveBeenCalled();
    expect(queryResolvers.events).not.toHaveBeenCalled();
  });

  it.each([{}, { variables: null, operationName: null }, { variables: {} }])(
    'accepts optional/null transport fields: %j', async (fields) => {
      const response = await app.inject({
        method: 'POST', url: '/graphql', payload: { query: '{ events { id } }', ...fields },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { events: [] } });
    },
  );

  it('preserves successful fields and GraphQL execution errors with HTTP 200', async () => {
    queryResolvers.event.mockImplementationOnce(() => { throw new Error('resolver failed'); });
    const response = await app.inject({
      method: 'POST', url: '/graphql',
      payload: { query: '{ events { id } event(id: "bad") { id } }' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { events: [], event: null }, errors: [{ message: 'resolver failed', path: ['event'] }],
    });
  });

  it('keeps complexity budget rejections at HTTP 400 without running resolvers', async () => {
    const response = await app.inject({
      method: 'POST', url: '/graphql', payload: { query: '{ events(limit: 5001) { id } }' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [{ extensions: { code: 'QUERY_TOO_COMPLEX' } }],
    });
    expect(queryResolvers.events).not.toHaveBeenCalled();
  });

  it('accepts a selected cheap operation despite an unused expensive operation', async () => {
    const response = await app.inject({
      method: 'POST', url: '/graphql', payload: {
        query: 'query Cheap { event(id: "cheap") { id } } query Expensive { events(limit: 10000) { id } }',
        operationName: 'Cheap',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { event: null } });
    expect(queryResolvers.event).toHaveBeenCalledTimes(1);
    expect(queryResolvers.events).not.toHaveBeenCalled();
  });

  it.each([
    ['named fragment', 'fragment Root on Query { events(limit: 10000) { ...Item } } fragment Item on Event { id } query Expensive { ...Root }'],
    ['inline fragment', 'query Expensive { ... on Query { events(limit: 10000) { ... on Event { id } } } }'],
    ['variable default', 'query Expensive($limit: Int = 10000) { events(limit: $limit) { id } }'],
    ['multiplied aliases', 'query Expensive { events(limit: 100) { ' + Array.from({ length: 51 }, (_, index) => `f${index}: id`).join(' ') + ' } }'],
    ['selected operation', 'query Cheap { event(id: "cheap") { id } } query Expensive { events(limit: 10000) { id } }'],
  ])('rejects expensive %s before Apollo resolver execution with 400', async (_name, query) => {
    const response = await app.inject({
      method: 'POST', url: '/graphql', payload: { query, operationName: 'Expensive' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ extensions: { code: 'QUERY_TOO_COMPLEX' } }] });
    expect(queryResolvers.event).not.toHaveBeenCalled();
    expect(queryResolvers.events).not.toHaveBeenCalled();
  });

  it.each(['query {', '{ unknownField }', query])(
    'keeps GraphQL parse/validation/operation selection failures at 400', async (invalidQuery) => {
      const response = await app.inject({
        method: 'POST', url: '/graphql', payload: { query: invalidQuery },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().errors).not.toHaveLength(0);
      expect(queryResolvers.event).not.toHaveBeenCalled();
      expect(queryResolvers.events).not.toHaveBeenCalled();
    },
  );

  it('returns the standard 400 response for malformed REST JSON', async () => {
    const response = await app.inject({
      method: 'POST', url: '/events', headers: { 'content-type': 'application/json' }, payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('keeps unrecognized internal errors at 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/transport-internal-error' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('verifies the exact signed JSON bytes and rejects a whitespace-only change', async () => {
    const payload = '{\n  "event": "결제", "x": 1\n}\n';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.`).update(Buffer.from(payload)).digest('hex');
    const headers = {
      'content-type': 'application/json', 'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    };
    const accepted = await app.inject({
      method: 'POST', url: '/webhooks/transport-probe', headers, payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ raw: payload, parsed: { event: '결제', x: 1 } });
    const rejected = await app.inject({
      method: 'POST', url: '/webhooks/transport-probe', headers,
      payload: '{"event":"결제","x":1}',
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
  });
});
