# 입장 제어: 설계 선택과 운영 절차

이 문서는 PeakPass의 입장 제어(대기열, 입장량 제한, polling)를 왜 이렇게 만들었는지와 어떻게 켜고 끄고 재현하는지를 한곳에 모은다. 규칙의 원문은 [입장 제어 계약 admission-v1](ADMISSION_CONTRACT.md)이고, 이 문서가 계약과 다르면 계약이 맞다.

기준: 여기 적은 수치는 측정 commit `6f9568f780219ea8e28e026072c448a38e8e069b`(main `5529898`로 병합)의 코드로 2026-10-08–09에 잰 것이다. 그 뒤 계약과 migration은 바뀌지 않았고, 제품 코드는 2026-10-12에 입장 제어 밖에서 바뀌었다(인코딩된 경로의 미들웨어 적용, 매칭되는 route가 없는 요청을 한도 없이 404로 답하는 것, 동작하지 않던 `GET /graphql` 삭제, 밖에서 들어오는 UUID를 소문자로 맞춘 것(대상: UUID인 JWT 주체, 조회 경로의 id, 예약·checkout·정산·데모 정산 본문의 `eventId`·`userId`·`reservationId`·`orderId`, GraphQL `event(id)`. checkout의 Idempotency-Key는 PostgreSQL에 쓰는 값만 맞추고 Redis의 lock은 보낸 그대로 쓴다), 운영 시작 검사, 입력 오류의 4xx 응답, GraphQL 오류 메시지 가리기, 주석 정리와 서식). 그 변경 뒤에 다시 측정하지는 않았다. 수치는 모두 로컬 단일 host에서 한 측정이며 운영 성과가 아니다.

## 무엇을 풀려고 했나

같은 이벤트에 구매자가 한꺼번에 몰리면, 대기열이 없는 구매 경로는 PostgreSQL의 SERIALIZABLE 재시도를 다 쓰고 500으로 끝나는 요청이 늘어난다. 입장 제어는 구매 경로에 들어오는 사람 수를 줄여 이 실패를 없애고, 그 대신 기다리게 한다. 처리량을 늘리는 장치가 아니다.

### 실제 순서

아래 수치가 대기열을 만든 이유로 읽히지 않도록, 일이 진행된 순서를 적어 둔다.

1. 대기열, 입장량 제한, polling을 만들기로 먼저 정했다. 단계를 나눈 Issue #9–#18을 2026-09-30에 한꺼번에 만들었다.
2. 구현하기 전에 대기열 없는 구매 경로를 쟀다(쓰기 기준선, 2026-10-01–02). 초당 2명과 10명은 세 번 모두 안정이었고 초당 25명은 3회 중 2회가 과부하였다.
3. 그 기준선을 입력으로 계약(admission-v1)을 쓰고, 구현한 뒤 실제 장애를 일으켜 검증했다.
4. 마지막에 같은 조건에서 대기열 없음(arm A), 대기열과 고정 간격 polling(arm B), 대기열과 적응형 polling(arm C)을 비교했다(2026-10-08–09). 초당 50명이 20초 동안 도착하는 조건에서 arm A는 측정 cohort(처음 5초에 도착한 warmup 250명을 뺀 750명) 가운데 16.00%만 결제했다(3회 중앙값, [성능 보고서](PERFORMANCE_REPORT.md)).

즉 16.00%는 대기열을 만들게 한 관측이 아니라 만든 뒤에 같은 조건으로 비교해 얻은 값이다. 만들기 전에 있던 근거는 2번의 기준선이다. 또 이 실패의 원인은 격리 수준과 재시도 설정이므로 대기열 말고도 고칠 방법이 있다. 그 방법들은 측정하지 않았다(아래 "채택하지 않은 것").

## 설계 선택과 trade-off

