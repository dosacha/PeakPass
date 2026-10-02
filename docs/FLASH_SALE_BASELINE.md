# P2 A baseline — protocol and results (2026-10-01 KST)

현재 gate: **v2.6 정식10/12회 원본을 analysis-v2.6.1로 재검증 중이며 P2 수용은 보류**다. 2026-10-02 오토리뷰의 sourceClean·정확한 offered buyer 범위·strict smoke 분리를 수정한다. 기존 원본은 그대로 보존하며 남은 limited02/03은 아래 재개 계획에 따른다. #12/#17 consumed v2.3은 아직 stale/blocked다.

## Input gate and scope

Base `8f645395bc54c86049a8137b1c0887c4590a2723` contains PR #19 head `09b94fe11b4557097cf0c65ca7969def02c9b414`. Accepted P1 input: implementation `e0fbc78754e17dd6380b1a899373168c3ddf6153`, `flash-sale-v1`, three `p1-reference-{ample-01,ample-02,limited-01}` archives. ZIP hashes, 21 files/archive, all 60 artifact hashes and SQL/cleanup were checked again. Seven sources match after canonical LF normalization. This accepts stored low-load correctness evidence, not capacity. #9/#11 record acceptance; #12/#17 have no accepted P2 input and remain blocked.

Three read-only agents investigated before main finalized this plan. No application transaction, schema, pool, logging, authentication or limiter failure policy changes. Main implements and fixes findings; final review is independent. No merge is authorized.

## Implementation plan — v2.3 당시 완료 기록

- [x] Add failing regression cases for phase boundaries, pending/expired settlement facts, malformed business success, SQL identity reconciliation, failed-run coverage and missing evidence.
- [x] Modify `flash-sale.js` and fixture runner; add pure `flash-sale-analysis.mjs`. Keep strict smoke exit/result while classifying evidence independently. Stream logs; canonical LF plus raw source hashes; bound sampling input. No new dependency.
- [x] Verify relevant checks and actual small ample/limited HTTP+SQL preflights, then commit measured source. Fix any measurement bug before pilots.
- [x] Run pilot ladder, fix formal matrix before any formal execution, run each condition three times. Never overlap tests/builds/other workloads with measurement.
- [x] Analyze/archive every run including failure; run unit/full feasible integration/build/typecheck/lint, branch diff review and separate final reviewer. Main resolves findings; update gate and handoff.

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

Instrumentation correction before formal measurement: v2 pilots observed the Chocolatey k6 launcher (0 CPU seconds, ~14MiB), not its child load process. **All `p2-pilot-*-01` runs are excluded from capacity acceptance**, including any in-flight run during the correction. Original verdicts remain in original archives; this exclusion supersedes their validity label. v2.1 aggregates the owned k6 PID tree and requires observed CPU progression; rerun pilots as `p2-pilot-*-02` with identical experimental criteria. This also invalidates v2 preflights for generator-capacity claims, though their HTTP/SQL correctness evidence is retained. #12/#17 have no consumed P2 tuple; affected comparison assumptions remain stale until v2.1 acceptance.

Ruling before v2.1 pilots: repeat2,10,25/s only. The excluded50/s trial hit the fixed100-VU limit (312 dropped, maximum lag6173ms); it cannot establish a50/s delivered load and stops escalation under the original rule. Do not repeat that known invalid condition or raise VUs silently. The corrected pilot search is capped25/s; use2/s, highest stable, first unstable among2/10/25 (if all stable use all three). This reduces the searchable range and forbids a maximum-capacity conclusion. Preserve50/s raw as a generator/VU limitation. Any future higher-load experiment needs a new preregistered VU condition and new repetitions.

## Formal matrix and results

Before formal execution: v2.1 corrected pilots2/10/25 delivered every arrival with no dropped iterations and valid observation/cleanup. Rates2/10 were stable (30s paid/s2/10, cohort60/60 and300/300, paid journey p99 97.51/107.02ms). Rate25 was valid-overload: 747/750 cohort paid (99.6%), window750 paid (includes3 warmup spillover), 24/1902 non-replay attempts failed (1.2618%), p99 383.02ms. No stop threshold was reached. These are selection pilots, not formal replicates.

Formal matrix fixed now: ample2,10,25/s, three each, ordered **2/10/25;25/10/2;2/10/25**. Run IDs `p2-ample-r<rate>-01..03`. Then limited10/s,300users,60seats, three runs `p2-limited-01..03`. All use the settings above and independent fresh resources; tests/builds remain suspended during measurement.

Before this matrix, review tightened replay checkout identity validation: a201 response returning another order is a malformed success (invalid protocol), not merely a replay HTTP failure. Regression observed RED then GREEN. Revision **flash-sale-v2.2** changes only this harness validation, not offered load/application/resources/thresholds. v2.1 pilots only select the matrix; all accepted formal runs will use v2.2 source. Earlier revisions are not accepted P2 inputs.

Explicit supported drain boundary: a k6 iteration interrupted at the30s graceful cutoff, including interruption during post-purchase replay, is **invalid-measurement** because complete request/iteration accounting cannot be established. Preserve its paid/SQL/raw facts, but do not infer delivered-capacity validity from them. Valid overload can contain fully observed failed journeys and pending SQL orders; this harness does not certify censored in-flight attempts.

v2.2 formal stopped after `p2-ample-r2-01`: all80 buyers paid, window60/60 and2/s, SQL/cleanup/arrival coverage passed, but the owned two-process CPU counter stayed0.0625s throughout the window. Memory and both PIDs were present; requiring CPU progression falsely rejected low-load observation. **v2.3** records executable paths, per-process CPU/memory and ShimGen metadata, and requires a non-shim engine with finite CPU/memory instead of increasing CPU. Regression observed RED/GREEN. Preserve the original invalid result. Before restarting, retain the same matrix/thresholds/order and use fresh IDs `p2-v23-ample-r<rate>-01..03` / `p2-v23-limited-01..03`. The entire accepted matrix must use v2.3; do not substitute any previous pilot or invalid formal result.

Post-hoc analysis correction, before limited-stock runs: `p2-v23-ample-r25-03` stopped the series on generatorObserved only. Window ended02:00:07.493Z; the final sequential resource query spanned07.378–09.896Z and k6 exited normally at07.776Z (1000 complete iterations,0 interrupted/dropped). Previous actual engine sample was3.356s before window end. Analysis revision **flash-sale-analysis-v2.3.1** permits only a resource query straddling BOTH measurement end and k6 exit to lack the engine, while still requiring actual-engine coverage within the preregistered6000ms and rejecting interior null/shim/error samples. A read-only reviewer checked raw timestamps and the exception; main added RED/GREEN end-boundary and interior-gap regressions.

Uniformly reanalyze every v2.3 formal run with this analysis revision; preserve original `analysis.json` and all archive bytes, and label corrected analyses separately in the index. No latency/throughput/success/stop thresholds, fixture, load script, collector or application changed. Therefore existing raw measurements remain reusable with an explicit **measurement SHA + analysis SHA** tuple. This is a disclosed post-hoc instrumentation correction, not a preregistered statistical acceptance change. Limited runs use the same v2.3 measurement code and settings with only analyzer/tests/docs changed; record both measured commits and their source hashes. Resume the originally fixed three limited runs after committing this ruling; no failed run is silently replaced.

