# Implementation Plan: More server providers, first wave (OVHcloud, Kamatera, IONOS Cloud)

**Branch**: `035-providers-first-wave` for OVHcloud, `035-kamatera` for Kamatera (stacked on it),
`035-ionos` for IONOS Cloud (stacked on Kamatera's) | **Date**: 2026-11-21 for OVHcloud, 2026-11-24
for Kamatera, 2026-11-27 for IONOS Cloud | **Spec**: [spec.md](spec.md)
**Input**: [spec.md](spec.md), [research.md](research.md) (R1 OVHcloud's facts, R2 the lead's
decisions, R3 the live checks, R4 Kamatera's facts, R5 IONOS Cloud's).

## Summary

OVHcloud's Public Cloud becomes the fourth built-in cloud server provider, `ovhcloud`, in its own
package `@opscrew/provider-ovhcloud` on the contract of ADR 0029, as Contabo did in 026. It
contains:
- its definition;
- an API client signed in by an OAuth2 service account;
- a catalogue: a dated static price table, read live from OVHcloud's public catalogue when the
  credentials are set, with each offer's availability in the project;
- the server API: lookup by name, snapshots, rebuilds and power;
- its HCL module on `ovh/ovh` `~> 2.25.0` (an instance, an SSH key and a security group).

One thing in the contract is missing for it. Every OVHcloud resource names its project, and a
provider can't bring a value an app needs that isn't a server variable into its module. So the
contract gains one optional field, `rootVariables`, with three small generic consumers:
- the registry validates it;
- iac-templates declares the variables in the root;
- `projectEngine` passes them as `TF_VAR_*` from the environment.

That change, and the new id in the shared id lists, go through `[035]` issues to the core's lead
first. Kamatera, IONOS Cloud and UpCloud come later, each in its own pull request.

Kamatera becomes the fifth, `kamatera`, in `@opscrew/provider-kamatera`, on a branch stacked on
OVHcloud's because it needs the same contract fields and shared lists. It contains:
- its definition;
- a typed client over the API front Kamatera's own Terraform provider and CLI use;
- a catalogue: a dated table of Kamatera's public calculator prices, refreshed from the same
  public file when it is reachable;
- the server API the Terraform provider lacks: lookup by name, snapshots, power and terminate;
- its HCL module on `Kamatera/kamatera` 0.9.4 (a server with a startup script, no key resource and
  no user data).

Kamatera needs up to two more shared changes, both additive:
- `ProviderTerraform.firstBoot?: "cloud-init" | "script"`, because it takes the first-boot setup as
  a startup script, not as user data (issue #13, the contract question);
- a server-firewall kind in SecOps, because Kamatera has **no cloud firewall OpsCrew can set or
  prove** and the firewall has to live on the server (issue #13, the founder's safety-model
  question). Without the founder's approval, Kamatera's work stops at that task.

## Technical Context

- **Language**: TypeScript strict ESM on Node 22.9+, pnpm and turbo, Vitest, zod, Biome, as for
  every package.
- **Infrastructure**: OpenTofu and Terraform 1.6+ in the common dialect, with the `ovh/ovh`
  provider pinned `~> 2.25.0` (2.25.0 was published 2026-11-13).
- **OVHcloud API**: `https://api.eu.ovhcloud.com/1.0` and `https://api.eu.ovhcloud.com/v2`
  (go-ovh's `OvhEU`; the v2 base is to be confirmed against the v2 schema by T3506), with OAuth2
  client credentials from `https://auth.eu.ovhcloud.com/oauth2/token`, scope `all` (go-ovh
  `ovh.go` and `configuration.go`, read 2026-11-21). The public catalogue is
  `GET /1.0/order/catalog/public/cloud?ovhSubsidiary=IE`.
- **Kamatera's Terraform provider**: `Kamatera/kamatera` **0.9.4**, MPL-2.0, community tier, on the
  OpenTofu registry, published 2025-09-11 (R4 §2). It is built on terraform-plugin-sdk v2 and its
  resources are `kamatera_server` and `kamatera_network`, with the data sources
  `kamatera_datacenter` and `kamatera_image`.
- **Kamatera API**: the front its Terraform provider and cloudcli use, `https://cloudcli.cloudwm.com`,
  where **every call** carries `AuthClientId` and `AuthSecret` and returns a queued command id
  (R4 §1). The console API, `https://console.kamatera.com/service/`, is the documented front with
  an hourly token; the decision below takes the first, and the live pass confirms it.
- **Kamatera prices**: `https://console.kamatera.com/info/calculator.js.php`, a public
  unauthenticated file with every price in US dollars a month; the Terraform provider reads it
  during plan to validate the datacenter and the plan (R4 §7).
- **Testing**: unit tests with injected `fetch` fakes and fixtures written from the documented
  answers and the public calculator data. No real cloud call anywhere. Each module is checked with
  `tofu validate` and `fmt -check`, plus `terraform` where installed, skipping when the provider
  can't be downloaded.
- **Constraints**:
  - no new dependency (the clients use the injected `fetch`, and node's `crypto` only if needed);
  - no secret-shaped literal in any fixture (`fakeSecret`, `{{FAKE:<kind>}}`);
  - temp files under `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.

## Constitution Check

- **I. Safety gate**: unchanged. Every OVHcloud change is a Terraform plan approved by its hash,
  and a destroy needs `allowDestroy` and the typed name. The connector's mutating calls (snapshot,
  rebuild, power, reinstall) are the ones `ServerSnapshotApi` already gates in the agents. No
  standing approval is added. ✅
  **Kamatera** keeps the gate for everything Terraform creates: the server, its startup script and
  its key are one plan approved by its hash, and the destroy needs the same. Its **firewall** is
  the one exception: with no cloud firewall to plan, the gate is the first-boot script inside the
  approved plan plus `opscrew secure` after the boot, and a server is reachable between its boot
  and that script's run. That changes the safety model for one provider, so it waits for the
  founder's decision in issue #13. ⚠️
- **II. The user owns everything**: the module is vendored into the user's repository, and the
  project id is never written to a file. A user who deletes OpsCrew keeps HCL that runs with
  `TF_VAR_ovhcloud_project_id` set. The guide says so. ✅
  Kamatera's module is vendored the same way, with its startup script inside it: whoever runs it
  without OpsCrew runs the same server and firewall. ✅
- **III. Dual engine**: the module stays in the common dialect and is validated under both
  engines. ✅
- **IV. Secrets**: all four values are registered with the redactor when read. They are never in
  state (the provider reads them from the environment) or in tfvars. The service account is
  scoped to one project by an IAM policy, which the guide and `init` explain. ✅
  Kamatera's key **cannot be scoped**, so both values are redacted, the guide recommends a separate
  account, and the root password its provider records in state is random and never shown. ✅
- **V. Deterministic first**: the catalogue, availability and every check are code. No model is
  involved. ✅
- **VI. Contracts first**: one optional field, `rootVariables`, owned by `@opscrew/contracts`, is
  changed in its own task (T3502) and recorded in ADR 0029 as D11. The id joins the lists in
  T3510. ✅
  Kamatera's `firstBoot` and its SecOps kind are separate, additive tasks (T3520, T3526) recorded
  as D12 and D13, each after its issue. ✅
- **VII. Test-first**: every task names its `Verify:` command. ✅

## Design

### 1. The contract: `ProviderTerraform.rootVariables` (T3502, lead, after the issue)

```ts
/**
 * Root variables the provider's server module calls read (`var.<name>` in `moduleArguments`)
 * that are not a server's own: OpsCrew declares each in the root module once, and passes it to
 * every engine command only as `TF_VAR_<name>` from the credential variable `fromEnv`, never in
 * a file. Absent for most providers.
 */
rootVariables?: readonly { name: string; description: string; fromEnv: string }[];
/**
 * The HCL expression of an `import` block's `id` that takes over the server `serverId` (026's
 * takeover); absent, the quoted id (`"<serverId>"`). OVHcloud imports an instance as
 * `<project>/<id>`, so its expression reads the project from its root variable.
 */
importId?(serverId: string): string;
```

`importId` was found while building T3508: `ovh_cloud_instance` imports only as
`<service_name>/<instance id>` (the provider's `ImportState`), and iac-templates' takeover writes
`id = "<id>"`. Writing the project id there would put it in `main.tf`.

ADR 0029 gains **D11**: the reason (OVHcloud's `service_name`), the rule (only a credential feeds
it, only through the environment), and that the vendored HCL then needs `TF_VAR_<name>` set by
whoever runs it without OpsCrew.

### 2. Its consumers (wave 1, generic, byte-identical for the other three providers)

- **The registry** (`validate.ts`):
  - each name is a valid HCL identifier that collides with no server variable (`location`,
    `server_type`, `image`, `backups` and their prefixes) and with no other provider's root
    variable;
  - `fromEnv` is one of the provider's `credentials.envVars`;
  - the description is not empty.
- **iac-templates**: every root that renders at least one server of a provider with
  `rootVariables` declares each one once, `type = string`, with its description and no default.
  It never writes a value for it to `terraform.tfvars.json`. The roots of the other providers are
  byte-identical (the existing snapshot tests prove it).
  - **Not `sensitive`:** OpenTofu 1.13.9 refuses a sensitive value in an `import` block's `id`
    ("The import id cannot be sensitive"; the lead's local check, 2026-11-21). A non-sensitive
    variable there plans fine. The project id isn't a secret, and the redactor still masks its
    value in everything OpsCrew shows. Terraform is checked by T3504's test where it is installed.
  - **The takeover's `import` block** writes `id = <importId(serverId)>` when the provider has
    `importId`, and the quoted id otherwise.
- **The agents' `projectEngine`** (`shared/engine.ts`): for every built-in provider's root
  variables, when `env[fromEnv]` is set, it sets `env["TF_VAR_" + name]` and registers the value
  with the redactor. A root that doesn't declare the variable ignores it, which is the engines'
  documented behaviour for `TF_VAR_*`, so the other roots are unaffected. All nine callers then
  have it with no change. The task lists any engine run that doesn't go through `projectEngine`
  (a grep for `engine.plan(`, `engine.apply(`, `engine.init(`) and covers it, or reports it.

### 3. The OVHcloud package (`packages/providers/ovhcloud`, `@opscrew/provider-ovhcloud`)

- **`client.ts`**:
  - **Sign-in:** an OAuth2 client-credentials token, cached until it expires and fetched again
    once on a 401.
  - **Endpoint check:** `OVH_ENDPOINT` must be `ovh-eu`. Any other value is refused before any
    call, naming `ovh-eu`.
  - **The four values:** registered with the redactor when read.
  - **Requests:** v1 and v2 paths under the EU base, and every answer parsed with zod.
  - **Errors:** OVHcloud's error JSON (`class`, `message`, and `details` with
    `unauthorizedActionsByIAM`) mapped to plain English:
    - a missing right names the IAM action to allow;
    - a 404 on the project says to check `OVH_CLOUD_PROJECT_SERVICE`;
    - a 429 waits for `Retry-After` and retries once on reads only.
  - **Creates are never retried.**
- **`static-prices.ts`**: `d2-2`, `d2-4`, `d2-8`, `b3-8` and `b3-16`, each with:
  - vCPU, memory and disk;
  - the hourly price in EUR before VAT, with `monthly` = hourly × 730 as the cap the contract asks
    for;
  - `cpuType`: shared for d2, dedicated for b3.

  It also holds the snapshot price of €0.011 per GB a month and €0.000015 per GB an hour, the date
  2026-11-21 and the source (the IE catalogue).
- **`catalog.ts`**:
  - **Without credentials:** the static table, offered in every mapped location, `source: "static"`.
  - **With credentials:** the public catalogue read once a run (prices in 1e-8 EUR, the plan codes
    `<flavor>.consumption`), crossed with `GET /v2/publicCloud/project/{id}/reference/productAvailability`.
    An offer is `available` only where its region is activated, its stock isn't `OUT_OF_STOCK`,
    and its quota isn't `INSUFFICIENT`.
  - **If the live read fails:** the static table with a warning, as the other providers fall back.
  - **`extras`:** the snapshot rate and no IPv4 line (the public IPv4 is free).
- **`servers.ts`** (`ServerSnapshotApi`):
  - **`findAppServers(app)`:** the project's instances named exactly `app` or `app-…`, every one
    `nameOnly: true`, since OVHcloud has no tags. The generic takeover (026) then adopts a server
    only when OpsCrew's own apply stopped while creating it.
  - **Snapshots:** taken through the instance's snapshot call, named
    `opscrew-<app>-<server id>-<time>`, and listed by that prefix, oldest first. Delete waits until
    the snapshot is gone.
  - **Other calls:** `rebuild` = reinstall from the snapshot's image; `powerOff` = stop and wait for
    `SHUTOFF`; `powerOn` = start and wait for `ACTIVE`; `restart` = soft reboot; `reinstall` = the
    image with the user data.
  - **API version:** the implementer picks v1 or v2 per call from the schemas, preferring v2 where
    it has the call, and records each choice in the task's report.
- **`connector.ts`**: `verifyCredentials` gets a token and reads the project. Its message names the
  project's description and lists the activated regions, with the control panel's path to
  activate another (Public Cloud → the project → Settings → Regions; the implementer confirms the
  path from OVHcloud's docs). It also exposes `catalog()` and `servers`. There are no `firewalls`,
  `backups` or `objectStorage`.
- **`definition.ts`**, as research R2:
  - `billing: { model: "hourly", counts: "second", setupFee: false }`;
  - `providerBackups: false`, `backupPercent: 0`, `backupsOutliveServer: false`;
  - `snapshots: per-gb`, `serverSnapshotsOutliveServer: true`;
  - `deleteProtection: false`, `resize: false`, `removal: { kind: "delete" }`;
  - `connectorFirewall`, `connectorBackups` and `connectorRemoval` false, and no `homeCacheFiles`;
  - `lifecycleIgnored: ["user_data", "image_id", "ssh_key_name"]`;
  - `rootVariables: [{ name: "ovhcloud_project_id", fromEnv: "OVH_CLOUD_PROJECT_SERVICE", … }]`;
  - `tokenRules: []` and `envPrefixes: ["OVH"]`;
  - the regions as R2.7, with the notes and coordinates;
  - `unavailable` and `serverLimit` patterns from the words the API uses (`OUT_OF_STOCK`,
    `INSUFFICIENT`, `quota`), marked unverified until the live pass;
  - every text (runbook, destroy, init, SecOps) in plain English. The destroy texts name the
    snapshots that keep billing.
- **`module/` (`ovhcloud-instance`)**:
  - data sources resolve the flavor by name and the image `Ubuntu 24.04` by name in the region;
  - `ovh_cloud_ssh_key` `<app>-deploy`, kept in the root as `extraShared` so removing a server
    never deletes it, as Contabo's key;
  - `ovh_cloud_security_group` `opscrew-<name>` with Hetzner's rules (IPv4 and IPv6 sources);
  - `ovh_cloud_instance` with `security_group_ids` set explicitly to that group, the shared
    `cloud-init.yaml.tftpl` base64-encoded in `user_data`, and `lifecycle.ignore_changes` as above;
  - the outputs other modules have (`server_id`, `server_name`, `ipv4_address`, `ipv6_address`,
    `ssh_key_id`);
  - `src/generated/module.ts` from `pnpm gen:provider-modules`.
- **SecOps**: the security group's `rule` list read into Hetzner's rule shape. Its attachment comes
  from the instance's `security_group_ids` or, before apply, from the plan configuration's
  references, as Contabo's definition reads its firewall's.

### 4. The id joins the lists (T3510, lead, after the issue)

`ovhcloud` in:
- `ProviderId` and `VpsProviderId` (contracts);
- `VpsProviderSchema` and `DEFAULT_IMAGES` (`"Ubuntu 24.04"`) in plan-schema, and its generated
  schemas;
- `CLOUD_PROVIDERS`, after Contabo, and the registry's and CLI's `package.json` dependencies, with
  the lockfile.

Then `pnpm check` must pass, with any exhaustive switch left over fixed. This is the same task as
026's T2616.

### 5. The guide, the plugin, the live pass (wave 3)

- `docs/guide/ovhcloud.md` on `docs/guide/contabo.md`'s model.
- The pages that list providers. `docs/guide/index.md` is shared, so it goes in the `[035]` issue.
- The plugin's deploy and snapshot skills.
- `packages/cli/test/live/ovhcloud.test.ts` (`OPSCREW_E2E_OVHCLOUD=1` and the four variables) and
  its steps in `docs/e2e.md`, written for the founder. It is never run without his go-ahead.

### 6. Tests

- **The registry:** its conformance test over the four definitions, plus `rootVariables`
  validation cases (a bad name, a collision, `fromEnv` not a credential).
- **iac-templates:** the existing snapshots unchanged, and a root with an OVHcloud server declaring
  `ovhcloud_project_id` once, with no value in `terraform.tfvars.json`.
- **The agents:** `projectEngine` sets the `TF_VAR_` and registers it with the redactor, and leaves
  `env` untouched for a variable that isn't set.
- **OVHcloud's client and connector, with `fetch` fakes:**
  - a token renewed on a 401;
  - a missing IAM right in plain English;
  - `ovh-ca` refused before any call;
  - availability marking offers unavailable;
  - the live catalogue's prices parsed from a trimmed fixture of the real shape;
  - `findAppServers` by exact names;
  - a create's timeout followed by a second provision that creates nothing (SC-3502, with the
    generic takeover's fakes);
  - no credential or project id in any error, log or fixture.
- **The module** under both engines, and SecOps on an OVHcloud plan JSON fixture (an attached
  group, a missing one, the default group never used).

### 7. Kamatera's contract change: `ProviderTerraform.firstBoot` (T3520, lead, after issue #13)

```ts
/**
 * How a provider's servers take the shared first-boot setup: `cloud-init` (the default, and
 * every provider before Kamatera) as the `cloud-init.yaml.tftpl` user data, or `script` as a
 * shell script the module passes where the provider takes a startup script (Kamatera, which has
 * no user data). Both render the same steps, from the same context.
 */
firstBoot?: "cloud-init" | "script";
```

- **iac-templates:** today it writes `cloud-init.yaml.tftpl` into every server module's folder and
  the module reads it. With `script`, it also writes `first-boot.sh.tftpl`, the generic wrapper:
  the module renders the cloud-config, base64-encodes it (`base64encode`), and passes the wrapper
  to `startup_script`. The wrapper ships **beside** the cloud-config rather than replacing it,
  because the deploy key and the web flag are values only `templatefile` knows at apply time, so
  the steps have to stay a template. The other providers never get the wrapper.
- **The script's shape:** a bash script with a marker guard (`/var/lib/opscrew/first-boot.done`),
  which installs cloud-init when the image lacks it, writes the cloud-config to
  `/var/lib/cloud/seed/nocloud-net/user-data`, and runs `cloud-init clean`, `init --local`, `init`
  and `modules --mode=final`. It is idempotent, so an image that runs it on every boot changes
  nothing after the first. The live pass proves whether it runs once, and whether the image has
  cloud-init at all (R4 §9).
- **ADR 0029 D12:** why (Kamatera has no user data in its Terraform), the rule (the same steps,
  rendered twice), and that the vendored module keeps its script, so the user owns it.
- **Only Kamatera's files change.** The other providers' roots and modules are byte-identical,
  which the existing snapshot tests prove.

### 8. The Kamatera package (`packages/providers/kamatera`, `@opscrew/provider-kamatera`)

- **`client.ts`**:
  - **Front:** `https://cloudcli.cloudwm.com` (`KAMATERA_API_URL` overrides it), the front
    Kamatera's own Terraform provider and CLI use (decision 1). No token step: every call carries
    `AuthClientId` and `AuthSecret`, read from `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET`
    and registered with the redactor.
  - **Answers:** every one parsed with zod; a list is a list, and a command is `{ id }` or a
    one-element list, as the API answers both (R4 §10).
  - **Queued commands:** a create, a terminate and a configure return a command id; the client
    polls `GET /service/queue?id=<id>` with an injected clock and sleep until `complete`, and fails
    with the command's `log` on `error`.
  - **Errors:** HTTP 500 is used for user mistakes at Kamatera (R4 §10), so the client reads the
    body's `message` and `errors[].info` and says what to do; a 404 says the server or the route
    was not found; no `post` is ever retried.
  - **No scope:** neither value can be limited, so a message never prints one.
- **`static-prices.ts`**: the dated table of 2026-11-22, in USD a month, with `hourly` =
  `monthly / 730`, and these plans (R4 §7):
  - `A-1-2` (1 vCPU A, 2 GB, 20 GB, $6.00), `A-2-4` (2, 4 GB, 40 GB, $19.00), `A-4-8`
    (4, 8 GB, 80 GB, $42.00);
  - `B-1-2` (1 vCPU B, 2 GB, 20 GB, $15.00), `B-2-4` (2, 4 GB, 40 GB, $42.00), `B-4-8`
    (4, 8 GB, 80 GB, $90.00);

  plus the snapshot rate ($0.05 a GB a month), the extra IPv4 ($1 a month), the traffic allowance
  per datacenter (5000 GB in Europe and North America, 1000 GB in Asia and Sydney, $0.01 a GB
  over), the stopped-server rate (about a tenth: $0.0102 an hour for 50 GB, R4 §3) and the source.
- **`catalog.ts`**:
  - **The table:** every plan offered in every mapped datacenter, `billing: "hourly"`, `hourly`,
    `monthly` = the table's, no `setupFee`, `source: "static"` and the date.
  - **Live prices:** the public calculator file, read at most once per catalogue when it is
    reachable, because its prices are public and need no credentials. It updates the prices and
    says `source: "live"`; a failed read keeps the table and adds no warning (it is the same
    data).
  - **Availability:** Kamatera publishes no per-account availability, so every plan is offered
    everywhere it is sold; an apply it refuses (the account's price limit, its allotment, no
    capacity) takes the generic unavailable-size path, with the error patterns in the definition.
  - **`extras(location)`:** the snapshot rate, the extra IPv4, the traffic allowance and the
    overage rate.
- **`servers.ts`** (`ServerSnapshotApi`):
  - **`findAppServers(app)`:** `GET /service/servers` (id, name, datacenter, power), matched on
    the app's exact name, every one `nameOnly: true`. The ids and names both come back, so the
    Terraform id — the name — is available without another call.
  - **The `<name>(1)` guard:** the same list is checked for `<name>(1)` before every apply; a
    match is reported by name and never adopted silently (R4 §2, issue #25).
  - **Snapshots:** created, listed, reverted and deleted through the API's snapshot route, named
    `opscrew-<app>-<server>-<time>` and listed by that prefix, oldest first. The create's command
    is awaited; the delete's too.
  - **Power:** `poweron`, `poweroff` and `reboot`, each an awaited command; `powerOff` never forces
    (the terminate does).
  - **Terminate:** `POST /service/server/terminate` with `force: true`, awaited. The Terraform
    provider removes a server with it, so the connector's `remove` is not used
    (`connectorRemoval` false), and `rebuild`/`reinstall` are refused with a plain message: a
    Kamatera server is made again as a new one.
- **`connector.ts`**: `configured`, `catalog()`, `servers`, and `verifyCredentials`, which reads
  the account's server list and a datacenter's options and says what it found (the server count
  and the datacenter codes). No `firewalls`, `backups` or `objectStorage`.
- **`definition.ts`** (decision 2):
  - `currency: "USD"`, `billing: { model: "hourly", counts: "second", setupFee: false }` (billed by
    the started minute, finer than the offer's hour);
  - `providerBackups: false`, `backupPercent: 0`, `backupsPrice: "order-page"` (the daily-backup
    flag exists, its price does not: R4 §5), `backupsOutliveServer: true`;
  - `snapshots: { kind: "per-gb", perGbMonth: 0.05, perGbHour: 0.05 / 730 }`,
    `serverSnapshotsOutliveServer: true`;
  - `deleteProtection: false`, `resize: false`, `offAfterRefusedResize: false`,
    `removal: { kind: "delete" }`;
  - `connectorFirewall: false`, `connectorBackups: false`, `connectorRemoval: false`,
    `homeCacheFiles: []`;
  - `firewallResourceType: "kamatera_server"` (unused while `firewallCheck` is `"server"`, T3526);
  - `lifecycleIgnored: ["image_id", "ssh_pubkey", "startup_script"]`;
  - `sshKeyAttribute: "ssh_pubkey"` (T3516's field: the server takes the key's text);
  - `tokenRules: []` and `envPrefixes: ["KAMATERA", "CLOUDCLI"]`;
  - the regions as R4 §6, with the unconfirmed codes noted;
  - `unavailable` and `serverLimit` patterns from Kamatera's words (`price limit`, `allotment`,
    `no capacity`, `limit`), marked unverified until the live pass;
  - `defaultImage: "Ubuntu 24.04"`, mapped by the module's data source (`os = "Ubuntu"`,
    `code = "24.04 64bit"`);
  - every text in plain English, and the destroy texts say a stopped server had kept billing and
    what may outlive the server.
- **`module/` (`kamatera-instance`)**:
  - `locals.plans` maps each OpsCrew plan id (`A-2-4`) to `cpu_type`, `cpu_cores`, `ram_mb` and
    `disk_sizes_gb`, so `server_type` stays an opaque id to the root (decision 5);
  - `data "kamatera_image"` with `datacenter_id = var.location`, `os` and `code` from the
    definition's image;
  - `kamatera_server` with `name = var.name`, `datacenter_id = var.location`, the plan's CPU,
    memory and disks, `billing_cycle = "hourly"`, `ssh_pubkey = var.deploy_ssh_public_key`,
    `startup_script = templatefile("${path.module}/first-boot.sh.tftpl", { cloud_config_b64 =
    base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", …)) })`,
    `daily_backup = false`, `power_on = true` and `allow_recreate = false`;
  - `lifecycle.ignore_changes` on `image_id`, `ssh_pubkey` and `startup_script`, so a change is
    never planned (they would recreate the server);
  - no password argument: the provider generates one and records it in state as
    `generated_password`, which OpsCrew never reads or shows (decision 9);
  - the outputs the other modules have; `server_id` is the server's **name**, because that is
    Kamatera's Terraform id (R4 §2);
  - `src/generated/module.ts` from `pnpm gen:provider-modules`.
- **SecOps (T3526, after issue #13)**: `ProviderSecOps` gains a firewall kind —
  `firewallCheck?: "cloud" | "server"`, default `"cloud"`. With `"server"`, `firewall-attached`
  checks that the planned server's `startup_script` holds the firewall marker, and `opscrew
  secure` reads the rules over SSH after the boot (default deny; the allowed SSH, web and
  WireGuard ports) and fails until they are right. The plan, the design summary and the guide then
  say "cloud firewall: none; server firewall: on". **Not chosen:** D8's connector firewall, because
  Kamatera's API has no firewall to sync and an SSH-only sync would still leave the same boot gap
  without the script.

### 9. Kamatera's id joins the lists (T3527, lead, after the issue)

`kamatera` in:
- `ProviderId`, `VpsProviderId`, `VpsProviderSchema` and `DEFAULT_IMAGES` (`"Ubuntu 24.04"`);
- `CLOUD_PROVIDERS`, after `ovhcloud`, with the registry's and the CLI's dependencies and the
  lockfile;
- the plugin's two credential lists (`plugin/.codex-plugin/plugin.json` and the TOML in
  `docs/guide/mcp-clients.md`), with `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET`.

Then `pnpm check` passes, with any exhaustive switch left over fixed.

### 10. Kamatera's variables never reach the agent (T3528, small, additive)

`packages/core/src/env.ts` gains `KAMATERA_` and `CLOUDCLI_` among the prefixes the agent's
environment never gets, with a test, as commit 59e65a49 did for `OVH_` (issue #11). The variables
stay on the user's computer.

### 11. The guide, the plugin, the live pass (T3529, T3530)

- `docs/guide/kamatera.md` on `docs/guide/contabo.md`'s model, and Kamatera's lines on the pages
  that list providers and compare prices.
- The plugin's deploy and snapshot skills say what differs (no cloud firewall, a startup script, no
  resize, a stopped server that bills).
- `packages/cli/test/live/kamatera.test.ts` (`OPSCREW_E2E_KAMATERA=1` and the two variables) and its
  steps in `docs/e2e.md`, written for the founder, on one `A-2-4` at about $0.03 an hour. It is
  never run without his go-ahead (issue #14).

### 12. Tests (Kamatera)

- **The registry:** its conformance test over the five definitions, and Kamatera's `firstBoot` and
  `sshKeyAttribute` validated.
- **iac-templates:** every existing snapshot byte-identical; a root with a `firstBoot: "script"`
  provider gets `first-boot.sh.tftpl` beside `cloud-init.yaml.tftpl`, and the rendered script
  carries the same cloud-config, base64-encoded (checked by decoding it, and by `sh -n`).
- **The client, with `fetch` fakes:** the two headers on every call; a queued create awaited; a
  command that ends in `error` fails with its `log`; a 500 with `errors[].info` in plain English;
  no `post` retried; a leak check.
- **The catalogue:** the six plans, hourly = monthly / 730, the date, `source`, `extras`; the live
  read updating prices; a failed read keeping the table.
- **The server API:** `findAppServers` by exact name; the `<name>(1)` guard reporting a stray
  server; snapshot create/list/delete; power; terminate.
- **The module:** `tofu validate` and `fmt -check` (and `terraform` where installed), plus a plan
  with a fake provider config if the network allows, skipping plainly otherwise; SecOps on a
  Kamatera plan JSON fixture.
- **The flows:** SC-3508's one flow test in agents on a Kamatera app, and SC-3509's two cases
  (a timed-out create; a `<name>(1)` rename).

### 13. The IONOS Cloud package (`packages/providers/ionos`, `@opscrew/provider-ionos`)

IONOS Cloud is the sixth, `ionos`, stacked on Kamatera's branch. It needs **no contract change**:
its Terraform provider is the vendor's (`ionos-cloud/ionoscloud`, pinned `~> 6.7.42`) and covers
the data centre, the server, its disk, its NIC and the NIC's firewall rules (R5 §2).

- **`client.ts`**:
  - **Front:** `https://api.ionos.com/cloudapi/v6` (`IONOS_API_URL` overrides it). Every call
    carries `Authorization: Bearer` with `IONOS_TOKEN`, registered with the redactor. A user name
    and password are never read (decision 14).
  - **Requests:** a create, change or delete answers 202 with the request's address in `Location`;
    the client polls `GET /requests/{id}/status` with an injected clock and sleep until `DONE`, and
    fails with the request's `message` on `FAILED`.
  - **Errors:** the body is `{ httpStatus, messages: [{ errorCode, message }] }` (R5 §10); a 401 says
    the token is wrong or expired and how to make one; a 403 names the missing privilege; a 422 or
    a limit names it and says support raises it; a 429 waits on reads only; no `post` is retried.
- **`static-prices.ts`**: the EUR price list v2026-10-29 (R5 §7): vCPU 0.012 an hour, RAM 0.002 a GB
  an hour, Essential disk 0.04 a GB per 30 days, snapshot 0.04 a GB per 30 days, 2 TB of traffic a
  month per contract then 0.030 a GB. The sizes (decision 16), each with its hourly price and the
  730-hour figure, the disk counted at 730/720 of its 30-day price:
  - `vcpu-1-2` (1 vCPU, 2 GB, 40 GB), `vcpu-2-4` (2, 4 GB, 80 GB), `vcpu-4-8` (4, 8 GB, 160 GB),
    `vcpu-2-8` (2, 8 GB, 80 GB), `vcpu-4-16` (4, 16 GB, 160 GB).
- **`catalog.ts`**: the table, every size in every mapped location, `source: "static"` and the date.
  IONOS has no public price API (R5 §7), so there is no live read. `extras(location)`: the snapshot
  rate and the traffic allowance.
- **`servers.ts`** (`ServerSnapshotApi`):
  - **`findAppServers(app, names?)`:** `GET /datacenters?depth=1`, the data centres named
    `opscrew-<name>` for each of `names` (or, without them, `opscrew-<app>` and `opscrew-<app>-…`),
    then each one's servers. An `AppServer`'s id is `<datacenter id>/<server id>`.
  - **Snapshots:** of the server's boot disk, `POST /datacenters/{dc}/volumes/{vol}/create-snapshot`
    named `opscrew-<app>-<server>-<time>`, awaited; listed from `GET /snapshots` by that prefix,
    oldest first; deleted and restored (`restore-snapshot`) the same way.
  - **Power:** `start`, `stop` and `reboot`, each awaited; `stop` is IONOS's, which frees the cores
    and memory (an OS shutdown frees nothing, R5 §3).
  - The data centre's delete is Terraform's, so the connector's `remove` is not used.
- **`connector.ts`**: `configured`, `catalog()`, `servers`, and `verifyCredentials`, which reads
  `GET /datacenters?depth=0` and `GET /contracts` and says the data-centre count and the contract's
  limits it found. No `firewalls`, `backups` or `objectStorage`.
- **`definition.ts`**:
  - `currency: "EUR"`, `billing: { model: "hourly", counts: "second", setupFee: false }`;
  - `providerBackups: false`, `backupPercent: 0`, `backupsOutliveServer: true`;
  - `snapshots: { kind: "per-gb", … }` at 0.04 a GB, `serverSnapshotsOutliveServer: true`;
  - `deleteProtection: false`, `resize: false`, `removal: { kind: "delete" }`;
  - `firewallResourceType: "ionoscloud_firewall"`, with SecOps's `rules` and `attached` reading
    the planned rules and the NIC's `firewall_active` (decision 17);
  - `lifecycleIgnored` with the server's `image_name` and `ssh_keys` and the disk's `user_data`,
    which IONOS can't change after creation;
  - `tokenRules: []`, `envPrefixes: ["IONOS"]`;
  - the regions of decision 15, with their notes;
  - `unavailable` and `serverLimit` patterns from IONOS's words, unverified until the live pass;
  - every text in plain English, and the destroy texts say the data centre goes with everything in
    it and what may outlive it.
- **`module/` (`ionos-instance`)**, one per server (decision 13):
  - `ionoscloud_datacenter` named `opscrew-${var.name}` in `var.location`;
  - `ionoscloud_lan` with `public = true`, and `ionoscloud_ipblock` (size 1) whose address the NIC
    takes (decision 21);
  - `data "ionoscloud_image"` for Ubuntu 24.04 in that location, with cloud-init;
  - `ionoscloud_server` (`type = "VCPU"`, the size's cores and RAM, a label with the app), its boot
    volume (Essential, the size's disk, `user_data` = the cloud-config, base64-encoded if the
    provider doesn't encode it, which the implementer reads in the provider's source), `ssh_keys`
    with the deploy key, and its NIC on the LAN with `dhcp = true` and `firewall_active = true`;
  - one `ionoscloud_firewall` per allowed IPv4 network and port (`for_each`), never an inline list
    (R5 §2); the server has no IPv6, so IPv6 networks are left out of the rules;
  - the outputs the other modules have; `server_id` is `<datacenter id>/<server id>`.

### 14. IONOS's id joins the lists, and its variables never reach the agent (lead)

`ionos` in `ProviderId`, `VpsProviderId`, `VpsProviderSchema`, `DEFAULT_IMAGES`, `CLOUD_PROVIDERS`
(after `kamatera`), the plugin's credential lists and the lockfile, as for Kamatera.
`packages/core/src/env.ts` gains `IONOS_` among the prefixes the agent never gets.

### 15. The guide, the plugin, the live pass, and the tests (IONOS Cloud)

- `docs/guide/ionos.md` on `kamatera.md`'s model: business-only sign-up, the sub-user and token, the
  locations and the far mappings, EUR or USD, what keeps billing, what isn't offered.
- The plugin's deploy and snapshot skills, the MCP tools, `docs/e2e.md` and
  `packages/cli/test/live/ionos.test.ts` on one `vcpu-2-4` (about €0.04 an hour), never run without
  the founder's go-ahead.
- **Tests:** the client with `fetch` fakes (the bearer header, a request polled to `DONE` and to
  `FAILED`, each error status in plain English, no `post` retried, a leak check); the catalogue; the
  server API; the module (`tofu validate`, the firewall rules per network and port, no IPv6 rule);
  SecOps on an IONOS plan JSON; the registry over six definitions; every other provider's files
  byte-identical.

## Decisions (lead, 2026-11-21)

1. **`rootVariables` is a contract field, not a plan.yaml field.** The project id belongs with the
   credentials: the IAM policy scopes the service account to the project. A plan field would
   change plan-schema, design and the interview for one provider.
2. **Every OVHcloud server is `nameOnly`.** The takeover's shared message then says "without
   OpsCrew's tag", which reads oddly for a provider with no tags. Wording it per provider is a
   shared change that waits until users see it.
3. **No pre-plan availability check in provision** (research R2.8). The catalogue keeps
   unavailable offers out of design, and an apply refused anyway takes the existing path.
4. **One price table date** (2026-11-21), checked against the catalogue before each release, as
   Contabo's is.
6. **Design falls back to a dedicated type when no shared one holds the app** (found by T3510's
   tests). OVHcloud's shared d2 types hold at most 50 GB, so an app with PostgreSQL, which design
   sizes at 60 GB, had no option at all. `design/options.ts` now offers the dedicated type then,
   for every provider; Hetzner, DigitalOcean and Contabo always have a shared type that fits, so
   their options are unchanged. Lowering the disk floor for one provider would branch on its id.
   The live pass moves from `d2-2` (25 GB, below the 40 GB floor) to `d2-4`.
5. **Monthly billing, `ovh-ca` and `ovh-us`, automated backups, resizing and delete protection**
   are later, if users ask (research R2).

## Decisions for Kamatera (the contributor, 2026-11-24)

1. **The API front is the cloudcli proxy** (`https://cloudcli.cloudwm.com`): it is the front
   Kamatera's own Terraform provider and its MIT-licensed CLI use, it covers every route OpsCrew
   needs (servers, queue, snapshots, power, terminate), and its schema is public. The documented
   console API has a token step and no snapshot route. The live pass confirms each route; if one
   is missing, the console API is the fallback for it.
2. **The plans are OpsCrew's own ids** (`A-2-4`), mapped to Kamatera's CPU type, cores, memory and
   disk in the module. Kamatera sells a configuration, not a plan, and parsing a name in HCL would
   be fragile; the definition's offers and the module's map are kept equal by a test.
3. **`firstBoot` is an optional contract field**, `cloud-init` the default, so the other four
   providers' files and tests are untouched (issue #13).
4. **`disable_validations` stays off.** The provider's plan-time check reads Kamatera's public
   price file and is what refuses an unknown datacenter or plan; OpsCrew validates the datacenter
   itself too, and the duplicate check costs nothing but a network read. A machine without the
   network fails the plan with that address named.
5. **The live prices need no credentials**, because the calculator file is public. The catalog
   reads it once when reachable and shows `live`; it never blocks a design run.
6. **The firewall is the server's own**, installed by the first boot and checked by `secure`
   (issue #13, option A). The founder decides; the tasks that don't need it proceed meanwhile.
7. **Resize is refused**, because a disk change fails at Kamatera's API (issue #32) and a CPU or
   memory change's behaviour is unverified; a move is the way, as on OVHcloud.
8. **Billing counts by the second** in the contract, because Kamatera bills by the started minute
   (R4 §3); the difference in a shown estimate is under a cent.
9. **The root password is Kamatera's generated one**, kept in state and never read by OpsCrew; the
   SSH key is the way in, and the guide says the password is in the state on the user's computer.

10. **Servers are named as on every provider** (`<app>`, `<app>-<name>`), not
    `opscrew-<app>-<random>` (the lead, 2026-11-27), so the generic takeover and destroy keep finding
    them. A duplicate create shows as `<name>(n)`; `findAppServers` refuses to go on while one
    exists, naming it and its datacenter, which also stops destroy and snapshots until the user
    deletes it in the console.
11. **Kamatera's name rule** (4–40 letters, digits, dashes or dots) is checked by the module's
    `name` variable, so a plan fails with a plain message, not the provider's.
12. **No takeover of a lost server, for now** (known limit). `kamatera_server` imports by its
    internal UUID, and the connector reports servers by name, so the takeover's `import` fails at
    plan and creates nothing. Reporting UUIDs is a follow-up.
13. **No shared SSH-key resource:** Kamatera's servers take the deploy key's text, so
    `extraShared` declares nothing, which the registry accepts for that case only (issue #52).

## Decisions for IONOS Cloud (the contributor, 2026-11-27)

13. **One data centre per server**, made and deleted by the server's module (`opscrew-<server>`).
    A data centre costs nothing by itself (R5 §8), the module stays whole, and a destroy of a server
    deletes everything it used. A data centre shared by the app's servers would need root-level
    resources that move the first server when a second is added. Servers of one app reach each
    other over OpsCrew's WireGuard network, as across providers.
14. **A token only.** IONOS's Basic sign-in is being retired and needs an account without 2FA, so
    OpsCrew reads `IONOS_TOKEN` alone. The guide recommends a sub-user in a group with only "Create
    Data Center", "Create Snapshot" and "Reserve IP" (decision 21), because a token has no scope of
    its own.
15. **Every region maps** (the contract's map is complete): `eu-central` to `de/fra/1` (then
    `de/fra/2`, `de/txl`), `eu-north` to `de/txl` (Berlin, noted as far), `us-east` to `us/ewr`,
    `us-west` to `us/mci` (Lenexa, noted: Las Vegas has no vCPU servers), and `ap-southeast` to
    `de/fra/1` (noted: IONOS has no location in Asia or Oceania). The delay estimate shows the
    distance, so design ranks IONOS low there.
16. **vCPU servers on an Essential disk only**, five sizes with at least 40 GB, since design sizes
    every app at 40 GB or more. Cubes can't be resized or snapshotted as block storage, and
    Dedicated Core is dearer; neither is offered now.
17. **The NIC firewall, not a security group.** It is documented, its Terraform resource is read,
    and an active firewall with no rule blocks everything (R5 §4), which fails closed. Security
    groups' resource names are unverified.
18. **EUR.** The contract holds one currency per provider; IONOS CLOUD GmbH's list is in EUR. A US
    contract pays in USD, which design and the guide say; a currency per account is a later
    contract change if users ask.
19. **No takeover of a lost server, for now** (known limit, as on Kamatera). A lost create leaves a
    data centre the state may not know; the takeover's import of a server needs its data centre's
    id too, which is a follow-up.
20. **No resize.** IONOS scales cores and memory up live, but down needs a reboot and a disk only
    grows (R5 §10); the first cut refuses a size change and says a move is the way.
21. **A reserved IPv4 address per server** (`ionoscloud_ipblock`, size 1, in the server's module),
    5 EUR per 30 days, in each size's price. IONOS gives a stopped server's dynamic address back to
    its pool and a start takes a new one (the Cloud API's stop and start pages, found by T3541), so
    a stop, by OpsCrew or in IONOS's console, would leave the app's DNS on an old address. A
    reserved address keeps it, with no special case for IONOS anywhere else.

## Order

`tasks.md` holds the order, the waves and each task's number. OVHcloud is T3501 to T3518, with
T3515 waiting for the founder. Kamatera is T3519 to T3537, stacked on OVHcloud's branch and
following it in the review queue. IONOS Cloud is T3538 to T3547, stacked on Kamatera's.
