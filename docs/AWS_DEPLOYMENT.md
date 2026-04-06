# AWS 배포 개요

이 문서는 저장소의 `terraform/` 코드를 기준으로 의도된 AWS 배포 구조를 정리한다.  
문서 작성 시점에 로컬에서는 `terraform validate`를 다시 실행하지 못했으므로, 이 문서는 “구성 의도와 적용 순서” 중심으로 읽는 것이 맞다.

## 포함된 리소스

`terraform/` 디렉터리에는 다음 파일이 있다.

- `vpc.tf`
- `security_groups.tf`
- `alb.tf`
- `ecs.tf`
- `rds.tf`
- `redis.tf`
- `iam.tf`
- `sns.tf`
- `outputs.tf`
- `variables.tf`
- `terraform.tfvars.example`

## 목표 배포 구조

- VPC
- public / private subnet
- ALB
- ECS Fargate 또는 ECS 서비스
- RDS PostgreSQL
- ElastiCache Redis
- CloudWatch 로그 / 알람
- SSM Parameter Store 연동 전제

## 권장 흐름

1. ECR에 앱 이미지를 푸시
2. `terraform.tfvars` 준비
3. `terraform init`
4. `terraform fmt -check -recursive`
5. `terraform validate`
6. `terraform plan`
7. `terraform apply`

## 변수 예시

예시 파일은 [terraform.tfvars.example](C:/Users/dosac/projects/PeakPass/terraform/terraform.tfvars.example)에 있다.

중요 변수:

- `aws_region`
- `environment`
- `container_image`
- `db_password`
- `alarm_email`

## 앱 배포 시 확인할 환경 변수

- `DATABASE_URL`
- `REDIS_URL`
- `PORT`
- `NODE_ENV`
- `LOG_LEVEL`
- `JWT_SECRET`

## 운영 체크 포인트

- ALB health check 경로: `/health`
- readiness 판단 경로: `/ready`
- DB / Redis 보안 그룹은 앱 계층에서만 접근 허용
- 민감 정보는 `tfvars` 하드코딩보다 SSM 또는 CI secret로 주입

## 현재 상태 메모

- Terraform 파일은 저장소에 존재함
- 이 문서 작성 시점 로컬 환경에는 Terraform CLI가 없어 재검증하지 못함
- 따라서 실제 apply 전에는 반드시 `fmt`, `validate`, `plan`을 다시 실행해야 함
