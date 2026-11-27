# Feature Specification: More server providers, first wave (OVHcloud, then Kamatera)

**Feature Branch**: `035-providers-first-wave` (feature directory `specs/035-providers-first-wave`)
**Created**: 2026-11-21
**Status**: OVHcloud built on `035-providers-first-wave`, its pull request open for review. Kamatera
specified 2026-11-24 on `035-kamatera`. IONOS Cloud and UpCloud are later phases of this feature.
**Input**: The roadmap's "035 More server providers, first wave" (the founder's order of
2026-11-20: OVHcloud first, then Kamatera, IONOS Cloud and UpCloud). Each provider is a package on
the cloud provider contract (ADR 0029), built in as Contabo is, and ships complete in its own pull
request before the next one starts. Research: [research.md](research.md). R1 has OVHcloud's facts,
R2 the lead's decisions for it, R3 what only its live pass can check, and R4 Kamatera's facts,
including the two findings that await a decision in issue #13.

## Why

OVHcloud is Europe's largest cloud provider, and many people moving off hosted platforms in Europe
already have an account there. OpsCrew can't create a server there today. Its Public Cloud is
billed by the hour, metered per second, so a removal stops the cost at once, unlike Contabo's
monthly terms. Its smallest server costs about €7.59 a month at the hourly rate.

The contract (ADR 0029) means adding it is one package plus its place in the built-in list. OVHcloud
still differs from the providers OpsCrew has in ways the user must see (R1):
- its servers live in a **Public Cloud project** the user creates, and each region must be
  activated on that project first;
- servers carry **no tags**, so OpsCrew finds an app's servers by their names;
- the project's **default firewall is open**, so OpsCrew always attaches its own;
- **snapshots outlive the server** and keep billing until they are deleted;
- a later change of the first-boot script or of the image **reinstalls the server and wipes its
  disk**.

Kamatera is smaller and cheaper to start on, with data centres in Europe, North America and Asia,
and an hourly rate that is exactly its monthly one divided by 730. Its smallest server costs $4 a
month. It differs in ways the user must see (R4), and two of them touch the safety model:
- it has a **firewall, but only in its console and off by default**, with no API, Terraform
  resource or CLI route, so the plan can't set or prove a cloud firewall. The only protection
  OpsCrew can install is a firewall on the server itself, set up at the first boot;
- there is **no user data**: the first boot is delivered as a **startup script**, and whether the
  image runs cloud-init at all is unverified;
- servers carry **no tags, and names are not unique**: a duplicate is renamed `<name>(1)`, which
  loses the server and leaves it billing;
- a **stopped server still bills** for its IP and disk; only a terminate ends the cost;
- its Terraform provider covers no **snapshot, backup, tag or SSH-key resource**, so whole-server
  snapshots go through the connector's API;
- an API **key cannot be scoped**, so it can do everything on the account.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy an app to an OVHcloud server (Priority: P1)

**Why this priority**: it is the feature's point, a server at Europe's largest cloud, billed by use.

**Independent Test**: the live pass on one `d2-4` goes through interview, design, provision,
deploy, verify, status, secure and drift, and the app answers on its domain. Until the founder's
go-ahead, the same flow runs against fakes of OVHcloud's API and the engine.

**Acceptance Scenarios**:

