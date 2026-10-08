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
| `load-test/flash-sale-fixture.mjs` | Revision `flash-sale-v3.0` (`v3.1` since the external review, for two changes of the script): `--arm`, `--hidden-share`, `--monitor`, a drain bound of 900 s; the policy row in every arm, the contract's transition for b and c, the wait for a ready namespace, the queue samples, the end of a run (wait for free slots, Redis dump, application stop, SQL snapshot, `admission-final.sql`, ledger comparison, cleanup with `admission_results` first) and the manifest fields that show which arm really ran. |
| `load-test/flash-sale-analysis.mjs` | Revision `flash-sale-analysis-v3.0`, from 2026-10-06 `v3.1` (the bound for pool samples), from 2026-10-09 `v3.2` (expired entries as Redis kept them, a recognition without its delays). A v2.6 manifest takes the unchanged v2.6 path. A v3 run gets the purchase, horizon, admission, polling, recognition and queue figures and the validity and integrity rules below. |
| `load-test/flash-sale-check.mjs` | 21 checks added to the 29 of P2 at first, 23 with analysis v3.1, 26 after the external review (55 in all, one of them on the evidence index). They run the real controller file through the script in a `vm` context with a virtual clock and a fake queue API, and pin the copies the fixture holds of product statements, key names and log lines to the product sources. |
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

Cutoff: a buyer whose purchase is not decided starts no new request after scenario start + arrival seconds + drain budget − 15 s. A request that is out at that instant may still be answered. A buyer whose purchase was answered before the cutoff finishes checkout and settlement, and the controller's status read may still go out while those are in flight. A replay does not start after the cutoff (since harness v3.1; before it the second of the two replays could). Every buyer ends with exactly one outcome: `paid`, `not_joined`, `queue_waiting`, `admission_expired`, `admitted_unpurchased`, `cancelled`, `reset`, `unknown_outcome`, `stock_rejected`, `http_<status>`, `incomplete_checkout` or `incomplete_settlement`.

Recognition is what the controller records in the generator: the interval `lowerMs`–`upperMs` between the entry's `admittedAt` and the moment the controller applied it. It is called "controller recognition (generator)" in every report. Recognition in a browser is not judged here.

### Load model

1,000 buyers, 2,000 seats (ample), quantity 2, reservation and direct 50:50, think 20 ms, checkout and settlement retry 1 after 100 ms, replay every 3, purchase limiter 1,000,000 per 60 s in every arm, pool 10, samples every 250 ms, 1,000 VUs. The warmup cohort is the first 250 buyers; cohorts follow the scheduled arrival, never the admission time. The horizon (arrival seconds + drain budget) is the same in every arm of a comparison.

### Metrics and denominators

- Completion: unique buyers whose HTTP paid answer matches the final SQL order and ticket identity, over every scheduled buyer of the measurement cohort. Waiting, unadmitted, expired, unknown and unfinished buyers stay in the denominator, each under its outcome.
- Throughput: unique paid (HTTP = SQL) inside a window over its length, for the arrival window and for the whole horizon. The analyzer's windows begin at the measurement start (after the warmup) and count every buyer who is paid inside them, also a buyer of the warmup cohort who is paid late; in a queue arm that is nearly the whole warmup cohort and in arm A hardly anybody. The formal report therefore compares the arms by the paid buyers of the measurement cohort over the horizon and shows the analyzer's window figures with the warmup share next to them.
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
   - Added on 2026-10-06 after the C pilot had stopped (plan, E5): `p8-pilot-b-r4c8-01` (R 4, batch 1, C 8, drain 340 s) and `p8-pilot-b-r2c8-01` (R 2, batch 2, C 8, drain 650 s), arm B, formal arrival condition, once each, with the same three criteria per attempt. The outcome after the controller's repeats is reported next to them. If a candidate qualifies, the one with the larger R is the proposed profile; if neither does, the work stops.
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
- Admitted buyers of the foreground expired in every run: 3 to 96 buyers ended with the outcome `admission_expired`, the admission having run out while the purchase was repeated. Redis kept more entries as expired than that, 6 to 160 per run, because a buyer whose last answer was a 503 or a 409, or who was promoted just before the cutoff, ends with another outcome while the entry expires afterwards (counted since analysis v3.2; table under "External review, round 1").
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

### Preflight repeated on the changed harness (2026-10-06, commit `cdfee1b`, seed profile, 24 buyers at 2/s, 24 VUs, drain 30 s)

| Run | Arm | Verdict | Paid | Final SQL rows / ledger mismatches | Controller recognition, foreground upper bound p50 / p95 | Start gate |
| --- | --- | --- | --- | --- | --- | --- |
| `p8-pre-a-02` | A | valid-stable | 24/24 | 0 / 0 | – | first attempt, host CPU 10.3–16.1%, no other container |
| `p8-pre-b-02` | B | valid-queue | 24/24 | 0 / 0 | 686 / 782 ms (24 buyers) | first attempt, 1.1–7.5% |
| `p8-pre-c-02` | C | valid-queue | 24/24 | 0 / 0 | 850 / 1,012 ms (24 buyers) | first attempt, 2.1–7.2% |

Every trace was complete, no slot was in use when k6 ended, and no container, network or volume of the three projects was left.

### C pilot (2026-10-06) — stopped, no candidate qualified

