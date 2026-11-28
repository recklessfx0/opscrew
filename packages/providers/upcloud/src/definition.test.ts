import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_PROVIDER_CONTRACT_VERSION,
  type FetchLike,
  type PlannedResourceJson,
} from "@opscrew/contracts";
import { findExecutable, isRecord, NodeCommandRunner, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { TOKEN, TOKEN_ENV } from "./__fixtures__/client";
import {
  DEPLOY_KEY,
  MIME_BOUNDARY,
  mimeParts,
  upcloudPlanJson,
  userData,
} from "./__fixtures__/plan";
import {
  definition,
  STATIC_PLANS,
  STATIC_RATES,
  UPCLOUD_CREDENTIALS,
  UPCLOUD_CREDENTIALS_HINT,
  UPCLOUD_ZONES,
} from "./index";
import { HOURS_A_MONTH, HOURS_PER_30_DAYS } from "./static-prices";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];
const ENV_VARS = ["UPCLOUD_TOKEN"];
const CONSOLE_URL = "https://hub.upcloud.com/";
const PRICING_URL = "https://upcloud.com/pricing/";
/** How every text says where an UpCloud server's firewall is. */
const FIREWALL_WORDS = "cloud firewall: none; server firewall: on";
/** When the server's own firewall applies. */
const FIREWALL_GAP = "a few seconds after the server starts";
/** Why UpCloud's own firewall stays off. */
const STATELESS = "UpCloud's own firewall is stateless";
/** How the module's `name` validation starts its message: UpCloud's hostname rule. */
const NAME_RULE =
  "UpCloud needs a server hostname of 1 to 63 letters, digits or dashes that neither starts nor ends with a dash and isn't only digits";
/** Nothing in a unit test reaches the network. */
const offline: FetchLike = () => Promise.reject(new Error("no request in this test"));

