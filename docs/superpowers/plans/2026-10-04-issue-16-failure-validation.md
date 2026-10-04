# P7 real failure, concurrency and invariant validation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Main implements; any agent investigates or reviews read-only.

**Goal:** Show, at the real integration boundary, that the admission and purchase contract of P3–P6 holds under real Redis, PostgreSQL and process failures, under several application processes, and through the browser, and hand P8 an integrated SHA whose quantity and capacity invariants were checked.

**Architecture:** No product change unless a defect is confirmed. The product runs as containers of the production image built from this branch, next to an owned PostgreSQL and an owned Redis on one Docker network; Jest on the host drives them over HTTP and with the `docker` CLI (`pause`, `unpause`, `stop`, `start`, `restart`, `kill`). Two checks decide every scenario: one SQL file that returns only violating rows, and a replay of the Redis `MONITOR` stream that computes capacity after every command and the promotion count of every rolling second.

**Tech Stack:** TypeScript, existing Jest with ts-jest, node-postgres, node-redis, Docker CLI through `child_process`, PostgreSQL 16, Redis 7, the installed `agent-browser` CLI for the browser checks. No new dependency.

**Spec:** ../../ADMISSION_CONTRACT.md (admission-v1, accepted `87959cd84dbb231caa88fee2e4ad4bcd84115246`, LF blob SHA256 `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`) §4–§8; ../../ISSUE_13_VALIDATION.md, ../../ISSUE_14_VALIDATION.md and ../../ISSUE_15_VALIDATION.md ("Not verified", "Limits kept or introduced", "Successor notes"); Issue #16. The design was explained in chat on 2026-10-04 and the user answered "no objection, proceed as recommended"; the decisions below are that answer.

## Decisions (user, 2026-10-04)

- D1 The product runs as containers of the production image on a Docker network with an owned PostgreSQL and Redis. A host process on Windows can be killed but cannot be sent SIGTERM or be suspended, so graceful shutdown and a stalled process need Linux containers.
- D2 The new fault suites run only when `ADMISSION_FAULT_IMAGE` names an image; without it they are skipped. CI does not change, so the default run reports more skipped tests.
- D3 The guard of the ten fixed-port Redis-outage tests is parameterized (one shared helper) and they run on an owned Redis with an explicit host port chosen at run time. Their assertions do not change.
- D4 The Redis transition log is a replay of the `MONITOR` stream of the owned Redis, which includes the commands Lua runs. No product change.
- D5 Stimuli are allowed in the owned test database only: a `pg_sleep` trigger that slows one marked request, the event advisory gate held by the test session, and `track_commit_timestamp=on`. Evidence made with them is recorded as "real timer or process failure, synthetic stimulus".
- D6 Browser scope: B1–B8 below.
- D7 The purchase limit on `/reservations` stays as it is. P7 records how it behaves with real lost answers and what P8 must fix in advance.
- D8 A defect is a broken invariant, an answer code that differs from the contract table, a leaked 500, or a process that ends abnormally. Lower availability, delay and a needed retry of the same request are observations and limits; that includes the frequency of exhausted serialization retries, a coordinator that stalls while holding the gate, and the missing recovery of an unknown result in steps 4 and 5 of the page.

Defaults applied without objection: branch `claude/issue-16-p7-failure-validation`; plan, `docs/ISSUE_16_VALIDATION.md` and evidence under `test-results/admission-v1/` follow the P4–P6 convention; local commits per task with the trailer of the P6 branch (no model name); the review scope is reported before any push; model identifiers of reviewers go to the chat report, not into the repository; the fault topology raises the purchase limit (every buyer is another user) and the browser environment keeps 5 per minute with gaps between scenarios; the five-minute reservation sweeper is watched once in real time; a defect is reported before product code is changed; `docker-compose.flash-sale.yml` is P8's and is not touched.

## Global constraints

