locals {
  # The Premium plans OpsCrew offers, each with the MaxIOPS disk its price includes, in GB.
  plans = {
    "PREMIUM-2xCPU-2GB"  = 50
    "PREMIUM-2xCPU-4GB"  = 50
    "PREMIUM-2xCPU-8GB"  = 100
    "PREMIUM-4xCPU-8GB"  = 100
    "PREMIUM-4xCPU-16GB" = 150
  }

  # UpCloud's public templates, by the title UpCloud gives them.
  images = {
    "Ubuntu 24.04" = "Ubuntu Server 24.04 LTS (Noble Numbat)"
  }

  # The server's own firewall, from the networks another provider's cloud firewall gets.
  server_firewall = templatefile("${path.module}/server-firewall.sh.tftpl", {
    ssh_sources    = join(" ", var.ssh_allowed_cidrs)
    web_sources    = var.web ? join(" ", var.http_allowed_cidrs) : ""
    wireguard_port = var.wireguard_port == null ? "" : tostring(var.wireguard_port)
  })

  # The first boot every cloud-init provider gets. The scheduled check's key goes in as a second
  # authorized key (YAML-quoted); none without it.
  cloud_config = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
    web             = var.web
  })

  # What separates the parts of the server's user data.
  boundary = "opscrew-first-boot"
}

resource "upcloud_server" "this" {
  hostname = var.name
  title    = var.name
  zone     = var.location
  plan     = var.server_type
  labels   = { "opscrew-app" = var.app }

  # UpCloud's templates run cloud-init, which needs the metadata service.
  metadata = true

  # UpCloud's own firewall (its Public & Utility firewall) stays off: it is stateless, so letting
  # the answers to the server's own connections back in would open thousands of ports to the whole
  # internet. The server's own stateful firewall, the first step of its first boot, takes its place:
  # cloud firewall: none; server firewall: on.
  firewall = false

  # The plan's disk, on MaxIOPS storage, from Ubuntu's template.
  template {
    storage = local.images[var.image]
    size    = local.plans[var.server_type]
    tier    = "maxiops"
  }

  # The public IPv4 address the plan includes, and UpCloud's utility network.
  network_interface {
    index             = 1
    type              = "public"
    ip_address_family = "IPv4"
  }

  network_interface {
    index = 2
    type  = "utility"
  }

  # The deploy key, which UpCloud places at creation for its default user: UpCloud keeps no key
  # object. No password is made or sent.
  login {
    keys              = [var.ssh_public_key]
    create_password   = false
    password_delivery = "none"
  }

  # UpCloud hands user_data to cloud-init, through its metadata service. It is a MIME multipart in
  # two parts: the server's own firewall as a boothook, then the cloud-config every cloud-init
  # provider gets. cloud-init runs a boothook before the cloud-config, a few seconds after the
  # server starts, and at every boot: a server that powered itself off after a failed step (and
  # that UpCloud's provider starts again on an update) runs the step again and fails closed again.
  # set -e lets no failure of the step pass, so its own trap powers the server off. Only once the
  # step has returned does the boothook write its marker, /etc/opscrew/server-firewall.done (root's
  # alone, mode 0600), which keeps later boots from rewriting the rules; opscrew-firewall.service
  # loads them at every boot. Whether UpCloud takes a MIME user data as it is waits for the live
  # pass.
  user_data = <<-EOT
    Content-Type: multipart/mixed; boundary="${local.boundary}"
    MIME-Version: 1.0

    --${local.boundary}
    Content-Type: text/cloud-boothook; charset="us-ascii"

    #!/bin/bash
    set -euo pipefail
    exec >>/var/log/opscrew-first-boot.log 2>&1
    if [ -e /etc/opscrew/server-firewall.done ]; then exit 0; fi
    ${local.server_firewall}
    install -m 0600 /dev/null /etc/opscrew/server-firewall.done
    date -Is >/etc/opscrew/server-firewall.done
    --${local.boundary}
    Content-Type: text/cloud-config; charset="us-ascii"

    ${local.cloud_config}
    --${local.boundary}--
  EOT

  # Simple Backup's week plan when the plan asks for backups: a backup of the server's disk every
  # day at 03:00, each kept 7 days, for 20% more than the plan's price.
  dynamic "simple_backup" {
    for_each = var.backups ? ["dailies"] : []
    content {
      plan = simple_backup.value
      time = "0300"
    }
  }

  lifecycle {
    # A changed user data, login or template would make UpCloud build the server and its disk
    # again; OpsCrew never does that silently. A server taken over with an import block has no user
    # data, login or template name in the state, which then stays as it is.
    ignore_changes = [user_data, login, template]
  }
}
