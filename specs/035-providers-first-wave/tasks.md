---
description: "Tasks for 035-providers-first-wave"
---

# Tasks: More server providers, first wave (OVHcloud, Kamatera, IONOS Cloud)

**Status**: OVHcloud merged. Kamatera built on `035-kamatera` (T3519 to T3537, pull request #55).
IONOS Cloud specified 2026-11-27 on `035-ionos`, stacked on Kamatera's branch; its tasks are T3538
to T3547. UpCloud follows, with its own tasks added here when its work starts.

**Input**: `specs/035-providers-first-wave/` (spec.md, plan.md, research.md); feature 026 (the
contract, ADR 0029, and Contabo as the template).

**Numbering**: T3501–T3599 (T3500 is the lead's documents).

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Approvals:** nothing changes the safety gate. Every OVHcloud change is a plan approved by its
  hash. The connector's mutating calls are the ones `ServerSnapshotApi` already has.
- **Leaks:** none of the four OVHcloud values (the project id included), no address and no token
  in output, logs, audit entries, errors or fixtures. Every OVHcloud test file ends with a leak
  check.
- **Sources:** every request and answer shape comes from OVHcloud's published schemas
  (`https://eu.api.ovh.com/v1/cloud.json`, `https://eu.api.ovh.com/v2/publicCloud.json`) or the
  `ovh/ovh` provider's docs and source. Never guess an answer. Record what you read in the report;
  the lead moves it into research R1.
- **Words:** user-facing text says "OVHcloud", "your Public Cloud project" and "the control panel",
  and never names a task or a feature number.
- **No network in unit tests:** inject `fetch`. Module validation may download the provider and
  skips plainly without the network.
- **Temp files:** run tests with `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Scope:** build only what Accept asks. Report anything else.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Worktrees:** `D:/opscrew/.claude/worktrees/t35NN`, branched from `035-providers-first-wave`;
  `pnpm install --frozen-lockfile --prefer-offline` first.

**Kamatera's rules, for T3519 onward:**
- **Leaks:** none of `KAMATERA_API_CLIENT_ID` or `KAMATERA_API_SECRET` (and no address, no server
  id and no generated password) in output, logs, audit entries, errors or fixtures; fake values
  come from `fakeSecret(kind)`. Every Kamatera test file ends with a leak check.
- **Sources:** the public CLI schema `https://cloudcli.cloudwm.com/schema?supports=1.0.0`, the
  public calculator data `https://console.kamatera.com/info/calculator.js.php`, and the
  `Kamatera/kamatera` 0.9.4 provider's docs and source. Never guess a route or an answer; record
  what you read in the report, and the lead moves it into research R4.
- **Words:** user-facing text says "Kamatera", "your Kamatera account" and "its console", and never
  names a task or a feature number.
- **The API front:** `https://cloudcli.cloudwm.com` with `AuthClientId` and `AuthSecret` on every
  call (plan, decision 1). The console API is only a fallback for a route this front lacks, and
  the task that uses it says so in its report.
- **No cloud firewall:** never write text that claims one for Kamatera. Until T3526 lands, the plan
  says the firewall is on the server.

## Phase 1: Foundation (lead)

- [x] T3500 (lead) Research, spec, plan, tasks

- [x] T3501 (lead) The package's skeleton
  - Accept: `packages/providers/ovhcloud` with `package.json` (`@opscrew/provider-ovhcloud`, the
    same dependencies, scripts and `exports` as `@opscrew/provider-contabo`), `tsconfig.json`,
    `vitest.config.ts`, an empty `module/` folder, `src/index.ts` exporting nothing yet, and the
    lockfile regenerated. `pnpm check` is as green as before (see the baseline note in the PR).
  - Effort: lead

- [x] T3502 (lead; [issue #1](https://github.com/opscrew-hub/opscrew/issues/1) and step 1 of
  [issue #2](https://github.com/opscrew-hub/opscrew/issues/2), both approved by the core's lead on
  2026-11-21) The contract's `rootVariables` and `importId`, and `ovhcloud` in `ProviderId`
  - Accept:
    - `ProviderTerraform.rootVariables?` and `importId?` exactly as plan 1., exported from
      `@opscrew/contracts`.
    - `"ovhcloud"` in `ProviderId` only, which the catalogue and connector need (nothing reads
      it until T3510). `VpsProviderId` joins with plan-schema's target enums in T3510, since
      design and the interview read it against them.
    - ADR 0029 gains D11.
    - The typecheck is green, with any exhaustive switch the new id leaves over fixed.
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [x] T3503 [P] [US4] The registry validates `rootVariables`
  - Owns: `packages/providers/registry/src/validate.ts`, `validate.test.ts`
  - Reads: plan 1. and 2.; `validate.ts`; `packages/contracts/src/provider.ts`
  - Depends: T3502
  - Accept:
    - A definition without `rootVariables` validates as today.
    - Each root variable's `name` is an HCL identifier (`^[a-z][a-z0-9_]*$`), collides with no
      server variable (`location`, `server_type`, `image`, `backups`, `delete_protection`, with or
      without a prefix ending in `_`), and isn't repeated within the definition.
    - Its `fromEnv` is one of the definition's `credentials.envVars`, and its `description` isn't
      empty.
    - Each failure names the provider, the variable and what is wrong, as the validator's other
      messages do.
    - A test also checks across `CLOUD_PROVIDERS` that no two providers declare the same root
      variable name.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/providers && npx vitest run --root packages/providers/registry && pnpm lint`
  - Effort: medium

- [x] T3504 [P] [US4] iac-templates declares a provider's root variables
  - Owns: `packages/iac-templates/src/infra/**` (and its tests and snapshots)
  - Reads: plan 1. and 2.; `infra/servers.ts` (`serverVariables`, `providerBlock`, `renderedServers`),
    `infra/index.ts`, where `terraform.tfvars.json` is written
  - Depends: T3502
  - Accept:
    - A root that renders at least one server (the app's, the previous one during a move, or an
      extra one) of a provider with `rootVariables` declares each one once: `type = string`, its
      description, no default, and **not** `sensitive`. An `import` block's `id` can't be
      sensitive (plan 2.).
    - No value for it is ever written to `terraform.tfvars.json` or any other rendered file.
    - `takeover.ts`'s `import` block writes `id = <provider.terraform.importId(id)>` when the
      provider has `importId`, and `id = "<id>"` otherwise. The id check (`SERVER_ID`) still runs
      on the server id before it is passed.
    - A test under `tofu` (and `terraform` where installed, skipping plainly otherwise) plans a
      root with such an `import` block whose id reads the root variable from `TF_VAR_*`.
    - Every existing snapshot and output for Hetzner, DigitalOcean and Contabo is byte-identical.
    - Tests use a definition fake with one root variable, since OVHcloud isn't in the registry yet:
      the declaration appears once for two servers of that provider, and is absent without them.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates && pnpm lint`
  - Effort: high

- [x] T3505 [P] [US4] The engine gets each root variable from the environment
  - Owns: `packages/agents/src/shared/engine.ts`, `engine.test.ts`
  - Reads: plan 2.; `shared/engine.ts` (`projectEngine`, `NOT_FOR_THE_ENGINE`), `shared/root-variables.ts`
  - Depends: T3502
  - Accept:
    - For every built-in provider's root variables, `projectEngine` sets `env["TF_VAR_" + name]`
      from `env[fromEnv]` when that is set, and registers the value with the redactor. It changes
      nothing when it isn't set.
    - Tested with a registry where a provider has one root variable (inject or fake as the package's
      tests already do; report if the registry can't be faked).
    - List every engine run in `packages/agents/src` that doesn't get its environment from
      `projectEngine` (grep `engine.plan(`, `engine.apply(`, `engine.init(`, `engine.destroy(`,
      `stateResources(`). Cover those you own, and report the others with their file and line.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/shared && pnpm lint`
  - Effort: medium

- [x] T3506 [P] [US1] OVHcloud's API client
  - Owns: `packages/providers/ovhcloud/src/client.ts`, `client.test.ts`, `src/__fixtures__/**`
  - Reads: plan 3.; research R1 sections 1 and 10, and R2.4; `packages/providers/contabo/src/client.ts`
    and its tests (the template); go-ovh's `ovh/ovh.go`, `configuration.go` and `error.go`
  - Depends: T3501
  - Accept:
    - `OVHCLOUD_ENV` names the four variables. Reading them registers each with the redactor. A
      missing one is named, and an `OVH_ENDPOINT` other than `ovh-eu` is refused before any call
      with a message naming `ovh-eu`.
    - An OAuth2 client-credentials token from `https://auth.eu.ovhcloud.com/oauth2/token` (scope
      `all`), cached until it expires and fetched again once on a 401.
    - `get`, `post`, `put` and `delete` against the v1 and v2 bases, every answer parsed with a zod
      schema the caller passes.
    - Errors (`class`, `message`, `details`) become `OpsCrewError`s in plain English that say what
      to do:
      - a missing IAM right names the action;
      - a 404 on the project says to check `OVH_CLOUD_PROJECT_SERVICE`;
      - a 429 retries reads once after `Retry-After`.
    - A `post` is never retried.
    - Tests with `fetch` fakes cover each rule, and a leak check shows no value in any error or
      request log.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: high

## Phase 3: Wave 2

- [x] T3507 [P] [US1] [US3] The catalogue and the price table
  - Owns: `packages/providers/ovhcloud/src/catalog.ts`, `catalog.test.ts`, `static-prices.ts`, its
    fixtures under `src/__fixtures__/catalog*`
  - Reads: plan 3.; research R1 sections 7 and 8, and R2.3; `packages/contracts/src/connector.ts`
    (`ComputeCatalog`, `ComputeOffer`, `ProviderExtras`); Contabo's and Hetzner's catalogue
  - Depends: T3506
  - Accept:
    - Static: the five plans of plan 3. with the 2026-11-21 prices, each offered in every mapped
      location, `billing: "hourly"`, `hourly`, `monthly` = hourly × 730, no `setupFee`,
      `source: "static"`, the table's date.
    - Live, with credentials: the public catalogue parsed from a trimmed fixture of its real shape
      (prices in 1e-8 EUR, `<flavor>.consumption`, `blobs.technical`), crossed with
      `reference/productAvailability`. `available` is false where the region isn't activated,
      the stock is `OUT_OF_STOCK` or the quota is `INSUFFICIENT`. The catalogue is read once per
      catalogue object.
    - A failed live read falls back to the static table with a warning.
    - `extras(location)`: the snapshot rate per GB a month and an hour, with no IPv4 line.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: high

- [x] T3508 [P] [US1] [US2] [US3] The server API and the connector
  - Owns: `packages/providers/ovhcloud/src/servers.ts`, `servers.test.ts`, `connector.ts`,
    `connector.test.ts`, their fixtures
  - Reads: plan 3.; research R1 sections 5, 8, 9 and 10; `ServerSnapshotApi` and `VpsConnector`
    in `packages/contracts/src/connector.ts`; `packages/agents/src/provision/takeover.ts` (how
    `nameOnly` is used); Contabo's `servers.ts` and `connector.ts`
  - Depends: T3506
  - Accept:
    - `findAppServers(app)` returns the project's instances named exactly `app` or `app-<name>`,
      each with `nameOnly: true`.
    - Snapshots:
      - `snapshotServer` names the snapshot `opscrew-<app>-<server id>-<time>` and waits until it
        is complete;
      - `listSnapshots` lists by that prefix, oldest first, with sizes where known;
      - `deleteSnapshot` waits until it is gone.
    - Power and rebuild:
      - `rebuild` reinstalls from the snapshot and waits;
      - `powerOff` stops and waits for `SHUTOFF`, never forcing;
      - `powerOn` starts and waits for `ACTIVE`;
      - `restart` does a soft reboot;
      - `reinstall` uses the image and user data.
    - Every wait has a timeout with a plain message, and the clock and sleep are injected.
    - The connector: `configured`, `catalog()`, `servers` (undefined without credentials), and
      `verifyCredentials`. The latter reads the project and lists its activated regions, with the
      control panel's path to activate another; confirm the path in OVHcloud's docs.
    - A test with the generic takeover's inputs shows that a create which timed out leaves a
      server `findAppServers` reports, so a second provision takes it over rather than creating
      one (SC-3502). Report if that needs the agents' fakes.
    - Each API call's v1 or v2 choice is listed in the report.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: xhigh

- [x] T3509 [US1] [US2] [US3] The definition and the module
  - Owns: `packages/providers/ovhcloud/src/definition.ts`, `definition.test.ts`, `src/index.ts`,
    `module/**`, `src/generated/**`
  - Reads: plan 3.; research R2 in full; `packages/contracts/src/provider.ts`; Contabo's and
    Hetzner's `definition.ts`, `definition.test.ts` and `module/`; `scripts/gen-provider-modules.ts`;
    the `ovh/ovh` docs for `ovh_cloud_instance`, `ovh_cloud_ssh_key`, `ovh_cloud_security_group`,
    `ovh_cloud_instance_flavors` and `ovh_cloud_instance_images`
  - Depends: T3502, T3507, T3508
  - Accept:
    - `definition` as plan 3., including `rootVariables`, regions, offering, Terraform and every
      text, validated by `validateCloudProvider` in the test (import the registry's validator as
      Contabo's test does, or report how).
    - The module `ovhcloud-instance`:
      - the flavor and image resolved by name per region;
      - the security group with Hetzner's rules, set explicitly on the instance;
      - the SSH key shared through `extraShared`;
      - `user_data` from the shared cloud-init, and `lifecycle.ignore_changes` on `user_data`,
        `image_id` and `ssh_key_name`;
      - the usual outputs.
    - `src/generated/module.ts` is regenerated with `pnpm gen:provider-modules`.
    - SecOps reads the group's rules and its attachment, tested on a plan JSON fixture: attached;
      not attached; and an instance left on the default group is reported as not attached.
    - The module validates and passes `fmt -check` under `tofu` (and `terraform` where installed),
      skipping plainly without the network, as Contabo's test does.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && OPSCREW_IT=1 npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: xhigh

- [x] T3510 (lead; step 2 of [issue #2](https://github.com/opscrew-hub/opscrew/issues/2), approved
  2026-11-21; its step 1 is in T3502) `ovhcloud` joins the lists and the registry
  - Accept:
    - `ovhcloud` in `VpsProviderId`, `VpsProviderSchema`, `DEFAULT_IMAGES` (`"Ubuntu 24.04"`)
      and the generated schemas.
    - `CLOUD_PROVIDERS` after Contabo, with the registry's and the CLI's dependencies and the
      lockfile.
    - Any exhaustive switch left over is fixed.
    - `npx opscrew providers --json` lists it, with its labels, `signupUrl` and `pricingUrl`
      (`packages/agents/src/providers/catalogue.test.ts`).
    - The Codex plugin's two copies of the credential list follow OVHcloud's variables:
      `plugin/.codex-plugin/plugin.json`'s `mcpServers.opscrew.env_vars` and the TOML in
      `docs/guide/mcp-clients.md` (`packages/cli/src/mcp-clients/codex-plugin.test.ts`), as the
      core's lead asked in issue #2.
    - `pnpm check` passes, or the failures are only the environment's, named in the PR.
  - Effort: lead

- [x] T3516 (lead, after [issue #5](https://github.com/opscrew-hub/opscrew/issues/5), opened
  2026-11-21; before T3510) The SSH key check and the deploy-key match read any provider's shape
  - Found by T3509: `ovh_cloud_instance` takes `ssh_key_name`, and `ovh_cloud_ssh_key` has no `id`.
  - Accept:
    - `ProviderSecOps.sshKeyAttribute?` in the contract, default `"ssh_keys"`, read by
      `packages/secops/src/policies/plan.ts`. OVHcloud's definition sets `"ssh_key_name"`.
    - `packages/agents/src/rotate/infra.ts`' `DEPLOY_KEY_TYPES` matches `<address>.`, not only
      `<address>.id`.
    - Tests for both. Hetzner, DigitalOcean and Contabo are unchanged.
  - Effort: lead

- [x] T3517 [US2] Destroy and a move's finish name the whole-server snapshots that outlive the
  server ([issue #7](https://github.com/opscrew-hub/opscrew/issues/7), approved 2026-11-21)
  - Owns: `packages/agents/src/destroy/**`, `packages/agents/src/retarget/finish.ts` and their
    tests
  - Reads: spec US2, FR-3510; the issue's four points; `destroy/deletion.ts`
    (`remainingAfterDeletion`), `destroy/run.ts`, `retarget/finish.ts`; `ServerSnapshotApi`
  - Accept:
    - **Read once:** for each server being deleted at a provider with
      `offering.serverSnapshotsOutliveServer`, `listSnapshots(serverId)` is read once, before the
      approval, and reused for "What remains". It is never read again after the deletion.
    - **Named in full:** each snapshot is named in the plan's summary, the approval text and "What
      remains", with `snapshotRef` and `snapshotBilling`, once each. The one destroy takes or
      reuses (`snapshotId`) isn't repeated.
    - **Passed in:** the list goes into `remainingAfterDeletion` as a field (`earlierSnapshots`).
      `retarget/finish.ts` passes it the same way, through the same helper, when it deletes the
      old server.
    - **Unreadable list:** one plain line through the reporter, naming `texts.console`, and the
      removal goes on.
    - **Deletes nothing:** OpsCrew still deletes no snapshot at a destroy.
    - **Tests** with each provider's fake. Output without such snapshots is unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/destroy src/retarget && pnpm lint`
  - Effort: high

- [x] T3518 [US1] [US3] OVHcloud through OpsCrew's own flows, with fakes (T3514's review)
  - Owns: new or extended tests under `packages/agents/src/**` and `packages/cli/test/live/**`;
    `packages/providers/ovhcloud/src/servers.test.ts`;
    `packages/iac-templates/src/infra/root-variables.test.ts`;
    `packages/agents/src/destroy/destroy.test.ts`
  - Reads: spec SC-3501, SC-3502, SC-3505, FR-3504 (as reworded); ADR 0029 D11;
    `packages/agents/src/testing/deploy.ts` (the OVHcloud target), `testing/destroy.ts`
    (`FakeServers`); `packages/agents/src/provision/takeover.test.ts`
  - Accept:
    - **SC-3501 with fakes:** one flow test in agents on an OVHcloud app (`testing/deploy.ts`'s
      target, the fake engine and `FakeServers`) that runs provision, verify, status, secure,
      drift, `snapshot --server` and its `restore --server`, and asserts:
      - the engine gets `TF_VAR_ovhcloud_project_id` and the root declares the variable;
      - no rendered or committed file holds the project id's value;
      - SecOps's checks run on `ovh_cloud_instance` and pass;
      - snapshot and restore go through `ServerSnapshotApi`;
      - a leak check of the four values at the end.
    - **SC-3502 in agents:** an OVHcloud case in `provision/takeover.test.ts`: a create that timed
      out, then a second provision that takes the instance over. `main.tf` holds
      `id = "${var.ovhcloud_project_id}/<id>"` and never the project id itself. The copy of the
      takeover's choice in `servers.test.ts` is deleted.
    - **Cleanups:**
      - `root-variables.test.ts`'s stale comment is fixed, with one assertion on the real
        OVHcloud definition;
      - `destroy.test.ts` ~2278's project-id-shaped literal becomes `fakeSecret(...)`;
      - the live test's header price is €0.0206 (d2-4);
      - the live test's leak scan keeps checking state files and saved plans for the client id
        and secret, but not the project id (FR-3504).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/provider-ovhcloud --filter=@opscrew/iac-templates && npx vitest run --root packages/agents src/provision src/destroy && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: high

## Phase 4: Wave 3 (parallel)

- [x] T3511 [P] [US5] The guide
  - Owns: `docs/guide/ovhcloud.md`, and OVHcloud's lines in `docs/prices-compared.md`,
    `docs/guide/snapshots.md`, `retarget.md` and `credential-rotation.md`
  - Reads: spec US5; research R2 and R3; `docs/guide/contabo.md` (the model); README's provider
    list (report its line for the lead)
  - Depends: T3510
  - Accept:
    - The page covers what spec US5.1 lists: the project, the service account and its IAM policy
      limited to the project, `OVH_ENDPOINT=ovh-eu`, the regions to activate, billing by the hour
      and what keeps billing, and what isn't offered.
    - It also says that the vendored HCL needs `TF_VAR_ovhcloud_project_id` without OpsCrew.
    - The other pages list OVHcloud where they list Contabo.
    - `docs/guide/index.md` waits for its issue (report the line to add).
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T3512 [P] [US5] The plugin's skills and the MCP text
  - Owns: `plugin/**`, `packages/mcp-server/src/**` (text only)
  - Reads: spec US5.3; how 026's T2618 added Contabo
  - Depends: T3510
  - Accept: the MCP tools accept `ovhcloud` wherever they accept a cloud provider (from the
    registry, as today), and the deploy and snapshot skills say what differs on OVHcloud.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

- [x] T3513 [P] [US5] The live test and its steps
  - Owns: `packages/cli/test/live/ovhcloud.test.ts`, OVHcloud's section of `docs/e2e.md`
  - Reads: `packages/cli/test/live/contabo.test.ts`, `docs/e2e.md`'s Contabo section, spec SC-3507
  - Depends: T3510
  - Accept:
    - The test runs only with `OPSCREW_E2E_OVHCLOUD=1` and the four variables. It goes through the
      flow of SC-3501 on one `d2-4` and ends with a scan for the four values.
    - `docs/e2e.md` gives the steps, the variables, the IAM policy and the cost (under €0.05 an
      hour, and what stays after the destroy).
    - It is never run in this task.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: medium

## Phase 5: Finish (lead)

- [x] T3514 (lead) A fresh review of the whole branch, `pnpm check`, research R1 updated with the
  implementers' findings, then the pull request (OVHcloud's)
- [ ] T3515 The live pass, on the contributor's own OVHcloud account, just before the release that
  ships OVHcloud, when the founder is asked ([#3](https://github.com/opscrew-hub/opscrew/issues/3),
  [#14](https://github.com/opscrew-hub/opscrew/issues/14)). It costs money. After the destroy, the
  test proves nothing of the app is left (servers, snapshots, SSH keys, security groups), and its
  findings tighten `offering.unavailable` to OVHcloud's real wording.

## Phase 6: Kamatera

- [x] T3519 (lead) The package's skeleton
  - Accept: `packages/providers/kamatera` with `package.json` (`@opscrew/provider-kamatera`, the
    same dependencies, scripts and `exports` as `@opscrew/provider-contabo`), `tsconfig.json`,
    `vitest.config.ts`, an empty `module/` folder, `src/index.ts` exporting nothing yet, and the
    lockfile regenerated. `pnpm check` is as green as before.
  - Effort: lead

- [x] T3520 (lead; the contract question of [issue #13](https://github.com/opscrew-hub/opscrew/issues/13))
  The contract's `firstBoot`
  - Accept:
    - `ProviderTerraform.firstBoot?: "cloud-init" | "script"` exactly as plan 7., exported from
      `@opscrew/contracts`.
    - ADR 0029 gains D12: why Kamatera needs it, and that both kinds render the same steps.
    - The registry accepts both values and rejects any other.
    - The typecheck is green, and no other provider's file changes.
  - Effort: lead

- [x] T3521 [P] [US6] iac-templates renders the first-boot script (built 2026-11-24; reviewed with the whole branch in T3532)
  - Owns: `packages/iac-templates/src/infra/**` (and its tests and snapshots)
  - Reads: plan 7.; `infra/cloud-init.ts` (the context and the template), `infra/servers.ts`
    (where `cloud-init.yaml.tftpl` is added), `infra/index.ts`
  - Depends: T3520
  - Accept:
    - A root with a `firstBoot: "script"` provider gets `first-boot.sh.tftpl` **beside**
      `cloud-init.yaml.tftpl`: the wrapper can't carry the key or the web flag, which only
      `templatefile` knows at apply time, so the module renders the cloud-config, base64-encodes
      it and passes the wrapper to the startup script. A provider whose `firstBoot` is absent or
      `cloud-init` gets no wrapper and no other change.
    - The script is rendered from the same context as the cloud-init one, and it:
      - guards itself with a marker (`/var/lib/opscrew/first-boot.done`), so a second run changes
        nothing;
      - installs cloud-init when the image lacks it, writes the cloud-config to
        `/var/lib/cloud/seed/nocloud-net/user-data`, and runs `cloud-init clean`, `init --local`,
        `init` and `modules --mode=final`;
      - holds no secret and quotes its values as the cloud-init template does.
    - `sh -n` passes on the rendered script, and a test asserts the cloud-init and script
      renderings carry the same steps (the deploy user, its key, the packages and the commands).
    - Every existing snapshot and every other provider's output is byte-identical.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates && pnpm lint`
  - Effort: high

- [x] T3522 [P] [US6] Kamatera's API client
  - Owns: `packages/providers/kamatera/src/client.ts`, `client.test.ts`, `src/__fixtures__/**`
  - Reads: plan 8.; research R4 §1 and §10; plan decision 1; `packages/providers/contabo/src/client.ts`
    and `packages/providers/ovhcloud/src/client.ts` (the templates); the public CLI schema
  - Depends: T3519
  - Accept:
    - `KAMATERA_ENV` names `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET`, and
      `KAMATERA_API_URL` overrides the base only. Reading the two registers both with the
      redactor, and a missing one is named before any call.
    - Every call carries `AuthClientId` and `AuthSecret`; every answer is parsed with a zod schema
      the caller passes.
    - A queued command (`{ id }` or `[id]`) is awaited through `GET /service/queue?id=`, with the
      clock and sleep injected and a timeout carrying a plain message. A command whose status is
      `error` fails with its `log`.
    - An HTTP 500 body's `message` and `errors[].info` become an `OpsCrewError` that says what to
      do; a 404 says the server or the route wasn't found; no `post` is ever retried.
    - Tests with `fetch` fakes cover each rule, and a leak check shows neither value in any error,
      log or fixture.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-kamatera && npx vitest run --root packages/providers/kamatera && pnpm lint`
  - Effort: high

- [x] T3523 [P] [US6] [US8] The catalogue and the price table
  - Owns: `packages/providers/kamatera/src/catalog.ts`, `catalog.test.ts`, `static-prices.ts`, its
    fixtures under `src/__fixtures__/catalog*`
  - Reads: plan 8.; research R4 §3, §5 and §7; plan decision 5; `ComputeCatalog`, `ComputeOffer`
    and `ProviderExtras` in `packages/contracts/src/connector.ts`; Contabo's catalogue
  - Depends: T3522
  - Accept:
    - Static: the six plans of plan 8. with the 2026-11-22 table, in USD, offered in every mapped
      datacenter, `billing: "hourly"`, `hourly` = `monthly / 730`, no `setupFee`,
      `source: "static"`, the table's date.
    - Live: the public calculator file read once per catalogue when reachable, updating the
      prices and saying `source: "live"`; a failed read keeps the table without a warning, since
      it is the same data.
    - `extras(location)`: the snapshot rate, the extra IPv4, the traffic allowance and its overage
      rate, and the stopped-server rate.
    - No availability is claimed per account; a refusal at apply takes the generic path.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-kamatera && npx vitest run --root packages/providers/kamatera && pnpm lint`
  - Effort: high

- [x] T3524 [P] [US6] [US7] The server API, the `<name>(1)` guard and the connector
  - Owns: `packages/providers/kamatera/src/servers.ts`, `servers.test.ts`, `connector.ts`,
    `connector.test.ts`, their fixtures
  - Reads: plan 8.; research R4 §2, §8, §9 and §10; `ServerSnapshotApi` and `VpsConnector` in
    `packages/contracts/src/connector.ts`; `packages/agents/src/provision/takeover.ts` (how
    `nameOnly` is used); Contabo's `servers.ts` and `connector.ts`
  - Depends: T3522
  - Accept:
    - `findAppServers(app)` returns the account's servers named exactly `app` or `app-<name>`,
      each with `nameOnly: true`, and the server's id is its name.
    - A name check for the app's server reports:
      - a server already named exactly as the plan means to create it (`opscrew-<app>-<random>`);
      - a `<name>(1)` server, naming it and its datacenter, and never adopting it silently.
    - Snapshots: created, listed by the `opscrew-<app>-<server>-<time>` prefix oldest first, and
      deleted; each waits for its command.
    - Power: `powerOn`, `powerOff` (never forcing) and `restart`, each awaited; `rebuild` reverts
      the server to the snapshot (Kamatera's snapshot revert; the lead, 2026-11-27); `reinstall`
      is absent.
    - The connector: `configured`, `catalog()`, `servers` (undefined without credentials), and
      `verifyCredentials`, which reads the account's servers and a datacenter's options and says
      what it found. No `firewalls`, `backups` or `objectStorage`.
    - Every wait has a timeout with a plain message, and the clock and sleep are injected.
    - Each API route's source (the CLI schema or the console documentation) is listed in the
      report.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-kamatera && npx vitest run --root packages/providers/kamatera && pnpm lint`
  - Effort: xhigh

- [x] T3525 [US6] [US7] [US8] The definition and the module
  - Owns: `packages/providers/kamatera/src/definition.ts`, `definition.test.ts`, `src/index.ts`,
    `module/**`, `src/generated/**`
  - Reads: plan 8. and 9.; research R4 in full; `packages/contracts/src/provider.ts`; Contabo's and
    Hetzner's `definition.ts`, `definition.test.ts` and `module/`; `scripts/gen-provider-modules.ts`;
    `Kamatera/kamatera` 0.9.4's docs and `kamatera/*.go`
  - Depends: T3519, T3521, T3522, T3523, T3524
  - Accept:
    - `definition` as plan 8., including `firstBoot: "script"`, `sshKeyAttribute`, the regions, the
      offering and every text, validated by `validateCloudProvider` in the test.
    - The module `kamatera-instance`:
      - `locals.plans` maps each OpsCrew plan id to Kamatera's `cpu_type`, `cpu_cores`, `ram_mb`
        and `disk_sizes_gb`, and a test keeps the map and the offers equal;
      - the image resolved by `data "kamatera_image"` with `os` and `code` from the definition;
      - `kamatera_server` with the plan's CPU, memory and disks, `billing_cycle = "hourly"`, the
        key's text from `var.deploy_ssh_public_key`, `startup_script = file(...)`,
        `daily_backup = false`, `power_on = true` and `allow_recreate = false`;
      - `lifecycle.ignore_changes` on `image_id`, `ssh_pubkey` and `startup_script`;
      - no password argument, so the provider generates one and OpsCrew never reads it;
      - the usual outputs, with `server_id` equal to the server's name.
    - `src/generated/module.ts` is regenerated with `pnpm gen:provider-modules`.
    - SecOps reads the key from `ssh_pubkey` and passes on the plan JSON fixture. The firewall
      check is T3526, not this task.
    - The module validates and passes `fmt -check` under `tofu` (and `terraform` where installed),
      skipping plainly without the network.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-kamatera && OPSCREW_IT=1 npx vitest run --root packages/providers/kamatera && pnpm lint`
  - Effort: xhigh

- [x] T3526 (lead; the founder chose option A on
  [issue #13](https://github.com/opscrew-hub/opscrew/issues/13), 2026-11-25) The server firewall
  and SecOps's check of it
  - Owns: `packages/contracts/src/provider.ts` (`ProviderSecOps.firewallCheck`),
    `packages/secops/src/policies/**` and its tests, `packages/agents/src/**` (the post-boot
    check), `packages/providers/kamatera/src/definition.ts` and `module/first-boot` (the rules)
  - Reads: the issue's option A; plan 8.; ADR 0029 D8 and D11; how `secure` runs its checks today
  - Depends: T3525
  - Accept (the founder's conditions on #13):
    - **First:** the firewall is the first step of the first boot, before anything else runs:
      nftables for IPv4 and IPv6, default deny inbound, loopback and established/related allowed,
      22 only from `security.sshAllowedCidrs`, 80/443 as `security.httpAllowedFrom` says
      (Cloudflare's ranges when proxied), WireGuard's port only where the plan uses it.
    - **Kept across reboots:** the rules are persisted (the live pass checks it).
    - **Key-only from the same step:** if the image comes with a root password or password SSH,
      the same step turns password logins off.
    - `ProviderSecOps.firewallCheck?: "cloud" | "server"`, default `"cloud"`; the other four
      providers are unchanged.
    - With `"server"`, `firewall-attached` passes only when the planned server's
      `startup_script` holds the firewall marker, and `opscrew secure` reads the server's
      nftables rules over SSH and fails until they are default deny with the allowed SSH, web and
      WireGuard ports.
    - The plan, the design summary and the guide say "cloud firewall: none; server firewall: on",
      and name the boot-to-script gap.
    - Tests: a script with the rules passes, one without fails, and `secure` fails on a server
      whose rules were changed.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/secops --filter=@opscrew/agents --filter=@opscrew/provider-kamatera && npx vitest run --root packages/secops && npx vitest run --root packages/agents src/secure && pnpm lint`
  - Effort: xhigh

- [x] T3527 (lead; [issue #15](https://github.com/opscrew-hub/opscrew/issues/15)) `kamatera` joins
  the lists and the registry (`ProviderId` first, done 2026-11-26, so T3523 and T3524 typecheck)
  - Accept:
    - `kamatera` in `ProviderId`, `VpsProviderId`, `VpsProviderSchema` and `DEFAULT_IMAGES`
      (`"Ubuntu 24.04"`).
    - `CLOUD_PROVIDERS` after `ovhcloud`, with the registry's and the CLI's dependencies and the
      lockfile.
    - Any exhaustive switch left over is fixed.
    - `npx opscrew providers --json` lists it, with its labels, `signupUrl` and `pricingUrl`.
    - The Codex plugin's two credential lists gain `KAMATERA_API_CLIENT_ID` and
      `KAMATERA_API_SECRET`.
    - `pnpm check` passes, or the failures are only the environment's, named in the PR.
  - Effort: lead

- [x] T3528 [P] [US6] The agent's environment leaves out Kamatera's variables
  - Owns: `packages/core/src/env.ts`, `env.test.ts`
  - Reads: commit 59e65a49 (the same change for `OVH_`), the issue beside it
  - Accept: `KAMATERA_` and `CLOUDCLI_` join the prefixes the agent's environment never gets, with
    a test; the other prefixes and every caller are unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/core && npx vitest run --root packages/core && pnpm lint`
  - Effort: medium

- [x] T3529 [P] [US9] The guide
  - Owns: `docs/guide/kamatera.md`, and Kamatera's lines in `docs/prices-compared.md`,
    `docs/guide/snapshots.md`, `retarget.md` and `credential-rotation.md`
  - Reads: spec US9; research R4; `docs/guide/contabo.md` (the model); README's provider list
    (report its line for the lead)
  - Depends: T3527
  - Accept:
    - The page covers what spec US9.1 lists: the key and its lack of scope, the datacenter
      mapping, billing by the minute and what keeps billing, the traffic allowance, and what isn't
      offered (a cloud firewall OpsCrew manages, provider backups, resizing, delete protection,
      monthly billing).
    - It says the console firewall can be turned on as a second layer OpsCrew doesn't manage, and
      that the root password sits in the state.
    - The other pages list Kamatera where they list Contabo.
    - `docs/guide/index.md` waits for its issue (report the line to add).
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T3530 [P] [US9] The plugin's skills and the MCP text
  - Owns: `plugin/**`, `packages/mcp-server/src/**` (text only)
  - Reads: spec US9.3; how T3512 added OVHcloud
  - Depends: T3527
  - Accept: the MCP tools accept `kamatera` wherever they accept a cloud provider (from the
    registry), and the deploy and snapshot skills say what differs: no cloud firewall, a startup
    script, no resize, a stopped server that bills.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

- [x] T3531 [P] [US9] The live test and its steps
  - Owns: `packages/cli/test/live/kamatera.test.ts`, Kamatera's section of `docs/e2e.md`
  - Reads: `packages/cli/test/live/contabo.test.ts` and `ovhcloud.test.ts`, `docs/e2e.md`, spec
    SC-3513
  - Depends: T3527
  - Accept:
    - The test runs only with `OPSCREW_E2E_KAMATERA=1` and the two variables. It goes through the
      flow of SC-3508 on one `A-2-4` and ends with a scan for both values.
    - `docs/e2e.md` gives the steps, the variables and the cost (about $0.03 an hour, and what
      stays after the destroy).
    - It is never run in this task.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: medium

- [x] T3532 (lead) A fresh review of Kamatera's branch, `pnpm check`, research R4 updated with the
  implementers' findings, then its pull request, stacked on OVHcloud's
- [ ] T3533 (lead) The live pass, only with the founder's go-ahead (it costs money;
  [issue #14](https://github.com/opscrew-hub/opscrew/issues/14))

### The core lead's review of Kamatera's pull request ([#55](https://github.com/opscrew-hub/opscrew/pull/55))

- [x] T3534 [US6] An existing server's own firewall never drifts from the plan in silence (review points 1 and 2)
  - Owns: `packages/secops/src/policies/**`, `packages/agents/src/provision/**` (not `plan-json.ts`),
    `packages/agents/src/retarget/**`, `packages/agents/src/secure/server-firewall.ts` (and their tests)
  - Reads: ADR 0029 D13; `packages/iac-templates/shared/server-firewall.sh.tftpl` (its `ssh_sources`,
    `web_sources` and `wireguard_port` lines keep their form); the review on #55
  - Accept:
    - For a `firewallCheck: "server"` provider's server the plan doesn't create, SecOps parses the
      rules from the startup script in that resource change's `before` (policies see the masked plan,
      which has no `prior_state`) and compares them with the plan's `ssh_allowed_cidrs`,
      `http_allowed_cidrs` and the module call's `wireguard_port`. Any difference fails critical, with
      a plain next step. A missing or unreadable script fails critical too.
    - `provision` and `retarget` stop before any approval when the plan would change those networks
      on such a server that already exists, saying why (the rules are set at the first boot and
      OpsCrew can't change them in place yet) and what to do instead. A test proves each stops.
    - `secure`'s remediation no longer says that editing the tfvars and reloading fixes the rules. It
      says the rules are set at the first boot and can't be changed in place by OpsCrew yet. It says
      how to load them again as written (`systemctl restart opscrew-firewall.service`, which loads
      `/etc/opscrew/firewall.nft`, T3535), and what to do when the plan's networks really changed.
    - Every other provider's results and texts are unchanged.
  - Effort: high

- [x] T3535 [P] [US6] The server firewall's script and Kamatera's module harden (review points 3 to 8)
  - Owns: `packages/iac-templates/shared/**`, `packages/iac-templates/src/**` (and snapshots),
    `packages/providers/kamatera/**`
  - Accept:
    - The rules go to `/etc/opscrew/firewall.nft`, loaded by a oneshot `opscrew-firewall.service`
      that loads and deletes only `inet opscrew-firewall` (never `flush ruleset`).
      `nftables.service` is neither enabled nor touched.
    - After the ssh reload, `sshd -T` must show `passwordauthentication no` (and
      `kbdinteractiveauthentication no`), or the step fails closed.
    - The forward chain drops non-DNAT traffic from outside the server routed to `docker0` or `br-*`.
    - `variables.tf` validates each CIDR in `ssh_allowed_cidrs` and `http_allowed_cidrs` with
      `cidrhost`, and `wireguard_port` as empty or a port in 1 to 65535.
    - `power_on` is in `ignore_changes` and `terraform.lifecycleIgnored`.
    - `findAppServers` matches only the app's exact server names: `<app>`, and `<app>-<name>` for a
      name the plan gives, plus their `(n)` duplicates. A sibling app's `shop-staging` never matches
      `shop`.
    - The `ssh_sources=`, `web_sources=` and `wireguard_port=` lines keep their form (T3534 parses
      them).
  - Effort: high

- [x] T3536 [P] [US6] Kamatera's generated root password never leaves the state (review point 9)
  - Owns: `packages/agents/src/provision/plan-json.ts` (and its test), `packages/cli/test/live/kamatera.test.ts`
  - Accept:
    - `ALWAYS_MASKED` masks `kamatera_server`'s `generated_password` in resource changes, drift and
      planned values, whether or not the provider marks it sensitive. A test shows a plan JSON
      carrying it in `before`, `after` and `prior_state` keeps no trace of it once masked.
    - The pull request's answer names where raw plan JSON goes (the sidecar, policies, audit,
      prompts) and that each sees only the masked one; the task's report names the code for it.
  - Effort: medium

- [x] T3537 [US6] Kamatera's `findAppServers` matches only the plan's server names (review point 7,
  [#56](https://github.com/opscrew-hub/opscrew/issues/56))
  - Owns: `packages/contracts/src/connector.ts`, `packages/providers/kamatera/src/servers.ts` (and
    tests), the agents' callers of `findAppServers` (`destroy/`, `provision/plan-apply.ts`,
    `provision/takeover.ts`, `snapshot/`) and their tests
  - Accept:
    - `findAppServers(app, names?)`: `names` are the plan's server names. Kamatera, given them, keeps
      exactly those names and their `(n)` duplicates (the guard stays for exactly those); without
      them, it behaves as today. Every other provider ignores it, unchanged.
    - Each agents caller that has the plan passes its server names, from the one helper that
      already names servers (no new naming rule). A test: app `shop` with a sibling `shop-staging`
      and `shop-staging(1)` on the account finds neither, and its own `shop-<extra>` still.
  - Effort: high

## Phase 7: IONOS Cloud

IONOS Cloud is stacked on Kamatera's branch (`035-ionos`), plan 13. to 15. and decisions 13 to 20.
No contract change; the id joins the shared lists through [#63](https://github.com/opscrew-hub/opscrew/issues/63).

- [x] T3538 (lead; [#63](https://github.com/opscrew-hub/opscrew/issues/63)) The package's skeleton, and `ionos` in `ProviderId`
  - Accept:
    - `packages/providers/ionos` with `package.json` (`@opscrew/provider-ionos`, the same
      dependencies, scripts and `exports` as `@opscrew/provider-kamatera`), `tsconfig.json`,
      `vitest.config.ts`, an empty `module/`, `src/index.ts` exporting nothing yet, and the lockfile.
    - `ionos` in `ProviderId`, so the catalogue and the server API typecheck (`VpsProviderId`
      waits for T3543, with the schema it must match).
    - `pnpm check` is as green as before.
  - Effort: lead

- [ ] T3539 [P] [US10] IONOS's Cloud API client
  - Owns: `packages/providers/ionos/src/client.ts`, `client.test.ts`, `src/__fixtures__/client*`
  - Reads: plan 13.; research R5 §1 and §10; decision 14; Kamatera's and OVHcloud's `client.ts`
  - Depends: T3538
  - Accept:
    - `IONOS_ENV` names `IONOS_TOKEN`, and `IONOS_API_URL` overrides the base only. Reading the token
      registers it with the redactor, and a missing one is named before any call. `IONOS_USERNAME`
      and `IONOS_PASSWORD` are never read.
    - Every call carries `Authorization: Bearer`; every answer is parsed with a zod schema the
      caller passes.
    - A 202 is awaited through its request's status (`Location`, then `GET /requests/{id}/status`)
      with the clock and sleep injected, a timeout with a plain message, and the request's
      `message` on `FAILED`.
    - Errors from the body's `messages[]`: 401 (wrong or expired token, how to make one), 403 (the
      missing privilege), 404, 422 and a contract limit (named, and that support raises it), 429
      (reads wait, at most 60 seconds); no `post` is retried.
    - Each route's source (docs.ionos.com's Cloud API v6 pages) is listed in the report.
    - Tests with `fetch` fakes cover each rule, and a leak check shows the token in no error, log
      or fixture.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ionos && npx vitest run --root packages/providers/ionos && pnpm lint`
  - Effort: high

- [x] T3540 [P] [US10] [US12] The catalogue and the price table (built 2026-11-27; `extras()` has
  the snapshot rate only, since `ProviderExtras` has no traffic field: the 2 TB allowance and its rate
  are constants the texts and the guide quote, as on Kamatera)
  - Owns: `packages/providers/ionos/src/catalog.ts`, `catalog.test.ts`, `static-prices.ts`
  - Reads: plan 13.; research R5 §3, §5 and §7; decision 16; Kamatera's catalogue
  - Depends: T3538
  - Accept:
    - The five sizes of plan 13. in every mapped location, from the EUR list v2026-10-29, the
      hourly price from its parts (vCPU, RAM, the disk at its 30-day price over 720 hours), the
      730-hour figure, `billing: "hourly"`, no `setupFee`, `source: "static"`, the list's date.
    - `extras(location)`: the snapshot rate, and 2 TB of traffic a month per contract with the
      rate above it.
    - A test recomputes each size's price from the components.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ionos && npx vitest run --root packages/providers/ionos && pnpm lint`
  - Effort: medium

- [ ] T3541 [P] [US10] [US11] [US12] The server API and the connector
  - Owns: `packages/providers/ionos/src/servers.ts`, `servers.test.ts`, `connector.ts`,
    `connector.test.ts`, their fixtures
  - Reads: plan 13.; research R5 §5, §8 and §10; `ServerSnapshotApi` and `VpsConnector` in
    `packages/contracts/src/connector.ts` (with `findAppServers(app, names?)`, #56); Kamatera's
    `servers.ts` and `connector.ts`; docs.ionos.com's Cloud API v6 pages for data centres, servers,
    volumes and snapshots
  - Depends: T3539
  - Accept:
    - `findAppServers(app, names?)`: the data centres named `opscrew-<name>` for exactly `names`
      (without them, `opscrew-<app>` and `opscrew-<app>-…`), then their servers; an `AppServer`'s id
      is `<datacenter id>/<server id>`. A sibling app's `opscrew-shop-staging` is never `shop`'s
      when `names` is given.
    - Snapshots of the boot disk: created (named `opscrew-<app>-<server>-<time>`), listed by that
      prefix oldest first, restored and deleted, each awaited.
    - Power: `powerOn`, `powerOff` (IONOS's stop, never an OS shutdown) and `restart`, awaited.
    - The connector: `configured`, `catalog()`, `servers` (undefined without the token), and
      `verifyCredentials`, which reads the data centres and the contract's limits and says what it
      found. No `firewalls`, `backups` or `objectStorage`.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ionos && npx vitest run --root packages/providers/ionos && pnpm lint`
  - Effort: xhigh

- [ ] T3542 [US10] [US11] [US12] The definition, the module and SecOps's reading of its firewall
  - Owns: `packages/providers/ionos/src/definition.ts`, `definition.test.ts`, `src/index.ts`,
    `module/**`, `src/generated/**`
  - Reads: plan 13.; research R5 in full; decisions 13 to 20; `packages/contracts/src/provider.ts`;
    OVHcloud's and Kamatera's `definition.ts` and `module/`; `scripts/gen-provider-modules.ts`;
    `ionos-cloud/ionoscloud` 6.7.42's docs and source (`user_data`'s encoding, the firewall rule)
  - Depends: T3538, T3540, T3541
  - Accept:
    - `definition` as plan 13., validated by `validateCloudProvider` in the test, with the regions
      and notes of decision 15 and the texts in plain English.
    - The module `ionos-instance`: the data centre `opscrew-${var.name}`, the public LAN, the image
      by data source, the VCPU server with its label, its Essential boot volume (the size's disk,
      the cloud-config as `user_data` encoded as the provider needs, read from its source), its
      `ssh_keys`, its NIC with `firewall_active = true`, and one `ionoscloud_firewall` per IPv4
      network and port by `for_each`; no IPv6 rule; `lifecycle.ignore_changes` on what IONOS can't
      change; the usual outputs.
    - `locals.sizes` maps each size id to its cores, RAM and disk, and a test keeps it equal to the
      offers.
    - SecOps's `rules` and `attached` read the planned `ionoscloud_firewall` resources and the
      NIC's `firewall_active`; the plan JSON fixture passes, and fails with the firewall off or SSH
      open to everyone.
    - The module validates and passes `fmt -check` under `tofu`, skipping plainly without the
      network; `src/generated/module.ts` is regenerated.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ionos && OPSCREW_IT=1 npx vitest run --root packages/providers/ionos && pnpm lint`
  - Effort: xhigh

- [ ] T3543 (lead; [#63](https://github.com/opscrew-hub/opscrew/issues/63)) `ionos` joins the lists and the registry
  - Accept: as T3527, for `ionos` after `kamatera`, with `IONOS_TOKEN` in the plugin's credential
    lists (`plugin/.codex-plugin/plugin.json` `env_vars` and the TOML in
    `docs/guide/mcp-clients.md`), and `IONOS_` among the prefixes the agent's environment never gets
    (with its test). Approved on #63, 2026-11-27.
  - Effort: lead

- [ ] T3544 [P] [US13] The guide, the plugin and the MCP tools
  - Owns: `docs/guide/ionos.md`, IONOS's lines on the guide pages that list providers, the plugin's
    deploy and snapshot skills
  - Reads: plan 15.; spec US13; `docs/guide/kamatera.md`
  - Depends: T3542
  - Accept: spec US13 1. and 3.
  - Effort: medium

- [ ] T3545 [P] [US13] The live test and its steps
  - Owns: `packages/cli/test/live/ionos.test.ts`, IONOS's section of `docs/e2e.md`
  - Reads: `packages/cli/test/live/kamatera.test.ts`; plan 15.
  - Depends: T3542
  - Accept: the flow on one `vcpu-2-4` (about €0.04 an hour), the leak scan for the token, and the
    check after the destroy that no data centre `opscrew-<app>…` is left; never run in this task.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: medium

- [ ] T3546 (lead) A fresh review of IONOS's branch, `pnpm check`, research R5 updated with the
  implementers' findings, then its pull request, stacked on Kamatera's (the lead on #63: target it onto
  `035-kamatera`'s line, so `main` keeps 0.2.13's scope)

- [ ] T3547 (lead) The live pass, only with the founder's go-ahead (it costs money, and IONOS
  Cloud sells to businesses only)
