locals {
  # OpsCrew's sizes as IONOS's vCPU servers: IONOS sells cores, memory (MB) and a disk rather
  # than named sizes, so the size's id stays OpsCrew's own. One Essential disk, the system's.
  sizes = {
    "vcpu-1-2"  = { cores = 1, ram_mb = 2048, disk_gb = 40 }
    "vcpu-2-4"  = { cores = 2, ram_mb = 4096, disk_gb = 80 }
    "vcpu-4-8"  = { cores = 4, ram_mb = 8192, disk_gb = 160 }
    "vcpu-2-8"  = { cores = 2, ram_mb = 8192, disk_gb = 80 }
    "vcpu-4-16" = { cores = 4, ram_mb = 16384, disk_gb = 160 }
  }
  size = local.sizes[var.server_type]

  # IONOS's public images change name with each update, so the image is found by its alias.
  images = {
    "Ubuntu 24.04" = "ubuntu:24.04"
  }

  # IONOS takes only lower-case letters and digits in a label (my-shop becomes myshop).
  app_label = replace(lower(var.app), "/[^a-z0-9]/", "")

  # The server has no IPv6 address, so the NIC firewall holds IPv4 networks only.
  ssh_ipv4  = distinct([for cidr in var.ssh_allowed_cidrs : cidr if !strcontains(cidr, ":")])
  http_ipv4 = distinct([for cidr in var.http_allowed_cidrs : cidr if !strcontains(cidr, ":")])

  web_ports = [
    { name = "HTTP", protocol = "TCP", port = 80 },
    { name = "HTTPS", protocol = "TCP", port = 443 },
    { name = "HTTP/3", protocol = "UDP", port = 443 },
  ]

  # A NIC firewall rule has one source, so each port gets one rule per network.
  rules = concat(
    # SSH from the allowed networks; no rule once public SSH is closed (an empty list), when SSH
    # answers on the app's private network only.
    [
      for cidr in local.ssh_ipv4 :
      { name = "SSH", protocol = "TCP", port = 22, cidr = cidr }
    ],
    # Ports 80 and 443, only on a server that serves the web.
    flatten([
      for rule in var.web ? local.web_ports : [] :
      [for cidr in local.http_ipv4 : merge(rule, { cidr = cidr })]
    ]),
    [{ name = "Ping", protocol = "ICMP", port = null, cidr = "0.0.0.0/0" }],
    # WireGuard answers nothing without a valid key, and devices roam, so it is open to all.
    [
      for port in var.wireguard_port[*] :
      { name = "WireGuard", protocol = "UDP", port = port, cidr = "0.0.0.0/0" }
    ],
  )
}

data "ionoscloud_image" "this" {
  image_alias = local.images[var.image]
  type        = "HDD"
  cloud_init  = "V1"
  location    = var.location
}

# The server's own data centre: it costs nothing by itself, and deleting it deletes the server,
# its disk, its LAN and its firewall rules with it.
resource "ionoscloud_datacenter" "this" {
  name        = "opscrew-${var.name}"
  location    = var.location
  description = "OpsCrew's data centre of the server ${var.name}."
}

resource "ionoscloud_lan" "this" {
  datacenter_id = ionoscloud_datacenter.this.id
  public        = true
  name          = "public"
}

# The server's reserved IPv4 address (billed per 30 days, in each size's price). IONOS gives a
# stopped server's dynamic address back to its pool, so a reserved one keeps the app's DNS right
# through a stop. It belongs to the contract, not the data centre: Terraform deletes it on its own.
resource "ionoscloud_ipblock" "this" {
  location = ionoscloud_datacenter.this.location
  size     = 1
  name     = "opscrew-${var.name}"
}

resource "ionoscloud_server" "this" {
  name          = var.name
  datacenter_id = ionoscloud_datacenter.this.id
  type          = "VCPU"
  cores         = local.size.cores
  ram           = local.size.ram_mb
  image_name    = data.ionoscloud_image.this.id

  # The deploy key's text, which IONOS places on the disk when it creates it. No password is set.
  ssh_keys = [var.ssh_public_key]

  volume {
    name      = var.name
    size      = local.size.disk_gb
    disk_type = "ESSENTIAL"

    # The provider passes user_data to IONOS as it is, and IONOS takes it base64-encoded. The
    # scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      ssh_public_key  = var.ssh_public_key
      check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
      web             = var.web
    }))
  }

  # The reserved address on the public LAN. The firewall is on from the start with no rule, which
  # lets nothing in until the rules below are made; it filters incoming traffic only.
  nic {
    lan             = ionoscloud_lan.this.id
    name            = "public"
    dhcp            = true
    ips             = [ionoscloud_ipblock.this.ips[0]]
    firewall_active = true
    firewall_type   = "INGRESS"
  }

  label {
    key   = "managedby"
    value = "opscrew"
  }

  label {
    key   = "app"
    value = local.app_label
  }

  lifecycle {
    # IONOS can't change the image, the key or the first-boot setup of a server it created: a
    # change would make a new server, and its disk with it. OpsCrew never does that silently.
    ignore_changes = [image_name, ssh_keys, volume[0].user_data]
  }
}

# One resource per rule, never a list inside the NIC: removing a rule from such a list rewrites the
# rules after it (the provider's documentation).
resource "ionoscloud_firewall" "this" {
  for_each = { for rule in local.rules : "${rule.name} ${rule.cidr}" => rule }

  datacenter_id    = ionoscloud_datacenter.this.id
  server_id        = ionoscloud_server.this.id
  nic_id           = ionoscloud_server.this.primary_nic
  name             = each.value.name
  type             = "INGRESS"
  protocol         = each.value.protocol
  port_range_start = each.value.port
  port_range_end   = each.value.port

  # No source lets every IPv4 address in: with no source, IONOS's rule is for IPv4 only.
  source_ip = each.value.cidr == "0.0.0.0/0" ? null : each.value.cidr
}