## 최종 측정 결과 (2026-10-01 KST)

실제 환경은 Windows11/i5-10400F(12 logical CPU), host Node24.15.0·k6 1.7.1, Docker Desktop Linux12vCPU/8,281,108,480bytes, 앱 Node18.20.8, PostgreSQL16.12, Redis7.4.8이다. 각 이미지 digest·loopback port·container ID·전체 명령은 run manifest에 있다. 앱1CPU/512MiB, PG1CPU/512MiB, Redis0.5CPU/256MiB, pool2–10 및 info 로그를 고정했다.

12개 앱 이미지 digest는 실행별 Compose 프로젝트 이름 라벨 때문에 서로 다르다. 해당 소유권 라벨을 각 manifest와 대조한 뒤 제외했을 때 RootFS 모든 계층과 나머지 runtime Config/Architecture/Os는12개 모두 동일했다([동등성 기록](../load-test/results/flash-sale-baseline/image-equivalence.json), canonical runtime SHA256 `c1c8821e11f0bcb1f0da19846b41acc39efacf888d04b2b29afbf54b17e1537c`).

대기열 없는 기존 쓰기 경로에서 ample 2·10·25명/초 각각3회는 사전 안정 기준을 만족했다. **이는 이 환경·30초 측정창·허용 오류 기준에서 관측한 범위이며 최대 용량이 아니다.** 25명/초에는 실제500과 미완료 주문이 있었고 모든 strict smoke는 실패했다. 안정 기준의 99% 완료/1% 요청 실패 허용은 실험 가정이며 운영 SLO가 아니다. 50명/초 예비 실행은 발생기/VU 한계로 무효여서 서비스 포화점으로 쓰지 않는다. 대기열의 필요성·개선 효과는 아직 입증하지 않았다.

표의 값은 **3회 중앙값 [최솟값–최댓값]**이며 percentile을 합쳐 다시 계산하지 않았다. 구매/s는 측정창 고유 HTTP paid와 최종 SQL paid 사용자 일치를30초로 나눈다. 완료율은 scheduled measurement cohort 전체(미완료 포함)가 분모다. 오류율은 창 안 non-replay normal+retry 시도의429/5xx/전송실패 비율이며 품절409는 별도다.

| 조건 | 창 paid/s | cohort 완료율 % | 요청 실패율 % | paid 여정 p95 ms | paid 여정 p99 ms |
|---|---:|---:|---:|---:|---:|
| ample-2 | 2.00 [2.00–2.00] | 100.00 [100.00–100.00] | 0.00 [0.00–0.00] | 82.40 [79.10–89.05] | 94.00 [89.20–113.00] |
| ample-10 | 10.00 [10.00–10.00] | 100.00 [100.00–100.00] | 0.00 [0.00–0.13] | 81.00 [76.05–81.05] | 93.10 [88.03–118.38] |
| ample-25 | 25.00 [24.93–25.03] | 100.00 [99.73–100.00] | 0.58 [0.21–0.79] | 125.00 [108.00–125.65] | 276.00 [186.51–332.01] |
| limited-10 | 1.00 [1.00–1.00] | 10.00 [10.00–10.00] | 0.00 [0.00–0.00] | 88.10 [85.85–104.45] | 95.39 [93.26–145.66] |

limited의1 paid/s와10%는 재고가30개 주문으로 제한된 결과다. 세 번 모두300명 시작,30 paid/60 tickets/270 INSUFFICIENT_INVENTORY, 잔여0·pending0·active hold0이었다. 마지막 paid는 scenario 시작 후2.942–2.952초, 마지막 도착은29.897초였다. 이 수치를 ample 용량 곡선에 섞지 않는다.

### 실행별 분모와 미완료

모든 정식 실행은 offered=started, dropped0, script/protocol failure0, replay failure0, SQL paid without HTTP0, HTTP paid without SQL0이었다. 최대 도착 lag는24ms였다. 인증 negative3개/회는 별도이며 모두 기대401/403/401 및 DB 불변을 확인했다.

| Run ID (`p2-v23-` 생략) | 전체 시작 | cohort paid/offered | 창 paid/30s | 실패 시도/전체 non-replay | 전체 SQL paid | pending 주문 | active hold 좌석 | strict smoke |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| ample-r2-01 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| ample-r2-02 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| ample-r2-03 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| limited-01 | 300 | 30/300 | 30/30 | 0/345 | 30 | 0 | 0 | True |
| limited-02 | 300 | 30/300 | 30/30 | 0/345 | 30 | 0 | 0 | True |
| limited-03 | 300 | 30/300 | 30/30 | 0/345 | 30 | 0 | 0 | True |
| ample-r10-01 | 400 | 300/300 | 300/30 | 0/750 | 400 | 0 | 0 | True |
| ample-r10-02 | 400 | 300/300 | 300/30 | 0/750 | 400 | 0 | 0 | True |
| ample-r10-03 | 400 | 300/300 | 300/30 | 1/751 | 400 | 0 | 0 | True |
| ample-r25-01 | 1000 | 750/750 | 750/30 | 4/1879 | 999 | 1 | 0 | False |
| ample-r25-02 | 1000 | 748/750 | 748/30 | 15/1888 | 996 | 3 | 2 | False |
| ample-r25-03 | 1000 | 750/750 | 751/30 | 11/1887 | 999 | 1 | 0 | False |

25명/초의 전체 SQL paid는999/996/999였다. 측정 cohort의 미완료는0/2/0명이고 나머지 실패는 warmup cohort다. `r25-02`의2명은 최종HTTP500이며 unknown outcome은0이었다. `r25-03` 창751 paid에는 warmup 유입의 완료1개가 포함된다. cohort750과 창751은 서로 다른 분자다. paid 여정 percentile은 성공자 조건부이며 이 미완료 수를 대체하지 않는다.

측정 cohort 마지막 도착/마지막 confirmed paid는 scenario 시작 기준: 2/s39.494–39.495초/39.535–39.540초, 10/s39.895초/39.932–39.940초, 25/s39.955초/39.993–40.019초였다. 최대 drain은69.999초지만 마지막 confirmed paid는40.019초 이내였다. pending/hold는 HTTP 여정이 실패로 끝난 뒤 남은 DB 상태이며 drain 중 완료됐다고 세지 않았다. 최종 SQL 후 소유 fixture를 정리했으므로 이 주문들의 장기 만료/회수는 이번 측정 결과가 아니다.

### API 지연: 성공과 실패

아래는 측정창의 non-replay(normal+retry), stage/business별 값이다. 건수는3회 모두(없는 그룹은0)를 포함한다. 실패 관측이 없는 반복의 지연은 정의하지 않으므로 `관측 반복`을 표시한다. flow/kind/status/error_code/API code별 세부 분모와 replay 지연은 index의 각 run `analysis.window.apiLatencyMs` 및 `analysis.all.responses`, 원본 raw에 남아 있다.

