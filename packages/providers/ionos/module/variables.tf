variable "name" {
  description = "Server name; its data centre is named opscrew-<name>."
  type        = string
}

variable "app" {
  description = "The app's name, for the server's app label (IONOS takes only lower-case letters and digits in a label, so anything else is left out)."
  type        = string
}

variable "location" {
  description = "IONOS Cloud location of the server's data centre, for example de/fra/1."
  type        = string
}

variable "server_type" {
  description = "OpsCrew's size id for the vCPU server, for example vcpu-2-4: its vCPUs and GB of memory, mapped to its cores, memory and disk in main.tf."
  type        = string
}

variable "image" {
  description = "Operating system image (Ubuntu 24.04), looked up by IONOS's image alias in the location."
  type        = string
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...), which IONOS places on the server's disk when it creates it."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at the first boot; empty for none."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (port 22) through the NIC firewall; empty for none (public SSH closed). The server has no IPv6 address, so IPv6 networks get no rule."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443) through the NIC firewall. IPv6 networks get no rule."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed, in the NIC firewall and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to every IPv4 address; null for none."
  type        = number
  default     = null
}

variable "ssh_key_id" {
  description = "Unused: IONOS keeps no copy of a key, so every server takes the deploy key's text (ssh_public_key). OpsCrew passes the app's other servers the same text here."
  type        = string
  default     = null
}
