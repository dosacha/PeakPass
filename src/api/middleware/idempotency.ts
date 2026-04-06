import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import { getIdempotencyResult, setIdempotencyResult } from '@/infra/redis/commands';

const logger = getLogger();

// 중복 요청 방지 미들웨어
// Redis에 저장된 멱등성 키 기준 중복 감지
export async function idempotencyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // POST 요청만
  if (request.method !== 'POST') {
    return;
  }

  // 멱등성이 필요한 엔드포인트만
  if (!request.url.includes('/checkouts') && !request.url.includes('/webhooks')) {
    return;
  }

  const idempotencyKey = request.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    // 체크아웃 엔드포인트는 멱등성 키 필수
    if (request.url.includes('/checkouts')) {
      return reply.code(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key 헤더 필수',
        },
      });
    }
    return;
  }

  // 이전 요청 결과 확인
  const cachedResult = await getIdempotencyResult(idempotencyKey);

  if (cachedResult) {
    logger.info(
      { idempotencyKey, requestId: request.id },
      '중복 요청 감지, 캐시된 결과 반환',
    );

    return reply.code(cachedResult.statusCode || 201).send(cachedResult.body);
  }

  // 처리 중인 요청으로 표시
  // 엔드포인트 처리 후 결과 저장 (후크 통해)
  request.idempotencyKey = idempotencyKey;
}

/**
 * 성공 응답 후 Redis에 결과 저장하는 도우미
 * 멱등성을 지원하는 엔드포인트에서 사용
 */
export function storeIdempotencyResult(result: any, statusCode: number, idempotencyKey?: string) {
  if (!idempotencyKey) return;

  // 24시간 동안 Redis에 저장
  setIdempotencyResult(
    idempotencyKey,
    {
      statusCode,
      body: result,
      storedAt: new Date().toISOString(),
    },
    24 * 60 * 60,
  ).catch((err) => {
    logger.warn({ err }, 'Failed to store idempotency result');
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}
