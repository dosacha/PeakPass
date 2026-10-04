import { randomUUID } from 'crypto';
import {
  faultSuite,
  startTopology,
  Topology,
  Answer,
  AdmissionRef,
  until,
} from './admission-fault-fixture';

/**
 * P7: several application processes, real process failures and the real timers of admission-v1
 * (claim deadline 15 s, admission TTL 30 s, the transaction bounds of contract §5).
 *
 * Opt-in: ADMISSION_FAULT_IMAGE names the production image under test. Everything this file
 * stops, pauses or kills is a container the fixture created.
 */
jest.setTimeout(300000);

faultSuite('admission across application processes and process failures (real containers)', () => {
  let t: Topology;
  beforeAll(async () => {
    // Two instances run a scheduler; the third has the feature off and must never open the event.
    t = await startTopology({ apps: [{ admission: true }, { admission: true }, { admission: false }] });
  });
  afterAll(async () => {
    await t?.destroy('process');
  });

  /** The two checks every scenario ends with: the final SQL and the complete transition log. */
  async function verify() {
    expect(await t.violations()).toEqual([]);
    const log = await t.transitions();
    expect(log.incomplete).toEqual([]);
    expect(log.violations).toEqual([]);
    return log;
  }
  const quiet = (eventId: string, timeoutMs = 60000) =>
    until(async () => (await t.slots(eventId)) === 0, timeoutMs, 'every slot to be returned', 500);

  it('M1 buyers on three instances: two schedulers, one instance with the feature off', async () => {
    const eventId = await t.event(16);
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
    await quiet(eventId, 90000);
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

    const log = await verify();
    // Every entry that was admitted is in the log once: 18 purchasers and the two that abandoned.
    expect(log.promotions).toBe(20);
    // The log counts because it began on an empty keyspace. A capture that begins now says so.
    expect(await t.lateCapture()).toEqual([expect.stringMatching(/capture began with \d+ admission keys present/)]);
    t.note('M1', { buyers: buyers.length, bought: bought.length, soldOut: soldOut.length, promotions: log.promotions,
      viaOff: viaOff.length, seats });
  });
});
