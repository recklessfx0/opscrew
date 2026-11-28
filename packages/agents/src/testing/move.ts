import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { duplexPair, Readable } from "node:stream";
import {
  type FakeContainer,
  FakeDocker,
  type FakeFile,
  type FakeRun,
  fakeDialStdio,
} from "@opscrew/connector-docker/testing";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  type PinnedRequest,
  type PinnedStream,
  portainerClient,
} from "@opscrew/connector-portainer";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  AppServer,
  Clock,
  CommandResult,
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
  ResourceMove,
  ServerSnapshotApi,
  StreamRunner,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  CostLedger,
  MemoryApprovalStore,
  MemoryAuditLog,
  ProjectStateStore,
  Redactor,
  resolveProjectPaths,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import {
  type CloudProvider,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import type { PortainerServices } from "../provision/types";
import { isMaintenanceWindowRequest } from "../retarget/texts";
import type { RetargetGitHubApi, RetargetServices } from "../retarget/types";
import { ensureDeployKey, ensureStatePassphrase, isNewServerRepairRequest } from "../shared";
import { doEuCatalog, euCatalog, makeRequirements, writeArchitecture } from "./catalog";
import {
  createProject,
  FakeGitHub,
  fakeCloudflare,
  HOST_KEY,
  opscrewRecord,
  projectRunner,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "./deploy";
import { MemoryReporter, ScriptedRunner } from "./deps";
import { FakeFirewalls, fakeWantedFirewall } from "./firewalls";
import { firstAppLook } from "./other-apps";
import { type FakePortainer, fakeCertificate, fakePortainer } from "./portainer";
import { noProviderSchemas, plainStateResources } from "./state";

export { HOST_KEY, SERVER_IPV4 as OLD_IPV4, SERVER_IPV6 as OLD_IPV6 };

export const DOMAIN = "shop.example.com";
export const APP = "shop";
/** The Stripe key the user supplies through OPSCREW_APP_ENV_FILE (synthetic). */
export const STRIPE = fakeSecret("stripe-live-key");
export const TOKENS = {
  hetzner: fakeSecret("hcloud-token"),
  digitalocean: fakeSecret("digitalocean-token"),
  cloudflare: fakeSecret("cloudflare-token"),
};

/** What the fake engine creates for a new server, per provider. */
export const NEW_SERVERS: Record<CloudProvider, { id: string; ipv4: string; ipv6: string }> = {
  hetzner: { id: "4712", ipv4: "198.51.100.20", ipv6: "2001:db8:20::1" },
  digitalocean: { id: "3164445", ipv4: "198.51.100.30", ipv6: "2001:db8:30::1" },
  contabo: { id: "202611002", ipv4: "198.51.100.40", ipv6: "2001:db8:40::1" },
  ovhcloud: {
    id: "11111111-2222-4333-8444-666666666666",
    ipv4: "198.51.100.50",
    ipv6: "2001:db8:50::1",
  },
  kamatera: { id: "shop", ipv4: "198.51.100.60", ipv6: "2001:db8:60::1" },
  ionos: {
    id: "11111111-2222-4333-8444-999999999999/11111111-2222-4333-8444-aaaaaaaaaaaa",
    ipv4: "198.51.100.70",
    ipv6: "2001:db8:70::1",
  },
};
export const OLD_IDS: Record<CloudProvider, string> = {
  hetzner: "4711",
  digitalocean: "3164444",
  contabo: "202611001",
  ovhcloud: "11111111-2222-4333-8444-555555555555",
  kamatera: "shop",
  ionos: "11111111-2222-4333-8444-777777777777/11111111-2222-4333-8444-888888888888",
};

/** Everything the fakes saw, in order: the trail SC-502 is checked on. */
export type MoveEvent =
  | {
      type: "approval";
      kind: ApprovalRequest["kind"];
      title: string;
      planHash?: string;
      allowDestroy?: boolean;
      confirmation?: string;
      approved: boolean;
    }
  | { type: "confirm"; name: string; resources: number }
  | { type: "init"; modules: string }
  | { type: "plan"; hash: string; vars: string }
  | {
      type: "apply";
      hash: string;
      deletes: string[];
      creates: string[];
      updates: string[];
      moves: number;
    }
  | { type: "remote"; host: string; op: string }
  | { type: "scp"; from: string; to: string }
  | { type: "secret"; name: string }
  /** A run of the deploy workflow: a build of `ref`, or the deploy of an image's `digest`. */
  | { type: "dispatch"; ref: string; digest?: string }
  | { type: "snapshot"; serverId: string }
  | { type: "fetch"; url: string }
  | { type: "resolve"; host: string }
  /** A call of a provider connector's firewalls (`sync <name>`, `remove <name>`). */
  | { type: "firewall"; op: string }
  /** A server cancelled through its provider's connector (ADR 0029, D10). */
  | { type: "cancel"; serverId: string }
  /** Addresses taken out of the state. */
  | { type: "state-rm"; addresses: string[] };

type ModuleName = "server" | "server_previous";

interface FakeServer {
  id: string;
  provider: CloudProvider;
  ipv4: string;
  ipv6: string;
  protected: boolean;
}

const MODULE_PROVIDER: Record<string, CloudProvider> = {
  "hetzner-vps": "hetzner",
  "digitalocean-droplet": "digitalocean",
  "contabo-vps": "contabo",
  "ovhcloud-instance": "ovhcloud",
  "kamatera-instance": "kamatera",
  "ionos-instance": "ionos",
};

const RESOURCES: Record<CloudProvider, readonly (readonly [string, string])[]> = {
  hetzner: [
    ["hcloud_ssh_key", "deploy"],
    ["hcloud_firewall", "this"],
    ["hcloud_server", "this"],
  ],
  digitalocean: [
    ["digitalocean_tag", "app"],
    ["digitalocean_ssh_key", "deploy"],
    ["digitalocean_firewall", "this"],
    ["digitalocean_droplet", "this"],
  ],
  contabo: [
    ["contabo_secret", "deploy"],
    ["contabo_tag", "app"],
    ["contabo_instance", "this"],
    ["contabo_tag_assignment", "app"],
    // The firewall Contabo's connector applies after the apply (ADR 0029, D8).
    ["terraform_data", "firewall"],
  ],
  ovhcloud: [
    ["ovh_cloud_ssh_key", "deploy"],
    ["ovh_cloud_security_group", "this"],
    ["ovh_cloud_instance", "this"],
  ],
  // No cloud firewall and no SSH key resource: the server takes the key's text.
  kamatera: [["kamatera_server", "this"]],
  // The server's own data centre, its LAN, its reserved address and its NIC firewall's rules.
  ionos: [
    ["ionoscloud_datacenter", "this"],
    ["ionoscloud_lan", "this"],
    ["ionoscloud_ipblock", "this"],
    ["ionoscloud_server", "this"],
    ["ionoscloud_firewall", "this"],
  ],
};
const SERVER_TYPE: Record<CloudProvider, string> = {
  hetzner: "hcloud_server",
  digitalocean: "digitalocean_droplet",
  contabo: "contabo_instance",
  ovhcloud: "ovh_cloud_instance",
  kamatera: "kamatera_server",
  ionos: "ionoscloud_server",
};
const REGISTRY: Record<CloudProvider, string> = {
  hetzner: "registry.opentofu.org/hetznercloud/hcloud",
  digitalocean: "registry.opentofu.org/digitalocean/digitalocean",
  contabo: "registry.opentofu.org/contabo/contabo",
  ovhcloud: "registry.opentofu.org/ovh/ovh",
  kamatera: "registry.opentofu.org/kamatera/kamatera",
  ionos: "registry.opentofu.org/ionos-cloud/ionoscloud",
};

interface FakeConfig {
  modules: Map<ModuleName, CloudProvider>;
  moved?: [ModuleName, ModuleName];
  dns?: ModuleName;
  /** The DNS module points at an address side's variable (`server` or `previous_server`). */
  dnsVariable?: string;
  live?: ModuleName;
  variables: Set<string>;
}

/** Reads the rendered root module the way an engine would see it (modules, moved, DNS, outputs). */
async function readConfig(dir: string): Promise<FakeConfig> {
  const main = await readFile(join(dir, "main.tf"), "utf8");
  const outputs = await readFile(join(dir, "outputs.tf"), "utf8");
  const variables = await readFile(join(dir, "variables.tf"), "utf8");
  const modules = new Map<ModuleName, CloudProvider>();
  for (const m of main.matchAll(
    /module "(server|server_previous)" \{\s*source\s*=\s*"\.\.\/modules\/([a-z-]+)"/g,
  )) {
    const provider = MODULE_PROVIDER[m[2] as string];
    if (provider === undefined) throw new Error(`unknown module source ${m[2]}`);
    modules.set(m[1] as ModuleName, provider);
  }
  const moved = /moved \{\s*from\s*=\s*module\.(\w+)\s*to\s*=\s*module\.(\w+)/.exec(main);
  const dns = /module "dns" \{[\s\S]*?ipv4\s*=\s*module\.(\w+)\.ipv4_address/.exec(main);
  const dnsVariable = /module "dns" \{[\s\S]*?ipv4\s*=\s*var\.((?:previous_)?server)_ipv4/.exec(
    main,
  );
  const live = /output "server_ipv4" \{\s*value\s*=\s*module\.(\w+)\./.exec(outputs);
  return {
    modules,
    ...(moved ? { moved: [moved[1] as ModuleName, moved[2] as ModuleName] } : {}),
    ...(dns ? { dns: dns[1] as ModuleName } : {}),
    ...(dnsVariable?.[1] !== undefined ? { dnsVariable: dnsVariable[1] } : {}),
    ...(live ? { live: live[1] as ModuleName } : {}),
    variables: new Set([...variables.matchAll(/variable "(\w+)"/g)].map((v) => v[1] as string)),
  };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** What applying a plan does to the fake state. */
interface Effect {
  serial: number;
  moves: [ModuleName, ModuleName][];
  creates: [ModuleName, CloudProvider][];
  destroys: ModuleName[];
  unprotects: ModuleName[];
  dnsTo?: string;
  changes: ResourceChange[];
  moved: ResourceMove[];
  planJson: unknown;
}

function change(
  module: ModuleName,
  provider: CloudProvider,
  [type, name]: readonly [string, string],
  action: ResourceChange["action"],
): ResourceChange {
  return {
    address: `module.${module}.${type}.${name}`,
    type,
    name,
    provider: REGISTRY[provider],
    action,
  };
}

/**
 * IaC engine fake that keeps a state of server modules and reads the rendered root module: a
 * `moved` block renames a module, a module missing from the state is created, a module missing
 * from the configuration is deleted, `*delete_protection=false` turns a Hetzner server's
 * protection off, and the DNS module follows the configured server. Applies enforce the hash,
 * `allowDestroy`, delete protection and stale plans like the real engines; planning a module
 * that was not initialised, or a variable the root does not declare, fails as they would.
 */
export class FakeMoveEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly state: {
    servers: Partial<Record<ModuleName, FakeServer>>;
    dns?: string;
    serial: number;
    /** Root outputs as the last successful apply recorded them (what `output` reads, like tofu). */
    outputs: Record<string, unknown>;
  };
  /** Returns a failure log for an apply, e.g. to make the DNS switch fail. */
  failApply: ((effect: Effect) => string | undefined) | undefined;
  /** Throws from `plan` (e.g. a simulated interruption). */
  failPlan: ((effect: Effect) => Error | undefined) | undefined;
  /** Replaces the plan JSON (e.g. to fail a security policy). */
  planJsonFor: ((effect: Effect) => unknown) | undefined;
  /** Edits a computed plan (e.g. a delete that appears after the preview). */
  tamper: ((effect: Effect) => void) | undefined;
  readonly plans: { hash: string; effect: Effect }[] = [];
  /** Hashes of the plans applied, in order. */
  readonly applied: string[] = [];
  #installed = new Set<string>();
  #effects = new Map<string, Effect>();
  /** Addresses `stateRemove` took out of the state; they go with their module. */
  readonly #forgotten = new Set<string>();
  #counter = 0;

  constructor(
    readonly events: MoveEvent[],
    options: { from: CloudProvider; dns: boolean },
  ) {
    const old: FakeServer = {
      id: OLD_IDS[options.from],
      provider: options.from,
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
      protected: options.from === "hetzner",
    };
    this.state = {
      servers: { server: old },
      ...(options.dns ? { dns: old.id } : {}),
      serial: 0,
      // What `opscrew provision` applied: the root module without a move layout.
      outputs: outputsOf(
        {
          modules: new Map<ModuleName, CloudProvider>([["server", options.from]]),
          live: "server",
          variables: new Set(),
        },
        { server: old },
        options.dns,
      ),
    };
  }

  /**
   * Where DNS points: the server whose id it holds, or the address of a side that is the user's
   * own server or Portainer.
   */
  dnsServer(): Pick<FakeServer, "ipv4"> | undefined {
    const dns = this.state.dns;
    const server = Object.values(this.state.servers).find((s) => s?.id === dns);
    return server ?? (dns?.includes(".") ? { ipv4: dns } : undefined);
  }

  async init(dir: string, _options?: IacInitOptions): Promise<void> {
    const config = await readConfig(dir);
    this.#installed = new Set([...config.modules].map(([m, p]) => `${m}:${p}`));
    this.events.push({ type: "init", modules: [...this.#installed].sort().join(",") });
  }

  async validate() {
    return { valid: true, diagnostics: [] };
  }

  #compute(
    config: FakeConfig,
    vars: Record<string, string>,
    env: Record<string, string | undefined> = {},
  ): Effect {
    for (const [m, p] of config.modules) {
      if (!this.#installed.has(`${m}:${p}`)) {
        throw new Error(`Module not installed: module.${m} (run init)`);
      }
    }
    for (const name of Object.keys(vars)) {
      if (!config.variables.has(name)) throw new Error(`Value for undeclared variable ${name}`);
    }
    const servers: Partial<Record<ModuleName, FakeServer>> = { ...this.state.servers };
    const effect: Effect = {
      serial: this.state.serial,
      moves: [],
      creates: [],
      destroys: [],
      unprotects: [],
      changes: [],
      moved: [],
      planJson: undefined,
    };
    const details: Record<string, unknown>[] = [];
    if (config.moved) {
      const [from, to] = config.moved;
      const server = servers[from];
      if (server && !servers[to] && config.modules.has(to)) {
        servers[to] = server;
        delete servers[from];
        effect.moves.push([from, to]);
        for (const [type, name] of RESOURCES[server.provider]) {
          effect.moved.push({
            from: `module.${from}.${type}.${name}`,
            to: `module.${to}.${type}.${name}`,
            type,
          });
        }
      }
    }
    for (const [m, provider] of config.modules) {
      const server = servers[m];
      if (!server) {
        effect.creates.push([m, provider]);
        for (const resource of RESOURCES[provider]) {
          const c = change(m, provider, resource, "create");
          effect.changes.push(c);
          details.push({
            address: c.address,
            type: c.type,
            change: { actions: ["create"], before: null, after: {}, after_unknown: { id: true } },
          });
        }
        continue;
      }
      const variable = m === "server" ? "delete_protection" : "previous_delete_protection";
      if (provider === "hetzner" && vars[variable] === "false" && server.protected) {
        effect.unprotects.push(m);
        const c = change(m, provider, ["hcloud_server", "this"], "update");
        effect.changes.push(c);
        const before = {
          id: server.id,
          name: APP,
          backups: true,
          delete_protection: true,
          rebuild_protection: true,
        };
        details.push({
          address: c.address,
          type: c.type,
          change: {
            actions: ["update"],
            before,
            after: { ...before, delete_protection: false, rebuild_protection: false },
            after_unknown: {},
          },
        });
      }
    }
    for (const [m, server] of Object.entries(servers) as [ModuleName, FakeServer][]) {
      if (config.modules.has(m)) continue;
      effect.destroys.push(m);
      for (const resource of RESOURCES[server.provider]) {
        const c = change(m, server.provider, resource, "delete");
        if (this.#forgotten.has(c.address)) continue;
        effect.changes.push(c);
        const id =
          resource[0] === SERVER_TYPE[server.provider] ? server.id : `${resource[1]}-${server.id}`;
        details.push({
          address: c.address,
          type: c.type,
          change: { actions: ["delete"], before: { id, name: APP }, after: null },
        });
      }
    }
    if (
      (config.dns !== undefined || config.dnsVariable !== undefined) &&
      this.state.dns !== undefined
    ) {
      // A side that is an address: what the engine is given as its TF_VAR.
      const target =
        config.dns !== undefined
          ? servers[config.dns]?.id
          : env[`TF_VAR_${config.dnsVariable}_ipv4`];
      if (target !== undefined && target !== this.state.dns) {
        effect.dnsTo = target;
        for (const name of ["a", "aaaa"]) {
          const c: ResourceChange = {
            address: `module.dns.cloudflare_dns_record.${name}`,
            type: "cloudflare_dns_record",
            name,
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            action: "update",
          };
          effect.changes.push(c);
          details.push({
            address: c.address,
            type: c.type,
            change: { actions: ["update"], before: { name: DOMAIN }, after: { name: DOMAIN } },
          });
        }
      }
    }
    // The firewalls the state wants before the plan, as `output_changes` gives them.
    const firewalls = this.state.outputs.wanted_firewalls;
    effect.planJson = {
      format_version: "1.2",
      resource_changes: details,
      ...(firewalls !== undefined
        ? { output_changes: { wanted_firewalls: { actions: ["update"], before: firewalls } } }
        : {}),
    };
    return effect;
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    if (options.destroy) throw new Error("a move never plans a whole-root destroy");
    const config = await readConfig(dir);
    const effect = this.#compute(config, options.vars ?? {}, options.env);
    this.tamper?.(effect);
    const failure = this.failPlan?.(effect);
    if (failure) throw failure;
    if (this.planJsonFor) effect.planJson = this.planJsonFor(effect);
    const content = `fake plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const planHash = sha256(content);
    this.#effects.set(planHash, effect);
    this.plans.push({ hash: planHash, effect });
    this.events.push({ type: "plan", hash: planHash, vars: JSON.stringify(options.vars ?? {}) });
    const count = (action: string) => effect.changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash,
      createdAt: "2026-10-13T12:00:00.000Z",
      changes: effect.changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: effect.destroys.length > 0,
      planJson: effect.planJson,
      ...(effect.moved.length > 0 ? { moves: effect.moved } : {}),
    };
  }

  async apply(dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    const hash = sha256(await readFile(planFile));
    if (hash !== approval.approvedPlanHash) throw new Error("plan hash mismatch");
    const effect = this.#effects.get(hash);
    if (!effect) throw new Error("unknown plan");
    if (effect.destroys.length > 0 && approval.allowDestroy !== true) {
      throw new Error("the plan deletes resources but the approval does not allow it");
    }
    this.applied.push(hash);
    this.events.push({
      type: "apply",
      hash,
      deletes: effect.changes.filter((c) => c.action === "delete").map((c) => c.address),
      creates: effect.changes.filter((c) => c.action === "create").map((c) => c.address),
      updates: effect.changes.filter((c) => c.action === "update").map((c) => c.address),
      moves: effect.moved.length,
    });
    if (effect.serial !== this.state.serial) {
      return { ok: false, outputs: {}, log: "Error: Saved plan is stale" };
    }
    const failure = this.failApply?.(effect);
    if (failure) return { ok: false, outputs: {}, log: failure };
    for (const m of effect.destroys) {
      if (this.state.servers[m]?.protected) {
        return { ok: false, outputs: {}, log: `Error: server deletion is protected (module.${m})` };
      }
    }
    for (const [from, to] of effect.moves) {
      this.state.servers[to] = this.state.servers[from];
      delete this.state.servers[from];
    }
    for (const m of effect.unprotects) {
      const server = this.state.servers[m];
      if (server) server.protected = false;
    }
    for (const m of effect.destroys) {
      delete this.state.servers[m];
      for (const address of this.#forgotten) {
        if (address.startsWith(`module.${m}.`)) this.#forgotten.delete(address);
      }
    }
    for (const [m, provider] of effect.creates) {
      const created = NEW_SERVERS[provider];
      this.state.servers[m] = { ...created, provider, protected: provider === "hetzner" };
    }
    if (effect.dnsTo !== undefined) this.state.dns = effect.dnsTo;
    this.state.serial++;
    const config = await readConfig(dir);
    this.state.outputs = outputsOf(config, this.state.servers, config.dns !== undefined);
    return { ok: true, outputs: structuredClone(this.state.outputs), log: "Apply complete!" };
  }

  /** The outputs the last successful apply recorded (a plan without changes does not update them). */
  async output(_dir: string): Promise<Record<string, unknown>> {
    return structuredClone(this.state.outputs);
  }

  /** Takes `addresses` out of the state, which gets a new serial: a plan saved before is stale. */
  async stateRemove(_dir: string, addresses: readonly string[]): Promise<void> {
    for (const address of addresses) this.#forgotten.add(address);
    this.state.serial++;
    this.events.push({ type: "state-rm", addresses: [...addresses] });
  }

  readonly providerSchemas = noProviderSchemas;
  readonly stateResources = plainStateResources;
  async untaint(): Promise<void> {}
  async importResource(): Promise<void> {}
}

/**
 * The root outputs of the rendered configuration over the servers in the state: `server_*` and
 * `url` follow the live module, `servers` lists every server module's server by provider, and
 * `wanted_firewalls` the firewall of each whose provider's connector applies it.
 */
function outputsOf(
  config: FakeConfig,
  servers: Partial<Record<ModuleName, FakeServer>>,
  dns: boolean,
): Record<string, unknown> {
  const live = config.live ? servers[config.live] : undefined;
  const byProvider: Record<string, { ipv4: string; ipv6: string; id: string }> = {};
  const firewalls: Record<string, unknown> = {};
  for (const [m, provider] of config.modules) {
    const server = servers[m];
    if (server) byProvider[provider] = { ipv4: server.ipv4, ipv6: server.ipv6, id: server.id };
    if (server && cloudProvider(provider).terraform.connectorFirewall) {
      firewalls[m] = fakeWantedFirewall(provider, server.id);
    }
  }
  return {
    ...(live
      ? {
          server_ipv4: live.ipv4,
          server_ipv6: live.ipv6,
          server_id: live.id,
          server_name: APP,
          url: dns ? `https://${DOMAIN}` : `http://${live.ipv4}`,
        }
      : {}),
    servers: byProvider,
    ...(Object.keys(firewalls).length > 0 ? { wanted_firewalls: firewalls } : {}),
  };
}

export interface FakeHost {
  app: boolean;
  /** The edge's proxy (Caddy, nginx or OpenLiteSpeed) runs. */
  caddy: boolean;
  /** What the database holds (a marker, never real data). */
  db: string;
  dump?: string;
  /**
   * A move's marker in the app's folder (FR-3027): `waiting`, the deploys bring up only the
   * services; `copied`, they deploy the app and skip the check from outside.
   */
  marker?: "waiting" | "copied";
  /** The image the last deploy wrote to `.env`. */
  image?: string;
  /** What the last deploy's start script recorded (`.start.outcome`). */
  outcome?: string;
}

/** The image the deploy workflow's build of the branch pushes. */
export const BUILT_IMAGE = `ghcr.io/acme/shop@sha256:${"e".repeat(64)}`;

/** The plain operation a server command performs, for the event trail. */
function opOf(command: string): string {
  if (command.includes("opscrew-ready")) return "ready?";
  if (command.endsWith("docker compose stop app")) return "stop app";
  if (command.endsWith("docker compose up -d app")) return "start app";
  // The edge's proxy: Caddy, nginx or OpenLiteSpeed.
  const edge = /docker compose (stop|up -d) (caddy|nginx|openlitespeed)$/.exec(command);
  if (edge) return `${edge[1] === "stop" ? "stop" : "start"} ${edge[2]}`;
  if (/docker compose exec -T (caddy|nginx|openlitespeed) /.test(command)) return "reload edge";
  // The app's stateful services, which a move's window stops (with time to stop cleanly) and starts.
  // The services start waiting until they run; the workers and cron start with the app.
  const services = /docker compose (stop -t \d+|up -d(?: --wait)?) ([a-z0-9 -]+)$/.exec(command);
  if (services) return `${services[1]?.startsWith("up") ? "start" : "stop"} ${services[2]}`;
  // The app's web container by its name on its isolated `<app>_internal` network.
  if (
    /--entrypoint wget (caddy|nginx|openlitespeed) /.test(command) ||
    new RegExp(`--network ${APP}_internal --entrypoint wget `).test(command)
  ) {
    const byName = `--filter label=com.docker.compose.project=${APP} --filter label=com.docker.compose.service=app `;
    return command.includes(byName) ? "health" : "health by the app alias";
  }
  if (command.includes("pg_database_size")) return "db size";
  if (command.includes("pg_dump")) return "dump";
  if (command.includes("pg_restore --list")) return "verify dump";
  // The load of a database with two logins (047): the app's objects restored as app_owner.
  if (/pg_restore -h \S+ -U app_owner /.test(command)) return "load";
  if (command.includes("pg_restore")) return "restore";
  if (command.includes("DROP DATABASE")) return "empty db";
  if (command.startsWith(`rm -f /srv/apps/${APP}/opscrew-move.dump`)) return "rm dump";
  // The release command in the window, in a one-off run of the deployed compose file's service.
  if (command.endsWith("config --services")) return "services?";
  if (command.endsWith("docker compose run --rm --no-deps -T release")) return "release";
  // A move's marker (FR-3027), what the last deploy left, and the services it started.
  if (command.endsWith(`: > /srv/apps/${APP}/.move.waiting`)) return "mark waiting";
  if (command.endsWith(`copied > /srv/apps/${APP}/.move.waiting`)) return "mark copied";
  if (command === `rm -f /srv/apps/${APP}/.move.waiting`) return "remove marker";
  if (command.includes("printf 'image=%s")) return "deployed?";
  if (command.endsWith("docker compose ps --status running --services")) return "services up?";
  return command;
}

/** Where the app's services keep their data on a server OpsCrew deploys to over SSH. */
const DATA_ROOT = `/srv/data/${APP}`;

/**
 * What the move asked of a carrier's path list (`/opscrew-paths`, put into it before it starts):
 * the paths a read stages (`readPaths`, with the root and every folder above them) or an update
 * removes first (`updateVolume`), on the server `host`.
 */
export interface DeltaCall {
  host: string;
  op: "readPaths" | "updateVolume";
  paths: string[];
}

/**
 * The two servers' shells (Compose services, the database marker) and their Docker APIs, which a
 * move reaches over `ssh … docker system dial-stdio` ({@link FakeHosts.streams}): the app's
 * containers, its services' data folders, the carrier and the one-off postgres containers that
 * dump the database into the move's dump volume and restore it.
 */
export class FakeHosts {
  readonly hosts = new Map<string, FakeHost>();
  /** Each server's Docker, by address. */
  readonly dockers = new Map<string, FakeDocker>();
  /** Makes an operation fail (a result) or the connection break (an error). */
  fail: ((host: string, op: string) => CommandResult | Error | undefined) | undefined;
  /** The stateful services on the app's server, each with a data folder (`db`: Postgres). */
  services: string[] = ["db"];
  /** Services Docker kills when they are stopped (exit 137), by `<host> <service>`. */
  readonly killed = new Set<string>();
  dbSize = 52_428_800;
  readonly #dialers = new Map<string, ReturnType<typeof fakeDialStdio>>();

  readonly #broken = new Map<string, string>();

  /**
   * From now on ssh cannot reach `host`'s Docker: each connection closes at once, ssh saying
   * `stderr` (which may name the server), as a lost link does; open connections end.
   */
  breakDocker(host: string, stderr: string): void {
    this.#broken.set(host, stderr);
    this.#dialers.get(host)?.close();
    this.#dialers.delete(host);
  }

  /** `ssh … deploy@<host> … docker system dial-stdio`: a byte pipe to that server's Docker. */
  readonly streams: StreamRunner = {
    open: (command, args, options) => {
      const login = args.find((arg) => arg.startsWith("deploy@")) ?? "";
      const host = login.slice("deploy@".length);
      const broken = this.#broken.get(host);
      if (broken !== undefined) {
        const [local, remote] = duplexPair();
        const kill = () => {
          local.destroy();
          remote.destroy();
        };
        setImmediate(kill);
        return { stream: local, exit: Promise.resolve({ exitCode: 255, stderr: broken }), kill };
      }
      let dialer = this.#dialers.get(host);
      if (dialer === undefined) {
        dialer = fakeDialStdio(this.docker(host));
        this.#dialers.set(host, dialer);
      }
      return dialer.open(command, args, options);
    },
  };

  /** The Docker API of the server at `ip`, with the carrier's and postgres's images. */
  docker(ip: string): FakeDocker {
    let docker = this.dockers.get(ip);
    if (docker === undefined) {
      docker = new FakeDocker();
      docker.images.add(IMAGES.busybox.ref);
      docker.images.add(IMAGES.postgres.ref);
      docker.onStart = (container) => this.#oneOff(ip, container);
      docker.addFolder("/srv/data");
      docker.addFolder(DATA_ROOT);
      this.dockers.set(ip, docker);
    }
    return docker;
  }

  /**
   * The app's containers on `ip` as its deploy leaves them: `app`, and each stateful service with
   * its data (`data` its files) at the same path in the container: on a server a folder bound
   * from `/srv/data/<app>/<service>`, in the user's Portainer (`stack`) the stack's named volume
   * `opscrew-<app>_<service>_data`.
   */
  seed(ip: string, data: Record<string, FakeFile> = {}, stack = false): void {
    const docker = this.docker(ip);
    const project = stack ? `opscrew-${APP}` : APP;
    const container = (service: string, source?: string) => {
      const id = `${ip}-${service}`.replace(/[^a-z0-9]/gi, "0").padEnd(64, "0");
      if (docker.containers.has(id)) return;
      if (source !== undefined && !stack && !docker.folders.has(source)) {
        docker.addFolder(source, data);
      }
      if (source !== undefined && stack && !docker.volumes.has(source)) {
        docker.addVolume(source, data, { [COMPOSE_PROJECT_LABEL]: project });
      }
      docker.containers.set(id, {
        id,
        name: `${project}-${service}-1`,
        image:
          service === "app" ? `ghcr.io/acme/shop@sha256:${"c".repeat(64)}` : IMAGES.postgres.ref,
        cmd: [],
        env: [],
        labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_SERVICE_LABEL]: service },
        binds: [],
        mounts:
          source === undefined
            ? []
            : [
                {
                  type: stack ? "volume" : "bind",
                  source,
                  target: "/var/lib/postgresql/data",
                },
              ],
        state: "running",
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    };
    container("app");
    for (const service of this.services) {
      container(service, stack ? `${project}_${service}_data` : `${DATA_ROOT}/${service}`);
    }
  }

  /** Sets the state of the containers of `services` on `ip` (Compose's stop or start). */
  #compose(ip: string, verb: "stop" | "start", services: readonly string[]): void {
    for (const container of this.docker(ip).containers.values()) {
      const service = container.labels[COMPOSE_SERVICE_LABEL] ?? "";
      if (container.labels[COMPOSE_PROJECT_LABEL] !== APP || !services.includes(service)) continue;
      container.state = verb === "stop" ? "exited" : "running";
      container.exitCode = verb === "stop" && this.killed.has(`${ip} ${service}`) ? 137 : 0;
    }
  }

  /** The dump in the dump volume a one-off container mounts at `/dump`. */
  #dumpFile(ip: string, container: FakeContainer): FakeFile | undefined {
    const mount = container.mounts.find((m) => m.target === "/dump");
    return mount === undefined
      ? undefined
      : this.docker(ip).volumes.get(mount.source)?.files.get("app.dump");
  }

  /**
   * A one-off postgres container's command, as `pg_dump`, `pg_restore --list`, `psql` and
   * `pg_restore` would run it against the server's database marker; the carrier's built-ins
   * answer every other command.
   */
  #oneOff(ip: string, container: FakeContainer): FakeRun | undefined {
    const listed = container.files?.get("opscrew-paths")?.data?.toString("utf8");
    if (listed !== undefined) {
      // A stage mounts its source at /source; an update removes from what it mounts at /data.
      const stages = container.mounts.some((mount) => mount.target === "/source");
      const paths = listed.split(/\n/).filter((line) => line !== "");
      this.deltas.push({ host: ip, op: stages ? "readPaths" : "updateVolume", paths });
    }
    const mysql = this.#mysqlOneOff(ip, container);
    if (mysql !== undefined) return mysql;
    const [program, ...args] = container.cmd;
    const script = program === "sh" ? (args[1] ?? "") : "";
    const op = script.includes("pg_dump")
      ? "dump"
      : /pg_restore -h \S+ -U app_owner /.test(script)
        ? "load"
        : script.includes("pg_restore --list")
          ? "verify dump"
          : program === "psql"
            ? "empty db"
            : program === "pg_restore"
              ? "restore"
              : undefined;
    if (op === undefined) return undefined;
    this.events.push({ type: "remote", host: ip, op });
    const failure = this.fail?.(ip, op);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const h = this.host(ip);
    const file = this.#dumpFile(ip, container);
    const failed = (stderr: string): FakeRun => ({ exitCode: 1, stderr });
    switch (op) {
      case "dump": {
        const mount = container.mounts.find((m) => m.target === "/dump");
        const volume = this.docker(ip).volumes.get(mount?.source ?? "");
        volume?.files.set("app.dump", {
          type: "file",
          mode: 0o600,
          uid: 0,
          gid: 0,
          data: Buffer.from(h.db),
        });
        return { exitCode: 0 };
      }
      case "verify dump":
        if (file?.data === undefined) return failed("pg_restore: error: could not open input file");
        return {
          exitCode: 0,
          stdout: `${createHash("sha256").update(file.data).digest("hex")}  /dump/app.dump\n`,
        };
      case "empty db":
        h.db = "empty";
        return { exitCode: 0 };
      case "load":
        if (file?.data === undefined) return failed("pg_restore: error: could not open input file");
        // `DROP DATABASE … WITH (FORCE)` first: what the database held goes.
        h.db = file.data.toString("utf8");
        return { exitCode: 0 };
      default:
        if (h.app)
          return failed('pg_restore: error: database "app" is being accessed by other users');
        if (file?.data === undefined) return failed("pg_restore: error: could not open input file");
        // Without `--clean`, a restore onto a database that holds tables fails.
        if (h.db !== "empty") {
          return failed(
            'pg_restore: error: could not execute query: ERROR:  relation "orders" already exists',
          );
        }
        h.db = file.data.toString("utf8");
        return { exitCode: 0 };
    }
  }

  /** A MySQL or MariaDB service's data on `ip`: its folder on a server, its volume in Portainer. */
  #serviceData(ip: string, service: string) {
    const docker = this.docker(ip);
    return (
      docker.folders.get(`${DATA_ROOT}/${service}`) ??
      docker.volumes.get(`opscrew-${APP}_${service}_data`)
    );
  }

  /**
   * A one-off MySQL or MariaDB client's command (its service the script's `$1`): the dump writes
   * the service's files into the move volume as text ending in `-- Dump completed`, the check
   * gives its SHA-256, the ping answers, and the restore puts the dump's files into the service's
   * data, each rewritten as a restore does (`(restored)` added), the rest left as it was. Root's
   * login file must be there.
   */
  #mysqlOneOff(ip: string, container: FakeContainer): FakeRun | undefined {
    const [, , script = "", , service = ""] = container.cmd;
    if (container.image !== IMAGES.mysql.ref && container.image !== IMAGES.mariadb.ref) {
      return undefined;
    }
    const op = /mysqldump|mariadb-dump/.test(script)
      ? `dump ${service}`
      : script.includes("Dump completed")
        ? `verify ${service} dump`
        : /mysqladmin|mariadb-admin/.test(script)
          ? `${service} ready?`
          : `restore ${service}`;
    this.events.push({ type: "remote", host: ip, op });
    const failure = this.fail?.(ip, op);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    if (container.files?.get("tmp/opscrew.my.cnf") === undefined) {
      return { exitCode: 1, stderr: "Access denied for user 'root'" };
    }
    const mount = container.mounts.find((m) => m.target === "/dump");
    const volume = this.docker(ip).volumes.get(mount?.source ?? "");
    const data = this.#serviceData(ip, service);
    const dump = volume?.files.get("all.sql")?.data;
    if (op === `dump ${service}`) {
      const entries = [...(data?.files ?? [])].map(([path, file]) => [
        path,
        { ...file, data: file.data?.toString("base64") },
      ]);
      const text = `${JSON.stringify(entries)}\n-- Dump completed\n`;
      volume?.files.set("all.sql", {
        type: "file",
        mode: 0o600,
        uid: 0,
        gid: 0,
        data: Buffer.from(text),
      });
      return { exitCode: 0 };
    }
    if (op === `verify ${service} dump`) {
      if (dump === undefined || !dump.toString("utf8").trimEnd().endsWith("-- Dump completed")) {
        return { exitCode: 1 };
      }
      return {
        exitCode: 0,
        stdout: `${createHash("sha256").update(dump).digest("hex")}  /dump/all.sql\n`,
      };
    }
    if (op === `${service} ready?`) return { exitCode: 0 };
    if (dump === undefined || data === undefined) return { exitCode: 1 };
    const entries = JSON.parse(dump.toString("utf8").split("\n")[0] ?? "[]") as [
      string,
      FakeFile & { data?: string },
    ][];
    // As a dump's statements do, it replaces what it holds, and leaves the rest as it was.
    for (const [path, file] of entries) {
      const bytes = file.data === undefined ? undefined : Buffer.from(file.data, "base64");
      data.files.set(path, {
        ...file,
        ...(bytes === undefined
          ? {}
          : { data: Buffer.concat([bytes, Buffer.from(" (restored)")]) }),
      } as FakeFile);
    }
    return { exitCode: 0 };
  }
  /**
   * The deployed compose file has a `release` service (the plan has `app.releaseCommand`): each
   * full deploy migrates the database, an empty one to the schema of HEAD.
   */
  release = false;

  /** The release command fails on an empty database (the framework's `migrate` needs its tables). */
  releaseNeedsData = false;

  /**
   * Whether the release command finds the data it needs on `ip`: by default, the database marker
   * holds something.
   */
  hasData: (ip: string) => boolean = (ip) => this.host(ip).db !== "empty";

  /** What the move asked of the carriers' path lists, in order ({@link DeltaCall}). */
  readonly deltas: DeltaCall[] = [];

  constructor(readonly events: MoveEvent[]) {}

  host(ip: string): FakeHost {
    let host = this.hosts.get(ip);
    if (!host) {
      host = { app: false, caddy: false, db: "empty" };
      this.hosts.set(ip, host);
    }
    return host;
  }

  readonly remote = (ip: string): RemoteExec => ({
    host: ip,
    run: (command) => this.run(ip, command),
  });

  async run(ip: string, command: string): Promise<CommandResult> {
    const op = opOf(command);
    this.events.push({ type: "remote", host: ip, op });
    const failure = this.fail?.(ip, op);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const h = this.host(ip);
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    switch (op) {
      case "ready?":
        return ok("ready\n");
      case "stop app":
        h.app = false;
        return ok();
      case "start app":
        h.app = true;
        return ok();
      case "stop caddy":
      case "stop nginx":
      case "stop openlitespeed":
        h.caddy = false;
        return ok();
      case "start caddy":
      case "start nginx":
      case "start openlitespeed":
        h.caddy = true;
        return ok();
      case "health":
        return h.app ? ok() : { exitCode: 1, stdout: "", stderr: "wget: can't connect" };
      case "health by the app alias":
        return { exitCode: 1, stdout: "", stderr: "wget: bad address 'app'" };
      case "db size":
        return ok(`${this.dbSize}\n`);
      case "dump":
        h.dump = h.db;
        return ok();
      case "restore":
        if (h.app) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: 'pg_restore: error: database "app" is being accessed by other users',
          };
        }
        if (h.dump === undefined) return { exitCode: 1, stdout: "", stderr: "No such file" };
        // Without `--clean`, a restore onto a database that holds tables fails.
        if (h.db !== "empty") {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              'pg_restore: error: could not execute query: ERROR:  relation "orders" already exists',
          };
        }
        h.db = h.dump;
        return ok();
      case "load":
        if (h.dump === undefined) return { exitCode: 1, stdout: "", stderr: "No such file" };
        // `DROP DATABASE … WITH (FORCE)` first: what the database held goes.
        h.db = h.dump;
        return ok();
      case "verify dump":
        if (h.dump === undefined) return { exitCode: 1, stdout: "", stderr: "No such file" };
        return ok(
          `${createHash("sha256").update(h.dump).digest("hex")}  /srv/apps/${APP}/opscrew-move.dump\n`,
        );
      case "empty db":
        h.db = "empty";
        return ok();
      case "rm dump":
        h.dump = undefined;
        return ok();
      case "services?":
        return ok(this.release ? "app\nrelease\ndb\ncaddy\n" : "app\ndb\ncaddy\n");
      case "release":
        if (!this.release) return { exitCode: 1, stdout: "", stderr: "no such service: release" };
        if (this.releaseNeedsData && !this.hasData(ip)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "SQLSTATE[42S02]: Base table or view not found",
          };
        }
        h.db = `${h.db} (migrated)`;
        return ok();
      case "mark waiting":
        h.marker = "waiting";
        return ok();
      case "mark copied":
        h.marker = "copied";
        return ok();
      case "remove marker":
        h.marker = undefined;
        return ok();
      case "deployed?":
        return ok(
          `image=${h.image ?? ""}\nmarker=${h.marker === undefined ? "none" : h.marker === "copied" ? "copied" : ""}\n`,
        );
      case "services up?":
        return ok(
          [...this.docker(ip).containers.values()]
            .filter((c) => c.labels[COMPOSE_PROJECT_LABEL] === APP && c.state === "running")
            .map((c) => `${c.labels[COMPOSE_SERVICE_LABEL]}\n`)
            .join(""),
        );
      default: {
        const services = /^(stop|start) ([a-z0-9 -]+)$/.exec(op);
        if (services)
          this.#compose(ip, services[1] as "stop" | "start", services[2]?.split(" ") ?? []);
        return ok();
      }
    }
  }

  /** `scp -3 … deploy@A:/path deploy@B:/path`: copies the dump marker. */
  scp(args: readonly string[]): CommandResult {
    const at = (arg: string) => /^deploy@\[?([^\]]+?)\]?:/.exec(arg)?.[1] ?? "";
    const from = at(args[args.length - 2] ?? "");
    const to = at(args[args.length - 1] ?? "");
    this.events.push({ type: "scp", from, to });
    const failure = this.fail?.(from, "scp");
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const source = this.host(from);
    if (source.dump === undefined) return { exitCode: 1, stdout: "", stderr: "scp: No such file" };
    this.host(to).dump = source.dump;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  /**
   * What the deploy workflow's start step does on `ip` with `image`: the edge, then while a move's
   * marker holds the app only the services, with the app's container created but never started
   * (`held`, FR-3027); otherwise the release command, when there is one, migrates the database (an
   * empty one to the schema of HEAD, unless it needs data: then it fails and nothing starts), and
   * the app runs: `moved` when the marker says `copied`, which skips the check from outside.
   */
  deploy(ip: string, image = BUILT_IMAGE): FakeDeployOutcome {
    const h = this.host(ip);
    h.caddy = true;
    const app = (state: "created" | "running") => {
      for (const container of this.docker(ip).containers.values()) {
        if (container.labels[COMPOSE_SERVICE_LABEL] === "app") container.state = state;
      }
    };
    if (h.marker === "waiting") {
      this.seed(ip);
      if (!h.app) app("created");
      Object.assign(h, { image, outcome: `waiting ${image}` });
      return "held";
    }
    if (this.release) {
      if (this.releaseNeedsData && !this.hasData(ip)) {
        h.outcome = "started";
        return "failed";
      }
      h.db = h.db === "empty" ? "schema of HEAD" : `${h.db} (migrated)`;
    }
    Object.assign(h, { app: true, image, outcome: "finished" });
    this.seed(ip);
    app("running");
    return h.marker === "copied" ? "moved" : "deployed";
  }
}

