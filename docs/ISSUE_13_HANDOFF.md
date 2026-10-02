# Issue #13 / P4 새 세션 인수인계

작성일: 2026-10-02 KST. 대상: [P4 #13 — Redis 대기열 API와 원자적 입장 승격 구현](https://github.com/dosacha/PeakPass/issues/13). 이 문서는 **착수 절차와 구현 설계의 입력**이며 P4 구현·검증 결과가 아니다. 규범은 [ADMISSION_CONTRACT.md](ADMISSION_CONTRACT.md)의 `admission-v1`, 수용 상태의 단일 기준은 [총괄 #9](https://github.com/dosacha/PeakPass/issues/9)다.

## 1. 새 세션의 첫 작업: 조사 후 설계 설명

**첫 실질 응답은 “Issue #13을 어떻게 설계할 것인지” 설명하는 것이다. 첫 턴은 읽기 전용 조사와 설계 설명까지 수행하고, 사용자가 설명을 검토한 뒤 진행을 지시하기 전에는 코드·migration·계약 변경이나 새 실험을 시작하지 않는다.** 단순 작업 목록이나 구현 완료 보고로 대신하지 않는다.

explorer는 실제 호출 경로와 재사용 경계를, 테스트 조사 agent는 검증·fixture·환경을, reviewer는 계약 반례와 dependency gate를 읽기 전용으로 병렬 조사한다. main이 원본을 대조하고 종합한다. Issue의 Astra gate를 충족할 때는 실제 reviewer 모델과 대상 SHA/hash를 기록하며 역할명만으로 모델을 추정하지 않는다.

첫 설명은 아래 항목마다 **확정된 계약·현재 코드 근거 / 추천 구현안과 대안·비용 / 구현 전에 결정할 사항**을 구분한다. 계약상 이미 확정한 정책을 새 미결정처럼 취급하지 않는다.

| 설명 영역 | 반드시 답할 질문 |
| --- | --- |
| 상태·API | 세 endpoint와 인증·owner·epoch·join identity를 어디서 검증할 것인가? terminal replay, 다른 key의 active409, cancel/claim 경합과 정확한 오류 envelope를 어떻게 유지할 것인가? |
| Redis 모델·원자성 | entry/index/ZSET/sequence/limiter/control key를 어떻게 나누고 어떤 Lua가 함께 변경하는가? Redis TIME, FIFO, rolling R/C, 청소 상한, 동일 tick·worker 경합을 어떻게 검사하는가? |
| PostgreSQL 경계 | `admission_events` migration·백필·lazy ensure, 공통 event gate와 locking policy read를 어디에 둘 것인가? P5가 같은 PoolClient와 잠금 순서를 어떻게 재사용하는가? |
| claim·복구 | P4의 claim/complete/reconcile와 P5의 durable 판정 책임을 어떻게 나누는가? P5 미연결 상태의 제한과 timeout 뒤 슬롯을 함부로 반환하지 않는 조건은 무엇인가? |
| epoch·프로세스 | freeze→PG barrier→새 generation→initializing→ready CAS, 다중 coordinator, 부분 초기화, Redis 재연결, shutdown 중 작업을 어떻게 다루는가? |
| 설정·polling | seed 값과 지원 범위, endpoint별 독립 예산, `nextPollAfterMs`·serverTime, 무효 요청/503의 lease 비갱신, P6에 줄 실제 API를 어떻게 구현하는가? |
| 검증·후행 | P4가 실제로 증명할 A01~04/11/13/15 부분과 P5/P6/P7에서만 증명할 부분은 무엇인가? 최소 파일·단계·검증 명령, P5/P6 인계와 P8 A 재측정 영향을 설명하는가? |

## 2. 최신 상태를 다시 확인할 기준

작성 시 확인한 상태이며 미래 세션의 live 상태를 대신하지 않는다.

| 항목 | 확인 값 |
| --- | --- |
| 원격 main | `c2fd058c6a43fef312b1ce17b16c14d6a8bbdd63` |
| P3 PR | [PR #22](https://github.com/dosacha/PeakPass/pull/22), 2026-10-02 12:15:15 KST 병합 |
| P3 accepted SHA / revision | `87959cd84dbb231caa88fee2e4ad4bcd84115246` / `admission-v1`; 위 main에 포함 |
| 계약 파일 SHA256 | `e22be4df9910811eba552f630b43170ba0cf0c8d953a54dc5a3cea34c0dcf3d1` (Git blob의 LF bytes 기준) |
| P3 검증 | 해당 hash에 대한 읽기 전용 Astra·explorer No findings, 문서 검증·PR22 CI 통과. 사용자가 오토리뷰 No findings를 확인하고 병합했으며 bot의 +1도 확인. 제품 동작 검증과 구분 |
| dependency gate | P1/P2/P3 valid, P4 ready. P5/P6는 P4 수용 구현/API 대기, P7은 P5/P6, P8은 P6/P7, P9는 P8 대기 |
| 구현 상태 | admission 제품 코드·migration·P4 실행 증거 없음. 기존 limiter는 대기열이 아님 |

먼저 최신 #9/#12/#13 및 직접 후행 #14/#15의 본문·댓글·수용 tuple을 읽고 #16~#18의 영향도 확인한다. PR·Issue가 Closed라는 사실만으로 gate를 판단하지 않는다. P3 발행 시 남긴 “미병합”이나 [옛 P3 인계](ISSUE_12_HANDOFF.md)의 “계약 미작성” 표현은 당시 이력이며 현재 P3 수용 상태를 덮어쓰지 않는다.

이 인계 문서가 main에 없으면 원격 `codex/issue-13-handoff`와 해당 PR을 확인한다. `git show origin/codex/issue-13-handoff:docs/ISSUE_13_HANDOFF.md`로 먼저 읽고, 실제 작업 checkout에 최신 main과 수용 계약·인계 내용이 포함됐는지 확인한다. 브랜치 삭제 시 연결 PR의 문서 commit으로 조회한다. 인계 PR이 열려 있다는 이유만으로 P4 구현이 생긴 것으로 보지 않는다.

```powershell
git status --short
git worktree list
git fetch origin
git rev-parse origin/main
git log -5 --oneline origin/main
git merge-base --is-ancestor 87959cd84dbb231caa88fee2e4ad4bcd84115246 origin/main
gh pr view 22 --repo dosacha/PeakPass --json state,headRefOid,mergeCommit,mergedAt,statusCheckRollup
gh issue view 9 --repo dosacha/PeakPass --comments
gh issue view 12 --repo dosacha/PeakPass --comments
gh issue view 13 --repo dosacha/PeakPass --comments
```

명령의 exit code와 실제 checkout의 포함 관계를 확인한다. 작성 시 기본 checkout `C:\Users\dosac\projects\PeakPass`는 과거 main `54ca75a`와 사용자 미추적 문서·portfolio 산출물을 갖고 있다. 이를 reset/clean으로 없애지 않는다. 이 인계는 기존 격리 worktree `C:\Users\dosac\.codex\worktrees\peakpass-issue11-baseline\PeakPass`의 `codex/issue-13-handoff`에서 작성했다. 새 세션은 사용 가능한 worktree·branch·AGENTS.md를 다시 확인하고 사용자 변경을 보존한다.

## 3. 수용 입력과 수치의 한계

P3 계약 전체를 먼저 읽는다. 그다음 [P2 보고서](FLASH_SALE_BASELINE.md), [지표 정의](FLASH_SALE_EVIDENCE.md), [v261 수용 인덱스](../load-test/results/flash-sale-baseline-v261/index.json)와 [검증 기록](../load-test/results/flash-sale-baseline-v261/validation.json)을 확인한다.

- P2 측정 `flash-sale-v2.6`: ample9/limited01/preflight2는 `33a74de24cef2493bf4f8e473a695910fc404c42`, limited02/03은 `598ad50bc389b47bcbcfc0175359735671718fe1`.
- 공통 분석 `flash-sale-analysis-v2.6.1` / `598ad50bc389b47bcbcfc0175359735671718fe1`. 수용 인덱스 발행 SHA `891363fd44e38abb750c5212a984917d6844de26`, SHA256 `64d33e60a8e50c704d8fcd6f789974162fd096a564f4e2c95e5bcc286c81cea6`.
- accepted IDs는 `p2-v26-ample-r2-01..03`, `p2-v26-ample-r10-01..03`, `p2-v26-ample-r25-01..03`, `p2-v26-limited-01..03`. 정식12회와 제외 preflight2회를 구분한다. v26 index는 미완료10/12 시점의 checkpoint다.
- 충분 재고2/10명/s는 각3회 안정,25/s는 과부하2회·안정1회이고 strict smoke는3회 모두 실패했다. 제한 재고 결과는 충분 재고 처리량과 다르다. 최대 처리량·DB 단독 병목·대기열 효과·운영 SLO를 입증하지 않았다.

`admission-v1-seed`는 정합성 검증의 출발값이다. **R=2/s, C=8, TTL=30초는 P2에서 계산한 capacity나 운영 권고값이 아니다.** R은 rolling `(t-1000ms,t]`의 성공 승격 수, C는 admitted idle+unresolved claim의 합이다. C는 DB pool·미결제 주문·좌석 hold 총량이 아니다.

계약 §7의 나머지 값도 그대로 소비한다: claim deadline15초, tick250ms/승격batch2, cleanup100/reclaim8, waiting lease120초, waiting1,000/epoch entry10,000, epoch 최대24시간. P6용 fixed1초, adaptive1~5초는 jitter±20% **적용 후 clamp**, hidden15초이며 조회120/분·등록10/분·취소10/분은 user/event/action별로 구매 예산과 분리한다. 오류 대기에는 서버 최소대기가 우선한다. 이 요약보다 계약의 세부 조건이 우선한다.

## 4. P4가 이어받을 고정 경계

| P4에서 구현·인계 | 이번 P4에서 완료라고 선언할 수 없는 것 |
| --- | --- |
| JWT 필수 GET/POST/DELETE admission API와 Redis 상태·owner·epoch 규칙 | P6 화면·브라우저 polling/인지 지연 |
| 원자적 join/status/cancel/promote, R/C·lease·terminal mapping·bounded cleanup | P8 성능 개선율·최종 profile 보정 |
| `admission_events`와 공통 event gate/policy ensure, epoch lifecycle·readiness·scheduler | P5 `admission_results`와 신규 reservation/direct checkout의 영속 소비 연결 |
| P5용 claim/complete/reconcile/reset 내부 협력 인터페이스와 Redis CAS | 두 구매 경로 이중 소비·응답 유실·closed 뒤 늦은 writer 차단의 통합 증명 |

중요한 불변식:

1. PostgreSQL은 재고·예약·주문·결제·소비 결과의 권위, Redis는 FIFO·활성 자격·예산·조회 상태다. Redis 선삭제·TTL·finally만으로 소비 또는 회수를 확정하지 않는다.
2. 정상 status polling은 PG 연결0회다. entry 없음과 metadata 유실·recovering을 구분하고, 후자는 빈 정상 queue로 초기화하지 않는다. readiness/복구의 PG 사용과 요청별 정상 polling을 구분한다.
3. 같은 join key는 terminal까지 같은 entry를 재생한다. 다른 key의 active409에는 본인 snapshot만 주고 alias를 만들지 않는다. terminal mapping은 epoch 끝까지 보존한다. 취소 후 새 join은 뒤 순번이다.
4. event shared/exclusive gate와 policy locking read가 같은 PG transaction에 묶인다. SERIALIZABLE의 advisory 대기 뒤 snapshot은 자동 갱신되지 않는다. event 존재 확인→policy ensure→FOR SHARE,0행503, 없는 event404,40001 새 transaction 재시도를 보존한다. migration 최신 번호는 착수 때 다시 확인하고 기존011을 수정하지 않는다.
5. claim은 C에 남는다. P4는 Redis 전이/협력 API를 만들고, 결과 확인 또는 closed commit을 통한 영속 회수는 P5가 연결한다. P5 미연결 상태에서 임의의 timeout 회수 worker나 가짜 성공 결과로 빈자리를 메우지 않는다. claim API는 외부 REST로 노출하지 않는다.
6. reset ready 공개는 새로운 PG exclusive transaction에서 current generation/epoch/open을 확인하며 gate를 보유한 채 `initializing→ready` CAS를 한다. frozen을 다시 열거나 낮은 generation을 덮어쓰지 않는다. old writer drain 전 새 C를 열지 않는다. 순번 유실 후 명시적 재등록을 안내한다.
7. 단일 보호 이벤트는 PG partial UNIQUE로 제한한다. 전용 Redis는 volatile(AOF/RDB off)+noeviction이며 확인할 수 없으면 admission readiness를 열지 않는다. partial metadata/WRONGTYPE/OOM은503·복구 대상이다. 같은 손실에 여러 coordinator가 불필요하게 세대를 반복 증가시키지 않는다.
8. 기능은 기본 off이고 **P4 단독으로 보호 이벤트를 활성화하지 않는다.** P5 통합·모든 serving instance의 v1 소비 gate 확인 뒤 명시적으로 활성화한다. 구버전 mixed deployment와 ENV off를 통한 보호 우회는 허용하지 않는다. P4의 정책/전환 테스트는 격리된 fixture/helper 범위와 제품 구매 통합 미검증을 구분한다.
9. 기존 검증된 reservation checkout·order replay·결제는 admission 면제지만 현재 limiter503의 영향은 남는다. 전역 admission middleware나 InventoryService 전체 gate로 이 경로까지 막지 않는다.

## 5. 실제 코드 지도와 구현 전 선택할 것

기존 패턴을 우선 사용하고 새 범용 framework·MQ·인증 서비스·Redis Cluster를 만들지 않는다. 아래 신규 파일명은 후보이며 함수 signature와 Lua 분해는 첫 설계 설명에서 제안한다.

| 경계 | 읽을 파일 / 최소 변경 후보 |
| --- | --- |
| Redis 연결·명령·key | [client.ts](../src/infra/redis/client.ts), [commands.ts](../src/infra/redis/commands.ts). `withRedis`·offline queue 차단·socket timeout/종료 재사용; admission namespace 분리. 전용 명령 파일 분리가 기존 파일 확장보다 나은지 설명 |
| route·인증·오류·limiter | [app.ts](../src/api/app.ts), [auth.ts](../src/api/middleware/auth.ts), [rateLimit.ts](../src/api/middleware/rateLimit.ts), [idempotency.ts](../src/api/middleware/idempotency.ts), [오류 모델](../src/core/errors/index.ts), [HTTP 오류](../src/api/errors.ts). 후보 `src/api/rest/admissions.ts`, `src/core/services/admission.service.ts` |
| PG policy·migration | [postgres/client.ts](../src/infra/postgres/client.ts), [migration runner](../src/infra/migrations/runner.ts), [현재 마지막011](../src/infra/migrations/011_payment_callback_status.sql). `admission_events` 추가와 공유 gate helper; P5 원장 migration은 후속 번호 |
| 환경·수명주기 | [config.ts](../src/infra/config.ts), [main.ts](../src/main.ts), [health.ts](../src/api/health.ts), [order-sweeper.ts](../src/infra/cron/order-sweeper.ts), [reservation-sweeper.ts](../src/infra/cron/reservation-sweeper.ts). 후보 `src/infra/cron/admission-scheduler.ts` |
| P5가 연결할 실제 분기 | [reservation.service.ts](../src/core/services/reservation.service.ts), [checkout.service.ts](../src/core/services/checkout.service.ts), [inventory.service.ts](../src/core/services/inventory.service.ts). 이중 pool connection 없이 같은 PoolClient·잠금 순서·기존 replay/예약 검증 유지 |
| 테스트 재사용 | [rate-limit-atomic](../src/tests/integration/rate-limit-atomic.test.ts), [redis-recovery](../src/tests/integration/redis-recovery.test.ts), [route-contract](../src/tests/integration/route-contract.test.ts), [events-transaction](../src/tests/integration/events-transaction.test.ts), [order-sweeper-process](../src/tests/integration/order-sweeper-process.test.ts), [redis-shutdown-order](../src/tests/unit/redis-shutdown-order.test.ts). 후보 `src/tests/integration/admission.test.ts` |

현재 전역 훅 순서는 webhook signature→JWT→기존 limiter→idempotency→route다. JWT middleware는 토큰 누락을 그대로 통과시키므로 admission route에서 필수 인증을 명시해야 한다. 기존 `ENFORCE_AUTH_USER_MATCH=false`를 입장 인증 우회로 사용하지 않는다. 기존 limiter의 user/action 키만 재사용하면 event별 예산이 합쳐질 수 있으므로 **user/event/action**을 보장하고 중복 limiter 적용을 피한다. 계약의 오류 envelope와 전역401/validation 오류의 연결 방법도 설명한다.

구현 미결정 사항은 구체적으로 남긴다: Lua별 입력·반환값/원자성 묶음, Redis `TIME`과 sequence 표현, 손실·process identity 검출 및 generation 복구 담당, public `/ready`와 admission readiness의 관계, activation/reset을 호출할 제한된 관리 진입점, worker overlap·stop/drain, PG helper signature·two-int namespace, P5가 제공할 durable recovery 협력 방식과 P4 단독 테스트 범위. 이 선택이 계약 의미를 바꾼다면 먼저 revision/영향을 제안하고 #9/#12~#18을 갱신한다.

현재 `/ready`의 PG `SELECT 1`/Redis `PING` 성공은 admission namespace/config 준비 완료가 아니다. scheduler는 `order-sweeper`의 순차 timer·inflight 대기 `stop()`을 우선 참고한다. `main.ts`의 Redis 선차단·worker drain·PG 후종료와 listen 실패/중복 signal 경로까지 설명하고, 단순 `clearInterval`을 진행 중 작업 종료로 간주하지 않는다.

## 6. 검증 계획과 증거 경계

아래는 **설계 검토 후 구현하면서 실행할 계획**이다. 현재 실행·통과한 P4 테스트가 아니다.

| 범위 | 필요한 증거 |
| --- | --- |
| A01/A02 | 실제 Redis+인증 HTTP: 같은 join10개/첫 응답 유실/terminal replay, active 다른key409, 타인·event404, 취소 후 새 순번 |
| A03/A04 | 다중 worker·동일 timestamp·지연 tick, rolling R/C 전이 기록과 cancel/claim/expire 승자. 좌석 차감/이중 소비 부분은 P5/P7까지 미검증으로 표시 |
| A11/A13 | 실제 PG policy/gate 경합·새 transaction retry·없는 event404·blank/기존 DB migration, 두 coordinator와 reset 단계별 중단·재개. P4 helper/process 증거와 P7 구매 writer 통합 장애를 구분 |
| A15 | full/청소·terminal mapping·limiter 독립·429/503에서 lease 비갱신. 브라우저가 서버 최소대기를 지키는지는 P6/P7 |
| 회귀·수명주기 | 기존 limiter/Redis 재연결·종료, app startup 실패/정상 stop, migration·구매·callback 회귀. readiness 성공만으로 복구 완료를 추정하지 않음 |

최소 검증 명령 후보(프로젝트 root, 격리된 테스트 DB/Redis 준비 후):

```powershell
npm run build
npx --no-install tsc --noEmit
npm run lint
npm test -- --runInBand
npx --no-install jest --runInBand --config jest.integration.cjs src/tests/integration/admission.test.ts
npx --no-install jest --runInBand --config jest.integration.cjs src/tests/integration/rate-limit-atomic.test.ts src/tests/integration/redis-recovery.test.ts src/tests/integration/route-contract.test.ts
```

새 파일이 생긴 뒤 해당 명령을 사용한다. `npm test`는 unit 전용이고 `test:integration`/`test:admission` script는 현재 없다. PowerShell 실행 정책에 걸리면 `npm.cmd`/`npx.cmd`를 사용한다. 단위·통합 fixture의 실제 필요 환경과 opt-in을 먼저 읽고, 변경 경로의 의미 있는 회귀를 선택한다. protected policy와 generation·epoch가 DB에서, admission 상태가 Redis에서 어떻게 달라졌는지 실제 HTTP 응답과 대조한다. 정상 GET의 PG0회도 계측/spy와 실제 경로로 확인한다. mock·Fastify inject·응답 버림·fault injection·실제 TCP/process·브라우저 증거를 각각 표시한다.

`route-contract`/`rate-limit-atomic`의 Fastify inject만으로 실제 HTTP smoke를 대신하지 않는다. [order-expiration-http](../src/tests/integration/order-expiration-http.test.ts)의 loopback `listen(port:0)`+`fetch`를 참고한다. R/C 순간 상한과 status의 PG0회는250ms 표본만으로 증명하지 않고 원자 전이·실제 호출 경계를 검사한다.

실제 연결은 `DB_HOST/PORT/USER/PASSWORD/NAME`과 `REDIS_HOST/PORT/PASSWORD`를 사용하며 `.env`도 읽는다. `DATABASE_URL`/`REDIS_URL`만 바꿔 격리됐다고 가정하지 않는다. `route-contract`는 도메인 행을 DELETE하고 `redis.test`는 `peakpass:*` 전체 키를 삭제하므로 전용 테스트 DB·Redis가 필요하다. 비밀값을 로그에 남기지 말고 대상 identity/소유권만 기록한다.

기존 저장 P2 검증은 unit159/integration240 pass+10 skip이다. Redis 장애10개는 Windows 예약 포트63532 때문에 제외됐으며 [validation.json](../load-test/results/flash-sale-baseline-v261/validation.json)에 이름과 원본이 있다. 이전250/250을 최신 전체 통과로 쓰지 않는다. 테스트별 고정 포트·Docker opt-in·PostgreSQL TRUNCATE를 확인하고 전용 자원/동적 포트와 run 소유 데이터로 실행한다. 무관한 컨테이너·Windows 예약 정책·사용자 데이터를 바꾸지 않는다. `migrate:down`은 현재 rollback을 구현하지 않아 `db:reset`을 빈 DB 재생성 증거로 쓸 수 없다.

기존 destructive Redis fixture는 `peakpass-wave3-0928-redis` 이름·정확한 container ID/label·`127.0.0.1:63532`를 강제한다. 포트 환경변수만 바꾸면 실행되지 않는다. 필요한 fixture 변경은 소유권 검증을 보존하며 설명하고, 실행하지 못한 항목은 이름과 이유를 공개한다. `order-sweeper-docker`는 `WAVE4_TEST_IMAGE`가 없으면5개 lifecycle case를 건너뛴다. 기본 CI green은 이 opt-in 장애군의 실행 증거가 아니다.

[production-image-check.mjs](../.github/scripts/production-image-check.mjs)는 migration001~011 및 `/ready`의 checks shape를 고정해 검사한다. migration/readiness를 바꾸면 관련 기대값과 검증도 함께 갱신할지 확인한다. 이 검사는 전용 빈 DB를 사용하므로 기존 DB의 upgrade 증거는 별도로 남긴다.

P4 착수만으로 P2 부하 전체를 반복하지 않는다. PG policy 조회·migration·잠금·Redis 환경 비용이 들어간 최종 비교는 P8에서 **같은 통합 SHA로 A/B/C 모두, A부터** 다시 측정한다. R2 seed로 기존400/1,000명·짧은 drain을 완료할 수 있다고 가정하지 않는다. generator/VU·window/drain·분모·실패/미완료를 사전 고정한다.

## 7. 완료·후행 인수인계

P4 구현 수용은 이번 문서 push와 별개다. 구현 후 main이 finding을 수정하고 독립 reviewer가 최종 SHA를 검토한다. 선행 tuple·latest main과 후행 영향을 다시 확인한 뒤 다음을 기록한다.

- 구현 commit/PR, 소비한 P3 SHA·contract/profile revision, schema·migration·설정·지원 환경.
- P5용 실제 함수 signature·PoolClient/lock 전제·claim token/DB 결과 반영 규칙과 미연결 recovery 범위, P6용 실제 API/schema/오류·polling 필드/예시.
- 명령·run ID·원본 결과·SQL/Redis/HTTP 대조, 성공·실패·skip와 미검증 범위. reviewer 실제 모델·대상 SHA와 해결한 finding.
- 계약 변경 전후 또는 변경 없음, #14/#15 소비 revision·완료 조건 및 #9 상태표. P4 산출물이 수용되고 실제 checkout에 포함됐을 때만 P5/P6 ready 여부를 판정한다.
- #16~#18까지 전이 영향을 확인하고 완료된 후행도 영향이 있으면 stale/재검증 대상을 남긴다. P1/P2 저장 근거는 무관한 문서 변경만으로 무효화하지 않는다.

PR merge·배포·백그라운드 감시는 별도 지시 없이 시작하지 않는다. 이 문서의 모든 P4 구현·검증 항목은 다음 세션의 설계 설명과 사용자 검토 뒤 진행할 작업이다.
