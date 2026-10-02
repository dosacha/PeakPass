# Admission contract — admission-v1

작성일: 2026-10-02 KST. 소유 Issue: [P3 #12](https://github.com/dosacha/PeakPass/issues/12). 검토 기준 코드: `cad7a40065fe8ae1503a91f49d8e77ab3aa78181`.

이 문서는 후행 P4~P8이 구현·검증할 계약이다. 현재 제품 구현 또는 부하 검증 완료를 뜻하지 않는다. 수용 상태와 수용 SHA의 단일 기준은 [총괄 #9](https://github.com/dosacha/PeakPass/issues/9)의 상태표다. 결정·검토 범위는11절, 실제 최종 reviewer의 대상 hash와 수용 SHA는 [Issue #12](https://github.com/dosacha/PeakPass/issues/12)의 인계 기록에 둔다.

## 1. 입력 근거와 지원 범위

| 입력 | 수용 값과 용도 |
| --- | --- |
| P1 | `e0fbc78754e17dd6380b1a899373168c3ddf6153` / `flash-sale-v1` / `p1-reference-ample-01`, `p1-reference-ample-02`, `p1-reference-limited-01`. 저부하 정합성 근거 |
| P2 측정 | `flash-sale-v2.6`; ample9/limited01/preflight2는 `33a74de24cef2493bf4f8e473a695910fc404c42`, limited02/03은 `598ad50bc389b47bcbcfc0175359735671718fe1` |
| P2 분석 | `flash-sale-analysis-v2.6.1` / `598ad50bc389b47bcbcfc0175359735671718fe1` |
| 수용 인덱스 | [v261 index](../load-test/results/flash-sale-baseline-v261/index.json), 발행 SHA `891363fd44e38abb750c5212a984917d6844de26`, SHA256 `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6` |
| accepted runs | `p2-v26-ample-r2-01..03`, `p2-v26-ample-r10-01..03`, `p2-v26-ample-r25-01..03`, `p2-v26-limited-01..03`. preflight2는 제외 |

최신 main은 PR19/20/21을 포함한다. P2 발행 head와 위 main의 차이는 문서 인덱스와 핸드오프뿐이며 소비하는 코드·원본은 불변이다. [P2 보고](FLASH_SALE_BASELINE.md)와 [지표 정의](FLASH_SALE_EVIDENCE.md)의 현재 gate를 소비하며 v26 미완료 checkpoint나 이전 v2.3을 채택하지 않는다.

P2의 충분 재고 2/10 buyer/s는 각3회 안정, 25/s는 과부하2회·안정1회이며 strict smoke는 전체3회 실패했다. 25/s cohort paid는739/628/748 of750, pending9/165/45, hold10/196/16석이다. 제한 재고10/s·300명·60석의3회는 각각30paid/60tickets/270품절이다. 최대 처리량, DB 단독 포화, 큐 효과, 운영SLO, R/C/TTL 적정값은 입증하지 않았다.

**admission-v1 범위:** 단일 Redis와 PostgreSQL, 동시에 보호하는 이벤트1개, 동일 계약 대응 버전의 여러 app/worker를 허용한다. 측정은 해당 이벤트의 합성 트래픽으로 제한한다. 다른 이벤트·일반 업무의 혼합 부하 및 다중 이벤트 총량 배분은 미지원이며 도입하려면 새 revision과 A 재검증이 필요하다. 인증·재고 권한 이동, MQ, Redis Cluster는 추가하지 않는다.

아래 규칙·수치는 v1의 실험 계약이며 위 P2에서 용량을 환산한 값이 아니다.

## 2. 결정과 현재 코드 경계

PostgreSQL은 재고·예약·주문·결제·admission 소비 결과의 권위다. Redis는 대기 순서·활성 자격·입장 예산·조회 상태를 관리한다. Redis 토큰 선삭제와 reservation/order 각각의 독립 UNIQUE만으로 소비를 구현하지 않는다. 두 신규 점유 경로가 공유하는 영속 원장 하나를 사용한다.

| 경로 | 입장 정책 |
| --- | --- |
| 신규 `POST /reservations` | 보호 이벤트면 admission 필요. 원장·예약·재고를 같은 PG transaction에서 commit |
| 기존 주문이 없는, reservation 없는 `POST /checkouts` | 보호 이벤트면 admission 필요. 원장·주문·pending payment·재고를 같은 PG transaction에서 commit |
| 기존 reservation checkout | 실제 DB의 user/event/tier/quantity/active/expires_at 조건을 만족해야 면제. 무효 reservation에서 direct checkout으로 fallback하지 않음 |
| 기존 주문 replay | 기존 key·소유권·fingerprint 검증 후 현재 order/tickets 반환. admission TTL/reset과 무관 |
| 결제 webhook/demo settlement·조회·sweeper | 신규 admission을 요구하지 않음. 기존 인증·소유권·callback·limiter 정책 유지 |

현재 근거: [예약 transaction](../src/core/services/reservation.service.ts), [checkout의 replay/예약 전환/신규 점유](../src/core/services/checkout.service.ts), [middleware 순서](../src/api/app.ts), [멱등 scope](../src/api/middleware/idempotency.ts). 현재 reservation에는 durable 멱등성이 없다. checkout은 Redis 성공 캐시를 재생하지 않고 DB를 읽으며 payment만 fingerprint가 맞는 캐시를 사용할 수 있다. 첫 `duplicate:false` callback 응답의 그대로 replay를 변경하지 않는다.

새 gate는 전역 middleware나 `InventoryService` 전체에 넣지 않는다. 입력·인증은 route에서 검증하고, 두 service의 신규 점유 분기를 공통 소비 함수로 연결한다. 기존 `PoolClient`를 전달하며 transaction 도중 두 번째 pool connection을 얻지 않는다.

## 3. API와 identity

모든 admission API는 JWT의 사용자 ID를 요구한다. body의 userId와 demo 설정으로 인증을 우회하지 않는다. UUID 입력은 소문자로 정규화하고 수량은 기존 양의 정수 제한을 따른다. JSON의 불필요한 필드는 거절한다. 응답에는 `Cache-Control: no-store`를 적용한다.

| Method/path | 입력 | 성공과 반복 의미 |
| --- | --- | --- |
| `GET /events/:eventId/admissions/me` | body 없음 | 200 현재 queue와 본인의 마지막 entry. entry가 없으면 `admission:null`. 정상 조회는 PG 연결을 사용하지 않음 |
| `POST /events/:eventId/admissions` | `{epoch: UUID, joinRequestId: UUID}` | 최초201, 같은 user/event/epoch/joinRequestId는 terminal까지 같은 entry로200. 다른 joinRequestId인데 waiting/admitted/claim이 있으면409와 현재 snapshot |
| `DELETE /events/:eventId/admissions/:admissionId` | `{epoch: UUID}` | 취소 전이가 commit된 Redis snapshot을200. cancelled/expired 반복도200. claimed/consumed는409 |

등록 전 GET으로 현재 epoch를 얻는다. 동일 joinRequestId는 이벤트와 epoch 안에서 인증 사용자에게 결박한다. 타인이 같은 joinRequestId를 제출하면409이며 기존 entry를 노출하지 않는다. 취소·만료·consumed 뒤 의도적 새 구매는 새 joinRequestId로 등록하고 항상 뒤 순번을 받는다. 새로고침은 GET으로 복구하며 자동으로 새 구매를 만들지 않는다. 다른 key로 active 등록을 시도한409는 현재 상태를 안내하지만 그 key의 성공/alias를 생성하지 않는다. join retry도 등록 limiter를 소모하며429일 때 별도 GET으로 현재 등록을 확인할 수 있다.

공통 성공 body는 다음 구조다. queue와 admission의 epoch가 다른 응답을 만들지 않는다.

```text
{
  contractRevision: "admission-v1",
  serverTime: UTC ISO-8601 milliseconds,
  queue: { eventId: UUID, epoch: UUID, mode: "open" },
  admission: null | {
    admissionId: UUID, epoch: UUID, state: waiting|admitted|consumed|cancelled|expired,
    phase: idle|processing|reconciling,
    sequence: decimal string, position: positive integer|null,
    joinedAt: timestamp, admittedAt: timestamp|null,
    expiresAt: timestamp|null, reason: string|null,
    outcome: null|{kind: reservation|direct-checkout|rejected, resourceId: UUID|null, code: string|null}
  },
  nextPollAfterMs: integer|null
}
```

`sequence`는 해당 epoch에서 최초 등록 순번이며 바뀌지 않는다. `position`은 응답 시점 waiting ZSET의 1-based rank이며 waiting 외에는 null이다. waiting의 expiresAt은 이탈 lease, admitted/claim은 입장 유효기한, terminal은 null이다. phase는 admitted에서만 processing/reconciling을 가질 수 있고 그 외 idle이다. admission null/terminal이면 nextPollAfterMs는 null이다. 성공 구매 응답은 기존 reservation/order schema를 유지한다. Redis의 outcome는 DB 결과의 안내용 참조이며 구매 성공 판정은 구매 API/DB 결과로 한다.

신규 예약·direct checkout에는 `{admissionId: UUID, admissionEpoch: UUID}`를 기존 body에 추가한다. 보호된 신규 점유에서 둘 다 필수이며 한쪽만 제출하면400이다. 기존 주문/예약 경로는 생략 가능하다. 제출했다면 기존 영속 연결과 다른 값은409이고, 같은 값의 TTL/reset은 기존 결과를 막지 않는다. rollout 이전의 admission 연결 없는 기존 주문/예약에는 새 자격을 결박하지 않는다.

| 오류 | 의미·재시도 |
| --- | --- |
| 400 `ADMISSION_INVALID_INPUT` | 형식·필드 오류. 수정 전 자동 retry 없음 |
| 401 `UNAUTHENTICATED` | 인증 필요 |
| 404 `ADMISSION_NOT_FOUND` | 없는 ID 또는 타인/event ID 조회·취소·소비. 자격 존재를 노출하지 않음 |
| 409 `ACTIVE_ADMISSION_EXISTS` | 다른 join key의 active entry. 본인 snapshot 포함, 새 등록 생성 없음 |
| 409 `ADMISSION_NOT_READY` | waiting 자격으로 구매 시도. 상태 조회로 복귀 |
| 409 `ADMISSION_REQUEST_MISMATCH` | 같은 ID의 다른 command/payload/checkout key 또는 기존 연결과 다른 ID |
| 409 `ADMISSION_IN_PROGRESS` | 같은 논리 요청 처리 중 또는 취소 불가. 같은 요청만 retry 가능 |
| 409 `ADMISSION_ALREADY_CONSUMED` | consumed 취소 시도. 구매 취소 기능으로 해석하지 않음 |
| 410 `ADMISSION_EXPIRED` / `ADMISSION_CANCELLED` / `ADMISSION_RESET` | 신규 소비 불가. durable 결과 확인이 우선이며 결과 불명 상태에서 새 구매를 자동 생성하지 않음 |
| 429 `ADMISSION_RATE_LIMITED` / `ADMISSION_QUEUE_FULL` | endpoint 또는 대기/보존 건수 제한. `Retry-After` 제공 |
| 503 `ADMISSION_UNAVAILABLE` / `ADMISSION_RECOVERING` | 신규 입장 fail-closed. 지수 backoff, 동일 identity 유지 |
| 기존 업무 오류 | `INSUFFICIENT_INVENTORY` 등 기존 코드·HTTP 상태 유지. 5절의 영속 rejected 결과로 재생 |

오류 envelope는 `{error:{code,message}, nextPollAfterMs: integer|null}`이고409 ACTIVE에만 본인 admission snapshot을 덧붙인다. 429의 Retry-After는 초 단위 올림이고 nextPollAfterMs 이상을 기다린다. 신규 queue 미적용 이벤트의 admission API는404 `ADMISSION_NOT_ENABLED`; 기존 구매는 기존 흐름이다. recovering이면 GET도503이며 stale 상태를 성공으로 반환하지 않는다. 등록의 stale epoch는410이며 현재 자격을 조용히 생성하지 않는다.

## 4. Redis 상태와 원자 작업

공정성은 **동일 epoch의 원자적 등록 완료 순서 → 승격 순서**다. 구매 성공 순서·네트워크 발신 순서·좌석 확보는 보장하지 않는다. 각 epoch의 INCR sequence와 waiting ZSET을 사용한다. 같은 timestamp여도 sequence는 중복되지 않는다. sequence가 JS/Redis score의 정확한 정수 범위를 넘기 전에 신규 등록을 닫고 reset한다.

| 전이 | 조건과 선형화 지점 |
| --- | --- |
| 없음→waiting | user/event active 중복·join key·저장 상한 검사, sequence 배정, entry/index/ZSET 저장을 한 Lua에서 수행 |
| waiting→admitted | 이탈 만료를 제외한 최저 sequence부터 공유 R/C 검사·waiting 제거·active 추가·admittedAt/TTL 설정을 한 Lua에서 수행 |
| waiting/admitted idle→cancelled | claim보다 먼저 취소 Lua가 상태를 변경했을 때. 대기/active에서 정확히1회 제거 |
| waiting→expired | leaseUntil <= Redis server now. heartbeat와 같은 atomic 조건으로 경합 |
| admitted idle→expired | expiresAt <= now. 신규 claim 금지·슬롯 반환 |
| admitted idle→processing | 유효기한 전에 claim Lua가 승인. 최초 command fingerprint를 고정하고 claim token/deadline 저장. C에서 제거하지 않음 |
| processing→reconciling | 처리 기한 경과 또는 결과 불명. 상태만 변경하며 C 유지 |
| processing/reconciling→consumed | PG consumed/rejected 결과를 확인하고 ID/epoch/token CAS로 반영한 때. C에서 정확히1회 제거 |
| processing/reconciling→expired | PG closed 기록 또는 epoch barrier로 이후 신규 commit 불가를 확정한 뒤에만 회수 |

승격, 취소, claim, 만료는 동일 Redis 상태를 원자적으로 비교한다. claim 승인 시점에 `now < expiresAt`이면 그 이후 TTL이 지나도 이미 시작한 동일 작업의 PG commit을 허용한다. 이는 commit까지 TTL이 남아 있다는 보장이 아니다. claim은 처음 승인된 fingerprint에 묶이고 갱신으로 유효기한을 연장하지 않는다.

키 prefix는 `peakpass:admission:<eventId>:`이다. epoch별 entry/index/waiting/active/claims/promotion-window와 제어 metadata를 별도 namespace로 둔다. 기존 rate limiter/hold 키를 재사용하지 않는다. 회원 identity는 JWT 문자열이 아닌 user ID다.

| 데이터 | 보존·상한 |
| --- | --- |
| waiting | 최대1,000 entry; 이탈 lease120초; 만료·취소·승격 시 제거 |
| admitted + unresolved claim | 합계 C=8; claim은 TTL만으로 삭제하지 않음 |
| entry + joinRequestId 매핑 + 본인 마지막 entry index | terminal도 현재 epoch가 끝날 때까지 보존. epoch당 총 entry10,000개; active 다른 key 충돌은 새 entry를 만들지 않음 |
| 승격 history | rolling1초의 성공 승격만, R=2개 이하; 빈 집합 sentinel로 초기화 여부 구분 |
| epoch | 최대24시간 실험 세션. 기한 뒤 신규 등록·claim·승격 중단, 6절 reset 후 재등록. 기존 DB replay는 유지 |
| retired epoch namespace | durable epoch 전환 완료 뒤 bounded cleanup. old epoch 요청은 mapping을 삭제해도410 |
| endpoint limiter | user/event/action별 sliding60초, 마지막 요청 뒤 window TTL; 정상 구매 limiter와 별도 action |

상한은 메모리 안전을 실측한 값이 아니라 bounded 실험 조건이다. full에서도 같은 join key 조회는 기존 entry를 반환하며 새 unique join만429로 거절한다. 자동으로 terminal을 지워 새 자격을 만들지 않는다. cleanup은 tick당 최대100개이며 한 명령에서 무한 drain하지 않는다. 시간 경과로 만료된 entry는 조회/등록 경계에서도 논리적으로 만료 처리한다. 선두의 만료 entry 청소가 batch를 채우면 그 tick은 승격을 줄이고 다음 tick에 계속한다.

v1의 전용 Redis는 `maxmemory-policy=noeviction`, AOF/RDB persistence 비활성으로 운영한다. 이 설정을 확인할 수 없으면 admission readiness를 열지 않는다. OOM/WRONGTYPE/필수 metadata·index 손실은503 및 epoch 복구 대상으로 취급한다. 기존 cache miss처럼 빈 대기열로 초기화하지 않는다. 백업 복원·부분 key 임의 삭제·영속 Redis에서의 과거 snapshot 복원은 v1 지원 범위가 아니다. 기존 limiter와 달라지는 Redis 설정은 P8 환경 manifest/A 재측정에 포함한다.

## 5. PG 소비·멱등성·claim 회수

DB 객체 이름은 후행의 공통 인터페이스다. P4는 `admission_events`, P5는 `admission_results`를 추가한다. 최신 migration011 다음 번호를 순서대로 사용하며 기존 migration을 수정하지 않는다.

| 객체 | 필수 제약 |
| --- | --- |
| `admission_events` | event_id PK/FK; protected boolean 기본false; generation bigint 증가; epoch UUID; phase recovering/open; epoch_started_at; Redis namespace 식별. migration에서 기존 event를 백필하고 새 event는 gate 아래 lazy ensure. 행 부재를 보호 우회로 해석하지 않음 |
| `admission_results` | admission_id PK; user_id/event_id FK; epoch; operation reservation/direct-checkout; canonical fingerprint; outcome consumed/rejected/closed; reservation_id/order_id FK; error_code/http_status; created_at |
| 결과 CHECK | consumed는 operation에 맞는 reservation 또는 direct-order 참조 정확히1개와 error 없음. rejected/closed는 참조0개와 error 필수. identity/outcome는 commit 후 불변 |
| 결과 대상 | non-null reservation_id와 order_id 각각 UNIQUE. user/event/operation/수량/tier가 실제 대상과 일치하는지 같은 transaction에서 검증 |

fingerprint는 동일한 함수로 canonical JSON array를 만든다: `[userId,eventId,epoch,operation,tierId,quantity,checkoutKeyOrNull]`. UUID 소문자, checkout key는 기존 trim 규칙, reservation command의 checkoutKey는 null. 가격은 서버 계산이므로 포함하지 않는다. admission ID는 원장의 PK로 별도 결박한다. 새 reservation의 retry 키는 admission ID다. direct checkout은 기존 Idempotency-Key도 유지하며 다른 key로 admission을 재사용하면409다.

**잠금 순서:** 모든 신규 점유/정책 전환을 포괄하는 event admission gate → policy 행 잠금 → admission별 잠금(해당 시) → 기존 checkout-key 잠금(해당 시) → 기존 reservation/event row lock 순서. 반환·결제·기존 예약 전환은 기존 row 순서를 유지하며 admission 잠금을 뒤늦게 얻지 않는다. 두 advisory gate는 PostgreSQL transaction-level two-int namespace를 각각 사용하고 기존 checkout의 bigint key 공간과 분리한다. event gate는 consumer/reclaimer shared, 정책 전환/reset exclusive; admission 잠금은 exclusive이다. policy는 consumer/reclaimer가 FOR SHARE, 정책 변경자가 FOR UPDATE/UPDATE로 잠근다. hash 충돌은 직렬화만 늘리고 correctness를 바꾸지 않아야 한다. [PG16 advisory lock 의미](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)를 따른다.

SERIALIZABLE snapshot은 advisory lock 대기 후에도 자동 갱신되지 않는다. gate 아래 같은 transaction에서 먼저 event 존재를 확인하고 없는 event는 기존 Event404로 끝낸다. 존재하는 event에는 `INSERT ... ON CONFLICT DO NOTHING`으로 default-unprotected policy 행을 ensure한 뒤 반드시 `SELECT ... FOR SHARE`로 읽는다. 이 읽기는 savepoint 이전이며 commit/rollback까지 유지한다. 존재하는 event의 policy SELECT 결과0행만503이고 legacy 통과가 아니다. 동시 event 삭제로 policy의 event FK23503이 발생하면 rollback 후 새 transaction에서 존재를 재확인하여 없는 event는404로 매핑하며 다른 FK 오류를 숨기지 않는다. 동시 activation의 INSERT/UPDATE가 snapshot보다 새로우면40001을 전체 새 transaction으로 재시도한다. activation/reset/disable은 같은 policy 행을 실제 UPDATE하며 삭제하지 않는다. advisory lock만 얻고 plain SELECT의 오래된 false/행 없음으로 보호를 우회하지 않는다.

신규 consumer 알고리즘:

1. route의 인증/schema를 검증한다. checkout의 기존 주문 replay 또는 검증된 reservation 전환은 기존 계약으로 분류한다. 단순 body reservationId 존재만으로 면제하지 않는다.
2. 신규 점유 후보는 PG transaction에서 event shared gate를 얻고 위 ensure+FOR SHARE로 durable 보호 정책을 읽는다. 이 단계는 정책을 읽을 뿐 기존 결과 replay를 거절하지 않는다. legacy/unprotected도 이 gate 아래 정책을 확인하여 동시 activation과 직렬화한다.
3. admission이 있으면 admission 잠금 아래 durable 결과를 먼저 읽는다. row의 owner/event가 요청과 다르면404로 끝내고 존재를 노출하지 않는다. 동일 owner/event 안에서 operation/tier/수량/key/epoch 등 identity가 다르면409다. 일치한 consumed는 현재 target DB 상태로 replay, rejected는 저장 오류, closed는410이다. 이 결과 복구에는 현 Redis·epoch·TTL을 요구하지 않는다. 기존 checkout key replay도 기존 fingerprint 검사를 유지하며 제출된 admission 연결이 다르면409다.
4. 아직 신규 점유가 필요하면 보호된 event의 기능 off/phase recovering은503, epoch 불일치는410이다. ENV off만으로 보호를 해제하지 않는다. Redis entry의 owner/event 및 최초 claim 가능한 admitted idle 또는 동일 fingerprint의 미완료 claim을 검증한다. claim Lua를 **PG admission 잠금을 보유한 상태에서** 실행한다. 첫 claim은 입장 TTL 안에서 token/fingerprint/deadline을 고정한다. 같은 claim의 retry는 최초 claim deadline 안이면 admission TTL이 지났어도 기존 token으로 재개하며 기한을 연장하지 않는다. 다른 요청은409다. claim 유효성 확인에 실패하면 PG에서 아무 점유도 만들지 않는다.
5. savepoint를 만들고 기존 점유 service를 실행한다. 성공하면 target 참조와 consumed 결과를 같은 transaction으로 commit한다. 품절·판매 종료·존재하지 않는 tier 등 확정 업무 거절이면 savepoint까지 rollback하고 동일 fingerprint의 rejected 결과를 commit한다. 형식/인증/타인·payload 충돌은 claim 전에 거절하며 결과를 생성하지 않는다. DB 연결·40001·40P01·unknown 5xx는 업무 거절로 저장하지 않는다.
6. commit 뒤 token CAS로 Redis 결과/슬롯을 반영한다. 실패해도 commit된 결과를 rollback하거나 다시 점유하지 않는다. HTTP 응답을 이미 만들 수 있으면 DB 결과를 반환하고 실패를 관측하며, 응답이 유실되면 같은 요청으로 복구한다.

PG 결과를 읽는 replay는 recovering/epoch 거절보다 먼저 처리한다. 위 2절의 보호정책 검사는 **새 점유가 남아 있는 경우에만** 거절한다. Redis에 claim만 남고 PG 결과가 없는 retry는 admission 잠금 아래서 새 transaction으로 재검증하며, 최초 claim deadline까지 동일 작업을 재개할 수 있다. 같은 claim에서 transient rollback 후 fingerprint를 바꾸거나 TTL을 갱신하지 않는다.

기존 `serializableTransactionWithRetry`의40001/40P01 재시도는 매번 새 snapshot으로 전체 검증을 반복한다. admission 결과의23505 경합은 해당 제약만 분류하여 transaction을 rollback한 뒤 새 transaction으로 결과를 재조회한다. 다른 UNIQUE 오류를 무조건 성공 replay로 취급하지 않는다. 보호된 예약도 같은 재시도/직렬화 계약을 적용한다. 최대 시도3회, 지연은 기존20ms 지수+jitter 정책을 재사용한다. 모두 실패하면503, 동일 요청의 identity를 보존한다.

claim 처리 기한은 최초 승인부터15초다. 기한은 새 DB 소비 시작/재시도 승인 마감이며 이미 잠금을 보유한 transaction을 강제로 만료시키지 않는다. transaction에는 statement_timeout=5초, lock_timeout=1초, idle_in_transaction_session_timeout=10초를 local로 설정한다. HTTP 종료·timeout은 DB rollback 확인과 동의어가 아니다. DB 장애/진행 중 lock 때문에 recovery가 지연되면 C를 유지하고 가용성을 줄인다.

reclaimer는 기한이 지난 claim을 최대8개 조회하고 event shared gate→admission `try` lock 순서로 처리한다. lock을 얻지 못하면 건너뛰며 다른 claim을 처리한다. 새 transaction의 ledger에 consumed/rejected가 있으면 그 결과를 Redis에 반영한다. 결과가 없고 동일 epoch/token/fingerprint의 기한 경과 claim임을 확인했다면 closed(`ADMISSION_EXPIRED`)를 commit한 뒤 Redis 슬롯을 반환한다. 이후 멈췄던 consumer는 동일 잠금 아래 closed를 읽어 점유하지 못한다. **결과0행·lease 만료·finally만으로 슬롯을 반환하지 않는다.** DB 결과 확인 또는 closed commit이 불명확하면 슬롯을 유지하고 재확인한다.

영속 consumed/rejected/closed는 v1에서 자동 삭제하지 않는다. 연결 대상 데이터도 결과 복구 기간 중 삭제하지 않는다. 실험 정리는 app/worker 종료와 epoch fence 뒤 run 소유 데이터만 제거한다. 운영 retention 도입은 늦은 writer·replay 방지 조건을 검증한 별도 revision이다.

## 6. 장애·reset·활성화

Redis 불가 시 신규 등록·승격·신규 점유는 fail-closed이다. 기존 DB 결과/예약/결제는 admission이 면제되지만 기존 limiter는 유지한다. 현재 production limiter가 Redis 불가 시 reservations/checkouts/webhooks/GraphQL에503을 반환한다는 사실을 바꾸지 않는다. DB 복구 가능성과 실제 HTTP 가용성을 구분한다.

PG epoch는 단순 SELECT 비교만으로 fence가 되지 않는다. consumer/reclaimer가 동일 event shared gate를 transaction 종료까지 유지하고 reset이 exclusive gate를 얻어야 한다. 논리적 cutover 전에 gate를 얻은 transaction은 완료할 수 있다. Redis가 물리적으로 죽은 시각 이후 old commit이0개라는 보장은 하지 않는다.

reset 절차는 다음과 같다.

1. Redis가 사용 가능하면 expected generation/epoch CAS로 현재 namespace를 frozen으로 바꿔 등록·승격·새 claim을 닫는다. Redis 불가이면 명령이 실패하는 상태 자체가 신규 진입을 막는다. 준비되지 않은 연결/namespace는 admission 명령을 받지 않는다.
2. PG event exclusive gate를 얻어 기존 consumer/reclaimer 종료를 기다린다. 최신 policy를 다시 읽고 generation을 증가시켜 새 UUID epoch와 recovering을 commit한다. 이전 epoch로 늦게 들어오는 신규 consumer는 이후 거절된다. 기존 durable 결과는 그대로 둔다.
3. 초기화자는 다시 exclusive gate와 policy 행 잠금을 잡고 여전히 같은 generation/epoch/recovering인지 확인한다. 새 Redis namespace와 control을 initializing으로 준비한다. publication은 generation CAS이며 낮은 generation으로 덮어쓰지 않는다. 같은 generation 초기화는 이미 만들어진 데이터를 지우지 않는 멱등 작업이다. PG phase를 open으로 commit한다.
4. ready 공개는 **새 PG transaction에서 exclusive gate와 policy 행 잠금을 다시 얻고** current generation/epoch/open을 확인한 상태에서 실행한다. Redis CAS는 같은 generation/epoch의 `initializing→ready`만 허용하고 frozen은 열지 않는다. 이미 ready면 멱등 성공이다. PG gate 보유 중 CAS를 마친 뒤 transaction을 끝낸다. 그 전에 죽으면503으로 유지하고, 재시작 coordinator가 이 단계를 재개한다. 초기 데이터를 지우지 않으며 늦은 coordinator의 과거 generation 또는 frozen 공개는 no-op이다.
5. retired Redis namespace는 이후 bounded cleanup한다. 이전 자격은410 RESET, 사용자는 GET으로 새 epoch를 확인한 뒤 명시적으로 재등록한다. 순번 복원은 보장하지 않는다. 결과 불명 구매는 새 join 전에 원래 구매 요청을 재시도해 DB 결과를 확인한다.

서버 재시작·연결 복구 시 Redis의 새 프로세스/필수 namespace 부재는 위 복구 대상이다. v1은 persistence가 꺼져 있으므로 restart 뒤 저장된 과거 queue를 그대로 신뢰하지 않는다. partial 초기화도 not-ready이며 Lua는 필수 metadata·sentinel의 일치를 검사한다. 동시 reset은 PG gate와 generation으로 직렬화한다. 같은 손실을 관측한 coordinator는 최신 세대가 이미 복구됐다면 다시 세대를 올리지 않는다.

활성화/비활성화 역시 event exclusive gate를 사용한다. 보호 이벤트 최대1개는 `admission_events`의 `UNIQUE(protected) WHERE protected` partial index로 보장한다. 모든 serving instance가 v1 소비 gate를 구현한 뒤에만 활성화한다. 구버전과의 mixed deployment는 지원하지 않는다. feature 기본값은 off이며 P4 단독에서는 보호를 활성화하지 않는다. P5 통합 후 명시적인 event activation으로만 켠다. worker/기능 off 인스턴스가 보호 이벤트를 받으면 신규 점유503, DB에 이미 있는 예약·주문은 기존 검증으로 진행한다. 보호 해제는 명시적 전환이며 ENV 변경만으로 해제하지 않는다.

## 7. 실험 profile과 polling

아래 값은 `admission-v1-seed`로 사전 고정한 초기 검증 설정이다. 운영 용량 권고나 P2의 최대 처리량 주장이 아니다. 설정을 바꾸면 profile revision/run manifest와 영향받는 계약 검증을 먼저 갱신한다.

| 설정 | seed 값 | 의미·선택 이유 |
| --- | --- | --- |
| R | 2 admissions/s | low-load 흐름을 관찰할 출발 가정. `(t-1000ms,t]` 성공 승격 합계<=2 |
| C | 8 | admitted idle + unresolved claim의 보수적 슬롯 수. DB pool10에서 환산한 값이 아님 |
| admission TTL | 30초 | 최초 승격부터 claim 승인까지. 인지/행동/오류 비용을 pilot로 평가 |
| claim deadline | 15초 | 재시도 시작 마감과 orphan 탐지. PG 진행 중 작업의 강제 취소 시각 아님 |
| tick / 승격 batch | 250ms / 최대2 | 모든 worker가 같은 Redis R/C 예산 사용. 지연 tick의 과거 예산을 적립하지 않음 |
| waiting lease | 120초 | 성공한 본인 GET 또는 동일 join retry가 waiting일 때만 갱신. rank/sequence 불변 |
| fixed B | foreground1,000ms | jitter 없음 |
| adaptive C | foreground1,000~5,000ms | 서버 base에 uniform[-0.2,+0.2] jitter 적용 후 같은 범위로 clamp |
| hidden | B/C 공통15,000ms | 브라우저 throttling으로 더 늦어질 수 있음. 복귀 시1회 조회 |
| endpoint limit | 조회120/분, 등록10/분, 취소10/분 | user/event/action별. 기존 구매5/분과 분리; 중복 적용 금지 |
| max waiting / entries | 1,000 / 10,000 per epoch | bounded 실험. full 시429, 기존 상태 조회 보존 |
| epoch session | 최대24시간 | terminal join mapping을 세션 동안 보존. reset 전에는 재사용하지 않음 |

Redis `TIME`이 admission/lease/R의 기준이다. process별 Date.now로 승격 예산을 따로 만들지 않는다. C는 DB transaction·pending 주문·held 좌석의 동시성 상한이 아니다. 소비 후에는 예약/주문이 계속 남는다. 현재 예약TTL300초·주문 결제창 기본10분은 변경하지 않는다. 아무도 소비하지 않으면8명이 C를 채운 뒤 만료/취소까지 승격이 멈춘다. R은 목표 처리량이나 달성 보장이 아니다.

서버 polling base는 waiting position이 `5*R` 이하면1,000ms, 그보다 멀면5,000ms이다. admitted idle/processing/reconciling은1,000ms, terminal은null이다. fixed는 base와 무관하게1,000ms, adaptive는 `clamp(base*(1+u),1000,5000)`이다. hidden 정책과 오류 backoff는 B/C에서 동일하다. 응답의 `nextPollAfterMs`는 adaptive base 또는 오류의 최소 대기 지침이며 naming은 이것 하나로 고정한다.

각 탭은 이전 요청 완료 뒤 다음 timer를 예약한다. 요청 timeout5초, 네트워크/503 backoff는1→2→4→8→15초 상한에 jitter±20% 후최대15초, 정상 응답이면 초기화한다. 429와503 모두 최종 대기는 `max(jitteredBackoff, 유효한 Retry-After, nextPollAfterMs)`이며 서버 최소 대기는15초 cap보다 우선한다. 오류/429/503은 lease를 갱신하지 않는다. AbortController와 함께 user/event/admission/epoch 및 로컬 요청 generation을 비교해 늦은 응답을 버린다. 로그아웃·event 전환은 timer/request를 정리한다. 재접속은 GET이며 unknown 구매를 새 key로 재전송하지 않는다.

입장 인지는 Redis admittedAt부터 브라우저가 admitted를 적용한 시점까지다. `(runId,epoch,admissionId)`별 최초 적용1회만 표본으로 세고 반복 polling·다중 탭·새로고침은 중복 집계하지 않는다. 승격 당시 foreground/connected 여부와 이후 visibility 전환을 기록해 층을 나눈다. foreground/connected p95<=2초는 **기각 가능한 실험 목표**다. 최대5초 polling과 취소/만료에 의한 급승격 때문에 보장되는 SLO가 아니다. hidden/재접속은 별도 층으로 모두 공개하고, 미인지 만료자 수와 전체 승격자 분모를 함께 기록한다. 서버 시각·요청 송수신·브라우저 monotonic 시각으로 오차 구간을 기록한다. 서버 poll 응답 시각만 측정한 값은 실제 브라우저 인지와 구분한다.

## 8. 실패 표와 필수 검증

이 표는 후행에서 실행할 요구이며 이번 P3에서 실행한 결과가 아니다.

| ID | 검증 | 통과 조건 / 소유 |
| --- | --- | --- |
| A01 | 같은 join 동시10개·첫 응답 버림·늦은 retry | entry/sequence1개, terminal retry는 새 등록0개; P4 |
| A02 | 다른 join ID·타인/event·취소 후 재등록 | active409와 현재 본인 상태, 타인정보 없음, 새 시도는 뒤 순번; P4 |
| A03 | 같은 timestamp·worker2개·지연 tick | 모든 rolling `(t-1000,t]` 승격<=R, admission 중복0, C<=8; P4/P7 |
| A04 | 취소/claim/만료 경합 | 원자 전이의 승자1개, cancelled/expired 자격의 새 점유0; P4/P5 |
| A05 | 하나의 admission으로 reservation/direct 동시 호출 | consumed 대상 최대1개, 좌석 차감1회, 다른 command409; P5 |
| A06 | 동일 payload retry / 다른 tier·수량·key | 같은 DB identity 또는 같은 영속 업무 거절, 변형409; P5 |
| A07 | commit 전 transient / 업무 거절 | transient은 새 점유0·같은 identity만 재시도; 업무 거절은 재현 가능한 rejected1개·부분 order0; P5 |
| A08 | commit 후 HTTP 유실·Redis finalization 실패 | DB target 유지, 같은 요청 replay, C는 보수적으로 유지 후1회 회수; P5/P7 |
| A09 | claim 후 중단·DB lock 지연·회수 후 늦은 재개 | PG lock 없이는 회수 안 함, closed 뒤 늦은 writer commit0, SERIALIZABLE fresh retry에서도 동일; P5/P7 |
| A10 | 실제 Redis pause/stop/restart·empty state | 신규 입장503, DB 결과 replay 정책 유지, old epoch 신규 commit 차단, 순번 유실 안내; P7 |
| A11 | reset 단계별 app/worker kill·coordinator2개 | 낮은 generation 공개0, partial init503, 이전 DB 작업 종료 뒤 새 C 열림; P4/P7 |
| A12 | 기존 reservation checkout·order replay·callback | admission TTL/reset 때문에 재대기하지 않음, 기존 limiter503은 별도 확인; P5/P7 |
| A13 | rollover·설정 off·보호 전환·기존 DB migration | ENV 우회0, old join410, 없는 event404, blank/기존DB 업그레이드·최신번호·구버전 차단. activation exclusive 대기 도중 consumer snapshot 생성→activation commit→consumer 재개에도 새 정책 적용/40001 retry; P4/P5 |
| A14 | browser hidden/reconnect/user A→B→A/event 변경 | 탭당 in-flight<=1, 낡은 응답 적용0, 서버 상태 복구, 구매 자동 중복0. cancel(A) 유실→join(B)→늦은 cancel(A)가 B를 바꾸지 않음; P6/P7 |
| A15 | full/청소·terminal mapping·status limiter | 상한 초과0, 같은 join 보존, 정상1초 polling이 구매 예산을 소모하지 않음. 503 최소대기15초 동안 다음 요청0·identity 유지·lease 갱신0; P4/P6 |
| A16 | R/C/TTL/polling A/B/C | 전체 cohort·미인지/만료 포함, 설정/분모/발생기/원본 식별; P8 |

최종 SQL은 `available + active reservation 수량 + pending/paid/delivered order 수량 = total`과 재고 상하한을 검사한다. converted reservation은 재합산하지 않는다. admission 결과와 실제 owner/event/tier/quantity/target, order/ticket/provider/callback identity도 대조한다. claim/C/R은 Redis 전이 로그와 원자 작업 결과로 검사하며250ms 표본만으로 순간 상한을 증명하지 않는다.

기존 검증을 재사용하되 증거 종류를 표시한다. `route-contract`의 응답 유실은 첫 응답을 버리는 모델이며 DB fallback은 limiter fail-open 설정이다. `checkout-expiry`의 DEL failure는 주입이다. 실제 TCP/Redis process 중단·브라우저 검사는 별도 run으로 남긴다. 최신 저장 결과는 unit159/integration240pass+10skip이며 예약 포트63532에 걸린 Redis 장애10개를 최신 전체 통과라고 하지 않는다. P7은 전용 자원/동적 포트로 실행하고 무관한 컨테이너·Windows 예약 정책을 바꾸지 않는다.

## 9. P8 측정과 변경 전파

P2는 수용된 과거 A 근거로 valid이다. 추가 정책 조회·원장·잠금·Redis 설정·polling 때문에 최종 A/B/C는 **같은 통합 SHA**에서 다시 측정한다. A는 정책상 unprotected, B/C는 같은 보호 설정이며 polling 모드만 다르다. 보호 off가 ENV 우회가 되어서는 안 된다. A와 B/C의 실제 공통 gate 비용·migration·계측을 공개한다.

pilot에서 R을 바꿀 때 C/TTL/polling/사용자 행동을 고정하고, 이후 R을 고정해 C/TTL을 보정한다. 입장 인지→소비 시작·DB 완료, 이탈·hidden 비율을 함께 본다. `R*체류시간`은 후보 계산일 뿐 capacity 보장이 아니다. 보정 결과는 새 profile로 기록하고 관련 A03/A04/A09/A14/A15를 재검증한 뒤 정식 비교한다.

정식은 조건별 최소3회, 순서를 섞는다. 자원·데이터·JWT/HMAC·기존 및 admission limiter·50:50 흐름·수량·think/retry/replay·로그·collector·도착 패턴을 고정한다. queue 체류가 VU를 점유하므로 P2의100VU/최대drain30초를 자동 재사용하지 않는다. 충분한 generator와 window/drain을 pilot로 사전 고정하고 A도 같은 조건으로 실행한다. 정합성 실패/관측 invalid는 중단·원본 보존하고 성공자만 남겨 재분석하지 않는다.

R=2 seed는40초 도착+30초 drain에서도 단순 상한 약140명만 승격할 수 있어 P2의400/1,000명을 같은 창 안 처리할 설정이 아니다. P4~P7 정합성 출발값이며 P8의 개선을 보장하지 않는다. R보다 도착률이 크면 queue가 늘어나는 finite burst/drain 관측으로 표시한다. cohort는 예정 도착 시각으로 구분하며 늦은 admission 시각으로 재분류해 대기자를 분모 밖으로 빼지 않는다.

완료율 분모는 예정 buyer 전체다. 미입장·queue잔류·취소·입장 만료·unknown·미완료를 별도 outcome으로 포함한다. throughput은 창 안 HTTP paid와 최종 SQL order/ticket identity가 일치한 고유 구매/창 길이다. 구매 write 오류율에 가벼운 polling을 섞지 않는다. join→paid 전체 대기, 입장 뒤 지연, paid p95/p99와 미완료 수, polling총수/대기자당/초별최대, 승격자 전체 대비 인지·미인지, active/claim/expiry, DB pool/lock/retry, Redis/CPU를 남긴다. 사용자당 탭 수와 hidden 비율도 고정한다. B/C는 adaptive+jitter의 합성 효과이며 jitter 단독 효과를 주장하려면 별도 대조군이 필요하다.

정식 중단/안정 기준은 실행 전 측정 revision에 고정한다. queue 때문에 전체 여정이 길어지는 만큼 P2의2초 paid 여정 기준을 B/C의 join→paid에 그대로 적용하지 않는다. 입장 후 지연·전체 대기·완료율의 각각의 기준과 실패 분모를 명시해야 P8 착수 gate를 통과한다. 이 계약의2초는 foreground 인지 목표이며 구매 전체 여정 기준이 아니다.

## 10. 후행 책임과 최소 파일 지도

| Issue | 계약 소비·구현 경계 | 최소 후보와 완료 증거 |
| --- | --- | --- |
| P4 #13 | Redis/API/R/C/lease/epoch lifecycle. PG event policy와 epoch barrier 포함 | `admission.service.ts`, `admissions.ts`, Redis admission 명령, `admission-scheduler.ts`, config/app/main, event-policy migration. A01~04/11/13/15, 실제 Redis/HTTP smoke |
| P5 #14 | 공통 소비 원장·두 신규점유·replay/회수; P4 event gate 재사용 | reservation/checkout service·입력/route, 공통 소비 helper, 결과 migration. A04~09/12/13, 실제 PG/Redis/HTTP·기존 callback/expiry 회귀 |
| P6 #15 | 같은 API의 fixed/adaptive UI·인지 계측 | 기존 frontend app/app-flow/utils/styles. A14/15, runnable 상태 검사와 실제 browser→HTTP→Redis. 최종 구매 통합은 P7 |
| P7 #16 | P4/P5/P6 통합과 실제 장애/프로세스 수명 | 기존 fixture·concurrency/redis-recovery/expiry 재사용, admission integration. A01~15의 실패/실행/SQL·Redis/미검증 표 |
| P8 #17 | 새 A/B/C·수치 보정·허용 주장 | 기존 flash-sale runner/analyzer/manifest 확장. A16, 원본/실패/3반복/생성기·분모·전체 비용 |
| P9 #18 | 수용 결과의 문서·이력서 | 구현/원본/조건에 연결된 문장. 미측정 개선·운영성과 주장 없음 |

P4가 노출할 내부 작업은 join/status/cancel/promote/claim/complete/reconcile/reset이며 새 범용 프레임워크를 만들지 않는다. P5는 claim에 event/user/admission/epoch/fingerprint를, complete에는 DB 결과와 claim token을 전달한다. claim API는 외부 REST로 노출하지 않는다. P4의 공통 event gate·policy 모델과 P5 원장 migration 순서를 합의한 뒤 구현하고, status polling에는 PG를 넣지 않는다.

P3 수용 뒤 P4만 직접 ready 판정 대상이다. P5/P6는 P4의 수용 SHA/API가 필요하며, P7은 P5/P6, P8은 P3/P6/P7을 기다린다. 실제 소비 checkout에 accepted SHA 또는 검증된 동등 내용이 없으면 PR open만으로 ready라 하지 않는다. 계약/API/상태/수치/epoch/소비·실패 변경은 P4~P7→P8→P9로 전파한다. 이미 완료된 결과도 영향이 있으면 stale과 재검증 범위를 기록한다. 무관한 문서 변경만으로 P2 전체를 재실행하지 않는다.

## 11. 결정·검토 기록

| 항목 | admission-v1 결정 |
| --- | --- |
| 소비 | 공통 PG 결과 원장, Redis claim과 DB commit 분리 |
| 품절 | 한 논리 요청의 영속 rejected, public consumed/outcome rejected. 재고가 바뀌어도 같은 요청은 같은 거절; 새 시도는 재등록 |
| 응답 유실 | 동일 ID/fingerprint로 durable 결과 복구. Redis/TTL/epoch는 새 점유만 제한 |
| claim 회수 | admission PG lock + 결과 또는 closed commit 뒤 슬롯 반환 |
| reset | event shared/exclusive gate + durable generation/epoch + CAS publication |
| 등록 재시도 | 같은 join key는 terminal까지 재생, active의 다른 key는409, epoch 전체 mapping 보존 |
| 범위 | 단일 보호 이벤트·volatile noeviction Redis·동일 지원 버전. 실험 기본 off |
| 수치 | admission-v1-seed는 초기 실험 가정. 최종 비교용 설정은 P8 보정/revision으로 수용 |

이번 문서의 검증 범위는 링크·현재 코드/Issue/tuple 대조·계약 반례 검토다. 제품 코드/migration/부하 실행은 없다. P3 reviewer는 우회, 양 경로 이중 소비, commit 전후 실패, 만료, 재시도, 다중 worker/reset, 재접속을 검토하며 실제 모델·대상 SHA/파일 hash·finding 처리 결과를 인계에 기록한다. 계약 검토 통과를 runtime 안전성 입증으로 표현하지 않는다.

초안 독립 검토에서 수정한 항목: SERIALIZABLE의 stale policy snapshot(P1), 늦은 reset ready 공개(P2), durable replay의 타인/event404 우선순위(P2), 503 서버 최소대기 준수(P2), policy ensure 이전의 없는 event404 보존(P2). 각각 policy ensure+locking read/새 transaction retry, gate 안의 initializing→ready CAS, owner/event 우선 검사, 서버 지침을 포함한 max 대기, event 존재 확인으로 반영했다. 이 기록은 문서 수정이며 실제 반례 실행 결과가 아니다.
