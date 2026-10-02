# P6 waiting screen and fixed/adaptive polling implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Main implements; any agent investigates or reviews read-only.

**Goal:** Connect the live mode of the existing frontend to the admission queue: register, wait, be admitted and hand the admission to the existing booking flow, with a fixed and an adaptive polling mode on the same API and the instrumentation P8 needs.

**Architecture:** One plain script, `frontend/admission-polling.js`, holds the delay policy as pure functions and a controller that owns every admission request of a tab. Clock, timers, randomness, transport, visibility and storage are injected, so the same file runs in the browser and, through `vm`, in a Jest unit test. React only subscribes to the controller's view. The server stays the only authority: state is always recovered by `GET /events/:eventId/admissions/me` with the current JWT.

**Tech Stack:** Build-less static frontend (React 18 UMD and Babel standalone from a CDN), plain JavaScript, existing Jest with ts-jest, the installed `agent-browser` CLI for the real-browser checks.

**Spec:** ../../ADMISSION_CONTRACT.md (admission-v1, accepted `87959cd84dbb231caa88fee2e4ad4bcd84115246`, LF blob SHA256 `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`) §3, §7, §8 A14/A15 and §10; ../../ISSUE_13_VALIDATION.md ("P6 API handoff"); ../../ISSUE_14_VALIDATION.md ("Purchase interface for P6", "Activation and release"); Issue #15. The design was explained in chat on 2026-10-03 and the user answered "proceed as recommended"; the decisions below are that answer.

## Decisions (user, 2026-10-03)

- D1 The queue is a separate card between step 2 and step 3, without a step number and only in live mode. The seven steps, their keys and the progress bar do not change.
- D2 Mock mode has no queue. The card is not rendered there and no trace is produced.
- D3 The default polling mode is adaptive. `?poll=fixed|adaptive` in the URL wins over the stored choice; the card has a toggle.
- D4 The runnable state check is a Jest unit test that loads the frontend script through `vm`. It runs in `npm test` and therefore in CI.
- D5 The real-browser checks use the globally installed `agent-browser` CLI. No dependency is added; the scripts live outside the repository and in the evidence archive.
- D6 Two users are produced by two application processes that differ only in `DEMO_USER_EMAIL` and share PostgreSQL and Redis; the browser switches the API base.
- D7 A response lost after the commit is produced by a small local proxy script between browser and application.
- D8 No backend change. A cross-origin page cannot read `Retry-After`; it uses the body's `nextPollAfterMs`, from which the server derives that header.
- D9 A purchase whose outcome is unknown is kept as a request template in `sessionStorage` (no token), so the same request can be repeated after a reload.
- D10 No third polling mode for a jitter-only comparison.
- D11 Five implementation choices the contract text does not fix are recorded as P6 behaviour, without a contract revision: a visibility return does not shorten an error wait; the hidden interval has no jitter; 5xx and timeouts use the 503 backoff; polling pauses while a purchase request is in flight; a purchase request times out after 10 s.

Defaults applied without objection: step 4 sends no admission fields; changing the event and Reset do not cancel the server-side entry; cancel asks for an inline confirmation; the request log shows joins, cancels, purchases and only those polls that changed the state; commits are local, one per task; push, PR and review requests are asked again after local verification.

## Global constraints

- Contract text and every file under `src/` except the new unit test do not change. No new dependency. No push, PR, merge or deployment.
- The frontend stays build-less. `admission-polling.js` uses no React, DOM or `window` API directly; everything environmental is injected.
- Polling values come from contract §7: fixed 1000 ms; adaptive `clamp(base × (1 + u), 1000, 5000)` with `u` uniform in [-0.2, +0.2]; hidden 15000 ms in both modes and one request on return; next timer only after the previous request completed; request timeout 5 s; failure backoff 1 → 2 → 4 → 8 → 15 s with ±20% jitter capped at 15 s and reset by a normal response; for 429 and 503 the wait is `max(backoff, Retry-After, nextPollAfterMs)` and a longer server minimum wins over the cap.
- One request at a time per tab among status, join, cancel and purchase.
- No code path sends a join, or a purchase with another body or key, without an explicit user action. A response handler never calls join.
- A response is applied only when it belongs to the request the controller currently has in flight; a disposed controller applies nothing.
- The JWT stays in memory. Browser storage holds preferences, the recognition markers and the pending purchase template, and is never used to decide the queue state.
- `DemoFlow` must still render when the new state is absent: `frontend/task21-contract-check.html` and `frontend/task22-keyboard-check.html` keep passing.
- Tests run on resources owned by this task (PostgreSQL 16, Redis 7 with AOF/RDB off and noeviction), labelled `peakpass.task=peakpass-p6-20261003`. The integration suite and the browser environment use separate Redis instances and databases, because an active scheduler removes admission keys it does not own.
- No number is reported that was not measured. P6 claims no polling improvement.

## Review focus

