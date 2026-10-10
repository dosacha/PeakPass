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
- [x] Failing tests: start recovers by one GET and sends no POST; the next request starts only after the previous one completed; a request without an answer is aborted after 5 s and retried with backoff while at most one request is in flight; an unprotected event (404) stops polling; hidden polls every 15 s and a return sends exactly one request; a visibility return or a mode switch inside an error wait sends nothing (a 503 with a 15 s server minimum: no request for 15 s, same admission afterwards); 429 honours `Retry-After`; failures escalate and a success resets them; a mode switch keeps the admission and sends no join; dispose aborts the request and clears every timer; a late response of a disposed controller (user A → B → A) is not applied and the second A controller starts with its own GET; a response with another epoch reports `reset` and sends no join.
- [x] Implement; verify.

## Task 3: Join, cancel and purchase

Files: `frontend/admission-polling.js`, `src/tests/unit/admission-polling.test.ts`.
Interfaces:
- `join()`: POST `{ epoch, joinRequestId }`; the key belongs to one intent and to `(user, event, epoch)`.
- `cancel()`: DELETE with the admission id and epoch captured at the call.
- `purchase(body)`: freezes `body`, calls `sendPurchase(body, signal): Promise<{ status, data }>`, reports through `onPurchaseResult({ status, data, body })`.
- `retryPurchase()`: sends the frozen body again after the automatic retries ended.
- `pending = { get(key), set(key, value), remove(key) }` with key `userId:eventId`.
- [x] Failing tests: a join whose response is lost reuses its key, a join after a terminal state uses a new one; 409 `ACTIVE_ADMISSION_EXISTS` adopts the returned snapshot without another POST; a mutation pre-empts the in-flight GET and that GET's late response is ignored; a cancel that timed out does not change the admission joined afterwards; a purchase sends the frozen body while polling is paused and one GET follows its result; an unknown outcome repeats the identical body after 1, 2, 4 and 8 s, never joins, then reports `unconfirmed` and refuses join until `retryPurchase` resolves it; 410, 409 mismatch and a business rejection end without a retry; a pending purchase is restored after a reload for the same user and event only.
- [x] Implement; verify.

## Task 4: Instrumentation

Files: `frontend/admission-polling.js`, `src/tests/unit/admission-polling.test.ts`.
Interfaces:
- `createTrace({ limit, meta }): { push(event), snapshot() }`; `snapshot()` returns `{ meta, dropped, events }`.
- Trace events through `onTrace`: `poll`, `poll-aborted`, `join`, `cancel`, `purchase`, `visibility`, `mode`, `epoch`, `recognition`, `recognition-missed`.
- `seen = { has(key), add(key) }` with key `epoch:admissionId`.
- `recognition` carries `{ epoch, admissionId, serverDeltaMs, tSend, tRecv, tApply, lowerMs, upperMs, hiddenAtApply, visibleAtPromotion, hiddenBetween, failuresBefore, viaRecover, layer }` with `layer` one of `foreground | hidden | reconnect`.
- [x] Failing tests: the first admitted application records one sample whose bounds are `serverTime − admittedAt` plus the time from receipt, and from send, to application; repeated polls and a reload record nothing more; hidden, failures and a first response after start give the `hidden` and `reconnect` layers; a terminal entry with `admittedAt` that was never applied records `recognition-missed` once; every poll records mode, base, jitter draw, planned and actual delay; the trace is bounded and counts what it dropped.
- [x] Implement; verify.

## Task 5: Queue card and booking connection

