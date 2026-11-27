import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_PROVIDER_CONTRACT_VERSION,
  type FetchLike,
  type PlannedFirewallRule,
  type PlannedResourceJson,
} from "@opscrew/contracts";
import { findExecutable, isRecord, NodeCommandRunner, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { TOKEN, TOKEN_ENV } from "./__fixtures__/client";
import { DEPLOY_KEY, ionosPlanJson } from "./__fixtures__/plan";
import {
  definition,
  IONOS_CREDENTIALS,
  IONOS_CREDENTIALS_HINT,
  IONOS_LOCATIONS,
  STATIC_RATES,
  STATIC_SIZES,
} from "./index";
import { HOURS_A_MONTH, HOURS_PER_30_DAYS } from "./static-prices";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];
/** IONOS's Data Center Designer. */
const DCD_URL = "https://dcd.ionos.com/";
const PRICING_URL = "https://cloud.ionos.com/prices";
/** Nothing in a unit test reaches the network. */
const offline: FetchLike = () => Promise.reject(new Error("no request in this test"));

/** The module's main.tf. */
function mainTf(): string {
  return definition.terraform.module.files["main.tf"] ?? "";
}

/** The HCL block of main.tf that starts with `head`, up to its closing brace at column 0. */
function block(head: string): string {
  const main = mainTf();
  const start = main.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const rest = main.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
}

/** Every user-facing text of the definition, its functions called with sample values. */
function allTexts(): string {
  const { texts } = definition;
  return JSON.stringify({
    ...texts,
    runbook: {
      ...texts.runbook,
      serverLabel: texts.runbook.serverLabel("vcpu-2-4", "de/fra/1"),
      deletes: texts.runbook.deletes("shop"),
      whatRemains: texts.runbook.whatRemains("img", "opscrew", "wf.yml", false),
    },
    destroy: {
      ...texts.destroy,
      snapshotRef: texts.destroy.snapshotRef("5a000000"),
      lookup: texts.destroy.lookup("shop"),
      tokenHint: texts.destroy.tokenHint("opscrew destroy"),
    },
    notes: definition.regions.notes,
    descriptions: definition.terraform.descriptions,
  });
}