- A late response of an earlier context or request (user A → B → A, a cancel that timed out before a new join, a GET pre-empted by a mutation) must never change the current state.
- No second request may start while one is in flight, whatever the order of timers, visibility changes, mode switches and clicks.
- No request may be sent inside a wait the server asked for: not by a visibility return, not by a mode switch.
- Expiry, reset, a 410 or an unknown purchase outcome must not lead to an automatic join or to a purchase with another identity.
- The first recognition of an admission is counted once: repeated polls and a reload do not count again, and a hidden, reconnecting or missed recognition is recorded, not dropped.

## Task 0: Baseline

- [x] Re-check origin/main, the contract hash and the issue gates. `npm ci`. Owned PostgreSQL and two Redis instances with the task label; credentials in files outside the repository.
- [x] Record build, typecheck, lint and unit results before any change.

## Task 1: Delay policy

Files: new `frontend/admission-polling.js`; new test `src/tests/unit/admission-polling.test.ts`.
Interfaces (all on `globalThis.PeakPassAdmission`, and `module.exports` when it exists):
- `POLICY`: `{ fixedMs: 1000, minMs: 1000, maxMs: 5000, hiddenMs: 15000, timeoutMs: 5000, purchaseTimeoutMs: 10000, backoffMs: [1000, 2000, 4000, 8000, 15000], backoffCapMs: 15000, jitter: 0.2, purchaseAutoRetries: 4 }`.
- `successDelay({ mode, hidden, baseMs, u }): number` — `mode` is `'fixed' | 'adaptive'`, `u` is a draw in [-1, 1).
- `failureDelay({ failures, hidden, serverMinMs, retryAfterMs, u }): number` — `failures` counts from 1.
- `parseRetryAfter(value): number | null` — delta-seconds to milliseconds.
- [x] Failing tests: fixed is 1000 whatever the base; adaptive jitters and clamps at both bounds; hidden is 15000 in both modes; the backoff steps with jitter and cap; a server minimum or `Retry-After` beyond 15 s wins; header parsing.
- [x] Implement; the file passes.

## Task 2: Polling controller

Files: `frontend/admission-polling.js`, `src/tests/unit/admission-polling.test.ts`.
Interfaces:
- `createController(options)` with `options = { userId, eventId, mode, transport, sendPurchase, onChange, onTrace, onPurchaseResult, now, setTimer, clearTimer, random, uuid, AbortController, visibility, pending, seen }`.
  - `transport({ method, path, body, signal }): Promise<{ status, data, retryAfterMs }>`; status 0 means no response.
  - `visibility = { hidden(): boolean, subscribe(listener): unsubscribe }`.
- Returns `{ start(), join(), cancel(), purchase(body), retryPurchase(), setMode(mode), view(), dispose() }`.
- `view()` is `{ phase, problem, notice, admission, epoch, mode, busy, purchase, deadlineAt, nextPollAt, polls }` with `phase` one of `loading | not-enabled | not-joined | waiting | admitted | processing | consumed | cancelled | expired | reset` and `problem` either null or `{ kind: 'network' | 'unavailable' | 'rate-limited' | 'unauthenticated' | 'invalid', code, retryAt }`.
- [ ] Failing tests: start recovers by one GET and sends no POST; the next request starts only after the previous one completed; a request without an answer is aborted after 5 s and retried with backoff while at most one request is in flight; an unprotected event (404) stops polling; hidden polls every 15 s and a return sends exactly one request; a visibility return or a mode switch inside an error wait sends nothing (a 503 with a 15 s server minimum: no request for 15 s, same admission afterwards); 429 honours `Retry-After`; failures escalate and a success resets them; a mode switch keeps the admission and sends no join; dispose aborts the request and clears every timer; a late response of a disposed controller (user A → B → A) is not applied and the second A controller starts with its own GET; a response with another epoch reports `reset` and sends no join.
- [ ] Implement; verify.

## Task 3: Join, cancel and purchase

Files: `frontend/admission-polling.js`, `src/tests/unit/admission-polling.test.ts`.
Interfaces:
- `join()`: POST `{ epoch, joinRequestId }`; the key belongs to one intent and to `(user, event, epoch)`.
- `cancel()`: DELETE with the admission id and epoch captured at the call.
- `purchase(body)`: freezes `body`, calls `sendPurchase(body, signal): Promise<{ status, data }>`, reports through `onPurchaseResult({ status, data, body })`.
- `retryPurchase()`: sends the frozen body again after the automatic retries ended.
- `pending = { get(key), set(key, value), remove(key) }` with key `userId:eventId`.
- [ ] Failing tests: a join whose response is lost reuses its key, a join after a terminal state uses a new one; 409 `ACTIVE_ADMISSION_EXISTS` adopts the returned snapshot without another POST; a mutation pre-empts the in-flight GET and that GET's late response is ignored; a cancel that timed out does not change the admission joined afterwards; a purchase sends the frozen body while polling is paused and one GET follows its result; an unknown outcome repeats the identical body after 1, 2, 4 and 8 s, never joins, then reports `unconfirmed` and refuses join until `retryPurchase` resolves it; 410, 409 mismatch and a business rejection end without a retry; a pending purchase is restored after a reload for the same user and event only.
- [ ] Implement; verify.

## Task 4: Instrumentation

