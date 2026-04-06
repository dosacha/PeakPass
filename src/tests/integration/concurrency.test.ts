import { initPostgresPool, closePostgresPool, serializableTransaction } from '@/infra/postgres/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { v4 as uuid } from 'uuid';
import { CheckoutService } from '@/core/services/checkout.service';

type CheckoutInput = {
  eventId: string;
  userId: string;
  quantity: number;
  tierId: string;
  idempotencyKey: string;
};

function isRetriableTransactionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01';
}

describe('동시성 테스트', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;

  async function clearTestData() {
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  }

  async function runCheckoutWithRetry(
    checkoutService: CheckoutService,
    input: CheckoutInput,
    maxAttempts = 3,
  ): Promise<void> {
    let lastError: unknown = new Error('체크아웃 처리 실패');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await serializableTransaction((client) => checkoutService.checkout(input, client));
        return;
      } catch (err) {
        lastError = err;

        if (!isRetriableTransactionError(err) || attempt === maxAttempts - 1) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  beforeAll(async () => {
    loadConfig();
    initLogger();
    pool = await initPostgresPool();
  });

  afterAll(async () => {
    await closePostgresPool();
  });

  beforeEach(async () => {
    await clearTestData();
  });

  afterEach(async () => {
    await clearTestData();
  });

  it(
    'SERIALIZABLE 트랜잭션으로 초과 판매 방지 확인',
    async () => {
      const eventId = uuid();
      const tierId = uuid();
      const now = new Date();
      const startsAt = new Date(now.getTime() + 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

      await pool.query(
        `
        INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
        `,
        [
          eventId,
          '동시성 테스트 이벤트',
          startsAt,
          endsAt,
          3,
          3,
          JSON.stringify([
            {
              id: tierId,
              name: '일반',
              price: 50,
              quantity: 3,
            },
          ]),
        ],
      );

      const userIds = Array.from({ length: 5 }, () => uuid());

      await Promise.all(
        userIds.map((userId) =>
          pool.query(
            `
            INSERT INTO users (id, email, name)
            VALUES ($1, $2, $3)
            `,
            [
              userId,
              `user-${userId.slice(0, 8)}@test.com`,
              `테스트 사용자 ${userId.slice(0, 4)}`,
            ],
          ),
        ),
      );

      const checkoutService = new CheckoutService();

      const results = await Promise.allSettled(
        userIds.map((userId) => {
          const input: CheckoutInput = {
            eventId,
            userId,
            quantity: 1,
            tierId,
            idempotencyKey: uuid(),
          };

          return runCheckoutWithRetry(checkoutService, input);
        }),
      );

      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failureCount = results.filter((result) => result.status === 'rejected').length;

      const eventCheck = await pool.query(
        `
        SELECT available_seats
        FROM events
        WHERE id = $1
        `,
        [eventId],
      );

      const availableSeats = eventCheck.rows[0].available_seats;

      expect(successCount).toBe(3);
      expect(failureCount).toBe(2);
      expect(availableSeats).toBe(0);
    },
    15000,
  );
});