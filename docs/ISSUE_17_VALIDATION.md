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
| `load-test/flash-sale-check.mjs` | 21 checks added to the 29 of P2. They run the real controller file through the script in a `vm` context with a virtual clock and a fake queue API, and pin the copies the fixture holds of product statements, key names and log lines to the product sources. |
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

Bounds of a gap between samples (rule of 2026-10-06, analyzer `flash-sale-analysis-v3.1`): 1,000 ms for the observation loop and the queue samples, 6,000 ms for the resource samples, and 2,000 ms for the application's pool samples of a v3 run. Until v3.0 the pool bound was 1,000 ms; the application's 250 ms sampler stalled for 1,001–1,593 ms on the instance near its CPU limit, which alone made three pilot runs invalid. The largest pool gap of a run is published in `disclosures.poolMaxGapMs`. A verdict given by v3.0 is not rewritten; the v3.1 verdict of a kept run is listed next to it.

Integrity defect: a failed P2 SQL check, any row of `admission-final.sql`, a mismatch between the ledger and Redis, an HTTP paid that SQL does not have, more promotions in a rolling second than R. The series stops, the raw run is kept, nothing is analysed again with the survivors only, and it is reported before any product code changes.

Published, not invalid: slots still in use when the bounded wait after the load ends (a late reclamation is product behaviour), and a slow application exit (F2), with duration and exit code. A Redis restart or reset makes a run invalid; the raw run is kept and the slot is repeated once under a new id with the suffix `r`.

### Run procedure

A run goes through the run script outside the repository. It applies the P2 start gate (at least 2 GiB of free host memory in three samples 5 s apart, at most ten attempts 30 s apart), records host CPU with it, and then starts the fixture from a clean tree. From 2026-10-06 the same three samples must also show a host CPU of at most 30%, and no container of another project may be running (`my-factory-db`, which runs permanently, is the exception); the retries are the same, and the container names before and after the run are in the gate record. Other projects' containers are never touched. Nothing else that loads the host (build, test, review) runs during a measured run. `MONITOR` is attached to the verification run only. End of a run: k6 ends → wait until no slot is in use (bounded by TTL + claim deadline + 15 s) → Redis dump → application stop → SQL snapshot → `admission-final.sql` → ledger comparison → cleanup.

## Pilot plan (fixed before the first pilot)

Every pilot uses the load model above unless a line says otherwise, 1,000 VUs, and one run per line. An invalid run is repeated once under the suffix `r`.