| 조건 | stage/business | 관측 반복 | 시도 수 | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|
| ample-2 | checkout/success | 3/3 | 60 [60–60] | 15.02 [14.39–15.06] | 23.23 [16.76–29.63] |
| ample-2 | reservation/success | 3/3 | 30 [30–30] | 14.00 [13.92–16.05] | 24.31 [14.41–40.81] |
| ample-2 | settlement/success | 3/3 | 60 [60–60] | 17.83 [17.50–19.30] | 24.69 [18.42–25.71] |
| ample-10 | checkout/success | 3/3 | 300 [300–300] | 15.06 [12.58–15.95] | 29.09 [20.27–35.78] |
| ample-10 | reservation/success | 3/3 | 150 [150–150] | 12.41 [11.59–14.38] | 20.98 [17.15–27.10] |
| ample-10 | settlement/failure | 1/3 | 0 [0–1] | 236.87 [236.87–236.87] | 236.87 [236.87–236.87] |
| ample-10 | settlement/success | 3/3 | 300 [300–300] | 15.23 [13.81–17.70] | 28.21 [25.37–29.06] |
| ample-25 | checkout/failure | 3/3 | 4 [1–5] | 123.69 [104.93–143.51] | 123.69 [105.69–146.98] |
| ample-25 | checkout/success | 3/3 | 750 [750–750] | 26.75 [21.45–32.20] | 59.37 [49.34–62.20] |
| ample-25 | reservation/success | 3/3 | 375 [375–375] | 16.28 [15.99–17.70] | 31.51 [30.57–35.71] |
| ample-25 | settlement/failure | 3/3 | 6 [3–11] | 129.83 [103.99–154.18] | 137.04 [104.03–157.92] |
| ample-25 | settlement/success | 3/3 | 750 [748–751] | 43.67 [37.61–47.66] | 107.01 [103.69–114.59] |
| limited-10 | checkout/failure | 3/3 | 135 [135–135] | 13.26 [12.99–13.85] | 20.15 [18.51–25.37] |
| limited-10 | checkout/success | 3/3 | 30 [30–30] | 15.66 [14.78–37.58] | 41.03 [29.74–75.92] |
| limited-10 | reservation/failure | 3/3 | 135 [135–135] | 8.09 [7.60–9.89] | 14.94 [12.84–35.15] |
| limited-10 | reservation/success | 3/3 | 15 [15–15] | 16.42 [13.75–19.14] | 19.14 [16.85–27.09] |
| limited-10 | settlement/success | 3/3 | 30 [30–30] | 19.46 [14.36–25.69] | 24.76 [21.72–35.14] |

ample의 실패 응답은500/INTERNAL_ERROR였으며, 제한 재고 실패는409/INSUFFICIENT_INVENTORY였다. 정식 실행에서401/403/429·전송오류·기타409는 구매 시도에 없었다(negative 인증 검사는 별도).

### 관측된 압력과 진단 한계

25/s 측정창의 transaction retry 예정 로그는77/133/126회로 늘었다. pool waiting 표본은 모든 정식 run에서0이었고 lock waiter 최대는0/2/1이었다. `transactionid`와 `tuple` 대기 표본은 hot-event 쓰기 충돌의 단서지만 DB 단독 병목이나 포화의 증거는 아니다.

25/s의 run별 app CPU 중앙값은34.71–38.40%, PG는17.67–22.07%였다. Redis observer PING p99는3.61–4.47ms였다. 이는 각 컨테이너 제한(앱/PG 각1CPU)의 Docker 표본과 외부 PING이며 앱 Redis 명령 지연이 아니다. 최대 실제 active VU, host CPU/여유 메모리, 엔진 누적 CPU·RSS, 각 관측 경계/간격/오류는 index와 원본에 있다. 자원 수집은 약3초 간격의 순차 조회이고 각 구간은 종료 경계와 겹칠 수 있어 순간 인과관계를 확정하지 않는다.

실제 쓰기 경로를 수정하지 않았다. checkout의 SERIALIZABLE 재시도·event row lock·멱등 키 경합, reservation의 event row lock, settlement의 order/callback 처리와 info 로그 비용이 함께 포함된다. 정식 범위에서는 pool 고갈·CPU 포화가 확인되지 않았다. 더 높은 부하에서의 포화점, 장시간 지속성, 다중 인스턴스, WAN/브라우저, 실제 네트워크 단절 및 운영 성능은 미검증이다.

### 수용 tuple·원본과 제외 범위

- 측정 revision: `flash-sale-v2.3`; ample SHA `076140a73d74fe82f7428cb5fe3f4a4b33b7876c`, limited SHA `ef6ea93dd9de8884b8d0652bf3bad912d4b6dd45`.
- 분석 revision: `flash-sale-analysis-v2.3.1`; SHA `ef6ea93dd9de8884b8d0652bf3bad912d4b6dd45`; canonical source hash `32829cef78eb04e3ce555fa463005aff4acb4cb88944c37c9f74ad9171708d84`.
- accepted IDs: `p2-v23-ample-r2-01..03`, `p2-v23-ample-r10-01..03`, `p2-v23-ample-r25-01..03`, `p2-v23-limited-01..03`.
- 두 측정 SHA 사이의 diff는 분석기·경계 regression·문서뿐이다. 실행 하네스/부하 스크립트/Compose/Dockerfile/lockfile/앱 계측의 canonical hashes는 동일하다. 모든 원본 manifest는 clean source 상태였다. 분석을 전체12회에 같은 revision으로 적용했다.
- [원본 인덱스](../load-test/results/flash-sale-baseline/index.json)에 SHA별 source hashes, 원본 분류, 수정 분석, 반복 통계가 있다. [ZIP SHA256](../load-test/results/flash-sale-baseline/archives.sha256)과23개 ZIP(총16.38MiB,529파일/506개 artifact hash 검증)을 함께 전달한다. JWT·private-key·credential-URL 패턴 검사에서 검출0이었다. 합성 UUID와 진단 로그는 보존했다.
- v2 preflight3개, v2 pilot4개, v2.1 selection pilot3개, v2.2 formal 중단1개는 정식 통계에서 제외했다. script 예외·launcher 관측·CPU 증가 판정의 한계와 실패 SQL을 그대로 보존했다. v2의50/s pilot은312 dropped/max lag6173ms/100VU 한계 때문에 유효한50/s 서비스 부하가 아니다.
- `p2-v23-ample-r25-03`의 원본 `invalid-measurement` 판정도 ZIP에서 유지한다. 종료 경계 수집 race를 위에서 공개한 사후 분석 수정으로만 보정했다. 이 보정은 통계 임계값 변경이 아니다.

### #12 / #17 인계

