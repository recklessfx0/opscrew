output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = one([for nic in upcloud_server.this.network_interface : nic.ip_address if nic.type == "public" && nic.ip_address_family == "IPv4"])
}

output "ipv6_address" {
  description = "Public IPv6 address of the server, or null when it has none."
  value       = one([for nic in upcloud_server.this.network_interface : nic.ip_address if nic.type == "public" && nic.ip_address_family == "IPv6"])
}

output "server_id" {
  description = "UUID of the server, by which OpsCrew finds it at UpCloud."
  value       = upcloud_server.this.id
}

output "server_name" {
  description = "Server title (and hostname)."
  value       = upcloud_server.this.title
}

# The root module reads every server module's deploy key from ssh_key_id. UpCloud keeps no key
# object, so this is the key's public half, which the app's other servers take as text too.
output "ssh_key_id" {
  description = "Public half of the deploy key, for the app's other servers on UpCloud."
  value       = var.ssh_public_key
}
