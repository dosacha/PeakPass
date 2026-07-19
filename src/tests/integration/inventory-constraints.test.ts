/**
 * R03-B — available_seats 상한 CHECK constraint 검증 (migration 007)
 *
 * events.available_seats <= events.total_seats 가 DB에서 강제되는지를
 * 세 계층으로 검증한다.
 *
 *   - raw SQL: INSERT/UPDATE가 23514로 거부되고 값이 보존되는지
 *   - service: InventoryService.adjustAvailableSeats의 positive delta가
 *     상한 초과 시 DB에서 거부되는지 (서비스에 상한 검사를 추가하라는 뜻이
 *     아니라, DB가 마지막 방어층임을 고정하는 테스트다)
 *   - concurrency: 동시 positive 복구 두 건이 FOR UPDATE로 직렬화되어
 *     정확히 한 건만 성공하는지
 *
 * 실행 전제: 격리된 테스트 전용 PostgreSQL (beforeEach가 전체 테이블 DELETE).
 * Redis는 사용하지 않는다.
 */
import { initPostgresPool, closePostgresPool, transaction } from '@/infra/postgres/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { InventoryService } from '@/core/services/inventory.service';
import { v4 as uuid } from 'uuid';

const CEILING_CONSTRAINT = 'events_available_seats_not_above_total_check';

describe('available seat ceiling constraint (R03-B, migration 007)', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  const inventory = new InventoryService();

  beforeAll(async () => {
    loadConfig();
    initLogger();
    pool = await initPostgresPool();
  });

  afterAll(async () => {
    await closePostgresPool();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  });

  function insertEvent(totalSeats: number, availableSeats: number): Promise<unknown> & { id: string } {
    const id = uuid();
    const promise = pool.query(
      `
      INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, NOW() + interval '1 day', NOW() + interval '1 day 2 hours', $3, $4, $5, 'published')
      `,
      [
        id,
        `Seat ceiling event ${id.slice(0, 8)}`,
        totalSeats,
        availableSeats,
        JSON.stringify([{ id: 'tier-1', name: 'General', price: 50, quantity: totalSeats }]),
      ],
    );
    return Object.assign(promise, { id });
  }

  async function createEvent(totalSeats: number, availableSeats: number): Promise<string> {
    const insert = insertEvent(totalSeats, availableSeats);
    await insert;
    return insert.id;
  }

  async function getAvailableSeats(eventId: string): Promise<number> {
    const result = await pool.query(`SELECT available_seats FROM events WHERE id = $1`, [eventId]);
    return result.rows[0].available_seats;
  }

  // ── T-DB01 catalog shape ────────────────────────────────────────────────

  it('T-DB01 catalog: ceiling constraint exists on events, validated, with the expected predicate', async () => {
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
      WHERE conname = $1
      `,
      [CEILING_CONSTRAINT],
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.contype).toBe('c');
    expect(row.convalidated).toBe(true);
    expect(row.table_name).toBe('events');
    expect(row.definition).toContain('available_seats <= total_seats');
  });

  // ── T-DB02 invalid INSERT rejected ─────────────────────────────────────

  it('T-DB02 INSERT with available_seats above total_seats rejected with 23514', async () => {
    await expect(insertEvent(5, 6)).rejects.toMatchObject({
      code: '23514',
      constraint: CEILING_CONSTRAINT,
    });
  });

  // ── T-DB03 invalid UPDATE rejected ─────────────────────────────────────

  it('T-DB03 UPDATE raising available_seats above total_seats rejected with 23514, value preserved', async () => {
    const eventId = await createEvent(5, 5);

    await expect(
      pool.query(`UPDATE events SET available_seats = 6 WHERE id = $1`, [eventId]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: CEILING_CONSTRAINT,
    });

    expect(await getAvailableSeats(eventId)).toBe(5);
  });

  // ── T-DB04 valid boundaries accepted ───────────────────────────────────

  it('T-DB04 boundary values (0/5, 3/5, 5/5) are accepted', async () => {
    await expect(insertEvent(5, 0)).resolves.toBeDefined();
    await expect(insertEvent(5, 3)).resolves.toBeDefined();
    await expect(insertEvent(5, 5)).resolves.toBeDefined();
  });

  // ── T-DB05 lower bound preserved ───────────────────────────────────────

  it('T-DB05 existing lower-bound constraint (available_seats >= 0) remains effective', async () => {
    const eventId = await createEvent(5, 5);

    // 하한 constraint 이름은 001에서 자동 생성됐으므로 catalog에서 확인해 사용한다.
    const lowerBound = await pool.query<{ conname: string }>(
      `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'events'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%available_seats >= 0%'
      `,
    );
    expect(lowerBound.rows).toHaveLength(1);

    await expect(
      pool.query(`UPDATE events SET available_seats = -1 WHERE id = $1`, [eventId]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: lowerBound.rows[0].conname,
    });

    expect(await getAvailableSeats(eventId)).toBe(5);
  });

  // ── T-SVC01 service positive overflow rejected by DB ───────────────────

  it('T-SVC01 InventoryService positive overflow is rejected by the DB and rolled back', async () => {
    const eventId = await createEvent(5, 5);

    // adjustAvailableSeats에는 상한 검사가 없다 — DB constraint가 마지막 방어층으로
    // 초과 복구를 거부하고, 트랜잭션 rollback으로 값이 보존되어야 한다.
    await expect(
      transaction((client) => inventory.adjustAvailableSeats(eventId, 1, client)),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: CEILING_CONSTRAINT,
    });

    expect(await getAvailableSeats(eventId)).toBe(5);
  });

  // ── T-CONC01 concurrent positive returns cannot exceed capacity ────────

  it('T-CONC01 concurrent +1 returns serialize on the event row and exactly one succeeds', async () => {
    const eventId = await createEvent(10, 9);

    const results = await Promise.allSettled([
      transaction((client) => inventory.adjustAvailableSeats(eventId, 1, client)),
      transaction((client) => inventory.adjustAvailableSeats(eventId, 1, client)),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: '23514',
      constraint: CEILING_CONSTRAINT,
    });

    expect(await getAvailableSeats(eventId)).toBe(10);
  });
});
