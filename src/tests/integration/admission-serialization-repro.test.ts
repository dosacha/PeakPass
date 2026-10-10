import 'dotenv/config';
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';
import { Client, PoolClient } from 'pg';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { getConfig } from '@/infra/config';
import { getLogger, initLogger } from '@/infra/logger';
import { CheckoutService } from '@/core/services/checkout.service';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import {
  purchaseFixture,
  PurchaseFixture,
  setProtected,
  inspect,
  sleep,
  TIER,
  Json,
} from './admission-purchase-fixture';

/**
 * Follow-up #27: which serialization failures do real, overlapping purchases of different buyers
 * produce, and how many requests use up the three attempts?
 *
 * Nothing is injected. Every 40001/40P01 that PostgreSQL returns to the application's own pool
 * during a wave is recorded with its message, its reason and the statement it interrupted. The
 * waves go through the real routes on loopback HTTP. Product code is not changed.
 *
 * The counts depend on timing and are printed, not asserted. Asserted are the inventory
 * invariant of the fixture, that every 503 is a purchase that used up its transaction, and "at
 * least one failure of this kind" where every run on the host that wrote this file had many. That
 * last kind of assertion needs the requests of a wave to overlap, so a very different host can
 * miss it; it is a record of an observation, not a property of the product.
 *
 * The kinds are told apart by the server's message text, which is English only with the default
 * `lc_messages`. A 40001 with another text is counted as `unrecognized40001` and fails the test.
 *
 * Opt-in (ADMISSION_SERIALIZATION_REPRO=1): a measurement of about two minutes whose counts
 * follow the host's timing, so it is skipped in the default integration run and in CI.
 */
jest.mock('@/infra/config', () => {
  const actual = jest.requireActual('@/infra/config');
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      ENABLE_ADMISSION: true,
      // The purchase limiter (5/min) is not under test here; rate-limit-atomic covers it.
      RATE_LIMIT_MAX_REQUESTS: 100000,
    }),
  };
});
jest.setTimeout(600000);

type Admission = { admissionId: string; admissionEpoch: string };
type RequestType = 'direct' | 'reserve' | 'viaReservation' | 'settle';
type Mix = Partial<Record<RequestType, number>>;
interface Failure {
  kind: string;
  reason: string;
  statement: string;
}

const kindOf = (error: { code?: string; message?: string }) =>
  error.code === '40P01'
    ? 'deadlock'
    : error.code !== '40001'
      ? `code:${error.code}`
      : /read\/write dependencies/.test(error.message ?? '')
        ? 'ssi'
        : /concurrent update/.test(error.message ?? '')
          ? 'concurrentUpdate'
          : 'unrecognized40001';
const tally = <T>(items: T[], key: (item: T) => string) =>
  items.reduce<Record<string, number>>((counts, item) => {
    counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return counts;
  }, {});

const reproSuite = process.env.ADMISSION_SERIALIZATION_REPRO === '1' ? describe : describe.skip;

