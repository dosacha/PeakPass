import { readFileSync } from 'fs';
import vm from 'vm';

/**
 * Runnable polling state check of the P6 frontend (admission-v1 §7, A14/A15).
 *
 * The frontend has no build step: `frontend/admission-polling.js` is a plain script that
 * index.html loads next to React. It is loaded here the same way, as a script in a fresh
 * context, with clock, timers, transport, visibility and storage injected. Nothing in this
 * file is real HTTP, a real browser or real time.
 */
type Mode = 'fixed' | 'adaptive';

interface Api {
  successDelay(input: { mode: Mode; hidden: boolean; baseMs: unknown; u: number }): number;
  failureDelay(input: {
    failures: number;
    hidden: boolean;
    serverMinMs: unknown;
    retryAfterMs: unknown;
    u: number;
  }): number;
  parseRetryAfter(value: unknown): number | null;
  createController(options: Record<string, unknown>): Controller;
}

interface Snapshot {
  admissionId: string;
  epoch: string;
  state: string;
  phase: string;
  sequence: string;
  position: number | null;
  joinedAt: string;
  admittedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  outcome: unknown;
}

interface View {
  phase: string;
  problem: { kind: string; code: string | null; retryAt: number | null } | null;
  notice: string | null;
  admission: Snapshot | null;
  epoch: string | null;
  mode: Mode;
  busy: string | null;
  purchase: { status: string; attempts: number; restored: boolean } | null;
  deadlineAt: number | null;
  polls: number;
}

interface Controller {
  start(): void;
  join(): boolean;
  cancel(): boolean;
  purchase(body: Record<string, unknown>): boolean;
  retryPurchase(): boolean;
  setMode(mode: Mode): void;
  view(): View;
  dispose(): void;
}

interface Reply {
  status: number;
  data?: unknown;
  retryAfterMs?: number | null;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
  signal: AbortSignal;
  at: number;
}

