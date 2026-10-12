import { ApolloServer } from '@apollo/server';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { graphqlTypeDefs } from './types';
import { resolvers } from './resolvers';
import { clearGraphQLContext, createGraphQLContext, GraphQLContext } from './loaders';
import { createComplexityPlugin } from './complexity';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

const logger = getLogger();

const graphQLRequestSchema = z.object({
  query: z.string().refine((query) => query.trim().length > 0, 'Query must not be blank'),
  variables: z.record(z.unknown()).nullish(),
  operationName: z.string().nullish(),
});

/**
 * resolver가 GraphQLError가 아닌 것을 던지면 graphql-js는 그 메시지를 그대로 응답에 싣는다.
 * DB 연결 실패의 메시지에는 host와 port가 들어 있고, 그런 오류는 Query resolver뿐 아니라
 * DataLoader를 거치는 field resolver에서도 난다. 그래서 resolver마다 감싸지 않고 응답을
 * 만드는 이 한 곳에서 예상하지 못한 오류를 일반 메시지로 바꾼다.
 *
 * GraphQLError(문법·검증·복잡도 거절, 인증 오류, AppError를 변환한 것)는 의도한 응답이므로
 * 그대로 둔다.
 */
export function formatGraphQLError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const thrown = error instanceof GraphQLError ? (error.originalError ?? error) : error;
  if (thrown instanceof GraphQLError) {
    return formatted;
  }

  logger.error({ err: thrown, path: formatted.path }, 'Unexpected error in a GraphQL resolver');
  return {
    message: 'Internal server error',
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code: 'INTERNAL_ERROR', statusCode: 500 },
  };
}

export async function createApolloServer(): Promise<ApolloServer<GraphQLContext>> {
  const config = getConfig();

  const server = new ApolloServer<GraphQLContext>({
    typeDefs: graphqlTypeDefs,
    resolvers,
    introspection: getConfig().NODE_ENV !== 'production',
    formatError: formatGraphQLError,
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
  fastify.post<{ Body: unknown }>(
    '/graphql',
    { config: { rateLimit: 'graphql' } },
    async (request, reply) => {
      const { query, variables, operationName } = graphQLRequestSchema.parse(request.body);
      const context = createGraphQLContext((request as { user?: { id?: string } }).user?.id);

      try {
        logger.debug(
          { query: query.slice(0, 100), userId: context.userId },
          'GraphQL query received',
        );

        const result = await apollo.executeOperation(
          {
            query,
            variables: variables ?? undefined,
            operationName: operationName ?? undefined,
          },
          {
            contextValue: context,
          },
        );

        if (result.body.kind === 'single') {
          return reply.code(result.http.status ?? 200).send(result.body.singleResult);
        }

        logger.error({ result }, 'GraphQL response streaming not supported');
        return reply.code(500).send({ errors: [{ message: 'Response streaming not supported' }] });
      } finally {
        clearGraphQLContext(context);
      }
    },
  );

  logger.info('GraphQL endpoint registered at POST /graphql');
}