1. **Given** the four OVHcloud values in the environment (`OVH_ENDPOINT=ovh-eu`, `OVH_CLIENT_ID`,
   `OVH_CLIENT_SECRET` and `OVH_CLOUD_PROJECT_SERVICE`, the project's id), **When** the user runs
   `opscrew interview`, **Then** OpsCrew offers OVHcloud next to the other cloud providers, with
   the regions it serves. When only OVHcloud's values are set, it chooses OVHcloud without asking.
2. **When** the user runs `opscrew design`, **Then** the options show OVHcloud's plans (
   `d2-4` and `d2-8`, shared; `b3-8` and `b3-16`, guaranteed) with:
   - the hourly price and the monthly figure for 730 hours, before VAT;
   - the price table's date, or "live" when the prices come from OVHcloud's public catalogue;
   - no setup fee, and that billing stops when the server is deleted;
   - no provider backups (OpsCrew's own snapshots cover the data).
3. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then** OpsCrew
   creates, in the user's project:
   - the server, from Ubuntu 24.04 with the same first-boot setup as on the other providers;
   - its SSH key;
   - its own firewall (a security group) with the same rules as elsewhere: SSH from the allowed
     networks, the web ports on a server that serves the web, WireGuard where it is used. The
     server is never left on the project's default group.

   The deploy, verify, status, secure and drift commands then work as on the other providers.
4. **Given** a region not activated on the project, a plan out of stock in the region, or a project
   whose quota can't hold the server, **When** the user runs `opscrew design`, **Then** that plan
   isn't offered there. `opscrew init`'s check of the credentials lists the regions activated on
   the project and says how to activate another in the control panel. **When** a plan made
   earlier is applied and OVHcloud refuses the server for one of these reasons, **Then** provision
   stops with OVHcloud's answer and the same advice, as it does for an unavailable size on any
   provider. No server is created.
5. **Given** a create that timed out or failed halfway, **When** provision runs again, **Then** a
   server with the app's name that OpsCrew's state doesn't know is shown and taken over in the
   plan, never created a second time.
6. **Given** values that are missing or wrong, or an endpoint other than `ovh-eu`, **Then**
   `opscrew init` and provision name what is missing or wrong and link OVHcloud's page for service
   accounts. They say how to limit the account to the one project.

---

### User Story 2 - Remove an app from OVHcloud honestly (Priority: P1)

**Why this priority**: something left behind that keeps billing would cost the user money without
warning.

**Independent Test**: against fakes, and in the live pass, `opscrew destroy` deletes the server,
its firewall and its key, and the plan names every snapshot that stays and keeps billing.

**Acceptance Scenarios**:

1. **Given** an app on OVHcloud, **When** the user runs `opscrew destroy`, **Then** the plan says:
   - the server is deleted at once, and its hourly billing stops then;
   - OpsCrew removes the app's firewall, SSH key and DNS records;
   - snapshots of the server stay in the project and keep billing per GB until they are deleted in
     the control panel, each one named.
2. **Given** data on the server, **Then** OpsCrew offers its own data snapshot with the encrypted
   copy off the server first, as on every provider (024). A whole-server snapshot is offered too,
   since it outlives the server, with its monthly cost per GB.
3. **Then** the approval and the typed confirmation of the server's name come before anything is
   deleted, as on every provider.

---

### User Story 3 - Everything around a server, on OVHcloud (Priority: P2)

**Acceptance Scenarios**:

1. **Whole-server snapshots** (`opscrew snapshot --server`, `restore --server`) work through
   OVHcloud's instance snapshots, priced per GB a month. A restore rebuilds the server from the
   snapshot, after the approval that any restore needs.
2. **Moves** (`opscrew retarget`) work to and from OVHcloud like any other server target. A change
   of plan size on OVHcloud is refused with the reason and the way to do it: a move to a new
   server.
3. **Several servers** (018), **previews on a server** (022), **monitoring** (020), **logs**,
   **rollback** and **data snapshots** (019, 024) work on OVHcloud servers as on the others.
4. **`opscrew advise`** includes OVHcloud in its cost comparisons, labelled with the price
   table's date or "live".
5. **`opscrew rotate`** lists OVHcloud's service account among the user's own credentials, with
   how to replace it (025).
6. **No provider backups, no delete protection, no resize:** each is said plainly where it matters
   (design, the runbook, the guide), with what OpsCrew does instead.

---

### User Story 4 - The project's id reaches the server module, never a file (Priority: P2)

**Why this priority**: every OVHcloud resource names its project, and the contract has no place
for a value an app needs that isn't a server variable. It must never be written to a committed
file.

**Independent Test**: the generated root module declares the project variable, its value appears
in no generated or committed file, and the engine gets it only from the environment.

**Acceptance Scenarios**:

1. **Given** a provider whose definition lists a root variable fed from one of its credentials,
   **Then** the root module declares it, the server module calls pass it, and OpsCrew hands it to
   every engine command only through the environment.
2. **Given** Hetzner, DigitalOcean and Contabo, which list none, **Then** their generated files
   are byte-identical before and after.
3. **Then** the change to the shared contract waits for an `[035]` issue to the core's lead (the
   brief's rule), and is small and additive.

---

### User Story 5 - In the guide, and a live pass the founder can run (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the guide, **Then** a page for OVHcloud says:
   - how to create the project and the service account, and how to limit the account to the
     project;
   - which regions to activate, and what each OpsCrew region maps to;
   - how billing works: by the hour, stopping at the delete, and what keeps billing (snapshots);
   - what isn't offered: provider backups, resizing, delete protection, monthly billing, and
     accounts outside OVHcloud's EU zone.

   The pages that list providers include it.
2. **Given** `docs/e2e.md`, **Then** the OVHcloud live pass has its steps, its variables and what it
   costs, so the founder can run it, or give a throwaway account.
3. **Then** the MCP tools accept `ovhcloud` wherever they accept a cloud provider, and the deploy
   and snapshot skills say what differs on OVHcloud.

---

### User Story 6 - Deploy an app to a Kamatera server (Priority: P1)

**Why this priority**: this is Kamatera's point: a cheap server, in Europe, North America or Asia,
that a person can try without a company account, billed by the minute.

**Independent Test**: against fakes of Kamatera's API and the engine, interview, design, provision,
deploy, verify, status, secure and drift run on a Kamatera app. The live pass, which needs an
account and the founder's go-ahead (issue #14), proves the same on one `A-2-4`.

**Acceptance Scenarios**:

1. **Given** `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET` in the environment (and
   `KAMATERA_API_URL` only to override the endpoint), **When** the user runs `opscrew interview`,
   **Then** OpsCrew offers Kamatera next to the other cloud providers, with the regions and
   datacenters it serves. When only Kamatera's values are set, it chooses Kamatera without asking.
2. **When** the user runs `opscrew design`, **Then** the options show Kamatera's plans, from a dated
   table of Kamatera's public calculator prices, each with:
   - the hourly price and the monthly figure for 730 hours, in US dollars before VAT;
   - the price table's date;
   - no setup fee, and that billing stops when the server is terminated, not when it is stopped;
   - that a stopped server still costs about a tenth of its running price, for its IP and disk;
   - no provider backups (OpsCrew's own snapshots cover the data).
3. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then** OpsCrew
   creates on the user's account:
   - the server, from Ubuntu 24.04, with a **unique name** (`opscrew-<app>-<random>`), because
     Kamatera renames a duplicate and loses it;
   - its SSH key, as the public key text the server takes (Kamatera has no key resource);
   - the shared first-boot setup, delivered as the **startup script** Kamatera's Terraform accepts
     instead of user data;
   - the app's **server firewall** in that script (default deny; SSH from the allowed networks, the
     web ports on a server that serves the web, WireGuard where it is used), since Kamatera's
     console firewall is off by default and OpsCrew can't set it.

   The plan says "cloud firewall: none; server firewall: on", and `opscrew secure` fails until the
   server's firewall is in place. The deploy, verify, status, secure and drift commands then work
   as on the other providers.
4. **Given** a plan Kamatera refuses (the account's price limit, its server allotment, or no
   capacity in the datacenter), **When** the plan is applied, **Then** provision stops with
   Kamatera's answer and what to do, and no server is created.
5. **Given** a create that timed out, **When** provision runs again, **Then** a server with the
   app's name that OpsCrew's state doesn't know is shown and taken over in the plan, never created
   a second time. **Given** a server named `<name>(1)` — a duplicate Kamatera renamed — **Then**
   provision reports it, names it, and ignores neither the stray server nor its billing.
6. **Given** values that are missing or wrong, **Then** `opscrew init` and provision name what is
   missing and link Kamatera's page for API keys. They say the key can do everything on the account
   and recommend a separate Kamatera account for OpsCrew.

---

### User Story 7 - Remove an app from Kamatera honestly (Priority: P1)

**Why this priority**: a stopped Kamatera server keeps billing, and its snapshots may outlive it.
A removal that says "free now" when it isn't would cost the user money without warning.

**Independent Test**: against fakes, `opscrew destroy` terminates the server, and its plan names
what stops and what may keep billing.

**Acceptance Scenarios**:

1. **Given** an app on Kamatera, **When** the user runs `opscrew destroy`, **Then** the plan says:
   - the server is **terminated** (powered off first if it is on), and its hourly billing stops at
     the terminate, which the provider runs as a queued command;
   - a server that was only **stopped** still billed, and only the terminate ends the cost;
   - OpsCrew removes the app's DNS records;
   - whole-server snapshots and backups may outlive the server and keep billing per GB; each is
     named, and OpsCrew deletes none of them.
2. **Given** data on the server, **Then** OpsCrew offers its own data snapshot with the encrypted
   copy off the server first, as on every provider (024). A whole-server snapshot is offered too,
   with its monthly cost per GB.
3. **Then** the approval and the typed confirmation of the server's name come before anything is
   deleted, as on every provider.

---

### User Story 8 - Everything around a server, on Kamatera (Priority: P2)

**Acceptance Scenarios**:

1. **Whole-server snapshots** (`opscrew snapshot --server`, `restore --server`) work through
   Kamatera's API, because its Terraform provider has no snapshot resource, priced per GB a
   month. A restore rebuilds the server from the snapshot, after the approval that any restore
   needs.
2. **Moves** (`opscrew retarget`) work to and from Kamatera like any other server target. A change
   of plan size is refused with the reason and the way to do it: a move to a new server, because a
   disk-size change fails at Kamatera's API and a CPU or memory change is unverified.
3. **Several servers** (018), **previews on a server** (022), **monitoring** (020), **logs**,
   **rollback** and **data snapshots** (019, 024) work on Kamatera servers as on the others.
4. **`opscrew advise`** includes Kamatera in its cost comparisons, labelled with the price table's
   date.
5. **`opscrew rotate`** lists Kamatera's API key among the user's own credentials, with how to
   replace it (025).
6. **No provider backups, no delete protection, no resize:** each is said plainly where it matters
   (design, the runbook, the guide), with what OpsCrew does instead.

---

### User Story 9 - In the guide, and a live pass the founder can run (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the guide, **Then** a page for Kamatera says:
   - how to create the API key, and that it can do everything on the account, so a separate
     Kamatera account for OpsCrew is the safer way;
   - which datacenters OpsCrew offers, and what each OpsCrew region maps to;
   - how billing works: by the minute, hourly = monthly / 730, stopping at the terminate, and what
     keeps billing (a stopped server, snapshots);
   - the traffic allowance per datacenter and what exceeding it costs;
   - what isn't offered: a cloud firewall OpsCrew can manage (its console one is yours to turn on),
     provider backups, resizing, delete protection and monthly billing.
2. **Given** `docs/e2e.md`, **Then** the Kamatera live pass has its steps, its variables and what it
   costs (about $0.03 an hour on one `A-2-4`), so the founder can run it, or give a throwaway
   account.
3. **Then** the MCP tools accept `kamatera` wherever they accept a cloud provider, and the deploy
   and snapshot skills say what differs on Kamatera.

---

### User Story 10 - IONOS Cloud (Priority: later phase, not built now)

IONOS Cloud follows Kamatera. Its research, stories and requirements are added to this folder then.

### User Story 11 - UpCloud (Priority: later phase, not built now)

UpCloud follows IONOS Cloud, in the same way.

### Edge Cases

- **A region OVHcloud's EU zone doesn't serve in OpsCrew's terms** (`eu-north`, `us-east`,
  `us-west`): the nearest location is used (Warsaw for the Nordics; Beauharnois, near Montreal,
  for the US), and design says so and why.
