# P4 admission implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Agents investigate/review read-only; main implements.

**Goal:** Implement admission-v1 Redis/API/policy/epoch support without enabling protected purchases before P5.

**Architecture:** Redis owns queue state and budgets; PostgreSQL owns policy and epoch barriers. P4 exposes internal claim/finalization operations; P5 owns durable consumption and recovery decisions. Existing Redis connection, SERIALIZABLE retry, Fastify and sequential scheduler patterns are reused.

**Tech Stack:** TypeScript, Fastify, Zod, node-redis/Lua, PostgreSQL 16, existing Jest.

**Spec:** ../../ADMISSION_CONTRACT.md (accepted 87959cd84dbb231caa88fee2e4ad4bcd84115246, SHA256 e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1); design reviewed in chat before the user's execution instruction.

## Global constraints

- admission-v1-seed: R2/C8/TTL30000/claim15000/tick250/batch2/cleanup100/reclaim8/lease120000/waiting1000/entries10000/epoch86400000.
- Default off. Product activation is unavailable until P5 provides purchase gates. Isolated helpers/fixtures may test protected policies.
- No new dependency, purchase-path change, result ledger, contract revision, P2 load rerun, merge or deployment.
- Same join replays terminal; owner/event privacy; no alias on active409; claimed slots require durable evidence.
- Normal polling has no PG access. Unready/missing metadata fails closed and only coordinator repairs it.
- Event gate -> policy locking read -> admission lock -> checkout key -> existing rows; same PoolClient.

## Review focus

- Old terminal retry/cancel must not overwrite a newer active/latest index.
- Limiter and invalid/recovering requests must not extend waiting lease.
- Lua partial failure, missing sentinel, stale generation and reconnect cannot open an empty queue.
- SERIALIZABLE stale snapshots must retry instead of treating missing/false policy as bypass.
- Stop/listen failure must drain in-flight work before PostgreSQL closes.

## Task 1: Policy and epoch storage

Files: new src/infra/postgres/admission-policy.ts, migration012; tests in admission.test.ts.
Interfaces: readAdmissionPolicy(client,eventId,mode), lockAdmission(client,id,tryOnly), policy generation/epoch as strings.
- [x] Add failing real-PG migration/backfill/lazy ensure/gate tests and run RED.
- [x] Implement migration and locking helper with event404, policy0-row503 and narrow policy FK retry classification.
- [x] Verify empty/011 upgrade, partial unique, shared/exclusive waiting and fresh snapshot retry.

## Task 2: Redis atomic state machine

Files: new src/infra/redis/admission.ts, src/core/services/admission.service.ts; admission.test.ts.
Interfaces: join/status/cancel/promote/claim/complete/reconcile, freeze/initialize/publish CAS; fixed key list and tagged results.
- [x] Add failing tests for identity/FIFO/R/C/lease/terminal/claim and run RED.
- [x] Implement bounded scripts, sentinels, Redis TIME and per-action limiter; no automatic claim release.
- [x] Verify real Redis races, corruption and epoch guards; record transition outputs.

## Task 3: HTTP and process lifecycle

Files: new admissions.ts and admission-scheduler.ts; edit app/auth/config/main/health; tests admission.test.ts and lifecycle tests.
Interfaces: strict JWT admission routes and errors, scheduler stop():Promise<void>, process admission readiness.
- [x] Add failing actual-HTTP auth/schema/error/PG0 and lifecycle tests.
- [x] Implement coordinator, recovery phases, Redis config/process validation and P4 activation guard.
- [x] Verify two coordinators, reset interruption, disabled/ready/recovering behavior and stop/drain.

## Task 4: Regression and handoff

Files: production-image-check.mjs, .env.example, docs/ISSUE_13_VALIDATION.md and P5/P6 handoff.
- [x] Update image migration/readiness assertions; run build/typecheck/lint/unit/targeted and full integration in owned resources.
- [x] Review entire change with independent read-only reviewer; fix reproducible issues and verify regressions.
- [x] Record implementation SHA, commands/results/skips, consumed tuple and remaining P5/P6/P7 scope. Commit locally; no automatic merge/deploy.

## Execution ledger

