# RDS PostgreSQL Database
# 
# Configuration:
# - Multi-AZ for high availability (automatic failover)
# - Automated backups with 30-day retention
# - Storage autoscaling (20GB initial → 100GB max)
# - Enhanced monitoring
# - Daily backup snapshots
# - Deletion protection enabled

# DB Subnet Group
resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.app_name}-db-subnet-group"
  }
}

# RDS PostgreSQL Instance
resource "aws_db_instance" "postgres" {
  identifier            = "${var.app_name}-db"
  engine                = "postgres"
  engine_version        = var.db_engine_version
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage

  # Credentials
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = true # High availability

  # Storage
  storage_type      = "gp3"
  storage_encrypted = true
  iops              = 3000

  # Backups
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:00-04:00"         # UTC
  maintenance_window      = "mon:04:00-mon:05:00" # UTC
  copy_tags_to_snapshot   = true

  # Monitoring
  monitoring_interval             = var.enable_detailed_monitoring ? 60 : 0
  monitoring_role_arn             = var.enable_detailed_monitoring ? aws_iam_role.rds_monitoring[0].arn : null
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Deletion protection
  deletion_protection = true

  # Performance Insights
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Automatic minor version upgrade
  auto_minor_version_upgrade = true

  tags = {
    Name = "${var.app_name}-postgres"
  }

  lifecycle {
    ignore_changes = [password] # Prevent recreation on password change
  }
}

# IAM Role for RDS Monitoring
resource "aws_iam_role" "rds_monitoring" {
  count = var.enable_detailed_monitoring ? 1 : 0
  name  = "${var.app_name}-rds-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "monitoring.rds.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  count      = var.enable_detailed_monitoring ? 1 : 0
  role       = aws_iam_role.rds_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# CloudWatch Alarm: Database CPU
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-db-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alert when DB CPU exceeds 80%"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.id
  }
}

# CloudWatch Alarm: Database Connections
resource "aws_cloudwatch_metric_alarm" "db_connections" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-db-high-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alert when DB connections exceed 80"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.id
  }
}

# CloudWatch Alarm: Free Storage Space
resource "aws_cloudwatch_metric_alarm" "db_storage" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${var.app_name}-db-low-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 3600
  statistic           = "Average"
  threshold           = 5368709120 # 5GB in bytes
  alarm_description   = "Alert when DB storage < 5GB"
  alarm_actions       = var.alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.id
  }
}

# Outputs
output "db_endpoint" {
  value       = aws_db_instance.postgres.endpoint
  description = "RDS database endpoint"
}

output "db_instance_id" {
  value       = aws_db_instance.postgres.id
  description = "RDS database instance identifier"
}

output "db_name" {
  value       = aws_db_instance.postgres.db_name
  description = "Database name"
}

output "db_port" {
  value       = aws_db_instance.postgres.port
  description = "Database port"
}