- **An account outside the EU zone** (`ovh-ca`, `ovh-us`): refused before any call, naming
  `ovh-eu` and saying the others are not supported yet.
- **Only some of the four values set**: the missing ones are named, and nothing is called.
- **A service account without the rights a call needs**: OVHcloud's answer is shown in plain
  English with the IAM policy to add, and nothing more is tried.
- **A change to the first-boot setup or the image after create**: it is never planned, because it
  would wipe the disk. The server keeps what it booted with.
- **Several servers with the app's name** (names aren't unique at OVHcloud): provision stops and
  lists them, rather than guessing which one is the app's.
- **The price table is old**: its date is shown wherever its prices are, and it is checked
  against the public catalogue before each release.
- **A firewall OVHcloud refuses to create or attach**: provision stops before the deploy and
  leaves no server reachable without one.
- **OVHcloud's values in the app's environment or files**: the analysis treats the app's `OVH_*`
  variables as provider credentials, as it does other providers' prefixes. The values have no
  recognisable format of their own, so `opscrew scan` has no rule that matches them.
- **A duplicate name at Kamatera**: the API renames the new server `<name>(1)`, which the
  Terraform provider then loses, leaving it billing (R4 §2). OpsCrew's names carry a random suffix
  and are checked against the account's list, the `(1)` form included, before every apply. A stray
  `(1)` server is reported, never ignored, and a failed create is never retried blindly.
