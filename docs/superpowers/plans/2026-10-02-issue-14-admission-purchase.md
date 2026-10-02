# P5 admission purchase gate implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Main implements; any agent investigates or reviews read-only.

**Goal:** Connect new reservations and reservation-free new checkouts to admission-v1 with one durable result ledger, so that one admission yields at most one logical seat acquisition and every retry recovers the same result.

**Architecture:** PostgreSQL stays the authority. `admission_results` (migration 013) is written in the same transaction as the reservation or order. A common consumption module runs on the caller's `PoolClient`: event gate, policy locking read, admission lock, durable replay, Redis claim, savepoint, existing occupation, ledger insert. Redis finalization happens after COMMIT and never undoes a commit. The admission scheduler tick reclaims overdue claims through the ledger.

**Tech Stack:** TypeScript, Fastify, Zod, node-postgres, node-redis/Lua, PostgreSQL 16, Redis 7, existing Jest.

**Spec:** ../../ADMISSION_CONTRACT.md (admission-v1, accepted `87959cd84dbb231caa88fee2e4ad4bcd84115246`, LF blob SHA256 `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`), ../../ISSUE_13_VALIDATION.md ("P5 cooperation interface"), Issue #14. The design was explained in chat on 2026-10-02 and the user answered "proceed as recommended"; the decisions below are that answer.

## Decisions (user, 2026-10-02)

- D1 A reservation without admission fields keeps the existing READ COMMITTED transaction and only adds the gate and policy read. With admission fields it runs SERIALIZABLE with retry.
- D2 A new occupation on a protected event without admission fields answers 400 `ADMISSION_INVALID_INPUT`. No new error code, no contract revision.
- D3 Admission fields sent with an existing reservation or order that has no durable link are ignored: no binding, no consumption, no rejection.
- D4 The ledger has an UPDATE-blocking trigger and an `error_message` column, so a rejected replay returns the same message.
- D5 The lazy policy ensure stays as the contract says. `event-sale-eligibility.test.ts` ensures the policy in its fixture; its assertions do not change.
- D6 The merged P4 file is changed: `claim`/`complete`/`close`/`reconcile` answer 503 when the Redis control is missing instead of reading PG on a second connection.
- D7 `assertP4AdmissionStartup` is replaced by a startup check that `admission_results` exists. A P4-version instance is blocked by its own guard; older versions are unsupported by contract §6.
- D8 P5 adds no activation or release entry point. The transition is the contract's explicit one (exclusive gate, real UPDATE), performed by test helpers and documented.
- D9 TTL and claim deadlines are synthetic fields followed by real commands; one real process SIGKILL case is included; local production image and 012→013 upgrade checks are run.
- D10 Plan, `docs/ISSUE_14_VALIDATION.md` and evidence under `test-results/admission-v1/` follow the P4 convention. Local commits per task. Push, PR and the independent reviewer are asked again after local verification.

## Global constraints

- Contract text, `inventory.service.ts`, `idempotency.ts` and `rateLimit.ts` do not change. No new dependency. No push, PR, merge or deployment.
- Lock order: event gate → policy locking read → admission lock → checkout-key lock → existing rows. Same `PoolClient`; no second pool connection inside a purchase transaction.
- A checkout that carries `reservationId` takes no gate and keeps its lock order and status codes.
- Durable replay precedes every Redis, epoch, TTL and feature-flag rejection. Those reject only when a new occupation remains.
- Only a 4xx `AppError` thrown by the existing occupation inside the savepoint is a business rejection. PG errors and 5xx roll everything back and write no result.
- Protected consumption sets `statement_timeout=5s`, `lock_timeout=1s`, `idle_in_transaction_session_timeout=10s` locally; at most three attempts with the existing 20ms backoff; exhaustion is 503 with the same identity.
- A slot is returned only after a matching durable result or a committed `closed`. Never from a timeout, an absent row or a finally block.
- Successful purchase responses keep the existing reservation/order schema. Admission errors use `{error:{code,message},nextPollAfterMs}`; business errors keep their code and status.
- Tests run serially on resources owned by this task (PostgreSQL 16, Redis 7 with AOF/RDB off and noeviction). Protocol fixtures that publish a namespace for an event without a protected policy never run next to an app whose scheduler is active.

## Review focus

- A SERIALIZABLE snapshot taken before the admission lock wait must not turn an already committed result into a Redis-derived denial or a second occupation.
- A rejected occupation leaves no reservation, order or seat change, and its replay does not depend on the current stock.
- The reclaimer must not return a slot while a consumer transaction holds the admission lock, and `closed` must fence the late writer.
- Existing reservation checkout, order replay, webhook and sweepers must not start requiring admission or change their status codes.
- Feature off must not become a bypass, and a missing Redis control must not open a second connection.

## Task 0: Baseline

- [ ] Re-check origin/main, the contract hash and the issue gates. `npm ci`. Owned PostgreSQL/Redis with task label `peakpass-p5-20261002`.
- [ ] Record build, typecheck, lint, unit and full integration results before any change.

## Task 1: Result ledger

Files: new `src/infra/migrations/013_admission_results.sql`; new test `src/tests/integration/admission-ledger.test.ts`.
Interfaces: table `admission_results(admission_id PK, user_id, event_id, epoch, operation, fingerprint, outcome, reservation_id UNIQUE, order_id UNIQUE, error_code, http_status, error_message, created_at)`; primary key constraint name `admission_results_pkey`.
- [ ] Failing real-PG tests: shape CHECKs per outcome, target UNIQUEs, FK restriction on delete, UPDATE rejected, DELETE allowed, 012 objects untouched.
- [ ] Add the migration; apply to the owned database; tests pass.

## Task 2: Consumption module and reservation path