- Base f2a4674133cbeb50a65590f75bd9140efc32ff1d; user approved implementation after design. Main checkout preserved.
- Interfaces: policy supplies the same transaction/generation used by coordinator and later P5; Redis claim never performs PG decisions; HTTP consumes one Redis snapshot.
- Ruling: no additional skill approval stage after explicit execution instruction; the accepted contract and reviewed chat design are the spec.
- Task1: policy RED (missing migration), then real-PG backfill/ensure/constraints and two stale-snapshot retry variants pass; fresh transaction IDs and pg_blocking_pids retained.
- Task2: Redis RED (missing command module), then Lua identity/claim tests pass. Full limits verified with two actual child workers and bounded fixtures; seed is not capacity.
- Task3: HTTP/scheduler RED, then green. Read-only findings reproduced RED: stale cleanup deletes new namespace, null observer advances twice, initializing resume freezes itself, GET reset race returns410, oversized body returns503. Root fixed with CAS cleanup/probe/resume and scoped error mapping; regression tests pass.
- Ruling: cold missing-control API may read PG to classify404/503; ready status remains PG0. A policy registry/cache adds unnecessary invalidation state.
- Ruling: P4 protected helper tests are isolated; product startup/readiness explicitly refuse protected policies pending P5. No purchase service or durable result schema was changed.
- Task4 candidate: build pass, lint zero errors, unit160/160, integration274 pass/10 legacy Redis-destructive skips including Docker lifecycle5 pass. Image empty DB migration/rerun/readiness/auth smoke passes with flag off/on. Existing011 DB upgrade applies012 only.
- Validation correction: the first full integration run had268 pass/1 existing subprocess DB-environment failure/15 skips. Explicit inherited environment fixes the subprocess, and Docker opt-in adds5 passing cases. Keep the failed raw output.
- Final whole-branch Astra review and final code/evidence SHA record pending; no merge, deployment or background monitor authorized.
- Final review: actual gpt-6-astra/high, base f2a4674 → candidate55a97fd,27/27 files, static/read-only. One Important P2: stale PG policy plus newer Redis control could reset an already recovered epoch.
- Final: fixed stale maintenance observation — epoch and phase regression cases RED→GREEN; shared observation choice covers both normal recovery and its retry path. Fresh build/typecheck/lint pass, unit160/160, full integration276 pass/10 legacy skips with rebuilt Docker image. Harness29/29 and callback isolation check pass.
- Final: Ruling: P5 ledger/purchase safety, P6 browser, P7 real buyer fault cases and P8 capacity are explicitly successor work, so the review's declined scope remains unclaimed. Static review does not independently execute tests.
- Ruling: ISSUE_13_HANDOFF final-SHA gate is satisfied by the same read-only Astra reviewer checking the fix delta at the final code SHA; no new whole-branch review or implementation agent.
- Final gate: gpt-6-astra/high returned No findings for c51ebd6dc8219e000d9f35afefc49dbf849c284b after the fix delta. Final image off/on blank-DB checks passed. Evidence ZIPs/manifests and P5/P6 interface handoff are in ISSUE_13_VALIDATION.md. P4 remains a local candidate; external acceptance and successor gates are unchanged.
- PR24 automated review (GitHub Codex, head e6583fb): three P2 findings outside the earlier static verdict — a released policy kept an authoritative control, maintenance reset an intact epoch after a failed command, and the session deadline blocked token-matched finalization. Each reproduced RED→GREEN and fixed in e408fd2 from a separate worktree; 14dd497 adds a service-level regression.
- PR24 automated review of the first fix (head 2d138e9): one more P2 — deleting an event cascades away its policy row and leaves an orphaned control that still answers. Reproduced RED→GREEN and fixed in 0d42c03: the barrier retires the namespace of a missing event, and maintenance sweeps one page of control keys per tick.
- PR24 automated review of that fix (head ab69ab7): one more P2 — retirement removed only the control's current epoch, so an earlier epoch still awaiting cleanup leaked for good. Reproduced RED→GREEN and fixed in 51d331b: the sweep scans the whole admission prefix and the barrier unlinks every namespace key of an event without a protected policy. At 51d331b: build/typecheck/lint pass, unit160/160, integration282 pass/15 skips, harness29/29, two-process scheduler smoke for release and deletion after a forced reset. Image checks and Docker lifecycle were not rerun locally; CI passed on 2d138e9, 4965f00 and ab69ab7.
- Ruling: ready polling stays PG0, so release and deletion are fenced by coordinator retirement and no release or deletion route is added in P4. The sweep relies on the v1 scope of one Redis per PostgreSQL database; that assumption and the remaining limits are recorded in ISSUE_13_VALIDATION.md.