Files: `frontend/admission-polling.js`, `src/tests/unit/admission-polling.test.ts`.
Interfaces:
- `createTrace({ limit, meta }): { push(event), snapshot() }`; `snapshot()` returns `{ meta, dropped, events }`.
- Trace events through `onTrace`: `poll`, `poll-aborted`, `join`, `cancel`, `purchase`, `visibility`, `mode`, `epoch`, `recognition`, `recognition-missed`.
- `seen = { has(key), add(key) }` with key `epoch:admissionId`.
- `recognition` carries `{ epoch, admissionId, serverDeltaMs, tSend, tRecv, tApply, lowerMs, upperMs, hiddenAtApply, visibleAtPromotion, hiddenBetween, failuresBefore, viaRecover, layer }` with `layer` one of `foreground | hidden | reconnect`.
- [ ] Failing tests: the first admitted application records one sample whose bounds are `serverTime − admittedAt` plus the time from receipt, and from send, to application; repeated polls and a reload record nothing more; hidden, failures and a first response after start give the `hidden` and `reconnect` layers; a terminal entry with `admittedAt` that was never applied records `recognition-missed` once; every poll records mode, base, jitter draw, planned and actual delay; the trace is bounded and counts what it dropped.
- [ ] Implement; verify.

## Task 5: Queue card and booking connection

Files: `frontend/index.html`, `frontend/app.jsx`, `frontend/app-flow.jsx`, `frontend/styles.css`.
Interfaces:
- `callLive(apiBase, method, path, body, headers, isGraphQL, signal)` also returns `retryAfterMs`.
- `App` creates one controller per `(mode, apiBase, selectedEventId, live user)`, disposes it when any of them changes, and exposes `state.admission` (the view), `state.pollMode` and actions `joinQueue`, `cancelQueue`, `retryPurchase`, `setPollMode`.
- `window.PeakPassAdmissionTrace.snapshot()` returns the page's trace with `{ runId, tabId }`.
- `QueueCard` in `app-flow.jsx`; `StepCard` accepts an optional `statusLabel`.
- [ ] Load the script; add timeout, abort and `Retry-After` to the live transport.
- [ ] Controller lifecycle with automatic recovery on load; polling mode from the URL, storage and the toggle.
- [ ] Step 3 sends `{admissionId, admissionEpoch}` when admitted, through the controller, and stays disabled for a protected event until then; step 4 is unchanged.
- [ ] Queue card: states, fixed-user notice, join, cancel with confirmation, retry of an unconfirmed purchase, live regions, title change on admission.
- [ ] Both existing check pages pass; `npm test` passes.

## Task 6: Real browser, HTTP and Redis

Outside the repository: environment files, the activation script, the filler-user script, the proxy and the browser command files.
- [ ] Two application processes on the browser database and its Redis, a protected event made by the explicit transition (exclusive gate, real UPDATE), filler users over HTTP.
- [ ] Scenarios: join → wait → admit → reserve → checkout in both modes; reload; hidden and return; offline and return; real 503 from an instance restarted with the feature off; 429; cancel, re-join and a late cancel; expiry in real time; user A → B → A and event change; epoch change; response lost after commit.
- [ ] For each: the page trace, the request list without tokens, the application log, Redis reads and the final SQL invariant.

## Task 7: Regression, evidence and handoff

Files: new `docs/ISSUE_15_VALIDATION.md`, `docs/README.md`, `test-results/admission-v1/p6-*.{json,zip}`.
- [ ] Build, typecheck, lint, unit, full integration, harness and callback checks on the owned test resources.
- [ ] Record commands, results, evidence kinds, the D11 choices, what stays unverified and the notes for P7 and P8. Commit locally; report the review scope; no push.

## Execution ledger

- Base `2d67cc3c10a1d04bebe0a7a81f9575ea39e63363` (origin/main rechecked 2026-10-03, no open PR). Contract hash unchanged. Worktree `claude/issue-15-p6-waiting-polling`, created with `--no-track`; the user's main checkout and every other worktree untouched.
- Ruling: the user's "proceed as recommended" after the reviewed chat design is the execution instruction and approves the plan, `npm ci`, the owned resources and local commits per task. The accepted contract and that design are the spec, so no separate spec or plan approval stage is added, as in P5. Push, PR and independent review remain unapproved.
- Ruling: the ledger is this section and the working files are in the run directory outside the repository, as in P5, instead of a `.superpowers` workspace inside the worktree — the repository's own convention for these phases — cost if wrong: none for the code; a later executor reads this section instead of a workspace file.
- Owned resources (run `peakpass-p6-20261003`): PostgreSQL 16.12 with the databases `peakpass_test` and `peakpass_browser`, and two Redis 7.4.8 instances (save "", appendonly no, noeviction, 256MiB), one for the integration suite and one for the browser environment, on Docker-chosen loopback ports, label `peakpass.task=peakpass-p6-20261003`. Credentials are kept in files outside the repository.
- Task 0: baseline at `2d67cc3` before any change — build and typecheck passed, lint 0 errors/11 warnings, unit 160/160 (22 suites). The full integration suite is run once at the end (Task 7).