1. **Preflight** `p8-pre-a-01`, `p8-pre-b-01`, `p8-pre-c-01`: 24 buyers, 2/s, 24 VUs, seed profile, drain 30 s. Passed when all three are valid, the final SQL returns no row, every buyer of B and C is paid and no trace is missing.
2. **Generator pilot** `p8-gen-b-01`: seed profile, arm B, 1,000 buyers, 25/s × 40 s, warmup 10 s, drain 30 s (the buyers' cutoff is 55 s after the start). With R 2/s most buyers end as `queue_waiting`; that is expected. Read: k6 memory and CPU, arrival lag, dropped iterations, raw and log sizes, application and Redis CPU. If the run is invalid for lag, drops or host pressure, the work stops and the user decides about buyers or generator.
3. **A ladder**, arm A, drain 30 s: `p8-pilot-a-r10-01` (10/s × 40 s, 400 buyers, warmup 10 s), `p8-pilot-a-r25-01` (25/s × 40 s, 1,000 buyers, warmup 10 s), `p8-pilot-a-r50-01` (50/s × 20 s, 1,000 buyers, warmup 5 s). The P2 stability criteria decide each step (`criteria.stableByP2`): completion of the measurement cohort ≥ 99%, write failure share in the arrival window ≤ 1%, no replay failure, paid journey p99 ≤ 2,000 ms, and the paid throughput of the two halves of the window within 20% of the offered rate.
   - The formal arrival condition is the lowest step at which A is not stable. If at that step the unfinished share of the measurement cohort (1 − completion) and the write failure share of the cohort's attempts are both below 5%, it is the next higher step. If A is stable at every step, it is 50/s × 20 s and is described as a condition in which A is not overloaded.
   - If 10/s is not stable, the work stops.
4. **Pilot branch** `claude/issue-17-p8-pilot`, local only: from the work branch, one commit that derives the polling boundary of `admission.service.ts` as `5 * admissionProfile.rate`, then one commit of constants per candidate. A candidate runs from a clean tree at its commit; its diff against the work branch and the hash of that diff are kept with the run.
5. **C pilot** (rule of 2026-10-06), arm B, formal arrival condition, R 20 and batch 5 fixed: `p8-pilot-b-r20c8-01` (C 8) and `p8-pilot-b-r20c12-01` (C 12), drain 275 s.
   - Chosen: the largest C whose run is valid and has a write failure share of the measurement cohort ≤ 1%, a recognition → paid p99 of the measurement cohort ≤ 2,000 ms, and no row of the final SQL. If neither qualifies, the work stops.
   - The promotion achievement while somebody waits (`queue.promotionAchievement`) is reported as a number and selects nothing.
   - An entry of a foreground buyer that expires is analysed and reported. The TTL is not changed.
6. **R** (rule of 2026-10-06): with h the mean slot occupation in seconds of the chosen C run (`admission.slotOccupationSeconds`), R′ = min(20, max(2, ⌊C / (1.5 · h)⌋)) and batch = ⌈R′/4⌉. If R′ is 20, the chosen C run is the R run. Otherwise `p8-pilot-b-r<R′>c<C>-01`, arm B, once, with the drain budget ⌈1.25 · buyers / R′⌉ − arrival seconds + 45 s, rounded up to 5 s and at most 900 s.
   - If that run is valid and keeps the three criteria of the C pilot, (R′, batch, C) is the proposed profile. If not, the work stops.
7. **Confirmation** `p8-pilot-c-01`: arm C with the proposed profile, same condition and the drain budget of the run that gave the profile.
8. **Verification** `p8-verify-b-01`: arm B with the chosen profile and `--monitor`. The capture must have begun on an empty admission keyspace and must not have ended by itself; the replay of `admission-transition-log` with the chosen R and C must report no violation, and its final sets must equal the Redis dump. Excluded from every statistic.

The work also stops on an integrity defect, on two invalid runs in a row for one slot, and on ten failed start gates in a row.

Items 5 and 6 were changed on 2026-10-06, after the R pilot had stopped and before the C pilot, by the user's decision (plan, "Decisions (user, 2026-10-06)"): the failure share followed C and not R, so C is calibrated first. As fixed before the first pilot, and as the R pilot below was run, they read:

> 5. **R pilot**, arm B, formal arrival condition: `p8-pilot-b-r<R>-01` for R1 = min(highest step at which A was stable, 20) and R2 = ⌈R1/2⌉, each with batch = ⌈R/4⌉ and C = 3R, everything else seed. Drain budget: ⌈1.25 · buyers / R⌉ − arrival seconds + 45 s, rounded up to 5 s, so that the buyers' cutoff is ⌈1.25 · buyers / R⌉ + 30 s after the start.
>    - Chosen: the largest R whose run is valid and has a write failure share of the measurement cohort ≤ 1%, a recognition → paid p99 of the measurement cohort ≤ 2,000 ms, and no row of the final SQL. If neither candidate qualifies, R3 = ⌈R2/2⌉ is run once; if that fails too, the work stops.
> 6. **C pilot**, arm B, R fixed: C ∈ {8, ⌈1.5 · R · h⌉, 3R}, where h is the mean slot occupation in seconds of the chosen R run (`admission.slotOccupationSeconds`). The run of 3R is the R pilot's; equal values are run once. Run ids `p8-pilot-b-r<R>c<C>-01`, the drain budget of the R pilot.
>    - Chosen: the smallest C whose run is valid, keeps the three criteria of the R pilot and reaches a promotion achievement of at least 95% while somebody waits (`queue.promotionAchievement`). If no C does, the work stops.
>    - An entry of a foreground buyer that expires is analysed and reported. The TTL is not changed.

## Verification record

To be completed with each stage. So far (2026-10-05, run in this session unless marked otherwise):

- Base: `npm ci`, `npm run build` and `npm run test:flash-sale` 29/29 at `1bb2796`.
- k6 and the controller (throwaway scripts, not in the tree): k6 1.7.1 imports the controller file as CommonJS; an async iteration keeps its VU and a pending timer keeps the iteration; timers and the controller's polls were 0–2 ms late; points added from async callbacks and metadata set for one point are in the raw output. Ten buyers went from join to paid on the seed profile against the real application, with no row of the final SQL. The details are in the plan's ledger.
- Harness at `d2b51b0`: `npm run test:flash-sale` 50/50 on the host (Node 24.15.0) and 50/50 in a `node:18-alpine` container (Node 18.20.8, the major version of CI). Six behaviours were changed one at a time (the join key, the controller's stop at an outcome, admission fields on the reservation's checkout, polling in the purchase share, promotions after the cutoff, the activation gate) and the checks failed each time; `npm run build` passed; `npm run lint` 0 errors and 11 warnings, as at the base.
- The 14 stored v2.6 archives of the v261 index, hashes verified, re-analysed by the v3 analyzer: every field but `analysisRevision` equals the stored analysis (stored evidence, re-analysed in this session).
- A development smoke `p8-dev-b-01` (arm B, 12 buyers, 2/s, seed profile): classified `valid-queue`, 12 of 12 paid. It is not part of the pilot plan.
- Analyzer v3.1 at `8e1148f` (2026-10-06, run in this session): the checks for the pool bound were seen failing first (2 of 52: the revision and the published gap), then `npm run test:flash-sale` 52/52 on the host (Node 24.15.0) and 52/52 in a `node:18-alpine` container (Node 18.20.8); `npm run build` passed; `npm run lint` 0 errors and 11 warnings; the 14 stored v2.6 archives re-analysed equal their index in every field but `analysisRevision`; `git diff 1bb2796 -- src frontend ':!src/tests'` is empty.
- Start gate of 2026-10-06 in the run script (outside the repository): three samples with at least 2 GiB free and a host CPU of at most 30%, and no running container but `my-factory-db`; the names of the running containers before and after a run are in `gates/<run-id>.json`.

## Results

Raw runs are in `load-test/results/flash-sale/<run-id>/` of the work tree (not committed). Each line below is one run of this session.

### Preflight (2026-10-05, commit `2e48a78`, seed profile, 24 buyers at 2/s, 24 VUs, drain 30 s)

| Run | Arm | Verdict | Paid | Purchase write failures | Final SQL rows / ledger mismatches | Status requests | Controller recognition, foreground upper bound p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pre-a-01` | A | valid-stable | 24/24 | 0 of 60 | 0 / 0 | – | – |
| `p8-pre-b-01` | B | valid-queue | 24/24 | 0 of 60 | 0 / 0 | 72 (24 `recover`, 24 `timer`, 24 `refresh`) | 758 / 927 ms (23 buyers) |
| `p8-pre-c-01` | C | valid-queue | 24/24 | 0 of 60 | 0 / 0 | 72 (24 `recover`, 24 `timer`, 24 `refresh`) | 787 / 1,048 ms (24 buyers) |

All three passed the strict smoke as well (k6 exit 0), every trace was complete, no slot was in use when k6 ended, the application left with exit 0 within 0.6 s, and every Compose project was removed. The arrival rate equals the seed R here, so nobody waited for long (server-side queue wait at most 488 ms) and the two polling modes sent the same number of requests; the preflight shows that the harness works, not how the arms differ.

Two things the preflight showed about the figures:

- In `p8-pre-b-01` the recognition of buyer 0 is filed under `reconnect`, not `foreground`. Its entry was promoted about 11 ms after its join and the answer that showed it took 37 ms, so the earliest instant the promotion can have happened lies before the controller's own start, and the controller's rule files such a sample under `reconnect` (ISSUE_15, "Trace for P8"). It can only happen to a buyer who is promoted within one round trip of arriving. All layers are reported.
- The promotion achievement can exceed 100% over a short backlog (`p8-pre-b-01`: 7 promotions in 3.1 s at R 2/s). The rate bound holds per rolling second, and a backlog that begins and ends inside such seconds collects up to R promotions more than R times its length. Over the backlogs of the pilots, tens of seconds long, this is at most R promotions.

## Commands

`npm run build`; `npm run test:flash-sale`; one run: `node load-test/flash-sale-fixture.mjs --run-id <id> --arm a|b|c --users <n> --rate <r> --pre-vus <n> --max-vus <n> --warmup-seconds <s> --drain-seconds <s>`; re-analysis of a kept run: `node load-test/flash-sale-analysis.mjs load-test/results/flash-sale/<id>`. Docker Compose v2 and k6 are needed for a run, nothing but Node for the checks.

### Generator pilot (2026-10-05, commit `a557fbc`, seed profile)

`p8-gen-b-01`, arm B, 1,000 buyers at 25/s for 40 s, 1,000 VUs, buyers' cutoff 55 s after the start: `valid-queue`. The generator carried the load: no dropped iteration, arrival lag p99 2 ms and maximum 30 ms, k6 working set at most 793 MB, k6 CPU 6.9 s, host CPU median 7.9% and maximum 22.6%, at least 4.8 GiB of host memory free. The raw k6 output is 87.1 MB and the application log 15.8 MB.

What the run showed, as an observation of one run with the seed profile and not as a result: 72 entries were promoted before the cutoff and 70 buyers paid, all of the warmup cohort; the 750 buyers of the measurement cohort ended as `queue_waiting`, as expected with R 2/s. 20,072 status requests were sent, up to 938 in one second, and the application container used a median of 62% and a maximum of 99% of its one CPU. The promotions while somebody waited reached 64% of R (72 in 55.9 s), with at most 5 of the 8 slots seen in use, and the controller recognition of the 70 buyers had an upper bound p95 of 3,224 ms. So with about 900 buyers polling once a second the single instance was close to its CPU limit, and its scheduler promoted fewer entries than R allows. 910 buyers were still waiting when k6 ended; the scheduler went on promoting them, so the bounded wait for free slots ran its full 60 s with 8 slots in use, which is published and not invalid. Final SQL 0 rows, ledger equal, trace complete.

### A ladder (2026-10-05, commit `a557fbc`, arm A, 1,000 VUs, drain 30 s)

| Run | Arrival | Verdict | Completion of the measurement cohort | Write failure share, cohort / arrival window | 500 `INTERNAL_ERROR` (all attempts) | Paid journey p50 / p95 / p99 | Paid per second in the window | Stable by the P2 criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pilot-a-r10-01` | 10/s × 40 s, 400 buyers | valid-stable | 300/300 | 0 of 750 / 0% | 0 | 67 / 84 / 146 ms | 10.00 | yes |
| `p8-pilot-a-r25-01` | 25/s × 40 s, 1,000 buyers | valid-stable | 749/750 (99.87%) | 17 of 1,890 (0.90%) / 0.90% | 74 | 65 / 159 / 417 ms | 24.97 | yes |
| `p8-pilot-a-r50-01` | 50/s × 20 s, 1,000 buyers | valid-overload | 140/750 (18.67%) | 1,444 of 2,352 (61.39%) / 64.41% | 1,965 | 2,444 / 4,314 / 5,028 ms | 4.00 | no |

In the 50/s run the application container was at its CPU limit (median 95%), PostgreSQL at a median of 81%, up to 159 requests waited for a pool connection and 3,610 serialization retries were scheduled; 610 buyers of the cohort ended with 500. These are pilot observations that choose the condition.

The rules of the pilot plan applied:

- The lowest step at which A is not stable is 50/s × 20 s. Its unfinished share (81.33%) and its write failure share (61.39%) are not below 5%, so the **formal arrival condition is 50/s × 20 s**: 1,000 buyers, warmup 5 s (the first 250 buyers), 1,000 VUs.
- The highest step at which A was stable is 25/s, so the R candidates are R1 = min(25, 20) = **20** (batch 5, C 60) and R2 = **10** (batch 3, C 30).
- Drain budgets by the fixed formula: 90 s for R 20 (buyers' cutoff 95 s after the start) and 150 s for R 10 (cutoff 155 s).

### R pilot (2026-10-05) — stopped, no candidate qualified

Arm B, the formal arrival condition (50/s × 20 s, 1,000 buyers, warmup 5 s, 1,000 VUs), C = 3R, batch = ⌈R/4⌉, each candidate a commit of the local pilot branch on top of `03af946` (the polling boundary as `5 * admissionProfile.rate`). The criteria were: a valid run, write failure share of the measurement cohort ≤ 1%, recognition → paid p99 of the cohort ≤ 2,000 ms, no row of the final SQL.

| Run | Candidate commit, profile | Verdict | Completion of the cohort | Write failure share of the cohort | Recognition → paid p99 | Promotion achievement in the backlog | First purchase request: failed first attempts | 503 / 500 answers | Final SQL rows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pilot-b-r20-01` | `1946715`, R 20 / batch 5 / C 60 | invalid (`pool`: a gap of 1,059 ms in the application's pool samples) | 535/750 | 757 of 2,146 (35.27%) | 9,555 ms | 44.98% | 540 of 839 | 1,178 / 69 | 0 |
| `p8-pilot-b-r20-01r` | the same | valid-queue | 340/750 | 685 of 1,620 (42.28%) | 10,109 ms | 36.63% | 470 of 687 | 1,111 / 55 | 0 |
| `p8-pilot-b-r10-01` | `50c81a3`, R 10 / batch 3 / C 30 | invalid (host pressure: free host memory fell to 0.1 GiB while another project's containers ran; observer, pool, resource and generator samples have gaps) | 320/750 | 379 of 1,238 (30.61%) | 10,564 ms | 40.03% | 341 of 608 | 661 / 31 | 0 |
| `p8-pilot-b-r10-01r` | the same | valid-queue | 470/750 | 539 of 1,746 (30.87%) | 9,048 ms | 49.16% | 439 of 754 | 846 / 46 | 0 |
| `p8-pilot-b-r5-01` | `0f4df67`, R 5 / batch 2 / C 15 | invalid (`pool`: a gap of 1,593 ms) | 529/750 | 204 of 1,531 (13.32%) | 5,483 ms | 56.20% | 255 of 785 | 384 / 11 | 0 |
| `p8-pilot-b-r5-01r` | the same | invalid (`pool`: a gap of 1,001 ms, the bound is 1,000 ms) | 657/750 | 132 of 1,774 (7.44%) | 3,807 ms | 64.92% | 202 of 907 | 272 / 17 | 0 |

Neither R 20 nor R 10 qualified, so R 5 was run as the plan provides. It did not qualify either, and both of its runs are invalid by the pool-sample rule. Two stop conditions of the pilot plan are met (no candidate after one more halving; two invalid runs in a row for one slot), so the C pilot, the confirmation run and the verification run were not started and the calibration is not decided. The figures of the invalid runs are shown as they were recorded and choose nothing.

What the six runs have in common, as observations of pilots:

- Integrity held in every run: no row of the final SQL, the ledger equal to Redis, at most R promotions in any rolling second, every trace complete, and no 401, 403, 429 or `ADMISSION_QUEUE_FULL`.
- The 503 answers are on the requests that consume the admission (`ADMISSION_UNAVAILABLE`, the reservation and above all the direct checkout); only the run of the host incident has two 503 answers on other purchase requests. In the application logs of `p8-pilot-b-r5-01r` and `p8-pilot-b-r20-01r` each of them is a PostgreSQL serialization failure (40001) that used up its retries, except one lock timeout: 272 of 272 and 1,110 of 1,111. Their share falls with the capacity: about 42% of the cohort's purchase attempts at C 60, 31% at C 30, 7–13% at C 15, and one failed first attempt of 70 in the generator pilot at the seed C 8. A purchase with admission fields runs SERIALIZABLE (ISSUE_14, "Limits kept or introduced"); its frequency of failures had not been measured before.
- The 500 answers are on the existing requests only (the checkout of a reservation and the settlement), never on a request with admission fields.
- The single instance was near its CPU limit while about 900 buyers polled once a second: application CPU median 52–91% of its one CPU. The scheduler promoted 37–65% of R while somebody waited, the controller recognition had a foreground upper bound p95 of 2.7–3.2 s in every run (above the 2 s goal), and the application's own 250 ms pool sampler stalled for more than a second in four runs, which alone made three of them invalid.
- Admitted buyers of the foreground expired in every run (3 to 96 entries): the admission ran out while the purchase was repeated.
- The wait for free slots after the load ran to its bound of 60 s in every run, because buyers were still waiting and the scheduler kept promoting them.
- Another project's containers started on the host twice during these runs; one run was invalid for it.

### Kept runs under analysis v3.1 (2026-10-06, stored evidence re-analysed in this session)

The raw runs of 2026-10-05 were analysed again by `flash-sale-analysis-v3.1` (`8e1148f`). Their folders were only read: the stored `analysis.json` of each run is the v3.0 result and was not rewritten, and the v3.1 results are kept outside the repository (`run/reanalysis/<run-id>.v3.1.json`). In every run the two analyses differ only in the verdict fields shown here, in `evidence.pool` and in `disclosures.poolMaxGapMs`.

| Run | Verdict as recorded (analysis v3.0) | Verdict of analysis v3.1 | Largest gap between pool samples |
| --- | --- | --- | --- |
| `p8-dev-b-01` | valid-queue | valid-queue | 266 ms |
| `p8-gen-b-01` | valid-queue | valid-queue | 846 ms |
| `p8-pilot-a-r10-01` | valid-stable | valid-stable | 262 ms |
| `p8-pilot-a-r25-01` | valid-stable | valid-stable | 260 ms |
| `p8-pilot-a-r50-01` | valid-overload | valid-overload | 291 ms |
| `p8-pilot-b-r10-01` | invalid-measurement [observer,queue-observer,pool,resources,generatorObserved,host-pressure] | invalid-measurement [observer,queue-observer,pool,resources,generatorObserved,host-pressure] | 4464 ms |
| `p8-pilot-b-r10-01r` | valid-queue | valid-queue | 974 ms |
| `p8-pilot-b-r20-01` | invalid-measurement [pool] | valid-queue | 1059 ms |
| `p8-pilot-b-r20-01r` | valid-queue | valid-queue | 745 ms |
| `p8-pilot-b-r5-01` | invalid-measurement [pool] | valid-queue | 1593 ms |
| `p8-pilot-b-r5-01r` | invalid-measurement [pool] | valid-queue | 1001 ms |
| `p8-pre-a-01` | valid-stable | valid-stable | 252 ms |
| `p8-pre-b-01` | valid-queue | valid-queue | 256 ms |
| `p8-pre-c-01` | valid-queue | valid-queue | 252 ms |

Three runs that were invalid for the pool gap alone are `valid-queue` under v3.1; `p8-pilot-b-r10-01` stays invalid for the host incident. The tables above keep the verdicts as they were recorded, and no decision of 2026-10-05 is taken again from the v3.1 verdicts: by their figures none of the three runs meets the criteria either.
