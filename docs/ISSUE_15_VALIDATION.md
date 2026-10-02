# Issue #15 / P6 implementation and P7/P8 handoff

Run: `peakpass-p6-20261003`. This is the implementation candidate on the local branch `claude/issue-15-p6-waiting-polling`, cut from main `2d67cc3c10a1d04bebe0a7a81f9575ea39e63363`. It is **not pushed, has no PR and is not an accepted P6 tuple**. Acceptance remains in [#9](https://github.com/dosacha/PeakPass/issues/9). The contract `admission-v1` is unchanged, and under `src/` only one unit test was added: no backend, migration, dependency or CI change.

Final code: `7c1d1918dcccb90bb6f69d45d3a3ca8616e8459d`.

P6 claims no polling improvement. Every interval, delay and count in this document is one observation of one local run and shows that a rule holds or that the trace records a value. The comparison of the two polling modes is P8's.

## Consumed input

- Base main `2d67cc3c10a1d04bebe0a7a81f9575ea39e63363` (PR #26 merged). P5 head `e3fb7e2349db49600c7c617e9d89099d99bdd808` and final P5 code `9eca3247429905bc5ae9ed4bc01e8b1483183baa`, P4 head `4b8847e68cc1cec66a4ac90f247b86f87ea26dfa` and final P4 code `51d331b026cc7d79bb0ab4d640960240f6adba4b`, and the accepted P3 `87959cd84dbb231caa88fee2e4ad4bcd84115246` are ancestors of this branch, checked at the start and at the end.
- `admission-v1`: contract LF Git blob SHA256 `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`, rechecked at the start and at the end. Migrations end at 013.
- The queue API of [ISSUE_13_VALIDATION.md](ISSUE_13_VALIDATION.md) ("P6 API handoff") and the purchase interface of [ISSUE_14_VALIDATION.md](ISSUE_14_VALIDATION.md) ("Purchase interface for P6", "Activation and release").
- P2 v261 index SHA256 `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6`, unchanged. No load experiment was run.
- `admission-v1-seed` is unchanged: R2/s, C8, TTL30s, claim15s, tick250ms, waiting lease 120s, status limit 120/min, join and cancel 10/min.
- At the start #9 listed P4 valid, P5 valid and P6 ready, and no PR was open.
- The user reviewed the design in chat on 2026-10-03 and answered "proceed as recommended". The eleven decisions are in [the plan](superpowers/plans/2026-10-03-issue-15-waiting-polling.md), together with the ledger of every ruling made during the work.

## Implementation boundaries

| Area | Implementation and invariant |
| --- | --- |
| Files | New [`frontend/admission-polling.js`](../frontend/admission-polling.js) and [`src/tests/unit/admission-polling.test.ts`](../src/tests/unit/admission-polling.test.ts). Changed `frontend/app.jsx`, `frontend/app-flow.jsx`, `frontend/styles.css` (rules appended) and `frontend/index.html` (one script tag). The frontend stays build-less. |
| Shape | `admission-polling.js` is a plain script with the delay policy as pure functions and one controller. Clock, timers, randomness, transport, visibility and storage are injected, so the same file runs in the page and, loaded through `vm`, in the Jest unit test. React only renders the controller's view. |
| Delay policy | Fixed: 1000 ms whatever base the server sends. Adaptive: `clamp(base × (1 + 0.2u), 1000, 5000)` with `u` uniform in [-1, 1). Hidden: 15000 ms in both modes, without jitter, and one request on return. Failures (no answer, timeout, 429, 5xx, a 200 that cannot be used): 1 → 2 → 4 → 8 → 15 s with ±20% jitter capped at 15 s, reset by a normal answer; the wait is the maximum of that backoff, the body's `nextPollAfterMs` and a readable `Retry-After`, so a server minimum beyond 15 s wins. A mode switch changes only how the next poll is scheduled. |
| One request per tab | Status, join, cancel and purchase share one slot. The next timer is set only when the previous request completed. A status request is aborted after 5 s and a purchase after 10 s. An explicit action aborts a status request in flight and takes its place. |
| Late answers | An answer is applied only if its request is still the one in flight. One controller serves one context (API base, user, event) and is disposed before the next one starts, so an answer of an earlier context has nowhere to land. Every body is checked against the event and the queue epoch, and a cancel answer is applied only to the admission id the cancel named. |
| Recovery | The state is always read by `GET /events/:eventId/admissions/me` with the current JWT: on load, after a reload, on return to the tab, after a purchase result and after a refused join or cancel. Nothing in browser storage decides the queue state. A live page that knows a selected event starts a demo session and reads the events by itself, so a waiting or admitted user who reloads continues without a click. |
| Answers of the status API | 200: applied. 404: the event has no queue; polling stops and step 3 works as before. 401: the demo session is renewed once for the same user, then polling stops with a "check again" button. 429 and 5xx: wait as above and keep the entry. Other 4xx: polling stops and the code is shown. An epoch other than the one shown: the card reports the reset; the previous order is not restored. |
| Join | Only on a click. The key belongs to one attempt in one epoch: an attempt whose answer is unknown repeats it, a new attempt after a finished entry or in another epoch gets a new one. 409 `ACTIVE_ADMISSION_EXISTS` is adopted through the GET that follows. No answer handler calls join. |
| Cancel | Only on a click, after an inline confirmation. `DELETE` with the admission id and epoch captured at the click. |
| Purchase | Step 3 sends `{eventId, userId, quantity, tierId, admissionId, admissionEpoch}` through the controller as one frozen body while the entry is admitted. Status polling pauses while the purchase is in flight or between its retries. No answer, a timeout, 429, 5xx and 409 `ADMISSION_IN_PROGRESS` repeat the identical body after about 1, 2, 4 and 8 s; after four automatic repeats the card shows "unconfirmed", refuses a join and offers a manual repeat of the same request. Any other answer is final and is shown. The request template (no token) is kept in `sessionStorage`, so the same request can be repeated after a reload. Step 4 is unchanged: the checkout of an existing reservation sends no admission fields, and the reservation's own TTL applies from then on. |
| Card | Live mode only, between step 2 and step 3. States (checking, no queue, not joined, waiting, admitted, processing, used, cancelled, expired, reset) are told apart by label and text, not by colour alone. It names the fixed demo user, shows position and sequence while waiting and the remaining seconds while admitted (from the server's times on the local monotonic clock), announces changes through a `status` and an `alert` live region and the tab title, and opens step 3 on admission. Step 3 is enabled for an event without a queue or while the entry is admitted. |
| Instrumentation | `window.PeakPassAdmissionTrace.snapshot()` returns `{meta: {runId, tabId, startedAt}, dropped, events}`; `runId` comes from `?run=`. See "Trace for P8". The trace is a ring of 5000 events that counts what it dropped. Nothing of it is sent to the server. |
| Storage | The JWT stays in memory. `localStorage` holds preferences (`pp_poll_mode` among the existing ones) and the recognition markers `pp_admission_seen` (last 50). `sessionStorage` holds the pending purchase template. |
| Mock mode | No queue card and no trace. A simulated wait would look like a measurement. |
| Polling mode | `?poll=fixed|adaptive` wins over the stored choice; the card has a toggle. The default is adaptive. Both modes use the same API, the same entry and the same purchase. |

## Choices the contract text does not fix

Recorded as P6 behaviour, without a contract revision (decision D11 and rulings in the plan's ledger). A change to any of them changes what P8 measures.

- A return to the tab does not shorten a wait after a failure: no request is sent before the wait ends.
- The hidden interval has no jitter. A hidden tab that fails never retries sooner than 15 s.
- 5xx other than 503, timeouts and a 200 that cannot be used take the 503 backoff.
- Polling pauses while a purchase is open; a purchase is not held back by a backoff of the status API.
- A purchase request times out after 10 s; automatic repeats: four.
- Requests outside the timer cadence: the first read of a page (`recover`), the one read on return (`return`), one read right after a purchase result, a refused join or a refused cancel (`refresh`). In fixed mode two status requests can therefore be closer than 1 s; they never overlap.
- The recognition marker is keyed by epoch and admission, not by run. An admission id is unique, so this is at most one sample per run, epoch and admission; a sample belongs to the run of the page that recorded it. A key with the run was tried and withdrawn: the page of the next run then recorded an admission that had been recognized as missed.
- When several layer conditions hold, `reconnect` wins over `hidden`; the raw flags are recorded next to the label.
- A finished entry is not polled (the server sends no interval for it). A join made in another tab is seen on return to the tab, on "check again" or when a join answers 409.
- Reset and a change of the event do not cancel the server-side entry.

## Findings made during the work

- **`Retry-After` is not readable by a cross-origin page.** The server sends it on 429 only and CORS exposes no header. The page uses the body's `nextPollAfterMs`, from which the server derives that header (decision D8, no backend change). In the 429 run the trace recorded the body's wait and no header. The 503 answers of the admission service and its Lua carry `nextPollAfterMs: 1000` (read in the code, seen in S6).
- **The clamp makes the jitter one-sided at both bounds.** With base 1000 the planned delays were 1000–1192 ms and with base 5000 they were 4779–5000 ms. This is what the contract formula yields; P8 should expect it.
- **Chrome repeats a POST once by itself** when a reused connection closes without an answer. With one answer lost, the browser's own repeat returned the same reservation and the page saw a single request. The proxy therefore loses two answers to reach the page's own retry. Each lost answer costs two requests of the purchase limit: with five page attempts the application saw eight `POST /reservations`, five answered 201 with the same reservation and three answered 429.
- **A wait asked for by the server can outlive the admission.** In one run a 429 asked for 21347 ms while the entry was admitted; the page kept the wait and the entry had expired when it read again. A purchase stays possible during such a wait.
- **Hidden timers run late.** Two hidden polls planned at 15000 ms were sent after 15316 and 15997 ms, as the contract expects from browser throttling.
- **Step 3 after a reload.** An entry recovered as admitted could not be used because the page had not read the events. The page now reads them on load.
- **A controller of the previous user.** After a change of the API base one render created a controller for the new base with the previous user; its request was aborted before any answer was applied. The queue user is now bound to the API base and mode its session was issued for, and a session answered after a reset is dropped.
- **Keyboard and screen-reader output.** Opening or closing the cancel confirmation moved the focus to `body`, and both live regions kept the text of an earlier state. One button now opens and closes the confirmation, and both texts follow the state.
- **The accessibility audit lists at most ten nodes of a rule.** A first reading ("nothing inside the card") was wrong for that reason and is corrected below.
- **The static server sends no cache policy.** The browser once served a file edited seconds before from its cache; that check was repeated, and the helper that opens the page now reads every frontend file with cache `reload` first.
- **Request lists with headers.** The browser tool's JSON request list and a raw HAR contain the `Authorization` header. The checks use the plain list, a reduced HAR and the application's request log, which record no header. Before that was noticed one demo token of the owned environment (ten minutes lifetime, signed with a random local secret) was printed to the operator's console. It is in no file of the repository or of the archive.

## Trace for P8

Events, each with `t` (local monotonic ms) and `wall`:

- `poll`: `seq`, `reason` (`recover`, `timer`, `retry`, `return`, `refresh`), `mode`, `hidden`, `tSend`, `tRecv`, `status`, `code`, `timedOut`, `state`, `phase`, `position`, `serverTime`, `nextPollAfterMs`, `serverMinMs` and `retryAfterMs` (what the server asked for with a failure), `plannedDelayMs`, `actualDelayMs`, `baseMs`, `u` (the jitter draw), `changed`. The interval effect and the jitter effect are separable: `baseMs` is the server base, `u` the draw and `plannedDelayMs` the result.
- `poll-aborted`: a status request an action pre-empted. It may have reached the server.
- `join`, `cancel`, `purchase` (one per attempt), `visibility`, `mode`, `epoch`.
- `recognition`: once per epoch and admission, when this browser first applies the entry as admitted. `serverDeltaMs` is `serverTime − admittedAt`, both from Redis `TIME`, so no local wall clock is involved. The delay lies between `lowerMs = serverDeltaMs + (tApply − tRecv)` and `upperMs = serverDeltaMs + (tApply − tSend)`. `layer` is `foreground`, `hidden` or `reconnect`; `visibleAtPromotion`, `hiddenBetween`, `hiddenAtApply`, `failuresBefore` and `viaRecover` are the raw flags.
- `recognition-missed`: an entry that ended before this browser applied it as admitted, with its final state.

## Verification record

Owned environment: Windows host, Node 24.15.0; PostgreSQL 16.12 and two Redis 7.4.8 instances (save "", appendonly no, noeviction, 256MiB) in Docker on loopback ports chosen by Docker, labelled `peakpass.task=peakpass-p6-20261003`. The integration suite uses the database `peakpass_test` and its own Redis; the browser checks use `peakpass_browser` and the other Redis, because an active scheduler removes admission keys it does not own. Browser: headless Chrome 154 driven by `agent-browser` 0.38.2; the frontend served by `python -m http.server` on 8765, cross-origin to the API. Two application processes of this branch (`tsx src/main.ts`, `ENABLE_ADMISSION=true`, `ENABLE_DEMO_SESSION=true`) on 3101 and 3102 share the browser database and Redis and differ only in `DEMO_USER_EMAIL`. One seeded event was protected by the contract's explicit transition (exclusive gate, real `UPDATE admission_events`). No other container, checkout or database was changed.

Evidence kinds: **real** is headless Chrome running the committed frontend against a listening application with owned PostgreSQL and Redis. **Runnable check** is the unit test: the real script with an injected clock, transport and visibility. **Synthetic stimulus** is something done to the real system from outside the page: waiting users created by SQL whose JWTs are signed with the environment's secret and who join and poll over HTTP; a flood of status requests as the demo user; a deleted Redis control key; an application process replaced by one with the feature off; the browser's offline emulation; a local proxy that closes the browser's connection after the application answered.

| Check | Result / evidence boundary |
| --- | --- |
| Baseline at `2d67cc3` | Before any change: build and typecheck passed, lint 0 errors/11 warnings, unit 160/160 (22 suites). |
| Build / typecheck / lint | `npm run build` and `npx --no-install tsc --noEmit` passed at `d6a09c8`; lint 0 errors/11 warnings, as the baseline. The one later commit changes `frontend/app.jsx` and the plan only. |
| Unit | 216/216 (23 suites). 56 tests are new, all in the polling file. |
| Full integration | 346 passed / 15 skipped, 30 suites passed and 2 skipped (361 tests), at `d6a09c8`: the counts of the stored P5 result. No file the suite covers changed. |
| Harness regression | `npm run test:flash-sale`: 29/29; callback run-isolation check passed. Harness checks, not load runs. |
| RED before GREEN | Each of the four test groups failed first for the missing function (8, 18, 14 and 10 tests), and later tests failed for the behaviour they pin (a purchase held back by a status backoff; fifteen polls inside a 15 s server wait after a purchase). Raw outputs are in the archive. |
| Mutation check | 43 branches of the polling script were removed or changed one at a time; the named test failed each time and the source was restored. |
| Existing check pages | `task21-contract-check.html` 10/10 and the four native-keyboard cases of `task22-keyboard-check.html` pass in the real browser. |
| Real browser | The scenarios below, during the work, on the working tree between `03218ca` and `d6a09c8`. |
| Final check at `7c1d191` | The ten served frontend files equal the committed blobs. F1 and F2 below and the final SQL ran on that commit. |

Raw outputs: [manifest](../test-results/admission-v1/p6-final-20261003.json) / [ZIP](../test-results/admission-v1/p6-final-20261003.zip). The manifest records the ZIP and file SHA256 values and the results. The archive holds the page traces, the request lists without headers, the extracts of the application's request log, the proxy logs, the audit results, the console output of the final check, the baseline and RED outputs, and the scripts of the run, which are not part of the source tree. No credentials, `.env`, token or raw HAR are archived.

### Scenarios

Every page trace and every extract of the application's request log shows no overlapping request of the tab.

| ID | What was done and seen | Evidence kind |
| --- | --- | --- |
| S1 adaptive | Join behind synthetic users, wait, admission, reservation with the admission fields (201) and checkout (201). 36 status polls; planned delays 4779–5000 ms at base 5000 and 1000–1192 ms at base 1000. | Real; waiting users synthetic |
| S2 fixed | The same flow up to the reservation. Every timer poll planned at 1000 ms, also at base 5000. The reservation answered 201 after 50 status polls: the status limit and the purchase limit are separate. A reduced HAR of the browser shows the same requests with gaps of 991–1034 ms. | Real; waiting users synthetic |
| S3 reload | After a reload the page sent no POST and its first GET showed the waiting entry. A reload while admitted recorded no second recognition. | Real |
| S4 hidden | The tab was put in the background by activating another tab. Two polls at the hidden interval, the recognition filed under `hidden`, exactly one request on return, then the reservation (201). | Real |
| S5 offline | Browser offline emulation while waiting: retries planned at 889, 2361, 3929 and 9586 ms, then the same entry, no POST. Offline through the whole admission in two runs: retries up to the 15 s cap; the entry was found expired, recorded as missed once in the run that had not seen it admitted, and no join was sent. | Real; offline is emulation, not a partition |
| S6 503 | The application on the page's port was stopped and replaced by one with the feature off: two requests without an answer, then five 503 `ADMISSION_RECOVERING` with `nextPollAfterMs` 1000. Retries planned from 1071 ms to 15000 ms. The waiting lease score in Redis was the same before the outage and before recovery, and the page showed the same entry when the feature returned. | Real; the instance swap is the stimulus |
| S7 429 | 125 status requests as the demo user from outside the browser used up the status limit. The page's next poll answered 429 asking for 49064 ms; the following request was sent 49073 ms later, beyond the 15 s cap, and showed the entry still waiting. Second run, while admitted: a wait of 21347 ms, after which the entry had expired. | Real; the flood is synthetic |
| S8 cancel | Confirmation, `DELETE` 200, no status request until the next join. The new join got another entry. A cancel of the first entry sent afterwards from outside the browser answered 200 and left the second entry waiting. | Real; the late cancel is sent by a script |
| S9 expiry | The page was reloaded while admitted and recovered the admitted entry. The entry then expired, about 30 s after its admission; polling stopped and no join was sent. | Real |
| S10 users and events | API base A (user 1) → B (user 2) → A: each page showed only its user's entry, and user 1's entry was unchanged on return. An unprotected event answered 404 once and was not polled again; back on the protected event the entry was still waiting. | Real |
| S11 epoch | The Redis control key of the event was deleted. The scheduler published a new epoch (policy generation 0 → 1). The page saw the new epoch at its next poll and reported the reset, sent no join until the explicit click 11 s later, and that join created an entry of the new epoch. | Real; the deletion is the stimulus |
| S12 lost answer | The proxy closed the connection after the application answered 201, twice. The page's second attempt returned the same reservation; seats 96 → 94, one more reservation. With one answer lost, the browser's own repeat returned the same reservation (seats 98 → 96). | Real application and commit; the loss is injected at the proxy |
| S13 unconfirmed | Five page attempts without an answer, about 1, 2, 4 and 8 s apart, then "unconfirmed"; no join was sent. The manual repeat a minute later returned the one reservation the application had made; seats 94 → 92. | As S12 |
| F1 at `7c1d191` | Adaptive. Join (sequence 139), reload while waiting: the same admission id and sequence in Redis and one admission POST in total. Admission, reservation 201 on the first attempt, entry consumed with the reservation as outcome. A reload under another run id recorded neither a recognition nor a miss; the card's "load reservation" read the reservation back, and checkout and demo settlement followed: reservation converted, order paid, seats 98 → 96. | Real; waiting users synthetic |
| F2 at `7c1d191` | Fixed. Join (sequence 152), cancel: no status request for the 6.6 s until the next join. New join: sequence 153. A late cancel of the first entry from outside the browser answered 200 and left the second entry waiting. Admission, then expiry: the page saw the entry admitted for between 29.3 and 31.4 s. No request after the expired answer; the poll count was unchanged when the page was read again later. | Real; waiting users and the late cancel synthetic |

Final SQL of contract §8 on the browser database after all runs: `available + active reservation quantity + pending/paid/delivered order quantity = total` holds (96 + 0 + 4 = 100), and each of the eight consumed results matches the owner, event, tier and quantity of its reservation.

Recognition ranges recorded in the archived runs, each a single observation: fourteen in the foreground, from [13, 18] ms to [1015, 1025] ms; one hidden at [8433, 8447] ms; one miss with a server delta of 51581 ms. They show that the trace records the range and the layer. They are not a recognition-delay result.

### Contract scenarios and completion conditions

| Item | Where it is shown |
| --- | --- |
| A14 at most one request in flight per tab | Runnable check (a second request is never started, whatever the order of timers, visibility, mode switch and clicks) and every real trace and server log. |
| A14 no stale answer applied | Runnable check: user A → B → A, a GET pre-empted by an action, a cancel that timed out before a new join. Real: S10, S8, F2. |
| A14 server state recovered, no automatic duplicate purchase | S3, S9, F1; S12, S13 (one reservation, seats taken once). |
| A14 late cancel(A) does not change B | Runnable check for the page's side (the late answer is ignored); S8 and F2 for the server's side. |
| A15 one-second polling does not use the purchase budget | S2. |
| A15 no request inside a 15 s server minimum, identity kept, lease not renewed | The 15 s minimum on 503 is an injected answer in the runnable check, because the server always sends 1000 ms with a 503. Real: S6 (503, lease score unchanged, same entry) and S7 (a 49 s minimum kept). |
| Both modes use the same API and entry | S1, S2, F1, F2; a mode switch keeps the entry and sends no join (runnable check). |
| No duplicate polling, stale answer or reuse on cancel, retry, reload, user change, expiry | S3, S8, S9, S10, S12, S13, F1, F2. |
| Error, waiting and admitted states are distinguishable; the purchase step gets the admission | The card's states; S1, S2, F1 (admission fields sent, 201). |
| Polls, request bursts and recognition can be collected | The trace; the application's request log gives the per-second count per scenario. |
| First recognition once; clock error; layers; missed entries | Runnable check; S3, S4, S5, F1, F2. |
| Unknown purchase recovered with the same identity; no automatic join or new key | Runnable check; S12, S13. Mock delays are not used: mock mode has no queue. |

### Accessibility

axe-core 4.12.1 with the WCAG 2 A and AA rules, scoped to the card in four states (finished, waiting, confirmation open, admitted), in the light theme. The only failing rule is colour contrast, on classes and colours of the existing stylesheet: the "Polling" label (`.field-label`, 4.38:1), the join button (`.btn-accent`, 4.24:1) and the confirm button (`.btn-danger`, 3.88:1). The whole page has 83 to 85 contrast nodes of the same colours and one scrollable region without focusable content. The palette was not changed here.

Keyboard, in the real browser: the mode toggle, cancel, confirmation and return work with Tab, Enter and Space; the focus stays on the button that opens and closes the confirmation; the confirm button is described by the question. After the cancel is sent that button disappears with the focus on it; the result is announced by the status region. No screen reader was run.

### Not verified

- A screen reader, other browsers than headless Chrome, a mobile browser and the dark theme.
- Two tabs of one user at the same time. The marker is shared through `localStorage` and was exercised by reloads only. By the seed profile two foreground tabs in fixed mode send 120 status requests a minute, which is the limit; this is arithmetic, not a run.
- A real network partition. Offline was the browser's emulation, where a request fails at once.
- A real 503 with a minimum above 1000 ms, and the `Retry-After` path: a same-origin deployment or a server that exposes the header was not run. Both are covered by the runnable check with injected answers.
- Purchase answers other than 201, a lost answer and a lost 429 in the real browser: 400, 401, 404, 409 and 410 on the purchase path are covered by the runnable check with injected answers; the server's side is P5's evidence.
- The end of a 24 h epoch session, a full queue (429 `ADMISSION_QUEUE_FULL`) and a trace that overruns its 5000 events.
- Whether P8's runner can load `admission-polling.js` or reads the page trace: not tried.
- GitHub Actions and the automated review: the branch is not pushed.
- Real Redis pause, stop and restart with buyers (A10), several application processes buying, and the final purchase integration: P7.
- Request volume, burst size and recognition delay of the two modes: P8.

### Limits kept or introduced

- The colour contrast of the existing palette (above).
- In live mode with a selected event the page now sends `POST /demo/session` and reads the events on load, without a click. It needs both to recover a waiting user.
- The pending purchase template is per tab (`sessionStorage`). Another tab learns the outcome from the status API only.
- The markers keep the last 50 admissions of a browser profile; an older admission seen again would be counted again.
- The demo has one fixed user per application process. "Another user" was a second process, reached by changing the API base.
- A cross-origin page sends a preflight for each request once the browser's short preflight cache has run out: 13 preflights next to 37 status requests in S1. They reach the application and are not counted by the admission limits.
- The limits of P4 in [#25](https://github.com/dosacha/PeakPass/issues/25) and of P5 in [#27](https://github.com/dosacha/PeakPass/issues/27) are unchanged. None turned into a defect here. S6 uses the behaviour of #25 item 1 (an instance with the feature off answers 503 for an existing control) as its stimulus, and S9 and F2 saw the 30 s TTL elapse in real time through the API; the claim deadline stays P7's.

## Successor notes

- **P7** owns the final purchase integration, A10 and several processes. The proxy script and the synthetic-user script in the archive are reusable. With lost answers the purchase limit (5 per minute) is reached quickly, because the browser repeats a POST by itself: a committed purchase is then replayed only once the limit lets the request through. The page's manual repeat covers that; whether the limit should count replays of one identity is a question for P7.
- **P8**: the two modes are selected with `?poll=fixed|adaptive` and a run is labelled with `?run=`. The trace separates the server base from the jitter draw and the cadence polls from the event-driven ones (`reason`). Fix the number of tabs per user and the hidden share: a hidden tab polls every 15 s in both modes, and browser throttling adds to it. Serve the page from the API's origin or count the preflights. The adaptive interval is one-sided at both bounds. A third arm for jitter alone does not exist (decision D10).
- A change of the polling interval, the jitter, the retry rules, the hidden interval or the recognition record invalidates P8 measurements made with this code.

## Commands

`npm run build`; `npx --no-install tsc --noEmit`; `npm run lint`; `npm test -- --runInBand`; `npx jest --runInBand --config jest.integration.cjs`; `npm run test:flash-sale`; `node --experimental-vm-modules load-test/payment-callback-check.mjs`. `DB_HOST/PORT/USER/PASSWORD/NAME` and `REDIS_HOST/PORT` are exported in the parent process against the owned test resources. The polling test alone: `npx --no-install jest src/tests/unit/admission-polling.test.ts`. The browser checks, the final check (`final.sh`), the mutation check and the helper scripts are in the evidence archive; they are not part of the source tree and need the `agent-browser` CLI, the two application processes and the protected event described above.