P3은 이 tuple과 환경에서2·10·25 offered arrivals/s가 사전 안정 기준을 만족했다는 제한된 근거를 소비한다. 25/s의 실제500·pending/hold와 미관측 포화점을 함께 소비해야 한다. 입장 제어의 실험 목적은 더 큰 burst에서 쓰기 재시도/오류를 줄이면서 전체 대기·포기 비용을 비교하는 것이다. 현재 결과만으로 큐 도입이나 효과를 정당화하지 않는다. R/C/TTL은 아직 미확정이며 paid/s·실제 active VU·preallocated100VU를 서로 같은 용량으로 환산하지 않는다. 10–25/s는 후속 실험 후보 범위일 뿐 운영 권고값이 아니다.

P8은 이 A 조건과 원본을 부분 입력으로 소비하되 P3/P6/P7 산출물이 없어 blocked다. B/C와 비교하려면 같은 사용자/혼합/재고/think/retry/replay/auth/limiter/로그/pool/자원/30초 창/3회 반복·발생기 조건을 맞춘다. 쓰기 경로·계측·환경이 바뀌면 A도 다시 측정한다. 새 VU/고부하 조건은 먼저 프로토콜을 고정해야 하며 기존50/s 무효 run을 포화점으로 재사용하지 않는다. #13–16/#18은 수용한 결과가 없어 blocked 유지, 재오픈할 완료 결과는 없다. v1 smoke 및 제외된 v2 pilot을 용량으로 읽는 해석은 stale다.

### 검증·최종 리뷰

측정과 겹치지 않게 새 전용 PostgreSQL/Redis에서 실행했다. production image의 빈 DB migration001–011/재실행/readiness/서명 GraphQL 검사 통과, 하네스19/19, callback harness 통과, unit21 suites/159 tests, integration24 suites/250 tests(파괴적 opt-in15개 포함, skipped0), build/typecheck 통과, lint0errors/기존9warnings였다. 실제 명령·시간·종료코드와 원본 로그는 `validation.zip`의 `results.json` 및 각 검사 파일에 있다.

새 테스트 자원은 owner label과 정확한 ID로 정리했고 cleanupErrors는0이다. 기존 중지된 Redis는 원래 ID/이름/중지 상태로 복원했다. 검증 스크립트의 실패 중 정리/복원 누락과 실패 없는 반복의0건 통계 누락은 읽기 전용 검토 후 main이 수정했다. 단위·통합 검증을 mock 기반 하네스 경계 검사와 혼동하지 않으며, 실제 HTTP/PG/Redis 부하 증거는 별도23개 run ZIP이다.

main의 전체 branch diff 검토 후, 별도 fresh-context Astra 최종 reviewer는 `8f645395..d41f45312877984eb2dcd050c6a95c174f1a6201`에 **No findings**를 반환했다. 36개 변경 파일 전체(코드4·문서3·ZIP24·해시2·JSON3), skipped0; OCR preview에서 제외되거나 빠진 형식도 포함했다. reviewer가23개 run/506 artifact hashes·검증 ZIP·정식12회 raw-point 재계산·source provenance·12개 이미지 metadata를 독립 확인하고 하네스19/19 및 whitespace 검사를 재실행했다. 전체 integration/build는 앞서 보존한 실행 증거를 검토했으며 별도로 재실행하지 않았다.