Files: `frontend/index.html`, `frontend/app.jsx`, `frontend/app-flow.jsx`, `frontend/styles.css`.
Interfaces:
- `callLive(apiBase, method, path, body, headers, isGraphQL, signal)` also returns `retryAfterMs`.
- `App` creates one controller per `(mode, apiBase, selectedEventId, live user)`, disposes it when any of them changes, and exposes `state.admission` (the view), `state.pollMode` and actions `joinQueue`, `cancelQueue`, `retryPurchase`, `setPollMode`.
- `window.PeakPassAdmissionTrace.snapshot()` returns the page's trace with `{ runId, tabId }`.
- `QueueCard` in `app-flow.jsx`; `StepCard` accepts an optional `statusLabel`.
- [x] Load the script; add timeout, abort and `Retry-After` to the live transport.
- [x] Controller lifecycle with automatic recovery on load; polling mode from the URL, storage and the toggle.
- [x] Step 3 sends `{admissionId, admissionEpoch}` when admitted, through the controller, and stays disabled for a protected event until then; step 4 is unchanged.
- [x] Queue card: states, fixed-user notice, join, cancel with confirmation, retry of an unconfirmed purchase, live regions, title change on admission.
- [x] Both existing check pages pass; `npm test` passes.

## Task 6: Real browser, HTTP and Redis

Outside the repository: environment files, the activation script, the filler-user script, the proxy and the browser command files.
- [x] Two application processes on the browser database and its Redis, a protected event made by the explicit transition (exclusive gate, real UPDATE), filler users over HTTP.
- [x] Scenarios: join → wait → admit → reserve → checkout in both modes; reload; hidden and return; offline and return; real 503 from an instance restarted with the feature off; 429; cancel, re-join and a late cancel; expiry in real time; user A → B → A and event change; epoch change; response lost after commit.
- [x] For each: the page trace, the request list without tokens, the application log, Redis reads and the final SQL invariant.

## Task 7: Regression, evidence and handoff

Files: new `docs/ISSUE_15_VALIDATION.md`, `docs/README.md`, `test-results/admission-v1/p6-*.{json,zip}`.
- [x] Build, typecheck, lint, unit, full integration, harness and callback checks on the owned test resources.
- [x] Record commands, results, evidence kinds, the D11 choices, what stays unverified and the notes for P7 and P8. Commit locally; report the review scope; no push.

## Execution ledger

