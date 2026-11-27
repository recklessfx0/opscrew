import type {
  CloudProviderDefinition,
  ModuleCall,
  PlannedFirewallRule,
  PlannedResourceJson,
  ProviderSecOps,
} from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";
import { IONOS_CREDENTIALS_HINT, IONOS_ENV, IONOS_TOKEN_MANAGER_URL } from "./client";
import { IONOS_CREDENTIALS, ionosConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";
import { HOURS_A_MONTH, HOURS_PER_30_DAYS, STATIC_RATES } from "./static-prices";

/** IONOS's Data Center Designer: the data centres, their servers, the snapshots and the tokens. */
const DCD_URL = "https://dcd.ionos.com/";
const DCD = "IONOS's Data Center Designer";

/** A snapshot's price by the hour, EUR: IONOS prices it per 30 days. */
const SNAPSHOT_PER_GB_HOUR = STATIC_RATES.snapshotGbPer30Days / HOURS_PER_30_DAYS;

/** What keeps billing until a delete, as every text says it. */
const STOPPED =
  "a stopped server still bills its disk and its reserved IPv4 address, and one shut down from its own system bills in full";

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's networks, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/** Resource address without `count`/`for_each` keys: `module.a.x.y["k"]` becomes `module.a.x.y`. */
function configAddress(address: string): string {
  return address.replace(/\[[^\]]*\]/g, "");
}

/** A list attribute's strings, or none. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The servers (addresses without instance keys) each firewall rule's `server_id` references, by
 * the rule's address, read from the plan's `configuration` section. A new server's id is unknown
 * before apply, so these references are the only way to see which server a rule is on.
 */
function ruleServers(planJson: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (module: unknown, prefix: string) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== "ionoscloud_firewall") continue;
      if (typeof resource.address !== "string") continue;
      const expressions = isRecord(resource.expressions) ? resource.expressions : {};
      const serverId = isRecord(expressions.server_id) ? expressions.server_id : {};
      const servers = new Set<string>();
      for (const reference of strings(serverId.references)) {
        const target = configAddress(reference).replace(/\.id$/, "");
        if (/^ionoscloud_server\.[^.]+$/.test(target)) servers.add(`${prefix}${target}`);
      }
      out.set(`${prefix}${resource.address}`, servers);
    }
    const calls = isRecord(module.module_calls) ? module.module_calls : {};
    for (const [name, call] of Object.entries(calls)) {
      if (isRecord(call)) walk(call.module, `${prefix}module.${name}.`);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.configuration)) {
    walk(planJson.configuration.root_module, "");
  }
  return out;
}

/**
 * A NIC firewall rule in the Hetzner rule shape: inbound unless it is `EGRESS` (a `BIDIRECTIONAL`
 * rule lets traffic in too), its protocol in lower case (`ANY` as `""`, every protocol; `ICMPv6`
 * as `icmp`), its port or range (none is every port) and its one source. A rule with no source
 * (or one known only after apply) lets every address of its family in: IPv4, unless it is ICMPv6.
 */
function nicFirewallRules({ values }: PlannedResourceJson): PlannedFirewallRule[] {
  const protocol = typeof values.protocol === "string" ? values.protocol.toLowerCase() : "";
  const start = typeof values.port_range_start === "number" ? values.port_range_start : undefined;
  const end = typeof values.port_range_end === "number" ? values.port_range_end : start;
  const source =
    typeof values.source_ip === "string" && values.source_ip !== ""
      ? values.source_ip
      : protocol === "icmpv6"
        ? "::/0"
        : "0.0.0.0/0";
  return [
    {
      direction: values.type === "EGRESS" ? "out" : "in",
      protocol: protocol === "any" ? "" : protocol === "icmpv6" ? "icmp" : protocol,
      port: start === undefined ? "" : start === end ? `${start}` : `${start}-${end}`,
      source_ips: [source],
    },
  ];
}

/**
 * True when the server's NIC has its firewall on and one of `firewalls` is a rule on the server:
 * by the server's id once both are known, or by the rule's reference to it in the configuration.
 * A NIC without `firewall_active` lets everything in.
 */
function nicFirewallAttached(
  server: PlannedResourceJson,
  firewalls: PlannedResourceJson[],
  planJson: unknown,
): boolean {
  const nics = Array.isArray(server.values.nic) ? server.values.nic : [];
  const active =
    nics.length > 0 && nics.every((nic) => isRecord(nic) && nic.firewall_active === true);
  if (!active) return false;
  const id = server.values.id;
  if (typeof id === "string" && firewalls.some(({ values }) => values.server_id === id)) {
    return true;
  }
  const references = ruleServers(planJson);
  const address = configAddress(server.address);
  return firewalls.some(
    (firewall) => references.get(configAddress(firewall.address))?.has(address) ?? false,
  );
}

