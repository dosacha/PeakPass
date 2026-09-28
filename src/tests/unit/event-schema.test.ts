import { CreateEventSchema, GetEventsSchema } from '@/core/models/event';

describe('event unit price contract', () => {
  const event = { name: 'Money', startsAt: new Date(), endsAt: new Date(), totalSeats: 1 };
  it.each([0.005, 12.345, 100000000, 0, -1, NaN, Infinity, -Infinity])('rejects price %s without rounding', (price) => {
    expect(CreateEventSchema.safeParse({ ...event, pricing: [{ name: 'General', price, quantity: 1 }] }).success).toBe(false);
  });
  it.each([0.01, 12.34, 99999999.99])('accepts representable price %s', (price) => {
    expect(CreateEventSchema.parse({ ...event, pricing: [{ name: 'General', price, quantity: 1 }] }).pricing[0].price).toBe(price);
  });
});

describe('REST event list pagination schema', () => {
  it.each(['101', '1000000', '0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid or oversized limit %s',
    (limit) => {
      const result = GetEventsSchema.safeParse({ limit });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(['limit']);
    },
  );

  it.each(['1', '100'])('accepts and coerces allowed limit %s', (limit) => {
    expect(GetEventsSchema.parse({ limit }).limit).toBe(Number(limit));
  });

  it('accepts omitted pagination and preserves offset coercion', () => {
    expect(GetEventsSchema.safeParse({}).success).toBe(true);
    expect(GetEventsSchema.parse({ limit: '100', offset: '5' })).toMatchObject({ limit: 100, offset: 5 });
  });
});
