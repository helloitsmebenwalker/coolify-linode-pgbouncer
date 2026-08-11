terraform {
  required_version = ">= 1.6.0"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.41"
    }
  }
}

provider "linode" {
  # Falls back to LINODE_TOKEN in the environment, which is how the other
  # stacks in this repo are driven.
  token = var.linode_token != "" ? var.linode_token : null
}
