import Fastify, { FastifyRequest } from 'fastify';
import corsPlugin from '@fastify/cors';
import helmetPlugin from '@fastify/helmet';
import { randomUUID } from 'crypto';
import { getLogger } from '@/infra/logger';
import { AppError } from '@/core/errors';
import { AdmissionError } from '@/core/models/admission';
import { ZodError } from 'zod';
import {
  handleAppError,
  handleHttpError,
  handleUnexpectedError,
  handleValidationError,
  sendAdmissionError,
  toValidationIssues,
} from './errors';
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
          remoteAddress: request.ip,
          requestId: request.id,
          // headers 의 화이트리스트만 명시적으로 (필요 시):
          contentType: request.headers['content-type'],
          userAgent: request.headers['user-agent'],
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

  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as FastifyRequest).rawBody = buffer;

    if (buffer.length === 0) {
      done(null, {});
      return;
    }

    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch (err) {
      const error =
        err instanceof SyntaxError
          ? new AppError('BAD_REQUEST', 400, 'Invalid JSON body')
          : err instanceof Error
            ? err
            : new Error('Invalid JSON body');
      done(error, undefined);
    }
  });

  fastify.addHook('onRequest', async (request) => {
    request.id = (request.headers['x-request-id'] as string) || randomUUID();
  });

  fastify.addHook('onRequest', async (request) => {
    logger.info(
      { requestId: request.id, method: request.method, url: request.url },
      'Request started',
    );
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

    if (err instanceof ZodError) {
      handleValidationError(toValidationIssues(err), reply, requestId);
      return;
    }

    // A purchase route answers admission errors with the admission-v1 envelope.
    if (err instanceof AdmissionError) {
      sendAdmissionError(reply, err);
      return;
    }

    if (err instanceof AppError) {
      handleAppError(err, reply, requestId);
      return;
    }

    // Fastify가 요청을 거절하며 만든 4xx(415 지원하지 않는 Content-Type, 413 본문 초과 등)는
    // 서버 결함이 아니므로 그 상태 코드로 답한다. Fastify의 오류(code가 FST_ERR_로 시작)만
    // 대상이다. statusCode만 붙은 알 수 없는 오류는 메시지가 새지 않도록 500으로 남긴다.
    if (
      typeof err.code === 'string' &&
      err.code.startsWith('FST_ERR_') &&
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      handleHttpError(reply, err.statusCode, err.message, requestId);
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
  const { registerDemoSessionRoutes } = await import('./rest/demo');

  await registerEventRoutes(fastify);
  await registerPaymentRoutes(fastify);
  await registerReservationRoutes(fastify);
  await registerCheckoutRoutes(fastify);
  await registerDemoSessionRoutes(fastify);
  const { registerAdmissionRoutes } = await import('./rest/admissions');
  await fastify.register(registerAdmissionRoutes);

  return fastify;
}
