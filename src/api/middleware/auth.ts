import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import jwt from 'jsonwebtoken';
import { getConfig } from '@/infra/config';
import { ForbiddenError, UnauthorizedError } from '@/core/errors';
import { AdmissionError, AdmissionRef, parsePurchaseAdmission } from '@/core/models/admission';
import { uuid } from '@/core/models/uuid';

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
}

export function extractUserFromToken(token: string): AuthUser | null {
  const config = getConfig();
  const logger = getLogger();

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    // UUID는 대소문자를 구분하지 않지만 문자열 비교와 Map 조회는 구분한다. 주체가 UUID면
    // PostgreSQL이 돌려주는 소문자 형태로 맞춘다. 그래야 소유권 비교와 DataLoader 조회가 같은
    // 사용자를 같은 값으로 본다. UUID가 아닌 주체는 그대로 둔다. 하이픈 없는 32자리처럼
    // PostgreSQL은 받지만 이 schema는 UUID로 보지 않는 형태도 그대로 남는다. 그런 주체는
    // 문자열로 비교하는 곳(REST의 소유권 확인, 본문 userId 확인)에서는 일치하지 않고, 주체를
    // SQL 조건으로만 쓰는 곳(GraphQL myOrders·myTickets)에서는 PostgreSQL이 같은 사용자로 본다.
    const subject = String(decoded.sub || decoded.id);
    const normalized = uuid.safeParse(subject);
    return {
      id: normalized.success ? normalized.data : subject,
      email: String(decoded.email || ''),
      role: decoded.role ? String(decoded.role) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Invalid JWT token');
    return null;
  }
}

export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.substring(7);
}

export async function jwtAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const logger = getLogger();
  const token = extractTokenFromHeader(request.headers.authorization);

  if (!token) {
    return;
  }

  const user = extractUserFromToken(token);
  if (!user) {
    // 토큰을 *보낸 의도*가 있었는데 invalid → 401로 거절.
    // (토큰 미존재와 토큰 변조/만료를 구분하지 않으면 escalation 시도가
    //  ENFORCE_AUTH_USER_MATCH=false 환경에서 silent로 통과한다.)
    logger.warn({ requestId: request.id }, 'Authorization header present but JWT is invalid');
    return reply.code(401).send({
      error: {
        code: request.routeOptions.config.admission ? 'UNAUTHENTICATED' : 'INVALID_TOKEN',
        message: 'Authorization token is invalid or expired',
      },
      ...(request.routeOptions.config.admission ? { nextPollAfterMs: null } : {}),
    });
  }

  request.user = user;
  logger.debug({ userId: user.id }, 'User authenticated via JWT');
}

/**
 * 인증된 주체와 요청 본문의 userId가 일치하는지 검증한다.
 *
 * 동작:
 *   - JWT가 있고 sub == bodyUserId → 통과
 *   - JWT가 있고 sub != bodyUserId → 403 Forbidden
 *   - JWT가 없고 ENFORCE_AUTH_USER_MATCH=true → 401 Unauthorized
 *   - JWT가 없고 ENFORCE_AUTH_USER_MATCH=false → 통과 (warn 로그)
 *
 * 운영 환경에서는 ENFORCE_AUTH_USER_MATCH=true 권장.
 */
export function assertBodyUserMatchesAuth(request: FastifyRequest, bodyUserId: string): void {
  const cfg = getConfig();
  const logger = getLogger();
  const authUser = request.user;

  if (authUser) {
    // 주체와 본문의 userId는 둘 다 들어올 때 소문자로 맞춰진 값이다(주체는 위에서, 본문은
    // 생성 schema에서). 여기서 다시 바꾸지 않는다.
    if (authUser.id !== bodyUserId) {
      logger.warn(
        { authUserId: authUser.id, bodyUserId, requestId: request.id },
        'Body userId does not match authenticated subject',
      );
      throw new ForbiddenError('userId in body does not match authenticated subject');
    }
    return;
  }

  if (cfg.ENFORCE_AUTH_USER_MATCH) {
    logger.warn(
      { bodyUserId, requestId: request.id },
      'Authenticated request required but no valid JWT provided',
    );
    throw new UnauthorizedError('Authentication required');
  }

  logger.warn(
    { bodyUserId, requestId: request.id },
    'Trusting body userId without JWT (ENFORCE_AUTH_USER_MATCH=false)',
  );
}

/**
 * 구매 요청 본문의 admission 필드 (admission-v1 §3).
 *
 * admission 소비는 항상 JWT 주체로만 한다. ENFORCE_AUTH_USER_MATCH=false(demo override)로
 * body.userId를 신뢰하는 환경에서도 JWT 없이 남의 자격을 소비할 수 없다.
 */
export function purchaseAdmission(request: FastifyRequest): AdmissionRef | undefined {
  const admission = parsePurchaseAdmission(request.body);
  if (admission && !request.user) throw new AdmissionError('UNAUTHENTICATED', 401);
  return admission;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
