import type {
  CloudProviderDefinition,
  ModuleCall,
  PlannedResourceJson,
  ProviderSecOps,
} from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";
import { UPCLOUD_CONTROL_PANEL_URL, UPCLOUD_CREDENTIALS_HINT, UPCLOUD_ENV } from "./client";
import { UPCLOUD_CREDENTIALS, upcloudConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";
import { HOURS_A_MONTH, HOURS_PER_30_DAYS, STATIC_RATES } from "./static-prices";

const CONSOLE = "UpCloud's control panel";

/** A backup's price by the hour, EUR: UpCloud prices backups per GB over a 30-day month. */
const BACKUP_PER_GB_HOUR = STATIC_RATES.backupGbMonth / HOURS_PER_30_DAYS;

/** How every text says where an UpCloud server's firewall is. */
const FIREWALL_WORDS = "cloud firewall: none; server firewall: on";
/** When the server's own firewall applies. */
const FIREWALL_GAP = "a few seconds after the server starts";
/** Why UpCloud's own firewall stays off. */
const STATELESS = "UpCloud's own firewall is stateless";
/** What a stateless firewall would have to open. */
const OPEN_PORTS =
  "to let the answers to the server's own connections back in, it would have to open thousands of ports to the whole internet";
/** What keeps billing until a delete, as every text says it. */
const STOPPED = "a stopped server still bills its plan";

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's networks, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/**
 * True when the planned server has Simple Backup on: a `simple_backup` block with both a plan and
 * a time, without which UpCloud leaves it off.
 */
function simpleBackupOn(server: PlannedResourceJson): boolean {
  const blocks = server.values.simple_backup;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        isRecord(block) &&
        typeof block.plan === "string" &&
        block.plan !== "" &&
        typeof block.time === "string" &&
        block.time !== "",
    )
  );
}

/**
 * SecOps's checks of a plan's UpCloud servers. UpCloud's own firewall is stateless, so the module
 * leaves it off and makes no `upcloud_firewall_rules`: the server's own firewall is the first step
 * of its first boot, a cloud-init boothook before the cloud-config, which SecOps reads from the
 * planned server's `user_data` and `opscrew secure` from the server (`firewallCheck`); `rules` and
 * `attached` find nothing.
 */
const SECOPS: ProviderSecOps = {
  noun: "server",
  firewallCheck: "server",
  rules: () => [],
  attached: () => false,
  attachedText: `Cloud firewall: none; server firewall: on. ${STATELESS}, so it stays off: ${OPEN_PORTS}. The server's own stateful firewall (nftables) is the first step of its first boot: it drops everything the plan doesn't allow from ${FIREWALL_GAP}, when cloud-init runs it, before the rest of the first boot.`,
  unattachedText:
    "Cloud firewall: none; server firewall: off. UpCloud's own firewall stays off, and the server's first boot (its user data) doesn't set up OpsCrew's firewall, so every port would be reachable from the internet. Run `opscrew provision` again: it writes the server's module with the firewall as the first step.",
  keylessText:
    "The server has no SSH key in its login, so the only way in would be a password, which OpsCrew never has UpCloud make. Add the deploy key.",
  // The key goes in the server's login block (`login[0].keys`); the check sees the block.
  sshKeyAttribute: "login",
  backupsText:
    "UpCloud's Simple Backup is on as the plan requires: a backup of the server's disk every day, each kept 7 days.",
  backups: simpleBackupOn,
};