function load(): Api {
  const context = vm.createContext({});
  vm.runInContext(readFileSync('frontend/admission-polling.js', 'utf8'), context, {
    filename: 'frontend/admission-polling.js',
  });
  return (context as unknown as { PeakPassAdmission: Api }).PeakPassAdmission;
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EPOCH_1 = '11111111-1111-4111-8111-111111111111';
const EPOCH_2 = '22222222-2222-4222-8222-222222222222';
const ADMISSION_A = 'a0000000-0000-4000-8000-000000000001';
const ADMISSION_B = 'b0000000-0000-4000-8000-000000000002';
const STATUS_PATH = `/events/${EVENT}/admissions/me`;
// The fake server clock runs with the fake monotonic clock, from an arbitrary wall time.
const SERVER_T0 = Date.UTC(2026, 9, 3);
const iso = (ms: number) => new Date(ms).toISOString();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function entry(state: string, patch: Partial<Snapshot> = {}): Snapshot {
  return {
    admissionId: ADMISSION_A,
    epoch: EPOCH_1,
    state,
    phase: 'idle',
    sequence: '21',
    position: state === 'waiting' ? 21 : null,
    joinedAt: iso(SERVER_T0),
    admittedAt: null,
    expiresAt: null,
    reason: null,
    outcome: null,
    ...patch,
  };
}

const failure = (status: number, code: string, nextPollAfterMs: number | null = null): Reply => ({
  status,
  data: { error: { code, message: code }, nextPollAfterMs },
});

/** A fake clock, fake timers, a fake transport and a fake visibility source for one tab. */
function tab(api: Api, overrides: Record<string, unknown> = {}) {
  let now = 0;
  let timerSeq = 0;
  let keySeq = 0;
  let active = 0;
  let maxActive = 0;
  let hidden = false;
  let respond: (call: Call) => Reply | Promise<Reply> = () => ({ status: 0 });
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const calls: Call[] = [];
  const views: View[] = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const controller = api.createController({
    userId: USER_A,
    eventId: EVENT,
    mode: 'fixed',
    transport(request: Omit<Call, 'at'>) {
      const call: Call = { ...request, at: now };
      calls.push(call);
      active += 1;
      maxActive = Math.max(maxActive, active);
      let open = true;
      const leave = () => {
        if (open) active -= 1;
        open = false;
      };
      request.signal.addEventListener('abort', leave);
      return Promise.resolve(respond(call)).finally(leave);
    },
    onChange: (view: View) => views.push(view),
    now: () => now,
    setTimer(run: () => void, ms: number) {
      timers.set(++timerSeq, { at: now + ms, run });
      return timerSeq;
    },
    clearTimer: (id: number) => timers.delete(id),
    // 0.5 is the jitter draw u = 0, so every delay equals its base unless a test overrides it.
    random: () => 0.5,
    uuid: () => `join-key-${++keySeq}`,
    AbortController,
    visibility: {
      hidden: () => hidden,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ...overrides,
  });

  return {
    controller,
    calls,
    views,
    flush,
    now: () => now,
    times: () => calls.map((call) => call.at),
    maxActive: () => maxActive,
    onRequest(handler: (call: Call) => Reply | Promise<Reply>) {
      respond = handler;
    },
    /** The answer of the status API at the current fake time. */
    ok(admission: Snapshot | null, nextPollAfterMs: number | null, epoch = EPOCH_1): Reply {
      return {
        status: 200,
        data: {
          contractRevision: 'admission-v1',
          serverTime: iso(SERVER_T0 + now),
          queue: { eventId: EVENT, epoch, mode: 'open' },
          admission,
          nextPollAfterMs,
        },
      };
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
    /** Runs every timer that is due within `ms`, letting promises settle after each one. */
    async advance(ms: number) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
        await flush();
      }
      now = end;
    },
  };
}

describe('delay policy', () => {
  let api: Api;
  beforeAll(() => {
    api = load();
  });

  it('fixed mode waits 1000 ms whatever base the server sends', () => {
    for (const baseMs of [1000, 5000])
      for (const u of [-1, 0, 0.999])
        expect(api.successDelay({ mode: 'fixed', hidden: false, baseMs, u })).toBe(1000);
  });

  it('adaptive mode applies ±20% jitter to the server base and clamps to 1000–5000 ms', () => {
    const delay = (baseMs: unknown, u: number) =>
      api.successDelay({ mode: 'adaptive', hidden: false, baseMs, u });
    expect(delay(1000, -1)).toBe(1000);
    expect(delay(1000, 1)).toBe(1200);
    expect(delay(5000, -1)).toBe(4000);
    expect(delay(5000, 1)).toBe(5000);
    expect(delay(5000, 0)).toBe(5000);
    expect(delay(3000, 0.5)).toBe(3300);
  });

  it('adaptive mode treats an unusable base as the longest foreground interval', () => {
    for (const baseMs of [undefined, null, Number.NaN, -1, '1000'])
      expect(api.successDelay({ mode: 'adaptive', hidden: false, baseMs, u: 0 })).toBe(5000);
  });

  it('a hidden tab waits 15000 ms in both modes, without jitter', () => {
    for (const mode of ['fixed', 'adaptive'] as const)
      for (const u of [-1, 0.999])
        expect(api.successDelay({ mode, hidden: true, baseMs: 1000, u })).toBe(15000);
  });

  it('failures back off 1, 2, 4, 8 and 15 s with ±20% jitter, capped at 15 s', () => {
    const steps = (u: number) =>
      [1, 2, 3, 4, 5, 6].map((failures) =>
        api.failureDelay({ failures, hidden: false, serverMinMs: null, retryAfterMs: null, u }),
      );
    expect(steps(0)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    expect(steps(1)).toEqual([1200, 2400, 4800, 9600, 15000, 15000]);
    expect(steps(-1)).toEqual([800, 1600, 3200, 6400, 12000, 12000]);
  });

  it('the server minimum and Retry-After win over the backoff, also beyond the 15 s cap', () => {
    const delay = (failures: number, serverMinMs: unknown, retryAfterMs: unknown) =>
      api.failureDelay({ failures, hidden: false, serverMinMs, retryAfterMs, u: 0 });
    expect(delay(1, 20000, null)).toBe(20000);
    expect(delay(1, 1000, 30000)).toBe(30000);
    expect(delay(5, 15000, 15000)).toBe(15000);
    expect(delay(3, 1000, 1000)).toBe(4000);
    expect(delay(1, Number.NaN, '5')).toBe(1000);
  });

  it('a failing hidden tab never retries sooner than the hidden interval', () => {
    expect(
      api.failureDelay({ failures: 1, hidden: true, serverMinMs: 1000, retryAfterMs: null, u: 0 }),
    ).toBe(15000);
    expect(
      api.failureDelay({ failures: 1, hidden: true, serverMinMs: 60000, retryAfterMs: null, u: 0 }),
    ).toBe(60000);
  });

  it('reads Retry-After as whole seconds and ignores anything else', () => {
    expect(api.parseRetryAfter('7')).toBe(7000);
    expect(api.parseRetryAfter(' 12 ')).toBe(12000);
    for (const value of [null, undefined, '', 'soon', '-1', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT'])
      expect(api.parseRetryAfter(value)).toBeNull();
  });
});

describe('polling controller', () => {
  let api: Api;
  beforeAll(() => {
    api = load();
  });

  it('recovers the state with one GET and sends no POST by itself', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(null, null));
    t.controller.start();
    await t.advance(60000);
    expect(t.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET ${STATUS_PATH}`]);
    expect(t.controller.view().phase).toBe('not-joined');
    expect(t.controller.view().epoch).toBe(EPOCH_1);
  });

  it('starts the next request only after the previous response arrived', async () => {
    const t = tab(api);
    const second = deferred<Reply>();
    t.onRequest(() => (t.calls.length === 2 ? second.promise : t.ok(entry('waiting'), 5000)));
    t.controller.start();
    await t.advance(4000);
    expect(t.times()).toEqual([0, 1000]);
    second.resolve(t.ok(entry('waiting'), 5000));
    await t.advance(999);
    expect(t.times()).toEqual([0, 1000]);
    await t.advance(1);
    expect(t.times()).toEqual([0, 1000, 5000]);
    expect(t.maxActive()).toBe(1);
  });

  it('adaptive mode follows the server base with jitter and clamps it', async () => {
    const t = tab(api, { mode: 'adaptive', random: () => 0.25 });
    t.onRequest(() =>
      t.calls.length === 1
        ? t.ok(entry('waiting'), 5000)
        : t.ok(entry('waiting', { position: 5 }), 1000),
    );
    t.controller.start();
    await t.advance(5500);
    expect(t.times()).toEqual([0, 4500, 5500]);
  });

  it('aborts a request without an answer after 5 s, backs off and keeps one request in flight', async () => {
    const t = tab(api);
    t.onRequest(() => new Promise<Reply>(() => undefined));
    t.controller.start();
    await t.advance(22000);
    expect(t.times()).toEqual([0, 6000, 13000, 22000]);
    expect(t.calls.slice(0, 3).every((call) => call.signal.aborted)).toBe(true);
    expect(t.maxActive()).toBe(1);
    expect(t.controller.view().problem?.kind).toBe('network');
    expect(t.controller.view().phase).toBe('loading');
  });

  it('stops polling an event without a queue', async () => {
    const t = tab(api);
    t.onRequest(() => failure(404, 'ADMISSION_NOT_ENABLED'));
    t.controller.start();
    await t.advance(60000);
    expect(t.calls).toHaveLength(1);
    expect(t.controller.view().phase).toBe('not-enabled');
    expect(t.controller.view().problem).toBeNull();
  });

  it('stops on 401 and on an invalid request instead of retrying', async () => {
    for (const [reply, kind] of [
      [failure(401, 'UNAUTHENTICATED'), 'unauthenticated'],
      [failure(400, 'ADMISSION_INVALID_INPUT'), 'invalid'],
    ] as const) {
      const t = tab(api);
      t.onRequest(() => reply);
      t.controller.start();
      await t.advance(60000);
      expect(t.calls).toHaveLength(1);
      expect(t.controller.view().problem?.kind).toBe(kind);
    }
  });

  it('polls a hidden tab every 15 s and sends exactly one request on return', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(entry('waiting'), 5000));
    t.controller.start();
    await t.advance(1500);
    t.setHidden(true);
    await t.advance(18500);
    expect(t.times()).toEqual([0, 1000, 16000]);
    t.setHidden(false);
    await t.advance(2000);
    expect(t.times()).toEqual([0, 1000, 16000, 20000, 21000, 22000]);
    expect(t.maxActive()).toBe(1);
  });

  it('sends no second request when the tab returns while one is in flight', async () => {
    const t = tab(api);
    const open = deferred<Reply>();
    t.onRequest(() => (t.calls.length === 2 ? open.promise : t.ok(entry('waiting'), 5000)));
    t.controller.start();
    await t.advance(1200);
    t.setHidden(true);
    t.setHidden(false);
    await t.advance(800);
    expect(t.times()).toEqual([0, 1000]);
    open.resolve(t.ok(entry('waiting'), 5000));
    await t.advance(1000);
    expect(t.times()).toEqual([0, 1000, 3000]);
    expect(t.maxActive()).toBe(1);
  });

  it('sends nothing inside a wait the server asked for, whatever the tab does (A15)', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.calls.length === 2
        ? failure(503, 'ADMISSION_RECOVERING', 15000)
        : t.ok(entry('waiting'), 5000),
    );
    t.controller.start();
    await t.advance(3000);
    t.setHidden(true);
    await t.advance(1000);
    t.setHidden(false);
    await t.advance(1000);
    t.controller.setMode('adaptive');
    await t.advance(10999);
    expect(t.times()).toEqual([0, 1000]);
    expect(t.controller.view().problem).toMatchObject({
      kind: 'unavailable',
      code: 'ADMISSION_RECOVERING',
      retryAt: 16000,
    });
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_A);
    await t.advance(1);
    expect(t.times()).toEqual([0, 1000, 16000]);
    expect(t.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(t.controller.view().problem).toBeNull();
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_A);
  });

  it('waits at least Retry-After on 429', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.calls.length === 1
        ? { ...failure(429, 'ADMISSION_RATE_LIMITED', 2500), retryAfterMs: 3000 }
        : t.ok(entry('waiting'), 5000),
    );
    t.controller.start();
    await t.advance(2999);
    expect(t.times()).toEqual([0]);
    expect(t.controller.view().problem?.kind).toBe('rate-limited');
    await t.advance(1);
    expect(t.times()).toEqual([0, 3000]);
  });

  it('escalates consecutive failures to 15 s and starts over after a normal response', async () => {
    const t = tab(api);
    t.onRequest(() =>
      [6, 8].includes(t.calls.length)
        ? t.ok(entry('waiting'), 5000)
        : failure(503, 'ADMISSION_UNAVAILABLE', 1000),
    );
    t.controller.start();
    await t.advance(32000);
    expect(t.times()).toEqual([0, 1000, 3000, 7000, 15000, 30000, 31000, 32000]);
  });

  it('keeps the admission and sends no join when the mode is switched', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(entry('waiting'), 5000));
    t.controller.start();
    await t.advance(1500);
    t.controller.setMode('adaptive');
    expect(t.controller.view().mode).toBe('adaptive');
    await t.advance(5500);
    expect(t.times()).toEqual([0, 1000, 2000, 7000]);
    expect(t.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_A);
  });

  it('dispose aborts the request in flight and clears every timer', async () => {
    const inFlight = tab(api);
    const late = deferred<Reply>();
    inFlight.onRequest(() => late.promise);
    inFlight.controller.start();
    await inFlight.flush();
    inFlight.controller.dispose();
    expect(inFlight.calls[0].signal.aborted).toBe(true);
    const views = inFlight.views.length;
    late.resolve(inFlight.ok(entry('waiting'), 5000));
    await inFlight.advance(60000);
    expect(inFlight.calls).toHaveLength(1);
    expect(inFlight.views).toHaveLength(views);

    const scheduled = tab(api);
    scheduled.onRequest(() => scheduled.ok(entry('waiting'), 5000));
    scheduled.controller.start();
    await scheduled.advance(500);
    scheduled.controller.dispose();
    scheduled.setHidden(true);
    scheduled.setHidden(false);
    await scheduled.advance(60000);
    expect(scheduled.calls).toHaveLength(1);
  });

  it('never applies a late response of an earlier context: user A → B → A (A14)', async () => {
    const first = tab(api, { userId: USER_A });
    const late = deferred<Reply>();
    first.onRequest(() => late.promise);
    first.controller.start();
    await first.flush();
    first.controller.dispose();

    const other = tab(api, { userId: USER_B });
    other.onRequest(() => other.ok(entry('waiting', { admissionId: ADMISSION_B }), 5000));
    other.controller.start();
    await other.flush();
    expect(other.controller.view().admission?.admissionId).toBe(ADMISSION_B);
    other.controller.dispose();

    const second = tab(api, { userId: USER_A });
    second.onRequest(() => second.ok(null, null));
    second.controller.start();
    await second.flush();
    const views = first.views.length;
    late.resolve(first.ok(entry('waiting'), 5000));
    await first.advance(60000);

    expect(first.views).toHaveLength(views);
    expect(first.calls).toHaveLength(1);
    expect(second.calls.map((call) => call.method)).toEqual(['GET']);
    expect(second.controller.view().phase).toBe('not-joined');
    expect(second.controller.view().admission).toBeNull();
  });

  it('reports a new epoch as a reset and does not join again by itself', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.calls.length === 1 ? t.ok(entry('waiting'), 5000) : t.ok(null, null, EPOCH_2),
    );
    t.controller.start();
    await t.advance(60000);
    expect(t.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(t.controller.view()).toMatchObject({ phase: 'reset', epoch: EPOCH_2, admission: null });
  });

  it('does not call an epoch change a reset when nothing was waiting', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(null, null, t.calls.length === 1 ? EPOCH_1 : EPOCH_2));
    t.controller.start();
    await t.advance(1000);
    t.setHidden(true);
    t.setHidden(false);
    await t.advance(1000);
    expect(t.calls).toHaveLength(2);
    expect(t.controller.view()).toMatchObject({ phase: 'not-joined', epoch: EPOCH_2 });
  });

  it('treats an answer whose admission is not of the queue epoch as a failure', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.calls.length === 1
        ? t.ok(entry('waiting', { epoch: EPOCH_2 }), 1000)
        : t.ok(entry('waiting'), 5000),
    );
    t.controller.start();
    await t.advance(999);
    expect(t.controller.view().admission).toBeNull();
    expect(t.controller.view().problem).toMatchObject({ kind: 'unavailable', code: 'PROTOCOL' });
    await t.advance(1);
    expect(t.times()).toEqual([0, 1000]);
    expect(t.controller.view().phase).toBe('waiting');
    expect(t.controller.view().problem).toBeNull();
  });

  it('exposes the deadline of an admitted entry on the local monotonic clock', async () => {
    const t = tab(api);
    const first = deferred<Reply>();
    t.onRequest(() =>
      t.calls.length === 1
        ? first.promise
        : t.ok(entry('admitted', { phase: 'processing', admittedAt: iso(SERVER_T0 + 40) }), 1000),
    );
    t.controller.start();
    await t.advance(120);
    first.resolve({
      status: 200,
      data: {
        contractRevision: 'admission-v1',
        serverTime: iso(SERVER_T0 + 100),
        queue: { eventId: EVENT, epoch: EPOCH_1, mode: 'open' },
        admission: entry('admitted', {
          admittedAt: iso(SERVER_T0 + 40),
          expiresAt: iso(SERVER_T0 + 30040),
        }),
        nextPollAfterMs: 1000,
      },
    });
    await t.flush();
    expect(t.controller.view()).toMatchObject({ phase: 'admitted', deadlineAt: 120 + 29940 });
    await t.advance(1000);
    expect(t.controller.view()).toMatchObject({ phase: 'processing', deadlineAt: null });
  });

  it('refreshes a finished entry once on return but never probes an event without a queue', async () => {
    const finished = tab(api);
    finished.onRequest(() =>
      finished.ok(entry('cancelled', { reason: 'ADMISSION_CANCELLED' }), null),
    );
    finished.controller.start();
    await finished.advance(30000);
    finished.setHidden(true);
    await finished.advance(1000);
    finished.setHidden(false);
    await finished.advance(30000);
    expect(finished.times()).toEqual([0, 31000]);

    const none = tab(api);
    none.onRequest(() => failure(404, 'ADMISSION_NOT_ENABLED'));
    none.controller.start();
    await none.advance(1000);
    none.setHidden(true);
    none.setHidden(false);
    await none.advance(30000);
    expect(none.calls).toHaveLength(1);
  });
});
