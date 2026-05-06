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
type RateLimitAction = 'checkout' | 'reservation' | 'webhook' | 'graphql';

interface RouteRateLimit {
  action: RateLimitAction;
  limit: number;
  windowMs: number;
}

/**
 * URL을 보고 적용할 rate limit 정책을 결정한다.
 * 매치 안 되면 null (rate limit 미적용 경로).
 *
 * GraphQL은 별도 한도를 사용한다. write 경로의 5/60s를 그대로 쓰면 화면 1개 렌더링에
 * 호출되는 events/event/myOrders 등이 1초도 안 되어 한도를 소진한다.
 */
function resolveRouteRateLimit(url: string): RouteRateLimit | null {
  const config = getConfig();

  if (url.includes('/checkouts')) {
    return {
      action: 'checkout',
      limit: config.RATE_LIMIT_MAX_REQUESTS,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
    };
  }
  if (url.includes('/reservations')) {
    return {
      action: 'reservation',
      limit: config.RATE_LIMIT_MAX_REQUESTS,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
    };
  }
  if (url.includes('/webhooks')) {
    return {
      action: 'webhook',
      limit: config.RATE_LIMIT_MAX_REQUESTS,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
    };
  }
  if (url.includes('/graphql')) {
    return {
      action: 'graphql',
      limit: config.GRAPHQL_RATE_LIMIT_MAX_REQUESTS,
      windowMs: config.GRAPHQL_RATE_LIMIT_WINDOW_MS,
    };
  }

  return null;
}

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const config = getConfig();

  if (!config.ENABLE_RATE_LIMITING) {
    return;
  }

  const route = resolveRouteRateLimit(request.url);
  if (!route) {
    return;
  }

  const userId = request.user?.id || request.ip || 'anonymous';

  const { allowed, count, resetAt, redisAvailable } = await checkRateLimit(
    userId,
    route.action,
    route.limit,
    route.windowMs,
    config.RATE_LIMIT_FAIL_MODE,
  );

  // Redis 장애 + fail-closed: rate limit 정책 자체를 적용할 수 없는 상태.
  // X-RateLimit-* 헤더를 박는 건 의미가 어긋나므로 503을 먼저 반환한다.
  if (!redisAvailable && config.RATE_LIMIT_FAIL_MODE === 'closed') {
    logger.error(
      { userId, action: route.action, requestId: request.id },
      'Rate limit Redis unavailable; rejecting (fail-closed)',
    );
    return reply.code(503).send({
      error: {
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Rate limiter temporarily unavailable, please retry shortly',
      },
    });
  }

  reply.header('X-RateLimit-Limit', route.limit);
  reply.header('X-RateLimit-Remaining', Math.max(0, route.limit - count));
  reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString());

  if (!allowed) {
    logger.warn(
      {
        userId,
        action: route.action,
        limit: route.limit,
        requestId: request.id,
      },
      'Rate limit exceeded',
    );

    throw new RateLimitExceededError(route.limit, route.windowMs);
  }
}