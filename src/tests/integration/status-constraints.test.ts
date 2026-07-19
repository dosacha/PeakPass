/**
 * R03-A — status domain CHECK constraint 검증 (migration 006)
 *
 * 애플리케이션 모델의 status 허용 집합이 DB CHECK constraint로 동일하게
 * 강제되는지를 raw SQL로 직접 검증한다 (route/service 우회).
 *
 * - invalid INSERT/UPDATE → SQLSTATE 23514 + 해당 constraint 이름
 * - 모델에 선언된 모든 허용 status는 거부되지 않아야 한다
 *   (delivered, used, closed 등 현재 runtime 전이가 없는 값 포함 —
 *    단 이 테스트는 DB direct fixture 검증이며 production 전이 존재를
 *    주장하지 않는다)
 *
 * 실행 전제: 격리된 테스트 전용 PostgreSQL (beforeEach가 전체 테이블 DELETE).
 * Redis는 사용하지 않는다.
 */
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { EventStatus } from '@/core/models/event';
import { ReservationStatus } from '@/core/models/reservation';
import { OrderStatus } from '@/core/models/order';
import { TicketStatus } from '@/core/models/ticket';
import { PaymentWebhookStatus } from '@/core/models/payment';
import { v4 as uuid } from 'uuid';

const STATUS_DOMAINS = {
  events: {
    constraint: 'events_status_allowed_check',
    allowed: ['draft', 'published', 'closed', 'cancelled'],
  },
  reservations: {
    constraint: 'reservations_status_allowed_check',
    allowed: ['active', 'released', 'converted', 'expired'],
  },
  orders: {
    constraint: 'orders_status_allowed_check',
    allowed: ['pending', 'paid', 'delivered', 'cancelled'],
  },
  tickets: {
    constraint: 'tickets_status_allowed_check',
    allowed: ['active', 'used', 'cancelled'],
  },
  payment_records: {
    constraint: 'payment_records_status_allowed_check',
    allowed: ['pending', 'settled', 'failed'],
  },
} as const;

