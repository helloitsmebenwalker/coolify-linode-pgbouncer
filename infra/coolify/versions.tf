terraform {
  required_version = ">= 1.6.0"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.30"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "linode" {
  # Reads LINODE_TOKEN from the environment. The dev container forwards it
  # from your host shell (see .devcontainer/devcontainer.json).
  token = var.linode_token != "" ? var.linode_token : null
}
