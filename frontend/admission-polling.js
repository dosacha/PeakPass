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

  // What one page did, for the measurements of admission-v1 §7.
  // ponytail: a ring of `limit` events. What it pushes out is counted in `dropped`, so a
  // truncated trace is visible; export it before a long session overruns the limit.
  function createTrace({ limit, meta }) {
    const events = [];
    let dropped = 0;
    return {
      push(event) {
        events.push(event);
        if (events.length > limit) {
          events.shift();
          dropped += 1;
        }
      },
      snapshot: () => ({ meta, dropped, events: events.slice() }),
    };
  }

  const noop = () => {};
  const NO_RESPONSE = Object.freeze({ status: 0, data: null, retryAfterMs: null });
  const TIMED_OUT = Object.freeze({ status: 0, data: null, retryAfterMs: null, timedOut: true });
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

  function memoryMarkers() {
    const keys = new Set();
    return { has: (key) => keys.has(key), add: (key) => void keys.add(key) };
  }

  // One controller serves one context: one user on one event against one API base. The caller
  // disposes it and creates another when any of those changes, so a response of an earlier
  // context has nowhere to land. Within a context at most one request is in flight, whether it
  // is a status poll, a join, a cancel or a purchase.
  //
  // The server is the only authority. Nothing here joins, or buys with another identity, as a
  // reaction to a response: join() and purchase() run only when the caller calls them.
  function createController(options) {
    const { apiBase, userId, eventId, transport, sendPurchase, visibility, uuid } = options;
    const onChange = options.onChange || noop;
    const onTrace = options.onTrace || noop;
    const onPurchaseResult = options.onPurchaseResult || noop;
    const pending = options.pending || null;
    const seen = options.seen || memoryMarkers();
    const now = options.now || (() => root.performance.now());
    const wall = options.wall || (() => Date.now());
    const setTimer = options.setTimer || ((run, ms) => root.setTimeout(run, ms));
    const clearTimer = options.clearTimer || ((id) => root.clearTimeout(id));
    const random = options.random || Math.random;
    const Abort = options.AbortController || root.AbortController;
    const path = "/events/" + eventId + "/admissions";
    // Another server can hold the same user and event ids, so a stored purchase names all three.
    // The base is spelled as the transport sends it: trailing slashes do not make another server.
    const pendingKey = JSON.stringify([String(apiBase).replace(/\/+$/, ""), userId, eventId]);

    let mode = options.mode === "fixed" ? "fixed" : "adaptive";
    let started = false;
    let disposed = false;
    let flight = null; // the one request in flight
    let pollTimer = null;
    let pollDue = 0;
    let pollReason = null;
    let pollPlan = null; // { baseMs, u } behind the scheduled poll, for the trace
    let lastDone = null; // when the last request completed, on the injected clock
    let notBefore = 0; // an error wait: no request before this time
    let failures = 0;
    let polls = 0;
    let applied = 0; // answers applied by this controller
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
    // ponytail: the last 64 visibility changes. A promotion older than the log is filed
    // under reconnect.
    const visibilityLog = [];

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
    const trace = (type, fields) =>
      onTrace(Object.assign({ type, t: now(), wall: wall() }, fields));
    const draw = () => 2 * random() - 1;
    const purchasing = () => purchase !== null && purchase.status !== "unconfirmed";
    const idle = () => started && !disposed && !busy && !purchase;
    // A join or cancel is a request to the queue API and respects its error wait.
    const ready = () => idle() && notBefore <= now();
    const shown = () => phase + "|" + (problem ? problem.kind : "");

    // `done` runs only for the request that is still the current one. A request that timed
    // out, was pre-empted or belongs to a disposed controller never reaches it.
    function send(timeoutMs, request, done, pollSeq) {
      const abort = new Abort();
      const entry = { abort, timeout: null, tSend: now(), pollSeq: pollSeq || null };
      const finish = (response) => {
        if (flight !== entry) return;
        clearTimer(entry.timeout);
        flight = null;
        lastDone = now();
        done(response, { tSend: entry.tSend, tRecv: lastDone });
      };
      flight = entry;
      entry.timeout = setTimer(() => {
        if (flight !== entry) return;
        abort.abort();
        finish(TIMED_OUT);
      }, timeoutMs);
      Promise.resolve()
        .then(() => request(abort.signal))
        .then(finish, () => finish(NO_RESPONSE));
    }

    function drop() {
      if (!flight) return;
      clearTimer(flight.timeout);
      flight.abort.abort();
      if (flight.pollSeq) trace("poll-aborted", { seq: flight.pollSeq, tSend: flight.tSend });
      flight = null;
    }

    function unschedule() {
      if (pollTimer === null) return;
      clearTimer(pollTimer);
      pollTimer = null;
    }

    function schedule(delayMs, reason, plan) {
      unschedule();
      pollDue = now() + delayMs;
      pollReason = reason;
      pollPlan = plan || null;
      pollTimer = setTimer(() => {
        pollTimer = null;
        poll(reason, pollPlan);
      }, delayMs);
    }

    // An explicit action takes the place of a status poll, in flight or scheduled.
    function preempt() {
      drop();
      unschedule();
    }

    function poll(reason, plan) {
      if (disposed || flight || purchasing()) return;
      unschedule();
      polls += 1;
      const seq = polls;
      const sent = { mode, hidden: visibility.hidden(), since: lastDone };
      send(
        POLICY.timeoutMs,
        (signal) => transport({ method: "GET", path: path + "/me", signal }),
        (response, timing) => {
          const before = shown();
          onStatus(response, timing);
          const body = response.status === 200 && usable(response.data, eventId) ? response.data : null;
          const entry = body && body.admission;
          trace("poll", {
            seq,
            reason,
            mode: sent.mode,
            hidden: sent.hidden,
            tSend: timing.tSend,
            tRecv: timing.tRecv,
            status: response.status,
            code: codeOf(response),
            timedOut: response.timedOut === true,
            state: entry ? entry.state : null,
            phase: entry ? entry.phase : null,
            position: entry ? entry.position : null,
            serverTime: body ? body.serverTime : null,
            nextPollAfterMs: body ? body.nextPollAfterMs : null,
            // What the server asked for with a failure: the body's wait and, when the page
            // can read it, Retry-After.
            serverMinMs: body || !response.data ? null : positive(response.data.nextPollAfterMs) || null,
            retryAfterMs: positive(response.retryAfterMs) || null,
            plannedDelayMs: plan ? plan.delayMs : null,
            actualDelayMs: sent.since === null ? null : timing.tSend - sent.since,
            baseMs: plan ? plan.baseMs : null,
            u: plan ? plan.u : null,
            changed: shown() !== before,
          });
          emit();
        },
        seq,
      );
    }

    // Reads the state again as soon as the queue API may be asked.
    function refresh() {
      if (notBefore > now()) schedule(notBefore - now(), "retry");
      else poll("refresh");
    }

    function recovered() {
      failures = 0;
      notBefore = 0;
      problem = null;
    }

    // Visibility at a past time on the local clock; null before the log starts.
    function hiddenAt(time) {
      let state = null;
      for (const item of visibilityLog) {
        if (item.t > time) break;
        state = item.hidden;
      }
      return state;
    }

    function hiddenWithin(from, to) {
      return (
        hiddenAt(from) === true ||
        visibilityLog.some((item) => item.hidden && item.t > from && item.t <= to)
      );
    }

    // admission-v1 §7: one sample per admission, at the first time this browser applies it as
    // admitted. serverTime and admittedAt are the same server clock, so their difference needs
    // no local wall time, and the round trip bounds where that server instant lies locally:
    // the delay is between serverDelta + (apply − receive) and serverDelta + (apply − send).
    // An entry that ended before it was ever applied as admitted is recorded as missed.
    function recognize(entry, serverTime, timing, failuresBefore) {
      const key = entry.epoch + ":" + entry.admissionId;
      if (seen.has(key)) return;
      seen.add(key);
      const serverDeltaMs = Date.parse(serverTime) - Date.parse(entry.admittedAt);
      const tApply = now();
      const identity = { epoch: entry.epoch, admissionId: entry.admissionId };
      if (entry.state !== "admitted") {
        trace("recognition-missed", Object.assign(identity, { state: entry.state, serverDeltaMs, tApply }));
        return;
      }
      // The promotion happened within [from, to] on the local clock.
      const from = timing.tSend - serverDeltaMs;
      const to = timing.tRecv - serverDeltaMs;
      const visibleAtPromotion = hiddenAt(from) === null ? null : !hiddenWithin(from, to);
      const hiddenBetween = hiddenWithin(Math.max(from, visibilityLog[0].t), tApply);
      const hiddenAtApply = visibility.hidden();
      const viaRecover = applied === 0;
      const reconnect = viaRecover || failuresBefore > 0 || visibleAtPromotion === null;
      const hidden = hiddenBetween || hiddenAtApply || visibleAtPromotion === false;
      trace(
        "recognition",
        Object.assign(identity, {
          serverDeltaMs,
          tSend: timing.tSend,
          tRecv: timing.tRecv,
          tApply,
          lowerMs: serverDeltaMs + (tApply - timing.tRecv),
          upperMs: serverDeltaMs + (tApply - timing.tSend),
          hiddenAtApply,
          visibleAtPromotion,
          hiddenBetween,
          failuresBefore,
          viaRecover,
          layer: reconnect ? "reconnect" : hidden ? "hidden" : "foreground",
          mode,
        }),
      );
    }

    function apply(data, timing, failuresBefore) {
      const next = data.admission;
      const before = phase;
      // The previous epoch is gone for good and its order is not restored.
      if (epoch !== null && data.queue.epoch !== epoch) {
        trace("epoch", { from: epoch, to: data.queue.epoch });
        if (admission && (admission.state === "waiting" || admission.state === "admitted"))
          resetPending = true;
      }
      epoch = data.queue.epoch;
      admission = next;
      if (next) resetPending = false;
      // A join key belongs to one attempt. Once the server shows another entry than the one the
      // attempt started from, that attempt is decided, also when its own answer was lost: a
      // later join is a new attempt with a new key.
      if (intent && next && next.admissionId !== intent.from) intent = null;
      phase = next ? phaseOf(next) : resetPending ? "reset" : "not-joined";
      if (phase !== before) notice = null;
      // The admission TTL on the local clock, without trusting the local wall time.
      const left =
        phase === "admitted" ? Date.parse(next.expiresAt) - Date.parse(data.serverTime) : NaN;
      deadlineAt = Number.isFinite(left) ? timing.tRecv + left : null;
      if (next && next.admittedAt) recognize(next, data.serverTime, timing, failuresBefore);
      applied += 1;
    }

    // A normal answer of the status, join or cancel API.
    function accept(data, timing) {
      const failuresBefore = failures;
      recovered();
      apply(data, timing, failuresBefore);
      if (data.nextPollAfterMs === null) return;
      const hidden = visibility.hidden();
      const u = mode === "adaptive" && !hidden ? draw() : 0;
      const baseMs = data.nextPollAfterMs;
      const delayMs = successDelay({ mode, hidden, baseMs, u });
      schedule(delayMs, "timer", { baseMs, u, delayMs });
    }

    function unqueued() {
      recovered();
      admission = null;
      deadlineAt = null;
      phase = "not-enabled";
    }

    // Keeps every identity and reads the state again after the wait. The wait is what the
    // failure itself asks for: the backoff and a server minimum. A tab that stays hidden
    // retries no sooner than its interval, but that interval is not part of the wait, so it
    // does not hold back the request on return.
    function fail(response) {
      failures += 1;
      const u = draw();
      const asked = {
        failures,
        serverMinMs: response.data && response.data.nextPollAfterMs,
        retryAfterMs: response.retryAfterMs,
        u,
      };
      const wait = failureDelay(Object.assign({ hidden: false }, asked));
      const delay = failureDelay(Object.assign({ hidden: visibility.hidden() }, asked));
      notBefore = now() + wait;
      problem = {
        kind: response.status === 429 ? "rate-limited" : response.status === 0 ? "network" : "unavailable",
        code: response.status === 200 ? "PROTOCOL" : codeOf(response),
        retryAt: notBefore,
      };
      schedule(delay, "retry", { baseMs: null, u, delayMs: delay });
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

    function mutate(kind, request, detail, done) {
      preempt();
      busy = kind;
      notice = null;
      emit();
      send(
        POLICY.timeoutMs,
        (signal) => transport(Object.assign({ signal }, request)),
        (response, timing) => {
          busy = null;
          trace(
            kind,
            Object.assign(
              {
                tSend: timing.tSend,
                tRecv: timing.tRecv,
                status: response.status,
                code: codeOf(response),
              },
              detail,
            ),
          );
          done(response, timing);
          emit();
        },
      );
    }

    function join() {
      if (!ready() || epoch === null || !JOINABLE.includes(phase)) return false;
      // The key belongs to one attempt in one epoch: a retry of that attempt repeats it, a new
      // attempt after a finished entry or in another epoch gets a new one.
      if (!intent || intent.epoch !== epoch)
        intent = { epoch, joinRequestId: uuid(), from: admission ? admission.admissionId : null };
      const body = { epoch: intent.epoch, joinRequestId: intent.joinRequestId };
      mutate("join", { method: "POST", path, body }, { epoch: intent.epoch }, (response, timing) => {
        const { status, data } = response;
        // A usable answer shows the entry of this attempt, which ends its key (see apply).
        if ((status === 200 || status === 201) && usable(data, eventId)) {
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
      mutate("cancel", request, { admissionId: target }, (response, timing) => {
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
        (response, timing) => {
          const { status, data } = response;
          trace("purchase", {
            attempt: purchase.attempts,
            tSend: timing.tSend,
            tRecv: timing.tRecv,
            status,
            code: codeOf(response),
          });
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

    // The page the purchase belongs to was cleared. An attempt still out is dropped and no
    // repeat follows; the request waits as unconfirmed for its button. The status polling
    // resumes as after the last automatic repeat, so a wait the server asked for still holds.
    function stopPurchase() {
      if (disposed || !purchasing()) return false;
      drop();
      if (purchase.timer !== null) clearTimer(purchase.timer);
      purchase.timer = null;
      purchase.status = "unconfirmed";
      emit();
      refresh();
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
      const hidden = visibility.hidden();
      visibilityLog.push({ t: now(), hidden });
      if (visibilityLog.length > 64) visibilityLog.shift();
      trace("visibility", { hidden });
      if (hidden) {
        // A pending poll moves out to the hidden interval. It never moves earlier.
        if (pollTimer !== null) {
          const due = Math.max(pollDue, lastDone + POLICY.hiddenMs);
          const plan = pollPlan && Object.assign({}, pollPlan, { delayMs: Math.round(due - lastDone) });
          schedule(due - now(), pollReason, plan);
        }
        return;
      }
      // One request on return. A wait after a failure keeps its time: the retry comes at its
      // end, also when the hidden interval had moved it further out. An event without a queue
      // is not probed again.
      if (flight || purchasing() || phase === "not-enabled") return;
      if (notBefore > now()) {
        if (pollTimer !== null && pollDue > notBefore) {
          const plan = pollPlan && Object.assign({}, pollPlan, { delayMs: Math.round(notBefore - lastDone) });
          schedule(notBefore - now(), pollReason, plan);
        }
        return;
      }
      schedule(0, "return");
    }

    function start() {
      if (started || disposed) return;
      started = true;
      visibilityLog.push({ t: now(), hidden: visibility.hidden() });
      unsubscribe = visibility.subscribe(onVisibility);
      restorePurchase();
      emit();
      poll("recover");
    }

    function setMode(next) {
      if (disposed || next === mode || (next !== "fixed" && next !== "adaptive")) return;
      mode = next;
      trace("mode", { mode });
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

    return { start, join, cancel, purchase: startPurchase, retryPurchase, stopPurchase, setMode, view, dispose };
  }

  const api = {
    POLICY,
    successDelay,
    failureDelay,
    parseRetryAfter,
    createTrace,
    createController,
  };
  root.PeakPassAdmission = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
