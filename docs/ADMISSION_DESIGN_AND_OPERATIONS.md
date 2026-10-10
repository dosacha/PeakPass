# 입장 제어: 설계 선택과 운영 절차

이 문서는 PeakPass의 입장 제어(대기열, 입장량 제한, polling)를 왜 이렇게 만들었는지와 어떻게 켜고 끄고 재현하는지를 한곳에 모은다. 규칙의 원문은 [입장 제어 계약 admission-v1](ADMISSION_CONTRACT.md)이고, 이 문서가 계약과 다르면 계약이 맞다.

기준: main `5529898`(2026-10-09, P8 병합)의 코드와 증거. 제품 코드·계약·migration은 main `1bb2796`과 같고, 그 뒤 2026-10-10까지의 병합은 문서만 바꿨다. 여기 적은 수치는 모두 로컬 단일 host에서 한 측정이며 운영 성과가 아니다.

## 무엇을 풀려고 했나

같은 이벤트에 구매자가 한꺼번에 몰리면, 대기열이 없는 구매 경로는 PostgreSQL의 SERIALIZABLE 재시도를 다 쓰고 500으로 끝나는 요청이 늘어난다. P8 측정 조건(초당 50명이 20초 동안 도착, 1,000명)에서 대기열이 없는 arm A는 측정 cohort 750명 중 16.00%만 결제했다(3회 중앙값)([성능 보고서](PERFORMANCE_REPORT.md)).

입장 제어는 구매 경로에 들어오는 사람 수를 줄여 이 실패를 없애고, 그 대신 기다리게 한다. 처리량을 늘리는 장치가 아니다.

## 설계 선택과 trade-off