- **A create refused for the account's price limit, its server allotment or no capacity**: the
  plan stops with Kamatera's answer and the setting to raise, as an unavailable size does on the
  other providers.
- **Kamatera's plan-time check can't reach its price file** (`console.kamatera.com`): the plan
  fails with that address named and the way to fix it (the network, or a proxy), because the
  provider validates the datacenter and the plan against it.
- **The startup script's second boot**: whether the image runs it once or on every boot is
  unverified (R4 §9). The script is idempotent, so a second run changes nothing, and the live pass
  says which it is.
- **A change to the startup script, the image or the SSH key after create**: it is never planned.
  Kamatera marks all three as needing a recreate, and OpsCrew keeps `allow_recreate = false`, so
  the server keeps what it booted with and a change means a new server.
- **An API key that can do everything**: there is no scope, role or IP allow-list at Kamatera
  (R4 §1). `init` and the guide say so and recommend a separate account; the key is redacted
  everywhere.
- **The generated root password**: Kamatera's provider stores the password it generates in the
  Terraform state. OpsCrew gives it a random value it never shows and relies on the SSH key, and
  the guide says the password is in the state on the user's computer.
- **Traffic beyond the allowance** ($0.01 a GB, 5000 GB in Europe and North America, 1000 GB in
  Asia and Sydney): design shows the allowance and the rate, and the guide says what exceeding it
  costs.