Arm B, the formal arrival condition (50/s × 20 s, 1,000 buyers, warmup 5 s, 1,000 VUs), R 20 and batch 5 fixed, drain 275 s (buyers' cutoff 280 s after the start), each candidate a commit of the rebuilt local pilot branch on top of `aed5b97` (the polling boundary as `5 * admissionProfile.rate`). Criteria: a valid run, write failure share of the measurement cohort ≤ 1%, recognition → paid p99 of the cohort ≤ 2,000 ms, no row of the final SQL. Analysis v3.1; every start gate passed at the first attempt (host CPU 2.3–5.8% and no other container before the first run).

| Run | Candidate commit, profile | Verdict | Completion of the cohort | Write failure share of the cohort | Recognition → paid p50 / p95 / p99 | Mean slot occupation | Promotion achievement in the backlog | First purchase request: failed first attempts | 503 / 500 answers | Largest pool gap | Final SQL rows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pilot-b-r20c8-01` | `1253770`, R 20 / batch 5 / C 8 | invalid (`pool`: a gap of 2,113 ms, the bound is 2,000 ms) | 671/750 | 263 of 1,940 (13.56%) | 288 / 3,755 / 4,339 ms | 2.738 s | 16.50% | 287 of 923 | 396 / 15 | 2,113 ms | 0 |
| `p8-pilot-b-r20c8-01r` | the same | valid-queue | 711/750 (94.80%) | 285 of 2,066 (13.79%) | 277 / 3,852 / 5,731 ms | 2.606 s | 17.30% | 292 of 964 | 407 / 22 | 1,031 ms | 0 |
| `p8-pilot-b-r20c12-01` | `48e6ef1`, R 20 / batch 5 / C 12 | valid-queue | 744/750 (99.20%) | 464 of 2,333 (19.89%) | 380 / 4,311 / 8,430 ms | 3.286 s | 19.99% | 430 of 1,000 | 672 / 30 | 1,077 ms | 0 |

Neither C 8 nor C 12 meets the write failure and the latency criterion, so by the rule of 2026-10-06 the work stopped here: no R′ run, no confirmation run and no verification run were started, and no profile is proposed. Nothing was changed in response. The figures of the invalid run are shown as recorded and choose nothing.

What the three runs show, as observations of pilots:

- Integrity held: no row of the final SQL, the ledger equal to Redis, at most 13 promotions in a rolling second against R 20, every trace complete, no 401, 403, 429 or `ADMISSION_QUEUE_FULL`.
- The capacity bound, not R: the sampled slots in use reached C in every run, and the promotions while somebody waited were 3.3–4.0 per second (924 in 280.0 s, 969 in 280.0 s, 992 in 248.1 s), close to C divided by the mean slot occupation (8 / 2.606 s = 3.1 per second, 12 / 3.286 s = 3.7 per second). The promotion achievement of 17–20% is against R 20 and says that R 20 was never the limit here.
- The 503 answers are again serialization failures (40001) of the purchase with admission fields whose retries ran out: 396, 407 and 672 transient purchase failures in the application logs, all with SQLSTATE 40001. The share of failed attempts is 13.6–13.8% at C 8 and 19.9% at C 12. With the same C 8 but R 2 and batch 2 (the seed profile, generator pilot) one first attempt of 70 had failed, so the share does not follow C alone: it is lower when fewer purchases with admission fields run at the same moment.
- Buyers finished all the same: the controller repeats an undecided purchase with the same identity, and 94.80% (C 8) and 99.20% (C 12) of the measurement cohort were paid. The write failure share counts every failed attempt, also one whose repeat succeeded.
- The rule for R applied to these runs as arithmetic only (no run qualified, so it selects nothing): ⌊8 / (1.5 · 2.606)⌋ = 2 and ⌊12 / (1.5 · 3.286)⌋ = 2, the seed's R.
- The controller recognition had a foreground upper bound p95 of 2.7–2.9 s (above the 2 s goal), application CPU a median of 58–67% of its one CPU with about 900 buyers polling once a second, and 3 to 13 buyers per run ended with the outcome `admission_expired` (Redis kept 12 to 14 entries per run as expired; see "External review, round 1").
- The wait for free slots ran to its bound of 60 s in the two C 8 runs (13 and 55 buyers were still waiting); in the C 12 run every buyer had been promoted and it took 2 ms.

### Candidates near the seed (2026-10-06, plan E5) — R 2 / batch 2 / C 8 qualifies; stopped at the start gate of the confirmation run

Arm B, the formal arrival condition (50/s × 20 s, 1,000 buyers, warmup 5 s, 1,000 VUs), C 8, candidates of the local pilot branch, analysis v3.1, the same three criteria per attempt. Both start gates passed at the first attempt (host CPU 1.1–3.5%, no other container).

| Run | Candidate commit, profile, drain | Verdict | Write failure share of the cohort | Recognition → paid p50 / p95 / p99 | Completion of the cohort inside the horizon | First purchase request: failed first attempts, repeats | 503 / 500 answers | Mean slot occupation | Promotions while somebody waited | Recognition, foreground upper bound p95 | Largest pool gap | Final SQL rows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pilot-b-r4c8-01` | `e9bb12e`, R 4 / batch 1 / C 8, 340 s | valid-queue | 54 of 1,272 (4.25%) | 220 / 1,749 / 2,043 ms | 487/750 (64.93%), 263 still waiting | 82 of 737, 90 | 90 / 3 | 2.010 s | 741 in 345.1 s = 2.15 per second (53.68% of R) | 2,494 ms | 762 ms | 0 |
| `p8-pilot-b-r2c8-01` | `eb8956c`, R 2 / batch 2 / C 8, 650 s | valid-queue | 6 of 1,444 (0.42%) | 174 / 341 / 1,018 ms | 575/750 (76.67%), 175 still waiting | 17 of 825, 18 | 18 / 1 | 2.067 s | 826 in 655.1 s = 1.26 per second (63.04% of R) | 2,793 ms | 785 ms | 0 |

- R 4 / batch 1 / C 8 misses both criteria (4.25%, 2,043 ms). **R 2 / batch 2 / C 8 meets all three** and is, by the rule of E5, the proposed profile: the numbers of the seed. In both runs the final SQL returned no row, the ledger equals Redis, the promotions per rolling second stayed at R (4 and 2), every trace is complete, and no buyer ended with `admission_expired` or `http_503`. Four entries (R 4) and one (R 2) were promoted just before the cutoff, when their buyers had already been left as `queue_waiting`, and expired afterwards.
- The promotions did not reach R although slots were free (at most 7 and 5 of 8 sampled in use): 2.15 per second with batch 1 and 1.26 per second with batch 2. One entry per tick at 2.15 per second is a tick about every 0.47 s instead of 250 ms on the instance that about 900 polling buyers keep near its CPU limit (application CPU median 49–56%, maximum 99–100%). The tick was not measured directly. A batch of ⌈R/4⌉ assumes four ticks a second and therefore cannot reach R in arm B.
- Because of that the drain budget of the formula, which assumes R promotions per second, was too short: 263 and 175 buyers of the cohort were still waiting at the cutoff. The share of the cohort that paid inside the horizon (64.93%, 76.67%) is a property of the horizon, not a failure of a purchase.
- The failed attempts are again serialization failures (40001) whose retries ran out: 90 and 18 in the application logs. Over all runs of the formal condition the share falls with the purchases in flight: 19.89% (C 12, R 20), 13.79% (C 8, R 20), 4.25% (R 4), 0.42% (R 2).
- The controller recognition is above the 2 s goal in both runs (upper bound p95 2.5 s and 2.8 s).
- Another project's container was running when `p8-pilot-b-r2c8-01` ended (`gates/p8-pilot-b-r2c8-01.json`, `containersAfter`); it was not there at the start gate. The run is valid by the analysis: host CPU median 6.4% and maximum 21.7%, at least 2.9 GiB free, arrival lag at most 25 ms, largest pool gap 785 ms.

**Stopped (2026-10-07 00:07 local).** The confirmation run `p8-pilot-c-01` did not start: its start gate failed ten times in a row, because containers of another project (`bluegang-frontend-…-db-1`, then `bluegang-e2e-…-db-1`) kept running, and one attempt saw the host at 99–100% CPU with 0.0 GiB free. No run folder exists for it. The containers were not touched. The confirmation run and the `MONITOR` verification run are open.

### Confirmation and verification (2026-10-08, pilot commit `eb8956c`, R 2 / batch 2 / C 8, 50/s × 20 s, 1,000 buyers, drain 650 s)

Resumed after the other project's containers were gone; both start gates passed at the first attempt with `my-factory-db` as the only running container.

| Run | Arm | Verdict | Completion of the cohort | Write failure share of the cohort | Recognition → paid p50 / p95 / p99 | Promotions while somebody waited | Recognition, foreground upper bound p50 / p95 | Status requests, per second median / max | Application CPU median / max | Final SQL rows / ledger mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-pilot-c-01` | C (adaptive) | valid-queue | 750/750 | 0 of 1,875 | 90 / 106 / 132 ms | 996 in 511.4 s (97.38% of R) | 529 / 1,015 ms | 56,552, 111 / 233 | 28% / 81% | 0 / 0 |
| `p8-pilot-b-r2c8-01` (from above, arm B, for comparison) | B (fixed) | valid-queue | 575/750 | 6 of 1,444 (0.42%) | 174 / 341 / 1,018 ms | 826 in 655.1 s (63.04% of R) | 1,986 / 2,793 ms | 242,176, 346 / 970 | 49% / 100% | 0 / 0 |
| `p8-verify-b-01` | B, `--monitor` | valid-verification (no measurement) | 458/750 | 42 of 1,187 (3.54%) | 438 / 4,527 / 9,499 ms | 708 in 655.1 s (54.04% of R) | 869 / 1,932 ms | 323,796, 518 / 597 | 74% / 96% | 0 / 0 |

- **Confirmation.** With the proposed profile arm C finished every buyer: all 1,000 entries were promoted and consumed, one purchase attempt of the whole run failed (503) and its repeat succeeded, the scheduler reached 97.38% of R, the recognition stayed inside the 2 s goal, and no slot was in use when k6 ended. With the same profile and the same arrivals, arm B sent 4.3 times the status requests, kept the instance near its CPU limit and reached 63% of R. These are single pilot runs that choose the condition; the comparison itself is the task of the formal runs.
- **Verification.** `MONITOR` slows Redis down (Redis CPU median 48% against 11% in the run without it), so the figures of `p8-verify-b-01` are no measurement and enter no statistic. The capture began on an empty admission keyspace (`keysAtStart` 0) and did not end by itself (`endedEarly` false). The replay of its 659,027 lines with `replayAdmissionLog(entries, { rate: 2, capacity: 8, ttlMs: 30000 })` of `src/tests/helpers/admission-transition-log.ts` (run with `npx tsx` from a script outside the repository, output kept as `run/logs/s3-replay-verify-b-01.json`): every line parsed, one namespace, control `initializing` → `ready` in generation 0, 732 promotions (the Redis dump has 732 promoted entries), **0 violations** of capacity, rate, repromotion, FIFO, claim-without-slot, generation and run id, and the sets at the end of the replay equal the dump (waiting 268, active 8, claims 0).

## Formal protocol (fixed on 2026-10-08, before the independent review and before the first formal run)

Approved by the user on the report of the pilots (plan, "Decisions (user, 2026-10-08)"). Everything not named here is the protocol at the top of this document.

- **Source and profile.** One commit of the work branch, clean tree, for all eleven runs; the image is built from it for each run. Profile `admission-v1-seed`: R 2 per second, batch 2, C 8, TTL 30 s, claim 15 s. No product code, contract or profile differs from `1bb2796`.
- **Condition.** 50 buyers per second for 20 s: 1,000 buyers, warmup 5 s (the first 250 buyers are the warmup cohort, the other 750 the measurement cohort), 1,000 VUs, drain 900 s in every arm. Horizon 920 s; a buyer of a queue arm starts no request later than 905 s after the start. Everything else is the load model above (2,000 seats, quantity 2, reservation and direct checkout alternating, think 20 ms, hidden 0%).
- **Runs and order.** `p8-a-01`, `p8-b-01`, `p8-c-01`; `p8-b-02`, `p8-c-02`, `p8-a-02`; `p8-c-03`, `p8-a-03`, `p8-b-03`. Then the layer runs `p8-layer-b-01` and `p8-layer-c-01` with `--hidden-share 20`, which enter no statistic. Command: `node load-test/flash-sale-fixture.mjs --run-id <id> --arm <a|b|c> --users 1000 --rate 50 --warmup-seconds 5 --pre-vus 1000 --max-vus 1000 --drain-seconds 900`, through the run script with the start gate (at least 2 GiB free and host CPU at most 30% in three samples, no other project's container).
- **Validity.** The rules above with analysis `flash-sale-analysis-v3.1`. An invalid run keeps its raw folder and its slot is repeated once under the suffix `r`. The series stops on an integrity defect, on two invalid runs in a row for one slot and on ten failed start gates in a row. No build, test or review runs on the host during the series, and `MONITOR` is not attached.
- **Criteria per run** (a missed criterion is a result, not an invalid run):
  1. completion: paid buyers of the measurement cohort whose order and tickets the final SQL has ≥ 99% of the cohort;
  2. purchase write failure share of the cohort's non-replay attempts ≤ 1%, per attempt (`purchase.measuredCohort`), with the first-request figures after the controller's repeats listed next to it;
  3. paid p99 after admission ≤ 2,000 ms: recognition → paid in B and C (`admission.measuredRecognitionToPaidMs`), arrival → paid in A (`cohort.paidJourneyMs`);
  4. B and C only: promotion achievement while somebody waits ≥ 90% (`queue.promotionAchievement`).
  Arm A also keeps its P2 classification (`valid-stable`, `valid-overload`). The whole wait (arrival → paid p50, p95, p99, with the unfinished counted) is a published cost without a threshold. Recognition: foreground upper bound p95 ≤ 2,000 ms over all promoted buyers, judged per run and apart from the four criteria; it is the controller's recognition inside the generator, and the browser's recognition is not judged.
- **Reporting.** Three repeats are a median with [minimum–maximum]; percentiles are never pooled. Throughput is given for the arrival window and for the horizon. The 500 `INTERNAL_ERROR` of the existing paths and the 503 of the purchase with admission fields are separate columns. No improvement or regression is judged against the v2.6 baseline. A local load result is not an operational result.
- **Evidence.** Per run, committed under `load-test/results/flash-sale-abc-v3/<run-id>/`: `analysis.json`, `manifest.json` and the small evidence files; the raw k6 output and the application log stay in the work tree's ignored result folder with SHA256 and size in `index.json`.

### Independent review before the formal runs (2026-10-08, read-only, at `283a9ae`)

A reviewer that had not written the harness read the script, the fixture, the analysis, the Compose file, the controller and this protocol, and three stored pilot analyses; it ran nothing. It found no defect in the journeys, the denominators, the cutoff or the validity rules, and no difference between the arms beyond the intended ones. What it found, and what is done about it before the first formal run:

- The horizon and arrival-window throughput of the analysis count late payers of the warmup cohort, which inflates the queue arms against A (pilots: 241 of 991 in arm C, 2 of 142 in arm A). No code changes. Reporting rule: **throughput is compared by the paid buyers of the measurement cohort divided by the horizon's 920 s**, in every arm; the analyzer's window figures are shown with their warmup share.
- The evidence folder `load-test/results/flash-sale-abc-v3/` is not ignored by git, and a dirty tree makes a run invalid: nothing is copied or committed there before the last of the eleven runs has ended.
- Sample coverage is required for about 25 s in arm A and for up to 920 s in a queue arm, so a queue run is far more exposed to one late sample. This biases no figure; an invalid run is repeated once as fixed.
- Arm B needs at least 1.105 promotions per second to promote 1,000 buyers before the cutoff and reached 1.26 in its pilot: completion in arm B is read together with the outcomes (`queue_waiting` at the cutoff is the horizon, not a failed purchase).
- The analysis keeps every request point in memory and the manifest is written after it: the runs are started with a larger Node heap (`NODE_OPTIONS=--max-old-space-size=6144`), which changes nothing that is measured.
- Reported per run in addition: `polling.lateMs` (generator timer lateness, which no validity rule judges), the recognition over all layers with the `reconnect` and unrecognized counts next to the foreground p95 (the criterion's percentile is over the recognized foreground buyers), and after the series the image ids of the eleven manifests are compared.
- Application CPU and per-second polling are medians over windows of different length (arm A about 20 s, a queue arm until its last buyer) and are not compared between A and the queue arms.
- Corrected in this document: the analysis revision and the number of checks in "What the branch adds", the description of the cutoff, and the definition of throughput.

## Formal results (2026-10-08 23:06 to 2026-10-09 00:43 local, commit `6f9568f`, run in one stretch)

Nine formal runs and two layer runs by the formal protocol above: 50 buyers per second for 20 s, 1,000 buyers (measurement cohort 750), 1,000 VUs, drain 900 s, profile `admission-v1-seed` (R 2, batch 2, C 8), analysis `flash-sale-analysis-v3.1`. **All eleven runs are valid at the first attempt; no slot was repeated and nothing was excluded.** Every start gate passed at the first attempt with `my-factory-db` as the only running container (host CPU 0.9–7.2%, 4.2–5.2 GiB free). Every figure below is one of these runs on one local host; it is not an operational result, and nothing is judged against the v2.6 baseline.

### What the comparison shows

- **A (no queue) is overloaded at this condition in three of three runs**: 16.00% [14.67%–19.73%] of the measurement cohort paid, 61.75% [59.32%–62.34%] of its purchase attempts failed, and the application answered 500 `INTERNAL_ERROR` 1,975 [1,907–1,977] times. The buyers who did not pay ended with `http_500`.
- **B and C (queue, seed profile) completed the whole cohort in three of three runs**: 750 of 750 paid, with 0.32% [0.21%–0.37%] failed purchase attempts in B and none in C (0 of 1,875 in each run), and a paid p99 after admission of 804 ms [780–941 ms] in B and 134 ms [131–136 ms] in C.
- **The price is the wait.** A buyer of the cohort waited from arrival to paid a median of 503.8 s in B and 306.8 s in C (p99 711.1 s and 485.9 s). With R 2 per second, 1,000 buyers cannot be admitted in less than 500 s; C stayed close to that bound and B took about 225 s longer. In A the 110–148 buyers who paid did so within 1.4–3.0 s (p99).
- **Fixed polling held the scheduler back; adaptive polling did not.** B sent 249,395 [249,181–249,444] status requests, at most 975 in one second of any run, and its scheduler reached 67.92% [67.92%–68.02%] of R while somebody waited. C sent 55,983 [55,938–56,061], at most 236 in one second of any run, and reached 98.01% [97.98%–98.12%]. Criterion 4 (≥ 90%) is missed by B in three of three runs and met by C in three of three.
- **The 2 s recognition goal, on the generator**: met by C in three of three runs (foreground upper bound p95 1,002 ms [987–1,004 ms]) and missed by B in three of three (2,720 ms [2,653–2,723 ms]). Every promoted buyer was recognized in every run (no unrecognized, no missed entry, no `reconnect` sample), so the foreground percentile covers all 1,000. This is the controller's recognition inside k6; the browser's recognition is not judged.
- **Criteria**: C meets all four in every run. B meets completion, failures and latency in every run and misses the promotion achievement in every run. A misses completion and failures in every run; its latency criterion is conditional on the few buyers who paid (met in one run of three).
- **Integrity**: in all eleven runs the final SQL returned no row, the ledger equals Redis, no rolling second had more than R promotions, every trace is complete, nothing was dropped, and no slot was in use when k6 ended.
- **The 503 answers of B** (15 [10–26] over all attempts, 0–1 in C) are serialization failures of the SERIALIZABLE purchase with admission fields whose retries ran out, the limit recorded in #27; the controller's repeat with the same identity succeeded every time, and no buyer ended with a 503. No product code was changed.

#### Per run, in the order they ran

| Run | Arm | Verdict | Completion of the cohort | Write failures of the cohort (per attempt) | Paid p50 / p95 / p99 after admission | Promotion achievement | 1 completion ≥ 99% | 2 failures ≤ 1% | 3 p99 ≤ 2,000 ms | 4 promotion ≥ 90% | Final SQL rows / ledger mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-a-01` | A | valid-overload | 148/750 (19.73%) | 1,394 of 2,350 (59.32%) | 449 / 1,009 / 1,353 ms | – | missed | missed | met | – | 0 / 0 |
| `p8-b-01` | B | valid-queue | 750/750 (100.00%) | 6 of 1,881 (0.32%) | 141 / 365 / 804 ms | 68.02% (996 in 732.2 s) | met | met | met | missed | 0 / 0 |
| `p8-c-01` | C | valid-queue | 750/750 (100.00%) | 0 of 1,875 (0.00%) | 89 / 110 / 134 ms | 98.12% (998 in 508.6 s) | met | met | met | met | 0 / 0 |
| `p8-b-02` | B | valid-queue | 750/750 (100.00%) | 7 of 1,882 (0.37%) | 132 / 348 / 941 ms | 67.92% (996 in 733.2 s) | met | met | met | missed | 0 / 0 |
| `p8-c-02` | C | valid-queue | 750/750 (100.00%) | 0 of 1,875 (0.00%) | 90 / 109 / 136 ms | 98.01% (996 in 508.1 s) | met | met | met | met | 0 / 0 |
| `p8-a-02` | A | valid-overload | 120/750 (16.00%) | 1,453 of 2,353 (61.75%) | 1,682 / 2,673 / 3,024 ms | – | missed | missed | missed | – | 0 / 0 |
| `p8-c-03` | C | valid-queue | 750/750 (100.00%) | 0 of 1,875 (0.00%) | 89 / 107 / 131 ms | 97.98% (996 in 508.3 s) | met | met | met | met | 0 / 0 |
| `p8-a-03` | A | valid-overload | 110/750 (14.67%) | 1,445 of 2,318 (62.34%) | 1,075 / 1,938 / 2,362 ms | – | missed | missed | missed | – | 0 / 0 |
| `p8-b-03` | B | valid-queue | 750/750 (100.00%) | 4 of 1,879 (0.21%) | 143 / 367 / 780 ms | 67.92% (996 in 733.2 s) | met | met | met | missed | 0 / 0 |

#### Per arm, median [minimum–maximum] of three runs

| Figure | A (no queue) | B (queue, fixed polling) | C (queue, adaptive polling) |
| --- | --- | --- | --- |
| Completion of the measurement cohort | 16.00% [14.67%–19.73%] | 100.00% [100.00%–100.00%] | 100.00% [100.00%–100.00%] |
| Paid buyers of the cohort per second of the 920 s horizon | 0.130 [0.120–0.161] | 0.815 [0.815–0.815] | 0.815 [0.815–0.815] |
| Purchase write failure share of the cohort, per attempt | 61.75% [59.32%–62.34%] | 0.32% [0.21%–0.37%] | 0.00% [0.00%–0.00%] |
| First purchase requests that failed at the first attempt (all buyers) | 450 [410–458] | 13 [10–24] | 1 [0–1] |
| 503 answers (all attempts) | 0 [0–0] | 15 [10–26] | 1 [0–1] |
| 500 `INTERNAL_ERROR` answers (all attempts) | 1,975 [1,907–1,977] | 0 [0–1] | 0 [0–0] |
| Paid p50 after admission (A: arrival → paid) | 1,075 ms [449 ms–1,682 ms] | 141 ms [132 ms–143 ms] | 89 ms [89 ms–90 ms] |
| Paid p99 after admission (A: arrival → paid) | 2,362 ms [1,353 ms–3,024 ms] | 804 ms [780 ms–941 ms] | 134 ms [131 ms–136 ms] |
| Whole wait, arrival → paid p50 | 1.1 s [0.4 s–1.7 s] | 503.8 s [503.5 s–504.5 s] | 306.8 s [306.3 s–307.1 s] |
| Whole wait, arrival → paid p95 | 1.9 s [1.0 s–2.7 s] | 695.9 s [695.5 s–696.5 s] | 471.6 s [471.4 s–471.6 s] |
| Whole wait, arrival → paid p99 | 2.4 s [1.4 s–3.0 s] | 711.1 s [710.2 s–711.1 s] | 485.9 s [485.7 s–486.4 s] |
| Promotion achievement while somebody waited | – | 67.92% [67.92%–68.02%] | 98.01% [97.98%–98.12%] |
| Recognition, foreground upper bound p50 | – | 1,706 ms [1,704 ms–1,730 ms] | 514 ms [501 ms–551 ms] |
| Recognition, foreground upper bound p95 | – | 2,720 ms [2,653 ms–2,723 ms] | 1,002 ms [987 ms–1,004 ms] |
| Status requests | – | 249,395 [249,181–249,444] | 55,983 [55,938–56,061] |
| Status requests per registered buyer, median | – | 248.0 [247.5–248.5] | 56.0 [56.0–56.0] |
| Status requests in one second, maximum | – | 971 [958–975] | 232 [222–236] |
| Mean slot occupation | – | 1.854 s [1.816 s–1.859 s] | 0.561 s [0.556 s–0.584 s] |
| Time until k6 ended | 21 s [21 s–22 s] | 735 s [734 s–735 s] | 510 s [510 s–511 s] |
| Runs meeting criteria 1 / 2 / 3 / 4 | 0 of 3 / 0 of 3 / 1 of 3 / – | 3 of 3 / 3 of 3 / 3 of 3 / 0 of 3 | 3 of 3 / 3 of 3 / 3 of 3 / 3 of 3 |

#### Queue arms: recognition, polling and the generator

| Run | Promoted / recognized / unrecognized / missed | Foreground upper bound p50 / p95 (count) | All layers upper bound p95 (count), `reconnect` | 2 s goal | Status requests, per second median / max | By reason | Timer lateness p99 / max | Foreground entries expired | Application CPU median / max | Largest pool gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-b-01` | 1000 / 1000 / 0 / 0 | 1,730 / 2,720 ms (1000) | 2,720 ms (1000), 0 | missed | 249,181, 279 / 971 | recover 1,000, timer 247,181, refresh 1,000 | 15 / 90 ms | 0 | 46% / 100% | 777 ms |
| `p8-c-01` | 1000 / 1000 / 0 / 0 | 514 / 987 ms (1000) | 987 ms (1000), 0 | met | 56,061, 111 / 222 | recover 1,000, timer 54,061, refresh 1,000 | 1 / 68 ms | 0 | 27% / 65% | 285 ms |
| `p8-b-02` | 1000 / 1000 / 0 / 0 | 1,706 / 2,723 ms (1000) | 2,723 ms (1000), 0 | missed | 249,444, 293 / 958 | recover 1,000, timer 247,444, refresh 1,000 | 18 / 84 ms | 0 | 46% / 99% | 762 ms |
| `p8-c-02` | 1000 / 1000 / 0 / 0 | 501 / 1,002 ms (1000) | 1,002 ms (1000), 0 | met | 55,938, 109 / 236 | recover 1,000, timer 53,938, refresh 1,000 | 1 / 61 ms | 0 | 28% / 63% | 277 ms |
| `p8-c-03` | 1000 / 1000 / 0 / 0 | 551 / 1,004 ms (1000) | 1,004 ms (1000), 0 | met | 55,983, 112 / 232 | recover 1,000, timer 53,983, refresh 1,000 | 1 / 58 ms | 0 | 28% / 60% | 267 ms |
| `p8-b-03` | 1000 / 1000 / 0 / 0 | 1,704 / 2,653 ms (1000) | 2,653 ms (1000), 0 | missed | 249,395, 275 / 975 | recover 1,000, timer 247,395, refresh 1,000 | 15 / 92 ms | 0 | 44% / 100% | 732 ms |

#### Throughput windows of the analysis, with the warmup cohort's late payers

| Run | Arrival window (15 s): paid, of them warmup cohort, per second | Horizon window (915 s): paid, of them warmup cohort | Cohort paid over 920 s, per second | Outcomes of the cohort |
| --- | --- | --- | --- | --- |
| `p8-a-01` | 134, 2, 8.93 | 150, 2 | 0.161 | http_500 602, paid 148 |
| `p8-b-01` | 20, 20, 1.33 | 992, 242 | 0.815 | paid 750 |
| `p8-c-01` | 27, 27, 1.80 | 990, 240 | 0.815 | paid 750 |
| `p8-b-02` | 20, 20, 1.33 | 992, 242 | 0.815 | paid 750 |
| `p8-c-02` | 28, 28, 1.87 | 990, 240 | 0.815 | paid 750 |
| `p8-a-02` | 70, 0, 4.67 | 120, 0 | 0.130 | paid 120, http_500 630 |
| `p8-c-03` | 30, 30, 2.00 | 991, 241 | 0.815 | paid 750 |
| `p8-a-03` | 75, 0, 5.00 | 110, 0 | 0.120 | paid 110, http_500 640 |
| `p8-b-03` | 19, 19, 1.27 | 992, 242 | 0.815 | paid 750 |

#### Validity and environment per run

| Run | Commit | Application image | Arrival lag max | Dropped | Host CPU median / max | PostgreSQL / Redis CPU median | Trace | Free slots after | Application exit | Transient purchase failures in the log |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-a-01` | `6f9568f` | `219426f8c783` | 26 ms | 0 | 4.4% / 5.5% | 81% / 6% | complete | 2 ms | 0 after 0.6 s | 0 |
| `p8-b-01` | `6f9568f` | `318c029a9a8d` | 49 ms | 0 | 5.9% / 12.0% | 6% / 9% | complete | 1 ms | 0 after 0.6 s | 15 |
| `p8-c-01` | `6f9568f` | `1048ced49fb9` | 23 ms | 0 | 3.7% / 12.4% | 5% / 7% | complete | 2 ms | 0 after 0.6 s | 1 |
| `p8-b-02` | `6f9568f` | `c5b22d63f173` | 30 ms | 0 | 6.3% / 11.8% | 5% / 9% | complete | 1 ms | 0 after 0.6 s | 26 |
| `p8-c-02` | `6f9568f` | `67364c30d7a4` | 27 ms | 0 | 3.8% / 9.1% | 6% / 7% | complete | 1 ms | 0 after 0.6 s | 0 |
| `p8-a-02` | `6f9568f` | `4cabab6693e0` | 20 ms | 0 | 4.6% / 5.2% | 81% / 6% | complete | 1 ms | 0 after 0.7 s | 0 |
| `p8-c-03` | `6f9568f` | `a13efabe48ae` | 37 ms | 0 | 3.5% / 10.0% | 5% / 7% | complete | 1 ms | 0 after 0.6 s | 1 |
| `p8-a-03` | `6f9568f` | `f0a8d6a91230` | 22 ms | 0 | 3.3% / 4.2% | 79% / 6% | complete | 1 ms | 0 after 0.6 s | 0 |
| `p8-b-03` | `6f9568f` | `7eecfd67f1d1` | 25 ms | 0 | 6.1% / 11.7% | 6% / 10% | complete | 2 ms | 0 after 0.6 s | 10 |

#### Layer runs (hidden 20%, no statistic)

| Run | Arm | Verdict | Completion of the cohort | Write failures of the cohort | Promoted / recognized / unrecognized / missed | Foreground upper bound p50 / p95 (count) | Hidden upper bound p50 / p95 / max (count) | `reconnect` (count) | Entries expired: foreground | Outcomes of the cohort | Status requests | Final SQL rows / ledger |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p8-layer-b-01` | B | valid-queue | 750/750 | 30 of 1905 | 1000 / 1000 / 0 / 0 | 1,530 / 2,383 ms (800) | 7,617 / 14,546 / 16,239 ms (199) | 1 | 0 | paid 750 | 205,642 | 0 / 0 |
| `p8-layer-c-01` | C | valid-queue | 750/750 | 1 of 1876 | 1000 / 1000 / 0 / 0 | 530 / 995 ms (800) | 8,001 / 14,027 / 14,887 ms (200) | 0 | 0 | paid 750 | 48,559 | 0 / 0 |

Reading the tables:

- Throughput is compared by the cohort's paid buyers over the 920 s horizon (reporting rule of the independent review). B and C both show 0.815 per second because both completed all 750; the figure does not separate them, the whole wait and the time until k6 ended do. The analyzer's windows count late payers of the warmup cohort (240–242 of about 991 in a queue arm, 0–2 in A) and are shown for transparency only.
- Application CPU, per-second polling and "time until k6 ended" come from windows of different length (A about 21 s, C about 510 s, B about 735 s); CPU and polling are not compared between A and the queue arms.
- The generator did not limit arm B: its timers were late by at most 92 ms (p99 15–18 ms), the arrival lag was at most 49 ms and host CPU at most 12.4%.
- Images over 11 runs: application 11 distinct id(s), PostgreSQL 1, Redis 1; commits 6f9568f780219ea8e28e026072c448a38e8e069b. The application image is built again for every run, so its id differs from run to run; the 15 hashed source files are identical in all eleven manifests, and PostgreSQL and Redis ran from one image id each.
- Layer runs: with 20% of the buyers in a hidden tab the hidden layer's recognition had an upper bound p95 of 14.5 s (B) and 14.0 s (C), which is the hidden polling interval of 15 s at work, while the foreground layer stayed where it was in the formal runs (2,383 ms and 995 ms). Everybody was recognized and paid; no entry expired. In `p8-layer-b-01` 30 of 1,905 purchase attempts of the cohort failed (1.57%); the layer runs enter no statistic.

### Limits of these results

- One host, one application instance with one scheduler, one arrival condition, three repeats per arm; minimum and maximum of three are not a confidence interval.
- The buyers are k6 iterations that run the page's controller; k6 cannot cancel a request, every tab is in the foreground in the formal runs, nobody leaves or cancels, and a purchase follows recognition after 20 ms.
- The profile was chosen by single pilot runs (see the pilot sections). Larger R with C 8 or 12 failed the write failure criterion because of the serialization failures of the purchase with admission fields (#27); that product limit, not the queue, is what keeps the profile at the seed.
- The promotion achievement of B is the scheduler of one instance sharing one CPU with about 900 polls per second; the tick interval itself was not measured.
- The whole wait of several minutes is the direct consequence of R 2 per second for 1,000 buyers. Whether that wait is acceptable is a product decision this comparison does not make.

### Evidence

`load-test/results/flash-sale-abc-v3/index.json` lists every P8 run (35 at the time of the formal results, 37 with the two preflight runs of the external review round) with its kind, commit, profile, settings and verdict. For the nine formal and two layer runs it carries the full analysis and names one archive each (`<run-id>.zip`, 0.4–1.7 MB, 15 MB together) with size and SHA256; an archive holds every artifact of the run except `k6-raw.jsonl` and `app.jsonl`. Those two stay in the ignored result folder of the work tree (formal B run: 1.0 GB and 188 MB) with their size and SHA256 in the index under `localOnly`, as do all artifacts of the pilot, preflight, development, invalid and verification runs. A check of `load-test/flash-sale-check.mjs` verifies every archive against the index.

### Verification of the final state (2026-10-09, run in this session after the series)

- `npm run test:flash-sale` 53/53 on the host (Node 24.15.0) and 53/53 in a `node:18-alpine` container (Node 18.20.8); the added check is the one on the evidence index.
- `npm run build` passed; `npm run lint` 0 errors and 11 warnings, as at the base; `npm test` (unit) 251/251 in 25 suites.
- The 14 stored v2.6 archives re-analysed equal their index in every field but `analysisRevision`.
- `git diff 1bb2796 -- src frontend` and the diff of the contract document and the migrations are empty: no product code, test under `src`, contract or migration changed in P8. The integration and fault suites and the browser scenarios were therefore not run again; their last results are those of P7 at the consumed commit.
- No container, network or volume of this task is left; the images `peakpass:fs-p8-*` are kept until close-out.
- Corrected with this commit (D13, facts only): three statements of `docs/ISSUE_16_VALIDATION.md` that were written before the merge of PR #31.

## External review, round 1 (2026-10-09, of `f32eb17`)

An external reviewer read the branch at `f32eb17`, verified the hashes of the eleven archives, re-analysed the eleven runs to the figures of the index, confirmed the equal conditions of the arms, the denominators, the stated limits and that every changed rule was committed before the runs it governs, and reported three P2 findings and one P3. By the maintainer's rule for review rounds every finding of a round is worked on when one of them matters for real use, security, this project, a single occurrence or the documents; all four do. Findings 2 and 3 were reproduced by the reviewer on synthetic boundaries and did not occur in any formal run.

| Finding | What was wrong | Change | Check seen failing first |
| --- | --- | --- | --- |
| 1 (P2) Expired entries | `admission.foregroundExpired` counts buyers whose outcome is `admission_expired`. An entry that expired after its buyer had ended with another outcome was not counted (`p8-pilot-b-r20c12-01`: 13 reported, 14 in Redis and in the ledger). | Analysis v3.2 adds `admission.expiredEntries` (`foreground`, `hidden`, `byOutcome`): entries promoted before the cutoff that the Redis dump holds as expired, by the outcome of their buyer. The outcome count stays as it is. | yes |
| 2 (P2) Replay after the cutoff | The cutoff was checked once before the two replays of a paid buyer, so the second could start after it and run past the drain. | Harness v3.1: the second replay is not sent when the cutoff has passed. | yes |
| 3 (P2) Answers without times | A status answer without `serverTime` passed as a success; the recognition then had no delay, the buyer counted as recognized and was missing from the percentile. | Harness v3.1: a 2xx status or join answer needs a parseable `serverTime` and, in the state `admitted`, `admittedAt` and `expiresAt`, or it is a protocol failure (the run is invalid). Analysis v3.2: a recognition without both bounds and its instant makes the trace incomplete (invalid). | yes |
| 4 (P3) Maximum of maxima | The text gave 971 and 232 status requests "in one second" for B and C; those are the medians of the three per-run maxima. | Text corrected to the maxima over the runs, 975 and 236. The table was right. | – |

The five new or extended checks failed before the changes (5 of 55) and pass with them.

Effect on the recorded results:

- **Formal and layer runs: none.** All 35 kept runs were analysed again by v3.2 (results outside the repository, `run/reanalysis/<run-id>.v3.2.json`; the run folders and the committed archives were not written). For the eleven formal and layer runs every field equals the committed analysis except the added `admission.expiredEntries`, which is 0 in all of them; all verdicts are the same and every trace is complete under the stricter rule. They were made with harness `flash-sale-v3.0` and analysed by `flash-sale-analysis-v3.1`; the index and the archives stay as they were produced, and a manifest of either harness revision is analysed as a v3 run. In those runs no replay started after the cutoff (the last buyer ended 170 s or more before it) and no status answer failed validation.
- **Pilot and verification runs: the expired counts in the text were too low and are corrected above.** No verdict and no selection changes; the counts were not a selection criterion.

| Run | Buyers ending with `admission_expired` (as recorded) | Entries Redis kept as expired, promoted before the cutoff (v3.2) | Their buyers' outcomes |
| --- | --- | --- | --- |
| `p8-gen-b-01` | 0 | 2 | `queue_waiting` 2 |
| `p8-pilot-b-r20-01` | 71 | 114 | `admission_expired` 71, `http_503` 21, `http_409` 12, `queue_waiting` 10 |
| `p8-pilot-b-r20-01r` | 96 | 160 | `admission_expired` 96, `http_503` 51, `queue_waiting` 9, `http_409` 4 |
| `p8-pilot-b-r10-01` | 39 | 67 | `admission_expired` 39, `http_409` 10, `http_503` 9, `queue_waiting` 9 |
| `p8-pilot-b-r10-01r` | 38 | 57 | `admission_expired` 38, `http_503` 12, `http_409` 4, `queue_waiting` 3 |
| `p8-pilot-b-r5-01` | 6 | 10 | `admission_expired` 6, `http_503` 2, `queue_waiting` 2 |
| `p8-pilot-b-r5-01r` | 3 | 6 | `admission_expired` 3, `queue_waiting` 3 |
| `p8-pilot-b-r20c8-01` | 4 | 12 | `queue_waiting` 6, `admission_expired` 4, `http_503` 2 |
| `p8-pilot-b-r20c8-01r` | 3 | 13 | `queue_waiting` 6, `admission_expired` 3, `http_409` 3, `http_503` 1 |
| `p8-pilot-b-r20c12-01` | 13 | 14 | `admission_expired` 13, `http_409` 1 |
| `p8-pilot-b-r4c8-01` | 0 | 4 | `queue_waiting` 4 |
| `p8-pilot-b-r2c8-01` | 0 | 1 | `queue_waiting` 1 |
| `p8-verify-b-01` | 11 | 13 | `admission_expired` 11, `queue_waiting` 2 |

Every other queue run has no expired entry. A buyer with the outcome `queue_waiting` here was promoted within the last moments before the cutoff, on the Redis clock, and had been left as waiting by its last answer.

Verification of the changed harness (run in this session at `13c6937`):

- `npm run test:flash-sale` 55/55 on the host (Node 24.15.0) and in a `node:18-alpine` container (Node 18.20.8); `npm run build`; `npm run lint` 0 errors and 11 warnings; the 14 stored v2.6 archives re-analysed equal their index; the diff of `src` and `frontend/` against `1bb2796` is empty.
- Two preflight runs with the changed script against the real application, seed profile, 24 buyers at 2/s: `p8-pre-b-03` and `p8-pre-c-03`, both `valid-queue`, 24 of 24 paid, no protocol failure, no replay failure, final SQL 0 rows, ledger equal, traces complete, manifest revision `flash-sale-v3.1`, analysis `flash-sale-analysis-v3.2`. They are in the index as local-only preflight runs.
- No formal run was repeated: the two script changes act only on a replay after the cutoff and on a malformed status answer, and neither occurred in the formal runs.
