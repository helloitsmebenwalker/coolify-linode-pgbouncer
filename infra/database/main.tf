resource "linode_database_postgresql_v2" "this" {
  label        = var.label
  engine_id    = var.engine_id
  region       = var.region
  type         = var.instance_type
  cluster_size = var.cluster_size
  allow_list   = var.allow_list

  updates = {
    duration    = 4
    frequency   = "weekly"
    hour_of_day = 7
    day_of_week = 1
  }
}

# The Linode provider has no resource for PgBouncer connection pools yet — the
# API gained POST /databases/postgresql/instances/{id}/connection-pools in the
# March 2026 Managed Databases update, ahead of provider support. Until there
# is one, drive the endpoint directly. The script is idempotent: it updates the
# pool in place if it already exists.
resource "terraform_data" "pgbouncer_pool" {
  triggers_replace = {
    instance_id = linode_database_postgresql_v2.this.id
    pool_name   = var.pool_name
    database    = var.pool_database
    mode        = var.pool_mode
    size        = var.pool_size
    username    = linode_database_postgresql_v2.this.root_username
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/pgbouncer-pool.sh apply"

    environment = {
      INSTANCE_ID = linode_database_postgresql_v2.this.id
      POOL_NAME   = var.pool_name
      POOL_DB     = var.pool_database
      POOL_MODE   = var.pool_mode
      POOL_SIZE   = var.pool_size
      POOL_USER   = linode_database_postgresql_v2.this.root_username
    }
  }

  provisioner "local-exec" {
    when       = destroy
    command    = "${path.module}/scripts/pgbouncer-pool.sh delete"
    on_failure = continue

    environment = {
      INSTANCE_ID = self.triggers_replace.instance_id
      POOL_NAME   = self.triggers_replace.pool_name
    }
  }
}
