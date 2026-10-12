import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { checkRateLimit } from '@/infra/redis/commands';
import { RateLimitExceededError } from '@/core/errors';

const logger = getLogger();

// Redis 슬라이딩 윈도우 기반 레이트 리미팅
//
// 적용 대상과 기준:
//   - reservation, checkout: 사용자 폭주 방어. 결제·좌석 점유로 직접 이어지는 고위험 경로
//   - webhook: provider 재시도 폭주 또는 위조 webhook spam 방어
//   - graphql: read API. complexity가 단일 query 비용을 막고 본 layer가 시간당 호출
//     횟수를 막는 보완 관계
//
// 실패 모드 (RATE_LIMIT_FAIL_MODE):
//   - 'closed' (default): Redis 장애 시 503 반환. 보안 우선
//   - 'open': Redis 장애 시 통과. 가용성 우선
//
// 결제 경로의 폭주 방어 layer가 leak되는 위험이 단순 503보다 크므로 default 'closed'를
// 권장. production에서는 config가 fail-closed를 강제한다.
export type RateLimitAction =
  | 'checkout'
  | 'reservation'
  | 'webhook'
  | 'graphql'
  | 'demoSession'
  | 'demoSettlement';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 이 route에 적용할 rate limit. 선언하지 않은 route는 한도 대상이 아니다. */
    rateLimit?: RateLimitAction;
  }
}

/**
 * action별 한도. 어느 route가 어느 action인지는 route가 `config.rateLimit`으로 선언한다.
 *
 * 요청 경로의 문자열로 고르지 않는다. Fastify는 경로를 디코딩한 뒤 route를 고르므로, raw URL로
 * 판정하면 `/%63heckouts`가 `/checkouts` handler에 닿으면서 한도를 건너뛴다.
 *
 * 예약·주문 조회(`GET /reservations/:id`, `GET /checkouts/:orderId`)는 생성 요청과 같은 action을
 * 선언한다. 카운터는 action마다 따로여서 예약 조회는 예약 생성과, 주문 조회는 checkout 생성과
 * 같은 카운터를 쓴다. 알려진 한계이고, 입장 제어 계약이 기존 limiter 정책을 고정하고 있어
 * 그대로 둔다.
 *
 * GraphQL은 별도 한도를 사용한다. write 경로의 5/60s를 그대로 쓰면 화면 1개 렌더링에
 * 호출되는 events/event/myOrders 등이 1초도 안 되어 한도를 소진한다.
 */
export function rateLimitFor(action: RateLimitAction): { limit: number; windowMs: number } {
  const config = getConfig();

  switch (action) {
    case 'demoSession':
    case 'demoSettlement':
      return { limit: 10, windowMs: 60_000 };
    case 'graphql':
      return {
        limit: config.GRAPHQL_RATE_LIMIT_MAX_REQUESTS,
        windowMs: config.GRAPHQL_RATE_LIMIT_WINDOW_MS,
      };
    default:
      return { limit: config.RATE_LIMIT_MAX_REQUESTS, windowMs: config.RATE_LIMIT_WINDOW_MS };
  }
}

export async function rateLimitMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const config = getConfig();

  if (!config.ENABLE_RATE_LIMITING) {
    return;
  }

  // 매칭된 route가 없는 요청(404)과 선언하지 않은 route는 한도 대상이 아니다.
  const action = request.routeOptions.config.rateLimit;
  if (!action) {
    return;
  }
  const { limit, windowMs } = rateLimitFor(action);

  const userId =
    action === 'demoSession'
      ? request.ip || 'anonymous'
      : request.user?.id || request.ip || 'anonymous';

  const { allowed, count, resetAt, redisAvailable } = await checkRateLimit(
    userId,
    action,
    limit,
    windowMs,
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

  reply.header('X-RateLimit-Limit', limit);
  reply.header('X-RateLimit-Remaining', Math.max(0, limit - count));
  reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString());

  if (!allowed) {
    logger.warn(
      {
        userId,
        action,
        limit,
        requestId: request.id,
      },
      'Rate limit exceeded',
    );

    throw new RateLimitExceededError(limit, windowMs);
  }
}
