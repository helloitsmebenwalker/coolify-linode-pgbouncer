resource "linode_object_storage_bucket" "this" {
  label  = var.bucket_label
  region = var.region

  # Private, always. The objects here are complete email messages: headers,
  # bodies and attachments. Nothing reads them over HTTP — the service uses
  # signed S3 requests, and consumers should do the same.
  acl           = "private"
  cors_enabled  = false
  versioning    = var.versioning

  lifecycle_rule {
    id      = "abort-incomplete-multipart"
    enabled = var.abort_incomplete_multipart_days > 0

    abort_incomplete_multipart_upload_days = var.abort_incomplete_multipart_days
  }

  dynamic "lifecycle_rule" {
    for_each = var.expire_after_days > 0 ? [1] : []

    content {
      id      = "expire-archived-mail"
      enabled = true

      expiration {
        days = var.expire_after_days
      }
    }
  }
}

# Scoped to this bucket only. A tenant-wide Object Storage key would let a
# compromised mailhook container read every bucket in the account; this one can
# only touch the archive it writes.
resource "linode_object_storage_key" "mailhook" {
  label = var.key_label

  bucket_access {
    bucket_name = linode_object_storage_bucket.this.label
    region      = var.region
    permissions = "read_write"
  }
}