Files: new `src/core/services/admission-consumption.ts`; edit `src/core/models/admission.ts`, `src/infra/postgres/client.ts`, `src/core/services/reservation.service.ts`, `src/core/services/admission.service.ts` (cold path), `src/api/rest/reservations.ts`, `src/api/errors.ts`, `src/api/app.ts`, `src/api/rest/admissions.ts`; new tests `src/tests/integration/admission-purchase.test.ts`, fixture `admission-purchase-fixture.ts`.
Interfaces:
- `parsePurchaseAdmission(body: unknown): AdmissionRef | undefined` where `AdmissionRef = { admissionId: string; epoch: string }`.
- `serializableTransactionWithRetry(callback, { maxAttempts?, baseDelayMs?, retryIf? })`.
- `purchaseCommand(operation, input, checkoutKey, admission?): PurchaseCommand`, `admissionFingerprint(command): string`.
- `openAdmissionGate(client, command): Promise<AdmissionGate>` returns `{ policy, prior }`; throws 404/409/410 for a foreign, mismatched or closed result.
- `occupyThroughAdmission<T>(client, gate, command, occupy): Promise<Occupation<T>>` where `Occupation<T> = { value: T; settlement?: AdmissionSettlement } | { rejected: AppError; settlement: AdmissionSettlement }`.
- `purchaseTransaction<T>(admission, work): Promise<T>`, `settleAdmission(settlement?): Promise<void>`, `storedRejection(row): AppError`.
- `ReservationService.createReservation(input, admission?)`.
- [ ] Failing actual-HTTP tests for the reservation path: required fields, foreign owner, waiting/cancelled/expired admission, single consumption, same-request replay (sequential and concurrent), changed payload 409, sold-out rejection and its replay, transient failure and exhaustion, no second connection on a missing control.
- [ ] Implement; run the new file and the reservation regressions.

## Task 3: Checkout path and exemptions

Files: edit `src/core/services/checkout.service.ts`, `src/api/rest/checkouts.ts`; tests in `admission-purchase.test.ts`.
Interfaces: `CheckoutService.checkout(input, client, admission?)` returns the existing union plus `{ rejected: AppError }`, each optionally carrying `settlement`; `assertAdmissionLink(client, admission, { orderId?, reservationId? })`.
- [ ] Failing tests: direct checkout consumption, reservation versus direct race on one admission, different checkout key 409, order replay without and with admission fields, reservation checkout exemption after TTL/reset/namespace loss, mismatched link 409, unlinked target ignored, callback after reset.
- [ ] Implement; run `test:routes`, `test:concurrency`, `checkout-expiry`, `event-sale-eligibility` (with the D5 fixture line), callback and expiry suites.

## Task 4: Finalization and claim reclamation

Files: edit `admission-consumption.ts`, `admission.service.ts` (`maintain` hook), `src/infra/cron/admission-scheduler.ts`; tests in `admission-purchase.test.ts`, child fixture for the SIGKILL case.
Interfaces: `reclaimOverdueClaims(eventId: string, claims: RedisAdmissionEntry[]): Promise<void>`; `AdmissionService.maintain(stopped?, reclaim?)`.
- [ ] Failing tests: response loss replay, injected `complete` failure then exactly-once reclamation, held consumer transaction blocks reclamation, rollback then `closed` and one slot return, late writer 410 with no occupation (including a snapshot taken before the `closed` commit), consumer process SIGKILL.
- [ ] Implement; verify.

## Task 5: Policy states and transitions

Files: tests in `admission-purchase.test.ts` and new `admission-purchase-off.test.ts`.
- [ ] Tests: feature off 503 on both paths with exemptions and durable replay intact, recovering 503, retired epoch 410, missing event 404, activation racing a consumer on both paths, limiter codes distinct from admission codes.
- [ ] Fix whatever these expose; verify.

## Task 6: Guard replacement and image

Files: edit `admission.service.ts`, `src/main.ts`, `src/api/health.ts`, `.github/scripts/production-image-check.mjs`, `src/tests/integration/admission-process.test.ts`, `src/tests/unit/redis-shutdown-order.test.ts`.
Interfaces: `assertAdmissionLedger(): Promise<void>`.
- [ ] Failing process tests: a protected policy no longer blocks startup; flag off serves and answers 503 for a protected new occupation; flag on admits through the real scheduler and completes a purchase; a database without migration 013 refuses startup.
- [ ] Replace the guard only after Tasks 2–5 are green; update the image check to 001–013.

## Task 7: Regression, evidence and handoff

Files: new `docs/ISSUE_14_VALIDATION.md`, `test-results/admission-v1/p5-*.{json,zip}`, `docs/README.md` index if it lists validation documents.
- [ ] Build, typecheck, lint, unit, full integration, harness and callback checks on the owned resources; local production image off/on on empty databases; 012→013 upgrade with existing data.
- [ ] Record commands, results, skips, evidence kinds and what stays unverified; successor notes for P6/P7/P8. Commit locally; no push without approval.

## Execution ledger

- Base `678ac7c49422cb835a0c9027d49a9e168c8cc979` (origin/main rechecked 2026-10-02T09:06Z, no open PR). Contract hash unchanged. Worktree `claude/issue-14-p5-admission`, created with `--no-track`; the user's main checkout and every other worktree untouched.
- Ruling: the user's "proceed as recommended" after the reviewed chat design is the execution instruction and approves local commits per task; the accepted contract and that design are the spec, so no separate spec-approval stage is added. Push, PR and independent review remain unapproved.
- Owned resources: PostgreSQL 16.12 and Redis 7.4.8 (save "", appendonly no, noeviction, 256MiB) on Docker-chosen loopback ports, label `peakpass.task=peakpass-p5-20261002`. Credentials are kept in files outside the repository.