- Contract text and every file under `src/` outside `src/tests/` do not change unless a defect is confirmed, reported and its fix approved. No new dependency. No CI change. No push, PR, merge or deployment.
- Only resources created by this task are started, stopped, paused, killed or removed. Each carries the label `peakpass.task=peakpass-p7-20261004`. `peakpass-wave3-0928-*`, the Compose containers and every other container and image stay untouched.
- One Redis serves one PostgreSQL database. Redis runs with `--save "" --appendonly no --maxmemory-policy noeviction` on its command line, so the profile survives a restart. A fixture that publishes a namespace for an event without a protected policy never shares a Redis with a running scheduler.
- A host port is chosen at run time by asking the operating system for a free one and is then published explicitly, so it survives stop and start. No port number is written into the source tree.
- Protection is switched by the contract's explicit transition: exclusive event gate, real `UPDATE admission_events`. At most one event is protected per database.
- A purchase whose outcome is unknown (no answer, 429, 5xx, 409 `ADMISSION_IN_PROGRESS`) is repeated with the same body, the same admission and the same key, and never with another identity.
- Orderings are taken from PostgreSQL commit timestamps, PostgreSQL `clock_timestamp()` and Redis `TIME`, all inside the same Docker VM, never from the Windows host clock.
- The sampled maximum of a counter is never evidence of a bound. Capacity and rate are checked on the full transition log, and a log counts only when its capture began on an empty admission keyspace and its replayed end state equals the keys Redis holds.
- Every record names its evidence kind: real (container, process, TCP, timer, browser), synthetic stimulus (gate, trigger, SQL-made users, SQL activation), injected (proxy), stored earlier result.
- No number is reported that was not measured. P7 claims no throughput, latency or polling result; counts observed in one local run are labelled as observations.
- Passwords, tokens and secrets are generated at run time, kept in files outside the repository or in memory, and never printed or archived.

## Review focus

- A scenario that passes although its fault never happened: each one first shows the fault (container state, a refused or unanswered request, a terminated session) and only then asserts recovery.
- An incomplete transition log read as a clean one: a capture that began with admission keys present, or whose end state differs from Redis, fails the scenario instead of passing it.
- A retry that changes identity: the buyer of the fixture must not send another body, admission or key after an unknown outcome, or the suite would hide exactly the duplicate it looks for.
- A stimulus that outlives its scenario: every trigger and every held gate is removed in `finally`, and a suite that fails still removes its containers.
- A slot returned without a durable reason: after quiescence every admitted entry is consumed, expired or cancelled, and each `closed` or consumed ledger row has its Redis entry.

## Scenario catalogue

Redis: R1 pause and unpause; R2 stop and start (state lost); R3 restart; R4 `FLUSHALL`; R5 a coordinator killed at each of three reset stages held by the gate; R6 repeated loss with pauses, generation monotonic.
Processes: M1 buyers on three applications (two schedulers, one instance with the feature off); M2 one admission used on two instances at once; K1 kill inside the transaction, retry within the deadline; K2 kill, no retry, the 15 s deadline in real time; K3 death after COMMIT and before the answer (Redis paused, application killed); K4 an application stalled across the idle timeout and the claim deadline; K5 SIGTERM with a purchase in flight.
Database: T1 `statement_timeout` by its own timer; T2 PostgreSQL restart with purchases in flight; T3 eight admitted buyers at the same moment.
Lifecycle and existing flows: L1 activation while purchases arrive; L2 release with writers attached; L3 event deletion with writers attached; L4 reservation expiry, order deadline against settlement with several sweepers, late settlement, failed payment and callback replay after a Redis restart, all on a protected event; L5 authentication, foreign admission and direct endpoint matrix across instances.
Browser: B1 join to ticket; B2 Redis restart while waiting and while admitted; B3 Redis pause during a purchase; B4 application death after commit, then restart; B5 SIGTERM and restart while waiting; B6 real purchase errors 400, 409 mismatch, 409 in progress, 410 reset, 410 cancelled and sold out; B7 checkout answer lost, same tab and after a reload; B8 user A → B → A across a Redis restart.

## Task 0: Baseline

Outside the repository: `run/setup.mjs` (owned containers, env files), run logs.

- [x] Re-check origin/main, the contract hash and the issue gates. `npm ci`. Owned PostgreSQL (`track_commit_timestamp=on`) and Redis instances with the task label and explicit host ports; credentials in files outside the repository.
- [x] Record build, typecheck, lint, unit, full integration, harness and callback results at the base before any change, and compare them with the stored P6 result (unit 228, integration 346 passed / 15 skipped, harness 29).

