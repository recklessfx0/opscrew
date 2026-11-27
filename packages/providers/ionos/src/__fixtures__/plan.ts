/** A deploy key's public half, synthetic. */
export const DEPLOY_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)} opscrew-deploy`;

/** What a fixture plan holds for its one server module. */
export interface IonosPlanOptions {
  /** The module call, `server` for the app's server. */
  module?: string;
  /** The NIC's `firewall_active`; absent leaves it out of the NIC, as a module that never set it. */
  firewallActive?: boolean;
  /** The networks the module's SSH rules come from (`ssh_allowed_cidrs`, IPv4 only). */
  sshCidrs?: string[];
  /** The networks the module's web rules come from (`http_allowed_cidrs`, IPv4 only). */
  httpCidrs?: string[];
  /** The WireGuard port, or none. */
  wireguardPort?: number;
  /** Whether the firewall rules' `server_id` refers to this module's server (as the module writes it). */
  rulesOnServer?: boolean;
}

/** One `ionoscloud_firewall` the module plans: its key, name, protocol, port and source. */
interface PlannedRule {
  key: string;
  name: string;
  protocol: string;
  port?: number;
  /** Absent: every IPv4 address (the module sets no source for 0.0.0.0/0). */
  cidr?: string;
}

/** The rules the module plans for `options`, as its `local.rules` lists them. */
function plannedRules(options: IonosPlanOptions): PlannedRule[] {
  const source = (cidr: string) => (cidr === "0.0.0.0/0" ? {} : { cidr });
  const web = [
    { name: "HTTP", protocol: "TCP", port: 80 },
    { name: "HTTPS", protocol: "TCP", port: 443 },
    { name: "HTTP/3", protocol: "UDP", port: 443 },
  ];
  return [
    ...(options.sshCidrs ?? ["203.0.113.7/32"]).map((cidr) => ({
      key: `SSH ${cidr}`,
      name: "SSH",
      protocol: "TCP",
      port: 22,
      ...source(cidr),
    })),
    ...web.flatMap((rule) =>
      (options.httpCidrs ?? ["173.245.48.0/20"]).map((cidr) => ({
        key: `${rule.name} ${cidr}`,
        ...rule,
        ...source(cidr),
      })),
    ),
    { key: "Ping 0.0.0.0/0", name: "Ping", protocol: "ICMP" },
    ...(options.wireguardPort === undefined
      ? []
      : [
          {
            key: "WireGuard 0.0.0.0/0",
            name: "WireGuard",
            protocol: "UDP",
            port: options.wireguardPort,
          },
        ]),
  ];
}

/**
 * A plan's JSON (`show -json`) creating one IONOS server module as OpsCrew writes it: its data
 * centre, public LAN, reserved IPv4 address, server (whose NIC has `firewall_active` as given) and
 * one `ionoscloud_firewall` per network and port. Ids are unknown before apply, so the plan lists
 * them in `after_unknown`, and the rules reach the server through their configuration's references.
 */
export function ionosPlanJson(options: IonosPlanOptions = {}): unknown {
  const module = options.module ?? "server";
  const prefix = `module.${module}`;
  const rules = plannedRules(options);
  const nic: Record<string, unknown> = {
    dhcp: true,
    dhcpv6: null,
    firewall: [],
    firewall_type: "INGRESS",
    name: "public",
    security_groups_ids: [],
    ...(options.firewallActive === undefined ? {} : { firewall_active: options.firewallActive }),
  };
  const resources = [
    {
      address: `${prefix}.ionoscloud_datacenter.this`,
      type: "ionoscloud_datacenter",
      name: "this",
      values: { name: "opscrew-shop", location: "de/fra/1", sec_auth_protection: false },
      unknown: { id: true, cpu_architecture: true, features: true },
    },
    {
      address: `${prefix}.ionoscloud_lan.this`,
      type: "ionoscloud_lan",
      name: "this",
      values: { name: "public", public: true },
      unknown: { id: true, datacenter_id: true },
    },
    {
      address: `${prefix}.ionoscloud_ipblock.this`,
      type: "ionoscloud_ipblock",
      name: "this",
      values: { name: "opscrew-shop", location: "de/fra/1", size: 1 },
      unknown: { id: true, ips: true, ip_consumers: true },
    },
    {
      address: `${prefix}.ionoscloud_server.this`,
      type: "ionoscloud_server",
      name: "this",
      values: {
        name: "shop",
        type: "VCPU",
        cores: 2,
        ram: 4096,
        ssh_keys: [DEPLOY_KEY],
        allow_replace: false,
        label: [
          { key: "app", value: "shop" },
          { key: "managedby", value: "opscrew" },
        ],
        nic: [nic],
        volume: [{ name: "shop", size: 80, disk_type: "ESSENTIAL", user_data: "I2Nsb3VkLWNvbmZpZwo=" }],
      },
      unknown: {
        id: true,
        datacenter_id: true,
        image_name: true,
        primary_nic: true,
        primary_ip: true,
        nic: [{ id: true, ips: true, lan: true, mac: true }],
        volume: [{ boot_server: true }],
      },
    },
    ...rules.map((rule) => ({
      address: `${prefix}.ionoscloud_firewall.this[${JSON.stringify(rule.key)}]`,
      type: "ionoscloud_firewall",
      name: "this",
      index: rule.key,
      values: {
        name: rule.name,
        protocol: rule.protocol,
        type: "INGRESS",
        port_range_start: rule.port ?? null,
        port_range_end: rule.port ?? null,
        icmp_code: null,
        icmp_type: null,
        source_mac: null,
        ...(rule.cidr === undefined ? {} : { source_ip: rule.cidr }),
      },
      unknown: {
        id: true,
        datacenter_id: true,
        server_id: true,
        nic_id: true,
        target_ip: true,
        ...(rule.cidr === undefined ? { source_ip: true } : {}),
      },
    })),
  ];
  const serverReferences =
    options.rulesOnServer === false
      ? ["var.server_id"]
      : ["ionoscloud_server.this.id", "ionoscloud_server.this"];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: prefix,
            resources: resources.map(({ unknown: _, ...resource }) => ({
              ...resource,
              mode: "managed",
              provider_name: "registry.opentofu.org/ionos-cloud/ionoscloud",
            })),
          },
        ],
      },
    },
    resource_changes: resources.map(({ address, type, name, values, unknown }) => ({
      address,
      module_address: prefix,
      mode: "managed",
      type,
      name,
      change: { actions: ["create"], before: null, after: values, after_unknown: unknown },
    })),
    configuration: {
      root_module: {
        module_calls: {
          [module]: {
            source: "./modules/ionos-instance",
            module: {
              resources: [
                {
                  address: "ionoscloud_server.this",
                  mode: "managed",
                  type: "ionoscloud_server",
                  name: "this",
                  expressions: {
                    datacenter_id: {
                      references: ["ionoscloud_datacenter.this.id", "ionoscloud_datacenter.this"],
                    },
                  },
                },
                {
                  address: "ionoscloud_firewall.this",
                  mode: "managed",
                  type: "ionoscloud_firewall",
                  name: "this",
                  expressions: {
                    datacenter_id: {
                      references: ["ionoscloud_datacenter.this.id", "ionoscloud_datacenter.this"],
                    },
                    server_id: { references: serverReferences },
                    nic_id: {
                      references: ["ionoscloud_server.this.primary_nic", "ionoscloud_server.this"],
                    },
                  },
                  for_each_expression: { references: ["local.rules"] },
                },
              ],
            },
          },
        },
      },
    },
  };
}