describe("IONOS Cloud's cloud provider definition", () => {
  it("has the contract's version, its names, its pages and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "ionos",
      displayName: "IONOS Cloud",
      name: "IONOS",
      serverNoun: "server",
      sizeNoun: "size",
      consoleUrl: DCD_URL,
      accountUrl: DCD_URL,
      pricingUrl: PRICING_URL,
    });
    // No sign-up page: IONOS Cloud sells to businesses, through a contract, not a plain sign-up.
    expect(definition.signupUrl).toBeUndefined();
    expect(definition.pricingUrl).toMatch(/^https:\/\/[^?#]+$/);
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("needs only the token, which has no recognisable format", () => {
    const { credentials } = definition;
    expect(credentials).toMatchObject({
      envVars: ["IONOS_TOKEN"],
      labels: { IONOS_TOKEN: "IONOS Cloud token" },
      mode: "any",
      createUrl: IONOS_CREDENTIALS.createUrl,
      tokenRules: [],
      envPrefixes: ["IONOS"],
    });
    for (const text of [
      'Error: error creating server: (Post "https://api.ionos.com/cloudapi/v6/datacenters": 403 Forbidden)',
      "with module.server.ionoscloud_server.this",
      "with module.server.ionoscloud_firewall.this",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(true);
    }
    for (const text of [
      "api.hetzner.cloud",
      "with ovh_cloud_instance.this",
      "api.cloudflare.com",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(false);
    }
  });

  it("maps every region to the locations the catalogue offers, noting the far ones", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(locations).toEqual({
      "eu-central": ["de/fra/1", "de/fra/2", "de/txl"],
      "eu-north": ["de/txl"],
      "us-east": ["us/ewr"],
      "us-west": ["us/mci"],
      "ap-southeast": ["de/fra/1"],
    });
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    expect([...new Set(Object.values(locations).flat())].sort()).toEqual(
      [...IONOS_LOCATIONS].sort(),
    );
    expect(locationNames).toEqual({
      "de/fra/1": "Frankfurt 1",
      "de/fra/2": "Frankfurt 2",
      "de/txl": "Berlin",
      "us/ewr": "Newark, near New York",
      "us/mci": "Lenexa, near Kansas City",
    });
    for (const location of IONOS_LOCATIONS) {
      const [latitude, longitude] = coordinates[location] ?? [];
      expect(Math.abs(latitude ?? 99), location).toBeLessThanOrEqual(90);
      expect(Math.abs(longitude ?? 999), location).toBeLessThanOrEqual(180);
    }
    expect(coordinates["us/mci"]?.[1]).toBeLessThan(coordinates["us/ewr"]?.[1] ?? 0);
    expect(coordinates["de/txl"]?.[1]).toBeGreaterThan(coordinates["de/fra/1"]?.[1] ?? 180);
    expect(Object.keys(notes).sort()).toEqual(["ap-southeast", "eu-north", "us-west"]);
    expect(notes["eu-north"]).toContain("no location in the Nordics");
    expect(notes["eu-north"]).toContain("Berlin");
    expect(notes["us-west"]).toContain("Las Vegas");
    expect(notes["us-west"]).toContain("no vCPU servers");
    expect(notes["us-west"]).toContain("Lenexa");
    expect(notes["ap-southeast"]).toContain("no location in Asia or Oceania");
    expect(notes["ap-southeast"]).toContain("Frankfurt");
  });

  it("bills by the second until deleted, in EUR, with snapshots per GB that may outlive the server", () => {
    const perGbHour = STATIC_RATES.snapshotGbPer30Days / HOURS_PER_30_DAYS;
    expect(definition.offering).toEqual({
      currency: "EUR",
      // IONOS bills by the minute; "second" is the finer of the contract's two counts.
      billing: { model: "hourly", counts: "second", setupFee: false },
      defaultImage: "Ubuntu 24.04",
      backupPercent: 0,
      providerBackups: false,
      backupsOutliveServer: true,
      snapshots: { kind: "per-gb", perGbMonth: perGbHour * HOURS_A_MONTH, perGbHour },
      serverSnapshotsOutliveServer: true,
      deleteProtection: false,
      resize: false,
      offAfterRefusedResize: false,
      removal: { kind: "delete" },
      unavailable: expect.any(RegExp),
      serverLimit: expect.any(RegExp),
    });
    expect(perGbHour).toBeCloseTo(0.04 / 720, 12);
  });

  it("tells a location without room from a contract limit, and neither from an outage", () => {
    const { unavailable, serverLimit } = definition.offering;
    for (const text of [
      "There is no capacity available for this server in de/txl",
      "Insufficient capacity in the location",
      "The requested resource is not available in this location",
    ]) {
      expect(unavailable.test(text), text).toBe(true);
      expect(serverLimit.test(text), text).toBe(false);
    }
    for (const text of [
      "The number of cores exceeds the contract limit",
      "Resource limit of the contract reached: ramPerContract",
      "Quota exceeded for reservable IPs",
    ]) {
      expect(serverLimit.test(text), text).toBe(true);
      expect(unavailable.test(text), text).toBe(false);
    }
    for (const text of [
      "Service Temporarily Unavailable",
      "[HTTP 401] Unauthorized",
      "request rate limit exceeded",
    ]) {
      expect(unavailable.test(text), text).toBe(false);
      expect(serverLimit.test(text), text).toBe(false);
    }
  });

  it("prices its offers by its billing facts, from the dated table", async () => {
    const { billing, snapshots, currency } = definition.offering;
    const catalog = definition.connector({ env: {}, fetch: offline }).catalog();
    const offers = await catalog.listOffers();
    expect(offers).toHaveLength(STATIC_SIZES.length * IONOS_LOCATIONS.length);
    for (const offer of offers) {
      expect(offer.billing).toBe(billing.model);
      expect(offer.source).toBe("static");
      expect(offer.hourly?.currency).toBe(currency);
      expect(offer.hourly?.amount ?? Infinity).toBeLessThan(offer.monthly.amount);
      expect(offer.setupFee).toBeUndefined();
    }
    const extras = await catalog.extras("de/fra/1");
    expect(snapshots.kind).toBe("per-gb");
    if (snapshots.kind !== "per-gb") return;
    expect(extras.snapshotPerGbMonth).toEqual({ amount: snapshots.perGbMonth, currency });
    expect(extras.snapshotPerGbHour).toEqual({ amount: snapshots.perGbHour, currency });
  });

  it("has servers only with the token set", () => {
    const without = definition.connector({ env: {}, fetch: offline });
    expect(without.configured).toBe(false);
    expect(without.servers).toBeUndefined();
    const connector = definition.connector({
      env: TOKEN_ENV,
      redactor: new Redactor(),
      fetch: offline,
    });
    expect(connector.configured).toBe(true);
    expect(connector.servers?.findAppServers).toBeTypeOf("function");
  });

  it("has the texts the contract asks for, and no resize text since a size change is refused", () => {
    const { texts } = definition;
    expect(texts.resizeOffline).toBeUndefined();
    expect(texts.interview.label).toBe("IONOS Cloud");
    // IONOS has no price API: no variable turns live prices on.
    expect(texts.design).toEqual({
      summaryNoun: "IONOS Cloud vCPU server",
      titleSuffix: " on IONOS Cloud",
    });
    expect(texts.init.fix).toContain("IONOS_TOKEN");
    expect(texts.init.fix).toContain(IONOS_CREDENTIALS_HINT);
    expect(texts.init.fix).toContain(IONOS_CREDENTIALS.createUrl);
    // A token can't be limited: it acts as its user, so a sub-user and a short life.
    expect(texts.init.fix).toContain("acts as the user who made it");
    expect(texts.init.fix).toContain("sub-user");
    expect(texts.init.fix).toContain("at most 90 days");
    expect(texts.init.scopeNote).toBe("");
    expect(texts.rotate.deleteToken).toContain(DCD_URL);
    expect(texts.rotate.deleteToken).toContain("Token Manager");
    expect(texts.runbook.serverLabel("vcpu-2-4", "de/fra/1")).toBe(
      "IONOS Cloud vcpu-2-4 in de/fra/1",
    );
    expect(texts.runbook.console).toBe("IONOS's Data Center Designer");
    expect(texts.runbook.deleteProtectionNote.join("\n")).toContain("No delete protection");
    expect(texts.runbook.snapshotFirst.join("\n")).toContain("per GB per month");
    expect(texts.runbook.noSnapshot.join("\n")).toContain("no database");
    expect(texts.runbook.connectNote).toEqual([]);
    expect(texts.destroy.console).toBe("IONOS's Data Center Designer");
    expect(texts.destroy.snapshotRef("5a000000")).toBe("IONOS Cloud snapshot 5a000000");
    for (const text of [texts.destroy.snapshotBilling, texts.destroy.snapshotBilled]) {
      expect(text).toContain("per GB per month");
      expect(text).not.toMatch(/€|EUR|\d+\.\d+/);
    }
    expect(texts.destroy.lookup("shop")).toBe(
      "in the data centres named opscrew-shop or opscrew-shop-… in your IONOS Cloud contract",
    );
    expect(texts.destroy.tokenHint("opscrew destroy")).toBe(
      `${IONOS_CREDENTIALS_HINT} Then run \`opscrew destroy\` again.`,
    );
    // No provider backups and no object storage.
    expect(texts.destroy.deletedBackups).toBeUndefined();
    expect(texts.destroy.keptBackups).toBeUndefined();
    expect(texts.destroy.keptBackupsRemaining).toBeUndefined();
    expect(texts.destroy.storageConsole).toBeUndefined();
  });

  it("says who can sign up, the currency a contract bills in, and that the price holds the address", () => {
    const { interview, init } = definition.texts;
    for (const text of [interview.hint, init.fix]) {
      expect(text).toContain("businesses only");
    }
    expect(interview.hint).toContain("prices in EUR");
    expect(interview.hint).toContain("a US contract with IONOS CLOUD Inc. bills in USD");
    expect(interview.hint).toContain(
      `a reserved IPv4 address (${STATIC_RATES.reservedIpv4Per30Days} EUR per 30 days) in each price`,
    );
    expect(interview.hint).toContain("by the minute");
  });

  it("says a stopped server still bills, and only deleting its data centre ends the cost", () => {
    const { runbook, interview } = definition.texts;
    const deletes = runbook.deletes("shop");
    expect(deletes).toContain("`opscrew-shop`");
    expect(deletes).toContain("with everything in it");
    expect(deletes).toContain("reserved IPv4 address");
    expect(deletes).toContain("only that delete ends their billing");
    const note = runbook.deleteProtectionNote.join("\n").replace(/\s+/g, " ");
    for (const text of [deletes, interview.hint, note]) {
      expect(text).toContain("a stopped server still bills its disk and its reserved IPv4 address");
    }
    // What may stay and bill: the server's snapshots, named as OpsCrew names them.
    const remains = runbook.whatRemains("img", "opscrew", "wf.yml", false).join("\n");
    expect(remains).toContain("`opscrew-…`");
    expect(remains).toContain("may keep");
    expect(remains).toContain("per GB per month");
    expect(remains).toContain("`img`");
    expect(remains).toContain("`opscrew/`");
    expect(remains).toContain("`wf.yml`");
    expect(definition.texts.destroy.snapshotBilling).toContain("may outlive");
    expect(runbook.snapshotFirst.join(" ")).toContain("may keep it");
  });

  it("names no task or feature number in any text", () => {
    expect(allTexts()).not.toMatch(/\bT\d{4}\b|\b0\d\d\b|feature \d|decision \d/i);
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments } = definition.terraform;
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["app", "var.app_name"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
    ]);
    // An app tag passed in is ignored: IONOS's servers carry their app in a label.
    expect(
      moduleArguments({ prefix: "db_", extra: "db", appTag: "module.server.app_tag_name" }),
    ).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-db"'],
      ["app", "var.app_name"],
      ["location", "var.db_location"],
      ["server_type", "var.db_server_type"],
      ["image", "var.db_image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
    ]);
    const previous = moduleArguments({ prefix: "previous_" });
    expect(previous).toContainEqual(["location", "var.previous_location"]);
    expect(previous).toContainEqual(["server_type", "var.previous_server_type"]);
    expect(previous).toContainEqual(["http_allowed_cidrs", "var.http_allowed_cidrs"]);
  });

  it("uses IONOS's own Terraform provider, the shared cloud-init, and nothing of the connector", () => {
    expect(definition.terraform).toMatchObject({
      provider: { name: "ionoscloud", source: "ionos-cloud/ionoscloud", version: "~> 6.7.42" },
      serverResourceType: "ionoscloud_server",
      firewallResourceType: "ionoscloud_firewall",
      connectorFirewall: false,
      connectorBackups: false,
      connectorRemoval: false,
      homeCacheFiles: [],
      mirroredAttributes: {},
      deleteProtectionVariable: false,
    });
    // cloud-init, the default first boot; no root variable and no import id of its own.
    expect(definition.terraform.firstBoot).toBeUndefined();
    expect(definition.terraform.rootVariables).toBeUndefined();
    expect(definition.terraform.importId).toBeUndefined();
    expect(definition.terraform.credentialsComment).toContain("IONOS_TOKEN");
    expect(definition.terraform.credentialsComment).not.toContain("IONOS_USERNAME");
    const versions = definition.terraform.module.files["versions.tf"] ?? "";
    expect(versions).toContain('source  = "ionos-cloud/ionoscloud"');
    expect(versions).toContain('version = "~> 6.7.42"');
  });

  it("gives each server the deploy key's text, with no key object to share", () => {
    // IONOS has no SSH key resource: the server takes the key's text when it is created.
    expect(definition.terraform.extraShared).toEqual({
      resources: [],
      sshKeyId: "var.deploy_ssh_public_key",
    });
    expect(block('resource "ionoscloud_server" "this" {')).toContain(
      "  ssh_keys = [var.ssh_public_key]\n",
    );
  });

  it("ignores what IONOS can't change after creation, and tells drift the server's attributes", () => {
    expect(definition.terraform.lifecycleIgnored).toEqual(["image_name", "ssh_keys"]);
    expect(block('resource "ionoscloud_server" "this" {')).toContain(
      "    ignore_changes = [image_name, ssh_keys, volume[0].user_data]\n",
    );
  });

  it("maps each size to its cores, memory and disk, equal to the offers", async () => {
    const sizes = [
      ...mainTf().matchAll(
        /^ {4}"(vcpu-\d+-\d+)" += \{ cores = (\d+), ram_mb = (\d+), disk_gb = (\d+) \}$/gm,
      ),
    ].map(([, id, cores, ram, disk]) => ({
      id,
      vcpus: Number(cores),
      memoryGb: Number(ram) / 1024,
      diskGb: Number(disk),
    }));
    expect(sizes).toEqual(STATIC_SIZES.map((size) => ({ ...size })));
    const offers = await definition.connector({ env: {}, fetch: offline }).catalog().listOffers();
    for (const offer of offers) {
      expect(sizes, offer.id).toContainEqual({
        id: offer.id,
        vcpus: offer.vcpus,
        memoryGb: offer.memoryGb,
        diskGb: offer.diskGb,
      });
    }
    expect(mainTf()).toContain("  size = local.sizes[var.server_type]\n");
  });

  it("resolves the definition's image by IONOS's alias, with cloud-init, in the server's location", () => {
    expect(mainTf()).toContain(
      `    ${JSON.stringify(definition.offering.defaultImage)} = "ubuntu:24.04"\n`,
    );
    expect(block('data "ionoscloud_image" "this" {')).toBe(
      [
        'data "ionoscloud_image" "this" {',
        "  image_alias = local.images[var.image]",
        '  type        = "HDD"',
        '  cloud_init  = "V1"',
        "  location    = var.location",
        "}",
      ].join("\n"),
    );
  });

  it("gives each server its own data centre, a public LAN and a reserved IPv4 address", () => {
    expect(block('resource "ionoscloud_datacenter" "this" {')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  name        = "opscrew-${var.name}"\n  location    = var.location\n',
    );
    const lan = block('resource "ionoscloud_lan" "this" {');
    expect(lan).toContain("  datacenter_id = ionoscloud_datacenter.this.id\n");
    expect(lan).toContain("  public        = true\n");
    const ipblock = block('resource "ionoscloud_ipblock" "this" {');
    expect(ipblock).toContain("  location = ionoscloud_datacenter.this.location\n");
    expect(ipblock).toContain("  size     = 1\n");
  });

  it("creates a vCPU server on an Essential disk, from the shared cloud-init, labelled with the app", () => {
    const server = block('resource "ionoscloud_server" "this" {');
    for (const line of [
      "  name          = var.name",
      "  datacenter_id = ionoscloud_datacenter.this.id",
      '  type          = "VCPU"',
      "  cores         = local.size.cores",
      "  ram           = local.size.ram_mb",
      "  image_name    = data.ionoscloud_image.this.id",
      "    size      = local.size.disk_gb",
      '    disk_type = "ESSENTIAL"',
      // The provider passes user_data to IONOS as it is, and IONOS takes it base64-encoded.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {',
      '    key   = "managedby"',
      '    value = "opscrew"',
      '    key   = "app"',
      "    value = local.app_label",
    ]) {
      expect(server, line).toContain(`${line}\n`);
    }
    // The key is IONOS's way in; OpsCrew sets no password.
    expect(server).not.toMatch(/image_password/);
    expect(mainTf()).toContain('  app_label = replace(lower(var.app), "/[^a-z0-9]/", "")\n');
  });

  it("puts the server's NIC on the public LAN with the reserved address and its firewall on", () => {
    const server = block('resource "ionoscloud_server" "this" {');
    const start = server.indexOf("  nic {");
    const nic = server.slice(start, server.indexOf("\n  }\n", start) + 1);
    for (const line of [
      "    lan             = ionoscloud_lan.this.id",
      "    dhcp            = true",
      "    ips             = [ionoscloud_ipblock.this.ips[0]]",
      "    firewall_active = true",
      '    firewall_type   = "INGRESS"',
    ]) {
      expect(nic, line).toContain(`${line}\n`);
    }
    // Never an inline rule: removing one from a list rewrites the others (the provider's docs).
    expect(nic).not.toContain("firewall {");
  });

  it("makes one firewall rule per IPv4 network and port, SSH, the web on a web server, ping and WireGuard", () => {
    const main = mainTf();
    for (const line of [
      '  ssh_ipv4  = distinct([for cidr in var.ssh_allowed_cidrs : cidr if !strcontains(cidr, ":")])',
      '  http_ipv4 = distinct([for cidr in var.http_allowed_cidrs : cidr if !strcontains(cidr, ":")])',
      '      { name = "SSH", protocol = "TCP", port = 22, cidr = cidr }',
      '    { name = "HTTP", protocol = "TCP", port = 80 },',
      '    { name = "HTTPS", protocol = "TCP", port = 443 },',
      '    { name = "HTTP/3", protocol = "UDP", port = 443 },',
      "      for rule in var.web ? local.web_ports : [] :",
      '    [{ name = "Ping", protocol = "ICMP", port = null, cidr = "0.0.0.0/0" }],',
      "      for port in var.wireguard_port[*] :",
      '      { name = "WireGuard", protocol = "UDP", port = port, cidr = "0.0.0.0/0" }',
    ]) {
      expect(main, line).toContain(`${line}\n`);
    }
    const firewall = block('resource "ionoscloud_firewall" "this" {');
    for (const line of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  for_each = { for rule in local.rules : "${rule.name} ${rule.cidr}" => rule }',
      "  datacenter_id    = ionoscloud_datacenter.this.id",
      "  server_id        = ionoscloud_server.this.id",
      "  nic_id           = ionoscloud_server.this.primary_nic",
      '  type             = "INGRESS"',
      "  protocol         = each.value.protocol",
      "  port_range_start = each.value.port",
      "  port_range_end   = each.value.port",
      '  source_ip = each.value.cidr == "0.0.0.0/0" ? null : each.value.cidr',
    ]) {
      expect(firewall, line).toContain(`${line}\n`);
    }
  });

  it("outputs what the root module reads from every server module, the data centre in the id", () => {
    const outputs = definition.terraform.module.files["outputs.tf"] ?? "";
    for (const name of ["ipv4_address", "ipv6_address", "server_id", "server_name", "ssh_key_id"]) {
      expect(outputs).toContain(`output "${name}" {`);
    }
    expect(outputs).toContain("  value       = ionoscloud_ipblock.this.ips[0]\n");
    expect(outputs).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  value       = "${ionoscloud_datacenter.this.id}/${ionoscloud_server.this.id}"\n',
    );
  });

  it("embeds the current module, without the shared cloud-init", () => {
    expect(definition.terraform.module.name).toBe("ionos-instance");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files).sort()).toEqual([
      "main.tf",
      "outputs.tf",
      "variables.tf",
      "versions.tf",
    ]);
  });
});

