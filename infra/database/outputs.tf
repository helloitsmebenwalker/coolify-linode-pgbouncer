output "instance_id" {
  value = linode_database_postgresql_v2.this.id
}

output "host" {
  description = "Primary host. This is the DIRECT connection — it bypasses PgBouncer."
  value       = linode_database_postgresql_v2.this.host_primary
}

output "port" {
  description = "Direct Postgres port."
  value       = linode_database_postgresql_v2.this.port
}

output "root_username" {
  value = linode_database_postgresql_v2.this.root_username
}

output "root_password" {
  value     = linode_database_postgresql_v2.this.root_password
  sensitive = true
}

output "ca_cert" {
  value     = linode_database_postgresql_v2.this.ca_cert
  sensitive = true
}

output "direct_database_url" {
  description = "Direct connection string. Managed databases require TLS."
  value = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=require",
    linode_database_postgresql_v2.this.root_username,
    linode_database_postgresql_v2.this.root_password,
    linode_database_postgresql_v2.this.host_primary,
    linode_database_postgresql_v2.this.port,
    var.pool_database,
  )
  sensitive = true
}

output "pool_name" {
  value = var.pool_name
}

output "pooled_database_url_hint" {
  description = <<-EOT
    The pooler listens on its own port, assigned when the pool is created.
    Terraform cannot read it back (no provider resource yet), so fetch it with:

      make pool-show

    which prints the PgBouncer host/port and the ready-to-use DATABASE_URL.
  EOT
  value       = "run: make pool-show"
}
