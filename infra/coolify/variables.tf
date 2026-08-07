variable "linode_token" {
  description = "Linode API token. Prefer the LINODE_TOKEN env var over setting this."
  type        = string
  default     = ""
  sensitive   = true
}

variable "label" {
  description = "Name prefix for all resources in this stack."
  type        = string
  default     = "coolify-linode-pgbouncer"
}

variable "region" {
  description = "Linode region. Run `linode-cli regions list` to see options."
  type        = string
  default     = "us-ord"
}

variable "instance_type" {
  description = <<-EOT
    Linode plan for the Coolify host. Coolify's documented minimum is 2 CPU /
    2 GB RAM; g6-standard-2 (2 vCPU, 4 GB) leaves room for the app containers
    alongside Coolify itself. g6-standard-1 (1 vCPU, 2 GB) works for a spike
    but builds are slow and OOM-prone.
  EOT
  type        = string
  default     = "g6-standard-2"
}

variable "image" {
  description = "Base image. Must support cloud-init."
  type        = string
  default     = "linode/ubuntu24.04"
}

variable "authorized_keys" {
  description = "SSH public keys granted root access to the host. At least one is required."
  type        = list(string)

  validation {
    condition     = length(var.authorized_keys) > 0
    error_message = "Provide at least one SSH public key, or you will be locked out of the host."
  }
}

variable "admin_ipv4_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach SSH (22) and the Coolify dashboard (8000).
    Defaults to nothing — set this to your own IP, e.g. ["203.0.113.4/32"].
    Leaving the dashboard open to the internet is how Coolify hosts get owned.
  EOT
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to the Linode instance."
  type        = list(string)
  default     = ["coolify-linode-pgbouncer", "coolify"]
}

variable "attach_data_volume" {
  description = "Attach a separate block-storage volume for Docker data."
  type        = bool
  default     = false
}

variable "data_volume_size_gb" {
  description = "Size of the optional Docker data volume, in GB."
  type        = number
  default     = 40
}