/** The managed resources of `type` in a plan's JSON, every module's, as SecOps reads them. */
function plannedOfType(planJson: unknown, type: string): PlannedResourceJson[] {
  const unknown = new Map<string, Record<string, unknown>>();
  if (isRecord(planJson) && Array.isArray(planJson.resource_changes)) {
    for (const change of planJson.resource_changes) {
      if (!isRecord(change) || !isRecord(change.change)) continue;
      const after = change.change.after_unknown;
      if (typeof change.address === "string" && isRecord(after)) unknown.set(change.address, after);
    }
  }
  const out: PlannedResourceJson[] = [];
  const walk = (module: unknown) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== type || resource.mode !== "managed") continue;
      const address = String(resource.address);
      out.push({
        address,
        type,
        name: String(resource.name),
        values: isRecord(resource.values) ? resource.values : {},
        unknown: unknown.get(address) ?? {},
      });
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
      walk(child);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.planned_values)) {
    walk(planJson.planned_values.root_module);
  }
  return out;
}

const OPEN_TO_ALL = ["0.0.0.0/0", "::/0"];

/**
 * What SecOps's plan checks find for the IONOS servers of `planJson`, with the definition's
 * `rules` and `attached` (`@opscrew/secops`'s `providerPolicies`): whether every server has its
 * firewall, whether SSH is open to everyone, and the other ports open to everyone besides 80,
 * 443 and the WireGuard port.
 */