| 선택 | 얻은 것 | 치른 것 |
| --- | --- | --- |
| 재고·예약·주문·결제·입장 소비 결과의 기준은 PostgreSQL에 둔다 | 기존 정합성 장치(SERIALIZABLE, 행 잠금, UNIQUE·CHECK)를 그대로 쓴다. Redis를 잃어도 팔린 수량과 주문은 틀리지 않는다 | 구매마다 PostgreSQL transaction이 필요하다. 동시에 진행하는 구매가 늘면 직렬화 실패가 늘어난다([#27](https://github.com/dosacha/PeakPass/issues/27)) |
| Redis는 대기 순서, 입장 자격, 입장 예산(R, C), 조회 상태만 맡는다 | 등록·승격·취소·만료·claim을 Lua 하나로 원자적으로 비교한다. 순서는 epoch마다 INCR sequence와 waiting ZSET으로 정한다 | Redis가 없으면 신규 등록·승격·신규 구매가 모두 닫힌다(fail-closed) |
| 입장 하나는 PostgreSQL 원장(`admission_results`) 한 행으로 한 번만 소비된다 | 응답을 잃은 구매를 같은 요청으로 다시 보내면 같은 결과를 받는다. Redis 토큰을 먼저 지우는 방식이 아니어서 Redis와 DB가 어긋나도 이중 점유가 없다 | 원장 행은 v1에서 자동으로 지우지 않는다 |
| 전용 Redis는 persistence를 끄고 `noeviction`으로 둔다 | 재시작한 Redis의 과거 대기열을 믿지 않아도 된다. 유실은 epoch reset 한 번으로 복구한다 | reset 뒤 대기 순번은 복원되지 않고 사용자는 다시 등록한다 |
| 초당 승격 R과 동시 입장 C를 작게 고정한다(seed: R 2, C 8) | P8 조건에서 측정 cohort의 구매 시도 실패율이 대기열 없는 arm A의 61.75%에서, 같은 R·C를 쓴 arm B(fixed polling) 0.32%, arm C(adaptive polling) 0%가 됐다(3회 중앙값. arm C는 세 run 모두 0/1,875) | 1,000명을 받는 데 최소 500초가 걸린다. 대기가 분 단위다 |
| 대기 화면은 polling으로 상태를 읽는다 | 새 연결 방식이나 서버 구성요소가 필요 없다 | 대기자 수만큼 조회 요청이 생긴다. 아래 "polling 절충" 참고 |

### polling 절충

fixed polling은 전면 탭이 1,000ms마다 조회한다. adaptive polling은 서버가 응답에 넣는 `nextPollAfterMs`를 따른다: 대기 순번이 `5 × R` 이하이거나 이미 입장한 상태면 1,000ms, 그보다 뒤면 5,000ms이고, 여기에 ±20% jitter를 준 뒤 1,000–5,000ms로 자른다. 숨김 탭은 두 방식 모두 15초다.

P8에서 두 방식의 차이는 이것 하나였다. fixed는 status 요청이 249,395건, adaptive는 55,983건이었다(구매자 1,000명 전체의 요청, 3회 중앙값). fixed arm에서는 scheduler의 승격 달성률(대기자가 있는 동안의 승격 수 ÷ R이 허용한 수)이 67.92%에 머물렀고 adaptive arm은 98.01%였다(3회 중앙값. 사람 수의 비율이 아니며, 두 arm 모두 1,000명이 결국 전원 승격됐다). 조회 부하가 같은 1 CPU 인스턴스의 scheduler를 늦춘 것으로 읽지만, tick 간격 자체는 재지 않았다.

adaptive의 비용은 뒤쪽 대기자의 화면이 최대 5초 늦게 갱신된다는 점이다. 전면 탭의 입장 인지 지연을 상한 추정치의 p95로 2초 이하에 두는 것은 실험 목표였고 보장하는 SLO가 아니다.

### 채택하지 않은 것

아래 두 가지는 구현하지도 측정하지도 않았다. 비교 실험의 결론이 아니라, 범위를 정할 때의 판단을 P9에서 적은 것이다.

- **재고 권한을 Redis로 옮기기.** 팔 수 있는 수량을 Redis에서 차감하면 PostgreSQL과 Redis 두 곳의 수량을 맞춰야 하고, Redis를 잃었을 때 재고를 복구할 절차가 필요하다. 대기 순서는 잃어도 다시 등록하면 되지만 재고는 그럴 수 없다. 이 프로젝트의 oversell 방어는 이미 PostgreSQL transaction과 제약으로 통합 테스트에 고정돼 있어, 그것을 유지하고 앞단에서 유입만 줄이는 쪽을 택했다.
- **메시지 큐.** 필요한 것은 등록 순서, 입장 예산, 사용자가 조회할 상태였고 기존 Redis로 만들 수 있었다. 구매 요청은 지금처럼 동기 응답으로 결과를 돌려준다. 큐를 두면 운영할 구성요소와 실패 지점(적재 유실, 중복 소비, 결과 통지)이 늘어난다.

같은 이유로 Redis Cluster와 새 인증 시스템도 범위 밖이다(계약 §1).

## 설정

| 항목 | 값 | 어디서 정하나 |
| --- | --- | --- |
| `ENABLE_ADMISSION` | 기본 `false` | 환경 변수(`.env.example`). 이 인스턴스에서 대기열 scheduler를 켠다. 이벤트 보호 여부가 아니다 |
| 이벤트 보호 | 기본 unprotected | PostgreSQL `admission_events.protected`. 동시에 보호하는 이벤트는 1개다(partial UNIQUE) |
| profile `admission-v1-seed` | R 2/s, batch 2, C 8, 입장 TTL 30초, claim 기한 15초, tick 250ms, 대기 lease 120초, 대기 최대 1,000명, epoch당 entry 10,000개, epoch 최대 24시간 | 코드 상수 `src/core/models/admission.ts`. 환경 변수로 바꾸지 않는다 |
| 대기열 API 한도 | 조회 120/분, 등록 10/분, 취소 10/분 (user·event·action별) | 계약 §7. 기존 구매 한도(5/분)와 별도다 |
| 전용 Redis | `--save "" --appendonly no --maxmemory-policy noeviction` | Redis 실행 인자. 다르면 입장 제어가 준비 상태를 열지 않는다 |

seed 값은 처음에 고정한 실험 가정이다. 운영 권고값이 아니며 P2 기준선에서 용량을 환산한 값도 아니다. R이나 C를 올린 후보는 P8 pilot에서 구매 시도 실패율 기준을 맞추지 못해 채택하지 않았다([ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md)의 pilot 절. pilot 수치는 조건 선택용이다).

## 시작, 보호 켜기와 끄기, 종료

**migration.** 001–013을 적용한다(`npm run migrate:up`, 운영 이미지는 `node dist/infra/migrations/runner.js up`). 012가 `admission_events`, 013이 `admission_results`를 만든다. 앱은 `admission_results`가 없는 DB에서 시작을 거부한다. `down`은 구현돼 있지 않다.

**시작 순서**(`src/main.ts`). 원장 테이블 확인 → `ENABLE_ADMISSION=true`면 Redis 설정 검증 → 신호 처리 등록 → 예약·주문 sweeper → 대기열 scheduler → listen. Redis 설정이 맞지 않으면 기능을 켠 인스턴스는 시작하지 못한다.

**보호 켜기와 끄기.** 제품에는 이를 위한 route나 명령이 없다. 계약 §6의 전이를 SQL로 실행한다: 한 transaction에서 이벤트의 배타 gate를 얻고 `admission_events` 행을 `FOR UPDATE`로 잠근 뒤 `protected`를 UPDATE한다. 테스트와 부하 fixture가 이렇게 한다(`src/infra/postgres/admission-policy.ts`). 기능을 켠 인스턴스는 다음 tick에 보호 정책의 namespace를 만들어 공개하거나, 해제된 정책의 namespace를 정리한다. 전제는 세 가지다: 모든 인스턴스가 이 버전이고 migration 013이 적용돼 있다, Redis가 위 설정이다, 보호 이벤트가 1개 이하다. 켜는 SQL은 다음과 같다.

```sql
BEGIN;
SELECT pg_advisory_xact_lock(1347436869, hashtext('<event id>'));
INSERT INTO admission_events (event_id, redis_namespace)
VALUES ('<event id>', 'peakpass:admission:<event id>:') ON CONFLICT DO NOTHING;
SELECT protected FROM admission_events WHERE event_id = '<event id>' FOR UPDATE;
UPDATE admission_events SET protected = true WHERE event_id = '<event id>';
COMMIT;
```

- `<event id>`는 소문자 UUID로 쓴다. gate의 key(`1347436869`와 event id의 `hashtext`)와 namespace의 형식은 `src/infra/postgres/admission-policy.ts`의 값이다. 끌 때는 `protected = false`로 같은 transaction을 실행한다.
- INSERT가 필요한 이유: migration 012는 그때 있던 이벤트의 행만 만든다. 그 뒤에 만든 이벤트의 행은 `readAdmissionPolicy`를 거친 transaction이 commit될 때 생긴다. 2026-10-10 실행에서는 새로 만든 이벤트에 행이 없었고 그 이벤트의 첫 대기열 조회 뒤에 생겼다. 행이 없는 상태에서 UPDATE만 실행하면 0행으로 끝나 보호가 켜지지 않았다.
- 2026-10-10에 이 SQL을 production 이미지와 PostgreSQL 16, Redis 7에서 실행했다([#36](https://github.com/dosacha/PeakPass/issues/36)). 켠 뒤 1.5초 안에 `phase`가 `open`이 되고 대기열 조회가 200으로 답했으며, 끈 뒤에는 404 `ADMISSION_NOT_ENABLED`로 답했다. 로컬 실행 1회다.

**환경 변수만 끄면 보호가 풀리지 않는다.** 기능을 끈 인스턴스가 보호 이벤트의 신규 예약·checkout을 admission 필드와 함께 받으면 503 `ADMISSION_UNAVAILABLE`로 답한다. admission 필드가 없는 신규 예약은 기능을 켠 인스턴스와 끈 인스턴스 모두 400 `ADMISSION_INVALID_INPUT`으로 답했다(2026-10-10 실행). 이미 DB에 있는 예약과 주문은 기존 검증으로 진행한다.

**종료**(`src/main.ts`의 `gracefulShutdown`). SIGTERM·SIGINT를 받으면 먼저 Redis 연결을 끊는다. 그 순간부터 이 인스턴스의 Redis 명령은 실패한다. 이어서 sweeper와 scheduler를 멈추고, HTTP 서버를 닫아 진행 중인 요청의 응답을 기다린 뒤, PostgreSQL pool을 닫는다. 그래서 종료 중에 PostgreSQL에 commit된 구매는 이 인스턴스가 Redis에 반영하지 못한다. 응답은 DB 결과로 나가고, 슬롯은 claim 기한 뒤 다른 인스턴스의 reclaimer가 원장을 읽어 정리한다(P7의 K5: Redis 차단 → 결과를 reclaimer에 넘김 → HTTP 서버 종료 → PostgreSQL 종료 순서를 로그로 확인). 종료 중에 구매 요청에 답한 경우, client가 그 연결을 닫으면 약 3초에 끝났지만 keep-alive로 쥐고 있으면 약 73초가 걸렸다(P7의 K5·K5b와 F2, 로컬 관측. Node 18과 Fastify 기본 keep-alive timeout 72초). 진행 중인 요청이 없는 인스턴스는 유휴 keep-alive 연결이 하나 있어도 1초 안에 끝났다(2026-10-10 로컬 관측 1회). keep-alive로 쥔 경우에는 약 73초보다 짧은 grace period를 주는 orchestrator가 프로세스를 먼저 죽인다. 고치지 않은 한계다([#32](https://github.com/dosacha/PeakPass/issues/32)).

## 장애 때의 동작

| 상황 | 동작 |
| --- | --- |
| Redis에 닿지 않는다 | 신규 등록·승격·신규 구매가 닫힌다(503). 기존 rate limiter도 Redis가 없으면 예약·checkout·webhook·GraphQL에 503을 반환한다. 이 동작은 입장 제어 이전부터 있었고 바꾸지 않았다. 그래서 DB에 결과가 남아 있는 요청도 HTTP로는 503을 받을 수 있다 |
| Redis가 재시작됐거나 대기열 데이터가 없어졌다 | 빈 대기열로 계속하지 않는다. generation을 올리고 새 epoch로 reset한다. 이전 입장 자격은 410을 받고 사용자는 다시 등록한다. 순번은 복원되지 않는다 |
| 입장한 뒤 구매하지 않는다 | 입장 TTL 30초가 지나면 만료되고 슬롯이 돌아온다 |
| 구매 응답을 잃었다 | 같은 요청을 다시 보내면 PostgreSQL 원장의 결과를 받는다. Redis 상태나 TTL과 무관하다 |
| 구매를 시작한 뒤 프로세스가 죽었다 | claim 기한 15초 뒤 reclaimer가 원장을 확인한다. 결과가 있으면 그것을 반영하고, 없으면 닫힘을 commit한 뒤에만 슬롯을 돌려준다 |
| 입장 필드가 있는 구매가 직렬화 재시도를 다 썼다 | 503 `ADMISSION_UNAVAILABLE`. 같은 identity로 다시 보내면 된다. P8의 fixed arm에서 구매자 1,000명 전체의 시도 기준으로 15건이었다(3회 중앙값, 최소 10건, 최대 26건). 503으로 끝난 구매자는 없었고, 다시 보낸 요청이 한 번 더 503을 받은 경우가 두 run에서 2건씩 있었다 |
| 신규 입장이 멈춘 동안 진행 중이던 예약·주문 | 기존 예약의 checkout, 주문 replay, 결제 webhook은 입장 자격을 다시 요구하지 않는다 |

## 검증한 범위와 하지 않은 것

- **실제로 실행한 것.** 제품 이미지 컨테이너에 가한 Redis·PostgreSQL·프로세스 장애 26개 시나리오와 headless Chrome 시나리오(P7, [ISSUE_16_VALIDATION.md](ISSUE_16_VALIDATION.md)), 같은 조건의 A/B/C 부하 비교(P8, [ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md)). 모두 로컬 host 한 대다.
- **합성하거나 주입한 것.** TTL·claim 기한 경과의 일부, Redis 반영 유실, 화면의 구매 오류 응답 일부는 필드를 직접 쓰거나 응답을 주입해 확인했다. 어느 것이 그런지는 각 단계의 검증 문서에 있다.
- **하지 않은 것.** 네트워크 분할, persistence나 replica가 있는 Redis, failover, 인스턴스 4개 이상, 다른 도착률, 실제 브라우저에서의 입장 인지 지연, 이탈과 취소가 섞인 부하, 사람의 코드 리뷰.

## 알려진 한계

- 동시에 보호하는 이벤트는 1개다. Redis 하나는 PostgreSQL DB 하나에만 붙어야 한다.
- 보호를 해제한 직후 다음 scheduler tick(250ms)과 배타 gate를 기다리는 동안 이전 상태가 응답될 수 있다.
- Redis 반영이 실패한 구매의 슬롯은 회수될 때까지 사용 중으로 남고, 그 시간에 상한이 없다.
- 데모 페이지는 프로세스마다 고정 사용자 1명이다. 스크린리더, 다른 브라우저, 모바일은 확인하지 않았다.
- seed profile에서 대기는 분 단위다. 받아들일 만한지는 제품 판단이며 정하지 않았다.

단계별로 남긴 항목은 [#25](https://github.com/dosacha/PeakPass/issues/25)(P4), [#27](https://github.com/dosacha/PeakPass/issues/27)(P5), [#29](https://github.com/dosacha/PeakPass/issues/29)(P6), [#32](https://github.com/dosacha/PeakPass/issues/32)(P7), [#34](https://github.com/dosacha/PeakPass/issues/34)(P8), [#36](https://github.com/dosacha/PeakPass/issues/36)(P9)에 있다.

## 실험 재현

Node 18 이상, Docker Compose v2, k6, `npm ci`가 필요하다. 저장소 루트에서 실행한다. 실행마다 자체 PostgreSQL 16, Redis 7, 현재 코드로 빌드한 앱을 띄우고 끝나면 그 실행의 자원만 지운다. 빌드한 이미지(`peakpass:fs-<run id>`)와 결과 폴더는 남는다.

```sh
npm run build
npm run test:flash-sale
node load-test/flash-sale-fixture.mjs --run-id <새 id> --arm <a|b|c> --users 1000 --rate 50 --warmup-seconds 5 --pre-vus 1000 --max-vus 1000 --drain-seconds 900
```

- arm `a`는 대기열 없음, `b`는 대기열과 fixed polling, `c`는 같은 대기열과 adaptive polling이다.
- 이 조건의 부하 구간은 최대 920초다(도착 20초 + drain 900초). 분석기가 요청을 모두 메모리에 올리므로 P8은 `NODE_OPTIONS=--max-old-space-size=6144`로 실행했다.
- 결과는 `load-test/results/flash-sale/<run id>/`에 생기고 git이 무시한다. P8이 남긴 증거는 `load-test/results/flash-sale-abc-v3/`(index와 ZIP 11개)다.
- 지표의 정의, 유효성 규칙, 종료 순서는 [측정 계약](FLASH_SALE_EVIDENCE.md)에 있다.
- 장애 스위트(P7)는 Docker가 필요한 opt-in이고 CI에서 돌지 않는다. 명령은 [ISSUE_16_VALIDATION.md](ISSUE_16_VALIDATION.md)의 "Commands"에 있다.
