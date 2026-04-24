import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import {
  getIdempotencyResult,
  setIdempotencyResult,
  tryAcquireIdempotencyLock,
} from '@/infra/redis/commands';

const logger = getLogger();
const IN_PROGRESS_RECHECK_DELAY_MS = 100;

function getIdempotencyHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function getCachedStatusCode(cachedResult: Record<string, unknown>): number {
  return typeof cachedResult.statusCode === 'number' ? cachedResult.statusCode : 201;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendCachedResult(
  reply: FastifyReply,
  idempotencyKey: string,
  cachedResult: Record<string, unknown>,
) {
  logger.info(
    { idempotencyKey },
    'Duplicate idempotent request detected, returning cached result',
  );

  return reply.code(getCachedStatusCode(cachedResult)).send(cachedResult.body);
}

export async function idempotencyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (request.method !== 'POST') {
    return;
  }

  if (!request.url.includes('/checkouts') && !request.url.includes('/webhooks')) {
    return;
  }

  const idempotencyKey = getIdempotencyHeader(request);

  if (!idempotencyKey) {
    if (request.url.includes('/checkouts')) {
      return reply.code(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        },
      });
    }

    return;
  }

  const cachedResult = await getIdempotencyResult(idempotencyKey);
  if (cachedResult) {
    return sendCachedResult(reply, idempotencyKey, cachedResult);
  }

  let lockAcquired: boolean;
  try {
    lockAcquired = await tryAcquireIdempotencyLock(idempotencyKey);
  } catch (err) {
    logger.warn(
      { err, idempotencyKey },
      'Failed to acquire idempotency lock; continuing without Redis lock',
    );
    request.idempotencyKey = idempotencyKey;
    return;
  }

  if (!lockAcquired) {
    await sleep(IN_PROGRESS_RECHECK_DELAY_MS);

    const completedResult = await getIdempotencyResult(idempotencyKey);
    if (completedResult) {
      return sendCachedResult(reply, idempotencyKey, completedResult);
    }

    logger.info({ idempotencyKey }, 'Idempotent request is already processing');
    return reply.code(409).send({
      error: {
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Request with this Idempotency-Key is already processing',
      },
    });
  }

  request.idempotencyKey = idempotencyKey;
  request.idempotencyLockAcquired = true;
}

export async function storeIdempotencyResult(
  result: unknown,
  statusCode: number,
  idempotencyKey?: string,
): Promise<void> {
  if (!idempotencyKey) return;

  await setIdempotencyResult(
    idempotencyKey,
    {
      statusCode,
      body: result,
      storedAt: new Date().toISOString(),
    },
    24 * 60 * 60,
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
    idempotencyLockAcquired?: boolean;
  }
}
