# Issue #10 구현·검증 기록

2026-10-10 추가: 이 구현은 PR #19로 병합됐다(main `8f64539`, 2026-10-01). 맨 아래의 '아직 측정하지 않았다'는 그때의 기록이다. 과부하 구간은 이후 P2([FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md))가, 같은 조건의 A/B/C 비교는 P8([ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md))이 측정했다.

구현 branch: `codex/issue-10-write-load-harness`

기준 main: `79a0b5ed381b9c8be72e30fa7b0c61f8c56acfd0`

검토·실험한 구현: `e0fbc78754e17dd6380b1a899373168c3ddf6153`

계약 revision: `flash-sale-v1`

검증일: 2026-09-30 (Asia/Seoul)

explorer, 기존 테스트 조사 agent, race/data integrity reviewer가 먼저 읽기 전용 조사를 완료했다. 이후 main이 계획을 확정하고 모든 코드를 구현했다. 최종 별도 Astra reviewer가 11개 소스·설정·문서·테스트 파일을 전부 검토했다. 발견한 경계 2건 수정 후 **No findings**를 받았다.

## 실행 명령과 결과

| 실제 명령 | 결과 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 설치 성공, 새 dependency 없음 |
| `npm run test:flash-sale` | 8/8 통과. 실제 k6 script를 VM 경계에서 실행하는 계약 검사 |
| `npm test -- --runInBand --coverage` | 21 suites / 159 tests 통과. 기준 코드는 20 suites / 158 tests 통과 |
| `npx --no-install jest --runInBand --config jest.integration.cjs` | 24 suites / 250 tests 통과, skipped 0, 186.304초 |
| `npm run build` | 성공 |
| `npx --no-install tsc --noEmit` | 성공 |
| `npm run lint` | 오류 0, 변경 전부터 있던 `no-explicit-any` 경고 9개 |
| `node --experimental-vm-modules load-test/payment-callback-check.mjs` | 기존 callback 하네스 검사 통과 |
| `node .github/scripts/production-image-check.mjs peakpass:fs-p1-accepted-ample-01` | migration 001–011, 재실행 변경 없음, readiness, signed GraphQL 통과 |
| `git diff --check` | 통과 |

통합 테스트는 전용 빈 PostgreSQL(`issue10_tests`, 동적 loopback 포트)과 전용 Redis에서 `--runInBand`로 실행했다. `WAVE3_REDIS_DESTRUCTIVE=1`, `WAVE3_REDIS_CONTAINER=peakpass-wave3-0928-redis`, 새 컨테이너의 정확한 `WAVE3_REDIS_CONTAINER_ID`, `REDIS_HOST=127.0.0.1`, `REDIS_PORT=63532`, `WAVE4_TEST_IMAGE=peakpass:fs-p1-accepted-ample-01`를 적용했다. 따라서 Redis recovery/outage와 production Docker lifecycle의 opt-in 15개도 포함된다.

기존에 중지돼 있던 Wave3 Redis는 ID `b37528cf350e9983f8578e70c0a0bb2ffc0e417421ddf265e1e3bf09c2f22920`를 확인하고 이름만 임시 보존했다. 새 빈 컨테이너로 테스트를 끝낸 뒤 새 자원만 제거하고 기존 ID·이름·중지 상태를 복구했다. 기존 volume 데이터와 실행 중인 다른 프로젝트 DB는 사용하지 않았다.

호스트 Node `v24.15.0` 외에 Docker Node 18에서도 아래 명령으로 8/8 통과했다. 호스트 orchestration 전체를 Node 18로 실행한 증거와는 구분한다.

```powershell
docker run --rm --mount 'type=bind,source=C:/Users/dosac/.codex/worktrees/peakpass-issue10-harness/PeakPass,target=/workspace,readonly' --workdir /workspace peakpass:fs-p1-final-ample-01 node --experimental-vm-modules --test load-test/flash-sale-check.mjs
```

## 승인된 실제 HTTP·SQL 증거

세 실행 모두 위 구현 SHA의 clean working tree에서 새 자원·새 fixture로 실행했다. 각 ZIP은 원본 JSONL·로그·manifest·SQL·정리 결과 21개 파일을 포함한다. manifest의 20개 artifact 해시와 현재 구현 source hash를 대조했고, JWT 패턴이 결과에 없음을 확인했다. 인덱스는 [verification.json](../load-test/results/flash-sale-reference/verification.json), ZIP 해시는 [archives.sha256](../load-test/results/flash-sale-reference/archives.sha256)이다.

