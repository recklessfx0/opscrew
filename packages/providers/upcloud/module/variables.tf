variable "name" {
  description = "The server's hostname and title at UpCloud: 1 to 63 letters, digits or dashes."
  type        = string

  validation {
    # UpCloud's provider takes a hostname that is a domain name (validator/domainname.go). OpsCrew's
    # names are one label: up to 63 characters, no dash first or last, and not only digits.
    condition     = can(regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$", var.name)) && can(regex("[a-zA-Z-]", var.name))
    error_message = "UpCloud needs a server hostname of 1 to 63 letters, digits or dashes that neither starts nor ends with a dash and isn't only digits, and OpsCrew would name this server \"${var.name}\". Choose a different app name (or extra server's name) so that the server's name fits."
  }
}

variable "app" {
  description = "The app's name, which the server's opscrew-app label holds."
  type        = string
}

variable "location" {
  description = "UpCloud zone, for example de-fra1."
  type        = string
}

variable "server_type" {
  description = "UpCloud Premium plan, for example PREMIUM-2xCPU-4GB; main.tf maps it to the MaxIOPS disk its price includes."
  type        = string
}

variable "image" {
  description = "Operating system image (Ubuntu 24.04), mapped to UpCloud's template in main.tf."
  type        = string
}

variable "backups" {
  description = "Turn on UpCloud's Simple Backup (a daily backup kept 7 days, 20% more than the plan's price; `opscrew design` shows it)."
  type        = bool
  default     = false
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...), which UpCloud places at creation."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at the first boot; empty for none."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (port 22) through the server's own firewall; empty for none (public SSH closed)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    # The first boot writes each one into the firewall's rules; one that isn't a network would stop
    # it, and the server would power itself off.
    condition     = alltrue([for cidr in var.ssh_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Each network in ssh_allowed_cidrs must be an address range such as 203.0.113.7/32 or 2001:db8::/48. Correct it in the tfvars file, then plan again."
  }
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443) through the server's own firewall."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    condition     = alltrue([for cidr in var.http_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Each network in http_allowed_cidrs must be an address range such as 173.245.48.0/20 or 2400:cb00::/32. Correct it in the tfvars file, then plan again."
  }
}

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed, in the server's own firewall and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to everyone in the server's own firewall; null for none."
  type        = number
  default     = null

  validation {
    # A conditional, not ||: an engine that evaluates both sides would compare null.
    condition     = var.wireguard_port == null ? true : var.wireguard_port >= 1 && var.wireguard_port <= 65535 && floor(var.wireguard_port) == var.wireguard_port
    error_message = "The WireGuard port must be a whole number from 1 to 65535, or null for none."
  }
}

variable "ssh_key_id" {
  description = "Unused: UpCloud keeps no key object, so every server takes the deploy key's text (ssh_public_key). OpsCrew passes the app's other servers the same text here."
  type        = string
  default     = null
}
