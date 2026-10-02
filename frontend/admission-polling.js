// Admission queue polling for the live mode (admission-v1 §3 and §7).
//
// A plain script: index.html loads it next to React, and the unit test loads the same file
// through vm. It uses no DOM, window or network API of its own. The caller injects the clock,
// timers, randomness, transport, visibility and storage.
(function (root) {
  "use strict";

  const POLICY = Object.freeze({
    fixedMs: 1000,
    minMs: 1000,
    maxMs: 5000,
    hiddenMs: 15000,
    timeoutMs: 5000,
    purchaseTimeoutMs: 10000,
    backoffMs: Object.freeze([1000, 2000, 4000, 8000, 15000]),
    backoffCapMs: 15000,
    jitter: 0.2,
    purchaseAutoRetries: 4,
  });

  const jittered = (ms, u) => ms * (1 + POLICY.jitter * u);
  const positive = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

  // Wait after a normal response. `u` is a uniform draw in [-1, 1).
  function successDelay({ mode, hidden, baseMs, u }) {
    if (hidden) return POLICY.hiddenMs;
    if (mode === "fixed") return POLICY.fixedMs;
    const base = positive(baseMs) || POLICY.maxMs;
    return Math.round(Math.min(POLICY.maxMs, Math.max(POLICY.minMs, jittered(base, u))));
  }

  // Wait after a failure: no response, a timeout, 429 or 5xx. `failures` counts from 1.
  // A minimum the server asks for wins, also when it is longer than the 15 s cap.
  function failureDelay({ failures, hidden, serverMinMs, retryAfterMs, u }) {
    const step = POLICY.backoffMs[Math.min(failures, POLICY.backoffMs.length) - 1];
    const backoff = Math.min(POLICY.backoffCapMs, jittered(step, u));
    return Math.round(
      Math.max(backoff, hidden ? POLICY.hiddenMs : 0, positive(serverMinMs), positive(retryAfterMs)),
    );
  }

  // ponytail: delta-seconds only, which is what the server sends. An HTTP-date is ignored;
  // parse it here if a proxy in front of the API ever answers with one.
  function parseRetryAfter(value) {
    const text = value == null ? "" : String(value).trim();
    return /^\d+$/.test(text) ? Number(text) * 1000 : null;
  }

  const noop = () => {};
  const NO_RESPONSE = Object.freeze({ status: 0, data: null, retryAfterMs: null });
  const codeOf = (response) =>
    (response.data && response.data.error && response.data.error.code) || null;
  const phaseOf = (admission) =>
    admission.state === "admitted" && admission.phase !== "idle" ? "processing" : admission.state;

  // A status body is usable when it is about this event and its admission is of the queue epoch.
  function usable(data, eventId) {
    const queue = data && data.queue;
    if (!queue || typeof queue.epoch !== "string") return false;
    if (String(queue.eventId).toLowerCase() !== eventId.toLowerCase()) return false;
    const admission = data.admission;
    return admission === null || (typeof admission === "object" && admission.epoch === queue.epoch);
  }

  // One controller serves one context: one user on one event against one API base. The caller
  // disposes it and creates another when any of those changes, so a response of an earlier
  // context has nowhere to land. Within a context at most one request is in flight.
  function createController(options) {
    const { eventId, transport, visibility } = options;
    const onChange = options.onChange || noop;
    const now = options.now || (() => root.performance.now());
    const setTimer = options.setTimer || ((run, ms) => root.setTimeout(run, ms));
    const clearTimer = options.clearTimer || ((id) => root.clearTimeout(id));
    const random = options.random || Math.random;
    const Abort = options.AbortController || root.AbortController;
    const path = "/events/" + eventId + "/admissions";

    let mode = options.mode === "fixed" ? "fixed" : "adaptive";
    let started = false;
    let disposed = false;
    let flight = null; // the one request in flight
    let pollTimer = null;
    let pollDue = 0;
    let pollReason = null;
    let lastDone = 0; // when the last request completed, on the injected clock
    let notBefore = 0; // an error wait: no request before this time
    let failures = 0;
    let polls = 0;
    let epoch = null;
    let admission = null;
    let phase = "loading";
    let problem = null;
    let notice = null;
    let resetPending = false;
    let deadlineAt = null;
    let unsubscribe = noop;

    const view = () => ({
      phase,
      problem,
      notice,
      admission,
      epoch,
      mode,
      busy: null,
      purchase: null,
      deadlineAt,
      polls,
    });
    const emit = () => {
      if (!disposed) onChange(view());
    };
    const draw = () => 2 * random() - 1;

    // `done` runs only for the request that is still the current one. A request that timed
    // out, was pre-empted or belongs to a disposed controller never reaches it.
    function send(timeoutMs, request, done) {
      const abort = new Abort();
      const entry = { abort, timeout: null };
      const tSend = now();
      const finish = (response) => {
        if (flight !== entry) return;
        clearTimer(entry.timeout);
        flight = null;
        lastDone = now();
        done(response, { tSend, tRecv: lastDone });
      };
      flight = entry;
      entry.timeout = setTimer(() => {
        if (flight !== entry) return;
        abort.abort();
        finish(NO_RESPONSE);
      }, timeoutMs);
      Promise.resolve()
        .then(() => request(abort.signal))
        .then(finish, () => finish(NO_RESPONSE));
    }

    function drop() {
      if (!flight) return;
      clearTimer(flight.timeout);
      flight.abort.abort();
      flight = null;
    }

    function unschedule() {
      if (pollTimer === null) return;
      clearTimer(pollTimer);
      pollTimer = null;
    }

    function schedule(delayMs, reason) {
      unschedule();
      pollDue = now() + delayMs;
      pollReason = reason;
      pollTimer = setTimer(() => {
        pollTimer = null;
        poll(reason);
      }, delayMs);
    }

    function poll() {
      if (disposed || flight) return;
      unschedule();
      polls += 1;
      send(
        POLICY.timeoutMs,
        (signal) => transport({ method: "GET", path: path + "/me", signal }),
        onStatus,
      );
    }

    function recovered() {
      failures = 0;
      notBefore = 0;
      problem = null;
    }

    function apply(data, timing) {
      const next = data.admission;
      // The previous epoch is gone for good and its order is not restored.
      if (epoch !== null && data.queue.epoch !== epoch) {
        if (admission && (admission.state === "waiting" || admission.state === "admitted"))
          resetPending = true;
      }
      epoch = data.queue.epoch;
      admission = next;
      if (next) resetPending = false;
      phase = next ? phaseOf(next) : resetPending ? "reset" : "not-joined";
      // The admission TTL on the local clock, without trusting the local wall time.
      const left =
        phase === "admitted" ? Date.parse(next.expiresAt) - Date.parse(data.serverTime) : NaN;
      deadlineAt = Number.isFinite(left) ? timing.tRecv + left : null;
    }

    function fail(response) {
      failures += 1;
      const delay = failureDelay({
        failures,
        hidden: visibility.hidden(),
        serverMinMs: response.data && response.data.nextPollAfterMs,
        retryAfterMs: response.retryAfterMs,
        u: draw(),
      });
      notBefore = now() + delay;
      problem = {
        kind: response.status === 429 ? "rate-limited" : response.status === 0 ? "network" : "unavailable",
        code: response.status === 200 ? "PROTOCOL" : codeOf(response),
        retryAt: notBefore,
      };
      schedule(delay, "retry");
    }

    function onStatus(response, timing) {
      const { status, data } = response;
      if (status === 200 && usable(data, eventId)) {
        recovered();
        apply(data, timing);
        if (data.nextPollAfterMs !== null) {
          const hidden = visibility.hidden();
          const u = mode === "adaptive" && !hidden ? draw() : 0;
          schedule(successDelay({ mode, hidden, baseMs: data.nextPollAfterMs, u }), "timer");
        }
      } else if (status === 404) {
        recovered();
        admission = null;
        deadlineAt = null;
        phase = "not-enabled";
      } else if (status === 401) {
        problem = { kind: "unauthenticated", code: codeOf(response), retryAt: null };
      } else if (status === 0 || status === 200 || status === 429 || status >= 500) {
        fail(response);
      } else {
        problem = { kind: "invalid", code: codeOf(response), retryAt: null };
      }
      emit();
    }

    function onVisibility() {
      if (disposed) return;
      if (visibility.hidden()) {
        // A pending poll moves out to the hidden interval. It never moves earlier.
        if (pollTimer !== null)
          schedule(Math.max(pollDue, lastDone + POLICY.hiddenMs) - now(), pollReason);
        return;
      }
      // One request on return. An error wait keeps its time, and an event without a queue is
      // not probed again.
      if (flight || phase === "not-enabled" || notBefore > now()) return;
      schedule(0, "return");
    }

    function start() {
      if (started || disposed) return;
      started = true;
      unsubscribe = visibility.subscribe(onVisibility);
      emit();
      poll();
    }

    function setMode(next) {
      if (disposed || next === mode || (next !== "fixed" && next !== "adaptive")) return;
      mode = next;
      emit();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      drop();
      unschedule();
      unsubscribe();
    }

    return { start, setMode, view, dispose };
  }

  const api = { POLICY, successDelay, failureDelay, parseRetryAfter, createController };
  root.PeakPassAdmission = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
