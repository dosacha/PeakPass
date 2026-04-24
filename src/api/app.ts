import Fastify from 'fastify';
import corsPlugin from '@fastify/cors';
import helmetPlugin from '@fastify/helmet';
import { randomUUID } from 'crypto';
import { getLogger } from '@/infra/logger';
import { AppError } from '@/core/errors';
import { handleAppError, handleUnexpectedError } from './errors';
import { createApolloServer, registerGraphQLRoute } from './graphql/server';
import { registerHealthChecks } from './health';

export async function createApp() {
  const logger = getLogger();

  const fastify = Fastify({
    logger: {
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          headers: request.headers,
          remoteAddress: request.ip,
          requestId: request.id,
        }),
        res: (reply) => ({
          statusCode: reply.statusCode,
          responseTime: reply.elapsedTime,
        }),
      },
    },
    disableRequestLogging: false,
    requestTimeout: 30000,
  });

  await fastify.register(helmetPlugin, { global: true });
  await fastify.register(corsPlugin, { origin: true });

  fastify.addHook('onRequest', async (request) => {
    request.id = (request.headers['x-request-id'] as string) || randomUUID();
  });

  fastify.addHook('onRequest', async (request) => {
    logger.info({ requestId: request.id, method: request.method, url: request.url }, 'Request started');
  });

  const { webhookSignatureMiddleware } = await import('./middleware/webhook-signature');
  fastify.addHook('preHandler', webhookSignatureMiddleware);

  const { jwtAuthMiddleware } = await import('./middleware/auth');
  fastify.addHook('preHandler', jwtAuthMiddleware);

  const { rateLimitMiddleware } = await import('./middleware/rateLimit');
  fastify.addHook('preHandler', rateLimitMiddleware);

  const { idempotencyMiddleware } = await import('./middleware/idempotency');
  fastify.addHook('preHandler', idempotencyMiddleware);

  fastify.setErrorHandler((err, request, reply) => {
    const requestId = request.id || 'unknown';

    if (err instanceof AppError) {
      handleAppError(err, reply, requestId);
      return;
    }

    handleUnexpectedError(err, reply, requestId);
  });

  logger.info('Initializing Apollo Server');
  const apollo = await createApolloServer();
  await registerGraphQLRoute(fastify, apollo);

  await registerHealthChecks(fastify);

  const { registerEventRoutes } = await import('./rest/events');
  const { registerPaymentRoutes } = await import('./rest/payments');
  const { registerReservationRoutes } = await import('./rest/reservations');
  const { registerCheckoutRoutes } = await import('./rest/checkouts');

  await registerEventRoutes(fastify);
  await registerPaymentRoutes(fastify);
  await registerReservationRoutes(fastify);
  await registerCheckoutRoutes(fastify);

  const closeGracefully = async (signal: string) => {
    logger.info({ signal }, 'Starting graceful shutdown');

    try {
      await apollo.stop();
      logger.info('Apollo Server stopped');
      await fastify.close();
      logger.info('Fastify server closed');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void closeGracefully('SIGINT'));
  process.on('SIGTERM', () => void closeGracefully('SIGTERM'));

  return fastify;
}
