import { randomUUID } from 'crypto';
import {
  faultSuite,
  startTopology,
  Topology,
  Answer,
  AdmissionRef,
  AppBox,
  Buyer,
  sleep,
  until,
} from './admission-fault-fixture';

/**
 * P7: several application processes, real process failures and the real timers of admission-v1
 * (claim deadline 15 s, admission TTL 30 s, the transaction bounds of contract §5).
 *
 * Opt-in: ADMISSION_FAULT_IMAGE names the production image under test. Everything this file
 * stops, pauses or kills is a container the fixture created. Where a request is held inside its
 * transaction, the hold is a synthetic stimulus (a `pg_sleep` trigger on that buyer's INSERT);
 * the kill, the pause and every timer that fires are real.
 */
jest.setTimeout(420000);

faultSuite('admission across application processes and process failures (real containers)', () => {
  let t: Topology;
  let previous: string | null = null;
  beforeAll(async () => {
    // Two instances run a scheduler; the third has the feature off and must never open the event.
    t = await startTopology({ apps: [{ admission: true }, { admission: true }, { admission: false }] });
  });
  afterAll(async () => {
    await t?.destroy('process');
  });

  /** One protected event per database: the event of the scenario before is released first. */
  async function event(seats: number) {
    if (previous) await t.release(previous);
    await t.begin(expect.getState().currentTestName ?? 'scenario');
    previous = await t.event(seats);
    return previous;
  }
  const brief = (answer: Answer) => ({ app: answer.app, status: answer.status, code: answer.code, ms: answer.ms });
  const resultOf = async (eventId: string, admission: AdmissionRef) =>
    (await t.results(eventId)).find((row) => row.admissionId === admission.admissionId);
  /** An admitted buyer whose polls go to `app`, with the body of the one reservation it will ask for. */
  async function admitted(eventId: string, app: AppBox) {
    const buyer = await t.buyer();
    const admission = await buyer.enter(eventId, 60000, app);
    return { buyer, admission, body: buyer.reservationBody(eventId, admission, 1) };
  }
  const send = (buyer: Buyer, app: AppBox, body: unknown, timeoutMs = 30000) =>
    buyer.call(app, 'POST', '/reservations', body, undefined, timeoutMs);

  it('M1 buyers on three instances: two schedulers, one instance with the feature off', async () => {
    const eventId = await event(16);
    const [first, second, off] = t.apps;
    const rotations = [
      [first, second],
      [second, first],
      [off, first, second],
    ];
    const kinds = [
      ...Array<string>(10).fill('reserve'),
      ...Array<string>(4).fill('direct'),
      'duplicate',
      'duplicate',
      'same-join',
      'same-join',
      'abandon',
      'abandon',
      'cancel',
      'cancel',
    ];
    const buyers = [];
    for (const [index, kind] of kinds.entries())
      buyers.push({ kind, index, buyer: await t.buyer(), targets: rotations[index % rotations.length] });

    // Everyone joins in a known order; the cancellers are last and still waiting when they cancel.
    const joined: AdmissionRef[] = [];
    for (const { kind, buyer, targets } of buyers) {
      const poll = targets.find((app) => app.admission)!;
      if (kind !== 'same-join') {
        joined.push(await buyer.queue(eventId, poll));
        continue;
      }
      // A01 across processes: one join key sent to both instances at the same moment.
      const epoch = (await buyer.status(eventId, poll)).body!.queue.epoch;
      const key = randomUUID();
      const both = await Promise.all([buyer.join(eventId, epoch, key, first), buyer.join(eventId, epoch, key, second)]);
      expect(both.map((answer) => answer.status).sort()).toEqual([200, 201]);
      expect(both[0].body!.admission.admissionId).toBe(both[1].body!.admission.admissionId);
      joined.push({ admissionId: both[0].body!.admission.admissionId, admissionEpoch: epoch });
    }
    const sequences = await Promise.all(joined.map(async (admission) => Number((await t.entry(eventId, admission))!.sequence)));
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));

    const outcomes = await Promise.all(
      buyers.map(async ({ kind, index, buyer, targets }) => {
        const admission = joined[index];
        const poll = targets.find((app) => app.admission)!;
        if (kind === 'cancel') {
          const cancelled = await buyer.cancel(eventId, admission, poll === first ? second : first);
          const late = await buyer.reserve(eventId, admission, 1, [first]);
          return { kind, admission, answers: [cancelled, late.final], attempts: late.attempts };
        }
        await buyer.admitted(eventId, 90000, poll);
        if (kind === 'abandon') return { kind, admission, answers: [], attempts: [] };
        if (kind === 'direct') {
          const purchase = await buyer.checkout(eventId, { admission, quantity: 1 }, targets);
          return { kind, admission, answers: [purchase.final], attempts: purchase.attempts };
        }
        if (kind === 'duplicate') {
          // A06 across processes: the same request on both instances at the same moment.
          const pair = await Promise.all([
            buyer.reserve(eventId, admission, 1, [first]),
            buyer.reserve(eventId, admission, 1, [second]),
          ]);
          return { kind, admission, answers: pair.map((p) => p.final), attempts: pair.flatMap((p) => p.attempts) };
        }
        const purchase = await buyer.reserve(eventId, admission, 1 + (index % 2), targets);
        return { kind, admission, answers: [purchase.final], attempts: purchase.attempts };
      }),
    );

    // The instance with the feature off answered 503 for every purchase it received and none else.
    const viaOff = outcomes.flatMap((o) => o.attempts).filter((a: Answer) => a.app === off.index + 1);
    expect(viaOff.length).toBeGreaterThan(0);
    expect(viaOff.every((a) => a.status === 503 && a.code === 'ADMISSION_UNAVAILABLE')).toBe(true);

    for (const outcome of outcomes.filter((o) => o.kind === 'cancel')) {
      expect(outcome.answers[0]).toMatchObject({ status: 200 });
      expect(outcome.answers[0].body!.admission.state).toBe('cancelled');
      expect(outcome.answers[1]).toMatchObject({ status: 410, code: 'ADMISSION_CANCELLED' });
    }
    const purchases = outcomes.filter((o) => !['cancel', 'abandon'].includes(o.kind));
    const bought = purchases.filter((o) => o.answers.every((a) => a.status === 201));
    const soldOut = purchases.filter((o) => o.answers.every((a) => a.status === 409 && a.code === 'INSUFFICIENT_INVENTORY'));
    // Every purchase ended as one of the two; nothing stayed unknown.
    expect(bought.length + soldOut.length).toBe(purchases.length);
    expect(soldOut.length).toBeGreaterThan(0);
    for (const outcome of bought.filter((o) => o.kind === 'duplicate'))
      expect(outcome.answers[0].body!.id).toBe(outcome.answers[1].body!.id);

    // Real time: the two abandoned admissions expire after their 30 s and give their slots back.
    await t.quiet(eventId);
    for (const outcome of outcomes.filter((o) => o.kind === 'abandon'))
      expect(await t.entry(eventId, outcome.admission)).toMatchObject({ state: 'expired', reason: 'ADMISSION_EXPIRED' });

    const results = await t.results(eventId);
    const targetOf = (o: (typeof outcomes)[number]) =>
      o.kind === 'direct' ? o.answers[0].body!.order.id : o.answers[0].body!.id;
    expect(results.filter((r) => r.outcome === 'consumed').map((r) => r.reservationId ?? r.orderId).sort()).toEqual(
      bought.map(targetOf).sort(),
    );
    expect(results.filter((r) => r.outcome === 'rejected').map((r) => r.admissionId).sort()).toEqual(
      soldOut.map((o) => o.admission.admissionId).sort(),
    );
    expect(results.filter((r) => r.outcome === 'closed')).toEqual([]);
    // Redis tells the same story as the ledger for every admission that reached a purchase.
    for (const outcome of purchases) {
      const entry = (await t.entry(eventId, outcome.admission))!;
      expect(entry.state).toBe('consumed');
      expect(entry.outcome).toMatchObject(
        soldOut.includes(outcome)
          ? { kind: 'rejected', code: 'INSUFFICIENT_INVENTORY' }
          : { resourceId: targetOf(outcome) },
      );
    }
    const seats = await t.seats(eventId);
    const taken = bought.reduce(
      (sum, o) => sum + (o.kind === 'direct' ? o.answers[0].body!.order.quantity : o.answers[0].body!.quantity),
      0,
    );
    expect(seats.available).toBe(16 - taken);

    const log = await t.verify();
    // Every entry that was admitted is in the log once: 18 purchasers and the two that abandoned.
    expect(log.promotions).toBe(20);
    // The log counts because it began on an empty keyspace. A capture that begins now says so.
    expect(await t.lateCapture()).toEqual([expect.stringMatching(/capture began with \d+ admission keys present/)]);
    t.note('M1', { buyers: buyers.length, bought: bought.length, soldOut: soldOut.length, promotions: log.promotions,
      viaOff: viaOff.length, seats });
  });

  it('M2 one admission on two instances at once: one target, one deduction, the other command is refused', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    for (let round = 0; round < 5; round++) {
      const { buyer, admission } = await admitted(eventId, round % 2 ? first : second);
      const before = await t.seats(eventId);
      // A05 across processes: a reservation on one instance, a direct checkout on the other.
      const [reservation, direct] = await Promise.all([
        buyer.reserve(eventId, admission, 1, [first]),
        buyer.checkout(eventId, { admission, quantity: 1 }, [second]),
      ]);
      expect([reservation.final.status, direct.final.status].sort()).toEqual([201, 409]);
      const refused = reservation.final.status === 409 ? reservation.final : direct.final;
      expect(refused.code).toBe('ADMISSION_REQUEST_MISMATCH');
      const after = await t.seats(eventId);
      expect(after).toMatchObject({ available: before.available - 1, results: before.results + 1 });
      expect(after.reservations + after.orders).toBe(before.reservations + before.orders + 1);
      t.note('M2 round', { round, reservation: brief(reservation.final), direct: brief(direct.final) });
    }
    // A06 across processes: ten copies of one request, alternating between the instances.
    const { buyer, admission } = await admitted(eventId, first);
    const copies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => buyer.reserve(eventId, admission, 1, [t.apps[i % 2]])),
    );
    expect(copies.map((copy) => copy.final.status)).toEqual(Array(10).fill(201));
    expect(new Set(copies.map((copy) => copy.final.body!.id)).size).toBe(1);
    expect((await t.seats(eventId)).available).toBe(20 - 6);
    await t.quiet(eventId);
    await t.verify();
  });

  it('M3 cancel against promotion and against the purchase claim, across instances: one winner each time', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    // A04 across processes, first half: eight admitted users fill the capacity. Each round frees
    // one slot by a cancel on one instance, and the user who is next in line cancels on the other
    // instance a moment later: before or after the tick that would promote it.
    const holders: Array<{ buyer: Buyer; admission: AdmissionRef }> = [];
    for (let i = 0; i < 8; i++) {
      const buyer = await t.buyer();
      holders.push({ buyer, admission: await buyer.queue(eventId, i % 2 ? first : second) });
    }
    await Promise.all(holders.map((holder) => holder.buyer.admitted(eventId)));
    const before = await t.seats(eventId);
    for (const [round, delayMs] of [0, 120, 260, 400].entries()) {
      const next = await t.buyer();
      const waiting = await next.queue(eventId, second);
      expect(await t.entry(eventId, waiting)).toMatchObject({ state: 'waiting' });
      const holder = holders[round];
      const [freed, cancelled] = await Promise.all([
        holder.buyer.cancel(eventId, holder.admission, first),
        sleep(delayMs).then(() => next.cancel(eventId, waiting, second)),
      ]);
      expect(freed.status).toBe(200);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body!.admission.state).toBe('cancelled');
      const entry = (await t.entry(eventId, waiting))!;
      expect(entry).toMatchObject({ state: 'cancelled', reason: 'ADMISSION_CANCELLED' });
      // Whichever came first, the cancelled entry buys nothing.
      const late = await next.reserve(eventId, waiting, 1, [first]);
      expect(late.final).toMatchObject({ status: 410, code: 'ADMISSION_CANCELLED' });
      t.note('M3 cancel against promotion', { round, delayMs, promotedBeforeCancel: entry.admittedAt != null });
    }
    expect(await t.seats(eventId)).toEqual(before);

    // Second half: an admitted user's purchase arrives at one instance and its cancel at the
    // other, the cancel a few milliseconds later each round: before or after the claim.
    const tally = { bought: 0, cancelled: 0 };
    for (const [round, cancelAfterMs] of [0, 4, 8, 12, 18, 30].entries()) {
      const { buyer, admission } = await admitted(eventId, round % 2 ? first : second);
      const seatsBefore = await t.seats(eventId);
      const [purchase, cancel] = await Promise.all([
        buyer.reserve(eventId, admission, 1, [first]),
        sleep(cancelAfterMs).then(() => buyer.cancel(eventId, admission, second)),
      ]);
      const seatsAfter = await t.seats(eventId);
      if (purchase.final.status === 201) {
        // The claim won: the cancel is refused and the purchase is the one result.
        expect(cancel.status).toBe(409);
        expect(['ADMISSION_IN_PROGRESS', 'ADMISSION_ALREADY_CONSUMED']).toContain(cancel.code);
        expect(seatsAfter).toMatchObject({ available: seatsBefore.available - 1, results: seatsBefore.results + 1 });
        expect(await resultOf(eventId, admission)).toMatchObject({ outcome: 'consumed', reservationId: purchase.final.body!.id });
        tally.bought += 1;
      } else {
        // The cancel won: nothing is occupied and nothing is recorded.
        expect(cancel.status).toBe(200);
        expect(cancel.body!.admission.state).toBe('cancelled');
        expect(purchase.final).toMatchObject({ status: 410, code: 'ADMISSION_CANCELLED' });
        expect(seatsAfter).toEqual(seatsBefore);
        expect(await resultOf(eventId, admission)).toBeUndefined();
        tally.cancelled += 1;
      }
      t.note('M3 cancel against claim', { round, cancelAfterMs, purchase: brief(purchase.final), cancel: brief(cancel) });
    }
    t.note('M3', tally);
    await t.quiet(eventId);
    await t.verify();
  });

  it('M4 the 30 s admission ends while the purchase arrives: bought before the end, expired after it, never both', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const before = await t.seats(eventId);
    const buyers = [];
    for (const [index, offsetMs] of [-600, -300, -100, -30, 0, 30, 100, 300].entries()) {
      const { buyer, admission } = await admitted(eventId, index % 2 ? first : second);
      buyers.push({ buyer, admission, offsetMs, app: index % 2 ? second : first });
    }
    // Redis' clock decides the expiry, so the purchases are timed on it. Real time: every buyer
    // waits for the end of its own 30 s and sends its purchase that many milliseconds around it.
    const skew = Date.now() - (await t.redisNow());
    const outcomes = await Promise.all(
      buyers.map(async ({ buyer, admission, offsetMs, app }) => {
        const expiresAt: number = (await t.entry(eventId, admission))!.expiresAt;
        await sleep(Math.max(0, expiresAt + offsetMs + skew - Date.now()));
        return { admission, offsetMs, purchase: await buyer.reserve(eventId, admission, 1, [app]) };
      }),
    );
    for (const { admission, offsetMs, purchase } of outcomes) {
      const answer = purchase.final;
      const result = await resultOf(eventId, admission);
      if (answer.status === 201) {
        expect(result).toMatchObject({ outcome: 'consumed', reservationId: answer.body!.id });
      } else {
        // An expired admission occupies nothing and leaves no ledger row.
        expect(answer).toMatchObject({ status: 410, code: 'ADMISSION_EXPIRED' });
        expect(result).toBeUndefined();
        expect(await t.entry(eventId, admission)).toMatchObject({ state: 'expired', reason: 'ADMISSION_EXPIRED' });
      }
      // Well before the end it buys, unless its first answer was a transient 503; after it, never.
      if (offsetMs <= -300 && purchase.attempts.length === 1) expect(answer.status).toBe(201);
      if (offsetMs >= 100) expect(answer.status).toBe(410);
    }
    const bought = outcomes.filter((outcome) => outcome.purchase.final.status === 201).length;
    expect(await t.seats(eventId)).toMatchObject({ available: before.available - bought, results: before.results + bought });
    t.note('M4', {
      outcomes: outcomes.map((o) => ({ offsetMs: o.offsetMs, ...brief(o.purchase.final), attempts: o.purchase.attempts.length })),
    });
    await t.quiet(eventId);
    await t.verify();
  });

  it('K1 killed inside the purchase transaction: the same request on another instance buys once', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, second);
    const before = await t.seats(eventId);
    const remove = await t.slow('reservations', buyer.userId, 4);
    try {
      const lost = send(buyer, first, body);
      await t.sleeping('%INSERT INTO reservations%');
      await t.appFaults.kill(first);
      expect(await t.appFaults.exited(first)).toBe(137);
      expect((await lost).status).toBe(0);
      // The claim outlives the process: Redis still holds the entry as a claim in progress.
      expect(await t.entry(eventId, admission)).toMatchObject({ state: 'admitted', phase: 'processing' });
      // Within the claim deadline the same request resumes the same claim on another instance.
      // PostgreSQL still runs the dead process's statement and holds its admission lock for a
      // few seconds: until then the request is told that it is in progress.
      const retry = await buyer.reserve(eventId, admission, 1, [second]);
      t.note('K1 the same request on the other instance', { attempts: retry.attempts.map(brief) });
      expect(retry.attempts.some((attempt) => attempt.status === 409 && attempt.code === 'ADMISSION_IN_PROGRESS')).toBe(true);
      expect(retry.final.status).toBe(201);
      const after = await t.seats(eventId);
      expect(after).toMatchObject({ available: before.available - 1, reservations: before.reservations + 1 });
      expect(await resultOf(eventId, admission)).toMatchObject({ outcome: 'consumed', reservationId: retry.final.body!.id });
    } finally {
      await remove();
      await t.appFaults.start(first);
    }
    await t.quiet(eventId);
    await t.verify();
  });

  it('K2 killed and never retried: after the real 15 s deadline the claim is closed and the late request gets 410', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, second);
    const before = await t.seats(eventId);
    const remove = await t.slow('reservations', buyer.userId, 4);
    try {
      const lost = send(buyer, first, body);
      await t.sleeping('%INSERT INTO reservations%');
      const deadline: number = (await t.entry(eventId, admission))!.deadline;
      await t.appFaults.kill(first);
      expect((await lost).status).toBe(0);
      await remove();
      // Real time: nothing is closed before the deadline; after it the surviving reclaimer closes.
      const closed = await until(() => resultOf(eventId, admission), 40000, 'the abandoned claim to be closed', 500);
      expect(closed).toMatchObject({ outcome: 'closed', errorCode: 'ADMISSION_EXPIRED', reservationId: null });
      expect(new Date(closed.committedAt).getTime()).toBeGreaterThanOrEqual(deadline);
      t.note('K2 closed', { afterDeadlineMs: new Date(closed.committedAt).getTime() - deadline });
      await until(async () => (await t.entry(eventId, admission))?.state === 'expired', 10000, 'the slot to be returned');
      expect(await t.slots(eventId)).toBe(0);
      // The writer that comes back late reads the closed result and occupies nothing.
      const late = await buyer.reserve(eventId, admission, 1, [second]);
      expect(late.final).toMatchObject({ status: 410, code: 'ADMISSION_EXPIRED' });
      expect(await t.seats(eventId)).toMatchObject({ available: before.available, reservations: before.reservations });
    } finally {
      await remove();
      await t.appFaults.start(first);
    }
    await t.verify();
  });

  it('K3 death after COMMIT and before the answer: the same request replays, the slot returns once after the deadline', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, second);
    const before = await t.seats(eventId);
    const remove = await t.slow('reservations', buyer.userId, 2);
    let committed;
    try {
      const lost = send(buyer, first, body);
      await t.sleeping('%INSERT INTO reservations%');
      // Redis stops answering, so the instance commits and then waits to tell Redis.
      await t.redisFaults.pause();
      try {
        committed = await until(() => resultOf(eventId, admission), 15000, 'the purchase to commit', 50);
        const beforeKill = await t.pgNow();
        await t.appFaults.kill(first);
        expect((await lost).status).toBe(0);
        // The process died after its commit and before any answer.
        expect(new Date(committed.committedAt).getTime()).toBeLessThan(beforeKill.getTime());
      } finally {
        await t.redisFaults.unpause();
      }
      expect(committed).toMatchObject({ outcome: 'consumed' });
      // Redis never heard of the result: the entry is still a claim and holds its slot.
      expect(await t.entry(eventId, admission)).toMatchObject({ state: 'admitted', phase: 'processing' });
      expect(await t.slots(eventId)).toBe(1);
      // The buyer cannot tell this from a failure before the commit and sends the same request.
      const replay = await buyer.reserve(eventId, admission, 1, [second]);
      expect(replay.final.status).toBe(201);
      expect(replay.final.body!.id).toBe(committed.reservationId);
      expect(await t.seats(eventId)).toMatchObject({ available: before.available - 1, reservations: before.reservations + 1 });
      // Real time: after the 15 s deadline a reclaimer reflects the committed result.
      const deadline: number = (await t.entry(eventId, admission))!.deadline;
      await until(async () => (await t.entry(eventId, admission))?.state === 'consumed', 40000, 'the reclaimer to reflect the result', 500);
      expect(await t.redisNow()).toBeGreaterThanOrEqual(deadline);
      expect((await t.entry(eventId, admission))!.outcome).toMatchObject({ kind: 'reservation', resourceId: committed.reservationId });
    } finally {
      await remove();
      await t.appFaults.start(first);
    }
    await t.quiet(eventId);
    await t.verify();
  });

  it('K4 stalled across the idle bound and the claim deadline: not reclaimed while the lock is held, then closed, and the late writer commits nothing', async () => {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, second);
    const before = await t.seats(eventId);
    // Two held statements keep the transaction alive past the first seconds of the claim.
    const removeFirst = await t.slow('reservations', buyer.userId, 4);
    const removeSecond = await t.slow('admission_results', buyer.userId, 4);
    let answer: Answer;
    try {
      const stalled = send(buyer, first, body, 90000);
      await t.sleeping('%INSERT INTO admission_results%');
      const [{ pid }] = await t.backends('%INSERT INTO admission_results%');
      const deadline: number = (await t.entry(eventId, admission))!.deadline;
      // The instance freezes: when the statement ends, its session sits idle inside the transaction.
      await t.appFaults.pause(first);
      try {
        // Real time: the claim deadline passes while PostgreSQL still holds the admission lock.
        await until(async () => (await t.redisNow()) > deadline + 1500, 40000, 'the claim deadline to pass', 250);
        expect(await t.session(pid)).toBe('idle in transaction');
        expect(await resultOf(eventId, admission)).toBeUndefined();
        expect(await t.entry(eventId, admission)).toMatchObject({ state: 'admitted', phase: 'reconciling' });
        expect(await t.slots(eventId)).toBe(1);
        // idle_in_transaction_session_timeout fires by its own timer and PostgreSQL ends the session.
        await until(async () => (await t.session(pid)) === null, 30000, 'PostgreSQL to end the idle session', 250);
        expect(await t.pgLog()).toContain('terminating connection due to idle-in-transaction timeout');
        // Only now the reclaimer can decide: it closes the claim and returns the slot.
        const closed = await until(() => resultOf(eventId, admission), 20000, 'the claim to be closed', 250);
        expect(closed).toMatchObject({ outcome: 'closed', errorCode: 'ADMISSION_EXPIRED' });
      } finally {
        await t.appFaults.unpause(first);
      }
      // The writer resumes after it was closed: its commit fails and it answers the outage.
      answer = await stalled;
    } finally {
      await removeFirst();
      await removeSecond();
    }
    t.note('K4 the resumed writer', brief(answer));
    expect(answer).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
    expect(await t.seats(eventId)).toMatchObject({ available: before.available, reservations: before.reservations });
    expect((await buyer.reserve(eventId, admission, 1, [first])).final).toMatchObject({ status: 410, code: 'ADMISSION_EXPIRED' });
    // The instance survived the session PostgreSQL ended under it.
    expect((await t.http(first, 'GET', '/ready')).status).toBe(200);
    await t.quiet(eventId);
    await t.verify();
  });

  /** K5: SIGTERM while a purchase is inside its transaction. Returns the seconds until the exit. */
  async function gracefulStop(closing: boolean) {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, second);
    const remove = await t.slow('reservations', buyer.userId, 3);
    let seconds: number;
    try {
      const inflight = t.http(first, 'POST', '/reservations', {
        token: buyer.token, body, timeoutMs: 30000, user: buyer.userId, closing,
      });
      await t.sleeping('%INSERT INTO reservations%');
      const signalled = Date.now();
      await t.appFaults.kill(first, 'TERM');
      // The request in flight is answered although the instance is shutting down.
      const answer = await inflight;
      expect(answer.status).toBe(201);
      // Nothing more is sent to the instance: it leaves on its own.
      const code = await t.appFaults.exited(first, 150000);
      seconds = (Date.now() - signalled) / 1000;
      t.note(closing ? 'K5 client that closes its connection' : 'K5b keep-alive client', {
        answer: brief(answer), exitCode: code, secondsToExit: Math.round(seconds * 10) / 10,
      });
      expect(code).toBe(0);
      // Redis is fenced first, the HTTP server drains, PostgreSQL closes last.
      const log = await t.appFaults.logs(first);
      const steps = [
        'SIGTERM 수신, 종료 절차 시작',
        'Admission result is committed; Redis finalization is left to the reclaimer',
        'HTTP 서버 종료',
        'PostgreSQL 연결 종료',
        '종료 절차 완료',
      ].map((line) => log.lastIndexOf(line));
      expect(steps.every((at) => at >= 0)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(await resultOf(eventId, admission)).toMatchObject({ outcome: 'consumed', reservationId: answer.body!.id });
      // The result could not be told to Redis; the other instance's reclaimer reflects it.
      await until(async () => (await t.entry(eventId, admission))?.state === 'consumed', 40000, 'the reclaimer to reflect the result', 500);
    } finally {
      await remove();
      await t.appFaults.start(first);
    }
    await t.quiet(eventId);
    await t.verify();
    return seconds;
  }
  it('K5 SIGTERM with a purchase in flight, client closes its connection: answered, exit 0 within seconds, the slot returns', async () => {
    expect(await gracefulStop(true)).toBeLessThan(15);
  });
  it('K5b the same with a keep-alive client: answered and exit 0; the time until the exit is recorded', async () => {
    await gracefulStop(false);
  });

  it('T1 statement_timeout fires by its own timer: 503, nothing committed, the same request then succeeds', async () => {
    const eventId = await event(20);
    const [first] = t.apps;
    const { buyer, admission, body } = await admitted(eventId, first);
    const before = await t.seats(eventId);
    // Synthetic stimulus: the INSERT sleeps for 6 s. The 5 s bound that ends it is PostgreSQL's.
    const remove = await t.slow('reservations', buyer.userId, 6);
    try {
      const answer = await send(buyer, first, body);
      t.note('T1', brief(answer));
      expect(answer).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
      expect(answer.ms).toBeGreaterThanOrEqual(4900);
      expect(answer.ms).toBeLessThan(5900);
      expect(await t.pgLog()).toContain('canceling statement due to statement timeout');
      expect(await resultOf(eventId, admission)).toBeUndefined();
      expect(await t.seats(eventId)).toMatchObject({ available: before.available, reservations: before.reservations });
      expect(await t.entry(eventId, admission)).toMatchObject({ state: 'admitted', phase: 'processing' });
    } finally {
      await remove();
    }
    // The claim was kept, so the same request finishes inside its deadline.
    expect((await buyer.reserve(eventId, admission, 1, [first])).final.status).toBe(201);
    await t.quiet(eventId);
    await t.verify();
  });

  /** T2: PostgreSQL goes away with a purchase inside its transaction, and comes back. */
  async function databaseLoss(kind: 'restart' | 'crash') {
    const eventId = await event(20);
    const [first, second] = t.apps;
    const buyers = [await admitted(eventId, first), await admitted(eventId, second), await admitted(eventId, first)];
    const startedAt = await Promise.all(t.apps.map((app) => t.appFaults.startedAt(app)));
    const remove = await t.slow('reservations', buyers[0].buyer.userId, 3);
    try {
      const inflight = send(buyers[0].buyer, first, buyers[0].body);
      await t.sleeping('%INSERT INTO reservations%');
      // While PostgreSQL is away the queue still answers: status needs Redis only.
      const [, during] = await Promise.all([
        t.pgFaults[kind](),
        Promise.all([buyers[1].buyer.status(eventId, second), send(buyers[1].buyer, second, buyers[1].body)]),
      ]);
      const answer = await inflight;
      t.note(`T2 ${kind}`, { inflight: brief(answer), status: brief(during[0]), purchase: brief(during[1]) });
      // An outage is answered 503 and the request keeps its identity (contract §3, §5).
      expect(answer).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
      expect(during[0].status).toBe(200);
      expect([201, 503]).toContain(during[1].status);
    } finally {
      await remove();
    }
    // The same requests, repeated, land exactly once each.
    const finals = await Promise.all(buyers.map(({ buyer, admission }) => buyer.reserve(eventId, admission, 1, [first, second])));
    expect(finals.map((purchase) => purchase.final.status)).toEqual([201, 201, 201]);
    expect(new Set(finals.map((purchase) => purchase.final.body!.id)).size).toBe(3);
    expect(await t.seats(eventId)).toMatchObject({ available: 17, reservations: 3, results: 3 });
    // Neither instance restarted: the ended sessions did not end the processes.
    expect(await Promise.all(t.apps.map((app) => t.appFaults.startedAt(app)))).toEqual(startedAt);
    await Promise.all(t.apps.map((app) => t.ready(app)));
    await t.quiet(eventId);
    await t.verify();
  }
  it('T2 PostgreSQL restarts with a purchase in flight: 503 with the same identity, the instances survive, every purchase lands once', () =>
    databaseLoss('restart'));
  it('T2b PostgreSQL is killed and started again with a purchase in flight: the same', () => databaseLoss('crash'));

  it('T3 eight admitted buyers at the same moment: serialization retries may run out, and every 503 converges', async () => {
    const eventId = await event(40);
    const [first, second] = t.apps;
    const buyers = [];
    for (let i = 0; i < 8; i++) {
      const buyer = await t.buyer();
      buyers.push({ buyer, admission: await buyer.queue(eventId, i % 2 ? first : second), app: i % 2 ? first : second });
    }
    await Promise.all(buyers.map(({ buyer, app }) => buyer.admitted(eventId, 60000, app)));
    expect(await t.slots(eventId)).toBe(8);
    const answers = await Promise.all(
      buyers.map(({ buyer, admission, app }) => send(buyer, app, buyer.reservationBody(eventId, admission, 1))),
    );
    const seen: Record<string, number> = {};
    for (const answer of answers) seen[`${answer.status} ${answer.code ?? ''}`.trim()] = (seen[`${answer.status} ${answer.code ?? ''}`.trim()] ?? 0) + 1;
    // An observation of one local run, not a rate.
    t.note('T3 first answers of eight simultaneous purchases', seen);
    expect(Object.keys(seen).filter((answer) => answer !== '201' && answer !== '503 ADMISSION_UNAVAILABLE')).toEqual([]);
    // A 503 left nothing behind: exactly the answered purchases exist.
    expect((await t.seats(eventId)).reservations).toBe(seen['201'] ?? 0);
    const finals = await Promise.all(buyers.map(({ buyer, admission, app }) => buyer.reserve(eventId, admission, 1, [app])));
    expect(finals.map((purchase) => purchase.final.status)).toEqual(Array(8).fill(201));
    expect(new Set(finals.map((purchase) => purchase.final.body!.id)).size).toBe(8);
    expect(await t.seats(eventId)).toMatchObject({ available: 32, reservations: 8, results: 8 });
    await t.quiet(eventId);
    await t.verify();
  });
});
