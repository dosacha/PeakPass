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
  // A join is an explicit new attempt, so it is possible only when no entry is active.
  const JOINABLE = Object.freeze(["not-joined", "reset", "consumed", "cancelled", "expired"]);
  const codeOf = (response) =>
    (response.data && response.data.error && response.data.error.code) || null;
  const phaseOf = (admission) =>
    admission.state === "admitted" && admission.phase !== "idle" ? "processing" : admission.state;
  // Not decided, or not decided yet: the same request may be sent again.
  const undecided = (status) => status === 0 || status === 429 || status >= 500;

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
  // context has nowhere to land. Within a context at most one request is in flight, whether it
  // is a status poll, a join, a cancel or a purchase.
  //
  // The server is the only authority. Nothing here joins, or buys with another identity, as a
  // reaction to a response: join() and purchase() run only when the caller calls them.
  function createController(options) {
    const { userId, eventId, transport, sendPurchase, visibility, uuid } = options;
    const onChange = options.onChange || noop;
    const onPurchaseResult = options.onPurchaseResult || noop;
    const pending = options.pending || null;
    const now = options.now || (() => root.performance.now());
    const setTimer = options.setTimer || ((run, ms) => root.setTimeout(run, ms));
    const clearTimer = options.clearTimer || ((id) => root.clearTimeout(id));
    const random = options.random || Math.random;
    const Abort = options.AbortController || root.AbortController;
    const path = "/events/" + eventId + "/admissions";
    const pendingKey = userId + ":" + eventId;

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
    let busy = null; // "join" | "cancel" while that request is in flight
    let intent = null; // the join key of one explicit attempt, bound to its epoch
    let purchase = null; // the frozen purchase request while its outcome is open
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
      busy,
      purchase: purchase && {
        status: purchase.status,
        attempts: purchase.attempts,
        restored: purchase.restored,
      },
      deadlineAt,
      polls,
    });
    const emit = () => {
      if (!disposed) onChange(view());
    };
    const draw = () => 2 * random() - 1;
    const purchasing = () => purchase !== null && purchase.status !== "unconfirmed";
    const idle = () => started && !disposed && !busy && !purchase;
    // A join or cancel is a request to the queue API and respects its error wait.
    const ready = () => idle() && notBefore <= now();

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

    // An explicit action takes the place of a status poll, in flight or scheduled.
    function preempt() {
      drop();
      unschedule();
    }

    function poll() {
      if (disposed || flight || purchasing()) return;
      unschedule();
      polls += 1;
      send(
        POLICY.timeoutMs,
        (signal) => transport({ method: "GET", path: path + "/me", signal }),
        (response, timing) => {
          onStatus(response, timing);
          emit();
        },
      );
    }

    // Reads the state again as soon as the queue API may be asked.
    function refresh() {
      if (notBefore > now()) schedule(notBefore - now(), "retry");
      else poll();
    }

    function recovered() {
      failures = 0;
      notBefore = 0;
      problem = null;
    }

    function apply(data, timing) {
      const next = data.admission;
      const before = phase;
      // The previous epoch is gone for good and its order is not restored.
      if (epoch !== null && data.queue.epoch !== epoch) {
        if (admission && (admission.state === "waiting" || admission.state === "admitted"))
          resetPending = true;
      }
      epoch = data.queue.epoch;
      admission = next;
      if (next) resetPending = false;
      phase = next ? phaseOf(next) : resetPending ? "reset" : "not-joined";
      if (phase !== before) notice = null;
      // The admission TTL on the local clock, without trusting the local wall time.
      const left =
        phase === "admitted" ? Date.parse(next.expiresAt) - Date.parse(data.serverTime) : NaN;
      deadlineAt = Number.isFinite(left) ? timing.tRecv + left : null;
    }

    // A normal answer of the status, join or cancel API.
    function accept(data, timing) {
      recovered();
      apply(data, timing);
      if (data.nextPollAfterMs === null) return;
      const hidden = visibility.hidden();
      const u = mode === "adaptive" && !hidden ? draw() : 0;
      schedule(successDelay({ mode, hidden, baseMs: data.nextPollAfterMs, u }), "timer");
    }

    function unqueued() {
      recovered();
      admission = null;
      deadlineAt = null;
      phase = "not-enabled";
    }

    // Keeps every identity and reads the state again after the wait.
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
      if (status === 200 && usable(data, eventId)) accept(data, timing);
      else if (status === 404) unqueued();
      else if (status === 401)
        problem = { kind: "unauthenticated", code: codeOf(response), retryAt: null };
      else if (status === 200 || undecided(status)) fail(response);
      else problem = { kind: "invalid", code: codeOf(response), retryAt: null };
    }

    // A join or cancel that did not succeed. Returns whether the answer is final: an answer
    // that never came, 429 and 5xx keep the identity and wait, anything else is decided and
    // the state is read again at once.
    function refused(response, unconfirmed) {
      const { status } = response;
      if (status === 401) {
        problem = { kind: "unauthenticated", code: codeOf(response), retryAt: null };
        return true;
      }
      if (undecided(status) || status === 200 || status === 201) {
        notice = status === 429 ? codeOf(response) : unconfirmed;
        fail(response);
        return false;
      }
      notice = codeOf(response);
      refresh();
      return true;
    }

    function mutate(kind, request, done) {
      preempt();
      busy = kind;
      notice = null;
      emit();
      send(
        POLICY.timeoutMs,
        (signal) => transport(Object.assign({ signal }, request)),
        (response, timing) => {
          busy = null;
          done(response, timing);
          emit();
        },
      );
    }

    function join() {
      if (!ready() || epoch === null || !JOINABLE.includes(phase)) return false;
      // The key belongs to one attempt in one epoch: a retry of that attempt repeats it, a new
      // attempt after a finished entry or in another epoch gets a new one.
      if (!intent || intent.epoch !== epoch) intent = { epoch, joinRequestId: uuid() };
      const body = { epoch: intent.epoch, joinRequestId: intent.joinRequestId };
      mutate("join", { method: "POST", path, body }, (response, timing) => {
        const { status, data } = response;
        if ((status === 200 || status === 201) && usable(data, eventId)) {
          intent = null;
          accept(data, timing);
        } else if (status === 404) {
          intent = null;
          unqueued();
        } else if (refused(response, "JOIN_UNCONFIRMED")) {
          intent = null;
        }
      });
      return true;
    }

    function cancel() {
      if (!ready() || !admission || (phase !== "waiting" && phase !== "admitted")) return false;
      // The entry is named by the id it has now; an answer for it is never applied to another.
      const target = admission.admissionId;
      const request = {
        method: "DELETE",
        path: path + "/" + target,
        body: { epoch: admission.epoch },
      };
      mutate("cancel", request, (response, timing) => {
        const { status, data } = response;
        const same = status === 200 && usable(data, eventId) && data.admission !== null;
        if (same && data.admission.admissionId === target) accept(data, timing);
        else refused(response, "CANCEL_UNCONFIRMED");
      });
      return true;
    }

    // One attempt of the frozen purchase. Polling stays paused until the outcome is known or
    // the automatic retries are used up.
    function attempt() {
      purchase.status = "sending";
      purchase.attempts += 1;
      emit();
      send(
        POLICY.purchaseTimeoutMs,
        (signal) => sendPurchase(purchase.body, signal),
        (response) => {
          const { status, data } = response;
          if (undecided(status) || codeOf(response) === "ADMISSION_IN_PROGRESS") {
            if (purchase.auto >= POLICY.purchaseAutoRetries) {
              purchase.status = "unconfirmed";
              emit();
              refresh();
              return;
            }
            purchase.auto += 1;
            purchase.status = "retrying";
            const delay = failureDelay({
              failures: purchase.auto,
              hidden: false,
              serverMinMs: data && data.nextPollAfterMs,
              retryAfterMs: response.retryAfterMs,
              u: draw(),
            });
            purchase.timer = setTimer(() => {
              purchase.timer = null;
              attempt();
            }, delay);
            emit();
            return;
          }
          const body = purchase.body;
          purchase = null;
          if (pending) pending.remove(pendingKey);
          onPurchaseResult({ status, data, body });
          emit();
          refresh();
        },
      );
    }

    // The purchase goes to another API and the admission lives only 30 s, so a backoff of the
    // status poll does not hold it back.
    function startPurchase(body) {
      if (!idle() || phase !== "admitted") return false;
      purchase = {
        body: Object.freeze(Object.assign({}, body)),
        status: "sending",
        attempts: 0,
        auto: 0,
        restored: false,
        timer: null,
      };
      // The template of the request, without a token, so that the same request can be
      // repeated after a reload.
      if (pending) pending.set(pendingKey, JSON.stringify({ body: purchase.body }));
      preempt();
      notice = null;
      attempt();
      return true;
    }

    function retryPurchase() {
      if (!started || disposed || busy || !purchase || purchase.status !== "unconfirmed")
        return false;
      preempt();
      purchase.auto = 0;
      attempt();
      return true;
    }

    function restorePurchase() {
      if (!pending) return;
      try {
        const saved = JSON.parse(pending.get(pendingKey));
        const body = saved && saved.body;
        if (!body || body.userId !== userId || body.eventId !== eventId) return;
        purchase = {
          body: Object.freeze(body),
          status: "unconfirmed",
          attempts: 0,
          auto: POLICY.purchaseAutoRetries,
          restored: true,
          timer: null,
        };
      } catch (error) {
        // An unreadable record is not a purchase.
      }
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
      if (flight || purchasing() || phase === "not-enabled" || notBefore > now()) return;
      schedule(0, "return");
    }

    function start() {
      if (started || disposed) return;
      started = true;
      unsubscribe = visibility.subscribe(onVisibility);
      restorePurchase();
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
      if (purchase && purchase.timer !== null) clearTimer(purchase.timer);
      unsubscribe();
    }

    return { start, join, cancel, purchase: startPurchase, retryPurchase, setMode, view, dispose };
  }

  const api = { POLICY, successDelay, failureDelay, parseRetryAfter, createController };
  root.PeakPassAdmission = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
