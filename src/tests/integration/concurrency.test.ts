import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
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

describe('concurrency integration tests', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;

  async function clearTestData() {
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
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
    'prevents overselling under concurrent serializable checkouts',
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
          'Concurrency test event',
          startsAt,
          endsAt,
          3,
          3,
          JSON.stringify([
            {
              id: tierId,
              name: 'General',
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
              `Test user ${userId.slice(0, 4)}`,
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

          return serializableTransactionWithRetry((client) =>
            checkoutService.checkout(input, client),
          );
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