reproSuite(
  'follow-up #27: serialization failures of overlapping purchases (owned PostgreSQL, Redis, loopback HTTP)',
  () => {
    let pool: Awaited<ReturnType<typeof initPostgresPool>>;
    let redis: Awaited<ReturnType<typeof initRedis>>;
    let service: import('@/core/services/admission.service').AdmissionService;
    let app: Awaited<ReturnType<typeof import('@/api/app').createApp>>;
    let base = '';
    const fixtures: PurchaseFixture[] = [];

    // Every serialization failure and deadlock the server returns to this process.
    const failures: Failure[] = [];
    // The last error of an admission purchase that used up its attempts (the 503 of contract §5).
    const exhausted: Failure[] = [];
    const originalQuery = Client.prototype.query;
    const describeFailure = (error: Json, statement: unknown): Failure => ({
      kind: kindOf(error),
      reason: String(error.detail ?? '').replace(/^Reason code: /, ''),
      statement: String(statement).replace(/\s+/g, ' ').trim().slice(0, 40),
    });

    beforeAll(async () => {
      initLogger();
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const result = (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as Json)?.text;
        if (result instanceof Promise)
          result.catch((error: Json) => {
            if (error?.code === '40001' || error?.code === '40P01')
              failures.push(describeFailure(error, text));
          });
        return result;
      } as typeof Client.prototype.query;
      const logger = getLogger();
      const warn = logger.warn.bind(logger);
      jest.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]) => {
        const fields = args[0] as Json;
        if (String(args[1]).startsWith('Admission purchase failed transiently'))
          exhausted.push(describeFailure(fields.err ?? {}, ''));
        return (warn as (...a: unknown[]) => void)(...args);
      }) as typeof logger.warn);

      pool = await initPostgresPool();
      redis = await initRedis();
      service = (await import('@/core/services/admission.service')).admissionService;
      await service.verifyEnvironment();
      app = await (await import('@/api/app')).createApp();
      await app.listen({ host: '127.0.0.1', port: 0 });
      base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    });
    afterEach(async () => {
      try {
        for (const fixture of fixtures) await fixture.verify();
      } finally {
        for (const fixture of fixtures.splice(0)) await fixture.cleanup(redis);
      }
    });
    afterAll(async () => {
      Client.prototype.query = originalQuery;
      jest.restoreAllMocks();
      await app?.close();
      await closeRedis();
      await closePostgresPool();
    });

    async function fixture(userCount: number, isProtected: boolean) {
      const created = await purchaseFixture(pool, getConfig().JWT_SECRET, 1000, userCount);
      fixtures.push(created);
      if (isProtected) {
        await setProtected(created.eventId, true);
        await service.recover(created.eventId);
      }
      return created;
    }
    async function post(path: string, body: unknown, headers: object = {}) {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Json };
    }
    const purchase = (fx: PurchaseFixture, userId: string, extra: object = {}) => ({
      eventId: fx.eventId,
      userId,
      tierId: TIER,
      quantity: 1,
      ...extra,
    });
    const reserve = (fx: PurchaseFixture, userId: string, admission: Admission) =>
      post('/reservations', purchase(fx, userId, admission), { authorization: fx.token(userId) });
    const checkout = (fx: PurchaseFixture, userId: string, key: string, extra: object = {}) =>
      post('/checkouts', purchase(fx, userId, extra), {
        authorization: fx.token(userId),
        'idempotency-key': key,
      });
    const settle = (orderId: string) =>
      post(
        '/webhooks/payments/settlement',
        { orderId, providerTransactionId: randomUUID(), status: 'settled' },
        { 'idempotency-key': randomUUID() },
      );

    /** Registers the users and ticks the real promotion Lua until all are admitted (at most C). */
    async function admitAll(fx: PurchaseFixture, users: string[]): Promise<Admission[]> {
      if (!users.length) return [];
      const admissionEpoch = (await service.control(fx.eventId))!.epoch;
      const ids: string[] = [];
      for (const userId of users)
        ids.push(
          (await service.join(fx.eventId, userId, admissionEpoch, randomUUID())).body.admission!
            .admissionId,
        );
      for (let attempt = 0; attempt < 120; attempt++) {
        await service.promote(fx.eventId);
        const entries = await Promise.all(ids.map((id) => inspect(fx.eventId, admissionEpoch, id)));
        if (entries.every((entry) => entry.state === 'admitted'))
          return ids.map((admissionId) => ({ admissionId, admissionEpoch }));
        await sleep(250);
      }
      throw new Error('The admissions were not promoted');
    }

    interface Sent {
      type: RequestType;
      status: number;
      code: string | null;
      resend?: () => Promise<{ status: number; body: Json }>;
    }
    /**
     * One wave on a protected event. The preparation is sequential (reservations and pending orders
     * of earlier, already consumed admissions); only the last step sends everything at once.
     */
    async function wave(fx: PurchaseFixture, users: string[], mix: Mix): Promise<Sent[]> {
      const n = (type: RequestType) => mix[type] ?? 0;
      const take = (count: number) => users.splice(0, count);
      const viaUsers = take(n('viaReservation')),
        settleUsers = take(n('settle')),
        directUsers = take(n('direct')),
        reserveUsers = take(n('reserve'));

      const prepared = await admitAll(fx, [...viaUsers, ...settleUsers]);
      const reservationIds: string[] = [];
      for (const [i, userId] of viaUsers.entries()) {
        const held = await reserve(fx, userId, prepared[i]);
        expect(held.status).toBe(201);
        reservationIds.push(held.body.id);
      }
      const orderIds: string[] = [];
      for (const [i, userId] of settleUsers.entries()) {
        const ordered = await checkout(fx, userId, randomUUID(), prepared[viaUsers.length + i]);
        expect(ordered.status).toBe(201);
        orderIds.push(ordered.body.order.id);
      }
      const admitted = await admitAll(fx, [...directUsers, ...reserveUsers]);

      const requests: Array<{
        type: RequestType;
        send: () => Promise<{ status: number; body: Json }>;
      }> = [
        ...directUsers.map((userId, i) => {
          const key = randomUUID();
          return { type: 'direct' as const, send: () => checkout(fx, userId, key, admitted[i]) };
        }),
        ...reserveUsers.map((userId, i) => ({
          type: 'reserve' as const,
          send: () => reserve(fx, userId, admitted[directUsers.length + i]),
        })),
        ...viaUsers.map((userId, i) => {
          const key = randomUUID();
          return {
            type: 'viaReservation' as const,
            send: () => checkout(fx, userId, key, { reservationId: reservationIds[i] }),
          };
        }),
        ...orderIds.map((orderId) => ({ type: 'settle' as const, send: () => settle(orderId) })),
      ];
      failures.length = 0;
      exhausted.length = 0;
      const responses = await Promise.all(requests.map((request) => request.send()));
      const snapshot = { failures: [...failures], exhausted: [...exhausted] };
      const sent = responses.map((response, i) => ({
        type: requests[i].type,
        status: response.status,
        code: (response.body.error?.code as string | undefined) ?? null,
        resend: requests[i].send,
      }));
      // Contract §5: a purchase that used up its attempts keeps its identity. The same request is
      // sent again, alone, until it is answered; this also returns its slot for the next wave.
      for (const item of sent) {
        if (item.status !== 503 || (item.type !== 'direct' && item.type !== 'reserve')) continue;
        const again = await item.resend();
        expect(again.status).toBe(201);
      }
      failures.splice(0, failures.length, ...snapshot.failures);
      exhausted.splice(0, exhausted.length, ...snapshot.exhausted);
      return sent;
    }

    // `last` is null where the requests carry no admission fields: the log line it is read from
    // is written for admission purchases only, so there is nothing to count.
    function report(scenario: string, sent: Sent[], all: Failure[], last: Failure[] | null) {
      const byType: Record<string, Record<string, number>> = {};
      for (const type of new Set(sent.map((item) => item.type)))
        byType[type] = tally(
          sent.filter((item) => item.type === type),
          (item) => (item.code ? `${item.status} ${item.code}` : String(item.status)),
        );
      const summary = {
        scenario,
        requests: sent.length,
        responses: byType,
        serializationFailures: {
          total: all.length,
          byKind: tally(all, (failure) => failure.kind),
          byReason: tally(all, (failure) => `${failure.kind}: ${failure.reason}`),
          byStatement: tally(all, (failure) => `${failure.kind} @ ${failure.statement}`),
        },
        attemptsUsedUp: last && {
          total: last.length,
          byLastError: tally(last, (failure) => failure.kind),
        },
      };
      const line = `REPRO ${JSON.stringify(summary)}\n`;
      process.stdout.write(line);
      if (process.env.REPRO_OUT) appendFileSync(process.env.REPRO_OUT, line);
      return summary;
    }

    async function scenario(name: string, mix: Mix, waves: number) {
      const perWave = Object.values(mix).reduce((sum, count) => sum + (count ?? 0), 0);
      const fx = await fixture(perWave * waves, true);
      const users = [...fx.users];
      const sent: Sent[] = [],
        all: Failure[] = [],
        last: Failure[] = [];
      for (let i = 0; i < waves; i++) {
        sent.push(...(await wave(fx, users, mix)));
        all.push(...failures);
        last.push(...exhausted);
      }
      // No answer but success or the contract's 503 for an admission purchase.
      for (const item of sent)
        if (item.type === 'direct' || item.type === 'reserve')
          expect([201, 503]).toContain(item.status);
      // `last` is read from a log line. It is written once for every admission purchase whose
      // transaction failed transiently (a serialization failure after the last attempt, or a lock
      // or statement timeout, which shows as `code:`), and each of those is answered 503.
      expect(last).toHaveLength(sent.filter((item) => item.status === 503).length);
      expect([...all, ...last].filter((failure) => failure.kind === 'unrecognized40001')).toEqual(
        [],
      );
      return report(name, sent, all, last);
    }

    // The profile admits at most C = 8 at a time, so a wave has at most 8 admission purchases.
    const WAVES = Number(process.env.REPRO_WAVES ?? 5);

    it('S1: direct checkouts of different buyers, one protected event', async () => {
      const { serializationFailures } = await scenario('S1 direct x8', { direct: 8 }, WAVES);
      // Alone, they met on the event row only (in every run: no SSI failure at all).
      expect(serializationFailures.byKind.concurrentUpdate ?? 0).toBeGreaterThan(0);
    });

    it('S2: reservations of different buyers, one protected event', async () => {
      const { serializationFailures } = await scenario('S2 reserve x8', { reserve: 8 }, WAVES);
      expect(serializationFailures.byKind.concurrentUpdate ?? 0).toBeGreaterThan(0);
    });

    it('S3: direct checkouts with checkouts of existing reservations', async () => {
      const { serializationFailures } = await scenario(
        'S3 direct x4 + viaReservation x4',
        { direct: 4, viaReservation: 4 },
        WAVES,
      );
      // With a writer of `orders` that does not change the event row, SSI failures appear.
      expect(serializationFailures.byKind.ssi ?? 0).toBeGreaterThan(0);
    });

    it('S4: direct checkouts with settlements of existing orders', async () => {
      const { serializationFailures } = await scenario(
        'S4 direct x4 + settle x4',
        { direct: 4, settle: 4 },
        WAVES,
      );
      expect(serializationFailures.byKind.ssi ?? 0).toBeGreaterThan(0);
    });

    it('S5: direct checkouts, checkouts of reservations and settlements together', async () => {
      const { serializationFailures } = await scenario(
        'S5 direct x4 + viaReservation x4 + settle x4',
        { direct: 4, viaReservation: 4, settle: 4 },
        WAVES,
      );
      expect(serializationFailures.byKind.ssi ?? 0).toBeGreaterThan(0);
    });

    /**
     * Each buyer has an own, unprotected event, so no two transactions write the same event row,
     * policy row or checkout key. They still share tables: `orders` (read by Idempotency-Key, then
     * INSERT), `payment_records` (INSERT), and whatever a statement reads at a granularity wider
     * than its row. S8 lists them: for `events` and `users` a page of the primary key index on a
     * new database, and the whole relation once the planner scans those small tables instead. So a
     * failure here shows that a shared row is not needed for a dependency cycle; it does not
     * single out the read of `orders`. `filler` rows enlarge `orders` and its indexes only.
     */

    /** How the planner reads `orders` by Idempotency-Key right now (statistics included). */
    async function orderKeyPlan() {
      const plan = (
        await pool.query(
          `EXPLAIN (FORMAT JSON) SELECT id FROM orders WHERE idempotency_key = '${randomUUID()}'`,
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      return { node: plan['Node Type'] as string, index: (plan['Index Name'] as string) ?? null };
    }
    async function separateEvents(name: string, filler: number) {
      const buyers = 8;
      const own = [];
      for (let i = 0; i < buyers; i++) own.push(await fixture(1, false));
      const fillerEvent = await fixture(1, false);
      if (filler) {
        await pool.query(
          `INSERT INTO orders (id, user_id, event_id, quantity, tier_id, unit_price, total_amount,
           idempotency_key, status)
         SELECT uuid_generate_v4(), $1, $2, 1, $3, 50, 50, uuid_generate_v4(), 'cancelled'
         FROM generate_series(1, $4)`,
          [fillerEvent.users[0], fillerEvent.eventId, TIER, filler],
        );
        await pool.query('ANALYZE orders');
      }
      const plan = await orderKeyPlan();
      // The first purchase of an event creates its policy row; keep that out of the waves.
      for (const fx of own)
        expect((await checkout(fx, fx.users[0], randomUUID())).status).toBe(201);

      const sent: Sent[] = [];
      failures.length = 0;
      exhausted.length = 0;
      for (let i = 0; i < WAVES * 2; i++) {
        const responses = await Promise.all(
          own.map((fx) => checkout(fx, fx.users[0], randomUUID())),
        );
        sent.push(
          ...responses.map((response) => ({
            type: 'direct' as const,
            status: response.status,
            code: (response.body.error?.code as string | undefined) ?? null,
          })),
        );
      }
      const summary = report(name, sent, [...failures], null);
      process.stdout.write(`REPRO-PLAN ${JSON.stringify({ scenario: name, ...plan })}\n`);
      return summary;
    }

    it('S6: direct checkouts of different buyers on separate unprotected events, small orders table', async () => {
      const { serializationFailures } = await separateEvents('S6 separate events, no filler', 0);
      // No shared row at all, and still a dependency cycle: the reads are wider than the rows.
      expect(serializationFailures.byKind.ssi ?? 0).toBeGreaterThan(0);
    });

    it('S7: the same with 5,000 other orders in the table', async () => {
      const { serializationFailures } = await separateEvents(
        'S7 separate events, 5000 filler orders',
        5000,
      );
      expect(serializationFailures.byKind.ssi ?? 0).toBeGreaterThan(0);
    });

    /**
     * What one purchase transaction holds as SIRead (predicate) locks just before COMMIT. The work
     * runs alone in a SERIALIZABLE transaction of this test and is rolled back, so the list is what
     * the product's statements read, at the granularity PostgreSQL kept.
     */
    async function predicateLocks(work: (client: PoolClient) => Promise<unknown>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await work(client);
        const locks = await client.query<{ relation: string; locktype: string; count: number }>(
          `SELECT relation::regclass::text AS relation, locktype, count(*)::int AS count
         FROM pg_locks WHERE mode = 'SIReadLock' AND pid = pg_backend_pid()
         GROUP BY 1, 2 ORDER BY 1, 2`,
        );
        return locks.rows.map((row) => `${row.relation} ${row.locktype} x${row.count}`);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    async function lockReport(name: string, filler: number) {
      const fx = await fixture(3, true);
      const [viaUser, settleUser, directUser] = fx.users;
      if (filler) {
        const other = await fixture(1, false);
        await pool.query(
          `INSERT INTO orders (id, user_id, event_id, quantity, tier_id, unit_price, total_amount,
           idempotency_key, status)
         SELECT uuid_generate_v4(), $1, $2, 1, $3, 50, 50, uuid_generate_v4(), 'cancelled'
         FROM generate_series(1, $4)`,
          [other.users[0], other.eventId, TIER, filler],
        );
        await pool.query('ANALYZE orders');
      }
      const [viaAdmission, settleAdmission] = await admitAll(fx, [viaUser, settleUser]);
      const held = await reserve(fx, viaUser, viaAdmission);
      const ordered = await checkout(fx, settleUser, randomUUID(), settleAdmission);
      expect([held.status, ordered.status]).toEqual([201, 201]);
      const [directAdmission] = await admitAll(fx, [directUser]);
      const input = (userId: string, extra: object = {}) => ({
        ...purchase(fx, userId, extra),
        idempotencyKey: randomUUID(),
      });
      const locks = {
        scenario: name,
        orderKeyPlan: await orderKeyPlan(),
        direct: await predicateLocks((client) =>
          new CheckoutService().checkout(input(directUser), client, {
            admissionId: directAdmission.admissionId,
            epoch: directAdmission.admissionEpoch,
          }),
        ),
        viaReservation: await predicateLocks((client) =>
          new CheckoutService().checkout(
            input(viaUser, { reservationId: held.body.id }),
            client,
            undefined,
          ),
        ),
        settle: await predicateLocks((client) =>
          new PaymentWebhookService().processPaymentWebhook(
            {
              orderId: ordered.body.order.id,
              providerTransactionId: randomUUID(),
              status: 'settled',
            },
            randomUUID(),
            client,
          ),
        ),
      };
      const line = `REPRO-LOCKS ${JSON.stringify(locks)}\n`;
      process.stdout.write(line);
      if (process.env.REPRO_OUT) appendFileSync(process.env.REPRO_OUT, line);
      return locks;
    }

    it('S8: predicate locks of one direct checkout, one checkout of a reservation and one settlement', async () => {
      // "No filler" is not "small" for the planner: S7 leaves the statistics of its ANALYZE behind.
      const locks = await lockReport('S8 no filler', 0);
      // The Idempotency-Key read of both checkouts is a predicate lock on `orders`: a page of that
      // index when the planner uses it, the whole relation when it scans the table instead.
      const keyRead =
        locks.orderKeyPlan.node === 'Seq Scan'
          ? 'orders relation x1'
          : `${locks.orderKeyPlan.index} page x1`;
      for (const held of [locks.direct, locks.viaReservation]) expect(held).toContain(keyRead);
    });

    it('S9: the same with 5,000 other orders in the table', async () => {
      await lockReport('S9 5000 filler orders', 5000);
    });
  },
);
