# PeakPass Infrastructure as Code — Terraform
# 
# Deploys to AWS:
# - VPC with public/private subnets across 2 AZs
# - RDS PostgreSQL (Multi-AZ for high availability)
# - ElastiCache Redis (with replication)
# - ECS Fargate (containerized app)
# - ALB (Application Load Balancer)
# - Security groups, IAM roles, monitoring

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment for remote state (S3 backend)
  # backend "s3" {
  #   bucket         = "peakpass-terraform-state"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

# AWS Provider
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "PeakPass"
      Environment = var.environment
      ManagedBy   = "Terraform"
      CreatedAt   = timestamp()
    }
  }
}
