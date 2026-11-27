# Deploy to IONOS Cloud

OpsCrew can create your app's server at [IONOS Cloud](https://cloud.ionos.com/), on your own
contract, as it does at [Hetzner Cloud](hetzner.md), [DigitalOcean](digitalocean.md),
[Contabo](contabo.md), [OVHcloud](ovhcloud.md) and [Kamatera](kamatera.md). You get the same
result: a hardened server, the app deployed from [GitHub](https://github.com/) with TLS, health
checks and rollback, and the `verify`, `secure` and `drift` checks.

## What IONOS Cloud is here

- **For businesses only.** IONOS Cloud sells its cloud to businesses, not to private people.
- **Servers in Germany and the US:** Frankfurt, Berlin, Newark and Lenexa (see
  [Locations](#locations)).
- **Billed by the minute,** from the moment the server is created until it is deleted. A stopped
  server still bills (see [What keeps billing](#what-keeps-billing)).
- **Prices in EUR, before VAT.** No setup fee. A contract with IONOS CLOUD Inc., IONOS's US
  company, is billed in USD, at its own prices.
- **A cloud firewall on the server's network card,** which OpsCrew sets and checks (see
  [The firewall](#the-firewall)).

## The token

OpsCrew signs in to IONOS Cloud with a token only. It never reads a user name or a password.

**A token can't be limited.** It has no scope of its own: it acts as the user who made it, with
everything that user may do. So make it as a sub-user that may do only what OpsCrew needs:

1. In IONOS's [Data Center Designer](https://dcd.ionos.com/), as the contract's owner or an
   administrator, open **Users & Groups**.
2. Create a group for OpsCrew. On its **Privileges** tab, tick only these three:
   - **Create Data Center:** OpsCrew makes a data centre for each server;
   - **Create Snapshot:** for whole-server snapshots;
   - **Reserve IP:** each server keeps a reserved address.
3. Create a user for OpsCrew and add it to that group only.
4. Sign in to the Data Center Designer as that user, open the **Token Manager** (IONOS's steps:
   <https://docs.ionos.com/cloud/set-up-ionos-cloud/management/identity-access-management/token-manager>)
   and generate a token. **Give it at most 90 days.** IONOS allows up to 365 days, and a token
   stops working when its time is up. IONOS shows the token only once.
5. Set the variable:

   | Variable | The value |
   |---|---|
   | `IONOS_TOKEN` | the token |
   | `IONOS_API_URL` | only to point OpsCrew at another address of IONOS's Cloud API |

   ```bash
   export IONOS_TOKEN=…
   ```

   When it is missing, `npx opscrew init` and `npx opscrew provision` say so and call nothing.

- **When the token is wrong or has expired,** IONOS answers that it can't sign you in, and OpsCrew
  says to make a new token in the Token Manager.
- **When the user lacks a privilege,** OpsCrew names the one IONOS refused and where to add it: the
  group's **Privileges** tab in **Users & Groups**.
- **It stays on your computer.** OpsCrew uses the token only there, to plan and change your
  servers. It never goes to the server or to GitHub, and OpsCrew masks it in every message, log,
  audit entry and report.
- **Keep it out of your app.** OpsCrew's analysis treats your app's `IONOS_*` variables as a
  provider's credentials. IONOS documents no format for its tokens, so keep them out of your app's
  files yourself.

## Step by step

1. `npx opscrew interview`: choose **IONOS Cloud**. When only `IONOS_TOKEN` is set, OpsCrew chooses
   it without asking. In scripts, put `provider: ionos` in your answers file.
2. `npx opscrew design` shows IONOS's sizes with their hourly price and what 730 hours cost (see
   [Sizes and prices](#sizes-and-prices)), and the delay from the location to your visitors.
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan, for
   each server:
   - **a data centre of its own,** named `opscrew-<server>`, in the location design chose. IONOS
     doesn't bill a data centre by itself;
   - a public network in it, and a reserved IPv4 address (see [Sizes and prices](#sizes-and-prices));
   - the server: a vCPU server with Ubuntu 24.04 on an Essential disk, with that address, and the
     same first-boot hardening as on the other providers, which IONOS runs from the disk's
     cloud-init;
   - the deploy key, which IONOS puts on the disk when it creates it. IONOS keeps no SSH keys of
     its own, and OpsCrew sets no password;
   - the firewall on the server's network card (see [The firewall](#the-firewall)).
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` work as on the other
   providers.

When IONOS refuses a create, OpsCrew shows IONOS's answer in plain English with what to try next.
Your contract has limits on cores, memory, disk and public addresses. IONOS publishes no default
values for them: when a plan needs more, ask IONOS's support to raise the limit it names.

**A data centre left half made.** IONOS's Terraform provider doesn't undo what it made before a
create failed, so a data centre can be left with or without its server. OpsCrew names it. The next
`npx opscrew provision` carries on from what the state records, and `npx opscrew destroy` deletes
the data centre whatever is in it.

## The firewall

**Cloud firewall: on.** OpsCrew turns on IONOS's firewall on the server's network card, with one
rule per allowed network and port:

- SSH from the networks you allow;
- the web ports (80 and 443, and UDP 443 for HTTP/3) on the server that serves your site;
- WireGuard's port where the app's [private network](private-network.md) uses it;
- ping.

- **On from the start.** The firewall is on when the server is created. With no rule it lets
  nothing in, so the server is never open while the rules are made.
- **Incoming traffic only.** Outgoing traffic isn't filtered.
- **IPv4 only.** The server has no IPv6 address, so the rules hold IPv4 networks only, and IPv6
  networks you allow are left out.
- **Changed in place.** Each rule is its own resource, so a change to the networks you allow
  changes only the rules concerned at the next `npx opscrew provision`.
- **Checked:** `npx opscrew secure` fails when the firewall is off or none of OpsCrew's rules is on
  the server, and says to run `npx opscrew provision` again.

## Sizes and prices

| Size | vCPU | Memory | Disk | EUR an hour | 730 hours |
|---|---|---|---|---|---|
| vcpu-1-2 | 1 | 2 GB | 40 GB | 0.0252 | 18.37 |
| vcpu-2-4 | 2 | 4 GB | 80 GB | 0.0434 | 31.67 |
| vcpu-4-8 | 4 | 8 GB | 160 GB | 0.0798 | 58.28 |
| vcpu-2-8 | 2 | 8 GB | 80 GB | 0.0514 | 37.51 |
| vcpu-4-16 | 4 | 16 GB | 160 GB | 0.0958 | 69.96 |

The size names are OpsCrew's: the vCPUs and the GB of memory. IONOS sells each part of a vCPU
server on its own, and OpsCrew offers these five. Each has at least 40 GB of disk, which is what
design asks for at least. An app with a PostgreSQL database needs 60 GB, so on IONOS it gets at
least a `vcpu-2-4`.

- **Before VAT,** from IONOS CLOUD GmbH's EUR price list, version v2026-10-29. IONOS has no price
  API, so design shows this dated table and says so. OpsCrew checks it against IONOS's list before
  each release.
- **What each price holds:** the vCPUs (0.012 EUR an hour each), the memory (0.002 EUR a GB an
  hour), the Essential disk (0.04 EUR a GB per 30 days) and **a reserved IPv4 address (5 EUR per
  30 days).**
- **Why the address is reserved:** IONOS gives a stopped server's address back to its pool, and the
  server gets a new one when it starts again. Your app's DNS would then point at an address that
  isn't yours any more. A reserved address stays the server's through a stop.
- **The 730-hour figure** is a month of a server that runs all the time. IONOS bills by the minute,
  so a server that runs for less costs less.
- **The same price in every location.**
- **A US contract:** a contract with IONOS CLOUD Inc. is billed in USD, at prices that differ from
  these. Design shows the EUR list; check IONOS's USD list for yours.
- **Traffic:** 2 TB of outgoing traffic a month is included per contract, not per server; beyond
  it, 0.030 EUR per GB. Incoming traffic is free.

## What keeps billing

- **A server stopped from its own system** (a shutdown inside the server) **bills in full.**
- **A server stopped from IONOS's console** frees its cores and memory, but **still bills its disk
  and its reserved address.**
- **Whole-server snapshots** bill per GB, 0.04 EUR per GB per 30 days, for as long as IONOS keeps
  them (see [Snapshots](#snapshots)).
- **Only deleting ends the cost:** `npx opscrew destroy` deletes the server's data centre with
  everything in it, and its reserved address (see [Removing the app](#removing-the-app)).

## Locations

| Your answer in the interview | IONOS Cloud's location |
|---|---|
| Central Europe | Frankfurt (`de/fra/1`, `de/fra/2`) or Berlin (`de/txl`) |
| Northern Europe | Berlin (`de/txl`): far |
| United States, east coast | Newark, near New York (`us/ewr`) |
| United States, west coast | Lenexa, near Kansas City (`us/mci`): far |
| Southeast Asia (Singapore) | Frankfurt (`de/fra/1`): very far |

Three of these are far from where your visitors are, and design says why next to each:

- **Northern Europe:** IONOS has no location in the Nordics, so OpsCrew uses Berlin, its nearest.
- **United States, west coast:** IONOS's Las Vegas location has no vCPU servers, so OpsCrew uses
  Lenexa.
- **Southeast Asia:** IONOS has no location in Asia or Oceania, so OpsCrew uses Frankfurt.

Design shows the delay from each location to your visitors, so it ranks IONOS low in those regions.
IONOS's other locations (London, Logroño, Worcester, Paris and Las Vegas) aren't offered.

## Server names

The server is named as on the other providers: after your app, `<app>`, and `<app>-<name>` for one
of its [other servers](split-placement.md). Each server's data centre is named `opscrew-<server>`.
The server is labelled with your app's name in lower-case letters and digits only (`my-shop`
becomes `myshop`), since that is all IONOS takes in a label.

## Removing the app

While another app runs on the server (see
[A second app on another app's server](shared-server.md)), `npx opscrew destroy` refuses and
names it: remove or move that app first.

`npx opscrew destroy` shows the plan and asks you to type the server's name before it changes
anything. Then it:

- **deletes each server's data centre** with everything in it: the server, its disk, its network
  and its firewall rules. That delete alone ends their billing;
- **deletes each server's reserved IPv4 address,** which belongs to your contract rather than to
  the data centre;
- **deletes the DNS records OpsCrew made for the app.**

When the server holds your app's data, OpsCrew first offers an IONOS snapshot of the server's disk.
**What may keep billing:** the server's whole-server snapshots, named `opscrew-…`. IONOS keeps
snapshots apart from data centres, and doesn't say whether one outlives its data centre, so OpsCrew
counts them as kept, names each, and deletes none. OpsCrew finds a snapshot through its server, so
**delete the ones you don't want with `npx opscrew snapshot delete <id>` before the destroy;**
afterwards, check in the Data Center Designer and delete any left there.

### A create that stopped halfway

OpsCrew never repeats a create. When a create stops halfway and the state doesn't know the data
centre it made, OpsCrew can't take that data centre over yet. Delete the data centre
`opscrew-<server>` and the reserved address of the same name in the Data Center Designer, then run
`npx opscrew provision` again.

## Snapshots

```bash
npx opscrew snapshot --server        # IONOS's snapshot of the server's disk
npx opscrew restore --server <id>    # put the server back to it
```

- **Billed per GB,** 0.04 EUR per GB per 30 days, for as long as IONOS keeps it. The summary shows
  the rate before you take one.
- **Restoring reverts the server's disk** to the snapshot: everything written since is lost. The
  server keeps its address and its firewall. You type the server's name to approve it (see
  [Snapshots and restores](snapshots.md)).
- **The token's user needs the "Create Snapshot" privilege** (see [The token](#the-token)).

## What isn't offered

Each of these is a limit of OpsCrew on IONOS Cloud for now, with what to do instead:

- **No IONOS backups.** They need an agent on the server and a backup unit. OpsCrew's own data
  snapshots, with their encrypted copy off the server, cover your data instead: see
  [Snapshots and restores](snapshots.md).
- **No resizing.** IONOS adds cores and memory to a running server, but removes them only with a
  reboot, and a disk only grows. So design and advise refuse a new size on IONOS. Instead:
  - **move to another provider** with `npx opscrew retarget --to <provider>`, with a short
    maintenance window while the data is copied (see [Moving your app somewhere else](retarget.md));
    `retarget` doesn't move an app within IONOS Cloud;
  - or **stay on IONOS Cloud, with downtime:** take a data snapshot with its off-server copy,
    remove the server with `npx opscrew destroy`, choose the new size with `npx opscrew design`,
    run `npx opscrew provision`, then restore the copy, as [on Contabo](contabo.md#changing-the-size).
- **No delete protection.** Deleting the server's data centre in the Data Center Designer deletes
  the server and its disk at once. Use `npx opscrew destroy` instead, which shows the plan, offers a
  snapshot and asks for the typed name first.
- **No Cubes and no Dedicated Core servers.** OpsCrew offers vCPU servers only: a Cube's disk can't
  be resized or snapshotted like a separate disk, and Dedicated Core costs more.
- **No takeover of a lost create** (see [A create that stopped halfway](#a-create-that-stopped-halfway)).

## Still to be confirmed

OpsCrew on IONOS Cloud is built and tested against IONOS's documentation and its API's documented
answers. A run on a real contract is still to come, and will settle these:

- IONOS's exact words when a location has no room or a contract limit is reached. Until then,
  OpsCrew may show IONOS's answer as it is rather than in its own words.
- Whether a snapshot outlives its data centre. Until then, OpsCrew counts it as kept and billing.
- Whether a contract billed in EUR may use the US locations, and the reverse.

## Without OpsCrew

The Terraform code OpsCrew writes to `opscrew/infra/<env>/` runs without OpsCrew too. Set
`IONOS_TOKEN` as above; IONOS's Terraform provider reads it from the environment, and OpsCrew never
writes it to a file. Don't set `IONOS_USERNAME` or `IONOS_PASSWORD`: the token is the way in.

## Replacing the token

`npx opscrew rotate` lists IONOS's token among your own tokens. Generate a new token in the Token
Manager as the same user, set `IONOS_TOKEN` to it, run `npx opscrew rotate ionos`, then delete the
old token there: see [Rotating your app's credentials](credential-rotation.md). Before a token's
time is up, replace it the same way.
