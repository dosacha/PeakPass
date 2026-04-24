import { CreateOrderSchema } from '@/core/models/order';

describe('CreateOrderSchema', () => {
  const validInput = {
    eventId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    quantity: 1,
    tierId: 'general',
    idempotencyKey: '33333333-3333-3333-3333-333333333333',
  };

  it('accepts valid checkout input', () => {
    expect(() => CreateOrderSchema.parse(validInput)).not.toThrow();
  });

  it('rejects non-positive quantities', () => {
    expect(() =>
      CreateOrderSchema.parse({ ...validInput, quantity: 0 }),
    ).toThrow();
  });

  it('rejects invalid event ids', () => {
    expect(() =>
      CreateOrderSchema.parse({ ...validInput, eventId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('requires an idempotency key', () => {
    const inputWithoutKey: Partial<typeof validInput> = { ...validInput };
    delete inputWithoutKey.idempotencyKey;

    expect(() => CreateOrderSchema.parse(inputWithoutKey)).toThrow();
  });
});
