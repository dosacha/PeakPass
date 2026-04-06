# 부하 테스트 가이드

PeakPass 시스템의 성능과 안정성을 검증하기 위한 k6 기반 부하 테스트 스크립트들입니다.

## 설치

### k6 설치
```bash
# macOS (Homebrew)
brew install k6

# Windows (Chocolatey)
choco install k6

# 또는 Docker
docker pull grafana/k6
```

### 프로젝트 의존성
```bash
npm install
```

## 테스트 시나리오

### 1. Baseline (기본 부하)
**목적**: 정상 트래픽 상황에서의 성능 측정

**부하 프로필**:
- 0min-1min: 10 VU로 워밍업
- 1min-4min: 50 VU로 점진적 증가
- 4min-9min: 50 VU 유지 (안정 상태)
- 9min-10min: 0 VU로 회복

**주요 메트릭**:
- p95 응답 시간 < 1000ms
- p99 응답 시간 < 2000ms
- 에러율 < 5%

**실행**:
```bash
k6 run load-test/baseline.js

# 또는 원격 서버 테스트
BASE_URL=http://api.example.com:3000 k6 run load-test/baseline.js

# Docker 환경
docker run -v $PWD:/scripts grafana/k6 run /scripts/load-test/baseline.js
```

**분석**:
- 시스템이 50명의 동시 사용자를 조용히 처리할 수 있는지 확인
- 정상 운영 상태에서의 응답 시간 기준선 설정
- 데이터베이스 커넥션 풀 설정이 적절한지 검증

---

### 2. Spike (스파이크 부하)
**목적**: 갑작스러운 트래픽 급증 시 시스템 대응 능력 검증

**부하 프로필**:
- 분석 0sec-30sec: 10 VU 워밍업
- 30sec-35sec: **10 VU → 200 VU로 급증** (5초 내 20배 증가!)
- 35sec-65sec: 200 VU 유지 (스파이크 상황 지속)
- 65sec-75sec: 0 VU로 회복

**주요 메트릭**:
- p99 응답 시간 < 2000ms (여유 있게 설정)
- 에러율 < 10% (부분적 실패 허용)

**실행**:
```bash
k6 run load-test/spike.js
```

**분석 포인트**:
- 갑작스러운 요청 급증 시 큐 대기 시간 증가 여부
- 레이트 리미터 작동 확인 (정상적으로 요청 제한되는가?)
- 에러 메시지 타입 분석 (타임아웃 vs 리소스 부족 vs 레이트 리미트)
- 시스템 회복 시간 (200 VU → 0 VU 후 정상화까지 걸리는 시간)

---

### 3. Sustained Load (지속 부하)
**목적**: 고부하 상태에서 시스템이 얼마나 오래 안정적으로 운영되는지 확인

**부하 프로필**:
- 0min-2min: 50 VU로 워밍업 및 안정화
- 2min-10min: **100 VU 지속 부하** (메인 테스트 - 8분)
- 10min-12min: 100 VU 유지 (피크 유지)
- 12min-13min: 0 VU로 회복

**주요 메트릭**:
- p50 응답 시간 < 300ms (중간값)
- p95 응답 시간 < 800ms
- p99 응답 시간 < 1500ms
- 에러율 < 2%

**실행**:
```bash
k6 run load-test/sustained.js

# 조용한 모드 (요약만 출력)
k6 run --quiet load-test/sustained.js

# 결과를 JSON으로 저장
k6 run --out json=results.json load-test/sustained.js
```

**분석 포인트**:
- 메모리 누수 여부 (시간이 지날수록 응답 시간 악화되는가?)
- 연결 풀 고갈 여부 (특정 시점 이후 에러 급증하는가?)
- 데이터베이스 성능 저하 (타임스탤프 분석으로 특정 시점에 급악화되는가?)
- 캐시 효율성 (시간이 지날수록 응답 시간 개선되는가?)

---

## 실행 결과 해석

### 성공 기준
```
✓ Baseline 스크립트:
  - p95 < 1000ms: ✅
  - p99 < 2000ms: ✅
  - Error rate < 5%: ✅

✓ Spike 스크립트:
  - 200 VU 급증 시 처리 가능: ✅
  - 에러율 < 10%: ✅

✓ Sustained 스크립트:
  - 100 VU × 8분 지속: ✅
  - 메모리 누수 없음: ✅
  - 에러율 진행 중 증가 안함: ✅
```

### 일반적인 병목 현상

| 증상 | 원인 | 해결책 |
|------|------|--------|
| p95 > 1000ms | 데이터베이스 쿼리 느림 | 인덱스 추가, 쿼리 최적화 |
| 시간이 지날수록 느려짐 | 메모리 누수 | 좀비 연결 정리, 캐시 만료 |
| 200 VU에서 갑자기 많은 에러 | 커넥션 풀 부족 | pool_size 증가 |
| 특정 엔드포인트만 느림 | DataLoader 미적용 N+1 쿼리 | DataLoader 배치 처리 확인 |
| 에러: "429 Too Many Requests" | 레이트 리미터 작동 | window_ms/limit 조정 |

---

## 성능 최적화 체크리스트

### 데이터베이스
- [ ] 연결 풀 크기 (현재: max 20)
- [ ] 인덱스 설정 (events.date, checkouts.userId, tickets.eventId)
- [ ] 쿼리 실행 계획 검토

### 캐싱
- [ ] Redis 응답 시간 (< 10ms 목표)
- [ ] DataLoader 배치 크기 (현재: 최대 100개)
- [ ] TTL 설정 검토 (이벤트: 5분, 사용자: 10분)

### 애플리케이션
- [ ] 그래픽 쿼리 복잡도 제한 (현재: 5000 포인트)
- [ ] 응답 압축 (gzip) 활성화
- [ ] 요청 타임아웃 설정 (현재: 30초)

### 인프라
- [ ] CPU 사용률 (< 80% 목표)
- [ ] 메모리 사용률 (< 80% 목표)
- [ ] 네트워크 대역폭 확인

---

## 실제 배포 후 모니터링

부하 테스트 결과를 토대로 다음을 지속적으로 모니터링하세요:

### CloudWatch 메트릭
```bash
# ECS 태스크 모니터링
aws ecs describe-tasks \
  --cluster peakpass-cluster \
  --tasks $(aws ecs list-tasks --cluster peakpass-cluster | jq -r '.taskArns[0]') \
  --query 'tasks[].containerInstanceArn'

# RDS 성능
aws rds describe-db-instances \
  --db-instance-identifier peakpass-db \
  --query 'DBInstances[0].DBInstanceStatus'
```

### 알람 설정
- p95 응답 시간 > 1000ms
- 에러율 > 5%
- CPU 사용률 > 80%
- 메모리 사용률 > 80%

## 참고 자료

- [k6 공식 문서](https://k6.io/docs/)
- [k6 API 레퍼런스](https://k6.io/docs/javascript-api/)
- [부하 테스트 가이드](https://k6.io/docs/testing-guides/load-testing/)
