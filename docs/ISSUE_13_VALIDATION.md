# Issue #13 / P4 implementation and P5/P6 handoff

Run: `peakpass-p4-20261002`. This is a local implementation candidate, **not an accepted P4 tuple or permission to activate a protected event**. Acceptance remains in [#9](https://github.com/dosacha/PeakPass/issues/9). No purchase service or durable result ledger is added by P4.

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
| Redis | One bounded Lua dispatcher changes records and indexes atomically. `TIME` owns deadlines; INCR decimal strings own FIFO. R counts successful promotions in `(t-1000,t]`; C includes idle and unresolved claims. Terminal identity mappings have no TTL within the epoch. |
| Integrity | Hash/ZSET sentinels and cardinalities detect missing structures. A dirty bit set before mutation remains after a partial Lua failure. Reconnection version and Redis process identity prevent silently trusting a replacement process. |
| Lifecycle | Freeze CAS → exclusive PG barrier/new generation → exclusive initializing/open commit → **new exclusive PG transaction** and ready CAS. Intact initialization resumes without erasing data. Stale/null observers adopt completed recovery. Retired cleanup uses generation/epoch CAS and bounded UNLINK. |
| Shutdown | Sequential timer, no overlapping iteration, idempotent stop that awaits inflight work. Redis is fenced before draining HTTP/order/admission workers; PG closes afterward, including listen failure. |
| Activation | `ENABLE_ADMISSION=false` by default. No activation route or bypass flag. Production startup and readiness reject every protected policy until P5's purchase gates replace this explicit P4 guard. The protected-policy tests use isolated helpers/fixtures. Direct SQL toggling while serving and mixed old/new deployments are unsupported. |

Keys start with `peakpass:admission:<eventId>:`. `control` holds generation/epoch/mode/runId/dirty; `<epoch>:` contains meta, entries, joins, latest, users, waiting, leases, active, claims, window and sequence. Limiter keys are `limit:<userId>:<action>`, separate from existing purchase limiters and from epoch rollover. Sentinel members are excluded from ranks/counts. Retired keys are deleted only after a durable barrier and only while the expected current generation remains ready.

Normal ready status uses Redis only. The cold path for an absent control performs a policy lookup to distinguish an unprotected/nonexistent event404 from protected recovering503; it never initializes Redis from a request. This deliberately avoids a second policy cache/registry. Repeated cold404 requests can access PG; they are not the normal active-queue polling path. A GET racing with reset returns recovering503, while a submitted old epoch on mutation returns410.

Redis must have AOF/RDB off and `maxmemory-policy=noeviction`. CONFIG/INFO permission is required to verify this profile. CI configures its dedicated Redis fixture accordingly. The production image check now includes migration012 and the admission readiness field, and accepts `ENABLE_ADMISSION` for the enabled smoke.

## P5 cooperation interface

Source: [policy helper](../src/infra/postgres/admission-policy.ts), [service](../src/core/services/admission.service.ts), [types](../src/core/models/admission.ts).

| Function | Caller obligations / returned information |
| --- | --- |
| `readAdmissionPolicy(client,eventId,mode='shared')` | Caller starts the transaction and supplies the **same PoolClient** used for the purchase. Gate → event existence → ensure → FOR SHARE/UPDATE. Missing event404; policy0-row503. UUIDs must be canonical lowercase. Do not put the gate behind a savepoint that may release it. |
| `lockAdmission(client,admissionId,tryOnly=false)` | After the shared event gate, before checkout-key/domain locks. Reclaimer uses `tryOnly=true` and skips false. Two-int namespaces 1347436869 (event) / 1347436867 (admission) are separate from existing bigint checkout locks. |
| `claim({eventId,userId,admissionId,epoch,fingerprint})` | P5 holds the admission lock. Returns the identity plus claimToken and deadline (Redis-time Unix **milliseconds**). P5 builds the canonical fingerprint from the contract array; P4 treats it as opaque. Same identity resumes the original token/deadline, including admission TTL passage; no deadline extension. |
| `complete(claim,outcome)` | Only after P5 commits/verifies a matching durable consumed/rejected result. Outcome is `{kind:'reservation'|'direct-checkout'|'rejected',resourceId:string|null,code:string|null}`. Repeating matching finalization does not refund another slot. Redis failure cannot undo DB success. |
| `reconcile(eventId)` | Returns at most eight overdue raw entries with identity/token/fingerprint/deadline, and marks reconciling. P4 retains C. P5 must use shared event gate → admission try-lock → fresh ledger read → immutable consumed/rejected replay or closed commit. |
| `close(claim)` | Only after P5's matching closed commit. A timeout, absent ledger row, rollback or finally block is not authority to return C. |
| `recover(eventId,observed?)` | Internal reset/recovery coordinator. An observed ready/frozen generation triggers the barrier; intact initializing state resumes. A stale observer may help the current generation. Not an HTTP/admin activation endpoint. |

The helpers do not begin nested transactions. P5 reuses `serializableTransactionWithRetry` (three attempts, existing20ms exponential jitter base) and applies its contract transaction/lock/idle timeouts. `isAdmissionPolicyEventRace` recognizes only the policy→event FK violation for a fresh-transaction event recheck; do not map every FK/serialization failure to404.

Before replacing the P4 startup/readiness guard, P5 must integrate **both** new reservation and reservation-free new checkout, durable replay before current Redis/epoch checks, feature-off protected503, valid existing reservation/order exemptions, and all serving instances' version gate. P4 does not prove two-path single consumption, closed-before-late-writer safety, or durable response-loss recovery.

## P6 API handoff

- GET has no body and returns `contractRevision`, `serverTime`, `queue:{eventId,epoch,mode:'open'}`, `admission` or null, and `nextPollAfterMs`. `admission` exposes id/epoch/state/phase/decimal sequence/position/timestamps/reason/outcome; user identity, fingerprint, token and deadline are internal.
- GET obtains the current epoch. POST sends exactly `{epoch,joinRequestId}`: first201, same key replay200, different active key409 with only the owner's snapshot and **no alias**. Same join key from another owner409 without snapshot. Terminal retries return the original entry; an intentional new purchase uses a new key.
- DELETE sends exactly `{epoch}`: cancelled/expired replay200, processing/reconciling or consumed409, foreign/absent entry404. New registration after terminal state goes to the back.
- Errors are `{error:{code,message},nextPollAfterMs}`; only ACTIVE409 adds `admission`. Rate/queue full429 includes Retry-After rounded up to seconds. Unsupported/nonexistent event404; recovery503; submitted retired epoch410. Invalid input400 and missing/invalid JWT401 do not renew a lease.
- Waiting base poll is1000ms at position≤10 and5000ms otherwise; admitted1000ms; terminal/null stops polling. P6 fixed mode remains1s; adaptive applies±20% jitter **then clamps1–5s**, hidden15s. Error delays use `max(jitteredBackoff,Retry-After,nextPollAfterMs)`; server minimum wins over15s cap.
- P6 must implement completion-before-next-timer, timeout5s, identity/epoch/request-generation discard of late responses, logout/event cleanup, GET reconnection, and same-identity purchase recovery before new join. None of those browser behaviors is proven by P4 HTTP tests.

## Verification record

Owned environment: Windows host Node24.15.0; Docker Node18 Alpine image; PostgreSQL16.12 on127.0.0.1:52727 and Redis7.4.8 on127.0.0.1:52728 (AOF/RDB off, noeviction,256MiB). Containers carry `peakpass.task=peakpass-p4-20261002`; existing user containers/checkouts were not changed. Tests are serial against disposable data. No production/browser load result is claimed.

| Check | Result / evidence boundary |
| --- | --- |
| Build / typecheck | `npm run build` passed. |
| Lint | Zero errors; existing warnings and test-only annotations recorded in raw output. |
| Unit | 160/160 passed, including admission sequential stop and admission-enabled repeated signal/listen-failure drain ordering. |
| PostgreSQL | Real partial UNIQUE/check constraints,011 upgrade, backfill/lazy ensure404; blocked shared/exclusive gates observed by `pg_blocking_pids`; both existing-false/missing-policy SERIALIZABLE snapshots retried in distinct transactions. |
| Redis/HTTP | Actual Redis and application loopback listen/fetch: concurrent10 join, owner privacy, active409, Retry-After, terminal replay, PG0 normal GET; two child workers share FIFO/rollingR/C; deadline claims retain slots; waiting/entry bounds and cleanup100. |
| Fixture disclosure | Logical expiry fields and the10000-entry terminal history are synthetic initial states, followed by real Lua calls. HTTP response discard/retry is not a network partition. PG query spies measure normal GET access; they do not measure production load. |
| Crash recovery | Actual child SIGKILL at freeze, barrier commit, Redis initialization and PG-open commit. Parent resumes generation exactly once. Separate tests cover coordinator overlap, missing-control stale observer, partial structure loss and stale cleanup/publication CAS. |
| Product guard | Actual startup refuses protected policy with flag false/true and refuses unsupported Redis policy. Protected fixture API tests do not start the product via an activation bypass. |
| Production image | Two dedicated empty DBs: flag off and on; migrations001–012, unchanged rerun, readiness and signed GraphQL smoke passed. Existing011 DB applied only012. |
| Full integration | 274 passed /10 skipped,28 suites passed. Includes all five production Docker order-worker lifecycle tests with `WAVE4_TEST_IMAGE=peakpass:p4-issue13`. First attempt:268 pass/1 failure/15 skip; failure was an existing subprocess inheriting host5432 instead of the dedicated DB. Explicit process environment corrected it; raw failed attempt retained. |
| Skips | Legacy destructive Redis suite requires its exact old container identity and reserved port63532; it is not retargeted or claimed as run. P4 corruption/recovery fixtures are distinct evidence. |

Final reviewer, code SHA and archived raw-output hashes are recorded after the candidate review. A role named reviewer is not proof of model identity. Remote CI/merge, product purchase integration, Redis pause/stop/restart with a real buyer, browser behavior and P8 capacity comparisons remain outside this local proof.

P5/P6 consume this implementation only after its accepted SHA is present in their checkout. P7 validates integrated fault behavior; P8 remeasures A/B/C, starting with A, at the same integrated SHA/environment (including new policy/gate and Redis profile). P9 consumes those accepted results. Unchanged P1/P2 source evidence stays valid; no successor is marked ready or complete solely by this document.
