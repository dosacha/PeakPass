# UTF-8 문서 복원 보고서

작업 목적: `docs/` 아래 Markdown 문서 중 한글이 깨지며 연속 물음표 패턴이 남은 파일을 복원 또는 재작성했다.

## 검출 기준

- 대상: `docs/**/*.md`
- 패턴: 정규식 `\?{3,}`
- 초기 검출 파일:
  - `docs/INTERVIEW_PRACTICE_4_STEPS.md`
  - `docs/INTERVIEW_STORIES.md`
  - `docs/PORTFOLIO_DOCUMENTATION.md`
  - `docs/TECHNICAL_QA.md`
  - `docs/TRANSACTION_CONSISTENCY.md`

## 파일별 처리 결과

| 파일 | 처리 분기 | 정상 commit | 근거 |
|---|---|---|---|
| `docs/TRANSACTION_CONSISTENCY.md` | 복원 | `229f639 feat(project): PeakPass 핵심 흐름 및 문서 정리` | `git log --reverse --oneline -- docs/TRANSACTION_CONSISTENCY.md` 결과 유일한 commit이며, `git show 229f639:docs/TRANSACTION_CONSISTENCY.md` 내용의 `\?{3,}` 매칭이 0건이었다. 해당 내용을 UTF-8 BOM 없음으로 현재 working tree에 덮어썼다. |
| `docs/INTERVIEW_PRACTICE_4_STEPS.md` | 재작성 | 없음 | `git log --reverse --oneline -- docs/INTERVIEW_PRACTICE_4_STEPS.md` 결과가 비어 있었고 `git ls-files`에도 없었다. 파일명과 깨진 헤더 구조상 면접 연습 스크립트 문서로 판단하고, 현재 코드와 정상 문서를 근거로 새로 작성했다. |
| `docs/INTERVIEW_STORIES.md` | 재작성 | 없음 | Git 추적 이력이 없는 ignored 로컬 문서였다. 파일명상 면접에서 사용할 짧은 스토리 모음으로 판단하고, README와 현재 코드 흐름을 근거로 새로 작성했다. |
| `docs/PORTFOLIO_DOCUMENTATION.md` | 재작성 | 없음 | Git 추적 이력이 없는 ignored 로컬 문서였다. 파일명상 포트폴리오 문서 안내로 판단하고, README와 docs의 정상 문서를 근거로 새로 작성했다. |
| `docs/TECHNICAL_QA.md` | 재작성 | 없음 | Git 추적 이력이 없는 ignored 로컬 문서였다. 파일명과 깨진 질문 헤더 구조상 기술 Q&A 문서로 판단하고, 현재 `src/` 코드와 migration, 테스트 파일을 근거로 새로 작성했다. |

## 재작성 근거 파일

재작성 문서는 다음 실제 코드와 정상 문서를 근거로 작성했다.

- `README.md`
- `docs/CASE_STUDY.md`
- `docs/ARCHITECTURE_DIAGRAMS.md`
- `docs/GRAPHQL_RATIONALE.md`
- `docs/REDIS_STRATEGY.md`
- `docs/PRODUCTION_HARDENING.md`
- `docs/LOAD_TEST_STRATEGY.md`
- `docs/PERFORMANCE_REPORT.md`
- `docs/DEPLOYMENT_RUNBOOK.md`
- `src/main.ts`
- `src/api/app.ts`
- `src/api/health.ts`
- `src/api/rest/reservations.ts`
- `src/api/rest/checkouts.ts`
- `src/api/rest/payments.ts`
- `src/api/middleware/idempotency.ts`
- `src/api/middleware/rateLimit.ts`
- `src/api/middleware/webhook-signature.ts`
- `src/api/graphql/server.ts`
- `src/api/graphql/complexity.ts`
- `src/api/graphql/types.ts`
- `src/api/graphql/resolvers.ts`
- `src/core/services/reservation.service.ts`
- `src/core/services/checkout.service.ts`
- `src/infra/postgres/client.ts`
- `src/infra/redis/commands.ts`
- `src/infra/config.ts`
- `src/infra/migrations/001_init_schema.sql`
- `src/infra/migrations/002_ticket_number_sequence.sql`
- `src/infra/migrations/003_payment_provider_transaction_unique.sql`
- `src/tests/unit/graphql-complexity.test.ts`
- `src/tests/unit/webhook-signature.test.ts`

## 검증 결과

요청된 검증 명령 실행 결과 `Count = 0`을 확인했다.

```powershell
Get-ChildItem -Path . -Recurse -Include *.md |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -Pattern '\?{3,}' |
  Measure-Object | Select-Object Count
```

## 인코딩 처리

파일 쓰기는 PowerShell `Get-Content`/`Set-Content`를 사용하지 않고, `.NET`의 `[System.IO.File]::WriteAllText`와 `new System.Text.UTF8Encoding($false)`로 수행했다.