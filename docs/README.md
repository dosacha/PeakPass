# PeakPass 문서 안내

이 디렉터리는 PeakPass의 공개 문서를 모아 둔 공간입니다.
문서는 현재 코드 기준 구현 상태와 실제로 확인한 동작 범위를 중심으로 정리합니다.

## 진행 중인 Issue 인수인계

2026-10-03 기준으로 P1~P6가 main에 병합됐고 다음 단계는 P7([#16](https://github.com/dosacha/PeakPass/issues/16), 실제 장애·동시성·수량 불변식 검증)이다. 단계별 수용 상태와 SHA의 단일 기준은 총괄 [#9](https://github.com/dosacha/PeakPass/issues/9)의 상태표이고, 각 단계가 고치지 않고 남긴 한계는 #25(P4)·#27(P5)·#29(P6)에 있다.

- [P7 / Issue #16 실제 장애·동시성 검증과 P8 인계](ISSUE_16_VALIDATION.md) — 제품 이미지 컨테이너 여러 개에 가한 실제 Redis·PostgreSQL·프로세스 장애, Redis 전이 로그 재생과 최종 SQL·원장 대조, 실제 브라우저의 장애 시나리오, 발견 사항(F1·F2)과 관찰·미검증 항목. 제품 코드는 바꾸지 않았다. 수용 상태는 총괄 #9를 따른다.
- [P6 / Issue #15 구현 검증과 P7·P8 인계](ISSUE_15_VALIDATION.md) — 대기 카드, 고정·적응형 폴링과 jitter, 요청 직렬화와 늦은 응답 폐기, 구매 연결과 결과 미확인 구매의 복구, 입장 인지 계측, 실제 브라우저 검증 범위와 미검증 항목. PR #28로 병합됨(main `2ba3a5c`). 수용 상태는 총괄 #9를 따른다.
- [P5 / Issue #14 구현 검증과 P6·P7·P8 인계](ISSUE_14_VALIDATION.md) — 예약·직접 checkout의 admission 소비 원장, 재시도·회수, 구매 요청 인터페이스, 검증 범위와 미검증 항목. PR #26으로 병합됨(main `2d67cc3`). 수용 상태는 총괄 #9를 따른다.
- [P4 / Issue #13 구현 검증과 P5·P6 인계](ISSUE_13_VALIDATION.md) — 인증 대기열 API와 Redis Lua 전이, 정책·epoch 수명주기, P5 협력 인터페이스와 P6 API 인계, 검증 범위, PR #24 오토리뷰 후속. PR #24로 병합됨(main `678ac7c`). 수용 상태는 총괄 #9를 따른다.
- [P4 / Issue #13 착수 당시 인수인계](ISSUE_13_HANDOFF.md) — 병합된 admission-v1, 첫 설계 설명, Redis·PG policy 경계와 P4/P5/P6 검증·인계 기준. 구현 결과는 위 검증 문서를 따른다.
- [입장 제어 계약 admission-v1](ADMISSION_CONTRACT.md) — P4~P8의 상태/API·단일 소비·실패 복구·실험 profile과 검증 경계. 제품 구현·실측 결과와 구분한다.
- [P3 / Issue #12 이전 인수인계](ISSUE_12_HANDOFF.md) — P3 착수 당시의 수용 P2 증거와 설계 과제. 현재 계약·P4 착수는 위 문서를 따른다.
- [P2 쓰기 기준선과 실제 증거](FLASH_SALE_BASELINE.md) · [측정 계약](FLASH_SALE_EVIDENCE.md)

## 먼저 읽을 문서

1. [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md)
2. [TRANSACTION_CONSISTENCY.md](./TRANSACTION_CONSISTENCY.md)
3. [REDIS_STRATEGY.md](./REDIS_STRATEGY.md)
4. [GRAPHQL_RATIONALE.md](./GRAPHQL_RATIONALE.md)

## 주제별 문서

### 아키텍처

- [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md)
- [CASE_STUDY.md](./CASE_STUDY.md)
- [adr/0001-read-write-separation.md](./adr/0001-read-write-separation.md)

### 정합성과 데이터 처리

- [TRANSACTION_CONSISTENCY.md](./TRANSACTION_CONSISTENCY.md)
- [REDIS_STRATEGY.md](./REDIS_STRATEGY.md)
- [GRAPHQL_RATIONALE.md](./GRAPHQL_RATIONALE.md)
- [GRAPHQL_EXAMPLES.md](./GRAPHQL_EXAMPLES.md)

### 애플리케이션 안정성

- [PRODUCTION_HARDENING.md](./PRODUCTION_HARDENING.md)

### 성능과 부하 테스트

- [LOAD_TEST_STRATEGY.md](./LOAD_TEST_STRATEGY.md)
- [PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)

