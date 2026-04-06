import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import jwt from 'jsonwebtoken';
import { getConfig } from '@/infra/config';

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

export async function jwtAuthMiddleware(request: FastifyRequest, _reply: FastifyReply) {
  const token = extractTokenFromHeader(request.headers.authorization);

  if (!token) {
    return;
  }

  const user = extractUserFromToken(token);
  if (!user) {
    return;
  }

  (request as FastifyRequest & { user?: AuthUser }).user = user;
  logger.debug({ userId: user.id }, 'User authenticated via JWT');
}
