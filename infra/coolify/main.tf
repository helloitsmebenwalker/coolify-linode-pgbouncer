locals {
  # Ports 22 and 8000 are admin-only; 80/443 must stay open for Traefik to
  # serve the deployed apps and complete ACME challenges.
  admin_cidrs = length(var.admin_ipv4_cidrs) > 0 ? var.admin_ipv4_cidrs : []
}

resource "linode_instance" "coolify" {
  label           = var.label
  region          = var.region
  type            = var.instance_type
  image           = var.image
  authorized_keys = var.authorized_keys
  tags            = var.tags

  # Root password is required by the API but unusable: SSH is key-only after
  # cloud-init runs.
  root_pass = random_password.root.result

  metadata {
    user_data = base64encode(file("${path.module}/cloud-init.yaml"))
  }

  lifecycle {
    ignore_changes = [image, root_pass]
  }
}

resource "random_password" "root" {
  length  = 32
  special = true
}

resource "linode_firewall" "coolify" {
  label           = "${var.label}-fw"
  linodes         = [linode_instance.coolify.id]
  tags            = var.tags
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  dynamic "inbound" {
    for_each = length(local.admin_cidrs) > 0 ? [1] : []
    content {
      label    = "allow-ssh"
      action   = "ACCEPT"
      protocol = "TCP"
      ports    = "22"
      ipv4     = local.admin_cidrs
    }
  }

  # 8000 is the dashboard, 6001 is the realtime channel that streams build and
  # deployment logs into the UI, and 6002 backs the in-browser terminal. All
  # three are contacted by your browser directly, not proxied through 443, so
  # opening 8000 alone gives you a dashboard whose logs never load.
  #
  # Once you put the dashboard behind a domain on 443, all three can be closed.
  dynamic "inbound" {
    for_each = length(local.admin_cidrs) > 0 ? [1] : []
    content {
      label    = "allow-coolify-admin"
      action   = "ACCEPT"
      protocol = "TCP"
      ports    = "8000,6001,6002"
      ipv4     = local.admin_cidrs
    }
  }

  inbound {
    label    = "allow-http"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "80"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  inbound {
    label    = "allow-https"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "443"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }
}

resource "linode_volume" "data" {
  count     = var.attach_data_volume ? 1 : 0
  label     = "${var.label}-data"
  region    = var.region
  size      = var.data_volume_size_gb
  linode_id = linode_instance.coolify.id
  tags      = var.tags
}
