locals {
  # `ip_address` is deprecated in the provider. The instance is created without
  # a private IP, so the ipv4 set holds exactly the public address.
  public_ipv4 = tolist(linode_instance.coolify.ipv4)[0]
}

output "instance_id" {
  description = "Linode instance ID of the Coolify host."
  value       = linode_instance.coolify.id
}

output "ipv4" {
  description = "Public IPv4 of the Coolify host. Point your DNS A records here."
  value       = local.public_ipv4
}

output "ipv6" {
  value = linode_instance.coolify.ipv6
}

output "ssh" {
  description = "SSH command for the host."
  value       = "ssh root@${local.public_ipv4}"
}

output "coolify_dashboard" {
  description = "Coolify setup UI. First visit creates the admin account — do it promptly."
  value       = "http://${local.public_ipv4}:8000"
}

output "database_allow_list_entry" {
  description = "Feed this into the database stack's allow_list so the app can reach Postgres."
  value       = "${local.public_ipv4}/32"
}
