# PeakPass 문서 안내

각 문서는 코드와 저장된 측정 결과로 확인한 범위를 적고, 확인하지 못한 것은 그렇다고 적습니다.

## 읽는 순서

1. [저장소 README](../README.md) — 무엇을 만들었고 결과가 무엇인지
2. [아키텍처 다이어그램](ARCHITECTURE_DIAGRAMS.md) — 요청이 흐르는 경로
3. [트랜잭션과 정합성](TRANSACTION_CONSISTENCY.md) — 초과 판매와 중복 발급을 막는 방법, 격리 수준과 행 잠금이 각각 하는 일
4. [입장 제어: 설계 선택과 운영 절차](ADMISSION_DESIGN_AND_OPERATIONS.md) — 대기열을 왜 이렇게 만들었는지, 그 대가, 장애 때의 동작, 알려진 한계
5. [성능 보고서](PERFORMANCE_REPORT.md) — 측정 조건, 결과, 해석, 한계
6. [프로젝트 설명과 불렛의 근거](RESUME_EVIDENCE.md) — 이력서에 쓰는 문장 하나하나가 기대는 run과 필드, 쓰지 않는 표현

## 주제별 문서

| 주제 | 문서 |
| --- | --- |
| 구조 | [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md), [CASE_STUDY.md](CASE_STUDY.md), [adr/0001-read-write-separation.md](adr/0001-read-write-separation.md) |
| GraphQL | [GRAPHQL_RATIONALE.md](GRAPHQL_RATIONALE.md), [GRAPHQL_EXAMPLES.md](GRAPHQL_EXAMPLES.md) |
| 정합성과 Redis | [TRANSACTION_CONSISTENCY.md](TRANSACTION_CONSISTENCY.md), [REDIS_STRATEGY.md](REDIS_STRATEGY.md) |
| 입장 제어 | [ADMISSION_DESIGN_AND_OPERATIONS.md](ADMISSION_DESIGN_AND_OPERATIONS.md), 규칙의 원문인 [ADMISSION_CONTRACT.md](ADMISSION_CONTRACT.md) |
| 운영 | [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) |
| 측정 | [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md), [LOAD_TEST_STRATEGY.md](LOAD_TEST_STRATEGY.md), 지표 정의와 유효성 규칙인 [FLASH_SALE_EVIDENCE.md](FLASH_SALE_EVIDENCE.md), 실행 방법인 [load-test/README.md](../load-test/README.md) |

## 작업 기록

입장 제어는 아홉 단계로 나눠 만들었고, 2026-10-10에 모두 main에 병합됐습니다. 계약과 기록 문서에 나오는 P1–P9가 그 단계 번호입니다.

| 단계 | 한 일 | 기록 |
| --- | --- | --- |
| P1 | 서로 다른 구매자가 한 이벤트에 몰리는 쓰기 부하 하네스 | [records/ISSUE_10_VALIDATION.md](records/ISSUE_10_VALIDATION.md) |
| P2 | 대기열 없는 구매 경로의 기준선 측정 | [FLASH_SALE_BASELINE.md](FLASH_SALE_BASELINE.md) |
| P3 | 입장 제어 계약 | [ADMISSION_CONTRACT.md](ADMISSION_CONTRACT.md) |
| P4 | 대기열 API와 Redis 전이, 정책과 epoch 수명주기 | [records/ISSUE_13_VALIDATION.md](records/ISSUE_13_VALIDATION.md) |
| P5 | 구매 경로 연결과 소비 원장 | [records/ISSUE_14_VALIDATION.md](records/ISSUE_14_VALIDATION.md) |
| P6 | 대기 화면과 polling | [records/ISSUE_15_VALIDATION.md](records/ISSUE_15_VALIDATION.md) |
| P7 | 실제 장애와 동시성 검증 | [records/ISSUE_16_VALIDATION.md](records/ISSUE_16_VALIDATION.md) |
| P8 | 같은 조건의 A/B/C 부하 비교 | [records/ISSUE_17_VALIDATION.md](records/ISSUE_17_VALIDATION.md) |
| P9 | 측정 근거의 문서화 | 위 "읽는 순서"의 4–6번 문서 |

기록 문서는 그때 쓴 그대로이고, 날짜순 경과와 검토 이력을 담고 있습니다([records/README.md](records/README.md)). 결론만 필요하면 "읽는 순서"의 문서로 충분합니다.
