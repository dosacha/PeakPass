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

  const api = { POLICY, successDelay, failureDelay, parseRetryAfter };
  root.PeakPassAdmission = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
