# Terraform Outputs - All important infrastructure details

# Application Endpoint
output "app_url" {
  value       = "http://${aws_lb.main.dns_name}"
  description = "Application URL (HTTP)"
}

output "app_health_check" {
  value       = "http://${aws_lb.main.dns_name}/health"
  description = "Health check endpoint"
}

output "app_readiness_check" {
  value       = "http://${aws_lb.main.dns_name}/ready"
  description = "Readiness check endpoint"
}

output "app_graphql_endpoint" {
  value       = "http://${aws_lb.main.dns_name}/graphql"
  description = "GraphQL endpoint"
}

# Database
output "database_endpoint" {
  value       = aws_db_instance.postgres.endpoint
  description = "RDS PostgreSQL endpoint (host:port)"
}

output "database_host" {
  value       = aws_db_instance.postgres.address
  description = "RDS PostgreSQL host"
}

output "database_port" {
  value       = aws_db_instance.postgres.port
  description = "RDS PostgreSQL port"
  sensitive   = false
}

output "database_name" {
  value       = aws_db_instance.postgres.db_name
  description = "Database name"
}

output "database_username" {
  value       = "postgres"
  description = "Database master username"
}

# Redis
output "redis_endpoint" {
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
  description = "Redis cluster endpoint"
}

output "redis_port" {
  value       = aws_elasticache_cluster.redis.port
  description = "Redis port"
  sensitive   = false
}

output "redis_cluster_id" {
  value       = aws_elasticache_cluster.redis.cluster_id
  description = "Redis cluster ID"
}

# Network
output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID"
}

output "public_subnets" {
  value       = aws_subnet.public[*].id
  description = "Public subnet IDs"
}

output "private_subnets" {
  value       = aws_subnet.private[*].id
  description = "Private subnet IDs"
}

# Load Balancer
output "load_balancer_dns" {
  value       = aws_lb.main.dns_name
  description = "Load balancer DNS name"
}

output "load_balancer_arn" {
  value       = aws_lb.main.arn
  description = "Load balancer ARN"
}

# ECS
output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "ECS cluster name"
}

output "ecs_service_name" {
  value       = aws_ecs_service.app.name
  description = "ECS service name"
}

# Connection Strings
output "database_url" {
  value       = "postgresql://${var.db_username}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${var.db_name}"
  description = "PostgreSQL connection string (without password)"
  sensitive   = true
}

output "redis_url" {
  value       = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:${aws_elasticache_cluster.redis.port}"
  description = "Redis connection URL"
}

# Summary
output "summary" {
  value = {
    application  = "http://${aws_lb.main.dns_name}"
    database     = "${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}"
    redis        = "${aws_elasticache_cluster.redis.cache_nodes[0].address}:${aws_elasticache_cluster.redis.port}"
    region       = var.aws_region
    environment  = var.environment
    cluster      = aws_ecs_cluster.main.name
    service      = aws_ecs_service.app.name
  }
  description = "Infrastructure summary"
}
