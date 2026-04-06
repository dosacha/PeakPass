# 아키텍처 다이어그램

이 문서는 현재 저장소 기준의 구조를 간단하게 보여준다.  
설명 대상은 `Fastify + REST write-side + GraphQL read-side + PostgreSQL + Redis` 조합이다.

## 시스템 아키텍처

```mermaid
flowchart LR
    Client[브라우저 또는 API 클라이언트]

    subgraph App[PeakPass API]
      Fastify[Fastify]
      REST[REST 명령 API]
      GQL[GraphQL 조회 API]
      MW[인증 / 레이트 리미트 / 멱등성]
      Service[도메인 서비스]
    end

    subgraph Data[데이터 계층]
      PG[(PostgreSQL)]
      Redis[(Redis)]
    end

    Client --> Fastify
    Fastify --> MW
    MW --> REST
    MW --> GQL
    REST --> Service
    GQL --> Service
    Service --> PG
    Service --> Redis
```

## 배포 구조

로컬 기준은 `docker-compose.yml`, 운영 기준은 `terraform/` 디렉터리의 AWS 리소스를 따른다.

```mermaid
flowchart TB
    Internet[사용자]
    ALB[ALB]
    ECS[ECS Fargate 또는 EC2 앱]
    RDS[(RDS PostgreSQL)]
    Elasticache[(ElastiCache Redis)]
    CW[CloudWatch Logs / Alarm]
    SSM[SSM Parameter Store]

    Internet --> ALB
    ALB --> ECS
    ECS --> RDS
    ECS --> Elasticache
    ECS --> CW
    ECS --> SSM
```

## 데이터 흐름

```mermaid
flowchart LR
    A[클라이언트 요청]
    B[Fastify]
    C[미들웨어]
    D[도메인 서비스]
    E[(PostgreSQL)]
    F[(Redis)]
    G[응답]

    A --> B
    B --> C
    C --> D
    D --> E
    D --> F
    E --> D
    F --> D
    D --> G
```

## 시퀀스 다이어그램

### 예약 hold 생성

```mermaid
sequenceDiagram
    participant C as Client
    participant API as REST /reservations
    participant S as ReservationService
    participant PG as PostgreSQL
    participant R as Redis

    C->>API: POST /reservations
    API->>S: createReservation(input)
    S->>PG: BEGIN
    S->>PG: 이벤트 조회
    S->>PG: reservations INSERT
    S->>PG: COMMIT
    S->>R: setReservationHold(reservationId, ttl)
    API-->>C: 201 Created
```

### 체크아웃

```mermaid
sequenceDiagram
    participant C as Client
    participant API as REST /checkouts
    participant S as CheckoutService
    participant PG as PostgreSQL
    participant R as Redis

    C->>API: POST /checkouts + Idempotency-Key
    API->>R: 기존 멱등성 결과 조회
    alt 캐시 적중
        API-->>C: 기존 성공 응답 반환
    else 캐시 미적중
        API->>PG: SERIALIZABLE 트랜잭션 시작
        API->>S: checkout(input, client)
        S->>PG: orders 조회 by idempotency_key
        S->>PG: events 행 잠금 FOR UPDATE
        S->>PG: orders INSERT
        S->>PG: events.available_seats 차감
        S->>PG: payment_records INSERT pending
        S->>PG: reservation converted
        API->>PG: COMMIT
        API->>R: reservation hold 삭제
        API->>R: 이벤트 캐시 무효화
        API->>R: 멱등성 성공 결과 저장
        API-->>C: 201 Created with empty tickets
    end
```

### settlement webhook과 패스 발급

```mermaid
sequenceDiagram
    participant P as Payment Provider
    participant API as REST /webhooks/payments/settlement
    participant S as CheckoutService
    participant PG as PostgreSQL
    participant R as Redis
    participant Seq as ticket_number_seq

    P->>API: POST webhook + Idempotency-Key
    API->>R: 기존 멱등성 결과 조회
    alt 캐시 적중
        API-->>P: 기존 결과 반환
    else 캐시 미적중
        API->>PG: SERIALIZABLE 트랜잭션 시작
        API->>S: processPaymentWebhook()
        S->>PG: order FOR UPDATE
        S->>PG: payment_records INSERT settled
        S->>PG: orders status = paid
        loop quantity
          S->>Seq: nextval('ticket_number_seq')
          S->>PG: tickets INSERT
        end
        API->>PG: COMMIT
        API->>R: 이벤트 캐시 무효화
        API->>R: 멱등성 결과 저장
        API-->>P: 200 OK
    end
```

## 현재 상태 메모

- 예약 hold와 멱등성 결과는 Redis를 사용하지만, 정합성 기준은 PostgreSQL이다.
- checkout 핵심 경로는 트랜잭션과 행 잠금으로 보호한다.
- 티켓은 checkout 직후가 아니라 settlement webhook 이후에 발급된다.
- duplicate settlement webhook에도 티켓이 중복 발급되지 않도록 구현되어 있다.
