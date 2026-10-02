# Issue #13 / P4 implementation and P5/P6 handoff

Run: `peakpass-p4-20261002`. This is a local implementation candidate, **not an accepted P4 tuple or permission to activate a protected event**. Acceptance remains in [#9](https://github.com/dosacha/PeakPass/issues/9). No purchase service or durable result ledger is added by P4.

Final code: `c51ebd6dc8219e000d9f35afefc49dbf849c284b`, branch `codex/issue-13-admission`. Read-only final reviewer: actual `gpt-6-astra/high`, **No findings** at that code SHA. The initial whole-branch review of `55a97fd` covered 27/27 changed files and found one P2 stale-observation reset race. Root reproduced both epoch/phase variants RED→GREEN, fixed the shared normal/retry decision, and reran the complete suites. The same reviewer checked the three-file fix delta. This is static review plus root-executed local validation, not independently rerun tests or product activation approval.

**PR #24 review follow-up.** GitHub's automated Codex review of PR head `e6583fb70c14d0a99a19c530eeda1b178b64274d` raised three P2 findings that the static verdict above did not cover. Each was reproduced RED and fixed in `e408fd246d7467af3b555d6a96707fafe10afde3`; `14dd4979ab17506b2aaac11a3f6e9eb7d3148812` adds one more regression test and is the current code. Text marked *(follow-up)* describes that state. Everything else, including the reviewer verdict, the 276/10 run and the image checks, still describes `c51ebd6` and was not rerun in the same shape; see [PR #24 review follow-up](#pr-24-review-follow-up).

## Consumed input

- Base main: `f2a4674133cbeb50a65590f75bd9140efc32ff1d`, containing handoff PR23 (`724aae1113c4c8dc31df093b1dbd9406f3c6ce2f`). User reviewed the design before authorizing implementation.
- P3 accepted: `87959cd84dbb231caa88fee2e4ad4bcd84115246`, `admission-v1`. Contract LF Git blob SHA256: `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`. The contract is unchanged.
- P2: `flash-sale-v2.6` / `flash-sale-analysis-v2.6.1`; accepted v261 index SHA256 `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6`. No P2 load experiment was rerun.
- `admission-v1-seed`: R2/s, C8, TTL30s, claim15s, tick250ms/batch2, cleanup100/reclaim8, waiting lease120s, waiting1000/entries10000, epoch24h. These are correctness-test assumptions, **not maximum throughput or operating recommendations**.
- At start, #9/#12/#13 and #14–#18 retained P1/P2/P3 valid, P4 ready to implement, P5/P6 blocked on P4 acceptance. A local passing test does not change those gates.

## Implementation boundaries

| Area | Implementation and invariant |
| --- | --- |
| Policy | Migration012 adds `admission_events`, backfills false policies, and limits protected events to one with a partial UNIQUE index. New event policies are ensured under the common gate. P5 owns the next migration for `admission_results`. |
| Public API | JWT-required GET `/events/:eventId/admissions/me`, POST `/events/:eventId/admissions`, DELETE `/events/:eventId/admissions/:admissionId`. Strict UUID/input validation, no-store, exact admission error envelope. Internal claim commands have no REST route. |
| Redis | One bounded Lua dispatcher changes records and indexes atomically. `TIME` owns deadlines; INCR decimal strings own FIFO. R counts successful promotions in `(t-1000,t]`; C includes idle and unresolved claims. Terminal identity mappings have no TTL within the epoch. The 24h session deadline closes join/status/cancel/claim/promotion; token-matched `complete`/`close` and `reconcile` stay open until the generation is frozen *(follow-up)*. |
| Integrity | Hash/ZSET sentinels and cardinalities detect missing structures. A dirty bit set before mutation remains after a partial Lua failure. Reconnection version and Redis process identity prevent silently trusting a replacement process. |
| Lifecycle | Freeze CAS → exclusive PG barrier/new generation → exclusive initializing/open commit → **new exclusive PG transaction** and ready CAS. Intact initialization resumes without erasing data. Stale/null observers adopt completed recovery. Retired cleanup uses generation/epoch CAS and bounded UNLINK. A failed maintenance command is not treated as loss *(follow-up)*: after re-verifying the Redis process the coordinator re-reads and probes the namespace and resets only an established replacement, corruption, session end or loss. A released policy is retired under the same barrier *(follow-up)*: its control and that epoch's keys are unlinked, and an `open` policy advances to a new `recovering` generation so a published epoch is never reused. |
| Shutdown | Sequential timer, no overlapping iteration, idempotent stop that awaits inflight work. Redis is fenced before draining HTTP/order/admission workers; PG closes afterward, including listen failure. |
| Activation | `ENABLE_ADMISSION=false` by default. No activation route or bypass flag. Production startup and readiness reject every protected policy until P5's purchase gates replace this explicit P4 guard. The protected-policy tests use isolated helpers/fixtures. P4 still has no activation or release route; the coordinator only converges a release committed under the exclusive gate *(follow-up, see Lifecycle)*. Any other direct SQL edit while serving and mixed old/new deployments remain unsupported. |

Keys start with `peakpass:admission:<eventId>:`. `control` holds generation/epoch/mode/runId/dirty; `<epoch>:` contains meta, entries, joins, latest, users, waiting, leases, active, claims, window and sequence. Limiter keys are `limit:<userId>:<action>`, separate from existing purchase limiters and from epoch rollover. Sentinel members are excluded from ranks/counts. Retired keys are deleted only after a durable barrier and only while the expected current generation remains ready. A released policy's control and current-epoch keys are unlinked together under its exclusive gate *(follow-up)*; keys of that event's earlier retired epochs wait for the bounded cleanup that runs once it is protected again.

Normal ready status uses Redis only. The cold path for an absent control performs a policy lookup to distinguish an unprotected/nonexistent event404 from protected recovering503; it never initializes Redis from a request. This deliberately avoids a second policy cache/registry. Repeated cold404 requests can access PG; they are not the normal active-queue polling path. A GET racing with reset returns recovering503, while a submitted old epoch on mutation returns410. For the same reason a released policy is fenced by retiring its control, not by a per-request policy read *(follow-up)*: it keeps answering from Redis until a scheduler tick retires it. Instances with the feature off run no scheduler and keep returning503 for a leftover control until an enabled instance retires it.

Redis must have AOF/RDB off and `maxmemory-policy=noeviction`. CONFIG/INFO permission is required to verify this profile. CI configures its dedicated Redis fixture accordingly. The production image check now includes migration012 and the admission readiness field, and accepts `ENABLE_ADMISSION` for the enabled smoke.

## P5 cooperation interface

Source: [policy helper](../src/infra/postgres/admission-policy.ts), [service](../src/core/services/admission.service.ts), [types](../src/core/models/admission.ts).

| Function | Caller obligations / returned information |
| --- | --- |
| `readAdmissionPolicy(client,eventId,mode='shared')` | Caller starts the transaction and supplies the **same PoolClient** used for the purchase. Gate → event existence → ensure → FOR SHARE/UPDATE. Missing event404; policy0-row503. UUIDs must be canonical lowercase. Do not put the gate behind a savepoint that may release it. |
| `lockAdmission(client,admissionId,tryOnly=false)` | After the shared event gate, before checkout-key/domain locks. Reclaimer uses `tryOnly=true` and skips false. Two-int namespaces 1347436869 (event) / 1347436867 (admission) are separate from existing bigint checkout locks. |
| `claim({eventId,userId,admissionId,epoch,fingerprint})` | P5 holds the admission lock. Returns the identity plus claimToken and deadline (Redis-time Unix **milliseconds**). P5 builds the canonical fingerprint from the contract array; P4 treats it as opaque. Same identity resumes the original token/deadline, including admission TTL passage; no deadline extension. |
| `complete(claim,outcome)` | Only after P5 commits/verifies a matching durable consumed/rejected result. Outcome is `{kind:'reservation'|'direct-checkout'|'rejected',resourceId:string|null,code:string|null}`. Repeating matching finalization does not refund another slot. Redis failure cannot undo DB success. Still accepted after the session deadline while the generation is ready; a frozen or reset generation answers503/410 and the durable result stays authoritative *(follow-up)*. |
| `reconcile(eventId)` | Returns at most eight overdue raw entries with identity/token/fingerprint/deadline, and marks reconciling. P4 retains C. P5 must use shared event gate → admission try-lock → fresh ledger read → immutable consumed/rejected replay or closed commit. Available after the session deadline on the same terms as `complete` *(follow-up)*. |
| `close(claim)` | Only after P5's matching closed commit. A timeout, absent ledger row, rollback or finally block is not authority to return C. Available after the session deadline on the same terms as `complete` *(follow-up)*. |
| `recover(eventId,observed?)` | Internal reset/recovery coordinator. An observed ready/frozen generation triggers the barrier; intact initializing state resumes. A stale observer may help the current generation. Not an HTTP/admin activation endpoint. For an unprotected policy it retires the Redis namespace instead of leaving it frozen *(follow-up)*. The scheduler does that unprompted only while the released policy is still `open`; a release that commits while the policy is `recovering` (interrupted recovery) is retired only by this call, so the release transition must invoke it after its commit. |

The helpers do not begin nested transactions. P5 reuses `serializableTransactionWithRetry` (three attempts, existing20ms exponential jitter base) and applies its contract transaction/lock/idle timeouts. `isAdmissionPolicyEventRace` recognizes only the policy→event FK violation for a fresh-transaction event recheck; do not map every FK/serialization failure to404.

Before replacing the P4 startup/readiness guard, P5 must integrate **both** new reservation and reservation-free new checkout, durable replay before current Redis/epoch checks, feature-off protected503, valid existing reservation/order exemptions, and all serving instances' version gate. P4 does not prove two-path single consumption, closed-before-late-writer safety, or durable response-loss recovery.

## P6 API handoff

- GET has no body and returns `contractRevision`, `serverTime`, `queue:{eventId,epoch,mode:'open'}`, `admission` or null, and `nextPollAfterMs`. `admission` exposes id/epoch/state/phase/decimal sequence/position/timestamps/reason/outcome; user identity, fingerprint, token and deadline are internal.
- GET obtains the current epoch. POST sends exactly `{epoch,joinRequestId}`: first201, same key replay200, different active key409 with only the owner's snapshot and **no alias**. Same join key from another owner409 without snapshot. Terminal retries return the original entry; an intentional new purchase uses a new key.
- DELETE sends exactly `{epoch}`: cancelled/expired replay200, processing/reconciling or consumed409, foreign/absent entry404. New registration after terminal state goes to the back.
- Errors are `{error:{code,message},nextPollAfterMs}`; only ACTIVE409 adds `admission`. Rate/queue full429 includes Retry-After rounded up to seconds. Unsupported/nonexistent event404, and a released event404 once its namespace is retired *(follow-up)*; recovery503; submitted retired epoch410. Invalid input400 and missing/invalid JWT401 do not renew a lease.
- Waiting base poll is1000ms at position≤10 and5000ms otherwise; admitted1000ms; terminal/null stops polling. P6 fixed mode remains1s; adaptive applies±20% jitter **then clamps1–5s**, hidden15s. Error delays use `max(jitteredBackoff,Retry-After,nextPollAfterMs)`; server minimum wins over15s cap.
- P6 must implement completion-before-next-timer, timeout5s, identity/epoch/request-generation discard of late responses, logout/event cleanup, GET reconnection, and same-identity purchase recovery before new join. None of those browser behaviors is proven by P4 HTTP tests.

## Verification record

Owned environment: Windows host Node24.15.0; Docker Node18 Alpine image; PostgreSQL16.12 on127.0.0.1:52727 and Redis7.4.8 on127.0.0.1:52728 (AOF/RDB off, noeviction,256MiB). Containers carry `peakpass.task=peakpass-p4-20261002`; existing user containers/checkouts were not changed. Tests are serial against disposable data. No production/browser load result is claimed.

| Check | Result / evidence boundary |
| --- | --- |
| Build / typecheck | `npm run build` and `npx --no-install tsc --noEmit` passed. |
| Lint | Zero errors,10 warnings (nine pre-existing and one test-only `any`). |
| Unit | 160/160 passed, including admission sequential stop and admission-enabled repeated signal/listen-failure drain ordering. |
| PostgreSQL | Real partial UNIQUE/check constraints,011 upgrade, backfill/lazy ensure404; blocked shared/exclusive gates observed by `pg_blocking_pids`; both existing-false/missing-policy SERIALIZABLE snapshots retried in distinct transactions. |
| Redis/HTTP | Actual Redis and application loopback listen/fetch: concurrent10 join, owner privacy, active409, Retry-After, terminal replay, PG0 normal GET; two child workers share FIFO/rollingR/C; deadline claims retain slots; waiting/entry bounds and cleanup100. |
| Fixture disclosure | Logical expiry fields and the10000-entry terminal history are synthetic initial states, followed by real Lua calls. HTTP response discard/retry is not a network partition. PG query spies measure normal GET access; they do not measure production load. |
| Crash recovery | Actual child SIGKILL at freeze, barrier commit, Redis initialization and PG-open commit. Parent resumes generation exactly once. Separate tests cover coordinator overlap, missing-control stale observer, partial structure loss and stale cleanup/publication CAS. |
| Product guard | Actual startup refuses protected policy with flag false/true and refuses unsupported Redis policy. Protected fixture API tests do not start the product via an activation bypass. |
| Production image | Two dedicated empty DBs: flag off and on; migrations001–012, unchanged rerun, readiness and signed GraphQL smoke passed. Existing011 DB applied only012. |
| Full integration | **276 passed /10 skipped**,28 suites passed after the final fix. Includes all five production Docker order-worker lifecycle tests with `WAVE4_TEST_IMAGE=peakpass:p4-issue13-final`. First attempt:268 pass/1 failure/15 skip; failure was an existing subprocess inheriting host5432 instead of the dedicated DB. Explicit process environment corrected it; raw failed attempt retained. |
| Harness regression | `npm run test:flash-sale`:29/29; callback run-isolation check passed. These are harness checks, not load runs. |
| Skips | Seven redis-recovery, two order-sweeper Redis outage, one order-expiration-http Redis-stop cases. They require their exact old container identity and reserved port63532; they are not retargeted or claimed as run. All ten names are in the final manifest. P4 corruption/recovery fixtures are distinct evidence. |

Raw outputs: [candidate manifest](../test-results/admission-v1/p4-candidate-20261002.json) / [candidate ZIP](../test-results/admission-v1/p4-candidate-20261002.zip), [final manifest](../test-results/admission-v1/p4-final-20261002.json) / [final ZIP](../test-results/admission-v1/p4-final-20261002.zip). Each manifest records the ZIP and uncompressed file SHA256 values. The candidate preserves the failed first full run and final #9/#12–#18 snapshots; the final archive preserves the review regression RED/GREEN, final suites/image results and the initial implementation RED outputs. The reviewer model is recorded from the actual spawn arguments, not its role label. No credentials or `.env` are archived.

Cleanup: after final verification, both owned PostgreSQL/Redis container IDs and task labels were checked, then those two disposable containers were stopped and removed. No containers remain with this task label. The worktree, validation archives and final image remain available for review.

Commands: `npm run build`; `npx --no-install tsc --noEmit`; `npm run lint`; `npm test -- --runInBand`; `npx jest --runInBand --config jest.integration.cjs`; `npm run test:flash-sale`; `node --experimental-vm-modules load-test/payment-callback-check.mjs`. Set `DB_HOST/PORT/USER/PASSWORD/NAME` and `REDIS_HOST/PORT` in the **parent process environment** against owned disposable resources, including for subprocesses; `.env` alone did not configure one existing subprocess. The Docker lifecycle opt-in uses the rebuilt image tag above. Image checks use separate empty DBs with `IMAGE_DB_HOST/IMAGE_REDIS_HOST=host.docker.internal` on this Windows host and run `node --import dotenv/config .github/scripts/production-image-check.mjs peakpass:p4-issue13-final` with `ENABLE_ADMISSION=false` and then `true`.

Final source refresh: origin/main remains `f2a4674133cbeb50a65590f75bd9140efc32ff1d`; P3 ancestor/contract hash and P2 index hash match the consumed values. #9/#12–#18 have no new comments or changed gates. User checkout remains at `54ca75a` with its original untracked work preserved. Remote CI/merge, product purchase integration, Redis pause/stop/restart with a real buyer, browser behavior and P8 capacity comparisons remain outside this local proof.

P5/P6 consume this implementation only after its accepted SHA is present in their checkout. P7 validates integrated fault behavior; P8 remeasures A/B/C, starting with A, at the same integrated SHA/environment (including new policy/gate and Redis profile). P9 consumes those accepted results. Unchanged P1/P2 source evidence stays valid; no successor is marked ready or complete solely by this document.

## PR #24 review follow-up

Run: `peakpass-pr24-review-20261002`. Input: GitHub Codex review 5388546072 of PR head `e6583fb70c14d0a99a19c530eeda1b178b64274d`, three P2 inline comments. Fix: `e408fd246d7467af3b555d6a96707fafe10afde3` on the same branch, five files (service, Redis commands, three integration test files), written in a separate worktree so the original checkout stayed untouched. A test-only commit `14dd4979ab17506b2aaac11a3f6e9eb7d3148812` then added a service-level regression; every check below except the baseline ran at that commit. No migration, route, response schema, profile value or contract text changed; the contract blob hash `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1` was rechecked at the fix commit. This remains a local candidate, not P4 acceptance.

| Finding (review comment) | Defect reproduced at `e6583fb` | Change in `e408fd2` |
| --- | --- | --- |
| Stale control after release (4163076374) | After protection was released under the exclusive gate, the ready control kept serving joins/status: `maintain()` selected only protected rows, and `recover()` froze the control and returned, which left503 instead of `ADMISSION_NOT_ENABLED`404. | `recover()` retires the namespace whenever its barrier finds the policy unprotected (all three transactions), and `maintain()` also selects released policies that are still `open`. Retirement unlinks the control with that epoch's keys and moves an `open` policy to a new `recovering` generation/epoch. |
| Reset on a transient failure (4163076377) | Any error from `promote()`/`reconcile()` made the retry path freeze the observed control, so the following probe failed and a new generation discarded an intact queue. | After re-verifying the Redis process, the retry path re-reads the control and probes it, and calls `recover()` only when the generation is no longer ready and structurally intact (replacement, dirty or missing structures, session end, missing control). An explicit `recover()` keeps its forced-reset meaning. |
| Finalization after the session deadline (4163076382) | The Lua deadline check rejected `complete`, `close` and `reconcile` with503 before their own logic ran. | The deadline still closes join/status/cancel/claim/tick; `complete`/`close`/`reconcile` run until the generation is frozen. |

Ruling: a present control stays authoritative on the request path, because ready polling must not read PG. A released policy is therefore fenced by retirement, and P4 still adds no release route. The test fixtures perform the release as the contract's explicit transition (exclusive gate, real UPDATE).

| Check | Result / evidence boundary |
| --- | --- |
| Baseline | Five admission suites at `e6583fb` on the owned resources before any change: 36/36. |
| RED | Tests of `14dd497` against the two source files of `e6583fb`: 7 failed / 23 passed, and the Redis protocol file did not compile because `retireAdmission` did not exist. |
| GREEN | The same three files at `14dd497`: 35/35. |
| Build / typecheck / lint | `npm run build` and `npx --no-install tsc --noEmit` passed. Lint: zero errors, the same 10 warnings. |
| Unit | 160/160. |
| Full integration | **280 passed / 15 skipped**, 27 suites passed and 2 suites skipped (295 tests). Nine tests are new. |
| Harness regression | `npm run test:flash-sale`: 29/29; callback run-isolation check passed. Harness checks, not load runs. |
| Two-process smoke | `node dist/main.js` built at `14dd497` with `ENABLE_ADMISSION=true` and its real scheduler. A second process protected and opened an event, then released it under the exclusive gate and made no further lifecycle call. Loopback HTTP: 200/201 while protected, the app's scheduler promoted the entry, then404 `ADMISSION_NOT_ENABLED`; control and epoch keys were gone and the policy was `recovering` at generation+1. One observation took 261ms with eight 200 answers before the first404; it is not a latency bound. |
| Fixture disclosure | The lost reply is one injected `EVAL` rejection, not a network partition. The session deadline and the overdue claim are written fields followed by real Lua calls. The in-flight release interleavings wrap `pool.connect` to commit the release between two real recovery transactions. PG gates/transactions, Redis commands and loopback HTTP are real. |
| Not rerun | Production image build and off/on empty-DB checks, the five Docker lifecycle cases (they are among the 15 skips here; they passed at `c51ebd6`), the existing-011 upgrade check, and an independent static review of this change. The ten legacy Redis-outage cases stay skipped for the reason recorded above. |

Remaining limits of the follow-up:

- Between the release commit and the next scheduler tick the old control still answers. The bound is one 250ms tick plus the wait for the exclusive gate; it is not zero.
- `maintain()` discovers a released policy through `phase='open'`. A release that commits while the policy is `recovering` after an interrupted recovery whose coordinator died is not discovered; its leftover frozen or initializing control answers503 until `recover(eventId)` runs or the event is protected again. The release transition must call `recover(eventId)` after its commit.
- Retirement unlinks the control's own epoch keys only. Keys of earlier retired epochs stay until the event is protected again and bounded cleanup runs.
- The maintenance query now reads `protected OR phase='open'`, which the partial protected index cannot serve. Its cost was not measured; P8 remeasures at the integrated SHA.
- A token-matched finalization that arrives after the freeze is still rejected with503/410. That is the existing fence, and the durable result remains the authority.

Owned environment: Windows host Node24.15.0; PostgreSQL16.12 and Redis7.4.8 (AOF/RDB off, noeviction,256MiB) on127.0.0.1:64369/64370 for the baseline and on127.0.0.1:53334/53335 for the runs at `14dd497`. Both container pairs carried `peakpass.task=peakpass-pr24-review-20261002` and were stopped and removed after their runs; no other container, checkout or database was changed. Commands are the ones listed in the verification record, without the Docker opt-in and the image checks.

Raw outputs: [follow-up manifest](../test-results/admission-v1/p4-review-20261002.json) / [follow-up ZIP](../test-results/admission-v1/p4-review-20261002.zip). The manifest records the ZIP and file SHA256 values, the smoke observation and the skipped suites. The archive also holds the disposable smoke fixture, which is not part of the source tree. No credentials or `.env` are archived.

Source refresh at the follow-up: origin/main remains `f2a4674133cbeb50a65590f75bd9140efc32ff1d` and the PR head before this push was `e6583fb70c14d0a99a19c530eeda1b178b64274d`. The P2 index hash matches the consumed value. The PR description still names `c51ebd6` as final code and was not edited. GitHub Actions `install-lint-test` passed on `2d138e940035443750506087da525073df9a728e`, the head that carried the fix and the first version of this record; that run includes the image build and the enabled image check. CI for later heads, review-thread replies, a new automated review and the gates in #9 are outside this record.
