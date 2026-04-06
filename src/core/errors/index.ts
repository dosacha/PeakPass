export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public context?: Record<string, any>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super('VALIDATION_ERROR', 400, message, context);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} not found: ${id}` : `${resource} not found`;
    super('NOT_FOUND', 404, message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super('CONFLICT', 409, message, context);
    this.name = 'ConflictError';
  }
}

export class InsufficientInventoryError extends AppError {
  constructor(available: number, requested: number) {
    super(
      'INSUFFICIENT_INVENTORY',
      409,
      `Insufficient inventory. Available: ${available}, Requested: ${requested}`,
      { available, requested },
    );
    this.name = 'InsufficientInventoryError';
  }
}

export class RateLimitExceededError extends AppError {
  constructor(limit: number, window: number) {
    super(
      'RATE_LIMIT_EXCEEDED',
      429,
      `Rate limit exceeded: ${limit} requests per ${window}ms`,
      { limit, window },
    );
    this.name = 'RateLimitExceededError';
  }
}

export class IdempotencyError extends AppError {
  constructor(message: string) {
    super('IDEMPOTENCY_ERROR', 409, message);
    this.name = 'IdempotencyError';
  }
}

export class TransactionError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super('TRANSACTION_ERROR', 500, message, context);
    this.name = 'TransactionError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super('UNAUTHORIZED', 401, message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super('FORBIDDEN', 403, message);
    this.name = 'ForbiddenError';
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', context?: Record<string, any>) {
    super('INTERNAL_ERROR', 500, message, context);
    this.name = 'InternalServerError';
  }
}