## Task 1: Harness

Files: new `src/tests/helpers/admission-transition-log.ts`, new `src/tests/unit/admission-transition-log.test.ts`, new `src/tests/integration/admission-final.sql`, new `src/tests/integration/admission-fault-fixture.ts`, new `src/tests/integration/admission-fault-process.test.ts` (first scenario only).

Interfaces:

- `parseMonitorLine(line: string): MonitorEntry | null` with `MonitorEntry = { time: number; source: string; args: string[] }`; `source` is `lua` for a command a script ran.
- `replayAdmissionLog(entries: MonitorEntry[], profile = { rate: 2, capacity: 8 }): Replay` with `Replay = { violations: Array<{ rule, detail, time }>, promotions: number, namespaces: Map<string, { waiting, active, claims }>, controls: Array<{ eventId, generation, epoch, mode, time }> }` and `rule` one of `capacity | rate | repromotion | fifo | claim-without-slot | generation`.
- `admission-final.sql`: one statement, no parameter, rows `(check_name, event_id, detail)`; no row means every check holds.
- `admission-fault-fixture.ts`: `faultSuite` (`describe` or `describe.skip` by `ADMISSION_FAULT_IMAGE`); `startTopology(options)` returning the owned network, PostgreSQL, Redis and application containers with `pool`, `redis`, `apps`, `docker()`, `event()`, `protect()`, `buyer()`, `holdGate()`, `slow()`, `violations()`, `transitions()` and `destroy()`.

- [x] Failing unit tests for the replay: nine entries in `active` is a `capacity` violation and eight is none; three promotions inside one rolling second is a `rate` violation and two is none; an entry promoted twice; a promotion that leaves a lower sequence waiting; a claim for an entry without a slot; a `ready` publication of a lower generation; `UNLINK` and `FLUSHALL` clear the state; a script body with quotes and escapes parses.
- [x] Implement the parser and the replay; the unit file passes.
- [x] The final SQL file with the checks of contract §8: bounds, the seat equation, tickets against orders, consumed results against their targets, occupations of a protected event without a result, payment records against callback keys.
- [x] The fixture: topology, migrations through the image, `MONITOR` capture on a raw socket that reads the admission keys and subscribes in one pipeline, buyers with the same-identity retry rule, gate and trigger stimuli, cleanup by label.
- [x] Build the image. M1 passes both checks; a capture that starts late fails as incomplete.

## Task 2: The ten fixed-port Redis-outage tests

Files: new `src/tests/integration/redis-outage-fixture.ts`; `redis-recovery.test.ts`, `order-expiration-http.test.ts`, `order-sweeper.test.ts` (guards only).

Interface: `ownedRedis(): { name: string; id: string }` throws unless `WAVE3_REDIS_DESTRUCTIVE=1`, `WAVE3_REDIS_CONTAINER` and `WAVE3_REDIS_CONTAINER_ID` are set, `docker inspect` returns that id, the container carries the label `peakpass.redis-outage=owned`, and its explicit host port of `6379/tcp` on `127.0.0.1` equals `REDIS_PORT`.

- [x] Replace the four literal checks by the helper; nothing else changes in those files.
- [x] Run the ten cases on the owned Redis. A failure is classified (test rot or product regression) before anything is changed.

## Task 3: Real Redis failures and reset stages

Files: new `src/tests/integration/admission-fault-redis.test.ts`.

- [x] R1–R4 with waiting users, admitted users, one purchase in flight and committed reservations: the answers of the three path groups during the outage, before the namespace is published and after it; generation unchanged after a pause and exactly one higher after a loss; old admissions 410; the committed request replays; no old-epoch result commits after the reset.
- [x] R5 at the three stage boundaries and R6.

## Task 4: Processes and database

Files: `src/tests/integration/admission-fault-process.test.ts`.

- [x] M1, M2, K1, K2, K3, K4, K5.
- [x] T1, T2, T3.

## Task 5: Lifecycle and existing flows

Files: new `src/tests/integration/admission-fault-flows.test.ts`.

- [x] L1, L2, L3, L4, L5.

## Task 6: Production image

- [ ] `production-image-check.mjs` with the feature off and on, on empty databases; a restart on a database at 013 with rows applies nothing and changes no row; the five Docker lifecycle cases with `WAVE4_TEST_IMAGE`.

