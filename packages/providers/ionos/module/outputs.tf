output "ipv4_address" {
  description = "Public IPv4 address of the server: its reserved address, which it keeps through a stop."
  value       = ionoscloud_ipblock.this.ips[0]
}

# OpsCrew gives an IONOS server no IPv6 address, so the app gets no AAAA record.
output "ipv6_address" {
  description = "Public IPv6 address of the server: always null on IONOS Cloud."
  value       = null
}

# OpsCrew reaches an IONOS server through its data centre, so its id carries both.
output "server_id" {
  description = "The server's data centre id and its own id, as <data centre id>/<server id>."
  value       = "${ionoscloud_datacenter.this.id}/${ionoscloud_server.this.id}"
}

output "server_name" {
  description = "Server name."
  value       = ionoscloud_server.this.name
}

# The root module reads every server module's deploy key from ssh_key_id. IONOS keeps no copy of
# a key, so this is the key's public half, which the app's other servers take as text too.
output "ssh_key_id" {
  description = "Public half of the deploy key, for the app's other servers on IONOS Cloud."
  value       = var.ssh_public_key
}
