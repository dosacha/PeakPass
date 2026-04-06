# ADR 0001: REST write-side와 GraphQL read-side 분리

## 상태

승인

## 맥락

PeakPass는 정합성이 중요한 예약과 체크아웃을 다룬다.  
동시에 이벤트 상세, 내 주문, 내 티켓처럼 조회 조합이 많은 화면도 필요하다.

## 결정

- 명령 API는 REST로 유지
- 조회 API는 GraphQL로 제공

## 이유

- REST는 트랜잭션, 멱등성 키, 상태 코드 설명이 단순함
- GraphQL은 조회 집계와 overfetching 감소에 유리함
- 면접에서 trade-off를 설명하기 쉬움

## 결과

- 구조가 명확해짐
- GraphQL을 전면 도입했을 때의 복잡성을 줄임
- read-side 완성도가 따라오지 않으면 일부 resolver가 placeholder로 남을 수 있음