function secopsFindings(planJson: unknown, wireguardPort?: number) {
  const { secops } = definition.texts;
  const servers = plannedOfType(planJson, definition.terraform.serverResourceType);
  const firewalls = plannedOfType(planJson, definition.terraform.firewallResourceType);
  const rules: PlannedFirewallRule[] = firewalls.flatMap((firewall) => secops.rules(firewall));
  const open = rules.filter(
    (rule) =>
      rule.direction === "in" && (rule.source_ips ?? []).some((ip) => OPEN_TO_ALL.includes(ip)),
  );
  return {
    servers: servers.length,
    attached: servers.length > 0 && servers.every((s) => secops.attached(s, firewalls, planJson)),
    sshOpen: open.some((rule) => rule.protocol === "tcp" && rule.port === "22"),
    otherOpen: open
      .filter((rule) => rule.protocol !== "icmp")
      .filter(
        ({ protocol, port }) => !(protocol === "tcp" && ["22", "80", "443"].includes(port ?? "")),
      )
      .filter(({ protocol, port }) => !(protocol === "udp" && port === "443"))
      .filter(({ protocol, port }) => !(protocol === "udp" && port === String(wireguardPort)))
      .map(({ protocol, port }) => `${protocol}/${port || "any"}`),
  };
}

/** A planned `ionoscloud_firewall` with `values` (the plan's every attribute) and its unknowns. */
function firewallRule(
  values: Record<string, unknown>,
  unknown: Record<string, unknown> = {},
): PlannedResourceJson {
  return {
    address: 'module.server.ionoscloud_firewall.this["rule"]',
    type: "ionoscloud_firewall",
    name: "this",
    values: {
      type: "INGRESS",
      port_range_start: null,
      port_range_end: null,
      icmp_type: null,
      icmp_code: null,
      ...values,
    },
    unknown: { id: true, ...unknown },
  };
}

