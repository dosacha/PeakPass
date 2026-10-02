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
}

function load(): Api {
  const context = vm.createContext({});
  vm.runInContext(readFileSync('frontend/admission-polling.js', 'utf8'), context, {
    filename: 'frontend/admission-polling.js',
  });
  return (context as unknown as { PeakPassAdmission: Api }).PeakPassAdmission;
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
