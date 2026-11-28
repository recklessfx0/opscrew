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

  # UpCloud runs user_data as a script, once, at the first boot: the shared first boot, which
  # applies the same cloud-config every provider gets through cloud-init. Its first step is the
  # server's own firewall, from the networks another provider's cloud firewall gets; it applies a
  # few seconds after the server starts. The scheduled check's key goes in as a second authorized
  # key (YAML-quoted); none without it.
  user_data = templatefile("${path.module}/first-boot.sh.tftpl", {
    server_firewall = templatefile("${path.module}/server-firewall.sh.tftpl", {
      ssh_sources    = join(" ", var.ssh_allowed_cidrs)
      web_sources    = var.web ? join(" ", var.http_allowed_cidrs) : ""
      wireguard_port = var.wireguard_port == null ? "" : tostring(var.wireguard_port)
    })
    cloud_config_b64 = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      ssh_public_key  = var.ssh_public_key
      check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
      web             = var.web
    }))
  })

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
    # A changed first-boot script, login or template would make UpCloud build the server and its
    # disk again; OpsCrew never does that silently. A server taken over with an import block has no
    # script, login or template name in the state, which then stays as it is.
    ignore_changes = [user_data, login, template]
  }
}