/** What the start step of {@link FakeHosts.deploy} ended with. */
export type FakeDeployOutcome = "held" | "moved" | "deployed" | "failed";

/**
 * GitHub fake with the deploy workflow: a successful run deploys to `OPSCREW_HOST`, its build of
 * the branch or the image a dispatch's digest names, then checks the app from outside
 * ({@link checkFromOutside}) unless its start step said a move's marker held it or that it started
 * the app on a move's copied data. A failed check fails the run.
 */
export class FakeMoveGitHub extends FakeGitHub implements RetargetGitHubApi {
  conclusion: string | null = "success";
  readonly runs: { workflowFile: string; ref: string; inputs?: Record<string, string> }[] = [];
  /** The workflow's health step: whether the app answers at its public URL, from `host`. */
  checkFromOutside: (host: string) => boolean = () => true;
  /** The runs wait for a required reviewer first (they tell `onWaiting`). */
  reviewer = false;
  #digest: string | undefined;

  constructor(
    readonly events: MoveEvent[],
    readonly hostsFake: FakeHosts,
  ) {
    super();
  }

  override async setActionsSecret(owner: string, repo: string, name: string, value: string) {
    await super.setActionsSecret(owner, repo, name, value);
    this.events.push({ type: "secret", name });
  }

  override async dispatchWorkflow(
    _owner: string,
    _repo: string,
    workflowFile: string,
    ref: string,
    inputs?: Record<string, string>,
    onAccepted?: () => Promise<void>,
  ) {
    const given = inputs !== undefined && Object.keys(inputs).length > 0;
    this.#digest = inputs?.digest || undefined;
    this.runs.push({ workflowFile, ref, ...(given ? { inputs } : {}) });
    this.events.push({
      type: "dispatch",
      ref,
      ...(this.#digest !== undefined ? { digest: this.#digest } : {}),
    });
    await onAccepted?.();
    return { runId: 99, url: "https://github.com/acme/shop/actions/runs/99" };
  }

  /** Branches deleted with `deleteBranch`, in order. */
  readonly deletedBranches: string[] = [];

  async deleteBranch(_owner: string, _repo: string, branch: string) {
    this.deletedBranches.push(branch);
    return this.holds.delete(branch) ? ("deleted" as const) : ("absent" as const);
  }

  async waitForWorkflowRun(
    _owner: string,
    _repo: string,
    options: { runId: number; onWaiting?: (htmlUrl: string) => Promise<void> | void },
  ) {
    const htmlUrl = "https://github.com/acme/shop/actions/runs/99";
    if (this.reviewer) await options.onWaiting?.(htmlUrl);
    const host = this.secrets.get("OPSCREW_HOST");
    let conclusion = this.conclusion;
    if (conclusion === "success" && host !== undefined) {
      const image = this.#digest === undefined ? BUILT_IMAGE : `ghcr.io/acme/shop@${this.#digest}`;
      const started = this.hostsFake.deploy(host, image);
      const checked = started === "deployed" ? this.checkFromOutside(host) : started !== "failed";
      if (!checked) conclusion = "failure";
    }
    return { id: options.runId, conclusion, htmlUrl };
  }
}

/** Approval handler that records every decision in the event trail. */
export class RecordingHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  answer: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string } =
    () => true;

  constructor(readonly events: MoveEvent[]) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    const raw = this.answer(request);
    const decision = typeof raw === "boolean" ? { approved: raw } : raw;
    const confirmation =
      decision.confirmation ?? (decision.approved ? request.confirmPhrase : undefined);
    this.events.push({
      type: "approval",
      kind: request.kind,
      title: request.title,
      ...(request.planHash !== undefined ? { planHash: request.planHash } : {}),
      ...(request.allowDestroy !== undefined ? { allowDestroy: request.allowDestroy } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
      approved: decision.approved,
    });
    return {
      approved: decision.approved,
      approver: "test-user",
      decidedAt: "2026-10-13T12:00:00.000Z",
      ...(confirmation !== undefined ? { confirmation } : {}),
    };
  }
}