describe('status domain CHECK constraints (R03-A, migration 006)', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;

  beforeAll(async () => {
    loadConfig();
    initLogger();
    pool = await initPostgresPool();
  });

  afterAll(async () => {
    await closePostgresPool();
  });

  beforeEach(async () => {
    // FK 순서: tickets → payment_records → orders → reservations → events/users
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  });

  // ── fixture 헬퍼 (모든 UNIQUE 값은 호출마다 새로 생성) ──────────────────

  async function createUser(): Promise<string> {
    const id = uuid();
    await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `status-${id.slice(0, 8)}@test.local`,
      `Status user ${id.slice(0, 4)}`,
    ]);
    return id;
  }

  async function createEvent(status = 'published'): Promise<string> {
    const id = uuid();
    await pool.query(
      `
      INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, NOW() + interval '1 day', NOW() + interval '1 day 2 hours', 10, 10, $3, $4)
      `,
      [
        id,
        `Status event ${id.slice(0, 8)}`,
        JSON.stringify([{ id: 'tier-1', name: 'General', price: 50, quantity: 10 }]),
        status,
      ],
    );
    return id;
  }

  function insertReservation(userId: string, eventId: string, status: string) {
    return pool.query(
      `
      INSERT INTO reservations (id, user_id, event_id, quantity, tier_id, expires_at, status)
      VALUES ($1, $2, $3, 1, 'tier-1', NOW() + interval '5 minutes', $4)
      `,
      [uuid(), userId, eventId, status],
    );
  }

  async function createOrder(userId: string, eventId: string, status = 'pending'): Promise<string> {
    const id = uuid();
    await pool.query(
      `
      INSERT INTO orders (id, user_id, event_id, quantity, tier_id, unit_price, total_amount, status, idempotency_key)
      VALUES ($1, $2, $3, 1, 'tier-1', 50, 50, $4, $5)
      `,
      [id, userId, eventId, status, uuid()],
    );
    return id;
  }

  function insertOrder(userId: string, eventId: string, status: string) {
    return createOrder(userId, eventId, status);
  }

  function insertTicket(orderId: string, eventId: string, userId: string, status: string) {
    return pool.query(
      `
      INSERT INTO tickets (id, order_id, event_id, user_id, ticket_number, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [uuid(), orderId, eventId, userId, `PASS-2026-9${String(Date.now()).slice(-5)}${uuid().slice(0, 4)}`, status],
    );
  }

  function insertPaymentRecord(orderId: string, status: string, providerLinked: boolean) {
    return pool.query(
      `
      INSERT INTO payment_records (id, order_id, status, provider_transaction_id, idempotency_key, webhook_received_at)
      VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::varchar IS NULL THEN NULL ELSE NOW() END)
      `,
      [uuid(), orderId, status, providerLinked ? `txn-${uuid()}` : null, uuid()],
    );
  }

  // ── T-DB00 model ↔ DB domain parity ────────────────────────────────────

  /** 순서·중복에 의존하지 않는 집합 동등 비교. */
  function expectSameMembers(actual: readonly string[], expected: readonly string[]) {
    expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
  }

  it('T-DB00 application status models match declared DB domains', () => {
    // 이 테스트가 없으면 STATUS_DOMAINS는 테스트 파일에 복사된 문자열일 뿐이다.
    // 실제 Zod 모델에서 읽은 집합과 비교해, 모델이 바뀌었는데 migration/테스트가
    // 안 따라온 drift를 CI에서 잡는다. (runtime 전이가 없는 delivered/used/closed도
    // 모델에 선언돼 있으므로 비교에 포함된다)
    expectSameMembers(EventStatus.options, STATUS_DOMAINS.events.allowed);
    expectSameMembers(ReservationStatus.options, STATUS_DOMAINS.reservations.allowed);
    expectSameMembers(OrderStatus.options, STATUS_DOMAINS.orders.allowed);
    expectSameMembers(TicketStatus.options, STATUS_DOMAINS.tickets.allowed);

    // payment_records의 'pending'은 webhook 모델이 아니라 checkout이 만드는
    // pending record의 상태다 — webhook terminal 상태(settled/failed)에 더해 비교한다.
    expectSameMembers(
      ['pending', ...PaymentWebhookStatus.options],
      STATUS_DOMAINS.payment_records.allowed,
    );
  });

  // ── T-DB01 catalog shape ────────────────────────────────────────────────

  it('T-DB01 catalog: five status CHECK constraints exist, validated, with declared allowed values', async () => {
    const result = await pool.query<{
      conname: string;
      contype: string;
      convalidated: boolean;
      table_name: string;
      definition: string;
    }>(
      `
      SELECT
        conname,
        contype,
        convalidated,
        conrelid::regclass::text AS table_name,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname LIKE '%_status_allowed_check'
      `,
    );

    const byName = new Map(result.rows.map((row) => [row.conname, row]));
    expect(byName.size).toBe(5);

    for (const [table, domain] of Object.entries(STATUS_DOMAINS)) {
      const row = byName.get(domain.constraint);
      expect(row).toBeDefined();
      expect(row!.contype).toBe('c'); // CHECK
      expect(row!.convalidated).toBe(true);
      expect(row!.table_name).toBe(table);
      for (const status of domain.allowed) {
        expect(row!.definition).toContain(`'${status}'`);
      }
    }
  });

  // ── T-DB02~06 invalid INSERT rejected ──────────────────────────────────

  it('T-DB02 events: invalid status INSERT rejected with 23514', async () => {
    await expect(createEvent('archived')).rejects.toMatchObject({
      code: '23514',
      constraint: 'events_status_allowed_check',
    });
  });

  it('T-DB03 reservations: invalid status INSERT rejected with 23514', async () => {
    const userId = await createUser();
    const eventId = await createEvent();

    await expect(insertReservation(userId, eventId, 'held')).rejects.toMatchObject({
      code: '23514',
      constraint: 'reservations_status_allowed_check',
    });
  });

  it('T-DB04 orders: invalid status INSERT rejected with 23514', async () => {
    const userId = await createUser();
    const eventId = await createEvent();

    await expect(insertOrder(userId, eventId, 'refunded')).rejects.toMatchObject({
      code: '23514',
      constraint: 'orders_status_allowed_check',
    });
  });

  it('T-DB05 tickets: invalid status INSERT rejected with 23514', async () => {
    const userId = await createUser();
    const eventId = await createEvent();
    const orderId = await createOrder(userId, eventId, 'paid');

    await expect(insertTicket(orderId, eventId, userId, 'revoked')).rejects.toMatchObject({
      code: '23514',
      constraint: 'tickets_status_allowed_check',
    });
  });

  it('T-DB06 payment_records: invalid status INSERT rejected with 23514', async () => {
    const userId = await createUser();
    const eventId = await createEvent();
    const orderId = await createOrder(userId, eventId, 'pending');

    await expect(insertPaymentRecord(orderId, 'refunded', true)).rejects.toMatchObject({
      code: '23514',
      constraint: 'payment_records_status_allowed_check',
    });
  });

  // ── T-DB07 all declared valid statuses accepted ────────────────────────

  it('T-DB07 all declared valid statuses are accepted by the constraints', async () => {
    for (const status of STATUS_DOMAINS.events.allowed) {
      await expect(createEvent(status)).resolves.toBeDefined();
    }

    const userId = await createUser();
    const eventId = await createEvent();

    for (const status of STATUS_DOMAINS.reservations.allowed) {
      await expect(insertReservation(userId, eventId, status)).resolves.toBeDefined();
    }

    for (const status of STATUS_DOMAINS.orders.allowed) {
      await expect(insertOrder(userId, eventId, status)).resolves.toBeDefined();
    }

    const ticketOrderId = await createOrder(userId, eventId, 'paid');
    for (const status of STATUS_DOMAINS.tickets.allowed) {
      await expect(insertTicket(ticketOrderId, eventId, userId, status)).resolves.toBeDefined();
    }

    const paymentOrderId = await createOrder(userId, eventId, 'pending');
    // pending record는 provider_transaction_id IS NULL scope,
    // settled/failed는 IS NOT NULL scope로 삽입 (migration 005 partial unique와 무충돌)
    await expect(insertPaymentRecord(paymentOrderId, 'pending', false)).resolves.toBeDefined();
    await expect(insertPaymentRecord(paymentOrderId, 'settled', true)).resolves.toBeDefined();
    await expect(insertPaymentRecord(paymentOrderId, 'failed', true)).resolves.toBeDefined();
  });

  // ── T-DB08 invalid UPDATE rejected ─────────────────────────────────────

  it('T-DB08 orders: invalid status UPDATE on an existing valid row rejected with 23514', async () => {
    const userId = await createUser();
    const eventId = await createEvent();
    const orderId = await createOrder(userId, eventId, 'pending');

    await expect(
      pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [orderId]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'orders_status_allowed_check',
    });

    const after = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    expect(after.rows[0].status).toBe('pending');
  });
});
