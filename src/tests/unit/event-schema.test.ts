import { GetEventsSchema } from '@/core/models/event';

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