/** SecOps's checks of a plan's IONOS servers and their NIC firewall rules. */
const SECOPS: ProviderSecOps = {
  noun: "server",
  rules: nicFirewallRules,
  attached: nicFirewallAttached,
  attachedText: "The server's IONOS Cloud NIC firewall is active, with OpsCrew's rules.",
  unattachedText:
    "The server's NIC firewall is off, or none of OpsCrew's firewall rules is on it, so IONOS would let every port be reached from the internet. Run `opscrew provision` again: it writes the server's module with the firewall on and its rules.",
  keylessText:
    "The server has no SSH key; IONOS needs one (or a password, which OpsCrew never sets) to create a Linux server. Add the deploy key.",
  backupsText:
    "OpsCrew turns on no IONOS Cloud backups: its own snapshots of the app's data cover them.",
};

/** IONOS Cloud, as OpsCrew creates servers there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "ionos",
  displayName: "IONOS Cloud",
  name: "IONOS",
  serverNoun: "server",
  // OpsCrew's own ids for the vCPU servers it offers (`vcpu-2-4`).
  sizeNoun: "size",
  consoleUrl: DCD_URL,
  accountUrl: DCD_URL,
  // No signupUrl: IONOS Cloud sells to businesses, and its sign-up page wasn't read.
  pricingUrl: "https://cloud.ionos.com/prices",
  credentials: {
    envVars: Object.values(IONOS_ENV),
    labels: { [IONOS_ENV.token]: "IONOS Cloud token" },
    mode: "any",
    createUrl: IONOS_CREDENTIALS.createUrl,
    // IONOS documents no format for its tokens.
    tokenRules: [],
    envPrefixes: ["IONOS"],
    apiPattern: /api\.ionos\.com|cloudapi\/v6|ionoscloud_/i,
  },
  connector: (deps) => ionosConnector(deps),
  regions: {
    locations: {
      "eu-central": ["de/fra/1", "de/fra/2", "de/txl"],
      "eu-north": ["de/txl"],
      "us-east": ["us/ewr"],
      "us-west": ["us/mci"],
      "ap-southeast": ["de/fra/1"],
    },
    locationNames: {
      "de/fra/1": "Frankfurt 1",
      "de/fra/2": "Frankfurt 2",
      "de/txl": "Berlin",
      "us/ewr": "Newark, near New York",
      "us/mci": "Lenexa, near Kansas City",
    },
    notes: {
      "eu-north":
        "IONOS Cloud has no location in the Nordics, so OpsCrew uses Berlin, its nearest, which is far from the Nordic countries.",
      "us-west":
        "IONOS Cloud's Las Vegas location has no vCPU servers, so OpsCrew uses Lenexa, near Kansas City, which is far from the US west coast.",
      "ap-southeast":
        "IONOS Cloud has no location in Asia or Oceania, so OpsCrew uses Frankfurt, which is very far from South-East Asia.",
    },
    // Approximate, for the delay estimates (research R5 §6).
    coordinates: {
      "de/fra/1": [50.1, 8.7],
      "de/fra/2": [50.1, 8.7],
      "de/txl": [52.5, 13.4],
      "us/ewr": [40.5, -74.5],
      "us/mci": [39.0, -94.7],
    },
  },
  offering: {
    currency: "EUR",
    // IONOS bills by the minute, until the server is deleted; "second" is the closer of the
    // contract's two counts, and differs by under a cent.
    billing: { model: "hourly", counts: "second", setupFee: false },
    defaultImage: "Ubuntu 24.04",
    backupPercent: 0,
    // IONOS's backups need an agent on the server and a backup unit; OpsCrew's own data
    // snapshots cover the data instead.
    providerBackups: false,
    backupsOutliveServer: true,
    snapshots: {
      kind: "per-gb",
      perGbMonth: SNAPSHOT_PER_GB_HOUR * HOURS_A_MONTH,
      perGbHour: SNAPSHOT_PER_GB_HOUR,
    },
    // Unverified until the live pass: IONOS doesn't say whether a snapshot outlives its data
    // centre, so OpsCrew assumes it does and keeps billing.
    serverSnapshotsOutliveServer: true,
    deleteProtection: false,
    // Cores and memory scale up live but down only with a reboot, and a disk only grows: a size
    // change is refused, and a move is the way.
    resize: false,
    offAfterRefusedResize: false,
    removal: { kind: "delete" },
    // Unverified until the live pass: IONOS documents no wording for a location without room.
    unavailable:
      /no (?:\w+ )?capacity|not enough capacity|insufficient capacity|out of stock|not available in (?:this|the) location|(?<!service (?:temporarily )?)unavailable/i,
    // Unverified until the live pass: a contract's limits on cores, memory, disks and addresses.
    serverLimit: /contract limit|resource limit|limit of the contract|quota exceeded/i,
  },
  terraform: {
    provider: { name: "ionoscloud", source: "ionos-cloud/ionoscloud", version: "~> 6.7.42" },
    serverResourceType: "ionoscloud_server",
    firewallResourceType: "ionoscloud_firewall",
    connectorFirewall: false,
    connectorBackups: false,
    connectorRemoval: false,
    homeCacheFiles: [],
    mirroredAttributes: {},
    // The module also ignores the disk's user_data (`volume[0].user_data`), which drift never sees
    // change: the provider keeps it from the state.
    lifecycleIgnored: ["image_name", "ssh_keys"],
    module: { name: "ionos-instance", files: MODULE_FILES },
    credentialsComment: `Token from the ${IONOS_ENV.token} environment variable (never stored in files or state).`,
    deleteProtectionVariable: false,
    descriptions: {
      location: "IONOS Cloud location of the server's data centre.",
      serverType:
        "OpsCrew's size for an IONOS Cloud vCPU server (vCPUs and GB of memory, such as vcpu-2-4).",
      backups:
        "IONOS Cloud's backups, which OpsCrew doesn't turn on: always false, OpsCrew's own snapshots cover the data.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      // For the server's app label.
      ["app", "var.app_name"],
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ...httpArguments(call),
    ],
    // IONOS keeps no copy of a key: every server takes the deploy key's text, so the app's
    // servers share no resource, and an extra server gets the text itself as `ssh_key_id`.
    extraShared: { resources: [], sshKeyId: "var.deploy_ssh_public_key" },
    // No importId: taking over a server needs its data centre, LAN and address too.
  },
  texts: {
    rotate: {
      deleteToken: `the Token Manager in ${DCD} (${DCD_URL}; IONOS's guide: ${IONOS_TOKEN_MANAGER_URL})`,
    },
    interview: {
      label: "IONOS Cloud",
      hint: `for businesses only; servers in Frankfurt, Berlin, Newark and Lenexa; billed by the minute until deleted (${STOPPED}); a reserved IPv4 address (${STATIC_RATES.reservedIpv4Per30Days} EUR per 30 days) in each price; prices in EUR (a US contract with IONOS CLOUD Inc. bills in USD, at its own prices)`,
    },
    design: { summaryNoun: "IONOS Cloud vCPU server", titleSuffix: " on IONOS Cloud" },
    init: {
      fix: `${IONOS_CREDENTIALS_HINT} A token can't be limited: it acts as the user who made it, so make it as a sub-user, and give it at most 90 days. IONOS Cloud sells to businesses only.`,
      scopeNote: "",
    },
    runbook: {
      serverLabel: (type, location) => `IONOS Cloud ${type} in ${location}`,
      console: DCD,
      backupsOnDatabaseCell: "snapshots with `opscrew snapshot`",
      backupsOn:
        "OpsCrew turns on no IONOS Cloud backups: its own snapshots of the app's data (`opscrew snapshot`) cover them.",
      cloudFirewall:
        "the server's IONOS Cloud NIC firewall, active, with one rule per allowed network and port (IPv4 only: the server has no IPv6 address)",
      deletes: (app) =>
        `each server's data centre (\`opscrew-${app}\`, and \`opscrew-${app}-…\` for the app's other servers) with everything in it (the server, its disk, its network and its firewall rules), and each server's reserved IPv4 address; only that delete ends their billing: ${STOPPED}`,
      connectNote: [],
      snapshotReason: "the app keeps data on the server",
      snapshotFirst: [
        "OpsCrew takes an IONOS Cloud snapshot of the server's disk",
        "  before deleting its data centre (skip it with `--no-snapshot`). IONOS keeps snapshots apart from data centres, so",
        "  it may keep it after the data centre is gone, and bills it per GB per month until you delete it in the Data Center",
        "  Designer.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server, so OpsCrew does not take a snapshot before deleting it.",
        "  OpsCrew turns on no IONOS Cloud backups, so nothing else keeps a copy of the server.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** IONOS Cloud has no delete protection. Deleting the server's data centre in the Data",
        "  Center Designer deletes the server and its disk at once, and only a delete ends the billing: a stopped server",
        "  still bills its disk and its reserved IPv4 address. `opscrew destroy` is the safe way, because it shows the plan,",
        "  offers a snapshot and asks for the typed name first.",
      ],
      whatRemains: (image, folder, workflowPath) => [
        "- **What remains:** the server's snapshots named `opscrew-…`, the one taken first and any other, which IONOS may keep",
        "  after the data centre is gone (each is billed per GB per month while it exists, so check in the Data Center Designer",
        `  and delete them there), the container images in GitHub Container Registry (\`${image}\`), and the files in this`,
        `  repository (\`${folder}/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: DCD,
      snapshotRef: (id) => `IONOS Cloud snapshot ${id}`,
      snapshotBilling:
        "IONOS keeps snapshots apart from data centres, so they may outlive the server's, and bills them per GB per month until they are deleted in the Data Center Designer",
      snapshotBilled: "billed per GB per month until it is deleted in the Data Center Designer",
      lookup: (app) =>
        `in the data centres named opscrew-${app} or opscrew-${app}-… in your IONOS Cloud contract`,
      tokenHint: (command) => `${IONOS_CREDENTIALS_HINT} Then run \`${command}\` again.`,
    },
    secops: SECOPS,
  },
};
