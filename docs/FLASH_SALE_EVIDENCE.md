# 실제 쓰기 부하 측정 계약 — P2 flash-sale-v2.6 / P8 flash-sale-v3.0

## v3 측정 계약 — P8 A/B/C / flash-sale-v3.0

P8([Issue #17](https://github.com/dosacha/PeakPass/issues/17))의 동일 조건 A/B/C 비교를 위한 revision이다. 실행 전 프로토콜·pilot 계획·결과는 [ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md)에 있다. 아래 v2.x 절과 P1 설명에서 v3가 바꾼 사항은 이 절이 우선한다. v2.6 원본과 판정은 수정하지 않는다. 분석기 `flash-sale-analysis-v3.0`은 v2.6 manifest를 기존 v2.6 규칙 그대로 분석한다.

- **환경.** `docker-compose.flash-sale.yml`의 변경은 두 곳이다: Redis `redis-server --save "" --appendonly no --maxmemory-policy noeviction`, 앱 `ENABLE_ADMISSION: "true"`. 모든 arm이 같은 파일과 같은 image를 쓴다. 자원 제한·pool·로그 수준·표본 주기는 v2.6과 같다.
- **arm.** `--arm a|b|c`(기본 a). 모든 arm에서 이벤트의 policy 행을 SQL로 ensure한다. a는 그 행을 unprotected로 둔다. b·c는 앱 시작 전에 계약 §6 전이(배타 event gate → 행 `FOR UPDATE` → `UPDATE protected=true`)를 실행하고, 시작한 인스턴스가 namespace를 공개해 control `mode=ready`, PG `phase='open'`, generation·epoch 일치가 될 때까지 기다린다. 전이 SQL은 `src/infra/postgres/admission-policy.ts`의 문장을 옮긴 것이고 check가 소스와 대조한다. b·c는 인증 negative 3건에 더해 admission 필드 없는 구매가 400 `ADMISSION_INVALID_INPUT`으로 거절되는지 확인한다.
- **여정.** a는 v2.6 여정 그대로다(코드 불변). b·c는 iteration 하나가 구매자 한 명·탭 하나이며, 페이지의 `frontend/admission-polling.js` controller 하나를 수정 없이 실행한다: 첫 상태 조회 → epoch 확인 뒤 등록 → 모드별 polling(b fixed, c adaptive) → 인지 후 think 시간 뒤 admission을 소비하는 구매(짝수 index는 예약, 홀수는 직접 checkout, 둘 다 admission 필드 포함) → 이후 checkout·정산·replay는 a와 같은 요청과 재시도 규칙. transport(`http.asyncRequest`), 시계, timer, visibility, `AbortController` 대체물을 주입한다. k6는 요청을 취소하지 못하므로 요청은 timeout(조회·등록 5초, 구매 10초)으로 끝난다. admission을 소비하는 요청은 controller 규칙대로 결과 미확정(무응답·429·5xx·409 `ADMISSION_IN_PROGRESS`)인 동안 같은 identity로 최대 4회 자동 반복한다.
- **cutoff.** 구매자는 절대 마감(scenario start + 도착 시간 + drain − 15초) 뒤에 새 요청을 시작하지 않고 outcome을 기록한다. 그때 나가 있던 요청의 응답은 받는다. queue arm은 구매자 수 이상의 VU(`--pre-vus >= --users`)와 15초보다 긴 `--drain-seconds`(상한 900)가 필요하다. k6가 drain 끝에서 iteration을 중단하면 그 run은 invalid다.
- **outcome.** `paid`, `not_joined`, `queue_waiting`, `admission_expired`, `admitted_unpurchased`, `cancelled`, `reset`, `unknown_outcome`, `stock_rejected`, `http_<status>`, `incomplete_checkout`, `incomplete_settlement`. 어느 것도 분모에서 빠지지 않는다.
- **hidden.** `--hidden-share <0–100>`(기본 0, queue arm 전용)은 `(index*37)%100 < share`인 구매자의 탭을 여정 내내 hidden으로 둔다. 층 관측용이며 정식 통계에 넣지 않는다.
- **계측.** 조회·등록 요청은 `api_responses`/`api_duration`에 `stage=status|join`으로 기록한다. controller의 trace 이벤트는 `admission_trace` point(태그 `type`, 이벤트 본문은 point metadata `e`의 JSON), 구매자별 요약은 `admission_journey` point다. 관측 loop는 250ms마다 모든 arm에서 같은 명령(Redis `TIME`, control, waiting·active·claims·window의 `ZCARD`)을 실행해 `observations.jsonl`의 `queue`에 남긴다.
- **종료 순서.** k6 종료 → active·claims가 0이 될 때까지 대기(상한은 TTL + claim 기한 + 15초, 실제 시간과 남은 수를 manifest `quiesce`에 기록) → Redis 상태 dump(`redis-admission.json`) → 앱 정지(`stop -t 90`, 소요 시간과 exit code를 `applicationStop`에 기록) → SQL snapshot → `admission-final.sql`(행 0이어야 함)과 원장–Redis 대조(`admission-final.json`) → cleanup(`admission_results` 먼저).
- **manifest.** `arm`, `pollMode`, `behaviour`, 실행 중인 image에서 읽은 `profile`, 비밀값을 뺀 `applicationEnvironment`, Redis `CONFIG` 3개 값과 run id의 전·후(`redis`), policy 행과 control의 전·후가 추가된다. `sourceHashes`에 `frontend/admission-polling.js`와 admission 소스 5개가 추가된다.
- **검증 run.** `--monitor`는 활성화와 앱 시작 전에 Redis `MONITOR`를 붙여 admission 쓰기를 `redis-monitor.txt`에 남긴다. `MONITOR`는 Redis를 느리게 하므로 측정 run에는 쓰지 않으며 이 run의 분류는 `valid-verification`이다.

2026-10-09 외부 리뷰 뒤의 revision: 하네스 `flash-sale-v3.1`은 script 두 곳만 다르다(대기열 arm의 두 번째 replay도 cutoff 뒤에는 시작하지 않는다. 2xx 조회·등록 응답에 해석 가능한 `serverTime`이 없거나 `admitted` 상태인데 `admittedAt`·`expiresAt`이 없으면 protocol failure다). 분석 `flash-sale-analysis-v3.2`는 `admission.expiredEntries`(cutoff 전에 승격됐고 Redis dump에 expired로 남은 entry 수, 구매자 outcome별)를 더하고, lower·upper·시각이 없는 인지 기록을 `trace` invalid로 판정한다. 분석기는 `flash-sale-v3.0`과 `flash-sale-v3.1` manifest를 같은 v3 규칙으로 분석한다. 정식 11회는 `flash-sale-v3.0`으로 실행해 `flash-sale-analysis-v3.1`로 분석한 그대로 보존하며, v3.2 재분석은 추가 필드 외에 같다.

분석 `flash-sale-analysis-v3.0`(2026-10-06부터 `flash-sale-analysis-v3.1`. 아래 표본 간격 항목만 다르다)이 v3 run에 적용하는 규칙:

- 완료율·throughput·paid 여정의 정의는 v2.6과 같다. 구매 write 지표는 `reservation`·`checkout`·`settlement` 단계만 센다. 조회·등록은 어떤 구매 오류율에도 들어가지 않고 `polling`에 따로 집계한다.
- 창은 두 가지다: 도착 창(`window`)과 전체 horizon(`horizon`, 도착 창 + drain 예산). 관측·pool·자원·발생기 표본은 측정 시작부터 부하 종료(k6 종료와 horizon 끝 중 이른 쪽)까지 요구한다.
- 표본 간격 상한(2026-10-06 결정, `flash-sale-analysis-v3.1`): v3 run에서 관측 loop·대기열 표본은 1,000ms, 자원 표본은 6,000ms, 앱 pool 표본은 2,000ms다(v3.0까지는 1,000ms). pool 표본의 최대 간격은 `disclosures.poolMaxGapMs`로 공개한다. v2.6 manifest의 pool 상한은 1,000ms 그대로다. v3.0이 낸 기존 run의 판정은 고치지 않고, v3.1로 재분석한 판정을 따로 병기한다.
- `purchase`: 창별·cohort별 non-replay 구매 시도의 실패(무응답·429·5xx) 비율, 500 `INTERNAL_ERROR`·503·무응답 수, 409의 code별 수, 첫 요청(예약 또는 직접 checkout)의 첫 시도 실패율과 반복 수.
- `admission`·`recognition`(queue arm): Redis dump의 entry 전수와 구매자별 요약으로 계산한다. 승격자 분모는 구매자 cutoff(Redis 시계로 환산) 이전에 승격된 entry 전체이며 인지·미인지 만료·미인지 수를 함께 낸다. 인지는 controller가 기록한 `lowerMs`~`upperMs`로, 발생기 안에서 잰 값이다. 브라우저의 인지가 아니다.
- `queue`: 표본 통계, dump의 모든 `admittedAt`에 대한 rolling 1초 `(t-1000, t]` 승격 수 ≤ R 검사, 대기자가 있던 구간의 승격 달성률. 표본의 최댓값은 상한의 증명이 아니다.
- invalid: v2.6 목록에 더해 policy·epoch·generation·control의 변화나 arm과 다른 보호 상태(`policy`), Redis run id 변화(`redis-restart`), Redis 설정 불일치(`redis-config`), admission 429·`ADMISSION_QUEUE_FULL`(`admission-limiter`), 구매자별 trace·요청 수·join identity 불일치(`trace`), 대기열 표본 누락(`queue-observer`), 최종 SQL·원장 증거 미확보(`admission-evidence`).
- integrity-defect: v2.6의 SQL 검사 실패, `admission-final.sql`의 행, 원장–Redis 불일치, SQL에 없는 HTTP paid, rolling 1초 승격 수 > R.
- 분류: a는 v2.6과 같다(`valid-stable`/`valid-overload`/`valid-limited`). b·c는 `valid-queue`이며 기준에 쓰는 값은 `criteria`에 수치로만 낸다(임계는 실행 전에 ISSUE_17 문서에 고정한다). 슬롯이 남은 채 상한에 걸린 대기와 느린 앱 종료는 invalid가 아니며 `disclosures`로 공개한다.

| 추가 입력 | 기본값 | 의미 |
| --- | --- | --- |
| `--arm` | a | a: 대기열 없음(이벤트 unprotected). b: 대기열 + fixed polling. c: 같은 대기열 + adaptive polling |
| `--hidden-share` | 0 | hidden 탭 비율(%). queue arm 전용 |
| `--monitor` | 꺼짐 | 검증 run 전용 Redis `MONITOR` 캡처 |
| `--drain-seconds` | 30 | 상한이 900으로 늘었다. queue arm은 15보다 커야 한다 |

| 추가 파일 | 의미 |
| --- | --- |
| `redis-admission.json` | 부하 뒤 Redis의 control, entry 전수(claim token 제외), join 매핑, waiting·active·claims·window 구성원 |
| `admission-final.json` | `admission-final.sql`이 반환한 행과 원장–Redis 불일치 목록. 둘 다 비어 있어야 한다 |
| `redis-monitor.txt` | `--monitor` run의 admission 쓰기(`ZADD`/`ZREM`/`UNLINK`/`DEL`, control `HSET`, `FLUSH*`) |

## v2.4–v2.6 변경 기록 (P2)

v2.4는 PR20 오토리뷰를 반영한다. 전체 started buyer와 terminal journey를 buyer별로 대조하고 terminal 수=완료 iterations를 함께 요구해 drain 중단을 배제한다. 각 주문의 null-provider pending payment audit는 해당 buyer checkout key로 정확히1개여야 한다. checkout 응답은 pending일 때 빈 tickets 배열, 정산 후 replay일 때 paid와 최초 정산의 동일한 유효 티켓 ID 집합을 요구한다. 이미 paid인 replay에 expired 응답 예외는 허용하지 않는다.

v2.5는 모든 성공 정산 응답(normal/retry/replay 및 expired ACK)의 `duplicate`에 boolean 타입을 요구한다. 동일 키의 HTTP replay는 첫 응답 캐시를 그대로 반환하므로 `false`도 정상이며, DB 재처리 경로의 `true`도 허용한다. 누락/null/문자열은 protocol failure다. expired ACK는 이 검사를 통과해도 paid가 아니며, 이미 paid인 replay의 expired 응답은 계속 거절한다. [기존 HTTP 경로 테스트](../src/tests/integration/route-contract.test.ts)의 cached false 계약을 유지한다.

v2.6은 최초 `normal` 정산(만료 ACK 포함)에 `duplicate:false`를 요구하며 retry/replay의 boolean 양쪽은 유지한다. paid 응답은 fixture tier와 일치해야 하고, SQL provider 정산 fact의 `reconciliation_required`는 paid일 때 false, expired일 때 true여야 한다. `buyers_completed`에 최초 정산의 `order_id`와 정렬한 티켓 ID 배열 JSON인 `ticket_ids`를 보존한다. 분석은 fixture buyer→paid SQL 주문→그 주문의 정확한 티켓 집합을 모두 대조한 완료만 분자에 포함한다. 태그 누락/파싱 불가/중복 ID는 관측 불완전으로 invalid, 정상 형식이지만 SQL identity와 다르면 integrity-defect다.

분석 `flash-sale-analysis-v2.6.1`은 위 관측에 더해 명시적으로 빈 workingTree와 start/terminal의 정확한 offered buyer 범위(0부터 users-1까지 canonical 문자열, 각1개)를 요구한다. 분석 invalid/예외는 analysisError와 실패 종료로 전달하며 strict manifest.passed/smokePassed를 덮어쓰지 않는다. 이 보강은 저장된 v2.6 원본의 별도 재분석으로 검증하고 원본 판정을 수정하지 않는다. v2.3/v2.4 raw에 최초 HTTP 티켓 ID가 없어 소급 수용하지 않는다. v2.5는 메모리 시작 조건에 미달해 부하0회였으며 v2.6 전체12회 계획으로 대체했다. v2.6은 ample9회·limited3회와 preflight2회를 완료했다. 기존12회는 원본을 보존한 별도 v2.6.1 재분석에서 수치·판정이 같았고, limited02/03은 2026-10-02 같은 조건으로 재개했다. 별도 최종 검토 No findings 뒤 새 정식12회 tuple을 수용했다. #12는 새tuple 소비로 ready(계약미작성), #17은 A입력만 valid이고 P3/P6/P7 대기로 blocked다. 실제후행착수시 수용SHA/동등코드포함을 재확인한다. 현재 상태·고정 행렬·원본은 [FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md)를 따른다.

## v2 변경 계약

v2.3은 Windows Chocolatey launcher와 그 자식 k6 프로세스를 소유 PID 트리로 묶어 CPU·메모리를 합산하고 실행 경로·PID·ShimGen 여부를 기록한다. CPU 누적값은 저부하에서 일정할 수 있으므로 증가 여부 대신 실제 non-shim 프로세스 관측을 요구한다. v2의 launcher-only pilot과 v2.2의 CPU 증가 조건으로 중단한 실행은 원본 그대로 보존하고 formal 결과에서 제외한다.

v2.2부터 checkout replay도 원본 주문 ID를 검증하며, 잘못된 성공 응답은 protocol failure다. graceful drain cutoff에서 iteration이 중단되면 완전한 시도 집계를 확인할 수 없어 무효 측정으로 남긴다.

분석기 v2.6.1은 `flash-sale-analysis-v2.3.1`의 종료 경계 보정을 유지한다. 측정 종료와 정상 k6 종료를 모두 가로지르는 마지막 자원 수집의 engine 부재만 허용하며, 실제 engine 표본에는 기존 최대6000ms 간격을 적용하고 중간 누락은 거절한다. 이전 원본 판정과 당시 재분석 SHA/revision은 보존한다.

P2의 실행 전 프로토콜·분모·중단 기준·결과는 [FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md)에 있다. 아래 P1 설명에서 v2가 바꾼 사항은 이 절이 우선한다. P1 reference ZIP/검증 기록은 수정하지 않으며 `flash-sale-v1` 저부하 증거로만 보존한다.

- `--warmup-seconds`(기본0), `--drain-seconds`(기본30, 최대240), `--limiter-max`(기본1,000,000)를 추가했다. `users/rate`는 warmup을 포함한 연속 도착 기간이다. 측정창은 k6 scenario start + warmup부터 도착 종료까지의 반개방 구간이며 최소2초다. `sample-ms`는 최대250ms로 제한하고 실제 표본 간격/경계도 검사한다.
- 명시적 실험 limiter는 run 규모와 독립적으로 고정한다. fail-closed/auth/production 쓰기 로직과 CPU·메모리/pool/info 로그는 유지한다. 부모 환경의 `K6_*` override는 provisioning 전에 거절한다.
- `api_duration`/`api_responses`의 `business=success|failure`는 실제 응답의 status·사용자·이벤트·수량·연결 검증 결과다. `normal|retry|replay`와 별개다. buyer index/cohort로 원본과 SQL identity를 대조한다. 시작 시각·도착 지연도 raw metric으로 보존한다.
- paid 집계는 실제 status별이다. pending/active hold/expired reconciliation은 미완료와 정합성 위반을 구분한다. 기존 엄격한 smoke `passed`와 k6 종료코드를 유지하고 `analysis.json`에 측정 유효성/안정·과부하·제한재고 결과를 별도로 기록한다.
- 관측·로그·최종 SQL·cleanup을 독립 시도하므로 smoke 실패가 관측 검사나 cleanup을 건너뛰지 않는다. `resources.jsonl`은 앱/PG/Redis Docker CPU·메모리, host CPU·가용 메모리, k6 process CPU 누적초·메모리 표본이다. `clockChecks`로 PG와 host 시각을 비교한다. CPU 표본은 단독 인과관계 증거가 아니다.
- child 로그는 줄 단위로 비밀값을 제거해 파일에 저장하고 반환 버퍼는64KiB tail로 제한한다. 앱 로그도 줄 단위로 읽는다. `sourceHashes`는 명명된 SHA256 canonical UTF-8 LF 계약이며 `rawSourceHashes`는 실제 실행 바이트다. 결과 `artifactHashes`는 원본 바이트 SHA256이다.
- 재분석: `node load-test/flash-sale-analysis.mjs <run-folder>`는 원본을 변경하지 않고 JSON을 출력한다. 성공 throughput은 창 안의 검증된 HTTP 완료와 최종 SQL paid가 일치하는 고유 구매/창 초다. SQL `paid_at`은 transaction-start timestamp이므로 commit 시간으로 쓰지 않는다.

## P1에서 인수한 기본 동작 (v1 역사 포함)

[Issue #10](https://github.com/dosacha/PeakPass/issues/10)의 산출물이다. 기존 예매 계약을 호출하는 측정 도구이며 대기열·캐시 재고 차감·처리량 개선 구현은 포함하지 않는다. 아래 작은 실행은 하네스 정합성 증거다. 서비스의 최대 처리량이나 성능 개선 수치로 사용하지 않는다.

새 세션에서 P2를 시작할 때는 [Issue #11 인수인계](ISSUE_11_HANDOFF.md)의 착수 gate·측정 보완 사항·후행 영향 기준을 먼저 확인한다.

## 실행

Node 18 이상, Docker Compose v2, k6, `npm ci`가 필요하다. 저장소 루트에서 실행한다.

```sh
npm run build
npm run test:flash-sale
npm run load-test:flash-sale -- --run-id my-ample-01
npm run load-test:flash-sale -- --run-id my-ample-02
npm run load-test:flash-sale -- --run-id my-limited-01 --stock limited --seats 6
```

매번 새로운 run ID를 사용한다. 같은 ID의 결과 폴더 또는 Compose 자원이 있으면 재사용하지 않고 거부한다. `docker-compose.flash-sale.yml` 한 파일로 자체 PostgreSQL 16·Redis 7·현재 코드의 production 앱을 빌드한다. 외부 DB/Redis 주소는 입력받지 않는다. 기존 Compose, `.env`의 연결 설정, demo 사용자, 공유 DB를 재사용하지 않는다.

포트는 `127.0.0.1`의 동적 포트이고 project/network/volume/DB는 실행마다 분리된다. 앱은 실제 `DB_HOST/PORT/NAME`, `REDIS_HOST/PORT`로 접속한다. 앱 1 CPU/512 MiB, PostgreSQL 1 CPU/512 MiB, Redis 0.5 CPU/256 MiB 제한을 고정한다. manifest에 실제 Docker 자원, 이미지 ID/digest, 호스트 환경과 버전을 보관한다.

정상 종료와 처리 가능한 실패·SIGINT/SIGTERM은 앱을 멈춘 후 SQL 증거를 저장하고, 대상 DB의 run marker를 확인해 해당 event/user ID만 트랜잭션으로 지운다. 무관한 sentinel event/user가 남는지 검사한 다음 그 실행의 Compose 자원과 volume을 제거한다. `FLUSHDB`, 전체 테이블 DELETE, `db:reset`은 사용하지 않는다. 임시 JWT 파일도 제거한다. 전원 종료·프로세스 강제 종료 시 `manifest`가 미완성일 수 있다. 그 경우 로그에 나온 정확한 project의 자원만 확인해 정리하고 해당 run은 증거로 승인하지 않는다. 빌드 이미지와 결과 파일은 유지된다.

## 부하 모델과 판정

| 입력 | 기본값 | 의미 |
| --- | --- | --- |
| `--users` / `--rate` | 12 / 2 | 신규 사용자 총수 / 초당 도착 수. users는 rate로 나누어져야 하고 users/rate는 2–3600초여야 한다. 이 revision은 최대 999명/초를 지원한다. |
| `--quantity` | 2 | 사용자당 좌석 수, 최대 100 |
| `--stock ample` | 모든 구매 수량 | 충분한 재고. 모든 사용자의 paid 완료를 요구한다. |
| `--stock limited --seats N` | 총 구매 수량의 약 절반 | 제한 재고. 정확히 `floor(seats/quantity)` 구매 성공과 나머지 `409 INSUFFICIENT_INVENTORY`만 허용한다. |
| `--think-ms` | 20 | 예약→checkout, checkout→정산 사이 대기 |
| `--retries` / `--retry-delay-ms` | 1 / 100 | checkout·정산의 timeout/5xx/진행 중 응답에 대한 추가 시도 수/대기. 최대 5회. |
| `--replay-every` | 3 | 해당 index 사용자가 구매 완료 후 checkout·정산을 동일 키로 재전송. 0은 끔. |
| `--pre-vus` / `--max-vus` | 10 / 20 | 미리 확보할 VU / 상한 |
| `--pool-max` / `--sample-ms` | 10 / 250 | 앱 pool 상한 / 관측 주기 |

[k6 constant-arrival-rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)는 응답 속도와 독립적으로 신규 구매 iteration을 시작한다. 사용자 선택은 VU ID가 아니라 전역 iteration index를 사용한다. 짝수 index는 예약→checkout→정산, 홀수는 직접 checkout→정산이다. 우측 경계의 추가 iteration을 피하기 위해 실행 시간은 `users/rate*1000 - 1ms`이다. 수량을 초과하는 iteration이나 예외는 실패 metric에 포함한다. 설정 도착 수, 실제 시작 수, iteration 수, dropped 수와 SQL 구매 수를 별도로 검증한다.

각 사용자는 개별 DB 행과 JWT subject를 갖는다. checkout 키·callback 키·provider transaction ID는 사용자당 고유하다. 재시도는 동일 body와 key를 사용한다. **예약은 멱등성이 없어 절대 자동 재시도하지 않는다.** 응답이 유실되면 unknown outcome으로 실패시키고 실제 hold를 SQL에 남겨 확인한다. provider callback은 사용자 JWT 없이 raw body와 timestamp에 대한 HMAC으로 서명한다.

구매 완료는 HTTP 200, `paymentStatus=settled`, `order.status=paid`, 정확한 주문·사용자·이벤트·수량, 중복 없는 active 티켓이 모두 일치할 때 한 번만 집계한다. 동일 키 replay는 구매 지연 측정 이후 별도 `kind=replay`로 기록한다. 첫 시도 `kind=normal`, 장애 재시도 `kind=retry`도 분리한다. 인증 실패, 일반 409, 429, 5xx, timeout은 재고 거절로 합산하지 않는다.

측정 전 실제 HTTP로 invalid JWT→401, 다른 body user→403, invalid HMAC→401을 검증하며 DB가 변하지 않는지 비교한다. 이 요청은 `negative-checks.json`의 `kind=negative`로 보관하고 k6 정상 구매 분모에 넣지 않는다. rate limiter는 켜진 fail-closed 상태로 유지하며 provider IP의 전체 callback/replay를 수용하도록 실행 규모에 따른 명시적 실험 한도를 부여한다. 운영 설정으로 복사하지 않는다.

## 증거 읽기

`load-test/results/flash-sale/<run-id>/` 전체를 한 묶음으로 취급한다. 큰 원본은 기본 Git ignore이므로 보존·공유 시 전체 폴더를 별도 아카이브하거나 검토 후 명시적으로 추가한다.

| 파일 | 의미 |
| --- | --- |
| `manifest.json` | revision, 코드 SHA/dirty 상태, 소스·lockfile·Compose 해시, 실행 명령/종료 코드, 머신·Docker·Node/npm/k6/PG/Redis·이미지 버전, 자원/pool/log/auth/limiter/모델 설정, 모든 결과 파일 해시 |
| `k6-raw.jsonl`, `k6-summary.json`, `k6.txt` | 원본 point와 요약. API/여정 p50·p95·p99, VU/dropped, 완료 수. `api_duration{stage:...,kind:normal}`과 `journey_duration{outcome:paid}`를 사용한다. 전체 HTTP 통계는 replay·retry·업무 거절을 포함한다. |
| `traffic.json` | 실제 시작 수·설정 창 기준 시작률·초별 도착, 관측 VU, `stage/kind/flow/status/error_code`별 응답 수. status 0과 k6 error code로 timeout/전송 오류를 구분한다. |
| `observations.jsonl` | PG active/Lock 대기 세션, locktype별 대기 수/가장 오래된 대기, observer Redis PING RTT |
| `app.jsonl`, `app-metrics.json` | 앱 JSON 로그, 실제 pool total/idle/checkedOut/waiting sample, 기존 transaction retry 경고 수 |
| `redis-before.txt`, `redis-after.txt` | Redis INFO commandstats 전후 원본 |
| `sql-snapshot.json`, `verification.json` | SQL 상태와 불변식·HTTP/DB 수량 대조 |
| `cleanup.json`, `teardown.txt` | fixture 제거·무관한 sentinel 보존·전용 자원 해제 |

SQL 재고식은 `available + active reservation 수량 + pending/paid/delivered order 수량 = total`이다. converted reservation은 중복 합산하지 않는다. 예약/주문은 사용자당 최대 한 개이고 converted reservation은 정확한 주문에 연결되어야 한다. paid 주문은 정확한 소유자의 티켓·settled provider record·입력에 결합된 callback key를 갖는다. pending/paid/expired 주문 모두 checkout의 원래 pending/null-provider payment record가 해당 buyer checkout key로 정확히1개 남아 있어야 한다. 별도 settlement record가 있으므로 전체 payment record 수를 주문 수와 같다고 검사하지 않는다.

## 한계와 P2 인수 조건

- PG/Redis/pool은 주기 표본이므로 짧은 대기를 놓칠 수 있다. pool checkedOut은 빌려간 connection 수이며 PG active query 수와 다르다. tuple/transactionid 대기는 row contention의 단서이고 advisory 대기와 구분한다.
- Redis PING은 **외부 observer 왕복시간**이다. 앱 명령별 latency percentile로 해석하지 않는다. INFO 전후 차이에는 observer와 앱 startup/cleanup 활동이 일부 포함된다.
- retry 경고 수는 재시도 예정 횟수다. 최종 실패 수는 HTTP 결과와 함께 본다. Fastify request logger도 info로 실행되어 계측·로그 비용이 포함된다.
- k6·Docker를 같은 PC에서 실행하므로 부하 생성기의 CPU/메모리 및 VU 한계도 영향을 준다. raw JSON 기록·observer·info 로그 설정을 모든 비교군에서 동일하게 고정한다. 하네스는 단일 호스트 실행용이다. 1000명/초 이상에는 1ms 종료 경계와 도착 모델을 먼저 재검증해야 한다. `maxObservedVUs`는 k6 주기 표본과 도착 시점 표본의 최대값이며 정확한 순간 peak는 아니다.
- 재시도 코드의 timeout/5xx 분기는 VM 경계 테스트이고, 저부하 정상 smoke의 replay는 실제 HTTP다. 강제 네트워크 장애·고부하 한계는 P1에서 측정했다고 주장하지 않는다.
- 앱 코드 변경은 기본값 0인 `DB_POOL_SAMPLE_INTERVAL_MS` 계측뿐이다. 일반 실행에는 타이머가 없으며 close 때 제거한다.

P2/Astra는 시작할 때 [총괄 #9](https://github.com/dosacha/PeakPass/issues/9)의 dependency gate를 적용한다. 승인한 **구현 SHA + `flash-sale-v1` + source hashes + accepted run IDs**를 #11에 고정하고, 환경·모델·성공 판정·계측이 바뀌면 먼저 #10 산출물 revision과 영향 범위를 갱신한다. 기존 결과를 새 조건의 결과처럼 재사용하지 않는다. 고부하에서 비정상 종료해도 원본과 SQL 스냅샷을 보존하며 `passed=false`는 하네스의 정상 smoke 승인 실패이지 측정 파일 부재를 뜻하지 않는다.
