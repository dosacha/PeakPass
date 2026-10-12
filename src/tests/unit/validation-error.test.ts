import { z } from 'zod';

const ORIGINAL_ENV = process.env;

describe('API validation and demo route protection', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      JWT_SECRET: 'v'.repeat(32),
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('formats Zod issues without leaking an internal error response', async () => {
    const { handleValidationError, toValidationIssues } = await import('@/api/errors');
    const result = z.object({ userId: z.string().uuid() }).safeParse({ userId: 'not-a-uuid' });
    if (result.success) {
      throw new Error('Expected invalid input');
    }

    const issues = toValidationIssues(result.error);
    expect(issues).toEqual([
      expect.objectContaining({ path: 'userId', message: expect.any(String) }),
    ]);

    const send = jest.fn();
    const reply = {
      status: jest.fn().mockReturnThis(),
      send,
    };
    handleValidationError(issues, reply as never, 'request-id');
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: { issues },
        }),
      }),
    );
  });

  // Which routes use these limits is checked on the real application in
  // encoded-route-middleware.test.ts.
  it('gives the two demo actions a limit of ten per minute', async () => {
    const { rateLimitFor } = await import('@/api/middleware/rateLimit');
    expect(rateLimitFor('demoSession')).toEqual({ limit: 10, windowMs: 60_000 });
    expect(rateLimitFor('demoSettlement')).toEqual({ limit: 10, windowMs: 60_000 });
  });
});
