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
  createTrace(options: { limit: number; meta: Record<string, unknown> }): {
    push(event: TraceEvent): void;
    snapshot(): { meta: Record<string, unknown>; dropped: number; events: TraceEvent[] };
  };
}

type TraceEvent = Record<string, unknown> & { type: string };

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

interface Purchase {
  body: unknown;
  signal: AbortSignal;
  at: number;
}

interface PurchaseResult {
  status: number;
  data: unknown;
  body: unknown;
}

interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  size(): number;
}

function memoryStore(): Store {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
    size: () => values.size,
  };
}

/** The recognition markers a browser profile shares between its tabs and reloads. */
function memoryMarkers() {
  const keys = new Set<string>();
  return { has: (key: string) => keys.has(key), add: (key: string) => void keys.add(key) };
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

const PURCHASE = Object.freeze({
  eventId: EVENT,
  userId: USER_A,
  quantity: 2,
  tierId: 'general',
  admissionId: ADMISSION_A,
  admissionEpoch: EPOCH_1,
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
  let respondPurchase: (purchase: Purchase) => Reply | Promise<Reply> = () => ({ status: 0 });
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const calls: Call[] = [];
  const purchases: Purchase[] = [];
  const results: PurchaseResult[] = [];
  const views: View[] = [];
  const traces: TraceEvent[] = [];
  const pending = (overrides.pending as Store | undefined) ?? memoryStore();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  // Counts what the tab has in flight: a request leaves when it settles or is aborted.
  const track = (signal: AbortSignal, reply: Reply | Promise<Reply>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    let open = true;
    const leave = () => {
      if (open) active -= 1;
      open = false;
    };
    signal.addEventListener('abort', leave);
    return Promise.resolve(reply).finally(leave);
  };

  const controller = api.createController({
    userId: USER_A,
    eventId: EVENT,
    mode: 'fixed',
    transport(request: Omit<Call, 'at'>) {
      const call: Call = { ...request, at: now };
      calls.push(call);
      return track(request.signal, respond(call));
    },
    sendPurchase(body: unknown, signal: AbortSignal) {
      const purchase: Purchase = { body, signal, at: now };
      purchases.push(purchase);
      return track(signal, respondPurchase(purchase));
    },
    onPurchaseResult: (result: PurchaseResult) => results.push(result),
    pending,
    seen: memoryMarkers(),
    onChange: (view: View) => views.push(view),
    onTrace: (event: TraceEvent) => traces.push(event),
    wall: () => SERVER_T0 + now,
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
    purchases,
    results,
    pending,
    views,
    traces,
    traced: (type: string) => traces.filter((event) => event.type === type),
    flush,
    now: () => now,
    times: () => calls.map((call) => call.at),
    methods: () => calls.map((call) => call.method),
    maxActive: () => maxActive,
    onRequest(handler: (call: Call) => Reply | Promise<Reply>) {
      respond = handler;
    },
    onPurchase(handler: (purchase: Purchase) => Reply | Promise<Reply>) {
      respondPurchase = handler;
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

describe('join, cancel and purchase', () => {
  let api: Api;
  beforeAll(() => {
    api = load();
  });

  const admittedEntry = (t: { now(): number }) =>
    entry('admitted', {
      position: null,
      admittedAt: iso(SERVER_T0 + t.now()),
      expiresAt: iso(SERVER_T0 + t.now() + 30000),
    });
  const cancelled = () => entry('cancelled', { reason: 'ADMISSION_CANCELLED' });

  it('repeats a join whose answer was lost with the same key and the epoch read by GET', async () => {
    const t = tab(api);
    let posts = 0;
    t.onRequest((call) => {
      if (call.method === 'GET') return t.ok(null, null);
      posts += 1;
      return posts === 1 ? { status: 0 } : t.ok(entry('waiting'), 5000);
    });
    t.controller.start();
    await t.flush();
    expect(t.controller.join()).toBe(true);
    await t.flush();
    // The answer is unknown. Nothing more is sent inside the backoff, not even on a second click.
    expect(t.controller.join()).toBe(false);
    expect(t.controller.view()).toMatchObject({ phase: 'not-joined', notice: 'JOIN_UNCONFIRMED' });
    await t.advance(1000);
    expect(t.methods()).toEqual(['GET', 'POST', 'GET']);
    expect(t.controller.view()).toMatchObject({ phase: 'not-joined', notice: 'JOIN_UNCONFIRMED' });
    expect(t.controller.join()).toBe(true);
    await t.flush();
    expect(t.calls[1].path).toBe(`/events/${EVENT}/admissions`);
    expect(t.calls[1].body).toEqual({ epoch: EPOCH_1, joinRequestId: 'join-key-1' });
    expect(t.calls[3].body).toEqual(t.calls[1].body);
    expect(t.controller.view()).toMatchObject({ phase: 'waiting', notice: null });
  });

  it('uses a new join key for a new attempt after a finished entry', async () => {
    const t = tab(api);
    let current: Snapshot | null = null;
    t.onRequest((call) => {
      if (call.method === 'POST') current = entry('waiting');
      if (call.method === 'DELETE') current = cancelled();
      return t.ok(current, current?.state === 'waiting' ? 5000 : null);
    });
    t.controller.start();
    await t.flush();
    expect(t.controller.join()).toBe(true);
    await t.flush();
    expect(t.controller.cancel()).toBe(true);
    await t.flush();
    expect(t.controller.view().phase).toBe('cancelled');
    expect(t.controller.join()).toBe(true);
    await t.flush();
    const keys = t.calls
      .filter((call) => call.method === 'POST')
      .map((call) => (call.body as { joinRequestId: string }).joinRequestId);
    expect(keys).toEqual(['join-key-1', 'join-key-2']);
  });

  it('adopts the existing entry when another join key is still active and sends no second POST', async () => {
    const t = tab(api);
    const existing = entry('waiting', { admissionId: ADMISSION_B });
    let refused = false;
    t.onRequest((call) => {
      if (call.method === 'GET') return refused ? t.ok(existing, 5000) : t.ok(null, null);
      refused = true;
      return {
        status: 409,
        data: {
          error: { code: 'ACTIVE_ADMISSION_EXISTS', message: 'ACTIVE_ADMISSION_EXISTS' },
          nextPollAfterMs: null,
          admission: existing,
        },
      };
    });
    t.controller.start();
    await t.flush();
    t.controller.join();
    await t.flush();
    expect(t.methods()).toEqual(['GET', 'POST', 'GET']);
    expect(t.controller.view().phase).toBe('waiting');
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_B);
    await t.advance(3000);
    expect(t.methods().filter((method) => method === 'POST')).toHaveLength(1);
  });

  it('does not join again by itself when the epoch was replaced before the join arrived', async () => {
    const t = tab(api);
    let epoch = EPOCH_1;
    t.onRequest((call) => {
      if (call.method === 'GET') return t.ok(null, null, epoch);
      if ((call.body as { epoch: string }).epoch !== epoch) return failure(410, 'ADMISSION_RESET');
      return { ...t.ok(entry('waiting', { epoch }), 5000, epoch), status: 201 };
    });
    t.controller.start();
    await t.flush();
    epoch = EPOCH_2;
    t.controller.join();
    await t.flush();
    expect(t.methods()).toEqual(['GET', 'POST', 'GET']);
    expect(t.controller.view()).toMatchObject({
      phase: 'not-joined',
      epoch: EPOCH_2,
      notice: 'ADMISSION_RESET',
    });
    await t.advance(60000);
    expect(t.methods()).toEqual(['GET', 'POST', 'GET']);
    t.controller.join();
    await t.flush();
    expect(t.calls[3].body).toEqual({ epoch: EPOCH_2, joinRequestId: 'join-key-2' });
    expect(t.controller.view().phase).toBe('waiting');
  });

  it('refuses a join while loading, while an entry is active and for an event without a queue', async () => {
    const loading = tab(api);
    loading.onRequest(() => new Promise<Reply>(() => undefined));
    loading.controller.start();
    await loading.flush();
    expect(loading.controller.join()).toBe(false);

    const active = tab(api);
    active.onRequest(() => active.ok(entry('waiting'), 5000));
    active.controller.start();
    await active.flush();
    expect(active.controller.join()).toBe(false);

    const none = tab(api);
    none.onRequest(() => failure(404, 'ADMISSION_NOT_ENABLED'));
    none.controller.start();
    await none.flush();
    expect(none.controller.join()).toBe(false);
    expect([...loading.methods(), ...active.methods(), ...none.methods()]).toEqual([
      'GET',
      'GET',
      'GET',
    ]);
  });

  it('lets a cancel pre-empt the request in flight and ignores that request when it answers late', async () => {
    const t = tab(api);
    const open = deferred<Reply>();
    t.onRequest((call) => {
      if (call.method === 'DELETE') return t.ok(cancelled(), null);
      return t.calls.length === 2 ? open.promise : t.ok(entry('waiting'), 5000);
    });
    t.controller.start();
    await t.advance(1200);
    expect(t.controller.cancel()).toBe(true);
    await t.flush();
    expect(t.calls[1].signal.aborted).toBe(true);
    expect(t.calls[2]).toMatchObject({
      method: 'DELETE',
      path: `/events/${EVENT}/admissions/${ADMISSION_A}`,
      body: { epoch: EPOCH_1 },
    });
    expect(t.controller.view().phase).toBe('cancelled');
    open.resolve(t.ok(entry('waiting'), 5000));
    await t.advance(60000);
    expect(t.controller.view().phase).toBe('cancelled');
    expect(t.calls).toHaveLength(3);
    expect(t.maxActive()).toBe(1);
  });

  it('keeps the newly joined entry when a cancel that timed out answers late (A14)', async () => {
    const t = tab(api);
    const lost = deferred<Reply>();
    let current = entry('waiting');
    t.onRequest((call) => {
      if (call.method === 'DELETE') {
        current = cancelled();
        return lost.promise;
      }
      if (call.method === 'POST')
        current = entry('waiting', { admissionId: ADMISSION_B, sequence: '40', position: 40 });
      return t.ok(current, current.state === 'waiting' ? 5000 : null);
    });
    t.controller.start();
    await t.flush();
    t.controller.cancel();
    await t.advance(5000);
    expect(t.controller.view()).toMatchObject({ phase: 'waiting', notice: 'CANCEL_UNCONFIRMED' });
    await t.advance(1000);
    expect(t.controller.view()).toMatchObject({ phase: 'cancelled', notice: null });
    expect(t.controller.join()).toBe(true);
    await t.flush();
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_B);
    lost.resolve(t.ok(cancelled(), null));
    await t.advance(3000);
    expect(t.controller.view().phase).toBe('waiting');
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_B);
    expect(t.maxActive()).toBe(1);
  });

  it('reads the state again when a cancel is refused, without repeating the cancel', async () => {
    const t = tab(api);
    let refused = false;
    t.onRequest((call) => {
      if (call.method === 'DELETE') {
        refused = true;
        return failure(409, 'ADMISSION_IN_PROGRESS');
      }
      const admitted = admittedEntry(t);
      return t.ok(refused ? { ...admitted, phase: 'processing' } : admitted, 1000);
    });
    t.controller.start();
    await t.flush();
    expect(t.controller.cancel()).toBe(true);
    await t.flush();
    expect(t.methods()).toEqual(['GET', 'DELETE', 'GET']);
    expect(t.controller.view().phase).toBe('processing');
    expect(t.controller.cancel()).toBe(false);
  });

  it('does not apply a cancel answer that is about another entry', async () => {
    const t = tab(api);
    t.onRequest((call) =>
      call.method === 'DELETE'
        ? t.ok(
            entry('cancelled', { admissionId: ADMISSION_B, reason: 'ADMISSION_CANCELLED' }),
            null,
          )
        : t.ok(entry('waiting'), 5000),
    );
    t.controller.start();
    await t.flush();
    expect(t.controller.cancel()).toBe(true);
    await t.flush();
    expect(t.methods()).toEqual(['GET', 'DELETE']);
    expect(t.controller.view()).toMatchObject({ phase: 'waiting', notice: 'CANCEL_UNCONFIRMED' });
    expect(t.controller.view().admission?.admissionId).toBe(ADMISSION_A);
  });

  it('sends no status request while a purchase is open, in flight or between its retries', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(admittedEntry(t), 1000));
    t.onPurchase(() =>
      t.purchases.length === 1 ? { status: 0 } : new Promise<Reply>(() => undefined),
    );
    t.controller.start();
    await t.flush();
    t.controller.purchase({ ...PURCHASE });
    // The first attempt failed at once and the retry waits until 1000: nothing is in flight.
    await t.advance(500);
    t.setHidden(true);
    t.setHidden(false);
    await t.advance(400);
    expect(t.methods()).toEqual(['GET']);
    // The second attempt is in flight from 1000.
    await t.advance(1100);
    t.setHidden(true);
    t.setHidden(false);
    await t.advance(1000);
    expect(t.methods()).toEqual(['GET']);
    expect(t.purchases).toHaveLength(2);
    expect(t.maxActive()).toBe(1);
  });

  it('sends the purchase once with the body it was given while polling is paused', async () => {
    const t = tab(api);
    const answer = deferred<Reply>();
    let consumed = false;
    t.onRequest(() =>
      consumed
        ? t.ok(
            entry('consumed', { outcome: { kind: 'reservation', resourceId: 'r-1', code: null } }),
            null,
          )
        : t.ok(admittedEntry(t), 1000),
    );
    t.onPurchase(() => answer.promise);
    t.controller.start();
    await t.flush();
    expect(t.controller.purchase({ ...PURCHASE })).toBe(true);
    await t.advance(3000);
    expect(t.methods()).toEqual(['GET']);
    expect(t.purchases).toHaveLength(1);
    expect(t.purchases[0].body).toEqual(PURCHASE);
    expect(t.controller.view().purchase).toMatchObject({ status: 'sending', attempts: 1 });
    expect(t.pending.size()).toBe(1);
    consumed = true;
    answer.resolve({ status: 201, data: { id: 'r-1' } });
    await t.flush();
    expect(t.results).toEqual([{ status: 201, data: { id: 'r-1' }, body: PURCHASE }]);
    expect(t.methods()).toEqual(['GET', 'GET']);
    expect(t.controller.view()).toMatchObject({ phase: 'consumed', purchase: null });
    expect(t.pending.size()).toBe(0);
    expect(t.maxActive()).toBe(1);
  });

  it('repeats an unknown purchase with the identical body, never joins, and stops after four automatic retries', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(admittedEntry(t), 1000));
    t.onPurchase(() => ({ status: 0 }));
    t.controller.start();
    await t.flush();
    t.controller.purchase({ ...PURCHASE });
    await t.advance(14999);
    expect(t.purchases.map((purchase) => purchase.at)).toEqual([0, 1000, 3000, 7000]);
    expect(t.controller.view().purchase).toMatchObject({ status: 'retrying', attempts: 4 });
    expect(t.methods()).toEqual(['GET']);
    await t.advance(1);
    expect(t.purchases.map((purchase) => purchase.at)).toEqual([0, 1000, 3000, 7000, 15000]);
    expect(t.purchases.every((purchase) => purchase.body === t.purchases[0].body)).toBe(true);
    expect(t.purchases[0].body).toEqual(PURCHASE);
    expect(t.controller.view().purchase).toMatchObject({ status: 'unconfirmed', attempts: 5 });
    // Polling is back, but nothing joins, cancels or buys again by itself.
    expect(t.methods()).toEqual(['GET', 'GET']);
    expect(t.controller.join()).toBe(false);
    expect(t.controller.cancel()).toBe(false);
    expect(t.controller.purchase({ ...PURCHASE, quantity: 1 })).toBe(false);
    await t.advance(5000);
    expect(t.purchases).toHaveLength(5);
    expect(t.methods().every((method) => method === 'GET')).toBe(true);

    t.onPurchase(() => ({ status: 201, data: { id: 'r-1' } }));
    expect(t.controller.retryPurchase()).toBe(true);
    await t.flush();
    expect(t.purchases).toHaveLength(6);
    expect(t.purchases[5].body).toBe(t.purchases[0].body);
    expect(t.results.map((result) => result.status)).toEqual([201]);
    expect(t.controller.view().purchase).toBeNull();
    expect(t.pending.size()).toBe(0);
    expect(t.maxActive()).toBe(1);
  });

  it('retries only what a later attempt can outlive and reports every other answer at once', async () => {
    const transient = tab(api);
    const replies: Reply[] = [
      failure(503, 'ADMISSION_UNAVAILABLE', 1000),
      failure(409, 'ADMISSION_IN_PROGRESS'),
      { status: 429, data: { error: { code: 'RATE_LIMIT_EXCEEDED' } } },
      { status: 201, data: { id: 'r-1' } },
    ];
    transient.onRequest(() => transient.ok(admittedEntry(transient), 1000));
    transient.onPurchase(() => replies[transient.purchases.length - 1]);
    transient.controller.start();
    await transient.flush();
    transient.controller.purchase({ ...PURCHASE });
    await transient.advance(7000);
    expect(transient.purchases.map((purchase) => purchase.at)).toEqual([0, 1000, 3000, 7000]);
    expect(transient.results.map((result) => result.status)).toEqual([201]);

    for (const reply of [
      failure(410, 'ADMISSION_EXPIRED'),
      failure(409, 'ADMISSION_REQUEST_MISMATCH'),
      failure(404, 'ADMISSION_NOT_FOUND'),
      failure(400, 'ADMISSION_INVALID_INPUT'),
      failure(401, 'UNAUTHENTICATED'),
      { status: 409, data: { error: { code: 'INSUFFICIENT_INVENTORY' } } },
    ]) {
      const t = tab(api);
      t.onRequest(() => t.ok(admittedEntry(t), 1000));
      t.onPurchase(() => reply);
      t.controller.start();
      await t.flush();
      t.controller.purchase({ ...PURCHASE });
      await t.advance(20000);
      expect(t.purchases).toHaveLength(1);
      expect(t.results.map((result) => result.status)).toEqual([reply.status]);
      expect(t.controller.view().purchase).toBeNull();
      expect(t.methods().every((method) => method === 'GET')).toBe(true);
    }
  });

  it('does not hold a purchase back because a status poll failed', async () => {
    const t = tab(api);
    t.onRequest(() => (t.calls.length === 1 ? t.ok(admittedEntry(t), 1000) : { status: 0 }));
    t.onPurchase(() => ({ status: 201, data: { id: 'r-1' } }));
    t.controller.start();
    await t.advance(1000);
    expect(t.controller.view().problem?.kind).toBe('network');
    // The admission lives 30 s; the backoff of the status API must not cost the user that time.
    expect(t.controller.cancel()).toBe(false);
    expect(t.controller.purchase({ ...PURCHASE })).toBe(true);
    await t.flush();
    expect(t.results.map((result) => result.status)).toEqual([201]);
  });

  it('keeps a wait of the status API when it reads the state again after a purchase', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.calls.length === 2
        ? failure(503, 'ADMISSION_RECOVERING', 15000)
        : t.ok(admittedEntry(t), 1000),
    );
    t.onPurchase(() => ({ status: 201, data: { id: 'r-1' } }));
    t.controller.start();
    await t.advance(1000);
    expect(t.controller.purchase({ ...PURCHASE })).toBe(true);
    await t.advance(14999);
    expect(t.results).toHaveLength(1);
    expect(t.times()).toEqual([0, 1000]);
    await t.advance(1);
    expect(t.times()).toEqual([0, 1000, 16000]);
  });

  it('gives a purchase 10 s before it counts as unanswered', async () => {
    const t = tab(api);
    t.onRequest(() => t.ok(admittedEntry(t), 1000));
    t.onPurchase(() => new Promise<Reply>(() => undefined));
    t.controller.start();
    await t.flush();
    t.controller.purchase({ ...PURCHASE });
    await t.advance(10999);
    expect(t.purchases.map((purchase) => purchase.at)).toEqual([0]);
    expect(t.purchases[0].signal.aborted).toBe(true);
    await t.advance(1);
    expect(t.purchases.map((purchase) => purchase.at)).toEqual([0, 11000]);
    expect(t.maxActive()).toBe(1);
  });

  it('refuses a purchase unless the entry is admitted and idle', async () => {
    for (const admission of [
      entry('waiting'),
      entry('admitted', { phase: 'processing', admittedAt: iso(SERVER_T0) }),
      entry('expired', { reason: 'ADMISSION_EXPIRED' }),
      null,
    ]) {
      const t = tab(api);
      t.onRequest(() => t.ok(admission, admission?.state === 'expired' ? null : 1000));
      t.controller.start();
      await t.flush();
      expect(t.controller.purchase({ ...PURCHASE })).toBe(false);
      expect(t.purchases).toHaveLength(0);
    }
  });

  it('restores an unresolved purchase after a reload for the same user and event only', async () => {
    const before = tab(api);
    before.onRequest(() => before.ok(admittedEntry(before), 1000));
    before.onPurchase(() => new Promise<Reply>(() => undefined));
    before.controller.start();
    await before.flush();
    before.controller.purchase({ ...PURCHASE });
    await before.flush();
    before.controller.dispose();
    expect(before.pending.size()).toBe(1);

    const stranger = tab(api, { userId: USER_B, pending: before.pending });
    stranger.onRequest(() => stranger.ok(null, null));
    stranger.controller.start();
    await stranger.flush();
    expect(stranger.controller.view().purchase).toBeNull();

    const after = tab(api, { pending: before.pending });
    after.onRequest(() =>
      after.ok(entry('admitted', { phase: 'processing', admittedAt: iso(SERVER_T0) }), 1000),
    );
    after.onPurchase(() => ({ status: 201, data: { id: 'r-1' } }));
    after.controller.start();
    await after.flush();
    expect(after.controller.view().purchase).toMatchObject({
      status: 'unconfirmed',
      restored: true,
    });
    // Nothing is bought again by itself, and nothing joins while the outcome is open.
    expect(after.purchases).toHaveLength(0);
    expect(after.controller.join()).toBe(false);
    expect(after.controller.retryPurchase()).toBe(true);
    await after.flush();
    expect(after.purchases[0].body).toEqual(PURCHASE);
    expect(after.results.map((result) => result.status)).toEqual([201]);
    expect(after.pending.size()).toBe(0);
  });
});