describe("IONOS Cloud's security checks", () => {
  const { secops } = definition.texts;

  it("read each rule in Hetzner's shape: its protocol, its port or range, and its one source", () => {
    const cases: [PlannedResourceJson, PlannedFirewallRule][] = [
      [
        firewallRule({
          protocol: "TCP",
          port_range_start: 22,
          port_range_end: 22,
          source_ip: "203.0.113.7/32",
        }),
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["203.0.113.7/32"] },
      ],
      [
        firewallRule(
          { protocol: "TCP", port_range_start: 8000, port_range_end: 8100 },
          { source_ip: true },
        ),
        { direction: "in", protocol: "tcp", port: "8000-8100", source_ips: ["0.0.0.0/0"] },
      ],
      // No source and no port: every IPv4 address, every port (IONOS's rule is IPv4 by default).
      [
        firewallRule({ protocol: "UDP", source_ip: null }),
        { direction: "in", protocol: "udp", port: "", source_ips: ["0.0.0.0/0"] },
      ],
      [
        firewallRule({ protocol: "ICMP" }, { source_ip: true }),
        { direction: "in", protocol: "icmp", port: "", source_ips: ["0.0.0.0/0"] },
      ],
      [
        firewallRule({ protocol: "ICMPv6" }, { source_ip: true }),
        { direction: "in", protocol: "icmp", port: "", source_ips: ["::/0"] },
      ],
      // ANY is every protocol, read as none.
      [
        firewallRule({ protocol: "ANY", source_ip: "198.51.100.0/24" }),
        { direction: "in", protocol: "", port: "", source_ips: ["198.51.100.0/24"] },
      ],
      [
        firewallRule({
          protocol: "TCP",
          port_range_start: 443,
          port_range_end: 443,
          type: "EGRESS",
        }),
        { direction: "out", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0"] },
      ],
      [
        firewallRule({ protocol: "TCP", port_range_start: 5432, type: "BIDIRECTIONAL" }),
        { direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] },
      ],
    ];
    for (const [firewall, rule] of cases) {
      expect(secops.rules(firewall), JSON.stringify(firewall.values)).toEqual([rule]);
    }
  });

  it("see the rules on the server through their reference to it before apply", () => {
    const plan = ionosPlanJson({ firewallActive: true });
    const [server] = plannedOfType(plan, "ionoscloud_server");
    const firewalls = plannedOfType(plan, "ionoscloud_firewall");
    expect(server && secops.attached(server, firewalls, plan)).toBe(true);
    // Rules whose server_id refers to something else are no rules of this server's.
    const elsewhere = ionosPlanJson({ firewallActive: true, rulesOnServer: false });
    expect(
      server && secops.attached(server, plannedOfType(elsewhere, "ionoscloud_firewall"), elsewhere),
    ).toBe(false);
    // Another module's rules are that module's server's.
    const other = ionosPlanJson({ module: "server_db", firewallActive: true });
    expect(
      server && secops.attached(server, plannedOfType(other, "ionoscloud_firewall"), other),
    ).toBe(false);
    expect(server && secops.attached(server, [], plan)).toBe(false);
  });

  it("see the rules on the server by its id once both are known", () => {
    const server: PlannedResourceJson = {
      address: "module.server.ionoscloud_server.this",
      type: "ionoscloud_server",
      name: "this",
      values: { id: "5e000000-1", nic: [{ firewall_active: true }] },
      unknown: {},
    };
    const rule = (serverId: string) =>
      firewallRule({ protocol: "TCP", port_range_start: 22, server_id: serverId });
    expect(secops.attached(server, [rule("5e000000-1")], {})).toBe(true);
    expect(secops.attached(server, [rule("5e000000-2")], {})).toBe(false);
  });

  it("pass the plan OpsCrew writes: the NIC's firewall on, SSH from the allowed network only", () => {
    expect(
      secopsFindings(ionosPlanJson({ firewallActive: true, wireguardPort: 51820 }), 51820),
    ).toEqual({
      servers: 1,
      attached: true,
      sshOpen: false,
      otherOpen: [],
    });
    expect(secops.attachedText).toContain("NIC firewall is active");
  });

  it("fail a plan whose NIC firewall is off, or not set, whatever its rules", () => {
    for (const firewallActive of [false, undefined]) {
      const findings = secopsFindings(ionosPlanJson({ firewallActive }));
      expect(findings.servers).toBe(1);
      expect(findings.attached, String(firewallActive)).toBe(false);
    }
    expect(secops.unattachedText).toContain("every port");
  });

  it("fail a plan that opens SSH to everyone", () => {
    const findings = secopsFindings(
      ionosPlanJson({ firewallActive: true, sshCidrs: ["0.0.0.0/0"] }),
    );
    expect(findings.attached).toBe(true);
    expect(findings.sshOpen).toBe(true);
  });

  it("read the deploy key from the server's ssh_keys, where SecOps looks by default", () => {
    expect(secops.sshKeyAttribute).toBeUndefined();
    const [server] = plannedOfType(ionosPlanJson({ firewallActive: true }), "ionoscloud_server");
    expect(server?.values.ssh_keys).toEqual([DEPLOY_KEY]);
    expect(secops.keylessText).toContain("Add the deploy key");
    expect(secops.firewallCheck).toBeUndefined();
    expect(secops.noun).toBe("server");
    expect(secops.backupsText).toContain("snapshots");
  });
});