- **A datacenter OpsCrew's regions don't map** (for example one of Kamatera's four Israeli codes):
  design says the region isn't served there, with the nearest one that is.
- **Whole-server snapshots may or may not outlive the server** at Kamatera (unverified): OpsCrew
  takes the cautious value, offers one before a removal, and names it and its price.
- **The console firewall is off by default**: the plan never claims a cloud firewall for
  Kamatera. The guide shows how to turn the console one on as a second layer, and that OpsCrew
  doesn't manage or verify it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-3501**: OVHcloud MUST be a built-in cloud server provider, `ovhcloud`, in its own package
  written for the contract (ADR 0029), and added to the built-in list after Contabo. No code
  outside its package, the built-in list, the provider id lists and the docs MAY branch on it.
- **FR-3502**: Its connector MUST call OVHcloud's API with a typed client signed in by an OAuth2
  service account. Every answer MUST be validated before use, and the client never repeats a
  create.
- **FR-3503**: Its servers MUST be created through the IaC engine with OVHcloud's own Terraform
  provider (`ovh/ovh`, its current resource family), pinned to an exact minor version.
- **FR-3504**: Its credentials MUST be read from `OVH_ENDPOINT`, `OVH_CLIENT_ID`,
  `OVH_CLIENT_SECRET` and `OVH_CLOUD_PROJECT_SERVICE`, all four required, with `OVH_ENDPOINT`
  equal to `ovh-eu`. They MUST be redacted everywhere, the project id included, used only on the
  user's computer, and never written to tfvars, a committed file, the server or CI. The
  project id is the one exception for state: every OVHcloud resource records it as `service_name`
  in the Terraform state and in saved plans, which stay on the user's computer (ADR 0029, D11).
- **FR-3505**: Design MUST price OVHcloud by the hour and for 730 hours, before VAT, in EUR. Prices
  come from a dated static table, or from OVHcloud's public catalogue when the credentials are
  set. Every price MUST show its date or "live", and there is no setup fee.
- **FR-3506**: With the credentials set, OVHcloud's catalogue MUST mark a plan unavailable in a
  region that isn't activated on the project, where it is out of stock, or where the project's
  quota can't hold it, so design never offers it there. The credential check MUST list the
  project's activated regions and say how to activate another. An apply OVHcloud refuses for one
  of these reasons MUST stop with its answer and what to do, through the same path as an
  unavailable size on any provider.
- **FR-3507**: Provision MUST create the server with the shared first-boot setup, its SSH key and
  its own firewall with the same rules as the other providers, set explicitly on the server. It
  MUST stop before the deploy when the firewall is not in place.
- **FR-3508**: A create MUST never be repeated blindly. A server with the app's name that the
  state doesn't know MUST be shown and taken over in the plan. Several such servers stop
  provision.
- **FR-3509**: Changes that would reinstall or recreate the server (first-boot setup, image, SSH
  key) MUST never be planned after create.
- **FR-3510**: Destroy MUST delete the server, its firewall and its key after the approval and the
  typed name, and its plan MUST name the snapshots that stay and keep billing.
- **FR-3511**: Whole-server snapshots, restores, moves, several servers, previews, monitoring,
  logs, rollback, data snapshots, advise, rotate, status, secure and drift MUST work for OVHcloud
  as US3 says. A size change MUST be refused with a move named as the way.
- **FR-3512**: The interview MUST offer OVHcloud and map OpsCrew's regions to its locations:
  eu-central to Limburg, Strasbourg, Gravelines or Warsaw; eu-north to Warsaw; us-east and us-west
  to Beauharnois; ap-southeast to Singapore or Sydney. Any region that maps elsewhere MUST be said
  in design.
- **FR-3513**: The contract MUST gain an optional way for a provider to name root variables its
  server modules read, each fed from one of its credentials and passed to the engine only through
  the environment (US4). Providers that name none MUST be unchanged.
- **FR-3514**: The MCP tools, the plugin skills and the guide (an OVHcloud page, plus the pages
  that list providers) MUST cover OVHcloud (US5). `docs/e2e.md` MUST give the live pass's steps.
- **FR-3515**: Kamatera MUST be a built-in cloud server provider, `kamatera`, in its own package
  written for the contract (ADR 0029), added to the built-in list after OVHcloud. No code outside
  its package, the built-in list, the provider id lists and the docs MAY branch on it.
- **FR-3516**: Its connector MUST call Kamatera's API with a typed client, signed in by the API key
  in `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET` (`KAMATERA_API_URL` only overrides the
  endpoint). Both values MUST be registered with the redactor, and an answer MUST be validated
  before use. A create MUST never be repeated.
- **FR-3517**: Its servers MUST be created through the IaC engine with Kamatera's Terraform
  provider (`Kamatera/kamatera`), pinned to an exact version, which is the only one found. The plan
  MUST keep `disable_validations` off, as the provider's validation is what refuses an unknown
  datacenter or plan, and the error MUST name the price file it couldn't read when that is why.
- **FR-3518**: Design MUST price Kamatera in US dollars by the hour and for 730 hours, before VAT,
  from a dated table of its public calculator prices. Every price MUST show its date, there is no
  setup fee, and design, the runbook and the guide MUST say that a stopped server still bills
  about a tenth and that only a terminate ends the cost.
- **FR-3519**: Kamatera servers MUST be named as on every provider (`<app>`, `<app>-<name>`;
  plan decision 10), within Kamatera's rule (4–40 letters, digits, dashes or dots), which the module
  checks with a plain message. Whenever OpsCrew lists the app's servers (the takeover after an
  earlier apply, destroy, snapshots), a `<name>(n)` server that Kamatera made from a repeated
  create MUST stop the command, named with its datacenter, and never be adopted. Taking over a
  lost server isn't possible yet (decision 12): its import fails at plan and creates nothing.
- **FR-3520**: Because Kamatera has no user data, the shared first-boot setup MUST be delivered as
  the `startup_script` its Terraform accepts. The contract MUST gain an optional first-boot kind
  (`cloud-init`, the default, or `script`) so the same steps render as that script, and no other
  provider's generated files MAY change. The script MUST run once, as root, after the network is
  up; whether the image would also run cloud-init MUST be settled on the live pass.
- **FR-3521**: Kamatera has no cloud firewall that OpsCrew can set or prove (R4 §4). The plan
  therefore MUST NOT claim one: the app's firewall MUST be installed on the server by the first
  boot (default deny; SSH from the allowed networks, the web ports on a server that serves the
  web, WireGuard where it is used), and `opscrew secure` MUST fail until it is in place. The plan,
  the design summary and the guide MUST say "cloud firewall: none; server firewall: on". This
  changes the safety model for one provider and waits for the founder's decision in issue #13;
  without it, Kamatera's work stops at the decision and the queue moves on.
- **FR-3522**: Destroy MUST terminate the server (powering it off first when it is on) after the
  approval and the typed name, with the plan saying that the terminate is a queued command, that a
  stopped server had kept billing, and which whole-server snapshots or backups may stay and keep
  billing. OpsCrew MUST delete no snapshot of its own at a destroy.
- **FR-3523**: Whole-server snapshots, restores, moves, several servers, previews, monitoring,
  logs, rollback, data snapshots, advise, rotate, status, secure and drift MUST work for Kamatera
  as US8 says. Snapshots MUST go through the connector's API, since Kamatera's Terraform has no
  snapshot resource. A size change MUST be refused with a move named as the way.
- **FR-3524**: The interview MUST offer Kamatera and map OpsCrew's regions to its datacenter codes:
  eu-central to `EU-FR` (Frankfurt), eu-north to `EU-ST` (Stockholm), us-east to `US-NY2` (New
  York), us-west to `US-SC` (Santa Clara) and ap-southeast to `AS-SG` (Singapore), each with the
  codes that aren't confirmed named as unverified. Any region that maps elsewhere MUST be said in
  design.