- Base `2d67cc3c10a1d04bebe0a7a81f9575ea39e63363` (origin/main rechecked 2026-10-03, no open PR). Contract hash unchanged. Worktree `claude/issue-15-p6-waiting-polling`, created with `--no-track`; the user's main checkout and every other worktree untouched.
- Ruling: the user's "proceed as recommended" after the reviewed chat design is the execution instruction and approves the plan, `npm ci`, the owned resources and local commits per task. The accepted contract and that design are the spec, so no separate spec or plan approval stage is added, as in P5. Push, PR and independent review remain unapproved.
- Ruling: the ledger is this section and the working files are in the run directory outside the repository, as in P5, instead of a `.superpowers` workspace inside the worktree — the repository's own convention for these phases — cost if wrong: none for the code; a later executor reads this section instead of a workspace file.
- Owned resources (run `peakpass-p6-20261003`): PostgreSQL 16.12 with the databases `peakpass_test` and `peakpass_browser`, and two Redis 7.4.8 instances (save "", appendonly no, noeviction, 256MiB), one for the integration suite and one for the browser environment, on Docker-chosen loopback ports, label `peakpass.task=peakpass-p6-20261003`. Credentials are kept in files outside the repository.
- Task 0: baseline at `2d67cc3` before any change — build and typecheck passed, lint 0 errors/11 warnings, unit 160/160 (22 suites). The full integration suite is run once at the end (Task 7).
- Task 1: `94c615f` delay policy. RED 8 failed (script missing) → GREEN 8/8.
- Task 2: `ce2c3e4` polling controller. RED 18 failed (`createController` missing) → GREEN 27/27 after one test input was corrected (see the ruling on a malformed answer).
- Task 2: Ruling: `nextPollAt` is not part of the view — nothing reads it; the problem banner uses `problem.retryAt` — cost if wrong: one field to add.
- Task 2: Ruling: an answer with status 200 that is not usable (another event, or an admission of another epoch) is a failure, and a `nextPollAfterMs` it carries still counts as a server minimum — waiting longer is the safe reading of an answer that cannot be trusted — cost if wrong: one retry comes later than the backoff alone would allow.
- Task 3: Ruling: a 409 `ACTIVE_ADMISSION_EXISTS` is adopted through the GET that follows it at once, not from the error body — one code path, and that GET also brings `serverTime` and `nextPollAfterMs` — cost if wrong: one extra request per such conflict.
- Task 3: Ruling: the error wait of the queue API blocks join and cancel but not a purchase, and the state is read again after a purchase only once that wait is over — the purchase is another API and the admission lives 30 s; found by two tests written after the first GREEN (RED: purchase refused during a backoff; RED: fifteen polls inside a 15 s server minimum after a purchase) — cost if wrong: a purchase attempt reaches a server that is recovering and is answered 503, which the same-request retry handles.
- Task 3: Ruling: a notice of a join or cancel is dropped when the phase changes — the new phase is then the information — cost if wrong: the reason of a refused cancel is not shown once the entry moved on.
- Task 3: `ab39cb0` join, cancel and purchase. RED 14 failed (methods missing) → GREEN 43/43, including the two tests behind the purchase ruling.
- Task 4: Ruling: when several layer conditions hold, `reconnect` (first answer of a controller, failed requests before, or a promotion older than the visibility log) wins over `hidden`, and the raw flags are recorded next to the label — P8 can stratify differently from the flags — cost if wrong: a relabelling in the analysis, no new measurement.
- Task 4: Ruling: the trace is a ring that drops the oldest event and counts it, and the visibility log keeps the last 64 changes — bounded memory for a page that stays open — cost if wrong: a very long session loses its oldest polls (visible as `dropped`) or files an old promotion under reconnect.
- Task 4: mutation check of `frontend/admission-polling.js`: 38 mutations, each killed by its named test. Two single-guard mutants (the purchase pause in `poll()` and on a visibility return) are equivalent on their own because each guard covers the other; they are mutated together through their shared predicate.
- Task 4: `2cfe947` instrumentation, `5543521` formatting. RED 10 failed (trace and recognition missing) → GREEN 55/55.
- Task 5: Ruling: the queue context belongs to the last user a live session was issued for (`queueUserId`), not to the live session state — the existing code clears that state on Reset, on a rejected token and on a failed renewal, and a controller disposed by any of those would stop polling a waiting entry until its lease ran out — cost if wrong: a controller keeps running for a user whose session is gone; its requests then return no response and back off.
- Task 5: Ruling: the card has an action that reads the reservation an admission was used for (`GET /reservations/:id`) and sets the tier and quantity from it — after a reload the page no longer holds that reservation and step 4 could not continue — cost if wrong: one unused button.
- Task 5: Ruling: step 3 opens when the entry is admitted — the admission lives 30 s — cost if wrong: one step expands without a click.
- Task 5: Ruling: the card uses its own banner class, not `.result-banner` — `task21-contract-check.html` reads the first `.result-banner` of the flow as the settlement result — cost if wrong: a few duplicated layout rules.
- Task 5: a recorded poll delay showed 5000.1 ms in the browser (the planned delay was derived from two clock reads); the plan now carries the delay itself, with a unit test for the hidden interval.
- Task 5: checked in a real browser against the real application (owned PostgreSQL and Redis): recovery on load, join, wait behind 20 synthetic users, admission, reservation with the admission fields, checkout and demo settlement, expiry in real time without a new join, cancel with confirmation, mode switch, and an unprotected event on the existing flow. Both existing check pages pass (Task21 10/10, Task22 four cases). Unit 216/216. The axe audit (WCAG 2 A/AA) reports nothing inside the queue card; the page's ten contrast findings and one scrollable-region finding are on elements this change does not touch.
- Task 5: correction, found in Task 6: the last sentence above is wrong. The audit command lists at most ten nodes of a rule, and the ten it listed were outside the card. What the card contains is in the Task 6 accessibility line.
- Task 6: environment — headless Chrome driven by `agent-browser`; the static frontend on 8765; two application processes of this branch on the browser database and its Redis (3101 and 3102, differing only in `DEMO_USER_EMAIL`); the event protected by the explicit transition (exclusive gate, real UPDATE of `admission_events`); synthetic waiting users that join and poll over HTTP; a local proxy on 3103 that closes the browser's connection after the application answered `POST /reservations`.
- Task 6: Ruling: a live page that knows a selected event reads the events by itself after a load — step 3 needs the tiers and an entry recovered as admitted has 30 s; found when step 3 stayed disabled after a reload while admitted — cost if wrong: one read of the event list on load in live mode.
- Task 6: Ruling: the queue user is derived from the last session together with the API base and mode it was issued for, and a session that is answered after a reset is dropped — the first user-switch run showed a controller created for the new API base with the previous user for one render (its request was aborted and nothing was applied) — cost if wrong: a step that was waiting for a session made obsolete by a reset shows an error.
- Task 6: the poll trace also records what the server asked for with a failure (`serverMinMs` from the body, `retryAfterMs` from the header when the page can read it), so that a run can show that such a wait was kept.
- Task 6: Ruling: the recognition markers are keyed by run, epoch and admission, as §7 counts samples; the first version had no run in the key — cost if wrong: an admission looked at under two run ids in one browser profile is a sample of both runs.
- Task 6: Ruling: the cancel confirmation is opened and closed by one button, and the two live-region texts are derived from the state — the keyboard check showed the focus falling to `body` when the confirmation opened or closed, and both regions kept the text of an earlier state after a cancel — cost if wrong: none known; the confirm button itself still disappears with the focus on it when the cancel is sent, and the result is then announced by the status region.
- Task 6: scenarios, real browser → HTTP → Redis and PostgreSQL, each with the page trace, the request list without headers, the application's own request log and Redis reads. Every trace and every server log shows no overlapping request of the tab.
  - S1 adaptive and S2 fixed: join behind synthetic users, wait, admission, reservation with the admission fields; S1 also the checkout. Planned delays with base 5000: 4779–5000 ms adaptive, 1000 ms fixed; with base 1000: 1000–1192 ms adaptive. S2: reservation 201 after 50 status polls at 1 s.
  - S3 reload: the waiting entry is shown again after a reload, no POST; a reload while admitted records no second recognition (with the key of the Task 6 ruling a reload under another run id recorded one more, filed under reconnect; that key was withdrawn in Task 7).
  - S4 hidden: two hidden polls planned at 15000 ms (sent after 15316 and 15997 ms), recognition filed under hidden, exactly one request on return, then the reservation.
  - S5 offline: retries planned at 889, 2361, 3929 and 9586 ms, the same entry afterwards, no POST; offline through the admission: retries up to the 15 s cap and the entry is recorded as missed once, without a join.
  - S6 real 503: the application was replaced by one with the feature off on the same port; two requests without an answer, five 503 `ADMISSION_RECOVERING` (server minimum 1000 ms), retries planned from 1071 ms up to 15000 ms; the waiting lease score did not change; the same admission after the feature returned.
  - S7 real 429: after a flood of the same user's status limit the answer asked for 49064 ms; the next request was sent 49073 ms later, beyond the 15 s cap, and showed the same admission. In a second run the wait of 21347 ms outlived the admission, which was then shown as expired.
  - S8 cancel: confirmation, 200, polling stops; a new join gets the next sequence; a late cancel of the first entry leaves the second one waiting.
  - S9 expiry: the admitted entry is recovered after a reload; the admission expires after its 30 s; polling stops; no join.
  - S10 users and events: two users through the two processes never see each other's entry; user 1's entry is unchanged after A → B → A; an unprotected event answers 404 once and is not polled.
  - S11 epoch: the control key was deleted in the owned Redis; the card reported the reset within one poll, sent no join until the explicit one 11 s later, and that join created an entry of the new epoch.
  - S12 answer lost after the commit: the page's second attempt returned the same reservation and the seats were taken once. Chrome itself repeats a POST once when a reused connection closes without an answer (S12a: that alone returned the same reservation), so the proxy loses two answers to reach the page's own retry.
  - S13 five answers lost: attempts after about 1, 2, 4 and 8 s, then "unconfirmed", no join; the manual repeat returned the one reservation the server had made; seats taken once.
