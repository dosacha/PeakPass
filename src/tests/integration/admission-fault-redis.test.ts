import { randomUUID } from 'crypto';
import {
  faultSuite,
  startTopology,
  Topology,
  Buyer,
  AdmissionRef,
  AppBox,
  Answer,
  sleep,
  until,
  TIER,
} from './admission-fault-fixture';

/**
 * P7, contract scenarios A10 and A11: a real Redis that is paused, stopped, started again or
 * emptied while buyers are attached, and coordinators killed at the stages of the reset.
 *
 * Opt-in: ADMISSION_FAULT_IMAGE names the production image under test. The Redis, the PostgreSQL
 * and the application containers that are paused, stopped or killed here are the fixture's own.
 */
jest.setTimeout(420000);

faultSuite('admission under real Redis failures (real containers)', () => {
  let t: Topology;
  let previous: string | null = null;
  beforeAll(async () => {
    t = await startTopology({ apps: [{ admission: true }, { admission: true }] });
  });
  afterAll(async () => {
    await t?.destroy('redis');
  });

  /** One protected event per database: the event of the scenario before is released first. */
  async function event(seats = 30) {
    if (previous) await t.release(previous);
    await t.begin(expect.getState().currentTestName ?? 'scenario');
    previous = await t.event(seats);
    return previous;
  }
  const brief = (answer: Answer) => ({ status: answer.status, code: answer.code, ms: answer.ms });
  /**
   * A purchase held inside its transaction, after its claim. Synthetic stimulus: a trigger makes
   * this buyer's reservation INSERT sleep. Returns once PostgreSQL shows the statement sleeping.
   */
  async function held(buyer: Buyer, eventId: string, admission: AdmissionRef, app: AppBox, seconds: number) {
    const remove = await t.slow('reservations', buyer.userId, seconds);
    const answer = buyer.call(app, 'POST', '/reservations', buyer.reservationBody(eventId, admission, 1), undefined, 30000);
    try {
      await until(
        async () => (await t.backends('%INSERT INTO reservations%')).some((b) => b.wait_event === 'PgSleep'),
        10000,
        'the purchase to reach its held statement',
        50,
      );
    } catch (error) {
      await remove();
      throw error;
    }
    return { answer, remove };
  }
  const existingCheckout = (buyer: Buyer, app: AppBox, eventId: string, reservationId: string, key: string) =>
    buyer.call(app, 'POST', '/checkouts', { eventId, userId: buyer.userId, quantity: 1, tierId: TIER, reservationId }, key);

  it('R1 pause and unpause: each path answers the outage its own way, nothing is reset, the queue is kept', async () => {
    const eventId = await event();
    const [first, second] = t.apps;
    const done = await t.buyer();
    const doneBody = done.reservationBody(eventId, await done.enter(eventId), 1);
    const reserved = await done.call(first, 'POST', '/reservations', doneBody);
    expect(reserved.status).toBe(201);
    const checkoutKey = randomUUID();

    const writer = await t.buyer();
    const writerAdmission = await writer.enter(eventId);
    // Seven more admitted users fill the capacity, so the two who join next stay waiting.
    const fillers: Array<{ buyer: Buyer; admission: AdmissionRef }> = [];
    for (let i = 0; i < 7; i++) {
      const buyer = await t.buyer();
      fillers.push({ buyer, admission: await buyer.queue(eventId) });
    }
    await Promise.all(fillers.map((filler) => filler.buyer.admitted(eventId)));
    expect(await t.slots(eventId)).toBe(8);
    const waiting: Array<{ buyer: Buyer; admission: AdmissionRef }> = [];
    for (let i = 0; i < 2; i++) {
      const buyer = await t.buyer();
      waiting.push({ buyer, admission: await buyer.queue(eventId, second) });
    }
    const newcomer = await t.buyer();
    const last = fillers[6];
    const before = { policy: await t.policy(eventId), control: await t.control(eventId) };

    const hold = await held(writer, eventId, writerAdmission, first, 3);
    const deadline: number = (await t.entry(eventId, writerAdmission))!.deadline;
    let writerAnswer: Answer;
    try {
      await t.redisFaults.pause();
      try {
        const [status, join, purchase, exempt, ready, health] = await Promise.all([
          waiting[0].buyer.status(eventId, first),
          newcomer.join(eventId, before.control!.epoch, randomUUID(), second),
          last.buyer.call(second, 'POST', '/reservations', last.buyer.reservationBody(eventId, last.admission, 1)),
          existingCheckout(done, first, eventId, reserved.body!.id, checkoutKey),
          t.http(second, 'GET', '/ready'),
          t.http(second, 'GET', '/health'),
        ]);
        t.note('R1 answers while Redis is paused', {
          status: brief(status), join: brief(join), purchase: brief(purchase), exempt: brief(exempt),
          ready: brief(ready), health: brief(health),
        });
        // New admission is closed by the admission service itself ...
        expect(status).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
        expect(join).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
        // ... while a purchase route, exempt or not, is stopped by the existing limiter first.
        expect(purchase).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
        expect(exempt).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
        expect(ready.status).toBe(503);
        expect(ready.body!.checks).toMatchObject({ postgres: true, redis: false });
        expect(health.status).toBe(200);
        // The purchase that was in flight commits in PostgreSQL although Redis cannot be told.
        await until(
          async () => (await t.results(eventId)).some((r) => r.admissionId === writerAdmission.admissionId),
          20000,
          'the purchase in flight to commit',
        );
        expect((await t.seats(eventId)).reservations).toBe(2);
      } finally {
        await t.redisFaults.unpause();
      }
      writerAnswer = await hold.answer;
    } finally {
      await hold.remove();
    }
    await Promise.all(t.apps.map((app) => t.ready(app)));
    expect(writerAnswer.status).toBe(201);

    // A stall is not a loss: the same generation, epoch and Redis process, and the same queue.
    expect(await t.policy(eventId)).toEqual(before.policy);
    expect(await t.control(eventId)).toEqual(before.control);
    for (const [index, entry] of waiting.entries()) {
      const answer = await until(async () => {
        const read = await entry.buyer.status(eventId, second);
        return read.status === 200 && read;
      }, 20000, 'the status API after the pause', 500);
      expect(answer.body!.admission).toMatchObject({
        admissionId: entry.admission.admissionId,
        state: 'waiting',
        position: index + 1,
      });
    }
    // An admission that sat idle through the pause is still good for its purchase.
    expect((await last.buyer.reserve(eventId, last.admission, 1)).final.status).toBe(201);
    // Exempt paths need no new admission: the replay, the existing reservation's checkout, settlement.
    const replay = await done.call(second, 'POST', '/reservations', doneBody);
    expect(replay.status).toBe(201);
    expect(replay.body!.id).toBe(reserved.body!.id);
    const checkout = await done.checkout(eventId, { reservationId: reserved.body!.id, key: checkoutKey });
    expect(checkout.final.status).toBe(201);
    const settled = await t.settle(first, checkout.final.body!.order.id);
    expect(settled.status).toBe(200);
    expect(settled.body!.order.status).toBe('paid');
    // The purchase that committed during the pause could not tell Redis: its finalization went
    // with the connection that the 5 s command bound gave up. Its slot stayed in use, which is why
    // the waiting users above kept their places, until a reclaimer reflects the result after the
    // claim deadline.
    await until(
      async () => (await t.entry(eventId, writerAdmission))?.state === 'consumed',
      40000,
      'the reclaimer to reflect the committed purchase',
      500,
    );
    expect(await t.redisNow()).toBeGreaterThanOrEqual(deadline);
    // The idle admissions expire after their 30 s; the two waiting users are admitted in order.
    for (const entry of waiting) {
      await entry.buyer.admitted(eventId, 60000, second);
      expect((await entry.buyer.reserve(eventId, entry.admission, 1)).final.status).toBe(201);
    }
    await t.quiet(eventId);
    const log = await t.verify();
    expect(log.controls.filter((c) => c.eventId === eventId).map((c) => c.mode)).toEqual(['initializing', 'ready']);
  });

  /** R2–R4: the Redis state is lost while buyers are attached. */
  async function loss(kind: 'stop' | 'restart' | 'flush') {
    const eventId = await event();
    const began = await t.redisNow();
    const [first, second] = t.apps;
    const done = await t.buyer();
    const doneBody = done.reservationBody(eventId, await done.enter(eventId), 1);
    const reserved = await done.call(first, 'POST', '/reservations', doneBody);
    expect(reserved.status).toBe(201);
    const idle = await t.buyer();
    const idleBody = idle.reservationBody(eventId, await idle.enter(eventId), 1);
    const writer = await t.buyer();
    const writerAdmission = await writer.enter(eventId);
    const writerBody = writer.reservationBody(eventId, writerAdmission, 1);
    const before = { policy: (await t.policy(eventId))!, control: (await t.control(eventId))! };

    const hold = await held(writer, eventId, writerAdmission, first, 3);
    let writerAnswer: Answer;
    try {
      if (kind === 'flush') {
        await t.redisFaults.flush();
        // Until the next epoch is published the old admission is refused, and never served.
        const seen = new Set<string>();
        await until(async () => {
          const answer = await idle.call(second, 'POST', '/reservations', idleBody);
          seen.add(`${answer.status} ${answer.code}`);
          return answer.status === 410;
        }, 30000, 'the old admission to be answered 410', 50);
        t.note('R4 answers to the old admission until the reset', { seen: [...seen] });
        const allowed = ['503 ADMISSION_RECOVERING', '503 ADMISSION_UNAVAILABLE', '410 ADMISSION_RESET'];
        expect([...seen].filter((answer) => !allowed.includes(answer))).toEqual([]);
      } else {
        await t.redisFaults.stop();
        if (kind === 'stop') {
          const [status, purchase, exempt, ready, health] = await Promise.all([
            idle.status(eventId, first),
            idle.call(second, 'POST', '/reservations', idleBody),
            existingCheckout(done, first, eventId, reserved.body!.id, randomUUID()),
            t.http(second, 'GET', '/ready'),
            t.http(second, 'GET', '/health'),
          ]);
          t.note('R2 answers while Redis is stopped', {
            status: brief(status), purchase: brief(purchase), exempt: brief(exempt), ready: brief(ready),
            health: brief(health),
          });
          expect(status).toMatchObject({ status: 503, code: 'ADMISSION_UNAVAILABLE' });
          expect(purchase).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
          expect(exempt).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
          expect(ready.status).toBe(503);
          expect(health.status).toBe(200);
          // Without Redis no coordinator moves the durable epoch.
          expect((await t.policy(eventId))!.generation).toBe(before.policy.generation);
        }
        await t.redisFaults.start();
      }
      writerAnswer = await hold.answer;
    } finally {
      await hold.remove();
    }
    // The writer of the old epoch held the gate before the reset and was allowed to finish.
    expect(writerAnswer.status).toBe(201);

    const published = () =>
      until(async () => {
        const [control, policy] = [await t.control(eventId), await t.policy(eventId)];
        return control?.mode === 'ready' && policy?.phase === 'open' && control.generation === policy.generation;
      }, 60000, 'the next epoch to be published', 200);
    await published();
    // Several scheduler ticks later the published epoch must still be the same one.
    await sleep(1500);
    await published();
    await Promise.all(t.apps.map((app) => t.ready(app)));
    const after = { policy: (await t.policy(eventId))!, control: (await t.control(eventId))! };
    // One loss costs one generation, although two coordinators saw it. Asserted at the end, so
    // that the rest of the scenario is still checked when this does not hold.
    const generations = Number(after.policy.generation) - Number(before.policy.generation);
    t.note(`${kind}: generations spent on one loss`, { generations });
    expect(after.policy.epoch).not.toBe(before.policy.epoch);
    expect(after.control).toMatchObject({ generation: after.policy.generation, epoch: after.policy.epoch });
    // The loss was the one the title names: another Redis process after a stop, the same after a flush.
    expect(after.control.runId === before.control.runId).toBe(kind === 'flush');

    // The old admission and the old epoch occupy nothing any more.
    const reservations = (await t.seats(eventId)).reservations;
    expect(await idle.call(first, 'POST', '/reservations', idleBody)).toMatchObject({ status: 410, code: 'ADMISSION_RESET' });
    expect(await idle.join(eventId, before.control.epoch, randomUUID(), second)).toMatchObject({
      status: 410,
      code: 'ADMISSION_RESET',
    });
    expect((await t.seats(eventId)).reservations).toBe(reservations);
    // The queue says that the place in line is gone: the new epoch, and no entry of this user.
    const lost = await idle.status(eventId, second);
    expect(lost.status).toBe(200);
    expect(lost.body).toMatchObject({ queue: { epoch: after.policy.epoch }, admission: null });

    // Durable results are replayed whatever became of their epoch, and exempt paths go on.
    const replays: Array<[Buyer, unknown, Answer]> = [
      [done, doneBody, reserved],
      [writer, writerBody, writerAnswer],
    ];
    for (const [buyer, body, original] of replays) {
      const replay = await buyer.call(second, 'POST', '/reservations', body);
      expect(replay.status).toBe(201);
      expect(replay.body!.id).toBe(original.body!.id);
    }
    const checkout = await done.checkout(eventId, { reservationId: reserved.body!.id });
    expect(checkout.final.status).toBe(201);
    const settled = await t.settle(first, checkout.final.body!.order.id);
    expect(settled.status).toBe(200);
    expect(settled.body!.order.status).toBe('paid');

    // No result of the old epoch committed once the reset had the exclusive gate.
    const late = await t.pool.query(
      `SELECT r.admission_id FROM admission_results r JOIN admission_events p ON p.event_id = r.event_id
      WHERE r.event_id = $1 AND r.epoch <> p.epoch AND pg_xact_commit_timestamp(r.xmin) >= p.epoch_started_at`,
      [eventId],
    );
    expect(late.rows).toEqual([]);
    // The next epoch was opened only after the writer of the old one had committed.
    const opened = (await t.transitions()).controls.find(
      (c) => c.eventId === eventId && Number(c.generation) > Number(before.policy.generation) && c.mode === 'ready',
    )!;
    const written = (await t.results(eventId)).find((r) => r.admissionId === writerAdmission.admissionId)!;
    expect(written.outcome).toBe('consumed');
    expect(opened.time).toBeGreaterThan(new Date(written.committedAt).getTime());

    // An explicit new registration is admitted in the new epoch and buys once.
    const again = await idle.enter(eventId);
    expect(again.admissionEpoch).toBe(after.policy.epoch);
    expect((await idle.reserve(eventId, again, 1)).final.status).toBe(201);
    await t.quiet(eventId);
    // Everything else is checked first, so that it is still asserted when the next line fails.
    const log = await t.verify([], ['run-id']);
    // One loss costs one generation, and no namespace is initialized under the run id of the
    // Redis process that is gone.
    const stale = log.violations.filter((violation) => violation.rule === 'run-id' && violation.time >= began);
    expect({ generations, initializedUnderAnOldRunId: stale.length }).toEqual({
      generations: 1,
      initializedUnderAnOldRunId: 0,
    });
  }

  it('R2 stop and start: the state is lost, one new generation, old admissions end, durable results stay', () =>
    loss('stop'));
  it('R3 restart: the same with no outage to speak of', () => loss('restart'));
  it('R4 FLUSHALL: an empty Redis of the same process is recovered the same way', () => loss('flush'));

  it('R5 a coordinator killed at each stage of the reset: another one finishes the same generation', async () => {
    const eventId = await event();
    const [first, second] = t.apps;
    const visitor = await t.buyer();
    const before = (await t.policy(eventId))!;
    const next = String(Number(before.generation) + 1);
    const bothWait = () =>
      until(async () => new Set((await t.gateWaiters()).map((app) => app.index)).size === 2, 30000,
        'both coordinators to wait at the gate', 100);

    // Synthetic stimulus: this session holds what a consumer holds, so every coordinator stops
    // before each of the three transactions of the reset. The kills are real.
    let gate = t.holdGate(eventId);
    await gate.granted;
    let staged = false;
    try {
      // The coordinator that did not publish this event may still be finishing that recovery.
      // What waits for the gate before the loss belongs to it and is let through first, so that
      // every transaction counted below is one of the recovery from the loss.
      for (let quiet = 0; quiet < 3; ) {
        await sleep(150);
        if ((await t.gateWaiters()).length) {
          gate = await t.passGate(eventId, gate);
          quiet = 0;
        } else quiet += 1;
      }
      await t.redisFaults.flush();
      // Stage 1: the loss is seen, nothing is durable yet.
      await bothWait();
      expect(await t.policy(eventId)).toMatchObject({ generation: before.generation, phase: 'open' });
      expect(await t.control(eventId)).toBeNull();
      const cold = await visitor.call(second, 'GET', `/events/${eventId}/admissions/me`, undefined, undefined, 2000);
      expect(cold.status).not.toBe(200);
      await t.appFaults.kill(first);
      gate = await t.passGate(eventId, gate);

      // Stage 2: the next generation is durable and recovering; Redis is still empty.
      expect(await t.policy(eventId)).toMatchObject({ generation: next, phase: 'recovering' });
      expect(await t.control(eventId)).toBeNull();
      await t.appFaults.start(first);
      await bothWait();
      await t.appFaults.kill(second);
      gate = await t.passGate(eventId, gate);
      // The restarted coordinator adopted the generation it found instead of advancing again.
      expect(await t.policy(eventId)).toMatchObject({ generation: next, phase: 'recovering' });
      gate = await t.passGate(eventId, gate);

      // Stage 3: initialized and open in PostgreSQL, not yet published.
      expect(await t.policy(eventId)).toMatchObject({ generation: next, phase: 'open' });
      expect(await t.control(eventId)).toMatchObject({ generation: next, mode: 'initializing' });
      const partial = await visitor.status(eventId, first);
      expect(partial).toMatchObject({ status: 503, code: 'ADMISSION_RECOVERING' });
      await t.appFaults.start(second);
      await bothWait();
      await t.appFaults.kill(first);
      staged = true;
    } finally {
      await gate.release();
      // A scenario that stopped half-way leaves no coordinator dead for the next one.
      if (!staged) for (const app of t.apps) await t.appFaults.start(app).catch(() => undefined);
    }
    await until(async () => (await t.control(eventId))?.mode === 'ready', 60000, 'the publication', 200);
    await t.appFaults.start(first);
    // Three coordinators died at three stages; the loss still cost exactly one generation.
    expect(await t.policy(eventId)).toMatchObject({ generation: next, phase: 'open' });
    expect(await t.control(eventId)).toMatchObject({ generation: next, mode: 'ready' });
    const admission = await visitor.enter(eventId);
    expect((await visitor.reserve(eventId, admission, 1)).final.status).toBe(201);
    await t.quiet(eventId);
    const log = await t.verify();
    expect(log.controls.filter((c) => c.eventId === eventId).map((c) => `${c.generation} ${c.mode}`)).toEqual([
      `${before.generation} initializing`,
      `${before.generation} ready`,
      `${next} initializing`,
      `${next} ready`,
    ]);
  });

  it('R6 repeated loss while a coordinator is paused at random: one generation per loss', async () => {
    const eventId = await event();
    let generation = Number((await t.policy(eventId))!.generation);
    for (let round = 0; round < 3; round++) {
      const victim = t.apps[round % 2];
      const [delay, pause] = [Math.floor(Math.random() * 400), 500 + Math.floor(Math.random() * 2500)];
      await t.redisFaults.flush();
      await sleep(delay);
      await t.appFaults.pause(victim);
      await sleep(pause);
      await t.appFaults.unpause(victim);
      await until(async () => {
        const [control, policy] = [await t.control(eventId), await t.policy(eventId)];
        return control?.mode === 'ready' && policy?.phase === 'open' && control.generation === policy.generation;
      }, 60000, 'the epoch after the loss', 200);
      // Whatever the paused coordinator still had in hand has run by now.
      await sleep(2000);
      generation += 1;
      t.note('R6 round', { round, victim: victim.index + 1, delay, pause, generation: (await t.policy(eventId))!.generation });
      expect(await t.policy(eventId)).toMatchObject({ generation: String(generation), phase: 'open' });
      expect(await t.control(eventId)).toMatchObject({ generation: String(generation), mode: 'ready' });
    }
    const buyer = await t.buyer();
    const admission = await buyer.enter(eventId);
    expect((await buyer.reserve(eventId, admission, 1)).final.status).toBe(201);
    await t.quiet(eventId);
    await t.verify();
  });
});
