# 035 research: more server providers, first wave (OVHcloud, Kamatera, IONOS Cloud, UpCloud)

The roadmap's order (founder, 2026-11-20): OVHcloud first, then Kamatera, IONOS Cloud and UpCloud.
Each provider ships complete, in a pull request of its own, before the next one starts. This file
starts with OVHcloud (R1 to R3). Each further provider adds its own sections when its work starts.

Sources are official only: the provider's API docs and schema, its Terraform provider's docs and
source, and its pricing pages or public catalogue. Anything no source confirmed is marked
"(unverified)" and listed in R3 for the live pass. No account was created, and no authenticated call
was made.

## R1. OVHcloud Public Cloud

Read 2026-11-21 from https://eu.api.ovh.com/v1/cloud.json, https://eu.api.ovh.com/v2/publicCloud.json,
https://eu.api.ovh.com/v1/auth.json, https://eu.api.ovh.com/v1/me.json, the unauthenticated catalogue
`https://eu.api.ovh.com/v1/order/catalog/public/cloud?ovhSubsidiary=IE` (also DE, FR, GB, CA and, on
`https://api.us.ovhcloud.com/1.0/...`, US), https://github.com/ovh/go-ovh (`ovh/ovh.go`, `ovh/error.go`),
https://github.com/ovh/terraform-provider-ovh (docs, CHANGELOG, issues),
https://registry.terraform.io/v1/providers/ovh/ovh, https://registry.opentofu.org/v1/providers/ovh/ovh/versions,
https://docs.ovhcloud.com/en/guides/manage-and-operate/api/manage-service-account,
https://docs.ovhcloud.com/en/guides/manage-and-operate/api/first-steps,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/analyze-billing,
https://docs.ovhcloud.com/en/guides/public-cloud/compute/suspend-or-pause-an-instance,
https://docs.ovhcloud.com/en/guides/public-cloud/compute/getting-started,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/increasing-public-cloud-quota,
https://docs.ovhcloud.com/en/guides/public-cloud/containers-orchestration/managed-kubernetes/datacenters-nodes-storage-flavors.md,
https://www.ovhcloud.com/en/about-us/global-infrastructure/regions/ and
https://www.ovhcloud.com/en/about-us/global-infrastructure/expansion-regions-az/. The pricing page
https://www.ovhcloud.com/en/public-cloud/prices/ came back without its tables, so prices below come from the
public catalogue API instead. The IAM policy guides and the OVH security-group guides were read only through
a search summary (https://docs.ovhcloud.com/en/guides/account-and-service-management/account-information/iam-policies-api,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/security-group-private-network).

### 1. API and sign-in

**Endpoints** (go-ovh `ovh/ovh.go`, provider `docs/index.md`):

| Provider `endpoint` | API base | OAuth2 token URL |
|---|---|---|
| `ovh-eu` | `https://api.eu.ovhcloud.com/1.0` | `https://auth.eu.ovhcloud.com/oauth2/token` |
| `ovh-ca` | `https://api.ca.ovhcloud.com/1.0` | `https://auth.ca.ovhcloud.com/oauth2/token` |
| `ovh-us` | `https://api.us.ovhcloud.com/1.0` | `https://auth.us.ovhcloud.com/oauth2/token` |

- `https://eu.api.ovh.com/v1` (the console's host) also answers. Accounts are separate per zone, and the
  catalogue's `ovhSubsidiary` must match the zone: the EU API refuses `US` (`invalid ovhSubsidiary`), and
  `api.us.ovhcloud.com` serves it.

**Three ways to sign in** (provider `docs/index.md`, go-ovh):
1. **Application key + application secret + consumer key.** Every call sends `X-Ovh-Application`,
   `X-Ovh-Consumer`, `X-Ovh-Timestamp` (server time from `GET /auth/time`) and
   `X-Ovh-Signature: $1$` + hex SHA-1 of `applicationSecret+consumerKey+METHOD+fullURL+body+timestamp`.
   Env vars: `OVH_ENDPOINT`, `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`.
2. **OAuth2 service account** (client credentials). Env vars: `OVH_ENDPOINT`, `OVH_CLIENT_ID`,
   `OVH_CLIENT_SECRET`. The provider docs list it first ("scoped service accounts, and compatible with
   OVHcloud IAM").
3. **A short-lived access token** in `OVH_ACCESS_TOKEN` (with `OVH_ENDPOINT`).
- The provider also reads `~/.ovh.conf` and named profiles (`OVH_PROFILE`).
- At start-up it sends a validation request (`/auth/details`) unless `OVH_IGNORE_INIT_ERROR` is set.

**Application key, secret and consumer key** (https://eu.api.ovh.com/v1/auth.json, `first-steps` guide):
- The application is declared on the token page (`https://auth.eu.ovhcloud.com/api/createToken`, formerly
  `https://api.ovh.com/createToken/`) with the account login and password, an application name, an optional
  validity and the rights. The page yields all three values at once.
- Programmatically, `POST /auth/credential` (no signature, only the `X-Ovh-Application` header) takes
  `{accessRules: [{method, path}], allowedIPs?, redirection?}` and returns `{consumerKey, state,
  validationUrl}`. The state starts as `pendingValidation`; the account holder opens `validationUrl`, logs in
  and picks a validity; it becomes `validated` (other states `refused`, `expired`).
- `GET /auth/currentCredential` shows the credential in use, with its `rules`, `expiration` and
  `allowedIPs`.
- **Scope.** An access rule is a method plus a path, with `*` as a wildcard, so a key limited to one project
  is possible, for example `GET /cloud/project/{id}/*` and `POST /cloud/project/{id}/instance*`. The
  `first-steps` guide gives no path-level detail beyond the wildcard.
- The provider's order guide (`docs/guides/order_consumer_key_access_rules.md`, issue #1448) warns that a
  restricted key must also allow the order and terminate routes to create or delete a project, or calls fail
  with `This call has not been granted`. That matters only for ordering a project, not for managing instances.

**OAuth2 service accounts** (service-account guide):
- Created in the control panel (Identity and Access Management, Identities, Service account) or with
  `POST /me/api/oauth2/client` (`flow: CLIENT_CREDENTIALS`, `name`, `description`, empty `callbackUrls`),
  which returns `clientId` and `clientSecret`. The secret cannot be read again.
- A service account has no rights until an IAM policy names it. Its identity URN is
  `urn:v1:<eu|ca>:identity:credential:<account-id>/oauth2-<clientId>`.
- **Scope to one project and to chosen actions: yes, through IAM.** A policy's `resources` can be the project
  URN `urn:v1:eu:resource:publicCloudProject:<project-id>` (`ca` for the rest of the world) and
  `permissions.allow` lists actions such as `publicCloudProject:apiovh:instance/create` (every operation's
  `iamActions` in the API schema names its action), or a managed group such as `globalReadWrite`. All
  actions are denied by default. Source: the IAM guides (search summary only). The `us` zone's URN form is
  unverified.
- The guide says the pair "has no time limit". The access token's lifetime is unverified.
- **Known gap:** provider issue #1592 (2026-11-11), `ovh_okms` rename fails with OAuth2 because `/services`
  returns 404 despite IAM. Whether every route OpsCrew needs works with a service account is unverified.
- Personal access tokens exist in the schema (`auth.PersonalAccessToken`, with `expiresAt`). I found no route
  for them. Unverified.

**Token format.** No source shows a prefix. Application key, consumer key, client id and client secret are
opaque strings (unverified: no real examples seen), so a secret scanner has no prefix to match.

### 2. Terraform provider `ovh/ovh`

- Latest **v2.25.0**, published 2026-11-13 (registry; the changelog heading says 2026-11-06). Earlier: v2.24.0
  2026-10-29, v2.23.0 2026-10-22, v2.22.0 2026-10-02. Registry tier `partner`. Licence **MPL-2.0** (GitHub
  API). On the **OpenTofu registry** (83 versions, 2.25.0 included).
- OVHcloud ships **two families** of Public Cloud resources
  (`docs/guides/public_cloud_resources_migration.md`): the legacy `ovh_cloud_project_*` (API v1, deprecated,
  a warning at every plan) and the new `ovh_cloud_*` (API v2, `/v2/publicCloud/...`, "Most arguments update
  in place"). `ovh_cloud_instance` first appears in the changelog in 2.19.0 (2026-08-07), `user_data` in
  2.20, snapshots in 2.20. The guide recommends moving to the new family. Both are in 2.25.0.

**New family:**

| Need | Resource | Notes |
|---|---|---|
| Server | `ovh_cloud_instance` | `service_name`, `region`, `name`, `flavor_id`, `image_id`, `ssh_key_name`, `user_data`, `networks`, `security_group_ids`, `power_state`, `availability_zone`, `group_id`, `volumes` |
| SSH key | `ovh_cloud_ssh_key` | `name`, `public_key`, both immutable; beta API |
| Firewall | `ovh_cloud_security_group` | per region; `rule` list (`direction`, `ethernet_type`, `protocol`, `port_range_min/max`, `remote_ip_prefix`, `remote_group_id`) |
| Private network | `ovh_cloud_network_private_vrack` + `ovh_cloud_network_private_vrack_subnet` (+ `ovh_cloud_gateway`) | one per region |
| Snapshot | `ovh_cloud_instance_snapshot` | every argument immutable |
| Volumes | `ovh_cloud_storage_block_volume` (+ `_snapshot`, `_backup`) | |
| Region | `ovh_cloud_project_region` | adds a region to the project |
| Project | `ovh_cloud_project` | orders a project; needs a default payment method |
| Lookups | data sources `ovh_cloud_instance_flavors`, `ovh_cloud_instance_images` | ids are per region |

- `ovh_cloud_instance` has **no billing period argument**, and neither has the v2 create body, so it
  creates hourly instances (the default is unverified on a live call). **Monthly billing needs the legacy
  `ovh_cloud_project_instance`** (`billing_period` = `hourly` or `monthly`, forces a new instance) or
  `POST /cloud/project/{id}/instance/{id}/activeMonthlyBilling`.
- `user_data` is base64 (`base64encode(...)`, 65535 bytes max), write-only and sensitive. A change to a
  different value **reinstalls the instance and wipes the root disk** (id and IP survive); `""` does the
  same; removing the argument does not. An imported instance has no user data in state, so the first apply
  with `user_data` set reinstalls it.
- Changing `image_id` rebuilds and wipes the disk. Changing `flavor_id` resizes in place.
- `ssh_key_name`, `region`, `service_name`, `group_id` and a set `availability_zone` force a new instance.
- Create, update and delete poll up to **60 minutes**, with no `timeouts` block. `resource_status = ERROR`
  ends the wait and the provider reports the failed task's summary.
- `security_group_ids` omitted: the project's `default` group is applied and written into state. `[]`: no
  group, so no inbound traffic at all. Each new group gets an automatic allow-all egress rule outside the
  managed `rule` set.
- Import ids: `service_name/instance_id`. Resources deleted outside Terraform drop out of state on refresh.
- Open issues: none against `ovh_cloud_instance` or `ovh_cloud_security_group` among the open issues listed
  on 2026-11-21 (first 60). Related: #1448 (consumer keys need undocumented routes to order a project) and
  #1592 (OAuth2 404). The disk-wipe cases above are documented behaviour, not bugs.
- Backups: `ovh_cloud_project_workflow_backup` (legacy family: `region_name`, `cron`, `instance_id`,
  `rotation`, `max_execution_count`). Deleting the workflow **does not delete the backups it made**. The
  legacy instance has `auto_backup { cron, rotation }`; the new resource lists no backup argument.

**OpenStack alternative.** `ovh_cloud_project_user` creates a Keystone user and OVH's regions expose normal
OpenStack endpoints, so the `terraform-provider-openstack` would work per region. The OVH docs I read show
OpenStack only for Horizon and the CLI, and the provider docs push `ovh_cloud_*`. Nothing I found says OVH
recommends the OpenStack provider. The OpenStack route gives plain Nova and Neutron semantics (server
metadata, one provider block per region) but needs an OpenStack user per project and does not do region
activation, monthly billing or the project. **Recommendation: `ovh/ovh` with the new `ovh_cloud_*`
resources**, and the legacy `ovh_cloud_project_instance` only for monthly instances.

### 3. Billing

Sources: `analyze-billing` guide, `suspend-or-pause-an-instance` guide, the catalogue.

- **Hourly instances** are metered **per second after a 1-minute minimum**, never rounded up to the hour. The
  meter starts when the instance reaches `ACTIVE`; time in `BUILD` is not billed. Billing stops only when the
  instance is **deleted**. Hourly usage is invoiced on the first day of the next month.
- **Monthly instances:** "roughly 50% cheaper" than hourly per the guide (the catalogue shows 25% for d2,
  see section 7). Paid in advance. **Each commenced month is billed in full, even if the instance is deleted
  early.** No pro-rata refund is stated.
- **Hourly to monthly** is allowed, not the reverse. Switching charges the rest of the current month at once
  (pro rata). API: `POST /cloud/project/{id}/instance/{id}/activeMonthlyBilling`.
- **Gen 3 flavors (b3, c3, r3) are hourly only.** The catalogue has no monthly line for them; their discount
  comes through Savings Plans (1 to 36 months). The older d2, s1, b2, c2, r2 families have monthly lines.
- **Setup fee:** none. The catalogue's `project*` plans cost 0 to install, and instance lines have only a
  `consumption` price.
- **Stopped (SHUTOFF), paused, suspended:** full rate continues, hourly or monthly. The public IP is kept.
- **Shelved:** for an hourly instance compute is released and **only the snapshot is billed** (rate in
  section 5); the IP is kept. A monthly instance pays its monthly price plus the snapshot. The `analyze-billing`
  page words this ambiguously ("will not stop the billing ... but will reduce your cost"), so confirm on a
  real invoice.
- **Public IPv4:** no separate line in the catalogue, and the guides charge nothing for an Ext-Net public IP.
  Instance bandwidth is "not billed" (catalogue `bandwidth_instance_out` is 0). A gateway is paid: s 2.00,
  m 8.00, l 35.00 EUR a month (catalogue); only private-only networks need one. Floating IP and additional IP
  prices are not in this read (unverified).
- **VAT:** catalogue prices are before VAT; `locale.taxRate` carries the subsidiary's rate (IE 23, DE 19,
  FR 20, GB 20; US and CA 0).
- **Deleting a monthly instance mid-month** is allowed; the whole commenced month stays billed.
- Deleting an instance does **not** delete its snapshots, backups or volumes; they keep billing.
- New-account credit: about 175 GBP (UK) or 200 USD (US), valid one month. The EU amount is unverified.

### 4. Firewall and private networking

- **Security groups (OpenStack).** v2 API `/v2/publicCloud/project/{id}/securityGroup` (GET, POST; GET, PUT,
  DELETE on one id); Terraform `ovh_cloud_security_group`, per region; the instance takes
  `security_group_ids`.
- **The default group is open.** OVH's OpenStack CLI guide says the `default` group allows every protocol in
  both directions, so a new instance on it accepts every connection. The Horizon guide contradicts itself
  ("only outgoing"). Treat the default as open (unverified on a live project) and always attach an OpsCrew
  group. OVH advises against editing the default group.
- `security_group_ids = []` gives an instance that accepts no inbound traffic.
- **OVHcloud Network Firewall** is a per-IP feature of the IP product (anti-DDoS family). It is separate from
  the security group. I did not read its docs or API; unverified, and not needed for OpsCrew.
- **Anti-DDoS** on OVHcloud public IPs is an OVH product claim not checked here (unverified).
- **vRack private networks:** `ovh_cloud_network_private_vrack` (one per region) with a subnet. The vRack
  product is free to order per the provider's order guide; a gateway is paid (above). Not needed for
  OpsCrew's single-server apps. Region coverage: wherever the project has the region.
- **IPv6:** security rules take `ethernet_type = IPV6`, and the legacy instance reports addresses with a
  version. Whether Ubuntu 24.04 instances get a public IPv6 by default is unverified.

### 5. Backups and snapshots

- **Instance snapshot** (an image): catalogue `snapshot.monthly.postpaid` **0.011 EUR per GB a month**
  (hourly line 0.000015 per GB-hour; LZ.EU 0.0000275; 3AZ 0.00001917). USD 0.0123, GBP 0.0079, CAD 0.0158 a
  month. The guide says instance snapshots are billed at a flat rate per GB per month.
- **Block volume snapshot** 0.042 EUR/GB/month; classic volume 0.042; high-speed 0.086.
- **Automated backup:** `POST /cloud/project/{id}/region/{region}/instance/{id}/autobackup`, the create
  field `autobackup {cron, rotation}`, and Terraform `ovh_cloud_project_workflow_backup`. These are scheduled
  snapshots, so the snapshot price applies; no separate backup fee is listed.
- **They outlive the instance.** The billing guide says deleting an instance leaves storage, snapshots and
  backups in place and billing, and the workflow resource says its backups survive its deletion. OpsCrew's
  removal has to list and delete them, or leave them on purpose.
- Restore: create an instance from the image (`image_id`) or reinstall (`POST .../reinstall`).
- Limits on snapshot count per project: not found (unverified).

### 6. Regions

Region ids are the ones the Kubernetes datacenter page uses; city and kind come from the infrastructure
pages. Coordinates are approximate and mine, not OVHcloud's.

| Public Cloud region | City, country | Kind | ~Lat, lon | OpsCrew key |
|---|---|---|---|---|
| `DE1` (site Limburg, `eu-west-lim`) | Frankfurt area, DE | 1-AZ | 50.4, 8.0 | eu-central |
| `WAW1` (`eu-central-waw`) | Warsaw, PL | 1-AZ | 52.2, 21.0 | eu-central |
| `GRA11` (also GRA5, 7, 9; `eu-west-gra`) | Gravelines, FR | 1-AZ | 51.0, 2.1 | eu-west |
| `SBG5` (`eu-west-sbg`) | Strasbourg, FR | 1-AZ | 48.6, 7.8 | eu-west |
| `EU-WEST-PAR` | Paris, FR | 3-AZ (a, b, c) | 48.9, 2.4 | eu-west |
| `UK1` (`eu-west-eri`) | London (Erith), UK | 1-AZ | 51.5, 0.2 | eu-west |
| `EU-WEST-RBX` | Roubaix, FR | 1-AZ | 50.7, 3.2 | eu-west (spare) |
| `EU-SOUTH-MIL` | Milan, IT | 3-AZ | 45.5, 9.2 | none |
| local zones `eu-north-lz-hel`, `-sto`, `-osl`, `-cph` | Helsinki, Stockholm, Oslo, Copenhagen | local zone | 60.2 / 59.3 / 59.9 / 55.7 N | eu-north |
| `BHS5` (`ca-east-bhs`) | Beauharnois (Montreal), CA | 1-AZ | 45.3, -73.9 | us-east (nearest) |
| `US-EAST-VA-1` (`us-east-vin`, Vint Hill) | Virginia, US | 1-AZ | 38.7, -77.7 | us-east |
| `US-WEST-OR-1` (`us-west-hil`, Hillsboro) | Oregon, US | 1-AZ | 45.5, -123.0 | us-west |
| `SGP1` (`ap-southeast-sgp`) | Singapore | 1-AZ | 1.35, 103.8 | ap-southeast |
| `SYD1` (`ap-southeast-syd`) | Sydney, AU | 1-AZ | -33.9, 151.2 | ap-southeast (alt) |
| `AP-SOUTH-MUM` | Mumbai, IN | 1-AZ | 19.1, 72.9 | none |

- OVH uses two naming schemes: older trigram ids (`GRA11`, `SBG5`, `DE1`, `UK1`, `WAW1`, `SGP1`, `SYD1`,
  `BHS5`) and newer slug ids (`EU-WEST-PAR`, `US-EAST-VA-1`). `GET /v2/publicCloud/project/{id}/reference/region`
  is the truth per project. The local-zone ids are inferred from the provider doc example
  `EU-WEST-LZ-LUX-A` and are unverified. The `eu-west-*` / `us-*-vin` slugs are infrastructure names, and the
  mapping to the trigram ids (DE1 = Limburg, UK1 = Erith) comes from search summaries, so treat it as unverified.
- **A region must be activated on the project first:** `POST /cloud/project/{id}/region` ("Request access to a
  region"), Terraform `ovh_cloud_project_region`. The v2 reference reports `regionActivated`.
- **Which account sees which regions:** the US site page lists BHS, TOR, HIL (Seattle) and VIN (Washington DC)
  plus the European regions; whether a US (`ovh-us`) or CA account may use EU regions, and the reverse, is
  **unverified**. The US catalogue has its own plan codes (`project`, not `project.2018`).
- Location suffixes in the catalogue (`.LZ.EU`, `.LZ.AF`, `.3AZ`) carry their own prices. For b3-8 in EUR they
  equal the standard price.

### 7. Prices

Public, **unauthenticated catalogue**:
`GET https://eu.api.ovh.com/v1/order/catalog/public/cloud?ovhSubsidiary=<IE|DE|FR|GB|CA|...>`
(US: `https://api.us.ovhcloud.com/1.0/order/catalog/public/cloud?ovhSubsidiary=US`). About 8 MB.
- Shape: `{catalogId, locale:{currencyCode, subsidiary, taxRate}, plans[], addons[], products[],
  planFamilies[]}`. A flavor is an `addons[]` row with `planCode` `<flavor>.consumption` (hourly) or
  `<flavor>.monthly.postpaid` (monthly), `product: "publiccloud-instance"`, `blobs.technical` (`cpu.cores`,
  `memory.size` in GB, `storage.disks[0].capacity` in GB, `bandwidth.level` in Mbit/s) and `blobs.tags`
  (`active`, `legacy`, `savings_plans`). Variants `.3AZ`, `.LZ.EU`, `.LZ.AF` hold location prices.
- **Prices are integers in 1e-8 of the currency:** `price: 1040000` is 0.0104 EUR, `571000000` is 5.71 EUR.
  `tax` is the VAT amount in the same unit, `formattedPrice` is rounded and loses precision. Prices are
  **before VAT**.
- Currency follows the subsidiary: EUR for IE, DE and FR (same prices), GBP for GB, USD for US, CAD for CA.
  **Use IE or FR for EUR.**
- `GET /cloud/project/{id}/flavor` gives per-project ids, not prices.

Read 2026-11-21 (IE catalogue, EUR before VAT):

| Flavor | Kind | vCPU | RAM | Disk (NVMe) | EUR an hour | EUR a month | Hourly x 730 |
|---|---|---|---|---|---|---|---|
| `d2-2` | discovery (shared) | 1 | 2 GB | 25 GB | 0.0104 | 5.71 | 7.59 |
| `d2-4` | discovery | 2 | 4 GB | 50 GB | 0.0206 | 11.44 | 15.04 |
| `d2-8` | discovery | 4 | 8 GB | 50 GB | 0.0372 | 20.60 | 27.16 |
| `c3-4` | cpu, Gen 3 | 2 | 4 GB | 50 GB | 0.0457 | none | 33.36 |
| `b3-8` | general purpose, Gen 3 | 2 | 8 GB | 50 GB | 0.0512 | none | 37.38 |
| `c3-8` | cpu, Gen 3 | 4 | 8 GB | 100 GB | 0.0913 | none | 66.65 |
| `b3-16` | general purpose, Gen 3 | 4 | 16 GB | 100 GB | 0.1023 | none | 74.68 |
| `r3-16` | ram, Gen 3 | 2 | 16 GB | 50 GB | 0.0663 | none | 48.40 |
| `b2-7` (older) | general purpose | 2 | 7 GB | 50 GB | 0.0709 | 25.17 | 51.76 |
| `s1-2`, `vps-ssd-1` (`legacy` tag) | | 1 | 2 GB | 10 GB | 0.0088 | 3.29 | 6.42 |

- `d2` is the cheapest `active` line ("Discovery": shared, no guaranteed resources). `b3-8` is the smallest
  Gen 3 flavor with guaranteed resources. The `s1` and `vps-ssd` flavors carry the `legacy` tag; do not
  offer them. The d2 monthly rate is 25% below hourly x 730, not 50%.
- Snapshot 0.011 EUR/GB/month; classic volume 0.042; outgoing bandwidth 0.
- `d2-2` hourly / monthly in other currencies: USD 0.0129 / 7.08, GBP 0.009 / 4.92, CAD 0.0167 / 9.14.
- Whether each flavor exists in each region is **unverified** (the catalogue is global). The v2
  `GET /v2/publicCloud/project/{id}/reference/productAvailability?type=INSTANCE` (login needed) returns per
  location `stockStatus` and `quotaStatus`.

### 8. Project and app mapping

- A **Public Cloud project** holds servers, keys and networks. Its `service_name` is the project id. The id's
  format (a 32-character hex string) is from memory and unverified.
- **Free to create:** the catalogue's `project`, `project.2018` and `project.discovery` plans cost 0 to
  install and 0 to renew. A project is created through the **order workflow** (`POST /order/cart`, assign,
  add the `cloud` product `project.2018`, `project` in the US, checkout) and needs a default payment method
  (provider doc of `ovh_cloud_project`). Terraform ends one through terminate plus an emailed confirmation
  token; deleting a US project is not supported in Terraform. v1 has no `POST /cloud/project`. The normal
  route is: the user creates the project in the control panel and gives OpsCrew its id.
- **One project can host many apps.** Quotas are per project and per region; the project count per account is
  also capped (support ticket).
- **Quota:** default numbers are **not published** ("limited by default for security reasons"); purchasable
  tiers exist (for example 20 VMs, 40 cores, 430 GB RAM). A warning shows at 80% use. Free-trial accounts
  have limited increases until the first paid invoice. Read it with
  `GET /cloud/project/{id}/region/{region}/quota` or `GET /v2/publicCloud/project/{id}/quota`.
- **Finding an app's servers:** an instance has a **name only**. The v1 `cloud.instance.Instance` and the v2
  `InstanceTargetSpec` have no tags, labels or metadata field, and `PUT` only renames. OpsCrew encodes the app
  in the instance name and lists by prefix, as it does for Contabo. Instance names are not unique.
- SSH key names are unique per project (provider doc of `ovh_cloud_ssh_key`).

### 9. Ubuntu 24.04 image, default user, cloud-init

- Images are listed per region: `GET /cloud/project/{id}/image?region=...` (v1) or
  `/v2/publicCloud/project/{id}/reference/instance/image?region=...`. Ids are UUIDs and differ per region.
  The name is the distribution and version; OVH's own examples write **"Ubuntu 24.04"**. The exact string is
  unverified; look it up by name per region.
- The v2 image has `defaultUser` (for example `ubuntu`, `almalinux`), and the getting-started guide says a
  sudo user named after the image is created (`ubuntu`, `debian`, `fedora`). Ubuntu 24.04 should give
  `ubuntu` (unverified on a live image).
- **A public SSH key is required** for every non-Windows instance (RSA, ECDSA or ED25519, kept in all regions).
- **cloud-init:** supported. v1 create takes `userData` ("Configuration information or scripts to use upon
  launch"), v2 a base64 `userData`, Terraform `user_data`, 65535 bytes max. That it runs `#cloud-config`
  exactly as on Hetzner is unverified.
- **Time to ACTIVE:** the guide says "Delivery may take a few minutes". Measured seconds are unverified.

### 10. Errors and limits

- **Error shape** (go-ovh `error.go`): JSON `{ "class": "Client::BadRequest", "message": "...", "details":
  {...} }` plus an `X-Ovh-QueryID` response header. Seen in this read: `Client::Unauthorized` "You must login
  first" and `Client::BadRequest` "invalid ovhSubsidiary". A missing right adds `details` keys
  `unauthorizedActionsByAuthentication` and `unauthorizedActionsByIAM`; for a consumer key the message is
  `This call has not been granted`.
- **Rate limits:** none stated in the pages I read. Unverified.
- **Out of stock or quota:** no error text was documented. The v2 API can answer **before** a create:
  `GET /v2/publicCloud/project/{id}/reference/productAvailability` returns per model and location
  `stockStatus` (`AVAILABLE`, `LOW`, `OUT_OF_STOCK`, per availability zone), `quotaStatus` (`SUFFICIENT`,
  `INSUFFICIENT`, `UNKNOWN`), `quotaLimitedBy` (`INSTANCES`, `CORES`, `RAM`, ...) and `regionActivated`.
  The real failure text of a create is **unverified**; a failed create shows as `resource_status = ERROR` with
  the failed task's summary, which the provider reports.
- **Idempotency:** no create key. v2 has a `checksum` (optimistic concurrency, HTTP 409 `ChecksumMismatch`
  on a stale update). Names are not unique, so list by name before retrying a create.
- **Delete protection:** v2 has `LOCK` and `UNLOCK` actions and a `locked` flag (OpenStack lock). Whether a
  locked instance refuses `DELETE` is unverified. There is no `deletionProtection` field on instances; it
  exists only on managed database clusters.
- **Resize:** v1 `POST /cloud/project/{id}/instance/{id}/resize {flavorId}`, and the Terraform in-place
  `flavor_id` change; v2 `GET .../instance/{id}/compatibleFlavor` lists the allowed targets. Statuses pass
  through `RESIZE` and `VERIFY_RESIZE`. Whether a downgrade is allowed and how long the server is offline is
  unverified.
- **Remove:** `DELETE /cloud/project/{id}/instance/{id}` (v1) ends hourly billing at once; the instance goes
  through `DELETING` and `DELETED`. Snapshots, backups, volumes and SSH keys stay.
- Statuses: v1 `BUILD`, `ACTIVE`, `SHUTOFF`, `SHELVED`, `SHELVED_OFFLOADED`, `ERROR`, `RESIZE`,
  `VERIFY_RESIZE`, `SNAPSHOTTING`, `DELETING`; v2 `resourceStatus` `CREATING`, `READY`, `UPDATING`,
  `DELETING`, `ERROR`, `OUT_OF_SYNC` and `powerState` `ACTIVE`, `SHUTOFF`, `SHELVED`, `PAUSED`, `SUSPENDED`,
  `RESCUE`.

### What this means for OpsCrew

- **Provider: `ovh/ovh`** (MPL-2.0, partner tier, on the OpenTofu registry) with the new `ovh_cloud_*`
  resources: `ovh_cloud_instance`, `ovh_cloud_ssh_key`, `ovh_cloud_security_group`,
  `ovh_cloud_instance_snapshot`. Pin the version (2.25.0 today): a new minor comes every one to three weeks
  and some of these are beta APIs.
- **Hourly only in the first plugin.** `ovh_cloud_instance` has no billing period. Hourly is per second after
  one minute, so a delete ends the cost at once, unlike Contabo. Offer monthly later through the legacy
  resource. Say in the plan that Gen 3 (b3, c3, r3) has no monthly price and that d2 monthly saves 25%.
- **Cost display:** hourly rate and the 730-hour figure, from a dated static table built from the catalogue
  (integers in 1e-8 units, before VAT, subsidiary IE or FR for EUR).
- **Credentials:** prefer an OAuth2 service account (`OVH_ENDPOINT`, `OVH_CLIENT_ID`, `OVH_CLIENT_SECRET`)
  with an IAM policy limited to the one project URN and the `publicCloudProject:apiovh:*` actions OpsCrew
  needs. The alternative is an application key whose access rules are limited to `/cloud/project/{id}/*` and
  `/v2/publicCloud/project/{id}/*`. Neither secret has a prefix a scanner can match, so redact the exact values
  OpsCrew holds. Check on a live account that a service account works for the `/v2/publicCloud` routes.
- **The user creates the project** (free, control panel, needs a payment method) and gives OpsCrew its id;
  OpsCrew never orders one. It does **activate the region** on the project and should call
  `reference/productAvailability` before a create to catch a missing region, no stock or no quota.
- **Firewall path:** always create an `ovh_cloud_security_group` (ingress 22, 80, 443 as chosen, IPv4 and IPv6
  rules) and pass `security_group_ids`. Never rely on the default group, which OVH's CLI guide shows as
  allow-all. The Network Firewall product is not used.
- **No tags:** the app lives in the instance name. Discovery and removal list by name prefix, and a retried
  create lists first (names are not unique, no idempotency key). Keep the `opscrew-` prefix on the SSH key and
  security group names too.
- **`user_data` changes destroy data:** a later cloud-init change reinstalls the server and wipes the disk, and
  an import loses it. Treat user data as fixed after create and warn on any image or user-data change.
- **Removal:** a delete is real and immediate, so the typed confirmation needs no billing-end date, but it must
  list what stays behind. **Snapshots, backups and volumes outlive the server and keep billing** (0.011
  EUR/GB/month for a snapshot), so removal deletes OpsCrew's own snapshots and backup images only on request.
  A stopped server keeps charging in full; a shelved hourly one charges only its snapshot.
- **Snapshots** are per GB-month and immutable in Terraform. Automated backups use the legacy workflow
  resource, and deleting the workflow keeps the images.
- **Regions:** eu-central to DE1 and WAW1, eu-west to GRA11, SBG5, EU-WEST-PAR and UK1, us-east to
  US-EAST-VA-1 (BHS5 nearby), us-west to US-WEST-OR-1, ap-southeast to SGP1 (SYD1 second). eu-north exists
  only as local zones (Helsinki, Stockholm, Oslo, Copenhagen) whose flavors and ids need a live check. US and
  CA accounts are separate zones with their own endpoint and currency, so the setup must ask which zone the
  account is in.
- **To test live:** per-region flavor and image ids, the real no-stock and quota error texts, a new project's
  default quota, `locked` as delete protection, the Ubuntu 24.04 image name, IPv6 on the image, and the service
  account on `/v2/publicCloud`. A live test create costs under one cent an hour (`d2-2`, 0.0104 EUR).

### Checked again by the lead (2026-11-21)

- The Terraform registry answers `ovh/ovh` 2.25.0, published 2026-11-13T15:54:48Z.
- `docs/resources/cloud_instance.md` on the provider's `master`: `service_name` is required and
  recreates the instance when changed. Unlike the legacy `ovh_cloud_project_instance`, it has no
  `OVH_CLOUD_PROJECT_SERVICE` fallback. There is no billing-period argument. `security_group_ids`
  omitted applies the project's `default` group, and `[]` applies none. `user_data` set to `""`
  reinstalls the instance, while removing the argument doesn't. Changing `image_id` wipes the root
  disk. Changing `flavor_id` resizes in place.
- The IE catalogue (`locale`: EUR, subsidiary IE, tax rate 23), read through Node, gives:
  - `d2-2`: 0.0104 an hour, 5.71 a month;
  - `d2-4`: 0.0206 an hour, 11.44 a month;
  - `d2-8`: 0.0372 an hour, 20.60 a month;
  - `b3-8`: 0.0512 an hour, with no monthly line.
- The provider's index page lists `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET` for service accounts,
  `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET` and `OVH_CONSUMER_KEY` for application keys, and
  `OVH_ACCESS_TOKEN`.

### Confirmed while building the client (T3506, 2026-11-21)

- **API base** (go-ovh `ovh/ovh.go`, `master`): `OvhEU` is `https://api.eu.ovhcloud.com/1.0`.
  `getTarget` drops `/1.0` for a path that starts with `/v1/` or `/v2/`, so the v2 base is
  `https://api.eu.ovhcloud.com/v2`. The v2 schema (`eu.api.ovh.com/v2/publicCloud.json`) has no
  `basePath`; its paths are relative, for example `/publicCloud/project/{projectId}/compute/instance`.
- **Token** (go-ovh `configuration.go`; OVHcloud's guide "authenticate the API with a service
  account"):
  - the request is a form-encoded POST to `https://auth.eu.ovhcloud.com/oauth2/token` with
    `grant_type=client_credentials`, `client_id`, `client_secret` and `scope=all`;
  - the answer is `{access_token, token_type: "Bearer", expires_in: 3599, scope: "all"}`, sent as
    `Authorization: Bearer`;
  - the service account's pair has no time limit (the service-account guide).
- **Errors** (go-ovh `error.go`):
  - the body is `{class, message, details}`, with `details` a string map. A missing right has
    `unauthorizedActionsByAuthentication` or `unauthorizedActionsByIAM`.
  - `X-Ovh-QueryID` comes in a header.
  - go-ovh itself never retries and doesn't handle a 401.
- **Still unverified, for the live pass:**
  - whether a 429 comes with `Retry-After` (the client waits on it for reads only, at most 60
    seconds, and 2 seconds without the header);
  - the error `class` names;
  - the HTTP status of a missing IAM right (the client reads `details`, whatever the status).

### Confirmed while building the server API (T3508 and its review, 2026-11-21)

- **Listing instances:** `GET /v2/publicCloud/project/{p}/compute/instance?name=` is a
  case-insensitive substring match (`name` is `string[]`, "Repeatable"), so the connector keeps
  only the exact `<app>` and `<app>-…` names.
- **Statuses:** v2's `common.ResourceStatusEnum` is `CREATING`, `CREATION_PLANNED`, `DELETING`,
  `ERROR`, `OUT_OF_SYNC`, `READY`, `SUSPENDED` and `UNKNOWN`, `UPDATING`. There is no `DELETED`, and
  lists return `DELETING` rows, which the connector leaves out of servers and snapshots.
- **Snapshots:**
  - create: `POST …/compute/snapshot` with `targetSpec {name, instance {id}, location {region}}`;
  - list: `GET …/compute/snapshot?instanceId=`;
  - get and delete: `GET` and `DELETE …/compute/snapshot/{id}`;
  - `currentState.size` is in bytes and nullable. No name constraint is documented.
- **Power:** `POST …/compute/instance/{id}/action` with `STOP`, `START` or `REBOOT` (`hard` applies
  only to `REBOOT`; soft by default).
- **Reinstall:** v1 only, `POST /cloud/project/{p}/region/{r}/instance/{id}/reinstall {imageId,
  imageRegionName}` (PRODUCTION), answering a `cloud.Operation`. v2 reinstalls only when the image
  or user data changes, so a restore from the same snapshot twice would do nothing there.
  - It is followed with `GET /cloud/project/{p}/operation/{id}`, marked **BETA** in `cloud.json`,
    until `completed` (`in-error` and `canceled` fail).
  - The reinstall takes no user data. OpenStack keeps the creation's; check on the live pass.
- **Regions and project:** `GET /v2/publicCloud/project/{p}` (`name`) and
  `GET …/reference/region` (`name`, `activated`; BETA).
- **Control panel:** OVHcloud's guides ("How to use the Public Cloud interface", "How to increase
  Public Cloud quotas") put region activation at Public Cloud → the project → Settings → Quota &
  Regions.
- **v2 lists are cursor-paginated** (`X-Pagination-Cursor-Next`, default page size undocumented).
  The name, `instanceId` and region filters keep OpsCrew's lists to one page. Following the cursor
  in the client is a follow-up.
- **Import:** `ovh_cloud_instance` imports as `<service_name>/<instance id>` (the provider's
  `ImportState`), hence the contract's `importId` (ADR 0029, D11).

## R2. The lead's decisions for OVHcloud (2026-11-21)

These are technical choices the brief leaves to the lead. Each one gives its reason. A product
question goes to the founder in an issue instead.

1. **Terraform: `ovh/ovh` `~> 2.25.0`, the new `ovh_cloud_*` family.**
   - The module uses `ovh_cloud_instance`, `ovh_cloud_ssh_key` and `ovh_cloud_security_group`, plus
     the data sources `ovh_cloud_instance_flavors` and `ovh_cloud_instance_images`. These resolve the
     flavor name (`d2-2`) and the image name per region, since ids differ per region.
   - OVH's migration guide deprecates the legacy family, which warns on every plan. Its provider
     docs push the new one.
   - The OpenStack provider would need a Keystone user per project and one provider block per region.
2. **Hourly billing only**: `{ model: "hourly", counts: "second", setupFee: false }`.
   - The new instance resource has no billing period.
   - Hourly is metered per second after one minute and ends at the delete. A removal then costs
     nothing more, unlike Contabo's term.
   - Monthly billing (the legacy resource, or `activeMonthlyBilling`) is left for later, if users ask.
     The guide says d2's monthly rate saves 25%, and that Gen 3 has no monthly rate.
3. **Plans offered**: `d2-2`, `d2-4` and `d2-8` (Discovery: shared CPU, the cheapest active line), and
   `b3-8` and `b3-16` (General Purpose Gen 3: guaranteed resources).
   - `s1` and `vps-ssd` carry the catalogue's `legacy` tag and are never offered.
   - Prices come from a dated static table read from the IE catalogue. The connector reads the public
     catalogue live when OVHcloud's credentials are set, like the other providers' live prices: an
     offline run stays offline.
4. **Credentials: an OAuth2 service account, as a set** (`mode: "all"`):
   - `OVH_ENDPOINT`, which must be `ovh-eu`;
   - `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET`;
   - `OVH_CLOUD_PROJECT_SERVICE`, the project id.

   Reasons:
   - It is the provider's first-listed method, and it works with OVHcloud's IAM. An IAM policy limits
     it to the one project's URN and the `publicCloudProject` actions OpsCrew needs (constitution IV:
     the narrowest scope that works).
   - Application keys add a third secret and a consumer-key validation step. They aren't offered in
     035.
   - None of the values has a recognisable format, so `tokenRules` is empty, as for Contabo, and the
     redactor masks the exact values.
   - The project id is not secret, but it is masked too, since it names the account's project.
   - The variable names are the provider's own, so the engine reads them with no copying.
5. **The project id reaches the module as a root variable passed only as `TF_VAR_*`.**
   - `ovh_cloud_instance`, `ovh_cloud_ssh_key` and `ovh_cloud_security_group` each need
     `service_name`, and the contract has no place for a value per app that isn't a server variable.
   - The smallest change: an optional `ProviderTerraform.rootVariables`. It lists variables the
     module calls read (`var.<name>` in `moduleArguments`), each with its description and the
     credential variable it comes from.
   - iac-templates declares them in the root. The agents pass them to the engine only as `TF_VAR_*`
     from that variable, never into `terraform.tfvars.json` or another committed file, as the
     own-server address already travels (`TF_VAR_server_ipv4`).
   - It touches shared files: `packages/contracts`, the registry's validation, `iac-templates` and
     the agents' engine environment. So it waits for an `[035]` issue to the core's lead.
6. **The account's zone: `ovh-eu` only in 035.**
   - `ovh-ca` and `ovh-us` are separate accounts with their own currencies (CAD, USD), plan codes and
     regions, and which regions each zone may use is unverified.
   - Another zone is refused with a plain message naming `ovh-eu`.
   - Supporting them later is a new price table and region check, not a new design.
7. **Regions.** Every OpsCrew region must map to a location (the registry's check).
   - eu-central → `DE1`, `SBG5`, `GRA11`, `WAW1`;
   - eu-north → `WAW1`, with a note: the Nordic local zones' flavors and ids are unverified, so
     Warsaw is the nearest standard region;
   - us-east → `BHS5`, with a note: Beauharnois, near Montreal. OVHcloud's US regions belong to
     OVHcloud US, a separate account;
   - us-west → `BHS5`, with the same note, saying it is far from the US west coast;
   - ap-southeast → `SGP1`, `SYD1`.

   Whether an `ovh-eu` project can use `BHS5`, `SGP1` and `SYD1` is checked live (R3).
8. **Regions are activated by the user, not by OpsCrew.**
   - With the credentials set, the connector's catalogue reads
     `GET /v2/publicCloud/project/{id}/reference/productAvailability`. It marks an offer unavailable
     where the region isn't activated, the stock is out, or the quota is insufficient, so design
     (which keeps only available offers) never proposes it there.
   - Its `verifyCredentials` lists the project's activated regions, with the control panel's path to
     add one, in the message `opscrew init` and provision already show.
   - An apply refused anyway goes through provision's existing path for an unavailable size
     (`offering.unavailable`). A check of every new server's offer before the plan was the other
     option. It would change provision for every provider, a shared change this feature doesn't
     need (changed by the lead on 2026-11-21, while writing the spec).
   - Activating a region through the plan (`ovh_cloud_project_region`) would fail on a region already
     active, and it changes the project, not the app. Saying so is clearer than owning it.
9. **Firewall: managed by Terraform** (`connectorFirewall: false`).
   - Each server has an `ovh_cloud_security_group` named `opscrew-<app>`, with the same inbound rules
     as Hetzner's (SSH from the allowed CIDRs, 80 and 443 for the web, IPv4 and IPv6).
   - `security_group_ids` is always set explicitly, never omitted: the `default` group is documented
     as open.
   - SecOps reads the group's `rule` list, and its attachment from the instance's
     `security_group_ids` or, before apply, from the plan's configuration references, as Contabo's
     does for its wanted firewall.
10. **No provider backups in 035** (`providerBackups: false`, `backupPercent: 0`).
    - OVH's automated backups are the legacy `ovh_cloud_project_workflow_backup`. Its images outlive
      both the workflow and the server and keep billing per GB.
    - OpsCrew's own data snapshots, with their encrypted copy off the server (024), cover the need.
      The runbook then points to them, as for any provider without backups (T2616).
11. **Snapshots** are priced `{ kind: "per-gb", perGbMonth: 0.011, perGbHour: 0.000015 }` in EUR.
    `serverSnapshotsOutliveServer: true`, so the destroy offers one, and its texts say it keeps billing
    until deleted in the control panel.
12. **Removal: `delete`. No delete protection, and no resize in 035.**
    - Whether `locked` refuses a delete is unverified.
    - Resize downgrades and how long the server is offline are unverified. A change of plan is
      refused with a move to a new server (023's retarget), as on Contabo.
    - The live pass may turn either on, with its facts recorded here.
13. **Finding an app's servers by name.** OVH instances have no tags or metadata.
    - The app's server is named `<app>`, an extra one `<app>-<name>`, the SSH key `<app>-deploy` and
      the security group `opscrew-<app>`.
    - `findAppServers` lists the project's instances and matches those names exactly. A create is
      never retried blindly, because names are not unique and there is no idempotency key: the same
      takeover check as Contabo's (026's generic takeover of a lost server).
14. **What reinstalls the server is ignored after create:** `lifecycle.ignore_changes` on `user_data`,
    `image_id` and `ssh_key_name`. A change of either of the first two wipes the disk, and the third
    recreates the server.
15. **The first-boot user:** OVH's Ubuntu images create the user `ubuntu` with the SSH key. The shared
    cloud-init makes `deploy` and closes root and password logins as on the other providers. Whether
    it also has to lock `ubuntu` is a plan question, settled by reading the shared cloud-init.

## R3. To check on the live pass (needs an OVHcloud account, so the founder's go-ahead)

- An `ovh-eu` service account with an IAM policy on one project works on every `/v2/publicCloud`
  route the module and the connector use (provider issue #1592 shows a 404 gap elsewhere).
- The access token's lifetime.
- The image name `Ubuntu 24.04` in each region, its default user `ubuntu`, a public IPv6 by default,
  and the shared cloud-init running unchanged.
- Each offered flavor in each mapped region, and whether `BHS5`, `SGP1` and `SYD1` are open to an
  `ovh-eu` project.
- The default quota of a new project, and the real error texts of a create with no stock and with
  no quota (for `offering.unavailable` and `offering.serverLimit`, which are patterns until then).
- The `default` security group really is open, and an explicit group really closes the rest.
- The time to `ACTIVE`.
- `locked` as delete protection.
- Resize up and down, and how long the server is offline.
- The rate limits.
- A shelved and a stopped instance on the invoice.
- Added from T3509's review:
  - **The takeover:** after an `import` of an instance, the first plan shows no change to
    `networks` (the module sets `networks = [{ auto_assign_public_ip = true }]`, and an imported
    state may hold more).
  - **The image name:** `Ubuntu 24.04` matches exactly one image per region. The module resolves it
    with `one()`, so none means a null `image_id` that only the apply refuses, and two would fail
    every plan.
  - **The default user:** cloud-init's first boot works with the image's own user (`ubuntu`).
- Added from T3513's review: whether OVHcloud's `instanceId` snapshot filter still finds an
  instance's snapshots after the instance is deleted. The live pass records the ids before the
  destroy, so it doesn't depend on it.

## R4. Kamatera

Read 2026-11-22 from https://registry.terraform.io/v1/providers/Kamatera/kamatera,
https://registry.opentofu.org/v1/providers/kamatera/kamatera/versions,
https://github.com/Kamatera/terraform-provider-kamatera (docs, `kamatera/*.go`, README, issues #18, #25, #32, #44,
releases, commits), https://github.com/Kamatera/kamateratoolbox (`pages_src/templates/serverconfiggen.js`),
https://github.com/Kamatera/docker-machine-driver-kamatera (README), https://github.com/cloudwm/cloudcli (README,
docs, `cmd/*.go`, `example-cloudcli.env`; Kamatera's own CLI, MIT), the public calculator data
`https://console.kamatera.com/info/calculator.js.php`, the public CLI schema
`https://cloudcli.cloudwm.com/schema?supports=1.0.0`, https://www.kamatera.com/knowledgebase/api-documentation/,
https://www.kamatera.com/faq/answer/permissions-api-documentation/,
https://www.kamatera.com/faq/answer/will-i-be-charged-for-my-hourly-server-even-when-its-powered-off/,
https://www.kamatera.com/faq/answer/which-cpu-types-are-offered-by-kamatera/,
https://www.kamatera.com/faq/answer/why-was-i-charged-after-i-terminated-my-services/,
https://www.kamatera.com/faq/answer/terminate-server/, https://www.kamatera.com/faq/billing/,
https://www.kamatera.com/pricing/, https://www.kamatera.com/data-centers/,
https://www.kamatera.com/knowledgebase/how-to-set-up-a-firewall-on-kamatera/,
https://www.kamatera.com/knowledgebase/how-do-i-back-up-my-server-and-restore-from-a-backup/,
https://www.kamatera.com/knowledgebase/how-to-deploy-terraform-on-a-kamatera-vps/ and
https://www.kamatera.com/blog/cloud-security-tips/. https://console.kamatera.com/pricing came back empty (it needs a
browser), so prices below come from the calculator data instead. The calculator data and the CLI schema are public
unauthenticated GETs. No account was created and no authenticated call was made. The provider's docs are not on
the registry pages I could read, so they come from the repository's `docs/` folder.

### 1. API and sign-in

There are **two API fronts** and Kamatera's own pages disagree on which one to use:

| Front | Base URL | Sign-in | Source |
|---|---|---|---|
| Console API (documented) | `https://console.kamatera.com/service/` | `POST /service/authenticate` with `clientId` and `secret` returns `authentication` (a token) and `expires` (epoch); the token lives **one hour**; send `Authorization: Bearer <token>`. The page says: do not send the id and secret as headers. | https://www.kamatera.com/knowledgebase/api-documentation/ |
| CLI proxy (what Terraform and cloudcli use) | `https://cloudcli.cloudwm.com` (provider default for `api_url`) | **every call** carries headers `AuthClientId: <id>` and `AuthSecret: <secret>`; no token step | `kamatera/provider.go`, `kamatera/request.go` in the provider repo; cloudcli `cmd/` |

- The proxy answers real paths such as `POST /service/server` (create), `POST /service/server/terminate`,
  `POST /service/server/info`, `GET /service/servers` (id, name, datacenter, power), `GET /service/queue?id=<id>`
  and `GET /service/server?datacenter=1|images=1&datacenter=<id>`. The console API documents
  `POST /service/server` (create), `DELETE /service/server/{id}/terminate` and returns a task id.
  (Sources: `kamatera/request.go`, `kamatera/resource_server.go`, the schema above, the API documentation page.)
- A bare `GET https://cloudcli.cloudwm.com/service/queue` with no credentials answered `200 []`, an empty list,
  so that route does not check credentials without an id. `GET .../service/server/options/datacenters` without
  credentials answered 500 with a PHP error text. No other unauthenticated call was made.
- **Keys:** console, API, Keys, Create New Key, a description; the dialog shows an *access key* (the client id) and a
  *secret key*, shown once (https://www.kamatera.com/knowledgebase/how-to-deploy-terraform-on-a-kamatera-vps/).
- **Env vars:** the Terraform provider reads `KAMATERA_API_CLIENT_ID`, `KAMATERA_API_SECRET` and `KAMATERA_API_URL`
  (`kamatera/provider.go`; the README example matches). cloudcli reads `CLOUDCLI_APICLIENTID`, `CLOUDCLI_APISECRET`,
  `CLOUDCLI_FORMAT`, `CLOUDCLI_DEBUG`, `CLOUDCLI_CONFIG` (`example-cloudcli.env`), and `~/.cloudcli.yaml`.
  The provider also takes `disable_validations`, which has no env var.
- **Scoping: not documented.** Kamatera's pages describe no scope, role, read-only key, IP allow-list or per-key
  permission (https://www.kamatera.com/faq/answer/permissions-api-documentation/ says so by omission and calls
  scope "not covered"). The security blog says to "restrict them to specific actions and IP addresses where possible"
  (https://www.kamatera.com/blog/cloud-security-tips/) but gives no way. Treat a key as **full account access**
  (unverified). The same permissions page links user-level controls (server price limit, server-creation
  allotment); their content was not read (unverified).
- **Token format:** no prefix is shown anywhere. The id and secret are opaque (unverified: no real example seen), so
  a scanner has nothing to match; redact the exact values OpsCrew holds.

### 2. Terraform provider `Kamatera/kamatera`

- Latest **v0.9.4**, published **2025-09-11T09:26:52Z** (registry and GitHub releases). Earlier: 0.9.3 2025-08-14,
  0.9.2 2025-08-03, 0.9.1 2025-08-02, 0.8.15 2025-05-26. Registry tier **community** (not partner or official).
  Licence **MPL-2.0** (GitHub API). **OpenTofu registry: present**, 0.9.4 is the newest version listed.
- Repository pushed 2026-02-10; the only commit after 0.9.4 is the same-day "add option to disable provider
  validations". No release in the 14 months to today. It is built on terraform-plugin-sdk v2 (`provider.go`).
- **Resources and data sources (all there are):** `kamatera_server`, `kamatera_network`; data sources
  `kamatera_datacenter` (by `country` + `name`) and `kamatera_image` (by `datacenter_id` + `os` + `code`, or
  `private_image_name`). **No firewall, no snapshot, no backup resource, no SSH-key resource, no tags, no user
  data** (docs folder and `provider.go`).

`kamatera_server` (https://github.com/Kamatera/terraform-provider-kamatera/blob/master/docs/resources/server.md):

| Argument | Notes |
|---|---|
| `name` (required) | the server name; **also the Terraform id** (`d.SetId(createdServerName)`); renamed in place |
| `datacenter_id` (required) | ForceNew; the code, for example `EU-FR` |
| `image_id` (required) | image id from `kamatera_image`; changing it needs `allow_recreate = true` |
| `cpu_type` + `cpu_cores` | `A`, `B`, `D` or `T`; sent as `"<cores><type>"`, for example `2B` |
| `ram_mb` | MB |
| `disk_sizes_gb` | list; one disk each; the first is the system disk |
| `billing_cycle` | `hourly` or `monthly`; changeable in place |
| `monthly_traffic_package` | only checked for monthly (`t5000`, `b50`, ...) |
| `network` blocks (max 4) | `name = "wan"` plus optional `ip`, or a `kamatera_network.full_name`; default one WAN with auto IP; a change needs `allow_recreate` |
| `ssh_pubkey` | the public key text; ForceNew in the schema; a change needs `allow_recreate` |
| `startup_script` | a script; ForceNew; a change needs `allow_recreate` |
| `password` | root password; if empty the provider sends `__generate__` and stores the answer in sensitive `generated_password` (so **a root password ends up in state**) |
| `daily_backup`, `managed` | booleans; changeable in place |
| `power_on` | default true; false creates the server off; changeable in place (`poweron` / `poweroff`) |
| `allow_recreate` | provider-specific guard; without it, changes to image, network, ssh key or script **fail with an error** instead of recreating |
| read-only | `id`, `internal_server_id`, `public_ips`, `private_ips`, `attached_networks`, `price_hourly_on`, `price_hourly_off`, `price_monthly_on`, `generated_password` |

- **Private networks:** `kamatera_network` (`datacenter_id`, `name`, up to 500 `subnet` blocks with `ip`, `bit`,
  `gateway`, `dns1`, `dns2`); `full_name` is what a server attaches.
- **Import:** `kamatera_server` has an importer (the id is the internal server id; added in issue #31, closed
  2022-06-16).
- **Waits:** every operation is a queued command; the provider polls `GET service/queue?id=` every 2 seconds for up
  to **40 minutes**, then fails with "timeout waiting for Kamatera command to complete"; a command status of
  `error` fails with "kamatera command failed: <log>" (`request.go`).
- **Plan-time network call:** unless `disable_validations` is set, the provider downloads
  `https://console.kamatera.com/info/calculator.js.php` during plan and rejects an unknown datacenter, CPU, RAM or
  disk size or traffic package (`server_options.go`). The plan therefore needs that URL reachable.
- **Open issues that bite** (25 issues in all; 7 open) at https://github.com/Kamatera/terraform-provider-kamatera/issues:
  - **#25 (open since 2021-12):** the API sometimes names the new server `<name>(1)`; the provider then fails with
    `error response from Kamatera API (500): No servers found (name='...')`, and an **orphan server keeps running and
    billing**. A maintainer says it comes from conditions in Kamatera's API the provider cannot control.
  - **#32 (open since 2023-09):** changing a disk size fails with HTTP 500 `Value expected to be 'number', 'string'
    given.` (a bug in the upstream API, ticket CWM-6583, per the maintainer). Treat disk resize as unusable.
  - **#44 (closed 2026-03-23):** a change in `cpu_cores` was not detected. No commit after 0.9.4 touches it, so
    whether it is fixed in a release is (unverified); plan a check on a live account.
  - **#18/#19 (closed 2021):** "Can't terminate server", which was the same `(1)` name problem.
- **Verdict:** the only Terraform provider is Kamatera's own, community tier, with a small surface and no release in
  over a year. Server, SSH key text and startup script are covered; **firewall, snapshots, tags and user data are
  not**. Another Terraform provider by anyone else was not looked for (unverified). The alternative is a typed
  OpsCrew connector over the same API cloudcli uses (the schema in section 10 lists every route) and no Terraform
  for Kamatera at all.

### 3. Billing

Sources: https://www.kamatera.com/pricing/, the three FAQ pages in the header, the calculator data.

- **Currency: US dollars** ("$"; the pricing page names no code). Price list in `calculator.js.php` has no tax data.
- **Monthly price is the base; hourly = monthly / 730.** The page shows type A "$0.00054/hour or $4/month"
  (that hourly figure looks like a typo for 0.0055, since 4/730 = 0.00548, unverified), type B "$0.0123/hour or
  $9/month" (9/730 = 0.01233), and for 8 vCPU, 8 GB, 50 GB "$0.0931/hour, about $68 for 730 hours" (68/730 = 0.0931). The
  calculator reproduces $4, $9, $25 (the page's "Standard 2 vCPU 2 GB") and $39 ("Pro 2 vCPU 4 GB").
  **Hourly and monthly cost the same per hour**; monthly is not a discount.
- **Hourly servers:** the pricing page says "billed by the minute" (https://www.kamatera.com/pricing/). The billing
  FAQ says hourly is **post-paid**: the invoice for a terminated server's usage arrives the next month. No minimum
  is stated. The exact rounding is (unverified).
- **Powered off (hourly):** there is a **small charge** for the reserved storage and IP address that varies with disk
  size (FAQ). The page's example: 8 vCPU / 8 GB / 50 GB is $0.0102 an hour off ($7.50 per 730 h), against $0.0931 on.
  The calculator has `wanPoweredOff` = 5 (an IP, "WAN Address for hourly powered off") and extra disk 0.05 per GB, and
  5 + 50 x 0.05 = 7.50, which matches. **A stopped server is not free**, but costs about a tenth. (The formula is my
  inference from the match; the FAQ gives only the example.)
- **Monthly servers:** paid in advance for the configuration, with upgrades pro rata; the billing cycle starts on the
  **1st of the month**. "If you cancel after the 1st, you're charged for the full month"; terminate **before the
  1st** to avoid the next month (https://www.kamatera.com/faq/answer/why-was-i-charged-after-i-terminated-my-services/).
  A monthly server terminated early is not refunded for the rest of the month (the FAQ states the full month is
  billed; no refund is mentioned).
- **Hourly to monthly and back:** the provider changes `billing_cycle` in place (`server/configure` with
  `billingcycle`); what Kamatera charges at the switch is (unverified).
- **Setup fee:** none mentioned on the pricing page or in the calculator data (unverified in the terms).
- **Public IPv4:** one is included (calculator `wan` option "1" costs 0); each extra address costs **$1 a month**
  (`wan` options 2, 3, 4 cost 1, 2, 3 and `wanEx` "Extra WAN address" 1).
- **Traffic** (calculator `netPck.<dc>` and `netPckTrafficEx.<dc>`): **5000 GB** a month in every Europe
  datacenter, every US datacenter and Toronto; **1000 GB** in Hong Kong (`AS`), Singapore (`AS-SG`), Tokyo
  (`AS-TY`) and Sydney (`AU-SY`); an unmetered `b50` option (50 Mbit/s, price 0) exists everywhere but `AS`.
  Over the allowance: **$0.01 per GB**. The pricing page adds: on the unmetered option, if incoming traffic is more
  than 33% of the total, the whole traffic is billed. Whether the hourly plans carry the allowance is
  (unverified); the pricing page lists 5 TB for its three monthly plans, and a FAQ title says the dedicated hourly
  plan includes no traffic (https://www.kamatera.com/faq/answer/why-doesnt-the-dedicated-hourly-plan-include-internet-traffic/,
  title only, not read).
- **VAT:** not mentioned on the pages read (unverified).
- **Deposit:** accounts can run on a prepaid deposit; after the trial a minimum deposit is required
  (https://www.kamatera.com/faq/billing/, amount not shown). Payment: card or PayPal, PayPal limited for new
  accounts.
- **Free trial:** 30 days, one server worth up to $100, 1 TB of traffic; some accounts are asked for a $10
  refundable security deposit (billing FAQ).
- **Deleting an hourly server** ends its charge on termination; a stopped one still costs the powered-off rate until
  it is terminated.

### 4. Firewall and private networking

- **There is a firewall, but only in the console, per server.** The knowledge-base article: open the server, the
  **Firewall** tab, tick the box to enable it, optional IP Sets, an input and an output policy (Accept, Reject or
  Drop), and rules with direction, interface, protocol (TCP, UDP, ICMP), source, port, policy and position,
  evaluated top to bottom, saved with "Update Firewall" (https://www.kamatera.com/knowledgebase/how-to-set-up-a-firewall-on-kamatera/).
  **It starts disabled**, so a new server accepts everything. The article mentions no API and no Terraform; IPv6 is not
  mentioned (the protocol list has no IPv6 entry).
- **No firewall route anywhere in the API surface I could read:** the cloudcli schema lists `server`, `queue`,
  `network`, `k8s`, `datacenters`, `images` and no firewall command; the console API documentation page has none; the
  Terraform provider has none. Whether a console-only API route exists is (unverified).
- **Consequence:** the cloud firewall cannot be managed from Terraform or from the documented API. The default
  protection has to be an **in-server firewall** installed by the startup script (nftables or ufw), which is also what
  Kamatera's own security blog recommends beside "default deny" (https://www.kamatera.com/blog/cloud-security-tips/).
- **Private networks:** `kamatera_network` creates a VLAN-style private network per datacenter with subnets
  (README). A server can have up to 4 interfaces (Terraform schema), 9 NICs on the console API (API page). Price of a
  private network is not in the calculator (unverified; the calculator has no line for it). Not needed for
  single-server apps.
- **IPv6 and DDoS:** the data-centers page mentions neither; IPv6 on a new server is (unverified).

### 5. Backups and snapshots

- **Daily backup** (`daily_backup`, API `dailybackup=yes`): runs at 00:00 in the datacenter's time zone, kept
  **14 days**, "a small monthly fee"; the page gives no figure (https://www.kamatera.com/solutions/backups/ was
  read through a search summary only). The calculator's `backup` entry says "Backup operation (boolean)" with 0.5
  on both values, and its unit is unclear (unverified). Restore is done by Kamatera support, or a backup image from
  the console's Hard Disk Library "My Private Images" can be turned into a new server
  (https://www.kamatera.com/knowledgebase/how-do-i-back-up-my-server-and-restore-from-a-backup/).
- **Snapshots:** per server, created and reverted from the console and by cloudcli
  (`cloudcli server snapshot --create/--delete/--revert`, schema route `/server/snapshot`). Calculator: **$0.05 per
  GB** (`snapshot`, "Snapshot price per GB"; per month is my reading, unverified). No count limit is stated.
- **Hard Disk Library images** (backups and private images): calculator `hdlibGB` $0.05 per GB.
- **Do they outlive the server?** Not stated for either. Snapshots hang off the server's Snapshots tab, so they most
  likely go with it, and library images stay because they are separate private images (both unverified).
  OpsCrew must treat backups as possibly outliving the server and ask Kamatera's console or API to confirm
  before saying so.
- **Terraform:** only the `daily_backup` flag. No snapshot or image resource.

### 6. Regions (datacenters)

The calculator lists **25 datacenter codes**; the data-centers page lists **21 cities**
(https://www.kamatera.com/data-centers/, no codes there). The toolbox maps 13 codes to cities (marked "T"); the
rest are my reading of the code against the city list (marked "inferred"). Coordinates are approximate and mine.

| Code | City, country | Mapping source | ~Lat, lon | Traffic |
|---|---|---|---|---|
| `EU` | Amsterdam, NL | T | 52.4, 4.9 | 5000 GB |
| `EU-FR` | Frankfurt, DE | T | 50.1, 8.7 | 5000 GB |
| `EU-LO` | London, UK | T | 51.5, -0.1 | 5000 GB |
| `EU-ST` | Stockholm, SE | inferred | 59.3, 18.1 | 5000 GB |
| `EU-ML` | Milan, IT | inferred | 45.5, 9.2 | 5000 GB |
| `EU-MD` | Madrid, ES | inferred | 40.4, -3.7 | 5000 GB |
| `EU-BU` | Bucharest, RO | inferred | 44.4, 26.1 | 5000 GB |
| `US-NY2` | New York, NY | T | 40.7, -74.0 | 5000 GB |
| `US-AT` | Atlanta, GA | inferred | 33.7, -84.4 | 5000 GB |
| `US-MI` | Miami, FL | inferred | 25.8, -80.2 | 5000 GB |
| `US-CH` | Chicago, IL | inferred | 41.9, -87.6 | 5000 GB |
| `US-TX` | Dallas, TX | T | 32.8, -96.8 | 5000 GB |
| `US-SC` | Santa Clara, CA | T | 37.4, -121.9 | 5000 GB |
| `US-LA` | Los Angeles, CA | inferred | 34.1, -118.2 | 5000 GB |
| `US-SE` | Seattle, WA | inferred | 47.6, -122.3 | 5000 GB |
| `CA-TR` | Toronto, CA | T | 43.7, -79.4 | 5000 GB |
| `AS` | Hong Kong | T | 22.3, 114.2 | 1000 GB |
| `AS-SG` | Singapore | inferred | 1.35, 103.8 | 1000 GB |
| `AS-TY` | Tokyo, JP | inferred | 35.7, 139.7 | 1000 GB |
| `AU-SY` | Sydney, AU | inferred | -33.9, 151.2 | 1000 GB |
| `IL`, `IL-RH` | Rosh Haayin, IL | T | 32.1, 34.95 | 5000 GB |
| `IL-HA` | Haifa, IL | T | 32.8, 35.0 | 5000 GB |
| `IL-PT` | Petach Tikva, IL | T | 32.1, 34.9 | 5000 GB |
| `IL-TA` | Tel Aviv, IL | T | 32.1, 34.8 | 5000 GB |

(Sources: `serverconfiggen.js` for T; `calculator.js.php` `datacenters` and `netPck.*` for codes and traffic.) The
data-centers page names only Tel Aviv among the Israeli sites and no Rosh Haayin, Haifa or Petach Tikva; whether
the other four are still on sale is (unverified; they are in the calculator list). The page also names no `US-MI2`;
the calculator has price lines for that code but not in its datacenter list.

**OpsCrew mapping** (every key maps):

- `eu-central` -> `EU-FR` Frankfurt (T, so verified), spare `EU` Amsterdam.
- `eu-north` -> `EU-ST` Stockholm (the city is on the data-centers page; the code is inferred, (unverified) until a
  live `datacenters` list says it). Nearest verified alternative: `EU` Amsterdam, about 1,100 km from Stockholm.
- `us-east` -> `US-NY2` New York (T); spares `US-AT`, `US-MI`, `US-CH` (inferred).
- `us-west` -> `US-SC` Santa Clara (T); spares `US-LA`, `US-SE` (inferred).
- `ap-southeast` -> `AS-SG` Singapore (inferred, (unverified) code); spare `AU-SY` Sydney, `AS` Hong Kong (T,
  verified, about 2,500 km from Singapore).
- The Asian and Sydney datacenters carry a 1000 GB allowance, five times less than elsewhere.

### 7. Prices

- **Public price data without login:** `GET https://console.kamatera.com/info/calculator.js.php`, a JavaScript file with
  `var prd_prices = '{...}';`; the inner JSON has `datacenters`, `cpu` (per `<cores><type>`), `ramMB.<type>`,
  `diskGB`, `snapshot`, `wan`, `wanPoweredOff`, `netPck.<dc>`, `netPckTrafficEx.<dc>`, `hdlibGB` and `os` (every image
  with id, name, `minRamMB`, `minCpu`, `minDiskSizeGB` and the datacenters it is in). The provider reads the same file.
  About 150 KB. It was fetched 2026-11-22. All prices in it are **US dollars a month**; hourly is that divided by 730.
- **A server's monthly price = cpu(`<cores><type>`) + ramMB.`<type>`(ram) + diskGB(total size) + extra disks +
  traffic + IP**; the three sums I checked against the pricing page's own examples all matched.
- **CPU types** (https://www.kamatera.com/faq/answer/which-cpu-types-are-offered-by-kamatera/): **A** Availability
  (threads shared with others, no guaranteed resources, 1 to 32 vCPU), **B** General Purpose (dedicated threads,
  guaranteed, the recommended one), **D** Dedicated (a whole core), **T** Burstable (guaranteed threads, but average
  CPU over 10% adds **$0.041 an hour per vCPU**: calculator `cpuEx.T` 30 a month). OpsCrew offers A and B only.
- **Disk:** the total size gives a price in steps (calculator `diskGB`): 5 to 20 GB $6, 30 GB $8, 40 $9, 50 $10,
  60 $11, 80 $12, 100 $14; extra disks $0.05 per GB.

Computed from the calculator 2026-11-22 (USD, includes a 20 to 80 GB system disk, one public IPv4, no extras):

| Config | Type | vCPU | RAM | Disk | Monthly | Hourly (monthly / 730) |
|---|---|---|---|---|---|---|
| A-small | A | 1 | 1 GB | 20 GB | 4.00 | 0.00548 |
| A-1-2 | A | 1 | 2 GB | 20 GB | 6.00 | 0.00822 |
| A-2-4 | A | 2 | 4 GB | 40 GB | 19.00 | 0.02603 |
| A-4-8 | A | 4 | 8 GB | 80 GB | 42.00 | 0.05753 |
| B-1-1 | B | 1 | 1 GB | 20 GB | 9.00 | 0.01233 |
| B-1-2 | B | 1 | 2 GB | 20 GB | 15.00 | 0.02055 |
| B-2-2 | B | 2 | 2 GB | 20 GB | 25.00 | 0.03425 |
| B-2-4 | B | 2 | 4 GB | 40 GB | 42.00 | 0.05753 |
| B-2-8 | B | 2 | 8 GB | 60 GB | 64.00 | 0.08767 |
| B-4-8 | B | 4 | 8 GB | 80 GB | 90.00 | 0.12329 |

- Powered off, 50 GB disk: $7.50 a month, $0.0102 an hour (FAQ example).
- An A-type 1 GB server falls below Ubuntu 24.04's image minimum for some apps; the plain `ubuntu_server_24.04_64-bit`
  image lists `minRamMB` 1024, `minCpu` 1 and `minDiskSizeGB` 10 (calculator `os`), so 1 GB and 20 GB are allowed.
- Snapshots $0.05 per GB, extra traffic $0.01 per GB, extra IP $1 a month.
- Is there a **public price API**? Yes, only that calculator file (not a documented API). The authenticated
  `server options` call returns the same data (schema route `GET /service/server`).

### 8. Account, apps and names

- **No projects, folders or resource groups.** The CLI schema has no such command and the docs describe none
  (unverified: not found, not proven absent). All servers of an account are in one flat list (`GET /service/servers`
  returns id, name, datacenter, power). Sub-users and groups exist (account-management FAQ,
  https://www.kamatera.com/faq/answer/assign-permissions-to-servers/, titles only) but were not read.
- **Tags exist in the API but not in Terraform:** `cloudcli server create --tag`, `cloudcli server tags --add/--remove`
  (route `/server/tags`), and the docker-machine driver passes `--kamatera-tag`. The Terraform provider has no
  tag argument, and a server created by Terraform cannot carry one. Tag listing and filtering routes were not
  read (unverified).
- **Name rules** (cloudcli schema): `[a-zA-Z0-9()_-]{4,}`, at least 4 characters. **Names are not unique**: a
  duplicate gets a `(1)` suffix (issues #18, #25), which is why `(` and `)` are allowed, and which breaks the
  provider. `server info` and cloudcli accept a name, and the CLI says a name may be "a regular expression matching a
  single server" (flag text), so listing by prefix is possible.
- **Idempotency:** no idempotency key. Create returns a command id (`quantity` up to 50 in one call). A retry
  after a lost answer may create a second server named `<name>(1)`. Look the name up first (and the `(1)` form too).

### 9. Ubuntu 24.04, default user, startup script, time to ready

- **Image:** `ubuntu_server_24.04_64-bit`, id **`6000C29549da189eaef6ea8a31001a34`**, category `server`, `minRamMB`
  1024, `minCpu` 1, `minDiskSizeGB` 10, offered in **all 25** datacenters (calculator `os`, 2026-11-22). The image id is
  the same in every datacenter in this data (unlike OVHcloud). Terraform picks it with `os = "Ubuntu"`,
  `code = "24.04 64bit"` (README); the calculator `name` field is a different string, so look up by id. Images for
  Ubuntu 22.04 and 26.04 exist too. Many "apps_*" images are Ubuntu 24.04 based; do not use them.
- **Default user:** the server resource documents a **root password** and `ssh_pubkey` "to allow access without a
  password"; the user the key lands under is (unverified), most likely `root`. The password rules: 10 to 20 characters
  from `a-zA-Z0-9!@#$^&*()~` with a capital, a small letter and a digit (cloudcli schema).
- **Startup script:** `startup_script` (Terraform) / `script-file` (CLI) / `--kamatera-script` (docker-machine):
  "script to run on server startup, Bash script for Linux" (cloudcli doc). The provider sends it as `script-file`. It
  runs on boot; **whether it runs once or on every boot is (unverified)**.
- **User data:** the create API and cloudcli have `userdata-file` ("Path to user data file") and the docker-machine
  driver `--kamatera-userdata` ("user-data contents to add to the machine on creation"). The Terraform provider has
  **no such argument**. Whether Kamatera images run cloud-init and execute `#cloud-config` is **(unverified)**; I found
  no page that says so.
- **Time to ready:** not documented; the provider allows 40 minutes. A Kamatera knowledge-base page says a new
  server is added to the "Tasks Queue" (https://www.kamatera.com/knowledgebase/how-to-operate-a-linux-server-on-kamatera/,
  via a search summary). Measured time is (unverified).

### 10. Errors and limits

- **Error shape** (provider `request.go`): HTTP status other than 200 gives a JSON body; the provider prints
  `error response from Kamatera API (<status>): <map>`. Seen in the issues: `(500) map[message:{"errors":[{"code":2,
  "info":"Value expected to be 'number', 'string' given.","category":"General Error"}]}]` (#32) and
  `(500) No servers found (name='...')` (#25). The proxy's own errors are `{"error":true,"message":"Not Found"}`
  (404, my call) and `{"error":true,"message":"Argument 1 passed to str_starts_with() ..."}` (500, my call). So
  **errors are sometimes HTTP 500 for a user mistake**, and the shape varies.
- **Command queue:** every change returns a command id (a one-item list of strings, sometimes a bare number). Status
  is `GET /service/queue?id=<id>` and returns a list of one object with `status` (`complete` or `error` seen in the
  provider; a pending state's name is not known) and `log`. Create's `log` holds a line `Name: <final name>`, which
  the provider reads to learn the real name (`resource_server.go`). cloudcli also has `queue list` (`/svc/queue`).
- **Rate limits:** not documented (the API page says so by silence). (unverified)
- **Out of stock or quota:** no text was found. Whether a datacenter can refuse for capacity, and the per-account
  server cap or spend limit text, are (unverified). The user-level "maximum server price" and "server creation
  allotment" settings exist (titles in the permissions page's related list) and would produce a refusal.
- **Delete protection:** none found in the schema or docs (`server` fields: none).
- **Resize:** CPU and RAM change in place through `POST /service/server/configure` (`cpu`, `ram`); whether the
  server must be off, and whether a downgrade is allowed, are (unverified). Disk size changes are broken (issue #32).
  Resize cannot be tested without an account.
- **Removal:** terminate is `POST /service/server/terminate {id, force:true}` through the proxy
  (`resource_server.go`) and `DELETE /service/server/{id}/terminate?confirm=1&force=1` on the console API. The
  console says "the server must be turned off to terminate" (https://www.kamatera.com/faq/answer/terminate-server/);
  the API's `force` covers a powered-on one. Termination is a queued command, so the server can show for a while.
  Whether its disks, snapshots and library backups are deleted with it is (unverified).
- **Power and statuses:** `poweron`, `poweroff`, `reboot`, `suspend`, `resume` routes exist; the list's `power` field
  reads `on` or `off` (provider reads `server["power"] == "on"`). Other statuses are (unverified).

### What this means for OpsCrew

- **Terraform provider choice.** `Kamatera/kamatera` 0.9.4 (MPL-2.0, community tier, on the OpenTofu registry,
  last release 2025-09-11) is the only one found. It covers the server (name, datacenter, image, CPU, RAM, disks,
  billing cycle, power, one public key, startup script, daily backup flag) and private networks. It does not cover a
  firewall, snapshots, tags or user data. Pin 0.9.4. The plugin should be an IaC plugin for the server only, or a
  connector plugin, as the contract allows; the lead decides. If the contract needs the firewall or a snapshot from
  Terraform, Kamatera cannot give it.
- **Idempotency and names are the risk.** The server's Terraform id is its name, the API renames a duplicate to
  `<name>(1)`, and the provider then loses the server and leaves an orphan that bills (issue #25, open five
  years). OpsCrew must give every server a unique name (`opscrew-<app>-<short random>`, at least 4 characters,
  `[a-zA-Z0-9()_-]`), check the account's list for the name and for `<name>(1)` before every apply, and report a
  stray `(1)` server instead of ignoring it. Treat a failed apply as "check the list" before any retry.
- **Billing for the definition: hourly, counted by the minute, post-paid.** Hourly and monthly rates are the same
  per hour (monthly / 730), so hourly has no price disadvantage; use `billing_cycle = "hourly"` only. Show hourly and
  the 730-hour figure from a dated static table built from `calculator.js.php`. **A stopped server still costs**
  (about $7.50 a month for 50 GB: IP and disk), so the destroy text must say that only a terminate ends the cost.
  A monthly mode, if ever added, is charged in full for the calendar month after the 1st: say so before approval.
- **Credentials.** A client id and secret, **no scope** (unverified, nothing documented). Env vars:
  `KAMATERA_API_CLIENT_ID`, `KAMATERA_API_SECRET` (and `KAMATERA_API_URL`, `CLOUDCLI_*` for the CLI); the agent's
  environment must pass these and no other `KAMATERA_` or `CLOUDCLI_` variable (compare commit 59e65a49 for `OVH_`).
  No token prefix, so redact the exact values. The setup should warn that the key can do everything on the account
  and suggest a separate Kamatera account for OpsCrew. The root password the provider generates lands in
  Terraform state as `generated_password`; give a random password OpsCrew never shows, and rely on the SSH key.
- **Firewall path.** No cloud firewall resource, no documented API, console-only and **off by default**. The plugin has
  `firewallResourceType` and `connectorFirewall` in the contract; both have no honest value for Kamatera. The only
  protection OpsCrew can set at create time is an **in-server firewall** (nftables or ufw, default deny, 22, 80,
  443) written by the startup script, which is one more thing to verify after first boot and is not a cloud
  firewall: say so in the plan's text ("cloud firewall: none, server firewall: on"). The console firewall can be
  turned on by the user (their choice, mention it in the guide).
- **Startup script instead of cloud-init (unverified).** Terraform has no user data, only `startup_script`, and it is
  ForceNew; a change later fails unless `allow_recreate` is set (it would destroy the server and its disks). Set
  `allow_recreate = false` and say that a changed script means a new server. Check on a live account that the script
  runs once, as root, and after networking is up; and what cloud-init does on this image.
- **Removal.** `terminate` is real but asynchronous (a queue command, up to 40 minutes in the provider) and the
  server can be left powered on, so the provider forces it. The typed confirmation needs no billing-end date for
  hourly. **What stays behind is unclear:** snapshots and library backups may outlive the server and each cost
  $0.05 per GB a month (unverified); list them (console, `cloudcli server snapshot`, Hard Disk Library) before
  saying the cost is zero. `backupsOutliveServer` and `serverSnapshotsOutliveServer` should be set to the cautious
  value `true` until a live test says otherwise.
- **Backups and snapshots.** Daily backup is a flag with a "small monthly fee" and no known price; the calculator
  `backup` entry (0.5) has an unknown unit, so `backupsPrice` should be "order-page"-like or unknown, not a percent.
  Snapshots are $0.05 per GB (`kind: "per-gb"`, `perGbMonth` 0.05, `perGbHour` 0.05/730 = 0.0000685), per
  month by my reading. There is **no Terraform resource for either snapshot or backup restore**, so the snapshot
  drill and "snapshot before destroy" have to go through the API or the console.
- **Regions.** Frankfurt, Stockholm (code to confirm), New York, Santa Clara and Singapore (code to confirm) give a
  complete map. Asia and Sydney carry 1000 GB of traffic instead of 5000. Only 13 of the 25 codes have a city from
  Kamatera's own repository.
- **What the contract may lack:** (1) a provider without a cloud firewall at all; (2) a provider with **no tags and
  non-unique names** whose Terraform id is its name; (3) a **plan-time network call** to a price file (the provider's
  validation), which needs `disable_validations` offline; (4) account-wide credentials with no scope;
  (5) a **stopped-server cost** below the running one and above zero; (6) an asynchronous terminate whose "gone"
  moment is a queue state; (7) user data with no cloud-init guarantee (a script instead); (8) a resize that depends on
  an API bug for disks.
- **To test live** (needs an account, so the founder's go-ahead; a test server costs about $0.0055 an hour for the
  1 vCPU / 1 GB / 20 GB type A): the real datacenter ids and their cities, the Ubuntu 24.04 `os` and `code` strings,
  the login user and where the key lands, whether the startup script runs once and when, cloud-init presence,
  seconds to ready, the `(1)` behaviour on a duplicate name, the no-capacity and quota error texts, whether
  terminate removes disks, snapshots and backups, whether a snapshot or backup shows afterwards, the powered-off
  rate, IPv6, whether a key works from another IP, and whether the console firewall has a route in the API.

### What building Kamatera settled or changed (T3519 to T3532, 2026-11-27)

- **Names:** plain `<app>` and `<app>-<name>`, as on the other providers (plan decision 10), not the random suffix
  suggested above. The module refuses a name Kamatera refuses (4 to 40 characters of `[a-zA-Z0-9.-]`).
  `findAppServers` stops with a plain error when it sees a `<name>(n)` duplicate. That check runs on the takeover,
  destroy and snapshot paths, not before every apply.
- **Takeover:** not possible. The Terraform import needs the server's internal id, which the name doesn't give,
  so the provider has no `importId` and a takeover fails closed.
- **Commands:** a queued command is polled at `/service/queue?id=`. A failed command's error never carries its
  `log`, which can quote what the server was sent; the hint points at the server's tasks in the console instead.
- **Rebuild:** done as a snapshot revert, the only restore Kamatera's API has.
- **Prices:** six plans from `calculator.js.php` (A-1-2, A-2-4, A-4-8, B-1-2, B-2-4, B-4-8) with a 40 GB disk at
  least, since design sizes every app at 40 GB or more, in six datacenters (EU-FR, EU, EU-ST, US-NY2, US-SC,
  AS-SG). The calculator file is the price source; there is no price API.
- **The server's own firewall** (D13): nftables, written by the first boot's script, default deny, SSH from the
  plan's networks, 80 and 443 from the plan's `http_allowed_cidrs`. The script turns password logins off first,
  then loads the rules; if any step before the rules are loaded fails, the server powers itself off rather than
  stay reachable without them. SecOps reads the rules from the plan only for a server the plan creates, and
  `opscrew secure` and `opscrew advise` compare the live table with the committed plan's networks.
- **No restart repair:** a new Kamatera server that never opens SSH may have powered itself off for that reason,
  and if Kamatera doesn't run the startup script again on a later boot, a restart would bring it up without a
  firewall. OpsCrew doesn't offer that restart; it points at the first boot's log in the console.
- **The generated root password** stays only in the encrypted state. The live pass reads it from the state and
  searches every other file and log for it.
- **Still for the live pass (T3533):** whether the startup script runs on later boots; the first real
  `nft -f` of the rules (no root here); the seconds to ready and how long the server is open before the rules
  load; the `(n)` behaviour; what terminate leaves behind.

## R6. UpCloud

Read 2026-11-28 from: https://developers.upcloud.com/1.3/ ; /1.3/1-introduction/ ; /1.3/2-architecture/ ; /1.3/3-accounts/ ; /1.3/4-pricing/ ; /1.3/5-zones/ ; /1.3/7-plans/ ; /1.3/8-servers/ (first 100000 of 121245 chars) ; /1.3/9-storages/ ; /1.3/11-firewall/ ; /1.3/12-tags/ ; /1.3/24-api-tokens/ ; https://upcloud.com/docs/guides/getting-started-upcloud-api/ ; https://upcloud.com/docs/products/cloud-servers/ ; /plans/ ; /faq/ ; /availability/ ; https://upcloud.com/docs/products/networking/billing/ ; https://upcloud.com/docs/products/block-storage/billing/ ; https://upcloud.com/docs/getting-started/billing/ ; https://upcloud.com/docs/changelog/2026-04-15-starter-premium-servers/ ; https://raw.githubusercontent.com/UpCloudLtd/terraform-provider-upcloud/main/docs/index.md, docs/resources/server.md, docs/resources/firewall_rules.md, docs/resources/storage.md, docs/data-sources/storage.md, docs/data-sources/hosts.md ; https://api.github.com/repos/UpCloudLtd/terraform-provider-upcloud/releases/latest ; GitHub issue search for the same repo (firewall). Failed (HTTP 403/404 or empty): upcloud.com/pricing (403, twice), upcloud.com/products/cloud-servers (403), calc.upcloud.com (JS page, no data), registry.terraform.io (empty JS page), registry.opentofu.org API (404), developers.upcloud.com 6-/7-prices/8-... guessed paths (404), docs billing/ cloud-init pages (404), /docs/products/networking/firewall/ (fetch gave no text). No instructions aimed at AI agents were seen in any page. The pricing page, the firewall page, the plans page and the Starter and Premium changelog were then read in a browser (sections 3, 4 and 7), and the plan and template names came from a GitHub code search of the provider's and `upcloud-cli`'s repositories. No account was created and no authenticated call was made.

### 1. API and sign-in
- Base URL `https://api.upcloud.com/`, version in path, e.g. `/1.3/server`; current API version is 1.3 (/1.3/2-architecture/, /1.3/1-introduction/).
- Bearer API token is the primary method: `Authorization: Bearer <token>` (/2-architecture/). HTTP Basic "is also accepted but is discouraged and will be deprecated and disabled later"; docs recommend a sub-account for Basic (/2-architecture/). To use Basic you must first enable API access in the control panel (/2-architecture/).
- Token format: prefix `ucat_` + id, e.g. `ucat_01DQE3AJDEBFEKECFM558TGH2F` (/24-api-tokens/). Created in control panel (Account > API tokens), via API or `upctl` (getting-started-upcloud-api, /2-architecture/). Shown once.
- Create: `POST /1.3/account/tokens` fields `name` (1-1024 chars, required), `expires_at` (RFC 3339) or `expires_in` (e.g. `1h30min`), max 8760h (365 days), `can_create_tokens` (bool, default false), `allowed_ip_ranges` (0-100 CIDR/IP; empty list = denied everywhere; unset = account IP filters, else 0.0.0.0/0). Also `GET /1.3/account/tokens`, `GET/DELETE /1.3/account/tokens/{id}` (/24-api-tokens/). Tokens are NOT scoped by resource/permission in the docs read; scoping is by IP range and expiry only. The getting-started guide says "creating a token under a dedicated subaccount allows stricter permission scoping" (getting-started-upcloud-api; whether a token inherits a sub-account's permissions: unverified).
- Sub-account: `POST /1.3/account/sub` with `allow_api` (yes/no; "no effect on API tokens"), `allow_gui`, `roles` (billing, aux_billing, technical), `server_access` (list of {uuid or `*`, storage yes/no}), `storage_access` (UUIDs or `*`), `tag_access` (list of {name, storage}), `network_access` (default `*`), `ip_filters` (CIDR/range/IP; API only from those) (/3-accounts/). Sub-accounts can only access servers and storages and their own details (/3-accounts/). Username 4-64 chars; currency EUR/GBP/USD/SGD (/3-accounts/).
- Terraform provider env vars: `UPCLOUD_USERNAME`, `UPCLOUD_PASSWORD`, `UPCLOUD_TOKEN` (token marked "experimental"; also read from system keyring populated by `upctl account login`). Provider args `request_timeout_sec` (default 120), `retry_max`, `retry_wait_min_sec`, `retry_wait_max_sec` (docs/index.md).
- "Who am I": `GET /1.3/account` returns `credits`, `username`, `resource_limits` (`cores`, `memory` MiB, `storage_standard`, `storage_hdd`, `storage_maxiops` MiB, `storage_total`, `public_ipv4`, `public_ipv6`, `detached_floating_ips`, `networks`, `routers`, `network_gateways`, ... managed-service limits) (/3-accounts/). Per /4-pricing/ the currency of the account is read from the same endpoint (field name: unverified).

### 2. Terraform provider UpCloudLtd/upcloud
- Latest release read: v5.49.1, published 2026-11-09 (api.github.com releases/latest). Docs say `version = "~> 5.0"`, Terraform >= 1.0.0 (docs/index.md). Licence, official/partner tier, OpenTofu registry presence: unverified (registry pages did not render; the OpenTofu API URL I tried 404'd, which does not prove absence).
- `upcloud_server` (docs/resources/server.md): required `hostname`, `zone`; `plan` (or `cpu`+`mem` for custom), `title`, `labels` (map), `tags`, `metadata` (bool; "Required for recent cloud-init-based templates"), `user_data` (URL or script body), `firewall` (bool; enables Public & Utility firewall, independent of `firewall_private`), `firewall_private*`, `simple_backup {plan = daily|dailies|weeklies|monthlies, time = hhmm}` (cannot be combined with per-storage `backup_rule`), `server_group`, `host`, `hot_resize`, `boot_order`, `nic_model`, `video_model`, `timezone`.
  - `template { storage (UUID or template name), size (GB), title, tier, encrypt, filesystem_autoresize, delete_autoresize_backup, backup_rule {interval, retention, time} }`.
  - `network_interface { type (public|utility|private; private needs `network`), index, ip_address, ip_address_family (IPv4|IPv6), network, bootable, source_ip_filtering, additional_ip_address }`; set `index` explicitly.
  - `login { user, keys (list of public keys), create_password, password_delivery (none|email|sms) }`.
  - Which arguments force replacement, timeouts block, user_data size limit: not documented on the page (unverified). Data-source example warns a new template image version will replace the server unless `lifecycle { ignore_changes = [template[0].storage] }` (docs/data-sources/storage.md).
  - Import: `terraform import upcloud_server.x <server-uuid>`.
- `upcloud_firewall_rules` (docs/resources/firewall_rules.md): one resource per server (`server_id`); repeated `firewall_rule` blocks evaluated in the order defined; fields `action` (accept|drop), `direction` (in|out), `comment`, `family` (IPv4|IPv6), `protocol` (tcp|udp|icmp|""), `icmp_type`, `source_address_start/end`, `destination_address_start/end`, `source_port_start/end`, `destination_port_start/end` (start and end both required; ports only tcp/udp). A default rule may be given with only `action` and `direction` and "should be defined last". Max 1000 rules per server. Needs `firewall = true` on the server. Import ID: example is a UUID, presumed server UUID (not confirmed in the doc).
- `upcloud_storage`: `size`, `title`, `zone` required; `tier`, `encrypt`, `labels`, `backup_rule {interval (daily or weekday), time (UTC hhmm), retention (days)}`, `clone {id}`, `import {...}`; import ID = storage UUID. A storage with `backup_rule` cannot be attached to a server that has `simple_backup`.
- Other resources I did not read: `upcloud_floating_ip_address`, `upcloud_network`, `upcloud_server_group`, `upcloud_storage_backup` (existence unverified; I saw no on-demand backup resource in what I read). Open issues seen: #1082 "IPv6 not supported in upcloud_firewall_ruleset", #1027 "Purpose of firewall_ruleset unclear" (these concern a different resource, `upcloud_firewall_ruleset`, not `upcloud_firewall_rules`; the issue search was limited to the word "firewall").

### 3. Billing

Read 2026-11-28 in a browser from https://upcloud.com/pricing/ ("Pricing updated: 24/10/2026"; it answers 403 to
plain fetches) and https://upcloud.com/docs/products/cloud-servers/plans/.

- **Prepaid, by the hour:** UpCloud's pricing FAQ describes a prepaid balance from which services are deducted
  hourly. When the credits run out, active resources are disabled until the balance is positive (/3-accounts/).
- **By the starting hour, capped:** Starter, Premium and Cloud Native plans are each "billed by the starting hour,
  maximum of 28 days per month" (pricing page). So the hourly rate is the monthly price / 672, and a month of 730
  hours costs the monthly price. The plans page says every plan has a capped monthly price but is billed by the
  hour. Prices exclude local taxes (VAT).
- **EUR only:** payments in USD, GBP or SGD are exchanged to EUR (pricing FAQ). The account's billing is in EUR
  whatever the payment currency.
- **What ends the cost:** deleting a service stops its charges (pricing FAQ). The Cloud Native table says "Server
  stopped, no charges"; the Starter and Premium tables don't, so a stopped Starter or Premium server is read as
  still billing its plan (unverified until the live pass).
- **Included:** one public IPv4 address per plan; an additional public IPv4 or a floating IP is €3.47 a month;
  public IPv6 €0.00; transfer in and out €0.00 under the Fair Transfer Policy; firewall, SDN private network and
  router €0.00 (pricing page). Outbound SMTP (port 25) is closed on new accounts until support opens it (section 4).
- **Free trial:** new sign-ups get free credit, and the firewall is locked to certain ports during the trial
  (pricing FAQ; firewall docs). A 30-day money-back on the first payment.

### 4. Firewall and networking

Read 2026-11-28 in a browser from https://upcloud.com/docs/products/networking/firewall/, and from the provider's
`examples/resources/upcloud_firewall_rules/resource.tf` and `docs/resources/server.md`.

- **Two firewalls:** the **Public & Utility Firewall** (public and utility interfaces, IPv4 and IPv6, **stateless**,
  the first matching rule from the top wins, one ruleset per server, at most 1000 rules, not shareable) and the
  **SDN Firewall** (SDN private networks only, IPv4 only, stateful, rulesets shared like security groups, a drop
  rule wins whatever the order) (firewall docs).
- **Stateless:** the docs say that users must allow both incoming and outgoing traffic explicitly. Return traffic of
  the server's own outgoing connections (package and image downloads, the app's calls to other services) is not let
  in by itself: it needs inbound rules for the ephemeral ports (32768-60999 on Ubuntu), open to every source. A rule
  can match a source port, but a stateless rule can't tell a reply from a new connection.
- **On and off:** when the firewall is disabled all traffic is allowed; when enabled, traffic is filtered by the
  rules (firewall docs). Terraform's `firewall` (bool) on `upcloud_server` turns on the Public & Utility firewall,
  and `upcloud_firewall_rules` (one per server) holds its rules (section 2). The default rule's action on a new
  server, and what an enabled firewall with no rule does, are not stated (unverified).
- **Free:** all firewall features are included at no cost (firewall docs, pricing page).
- **SMTP:** outbound port 25 is blocked on new accounts, shown in the server's firewall settings, and can't be
  changed there; support lifts it after identity verification (firewall docs).
- **Trial:** the firewall is locked during the free trial and allows only certain ports (firewall docs).
- **Interfaces:** public, utility and private (SDN) (/8-servers/; in 1.3 `private` is SDN and the former private is
  `utility`). Up to 5 public IPv4 addresses per server; public IPv6 free (pricing page).

### 5. Backups and snapshots
- Simple Backup: fixed monthly rate of +10%, +20%, +40% or +60% of the Cloud Server plan price, independent of the number of backups (block-storage/billing). Terraform `simple_backup.plan` values: daily, dailies, weeklies, monthlies.
- Flexible and on-demand backups billed per GiB per hour (block-storage/billing). Snapshot price: not mentioned.
- Create: `POST /1.3/storage/{uuid}/backup` (body `title`), 201, storage goes to `backuping`. List: `GET /1.3/storage/backup`. Restore: `POST /1.3/storage/{uuid}/restore`, 204, attached server must be stopped (else 409 `SERVER_STATE_ILLEGAL`). No dedicated delete-backup route documented; backups are removed via `DELETE /1.3/storage/{uuid}?backups=keep|keep_latest|delete` (default keep) or presumably deleting the backup storage itself (unverified). Templatize: `POST /1.3/storage/{uuid}/templatize`, maxiops only (`STORAGE_TIER_ILLEGAL`). Errors: `INSUFFICIENT_CREDITS` (402), `STORAGE_RESOURCES_UNAVAILABLE`, `STORAGE_STATE_ILLEGAL` (409) (/9-storages/).
- Async: backup/clone/templatize run asynchronously; poll `GET /1.3/storage/{uuid}` until state `online`. Storage states: online, maintenance, cloning, backuping, syncing, error (/9-storages/).
- Server delete: `DELETE /1.3/server/{uuid}?storages=0|1&backups=keep|keep_latest|delete`; requires `stopped`; releases IPs; kept storages can be reattached; `backups=delete` without `storages=1` not allowed; default `backups=keep`, so backups outlive the server by default (/8-servers/). Storage `backup_rule`: interval daily|mon..sun, time 0000-2359 UTC, retention 1-1095 days (/9-storages/).

### 6. Regions
- Per cloud-servers/availability (15 locations): au-syd1 Sydney AU; de-fra1 Frankfurt DE; dk-cph1 Copenhagen DK; es-mad1 Madrid ES; fi-hel1 and fi-hel2 Helsinki FI; nl-ams1 Amsterdam NL; pl-waw1 Warsaw PL; no-svg1 Stavanger NO; se-sto1 Stockholm SE; sg-sin1 Singapore; uk-lon1 London UK; us-chi1 Chicago US; us-nyc1 New York US; us-sjo1 San Jose US. No private-only zones listed on that page; the API `GET /1.3/zone` example also shows a `fi-fake-priv-cloud` private zone (parent fi-hel1) (/5-zones/). Whether plans are available in every zone: page says Cloud Servers are available in all locations; per-plan grid unreadable. Whether `GET /1.3/zone` needs auth: unverified.
- au-syd1, dk-cph1, es-mad1, no-svg1, se-sto1 lack 2nd-4th generation CPUs (availability page; meaning of the dash is my reading).

### 7. Prices

Read 2026-11-28 in a browser from https://upcloud.com/pricing/ ("Pricing updated: 24/10/2026"; EUR, "Global price",
before VAT; Helsinki had its own column for the discontinued General Purpose plans only). Plan **names** from the
provider's examples (`PREMIUM-1xCPU-1GB`, `PREMIUM-2xCPU-4GB`) and `upcloud-cli`'s
`internal/commands/server/plan_list.go`, which sorts plans by the prefixes `PREMIUM-`, `STARTER-` and `DEV-` (GitHub
code search of `UpCloudLtd/terraform-provider-upcloud` and `UpCloudLtd/upcloud-cli`).

- **Families** (since 2026-04-15, https://upcloud.com/docs/changelog/2026-04-15-starter-premium-servers/):
  **Starter** (previous-generation AMD CPUs, Standard storage, 99.99% SLA, replacing the Developer plans),
  **Premium** (latest AMD EPYC, MaxIOPS storage, 99.999% SLA, 1000 Mbps), **Cloud Native** (CPU and memory only;
  storage and IP addresses bought apart). The Developer and General Purpose plans are listed as discontinued, no
  longer available for deployment.
- **Starter** (memory, cores, Standard storage, monthly): 1 GB/1/10 GB €3 (at most 5 per customer); 2 GB/1/20 GB €6;
  2 GB/2/30 GB €8; 4 GB/1/30 GB €10; 4 GB/2/30 GB €12; 8 GB/2/40 GB €18; 8 GB/4/40 GB €20; 16 GB/2/50 GB €24;
  16 GB/4/50 GB €28.
- **Premium** (memory, cores, MaxIOPS storage, monthly): 1 GB/1/25 GB €5; 2 GB/1/25 GB €12; **2 GB/2/50 GB €16**;
  **4 GB/2/50 GB €26**; **8 GB/2/100 GB €38**; **8 GB/4/100 GB €52**; 16 GB/2/150 GB €72; **16 GB/4/150 GB €92**;
  16 GB/8/200 GB €148; then up to 512 GB/80 cores/500 GB €2552.
- **Cloud Native:** from 4 GB/1 core €12 (no storage, no IP address).
- **Block storage** (per GB a month, billed by the hour): MaxIOPS €0.220, Standard €0.115, Archive €0.100, custom
  image €0.330.
- **Backups:** Simple Backups at +10% (day plan: daily, kept 24 h), +20% (week plan: daily for 7 days), +40% (month
  plan) or +60% (year plan) of the server plan's price; **flexible and on-demand backups €0.056 per GB a month**,
  billed by the hour per GB (pricing page).
- **Same price in every zone:** the current tables give one "Global price" (pricing page). The price API
  (`GET /1.3/price`) answers per zone and in the account's currency (/4-pricing/), so a zone could still differ
  (unverified).
- **Plan names:** the Premium pattern `PREMIUM-<cores>xCPU-<memory>GB` is confirmed for `1xCPU-1GB` and `2xCPU-4GB`
  only; the other names follow the pattern (unverified until `GET /1.3/plan` is read with a token). `GET /1.3/plan`
  lists each plan's `core_number`, `memory_amount`, `storage_size`, `storage_tier` and `public_traffic_out`
  (/7-plans/); whether it needs a token is not stated.

### 8. Account, apps and names
- Account is flat in the API; the billing docs mention "workspaces" each with their own billing and credits (getting-started/billing). No project concept in the API docs read.
- Labels (preferred over tags): up to 255 per server, key 2-32 printable ASCII not starting with `_`, value 0-255 chars (/8-servers/). `GET /1.3/server` filters: `label` (case-insensitive, matches all values given), `tag` (`:` or `,` separated), `host`, `search`, `state`, `uuid`; `limit`/`offset`; exact label query syntax (key=value?) unverified.
- Tags: 1-32 chars of `[A-Za-z0-9_]`; only the main account can create or modify tags; sub-accounts only list; assign via `POST /1.3/server/{uuid}/tag/{tags}`; tags must pre-exist; docs recommend labels instead (/12-tags/).
- Hostname up to 128 chars, title 0-255 (/8-servers/). Uniqueness of hostname/title: unverified (not stated).

### 9. Ubuntu 24.04, default user, cloud-init
- Template list: `GET /1.3/storage/template` (/9-storages/, whose example shows only Ubuntu 22.04). The provider's
  own docs and examples (`docs/index.md`, `docs/resources/server.md`, `docs/resources/firewall_rules.md`,
  `examples/resources/upcloud_server/resource.tf`) all use `template { storage = "Ubuntu Server 24.04 LTS (Noble
  Numbat)" }` with `metadata = true` (the docs say the metadata service must be on for recent cloud-init based
  templates). `template.storage` takes a template's name or UUID.
- Server create: `login_user` {username default `root`, up to 32 SSH keys}; "cloud-init templates require" SSH keys; `user_data` = URL or script run as root on first boot, ignored for non-Linux; `metadata` yes/no, metadata service at 169.254.169.254 reachable from inside only (/8-servers/); Terraform says `metadata` is required for recent cloud-init templates. Size limit of user_data and time to ready: unverified. New server passes through `maintenance` and then `started`.
- Create limits: hostname 128 chars, storage 10-1024 GB per device, 1-10 interfaces (public, utility, private) (/8-servers/).

### 10. Errors and limits
- Error body `{"error": {"error_code": "...", "error_message": "..."}}`; 4xx client, 5xx server; 401 `AUTHENTICATION_FAILED`; `API_VERSION_INVALID`, `API_VERSION_OBSOLETE` (/2-architecture/). Seen codes: `INSUFFICIENT_CREDITS` (402), `SERVER_STATE_ILLEGAL`, `STORAGE_STATE_ILLEGAL`, `STORAGE_ATTACHED`, `STORAGE_DEVICE_LIMIT_REACHED`, `TAG_FORBIDDEN`, `SERVER_FORBIDDEN`, `SERVER_NOT_FOUND`, `FIREWALL_RULE_LIMIT_REACHED`. Exact quota error code (e.g. `*_LIMIT_REACHED` for cores/memory) and `ZONE_NOT_FOUND`: unverified.
- Rate limits: not stated on the pages read (unverified). Resource limits come from `GET /1.3/account` `resource_limits`; how to raise them (support request): unverified.
- Server states `started`, `stopped`, `maintenance`, `error`. Start `POST /1.3/server/{uuid}/start` (needs stopped; `start_type` sync default or async). Stop `POST .../stop` (needs started; `stop_type` soft default or hard; `timeout` 1-600 s then hard stop; state stays `started` until shutdown done). Restart `POST .../restart` (`timeout` required for soft; `timeout_action` destroy|ignore). Cancel `POST .../cancel`. Resize: `PUT /1.3/server/{uuid}`; decreasing cores or memory needs `stopped`. Rebuild `POST .../rebuild` (stopped only). Delete route and options: see section 5. Poll `GET /1.3/server/{uuid}` for `state` (/8-servers/). `GET /1.3/server_size` lists allowed core/memory combos.

### What this means for OpsCrew

- **Sign-in:** an API token only (`UPCLOUD_TOKEN`, `Authorization: Bearer`), the method UpCloud recommends; Basic
  sign-in is discouraged and will be retired. The Terraform provider reads the same variable (marked experimental in
  its docs). A token can't be limited to some resources, only to IP ranges and an expiry of at most 365 days, so the
  guide recommends making it under a sub-account limited to servers and storage, with an expiry of 90 days or less.
  `GET /1.3/account` is the credentials check (it returns the user name, the credits and the resource limits).
- **Firewall:** the Public & Utility firewall is stateless. To let the server's own downloads and the app's outgoing
  calls back in, its rules would have to open the ephemeral ports to every address, which SecOps rightly fails as
  ports open to the whole internet, and a source-port rule can be spoofed. The server's own stateful nftables
  firewall, which OpsCrew already installs first in a script first boot (Kamatera, issue #13), does what OpsCrew's
  rules mean, and UpCloud runs `user_data` as a script on the first boot. Using it needs no contract change.
- **Sizes:** design asks for 40 GB of disk at least (60 GB with PostgreSQL). Starter plans hold 10 to 50 GB and,
  where they fit, cost more than Premium's 2 GB/2-core plan, so Premium plans at their included MaxIOPS disk are the
  ones to offer: `PREMIUM-2xCPU-2GB` (50 GB, €16), `PREMIUM-2xCPU-4GB` (50 GB, €26), `PREMIUM-2xCPU-8GB` (100 GB,
  €38), `PREMIUM-4xCPU-8GB` (100 GB, €52), `PREMIUM-4xCPU-16GB` (150 GB, €92), each by the hour at monthly / 672.
- **Finding an app's servers:** labels (tags need the main account); names are plain `<app>` and `<app>-<name>`, as
  on every provider, as the server's hostname and title, and the list is matched on the title.
- **Snapshots:** on-demand backups of the server's disk through the API (€0.056 per GB a month), awaited by polling
  the storage's state; a restore needs the server stopped. The provider has no snapshot resource.
- **Provider backups:** Simple Backup's week plan (`simple_backup { plan = "dailies" }`, daily backups kept 7 days)
  at +20% of the plan's price, like Hetzner's 20%.
- **Regions:** every OpsCrew region has a zone: `eu-central` Frankfurt (then Amsterdam, Warsaw), `eu-north` Helsinki,
  `us-east` New York, `us-west` San Jose, `ap-southeast` Singapore.

#### To test live (needs a real account)

- The Premium plan names beyond `PREMIUM-1xCPU-1GB` and `PREMIUM-2xCPU-4GB`, their availability in each zone (the
  availability page shows Stockholm, Copenhagen, Stavanger, Madrid and Sydney without the newer CPU generations), and
  whether `/plan`, `/price` and `/zone` answer without a token.
- Whether a stopped Premium server keeps billing its whole plan.
- That `user_data` holding a shell script runs once, as root, on the first boot of the Ubuntu 24.04 template with
  `metadata = true`; its size limit; the default user and where `login.keys` go; the time to `started`.
- Which `upcloud_server` arguments force a replacement, and whether `ignore_changes` on `user_data` and
  `template[0].storage` keeps a later change from rebuilding the server.
- Whether the server's backups (on-demand and Simple Backup) outlive a `terraform destroy` of the server, and the
  route that deletes a backup.
- The label filter's syntax on `GET /1.3/server`, whether titles must be unique, and the error codes for a used-up
  resource limit, an unknown zone and no capacity; the API's rate limits.
- Whether a token made by a sub-account carries only that sub-account's rights.
- The Terraform provider's licence, tier and listing on the OpenTofu registry (its registry pages render only with
  JavaScript).
