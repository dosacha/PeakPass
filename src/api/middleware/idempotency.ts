import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import {
  getIdempotencyResult,
  setIdempotencyResult,
  tryAcquireIdempotencyLock,
  IdempotencyScope,
} from '@/infra/redis/commands';

const logger = getLogger();
const IN_PROGRESS_RECHECK_DELAY_MS = 100;

/**
 * 요청 URL을 idempotency command scope로 매핑한다.
 *
 * 등록된 command surface만 정확히(pathname 일치) 매핑한다 — 부분 문자열 매칭으로
 * 의도치 않은 alias가 생기는 것을 막기 위해서다. 새 command route가 생기면
 * 여기에 명시적으로 추가해야 idempotency middleware 대상이 된다.
 * scope가 결정되지 않는 route는 idempotency middleware 대상이 아니다
 * (임의의 기본 scope를 부여하지 않는다).
 */
export function resolveIdempotencyScope(url: string): IdempotencyScope | null {
  const pathname = url.split('?')[0];
  if (pathname === '/checkouts') return 'checkout';
  if (pathname === '/webhooks/payments/settlement') return 'payment-settlement';
  return null;
}

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
  scope: IdempotencyScope,
  idempotencyKey: string,
  cachedResult: Record<string, unknown>,
) {
  logger.info(
    { scope, idempotencyKey },
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

  const scope = resolveIdempotencyScope(request.url);
  if (!scope) {
    return;
  }

  // scope는 여기서 한 번만 결정하고 request에 저장한다.
  // route(result 저장, lock release)는 URL을 다시 해석하지 않고 이 값을 쓴다.
  request.idempotencyScope = scope;

  const idempotencyKey = getIdempotencyHeader(request);

  if (!idempotencyKey) {
    if (scope === 'checkout') {
      return reply.code(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        },
      });
    }

    return;
  }

  const cachedResult = await getIdempotencyResult(scope, idempotencyKey);
  if (cachedResult) {
    return sendCachedResult(reply, scope, idempotencyKey, cachedResult);
  }

  let lockToken: string | null;
  try {
    lockToken = await tryAcquireIdempotencyLock(scope, idempotencyKey);
  } catch (err) {
    logger.warn(
      { err, scope, idempotencyKey },
      'Failed to acquire idempotency lock; continuing without Redis lock',
    );
    request.idempotencyKey = idempotencyKey;
    return;
  }

  if (!lockToken) {
    await sleep(IN_PROGRESS_RECHECK_DELAY_MS);

    const completedResult = await getIdempotencyResult(scope, idempotencyKey);
    if (completedResult) {
      return sendCachedResult(reply, scope, idempotencyKey, completedResult);
    }

    logger.info({ scope, idempotencyKey }, 'Idempotent request is already processing');
    return reply.code(409).send({
      error: {
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Request with this Idempotency-Key is already processing',
      },
    });
  }

  request.idempotencyKey = idempotencyKey;
  request.idempotencyLockToken = lockToken;
}

export async function storeIdempotencyResult(
  result: unknown,
  statusCode: number,
  scope: IdempotencyScope,
  idempotencyKey?: string,
): Promise<void> {
  if (!idempotencyKey) return;

  await setIdempotencyResult(
    scope,
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
    idempotencyLockToken?: string;
    idempotencyScope?: IdempotencyScope;
  }
}
