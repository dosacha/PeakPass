import { isRetriableTransactionError } from '@/infra/postgres/client';

describe('isRetriableTransactionError', () => {
  it('treats SQLSTATE 40001 as retriable', () => {
    expect(isRetriableTransactionError({ code: '40001' })).toBe(true);
  });

  it('treats SQLSTATE 40P01 as retriable', () => {
    expect(isRetriableTransactionError({ code: '40P01' })).toBe(true);
  });

  it('does not retry unique violations', () => {
    expect(isRetriableTransactionError({ code: '23505' })).toBe(false);
  });

  it('does not retry ordinary errors', () => {
    expect(isRetriableTransactionError(new Error('boom'))).toBe(false);
  });

  it('handles nullish values safely', () => {
    expect(isRetriableTransactionError(null)).toBe(false);
    expect(isRetriableTransactionError(undefined)).toBe(false);
  });
});