// Downloads the IONOS provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH. The plan reaches nothing else: a
// local fake answers the provider's reads (the image list and the location), with the token.
const runIt = process.env.OPSCREW_IT === "1";
if (!runIt) {
  console.warn(
    "[provider-ionos] skipping HCL validation: set OPSCREW_IT=1 (it downloads the IONOS provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|x509|context deadline exceeded|could not connect/i;
/** The engine's log when the provider's plugin refuses the engine's local TLS certificate. */
const PLUGIN_TLS_ERROR = /authentication handshake failed: .*x509/;
const SHARED = join(packageDir, "../../iac-templates/shared");
const MODULE_DIR = "modules/ionos-instance";

/** One server of the integration root: the app's (`prefix` "") or an extra one. */
interface PlannedServer {
  module: string;
  prefix: "" | `${string}_`;
  extra?: string;
  size: (typeof STATIC_SIZES)[number];
  location: string;
}

/** The app's server, then one extra server per other size, each in a location of its own. */
const SERVERS: PlannedServer[] = STATIC_SIZES.map((size, index) => {
  const location = IONOS_LOCATIONS[index % IONOS_LOCATIONS.length] as string;
  if (index === 0) return { module: "server", prefix: "", size, location };
  const extra = size.id.replace(/-/g, "");
  return { module: `server_${extra}`, prefix: `${extra}_`, extra, size, location };
});

/** The Ubuntu image ids of the fake, by location. */
function imageId(location: string, version: string): string {
  return `1a9e0000-${version.replace(".", "")}-4000-8000-${location.replace(/\W/g, "").padEnd(12, "0")}`;
}

/**
 * A root module as OpsCrew renders one: the app's server (the scheduled check's key and a
 * WireGuard port) and an extra server per other size (no web, the key's text as `ssh_key_id`).
 */
function rootModule(): string {
  const { terraform } = definition;
  const variable = (name: string, type: string) => [
    `variable "${name}" {`,
    `  type = ${type}`,
    "}",
  ];
  const moduleBlock = (server: PlannedServer) => [
    `module "${server.module}" {`,
    `  source = "./${MODULE_DIR}"`,
    ...terraform
      .moduleArguments({
        prefix: server.prefix,
        ...(server.extra === undefined ? {} : { extra: server.extra }),
      })
      .map(([key, value]) => `  ${key} = ${value}`),
    ...(server.extra === undefined
      ? ["  wireguard_port = 51820"]
      : ["  web = false", `  ssh_key_id = ${terraform.extraShared.sshKeyId}`]),
    "  check_key_line = var.check_key_line",
    "}",
    "",
  ];
  return [
    "terraform {",
    "  required_providers {",
    `    ${terraform.provider.name} = {`,
    `      source  = "${terraform.provider.source}"`,
    `      version = "${terraform.provider.version}"`,
    "    }",
    "  }",
    "}",
    "",
    `# ${terraform.credentialsComment}`,
    `provider "${terraform.provider.name}" {}`,
    "",
    ...["app_name", "deploy_ssh_public_key", "check_key_line"].flatMap((name) =>
      variable(name, "string"),
    ),
    ...["ssh_allowed_cidrs", "http_allowed_cidrs"].flatMap((name) =>
      variable(name, "list(string)"),
    ),
    ...SERVERS.flatMap(({ prefix }) =>
      ["location", "server_type", "image"].flatMap((name) =>
        variable(`${prefix}${name}`, "string"),
      ),
    ),
    "",
    ...terraform.extraShared.resources,
    ...SERVERS.flatMap(moduleBlock),
    'output "servers" {',
    "  value = {",
    ...SERVERS.map(
      ({ module }) =>
        `    ${module} = [module.${module}.ipv4_address, module.${module}.ipv6_address, module.${module}.server_id, module.${module}.server_name, module.${module}.ssh_key_id]`,
    ),
    "  }",
    "}",
  ].join("\n");
}

/** SSH from one address and one IPv6 network; the web from two of Cloudflare's ranges. */
const SSH_CIDRS = ["203.0.113.7/32", "2001:db8::/48"];
const HTTP_CIDRS = ["173.245.48.0/20", "2400:cb00::/32"];

/** The root's variable values. */
function rootValues(): Record<string, unknown> {
  return {
    app_name: "my-shop",
    deploy_ssh_public_key: DEPLOY_KEY,
    check_key_line: `restrict,command="/usr/local/sbin/opscrew-check" ${DEPLOY_KEY}`,
    ssh_allowed_cidrs: SSH_CIDRS,
    http_allowed_cidrs: HTTP_CIDRS,
    ...Object.fromEntries(
      SERVERS.flatMap(({ prefix, size, location }) => [
        [`${prefix}location`, location],
        [`${prefix}server_type`, size.id],
        [`${prefix}image`, definition.offering.defaultImage],
      ]),
    ),
  };
}

/**
 * A local fake of IONOS's Cloud API: the public images of every location (Ubuntu 24.04 and 22.04
 * for cloud-init, and 24.04's ISO), 404 for anything else.
 */
async function fakeIonos() {
  const requests: { method: string; url: string; authorization: unknown }[] = [];
  const image = (location: string, version: string, aliases: string[], type = "HDD") => ({
    id: type === "HDD" ? imageId(location, version) : `${imageId(location, version)}-iso`,
    type: "image",
    properties: {
      name: `Ubuntu-${version}-LTS-server-${type === "HDD" ? "cloud-init" : "iso"}-2026-11-01`,
      location,
      imageType: type,
      cloudInit: type === "HDD" ? "V1" : "NONE",
      imageAliases: aliases,
      licenceType: "LINUX",
      public: true,
      size: 3,
    },
  });
  const images = IONOS_LOCATIONS.flatMap((location) => [
    image(location, "24.04", ["ubuntu:latest", "ubuntu:24.04"]),
    image(location, "22.04", ["ubuntu:22.04"]),
    image(location, "24.04", ["ubuntu:latest_iso", "ubuntu:24.04_iso"], "CDROM"),
  ]);
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    const url = new URL(request.url ?? "/", "http://fake");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/cloudapi/v6/images") {
      response.end(JSON.stringify({ id: "images", type: "collection", items: images }));
      return;
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        httpStatus: 404,
        messages: [{ errorCode: "309", message: "Resource does not exist" }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!runIt)("IONOS Cloud's module validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const bin = process.env[`OPSCREW_${name.toUpperCase()}_BIN`] || findExecutable(name);
    if (runIt && bin === undefined) {
      console.warn(
        `[provider-ionos] skipping ${name} validation: no ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    it.skipIf(bin === undefined)(
      `validates, formats and plans the app's server and an extra server per size with ${name}`,
      async (test) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-ionos-${name}-`));
        const files = {
          ...definition.terraform.module.files,
          "cloud-init.yaml.tftpl": await readFile(join(SHARED, "cloud-init.yaml.tftpl"), "utf8"),
        };
        for (const [path, content] of Object.entries(files)) {
          const target = join(root, MODULE_DIR, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await writeFile(join(root, "main.tf"), rootModule());
        await writeFile(join(root, "terraform.tfvars.json"), JSON.stringify(rootValues()));
        const fake = await fakeIonos();
        try {
          const runner = new NodeCommandRunner();
          const env = {
            ...process.env,
            ...TOKEN_ENV,
            IONOS_API_URL: fake.url,
            TF_IN_AUTOMATION: "1",
          };
          const output: string[] = [];
          const run = async (args: string[], extra: Record<string, string> = {}) => {
            const result = await runner.run(bin as string, args, {
              cwd: root,
              env: { ...env, ...extra },
            });
            output.push(result.stdout, result.stderr);
            return result;
          };
          const init = await run(["init", "-backend=false", "-input=false", "-no-color"]);
          if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
            test.skip(
              `${name} could not download the IONOS provider (network needed): ${init.stderr.trim().split("\n")[0]}`,
            );
          }
          expect(init.exitCode, init.stdout + init.stderr).toBe(0);
          // The engine's own errors say why a provider didn't start.
          const validate = await run(["validate", "-no-color"], { TF_LOG: "ERROR" });
          if (validate.exitCode !== 0 && PLUGIN_TLS_ERROR.test(validate.stderr)) {
            test.skip(
              `${name} could not talk to the IONOS provider: their local TLS connection failed its certificate check (x509), as when software on this computer intercepts TLS`,
            );
          }
          expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
          const fmt = await run(["fmt", "-check", "-recursive", "-no-color", MODULE_DIR]);
          expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}`).toBe(0);

          const plan = await run([
            "plan",
            "-input=false",
            "-no-color",
            "-lock=false",
            "-out=tf.plan",
          ]);
          expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
          const show = await run(["show", "-json", "-no-color", "tf.plan"]);
          expect(show.exitCode, show.stderr).toBe(0);
          const planJson: unknown = JSON.parse(show.stdout);

          const servers = plannedOfType(planJson, "ionoscloud_server");
          expect(servers.map((server) => server.address).sort()).toEqual(
            SERVERS.map(({ module }) => `module.${module}.ionoscloud_server.this`).sort(),
          );
          for (const { module, extra, size, location } of SERVERS) {
            const named = extra === undefined ? "my-shop" : `my-shop-${extra}`;
            const inModule = (type: string) =>
              plannedOfType(planJson, type).filter((r) =>
                r.address.startsWith(`module.${module}.`),
              );
            expect(
              inModule("ionoscloud_datacenter").map((r) => r.values),
              module,
            ).toEqual([expect.objectContaining({ name: `opscrew-${named}`, location })]);
            expect(
              inModule("ionoscloud_lan").map((r) => r.values.public),
              module,
            ).toEqual([true]);
            expect(
              inModule("ionoscloud_ipblock").map((r) => r.values),
              module,
            ).toEqual([expect.objectContaining({ location, size: 1 })]);
            const server = servers.find((s) => s.address.startsWith(`module.${module}.`));
            expect(server?.values, module).toMatchObject({
              name: named,
              type: "VCPU",
              cores: size.vcpus,
              ram: size.memoryGb * 1024,
              image_name: imageId(location, "24.04"),
              ssh_keys: [DEPLOY_KEY],
              allow_replace: false,
              nic: [
                expect.objectContaining({
                  dhcp: true,
                  firewall_active: true,
                  firewall_type: "INGRESS",
                }),
              ],
            });
            expect(server?.values.label, module).toEqual(
              expect.arrayContaining([
                { key: "managedby", value: "opscrew" },
                { key: "app", value: "myshop" },
              ]),
            );
            const [volume] = (server?.values.volume ?? []) as Record<string, unknown>[];
            expect(volume, module).toMatchObject({ size: size.diskGb, disk_type: "ESSENTIAL" });
            // The shared cloud-config, base64-encoded as IONOS takes it, with the key and, on a
            // server that serves no web, no web ports.
            const cloudConfig = Buffer.from(String(volume?.user_data), "base64").toString("utf8");
            expect(cloudConfig.startsWith("#cloud-config\n"), module).toBe(true);
            expect(cloudConfig).toContain(`      - ${DEPLOY_KEY}\n`);
            expect(cloudConfig.includes("[ufw, allow, 80/tcp]"), module).toBe(extra === undefined);
            // One rule per IPv4 network and port; IPv6 networks get none.
            const rules = inModule("ionoscloud_firewall");
            const keys = rules.map((r) => /\["(.*)"\]$/.exec(r.address)?.[1]).sort();
            expect(keys, module).toEqual(
              (extra === undefined
                ? [
                    "SSH 203.0.113.7/32",
                    "HTTP 173.245.48.0/20",
                    "HTTPS 173.245.48.0/20",
                    "HTTP/3 173.245.48.0/20",
                    "Ping 0.0.0.0/0",
                    "WireGuard 0.0.0.0/0",
                  ]
                : ["SSH 203.0.113.7/32", "Ping 0.0.0.0/0"]
              ).sort(),
            );
            for (const rule of rules) {
              expect(String(rule.values.source_ip ?? "")).not.toContain(":");
              expect(rule.values.type).toBe("INGRESS");
            }
          }
          // SecOps reads the real plan as it reads the fixture: every server has its firewall, SSH
          // is open only to the allowed network, nothing else is open besides the web, ping and
          // WireGuard.
          expect(secopsFindings(planJson, 51820)).toEqual({
            servers: SERVERS.length,
            attached: true,
            sshOpen: false,
            otherOpen: [],
          });
          // The provider read the images with the token, and changed nothing.
          expect(fake.requests.some((r) => r.url.startsWith("/cloudapi/v6/images"))).toBe(true);
          for (const request of fake.requests) {
            expect(request).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
          }
          // The token reaches neither the plan, its JSON nor anything the engine printed.
          const printed = [...output, await readFile(join(root, "main.tf"), "utf8")].join("\n");
          expect(printed).not.toContain(TOKEN);
        } finally {
          await fake.close();
        }
      },
      300_000,
    );
  }
});

describe("IONOS Cloud definition leaks", () => {
  it("puts the token in none of its texts, its module or the HCL it writes", () => {
    // Built with the token, but never called: no request leaves the test.
    const connector = definition.connector({
      env: TOKEN_ENV,
      redactor: new Redactor(),
      fetch: offline,
    });
    const { terraform } = definition;
    const calls = [
      { prefix: "" },
      { prefix: "db_", extra: "db" },
      { prefix: "previous_" },
    ] as const;
    const written = JSON.stringify({
      terraform: {
        ...terraform,
        moduleArguments: calls.map((call) => terraform.moduleArguments(call)),
      },
      texts: allTexts(),
      credentials: definition.credentials,
      regions: definition.regions,
      connector: { configured: connector.configured, credentials: connector.credentials },
    });
    expect(written).not.toContain(TOKEN);
  });
});
