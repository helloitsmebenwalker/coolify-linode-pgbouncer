output "bucket" {
  value = linode_object_storage_bucket.this.label
}

output "region" {
  value = var.region
}

output "hostname" {
  description = "Virtual-hosted address of the bucket."
  value       = linode_object_storage_bucket.this.hostname
}

output "s3_endpoint" {
  description = "Endpoint to give the S3 client (S3_ENDPOINT)."
  value       = "https://${var.region}.linodeobjects.com"
}

output "access_key" {
  value     = linode_object_storage_key.mailhook.access_key
  sensitive = true
}

output "secret_key" {
  description = "Linode returns this once, at creation. Terraform state is the only copy."
  value       = linode_object_storage_key.mailhook.secret_key
  sensitive   = true
}

output "mailhook_env" {
  description = <<-EOT
    Paste into Coolify's env editor for the mailhook service:
      terraform -chdir=infra/storage output -raw mailhook_env
  EOT
  sensitive   = true
  value       = <<-EOT
    S3_BUCKET=${linode_object_storage_bucket.this.label}
    S3_REGION=${var.region}
    S3_ENDPOINT=https://${var.region}.linodeobjects.com
    S3_ACCESS_KEY_ID=${linode_object_storage_key.mailhook.access_key}
    S3_SECRET_ACCESS_KEY=${linode_object_storage_key.mailhook.secret_key}
  EOT
}
