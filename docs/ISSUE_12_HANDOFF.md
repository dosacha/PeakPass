# P3 / Issue #12 새 세션 인수인계

2026-10-10 추가: P3는 PR #22로 병합됐고(main `c2fd058`, 2026-10-02) 확정 계약은 [ADMISSION_CONTRACT.md](ADMISSION_CONTRACT.md)의 `admission-v1`이다. 아래의 '현재'·'아직'은 2026-10-02 착수 전 기준의 기록이다.

작성 기준: 2026-10-02 KST. 대상은 [P3 #12: 대기열·입장권·용량·실패 정책 계약](https://github.com/dosacha/PeakPass/issues/12)이다. **이 문서는 착수 기준이며 admission 설계의 확정 계약이 아니다.** 이번 작업에서는 P3 제품 코드·DB migration·부하 실험·`ADMISSION_CONTRACT.md`를 만들지 않았다.

## 1. 새 세션이 가장 먼저 할 일

필요한 읽기 전용 확인을 한 뒤, **“Issue #12를 어떻게 설계할 것인가”를 사용자에게 먼저 설명한다.** 첫 실질 산출물은 설계 설명이며, 곧바로 코드를 구현하거나 수치를 확정하는 것이 아니다. 설명 전에 explorer·기존 테스트 조사·reviewer를 읽기 전용으로 병렬 조사시키고 main이 근거와 선택지를 종합한다. 구현을 agent에게 분배하지 않는다.

첫 설명은 다음 순서로 작성한다.

1. **인수 판정:** 최신 main에 수용 P2 코드·원본이 포함되는지, 총괄 #9의 현재 gate가 무엇인지, 이전 기록과 달라진 사실이 있는지.
2. **목표와 근거의 한계:** 대기열이 해결하려는 신규 좌석 점유 폭주 문제, P2에서 관측한 사실, 아직 입증하지 않은 최대 처리량·대기열 효과.
3. **전체 흐름과 권한:** 대기 등록 → 승격 → 신규 예약 또는 직접 checkout → 기존 구매 진행. Redis가 관리할 입장 상태와 PostgreSQL이 보장할 재고·소비 기록의 경계.
4. **설계 선택지와 추천 이유:** 상태 전이·API·멱등성·DB 결박·장애 복구·polling의 최소 대안과 trade-off. 실제 코드 경로와 연결하고 확정/제안/미결정을 구분한다.
5. **수치 결정 방법:** R, C, TTL, scheduler, polling을 각각 정의하고, 측정 근거와 검증할 실험 가정을 구분한다. 필요한 추가 측정과 사전 고정 조건도 설명한다.
6. **검증과 인계:** 실패·재시도 검증표, P4~P8 책임 경계, 구현 순서와 최소 파일 지도, 계약 revision 변경 시 후행 영향을 제시한다.

이 설명을 계약 확정·P3 완료 보고로 대신하지 않는다. 이후 계약 작성과 실행 범위는 새 세션의 사용자 지시에 맞춘다. 결정을 위해 꼭 필요한 질문만 묻고, 이미 확인한 사실이나 승인된 범위를 다시 묻지 않는다.

새 세션 시작 문구:

```text
PeakPass [P3] Issue #12를 시작한다. docs/ISSUE_12_HANDOFF.md를 먼저 읽고,
최신 #9/#10/#11/#12 및 PR #19/#20, 후행 #13~#18과 실제 코드·수용 tuple을 확인하라.
explorer·테스트 조사 agent·reviewer는 읽기 전용으로 조사하고 main이 종합하라.
첫 실질 응답은 P3를 어떻게 설계할지 설명하는 것이다. 설명 전에 구현하거나
ADMISSION_CONTRACT를 확정하지 마라. 상태/API/DB-Redis 경계/소비·재시도/장애/
R·C·TTL/polling/검증·후행 계획을 근거와 미결정 사항을 구분해 설명하라.
P2 수치를 최대 처리량이나 확정 admission 설정값으로 바꾸지 마라.
```

## 2. 현재 사실과 착수 gate

다음은 작성 시점 스냅샷이다. 다음 세션은 GitHub와 실제 checkout을 다시 조회한다.

| 항목 | 확인한 상태 |
| --- | --- |
| 원격 main / PR #20 merge | `c1d88bd9872d5c1c3dfe44f03a5f1b6e59bb619d` |
| PR #20 마지막 head | `891363fd44e38abb750c5212a984917d6844de26` |
| 최종 오토리뷰 / CI | 해당 head 리뷰 완료, bot 👍 2026-10-02 11:12:27 KST; CI [36954169773](https://github.com/dosacha/PeakPass/actions/runs/36954169773) 성공 |
| PR #20 병합 | 사용자가 2026-10-02 11:14:08 KST에 병합. merge tree와 위 head의 파일 차이 없음 |
| P1 #10 | CLOSED. 저부하 하네스 정합성 증거로 valid |
| P2 #11 | Issue는 OPEN이나 총괄의 정식 12회 tuple은 valid. Issue Closed 여부로 판정하지 않음 |
| P3 #12 | 새 P2 tuple을 소비하는 ready. 계약 설계·확정은 아직 미수행 |
| P4~P7 #13~#16 / P9 #18 | 수용된 후행 산출물이 없어 blocked |
| P8 #17 | P2 A 입력만 valid. P3/P6/P7 결과가 없어 전체는 blocked |
| `docs/ADMISSION_CONTRACT.md` | 아직 없음. P3의 최종 산출물 |

P2 보고서와 Issue의 “PR을 병합하지 않았다”는 문장은 **증거 발행 당시 기록**이다. 현재 병합 사실은 위 스냅샷과 새 세션의 실시간 확인이 우선한다. 병합은 측정 SHA나 수치를 바꾸지 않는다. 과거 v2.3 accepted 또는 v2.6 미완료 gate를 현재 gate로 읽지 않는다.

착수 전에 `git status`, branch/HEAD, `origin/main`, 적용되는 `AGENTS.md`, 최신 Issue 본문·댓글을 확인한다. merge 조상 관계가 없으면 squash 가능성을 고려해 실제 변경 내용·canonical source hash를 비교한다. 최신 main의 무관한 변경은 근거를 남기고 valid를 유지할 수 있으며 전체 부하를 무조건 재실행하지 않는다.

이번 문서 작업은 기존 격리 worktree `C:\Users\dosac\.codex\worktrees\peakpass-issue11-baseline\PeakPass`의 `codex/issue-12-handoff`에서 main을 기준으로 시작했다. 이것은 새 세션의 checkout을 보장하지 않는다. 원래 `C:\Users\dosac\projects\PeakPass`의 로컬 main이나 다른 작업의 미추적 파일을 reset/clean하지 않는다. 미병합 인계 문서는 해당 원격 branch에서 읽고, P3 작업은 수용 코드가 포함된 최신 main 또는 검증한 branch에서 분리한다. 기존 작업공간을 재사용할 수 있으면 불필요한 worktree를 추가하지 않는다.

읽기 전용 확인 예시:

```powershell
git status --short --branch
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git merge-base --is-ancestor 891363fd44e38abb750c5212a984917d6844de26 origin/main
gh pr view 20 --json state,headRefOid,mergeCommit,mergedAt,statusCheckRollup
gh issue view 9 --comments
gh issue view 12 --comments
```

## 3. 읽을 순서와 수용 tuple

1. 이 문서, [총괄 #9](https://github.com/dosacha/PeakPass/issues/9), [P3 #12](https://github.com/dosacha/PeakPass/issues/12)의 최신 본문·댓글·dependency gate.
2. [FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md)의 **현재 gate와 마지막 v2.6.1 결과**, [FLASH_SALE_EVIDENCE.md](FLASH_SALE_EVIDENCE.md)의 지표·유효성 계약.
3. [현재 수용 인덱스](../load-test/results/flash-sale-baseline-v261/index.json), 같은 폴더의 `validation.json`, `image-equivalence.json`, checksum 목록. ZIP은 인덱스의 상대 경로를 따라 읽는다.
4. [P1 검증](ISSUE_10_VALIDATION.md), [이전 P2 인계](ISSUE_11_HANDOFF.md). 이 둘의 옛 PR/상태 스냅샷은 현재 상태가 아니다.
5. 아래 코드 지도와 [P4 #13](https://github.com/dosacha/PeakPass/issues/13), [P5 #14](https://github.com/dosacha/PeakPass/issues/14), [P6 #15](https://github.com/dosacha/PeakPass/issues/15), [P7 #16](https://github.com/dosacha/PeakPass/issues/16), [P8 #17](https://github.com/dosacha/PeakPass/issues/17), [P9 #18](https://github.com/dosacha/PeakPass/issues/18).

수용 tuple은 다음을 한 묶음으로 소비한다.

| 요소 | 값 |
| --- | --- |
| 측정 revision | `flash-sale-v2.6` |
| 기존 ample 9 + limited 1 + preflight 2 측정 SHA | `33a74de24cef2493bf4f8e473a695910fc404c42` |
| limited 02/03 측정 SHA | `598ad50bc389b47bcbcfc0175359735671718fe1` |
| 공통 분석 revision / SHA | `flash-sale-analysis-v2.6.1` / `598ad50bc389b47bcbcfc0175359735671718fe1` |
| 수용 인덱스 발행 SHA | `891363fd44e38abb750c5212a984917d6844de26` |
| 인덱스 SHA256 | `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6` |
| 정식 accepted IDs | `p2-v26-ample-r2-01..03`, `p2-v26-ample-r10-01..03`, `p2-v26-ample-r25-01..03`, `p2-v26-limited-01..03` |
| 제외 | preflight 2회, 이전 revision의 pilot/실패/미완료 실행은 정식 반복을 대신하지 못함 |

`flash-sale-baseline-v261/index.json`만 현재 수용 기준이다. `flash-sale-baseline-v26/index.json`은 정식 10/12회 당시 불변 checkpoint다. 기존 12개 ZIP은 v26 폴더에, 새 limited 02/03 ZIP과 12개 재분석 sidecar는 v261 폴더에 있다. 원본 14회 = 정식 12 + preflight 2이며 총 322파일/308 artifact hashes다. 4,174건의 HTTP paid 주문·티켓 ID를 SQL과 대조했다. 14개 실제 앱 이미지의 runtime 동등성도 확인했다.

v2.6.1은 빈 `workingTree`, 정확한 offered buyer 집합을 추가 검증하고 strict smoke를 분석 invalid/예외와 분리했다. 기존 원본을 고치지 않고 전체 재분석했으며 수치·판정은 같았다. `manifest.passed`/`smokePassed`와 `analysis.classification`은 다른 판단이다. **valid-overload는 유효한 과부하 관측이지 모든 구매 성공이 아니다.**

## 4. P2가 알려주는 사실과 알려주지 않는 것

| 관측 | 설계에 사용할 해석 |
| --- | --- |
| 충분 재고 2·10명/초, 각각 3회 안정 기준 충족 | 해당 환경·창·혼합에서 관측한 안정 구간. 10/s를 DB capacity나 입장 R 확정값으로 쓰지 않음 |
| 충분 재고 25명/초: 과부하 2회·안정 1회 | 반복 안정 구간 아님. 3회 모두 strict smoke 실패, 미완료·pending·hold가 존재 |
| 25/s 측정 cohort paid 739/628/748 of 750 | 성공자 p99만으로 전체 구매가 잘 처리됐다고 결론 내리지 않음. warmup 미완료도 3/190/55명 |
| 제한 재고 10명/초·300명·60석: 3회 모두 30paid/60tickets/270품절 | 재고 경쟁·정합성 관측. 충분 재고 처리량과 분리 |
| SQL 40001 재시도, pool/lock 대기 | 병목 가설의 근거. DB 단독 포화나 대기열 효과의 인과 증명은 아님 |

실험 조건: 단일 hot event, 합성 JWT 사용자/HMAC callback, 예약:직접 checkout=50:50, 수량 2, think 20ms, 재시도 1회/100ms, 매 3번째 replay. 앱 1CPU/512MiB, PG 1CPU/512MiB, Redis 0.5CPU/256MiB, pool 2~10, info 로그, 250ms 관측. 기존 limiter는 fail-closed를 유지하되 실험 한도 1,000,000/60s로 분리했다. 이는 운영 설정 추천이 아니다.

충분 재고는 40초 도착 중 warmup 10초를 제외한 30초, 제한 재고는 warmup 없이 30초, 최대 drain 30초다. cohort 완료율의 분모는 예약된 측정 사용자 전체이며, 처리량은 실제 시간창 안의 SQL 대조 완료/30초다. stable 기준은 cohort paid ≥99%, non-replay 요청 실패 ≤1%, paid p99 ≤2초, replay 실패 0, 전·후반 처리량 차이/제공률 ≤20% 등 보고서의 고정 조건이다. 한 rate의 세 반복이 모두 통과해야 안정이라고 부른다.

공유 Windows/Docker 호스트에서 2026-10-01과 10-02에 나누어 실행했다. 메모리 부족 중단·시작 실패는 보존했고 기준을 낮추지 않았다. 최대 처리량, 운영 SLO, 큐 도입 효과, 다중 이벤트 총량, R/C/TTL과 polling 최적값은 **아직 미입증·미결정**이다. 오래된 `PERFORMANCE_REPORT.md`나 P1 smoke를 이 공백의 근거로 대신 쓰지 않는다.

## 5. P3가 결정해야 할 계약

P3의 최종 산출물은 `docs/ADMISSION_CONTRACT.md`의 명시적 revision과 결정·변경 기록이다. 아래는 결정 목록이며 지금 확정한 설계가 아니다.

| 영역 | 설계 설명과 계약에 포함할 결정 |
| --- | --- |
| 대기·공정성 | 이벤트/인증 사용자별 중복 등록, 최초 순번의 원자적 배정과 동률, 취소·재등록·이탈 청소, 보장 범위. 입장 순서와 구매 성공 순서를 구분 |
| 상태·API | waiting/admitted/consumed 및 cancelled/expired 전이표, 전이 주체·전제·원자성·재시도 응답. 정확한 method/path/schema/오류·소유권·서버 시각·만료·endpoint 호출 제한 |
| 응답 필드 | admission ID, 상태·순번, 권장 polling 시각/간격. #12의 깨진 `extPollAfterMs` 표기와 #15의 `nextPollAfterMs`를 정리해 단일 명칭 확정 |
| 승격·자원 | R=초당 승격량, C=활성 admission 상한을 따로 정의. 활성의 시작/끝, scheduler 간격·batch 상한·다중 worker 중복 tick, 만료 회수, 여러 이벤트 공유 예산 또는 단일 이벤트 지원 범위 |
| 논리적 소비 | admission 하나를 사용자·이벤트·하나의 논리적 점유에 어떻게 결박할지. 신규 reservation과 직접 checkout 사이 이중 소비 방지, durable key·DB 제약과 transaction 위치, 변경 payload 재사용 거절 |
| 기존 구매 보호 | 실제 DB에서 유효함을 확인한 기존 reservation checkout, 기존 주문 replay, 결제 webhook에는 신규 입장을 요구하지 않음. admission TTL과 reservation/order deadline 분리 |
| 장애·복구 | commit 전 실패, commit 후 응답 유실, Redis 갱신 실패, replay를 표로 설명. Redis 토큰 선삭제만으로 소비 확정 금지. reset 이전 자격을 epoch 또는 동등 검증으로 무효화하고 재등록·공정성 한계 명시 |
| Redis/limiter | 신규 입장 fail-closed. 기존 limiter가 구매·결제·조회에 주는 영향과 admission 면제는 별도 정책으로 설명 |
| polling | fixed/adaptive 모드, 상하한·jitter, hidden tab/재접속/사용자·이벤트 변경, 중복 조회·늦은 응답 처리, 429/503, 입장 인지 지연의 정의·측정 목표 |
| 후행 책임 | P4 Redis/API, P5 구매·DB 결박, P6 대기 UI/polling의 함수·API·DB 경계와 최소 파일 지도. P7 실패 검증과 P8 A/B/C 조건을 연결 |

PostgreSQL은 재고·예약·주문·결제의 최종 권위다. 기존 ZSET/Lua는 rate limiter이며 admission 대기열이 아니다. MQ, Redis로 재고 권한 이전, 새 인증 서비스, Redis Cluster는 기본 범위가 아니다. 필요하면 근거·최소 대안을 먼저 제시하고 총괄 및 후행 범위를 갱신한다. P3에서 P4~P6 구현을 미리 완료하지 않는다.

## 6. 실제 코드와 검증 지도

경로는 repository root 기준이다. 아래 파일을 읽고 호출 순서를 확인한 뒤 설계한다.

| 경계 | 먼저 읽을 파일 |
| --- | --- |
| 공통 훅·인증·limiter·캐시 | `src/api/app.ts`, `src/api/middleware/{auth,webhook-signature,rateLimit,idempotency}.ts`, `src/infra/redis/{client,commands}.ts`, `src/infra/config.ts` |
| 신규 예약 | `src/api/rest/reservations.ts`, `src/core/services/reservation.service.ts`, `src/core/services/inventory.service.ts` |
| checkout/기존 주문 replay | `src/api/rest/checkouts.ts`, `src/core/services/checkout.service.ts`, `src/core/services/order.service.ts` |
| 결제·별도 데모 정산 | `src/api/rest/payments.ts`, `src/api/rest/demo.ts`, `src/core/services/payment-webhook.service.ts` |
| DB 원자성·소비/회복 패턴 | `src/infra/postgres/client.ts`, `src/infra/migrations/001_init_schema.sql`, `003_payment_provider_transaction_unique.sql`, `005_payment_record_idempotency_scopes.sql`, `010_payment_callback_keys.sql`, `011_payment_callback_status.sql` |
| 예약/주문 만료 | `src/infra/cron/{reservation-sweeper,order-sweeper}.ts`, `src/core/services/order-expiration.service.ts`, `src/infra/migrations/008_order_payment_deadline.sql` |
| 읽기/UI가 의존할 현재 API | `src/api/graphql/{types,resolvers}.ts`, REST 조회 경로. 현재 GraphQL은 Query만 제공하며 새 mutation 경로를 가정하지 않음 |
| HTTP·재시도·정합성 회귀 | `src/tests/integration/{route-contract,concurrency,checkout-expiry,order-expiration-http,payment-callback-keys,webhook-idempotency,inventory-constraints}.test.ts` |
| Redis·동시 worker·만료 | `src/tests/integration/{redis-recovery,rate-limit-atomic,order-sweeper,order-sweeper-starvation,order-sweeper-docker}.test.ts` |
| 수용 하네스 | `load-test/flash-sale.js`, `flash-sale-fixture.mjs`, `flash-sale-analysis.mjs`, `flash-sale-check.mjs`, `docker-compose.flash-sale.yml` |

중요한 현재 동작:

- 전역 훅은 webhook signature → JWT → 기존 rate limiter → idempotency → route 검증 순서다. admission을 어디에 넣을지, cached replay가 무엇을 우회하는지 반드시 설명한다.
- 신규 reservation에는 checkout과 같은 durable 멱등 계약이 없다. 현재 idempotency middleware의 command scope는 `/checkouts`, `/webhooks/payments/settlement`다. reservation의 응답 유실 복구를 기존 기능처럼 가정하지 않는다.
- `reservationId`가 입력에 있다는 이유만으로 입장을 면제하면 안 된다. 기존 DB의 사용자·이벤트·tier·수량·상태·만료 검증을 유지한다. 기존 checkout replay도 기존 주문 identity/소유권 검증을 보존한다.
- checkout은 Redis의 응답 캐시로 성공을 재생하지 않고 현재 DB 주문·티켓을 다시 읽는다. payment settlement만 입력 fingerprint에 맞는 응답 캐시를 쓴다. 같은 callback key의 HTTP replay가 최초 `duplicate:false` 응답을 그대로 돌려줄 수 있다는 기존 계약을 훼손하지 않는다.
- 신규 입장을 요구하지 않는 경로도 현재 limiter를 거친다. Redis 장애 fail-closed로 기존 결제/조회가 영향을 받을 수 있다. “큐를 안 거친다”를 “Redis가 없어도 모두 계속된다”로 설명하지 않는다.
- PostgreSQL의 기존 order/provider/callback unique key와 재시도 패턴은 참고할 수 있으나 admission 소비를 이미 보장하지는 않는다. DB commit 후 Redis hold/cache 정리 실패가 durable 결과를 되돌릴 수 없다는 경계를 이어받는다.

## 7. 검증·완료·변경 전파 기준

P3 계약 리뷰에서는 최소한 다음 반례를 상태/실패 표로 추적한다: 동시 중복 등록, 같은 timestamp, 취소와 승격 경합, 다중 tick, 만료와 소비 경합, 한 admission의 예약/직접 checkout 이중 사용, 다른 사용자·이벤트·payload 재사용, commit 전 장애, commit 후 응답 유실, Redis 업데이트 실패·reset·재연결, 기존 reservation checkout·order replay·payment 계속 진행, hidden tab·재접속·늦은 polling 응답. happy path만 있는 계약은 완료가 아니다.

문서·계약만 작성했다면 실행 테스트를 수행한 것처럼 쓰지 않는다. 코드 변경이 생기는 후행에서는 관련 회귀와 가능한 전체 테스트/build/typecheck, branch diff review 및 별도 최종 reviewer 검토를 수행하고 main이 finding을 수정한다. 문서만 달라졌다는 이유로 기존 부하 전체를 다시 돌리지 않되, 측정·쓰기·환경 조건이 달라지면 총괄 gate로 A 재검증 범위를 먼저 판정한다.

복구 테스트의 설정과 실제 실행을 구분한다. `route-contract`는 DB fallback 확인을 위해 limiter를 fail-open으로 설정하며, 응답 유실 사례는 첫 응답을 버리고 재요청하는 방식이다. `checkout-expiry`의 Redis DEL fault는 제어된 주입이다. 이를 production Redis 장애 중 HTTP 성공이나 실제 네트워크 단절 검증으로 확대하지 않는다. 실제 Redis pause/재연결 검사는 `redis-recovery`의 별도 범위다.

현재 검증 기록은 하네스 29, unit 159, integration 240 pass/10 skip, production-image/callback/build/typecheck 통과, lint 오류 0/기존 경고 9다. 고정 포트 63532가 Windows 예약 범위에 들어 Redis 장애 10개를 이번 실행에서 제외했다. 정확한 이름은 v261 `validation.json`에 있다. 이전 250/250을 최신 전체 통과로 쓰지 않는다. 새 환경에서는 포트·Docker 상태를 다시 확인하고 무관한 컨테이너나 시스템 포트 예약 정책을 바꾸지 않는다. 전용 리소스와 정확한 소유권으로만 장애 테스트·정리한다.

P3 완료 조건:

- [ ] 설계 설명을 먼저 전달하고 사실·제안·미결정을 구분했다.
- [ ] `ADMISSION_CONTRACT.md`에 revision, 채택 근거, 상태/실패/재시도 표, API/schema, R/C/TTL/polling과 지원 범위를 확정했다.
- [ ] 수치마다 측정 출처 또는 실험 가정·추후 판정 기준이 있다.
- [ ] P4/P5/P6 최소 파일·인터페이스·DB 경계와 P7/P8 검증 조건이 맞는다.
- [ ] Issue #12에 명시된 Astra reviewer가 우회·이중 소비·응답 유실·만료·재시도·다중 worker·재접속을 확인했고 main이 finding을 처리했다. 역할명만으로 실제 모델을 확인했다고 쓰지 않는다.
- [ ] 최신 #9 및 선행 입력을 다시 확인하고 P3 accepted SHA/revision과 검증·미검증 범위를 기록했다.
- [ ] #13~#17 완료 조건/consumed revision과 #9 상태표를 함께 갱신하고 #18까지 전이 영향을 판정했다. 이미 완료된 후행도 영향이 있으면 stale로 표시하고 재오픈 또는 재검증 Issue를 연결했다.

P3 수용 뒤 직접 소비자인 P4 #13의 ready 여부를 판정한다. P5/P6는 P4의 수용 구현/API도 필요하므로 문서만으로 모두 ready라 하지 않는다. P8은 A 입력이 있어도 P3/P6/P7이 미완료면 blocked다. 이 gate는 작업 시 수행할 절차이며 자동 감시나 임의 PR 병합 권한을 만들지 않는다.

최종 인계 기록에는 구현/문서 SHA·PR, 소비한 P2 tuple, 계약 revision·변경 전후, 실제 검증과 제외 범위, 후행 valid/stale 및 재검증 대상을 남긴다. 지금 문서 작성·push는 P3 계약 완료나 후행 구현 완료가 아니다.