- **FR-3525**: The MCP tools, the plugin skills and the guide (a Kamatera page, plus the pages that
  list providers) MUST cover Kamatera (US9). `docs/e2e.md` MUST give its live pass's steps, and the
  plugin's and the CLI's credential lists MUST include Kamatera's two variables.

### Key Entities

- **OVHcloud project**: the Public Cloud project the user created, named by its id. It holds the
  app's servers, keys, firewalls and snapshots, its activated regions and its quota.
- **Root variable of a provider**: a variable a provider's server modules read that isn't a
  server's own, with its description and the credential it is fed from.
- **OVHcloud price table**: the offered plans' hourly and 730-hour prices in EUR before VAT, the
  snapshot price per GB, its date and its source (the public catalogue, IE subsidiary).
- **Kamatera account**: the flat account the API key belongs to. It holds every server, with no
  project, folder or resource group, and its datacenters are codes such as `EU-FR`.
- **Kamatera price table**: the offered plans' monthly and hourly prices in USD before VAT, the
  snapshot rate per GB, the traffic allowance per datacenter, its date and its source (Kamatera's
  public calculator data).
- **First-boot kind**: whether a provider's servers take the shared setup as cloud-init (every
  provider so far) or as a startup script (Kamatera), each rendering the same steps.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-3501**: With fakes of OVHcloud's API and the engine, interview, design, provision, verify,
  status, secure, drift, a whole-server snapshot and its restore, and destroy each run on an
  OVHcloud app, with no real cloud call in any test.
- **SC-3502**: With a fake OVHcloud API that times out on create, a second provision creates no
  second server.
- **SC-3503**: For the example apps on Hetzner, DigitalOcean and Contabo, the generated files are
  byte-identical before and after, and every existing test passes.
- **SC-3504**: OVHcloud's tasks change nothing outside its package, the built-in list, the
  provider id lists, the contract's one optional field and its consumers, and the docs.
- **SC-3505**: No output, log, audit entry, generated or committed file of the fake runs holds any
  of the four OVHcloud values. The live pass, when the founder runs it, checks the same, and its
  state files and saved plans for the client id and secret (the project id is in them as
  `service_name`, as FR-3504 says).
- **SC-3506**: `pnpm check` passes on the pull request, or the pull request says plainly which
  test failed and why.
- **SC-3507**: The founder can run the live pass from `docs/e2e.md` alone. It costs under €0.05 an
  hour while it runs (one `d2-4` and its snapshot), and nothing after its destroy except what it
  names.
- **SC-3508**: With fakes of Kamatera's API and the engine, interview, design, provision, verify,
  status, secure, drift, a whole-server snapshot and its restore, and destroy each run on a
  Kamatera app, with no real cloud call in any test.
- **SC-3509**: With a fake Kamatera API that holds a `<name>(1)` server, listing the app's servers
  stops with that server named and creates nothing.
- **SC-3510**: For the example apps on Hetzner, DigitalOcean, Contabo and OVHcloud, the generated
  files are byte-identical before and after Kamatera's tasks, and every existing test passes.
- **SC-3511**: No output, log, audit entry, generated or committed file of the fake runs holds
  Kamatera's client id or secret. The live pass checks the same, and its state files are checked
  for both values except the random root password Kamatera's provider records, which OpsCrew never
  shows.
- **SC-3512**: `pnpm check` passes on Kamatera's pull request, or the pull request says plainly
  which test failed and why.
- **SC-3513**: The founder can run Kamatera's live pass from `docs/e2e.md` alone. It costs about
  $0.03 an hour on one `A-2-4` and nothing after its destroy except what it names.

## Assumptions

- The lead's decisions of 2026-11-21 (research R2).
- Accounts in OVHcloud's EU zone only (`ovh-eu`), billed in EUR. `ovh-ca` and `ovh-us` are later,
  if users ask.
- The user creates the Public Cloud project and activates its regions in OVHcloud's control panel.
  OpsCrew never orders a project, never activates a region and never raises a quota.
- Hourly billing only. Monthly billing is later, if users ask.
- Facts the research could not verify are checked on the live pass, which needs the founder's
  go-ahead because it costs money (research R3):
  - the service account on every route used;
  - the Ubuntu 24.04 image's name and its default user;
  - each plan's availability per region;
  - the error texts for no stock and no quota;
  - the time to a running server;
  - IPv6 by default.
- Kamatera's prices are US dollars, before VAT, hourly only, from its public calculator data of
  2026-11-22. Monthly billing is later, if users ask.
- Only Kamatera's `A` (availability) and `B` (general purpose) CPU types are offered. `T`
  (burstable) adds a per-vCPU charge above a tenth of average CPU, and `D` (dedicated) is priced
  for a whole core; neither is offered now.
- Kamatera's account is flat: no projects, folders or resource groups, so an app is found by its
  servers' names, and the key is recommended to belong to an account of its own.
- Kamatera's private networks, load balancers and Kubernetes are out of scope: an app is one server
  plus what 018 and 022 add.