/**
 * What a non-interactive CLI run would approve: an infrastructure plan only when `--approve` names
 * its hash (and, for deletions, `--confirm` the app name); the maintenance window only with
 * `--allow-downtime`; a new server's repair only with `--confirm` the app name (its install also
 * with `--approve` its hash); secrets, pushes and pull requests (as `--yes` does).
 */
export interface CliFlags {
  approve?: string;
  allowDowntime?: boolean;
  confirm?: string;
}

export function cliAnswer(flags: () => CliFlags) {
  return (request: ApprovalRequest): boolean | { approved: boolean; confirmation?: string } => {
    const cli = flags();
    if (request.kind === "iac-apply") {
      const named = cli.approve !== undefined && cli.approve.toLowerCase() === request.planHash;
      if (!named) return false;
      if (request.allowDestroy) {
        return cli.confirm === request.confirmPhrase
          ? { approved: true, confirmation: cli.confirm }
          : false;
      }
      return true;
    }
    if (isMaintenanceWindowRequest(request)) return cli.allowDowntime === true;
    if (isNewServerRepairRequest(request)) {
      const hashed =
        request.planHash === undefined || cli.approve?.toLowerCase() === request.planHash;
      return hashed && cli.confirm === request.confirmPhrase
        ? { approved: true, confirmation: cli.confirm }
        : false;
    }
    return ["github-secrets", "git-push", "pull-request"].includes(request.kind);
  };
}