완료 시 fetch한 origin/main은 여전히 `8f645395bc54c86049a8137b1c0887c4590a2723`이고 PR19는 head `09b94fe11b4557097cf0c65ca7969def02c9b414`가 해당 SHA로 merged인 것을 다시 확인했다. P1 입력 valid를 유지한다. [PR #20](https://github.com/dosacha/PeakPass/pull/20)은 검토용 draft이며 병합하지 않았다. #9/#11은 이 P2 tuple을 valid로, #12는 이를 소비하는 ready로, #17은 A 부분 수용/blocked로 인계한다. 실험·분석 수정의 이력과 제외 사유는 위 기록을 보존한다.

최종 전달 바이트 검사에서 main이 JSON 인덱스3개의 Git LF 정규화와 로컬 CRLF 바이트 해시 불일치를 재현했다(원본 ZIP은 일치). `.gitattributes`로 이 증거 디렉터리의 JSON만 `-text`로 고정해 원본 바이트를 보존한다. JSON 내용·측정·분석은 그대로이며, Git blob과 로컬 파일의 SHA256 및 supplemental 해시를 다시 대조했다. 이는 실행 후 아카이브 전달 형식 수정이라 부하를 재실행하지 않는다.

동일 최종 reviewer가 `a769fbc..6334b6100006e3a40fc1a828dbb23b8ef1a75e45`의 전달 수정5파일을 추가 검토하고 **No findings**를 반환했다. JSON3개의 의미·정규화 내용 동일성, Git blob/로컬/supplemental SHA256, 전체 ZIP Git blob 해시, `core.autocrlf=true/false/input`의 checkout-filter 바이트 보존, 전체 branch whitespace를 확인했다. 실제 별도 checkout이나 부하·Docker 실행은 추가하지 않았다. 최종 변경 범위는 기존36파일에 `.gitattributes`를 더한37파일이다.

## 오토리뷰 수정·재측정 사전 고정 — v2.4

오토리뷰4151324845/4151324854/4151324857을 main과 읽기 전용3개 agent가 재현했다. (1) started와 terminal/iterations를 buyer별 대조해 finish 이전·paid 후 replay 중단을 모두 invalid로 만든다. (2) 모든 주문에 buyer checkout key와 일치하는 pending/null-provider 결제 audit가 정확히1개인지 integrity gate에서 검사한다. (3) pending checkout은 tickets 빈 배열, 정산 뒤 checkout replay는 paid 주문과 최초 정산의 유효 티켓 ID 집합(순서 무관)을 요구한다. settlement replay도 같은 티켓 집합을 대조한다. 기존 VM의 replay 응답도 실제 paid 계약으로 고친다.

기존12회의 raw에는 전체5340 starts와 terminal/iterations가 모두 대응하고, SQL4529주문에 pending audit4529개가 주문 키와 일치했다. 이는 저장 원본의 보강 검사이며 원래 비공개 buyer key를 독립 재취득한 검사가 아니다. HTTP 응답 배열은 소급 확인할 수 없으므로 새 정식 전체 행렬을 실행한다. 앱·DB·Compose·로그·자원·사용자 혼합·재고·think/retry/replay·통계 임계값은 변경하지 않는다.

실행 전 확정: 하네스 `flash-sale-v2.4`, 분석 `flash-sale-analysis-v2.4`. 깨끗한 커밋 후 기존 preflight12명/2s^-1의 ample 및 limited6석 각1회(정식 제외), 이후 ample **2/10/25;25/10/2;2/10/25**, 조건당3회. IDs `p2-v24-ample-r<rate>-01..03`; limited10/s·300명·60석3회 `p2-v24-limited-01..03`. ample10s warmup+30s 측정, limited0s warmup+30s 측정, 최대drain30s, pre/max100VU, 250ms DB/pool 표본과 1000000/60s limiter 등 기존 고정값을 사용한다.50/s 이상 또는 VU 증가는 없다.

분모·반복·중단·stable 기준은 기존 사전 규칙 그대로다. invalid/integrity 또는 ample nonpaid>=20%/paid p99>5s 발생 시 중단하고 원본을 보존한 채 원인을 검토한다. 자동 재시도로 불리한 run을 대체하지 않는다. 구현 오류로 revision을 바꾸면 이력과 후행 gate를 먼저 갱신한다. 테스트/build와 측정은 겹치지 않는다. 새 원본은 별도 `flash-sale-baseline-v24/`에 보존하여 v2.3 ZIP과 인덱스 바이트를 유지한다.

v2.4 preflight 변경 기록(정식 실행 전): `p2-v24-preflight-ample-01`은12 complete/0 interrupted, paid12·모든 새 계약 검사·SQL·cleanup 통과이나6초 창에서 실제 engine 표본1개뿐이라 `generatorObserved=false`로 invalid였다. 첫 자원 조회는 k6 시작 전, 마지막은 종료 경계에 걸렸고 중간 실제 엔진은1회였다. 이 원본/판정을 보존하고 계획된 limited-01은 실행하지 않았다. 관측 기준을 완화하지 않고 **preflight만24명/2s^-1=12초,10/20VU**, ample 및 limited6석을 각각 `p2-v24-preflight-{ample,limited}-02`로 실행한다. 같은 코드 revision이며 정식40/30초 창·행렬·분모·중단 기준은 변경하지 않는다.

## v2.4 실행 결과 — 메모리 gate 중단, 수용 미완료

구현 `ddb5c97f1f0f61c36a6fd2c902440196bb222a64`, 정식 측정 SHA `0d835a8eb0efbf509004aea1394b3e41434fd64f`(차이는 위 preflight 문서뿐), 분석 `flash-sale-analysis-v2.4` / `ddb5c97f1f0f61c36a6fd2c902440196bb222a64`. 모든 실행은 clean source였다. 이후 실제12초 preflight는 ample24/24 paid, limited24명 중3 paid/6tickets/21품절 거절로 새 응답·SQL·관측 검사를 통과했다.

정식 순서2/10/25/25/10/2 중6번째 `p2-v24-ample-r2-02`에서 host free memory가 측정창 내 약0.56–0.94GB였다.1GiB 미만이3개 연속 표본인 기존 `host-pressure` 기준으로 invalid 판정되어 즉시 중단했다. CPU는 해당 창에서 약2.5–15.4%라 이번 중단 원인은 CPU 포화가 아니다.80명 모두 결제됐지만 용량 수용에서 제외한다. 중단 후에도 가용 메모리가 약0.95–1.00GB였으며 다른 작업의 앱/컨테이너를 종료하거나 임계값을 완화하지 않았다.

| 정식 실행 (`p2-v24-` 생략) | 판정 | cohort paid/예정 | 창 paid/30초 | 실패/non-replay 시도 | 전체 SQL paid | hold좌석 | strict smoke |
|---|---|---:|---:|---:|---:|---:|---|
| ample-r2-01 | valid-stable | 60/60 | 60/30 | 0/150 | 80 | 0 | true |
| ample-r10-01 | valid-stable | 300/300 | 300/30 | 0/750 | 400 | 0 | true |
| ample-r25-01 | valid-stable | 749/750 | 749/30 | 4/1877 | 999 | 2 | false |
| ample-r25-02 | valid-stable | 750/750 | 750/30 | 2/1877 | 1000 | 0 | true |
| ample-r10-02 | valid-stable | 300/300 | 300/30 | 0/750 | 400 | 0 | true |
| ample-r2-02 | invalid: host-pressure | 60/60 | 수용 제외 | 0/150 | 80 | 0 | true |

이 표는 개별 관측이며 조건별3회 완료 결과가 아니다. 유효 정식 관측은2/s1회·10/s2회·25/s2회, 정식 limited0회다. **accepted run IDs는 빈 배열이며 새 P2 tuple은 없다.** 미완료 반복의 중앙값·범위를 정식 결과로 발표하지 않는다.25/s 첫 실행의 실패 여정과2 held seats를 숨기지 않으며, 두 번째의재시도 오류2건도 모두 성공으로 요약하지 않는다. 이전v2.3 결과를 부족한 반복 대신 넣지 않는다.

[새 인덱스](../load-test/results/flash-sale-baseline-v24/index.json)와 [ZIP 해시](../load-test/results/flash-sale-baseline-v24/archives.sha256)에9개 실행(정식 시도6, preflight3),207개 파일/198개 artifact 해시를 보존했다.6초 발생기 관측 부족과 정식 호스트 메모리 부족 원본도 포함한다. 기존23개 ZIP/인덱스 바이트는 유지한다.9개 앱 이미지의 소유권 라벨을 제외한 runtime hash는 서로 같으며 이전v2.3 앱과도 동일하다. 이는 코드 동등성이지 성능 개선 증거가 아니다.

오토리뷰3건의 regression은 수정 전3개 실패를 재현했고, 추가 paid→expired replay도 RED/GREEN 확인했다. 수정 후 하네스23/23, unit159, integration250(skipped0, destructive opt-in15 포함), production-image/callback 검사, build/typecheck 통과. lint0errors/기존9warnings. 새 validation.zip에는 실행 로그·회귀 RED·검증한4개 하네스 코드의 canonical hash가 있다. 전체 검사는 측정 전에 끝났고 테스트한 작업 파일이 커밋된 코드와 같음을 해시로 확인했다. 전용 테스트 자원 cleanupErrors0, 기존 Redis의 ID/이름/중지 상태 복원. 부하9회도 cleanup/teardown 오류가 없다.

일반 reviewer와 별도 최종 reviewer의 수정 코드·문서 검토는 No findings였다. 실제원본/최종 diff의 검토 결과는 PR20에 기록한다. 이전 No findings 뒤 오토리뷰가 발견한 검증 공백도 이력에 남긴다. 구현 커밋의 GitHub CI도 통과했다.

최종 재확인한 origin/main은8f645395, PR19는09b94fe head가 해당 main으로 merged 상태다. P1의 제한된 저부하 수용은 valid 유지한다. #9/#11은 v2.4 재검증 대기, #12/#17 consumed v2.3은 stale/blocked 유지다. 메모리 여유를 확보한 뒤 재개 범위·순서·IDs를 실행 전에 다시 기록하고 부족한 정식 반복을 완료해야 한다. 호스트 메모리 조건을 바꾸면 그 차이를 남긴다. 최대 처리량·운영 성능·대기열 필요성/효과·R/C/TTL은 미입증/미확정이다. 병합하지 않는다.

별도 최종 reviewer가 이 중단 시점의22파일 delta와9개 실행의207파일/198 artifact hashes, validation hashes 및 staged Git 바이트를 확인하고 No findings를 보고했다.9회 오프라인 재분석은 저장 index와 일치했고23개 하네스 검사도 독립 통과했다. 기존v2.3 원본 불변과9개 이미지 metadata도 확인했다. 이는 코드·중단 기록의 검토이며 P2 전체 행렬을 수용했다는 뜻이 아니다.

### 메모리 확보 후 v2.4 재개 계획 — 미실행, 아래 v2.5 계획으로 대체

사용자는 메모리를 확보한 뒤 재측정을 계속하도록 선택했다. 기존 분석 유효성 기준과 조건은 그대로 두고, 재개 전 각 실행의 안전 여유로 호스트 가용 메모리2GiB 이상을5초 간격3회 확인한다. 이는 provisioning 전 점검이며 측정창의1GiB/연속3표본 invalid 기준을 완화하지 않는다. 다른 작업의 앱·컨테이너는 임의로 종료하지 않는다.

첫5개 유효 관측은 그대로 보존한다. 사전 host-pressure 기준으로 무효인 `p2-v24-ample-r2-02`는 수용하지 않고 원본 그대로 둔다. 재개 순서는 **`p2-v24-ample-r2-02r`, `p2-v24-ample-r2-03`, `p2-v24-ample-r10-03`, `p2-v24-ample-r25-03`, `p2-v24-limited-01..03`**의7회다. 무효 슬롯을 별도ID로 다시 측정한 이력을 숨기지 않으며 새 invalid/integrity/중단 조건이면 다시 중단한다. 코드·시간창·분모·자원·100VU·재고·실험 임계값은 바꾸지 않는다. 조건별3개 유효 반복이 모두 끝나기 전 새 P2 tuple을 만들지 않는다.

## v2.5 응답 계약·전체 재측정 계획 — 실행 전 고정

PR20 `e6bc7ed`의 오토리뷰4151721322를 읽기 전용3개 agent와 main이 실제 요청 경로·기존 테스트로 검토했다. `payments.ts`는 최초 `duplicate:false` 결과를 캐시에 저장하고, middleware는 동일 key/body replay에 그 응답을 그대로 반환한다. `route-contract.test.ts` T06과 `order-expiration-http.test.ts`도 cached false/uncached true를 명시한다. 따라서 bot의 replay `duplicate===true` 제안은 채택하지 않는다. 확인된 공백인 **boolean 필드 누락/잘못된 타입**만 공통 paid 검사와 expired ACK 예외에서 거절한다. 앱 계약·실행 경로는 바꾸지 않는다.

하네스 `flash-sale-v2.5`, 분석 `flash-sale-analysis-v2.5`. VM의 정상 응답에 cached false를 반영하며 normal/retry/replay 각각의 누락/null/문자열/숫자 거절 및 false/true 허용을 검사한다. retry는 실제 첫503 뒤 재시도로 진입시킨다. expired ACK는 boolean이어도 구매 미완료이며 paid replay의 expired는 계속 protocol failure다. 기존 티켓 오류 fixture에도 boolean을 넣어 별도 티켓 검증이 실제로 실행되게 한다.

원본 응답 본문이 없는 v2.3/v2.4를 새 계약의 증거로 소급 승인하지 않는다. 기존23개/9개 run ZIP·인덱스·해시는 변경하지 않으며 v2.4의5개 유효 정식 관측도 새 반복으로 대체 계산하지 않는다. 새 산출물 위치는 `load-test/results/flash-sale-baseline-v25/`다. 현재 새 accepted tuple/IDs는 없다. #12의 consumed v2.3 및 #17의 A v2.3은 stale/blocked 유지, v2.4는 미수용 후보 이력이다.

깨끗한 커밋 후 preflight는 **24명/2s^-1=12초, warmup0/drain30, 10/20VU**의 ample과 limited6석 각1회(`p2-v25-preflight-ample-01`, `p2-v25-preflight-limited-01`), 정식에서 제외한다. 정식 ample은 **2/10/25;25/10/2;2/10/25** 순서의9회(`p2-v25-ample-r<rate>-01..03`), 이후 limited10/s·300명·60석3회(`p2-v25-limited-01..03`)다. ample10초 warmup+30초 측정, limited0+30초 측정, drain최대30초, pre/max100VU 및 위 분모·자원·pool·로그·retry/replay·250ms표본·limiter·안정/중단 기준을 그대로 적용한다.50/s 이상·VU 증가·임계값 완화는 없다.

모든 preflight/정식 실행은 provisioning 전에 **호스트 가용 메모리2GiB 이상을5초 간격3회** 확인하고 시각/bytes를 남긴다. 미달이면 자원을 만들지 않는다. 측정창의1GiB 미만 연속3표본 중단 기준은 유지한다. 기존과 같이 invalid/integrity 또는 ample nonpaid>=20%/paid p99>5초면 중단·원본 보존한다. 테스트/build는 측정과 겹치지 않으며 다른 작업의 앱/컨테이너를 임의 종료하지 않는다. 전체 반복 완료·최종 검토 전 P2 valid/후행 ready를 선언하지 않는다.

### v2.5 검증 및 시작 점검 결과

구현 `2a6f69a910ca746411ef046f53077da80a9dd087`. 회귀는 수정 전22통과/2실패에서 수정 후24/24로 통과했다. 전용 PG/Redis에서 unit21 suites/159개, integration24 suites/250개(skipped0, destructive opt-in15 포함), production-image 빈 DB migration/재실행/readiness/서명 GraphQL, callback harness, build/typecheck를 실행해 모두 통과했다. lint0errors/기존9warnings, 검증9개 명령 모두 exit0, cleanupErrors0, 기존 중지된 Redis는 ID/이름/상태를 복원했다. 테스트한4개 하네스 코드의 canonical hash는 커밋 코드와 일치한다.

main의 branch diff 검토와 일반 reviewer 및 별도 최종 reviewer의6파일 delta 검토는 No findings였다. 실제 HTTP cached false 계약과 VM retry 분기를 확인했다. 기존v2.3/v2.4 증거44파일은 이전 커밋의 checkout 바이트와 같고 ZIP/JSON은 Git blob 바이트와도 같다. v2.4 원본을 현재 분석기로 읽으면 `checkoutProtocol` 부족으로 invalid가 되어 소급 수용을 차단한다.

2026-10-01 04:12:12/04:12:39 UTC 시작 점검은 각각2,067,136,512/2,081,751,040bytes(약1.93/1.94GiB)로2GiB에 미달했다. 따라서 **v2.5 HTTP 부하는 아직0회이며 preflight 자원도 생성하지 않았다**. 이 점검 실패는 서비스 부하 실패나 처리량 관측이 아니다. [v2.5 검증 기록](../load-test/results/flash-sale-baseline-v25/validation.json)·validation ZIP의21파일에 RED/GREEN·전체 검사·측정 실행 스크립트·시각/bytes를 보존했다. 새 accepted tuple/IDs는 없고 P2 및 #12/#17은 재검증 대기다.

동일 별도 최종 reviewer가 전달5파일까지 검토하고 No findings를 반환했다.21개 ZIP 항목·artifact/archive/supplemental 해시, staged JSON/ZIP 바이트, 구현 커밋의4개 코드 해시, 기존44파일 불변, 검증 메타데이터 및2개 메모리 점검값을 독립 확인했다. 실행/수용 IDs가 비어 있는 상태와 문서가 일치한다.


## v2.6 실행 전 계획 — 응답과 SQL identity 대조

PR20 c65a1b3의 오토리뷰4151818757/4151818761/4151818765/4151818770을 explorer·테스트 조사 agent·reviewer가 읽기 전용으로 조사한 뒤 main이 검증 공백4건을 재현했다. 신규 callback/provider인 최초 normal 정산은 duplicate:false, retry/replay는 boolean 양쪽을 허용한다. paid 응답의 tier와 fixture를 대조하고 paid SQL 정산 fact의 reconciliation_required는 false, expired fact는 true를 요구한다. 기존 buyers_completed에 첫 정산의 order_id와 정렬된 ticket_ids JSON을 기록해 fixture buyer와 SQL paid 주문·티켓 집합을 정확히 대조한다. 누락/비정상 identity 증거는 invalid, 관측된 SQL 불일치는 integrity-defect다. 앱·스키마·의존성은 바꾸지 않는다.

하네스 flash-sale-v2.6 / 분석 flash-sale-analysis-v2.6. 실행 source를 깨끗한 커밋으로 고정한다. **preflight24명/2s^-1=12초, warmup0/drain30,10/20VU**의 ample 및 limited6석 각1회(`p2-v26-preflight-{ample,limited}-01`) 뒤, 정식 ample **2/10/25;25/10/2;2/10/25**의9회(`p2-v26-ample-r<rate>-01..03`), limited10/s·300명·60석3회(`p2-v26-limited-01..03`)를 실행한다. ample warmup10초/측정30초, limited0/30초, 최대drain30초, 정식100/100VU, 자원·pool·로그·250ms표본·혼합·think/retry/replay·limiter·분모·반복·안정/중단 기준은 앞서 고정한 그대로다. 각 실행 전2GiB 이상5초 간격3표본, 창 내1GiB 미만 연속3표본 중단 기준도 유지한다. invalid/integrity 또는 ample nonpaid>=20%/paid p99>5초면 중단하고 실패 원본을 보존한다. 테스트/build와 측정은 겹치지 않는다.

새 raw/ZIP 위치는 flash-sale-baseline-v26이며 v2.3/v2.4 원본과 v2.5 검증 ZIP은 변경하지 않는다. 기존 raw에는 최초 반환 티켓 identity가 없어 새 계약으로 소급 수용하지 않는다. v2.5 계획은 부하 미실행 이력으로 남긴다. 새 전체 행렬과 검토 완료 전 accepted tuple/IDs는 없고 #12/#17은 stale/blocked다. 최초 확인한 메모리는 약4.99GiB였으며 실제 실행마다 다시 시작 조건을 확인한다.


## v2.6 실제 결과 — ample9회 완료, limited1회·전체 수용 미완료

실행 소스는 모두 `33a74de24cef2493bf4f8e473a695910fc404c42` / `flash-sale-v2.6`, 분석은 같은 SHA의 `flash-sale-analysis-v2.6`이며 clean source다. preflight2회와 정식10회를 완료했다. ample2·10·25/s는 각각3회 완료했지만 limited는1회뿐이다. **새 accepted tuple/IDs는 아직 없으며 #12/#17 consumed v2.3은 stale/blocked 유지**다. 실행한12회에는 invalid/integrity-defect가 없지만 strict smoke 실패3회는 그대로 보존했다.

아래 ample 값은3회 중앙값 [최소–최대]다. percentile을 합쳐 계산하지 않는다. 구매/s는30초 창 안 HTTP 완료와 SQL 주문·티켓 identity가 일치한 고유 구매/30초, cohort 완료율 분모는 예정 유입 전체, 요청 실패율은 창 안 non-replay429/5xx/전송실패 시도/전체 non-replay 시도다. latency는 성공자 조건부다.

| 조건 | 판정3회 | paid/s | cohort 완료율% | 요청 실패율% | paid p95 ms | paid p99 ms |
|---|---|---:|---:|---:|---:|---:|
| ample-2 | valid-stable, valid-stable, valid-stable | 2.00 [2.00–2.00] | 100.00 [100.00–100.00] | 0.00 [0.00–0.00] | 85.25 [84.20–93.55] | 113.41 [98.38–410.34] |
| ample-10 | valid-stable, valid-stable, valid-stable | 10.00 [10.00–10.00] | 100.00 [100.00–100.00] | 0.00 [0.00–0.13] | 91.05 [79.05–98.15] | 119.02 [116.05–129.06] |
| ample-25 | valid-overload, valid-overload, valid-stable | 24.60 [21.03–24.90] | 98.53 [83.73–99.73] | 2.67 [0.90–18.54] | 244.30 [116.30–489.05] | 455.50 [359.18–722.90] |

**이 환경에서2·10명/초는3회 모두 안정 기준을 만족했고,25명/초는 과부하2회·안정1회여서 안정 구간으로 수용할 수 없다.** 포화 경계의 정확한 위치나 최대 처리량을 찾은 결과가 아니다.25/s의 큰 반복 편차와 shared host 자원 변화를 원인 하나로 단정하지 않는다. 기존v2.3/v2.4와 숫자 차이를 개선·회귀 효과로 주장하지 않는다.

| 정식 Run (`p2-v26-` 생략) | 전체 시작 | cohort paid/예정 | 창 paid/30s | 실패/non-replay | SQL paid | pending | hold좌석 | strict smoke |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| ample-r2-01 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| ample-r10-01 | 400 | 300/300 | 300/30 | 0/750 | 400 | 0 | 0 | True |
| ample-r25-01 | 1000 | 739/750 | 738/30 | 51/1910 | 986 | 9 | 10 | False |
| ample-r25-02 | 1000 | 628/750 | 631/30 | 390/2104 | 688 | 165 | 196 | False |
| ample-r10-02 | 400 | 300/300 | 300/30 | 1/751 | 400 | 0 | 0 | True |
| ample-r2-02 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| ample-r2-03 | 80 | 60/60 | 60/30 | 0/150 | 80 | 0 | 0 | True |
| ample-r10-03 | 400 | 300/300 | 300/30 | 0/750 | 400 | 0 | 0 | True |
| ample-r25-03 | 1000 | 748/750 | 747/30 | 17/1889 | 943 | 45 | 16 | False |
| limited-01 | 300 | 30/300 | 30/30 | 0/345 | 30 | 0 | 0 | True |

25/s의 전체 미결제는14/312/57명이며, 이 중 warmup cohort의 미결제는3/190/55명이다. 마지막 실행은 측정창 안정 기준을 통과했어도 전체57명 미완료·pending45·hold16석이 남아 strict smoke는 실패했다. 이를 전체 구매 성공으로 요약하지 않는다. 창 paid와 cohort paid는 완료 시각 때문에 다르며 warmup spillover·창 이후 완료도 raw에 보존했다.

제한 재고는 **아직1회**다.300명 시작,30 paid/60tickets/270품절 거절, 잔여0·pending0·active hold0이며 strict smoke와 관측/정합성이 통과했다. 공급량 제한 결과인1 paid/s·10% 완료율은 ample 용량과 비교하지 않는다. `p2-v26-limited-02`, `p2-v26-limited-03`은 미실행이며 마지막 재확인도 provisioning 전 시작 조건에서 멈췄다.

| 25/s 반복 | 창 내부 transaction retry 예약 | 최대 pool waiting | 최대 lock waiter | app CPU 중앙값% | PG CPU 중앙값% | 창 host free 최소 GiB |
|---|---:|---:|---:|---:|---:|---:|
| 01 | 278 | 2 | 4 | 36.06 | 19.45 | 2.59 |
| 02 | 1224 | 10 | 7 | 59.90 | 34.55 | 1.16 |
| 03 | 101 | 0 | 1 | 34.33 | 17.25 | 1.90 |

창 내부25/s retry 코드 집계: {"p2-v26-ample-r25-01": {"40001": 278}, "p2-v26-ample-r25-02": {"40001": 1224}, "p2-v26-ample-r25-03": {"40001": 101}}. pool waiting·lock waiter와 transaction conflict/retry는 병목의 진단 단서다. 짧은 대기를 놓칠 수 있는 표본이며 DB 단독 포화·CPU 한계나 큐 도입 효과의 증명이 아니다.2/10/s의 최대 pool waiting과 lock waiter는 모두0이었다.

시작 메모리가2GiB 부근에서 변동해 정식7/8번째 및 limited 진입 전에 provisioning을 보류했다. 완료한 ID는 재실행하지 않고 원래 남은 순서를 유지했다. 남은 실행은30초 간격 최대10번 점검하되 매번2GiB 이상5초 간격3회를 요구했다. 마지막 limited02 점검10회가 실패해 중단했으며 측정창1GiB/연속3표본 및 모든 통계 임계값은 그대로다. 시작 점검 실패는 부하 실패나 서비스 용량 데이터가 아니다. 시각·bytes·대기 규칙은 검증 ZIP에 있다. 마지막2회도 같은 조건으로 완료해야 전체 수용을 판단할 수 있다.

검증은 RED6→GREEN26, unit159/integration250(skipped0, destructive opt-in15 포함), production-image/callback/build/typecheck 통과, lint0errors/기존9warnings다. 전체 검사는 부하 전에 종료했고 최종 하네스 재검사도 통과했다. 테스트 자원 정리·기존 Redis 복원 및 부하12회의 cleanup/teardown은 모두 확인했다.

[v2.6 인덱스](../load-test/results/flash-sale-baseline-v26/index.json)와 [ZIP 해시](../load-test/results/flash-sale-baseline-v26/archives.sha256)에12run ZIP,276파일/264 artifact hashes를 보존했다.12회 재분석은 저장 판정과 일치한다. 앱 이미지12개의 소유권 라벨을 제외한 runtime hash는 서로 및 이전v2.3과 동일하다. 기존47개 증거파일은 변경하지 않았다. 새 validation ZIP은25개 파일의 검사·RED/GREEN·코드 해시·시작 점검/실행 스크립트를 포함한다. 최초 반환 주문/티켓 identity의 누락·SQL 불일치는 실행12회 모두0이었다.

별도 최종 reviewer는 최종20개 staged 파일에 No findings를 반환했다.12run/276파일/264artifact hashes,9개 source hashes,12회 동일 재분석,4,114건의 HTTP paid 주문·티켓 ID와 SQL,12개 실제 이미지 metadata,25개 검증 ZIP 항목 및 기존47파일 불변·staged 바이트를 독립 확인했다. 보고서의 반복 통계·warmup 실패·40001 retry 수와 각 실제 실행의2GiB/5초간격3표본도 대조했다. 마지막 limited02의10차례 시작 점검 실패 및 limited02/03 미생성, accepted 빈 배열·matrix 미완료 상태를 확인했다. 이 검토는 전체 행렬을 수용했다는 뜻이 아니다.


## 2026-10-02 auto-review corrections and fixed continuation

Auto-review 4152079182/4152079191/4152079195 was independently checked by the read-only explorer, test investigator and reviewer; main implemented the fixes. Analysis `flash-sale-analysis-v2.6.1` requires `workingTree === ''` and exactly one canonical buyer tag `"0"` through `String(settings.users-1)` in both start and terminal evidence. Missing/null/dirty source metadata and substituted, fractional, missing or noncanonical buyer tags invalidate observations. The runner preserves strict `passed`/`smokePassed` through both analysis-invalid and analysis-exception paths while retaining `analysisError` and nonzero process exit. The extracted finalization block is exercised against actual synthetic evidence files; this is a boundary test, not load evidence.

These changes occur in offline analysis and post-load result finalization. The k6 script, HTTP contract, app, schema, collector, fixture generation, resource limits, windows, denominators and performance thresholds are unchanged. Keep measurement revision `flash-sale-v2.6`; record the new analysis revision/SHA and the two remaining runs' runner SHA separately. Reanalyze all existing12 original archives with byte/hash verification and retain old analysis/manifest/index/ZIP unchanged. Existing valid observations may be retained only if the new gates and original checks pass; no missing HTTP evidence is inferred for older revisions.

Before execution, fix continuation to the previously unexecuted `p2-v26-limited-02`, then `p2-v26-limited-03`: each10 buyers/s,300users,60seats,quantity2,0warmup/30smeasurement/max30sdrain,100pre/maxVUs,50:50 flow,20ms think,1retry after100ms,replay every3; app1CPU/512MiB,PG1CPU/512MiB,Redis0.5CPU/256MiB,pool2–10,info log,250ms observer,limiter1000000/60s. Start only after free memory>=2GiB on3 samples5s apart, at most10 attempts30s apart. Preserve the runtime stop criteria: invalid/integrity failure or3 consecutive resource samples hostCPU>=90% orfree<1GiB; the ample nonpaid>=20%/paidp99>5s rule remains unchanged. Never rerun completed IDs. No tests/build overlap load. Cross-day/shared-host variability will be disclosed; stable25/s or maximum capacity must not be claimed from the existing2overload/1stable ample observations.

Before resumption: RED26pass/3fail -> GREEN29, unit159/159, integration240pass/10skipped, production-image/callback/build/typecheck passed; lint0errors and9preexisting warnings. Windows now reservesTCP63532–63631, so the first dedicated Redis provisioning failed before tests; resources were cleaned and the exact stopped preexisting Redis restored. Dynamic-loopback retry retained the fixed-port destructive test guards and disabled their10cases. A PowerShell5 warning-handling interruption is also preserved; PowerShell7 completed all available tests. The earlier v2.6 250/250 result remains historical and is not claimed as a fresh250-case pass. Both normal reviewer and separate final source/plan reviewer reported No findings. All12 existing v2.6 archives passed reanalysis with unchanged metrics/classifications; their source/HTTP data were not changed. Existing65 evidence Git blobs are preserved (7checksum text files differ from working-tree bytes only by CRLF).
