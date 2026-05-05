import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { checkRateLimit } from '@/infra/redis/commands';
import { RateLimitExceededError } from '@/core/errors';

const logger = getLogger();

// Redis 슬라이딩 윈도우 기반 레이트 리미팅
// 체크아웃, 예약 요청 제한
//
// 실패 모드 (RATE_LIMIT_FAIL_MODE):
//   - 'closed' (default): Redis 장애 시 503 반환. 보안 우선.
//   - 'open': Redis 장애 시 통과. 가용성 우선.
//
// checkout/reservation은 자원 점유와 결제로 이어지는 고위험 경로이므로
// 기본값 'closed'를 권장한다. 폭주 트래픽이 leak되는 위험이 단순 503보다 크다.
export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const config = getConfig();

  if (!config.ENABLE_RATE_LIMITING) {
    return;
  }

  // 적용 대상: reservation/checkout 외에도 webhook을 포함한다.
  // - reservation/checkout: 사용자 폭주 방어
  // - webhook: provider 재시도 폭주 또는 위조 webhook spam 방어
  // (REDIS_STRATEGY.md와 일치)
  const isWebhook = request.url.includes('/webhooks');
  const isCheckout = request.url.includes('/checkouts');
  const isReservation = request.url.includes('/reservations');
  if (!isCheckout && !isReservation && !isWebhook) {
    return;
  }

  const userId = request.user?.id || request.ip || 'anonymous';
  const action = isCheckout ? 'checkout' : isReservation ? 'reservation' : 'webhook';

  const { allowed, count, resetAt, redisAvailable } = await checkRateLimit(
    userId,
    action,
    config.RATE_LIMIT_MAX_REQUESTS,
    config.RATE_LIMIT_WINDOW_MS,
    config.RATE_LIMIT_FAIL_MODE,
  );

  // Redis 장애 + fail-closed: rate limit 정책 자체를 적용할 수 없는 상태.
  // X-RateLimit-* 헤더를 박는 건 의미가 어긋나므로 503을 먼저 반환한다.
  if (!redisAvailable && config.RATE_LIMIT_FAIL_MODE === 'closed') {
    logger.error(
      { userId, action, requestId: request.id },
      'Rate limit Redis unavailable; rejecting (fail-closed)',
    );
    return reply.code(503).send({
      error: {
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Rate limiter temporarily unavailable, please retry shortly',
      },
    });
  }

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