export interface MoveHarnessOptions {
  from?: CloudProvider;
  /** The new side's provider (default: DigitalOcean from Hetzner, else Hetzner). */
  to?: CloudProvider;
  /** `cloudflare` (default), `other` (a domain without managed DNS) or `none` (no domain). */
  dns?: "cloudflare" | "other" | "none";
  postgres?: boolean;
  interactive?: boolean;
  /** The plan has `app.releaseCommand`, so the deployed compose file has a `release` service. */
  release?: boolean;
  /** The PostgreSQL `db` has the app's two logins (`logins: separate`, 047). */
  logins?: boolean;
}

/** The live deployment a move starts from (`opscrew/plan.yaml` after provision). */
export function movePlan(options: MoveHarnessOptions = {}): DeployPlan {
  const dns = options.dns ?? "cloudflare";
  const postgres = options.postgres ?? true;
  const base = testPlan({
    provider: options.from ?? "hetzner",
    deployed: true,
    postgres,
    ...(dns === "cloudflare" ? { domain: DOMAIN } : {}),
  });
  return DeployPlanSchema.parse({
    ...base,
    // Without the Postgres container nothing derives DATABASE_URL (design leaves it out).
    app: {
      ...base.app,
      env: base.app.env.filter((v) => postgres || v.name !== "DATABASE_URL"),
      ...(options.release === true ? { releaseCommand: "python manage.py migrate --noinput" } : {}),
    },
    ...(dns === "other" ? { dns: { provider: "none", domain: DOMAIN, proxied: false } } : {}),
    ...(options.logins === true
      ? {
          services: base.services.map((service) =>
            service.kind === "postgres" ? { ...service, options: { logins: "separate" } } : service,
          ),
        }
      : {}),
    deployment: {
      ...base.deployment,
      ...(dns === "cloudflare" ? { url: `https://${DOMAIN}` } : {}),
    },
  });
}

