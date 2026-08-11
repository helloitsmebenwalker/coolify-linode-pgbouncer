variable "linode_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "bucket_label" {
  description = <<-EOT
    Bucket name. Object Storage bucket names are global per region and become
    part of the hostname, so this must be DNS-safe and is likely to collide if
    it is generic — prefix it with something of yours.
  EOT
  type        = string
  default     = "mailhook-archive"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_label))
    error_message = "bucket_label must be lowercase, DNS-safe, 3-63 characters."
  }
}

variable "region" {
  description = <<-EOT
    Object Storage region, e.g. us-ord-1. Put this in the same region as the
    Coolify host and the managed database: egress between Linode regions is
    billable and every archived email crosses this path once.
  EOT
  type        = string
  default     = "us-ord-1"
}

variable "key_label" {
  description = "Label for the access key the service authenticates with."
  type        = string
  default     = "mailhook"
}

variable "versioning" {
  description = <<-EOT
    Keep previous versions of an object. The pipeline is idempotent — a replay
    rewrites identical bytes to the same key — so versioning is not needed for
    correctness, but it does turn an accidental delete into a recoverable one.
  EOT
  type        = bool
  default     = false
}

variable "abort_incomplete_multipart_days" {
  description = <<-EOT
    Multipart uploads that never complete are invisible in a bucket listing and
    billable forever. Reap them.
  EOT
  type        = number
  default     = 7
}

variable "expire_after_days" {
  description = <<-EOT
    Delete archived messages after this many days. 0 keeps them indefinitely.
    Set it deliberately: this bucket holds full email bodies and attachments,
    which is usually the most sensitive data in the system and often carries a
    retention obligation in both directions.
  EOT
  type        = number
  default     = 0
}
