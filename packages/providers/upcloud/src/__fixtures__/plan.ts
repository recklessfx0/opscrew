import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A deploy key's public half, synthetic. */
export const DEPLOY_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)} opscrew-deploy`;

/**
 * OpsCrew's first-boot files, which iac-templates adds beside the module (read here as the
 * module's `templatefile` reads them, never imported).
 */
const SHARED = new URL("../../../../iac-templates/shared/", import.meta.url);

/** `server-firewall.sh.tftpl` rendered as HCL's `templatefile` renders it: it interpolates only names. */
function renderServerFirewall(values: Record<string, string>): string {
  const file = fileURLToPath(new URL("server-firewall.sh.tftpl", SHARED));
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return source.replace(/\$\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** What separates the parts of the module's user data. */
export const MIME_BOUNDARY = "opscrew-first-boot";

/** What a fixture plan holds for its one server module. */
export interface UpcloudPlanOptions {
  /** The module call, `server` for the app's server. */
  module?: string;
  /** The networks of the server firewall's SSH rule (`ssh_allowed_cidrs`). */
  sshCidrs?: string[];
  /** The networks of its web rules (`http_allowed_cidrs`); none on a server without web. */
  httpCidrs?: string[];
  /** The WireGuard port, or none. */
  wireguardPort?: number;
  /** Whether the boothook holds the server firewall's step (as the module writes it). */
  firewallStep?: boolean;
  /** The cloud-config part; by default a stub, which the checks don't read. */
  cloudConfig?: string;
  /** The login block's keys; `null` leaves the login block out. */
  keys?: string[] | null;
  /** The planned `simple_backup` blocks: Simple Backup's week plan when the module turns it on. */
  simpleBackup?: Record<string, unknown>[];
}

/**
 * The `user_data` the module renders, byte for byte: a MIME multipart whose first part, a
 * boothook, sets up the server's own firewall once (or holds no step), and whose second part is
 * the cloud-config.
 */
export function userData(options: UpcloudPlanOptions = {}): string {
  const serverFirewall =
    options.firewallStep === false
      ? ""
      : renderServerFirewall({
          ssh_sources: (options.sshCidrs ?? ["203.0.113.7/32"]).join(" "),
          web_sources: (options.httpCidrs ?? ["173.245.48.0/20"]).join(" "),
          wireguard_port: options.wireguardPort === undefined ? "" : String(options.wireguardPort),
        });
  return [
    `Content-Type: multipart/mixed; boundary="${MIME_BOUNDARY}"`,
    "MIME-Version: 1.0",
    "",
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/cloud-boothook; charset="us-ascii"',
    "",
    "#!/bin/bash",
    "set -euo pipefail",
    "exec >>/var/log/opscrew-first-boot.log 2>&1",
    "if [ -e /etc/opscrew/server-firewall.done ]; then exit 0; fi",
    serverFirewall,
    "install -m 0600 /dev/null /etc/opscrew/server-firewall.done",
    "date -Is >/etc/opscrew/server-firewall.done",
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/cloud-config; charset="us-ascii"',
    "",
    options.cloudConfig ?? "#cloud-config\n",
    `--${MIME_BOUNDARY}--`,
    "",
  ].join("\n");
}

/** A part of a MIME multipart user data: its headers and its body. */
export interface MimePart {
  headers: Record<string, string>;
  body: string;
}

/**
 * The parts of a MIME multipart `text` whose boundary is {@link MIME_BOUNDARY}, in order: each
 * part's headers, by their lower-case names, and its body, without the line break before the next
 * boundary (RFC 2046).
 */
export function mimeParts(text: string): MimePart[] {
  const [, ...rest] = text.split(`\n--${MIME_BOUNDARY}`);
  return rest
    .filter((part) => !part.startsWith("--"))
    .map((part) => {
      const [head = "", ...body] = part.replace(/^\n/, "").split("\n\n");
      const headers = Object.fromEntries(
        head.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }),
      );
      return { headers, body: body.join("\n\n") };
    });
}

/**
 * A plan's JSON (`show -json`) creating one UpCloud server module as OpsCrew writes it: the
 * server, with the deploy key in its login block, the MIME user data in `user_data`, UpCloud's
 * own firewall off and Simple Backup as given. No `upcloud_firewall_rules`: the module never
 * makes one. The server's id is unknown before apply.
 */
export function upcloudPlanJson(options: UpcloudPlanOptions = {}): unknown {
  const module = options.module ?? "server";
  const address = `module.${module}.upcloud_server.this`;
  const keys = options.keys === undefined ? [DEPLOY_KEY] : options.keys;
  const nic = (index: number, type: string) => ({
    additional_ip_address: [],
    bootable: false,
    index,
    ip_address_family: "IPv4",
    source_ip_filtering: true,
    type,
  });
  // As `tofu show -json` gives a server the module plans (UpCloudLtd/upcloud 5.49.1).
  const values: Record<string, unknown> = {
    firewall: false,
    hostname: "shop",
    hot_resize: false,
    labels: { "opscrew-app": "shop" },
    login:
      keys === null ? [] : [{ create_password: false, keys, password_delivery: "none", user: null }],
    metadata: true,
    network_interface: [nic(1, "public"), nic(2, "utility")],
    plan: "PREMIUM-2xCPU-4GB",
    server_group: null,
    simple_backup: options.simpleBackup ?? [],
    storage_devices: [],
    template: [
      {
        backup_rule: [],
        delete_autoresize_backup: false,
        filesystem_autoresize: false,
        size: 50,
        storage: "Ubuntu Server 24.04 LTS (Noble Numbat)",
        tier: "maxiops",
      },
    ],
    title: "shop",
    user_data: userData(options),
    zone: "de-fra1",
  };
  const unknownNic = {
    additional_ip_address: [],
    ip_address: true,
    ip_address_floating: true,
    mac_address: true,
    network: true,
  };
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: `module.${module}`,
            resources: [
              {
                address,
                mode: "managed",
                type: "upcloud_server",
                name: "this",
                provider_name: "registry.opentofu.org/upcloudltd/upcloud",
                values,
              },
            ],
          },
        ],
      },
    },
    resource_changes: [
      {
        address,
        module_address: `module.${module}`,
        mode: "managed",
        type: "upcloud_server",
        name: "this",
        change: {
          actions: ["create"],
          before: null,
          after: values,
          after_unknown: {
            id: true,
            cpu: true,
            mem: true,
            labels: {},
            login: keys === null ? [] : [{ keys: keys.map(() => false), password: true }],
            network_interface: [unknownNic, unknownNic],
            template: [{ address: true, encrypt: true, id: true, title: true }],
          },
        },
      },
    ],
  };
}
