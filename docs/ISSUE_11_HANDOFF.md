# P2 / Issue #11 새 세션 인수인계

2026-10-01 후속 실행의 현재 계측 계약은 [FLASH_SALE_EVIDENCE.md](FLASH_SALE_EVIDENCE.md), 실제 측정·수용 tuple·제외 원본·후행 입력은 [FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md)를 따른다. 아래는 P2 착수 전에 작성한 인수 조건과 변경 gate의 기록이다.

이 문서는 [P2 #11: 대기열 없는 쓰기 기준선과 병목 실측](https://github.com/dosacha/PeakPass/issues/11)을 이어가기 위한 진입점이다. **이번 인계에서는 P2를 실행하지 않았다.** P1의 검증된 하네스를 인수하고, 측정 계약의 부족한 부분을 먼저 보완한 뒤 기준선 A를 만든다.

## 1. 목적과 범위

최종 목적은 이력서에 쓸 수 있는 재현 가능한 근거를 얻는 것이다. 강의의 대기열·입장 제한·adaptive polling 아이디어를 그대로 성과로 주장하지 않고, 현재 PeakPass에서 문제가 관측되는지부터 확인한다.

- PostgreSQL이 재고·예약·주문·결제의 최종 기준이다. 기존 Redis ZSET/Lua는 rate limiter이며 입장 대기열이 아니다.
- P2는 **대기열 없는 현재 쓰기 경로**의 안정 구간·포화 구간·병목 또는 병목 미관측 범위를 측정한다. 대기열, Redis 재고 차감, MQ, 인증 재설계는 이번 범위가 아니다.
- P3에 용량 근거와 한계를 전달하고 P8에서 재사용할 A 조건을 남긴다. R(초당 입장량), C(동시 입장 상한), TTL과 API 계약의 확정은 P3다. 입장 RPS를 DB TPS와, C를 DB pool 크기와 같게 놓지 않는다.

로드맵은 [총괄 #9](https://github.com/dosacha/PeakPass/issues/9)가 관리한다.

| 단계 | Issue | 산출물 |
| --- | --- | --- |
| P1 | [#10](https://github.com/dosacha/PeakPass/issues/10) | 실제 사용자 쓰기 하네스·격리 환경 |
| P2 | [#11](https://github.com/dosacha/PeakPass/issues/11) | 대기열 없는 기준선 A·병목 근거 |
| P3 | [#12](https://github.com/dosacha/PeakPass/issues/12) | 입장·실패·수명·계측 계약 |
| P4 | [#13](https://github.com/dosacha/PeakPass/issues/13) | Redis 대기열 backend |
| P5 / P6 | [#14](https://github.com/dosacha/PeakPass/issues/14) / [#15](https://github.com/dosacha/PeakPass/issues/15) | 구매 경로 연동 / UI·polling |
| P7 | [#16](https://github.com/dosacha/PeakPass/issues/16) | 실제 장애·정합성 검증 |
| P8 | [#17](https://github.com/dosacha/PeakPass/issues/17) | A/B/C 비교 |
| P9 | [#18](https://github.com/dosacha/PeakPass/issues/18) | 문서·이력서 반영 |

의존성: `#10 → #11 → #12 → #13 → {#14, #15} → #16 → #17 → #18`. #17은 #11의 A 기준선도 직접 소비한다.

## 2. 인계 시점과 착수 게이트

다음은 **2026-10-01 KST 문서 작성 시점의 스냅샷**이다. 새 세션에서 GitHub와 Git을 다시 조회한다.

| 항목 | 확인된 값 |
| --- | --- |
| 저장소 | `https://github.com/dosacha/PeakPass` |
| PR | [#19](https://github.com/dosacha/PeakPass/pull/19), OPEN, main에 미병합 |
| P1 branch | `codex/issue-10-write-load-harness` |
| PR 문서 추가 전 HEAD | `a657be492e35f5498b2c43e802a488824cd08a1f` |
| remote main | `79a0b5ed381b9c8be72e30fa7b0c61f8c56acfd0` |
| 구현·실험 SHA | `e0fbc78754e17dd6380b1a899373168c3ddf6153` |
| 계약 revision | `flash-sale-v1` |
| #9 상태표 | P1 ready / P2 blocked, 수용 산출물은 아직 미생성으로 표기 |

`a657be49`는 증거·문서 추가 커밋이고 이 인계 문서의 커밋도 측정 코드를 바꾸지 않는다. **코드와 reference 증거가 존재하는 것, PR가 병합된 것, 총괄 gate가 수용한 것은 별개**다. #9 상태표는 구현 진행을 아직 반영하지 않았으므로 자동으로 P2 ready라고 해석하지 않는다.

1. #9·#10·#11 본문/댓글과 PR #19의 최신 diff·CI·병합 상태를 읽는다. 후행 #12·#17의 소비 조건도 확인한다.
2. 아래 P1 tuple과 실제 코드·증거를 대조한다. #9/#11에 수용 SHA/revision/run ID 및 착수 판정을 기록하고 상태표를 실제 근거와 일치시킨다. 검토만 끝난 상태와 수용 완료를 구분한다.
3. P1이 병합됐다면 최신 main에 구현이 포함됐는지 확인하고 P2 branch를 만든다. 미병합이면 최신 PR head를 실제 포함하는 작업 공간에서 조사·계획을 진행하고, 그 위에서 P2를 진행할 경우 선행 PR에 의존하는 branch임을 명시한다. 의존성이 blocked/stale인 동안 정식 기준선 수용·완료를 선언하지 않는다. **PR 병합 권한을 추론하지 않는다.**
4. SHA ancestry만으로 squash merge를 오판하지 않는다. ancestry가 없으면 변경 파일 내용과 source hash를 비교해 포함 여부를 확인한다. 다른 OS의 줄바꿈에 따른 바이트 해시 차이도 원인을 기록한다.

현재 구현 worktree는 `C:\Users\dosac\.codex\worktrees\peakpass-issue10-harness\PeakPass`다. 원래 `C:\Users\dosac\projects\PeakPass`에는 오래된 local main과 별도 미추적 작업이 있으므로 reset/clean하거나 덮어쓰지 않는다. 기존 적합한 worktree를 확인한 뒤, 필요하면 별도의 `codex/issue-11-write-baseline` branch/worktree를 사용한다.

읽기·동기화 명령 예시(구현 worktree에서 실행):

```powershell
git status --short --branch
git remote -v
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git log -5 --oneline
gh issue view 9 --repo dosacha/PeakPass --comments
gh issue view 10 --repo dosacha/PeakPass --comments
gh issue view 11 --repo dosacha/PeakPass --comments
gh issue view 12 --repo dosacha/PeakPass --comments
gh issue view 17 --repo dosacha/PeakPass --comments
gh pr view 19 --repo dosacha/PeakPass --json state,headRefName,headRefOid,baseRefName,mergeCommit,statusCheckRollup
```

## 3. P1에서 인수할 것

기본 문서는 [측정 계약](FLASH_SALE_EVIDENCE.md)과 [실제 검증 기록](ISSUE_10_VALIDATION.md)이다. 인수 tuple은 `e0fbc78754e17dd6380b1a899373168c3ddf6153` + `flash-sale-v1` + source hashes + 아래 세 run ID다.

| reference run | 실제 저부하 결과 |
| --- | --- |
| `p1-reference-ample-01` | 12 시작 / 12 paid / 24 tickets / dropped 0 |
| `p1-reference-ample-02` | 12 시작 / 12 paid / 24 tickets / dropped 0 |
| `p1-reference-limited-01` | 12 시작 / 3 paid / 6 tickets / 재고 부족 409 9건 / dropped 0 |

원본 ZIP·[검증 인덱스](../load-test/results/flash-sale-reference/verification.json)·[ZIP 해시](../load-test/results/flash-sale-reference/archives.sha256)는 저장소에 있다. 각 ZIP의 21개 파일과 manifest의 artifact/source hash를 확인한다. 로컬 ignored run 폴더가 없어도 ZIP으로 인수할 수 있다. 초기에 잘못 통과했던 `p1-smoke-01`은 승인 증거가 아니다.

P1은 개별 사용자 JWT, callback HMAC, 동일 body/key의 checkout·settlement retry/replay, 인증 거절과 DB 불변, SQL 정합성, 소유한 fixture만 정리하는 경로를 검증했다. **예약은 멱등성 계약이 없어 자동 재시도하지 않는다.**

2026-09-30의 검증은 harness 8/8, unit 159개, integration 250개(24 suites, skip 0), build/typecheck 통과, lint 오류 0·기존 경고 9개다. 이는 과거 구현의 검증 기록이다. 새로운 세션의 실행 결과로 재표기하지 않는다. timeout/5xx 분기는 VM 검사이며 실제 장애 실험이 아니다. 999/s는 HTTP 없는 스케줄러 경계 검사이며 서비스 용량이 아니다.

| 파일 | 먼저 확인할 내용 |
| --- | --- |
| [flash-sale-fixture.mjs](../load-test/flash-sale-fixture.mjs) | CLI, 격리 자원, fixture/auth, observer, SQL 판정·cleanup·manifest |
| [flash-sale.js](../load-test/flash-sale.js) | 도착 모델, 구매 흐름, retry/replay, 성공 정의, metric tags |
| [flash-sale-check.mjs](../load-test/flash-sale-check.mjs) | VM/순수 로직 경계 검사 |
| [docker-compose.flash-sale.yml](../docker-compose.flash-sale.yml) | 자원 제한·production app·전용 PG/Redis |
| [client.ts](../src/infra/postgres/client.ts), [config.ts](../src/infra/config.ts) | opt-in pool 표본, 환경 변수·기본값 |

## 4. P2 측정 전에 해결할 차이

P1 하네스는 저부하의 전원 완료를 승인하는 도구다. 다음 차이를 먼저 조사하고 **필요한 최소 변경만** 구현한다. 기존 숫자를 그대로 그래프로 옮겨 기준선이라고 부르지 않는다.

| 차이 | P2에서 필요한 처리 |
| --- | --- |
| 매 실행 새 앱·DB·Redis, 단일 constant-arrival block | warmup/측정/drain 및 사용자 cohort의 시작·끝을 사전 정의한다. 같은 run 안에서 준비 구간과 측정 구간을 분리하고 원본 시각으로 판정 가능하게 한다. 별도 CLI 실행은 이전 앱을 warmup하지 않는다. |
| `loadStartedAt/loadEndedAt`는 k6 시작·결과 flush까지 포함 | 이 wrapper 구간을 정상 상태 측정창으로 쓰지 않는다. k6 point와 observer/app 시각을 정렬하고 경계 포함 규칙을 고정한다. 현재 CLI에 warmup/window 옵션은 없다. |
| smoke threshold는 전원 완료·오류 0 요구 | 정상적인 포화 관측과 하네스/환경 결함, 데이터 정합성 결함을 분리한다. 기존 원본 exit code·`passed=false`를 보존한다. 오류를 성공으로 바꾸거나 실패 run을 삭제하지 않는다. |
| `verification.counts.paidOrders`가 현재 모든 order 수 | P1 통과 run에서는 전부 paid라 일치했다. 과부하 분석에서는 `sql-snapshot.orders`의 status별 수를 직접 계산하고, 이 필드를 사용할 경우 먼저 집계와 회귀 검사를 고친다. |
| `noExtraSettlementFacts`는 모든 order가 정산됐다고 전제 | pending order가 있는 run의 false만으로 중복 정산을 단정하지 않는다. paid/pending/hold, provider·callback 중복/소유권, HTTP unknown outcome을 각각 확인한다. |
| 관측 완전성 assert가 smoke 실패 시 생략됨 | 실패 run도 필요한 파일·해시·시각 범위·관측 error·표본 누락을 독립 검사한다. 파일이 있다는 것만으로 병목 근거로 승인하지 않는다. |
| API custom latency는 업무 성공 여부를 tag로 보장하지 않음 | HTTP status 필터만으로는 잘못된 200 body를 제외할 수 없다. 검증된 업무 성공의 수·지연을 연결할 최소 metric/분석 계약을 정하고 검사한다. |
| k6 gracefulStop 240초, request timeout 10초 | 사전에 drain 종료와 미완료 분류를 정한다. 앱 중지 뒤 SQL snapshot은 그 시점의 상태다. hold/order TTL 이후의 자동 회수까지 검증했다고 주장하지 않는다. |
| 호스트 정보·Docker 제한은 있으나 실제 CPU 사용률 등의 시계열은 없음 | 앱/DB/Redis/발생기 병목을 구분할 최소 관측을 추가하거나 진단 한계를 명시한다. pool/lock 표본만으로 DB 병목이라고 단정하지 않는다. |

소스·도착/성공 정의·시간창·계측이 바뀌면 revision을 갱신하고 이전 P1 reference는 원래 계약의 증거로 보존한다. 변경 후 경계 검사와 작은 실제 HTTP·SQL smoke를 통과시킨 다음 새 SHA/revision을 P2 입력으로 고정한다.

## 5. 실행 순서와 측정 계약

### 조사와 준비

기존 요청과 같은 분업을 유지한다. 먼저 explorer(구현 경로/영향), 테스트 agent(기존 실패/검증), reviewer(경쟁·정합성·측정 위험)가 **읽기 전용으로 병렬 조사**한다. 모든 결과가 모인 뒤 main이 계획을 확정하고 코드를 수정한다. 같은 파일을 여러 agent가 동시에 수정하지 않는다.

저장소의 현재 지침을 확인하고 아래부터 실행한다. 마지막 실행은 **P1 재현 smoke**이며 정식 P2 기준선이 아니다. Docker Compose v2와 k6가 필요하다. 먼저 `docker context show`와 `docker context inspect`로 로컬 격리 실험 대상인지 확인한다. runner가 host 환경을 상속하므로 의도치 않은 `K6_*` 옵션은 사전에 판정하며 값·인증정보를 로그로 출력하지 않는다.

```powershell
if (Get-ChildItem Env: | Where-Object Name -Like 'K6_*') {
  throw 'Review inherited K6_* overrides before measuring'
}
npm ci --no-audit --no-fund
npm run test:flash-sale
$runId = 'p2-preflight-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
node load-test/flash-sale-fixture.mjs --run-id $runId --users 12 --rate 2 --stock ample
```

기존 ID를 재사용하지 않는다. 현재 parser는 `--help`, `--duration`, `--iterations`, `--vus`, `--warmup`, `--stages`, `--base-url`을 지원하지 않는다. `users`는 `rate`로 나누어져야 하며 `users/rate`는 2–3600초, `rate`는 최대 999, `pre-vus ≤ max-vus`다. 실제 도착 종료는 우측 경계를 제외한 `users/rate*1000 - 1ms`다. `users`를 고정하고 rate만 바꾸면 기간도 바뀐다. `k6 run load-test/flash-sale.js`를 직접 실행하지 않는다. JWT fixture·HMAC·모델·검증은 Node runner가 준비한다.

### 실행 전에 기록할 프로토콜

P2 계획·최종 결과는 `docs/FLASH_SALE_BASELINE.md`에 모으는 것을 권장한다(현재 미생성). 다음 항목을 **부하 실행 전** 채운다. 탐색 pilot과 정식 반복 실행을 구분하고 결과를 본 뒤 유리한 기준으로 바꾸지 않는다.

1. 소비 tuple, 구현/하네스 revision, 명령, 머신·Docker 할당 및 이미지 ID/digest, 앱/PG/Redis 제한, Node/k6/DB 버전, 스키마, pool·로그·표본 설정.
2. 각 run의 단일 hot event, 신규 사용자/키 정책, 충분한 재고, 예약/직접 구매 비율, 수량·think time·retry·replay. 현재 기본은 50:50, 수량 2, think 20ms, retry 1회/100ms, replay-every 3이다. 제한 재고 경쟁 실험은 별도 표로 둔다.
3. 유입률 단계, 각 단계의 warmup/측정/drain 길이, steady-state 기준, 각 조건 **최소 3회** 반복 및 실행 순서. 낮은 유입부터 pilot으로 범위를 찾고 정식 행렬을 고정한다. 숫자로 된 안정성/SLO·중단 기준은 선택 근거와 함께 기록하며 기존 서비스 목표로 꾸며내지 않는다.
4. offered/started/completed/dropped, cohort 완료율, measurement-window 처리량, 전체 완료 시간의 정확한 분모·시간 경계. 미완료·중단·unknown 결과의 처리 방법도 정한다.
5. 중단 조건: 재고/중복/소유권 위반은 즉시 중단·증거 보존·수정 범위 판정. 자원 소유권 불명/cleanup 실패 시 다음 run 중단. VU/발생기 포화·fixture/auth 오류·관측 누락은 해당 측정 무효화 후 원인 수정. 과부하율·지연·호스트 자원에 대한 수치 중단 기준도 미리 정한다.
6. 원본·실패 run 보존 위치, 분석 명령/버전, 중앙값·범위 산출 방식, 비교에서 제외한 run과 이유.

VU 기본 10/20은 고부하 용량 보장이 아니다. 같은 PC에서 k6·Docker·raw JSON 기록이 경쟁하므로 generator 자원도 확인한다. dropped가 생긴 run의 실제 시작 부하는 보고할 수 있지만 설정한 유입률을 전달했다고 승인하지 않는다. 한계를 수정했다면 새 조건으로 다시 측정한다.

실험 limiter는 켜진 fail-closed 상태이며 `(users + 3) * (retries + 3) * 4`로 정해진다. 고정 기간에서 rate를 늘리면 users와 limiter도 바뀐다. 각 run의 값을 명시하고 비구속 조건인지 확인하거나, 공정한 비교에 필요한 설정을 먼저 고정·revision 처리한다. limiter 거절 429를 높은 구매 처리량으로 세거나 운영 설정에 실험 한도를 복사하지 않는다.

각 run은 전용 Compose 자원·합성 사용자만 사용한다. 기존 `.env`/공유 DB/공유 Redis·global flush/reset을 사용하지 않는다. 강제 종료 후에는 manifest와 정확한 project 소유권부터 확인한다. 과거 검증 기록의 고정 컨테이너 이름·ID·포트를 그대로 정리 명령에 복사하지 않는다.

## 6. 분석·실패 판정 규칙

| 지표/판정 | 기준 |
| --- | --- |
| 구매 처리량 | 측정창 안의 고유한 실제 paid 완료 수 / 측정창 초. API 요청 수·retry·replay·티켓 수와 구분하고 HTTP 완료와 SQL paid를 각각 표시한다. |
| 완료율/전체 완료 시간 | 사전 정의한 도착 cohort의 최종 완료율, 마지막 도착·완료 시각, drain 후 미완료 수. 완료한 사용자만의 지연으로 전체 경험을 대표하지 않는다. |
| API 지연 | reservation/checkout/settlement별, 성공/실패별 p95/p99를 원본에서 계산한다. `api_duration{stage,kind:normal}`은 실패도 포함하고 normal은 첫 시도만 뜻한다. |
| 여정 지연 | `journey_duration{outcome:paid}`는 성공한 사용자만 포함하며 think/retry 시간이 들어간다. 실패·중단 사용자는 별도 수/상태로 보고한다. |
| 요청·오류율 | stage/flow/kind(normal,retry,replay)/status/error_code별 분모. 재고 409, 기타 409, 429, 5xx, timeout/전송 오류를 분리한다. 사전 negative auth는 구매 분모에서 제외한다. |
| 시간창별 throughput | k6 Counter `.rate`와 `traffic.startedPerScheduledSecond`는 정식 정상 상태 paid throughput이 아니다. 전자는 k6 전체 실행 시간, 후자는 설정된 도착 기간을 분모로 쓴다. |
| DB/Redis 진단 | pool checkedOut은 실행 query 수가 아니다. lock 표본은 짧은 대기를 놓친다. retry 경고는 최종 실패 수가 아니다. observer Redis PING은 앱 명령 latency가 아니다. startup/drain을 포함한 전체 로그·INFO 차이를 정상 창의 지표로 혼합하지 않는다. |

P1 `k6-summary.json`의 legacy threshold boolean은 reference에서 성공 조건에도 `false`다. `true=통과`를 가정하지 말고 k6 버전·`k6.txt`·exit code·원본 count를 함께 확인한다.

run 판정은 단일 `passed`를 복사하지 않고 아래처럼 기록한다.

- **유효·안정:** 설정 부하가 전달되고 관측/정리가 완전하며 사전 안정 기준과 정합성을 만족한다.
- **유효·과부하 관측:** 전달된 부하와 증거가 유효한 가운데 오류·지연·미완료가 증가한다. P1 smoke의 `passed=false`는 보존하며 안정 구간으로 승인하지 않는다. pending/active hold나 HTTP 응답 유실만으로 재고 손상을 단정하지 않는다.
- **무효 측정:** generator 부족, fixture/auth 오류, 하네스 예외, 파일·관측 누락, cleanup 실패 등이다. 원본을 보존하고 해당 자료로 서비스 용량을 확정하지 않는다.
- **정합성 결함:** inventory 식, 중복, 소유자·수량·provider/callback 결합의 실제 위반이다. 관련 실험을 중단하고 재현·원인·수정 또는 연결된 remediation Issue·무효화 범위를 남긴다.

`noUnfinishedOrdersOrHolds`, `expectedPurchases`, `noExtraSettlementFacts`, HTTP/SQL 완료 불일치의 실패는 원인을 나눠 판정한다. SQL 증거를 버리거나 이러한 조건을 전부 제거해 초록색으로 만드는 것은 해결이 아니다.

## 7. Astra의 변경 영향·수용 기준

변경이 생기면 **변경 전/후, 이유, 직접 소비자, 전이적 영향, 재검증 범위**를 기록한다. Issue가 닫혔어도 stale 판정 대상이다. 단순 문서 오탈자 등 비교 의미를 바꾸지 않는 변경은 근거와 함께 valid를 유지할 수 있다.

| 변경 | 최소 재판정 대상 |
| --- | --- |
| 사용자/JWT/fixture/도착/cohort/오류 분모/성공 정의 | #11 결과 → #12 용량·정책, #17 비교, #18 주장 |
| CPU/메모리/이미지/스키마/pool/log/쓰기 경로/계측 | #11 기준선·병목 및 이를 소비한 #12~#18의 해당 부분 |
| API/상태/순서/ID/epoch/TTL/소유권/실패 계약 | #12 계약 → #13/#14/#15 → #16 → #17 → #18 |
| R/C/회수/scheduler | #12 계약 및 #13/#14/#15, #16~#18 |
| polling/jitter/hidden-tab/retry/입장 인지 시계 | #15 → #16/#17/#18 |

1. #11의 consumed/produced revision과 #9 상태표를 갱신한다. 영향받는 #12/#17 등 본문·수용 기준·consumed revision에도 변경과 stale 이유를 반영한다. 미변경 후행은 valid 유지 이유를 쓴다.
2. 완료된 후행은 reopen하거나 명시적인 재검증 Issue로 연결한다. 재검증 전에는 최신 선행에 대해 ready/complete라고 선언하지 않는다. 모든 테스트를 무조건 반복하는 대신 영향 경로를 검증한다.
3. P8 A/B/C는 원칙적으로 같은 구현 SHA에서 실험 모드만 바꾸며 환경·사용자·도착·warmup/측정/drain·limiter·로그·retry·재고 정책을 맞춘다. A와 B/C의 구현 SHA가 다르면 무관한 diff라는 근거가 필요하고, 쓰기 경로나 계측이 변했으면 A를 재측정한다. P2 수치에 B/C 효과를 미리 붙이지 않는다.
4. 코드 변경 후 관련 검사 → 가능한 전체 테스트 → build/typecheck → branch diff review를 수행하고, 별도 reviewer가 최종 결과를 다시 검토한다. finding은 main이 수정하고 필요한 검증을 반복한다. 불가능한 검사는 이유와 미검증 범위를 남긴다. 파괴적인 opt-in 검사는 소유권이 확인된 별도 자원에서만 실행한다.

### P2 완료 시 남길 산출물

- [ ] 구현 SHA/PR, 소비한 P1 tuple, 새 계약 revision·소스 해시, 실제 명령/환경이 고정돼 있다.
- [ ] 조건별 최소 3회와 실패 run의 raw/summary/SQL/관측/cleanup/manifest를 보존하고 해시를 검증했다. `load-test/results/flash-sale/<run-id>/`는 Git ignore이므로 요약만 push하지 않고 검토한 원본 ZIP·해시·인덱스도 전달한다. 비밀값 포함 여부를 확인한다.
- [ ] ample 용량 곡선과 limited 경쟁 결과를 분리했다. 시작/완료/dropped·오류율·p95/p99·완료 시간의 중앙값·범위와 분모를 설명한다.
- [ ] pool/lock/app/Redis/generator 중 무엇이 관측됐는지 근거와 진단 한계를 쓴다. 병목 미관측이면 테스트한 범위의 하한만 보고한다. 최대 용량·대기열 필요성을 만들어내지 않는다.
- [ ] 정합성·실패 분류와 분석기가 실제 원본에 맞고, 미완료/unknown outcome을 숨기지 않는다. 오래된 `PERFORMANCE_REPORT.md`나 2026-06-03 JSON의 수치를 새 기준선으로 재사용하지 않는다.
- [ ] #12에는 용량 근거/한계와 입장 제어 필요성 판단을, #17에는 A 재현 조건/재측정 조건을 전달했다. 불필요한 대기열이라는 결론이면 후행 범위도 조정했다.
- [ ] #9/#11 및 영향받는 후행의 gate를 갱신하고 최종 reviewer finding을 처리했다. 최종 보고에 변경 사항, 실제 검증 명령·결과, 발견/수정 문제, 남은 위험을 구분했다.

## 8. 새 세션에 전달할 시작 문장

> PeakPass [P2] Issue #11을 이어서 수행하라. 먼저 `docs/ISSUE_11_HANDOFF.md`, `docs/FLASH_SALE_EVIDENCE.md`, `docs/ISSUE_10_VALIDATION.md`와 최신 Issue #9/#10/#11, PR #19, 후행 #12/#17을 읽고 P1 코드 포함 여부와 accepted tuple·dependency gate를 확인하라. P1 smoke는 최대 처리량 증거가 아니다. explorer·테스트 조사 agent·reviewer가 읽기 전용으로 병렬 조사한 뒤 main이 계획을 확정하고 구현하라. 측정 시간창·분모·반복·중단 기준을 실행 전에 고정하고, 현재 하네스의 과부하 판정·paid 집계·관측 완전성 한계를 먼저 해결하라. 충분한 재고의 대기열 없는 기준선과 제한 재고 경쟁 결과를 구분하고 실패 원본도 보존하라. 선행 변경이 발생하면 총괄 gate에 따라 후행의 consumed revision과 stale 여부를 갱신하라. 구현 후 관련/가능한 전체 테스트·build/typecheck·branch diff review 및 별도 최종 reviewer 검토를 수행하라. finding은 main이 수정하라. 실제 증거와 남은 한계를 보고하고, PR를 임의로 병합하지 마라.
