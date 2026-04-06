# SNS Topic for Alarm Notifications

resource "aws_sns_topic" "alarms" {
  count = var.enable_alarms ? 1 : 0
  name  = "${var.app_name}-alarms"

  tags = {
    Name = "${var.app_name}-alarms"
  }
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count     = var.enable_alarms && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
