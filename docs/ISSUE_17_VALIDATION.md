# Issue #17 / P8 same-condition A/B/C comparison: protocol, pilots and results

This is the record of P8 on the branch `claude/issue-17-p8-load-comparison`, cut from main `1bb27967b7fc654fe57cd4b2ae89eb6b63a0d509`. It is written in stages. The protocol and the pilot plan below are fixed before the runs they govern; the result sections are filled as runs finish and say which runs they come from. The measurement contract of the harness is in [FLASH_SALE_EVIDENCE.md](FLASH_SALE_EVIDENCE.md) ("v3 측정 계약"), the plan and the ledger of every ruling in [the plan](superpowers/plans/2026-10-05-issue-17-load-comparison.md).

Every number in this document is an observation of local runs on one Windows host that is shared with other work. None is an operational result. Pilot numbers choose conditions and a profile; they are not results of the comparison and are not to be quoted as such.

## Consumed input

- Base main `1bb27967b7fc654fe57cd4b2ae89eb6b63a0d509` (PR #31), read from the remote at the start. Product code: main `5016b8c` plus the fix of F1. Migrations end at 013.
- `admission-v1`: contract LF Git blob SHA256 `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1`. Profile in the image at the start: `admission-v1-seed` (R 2/s, C 8, batch 2, TTL 30 s, claim deadline 15 s, tick 250 ms, waiting lease 120 s).
- P2: `flash-sale-v2.6` with `flash-sale-analysis-v2.6.1`, v261 index SHA256 `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6`. Its archives are read, never changed.
- #9 listed P1–P7 valid, P8 ready and P9 blocked at the start; #9 and #17 had no comment and no PR was open.
- The user reviewed the design in chat on 2026-10-05 and approved the decisions D1–D13 as recommended. They are in the plan.

## What the branch adds

| File | Role |
| --- | --- |
| `docker-compose.flash-sale.yml` | Two changes, the same for every arm: Redis runs `redis-server --save "" --appendonly no --maxmemory-policy noeviction`, and the application has `ENABLE_ADMISSION: "true"`. |
| `load-test/flash-sale.js` | The A journey is unchanged. Arms b and c take a second path, `queued()`: one iteration is one buyer and runs one controller of `frontend/admission-polling.js`, loaded as it is, with transport, clock, timers, visibility and a stand-in for `AbortController` injected. |
| `load-test/flash-sale-fixture.mjs` | Revision `flash-sale-v3.0`: `--arm`, `--hidden-share`, `--monitor`, a drain bound of 900 s; the policy row in every arm, the contract's transition for b and c, the wait for a ready namespace, the queue samples, the end of a run (wait for free slots, Redis dump, application stop, SQL snapshot, `admission-final.sql`, ledger comparison, cleanup with `admission_results` first) and the manifest fields that show which arm really ran. |
| `load-test/flash-sale-analysis.mjs` | Revision `flash-sale-analysis-v3.0`. A v2.6 manifest takes the unchanged v2.6 path. A v3 run gets the purchase, horizon, admission, polling, recognition and queue figures and the validity and integrity rules below. |
| `load-test/flash-sale-check.mjs` | 20 checks added to the 29 of P2. They run the real controller file through the script in a `vm` context with a virtual clock and a fake queue API, and pin the copies the fixture holds of product statements, key names and log lines to the product sources. |
| `docs/FLASH_SALE_EVIDENCE.md`, this document, the plan | The measurement contract of v3, the protocol and record, the decisions and ledger. |

No file under `src` outside `src/tests`, no file under `frontend/`, no migration and no contract text changes on this branch before the user has approved the pilot report. `frontend/admission-polling.js` has the canonical LF SHA256 `0143f2e748b2256597d307d9fc6e8c1aa89fce7f2471b168ba302c0b88b1c6e2`; every manifest records it.

## Protocol (fixed before any load)

### Arms and environment

One commit, one Compose file and one image content serve all three arms, with the feature on. An arm is two things only: the policy row of the event and the journey of the generator.

| Arm | Policy row | Journey |
| --- | --- | --- |
| A | ensured, left unprotected | the P2 journey: reservation (even index) or direct checkout (odd), checkout, settlement |
| B | protected before the application starts | queue journey, fixed polling |
| C | protected before the application starts | queue journey, adaptive polling with jitter |

Protection is switched by the contract's transition (§6): in one transaction the exclusive event gate, the policy row `FOR UPDATE`, `UPDATE admission_events SET protected=true`. The statements are those of `readAdmissionPolicy(client, eventId, 'exclusive')`; the product has no activation entry point. The instance then initializes and publishes the namespace, and the load starts only when the control is `ready`, the policy `open`, and generation and epoch agree. No arm runs with the feature off, and no environment setting stands in for protection: the manifest holds the application environment without secrets, the three Redis `CONFIG` values and the run id, and the policy row and the control before and after, and the analysis requires that A stayed unprotected and that B and C began and ended in one generation and epoch on one Redis process. B and C also send one purchase without admission fields before the load, which must be refused with 400 `ADMISSION_INVALID_INPUT`.

Environment as in P2: application 1 CPU / 512 MiB, PostgreSQL 16 1 CPU / 512 MiB, Redis 7 0.5 CPU / 256 MiB, pool 2–10, info logs, 250 ms samples, one instance and so one scheduler. k6 runs on the Windows host next to Docker Desktop.

The A baseline of P2 (v2.6) was measured on another SHA, without the Redis settings, with other VU numbers and drain and on a smaller Docker VM. Nothing here is judged an improvement or a regression against it.

### Generator and journey

k6 `constant-arrival-rate` with `preAllocatedVUs = maxVUs`, the same number in every arm. A buyer of B or C:

1. reads the status once (the controller's `recover` poll);
2. joins as soon as that answer gave the epoch, with one `joinRequestId` that is kept for every repeat;
3. polls in the arm's mode. The delays are the controller's: fixed 1,000 ms; adaptive `clamp(base·(1+0.2u), 1000, 5000)` with the server's base and `u` in [−1, 1); 15,000 ms in a hidden tab; after a failure 1 → 2 → 4 → 8 → 15 s with ±20%, and never less than the server asks;
4. is recognized when the controller first applies the entry as admitted, and after the think time sends the purchase that consumes the admission: a reservation (even index) or a direct checkout (odd index), with `admissionId` and `admissionEpoch`. While that request is undecided (no answer, 429, 5xx, 409 `ADMISSION_IN_PROGRESS`) the controller repeats it with the same body up to four times;
5. continues as in A: the checkout of the reservation (the existing request, without admission fields), the settlement, and the replay of every third buyer, with A's retry rule (one repeat after 100 ms on no answer, 5xx or `IDEMPOTENCY_IN_PROGRESS`).

One tab per user, every tab in the foreground, nobody leaves or cancels. What differs from a browser: k6 has no `AbortController` and cannot cancel a request, so a request ends by its timeout (5 s for the queue API, 10 s for a purchase); the clock is `Date.now()`; the journey ends when its outcome is decided, so the read of the status that the page would make after an unconfirmed purchase is not sent. The controller file is not modified.

Cutoff: a buyer starts no new request after scenario start + arrival seconds + drain budget − 15 s. A request that is out at that instant may still be answered. Every buyer ends with exactly one outcome: `paid`, `not_joined`, `queue_waiting`, `admission_expired`, `admitted_unpurchased`, `cancelled`, `reset`, `unknown_outcome`, `stock_rejected`, `http_<status>`, `incomplete_checkout` or `incomplete_settlement`.

Recognition is what the controller records in the generator: the interval `lowerMs`–`upperMs` between the entry's `admittedAt` and the moment the controller applied it. It is called "controller recognition (generator)" in every report. Recognition in a browser is not judged here.

### Load model

1,000 buyers, 2,000 seats (ample), quantity 2, reservation and direct 50:50, think 20 ms, checkout and settlement retry 1 after 100 ms, replay every 3, purchase limiter 1,000,000 per 60 s in every arm, pool 10, samples every 250 ms, 1,000 VUs. The warmup cohort is the first 250 buyers; cohorts follow the scheduled arrival, never the admission time. The horizon (arrival seconds + drain budget) is the same in every arm of a comparison.

### Metrics and denominators

- Completion: unique buyers whose HTTP paid answer matches the final SQL order and ticket identity, over every scheduled buyer of the measurement cohort. Waiting, unadmitted, expired, unknown and unfinished buyers stay in the denominator, each under its outcome.
- Throughput: unique paid (HTTP = SQL) inside a window over its length, for the arrival window and for the whole horizon.
- Purchase write error share: non-replay attempts of `reservation`, `checkout` and `settlement` that got no answer, 429 or 5xx. Status and join requests are in none of these shares. A's 500 `INTERNAL_ERROR` and the 503 of B and C are counted in separate columns, 409 by code. The first request of a purchase is also reported alone: first-attempt failures and repeats.
- Whole wait: arrival → paid, p50/p95/p99 over the paid buyers, next to the number unfinished. After admission: recognition → paid, and an upper bound of `admittedAt` → purchase answer (the recognition's upper bound plus the time from recognition to the last purchase answer, on the generator's clock alone).
- Polling: status requests in total, per registered buyer, per second (seconds with at least one request: maximum and p95), by the controller's reason (`timer` against `recover`, `refresh`, `retry`, `return`), and planned against actual delay.
- Recognition: lower and upper bound p50/p95 by layer, over every entry promoted before the buyers' cutoff; entries that expired unseen and entries never seen are counted next to it.
- Queue: waiting, active, claims and the promotion window sampled every 250 ms with the same commands in every arm, and every `admittedAt` of the Redis dump checked against R per rolling second. A sampled maximum proves no bound; R and C are proven by the replay of one separate `MONITOR` run.
- Repeats are reported as median [min–max]; percentiles are not pooled across runs.

### Validity, integrity and incidents

Invalid measurement: dropped iterations, started ≠ offered, an arrival lag above 250 ms, a script exception, a malformed success answer, missing observation, queue sample, pool, resource or generator evidence between the measurement start and the end of the load, host pressure (host CPU ≥ 90% or less than 1 GiB free in three resource samples in a row), a failed cleanup, a dirty tree; a policy, epoch, generation or control that changed or does not fit the arm; another Redis run id; a Redis setting that differs; a 401 or 403, a 429 on a purchase path, an admission 429 or `ADMISSION_QUEUE_FULL`; a buyer without a summary or whose trace or request counts do not add up; unread final evidence.

Integrity defect: a failed P2 SQL check, any row of `admission-final.sql`, a mismatch between the ledger and Redis, an HTTP paid that SQL does not have, more promotions in a rolling second than R. The series stops, the raw run is kept, nothing is analysed again with the survivors only, and it is reported before any product code changes.

Published, not invalid: slots still in use when the bounded wait after the load ends (a late reclamation is product behaviour), and a slow application exit (F2), with duration and exit code. A Redis restart or reset makes a run invalid; the raw run is kept and the slot is repeated once under a new id with the suffix `r`.

### Run procedure

A run goes through the run script outside the repository. It applies the P2 start gate (at least 2 GiB of free host memory in three samples 5 s apart, at most ten attempts 30 s apart), records host CPU with it, and then starts the fixture from a clean tree. Nothing else that loads the host (build, test, review) runs during a measured run. `MONITOR` is attached to the verification run only. End of a run: k6 ends → wait until no slot is in use (bounded by TTL + claim deadline + 15 s) → Redis dump → application stop → SQL snapshot → `admission-final.sql` → ledger comparison → cleanup.

## Pilot plan (fixed before the first pilot)

Every pilot uses the load model above unless a line says otherwise, 1,000 VUs, and one run per line. An invalid run is repeated once under the suffix `r`.

1. **Preflight** `p8-pre-a-01`, `p8-pre-b-01`, `p8-pre-c-01`: 24 buyers, 2/s, 24 VUs, seed profile, drain 30 s. Passed when all three are valid, the final SQL returns no row, every buyer of B and C is paid and no trace is missing.
2. **Generator pilot** `p8-gen-b-01`: seed profile, arm B, 1,000 buyers, 25/s × 40 s, warmup 10 s, drain 30 s (the buyers' cutoff is 55 s after the start). With R 2/s most buyers end as `queue_waiting`; that is expected. Read: k6 memory and CPU, arrival lag, dropped iterations, raw and log sizes, application and Redis CPU. If the run is invalid for lag, drops or host pressure, the work stops and the user decides about buyers or generator.
3. **A ladder**, arm A, drain 30 s: `p8-pilot-a-r10-01` (10/s × 40 s, 400 buyers, warmup 10 s), `p8-pilot-a-r25-01` (25/s × 40 s, 1,000 buyers, warmup 10 s), `p8-pilot-a-r50-01` (50/s × 20 s, 1,000 buyers, warmup 5 s). The P2 stability criteria decide each step (`criteria.stableByP2`): completion of the measurement cohort ≥ 99%, write failure share in the arrival window ≤ 1%, no replay failure, paid journey p99 ≤ 2,000 ms, and the paid throughput of the two halves of the window within 20% of the offered rate.
   - The formal arrival condition is the lowest step at which A is not stable. If at that step the unfinished share of the measurement cohort (1 − completion) and the write failure share of the cohort's attempts are both below 5%, it is the next higher step. If A is stable at every step, it is 50/s × 20 s and is described as a condition in which A is not overloaded.
   - If 10/s is not stable, the work stops.
4. **Pilot branch** `claude/issue-17-p8-pilot`, local only: from the work branch, one commit that derives the polling boundary of `admission.service.ts` as `5 * admissionProfile.rate`, then one commit of constants per candidate. A candidate runs from a clean tree at its commit; its diff against the work branch and the hash of that diff are kept with the run.
5. **R pilot**, arm B, formal arrival condition: `p8-pilot-b-r<R>-01` for R1 = min(highest step at which A was stable, 20) and R2 = ⌈R1/2⌉, each with batch = ⌈R/4⌉ and C = 3R, everything else seed. Drain budget: ⌈1.25 · buyers / R⌉ − arrival seconds + 45 s, rounded up to 5 s, so that the buyers' cutoff is ⌈1.25 · buyers / R⌉ + 30 s after the start.
   - Chosen: the largest R whose run is valid and has a write failure share of the measurement cohort ≤ 1%, a recognition → paid p99 of the measurement cohort ≤ 2,000 ms, and no row of the final SQL. If neither candidate qualifies, R3 = ⌈R2/2⌉ is run once; if that fails too, the work stops.
6. **C pilot**, arm B, R fixed: C ∈ {8, ⌈1.5 · R · h⌉, 3R}, where h is the mean slot occupation in seconds of the chosen R run (`admission.slotOccupationSeconds`). The run of 3R is the R pilot's; equal values are run once. Run ids `p8-pilot-b-r<R>c<C>-01`, the drain budget of the R pilot.
   - Chosen: the smallest C whose run is valid, keeps the three criteria of the R pilot and reaches a promotion achievement of at least 95% while somebody waits (`queue.promotionAchievement`). If no C does, the work stops.
   - An entry of a foreground buyer that expires is analysed and reported. The TTL is not changed.
7. **Confirmation** `p8-pilot-c-01`: arm C with the chosen profile, same condition and drain budget.
8. **Verification** `p8-verify-b-01`: arm B with the chosen profile and `--monitor`. The capture must have begun on an empty admission keyspace and must not have ended by itself; the replay of `admission-transition-log` with the chosen R and C must report no violation, and its final sets must equal the Redis dump. Excluded from every statistic.

The work also stops on an integrity defect, on two invalid runs in a row for one slot, and on ten failed start gates in a row.

## Verification record

To be completed with each stage. So far (2026-10-05, run in this session unless marked otherwise):

- Base: `npm ci`, `npm run build` and `npm run test:flash-sale` 29/29 at `1bb2796`.
- k6 and the controller (throwaway scripts, not in the tree): k6 1.7.1 imports the controller file as CommonJS; an async iteration keeps its VU and a pending timer keeps the iteration; timers and the controller's polls were 0–2 ms late; points added from async callbacks and metadata set for one point are in the raw output. Ten buyers went from join to paid on the seed profile against the real application, with no row of the final SQL. The details are in the plan's ledger.
- Harness at `20eb728`: `npm run test:flash-sale` 49/49 on the host (Node 24.15.0) and 49/49 in a `node:18-alpine` container (Node 18.20.8, the version of CI); `npm run build` passed; `npm run lint` 0 errors and 11 warnings, as at the base.
- The 14 stored v2.6 archives of the v261 index, hashes verified, re-analysed by the v3 analyzer: every field but `analysisRevision` equals the stored analysis (stored evidence, re-analysed in this session).
- A development smoke `p8-dev-b-01` (arm B, 12 buyers, 2/s, seed profile): classified `valid-queue`, 12 of 12 paid. It is not part of the pilot plan.

## Results

Not yet run.

## Commands

`npm run build`; `npm run test:flash-sale`; one run: `node load-test/flash-sale-fixture.mjs --run-id <id> --arm a|b|c --users <n> --rate <r> --pre-vus <n> --max-vus <n> --warmup-seconds <s> --drain-seconds <s>`; re-analysis of a kept run: `node load-test/flash-sale-analysis.mjs load-test/results/flash-sale/<id>`. Docker Compose v2 and k6 are needed for a run, nothing but Node for the checks.
