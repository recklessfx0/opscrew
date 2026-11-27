# Deploy to OVHcloud

OpsCrew can create your app's server in [OVHcloud](https://www.ovhcloud.com/)'s Public Cloud, on
your own account, as it does at [Hetzner Cloud](hetzner.md), [DigitalOcean](digitalocean.md),
[Contabo](contabo.md), [Kamatera](kamatera.md) and [IONOS Cloud](ionos.md). You get the same result: a hardened server, the app deployed from
[GitHub](https://github.com/) with TLS, health checks and rollback, and the `verify`, `secure` and
`drift` checks.

## What OVHcloud is here

- **Servers in your Public Cloud project.** OVHcloud keeps servers in a Public Cloud project, which
  you create once. OpsCrew puts the app's server, its SSH key and its security group (OVHcloud's
  firewall) in that project, and touches nothing else in your account.
- **Billed by the hour.** A server is billed per second, with a one-minute minimum, from the moment
  it runs until it is deleted. Deleting it stops its billing at once: there is no term to run out, unlike
  [Contabo](contabo.md).
- **Prices in EUR, before VAT.**

## Before you start

1. **Create a Public Cloud project** in [the control panel](https://manager.eu.ovhcloud.com/), under
   Public Cloud. The project is free, but OVHcloud asks for a payment method when you create it.
2. **Activate the regions you'll use.** Open Public Cloud → your project → Settings → Quota &
   Regions, and activate the regions OpsCrew will use for your app (see [Regions](#regions)). OpsCrew
   never activates a region for you. With the four variables set (step 5), `npx opscrew init` lists
   the regions your Public Cloud project has activated, and design offers only the models it can
   have there; without them, design shows every model in every region.
3. **Create a service account** under Identity and Access Management → Identities → Service account
   (OVHcloud's guide:
   <https://docs.ovhcloud.com/en/guides/manage-and-operate/api/manage-service-account>). Keep its
   client ID and secret: OVHcloud shows the secret only once.
4. **Limit it to your Public Cloud project** with an IAM policy, under Identity and Access
   Management → Policies:
   - the identity: the service account;
   - the only resource: your Public Cloud project, `urn:v1:eu:resource:publicCloudProject:<project id>`;
   - the actions: `publicCloudProject:apiovh:*`.

   A service account can do nothing until a policy names it, and with this one it reaches nothing
   else in your account.
5. **Set the four variables.** OpsCrew needs all four:

   | Variable | The value |
   |---|---|
   | `OVH_ENDPOINT` | `ovh-eu` |
   | `OVH_CLIENT_ID` | the service account's client ID |
   | `OVH_CLIENT_SECRET` | the service account's client secret |
   | `OVH_CLOUD_PROJECT_SERVICE` | your Public Cloud project's id, which the control panel shows under the project's name |

   ```bash
   export OVH_ENDPOINT=ovh-eu OVH_CLIENT_ID=… OVH_CLIENT_SECRET=… OVH_CLOUD_PROJECT_SERVICE=…
   ```

   When one is missing, or `OVH_ENDPOINT` is anything but `ovh-eu`, `npx opscrew init` and
   `npx opscrew provision` say which and call nothing.

- **They stay on your computer.** OpsCrew uses them only there, to plan and change your servers.
  They never go to the server or to GitHub, and OpsCrew masks all four, the project's id included,
  in every message, log, audit entry and report.
- **Keep them out of your app.** `npx opscrew scan` reports them as a leaked secret when they turn
  up in your app's files or environment.

## Step by step

1. `npx opscrew interview`: choose **OVHcloud**. When only OVHcloud's credentials are set, OpsCrew
   chooses it without asking. In scripts, put `provider: ovhcloud` in your answers file.
2. `npx opscrew design` shows OVHcloud's models with their hourly price and what 730 hours cost
   (see [Models and prices](#models-and-prices)).
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan:
   - the server, billed by the hour, with Ubuntu 24.04 and the same first-boot hardening as on the
     other providers;
   - its SSH key, `<app>-deploy`;
   - an OVHcloud security group, `opscrew-<app>`, attached from the first boot: SSH from the
     networks you allow, the web ports (80 and 443, and UDP 443 for HTTP/3) on the server that
     serves your site, ping, and WireGuard where it is used. OpsCrew always attaches it: your
     Public Cloud project's default group lets every port be reached from the internet.
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` work as on the other
   providers.

When OVHcloud has no stock of a model in a region, or your Public Cloud project has reached its
quota, OpsCrew shows OVHcloud's answer in plain English with what to try next.

## Models and prices

| Model | vCPU | Memory | Disk (NVMe) | EUR an hour | 730 hours |
|---|---|---|---|---|---|
| d2-4 | 2, shared | 4 GB | 50 GB | 0.0206 | 15.04 |
| d2-8 | 4, shared | 8 GB | 50 GB | 0.0372 | 27.16 |
| b3-8 | 2, dedicated | 8 GB | 50 GB | 0.0512 | 37.38 |
| b3-16 | 4, dedicated | 16 GB | 100 GB | 0.1023 | 74.68 |

An app with a PostgreSQL database needs a 60 GB disk, and every model but `b3-16` has at most
50 GB, so on OVHcloud such an app gets `b3-16`: €74.68 for 730 hours before VAT. An app without a
database fits a `d2-4` (€15.04).

- **Before VAT,** dated 2026-11-21, from OVHcloud's public catalogue. OVHcloud adds your country's
  VAT on the invoice. OpsCrew shows every provider's prices before VAT.
- **Live when the credentials are set.** With the four variables, design reads the prices from
  OVHcloud's public catalogue, and which models your Public Cloud project can have in each region.
  Without them, it shows this dated table, and says so.
- **The 730-hour figure** is a month of a server that runs all the time. A server that runs for less
  costs less: OVHcloud bills the seconds it ran.
- **The same price in every region.**
- **d2 or b3:** the d2 models (Discovery) share their vCPUs with other servers; the b3 models
  (General Purpose) guarantee them.

## Regions

| Your answer in the interview | OVHcloud's region |
|---|---|
| Central Europe | Limburg (near Frankfurt), Strasbourg, Gravelines or Warsaw |
| Northern Europe | Warsaw: OVHcloud's locations in the Nordics are local zones OpsCrew doesn't use, so it uses the nearest region, and design says so |
| United States, east coast | Beauharnois, near Montreal |
| United States, west coast | Beauharnois, near Montreal, which is far from the west coast |
| Southeast Asia (Singapore) | Singapore or Sydney |

OVHcloud's regions in the United States belong to OVHcloud US, a separate company with its own
accounts, so OpsCrew uses Beauharnois, in Canada, for both answers, and design says so.

Activate the region in your Public Cloud project before you provision (see
[Before you start](#before-you-start)).

## Removing the app

While another app runs on the server (see
[A second app on another app's server](shared-server.md)), `npx opscrew destroy` refuses and
names it: remove or move that app first.

`npx opscrew destroy` shows the plan and asks you to type the server's name before it changes
anything. Then it deletes:

- **the server,** whose billing stops when it is deleted;
- **its security group, its SSH key and the DNS records OpsCrew made for the app.**

When the server holds your app's data, OpsCrew first offers a snapshot of it. **What keeps
billing:**

- **Snapshots.** OVHcloud keeps a server's snapshots in your Public Cloud project after the server
  is gone, the one destroy takes and any other, and bills them per GB a month (€0.011 per GB a
  month before VAT on 2026-11-21; see [OVHcloud's prices](https://www.ovhcloud.com/en-ie/public-cloud/prices/))
  until you delete them in the control panel: Public Cloud → your project → Compute → Instance
  Snapshot.
- **Your Public Cloud project** costs nothing by itself, and OpsCrew leaves it, with its regions,
  as it is.

### A create that stopped halfway

OVHcloud can't tell a repeated create from a new one, so OpsCrew never repeats a create. When a
create stops halfway, the next `npx opscrew provision` looks for the app's server in your Public
Cloud project first, shows it in the plan and takes it over, without creating another one.

## Snapshots

```bash
npx opscrew snapshot --server        # OVHcloud's snapshot of the whole server
npx opscrew restore --server <id>    # put the server back to it
```

- **Billed per GB a month,** €0.011 before VAT, until you delete it in the control panel, even after
  the server is gone. The summary shows the rate before you take one.
- **Restoring rebuilds the server** from the snapshot: everything written since is lost. You type
  the server's name to approve it (see [Snapshots and restores](snapshots.md)).

## What isn't offered

Each of these is a limit of OpsCrew on OVHcloud for now, with what to do instead:

- **Only OVHcloud Europe accounts** (`OVH_ENDPOINT=ovh-eu`). Accounts of OVHcloud Canada (`ovh-ca`)
  and OVHcloud US (`ovh-us`) are refused. Use an OVHcloud Europe account, or another provider.
- **Only hourly billing.** OVHcloud's monthly billing costs less a month on some models, but it
  bills each month begun in full, even after the server is deleted. OpsCrew offers only the hourly
  one, and doesn't switch a server to monthly. Switching it yourself in the control panel can't be
  undone, and a removal then keeps billing to the end of the month.
- **No OVHcloud automated backups.** Their images outlive the server and keep billing per GB.
  OpsCrew's own data snapshots, with their encrypted copy off the server, cover your data instead:
  see [Snapshots and restores](snapshots.md).
- **No resizing.** OpsCrew can't change a server's model in place, so design and advise refuse a
  new size on OVHcloud. Instead:
  - **move to another provider** with `npx opscrew retarget --to <provider>`, with a short
    maintenance window while the data is copied (see [Moving your app somewhere else](retarget.md));
    `retarget` doesn't move an app within OVHcloud;
  - or **stay on OVHcloud, with downtime:** take a data snapshot with its off-server copy, remove
    the server with `npx opscrew destroy`, choose the new size with `npx opscrew design`, run
    `npx opscrew provision`, then restore the copy, as [on Contabo](contabo.md#changing-the-size).
- **No delete protection.** Deleting the server in the control panel deletes it and its disk at
  once. Use `npx opscrew destroy` instead, which shows the plan, offers a snapshot and asks for the
  typed name first.
- **Not yet:** OVHcloud's Object Storage, private networks (vRack), load balancers and local zones.
  OpsCrew's own private network (WireGuard) connects the app's servers and your devices as on the
  other providers: see [Your devices on the private network](private-network.md). For your app's
  files, see [Object storage](object-storage.md).

## Without OpsCrew

The Terraform code OpsCrew writes to `opscrew/infra/<env>/` runs without OpsCrew too. Set
`OVH_ENDPOINT`, `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET` as above, and your Public Cloud project's id
as `TF_VAR_ovhcloud_project_id`:

```bash
export TF_VAR_ovhcloud_project_id="$OVH_CLOUD_PROJECT_SERVICE"
```

OpsCrew passes it that way and never writes it to a file in your repository.

## Replacing the credentials

`npx opscrew rotate` lists OVHcloud's values among your own tokens. Create a new service account
(it has no rights until a policy names it), add it to the IAM policy limited to your Public Cloud
project, set `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET`, then run `npx opscrew rotate ovhcloud`, and delete the old one in the control panel under Identity
and Access Management → Identities → Service account: see
[Rotating your app's credentials](credential-rotation.md).