- Task 6: three runs started while the previous admission was still alive and showed something else than planned; they are kept under their own names (offline while admitted, 429 while admitted, the browser's own re-send).
- Task 6: the static server sends no cache policy and the browser served a file edited seconds before from its cache once; the check was repeated, and the helper that opens the page now reads every frontend file with cache `reload` first.
- Task 6: accessibility, axe-core 4.12.1 with the WCAG 2 A and AA rules, scoped to the card in four states (finished, waiting, confirmation open, admitted): the only failing rule is colour contrast, on classes and colours of the existing stylesheet — the "Polling" label (`.field-label`, 4.38:1), the join button (`.btn-accent`, 4.24:1) and the confirm button (`.btn-danger`, 3.88:1). The whole page has 83 contrast nodes of the same colours (85 in an earlier state whose audit file was overwritten) and one scrollable region without focusable content. Not changed here: it is the page's palette. Keyboard: the mode toggle, cancel, confirmation and return work with Tab, Enter and Space, and the focus stays on the button that opens the confirmation. No screen reader was run.
- Task 6: mutation check repeated on the final script: 43 mutations, each killed by its named test. Unit 216/216; both check pages pass.
- Task 7: Ruling: the Task 6 ruling on the marker key is withdrawn; the key is epoch and admission again, without the run. The check of the committed frontend showed what the run in the key does: the page of the next run recorded the previous run's admission, which had been recognized after 0.8 s, as missed, and it would do so at the start of every run that follows an admitted entry. An admission id is unique, so one sample per epoch and admission is also at most one per run, epoch and admission; the run of a sample is the run of the page that recorded it (trace meta) — cost if wrong: an admission that is looked at under two run ids is a sample of the first run only.
- Task 7: regression at `d6a09c8` on the owned test resources: build and typecheck passed, lint 0 errors/11 warnings (as the baseline), unit 216/216, integration 346 passed/15 skipped (361; 30 suites passed, 2 skipped; the same counts as the stored P5 result), harness 29/29, callback check passed.
- Final review: a fresh reviewer, a read-only subagent of the implementing session (not an independent review), read `2d67cc3..545f3f5`, ran the polling unit file and its own probes against the script from a scratch directory outside the repository, and compared the validation document with the saved evidence. It reported the five review-focus properties as holding, five findings that it graded Minor, eight behaviours it declined to judge and five places where the document said more than the evidence. The identifiers of reviewer and implementer are in the hand-off report, not in this repository. Regraded by effect:
- Final: fixed, regraded Important: a status poll that failed while the tab was hidden made the wait 15 s, and that wait then held back the one request on return and the join and cancel buttons — up to half of a 30 s admission. The wait is now what the failure itself asks for (backoff and server minimum); only the retry of a tab that stays hidden keeps the 15 s, and a return inside the wait moves the retry back to its end — "sends the one request on return after a hidden poll failed, once the wait of that failure is over" and "retries at the end of the wait, not after the hidden interval, when the tab returns inside the wait of a hidden failure" RED→GREEN, a third test pins the 15 s of a tab that stays hidden; polling file 60/60, unit 220/220. Real browser (S15): the hidden poll was given up and the request on return was sent 4.4 s later.
- Final: fixed, regraded Important: step 3 stayed "running" when the event was changed during a purchase without an answer, so its button stayed disabled on the other event until Reset; and an unconfirmed purchase was shown as "running" without end. The step is released when its controller ends, and an unconfirmed purchase has its own label — real browser RED→GREEN (S16: button disabled → enabled; S17: label "결과 미확인"). The label and the card's processing and reset states use the info and err pills: the warn pill of the existing stylesheet measured 4.43:1.
- Final: fixed: the request log line of a status poll without an answer was the stored answer of the previous poll — real browser RED→GREEN (S14: "200" → "0 5001ms" for a request given up after 5 s).
- Final: a test for a controller disposed between two attempts of a purchase (it sends and reports nothing more; the request stays restorable). The script already behaved so; the mutation that removes the timer clean-up is now killed.
- Final: Ruling: two findings that stayed Minor (the request log line and the dispose test) were handled in the same pass — the reviews of P5 on this repository addressed every reproduced finding, and each is one small change with its own check — cost if wrong: two changes nobody asked for.
- Final: minor (deferred): the recognition marker is durable but the trace is in memory, so a recognition whose page was reloaded or closed before `snapshot()` was read is lost and not recorded again. Written down as a precondition for P8 instead of storing the record.
- Final: Ruling: a status read after a purchase result or a refused join or cancel also goes out while the tab is hidden — it is the one read after an explicit action — cost if wrong: one status request of a hidden tab sooner than its interval.
- Final: Ruling: a state that stopped polling on 401 or another 4xx is probed once on every return to the tab — it is the contract's one request on return and the only automatic way out of that state — cost if wrong: one request per tab switch against a server that keeps refusing.
- Final: Ruling: `recognition-missed` is also recorded for an entry first seen as consumed or cancelled — it stays as raw data with its state; the document says that the unrecognized expiries are the events with state `expired` — cost if wrong: an analysis that counts every missed event overcounts.
- Final: Ruling: a server time before `admittedAt` would give a negative delay without a flag — both are one Redis clock and a negative value is visible in the data — cost if wrong: one implausible sample.
- Final: Ruling: a sample that follows a failed request is filed under `reconnect` even when the promotion came after the failure (Task 4 ruling kept); the document now says what the label means — cost if wrong: a relabelling in the analysis.
- Final: Ruling: "load reservation" leaves a restored unconfirmed purchase open until the same request is repeated — safe, and the repeat resolves it — cost if wrong: one extra click.
- Final: Ruling: the status region says "cancelled" also when a cancelled entry is merely read again after a reload — the region mirrors the state — cost if wrong: one redundant announcement.
- Final: Ruling: the `module.exports` line stays although this package is `"type": "module"` and nothing here uses it — it is what a CommonJS loader would read; not tried — cost if wrong: one dead line.
- Final: the card's sentence about other tabs now says that their joins, cancels and purchases appear at the next status check; a finished entry is not polled.
- Final: mutation check on the final script: 48 mutations, each killed by its named test. Real-browser checks added with the review: S14 a status request that is accepted and never answered (given up after 5 s three times and retried with backoff), S15, S16, and S17 a reload while a purchase has no answer (restored from the tab's storage; the repeated request returned the one reservation).
- User, 2026-10-03, after the report: the recognition marker key (epoch, admission) is accepted; the P5 line of `docs/README.md` may say that PR #26 was merged; an external review by Codex is repeated until it reports No findings, then the PR is created; the owned containers are removed after the merge.
- External review: a Codex session with four independent subagents (model, version and effort not stated in the relayed result) read `2d67cc3..ba39f2a`, ran the polling unit file (60/60) and reproduced its findings in memory. No P0 or P1, three P2. Each was reproduced in the real browser on `ba39f2a` before the change.
- External: fixed P2 quantity after a recovered purchase — S18 RED (form 2 after the repeat, checkout 409) → GREEN (form 1, checkout 201). The form's tier and quantity now follow every reservation the page adopts.
- External: fixed P2 join key reused after its attempt was decided — "uses a new join key once the entry of a join whose answer was lost has been read and finished" and "uses a new join key when the entry of a join whose answer was lost is first read as finished" RED→GREEN, S19 RED (the cancelled entry replayed) → GREEN (a new entry). A third test pins that the key is kept while the server still shows the entry the attempt started from.
- External: fixed P2 late reservation read — S20 RED (the late answer put the first event's reservation, tier and quantity on the second) → GREEN (nothing changed).
- External: Ruling: a join key ends when an applied status answer shows another entry than the one its attempt started from — the server shows one latest entry per user, so another entry means the attempt is decided, whether its own answer arrived or not — cost if wrong: an attempt whose answer was lost and whose entry the page did not read before another entry appeared gets a new key on the next click, which the server answers like any new join.
- External: Ruling: the explicit clear of the key on a successful join answer was removed — the rule above clears it in that case, and the mutation check showed the line could not change any outcome — cost if wrong: a join answer without an entry would keep its key; the server always answers with the entry.
- External: Ruling: a reservation read that answers after the context changed is dropped without a line in the request log — the controller drops its own late answers the same way — cost if wrong: one request missing from the page's log.
- External: noted, not changed: an event change keeps a reservation that is already on the page, as before P6; Reset clears it.
- External: polling file 63/63, unit 223/223, mutation 49/49 at `b9656ab`; build, typecheck, lint (0/11), integration 346 passed/15 skipped, harness 29/29 and the callback check at `b9656ab`; S19 repeated on the commit; final check (served files, check pages, F1, F2, audits, final SQL) at `b9656ab`.
- External, second round: the same kind of Codex session read `2d67cc3..bb2fb13`, ran the 63 tests of the polling file in a memory runner and reproduced its findings in memory. No P0 or P1, two P2. Both were reproduced in the real browser on `bb2fb13` before the change.
- External 2: fixed P2 earlier reservation read on the same event — S21 RED (the held answer of the first read replaced the second reservation and its quantity) → GREEN (the second reservation stayed). The read now has to belong to the admission the controller shows, besides the controller itself.
- External 2: fixed P2 demo session request without a time limit — S22 RED (after a 401 and a held session request no status request was answered for 150 s and the waiting entry expired; the held request stayed open until the page was left) → GREEN (each held request given up after about 5 s, a new session once the server answered, polling resumed, the entry stayed waiting). The session request uses the queue's request timeout.
- External 2: Ruling: a reservation read is tied to the admission shown when it was asked — a new join on the same event makes it an answer about an earlier admission — cost if wrong: after a join the earlier reservation has to be read again with the card's button, which the card then no longer offers; the reservation stays readable through its id.
- External 2: Ruling: the demo session request gives up after the queue's 5 s request timeout and is asked again by the next request — every request of the page waits for it, so it must end; the backoff of the status requests spaces the attempts — cost if wrong: on a server that issues sessions slower than 5 s, every attempt is given up and counts against its limit for demo sessions.
- External 2: build, typecheck, lint (0/11), unit 223/223, integration 346 passed/15 skipped, harness 29/29 and the callback check at `fc0f4a8`; the polling script did not change after `b9656ab`, so its mutation check (49/49) stands; final check (served files, check pages, F1, F2, audits, final SQL 85 + 3 + 12 = 100) at `fc0f4a8`.
- External, third round: no findings on `6645a29`. On the user's instruction the branch was pushed and opened as PR #28; CI (`install-lint-test`) passed on `6645a29`.
- Auto-review of PR #28 (`chatgpt-codex-connector[bot]`, `6645a29`): three P2. The two code findings were reproduced in the real browser on `6645a29` before the change.
- Auto-review: fixed P2 reservation read answered after Reset — S23 RED (the late answer put the reservation back and marked step 3 done after Reset) → GREEN (nothing changed). The read also checks the session generation, which Reset ends.
- Auto-review: fixed P2 401 attempt missing from the record — S24 RED (no trace record, no request-log line for the rejected attempt) → GREEN (an `auth-retry` trace record and a 401 line).
- Auto-review: Ruling: the cross-tab race of the recognition marker is answered by an analysis rule (keep the earliest record per run, epoch and admission across exported traces), not by a cross-tab lock — the trace already carries what that rule needs, the race needs two tabs of one user applying the same admission within the moment `localStorage` takes to propagate, and a lock (Web Locks) would make the marker and the recognition record asynchronous — cost if wrong: raw traces of a multi-tab user can hold a duplicate that an analysis must drop.
- Auto-review: Ruling: Reset ends the reservation read through the session generation rather than a counter of its own — Reset already ends that generation, and so do a change of the API base or mode — cost if wrong: a read is also dropped when another step replaces a rejected token while it is out; the button stays and can be pressed again.
- Auto-review: Ruling: the rejected attempt is recorded by the page's wrapper as a separate `auth-retry` event, and the demo session request it causes is not recorded — the controller's own records stay one per request it sent — cost if wrong: an analysis that counts HTTP requests from the trace alone misses the session requests.
- Auto-review: build, typecheck, lint (0/11), unit 223/223, integration 346 passed/15 skipped, harness 29/29 and the callback check at `a9954d8`; final check (served files, check pages, F1, F2, audits, final SQL 82 + 4 + 14 = 100) at `a9954d8`.
- Second auto-review of PR #28 (`chatgpt-codex-connector[bot]`, `d022ec7`; CI passed on that push): three P2, all reproduced on `d022ec7` before the change.
- Auto-review 2: fixed P2 stored purchase not namespaced by API base — the test "restores an unresolved purchase only against the API base it was sent to" RED (the other base restored the request) → GREEN, polling file 64/64; in the browser the stored key had held only user and event (S25 before) and names the base after it.
- Auto-review 2: fixed P2 purchase callback after Reset — S25 RED (the retry's answer arrived after Reset, put the reservation back and marked step 3 done) → GREEN on the working tree of `0b1c3b5` (no request after Reset, the request restored as unconfirmed, the explicit repeat returned the one reservation). After the change to `stopPurchase`: the three tests of a stopped purchase RED (missing function) → GREEN, polling file 67/67; S25b, which loses every answer until Reset, RED with the frontend of `d022ec7` (the third attempt sent 834 ms after Reset, answered 201, reservation and step 3 done back) → GREEN on `cfe72a5` (no attempt after Reset, unconfirmed, its button returned the one reservation). S25 on `cfe72a5` had its retry answered before the click and shows only that Reset clears a finished purchase.
- Auto-review 2: fixed P2 newer consumed reservation not loadable — S26 RED (the card showed the second tab's newer reservation, the page kept the older one, no button) → GREEN (the button loaded the newer reservation and its quantity).
- Auto-review 2: Ruling: the API base is part of the controller's key for the stored purchase, given as an option, rather than a prefix added by the page's storage adapter — the controller already names its context (base, user, event) and the key is then covered by the polling file and the mutation check — cost if wrong: a purchase stored before this change is not restored after it; the record is per tab and the outcome is still read from the status API.
- Auto-review 2: Ruling: Reset stops only the purchase (`stopPurchase`, `cfe72a5`) instead of replacing the controller as the review suggested and as `0b1c3b5` first did — the S23 rerun on `0b1c3b5` showed a second `recover` poll from the new controller at the moment of Reset, for a used entry whose polling had ended, and inside a wait the server asked for such a read is a request A15 rules out; the controller's transition after its last automatic repeat already resumes polling with that wait kept — cost if wrong: a join or cancel answer that is out at Reset still updates the card, as before the change; only the purchase reached the cleared flow.
- Auto-review 2: Ruling: "load reservation" compares the page's reservation id with the outcome's, and loading keeps an order or settlement on the page, as a new reservation made in the same tab does — clearing the later steps would change the flow of the existing page beyond the finding — cost if wrong: the page can show an order of the older reservation next to the newer reservation until step 4 runs again; the server checks every later request.
- Auto-review 2: Ruling: S26 was run three times after the change and all runs are kept: the first read answered 429 (S25 and S26 had made five reservation requests of the user within the minute, and the limit matches `GET /reservations/:id` too), the second passed with a tab of the first still open, and the third, with one second tab, is the record — cost if wrong: none for the code; the limit's reach is a note for P7.
- Auto-review 2: build, typecheck, lint (0/11), unit 227/227, integration 346 passed/15 skipped, harness 29/29 and the callback check at `cfe72a5` (and at `0b1c3b5`); mutation 56/56 at `cfe72a5`; S25, S25b, S26, S16, S17 and S23 on `cfe72a5`; final check (served files, check pages, F1, F2, audits, final SQL 76 + 6 + 18 = 100) at `cfe72a5`, and the final SQL again after S25b (78 + 4 + 18 = 100). The final check of `0b1c3b5` was stopped in F2 when the Reset fix changed.
- Added 2026-10-10 (facts only; details in [ISSUE_15_VALIDATION.md](../../ISSUE_15_VALIDATION.md)): the third and fourth auto-review of PR #28 were answered by `d0d0ae5` and `621e937`, the PR head. PR #28 was merged on 2026-10-03 as main `2ba3a5ca554d6702e8e590bb674e43b25249d8d3`; what was left open is in #29.
