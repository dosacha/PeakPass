# ElastiCache Redis Cluster
# 
# Configuration:
# - Multi-node cluster with automatic failover
# - Automatic backups for disaster recovery
# - Enhanced security (encryption, VPC)
# - CloudWatch monitoring

# Redis Subnet Group
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.app_name}-redis-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.app_name}-redis-subnet-group"
  }
}

# ElastiCache Redis Replication Group
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.app_name}-redis"
  description          = "Redis replication group for ${var.app_name}"
  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_cache_clusters
  parameter_group_name = aws_elasticache_parameter_group.redis.name
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  # High availability
  automatic_failover_enabled = var.redis_automatic_failover_enabled
  multi_az_enabled           = var.redis_num_cache_clusters > 1

  # Backups
  snapshot_retention_limit = var.redis_snapshot_retention_limit
  snapshot_window          = "03:00-05:00" # UTC

  # Maintenance
  maintenance_window = "mon:05:00-mon:06:00" # UTC

  # Logging
  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # Requires AUTH token (optional for prod)

  tags = {
    Name = "${var.app_name}-redis"
  }
}

# Redis Parameter Group (custom settings)
resource "aws_elasticache_parameter_group" "redis" {
  name   = "${var.app_name}-redis-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru" # Evict least recently used when memory full
  }

  parameter {
    name  = "timeout"
    value = "300" # Close idle connections after 5 mins
  }

  parameter {
    name  = "tcp-keepalive"
    value = "60" # Keepalive every 60 seconds
  }

  tags = {
    Name = "${var.app_name}-redis-params"
  }
}

# CloudWatch Log Group for Redis Slow Log
resource "aws_cloudwatch_log_group" "redis_slow_log" {
  name              = "/aws/elasticache/${var.app_name}-redis-slow-log"
  retention_in_days = 7

  tags = {
    Name = "${var.app_name}-redis-slow-log"
  }
}

# CloudWatch Alarm: Redis CPU
resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-redis-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "Alert when Redis CPU exceeds 75%"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }
}

# CloudWatch Alarm: Redis Memory
resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-redis-high-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "Alert when Redis memory exceeds 85%"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }
}

# CloudWatch Alarm: Redis Evictions
resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-redis-evictions"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Evictions"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "Alert when Redis evictions occur"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }
}
