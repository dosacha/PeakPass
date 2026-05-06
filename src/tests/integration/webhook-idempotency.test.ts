import {
  closePostgresPool,
  initPostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { closeRedis, getRedis, initRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { CheckoutService } from '@/core/services/checkout.service';
import { ConflictError } from '@/core/errors';
import { Order } from '@/core/models/order';
import { Ticket } from '@/core/models/ticket';
import { v4 as uuid } from 'uuid';

describe('webhook idempotency integration tests', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  const checkoutService = new CheckoutService();

  async function clearTestData() {
    if (!pool) return;
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  }

  async function clearRedisData() {
    let redis: ReturnType<typeof getRedis>;
    try {
      redis = getRedis();
    } catch {
      return;
    }
    const keys = await redis.keys('peakpass:*');
    if (keys.length === 0) return;
    await Promise.all(keys.map((key) => redis.del(key)));
  }

  async function setupEventAndUsers(opts: {
    seats: number;
    userCount: number;
  }): Promise<{ eventId: string; tierId: string; userIds: string[] }> {
    const eventId = uuid();
    const tierId = uuid();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
      `,
      [
        eventId,
        'Webhook idempotency test event',
        startsAt,
        endsAt,
        opts.seats,
        opts.seats,
        JSON.stringify([
          {
            id: tierId,
            name: 'General',
            price: 50,
            quantity: opts.seats,
          },
        ]),
      ],
    );

    const userIds = Array.from({ length: opts.userCount }, () => uuid());
    await Promise.all(
      userIds.map((userId) =>
        pool.query(
          `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
          [
            userId,
            `webhook-user-${userId.slice(0, 8)}@test.com`,
            `Webhook user ${userId.slice(0, 4)}`,
          ],
        ),
      ),
    );

    return { eventId, tierId, userIds };
  }

  async function checkoutOnce(
    userId: string,
    eventId: string,
    tierId: string,
    quantity: number,
  ): Promise<Order> {
    const result = await serializableTransactionWithRetry((client) =>
      checkoutService.checkout(
        {
          eventId,
          userId,
          quantity,
          tierId,
          idempotencyKey: uuid(),
        },
        client,
      ),
    );

    return result.order;
  }

  async function sendWebhook(
    orderId: string,
    idempotencyKey: string,
    status: 'settled' | 'failed',
    providerTransactionId: string,
  ) {
    return serializableTransactionWithRetry((client) =>
      checkoutService.processPaymentWebhook(
        { orderId, providerTransactionId, status },
        idempotencyKey,
        client,
      ),
    );
  }

  async function getAvailableSeats(eventId: string): Promise<number> {
    const result = await pool.query(
      `SELECT available_seats FROM events WHERE id = $1`,
      [eventId],
    );
    return result.rows[0].available_seats;
  }

  async function getOrderStatus(orderId: string): Promise<string | null> {
    const result = await pool.query(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    return result.rows[0]?.status ?? null;
  }

  async function getTicketsByOrderId(orderId: string): Promise<Ticket[]> {
    const result = await pool.query<Ticket>(
      `
      SELECT
        id,
        order_id as "orderId",
        event_id as "eventId",
        user_id as "userId",
        ticket_number as "ticketNumber",
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tickets
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    );
    return result.rows;
  }

  async function getWebhookPaymentRecordCountByOrderId(orderId: string): Promise<number> {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int as count
      FROM payment_records
      WHERE order_id = $1
        AND provider_transaction_id IS NOT NULL
      `,
      [orderId],
    );
    return result.rows[0].count;
  }

  beforeAll(async () => {
    loadConfig();
    initLogger();
    pool = await initPostgresPool();
    await initRedis();
  });

  afterAll(async () => {
    await closeRedis();
    await closePostgresPool();
  });

  beforeEach(async () => {
    await clearTestData();
    await clearRedisData();
  });

  afterEach(async () => {
    await clearTestData();
    await clearRedisData();
  });

  it(
    'returns idempotent settled when settlement webhook arrives twice',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const order = await checkoutOnce(userIds[0], eventId, tierId, 1);
      const providerTransactionId = 'provider-txn-settle-repeat';

      const first = await sendWebhook(
        order.id,
        uuid(),
        'settled',
        providerTransactionId,
      );
      const second = await sendWebhook(
        order.id,
        uuid(),
        'settled',
        providerTransactionId,
      );

      expect(first.duplicate).toBe(false);
      expect(first.tickets).toHaveLength(1);
      expect(second.duplicate).toBe(true);
      expect(second.tickets).toHaveLength(1);
      expect(second.tickets[0].id).toBe(first.tickets[0].id);
    },
    15000,
  );

  it(
    'rejects different orderId for the same providerTransactionId',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 2,
      });
      const orderA = await checkoutOnce(userIds[0], eventId, tierId, 1);
      const orderB = await checkoutOnce(userIds[1], eventId, tierId, 1);
      const providerTransactionId = 'provider-txn-shared';

      await sendWebhook(orderA.id, uuid(), 'settled', providerTransactionId);

      await expect(
        sendWebhook(orderB.id, uuid(), 'settled', providerTransactionId),
      ).rejects.toBeInstanceOf(ConflictError);
    },
    15000,
  );

  it(
    'refunds seats when failure webhook arrives for a pending order',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const order = await checkoutOnce(userIds[0], eventId, tierId, 2);

      expect(await getAvailableSeats(eventId)).toBe(3);

      const result = await sendWebhook(
        order.id,
        uuid(),
        'failed',
        'provider-txn-fail',
      );

      expect(result.duplicate).toBe(false);
      expect(result.paymentStatus).toBe('failed');
      expect(result.tickets).toHaveLength(0);
      expect(await getAvailableSeats(eventId)).toBe(5);
      expect(await getOrderStatus(order.id)).toBe('cancelled');
    },
    15000,
  );

  it(
    'does not refund seats when failure webhook arrives for an already paid order',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const order = await checkoutOnce(userIds[0], eventId, tierId, 2);

      await sendWebhook(order.id, uuid(), 'settled', 'provider-txn-paid');
      expect(await getAvailableSeats(eventId)).toBe(3);

      const result = await sendWebhook(
        order.id,
        uuid(),
        'failed',
        'provider-txn-paid-failed-late',
      );

      expect(result.duplicate).toBe(true);
      expect(result.paymentStatus).toBe('settled');
      expect(result.tickets).toHaveLength(2);
      expect(await getAvailableSeats(eventId)).toBe(3);
      expect(await getOrderStatus(order.id)).toBe('paid');
    },
    15000,
  );

  it(
    'throws ConflictError when settlement webhook arrives for a cancelled order',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const order = await checkoutOnce(userIds[0], eventId, tierId, 1);

      await sendWebhook(order.id, uuid(), 'failed', 'provider-txn-cancel-first');

      await expect(
        sendWebhook(order.id, uuid(), 'settled', 'provider-txn-cancel-then-settle'),
      ).rejects.toBeInstanceOf(ConflictError);
    },
    15000,
  );

  it(
    'handles concurrent duplicate settlement webhooks idempotently',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const order = await checkoutOnce(userIds[0], eventId, tierId, 1);
      const providerTransactionId = 'provider-txn-concurrent';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          sendWebhook(order.id, uuid(), 'settled', providerTransactionId),
        ),
      );

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(await getTicketsByOrderId(order.id)).toHaveLength(1);
      expect(await getWebhookPaymentRecordCountByOrderId(order.id)).toBe(1);
    },
    15000,
  );
});