- Kamatera's live pass needs an account and the founder's go-ahead (issue #14). It costs about
  $0.03 an hour on one `A-2-4`. Until then, everything is built and tested against fakes, and
  these facts wait for it (research R4, "To test live"):
  - the datacenter codes and their cities, including Stockholm's and Singapore's;
  - the Ubuntu 24.04 `os` and `code` strings, the login user and where the key lands;
  - whether the startup script runs once and when, and whether the image has cloud-init;
  - the seconds to a ready server, and the `(1)` rename on a duplicate name;
  - the error texts for no capacity and for the account's limits;
  - whether a terminate removes disks, snapshots and backups;
  - the powered-off rate, IPv6, and whether the console firewall has an API route.
- Not in scope:
  - OVHcloud's object storage, automated backups, private networks (vRack), load balancers and
    local zones;
  - monthly billing, resizing and delete protection, for both providers;
  - Kamatera's private networks, Kubernetes and its console firewall automation;
  - IONOS Cloud and UpCloud, which are this feature's later phases.

## UpCloud (the fourth provider)

UpCloud specified 2026-11-28 on `035-upcloud`, stacked on Kamatera's line (issue #67). Research:
[research.md](research.md) R6. The plan's sections 16. to 18. and its "Decisions for UpCloud" (22 to
31) hold the design; `tasks.md`'s Phase 8 the tasks.

### Why UpCloud

UpCloud is a Finnish provider with fifteen data centres in Europe, North America, Asia and
Australia, billed in EUR by the started hour with a monthly cap of 28 days, and its Terraform
provider is the vendor's own. Its smallest plan that holds an OpsCrew app costs €16 a month. It
differs in ways the user must see (R6):
- its **firewall is stateless**: to let the server's own downloads back in, it would have to open
  every ephemeral port to the internet. OpsCrew uses the **server's own firewall** instead, the
  stateful one it already installs first at the first boot on Kamatera, and leaves UpCloud's off;
- the first boot is delivered as **`user_data` holding a script**, which UpCloud runs once as root;
- billing is **prepaid**: when the account's credits run out, UpCloud disables its servers;
- a **stopped server still bills** its plan; only a delete ends the cost;
- its Terraform provider has **no snapshot resource**, so whole-server snapshots are on-demand
  backups through the API, and they outlive the server;
- a **token can't be limited** to some resources, only to IP ranges and an expiry.

### User Story 14 - Deploy an app to an UpCloud server (Priority: P1)

**Why this priority**: this is UpCloud's point: a fast server with MaxIOPS storage, in Europe,
North America or Asia, with prices that hold in every zone and no traffic charges.

**Independent Test**: against fakes of UpCloud's API and the engine, interview, design, provision,
deploy, verify, status, secure and drift run on an UpCloud app. The live pass, which needs an
account and the founder's go-ahead, proves the same on one `PREMIUM-2xCPU-2GB`.

**Acceptance Scenarios**:

1. **Given** `UPCLOUD_TOKEN` in the environment, **When** the user runs `opscrew interview`, **Then** OpsCrew offers UpCloud next to
   the other cloud providers, with the zones it serves. When only UpCloud's token is set, it
   chooses UpCloud without asking. A user name and password are never read.
2. **When** the user runs `opscrew design`, **Then** the options show UpCloud's Premium plans, from
   a dated table of UpCloud's EUR price list, each with:
   - the hourly price (the monthly price over 672 hours) and the monthly figure, which is also the
     cap, in euros before VAT;
   - the price list's date;
   - its MaxIOPS disk and its public IPv4 address, both in the price;
   - no setup fee, prepaid credits, billing by the started hour, and that only a delete ends the
     cost: a stopped server bills its plan;
   - Simple Backup at +20% of the plan's price, when the plan asks for provider backups.
3. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then** OpsCrew
   creates on the user's account, for each server:
   - the server (a Premium plan, Ubuntu 24.04, its plan's MaxIOPS disk, a public IPv4 interface and
     a utility interface), named `<app>` or `<app>-<name>` as its hostname and title, and labelled
     with the app;
   - its SSH key, as the login key UpCloud places at creation (it has no key resource);
   - the shared first-boot setup as the server's **`user_data` script**, with the metadata service on;
   - the app's **server firewall** first in that script (default deny; SSH from the allowed
     networks, the web ports on a server that serves the web, WireGuard where it is used), and
     UpCloud's own firewall off, because it is stateless.

   The plan says "cloud firewall: none; server firewall: on", and `opscrew secure` fails until the
   server's firewall is in place, as on Kamatera. The deploy, verify, status, secure and drift
   commands then work as on the other providers.
4. **Given** a plan UpCloud refuses (the account's resource limits, too few credits, or a plan not
   offered in the zone), **When** the plan is applied, **Then** provision stops with UpCloud's
   answer and what to do (raise the limit with support, add credits, or choose another zone).
5. **Given** values that are missing or wrong, **Then** `opscrew init` and provision name what is
   missing and link UpCloud's page for API tokens. They say a token acts with the rights of the
   account that made it, recommend a sub-account limited to servers and storage, and a token of at
   most 90 days.

---

### User Story 15 - Remove an app from UpCloud honestly (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an app on UpCloud, **When** the user runs `opscrew destroy`, **Then** the plan says:
   - each server is stopped and deleted with its disk, which releases its address, and only the
     delete ends the cost;
   - the server's backups (OpsCrew's on-demand ones and Simple Backup's) may outlive it and keep
     billing per GB a month; each is named, and OpsCrew deletes none of them;
   - OpsCrew removes the app's DNS records.
2. **Then** OpsCrew's own data snapshot is offered first, and the approval and the typed
   confirmation of the server's name come before anything is deleted, as on every provider.

---

### User Story 16 - Everything around a server, on UpCloud (Priority: P2)

