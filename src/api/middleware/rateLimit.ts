import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { checkRateLimit } from '@/infra/redis/commands';
import { RateLimitExceededError } from '@/core/errors';

const logger = getLogger();

// Redis 슬라이딩 윈도우 기반 레이트 리미팅
// 체크아웃, 예약 요청 제한
export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const config = getConfig();

  if (!config.ENABLE_RATE_LIMITING) {
    return; // 비활성화된 경우 스킵
  }

  // 특정 엔드포인트만 제한
  if (!request.url.includes('/checkouts') && !request.url.includes('/reservations')) {
    return;
  }

  // 사용자 ID 추출 (JWT 사용자 우선, 없으면 IP 사용)
  const userId = (request as any).user?.id || request.ip || 'anonymous';
  const action = request.url.includes('checkouts') ? 'checkout' : 'reservation';

  const { allowed, count, resetAt } = await checkRateLimit(
    userId,
    action,
    config.RATE_LIMIT_MAX_REQUESTS,
    config.RATE_LIMIT_WINDOW_MS,
  );

  // 레이트 리미트 헤더 설정
  reply.header('X-RateLimit-Limit', config.RATE_LIMIT_MAX_REQUESTS);
  reply.header('X-RateLimit-Remaining', Math.max(0, config.RATE_LIMIT_MAX_REQUESTS - count));
  reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString());

  if (!allowed) {
    logger.warn(
      {
        userId,
        action,
        limit: config.RATE_LIMIT_MAX_REQUESTS,
        requestId: request.id,
      },
      'Rate limit exceeded',
    );

    throw new RateLimitExceededError(
      config.RATE_LIMIT_MAX_REQUESTS,
      config.RATE_LIMIT_WINDOW_MS,
    );
  }
}
