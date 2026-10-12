# 작업 기록

입장 제어를 단계별로 만들면서 그때그때 쓴 검증 기록입니다. 문서마다 한 단계의 실행 명령, 결과, 검토에서 나온 지적과 처리, 검증하지 못한 것이 들어 있습니다. 대부분 영어이고 날짜순으로 덧붙여 쓴 문서라, 뒤에 나온 정정이 앞 문장을 고칩니다.

수치의 요약과 해석은 [성능 보고서](../PERFORMANCE_REPORT.md)와 [설계 문서](../ADMISSION_DESIGN_AND_OPERATIONS.md)에 있습니다. 단계 번호의 뜻은 [문서 안내](../README.md)의 "작업 기록"에 있습니다.

| 문서 | 단계 |
| --- | --- |
| [ISSUE_10_VALIDATION.md](ISSUE_10_VALIDATION.md) | P1 쓰기 부하 하네스 |
| [ISSUE_13_VALIDATION.md](ISSUE_13_VALIDATION.md) | P4 대기열 API와 Redis 전이 |
| [ISSUE_14_VALIDATION.md](ISSUE_14_VALIDATION.md) | P5 구매 경로 연결과 소비 원장 |
| [ISSUE_15_VALIDATION.md](ISSUE_15_VALIDATION.md) | P6 대기 화면과 polling |
| [ISSUE_16_VALIDATION.md](ISSUE_16_VALIDATION.md) | P7 실제 장애와 동시성 검증 |
| [ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md) | P8 같은 조건의 A/B/C 부하 비교 |

읽을 때 알아 둘 것:

- 문서 안의 commit, branch, 파일 이름은 쓴 때의 것입니다. 그 뒤 바뀐 이름은 `frontend/task21-contract-check.html` → `frontend/contract-check.html`, `frontend/task22-keyboard-check.html` → `frontend/keyboard-check.html`입니다.
- 단계를 시작할 때 쓴 문서(`docs/ISSUE_11_HANDOFF.md`–`ISSUE_13_HANDOFF.md`)와 단계별 구현 계획(`docs/superpowers/plans/`)은 2026-10-12에 main에서 지웠습니다. 기록이 그 문서를 가리키는 곳은 링크 없이 이름만 남아 있고, 내용은 git 이력에 있습니다.
- 기록이 가리키는 검증 manifest는 `test-results/admission-v1/`에 있습니다.
- 부하 측정의 k6 원본과 앱 로그는 2026-10-11에 지웠습니다. 남은 것은 `load-test/results/`의 index와 ZIP입니다.