**Acceptance Scenarios**:

1. **Whole-server snapshots** (`opscrew snapshot --server`, `restore --server`) work through
   UpCloud's API as on-demand backups of the server's disk, at €0.056 per GB a month; a restore
   stops the server first.
2. **Moves**, **several servers**, **previews**, **monitoring**, **logs**, **rollback** and **data
   snapshots** work on UpCloud servers as on the others. A size change is refused with the reason
   and the way to do it (a move), as on OVHcloud, Kamatera and IONOS Cloud.
3. **`opscrew advise`** and **`opscrew rotate`** include UpCloud (its price list's date; how to
   replace the token).
4. **No delete protection, no resize:** each is said plainly where it matters.

---

### User Story 17 - UpCloud in the guide, and its live pass (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the guide, **Then** a page for UpCloud says:
   - how to make the sub-account and its token, and why;
   - which zones OpsCrew offers and what each OpsCrew region maps to;
   - how billing works (prepaid EUR credits, the started hour, the monthly cap, what keeps billing,
     what happens when the credits run out);
   - why the server's own firewall is used, and that UpCloud's firewall stays off;
   - that outbound mail on port 25 is closed until UpCloud's support opens it, and that the free
     trial locks the firewall;
   - what isn't offered: Starter and Cloud Native plans, resizing, delete protection.
2. **Given** `docs/e2e.md`, **Then** UpCloud's live pass has its steps, its variables and its cost.
3. **Then** the MCP tools accept `upcloud` wherever they accept a cloud provider, and the deploy and
   snapshot skills say what differs on UpCloud.

### Edge cases (UpCloud)

- **The credits run out:** UpCloud disables the servers until the balance is positive. The guide and
  design say so; `opscrew status` shows the server's state as UpCloud reports it.
- **A plan name UpCloud doesn't list:** with a token, the catalogue keeps only the plans
  `GET /1.3/plan` lists, so design never offers one UpCloud would refuse.
- **Port 25:** an app that sends mail directly gets no connection until support opens the port; the
  guide says to use a mail service on port 587 or 465.
- **Several servers with the app's title** (titles are not known to be unique): provision stops and
  lists them, rather than guessing.

### Requirements (UpCloud)

- **FR-3532**: UpCloud MUST be a built-in cloud server provider, `upcloud`, in its own package
  (`@opscrew/provider-upcloud`) written for the contract (ADR 0029), added to the built-in list
  after IONOS Cloud, with no change to the contract.
- **FR-3533**: The definition MUST offer the five Premium plans of decision 24, from a dated static
  table of UpCloud's EUR price list (2026-10-24), at the plan's included MaxIOPS disk, priced by the
  started hour at the monthly price over 672 hours with the monthly price as the cap. With a token,
  the catalogue MUST keep only the plans UpCloud lists.
- **FR-3534**: Each server MUST take the shared first boot as a script in `user_data` (`firstBoot`
  `script`), with the server's own firewall first in it (`firewallCheck` `server`), and UpCloud's
  firewall MUST be off, so that SecOps and `opscrew secure` check the server's own firewall as on
  Kamatera.
- **FR-3535**: Only `UPCLOUD_TOKEN` MUST be read; the agent's environment MUST
  leave out every `UPCLOUD_` variable, and the token MUST be registered with the redactor.
- **FR-3536**: An app's servers MUST be found by their titles (`<app>`, `<app>-<name>`, exactly the
  plan's names when given, #56) and their app label; an `AppServer`'s id is the server's UUID.
- **FR-3537**: Whole-server snapshots MUST be on-demand backups of the server's disk through the API,
  awaited by polling, and outlive the server in what OpsCrew says until the live pass shows
  otherwise.
- **FR-3538**: When the plan asks for provider backups, the module MUST turn on Simple Backup's week
  plan (`dailies`), priced at +20% of the plan, and SecOps MUST read it from the planned server.

### Success criteria (UpCloud)

- **SC-3517**: With fakes of UpCloud's API and the engine, interview, design, provision, verify,
  status, secure, a whole-server snapshot and its restore, and destroy run on an UpCloud app, with
  no real cloud call in any test.
- **SC-3518**: For the example apps on every other provider, the generated files are byte-identical
  before and after UpCloud's tasks, and every existing test passes.
- **SC-3519**: No output, log, audit entry, generated or committed file of the fake runs holds the
  token. The live pass checks the same, and its state files and saved plans.
- **SC-3520**: `pnpm check` passes on UpCloud's pull request, or the pull request says plainly which
  test failed and why.
- **SC-3521**: The founder can run UpCloud's live pass from `docs/e2e.md` alone. It costs about €0.024
  an hour on one `PREMIUM-2xCPU-2GB` and nothing after its destroy except the backups it names.

### Assumptions (UpCloud)

- Prices are EUR, before VAT, from UpCloud's price list of 2026-10-24; payments in other currencies
  are exchanged to EUR, so EUR is the one currency.
- Only Premium plans are offered. Starter plans hold at most 50 GB and cost more than Premium where
  they fit design's 40 GB minimum; Cloud Native plans have no disk or address of their own. Either
  can come later, if users ask.
- UpCloud's private SDN networks, floating IPs, load balancers and managed services are out of scope.
- UpCloud's live pass needs an account and the founder's go-ahead. Until then, everything is built
  and tested against fakes, and the facts in research R6's "To test live" wait for it.
