# P2 A baseline — preregistered protocol (2026-10-01 KST)

## Input gate and scope

Base `8f645395bc54c86049a8137b1c0887c4590a2723` contains PR #19 head `09b94fe11b4557097cf0c65ca7969def02c9b414`. Accepted P1 input: implementation `e0fbc78754e17dd6380b1a899373168c3ddf6153`, `flash-sale-v1`, three `p1-reference-{ample-01,ample-02,limited-01}` archives. ZIP hashes, 21 files/archive, all 60 artifact hashes and SQL/cleanup were checked again. Seven sources match after canonical LF normalization. This accepts stored low-load correctness evidence, not capacity. #9/#11 record acceptance; #12/#17 have no accepted P2 input and remain blocked.

Three read-only agents investigated before main finalized this plan. No application transaction, schema, pool, logging, authentication or limiter failure policy changes. Main implements and fixes findings; final review is independent. No merge is authorized.

## Implementation plan

- [ ] Add failing regression cases for phase boundaries, pending/expired settlement facts, malformed business success, SQL identity reconciliation, failed-run coverage and missing evidence.
- [ ] Modify `flash-sale.js` and fixture runner; add pure `flash-sale-analysis.mjs`. Keep strict smoke exit/result while classifying evidence independently. Stream logs; canonical LF plus raw source hashes; bound sampling input. No new dependency.
- [ ] Verify relevant checks and actual small ample/limited HTTP+SQL preflights, then commit measured source. Fix any measurement bug before pilots.
- [ ] Run pilot ladder, fix formal matrix before any formal execution, run each condition three times. Never overlap tests/builds/other workloads with measurement.
- [ ] Analyze/archive every run including failure; run unit/full feasible integration/build/typecheck/lint, branch diff review and separate final reviewer. Main resolves findings; update gate and handoff.

## Protocol v2 (fixed before any load)

Local Windows k6 + Docker Desktop Linux (12 vCPU, 8,281,108,480 byte VM memory at preflight). App 1 CPU/512 MiB, PG16 1 CPU/512 MiB, Redis7 0.5 CPU/256 MiB. Pool 2–10, info logs, PG/pool/PING sample 250ms. Record exact image/runtime/host/resources/clock checks in each manifest. Host and Docker share resources; no production extrapolation.

One hot event/run, unique synthetic identities and keys, 50:50 reservation/direct, quantity 2, think 20ms, checkout/settlement retry 1 after100ms, replay every3. Reservation never retried. Fixed experimental limiter 1,000,000 requests/60s, enabled fail-closed; any 429 means it constrained the run and must be reported. Not an operational setting.

Ample: continuous arrival for40s, warmup10s, measurement30s; users=rate*40 and seats=users*2. k6 duration39999ms, graceful drain maximum30s (ends early if all journeys finish). Scheduled measurement cohort indices [rate*10,rate*40). Also report actual arrivals in window and schedule lag. Endpoints use10s request timeout. Time windows use scenario-start epoch from k6, **[start+10s,start+40s)**; wrapper startup/flush is never a throughput denominator. Capture PG and app clock alignment, bounded by100ms roundtrip+offset uncertainty.

Pilot ladder: 2,10,25,50,100 arrivals/s ascending, one run each; ceiling100/s is an experiment budget, not claimed maximum. Stop escalation on first invalid/integrity run or >=20% nonpaid measurement cohort or paid journey p99>5000ms. Choose formal ample conditions deterministically: 2/s, highest valid-stable pilot, first valid-unstable pilot (deduplicate); if no unstable pilot, 2/s,25/s,100/s. If 2/s unstable, investigate first. Formal order: ascending, descending, ascending; **3 runs per selected condition**. Selection must be appended here before formal runs.

Separate limited-stock competition: rate10/s, users300, stock60 seats, warmup0, measurement30s, drain30s, same other settings; 3 runs. Sold-out rejections are expected; this is not an ample throughput condition. Preflight smoke: users12/rate2, warmup0/drain30, ample then limited seats6; excluded from formal matrix.