| 선택 | 얻은 것 | 치른 것 |
| --- | --- | --- |
| 재고·예약·주문·결제·입장 소비 결과의 기준은 PostgreSQL에 둔다 | 기존 정합성 장치(SERIALIZABLE, 행 잠금, UNIQUE·CHECK)를 그대로 쓴다. Redis를 잃어도 팔린 수량과 주문은 틀리지 않는다 | 구매마다 PostgreSQL transaction이 필요하다. 동시에 진행하는 구매가 늘면 직렬화 실패가 늘어난다([#27](https://github.com/dosacha/PeakPass/issues/27)) |
| Redis는 대기 순서, 입장 자격, 입장 예산(R, C), 조회 상태만 맡는다 | 등록·승격·취소·만료·claim을 Lua 하나로 원자적으로 비교한다. 순서는 epoch마다 INCR sequence와 waiting ZSET으로 정한다 | Redis가 없으면 신규 등록·승격·신규 구매가 모두 닫힌다(fail-closed) |
| 입장 하나는 PostgreSQL 원장(`admission_results`) 한 행으로 한 번만 소비된다 | 응답을 잃은 구매를 같은 요청으로 다시 보내면 같은 결과를 받는다. Redis 토큰을 먼저 지우는 방식이 아니어서 Redis와 DB가 어긋나도 이중 점유가 없다 | 원장 행은 v1에서 자동으로 지우지 않는다 |
| 전용 Redis는 persistence를 끄고 `noeviction`으로 둔다 | 재시작한 Redis의 과거 대기열을 믿지 않아도 된다. 유실은 epoch reset 한 번으로 복구한다 | reset 뒤 대기 순번은 복원되지 않고 사용자는 다시 등록한다 |
| 초당 승격 R과 동시 입장 C를 작게 고정한다(seed: R 2, C 8) | A/B/C 비교 조건에서 측정 cohort의 구매 시도 실패율이 대기열 없는 arm A의 61.75%에서, 같은 R·C를 쓴 arm B(fixed polling) 0.32%, arm C(adaptive polling) 0%가 됐다(3회 중앙값. arm C는 세 run 모두 0/1,875) | 1,000명을 받는 데 최소 500초가 걸린다. 대기가 분 단위다 |
| 대기 화면은 polling으로 상태를 읽는다 | 새 연결 방식이나 서버 구성요소가 필요 없다 | 대기자 수만큼 조회 요청이 생긴다. 아래 "polling 절충" 참고 |

### polling 절충

fixed polling은 전면 탭이 1,000ms마다 조회한다. adaptive polling은 서버가 응답에 넣는 `nextPollAfterMs`를 따른다: 대기 순번이 `5 × R` 이하이거나 이미 입장한 상태면 1,000ms, 그보다 뒤면 5,000ms이고, 여기에 ±20% jitter를 준 뒤 1,000–5,000ms로 자른다. 숨김 탭은 두 방식 모두 15초다.

A/B/C 비교에서 arm B와 C의 차이는 이것 하나였다. fixed는 status 요청이 249,395건, adaptive는 55,983건이었다(구매자 1,000명 전체의 요청, 3회 중앙값). fixed arm에서는 scheduler의 승격 달성률(대기자가 있는 동안의 승격 수 ÷ R이 허용한 수)이 67.92%에 머물렀고 adaptive arm은 98.01%였다(3회 중앙값. 사람 수의 비율이 아니며, 두 arm 모두 1,000명이 결국 전원 승격됐다). 조회 부하가 같은 1 CPU 인스턴스의 scheduler를 늦춘 것으로 읽지만, tick 간격 자체는 재지 않았다.

adaptive의 비용은 뒤쪽 대기자의 화면이 최대 5초 늦게 갱신된다는 점이다. 전면 탭의 입장 인지 지연을 상한 추정치의 p95로 2초 이하에 두는 것은 실험 목표였고 보장하는 SLO가 아니다.

### 채택하지 않은 것

아래는 구현하지도 측정하지도 않았다. 비교 실험의 결론이 아니라 범위를 정할 때의 판단이다.

- **재고 권한을 Redis로 옮기기.** 팔 수 있는 수량을 Redis에서 차감하면 PostgreSQL과 Redis 두 곳의 수량을 맞춰야 하고, Redis를 잃었을 때 재고를 복구할 절차가 필요하다. 대기 순서는 잃어도 다시 등록하면 되지만 재고는 그럴 수 없다. 이 프로젝트의 oversell 방어는 이미 PostgreSQL transaction과 제약으로 통합 테스트에 고정돼 있어, 그것을 유지하고 앞단에서 유입만 줄이는 쪽을 택했다.
- **메시지 큐.** 필요한 것은 등록 순서, 입장 예산, 사용자가 조회할 상태였고 기존 Redis로 만들 수 있었다. 구매 요청은 지금처럼 동기 응답으로 결과를 돌려준다. 큐를 두면 운영할 구성요소와 실패 지점(적재 유실, 중복 소비, 결과 통지)이 늘어난다.

- **구매 경로의 격리 수준이나 재시도를 바꾸기.** 대기열 없는 경로가 무너지는 원인은 SERIALIZABLE transaction이 직렬화 실패로 3회의 시도(재시도 2회)를 다 쓰는 것이다. checkout과 정산을 READ COMMITTED로 내리거나, 시도 횟수를 늘리거나, 구매 전에 이벤트 단위로 줄을 세우는 방법이 있다. 2026-10-10에 이 실패를 재현 테스트로 조사했고 제품 코드를 바꾸지 않기로 정했다([#27](https://github.com/dosacha/PeakPass/issues/27)). 격리 수준과 재시도 정책이 계약 §5에 고정돼 있어, 바꾸면 장애 검증과 부하 측정을 다시 해야 하기 때문이다. R을 올리게 되면 READ COMMITTED 전환을 먼저 시험하기로 했다. 그래서 "대기열이 이 방법들보다 낫다"는 근거는 없다.
- **WebSocket이나 SSE로 상태를 밀어 주기.** polling과 견준 기록이 없다. polling을 고른 근거는 위 표의 한 줄(새 연결 방식이나 서버 구성요소가 필요 없다)이 전부다.
- **scheduler를 HTTP와 다른 프로세스로 떼기.** fixed polling에서 승격이 늦어진 것을 조회 부하가 같은 1 CPU 프로세스의 scheduler를 늦춘 것으로 읽었지만, 분리한 구성은 시험하지 않았다.

같은 이유로 Redis Cluster와 새 인증 시스템도 범위 밖이다(계약 §1).

## 설정

| 항목 | 값 | 어디서 정하나 |
| --- | --- | --- |
| `ENABLE_ADMISSION` | 기본 `false` | 환경 변수(`.env.example`). 이 인스턴스에서 대기열 scheduler를 켠다. 이벤트 보호 여부가 아니다 |
| 이벤트 보호 | 기본 unprotected | PostgreSQL `admission_events.protected`. 동시에 보호하는 이벤트는 1개다(partial UNIQUE) |
| profile `admission-v1-seed` | R 2/s, batch 2, C 8, 입장 TTL 30초, claim 기한 15초, tick 250ms, 대기 lease 120초, 대기 최대 1,000명, epoch당 entry 10,000개, epoch 최대 24시간 | 코드 상수 `src/core/models/admission.ts`. 환경 변수로 바꾸지 않는다 |
| 대기열 API 한도 | 조회 120/분, 등록 10/분, 취소 10/분 (user·event·action별) | 계약 §7. 기존 구매 한도(5/분)와 별도다 |
| 전용 Redis | `--save "" --appendonly no --maxmemory-policy noeviction` | Redis 실행 인자. 다르면 입장 제어가 준비 상태를 열지 않는다 |

seed 값은 처음에 고정한 실험 가정이다. 운영 권고값이 아니며 쓰기 기준선에서 용량을 환산한 값도 아니다. R 2는 측정으로 찾은 값이 아니라 처음 가정이 pilot에서 남은 것이다. R이나 C를 올린 후보는 비교 측정의 pilot에서 구매 시도 실패율 기준을 맞추지 못해 채택하지 않았고, 후보는 모두 fixed polling으로만 시험했다([ISSUE_17_VALIDATION.md](records/ISSUE_17_VALIDATION.md)의 pilot 절. pilot 수치는 조건 선택용이다). 정식 측정에서 동시 입장 수는 C 8에 한 번도 닿지 않았고(표본 최대 3–5) 입장 TTL 만료도 0건이었으므로, C와 TTL의 값이 알맞은지는 이 측정으로 알 수 없다. polling 간격(1초와 5초), 경계(`5 × R`), jitter(±20%)는 정한 이유를 적은 기록이 없다.

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

**종료**(`src/main.ts`의 `gracefulShutdown`). SIGTERM·SIGINT를 받으면 먼저 Redis 연결을 끊는다. 그 순간부터 이 인스턴스의 Redis 명령은 실패한다. 이어서 sweeper와 scheduler를 멈추고, HTTP 서버를 닫아 진행 중인 요청의 응답을 기다린 뒤, PostgreSQL pool을 닫는다. 그래서 종료 중에 PostgreSQL에 commit된 구매는 이 인스턴스가 Redis에 반영하지 못한다. 응답은 DB 결과로 나가고, 슬롯은 claim 기한 뒤 다른 인스턴스의 reclaimer가 원장을 읽어 정리한다(장애 검증의 시나리오 K5: Redis 차단 → 결과를 reclaimer에 넘김 → HTTP 서버 종료 → PostgreSQL 종료 순서를 로그로 확인). 종료 중에 구매 요청에 답한 경우, client가 그 연결을 닫으면 약 3초에 끝났지만 keep-alive로 쥐고 있으면 약 73초가 걸렸다(장애 검증의 시나리오 K5·K5b와 그때 남긴 한계 F2, 로컬 관측. Node 18과 Fastify 기본 keep-alive timeout 72초). 진행 중인 요청이 없는 인스턴스는 유휴 keep-alive 연결이 하나 있어도 1초 안에 끝났다(2026-10-10 로컬 관측 1회). 종료 중에 답한 연결을 client가 keep-alive로 쥔 경우, 약 73초보다 짧은 grace period를 주는 orchestrator는 프로세스를 먼저 죽일 것이다(관측이 아니라 위 시간에서 나온 추론이다). 고치지 않은 한계다([#32](https://github.com/dosacha/PeakPass/issues/32)).

## 장애 때의 동작

| 상황 | 동작 |
| --- | --- |
| Redis에 닿지 않는다 | 신규 등록·승격·신규 구매가 닫힌다(503). 기존 rate limiter도 Redis가 없으면 예약·checkout(생성과 조회), webhook, GraphQL에 503을 반환한다. 이 동작은 입장 제어 이전부터 있었고 바꾸지 않았다. 그래서 DB에 결과가 남아 있는 요청도 HTTP로는 503을 받을 수 있다 |
| Redis가 재시작됐거나 대기열 데이터가 없어졌다 | 빈 대기열로 계속하지 않는다. generation을 올리고 새 epoch로 reset한다. 이전 입장 자격은 410을 받고 사용자는 다시 등록한다. 순번은 복원되지 않는다 |
| 입장한 뒤 구매하지 않는다 | 입장 TTL 30초가 지나면 만료되고 슬롯이 돌아온다 |
| 구매 응답을 잃었다 | 같은 요청을 다시 보내면 PostgreSQL 원장의 결과를 받는다. Redis 상태나 TTL과 무관하다 |
| 구매를 시작한 뒤 프로세스가 죽었다 | claim 기한 15초 뒤 reclaimer가 원장을 확인한다. 결과가 있으면 그것을 반영하고, 없으면 닫힘을 commit한 뒤에만 슬롯을 돌려준다 |
| 입장 필드가 있는 구매가 직렬화 재시도를 다 썼다 | 503 `ADMISSION_UNAVAILABLE`. 같은 identity로 다시 보내면 된다. A/B/C 비교의 fixed arm(B)에서 구매자 1,000명 전체의 시도 기준으로 15건이었다(3회 중앙값, 최소 10건, 최대 26건). 503으로 끝난 구매자는 없었고, 다시 보낸 요청이 한 번 더 503을 받은 경우가 두 run에서 2건씩 있었다 |
| 신규 입장이 멈춘 동안 진행 중이던 예약·주문 | 기존 예약의 checkout, 주문 replay, 결제 webhook은 입장 자격을 다시 요구하지 않는다 |

## 검증한 범위와 하지 않은 것

- **실제로 실행한 것.** 제품 이미지 컨테이너에 가한 Redis·PostgreSQL·프로세스 장애 26개 시나리오와 headless Chrome 시나리오(장애 검증, [ISSUE_16_VALIDATION.md](records/ISSUE_16_VALIDATION.md)), 같은 조건의 A/B/C 부하 비교([ISSUE_17_VALIDATION.md](records/ISSUE_17_VALIDATION.md)). 모두 로컬 host 한 대다.
- **합성하거나 주입한 것.** TTL·claim 기한 경과의 일부, Redis 반영 유실, 화면의 구매 오류 응답 일부는 필드를 직접 쓰거나 응답을 주입해 확인했다. 어느 것이 그런지는 각 단계의 검증 문서에 있다.
- **하지 않은 것.** 네트워크 분할, persistence나 replica가 있는 Redis, failover, 인스턴스 4개 이상, 다른 도착률, 실제 브라우저에서의 입장 인지 지연, 이탈과 취소가 섞인 부하, 다른 사람의 코드 리뷰(검토는 본인과 자동 리뷰 도구가 했다).

## 알려진 한계

- 동시에 보호하는 이벤트는 1개다. Redis 하나는 PostgreSQL DB 하나에만 붙어야 한다.
- 보호를 해제한 직후 다음 scheduler tick(250ms)과 배타 gate를 기다리는 동안 이전 상태가 응답될 수 있다.
- Redis 반영이 실패한 구매의 슬롯은 회수될 때까지 사용 중으로 남고, 그 시간에 상한이 없다.
- 데모 페이지는 프로세스마다 고정 사용자 1명이다. 스크린리더, 다른 브라우저, 모바일은 확인하지 않았다.
- seed profile에서 대기는 분 단위다(1,000명에 최소 500초). 2026-10-10에 이 대기 시간을 그대로 받아들이기로 정했고, 다시 측정하지 않는다([#34](https://github.com/dosacha/PeakPass/issues/34)). 이 대기는 DB의 처리 한계가 아니라 R 2라는 가정과, R을 올렸을 때 나타나는 구매 경로의 직렬화 실패에서 나온다.
- 보호 이벤트에서는 Redis가 판매의 단일 장애점이다. Redis에 닿지 않으면 신규 구매가 모두 닫힌다. 재고와 주문이 틀리지 않는 대신 치른 비용이다.
- 대기열 조회(status) 한 번은 Lua 스크립트 실행 한 번이고 대기 lease를 갱신하는 쓰기가 따른다. 대기자 수만큼 조회가 생기는 비용을 줄인 것이 adaptive polling이고, 조회 자체의 비용은 재지 않았다.
- 대기열이 적용되지 않은 이벤트의 대기열 조회는 요청마다 PostgreSQL transaction을 열고, 정책 행이 없으면 만든다. 이 경로는 대기열 API 한도 밖이다.
- settlement webhook의 rate limit은 구매 경로와 같은 한도(보낸 쪽 IP당 5회/분)다. 부하 측정에서는 올린 값으로 쟀다.
- 예약·주문 조회(`GET /reservations/:id`, `GET /checkouts/:orderId`)는 생성 요청과 같은 카운터(사용자당 5회/분)를 쓴다. 카운터는 action마다 따로여서, 예약을 다섯 번 조회하면 다음 예약 생성이 429가 되고 주문을 다섯 번 조회하면 다음 checkout이 429가 된다. Redis에 닿지 않으면 조회도 503이다. 장애 검증 때 이 한도를 그대로 두기로 정했고([기록](records/ISSUE_16_VALIDATION.md)의 "The purchase limit", 결정 D7), 계약 §2·§6이 조회의 기존 limiter 정책 유지를 정하고 있어 바꾸지 않았다.
- 예약 sweeper는 5분마다 200건씩 돌고 시작 직후에는 돌지 않는다. 만료된 예약이 좌석을 쥐고 있는 동안 입장한 구매자는 품절 거절로 입장을 쓴다.
- tier의 수량은 강제하지 않는다. 좌석은 이벤트 단위로만 지키므로 모든 좌석을 가장 싼 tier 가격으로 살 수 있다. 결제 금액도 대조하지 않는다.
- `cancelled` 주문에 온 `settled` webhook은 409로 거절되고 기록이 남지 않는다.
- GraphQL `ticketByCode`는 인증 없이 호출되고, 요청 하나에 alias로 여러 번 넣을 수 있다. 티켓 번호가 순차라 유효한 번호를 모을 수 있다. 공개 조회로 둘지는 정하지 않았다.

### 고치지 않고 받아들인 것

아래는 2026-10-10과 2026-10-11에 고치지 않기로 정한 것이다. 제품 코드와 계약은 바꾸지 않았다. 이 문서의 다른 절에 이미 적은 한계(예: 종료 지연, 직렬화 실패, polling 비용, "하지 않은 것"의 목록)는 되풀이하지 않는다. 줄마다의 근거와 상세는 괄호의 Issue에 있고, 측정하지 않은 값은 수치로 적지 않았다.

**수명주기와 scheduler ([#25](https://github.com/dosacha/PeakPass/issues/25))**

- 기능을 끈 인스턴스(`ENABLE_ADMISSION=false`)에는 scheduler가 없어 해제되거나 삭제된 이벤트의 대기열 상태를 정리하지 않는다. 남은 상태에는 404가 아니라 503으로 답한다. 계약 §3의 문언은 대기열이 적용되지 않은 이벤트에 404 `ADMISSION_NOT_ENABLED`를 말하므로, 이 줄은 계약 문언과 다른 구현의 동작을 적은 것이다. 기능을 켠 인스턴스가 하나도 없으면 그대로 남는다.
- 주인 없는 키의 정리는 tick마다 `SCAN` 한 페이지(`COUNT 100`)씩 진행한다. keyspace를 한 바퀴 도는 시간은 키 수에 비례하고, 재지 않았다.
- Redis 하나를 서로 다른 PostgreSQL DB의, 기능을 켠 인스턴스가 함께 쓰면, 한쪽의 정리가 그 DB에 보호 정책이 없는 이벤트의 키를 주인 없는 것으로 보고 지운다. 이 전제는 시작할 때 검증하지 않는다.
- 같은 이유로, 보호 정책 없는 이벤트로 대기열 키를 직접 만드는 테스트 fixture는 기능을 켠 인스턴스와 같은 Redis에서 동시에 돌리면 지워진다.
- epoch의 24시간 기한이 지나면 대기열 조회(status)와 취소(cancel)도 503으로 닫힌다. 계약 §4의 문언은 신규 등록·claim·승격의 중단만 말한다. 이 동작은 계약에 넣지 않고 여기에만 적는다.
- scheduler의 정책 조회는 tick마다 정책 테이블을 읽고(`protected OR phase='open'` 조건이라 partial index를 쓰지 못한다), 정리에 `SCAN`이 tick당 1회, 보호 이벤트가 준비 상태면 2회 든다. 이 비용은 재지 않았다.

**구매 경로 ([#27](https://github.com/dosacha/PeakPass/issues/27))**

- 입장 필드가 있는 구매는 보호 켜기나 reset이 배타 gate를 쥐고 있는 동안, 또는 정책 행이 없는 이벤트의 첫 확인이 event 행을 기다리는 동안 1초 뒤 503 `ADMISSION_UNAVAILABLE`로 답한다.
- 정책 행이 없는 이벤트의 첫 구매는 event 행을 기다리고, SERIALIZABLE checkout이 동시에 첫 구매를 하면 시도 1회를 그 경합에 쓴다.
- 원장 행 없이 내려진 신규 점유 거절은 transaction이 끝난 뒤 원장을 한 번 더 읽어 확인한다. 그 조회가 실패하면 거절 대신 503으로 답한다.
- Idempotency-Key 재전송은 주문을 checkout-key 잠금 없이 먼저 읽고, 주문이 있으면 event와 정책을 확인하지 않는다.
- code가 없는 driver 연결 오류가 구매 작업 안에서 나면 500으로 답한다.
- `orders.idempotency_key`의 23505는 새 transaction에서 다시 조회할 대상으로 분류하지 않았다. 같은 key의 checkout 세 개를 겹친 테스트는 수정 없이 10회 통과했고, 로그가 온전한 9회에서 PostgreSQL 16.12는 패자의 INSERT를 40001로 보고했으며 기존 재시도가 처리했다. 관측이며 23505가 나올 수 없다는 증명은 아니다.
- 구매 테스트 가운데 다른 요청이 쥔 잠금을 `lock_timeout` 1초 안에 얻어야 통과하는 케이스가 있다(main `7b12027`에 둘). runner가 그 구간에서 1초 멈추면 실패한다.

**대기 화면과 데모 페이지 ([#29](https://github.com/dosacha/PeakPass/issues/29), [#32](https://github.com/dosacha/PeakPass/issues/32))**

- 실제 브라우저로 만들어 보지 않은 경로: 503의 15초 최소 대기와 `Retry-After`(주입한 응답으로만 확인), 같은 id를 가진 두 서버 사이의 미확인 구매 복원, 같은 사용자의 두 탭이 동시에 전면인 경우, 24시간 epoch 마감, 대기열 가득(429 `ADMISSION_QUEUE_FULL`), trace 5,000건 초과, 다크 테마, 실제 네트워크 단절.
- 입장 인지 marker는 `localStorage`에 있고 탭 사이 transaction이 없어, 같은 사용자의 두 탭이 같은 입장을 중복 기록할 수 있다. 분석할 때 run·epoch·입장 자격마다 가장 이른 기록만 쓴다.
- trace는 메모리에만 있다. `snapshot()`을 읽기 전에 새로고침하면 그 인지 표본은 다시 기록되지 않는다. marker는 프로필당 최근 50개만 남는다.
- 데모 세션 요청은 5초 안에 답이 없으면 포기하고 다음 요청 때 다시 보내며, 시도마다 세션 요청 한도에 잡힌다. live mode에서 이벤트가 선택돼 있으면 페이지가 클릭 없이 `POST /demo/session`과 이벤트 조회를 보낸다.
- 복원된 미확인 구매는 "예약 불러오기"로 닫히지 않고 같은 요청을 다시 보내야 닫힌다. 새 예약을 불러와도 화면의 주문·정산은 남고, 이벤트를 바꿔도 화면의 예약은 남는다.
- checkout 응답을 잃은 뒤 새로고침하면 페이지는 그 주문에 다시 닿지 못한다(새 key는 409 `CONFLICT`를 받고, 주문은 결제 기한에 만료돼 좌석이 돌아온다).
- 페이지를 연 뒤에 보호된 이벤트는 새로고침 전까지 "대기열 미적용"으로 표시된다. 그동안의 구매는 400으로 거절되고 점유는 없다.
- 기존 팔레트의 색 대비가 낮은 곳이 있다(대기 카드의 라벨 4.38:1, 등록 버튼 4.24:1, 취소 확정 버튼 3.88:1). 팔레트는 바꾸지 않았다.
- 페이지와 API의 origin이 다르면 요청에 preflight가 붙을 수 있다. 대기열 API 한도에는 잡히지 않는다.

**reset, 로그, 승격 상한 ([#32](https://github.com/dosacha/PeakPass/issues/32))**

- scheduler의 정책 조회가 Redis 재시작과 다른 인스턴스의 복구 전체에 걸치면, 방금 복구된 상태를 낯선 것으로 보고 한 번 더 reset할 가능성이 있다(재시작 1회에 세대 2개). 정적 검토로만 본 가능성이고 재현하지 않았다.
- PostgreSQL pool 오류 로그에 driver의 client 객체가 남는다(연결 파라미터와 끝난 세션의 cancel key. 비밀번호는 없다).
- R은 epoch 하나의 상한이다(계약 §4). reset 직후의 새 epoch는 빈 승격 이력으로 시작하므로 같은 1초 안에 R건이 더 승격될 수 있다.

**장애 검증과 검증 코드 ([#32](https://github.com/dosacha/PeakPass/issues/32))**

- 실행하지 않은 것: claim 기한보다 긴 PostgreSQL 장애와 failover, 저장소의 disk·memory 한도, scheduler 3개 이상, 호스트 간 시계 차이, reset 수명주기 결함(F1) 둘째 형태의 컨테이너 재현, 수정 뒤의 민감도 6건 재실행. 브라우저 시나리오와 이미지 검사는 최종 이미지에서 1회씩이다.
- 장애 스위트의 일부 시나리오(K4, T1, M4, K1, K3, R1)는 타이밍 가정이 있어 부하가 큰 호스트에서 실패할 수 있다. M2, M3 후반, L4의 경합은 승자를 기록만 하고, reset 뒤의 두 번째 reset은 1.5–2초 동안만 살핀다. 전이 로그 재생은 `UNLINK`가 namespace의 set 하나만 지목해도 그 namespace를 버린다.
- 원장과 Redis entry를 대조하는 검증 helper(`src/tests/helpers/admission-ledger.ts`)는 fingerprint를 비교하지 않는다. 상태·operation·대상·code가 같고 fingerprint만 다른 쌍은 통과한다. 이 파일은 부하 하네스가 SHA256으로 고정하고 있어 고치지 않았다.

**부하 측정 ([#34](https://github.com/dosacha/PeakPass/issues/34), [#36](https://github.com/dosacha/PeakPass/issues/36))**

- A/B/C 비교는 도착 조건 1개(초당 50명 × 20초), 앱 인스턴스 1개(scheduler 1개), arm당 3회다. 정식 run은 전원이 전면 탭이었고, 숨김 탭 20%는 통계에서 뺀 관측 2회로만 봤다.
- 하네스의 검사 가운데 합성 입력으로만 확인한 것: `cancelled` 상태 응답의 형식 검사, Redis가 `MONITOR` 연결을 끊는 경우, dump 표시 뒤에 쓰기가 이어지는 캡처. `--arm` 없는 기본 실행이 invalid가 되는 것이 base `1bb2796`에서도 같았는지는 돌려 보지 않았다.
- 로컬 Node 18 컨테이너에서는 재생 script 검사가 skip된다(Windows에서 설치한 `node_modules`의 `tsx`가 Linux에서 변환하지 못한다).
- 검증 run `p8-verify-b-01`의 폴더에는 `monitor-replay.json`이 없어, 폴더만 다시 분석하면 invalid다. 자체 완결된 근거는 `p8-verify-b-02`다.
- 승격된 뒤 아무도 인지하지 못한 채 만료된 entry가 `admittedAt`을 잃으면 dump만으로는 대기 중 만료와 구분되지 않는다. 검증 run의 재생만 이를 본다.
- 앱 이미지는 run마다 다시 빌드해 id가 run마다 다르다. 재현 가능한 build가 아니다.
- `npm run test:flash-sale`이 새 worktree의 첫 실행에서 1회 실패한 적이 있다(44개 중 1개). 출력은 남지 않았고, 다시 시도했을 때 재현되지 않았으며 원인은 모른다.

단계별로 남긴 항목은 [#25](https://github.com/dosacha/PeakPass/issues/25), [#27](https://github.com/dosacha/PeakPass/issues/27), [#29](https://github.com/dosacha/PeakPass/issues/29), [#32](https://github.com/dosacha/PeakPass/issues/32), [#34](https://github.com/dosacha/PeakPass/issues/34), [#36](https://github.com/dosacha/PeakPass/issues/36)에 있다. 항목마다 고치거나 수용 결정을 적었고 Issue는 모두 닫혔다.

## 실험 재현

Node 18 이상, Docker Compose v2, k6, `npm ci`가 필요하다. 저장소 루트에서 실행한다. 실행마다 자체 PostgreSQL 16, Redis 7, 현재 코드로 빌드한 앱을 띄우고 끝나면 그 실행의 자원만 지운다. 빌드한 이미지(`peakpass:fs-<run id>`)와 결과 폴더는 남는다.

```sh
npm run build
npm run test:flash-sale
node load-test/flash-sale-fixture.mjs --run-id <새 id> --arm <a|b|c> --users 1000 --rate 50 --warmup-seconds 5 --pre-vus 1000 --max-vus 1000 --drain-seconds 900
```

- arm `a`는 대기열 없음, `b`는 대기열과 fixed polling, `c`는 같은 대기열과 adaptive polling이다.
- 이 조건의 부하 구간은 최대 920초다(도착 20초 + drain 900초). 분석기가 요청을 모두 메모리에 올리므로 비교 측정은 `NODE_OPTIONS=--max-old-space-size=6144`로 실행했다.
- 결과는 `load-test/results/flash-sale/<run id>/`에 생기고 git이 무시한다. 비교 측정이 남긴 증거는 `load-test/results/flash-sale-abc-v3/`(index와 ZIP 11개)다.
- 지표의 정의, 유효성 규칙, 종료 순서는 [측정 계약](FLASH_SALE_EVIDENCE.md)에 있다.
- 장애 스위트는 Docker가 필요한 opt-in이고 CI에서 돌지 않는다. 명령은 [ISSUE_16_VALIDATION.md](records/ISSUE_16_VALIDATION.md)의 "Commands"에 있다.
