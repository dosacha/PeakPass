import { FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import { AppError } from '@/core/errors';

const logger = getLogger();

// REST 오류 응답 처리 도우미
// GraphQL 요청은 Apollo 기본 응답 형식 사용

export interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  requestId: string;
  timestamp: string;
}

export function sendErrorResponse(
  reply: FastifyReply,
  statusCode: number,
  errorCode: string,
  message: string,
  requestId: string,
  details?: Record<string, any>,
): FastifyReply {
  const response: StandardErrorResponse = {
    error: {
      code: errorCode,
      message,
      ...(details && { details }),
    },
    requestId,
    timestamp: new Date().toISOString(),
  };

  return reply.status(statusCode).send(response);
}

export function handleAppError(err: AppError, reply: FastifyReply, requestId: string): void {
  logger.warn(
    {
      requestId,
      code: err.code,
      statusCode: err.statusCode,
      message: err.message,
      context: err.context,
    },
    'Application error',
  );

  sendErrorResponse(
    reply,
    err.statusCode,
    err.code,
    err.message,
    requestId,
    process.env.NODE_ENV === 'development' ? err.context : undefined,
  );
}

export function handleUnexpectedError(err: Error, reply: FastifyReply, requestId: string): void {
  logger.error(
    {
      requestId,
      error: err.message,
      stack: err.stack,
      name: err.name,
    },
    'Unexpected error',
  );

  const isDev = process.env.NODE_ENV === 'development';
  const message = isDev ? err.message : 'Internal server error';
  const details = isDev ? { stack: err.stack, name: err.name } : undefined;

  sendErrorResponse(reply, 500, 'INTERNAL_ERROR', message, requestId, details);
}

export function handleValidationError(
  issues: Array<{ path: string; message: string }>,
  reply: FastifyReply,
  requestId: string,
): void {
  logger.debug(
    {
      requestId,
      issueCount: issues.length,
    },
    'Validation error',
  );

  sendErrorResponse(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', requestId, {
    issues,
  });
}

export function handleHttpError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  requestId: string,
): void {
  logger.debug(
    {
      requestId,
      statusCode,
      message,
    },
    'HTTP error',
  );

  const codeMap: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    429: 'RATE_LIMIT_EXCEEDED',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };

  sendErrorResponse(reply, statusCode, codeMap[statusCode] || 'HTTP_ERROR', message, requestId);
}

export const errorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  INSUFFICIENT_INVENTORY: 'INSUFFICIENT_INVENTORY',
  INVALID_TRANSACTION: 'INVALID_TRANSACTION',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
};
