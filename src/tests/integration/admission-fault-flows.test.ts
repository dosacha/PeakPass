import { randomUUID } from 'crypto';
import {
  faultSuite,
  startTopology,
  Topology,
  Answer,
  AppBox,
  Buyer,
  sleep,
  until,
  TIER,
} from './admission-fault-fixture';

/**
 * P7: policy transitions with buyers attached, the existing flows on a protected event, and the
 * ways around the gate, through two application processes.
 *
 * Opt-in: ADMISSION_FAULT_IMAGE names the production image under test. Activation, release and
 * deletion are done by SQL as the contract's explicit transitions; the product has no entry point
 * for them. Orders get a payment window of three seconds so that deadlines pass in real time.
 */
jest.setTimeout(420000);

faultSuite('admission lifecycle and existing flows across processes (real containers)', () => {
  let t: Topology;
  let previous: string | null = null;
  let swept: { reservationId: string } | null = null;
  beforeAll(async () => {
    t = await startTopology({
      apps: [{ admission: true }, { admission: true }],
      env: { ORDER_PAYMENT_WINDOW_MINUTES: '0.05' },
    });
  });
  afterAll(async () => {
    await t?.destroy('flows');
  });

  /** One protected event per database: the event of the scenario before is released first. */
  async function event(seats: number, isProtected = true) {
    if (previous) await t.release(previous);
    await t.begin(expect.getState().currentTestName ?? 'scenario');
    const eventId = await t.event(seats, isProtected);
    previous = isProtected ? eventId : null;
    return eventId;
  }
  const brief = (answer: Answer) => ({ app: answer.app, status: answer.status, code: answer.code, ms: answer.ms });
  const tally = (answers: Answer[]) => {
    const seen: Record<string, number> = {};
    for (const answer of answers) {
      const key = `${answer.status} ${answer.code ?? ''}`.trim();
      seen[key] = (seen[key] ?? 0) + 1;
    }
    return seen;
  };
  const reserveLegacy = (buyer: Buyer, app: AppBox, eventId: string) =>
    buyer.call(app, 'POST', '/reservations', buyer.reservationBody(eventId, null, 1));
  const checkoutLegacy = (buyer: Buyer, app: AppBox, eventId: string) =>
    buyer.call(app, 'POST', '/checkouts', { eventId, userId: buyer.userId, quantity: 1, tierId: TIER }, randomUUID());
  /**
   * Occupations of the event that no consumed result stands for, with the time their creating
   * transaction committed. An order row is updated when it expires, so its creation is read from
   * its checkout payment record, which is written in the same transaction and never changed.
   */
  const unlinked = async (eventId: string) =>
    (
      await t.pool.query<{ id: string; at: Date }>(
        `SELECT r.id, pg_xact_commit_timestamp(r.xmin) AS at FROM reservations r
        WHERE r.event_id = $1 AND NOT EXISTS (SELECT 1 FROM admission_results a WHERE a.reservation_id = r.id)
        UNION ALL
        SELECT o.id, pg_xact_commit_timestamp(p.xmin) FROM orders o
        JOIN payment_records p ON p.order_id = o.id AND p.provider_transaction_id IS NULL
        WHERE o.event_id = $1 AND o.reservation_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM admission_results a WHERE a.order_id = o.id)`,
        [eventId],
      )
    ).rows;
  const order = async (orderId: string) =>
    (
      await t.pool.query<{ status: string; tickets: number }>(
        `SELECT o.status, (SELECT COUNT(*)::int FROM tickets WHERE order_id = o.id) AS tickets FROM orders o WHERE o.id = $1`,
        [orderId],
      )
    ).rows[0];

  it('L1 activation while purchases arrive: nothing is occupied without an admission after the activation committed', async () => {
    const eventId = await event(5000, false);
    const [first, second] = t.apps;
    const buyers = [];
    for (let i = 0; i < 12; i++) buyers.push(await t.buyer());
    let running = true;
    const reservations: Answer[] = [];
    const checkouts: Answer[] = [];
    // Purchases without admission fields on both paths and both instances, for the whole window.
    const traffic = Promise.all(
      buyers.map(async (buyer, index) => {
        while (running) {
          const app = index % 2 ? first : second;
          if (index % 3 === 0) checkouts.push(await checkoutLegacy(buyer, app, eventId));
          else reservations.push(await reserveLegacy(buyer, app, eventId));
          await sleep(40);
        }
      }),
    );
    await sleep(1500);
    // The explicit transition, held for a moment so that requests queue at the event gate.
    const activatedAt = await t.protect(eventId, true, 400);
    previous = eventId;
    await sleep(1500);
    running = false;
    await traffic;
    const seen = { reservations: tally(reservations), checkouts: tally(checkouts) };
    t.note('L1 answers', { seen, activatedAt });
    // Before the activation the purchases went through; after it they are told to go to the queue.
    expect(Object.keys(seen.reservations).sort()).toEqual(['201', '400 ADMISSION_INVALID_INPUT']);
    // The existing direct checkout runs SERIALIZABLE next to the reservations that update the same
    // event row. Without admission fields it keeps its existing answer when the three attempts
    // run out: 500. That is the unprotected path as it was before the queue, not the activation.
    expect(
      Object.keys(seen.checkouts).filter((answer) => !['201', '400 ADMISSION_INVALID_INPUT', '500 INTERNAL_ERROR'].includes(answer)),
    ).toEqual([]);
    expect(seen.checkouts['400 ADMISSION_INVALID_INPUT']).toBeGreaterThan(0);
    const late = (await unlinked(eventId)).filter((row) => row.at >= activatedAt);
    expect(late).toEqual([]);
    expect((await unlinked(eventId)).length).toBe((seen.reservations['201'] ?? 0) + (seen.checkouts['201'] ?? 0));
    // The schedulers publish the namespace of the new policy, and the queue then admits a buyer.
    await until(async () => (await t.control(eventId))?.mode === 'ready', 30000, 'the namespace to be published');
    const admitted = await buyers[0].enter(eventId);
    expect((await buyers[0].reserve(eventId, admitted, 1)).final.status).toBe(201);
    await t.quiet(eventId);
    // The occupations from before the activation have no result by design.
    await t.verify(['unlinked_occupation']);
  });

  it('L2 release with writers attached: the writer in flight finishes under protection, then the queue is gone', async () => {
    const eventId = await event(60);
    const [first, second] = t.apps;
    const writer = await t.buyer();
    const writerAdmission = await writer.enter(eventId, 60000, second);
    const waiting = await t.buyer();
    const idle = await t.buyer();
    const idleAdmission = await idle.enter(eventId);
    const remove = await t.slow('reservations', writer.userId, 2);
    let releasedAt: Date;
    let writerAnswer: Answer;
    try {
      const inflight = writer.call(first, 'POST', '/reservations', writer.reservationBody(eventId, writerAdmission, 1), undefined, 30000);
      await t.sleeping('%INSERT INTO reservations%');
      await waiting.queue(eventId, second);
      // The release needs the exclusive gate and so waits for the writer that holds the shared one.
      releasedAt = await t.protect(eventId, false);
      previous = null;
      writerAnswer = await inflight;
    } finally {
      await remove();
    }
    expect(writerAnswer.status).toBe(201);
    const results = await t.results(eventId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ admissionId: writerAdmission.admissionId, outcome: 'consumed' });
    expect(new Date(results[0].committedAt).getTime()).toBeLessThan(releasedAt.getTime());
    // A scheduler retires the namespace; the queue API then says that the event has no queue.
    await until(async () => (await t.control(eventId)) === null, 30000, 'the namespace to be retired');
    for (const [buyer, app] of [[waiting, first], [idle, second]] as const)
      expect(await buyer.status(eventId, app)).toMatchObject({ status: 404, code: 'ADMISSION_NOT_ENABLED' });
    // The event is unprotected now: a purchase takes the existing flow and consumes no admission.
    expect((await idle.reserve(eventId, idleAdmission, 1)).final.status).toBe(201);
    expect((await reserveLegacy(waiting, first, eventId)).status).toBe(201);
    expect(await t.results(eventId)).toHaveLength(1);
    // While it was protected nothing was occupied without a result.
    expect((await unlinked(eventId)).filter((row) => row.at < releasedAt)).toEqual([]);
    await t.verify();
  });

  it('L3 deletion with writers attached: history keeps the event, and a queue-only event leaves no orphan and no 500', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const writer = await t.buyer();
    const writerAdmission = await writer.enter(eventId, 60000, second);
    const remove = await t.slow('reservations', writer.userId, 2);
    try {
      const inflight = writer.call(first, 'POST', '/reservations', writer.reservationBody(eventId, writerAdmission, 1), undefined, 30000);
      await t.sleeping('%INSERT INTO reservations%');
      // The cascade to the policy row waits for the writer's lock; then the reservation forbids it.
      const began = Date.now();
      await expect(t.pool.query('DELETE FROM events WHERE id = $1', [eventId])).rejects.toMatchObject({ code: '23503' });
      expect(Date.now() - began).toBeGreaterThan(500);
      expect((await inflight).status).toBe(201);
    } finally {
      await remove();
    }
    expect(await t.policy(eventId)).toMatchObject({ protected: true });
    await t.quiet(eventId);
    await t.verify();

    // An event that only has a queue can be deleted. A purchase that meets the deletion either
    // commits first, and then the deletion is refused, or finds no event.
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const queued = await event(20);
      const buyer = await t.buyer();
      const admission = await buyer.enter(queued, 60000, round % 2 ? first : second);
      const other = await t.buyer();
      await other.queue(queued);
      const [bought, deletion] = await Promise.all([
        buyer.reserve(queued, admission, 1, [round % 2 ? second : first]),
        t.pool.query('DELETE FROM events WHERE id = $1', [queued]).then(() => 'deleted', (error) => String(error.code)),
      ]);
      const purchase = bought.final;
      rounds.push({ purchase: brief(purchase), attempts: bought.attempts.map(brief), deletion });
      if (deletion === 'deleted') {
        previous = null;
        expect(purchase.status).toBe(404);
        // The sweep retires the orphaned namespace; the queue API then answers 404.
        await until(async () => (await t.control(queued)) === null, 30000, 'the orphaned namespace to be retired');
        expect((await other.status(queued, first)).status).toBe(404);
        expect((await t.pool.query('SELECT 1 FROM reservations WHERE event_id = $1', [queued])).rowCount).toBe(0);
      } else {
        // Refused by the reservation's foreign key, or chosen as the victim of the lock cycle
        // between the purchase and the cascade.
        expect(['23503', '40P01']).toContain(deletion);
        expect(purchase.status).toBe(201);
        await t.quiet(queued);
      }
    }
    t.note('L3 purchase against deletion', { rounds });
    await t.verify();
  });

  it('L5 ways around the gate, across both instances: every one is refused and leaves nothing behind', async () => {
    const eventId = await event(40);
    const [first, second] = t.apps;
    const owner = await t.buyer();
    const ownerAdmission = await owner.enter(eventId);
    const stranger = await t.buyer();
    // Seven more admitted users fill the capacity: the next one waits, and one of them is left to expire.
    const fillers: Buyer[] = [];
    for (let i = 0; i < 7; i++) {
      fillers.push(await t.buyer());
      await fillers[i].queue(eventId, i % 2 ? first : second);
    }
    await Promise.all(fillers.map((filler) => filler.admitted(eventId)));
    const waiting = await t.buyer();
    const waitingAdmission = await waiting.queue(eventId, second);
    const before = await t.seats(eventId);
    const ownerBody = owner.reservationBody(eventId, ownerAdmission, 1);
    const refused: Array<[string, Answer, number, string | null]> = [
      ['admission fields without a token', await t.http(first, 'POST', '/reservations', { body: ownerBody }), 401, 'UNAUTHENTICATED'],
      ['the body names another user', await stranger.call(second, 'POST', '/reservations', ownerBody), 403, 'FORBIDDEN'],
      ['a reservation without admission fields', await reserveLegacy(stranger, first, eventId), 400, 'ADMISSION_INVALID_INPUT'],
      ['a direct checkout without admission fields', await checkoutLegacy(stranger, second, eventId), 400, 'ADMISSION_INVALID_INPUT'],
      ['one admission field alone', await stranger.call(first, 'POST', '/reservations', { ...stranger.reservationBody(eventId, null, 1), admissionId: ownerAdmission.admissionId }), 400, 'ADMISSION_INVALID_INPUT'],
      ['the admission of another user', await stranger.call(second, 'POST', '/reservations', stranger.reservationBody(eventId, ownerAdmission, 1)), 404, 'ADMISSION_NOT_FOUND'],
      ['the admission of another user on the direct path', await stranger.call(first, 'POST', '/checkouts', { eventId, userId: stranger.userId, quantity: 1, tierId: TIER, ...ownerAdmission }, randomUUID()), 404, 'ADMISSION_NOT_FOUND'],
      ['an admission that does not exist', await stranger.call(second, 'POST', '/reservations', stranger.reservationBody(eventId, { admissionId: randomUUID(), admissionEpoch: ownerAdmission.admissionEpoch }, 1)), 404, 'ADMISSION_NOT_FOUND'],
      ['an epoch that is not the current one', await owner.call(first, 'POST', '/reservations', owner.reservationBody(eventId, { admissionId: ownerAdmission.admissionId, admissionEpoch: randomUUID() }, 1)), 410, 'ADMISSION_RESET'],
      ['an admission that is still waiting', await waiting.call(second, 'POST', '/reservations', waiting.reservationBody(eventId, waitingAdmission, 1)), 409, 'ADMISSION_NOT_READY'],
    ];
    t.note('L5 refusals', { refused: refused.map(([what, answer]) => ({ what, ...brief(answer) })) });
    for (const [what, answer, status, code] of refused) expect({ what, status: answer.status, code: answer.code }).toEqual({ what, status, code });
    expect(await t.seats(eventId)).toEqual(before);
    // None of it cost the owner anything: the admission still buys, once.
    const bought = await owner.call(first, 'POST', '/reservations', ownerBody);
    expect(bought.status).toBe(201);
    // Another user cannot check out that reservation, with or without an admission of their own.
    const foreign = await stranger.call(second, 'POST', '/checkouts', { eventId, userId: stranger.userId, quantity: 1, tierId: TIER, reservationId: bought.body!.id }, randomUUID());
    expect(foreign.status).toBe(409);
    expect((await t.seats(eventId)).orders).toBe(0);
    // Real time: an admission left alone for its 30 s is refused as expired.
    await until(async () => (await fillers[0].status(eventId)).body?.admission?.state === 'expired', 60000, 'an idle admission to expire', 1000);
    const expired = await fillers[0].call(first, 'POST', '/reservations', fillers[0].reservationBody(eventId, { admissionId: (await fillers[0].status(eventId)).body!.admission.admissionId, admissionEpoch: ownerAdmission.admissionEpoch }, 1));
    expect(expired).toMatchObject({ status: 410, code: 'ADMISSION_EXPIRED' });
    expect(await t.seats(eventId)).toMatchObject({ reservations: 1, results: 1 });
    await t.quiet(eventId);
    await t.verify();
  });

  it('L4 existing flows on a protected event: expiry, deadline against settlement with two sweepers, late and failed payment, callback replay', async () => {
    const eventId = await event(60);
    const [first, second] = t.apps;
    const purchase = async (kind: 'reservation' | 'direct') => {
      const buyer = await t.buyer();
      const admission = await buyer.enter(eventId);
      const made = kind === 'direct' ? await buyer.checkout(eventId, { admission, quantity: 2 }) : await buyer.reserve(eventId, admission, 2);
      expect(made.final.status).toBe(201);
      return { buyer, body: made.final.body! };
    };
    const available = async () => (await t.seats(eventId)).available as number;

    // A reservation made with an admission expires (the expiry time is written back, synthetic)
    // and its checkout returns the seats; the result that created it stays.
    const expiring = await purchase('reservation');
    const held = await available();
    await t.pool.query(`UPDATE reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [expiring.body.id]);
    const tooLate = await expiring.buyer.checkout(eventId, { reservationId: expiring.body.id, quantity: 2 });
    expect(tooLate.final.status).toBe(409);
    expect(await available()).toBe(held + 2);
    expect((await t.pool.query('SELECT status FROM reservations WHERE id = $1', [expiring.body.id])).rows[0].status).toBe('expired');
    // A second one is left for the product's own five-minute sweeper (last scenario of this file).
    const left = await purchase('reservation');
    await t.pool.query(`UPDATE reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [left.body.id]);
    swept = { reservationId: left.body.id };

    // Real time: the three-second payment deadline against a settlement, with a sweeper in each
    // instance. Each order ends paid with its tickets or expired with its seats back, never both.
    const outcomes = [];
    for (const offsetMs of [-600, -200, -50, 0, 100, 300]) {
      const made = await purchase('direct');
      const taken = await available();
      const deadline = new Date(made.body.order.paymentDeadlineAt).getTime();
      await sleep(Math.max(0, deadline - (await t.pgNow()).getTime() + offsetMs));
      const settled = await t.settle(offsetMs % 100 ? first : second, made.body.order.id);
      expect(settled.status).toBe(200);
      const final = await until(async () => {
        const row = await order(made.body.order.id);
        return row.status !== 'pending' && row;
      }, 10000, 'the order to leave pending');
      outcomes.push({ offsetMs, status: final.status, tickets: final.tickets, answered: settled.body!.order.status });
      if (final.status === 'paid') {
        expect(final.tickets).toBe(2);
        expect(settled.body!.tickets).toHaveLength(2);
        expect(await available()).toBe(taken);
      } else {
        expect(final).toEqual({ status: 'expired', tickets: 0 });
        expect(settled.body!.tickets).toHaveLength(0);
        expect(await available()).toBe(taken + 2);
      }
    }
    t.note('L4 deadline against settlement', { outcomes });

    // A settlement that arrives after the expiry is kept as a fact and issues nothing.
    const lateOrder = await purchase('direct');
    await until(async () => (await order(lateOrder.body.order.id)).status === 'expired', 15000, 'the order to expire');
    const afterExpiry = await available();
    const late = await t.settle(first, lateOrder.body.order.id);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ order: { status: 'expired' }, tickets: [] });
    expect(await available()).toBe(afterExpiry);

    // A failed payment returns the seats once, whoever reports it again.
    const failing = await purchase('direct');
    const beforeFailure = await available();
    expect((await t.settle(second, failing.body.order.id, 'failed')).status).toBe(200);
    expect((await order(failing.body.order.id)).status).toBe('cancelled');
    expect(await available()).toBe(beforeFailure + 2);
    expect((await t.settle(first, failing.body.order.id, 'failed')).status).toBe(200);
    expect(await available()).toBe(beforeFailure + 2);

    // A paid order's callback is replayed after Redis lost its cache: the durable key answers.
    const paying = await purchase('direct');
    const key = randomUUID();
    const provider = `p7-${randomUUID()}`;
    const paid = await t.settle(first, paying.body.order.id, 'settled', key, provider);
    expect(paid.body).toMatchObject({ order: { status: 'paid' }, duplicate: false });
    await t.quiet(eventId);
    expect(await t.violations()).toEqual([]);
    await t.redisFaults.stop();
    await t.redisFaults.start();
    await Promise.all(t.apps.map((app) => t.ready(app)));
    const replay = await until(async () => {
      const answer = await t.settle(second, paying.body.order.id, 'settled', key, provider);
      return answer.status === 200 && answer;
    }, 30000, 'the callback after the Redis restart', 500);
    expect(replay.body).toMatchObject({ order: { status: 'paid' }, duplicate: true });
    expect(replay.body!.tickets).toHaveLength(2);
    const reused = await t.settle(first, paying.body.order.id, 'settled', key, `p7-${randomUUID()}`);
    expect(reused.status).toBe(409);
    expect(await t.violations()).toEqual([]);
  });

  it('L4c the five-minute reservation sweeper of the product returns the seats of an expired reservation', async () => {
    expect(swept).not.toBeNull();
    const { reservationId } = swept!;
    // Real time: the sweeper's first tick comes five minutes after the instances started.
    await until(
      async () => (await t.pool.query('SELECT status FROM reservations WHERE id = $1', [reservationId])).rows[0].status === 'expired',
      400000,
      'the reservation sweeper',
      5000,
    );
    // The reservation holds nothing any more and the seat equation still adds up: its two seats
    // came back exactly once.
    expect(await t.violations()).toEqual([]);
  });
});