/**
 * Leaves in the project at `root` (a git repository holding {@link movePlan}'s plan) what
 * `opscrew provision` left on this computer, and builds every fake a move talks to: the engine,
 * the two servers, GitHub with the deploy workflow, Cloudflare, the outside network and the
 * retarget services. `runEnv` is the run's environment; the returned `env` adds the provider
 * tokens and the user's env file.
 */
export async function moveFakes(
  root: string,
  runEnv: Record<string, string | undefined>,
  options: MoveHarnessOptions = {},
) {
  const from = options.from ?? "hetzner";
  const to: CloudProvider = options.to ?? (from === "hetzner" ? "digitalocean" : "hetzner");
  const dns = options.dns ?? "cloudflare";
  const env: Record<string, string | undefined> = {
    ...runEnv,
    HCLOUD_TOKEN: TOKENS.hetzner,
    DIGITALOCEAN_TOKEN: TOKENS.digitalocean,
    CLOUDFLARE_API_TOKEN: TOKENS.cloudflare,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const paths = resolveProjectPaths(root, { env });
  await writeArchitecture(paths.files.architecture, APP);
  await writeArtifact(
    "requirements",
    paths.files.requirements,
    makeRequirements({
      provider: to,
      dataCriticality: "important",
      budgetMonthly: { amount: 40, currency: "EUR" },
      ...(dns === "none" ? {} : { dnsProvider: dns, domain: DOMAIN }),
    }),
  );
  // What `opscrew provision` left on this computer.
  await ensureDeployKey(paths, new Redactor());
  await ensureStatePassphrase(paths);
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(join(paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await writeFile(paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  await writeFile(
    paths.files.deploySecrets,
    `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names: [] })}\n`,
  );
  // The look for apps from other repositories on the server a move starts from: none.
  const look = await firstAppLook(paths);
  await writeFile(join(root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);

  const events: MoveEvent[] = [];
  /** The snapshot ids the providers' `listSnapshots` answer, by server id (none by default). */
  const snapshotsOf: Record<string, string[]> = {};
  /** The server ids the providers' `listSnapshots` were asked for, in order. */
  const listed: string[] = [];
  const hosts = new FakeHosts(events);
  hosts.release = options.release === true;
  hosts.services = options.postgres === false ? [] : ["db"];
  Object.assign(hosts.host(SERVER_IPV4), { app: true, caddy: true, db: "orders before the move" });
  // The database's files on the old server, as large as the database.
  hosts.seed(SERVER_IPV4, {
    PG_VERSION: { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.alloc(hosts.dbSize) },
  });
  const engine = new FakeMoveEngine(events, { from, dns: dns === "cloudflare" });
  const github = new FakeMoveGitHub(events, hosts);
  /** Where the domain resolves when DNS is not managed (the user changes it). */
  const manual = { ip: SERVER_IPV4 };
  github.checkFromOutside = (host) => {
    const ip = dns === "cloudflare" ? engine.dnsServer()?.ipv4 : dns === "other" ? manual.ip : host;
    const h = ip === undefined ? undefined : hosts.hosts.get(ip);
    return h?.app === true && h.caddy;
  };
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    events.push({ type: "fetch", url: url.href });
    const ip =
      url.hostname === DOMAIN
        ? dns === "cloudflare"
          ? engine.dnsServer()?.ipv4
          : manual.ip
        : url.hostname.replace(/^\[|\]$/g, "");
    const h = ip !== undefined ? hosts.hosts.get(ip) : undefined;
    const ok = h?.app === true && h.caddy;
    return new Response(ok ? "ok" : "bad gateway", { status: ok ? 200 : 502 });
  };
  const fakeServers = (provider: CloudProvider): ServerSnapshotApi => ({
    findAppServers: async (): Promise<AppServer[]> =>
      Object.values(engine.state.servers)
        .filter((s): s is FakeServer => s?.provider === provider)
        .map((s) => ({ id: s.id, name: APP, status: "running" })),
    snapshotServer: async (serverId) => {
      events.push({ type: "snapshot", serverId });
      return { snapshotId: `snap-${serverId}` };
    },
    listSnapshots: async (serverId) => {
      listed.push(serverId);
      return (snapshotsOf[serverId] ?? []).map((id) => ({
        id,
        createdAt: "2026-10-01T00:00:00.000Z",
      }));
    },
    deleteSnapshot: async () => {
      throw new Error("deleteSnapshot is not implemented yet");
    },
    rebuild: async () => {
      throw new Error("rebuild is not implemented yet");
    },
    // The shutdown before a provider that cancels its servers cancels one.
    powerOff: async (serverId) => {
      poweredOff.push(serverId);
    },
    powerOn: async () => {
      throw new Error("powerOn is not implemented yet");
    },
    // Contabo's Terraform cannot remove a server, so its connector cancels it (ADR 0029, D10).
    cancelServer: async (serverId) => {
      events.push({ type: "cancel", serverId });
      return "2026-12-11";
    },
  });
  /** The servers shut down before their provider cancels them. */
  const poweredOff: string[] = [];
  /** Contabo's firewalls, which its connector applies (ADR 0029, D8): the old server's, if any. */
  const firewalls = new FakeFirewalls((op) => events.push({ type: "firewall", op }));
  const old = engine.state.servers.server;
  if (old !== undefined && cloudProvider(from).terraform.connectorFirewall) {
    firewalls.seed(fakeWantedFirewall(from, old.id));
  }
  let monotonic = 0;
  const ok = { configured: true, verify: async () => ({ ok: true, message: "ok" }) };
  const services: RetargetServices = {
    otherApps: look,
    engine: async () => engine,
    providers: { hetzner: ok, digitalocean: ok, contabo: ok },
    cloudflare: fakeCloudflare(
      dns === "cloudflare"
        ? {
            records: [
              opscrewRecord(DOMAIN, "A", SERVER_IPV4),
              opscrewRecord(DOMAIN, "AAAA", SERVER_IPV6),
            ],
          }
        : {},
    ),
    github,
    tcpConnect: async () => true,
    remote: hosts.remote,
    servers: {
      hetzner: fakeServers("hetzner"),
      digitalocean: fakeServers("digitalocean"),
      contabo: fakeServers("contabo"),
    },
    catalogs: { hetzner: euCatalog(), digitalocean: doEuCatalog() },
    firewalls: { contabo: firewalls },
    // A proxied Cloudflare domain resolves to the edge; otherwise to where the user points it.
    resolve: async (host) => {
      events.push({ type: "resolve", host });
      if (host !== DOMAIN) return [];
      return dns === "cloudflare" ? ["104.16.0.1"] : [manual.ip];
    },
    sleep: async (ms) => {
      monotonic += ms;
    },
    now: () => monotonic,
  };
  return {
    env,
    paths,
    from,
    to,
    events,
    hosts,
    engine,
    github,
    fetch,
    services,
    manual,
    firewalls,
    poweredOff,
    look,
    snapshotsOf,
    listed,
  };
}

/** A provisioned project (git repo, plan, state, keys) with every fake a move talks to. */
export async function moveHarness(options: MoveHarnessOptions = {}) {
  const plan = movePlan(options);
  const project = await createProject(plan);
  const fakes = await moveFakes(
    project.root,
    { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    options,
  );
  const { paths, events, hosts } = fakes;
  const reporter = new MemoryReporter();
  let seconds = 0;
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, seconds++)) };
  const audit = new MemoryAuditLog({ clock });
  const handler = new RecordingHandler(events);
  const approvals = new ApprovalGate({ handler, store: new MemoryApprovalStore(), audit, clock });
  const real = projectRunner();
  const runner = new ScriptedRunner(async (command, args, opts) =>
    command === "scp" ? hosts.scp(args) : real.run(command, args, opts),
  );
  const redactor = new Redactor();
  for (const [name, value] of Object.entries(TOKENS)) redactor.addLiteral(value, name);
  const deps: PhaseDeps = {
    paths,
    reporter,
    approvals,
    audit,
    state: new ProjectStateStore(paths.files.state, clock),
    costs: new CostLedger(paths.files.costs, clock),
    runner,
    fetch: fakes.fetch,
    streams: hosts.streams,
    env: fakes.env,
    clock,
    redactor,
    interactive: options.interactive ?? true,
    version: "0.0.0-test",
  };
  const confirm = async (preview: { name: string; resources: unknown[] }) => {
    events.push({ type: "confirm", name: preview.name, resources: preview.resources.length });
    return true;
  };
  /** Mutable flags of the simulated non-interactive CLI run. */
  const cli: CliFlags = {};
  if (deps.interactive === false) handler.answer = cliAnswer(() => cli);
  return {
    ...project,
    ...fakes,
    deps,
    plan,
    reporter,
    audit,
    handler,
    confirm,
    cli,
    newServer: NEW_SERVERS[fakes.to],
  };
}

export type MoveHarness = Awaited<ReturnType<typeof moveHarness>>;

/** A side of a move in the tests: a cloud provider, the user's own server, their Portainer. */
export type MoveSideKind = CloudProvider | "own" | "portainer";

/**
 * The target of a side `kind`, as a plan records it: {@link movePlan}'s server at a cloud
 * provider, the user's own server, or environment 3 of their Portainer, whose DNS records are
 * OpsCrew's unless `records` is false.
 */
export function targetOf(kind: MoveSideKind, records = true): DeployPlan["target"] {
  switch (kind) {
    case "hetzner":
    case "digitalocean":
    case "contabo":
    case "ovhcloud":
    case "kamatera":
    case "ionos":
      return movePlan({ from: kind }).target;
    case "own":
      return {
        provider: "own",
        mode: "vps-compose",
        arch: "amd64",
        access: "public",
        edge: "caddy",
      };
    case "portainer":
      return {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: records ? { mode: "caddy", records: true } : { mode: "caddy" },
      };
  }
}

/** The Portainer token {@link portainerServices}'s fake accepts (synthetic). */
export const PORTAINER_TOKEN = fakeSecret("generic-password", "portainer-token");
/** The certificate the fake Portainer presents. */
export const PORTAINER_CERT = fakeCertificate();

/**
 * The user's Portainer as a move reaches it: its API (`portainer`, by default a fresh
 * {@link fakePortainer} of environment 3 that accepts {@link PORTAINER_TOKEN}) and its Docker
 * proxy to `docker`, where the app's stack containers keep running once started (the fake runs
 * others to their end). `onStackCreate` runs once Portainer has created a stack.
 */
export function portainerServices(
  docker: FakeDocker,
  options: { portainer?: FakePortainer; onStackCreate?: () => void } = {},
): PortainerServices {
  const portainer = options.portainer ?? fakePortainer({ token: PORTAINER_TOKEN });
  const prefix = "/api/endpoints/3/docker";
  const request: PinnedRequest = async (init) => {
    const response = await portainer.request(init);
    if (init.method === "POST" && init.path.startsWith("/api/stacks/create/")) {
      options.onStackCreate?.();
    }
    return response;
  };
  const stream: PinnedStream = async (init) => {
    const path = init.path.slice(prefix.length);
    const id = /\/containers\/([^/?]+)\/start(?:\?|$)/.exec(path)?.[1];
    const container = id === undefined ? undefined : docker.containers.get(id);
    if (init.method === "POST" && container?.labels[COMPOSE_PROJECT_LABEL] === `opscrew-${APP}`) {
      container.state = "running";
      return { status: 204, headers: {}, body: Readable.from([]) };
    }
    return docker.request({
      method: init.method,
      path,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  };
  return {
    client: (endpoint, token, clientDeps) =>
      portainerClient(endpoint, token, { ...clientDeps, request, stream }),
    inspectCertificate: async () => PORTAINER_CERT,
    wait: { now: () => 0, sleep: async () => undefined },
  };
}
