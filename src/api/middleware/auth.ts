import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import jwt from 'jsonwebtoken';
import { getConfig } from '@/infra/config';
import { ForbiddenError, UnauthorizedError } from '@/core/errors';

const logger = getLogger();
const config = getConfig();

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
}

export function extractUserFromToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    return {
      id: String(decoded.sub || decoded.id),
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
  const token = extractTokenFromHeader(request.headers.authorization);

  if (!token) {
    return;
  }

  const user = extractUserFromToken(token);
  if (!user) {
    // 토큰을 *보낸 의도*가 있었는데 invalid → 정직하게 401로 거절.
    // (토큰 미존재와 토큰 변조/만료를 구분하지 않으면 escalation 시도가
    //  ENFORCE_AUTH_USER_MATCH=false 환경에서 silent로 통과한다.)
    logger.warn({ requestId: request.id }, 'Authorization header present but JWT is invalid');
    return reply.code(401).send({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Authorization token is invalid or expired',
      },
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
export function assertBodyUserMatchesAuth(
  request: FastifyRequest,
  bodyUserId: string,
): void {
  const cfg = getConfig();
  const authUser = request.user;

  if (authUser) {
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

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}