describe('instrumentation', () => {
  let api: Api;
  beforeAll(() => {
    api = load();
  });

  const cancelled = () => entry('cancelled', { reason: 'ADMISSION_CANCELLED' });

  it('records the first admitted application once, bounded by the server delta and the round trip', async () => {
    const t = tab(api);
    const answer = deferred<Reply>();
    const admitted = entry('admitted', {
      admittedAt: iso(SERVER_T0 + 500),
      expiresAt: iso(SERVER_T0 + 30500),
    });
    t.onRequest(() => {
      if (t.calls.length === 1) return t.ok(entry('waiting'), 1000);
      return t.calls.length === 2 ? answer.promise : t.ok(admitted, 1000);
    });
    t.controller.start();
    await t.advance(1300);
    // Sent at 1000, answered at 1300 by a server whose clock read 700 ms after the promotion.
    answer.resolve({
      status: 200,
      data: {
        contractRevision: 'admission-v1',
        serverTime: iso(SERVER_T0 + 1200),
        queue: { eventId: EVENT, epoch: EPOCH_1, mode: 'open' },
        admission: admitted,
        nextPollAfterMs: 1000,
      },
    });
    await t.advance(3000);
    expect(t.calls.length).toBeGreaterThan(3);
    expect(t.traced('recognition')).toHaveLength(1);
    expect(t.traced('recognition')[0]).toMatchObject({
      epoch: EPOCH_1,
      admissionId: ADMISSION_A,
      serverDeltaMs: 700,
      tSend: 1000,
      tRecv: 1300,
      tApply: 1300,
      lowerMs: 700,
      upperMs: 1000,
      hiddenAtApply: false,
      visibleAtPromotion: true,
      hiddenBetween: false,
      failuresBefore: 0,
      viaRecover: false,
      layer: 'foreground',
    });
    expect(t.traced('recognition-missed')).toHaveLength(0);
  });

  it('does not count a reload or a second tab again, and files a first sight after a load under reconnect', async () => {
    const seen = memoryMarkers();
    const admitted = entry('admitted', {
      admittedAt: iso(SERVER_T0),
      expiresAt: iso(SERVER_T0 + 30000),
    });
    const first = tab(api, { seen });
    first.onRequest(() => first.ok(admitted, 1000));
    first.controller.start();
    await first.flush();
    expect(first.traced('recognition')).toHaveLength(1);
    expect(first.traced('recognition')[0]).toMatchObject({ viaRecover: true, layer: 'reconnect' });
    first.controller.dispose();

    const reloaded = tab(api, { seen });
    reloaded.onRequest(() => reloaded.ok(admitted, 1000));
    reloaded.controller.start();
    await reloaded.advance(3000);
    expect(reloaded.traced('recognition')).toHaveLength(0);
    expect(reloaded.traced('recognition-missed')).toHaveLength(0);
  });

  it('files a recognition made in a hidden tab under hidden, whether it was promoted before or after hiding', async () => {
    const hiddenFirst = tab(api);
    hiddenFirst.onRequest(() =>
      hiddenFirst.calls.length === 1
        ? hiddenFirst.ok(entry('waiting'), 1000)
        : hiddenFirst.ok(
            entry('admitted', {
              admittedAt: iso(SERVER_T0 + 10000),
              expiresAt: iso(SERVER_T0 + 40000),
            }),
            1000,
          ),
    );
    hiddenFirst.controller.start();
    await hiddenFirst.advance(500);
    hiddenFirst.setHidden(true);
    await hiddenFirst.advance(14500);
    expect(hiddenFirst.traced('recognition')).toHaveLength(1);
    expect(hiddenFirst.traced('recognition')[0]).toMatchObject({
      serverDeltaMs: 5000,
      lowerMs: 5000,
      upperMs: 5000,
      hiddenAtApply: true,
      visibleAtPromotion: false,
      hiddenBetween: true,
      failuresBefore: 0,
      viaRecover: false,
      layer: 'hidden',
    });

    const promotedFirst = tab(api);
    promotedFirst.onRequest(() =>
      promotedFirst.calls.length < 3
        ? promotedFirst.ok(entry('waiting'), 1000)
        : promotedFirst.ok(
            entry('admitted', {
              admittedAt: iso(SERVER_T0 + 1200),
              expiresAt: iso(SERVER_T0 + 31200),
            }),
            1000,
          ),
    );
    promotedFirst.controller.start();
    await promotedFirst.advance(1500);
    promotedFirst.setHidden(true);
    await promotedFirst.advance(14500);
    expect(promotedFirst.times()).toEqual([0, 1000, 16000]);
    expect(promotedFirst.traced('recognition')[0]).toMatchObject({
      serverDeltaMs: 14800,
      visibleAtPromotion: true,
      hiddenBetween: true,
      hiddenAtApply: true,
      layer: 'hidden',
    });
  });

  it('files a recognition that follows failed requests under reconnect', async () => {
    const t = tab(api);
    t.onRequest(() => {
      if (t.calls.length === 1) return t.ok(entry('waiting'), 1000);
      if (t.calls.length < 4) return { status: 0 };
      return t.ok(
        entry('admitted', {
          admittedAt: iso(SERVER_T0 + 1500),
          expiresAt: iso(SERVER_T0 + 31500),
        }),
        1000,
      );
    });
    t.controller.start();
    await t.advance(4000);
    expect(t.times()).toEqual([0, 1000, 2000, 4000]);
    expect(t.traced('recognition')[0]).toMatchObject({
      serverDeltaMs: 2500,
      failuresBefore: 2,
      viaRecover: false,
      visibleAtPromotion: true,
      hiddenBetween: false,
      layer: 'reconnect',
    });
  });

  it('records an admission that ended before this page saw it admitted, once', async () => {
    const t = tab(api);
    t.onRequest(() =>
      t.ok(
        entry('expired', {
          reason: 'ADMISSION_EXPIRED',
          admittedAt: iso(SERVER_T0 - 40000),
        }),
        null,
      ),
    );
    t.controller.start();
    await t.flush();
    t.setHidden(true);
    t.setHidden(false);
    await t.advance(1000);
    expect(t.calls).toHaveLength(2);
    expect(t.traced('recognition')).toHaveLength(0);
    expect(t.traced('recognition-missed')).toHaveLength(1);
    expect(t.traced('recognition-missed')[0]).toMatchObject({
      epoch: EPOCH_1,
      admissionId: ADMISSION_A,
      state: 'expired',
      serverDeltaMs: 40000,
    });

    // A waiting entry whose lease ran out was never admitted.
    const never = tab(api);
    never.onRequest(() => never.ok(entry('expired', { reason: 'ADMISSION_EXPIRED' }), null));
    never.controller.start();
    await never.flush();
    expect(never.traced('recognition-missed')).toHaveLength(0);
  });

  it('does not call an entry missed when this page saw it admitted before it ended', async () => {
    const t = tab(api);
    const admittedAt = iso(SERVER_T0);
    t.onRequest(() =>
      t.calls.length === 1
        ? t.ok(entry('admitted', { admittedAt, expiresAt: iso(SERVER_T0 + 30000) }), 1000)
        : t.ok(entry('expired', { reason: 'ADMISSION_EXPIRED', admittedAt }), null),
    );
    t.controller.start();
    await t.advance(1000);
    expect(t.controller.view().phase).toBe('expired');
    expect(t.traced('recognition')).toHaveLength(1);
    expect(t.traced('recognition-missed')).toHaveLength(0);
  });

  it('records for every poll why and when it was sent and which delay was planned', async () => {
    const t = tab(api, { mode: 'adaptive', random: () => 0.25 });
    t.onRequest(() =>
      t.calls.length === 3
        ? failure(503, 'ADMISSION_RECOVERING', 1000)
        : t.ok(entry('waiting'), 5000),
    );
    t.controller.start();
    await t.advance(10000);
    expect(t.times()).toEqual([0, 4500, 9000, 10000]);
    const polls = t.traced('poll');
    expect(polls).toHaveLength(4);
    expect(polls[0]).toMatchObject({
      t: 0,
      wall: SERVER_T0,
      seq: 1,
      reason: 'recover',
      mode: 'adaptive',
      hidden: false,
      tSend: 0,
      tRecv: 0,
      status: 200,
      code: null,
      state: 'waiting',
      position: 21,
      nextPollAfterMs: 5000,
      plannedDelayMs: null,
      actualDelayMs: null,
      baseMs: null,
      u: null,
      changed: true,
    });
    expect(polls[1]).toMatchObject({
      seq: 2,
      reason: 'timer',
      plannedDelayMs: 4500,
      actualDelayMs: 4500,
      baseMs: 5000,
      u: -0.5,
      changed: false,
    });
    expect(polls[2]).toMatchObject({
      seq: 3,
      status: 503,
      code: 'ADMISSION_RECOVERING',
      state: null,
      changed: true,
    });
    expect(polls[3]).toMatchObject({
      seq: 4,
      reason: 'retry',
      plannedDelayMs: 1000,
      actualDelayMs: 1000,
      baseMs: null,
      status: 200,
      changed: true,
    });
  });

  it('records the delay of a poll that was moved out to the hidden interval', async () => {
    const t = tab(api, { mode: 'adaptive', random: () => 0.25 });
    t.onRequest(() => t.ok(entry('waiting'), 5000));
    t.controller.start();
    await t.advance(500);
    t.setHidden(true);
    await t.advance(14500);
    expect(t.times()).toEqual([0, 15000]);
    expect(t.traced('poll')[1]).toMatchObject({
      reason: 'timer',
      hidden: true,
      plannedDelayMs: 15000,
      actualDelayMs: 15000,
      baseMs: 5000,
    });
  });

  it('records a poll that an action pre-empted as aborted, not as answered', async () => {
    const t = tab(api);
    t.onRequest((call) => {
      if (call.method === 'DELETE') return t.ok(cancelled(), null);
      return t.calls.length === 2
        ? new Promise<Reply>(() => undefined)
        : t.ok(entry('waiting'), 5000);
    });
    t.controller.start();
    await t.advance(1200);
    t.controller.cancel();
    await t.flush();
    expect(t.traced('poll-aborted')).toHaveLength(1);
    expect(t.traced('poll-aborted')[0]).toMatchObject({ seq: 2, tSend: 1000, t: 1200 });
    expect(t.traced('poll').map((event) => event.seq)).toEqual([1]);
  });

  it('records visibility, mode and epoch changes and every join, cancel and purchase attempt', async () => {
    const t = tab(api);
    let current: Snapshot | null = null;
    t.onRequest((call) => {
      if (call.method === 'POST') current = entry('waiting');
      if (call.method === 'DELETE') current = cancelled();
      return t.ok(current, current?.state === 'waiting' ? 5000 : null);
    });
    t.controller.start();
    await t.flush();
    t.controller.join();
    await t.flush();
    t.setHidden(true);
    t.setHidden(false);
    t.controller.setMode('adaptive');
    t.controller.cancel();
    await t.flush();
    expect(t.traced('join')[0]).toMatchObject({ status: 200, code: null, tSend: 0, tRecv: 0 });
    expect(t.traced('cancel')[0]).toMatchObject({ status: 200, admissionId: ADMISSION_A });
    expect(t.traced('visibility').map((event) => event.hidden)).toEqual([true, false]);
    expect(t.traced('mode')[0]).toMatchObject({ mode: 'adaptive' });

    const reset = tab(api);
    reset.onRequest(() =>
      reset.calls.length === 1 ? reset.ok(entry('waiting'), 5000) : reset.ok(null, null, EPOCH_2),
    );
    reset.controller.start();
    await reset.advance(1000);
    expect(reset.traced('epoch')[0]).toMatchObject({ from: EPOCH_1, to: EPOCH_2 });

    const buyer = tab(api);
    buyer.onRequest(() =>
      buyer.ok(
        entry('admitted', { admittedAt: iso(SERVER_T0), expiresAt: iso(SERVER_T0 + 30000) }),
        1000,
      ),
    );
    buyer.onPurchase(() =>
      buyer.purchases.length === 1
        ? failure(503, 'ADMISSION_UNAVAILABLE', 1000)
        : { status: 201, data: { id: 'r-1' } },
    );
    buyer.controller.start();
    await buyer.flush();
    buyer.controller.purchase({ ...PURCHASE });
    await buyer.advance(1000);
    expect(buyer.traced('purchase')).toMatchObject([
      { attempt: 1, status: 503, code: 'ADMISSION_UNAVAILABLE', tSend: 0 },
      { attempt: 2, status: 201, code: null, tSend: 1000 },
    ]);
  });

  it('keeps the newest events up to the limit of the trace and counts what it dropped', () => {
    const trace = api.createTrace({ limit: 3, meta: { runId: 'run-1', tabId: 'tab-1' } });
    for (let seq = 1; seq <= 5; seq += 1) trace.push({ type: 'poll', seq });
    const snapshot = trace.snapshot();
    expect(snapshot.meta).toEqual({ runId: 'run-1', tabId: 'tab-1' });
    expect(snapshot.dropped).toBe(2);
    expect(snapshot.events.map((event) => event.seq)).toEqual([3, 4, 5]);
  });
});