## Task 7: Browser

Outside the repository: the proxy, the filler-user script, the scenario scripts and the environment files, adapted from the P6 archive.

- [ ] Two application containers that differ in the demo user, the page served cross-origin, one protected event.
- [ ] B1–B8. For each: the page trace, the request list without headers, the application log extract and the final SQL.

## Task 8: Regression, evidence and handoff

Files: new `docs/ISSUE_16_VALIDATION.md`, `docs/README.md`, `test-results/admission-v1/p7-*.{json,zip}`.

- [ ] Build, typecheck, lint, unit, full integration with every opt-in, harness and callback checks. The fault suites three times in a row.
- [ ] Sensitivity: three or four product branches changed one at a time in a throwaway image, the named fault test fails each time, the source is restored.
- [ ] Record commands, results, evidence kinds, what stays unverified, limits and the notes for P8. Re-check the consumed inputs. Commit locally; report the review scope; no push.

## Execution ledger

- Base `5016b8c02bb2631a468258d03a5529cbbe72f0ce` (origin/main rechecked 2026-10-04 by `git ls-remote`, no open PR among the phase branches). Contract blob `47cb6fbe4f0d84d437008a1981f16a929cc5732f`, SHA256 unchanged. P4 `4b8847e`/`51d331b`, P5 `e3fb7e2`/`9eca324` and P6 `621e937` are ancestors. Worktree `claude/issue-16-p7-failure-validation`, created with `--no-track`; the user's main checkout and every other worktree untouched.
- Ruling: the user's "no objection, proceed as recommended" after the reviewed chat design is the execution instruction and approves the plan, `npm ci`, the owned resources and local commits per task, as in P5 and P6. The accepted contract and that design are the spec, so no separate spec or plan approval stage is added. Push, PR and independent review remain unapproved.
- Ruling: the ledger is this section and the working files are in the run directory outside the repository, as in P5 and P6.
- Owned resources (run `peakpass-p7-20261004`): PostgreSQL 16.12 with `track_commit_timestamp=on` and the databases `peakpass_test`, `peakpass_browser`, `peakpass_image_off`, `peakpass_image_on` and `peakpass_upgrade`; two Redis 7.4.8 instances (save "", appendonly no, noeviction, 256MiB), one for the integration suite and one for the browser environment. Every host port was asked from the operating system at creation and published explicitly. Labels `peakpass.task=peakpass-p7-20261004`, and `peakpass.redis-outage=owned` on the two Redis containers. Credentials are kept in files outside the repository. The fault suites create and remove their own network, PostgreSQL, Redis and application containers on each run.
- Task 0: baseline at `5016b8c` on the owned resources — build and typecheck passed, lint 0 errors/11 warnings, unit 228/228 (23 suites), integration 346 passed/15 skipped (30 suites passed, 2 skipped), harness 29/29, callback check passed. The same counts as the stored P6 result.
- Task 1: `8be7d53` transition-log replay. RED (the helper missing) → GREEN 14/14.
- Task 1: `a522705` final SQL. RED 6 failed (the file missing) → GREEN 6/6.
- Task 1: Ruling: `unlinked_occupation` reports every reservation of a protected event without its consumed result, also one that expired or was converted since — it was an occupation when it was made; the first GREEN run failed on a test state that had an expired reservation without a result, and the test input was corrected, not the SQL — cost if wrong: none for the product; a reader must not read the check on an event that was protected only after its first purchase, which the file's header says.
- Task 1: Ruling: the label of the fault containers comes from `ADMISSION_FAULT_TASK` (default `admission-fault`) and each run adds `peakpass.fault-run=<its prefix>`; a suite removes only containers whose run label is its own — a dated task label does not belong in the source tree, and the run script sets `peakpass-p7-20261004` — cost if wrong: none.
- Task 1: Ruling: the MONITOR capture is a raw socket from the test process, not `redis-cli`, and it reads the admission keys in the same pipeline that subscribes — one read is executed back to back by Redis, so "no key seen" proves that nothing was written before the capture — cost if wrong: an incomplete log would be read as complete; the replayed end state is compared with Redis as a second check, and a capture that begins late is asserted to report itself (M1).
- Task 1: Ruling: a Redis restart is a stop followed by a start, with the capture armed before the start — a single `docker restart` gives no moment at which only the new process can be reached — cost if wrong: the `docker restart` command is exercised for PostgreSQL only.
- Task 1: `57d2d91` fault fixture and M1. Image `peakpass:p7-issue16` built from the worktree. M1 passed on its first run and again with the late-capture check; one run recorded 22 buyers, 20 promotions, 11 purchases, 7 sold-out rejections, 5 requests answered 503 by the instance with the feature off (observations of one local run).
- Task 2: guard of the ten fixed-port Redis-outage cases. RED: with the old guard on the owned Redis, 10 failed (the fixed fixture was refused: the name literal, port 63532, the `wave3` label) and 22 passed. GREEN: 32/32 in the three files; the ten cases ran for the first time on code later than P3 and passed without a change to their assertions. The owned Redis kept its host port through every stop and start of those cases.
- Task 3: Redis fault suite. One run of the whole file: R1, R4, R5 and R6 passed, R2 and R3 failed on one assertion each (finding F1 below). Observations of that run: paused Redis answered after about 5 s (status and join 503 `ADMISSION_UNAVAILABLE`, purchase and exempt checkout 503 `RATE_LIMIT_UNAVAILABLE`, `/ready` 503, `/health` 200 at once); stopped Redis answered the same codes within milliseconds; after `FLUSHALL` the old admission was answered 503 `ADMISSION_RECOVERING`, 503 `ADMISSION_UNAVAILABLE` and then 410 `ADMISSION_RESET`; three coordinators killed at the three stage boundaries cost one generation; three losses with a paused coordinator cost one generation each.
- Task 3: **Finding F1 (product, P4 lifecycle, not in #25): one Redis restart costs two generations.** Reproduced in every run of R2 and R3 (five of five). After the restart the next generation is initialized with the run id of the stopped Redis process and published; one scheduler tick later (about 260 ms in the recorded run) both coordinators freeze it and publish a second new generation under the new run id. Cause, read from the code and matched by the transition log: during the outage `maintain()` reads a failed control as missing (`control().catch(() => null)`) while `isReady()` still holds, `recover()` then waits for the exclusive gate behind the purchase in flight, Redis is replaced meanwhile, and `initializeAdmission(current, this.runId)` uses the run id verified before the outage. Nothing is occupied twice and every answer is fail-closed; an entry registered in the short-lived epoch is reset again. Contract §6 says a coordinator that saw the loss does not raise the generation again once it is recovered. Not fixed: product code changes only after the user's decision.
- Task 3: Ruling: R2 and R3 keep asserting one generation per loss and stay failing until F1 is decided; the count is asserted at the end of the scenario so that the rest of it is still checked — a test is not weakened to pass a finding — cost if wrong: two opt-in scenarios stay red.
- Task 3: Ruling: the replay has a seventh rule, `run-id`: a control initialized under the run id of a server process the fixture replaced. RED 1 failed → GREEN 15/15. It makes F1 visible in the invariant check itself — cost if wrong: none; a flushed server of the same process keeps its run id and is not reported.
- Task 3: Ruling: `verify()` reports the log violations from the start of the current scenario (`begin()`); the log is still replayed from its beginning — otherwise one finding fails every later scenario of the file — cost if wrong: a violation that a scenario causes before its `begin()` is attributed to the scenario before it.
- Task 3: Ruling: in R1 the purchase that committed during the pause was finalized by its own `complete` once Redis resumed, because the pause (about 5.3 s, the time the outage probes took) ended inside the 5 s command bound of that call; the scenario asserts that the entry becomes consumed and leaves the lost-finalization path to K3 — cost if wrong: none.
- Task 4: process and database suite, one run of the whole file: 12/12. Observations of that run: M2 saw both winners (the reservation four times, the direct checkout once in five rounds); K1's request on the other instance was answered 409 `ADMISSION_IN_PROGRESS` twice after PostgreSQL's 1 s lock bound each time and then 201; K2's claim was closed 103 ms after its deadline; K3's result was reflected by the other instance after the deadline; K4's resumed writer answered 503 after 22 s and committed nothing; T1 answered 503 after 5020 ms; T2 and T2b answered 503 for the purchase in flight while the status API answered 200; T3's eight simultaneous purchases were answered 201 six times and 503 `ADMISSION_UNAVAILABLE` twice at first, and all eight landed once.
- Task 4: **Finding F2 (product, shutdown; a delay, so a limit by decision D8): after SIGTERM the instance stays up until the connection of the request it answered while shutting down is closed.** With a client that closes its connection the process exited 0 after 3.3 s (K5). With a keep-alive client it exited 0 after 73.3 s (K5b), which is Fastify's default 72 s keep-alive timeout; the image runs Node 18, whose `server.close()` leaves a connection that goes idle afterwards open. In the first run the process left after 40.3 s, when an unrelated request of the test reused the connection and was answered 503 with `Connection: close`. Everything the shutdown promises still happened in order: Redis fenced, the request in flight answered 201, the result left to the other instance's reclaimer, PostgreSQL closed, exit 0. An orchestrator with a shorter grace period would kill the process before that exit. Not fixed.
- Task 4: Ruling: K5 is two scenarios. K5 sends the purchase on a connection the client closes and asserts exit 0 within 15 s; K5b uses a keep-alive client, asserts exit 0 and records the time — the shutdown order is the contract, the waiting time is the observation of F2 — cost if wrong: a slow exit with a closing client would be caught by K5, a slow exit with keep-alive is recorded and not failed.
- Task 4: Ruling: K1 sends the same request to the other instance before the trigger is removed, so that the answer while PostgreSQL still holds the dead process's lock is seen (409 `ADMISSION_IN_PROGRESS`), and T2 got a second form T2b in which PostgreSQL is killed instead of restarted — both are real failures the first form did not show — cost if wrong: none.
- Task 4: the first run of the whole file was stopped after K5 failed on its 40 s exit bound (F2); its five containers and its network were removed by name after their run label was checked.
- Task 5: lifecycle and existing-flows suite. First run of the whole file: L2, L3, L5, L4 and L4c passed and L1 failed on its list of expected answers; L1 passed on its own after that list was corrected (observation O1). Observations: L1's reservations were answered 201 until the activation and 400 `ADMISSION_INVALID_INPUT` after it, and no occupation without a result committed after the activation's commit time; L2's writer committed before the release and the queue API then answered 404; L3's deletion waited for the writer and was refused by the foreign key, and in three rounds against a queue-only event the deletion won each time and the purchase answered the existing 404; L5's ten ways around the gate were answered 401, 403, 400, 404, 410 and 409 and changed no count; L4's orders were paid when the settlement came up to the deadline and expired when it came 100 and 300 ms after it, each with its tickets or its seats back; L4c's reservation was expired by the product's own five-minute sweeper.
- Task 5: **Observation O1 (existing unprotected path, as before the queue): a direct checkout without admission fields answers 500 when its three serialization attempts run out.** In L1, before the activation, 34 of 47 such checkouts were answered 500 `INTERNAL_ERROR` while reservations updated the same event row (one local run). P5 kept this answer on purpose for requests without admission fields; with admission fields the same condition answers 503. It concerns the A arm of P8.
- Task 5: Ruling: L1 allows 500 `INTERNAL_ERROR` for direct checkouts without admission fields and nothing else beyond 201 and 400; reservations must be 201 or 400 only — the first version expected only 201 and 400 on both paths, which was wrong about the existing checkout — cost if wrong: a new 500 on the direct path before activation would pass L1; after activation the request is refused before it touches the event row.
- Task 5: Ruling: the creation time of an order is read from the commit time of its checkout payment record, because the order row itself is rewritten when it expires — cost if wrong: none; the record is written in the same transaction and never changed.
- Task 5: Ruling: in the purchase-against-deletion rounds the deletion may also end as the victim of a lock cycle (40P01) and the purchase is repeated with the same identity — the purchase holds the policy row the cascade needs while the deletion holds the event row the purchase needs — cost if wrong: none; both outcomes leave either the event with its reservation or neither.
- Task 1: Ruling: M1 verifies existing behaviour and so never failed first. That it can fail rests on the unit tests of the replay, the SQL test, the late-capture assertion and the sensitivity step of Task 8 — cost if wrong: a vacuous assertion stays unnoticed until Task 8.
