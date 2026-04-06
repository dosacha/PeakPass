import { ApolloServer } from '@apollo/server';
import { FastifyInstance } from 'fastify';
import { graphqlTypeDefs } from './types';
import { resolvers } from './resolvers';
import { clearGraphQLContext, createGraphQLContext, GraphQLContext } from './loaders';
import { getLogger } from '@/infra/logger';

const logger = getLogger();

type GraphQLRequestBody = {
  query: string;
  variables?: Record<string, unknown>;
};

export async function createApolloServer(): Promise<ApolloServer<GraphQLContext>> {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs: graphqlTypeDefs,
    resolvers,
    introspection: true,
  });

  await server.start();
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
                "document":"query GetEvents { events(limit: 5) { id title availableSeats } }",
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
