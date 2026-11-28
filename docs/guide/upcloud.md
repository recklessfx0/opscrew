# Deploy to UpCloud

OpsCrew can create your app's server at [UpCloud](https://upcloud.com/), on your own account, as it
does at [Hetzner Cloud](hetzner.md), [DigitalOcean](digitalocean.md), [Contabo](contabo.md),
[OVHcloud](ovhcloud.md) and [Kamatera](kamatera.md). You get the same result: a hardened server,
the app deployed from [GitHub](https://github.com/) with TLS, health checks and rollback, and the
`verify`, `secure` and `drift` checks.

## What UpCloud is here

- **Servers in Europe, North America and Asia:** Frankfurt, Amsterdam, Warsaw, Helsinki, New York,
  San Jose and Singapore (see [Zones](#zones)).
- **Paid from prepaid credits, in EUR, before VAT.** Billed by the started hour, up to the plan's
  monthly price. No setup fee. When the credits run out, UpCloud disables your servers (see
  [Billing](#billing)).
- **A stopped server still bills its plan:** only deleting it ends the cost.
- **No cloud firewall:** UpCloud's own firewall can't do what OpsCrew needs, so the server's own
  firewall protects it instead (see [The firewall](#the-firewall)).
- **Not tested on a real UpCloud account yet.** OpsCrew's UpCloud support is tested against fakes
  of UpCloud's API. Where something below waits on that first real run, it says so.

## The token

OpsCrew signs in to UpCloud with an API token only, `UPCLOUD_TOKEN`. It never reads a user name or
a password.

**A token can't be limited to some resources.** It acts with the rights of the account that made
it: on your main account, it can create, change and delete every server, disk and backup there,
and spend the account's credits. UpCloud lets you limit a token only to some IP ranges and to an
expiry. So make it under a sub-account that may reach only servers and storage:

1. In [UpCloud's control panel](https://hub.upcloud.com/), as the main account, add a
   sub-account for OpsCrew. Give it access to servers and storage only, and no billing role. UpCloud's guide says a token made under a sub-account has stricter permissions; whether
   the token carries exactly the sub-account's rights is checked on OpsCrew's first real run.
2. Sign in as that sub-account, open **Account → API tokens**
   (<https://hub.upcloud.com/account/api-tokens>) and create a token (UpCloud's steps:
   <https://upcloud.com/docs/guides/getting-started-upcloud-api/>).
   - **Give it at most 90 days.** UpCloud allows up to 365, and a token stops working when its
     time is up.
   - **Limit it to your addresses** if you run OpsCrew from known networks: a token can be held to
     IP ranges.
   - UpCloud shows the token only once.
3. Set the variable:

   ```bash
   export UPCLOUD_TOKEN=…
   ```

   When it is missing, `npx opscrew init` and `npx opscrew provision` say so, link UpCloud's page
   for API tokens, and call nothing.

- **When the token is wrong or has expired,** OpsCrew says so and how to make a new one.
- **When the sub-account lacks access,** OpsCrew names what UpCloud refused and the access that
  grants it.
- **It stays on your computer.** OpsCrew uses the token only there, to plan and change your
  servers. It never goes to the server or to GitHub, and OpsCrew masks it in every message, log,
  audit entry and report.
- **Keep it out of your app.** OpsCrew's analysis treats your app's `UPCLOUD_*` variables as a
  provider's credentials, and `opscrew scan` finds an UpCloud token (`ucat_…`) written in your
  app's files.

## Step by step

1. `npx opscrew interview`: choose **UpCloud**. When only `UPCLOUD_TOKEN` is set, OpsCrew chooses
   it without asking. In scripts, put `provider: upcloud` in your answers file.
2. `npx opscrew design` shows UpCloud's Premium plans with their hourly price and the monthly
   price, which is also the most a month costs (see [Plans and prices](#plans-and-prices)).
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan, for
   each server:
   - the server: a Premium plan with Ubuntu 24.04 on the plan's MaxIOPS disk, its public IPv4
     address and UpCloud's utility network, named `<app>` (or `<app>-<name>` for one of its
     [other servers](split-placement.md)) and labelled `opscrew-app=<app>`;
   - the same first-boot hardening as on the other providers, through UpCloud's cloud-init;
   - the server's own firewall, the first step of that first boot (see
     [The firewall](#the-firewall));
   - the deploy key, which UpCloud places on the server when it creates it. UpCloud keeps no SSH
     keys of its own, and OpsCrew has it make no password.
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` work as on the other
   providers.

When UpCloud refuses a create, OpsCrew shows UpCloud's answer in plain English with what to do, and
no server is created:

- **a resource limit** of your account (cores, memory, storage or addresses): UpCloud's support
  raises it;
- **too few credits:** add credits in the control panel;
- **a plan not offered in the zone:** choose another zone in `npx opscrew design`.

Which error codes UpCloud gives for a used-up limit or a full zone is checked on the first real
run.

**A plan needs the network.** At plan time UpCloud's Terraform provider reads UpCloud's plans and
zones with the token.

**Several servers with the app's name:** UpCloud doesn't say whether server titles are unique. When
OpsCrew finds more than one server titled as one of the app's, provision, destroy and snapshots
stop and name each, rather than guess: delete the one you don't want in the control panel, then
run the command again.

## The firewall

**Cloud firewall: none; server firewall: on.** UpCloud's own firewall (its Public & Utility
firewall) is **stateless**: it doesn't know which packets answer the server's own connections. To
let in the answers to the server's downloads and the app's calls to other services, it would have
to open every port those answers come back on (thousands of them) to the whole internet. OpsCrew
won't, so it leaves UpCloud's firewall off and installs the server's own stateful firewall instead:

- **The first step of the first boot,** which UpCloud's cloud-init runs as a boothook before the
  rest of the first boot: nftables, for IPv4 and IPv6, that drops everything by default and lets in
  only SSH from the networks you allow, the web ports (80 and 443, and UDP 443 for HTTP/3) on the
  server that serves your site, and WireGuard's port where the app's
  [private network](private-network.md) uses it. Answers to the server's own connections pass,
  because this firewall keeps track of them. Outside traffic to Docker's networks that Docker
  didn't publish is dropped too. The same step turns password logins off, and checks with
  `sshd -T` that SSH really refuses them.
- **A few seconds after the server starts,** when that step runs, password logins go off and then
  the rules apply. Until then nothing filters the server's ports, and nothing of your app runs
  there yet. If the firewall can't be put in place, the server powers itself off rather than stay
  reachable. OpsCrew doesn't offer to restart it. If anything starts it again (UpCloud's
  Terraform provider starts a server after changing it), the step runs again at that boot, and
  powers the server off again if it still fails: the step stops running only once it has
  succeeded. Read why in its first boot's log, `/var/log/opscrew-first-boot.log`, from
  the server's console in UpCloud's control panel.
- **Kept across reboots:** the rules are in `/etc/opscrew/firewall.nft`, which OpsCrew's own unit,
  `opscrew-firewall.service`, loads at every boot before the network and Docker. It replaces only
  OpsCrew's table, never the rules Docker and ufw keep.
- **Checked:** `npx opscrew design` and the plan say "cloud firewall: none; server firewall: on",
  and `npx opscrew secure` reads the live rules from the server and fails when they are missing or
  differ from the plan, with the steps to fix them.
- **Updated in place with a hash-approved host plan.** When `opscrew/plan.yaml` or Cloudflare's
  ranges change the networks of an existing server (narrower or new SSH ranges, updated Cloudflare
  IP ranges, or a private network's WireGuard port), `npx opscrew provision` (and
  `npx opscrew retarget`) compares the plan against `/etc/opscrew/firewall-networks.json` on the
  server (falling back to the first boot's user data if the server has not been updated in place
  yet) and shows a host plan to approve by its SHA-256 hash. Once approved, OpsCrew rewrites
  `/etc/opscrew/firewall.nft`, reloads `opscrew-firewall.service` (replacing only
  `inet opscrew-firewall` in one transaction), and writes `/etc/opscrew/firewall-networks.json`
  (mode `0600`, root-owned) under a dead-man rollback: if a fresh SSH login fails afterwards, the
  server puts both files back and reloads the old rules. The first boot's step never runs again
  once it has succeeded, so a reboot keeps the updated rules. If `npx opscrew secure` finds the live
  rules differ from the plan, run `npx opscrew provision` when the plan's networks changed, or as
  root from the server's console run `systemctl restart opscrew-firewall.service` when the live
  rules were altered outside OpsCrew.
- **UpCloud's firewall stays off.** Don't turn it on in the control panel with only the ports your
  app serves: being stateless, it would then drop the answers to the server's own connections, so
  the server could no longer download updates or images.

## Plans and prices

| Plan | vCPU | Memory | MaxIOPS disk | EUR an hour | A month at most |
|---|---|---|---|---|---|
| `PREMIUM-2xCPU-2GB` | 2 | 2 GB | 50 GB | 0.0238 | 16.00 |
| `PREMIUM-2xCPU-4GB` | 2 | 4 GB | 50 GB | 0.0387 | 26.00 |
| `PREMIUM-2xCPU-8GB` | 2 | 8 GB | 100 GB | 0.0565 | 38.00 |
| `PREMIUM-4xCPU-8GB` | 4 | 8 GB | 100 GB | 0.0774 | 52.00 |
| `PREMIUM-4xCPU-16GB` | 4 | 16 GB | 150 GB | 0.1369 | 92.00 |

- **Before VAT,** dated 2026-10-24, from UpCloud's price list. UpCloud gives one price for every
  zone. Design shows this dated table; with the token set, it leaves out any plan UpCloud doesn't
  list for your account, so a plan UpCloud would refuse never reaches a plan of OpsCrew's. Only two
  of these plan names appear in UpCloud's own documentation; the others follow the same pattern and
  are checked against UpCloud's list on the first real run.
- **Included:** the disk and one public IPv4 address. Traffic in and out costs nothing under
  UpCloud's fair transfer policy.
- **Simple Backup,** when the plan asks for provider backups: UpCloud's week plan, a backup of the
  server's disk every day, each kept 7 days, for 20% more than the plan's price. Design shows it.
- **An app with a PostgreSQL database** needs 60 GB of disk, so on UpCloud it gets a
  `PREMIUM-2xCPU-8GB` at least.

## Billing

- **Prepaid credits.** You add credits to your UpCloud account, and UpCloud takes the cost from
  them by the hour. **When the credits run out, UpCloud disables your servers** until the balance
  is positive again, so your app goes down. `npx opscrew status` shows the server's state as
  UpCloud reports it. Keep enough credits on the account.
- **By the started hour, up to the monthly price.** UpCloud bills a server for at most 28 days a
  month (672 hours): the hourly price is the monthly price over 672, and a server that runs all
  month costs the monthly price. A started hour is billed whole.
- **In EUR.** Payments in USD, GBP or SGD are converted to EUR, so OpsCrew shows every price in
  EUR.
- **The free trial** gives new accounts some credit, but during the trial UpCloud locks its
  firewall to some ports, which OpsCrew can't change. Check that SSH and the web ports reach the
  server before you rely on a trial account.

## What keeps billing

- **A stopped server still bills its plan.** UpCloud says this plainly only for its Cloud Native
  plans, which OpsCrew doesn't offer, so OpsCrew counts a stopped Premium server as billing in full
  (checked on the first real run). **Only deleting it ends the cost:** use `npx opscrew destroy`
  (see [Removing the app](#removing-the-app)).
- **Whole-server snapshots** are backups of the server's disk, €0.056 per GB a month, for as long
  as UpCloud keeps them, which can be after the server is gone (see [Snapshots](#snapshots)).
- **Simple Backup's copies,** when the plan turned it on, may also stay after the server is
  deleted, each billed per GB a month.
- **Extra addresses** cost €3.47 a month each; OpsCrew uses only the one included.

## Zones

| Your answer in the interview | UpCloud's zone |
|---|---|
| Central Europe | Frankfurt (`de-fra1`), Amsterdam (`nl-ams1`) or Warsaw (`pl-waw1`) |
| Northern Europe | Helsinki 1 (`fi-hel1`) or Helsinki 2 (`fi-hel2`) |
| United States, east coast | New York (`us-nyc1`) |
| United States, west coast | San Jose (`us-sjo1`) |
| Southeast Asia (Singapore) | Singapore (`sg-sin1`) |

UpCloud's other zones (London, Madrid, Stockholm, Copenhagen, Stavanger, Chicago and Sydney) aren't
offered: some lack the newer CPUs Premium plans run on, and the others aren't mapped yet.

## Sending email

**Outbound port 25 is closed on new UpCloud accounts** until UpCloud's support opens it, after
checking who you are. An app that sends mail straight to other mail servers gets no connection
until then. Send through a mail service instead, on port 587 or 465.

## Removing the app

While another app runs on the server (see
[A second app on another app's server](shared-server.md)), `npx opscrew destroy` refuses and
names it: remove or move that app first.

`npx opscrew destroy` shows the plan and asks you to type the server's name before it changes
anything. Then it:

- **stops and deletes the server with its disk,** which releases its IPv4 address and ends its
  billing;
- **deletes the DNS records OpsCrew made for the app.**

When the server holds your app's data, OpsCrew first offers a snapshot of it (skip it with
`--no-snapshot`). **What may keep billing:** the server's backups, the ones titled `opscrew-…` and,
when Simple Backup was on, its copies. UpCloud keeps a deleted server's backups unless told
otherwise, so OpsCrew counts them as kept, names each, and **deletes none of them.** Delete the
ones you don't want in UpCloud's control panel; each bills per GB a month until you do.

## Snapshots

```bash
npx opscrew snapshot --server        # a backup of the server's whole disk
npx opscrew restore --server <id>    # put the server back to it
```

- **An on-demand backup** of the server's disk, titled `opscrew-<app>-<server>-<time>`, at €0.056
  per GB a month. The summary shows the rate before you take one.
- **It outlives the server.** OpsCrew never deletes one when it removes the server; delete it with
  `npx opscrew snapshot delete <id>` or in the control panel.
- **Restoring stops the server first,** puts the disk back to the backup, then starts the server:
  everything written since is lost. You type the server's name to approve it (see
  [Snapshots and restores](snapshots.md)).

## What isn't offered

Each of these is a limit of OpsCrew on UpCloud for now, with what to do instead:

- **No cloud firewall that OpsCrew manages.** UpCloud's firewall is stateless, so it stays off, and
  the server's own firewall protects the server (see [The firewall](#the-firewall)).
- **Only Premium plans.** Starter plans hold too small a disk, or cost more than
  `PREMIUM-2xCPU-2GB` where they fit; Cloud Native plans come without a disk or an address.
- **No resizing.** UpCloud resizes only a stopped server, and a disk only grows, so design and
  advise refuse a new size on UpCloud. Instead:
  - **move to another provider** with `npx opscrew retarget --to <provider>`, with a short
    maintenance window while the data is copied (see [Moving your app somewhere else](retarget.md));
    `retarget` doesn't move an app within UpCloud;
  - or **stay on UpCloud, with downtime:** take a data snapshot with its off-server copy, remove
    the server with `npx opscrew destroy`, choose the new size with `npx opscrew design`, run
    `npx opscrew provision`, then restore the copy, as [on Contabo](contabo.md#changing-the-size).
- **No delete protection.** UpCloud has none: deleting the server in its control panel removes it
  and its disk for good. Use `npx opscrew destroy` instead, which shows the plan, offers a snapshot
  and asks for the typed name first.
- **Not yet:** UpCloud's private networks (SDN), load balancers and managed databases. OpsCrew's
  own private network (WireGuard) connects the app's servers and your devices as on the other
  providers: see [Your devices on the private network](private-network.md). For your app's files,
  see [Object storage](object-storage.md).

## Without OpsCrew

The Terraform code OpsCrew writes to `opscrew/infra/<env>/` runs without OpsCrew too. Set
`UPCLOUD_TOKEN` as above; UpCloud's Terraform provider reads it from the environment, and OpsCrew
never writes it to a file.

## Replacing the token

`npx opscrew rotate` lists UpCloud's token among your own tokens. Create a new token under the same
sub-account in the control panel (Account → API tokens), set `UPCLOUD_TOKEN` to it, run
`npx opscrew rotate upcloud`, then delete the old token there: see
[Rotating your app's credentials](credential-rotation.md).