| 실행 명령 | 실제 결과 | 원본 |
| --- | --- | --- |
| `node load-test/flash-sale-fixture.mjs --run-id p1-reference-ample-01` | 12 시작 / 12 paid / 24 tickets / dropped 0 | [ZIP](../load-test/results/flash-sale-reference/p1-reference-ample-01.zip) |
| `node load-test/flash-sale-fixture.mjs --run-id p1-reference-ample-02` | 12 시작 / 12 paid / 24 tickets / dropped 0 | [ZIP](../load-test/results/flash-sale-reference/p1-reference-ample-02.zip) |
| `node load-test/flash-sale-fixture.mjs --run-id p1-reference-limited-01 --stock limited --seats 6` | 12 시작 / 3 paid / 6 tickets / 재고 부족 409 9건 / dropped 0 | [ZIP](../load-test/results/flash-sale-reference/p1-reference-limited-01.zip) |

각 실행에서 invalid JWT 401, body user 불일치 403, invalid HMAC 401과 DB 불변을 확인했다. 충분한 재고 실행은 예약 경유 6명·직접 구매 6명, checkout replay 4회·settlement replay 4회다. SQL 수량·키·소유자 불변식 15개와 fixture 정리·무관한 sentinel 보존이 모두 통과했다. 실행용 컨테이너·네트워크·volume은 제거됐다. 이미지와 증거만 유지한다.

## 발견하고 수정한 문제

1. 실제 첫 smoke에서 k6가 종료 시점의 추가 iteration을 시작했고 스크립트 예외만으로 종료 코드가 실패하지 않았다. 1ms 우측 경계 제외, 정확한 iteration count threshold, 예외 실패 집계를 추가했다. 그 이전 `p1-smoke-01`은 승인 증거에 포함하지 않는다.
2. Astra가 실제 k6로 `users/rate=1`의 999ms가 최소 실행 시간에 미달하고, `rate=1000/users=2000`은 1999회만 실행되는 것을 재현했다. provisioning 전에 기간 2–3600초·rate 최대 999를 검증한다. 새 거부 사례의 RED→GREEN을 확인했다.
3. 도착 시각의 timezone offset을 제거한 값을 UTC로 표시하던 오류를 수정했다. 실제 UTC 변환과 응답 분모 분리 검사가 통과한다.
4. 검증용 PostgreSQL 초기화 중 Unix socket의 임시 서버가 준비 완료로 보일 수 있었다. 검증 환경과 새 Compose healthcheck를 TCP readiness로 바꿨다. 이후 image·전체 통합·최종 3회 smoke가 통과했다.

Astra는 다음 실제 k6 명령으로 허용 상한 모델을 검사했다. **HTTP 없는 스케줄러 검사**이며 서비스가 999 RPS를 처리한다는 뜻이 아니다.

```powershell
@'
export const options = {
  scenarios: { buyers: { executor: 'constant-arrival-rate', rate: 999,
    timeUnit: '1s', duration: '1999ms', preAllocatedVUs: 10, maxVUs: 20 } },
  thresholds: { iterations: ['count==1998'], dropped_iterations: ['count==0'] }
};
export default function () {}
'@ | k6 run -
```

결과: 1998 iterations, dropped 0, threshold 통과.

## #11 / Astra 인수

인수 tuple은 구현 SHA `e0fbc78754e17dd6380b1a899373168c3ddf6153`, `flash-sale-v1`, 위 세 reference run ID와 각 source hash다. 후속 evidence-only 커밋은 측정한 구현을 변경하지 않는다. #11 시작 시 이 tuple과 새 작업 코드·환경을 대조하고 총괄 #9의 변경 영향 gate를 적용한다.

최대 처리량·과부하 병목·개선 효과는 아직 측정하지 않았다. 로컬 Docker와 부하 생성기를 공유하는 작은 smoke이고, PG/pool/Redis 관측은 표본이다. Redis 지표는 observer PING RTT와 commandstats이며 앱 명령별 percentile이 아니다. timeout/5xx 강제 주입은 VM 검사이고 하네스 자체의 실제 네트워크 장애 실험으로 주장하지 않는다. 하네스 실패/cleanup 오류가 있는 run은 인수하지 않는다. 재현·계측 정의는 [FLASH_SALE_EVIDENCE.md](FLASH_SALE_EVIDENCE.md)를 따른다.