Stable ample criteria (experiment assumptions, not a service SLO): measured cohort confirmed-paid >=99%; non-replay window HTTP 429/5xx/transport fraction <=1%; no replay failures; measured paid journey p99<=2000ms; confirmed-paid window throughput in first/last15s differs by <=20% of offered rate. Every formal replicate must meet these to call a rate stable. Replay HTTP failures remain valid overload observations; malformed successful replay bodies invalidate protocol evidence. Latency and completion must both be shown; never summarize only survivors.

Invalid measurement: dropped>0, started != offered, max schedule lag>250ms, script exception, malformed success body, invalid fixture/auth, missing/errored observations or source/artifact/cleanup evidence. PG/pool/PING coverage includes both window edges; maxgap1000ms. Resource samples maxgap6000ms, process samples required during window; host CPU>=90% or <1GiB free memory for3 consecutive resource samples stops further runs. Generator VUs fixed100 pre/max; VU exhaustion requires a revised condition and remeasurement, not a capacity conclusion. Any actual inventory/duplicate/ownership/provider/callback violation stops the series immediately when detected. Unowned resource or cleanup failure stops the next run. Stop reasons and available raw evidence are preserved.

## Denominators and analysis

- Offered/started/dropped: full run plus scheduled/actual measurement arrivals. Measurement-cohort completion numerator is unique validated HTTP paid buyers reconciled individually to final SQL paid orders; denominator is scheduled measurement users, including dropped/incomplete users.
- Window purchase throughput: unique validated HTTP completions occurring inside [start,end) and matching final SQL paid identity, divided by30s. Report warmup-cohort spillover separately. Final SQL paid and HTTP unknown outcomes are separate. `paid_at=NOW()` is transaction-start time, **not commit time**.
- Latency: stage/kind/flow/status/error/business-valid groups from raw attempts, success/failure p95/p99 with counts. Journey includes think/retry, excludes replay; measured cohort paid latency is conditional on success. Whole-cohort unfinished/unknown, last arrival/completion and drain cutoff remain visible.
- SQL: inventory equation, owner/key/quantity, tickets, provider/callback facts independently of smoke expectations. Pending/active holds are incompletion; expired settled reconciliation is not paid and not automatically corruption.
- Pool checkedOut is not active queries; locks are samples and can miss short waits; Redis PING is observer RTT; retry logs are scheduled attempts. Window-filter app logs and PG samples. Resource samples identify pressure, not sole causation. No DB bottleneck claim from pool alone.
- Classification: integrity-defect; invalid-measurement; valid-stable; valid-overload; valid-limited. Strict `manifest.passed`/k6 exit remain unchanged in meaning. Analysis runs even after smoke failure.
- Percentiles use linear interpolation (sorted index `(n-1)*p`); repeats use median and min–max, no pooled percentile. Raw artifacts/failure runs in `load-test/results/flash-sale/<id>/`, reviewed ZIP/hash/index in `load-test/results/flash-sale-baseline/`. Reanalysis: `node load-test/flash-sale-analysis.mjs <run-folder>`.

## Progress and rulings

2026-10-01: user explicitly assigns main plan/implementation and read-only agents; use this single protocol/ledger instead of a second process document. Base harness8/8 passed freshly. P1 data remains historical. Production write paths remain unchanged so experiments measure the existing bottleneck.

Preflight development: `p2-preflight-ample-01` failed with12 script exceptions because k6 Response objects reject added properties. Its raw/SQL/cleanup remain preserved; SQL had0 paid,6 pending orders,12 held seats and all integrity checks passed. Return a separate result wrapper and freeze VM responses to reproduce the bug. `p2-preflight-ample-02` then completed12/12 paid; `p2-preflight-limited-01` completed3 paid/6 tickets,9 stock rejections. These are development smoke, not formal baseline; source was still being reviewed.

Branch reviewer found incomplete custom-metric accounting could be accepted and replay HTTP errors were wrongly invalidated. Main added response/latency, terminal/journey, arrival/summary accounting and separated replay HTTP from malformed responses. Added artifact hash validation for offline analysis. All new regression checks were observed failing before correction. No production path changed.

## Formal matrix and results

Not executed yet. Append pilot decision before formal execution.
