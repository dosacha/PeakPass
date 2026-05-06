import { ApolloServer } from '@apollo/server';
import { FastifyInstance } from 'fastify';
import { graphqlTypeDefs } from './types';
import { resolvers } from './resolvers';
import { clearGraphQLContext, createGraphQLContext, GraphQLContext } from './loaders';
import { createComplexityPlugin } from './complexity';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

const logger = getLogger();

type GraphQLRequestBody = {
  query: string;
  variables?: Record<string, unknown>;
};

export async function createApolloServer(): Promise<ApolloServer<GraphQLContext>> {
  const config = getConfig();

  const server = new ApolloServer<GraphQLContext>({
    typeDefs: graphqlTypeDefs,
    resolvers,
    introspection: getConfig().NODE_ENV !== 'production',
    // didResolveOperation 단계에서 query 복잡도를 검증한다.
    // 한도 초과 시 GraphQL이 resolver 호출 전에 query를 거부한다 (DB 미접근).
    plugins: [createComplexityPlugin({ max: config.GRAPHQL_MAX_COMPLEXITY })],
  });

  await server.start();
  logger.info(
    { maxComplexity: config.GRAPHQL_MAX_COMPLEXITY },
    'Apollo server started with complexity plugin',
  );
  return server;
}

export async function registerGraphQLRoute(
  fastify: FastifyInstance,
  apollo: ApolloServer<GraphQLContext>,
): Promise<void> {
  fastify.post<{ Body: GraphQLRequestBody }>('/graphql', async (request, reply) => {
    const { query, variables } = request.body;
    const context = createGraphQLContext((request as { user?: { id?: string } }).user?.id);

    try {
      logger.debug({ query: query.slice(0, 100), userId: context.userId }, 'GraphQL query received');

      const result = await apollo.executeOperation(
        {
          query,
          variables,
        },
        {
          contextValue: context,
        },
      );

      if (result.body.kind === 'single') {
        return reply.code(result.body.singleResult.errors ? 400 : 200).send(result.body.singleResult);
      }

      logger.error({ result }, 'GraphQL response streaming not supported');
      return reply.code(500).send({ errors: [{ message: 'Response streaming not supported' }] });
    } finally {
      clearGraphQLContext(context);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    fastify.get('/graphql', async (_request, reply) => {
      const sandboxHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Apollo Sandbox</title>
            <style>
              body { margin: 0; overflow: hidden; }
            </style>
          </head>
          <body>
            <apollo-sandbox
              initial-state='{
                "document":"query GetEvents { events(limit: 5) { id name availableSeats } }",
                "variables":{}
              }'
            ></apollo-sandbox>
            <script src="https://embeddable-sandbox.cdn.apollographql.com/_latest/embeddable-sandbox.umd.production.min.js"></script>
          </body>
        </html>
      `;

      return reply.type('text/html').send(sandboxHtml);
    });
  }

  logger.info('GraphQL endpoint registered at POST /graphql');
}
