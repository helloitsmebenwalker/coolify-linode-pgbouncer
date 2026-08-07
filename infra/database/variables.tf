variable "linode_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "label" {
  description = "Name of the managed database cluster."
  type        = string
  default     = "coolify-linode-pgbouncer-pg"
}

variable "region" {
  description = "Must be a region where Akamai Managed Databases are offered."
  type        = string
  default     = "us-ord"
}

variable "engine_id" {
  description = "Database engine. Run `linode-cli databases engines` for current values."
  type        = string
  default     = "postgresql/16"
}

variable "instance_type" {
  description = <<-EOT
    Managed database plan. Connection pooling (PgBouncer) needs a paid plan;
    the number of backend connections a pool may claim scales with the plan,
    so the nanode's ceiling is low. g6-standard-1 is a sane floor for testing
    pooling behaviour under load.
  EOT
  type        = string
  default     = "g6-standard-1"
}

variable "cluster_size" {
  description = "1 for a single node, 3 for HA with automatic failover."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 3], var.cluster_size)
    error_message = "cluster_size must be 1 or 3."
  }
}

variable "allow_list" {
  description = <<-EOT
    CIDRs permitted to connect. Include the Coolify host
    (`terraform -chdir=../coolify output database_allow_list_entry`) and your
    own IP if you want to run the benchmark from the dev container.
  EOT
  type        = list(string)
  default     = []
}

# --- PgBouncer pool -------------------------------------------------------

variable "pool_name" {
  description = "Label for the PgBouncer connection pool."
  type        = string
  default     = "app-pool"
}

variable "pool_database" {
  description = "Database the pool fronts."
  type        = string
  default     = "defaultdb"
}

variable "pool_mode" {
  description = <<-EOT
    transaction | session | statement.

    transaction is the default and the reason to use PgBouncer at all: a backend
    connection is held only for the duration of a transaction, so hundreds of
    idle clients share a handful of backends. It breaks session-scoped features
    (LISTEN/NOTIFY, session advisory locks, WITH HOLD cursors, plain `SET`).
    session mode keeps all of those working but pools far less aggressively.
  EOT
  type        = string
  default     = "transaction"

  validation {
    condition     = contains(["transaction", "session", "statement"], var.pool_mode)
    error_message = "pool_mode must be transaction, session, or statement."
  }
}

variable "pool_size" {
  description = "Backend connections reserved for this pool."
  type        = number
  default     = 10
}