/** UpCloud, as OpsCrew creates cloud servers there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "upcloud",
  displayName: "UpCloud",
  name: "UpCloud",
  serverNoun: "server",
  sizeNoun: "plan",
  consoleUrl: UPCLOUD_CONTROL_PANEL_URL,
  // Credits, resource limits and sub-accounts.
  accountUrl: "https://hub.upcloud.com/account",
  // UpCloud's sign-up; its pages answer only a browser, so a release checks this one by hand.
  signupUrl: "https://signup.upcloud.com/",
  pricingUrl: "https://upcloud.com/pricing/",
  credentials: {
    envVars: [UPCLOUD_ENV.token],
    labels: { [UPCLOUD_ENV.token]: "UpCloud API token" },
    mode: "any",
    createUrl: UPCLOUD_CREDENTIALS.createUrl,
    tokenRules: [
      {
        id: "upcloud-token",
        title: "UpCloud API token",
        severity: "critical",
        // `ucat_` and 26 characters of Crockford's base32 (no I, L, O or U).
        pattern: /(?<![A-Za-z0-9_])ucat_[0-9A-HJKMNP-TV-Z]{26}(?![A-Za-z0-9_])/gi,
        description:
          "An UpCloud API token is written in this file. It acts with every right of the account that made it: it can create, change and delete servers, disks and backups, and spend the account's credits.",
      },
    ],
    envPrefixes: ["UPCLOUD"],
    apiPattern: /api\.upcloud\.com|upcloudltd\/upcloud|upcloud_/i,
  },
  connector: (deps) => upcloudConnector(deps),
  regions: {
    locations: {
      "eu-central": ["de-fra1", "nl-ams1", "pl-waw1"],
      "eu-north": ["fi-hel1", "fi-hel2"],
      "us-east": ["us-nyc1"],
      "us-west": ["us-sjo1"],
      "ap-southeast": ["sg-sin1"],
    },
    locationNames: {
      "de-fra1": "Frankfurt",
      "nl-ams1": "Amsterdam",
      "pl-waw1": "Warsaw",
      "fi-hel1": "Helsinki 1",
      "fi-hel2": "Helsinki 2",
      "us-nyc1": "New York",
      "us-sjo1": "San Jose",
      "sg-sin1": "Singapore",
    },
    // Every region has a zone of its own.
    notes: {},
    // Approximate, for the delay estimates.
    coordinates: {
      "de-fra1": [50.1, 8.7],
      "nl-ams1": [52.4, 4.9],
      "pl-waw1": [52.2, 21.0],
      "fi-hel1": [60.2, 24.9],
      "fi-hel2": [60.2, 24.9],
      "us-nyc1": [40.7, -74.0],
      "us-sjo1": [37.3, -121.9],
      "sg-sin1": [1.35, 103.8],
    },
  },
  offering: {
    currency: "EUR",
    // By the started hour, at the monthly price over 672 hours, up to the monthly price.
    billing: { model: "hourly", counts: "started-hour", setupFee: false },
    defaultImage: "Ubuntu 24.04",
    // Simple Backup's week plan: a daily backup kept 7 days.
    backupPercent: STATIC_RATES.weekPlanBackupPercent,
    providerBackups: true,
    // Unverified until the live pass: UpCloud keeps a deleted server's backups unless told not to.
    backupsOutliveServer: true,
    snapshots: {
      kind: "per-gb",
      perGbMonth: BACKUP_PER_GB_HOUR * HOURS_A_MONTH,
      perGbHour: BACKUP_PER_GB_HOUR,
    },
    // A whole-server snapshot is an on-demand backup of the disk, which outlives the server.
    serverSnapshotsOutliveServer: true,
    deleteProtection: false,
    // UpCloud resizes only a stopped server, and a disk only grows: a size change is refused, and
    // a move is the way.
    resize: false,
    offAfterRefusedResize: false,
    removal: { kind: "delete" },
    // Unverified until the live pass: UpCloud's error codes for a zone without room.
    unavailable:
      /RESOURCES_UNAVAILABLE|no (?:available )?capacity|not enough capacity|out of stock|not available in (?:this|the) zone|(?<!service (?:temporarily )?)unavailable/i,
    // An account's resource limits (cores, memory, MaxIOPS storage, addresses), which support raises.
    serverLimit: /[A-Z_]+_LIMIT_REACHED/,
  },
  terraform: {
    provider: { name: "upcloud", source: "UpCloudLtd/upcloud", version: "~> 5.49" },
    serverResourceType: "upcloud_server",
    // Named, never made: UpCloud's own firewall is stateless and stays off (see SECOPS).
    firewallResourceType: "upcloud_firewall_rules",
    connectorFirewall: false,
    connectorBackups: false,
    connectorRemoval: false,
    homeCacheFiles: [],
    mirroredAttributes: {},
    lifecycleIgnored: ["user_data", "login", "template"],
    module: { name: "upcloud-instance", files: MODULE_FILES },
    credentialsComment: `Token from the ${UPCLOUD_ENV.token} environment variable (never stored in files or state). At plan time the provider reads UpCloud's plans and zones, so a plan needs the network and the token.`,
    deleteProtectionVariable: false,
    descriptions: {
      location: "UpCloud zone.",
      serverType: "UpCloud Premium plan, such as PREMIUM-2xCPU-4GB.",
      backups:
        "UpCloud's Simple Backup: a daily backup of the server's disk kept 7 days, 20% more than the plan's price (`opscrew design` shows it).",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      // For the server's opscrew-app label.
      ["app", "var.app_name"],
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["backups", `var.${call.prefix}backups`],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      // The networks the server's own firewall lets in, as another provider's cloud firewall.
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ...httpArguments(call),
    ],
    // UpCloud keeps no key object: every server takes the deploy key's text in its login, so the
    // app's servers share no resource, and an extra server gets the text itself as `ssh_key_id`.
    extraShared: { resources: [], sshKeyId: "var.deploy_ssh_public_key" },
    // No firstBoot: the default cloud-init, whose user data carries the server firewall's step as a
    // boothook before the cloud-config. No importId: a server imports by its UUID, the AppServer's id, which the default quotes.
  },
  texts: {
    rotate: { deleteToken: `${CONSOLE} (${UPCLOUD_CONTROL_PANEL_URL}, Account → API tokens)` },
    interview: {
      label: "UpCloud",
      hint: `servers in Frankfurt, Amsterdam, Warsaw, Helsinki, New York, San Jose and Singapore; prices in EUR, paid from prepaid credits (UpCloud disables the servers when they run out); billed by the started hour up to the monthly price, until deleted (${STOPPED}); ${FIREWALL_WORDS}, from ${FIREWALL_GAP}, since ${STATELESS}`,
    },
    design: {
      summaryNoun: `UpCloud server (${FIREWALL_WORDS}, from ${FIREWALL_GAP}, since ${STATELESS}: ${OPEN_PORTS})`,
      titleSuffix: " on UpCloud",
    },
    init: {
      fix: `${UPCLOUD_CREDENTIALS_HINT} UpCloud's page for API tokens: ${UPCLOUD_CREDENTIALS.createUrl}.`,
      scopeNote: "",
    },
    runbook: {
      serverLabel: (type, location) => `UpCloud ${type} in ${location}`,
      console: CONSOLE,
      backupsOnDatabaseCell: "UpCloud Simple Backup is on (daily, each kept 7 days)",
      backupsOn:
        "UpCloud's Simple Backup takes a backup of the server's disk every day and keeps each for 7 days; you find them with the server in UpCloud's control panel. UpCloud may keep them after the server is deleted, and bills each per GB per month while it exists.",
      cloudFirewall: `the server's own stateful nftables firewall, the first step of its first boot (${FIREWALL_WORDS}, from ${FIREWALL_GAP}; ${STATELESS}, so OpsCrew leaves it off: ${OPEN_PORTS})`,
      deletes: () =>
        `the server and its disk (UpCloud stops and deletes them, which releases the server's IPv4 address; only the delete ends its cost: ${STOPPED})`,
      connectNote: [],
      snapshotReason: "UpCloud's Simple Backup is on for this server",
      snapshotFirst: [
        "OpsCrew takes an UpCloud backup of the server's disk",
        "  before deleting it (skip it with `--no-snapshot`). UpCloud keeps it after the server is gone and bills it",
        "  per GB per month until you delete it in its control panel.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server and Simple Backup is off, so OpsCrew does not take a",
        "  snapshot before deleting the server.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** UpCloud has no delete protection. Deleting the server in its control panel removes it and",
        `  its disk for good, and only a delete ends its cost: ${STOPPED}. \`opscrew destroy\` is the safe way, because it`,
        "  shows the plan, offers a snapshot and asks for the typed name first.",
      ],
      whatRemains: (image, folder, workflowPath, backups) => [
        "- **What remains:** the server's backups titled `opscrew-…`, the one taken first and any other (UpCloud keeps them",
        "  after the server is gone and bills each per GB per month until you delete it in its control panel),",
        ...(backups
          ? [
              "  the Simple Backup copies UpCloud may keep (each billed per GB per month while it exists: check its control panel),",
            ]
          : []),
        `  the container images in GitHub Container Registry (\`${image}\`), and the files in this repository (\`${folder}/\``,
        `  and \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: CONSOLE,
      snapshotRef: (id) => `UpCloud backup ${id}`,
      snapshotBilling:
        "UpCloud keeps backups after their server is deleted, and bills them per GB per month until they are deleted in its control panel",
      snapshotBilled: "billed per GB per month until it is deleted in UpCloud's control panel",
      lookup: (app) =>
        `titled ${app} or ${app}-… and labelled opscrew-app=${app} in your UpCloud account`,
      tokenHint: (command) => `${UPCLOUD_CREDENTIALS_HINT} Then run \`${command}\` again.`,
      keptBackups:
        "UpCloud may keep the server's Simple Backup copies after the delete, and doesn't say for how long",
      keptBackupsRemaining:
        "The server's Simple Backup copies, if UpCloud keeps them after the delete: it bills each per GB per month while it exists, so check UpCloud's control panel and delete them there.",
    },
    secops: SECOPS,
  },
};