/** A bash to check the boothook's syntax with, or undefined when none is here. */
const bash = [
  // Git for Windows installs its bash off PATH, where a Windows session usually finds it.
  ...(process.platform === "win32"
    ? [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`]
    : []),
  "bash",
].find((candidate) => spawnSync(candidate, ["-n", "-c", "true"]).status === 0);
if (bash === undefined) {
  console.warn("[provider-upcloud] skipping the boothook's syntax check: no bash is here.");
}

/** What `bash -n` says of `script`: its exit status and its complaints. */
function bashSyntax(script: string): { status: number | null; stderr: string } {
  const result = spawnSync(bash ?? "bash", ["-n"], { input: script, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

/** The module's main.tf. */
function mainTf(): string {
  return definition.terraform.module.files["main.tf"] ?? "";
}

/** The HCL block of `file` that starts with `head`, up to its closing brace at `head`'s indent. */
function block(head: string, file: string | undefined = mainTf()): string {
  const text = file ?? "";
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const indent = /^ */.exec(head)?.[0] ?? "";
  const rest = text.slice(start);
  return rest.slice(0, rest.indexOf(`\n${indent}}\n`) + indent.length + 2);
}

/** The module's `upcloud_server`. */
function serverBlock(): string {
  return block('resource "upcloud_server" "this" {');
}

/** Every user-facing text of the definition, its functions called with sample values. */
function allTexts(backups = true): string {
  const { texts } = definition;
  return JSON.stringify({
    ...texts,
    runbook: {
      ...texts.runbook,
      serverLabel: texts.runbook.serverLabel("PREMIUM-2xCPU-4GB", "de-fra1"),
      deletes: texts.runbook.deletes("shop"),
      whatRemains: texts.runbook.whatRemains("img", "opscrew", "wf.yml", backups),
    },
    destroy: {
      ...texts.destroy,
      snapshotRef: texts.destroy.snapshotRef("01234567-89ab-cdef-0123-456789abcdef"),
      lookup: texts.destroy.lookup("shop"),
      tokenHint: texts.destroy.tokenHint("opscrew destroy"),
    },
    notes: definition.regions.notes,
    descriptions: definition.terraform.descriptions,
  });
}

describe("UpCloud's cloud provider definition", () => {
  it("has the contract's version, its names, its pages and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "upcloud",
      displayName: "UpCloud",
      name: "UpCloud",
      serverNoun: "server",
      sizeNoun: "plan",
      consoleUrl: CONSOLE_URL,
      accountUrl: "https://hub.upcloud.com/account",
      signupUrl: "https://signup.upcloud.com/",
      pricingUrl: PRICING_URL,
    });
    // Plain pages: no query string or fragment that could carry a referral.
    expect(definition.signupUrl).toMatch(/^https:\/\/[^?#]+$/);
    expect(definition.pricingUrl).toMatch(/^https:\/\/[^?#]+$/);
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("needs only the token, and recognises its format", () => {
    const { credentials } = definition;
    expect(credentials).toMatchObject({
      envVars: ENV_VARS,
      labels: { UPCLOUD_TOKEN: "UpCloud API token" },
      mode: "any",
      createUrl: UPCLOUD_CREDENTIALS.createUrl,
      envPrefixes: ["UPCLOUD"],
    });
    expect(credentials.tokenRules).toHaveLength(1);
    const [rule] = credentials.tokenRules;
    expect(rule).toMatchObject({ id: "upcloud-token", severity: "critical" });
    expect(rule?.pattern.global).toBe(true);
    const matches = (text: string) =>
      [...text.matchAll(rule?.pattern ?? /$^/g)].map((match) => match[rule?.group ?? 0]);
    // The token, made at runtime: `ucat_` and 26 characters of Crockford's base32.
    expect(matches(`UPCLOUD_TOKEN=${TOKEN}\n`)).toEqual([TOKEN]);
    expect(matches(`export UPCLOUD_TOKEN="${TOKEN}"`)).toEqual([TOKEN]);
    const body = TOKEN.slice("ucat_".length);
    for (const text of [
      `ucat_${body.slice(1)}`,
      `ucat_${body}A`,
      `xucat_${body}`,
      `ucat_${body.slice(0, -1)}U`,
      `ucat_${body.slice(0, -1)}I`,
      `ucat_${body.slice(0, -1)}L`,
      `ucat_${body.slice(0, -1)}O`,
    ]) {
      expect(matches(text), text).toEqual([]);
    }
    for (const text of [
      'Error: Post "https://api.upcloud.com/1.3/server": dial tcp: i/o timeout',
      "with module.server.upcloud_server.this",
      'with provider["registry.opentofu.org/upcloudltd/upcloud"]',
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(true);
    }
    for (const text of ["api.hetzner.cloud", "with kamatera_server.this", "api.cloudflare.com"]) {
      expect(credentials.apiPattern.test(text), text).toBe(false);
    }
  });

  it("maps every region to the zones of the catalogue, with no note", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(locations).toEqual({
      "eu-central": ["de-fra1", "nl-ams1", "pl-waw1"],
      "eu-north": ["fi-hel1", "fi-hel2"],
      "us-east": ["us-nyc1"],
      "us-west": ["us-sjo1"],
      "ap-southeast": ["sg-sin1"],
    });
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    expect([...new Set(Object.values(locations).flat())].sort()).toEqual([...UPCLOUD_ZONES].sort());
    expect(locationNames).toEqual({
      "de-fra1": "Frankfurt",
      "nl-ams1": "Amsterdam",
      "pl-waw1": "Warsaw",
      "fi-hel1": "Helsinki 1",
      "fi-hel2": "Helsinki 2",
      "us-nyc1": "New York",
      "us-sjo1": "San Jose",
      "sg-sin1": "Singapore",
    });
    for (const zone of UPCLOUD_ZONES) {
      const [latitude, longitude] = coordinates[zone] ?? [];
      expect(Math.abs(latitude ?? 99), zone).toBeLessThanOrEqual(90);
      expect(Math.abs(longitude ?? 999), zone).toBeLessThanOrEqual(180);
    }
    expect(coordinates["us-sjo1"]?.[1]).toBeLessThan(coordinates["us-nyc1"]?.[1] ?? 0);
    expect(coordinates["fi-hel1"]?.[0]).toBeGreaterThan(coordinates["de-fra1"]?.[0] ?? 90);
    expect(coordinates["pl-waw1"]?.[1]).toBeGreaterThan(coordinates["de-fra1"]?.[1] ?? 180);
    expect(notes).toEqual({});
  });

  it("bills by the started hour in EUR, with Simple Backup at 20% and snapshots per GB that outlive the server", () => {
    expect(definition.offering).toEqual({
      currency: "EUR",
      billing: { model: "hourly", counts: "started-hour", setupFee: false },
      defaultImage: "Ubuntu 24.04",
      backupPercent: STATIC_RATES.weekPlanBackupPercent,
      providerBackups: true,
      backupsOutliveServer: true,
      snapshots: {
        kind: "per-gb",
        perGbMonth: (STATIC_RATES.backupGbMonth / HOURS_PER_30_DAYS) * HOURS_A_MONTH,
        perGbHour: STATIC_RATES.backupGbMonth / HOURS_PER_30_DAYS,
      },
      serverSnapshotsOutliveServer: true,
      deleteProtection: false,
      resize: false,
      offAfterRefusedResize: false,
      removal: { kind: "delete" },
      unavailable: expect.any(RegExp),
      serverLimit: expect.any(RegExp),
    });
    expect(definition.offering.backupPercent).toBe(20);
  });

  it("tells a zone without room from an account limit, and neither from an outage or the credits", () => {
    const { unavailable, serverLimit } = definition.offering;
    for (const text of [
      "Error: Unable to create server: STORAGE_RESOURCES_UNAVAILABLE (type=STORAGE_RESOURCES_UNAVAILABLE, status=409",
      "There is not enough capacity for this server",
      "The plan is out of stock",
      "The plan is not available in this zone",
    ]) {
      expect(unavailable.test(text), text).toBe(true);
      expect(serverLimit.test(text), text).toBe(false);
    }
    for (const text of [
      "Error: Unable to create server: Resource limit reached (type=SERVER_CORE_LIMIT_REACHED, status=403",
      "type=MAXIOPS_STORAGE_LIMIT_REACHED",
      "type=SERVER_MEMORY_LIMIT_REACHED",
      "type=SERVER_IP_LIMIT_REACHED",
    ]) {
      expect(serverLimit.test(text), text).toBe(true);
      expect(unavailable.test(text), text).toBe(false);
    }
    for (const text of [
      "Service Temporarily Unavailable",
      "Failed to get account, error was AUTHENTICATION_FAILED: Authentication failed",
      "Not enough credits (type=INSUFFICIENT_CREDITS, status=402",
      "rate limit exceeded",
    ]) {
      expect(unavailable.test(text), text).toBe(false);
      expect(serverLimit.test(text), text).toBe(false);
    }
  });

  it("prices its offers by its billing facts, from the dated table", async () => {
    const { billing, snapshots, currency, backupPercent } = definition.offering;
    const catalog = definition.connector({ env: {}, fetch: offline }).catalog();
    const offers = await catalog.listOffers();
    expect(offers).toHaveLength(STATIC_PLANS.length * UPCLOUD_ZONES.length);
    for (const offer of offers) {
      expect(offer.billing).toBe(billing.model);
      expect(offer.source).toBe("static");
      expect(offer.monthly.currency).toBe(currency);
      expect(offer.hourly?.currency).toBe(currency);
      expect(offer.hourly?.amount ?? Infinity).toBeLessThan(offer.monthly.amount);
      expect(offer.setupFee).toBeUndefined();
    }
    const extras = await catalog.extras("de-fra1");
    expect(snapshots.kind).toBe("per-gb");
    if (snapshots.kind !== "per-gb") return;
    expect(extras.snapshotPerGbMonth).toEqual({ amount: snapshots.perGbMonth, currency });
    expect(extras.snapshotPerGbHour).toEqual({ amount: snapshots.perGbHour, currency });
    expect(extras.backupPercent).toBe(backupPercent);
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
    expect(texts.interview.label).toBe("UpCloud");
    for (const city of ["Frankfurt", "Amsterdam", "Warsaw", "Helsinki", "New York", "San Jose"]) {
      expect(texts.interview.hint).toContain(city);
    }
    expect(texts.interview.hint).toContain("Singapore");
    // UpCloud's prices are a dated table: no variable turns on live prices.
    expect(texts.design.titleSuffix).toBe(" on UpCloud");
    expect(texts.design.livePricesVar).toBeUndefined();
    expect(texts.design.summaryNoun).toMatch(/^UpCloud server \(/);
    for (const name of ENV_VARS) expect(texts.init.fix).toContain(name);
    expect(texts.init.fix).toContain(UPCLOUD_CREDENTIALS_HINT);
    expect(texts.init.fix).toContain(UPCLOUD_CREDENTIALS.createUrl);
    // A token can't be limited: the help says whose rights it has, a sub-account and 90 days.
    expect(texts.init.fix).toContain("rights of the account that made it");
    expect(texts.init.fix).toContain("sub-account limited to servers and storage");
    expect(texts.init.fix).toContain("90 days or less");
    expect(texts.init.scopeNote).toBe("");
    expect(texts.rotate.deleteToken).toContain(CONSOLE_URL);
    expect(texts.rotate.deleteToken).toContain("Account → API tokens");
    expect(texts.runbook.serverLabel("PREMIUM-2xCPU-4GB", "de-fra1")).toBe(
      "UpCloud PREMIUM-2xCPU-4GB in de-fra1",
    );
    expect(texts.runbook.console).toBe("UpCloud's control panel");
    expect(texts.runbook.backupsOnDatabaseCell).toContain("Simple Backup");
    expect(texts.runbook.backupsOn).toContain("every day");
    expect(texts.runbook.backupsOn).toContain("7 days");
    expect(texts.runbook.snapshotReason).toContain("Simple Backup");
    expect(texts.runbook.deleteProtectionNote.join("\n")).toContain("No delete protection");
    expect(texts.runbook.noSnapshot.join("\n")).toContain("no database");
    expect(texts.runbook.connectNote).toEqual([]);
    expect(texts.runbook.hostKey).toBe("the server's host key");
    expect(texts.destroy.console).toBe("UpCloud's control panel");
    expect(texts.destroy.snapshotRef("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "UpCloud backup 01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(texts.destroy.lookup("shop")).toBe(
      "titled shop or shop-… and labelled opscrew-app=shop in your UpCloud account",
    );
    expect(texts.destroy.tokenHint("opscrew destroy")).toBe(
      `${UPCLOUD_CREDENTIALS_HINT} Then run \`opscrew destroy\` again.`,
    );
    // UpCloud may keep the server's backups; nothing says they are deleted with it.
    expect(texts.destroy.deletedBackups).toBeUndefined();
    expect(texts.destroy.storageConsole).toBeUndefined();
  });

  it("says the billing plainly: prepaid credits, the started hour, a stopped server bills, only a delete ends it", () => {
    const { texts } = definition;
    for (const [where, text] of Object.entries({
      interview: texts.interview.hint,
      deletes: texts.runbook.deletes("shop"),
      deleteProtection: texts.runbook.deleteProtectionNote.join(" "),
    })) {
      expect(text, where).toMatch(/stopped server still bills its plan/);
    }
    expect(texts.interview.hint).toContain("prepaid credits");
    expect(texts.interview.hint).toContain("disables the servers when they run out");
    expect(texts.interview.hint).toContain("started hour");
    expect(texts.interview.hint).toContain("EUR");
    const deletes = texts.runbook.deletes("shop");
    expect(deletes).toContain("disk");
    expect(deletes).toContain("only the delete ends its cost");
    expect(deletes).toContain("IPv4 address");
  });

  it("says the server's backups may outlive it and bill per GB a month, and OpsCrew deletes none", () => {
    const { texts } = definition;
    for (const text of [texts.destroy.snapshotBilling, texts.destroy.snapshotBilled]) {
      expect(text).toContain("per GB per month");
      expect(text).not.toMatch(/€|\d+\.\d+/);
    }
    expect(texts.destroy.snapshotBilling).toContain("after their server is deleted");
    expect(texts.destroy.keptBackups).toContain("Simple Backup");
    expect(texts.destroy.keptBackups).toContain("may keep");
    expect(texts.destroy.keptBackupsRemaining).toContain("Simple Backup");
    expect(texts.destroy.keptBackupsRemaining).toContain("per GB per month");
    const snapshotFirst = texts.runbook.snapshotFirst.join("\n");
    expect(snapshotFirst).toContain("per GB per month");
    expect(snapshotFirst).toContain("after the server is gone");
    const remains = (backups: boolean) =>
      texts.runbook.whatRemains("img", "opscrew", "wf.yml", backups).join("\n");
    expect(remains(false)).toContain("`opscrew-…`");
    expect(remains(false)).toContain("per GB per month");
    expect(remains(false)).not.toContain("Simple Backup");
    expect(remains(true)).toContain("Simple Backup");
    for (const text of ["`img`", "`opscrew/`", "`wf.yml`"]) expect(remains(true)).toContain(text);
  });

  it("says plainly that the server's own firewall is on, why, and when it applies", () => {
    const { texts } = definition;
    const said = {
      interview: texts.interview.hint,
      design: texts.design.summaryNoun,
      runbook: texts.runbook.cloudFirewall,
      secops: texts.secops.attachedText,
    };
    for (const [where, text] of Object.entries(said)) {
      expect(text.toLowerCase(), where).toContain(FIREWALL_WORDS);
      // Why: UpCloud's firewall is stateless, so it would open every return port to everyone.
      expect(text, where).toContain(STATELESS);
      // The few seconds between the server's start and the firewall's first step.
      expect(text, where).toContain(FIREWALL_GAP);
    }
    for (const where of ["design", "runbook", "secops"] as const) {
      expect(said[where], where).toContain("thousands of ports to the whole internet");
    }
  });

  it("claims no cloud firewall and names no task in any text", () => {
    for (const backups of [false, true]) {
      const text = allTexts(backups);
      // Every mention of a cloud firewall says there is none.
      for (const match of text.matchAll(/.{0,30}cloud firewall.{0,7}/gi)) {
        expect(match[0], match[0]).toMatch(/cloud firewall: none/i);
      }
      expect(text).not.toMatch(/\bT\d{4}\b|\b0\d\d\b|feature \d|decision \d|R6/);
    }
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments } = definition.terraform;
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["app", "var.app_name"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["backups", "var.backups"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
    ]);
    // An app tag passed in is ignored: the server's label holds the app.
    expect(
      moduleArguments({ prefix: "db_", extra: "db", appTag: "module.server.app_tag_name" }),
    ).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-db"'],
      ["app", "var.app_name"],
      ["location", "var.db_location"],
      ["server_type", "var.db_server_type"],
      ["image", "var.db_image"],
      ["backups", "var.db_backups"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
    ]);
    const previous = moduleArguments({ prefix: "previous_" });
    expect(previous).toContainEqual(["location", "var.previous_location"]);
    expect(previous).toContainEqual(["backups", "var.previous_backups"]);
    expect(previous).toContainEqual(["http_allowed_cidrs", "var.http_allowed_cidrs"]);
  });

  it("uses UpCloud's own Terraform provider, the cloud-init first boot, and nothing of the connector", () => {
    // cloud-init, the default first boot: UpCloud's templates run it with UpCloud's own
    // datasource, so a script that seeds cloud-init again couldn't apply the cloud-config there.
    expect(definition.terraform.firstBoot).toBeUndefined();
    expect(definition.texts.secops.firewallCheck).toBe("server");
    expect(definition.terraform).toMatchObject({
      provider: { name: "upcloud", source: "UpCloudLtd/upcloud", version: "~> 5.49" },
      serverResourceType: "upcloud_server",
      firewallResourceType: "upcloud_firewall_rules",
      connectorFirewall: false,
      connectorBackups: false,
      connectorRemoval: false,
      homeCacheFiles: [],
      mirroredAttributes: {},
      deleteProtectionVariable: false,
    });
    // No root variable and no import id of its own: the takeover imports the server's UUID.
    expect(definition.terraform.rootVariables).toBeUndefined();
    expect(definition.terraform.importId).toBeUndefined();
    const { credentialsComment, descriptions } = definition.terraform;
    expect(credentialsComment).toContain("UPCLOUD_TOKEN");
    expect(credentialsComment).toContain("network");
    expect(descriptions.backups).toContain("Simple Backup");
    expect(descriptions.serverType).toContain("PREMIUM-2xCPU-4GB");
    const versions = definition.terraform.module.files["versions.tf"] ?? "";
    expect(versions).toContain('source  = "UpCloudLtd/upcloud"');
    expect(versions).toContain('version = "~> 5.49"');
  });

  it("gives each server the deploy key's text in its login, with no key object to share", () => {
    expect(definition.terraform.extraShared).toEqual({
      resources: [],
      sshKeyId: "var.deploy_ssh_public_key",
    });
    expect(block("  login {", serverBlock())).toBe(
      [
        "  login {",
        "    keys              = [var.ssh_public_key]",
        "    create_password   = false",
        '    password_delivery = "none"',
        "  }",
      ].join("\n"),
    );
  });

  it("makes only the server: no upcloud_firewall_rules, and UpCloud's own firewall off", () => {
    expect(mainTf()).not.toMatch(/^resource "(?!upcloud_server")/m);
    expect(mainTf()).not.toContain("upcloud_firewall_rules");
    expect(serverBlock()).toContain("  firewall = false\n");
    // The reason is written where the switch is.
    expect(mainTf()).toContain("it is stateless");
  });

  it("ignores the server's attributes whose change would rebuild its disk, and says so to drift", () => {
    expect(definition.terraform.lifecycleIgnored).toEqual(["user_data", "login", "template"]);
    expect(serverBlock()).toContain("    ignore_changes = [user_data, login, template]\n");
  });

  it("maps each plan to the MaxIOPS disk its price includes, equal to the offers", async () => {
    const plans = [...mainTf().matchAll(/^ {4}"(PREMIUM-\d+xCPU-\d+GB)" += (\d+)$/gm)].map(
      ([, id, disk]) => ({ id, diskGb: Number(disk) }),
    );
    expect(plans).toEqual(STATIC_PLANS.map(({ id, diskGb }) => ({ id, diskGb })));
    const offers = await definition.connector({ env: {}, fetch: offline }).catalog().listOffers();
    for (const offer of offers) {
      expect(plans, offer.id).toContainEqual({ id: offer.id, diskGb: offer.diskGb });
    }
    expect(block("  template {", serverBlock())).toBe(
      [
        "  template {",
        "    storage = local.images[var.image]",
        "    size    = local.plans[var.server_type]",
        '    tier    = "maxiops"',
        "  }",
      ].join("\n"),
    );
  });

  it("maps the definition's image to UpCloud's Ubuntu 24.04 template", () => {
    expect(mainTf()).toContain(
      `    ${JSON.stringify(definition.offering.defaultImage)} = "Ubuntu Server 24.04 LTS (Noble Numbat)"\n`,
    );
  });

  it("creates the server named, labelled and on its plan in its zone, with the metadata service and two interfaces", () => {
    const server = serverBlock();
    for (const line of [
      "  hostname = var.name",
      "  title    = var.name",
      "  zone     = var.location",
      "  plan     = var.server_type",
      '  labels   = { "opscrew-app" = var.app }',
      "  metadata = true",
    ]) {
      expect(server, line).toContain(`${line}\n`);
    }
    const interfaces = [...server.matchAll(/^ {2}network_interface \{\n([\s\S]*?)\n {2}\}$/gm)].map(
      ([, body]) => body,
    );
    expect(interfaces).toEqual([
      [
        "    index             = 1",
        '    type              = "public"',
        '    ip_address_family = "IPv4"',
      ].join("\n"),
      ["    index = 2", '    type  = "utility"'].join("\n"),
    ]);
  });

  it("renders the server's own firewall from the module's networks, and the cloud-config as every cloud-init provider does", () => {
    const locals = block("locals {");
    for (const line of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  server_firewall = templatefile("${path.module}/server-firewall.sh.tftpl", {',
      '    ssh_sources    = join(" ", var.ssh_allowed_cidrs)',
      '    web_sources    = var.web ? join(" ", var.http_allowed_cidrs) : ""',
      '    wireguard_port = var.wireguard_port == null ? "" : tostring(var.wireguard_port)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  cloud_config = templatefile("${path.module}/cloud-init.yaml.tftpl", {',
      "    ssh_public_key  = var.ssh_public_key",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '    check_key_entry = var.check_key_line == "" ? "" : "\\n      - ${jsonencode(var.check_key_line)}"',
      "    web             = var.web",
      `  boundary = "${MIME_BOUNDARY}"`,
    ]) {
      expect(locals, line).toContain(`${line}\n`);
    }
    const variables = definition.terraform.module.files["variables.tf"] ?? "";
    for (const name of ["ssh_allowed_cidrs", "http_allowed_cidrs"]) {
      const variable = block(`variable "${name}" {`, variables);
      expect(variable, name).toContain("  type        = list(string)\n");
      expect(variable, name).toContain('  default     = ["0.0.0.0/0", "::/0"]\n');
    }
  });

  it("gives the server a MIME user data: the server firewall's boothook, then the cloud-config", () => {
    const server = serverBlock();
    const start = server.indexOf("  user_data = <<-EOT\n");
    expect(start).toBeGreaterThan(0);
    const heredoc = server.slice(start, server.indexOf("\n  EOT\n", start) + "\n  EOT".length);
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    const lines = [
      'Content-Type: multipart/mixed; boundary="${local.boundary}"',
      "MIME-Version: 1.0",
      "",
      "--${local.boundary}",
      'Content-Type: text/cloud-boothook; charset="us-ascii"',
      "",
      "#!/bin/bash",
      "set -euo pipefail",
      "exec >>/var/log/opscrew-first-boot.log 2>&1",
      "if [ -e /etc/opscrew/server-firewall.done ]; then exit 0; fi",
      "${local.server_firewall}",
      "install -m 0600 /dev/null /etc/opscrew/server-firewall.done",
      "date -Is >/etc/opscrew/server-firewall.done",
      "--${local.boundary}",
      'Content-Type: text/cloud-config; charset="us-ascii"',
      "",
      "${local.cloud_config}",
      "--${local.boundary}--",
    ];
    expect(heredoc).toBe(
      [
        "  user_data = <<-EOT",
        ...lines.map((line) => (line === "" ? "" : `    ${line}`)),
        "  EOT",
      ].join("\n"),
    );
    // The fixture's user data is the heredoc as the engine renders it (`<<-` strips the indent and
    // inserts each value as it is), so the security checks below read what the module plans.
    const rendered = `${lines
      .join("\n")
      .replaceAll("${local.boundary}", MIME_BOUNDARY)
      .replaceAll("${local.server_firewall}", "")
      .replaceAll("${local.cloud_config}", "#cloud-config\n")}\n`;
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    expect(userData({ firewallStep: false })).toBe(rendered);
    // No startup script: UpCloud's cloud-init reads the user data itself.
    expect(mainTf()).not.toContain("first-boot.sh.tftpl");
  });

  it("puts the boothook before the cloud-config, guarded so a step that succeeded runs once", () => {
    const parts = mimeParts(userData({ cloudConfig: "#cloud-config\nusers: []\n" }));
    expect(parts.map((part) => part.headers["content-type"])).toEqual([
      'text/cloud-boothook; charset="us-ascii"',
      'text/cloud-config; charset="us-ascii"',
    ]);
    const [boothook, cloudConfig] = parts.map((part) => part.body);
    expect(cloudConfig).toBe("#cloud-config\nusers: []\n");
    const script = boothook ?? "";
    expect(script.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
    const at = (text: string) => script.indexOf(text);
    const guard = at("if [ -e /etc/opscrew/server-firewall.done ]; then exit 0; fi\n");
    expect(guard).toBeGreaterThan(at("exec >>/var/log/opscrew-first-boot.log 2>&1\n"));
    expect(at(SERVER_FIREWALL_MARKER)).toBeGreaterThan(guard);
    expect(at("\nopscrew_server_firewall\n")).toBeGreaterThan(at(SERVER_FIREWALL_MARKER));
  });

  it("writes the boothook's marker, root's alone, only after the step returned, and lets no failure pass", () => {
    const [boothook] = mimeParts(userData());
    const script = boothook?.body ?? "";
    // The step's call is the fragment's last line; the marker's two lines follow it, and nothing
    // else writes the marker. A failed step never returns: set -e stops the boothook, and the
    // step's own trap powers the server off.
    expect(
      script.endsWith(
        [
          "\nopscrew_server_firewall",
          "",
          "install -m 0600 /dev/null /etc/opscrew/server-firewall.done",
          "date -Is >/etc/opscrew/server-firewall.done",
        ].join("\n"),
      ),
    ).toBe(true);
    const lastCall = script.lastIndexOf("\nopscrew_server_firewall\n");
    const writes = [...script.matchAll(/^(?!if \[ -e )[^#\n]*server-firewall\.done.*$/gm)];
    expect(writes.map((write) => write[0])).toEqual([
      "install -m 0600 /dev/null /etc/opscrew/server-firewall.done",
      "date -Is >/etc/opscrew/server-firewall.done",
    ]);
    for (const write of writes) expect(write.index, write[0]).toBeGreaterThan(lastCall);
    // Nothing hides the step's status: no `|| true`, no `|| :`, and errexit stays on.
    expect(script).not.toMatch(/\|\|\s*(?:true|:)(?:\s|$)/);
    expect(script).not.toMatch(/^\s*set \+e/m);
    expect(script).toMatch(/^set -euo pipefail$/m);
  });

  it.skipIf(bash === undefined)("has a boothook bash accepts", () => {
    const [boothook] = mimeParts(userData({ wireguardPort: 51820 }));
    expect(bashSyntax(boothook?.body ?? "")).toEqual({ status: 0, stderr: "" });
  });

  it("turns on Simple Backup's week plan only when the plan asks for backups", () => {
    expect(block('  dynamic "simple_backup" {', serverBlock())).toBe(
      [
        '  dynamic "simple_backup" {',
        '    for_each = var.backups ? ["dailies"] : []',
        "    content {",
        "      plan = simple_backup.value",
        '      time = "0300"',
        "    }",
        "  }",
      ].join("\n"),
    );
    const backups = block(
      'variable "backups" {',
      definition.terraform.module.files["variables.tf"],
    );
    expect(backups).toContain("  type        = bool\n");
    expect(backups).toContain("  default     = false\n");
  });

  it("refuses a hostname UpCloud's provider refuses, before the provider sees it, saying what to do", () => {
    const name = block('variable "name" {', definition.terraform.module.files["variables.tf"]);
    expect(name).toContain(
      '    condition     = can(regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$", var.name)) && can(regex("[a-zA-Z-]", var.name))\n',
    );
    expect(name).toContain(
      `    error_message = "${NAME_RULE}, and OpsCrew would name this server \\"\${var.name}\\". Choose a different app name (or extra server's name) so that the server's name fits."\n`,
    );
  });

  it("outputs what the root module reads from every server module, the server's UUID as its id", () => {
    const outputs = definition.terraform.module.files["outputs.tf"] ?? "";
    for (const name of ["ipv4_address", "ipv6_address", "server_id", "server_name", "ssh_key_id"]) {
      expect(outputs).toContain(`output "${name}" {`);
    }
    expect(block('output "server_id" {', outputs)).toContain(
      "  value       = upcloud_server.this.id\n",
    );
    expect(block('output "server_name" {', outputs)).toContain(
      "  value       = upcloud_server.this.title\n",
    );
    expect(block('output "ssh_key_id" {', outputs)).toContain(
      "  value       = var.ssh_public_key\n",
    );
    expect(outputs).toContain("upcloud_server.this.network_interface");
  });

  it("embeds the current module, without OpsCrew's first-boot files", () => {
    expect(definition.terraform.module.name).toBe("upcloud-instance");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files).sort()).toEqual([
      "main.tf",
      "outputs.tf",
      "variables.tf",
      "versions.tf",
    ]);
    // The files OpsCrew adds beside it, which it reads: the cloud-config and the server firewall's
    // step, and no first-boot script.
    const added = [...mainTf().matchAll(/"\$\{path\.module\}\/([^"]+)"/g)].map(([, file]) => file);
    expect([...new Set(added)].sort()).toEqual([
      "cloud-init.yaml.tftpl",
      "server-firewall.sh.tftpl",
    ]);
  });
});

/** The managed resources of a plan's JSON, every module's, with their unknown attributes. */
function plannedResources(planJson: unknown): PlannedResourceJson[] {
  const unknown = new Map<string, Record<string, unknown>>();
  if (isRecord(planJson) && Array.isArray(planJson.resource_changes)) {
    for (const change of planJson.resource_changes) {
      if (!isRecord(change) || !isRecord(change.change)) continue;
      const afterUnknown = change.change.after_unknown;
      if (isRecord(afterUnknown)) unknown.set(String(change.address), afterUnknown);
    }
  }
  const out: PlannedResourceJson[] = [];
  const walk = (module: unknown) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.mode !== "managed") continue;
      const address = String(resource.address);
      out.push({
        address,
        type: String(resource.type),
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
/** The server firewall step's first line and its default drop, as SecOps finds the step. */
const SERVER_FIREWALL_MARKER = "# opscrew-server-firewall:";
const SERVER_FIREWALL_DROP = "type filter hook input priority filter; policy drop;";

/**
 * What SecOps's plan checks find for each UpCloud server of `planJson` (`@opscrew/secops`'s
 * `providerPolicies` with `firewallCheck` `server`): the attribute whose text holds the server
 * firewall's step (any string with its marker) and the networks it lets in, whether the server has its SSH key (the "uses SSH
 * keys" check, reading the definition's `sshKeyAttribute`), whether Simple Backup is on (the
 * definition's `backups`), and whether SSH is open to everyone.
 */
function secopsFindings(planJson: unknown) {
  const { secops } = definition.texts;
  const resources = plannedResources(planJson);
  return resources
    .filter((resource) => resource.type === definition.terraform.serverResourceType)
    .map((server) => {
      const [attribute, script] =
        Object.entries(server.values).find(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[1].includes(SERVER_FIREWALL_MARKER),
        ) ?? [];
      const value = (name: string) =>
        script === undefined || !script.includes(SERVER_FIREWALL_DROP)
          ? undefined
          : new RegExp(`^${name}='([^']*)'$`, "m").exec(script)?.[1];
      const words = (text: string | undefined) => text?.split(" ").filter((w) => w !== "");
      const ssh = words(value("ssh_sources"));
      const key = server.values[secops.sshKeyAttribute ?? "ssh_keys"];
      return {
        address: server.address,
        firewall:
          ssh === undefined
            ? undefined
            : {
                attribute,
                ssh,
                web: words(value("web_sources")),
                wireguard: value("wireguard_port"),
              },
        keys: Array.isArray(key) ? key.length > 0 : key !== undefined && key !== null,
        backups: secops.backups?.(server, resources) ?? server.values.backups === true,
        sshOpen: (ssh ?? []).some((network) => OPEN_TO_ALL.includes(network)),
        firewalls: resources.filter((r) => r.type === definition.terraform.firewallResourceType)
          .length,
      };
    });
}

describe("UpCloud's security checks", () => {
  const { secops } = definition.texts;

  it("read the server's own firewall from its user data's boothook, since UpCloud's stays off", () => {
    expect(secops.firewallCheck).toBe("server");
    expect(secops.noun).toBe("server");
    // No cloud firewall resource is read: the module never makes one.
    expect(secops.rules({} as PlannedResourceJson)).toEqual([]);
    expect(secops.attached({} as PlannedResourceJson, [], {})).toBe(false);
    const [server] = secopsFindings(
      upcloudPlanJson({
        sshCidrs: ["203.0.113.7/32", "2001:db8::/48"],
        httpCidrs: ["173.245.48.0/20", "2400:cb00::/32"],
        wireguardPort: 51820,
      }),
    );
    expect(server).toEqual({
      address: "module.server.upcloud_server.this",
      firewall: {
        attribute: "user_data",
        ssh: ["203.0.113.7/32", "2001:db8::/48"],
        web: ["173.245.48.0/20", "2400:cb00::/32"],
        wireguard: "51820",
      },
      keys: true,
      backups: false,
      sshOpen: false,
      firewalls: 0,
    });
    expect(secops.attachedText).toMatch(/^Cloud firewall: none; server firewall: on\. /);
  });

  it("find the firewall's step in the user data's first part, before the cloud-config", () => {
    const user = userData({ cloudConfig: "#cloud-config\npackages: [ufw]\n" });
    expect(user.indexOf(SERVER_FIREWALL_MARKER)).toBeGreaterThan(
      user.indexOf("Content-Type: text/cloud-boothook"),
    );
    expect(user.indexOf(SERVER_FIREWALL_MARKER)).toBeLessThan(
      user.indexOf("Content-Type: text/cloud-config"),
    );
    expect(user.indexOf("\nopscrew_server_firewall\n")).toBeLessThan(user.indexOf("#cloud-config"));
  });

  it("find no firewall in a user data without the step, and say what to do", () => {
    const [server] = secopsFindings(upcloudPlanJson({ firewallStep: false }));
    expect(server?.firewall).toBeUndefined();
    expect(secops.unattachedText).toMatch(/^Cloud firewall: none; server firewall: off\. /);
    expect(secops.unattachedText).toContain("every port");
    expect(secops.unattachedText).toContain("opscrew provision");
  });

  it("fail a plan that opens SSH to everyone", () => {
    for (const sshCidrs of [["0.0.0.0/0"], ["203.0.113.7/32", "::/0"]]) {
      const [server] = secopsFindings(upcloudPlanJson({ sshCidrs }));
      expect(server?.firewall?.ssh, sshCidrs.join(" ")).toEqual(sshCidrs);
      expect(server?.sshOpen, sshCidrs.join(" ")).toBe(true);
    }
  });

  it("read the deploy key from the server's login block", () => {
    expect(secops.sshKeyAttribute).toBe("login");
    const [server] = secopsFindings(upcloudPlanJson());
    expect(server?.keys).toBe(true);
    const [keyless] = secopsFindings(upcloudPlanJson({ keys: null }));
    expect(keyless?.keys).toBe(false);
    expect(secops.keylessText).toContain("Add the deploy key");
  });

  it("read Simple Backup from the planned server's simple_backup block", () => {
    const resources = (plan: unknown) => plannedResources(plan);
    const backups = (simpleBackup?: Record<string, unknown>[]) => {
      const plan = upcloudPlanJson(simpleBackup === undefined ? {} : { simpleBackup });
      const [server] = resources(plan);
      return server === undefined ? undefined : secops.backups?.(server, resources(plan));
    };
    expect(backups([{ plan: "dailies", time: "0300" }])).toBe(true);
    expect(backups()).toBe(false);
    expect(backups([])).toBe(false);
    // UpCloud turns Simple Backup on only with both a plan and a time.
    expect(backups([{ plan: "dailies", time: null }])).toBe(false);
    expect(backups([{ plan: null, time: "0300" }])).toBe(false);
    const [on] = secopsFindings(
      upcloudPlanJson({ simpleBackup: [{ plan: "dailies", time: "0300" }] }),
    );
    expect(on?.backups).toBe(true);
    expect(secops.backupsText).toContain("Simple Backup");
  });
});

// Downloads UpCloud's provider from the registry, so it only runs with OPSCREW_IT=1. Binaries come
// from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH. The plan reaches nothing else: a local
// fake answers the provider's reads (the account, the plans and the zones), with the token.
const runIt = process.env.OPSCREW_IT === "1";
if (!runIt) {
  console.warn(
    "[provider-upcloud] skipping HCL validation: set OPSCREW_IT=1 (it downloads the UpCloud provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
/** The engine's log when the provider's plugin refuses the engine's local TLS certificate. */
const PLUGIN_TLS_ERROR = /authentication handshake failed: .*x509/;
/** OpsCrew's first-boot files, which iac-templates adds to the module: the cloud-config and the firewall's step. */
const SHARED = join(packageDir, "../../iac-templates/shared");
const MODULE_DIR = "modules/upcloud-instance";

/** One server of the integration root: the app's (`prefix` "") or an extra one, on `plan`. */
interface PlannedServer {
  module: string;
  prefix: "" | `${string}_`;
  extra?: string;
  plan: (typeof STATIC_PLANS)[number];
  zone: string;
  backups: boolean;
}

/** The app's server, then one extra server per other plan, each in its own zone. */
const SERVERS: PlannedServer[] = STATIC_PLANS.map((plan, index) => {
  const zone = UPCLOUD_ZONES[index] as string;
  // Simple Backup on the app's server and every other extra one.
  const backups = index % 2 === 0;
  if (index === 0) return { module: "server", prefix: "", plan, zone, backups };
  const extra = `p${index}`;
  return { module: `server_${extra}`, prefix: `${extra}_`, extra, plan, zone, backups };
});

/**
 * A root module as OpsCrew renders one, with the app's server (the scheduled check's key and a
 * WireGuard port) and an extra server per other plan (no web, the key's text as `ssh_key_id`).
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
      : [
          "  web = false",
          "  wireguard_port = 51821",
          `  ssh_key_id = ${terraform.extraShared.sshKeyId}`,
        ]),
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
    ...SERVERS.flatMap(({ prefix }) => [
      ...["location", "server_type", "image"].flatMap((name) =>
        variable(`${prefix}${name}`, "string"),
      ),
      ...variable(`${prefix}backups`, "bool"),
    ]),
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
    "",
    // The shared cloud-config as every cloud-init provider's module renders it (Hetzner's), on a
    // server that serves the web and on one that doesn't: what the user data's second part holds.
    ...[true, false].flatMap((web) => [
      `output "cloud_config_${web ? "web" : "no_web"}" {`,
      `  value = templatefile("./${MODULE_DIR}/cloud-init.yaml.tftpl", {`,
      "    ssh_public_key  = var.deploy_ssh_public_key",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '    check_key_entry = var.check_key_line == "" ? "" : "\\n      - ${jsonencode(var.check_key_line)}"',
      `    web             = ${web}`,
      "  })",
      "}",
    ]),
  ].join("\n");
}

/** SSH from one address and one IPv6 network; the web from two of Cloudflare's ranges. */
const SSH_CIDRS = ["203.0.113.7/32", "2001:db8::/48"];
const HTTP_CIDRS = ["173.245.48.0/20", "2400:cb00::/32"];

/** The root's variable values. */
function rootValues(): Record<string, unknown> {
  return {
    app_name: "shop",
    deploy_ssh_public_key: DEPLOY_KEY,
    check_key_line: `restrict,command="/usr/local/sbin/opscrew-check" ${DEPLOY_KEY}`,
    ssh_allowed_cidrs: SSH_CIDRS,
    http_allowed_cidrs: HTTP_CIDRS,
    ...Object.fromEntries(
      SERVERS.flatMap(({ prefix, plan, zone, backups }) => [
        [`${prefix}location`, zone],
        [`${prefix}server_type`, plan.id],
        [`${prefix}image`, definition.offering.defaultImage],
        [`${prefix}backups`, backups],
      ]),
    ),
  };
}

/**
 * A local fake of UpCloud's API (`UPCLOUD_DEBUG_API_BASE_URL`, read by UpCloud's Go client): the
 * account the provider checks the token with, the plans and the zones it checks a plan against,
 * 404 for anything else.
 */
async function fakeUpcloud() {
  const requests: { method: string; url: string; authorization: unknown }[] = [];
  const answers: Record<string, unknown> = {
    "/1.3/account": {
      account: { credits: 10000, username: "opscrew-test", resource_limits: { cores: 100 } },
    },
    "/1.3/plan": {
      plans: {
        plan: STATIC_PLANS.map((plan) => ({
          name: plan.id,
          core_number: plan.vcpus,
          memory_amount: plan.memoryGb * 1024,
          storage_size: plan.diskGb,
          storage_tier: "maxiops",
          public_traffic_out: 0,
        })),
      },
    },
    "/1.3/zone": {
      zones: { zone: UPCLOUD_ZONES.map((id) => ({ id, description: id, public: "yes" })) },
    },
  };
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const answer = request.method === "GET" ? answers[path] : undefined;
    response.setHeader("content-type", "application/json");
    if (answer === undefined) {
      response.statusCode = 404;
      response.end(
        JSON.stringify({ error: { error_code: "NOT_FOUND", error_message: "Not found" } }),
      );
      return;
    }
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!runIt)("UpCloud's module validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const bin = process.env[`OPSCREW_${name.toUpperCase()}_BIN`] || findExecutable(name);
    if (runIt && bin === undefined) {
      console.warn(
        `[provider-upcloud] skipping ${name} validation: no ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    it.skipIf(bin === undefined)(
      `validates, formats and plans the app's server and an extra server per plan with ${name}`,
      async (test) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-upcloud-${name}-`));
        const files = {
          ...definition.terraform.module.files,
          "cloud-init.yaml.tftpl": await readFile(join(SHARED, "cloud-init.yaml.tftpl"), "utf8"),
          "server-firewall.sh.tftpl": await readFile(
            join(SHARED, "server-firewall.sh.tftpl"),
            "utf8",
          ),
        };
        for (const [path, content] of Object.entries(files)) {
          const target = join(root, MODULE_DIR, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await writeFile(join(root, "main.tf"), rootModule());
        await writeFile(join(root, "terraform.tfvars.json"), JSON.stringify(rootValues()));
        const fake = await fakeUpcloud();
        try {
          const runner = new NodeCommandRunner();
          const env = {
            ...process.env,
            UPCLOUD_USERNAME: undefined,
            UPCLOUD_PASSWORD: undefined,
            ...TOKEN_ENV,
            UPCLOUD_DEBUG_API_BASE_URL: fake.url,
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
              `${name} could not download the UpCloud provider (network needed): ${init.stderr.trim().split("\n")[0]}`,
            );
          }
          expect(init.exitCode, init.stdout + init.stderr).toBe(0);
          // The engine's own errors say why a provider didn't start.
          const validate = await run(["validate", "-no-color"], { TF_LOG: "ERROR" });
          if (validate.exitCode !== 0 && PLUGIN_TLS_ERROR.test(validate.stderr)) {
            test.skip(
              `${name} could not talk to the UpCloud provider: their local TLS connection failed its certificate check (x509), as when software on this computer intercepts TLS`,
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
          /** The root's two renders of the shared cloud-config, by `web` and `no_web`. */
          const outputs = Object.fromEntries(
            ["web", "no_web"].map((key) => {
              const all =
                isRecord(planJson) && isRecord(planJson.planned_values)
                  ? planJson.planned_values.outputs
                  : undefined;
              const output = isRecord(all) ? all[`cloud_config_${key}`] : undefined;
              return [key, isRecord(output) ? output.value : undefined];
            }),
          );

          const resources = plannedResources(planJson);
          // Only the servers: no upcloud_firewall_rules, no key object.
          expect(resources.map((resource) => resource.address).sort()).toEqual(
            SERVERS.map(({ module }) => `module.${module}.upcloud_server.this`).sort(),
          );
          const findings = secopsFindings(planJson);
          for (const { module, extra, plan: offer, zone, backups } of SERVERS) {
            const server = resources.find((s) => s.address.startsWith(`module.${module}.`));
            const title = extra === undefined ? "shop" : `shop-${extra}`;
            expect(server?.values, module).toMatchObject({
              hostname: title,
              title,
              zone,
              plan: offer.id,
              labels: { "opscrew-app": "shop" },
              metadata: true,
              firewall: false,
              template: [
                {
                  storage: "Ubuntu Server 24.04 LTS (Noble Numbat)",
                  size: offer.diskGb,
                  tier: "maxiops",
                },
              ],
              network_interface: [
                { index: 1, type: "public", ip_address_family: "IPv4" },
                { index: 2, type: "utility" },
              ],
              login: [{ keys: [DEPLOY_KEY], create_password: false, password_delivery: "none" }],
              simple_backup: backups ? [{ plan: "dailies", time: "0300" }] : [],
            });
            // What SecOps reads from the planned server: the firewall's networks from user_data,
            // the key from the login block, Simple Backup from simple_backup.
            expect(
              findings.find((f) => f.address === server?.address),
              module,
            ).toEqual({
              address: `module.${module}.upcloud_server.this`,
              firewall: {
                attribute: "user_data",
                ssh: SSH_CIDRS,
                web: extra === undefined ? HTTP_CIDRS : [],
                wireguard: extra === undefined ? "51820" : "51821",
              },
              keys: true,
              backups,
              sshOpen: false,
              firewalls: 0,
            });
            // The user data is the fixture's, byte for byte: the boothook with the server's own
            // firewall from the root's networks, then the shared cloud-config as every cloud-init
            // provider renders it, with the key and, on a server that serves no web, no web ports.
            const user = String(server?.values.user_data);
            const cloudConfig = String(outputs[extra === undefined ? "web" : "no_web"]);
            expect(user, module).toBe(
              userData({
                sshCidrs: SSH_CIDRS,
                httpCidrs: extra === undefined ? HTTP_CIDRS : [],
                wireguardPort: extra === undefined ? 51820 : 51821,
                cloudConfig,
              }),
            );
            const parts = mimeParts(user);
            expect(parts.map((part) => part.headers["content-type"]?.split(";")[0])).toEqual([
              "text/cloud-boothook",
              "text/cloud-config",
            ]);
            expect(parts[1]?.body, module).toBe(cloudConfig);
            expect(cloudConfig.startsWith("#cloud-config\n"), module).toBe(true);
            expect(cloudConfig).toContain(`      - ${DEPLOY_KEY}\n`);
            expect(cloudConfig.includes("[ufw, allow, 80/tcp]"), module).toBe(extra === undefined);
            const boothook = parts[0]?.body ?? "";
            expect(boothook).toContain(SERVER_FIREWALL_MARKER);
            if (bash !== undefined) {
              expect(bashSyntax(boothook), module).toEqual({ status: 0, stderr: "" });
            }
          }
          // The provider read the account, the plans and the zones, and nothing else, with the token.
          expect(fake.requests.length).toBeGreaterThan(0);
          for (const request of fake.requests) {
            expect(request).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
            expect(request.url).toMatch(/^\/1\.3\/(?:account|plan|zone)$/);
          }
          // A hostname UpCloud's provider refuses stops the plan in OpsCrew's words: digits only.
          const digits = await run([
            "plan",
            "-input=false",
            "-no-color",
            "-lock=false",
            "-var=app_name=123",
          ]);
          expect(digits.exitCode, digits.stdout).not.toBe(0);
          const said = `${digits.stdout} ${digits.stderr}`
            .replace(/[│╷╵]/g, " ")
            .replace(/\s+/g, " ");
          expect(said).toContain(
            `${NAME_RULE}, and OpsCrew would name this server "123". Choose a different app name (or extra server's name) so that the server's name fits.`,
          );
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

describe("UpCloud definition leaks", () => {
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

/** OpenTofu or Terraform, for the module's variables alone (no provider, so no network). */
const engine =
  process.env.OPSCREW_TOFU_BIN ||
  findExecutable("tofu") ||
  process.env.OPSCREW_TERRAFORM_BIN ||
  findExecutable("terraform");
if (engine === undefined) {
  console.warn(
    "[provider-upcloud] skipping the variables' validation run: no tofu or terraform binary (set OPSCREW_TOFU_BIN or add it to PATH).",
  );
}

describe("the module's variables", () => {
  const variables = () => definition.terraform.module.files["variables.tf"] ?? "";

  it("check each network of the server's own firewall and its WireGuard port", () => {
    for (const name of ["ssh_allowed_cidrs", "http_allowed_cidrs"]) {
      expect(block(`variable "${name}" {`, variables()), name).toContain(
        `    condition     = alltrue([for cidr in var.${name} : can(cidrhost(cidr, 0))])`,
      );
    }
    expect(variables()).toContain(
      "    condition     = var.wireguard_port == null ? true : var.wireguard_port >= 1 && var.wireguard_port <= 65535 && floor(var.wireguard_port) == var.wireguard_port",
    );
  });

  it.skipIf(engine === undefined)(
    "refuse a hostname UpCloud refuses, a network that isn't one and a port outside 1 to 65535, before anything is planned",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opscrew-upcloud-variables-"));
      await writeFile(join(root, "variables.tf"), variables());
      const runner = new NodeCommandRunner();
      const env = { ...process.env, TF_IN_AUTOMATION: "1" };
      const run = (args: string[]) => runner.run(engine as string, args, { cwd: root, env });
      const init = await run(["init", "-backend=false", "-input=false", "-no-color"]);
      expect(init.exitCode, init.stdout + init.stderr).toBe(0);
      const plan = async (values: Record<string, unknown>) => {
        await writeFile(
          join(root, "terraform.tfvars.json"),
          JSON.stringify({
            name: "shop",
            app: "shop",
            location: "de-fra1",
            server_type: "PREMIUM-2xCPU-4GB",
            image: "Ubuntu 24.04",
            ssh_public_key: DEPLOY_KEY,
            ...values,
          }),
        );
        const result = await run(["plan", "-input=false", "-no-color", "-lock=false"]);
        return {
          exitCode: result.exitCode,
          said: `${result.stdout} ${result.stderr}`.replace(/[│╷╵]/g, " ").replace(/\s+/g, " "),
        };
      };
      const SSH = "Each network in ssh_allowed_cidrs must be an address range such as";
      const WEB = "Each network in http_allowed_cidrs must be an address range such as";
      const PORT = "The WireGuard port must be a whole number from 1 to 65535";
      const cases: [Record<string, unknown>, string | undefined][] = [
        [{}, undefined],
        [{ name: "a" }, undefined],
        [{ name: "shop-db" }, undefined],
        [{ name: "1shop" }, undefined],
        [{ name: `s${"a".repeat(62)}` }, undefined],
        [{ name: "123" }, NAME_RULE],
        [{ name: "shop-" }, NAME_RULE],
        [{ name: "-shop" }, NAME_RULE],
        [{ name: "shop.example" }, NAME_RULE],
        [{ name: `s${"a".repeat(63)}` }, NAME_RULE],
        [{ ssh_allowed_cidrs: [], wireguard_port: 51820 }, undefined],
        [{ ssh_allowed_cidrs: ["203.0.113.7/32", "2001:db8::/48"], wireguard_port: 1 }, undefined],
        [{ http_allowed_cidrs: ["173.245.48.0/20"], wireguard_port: 65535 }, undefined],
        [{ ssh_allowed_cidrs: ["203.0.113.7/32;"] }, SSH],
        [{ ssh_allowed_cidrs: ["0.0.0.0/0", "accept"] }, SSH],
        [{ http_allowed_cidrs: ["173.245.48.0/20", "203.0.113.7"] }, WEB],
        [{ wireguard_port: 0 }, PORT],
        [{ wireguard_port: 65536 }, PORT],
        [{ wireguard_port: 51820.5 }, PORT],
      ];
      for (const [values, error] of cases) {
        const result = await plan(values);
        const name = JSON.stringify(values);
        if (error === undefined) {
          expect(result.exitCode, `${name}: ${result.said}`).toBe(0);
        } else {
          expect(result.exitCode, name).not.toBe(0);
          expect(result.said, name).toContain(error);
        }
      }
    },
    120_000,
  );
});
