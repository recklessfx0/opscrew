# Deploy to Kamatera

OpsCrew can create your app's server at [Kamatera](https://www.kamatera.com/), on your own
account, as it does at [Hetzner Cloud](hetzner.md), [DigitalOcean](digitalocean.md),
[Contabo](contabo.md), [OVHcloud](ovhcloud.md) and [UpCloud](upcloud.md). You get the same result: a hardened server, the
app deployed from [GitHub](https://github.com/) with TLS, health checks and rollback, and the
`verify`, `secure` and `drift` checks.

## What Kamatera is here

- **Servers in Europe, North America and Asia:** Frankfurt, Amsterdam, Stockholm, New York, Santa
  Clara and Singapore (see [Datacenters](#datacenters)).
- **Billed by the hour, counted by the minute,** from the moment the server is created until it is
  terminated. A stopped server still bills (see [What keeps billing](#what-keeps-billing)).
- **Prices in USD, before any tax.** No setup fee.
- **No cloud firewall:** the server's own firewall protects it instead (see
  [The firewall](#the-firewall)).

## The API key

1. In [Kamatera's console](https://console.kamatera.com/), open **API → Keys** and create a key
   (Kamatera's steps:
   <https://www.kamatera.com/knowledgebase/how-to-deploy-terraform-on-a-kamatera-vps/>). The dialog
   shows an access key and a secret key; Kamatera shows the secret only once.
2. Set the two variables. OpsCrew needs both:

   | Variable | The value |
   |---|---|
   | `KAMATERA_API_CLIENT_ID` | the key's access key (its client ID) |
   | `KAMATERA_API_SECRET` | the key's secret key |

   ```bash
   export KAMATERA_API_CLIENT_ID=… KAMATERA_API_SECRET=…
   ```

   When one is missing, `npx opscrew init` and `npx opscrew provision` say which and call nothing.
   `KAMATERA_API_URL` is needed only to point OpsCrew at another address of Kamatera's API.

- **The key reaches your whole account.** Kamatera has no way to limit a key to some servers, to
  reading only, or to your addresses: whoever holds it can create, change and terminate every
  server on the account. **Use a separate Kamatera account for OpsCrew,** with only your app's
  servers in it, so the key can reach nothing else.
- **It stays on your computer.** OpsCrew uses the key only there, to plan and change your servers.
  It never goes to the server or to GitHub, and OpsCrew masks both values in every message, log,
  audit entry and report.
- **Keep it out of your app.** OpsCrew's analysis treats your app's `KAMATERA_*` variables as a
  provider's credentials. The values themselves have no format a scanner could match, so keep them
  out of your app's files yourself.

## Step by step

1. `npx opscrew interview`: choose **Kamatera**. When only Kamatera's values are set, OpsCrew
   chooses it without asking. In scripts, put `provider: kamatera` in your answers file.
2. `npx opscrew design` shows Kamatera's plans with their hourly price and what 730 hours cost
   (see [Plans and prices](#plans-and-prices)).
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan:
   - the server, billed by the hour, with Ubuntu 24.04 and the same first-boot hardening as on the
     other providers. Kamatera takes it as a startup script, which runs as the server starts;
   - the server's own firewall, the first step of that script (see [The firewall](#the-firewall));
   - the deploy key, which Kamatera puts on the server as text: Kamatera keeps no SSH keys of its
     own.
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` work as on the other
   providers.

When Kamatera refuses a create (your account's server price limit or its server creation
allotment, or no room in the datacenter), OpsCrew shows Kamatera's answer in plain English with what
to try next, and no server is created.

**A plan needs the network.** At plan time Kamatera's Terraform provider checks the server's
datacenter and size against Kamatera's public price list, `console.kamatera.com`. When that address
can't be reached, the plan fails and names it: check your network or proxy.

**The root password is in the state.** Kamatera gives every server a root password it generates.
OpsCrew never reads or shows it, and logs in with the deploy key only, but Kamatera's Terraform
provider keeps the password in the Terraform state on your computer (`opscrew/infra/<env>/`), so
keep that folder as private as the key.

## The firewall

**Cloud firewall: none; server firewall: on.** Kamatera has no firewall that OpsCrew can set from
its API or Terraform: the one in its console starts off, and only you can turn it on. So OpsCrew
installs the server's own firewall instead:

- **The first step of the first boot,** before anything else runs: nftables, for IPv4 and IPv6,
  that drops everything by default and lets in only SSH from the networks you allow, the web ports
  (80 and 443, and UDP 443 for HTTP/3) on the server that serves your site, and WireGuard's port
  where the app's [private network](private-network.md) uses it. Outside traffic to Docker's networks
  that Docker didn't publish is dropped too. The same step turns password logins off, and checks with
  `sshd -T` that SSH really refuses them.
- **Shortly after the server starts,** when Kamatera runs the startup script, password logins go
  off and then the rules apply: within seconds when the image has nftables, a few minutes when it
  must install it first. Until then nothing filters the server's ports, and nothing of your app
  runs there yet. If the firewall can't be put in place, the server powers itself off rather than
  stay open. It stays off: no later `npx opscrew provision` turns it on again, and OpsCrew doesn't
  offer to restart it. Read why in its first boot's log, `/var/log/opscrew-first-boot.log`, from the
  server's console.
- **Kept across reboots:** the rules are in `/etc/opscrew/firewall.nft`, which OpsCrew's own unit,
  `opscrew-firewall.service`, loads at every boot before the network and Docker. It replaces only
  OpsCrew's table, never the rules Docker and ufw keep.
- **Checked:** `npx opscrew secure` reads the live rules from the server and fails when they are
  missing or differ from the plan, with the steps to fix them.
- **Updated in place with a hash-approved host plan.** When `opscrew/plan.yaml` or Cloudflare's
  ranges change the networks of an existing server (narrower or new SSH ranges, updated Cloudflare
  IP ranges, or a private network's WireGuard port), `npx opscrew provision` (and
  `npx opscrew retarget`) compares the plan against `/etc/opscrew/firewall-networks.json` on the
  server (falling back to the first-boot script if the server has not been updated in place yet)
  and emits a SHA-256 hash-approved host plan. After you approve that hash, OpsCrew rewrites
  `/etc/opscrew/firewall.nft`, reloads `opscrew-firewall.service` (replacing only
  `inet opscrew-firewall` in one transaction), and atomically writes
  `/etc/opscrew/firewall-networks.json` (mode `0600`, root-owned) under a dead-man rollback: if a
  fresh SSH login fails afterwards, the server restores both `/etc/opscrew/firewall.nft` (reloaded)
  and the previous `/etc/opscrew/firewall-networks.json` automatically. If `npx opscrew secure`
  finds the live rules differ from the plan, run `npx opscrew provision` when the plan's networks
  changed, or as root from Kamatera's console run `systemctl restart opscrew-firewall.service` when
  the live rules were altered outside OpsCrew.
- **Kamatera's console firewall is yours to add.** Open the server in the console, its **Firewall**
  tab, and turn it on as a second layer. OpsCrew doesn't manage it or check it: let in at least SSH
  from your networks and the web ports, or your app and OpsCrew lose the server.

## Plans and prices

| Plan | vCPU | Memory | Disk | USD an hour | 730 hours |
|---|---|---|---|---|---|
| A-1-2 | 1, shared | 2 GB | 40 GB | 0.0123 | 9.00 |
| A-2-4 | 2, shared | 4 GB | 40 GB | 0.0260 | 19.00 |
| A-4-8 | 4, shared | 8 GB | 80 GB | 0.0575 | 42.00 |
| B-1-2 | 1, dedicated | 2 GB | 40 GB | 0.0247 | 18.00 |
| B-2-4 | 2, dedicated | 4 GB | 40 GB | 0.0575 | 42.00 |
| B-4-8 | 4, dedicated | 8 GB | 80 GB | 0.1233 | 90.00 |

The plan names are OpsCrew's: Kamatera's CPU type, the vCPUs and the GB of memory. Kamatera sells
each part on its own, and OpsCrew offers these six. The smallest disk is 40 GB, which is what
design asks for at least. An app with a PostgreSQL database needs 60 GB, so on Kamatera it gets an
`A-4-8` ($42 for 730 hours).

- **Before any tax,** dated 2026-11-22, from Kamatera's public price list. Design reads that list
  when it can reach it, without the key, and shows this dated table when it can't, and says which.
- **The 730-hour figure** is a month of a server that runs all the time. Kamatera's hourly price
  is its monthly price divided by 730, and a server that runs for less costs less.
- **The same price in every datacenter.**
- **A or B:** type A (Availability) shares its vCPUs with other servers; type B (General Purpose)
  guarantees them.
- **Traffic:** 5000 GB a month in Europe and North America, 1000 GB in Singapore; beyond it, $0.01
  per GB. Kamatera doesn't say plainly whether an hourly server carries that allowance, so count on
  paying for heavy traffic.

## What keeps billing

- **A stopped server still bills,** for its address and its disk: about $5 a month for the address
  and $0.05 per GB of disk a month, so about $7 a month for an `A-2-4`. **Only terminating it ends
  the cost:** use `npx opscrew destroy` (see [Removing the app](#removing-the-app)).
- **Whole-server snapshots** bill per GB, $0.05 per GB a month, for as long as Kamatera keeps them
  (see [Snapshots](#snapshots)).
- **Extra addresses** cost $1 a month each; OpsCrew uses only the one included.

## Datacenters

| Your answer in the interview | Kamatera's datacenter |
|---|---|
| Central Europe | Frankfurt (`EU-FR`) or Amsterdam (`EU`) |
| Northern Europe | Stockholm (`EU-ST`) |
| United States, east coast | New York (`US-NY2`) |
| United States, west coast | Santa Clara (`US-SC`) |
| Southeast Asia (Singapore) | Singapore (`AS-SG`) |

Kamatera's price list has the codes `EU-ST` and `AS-SG` but names no city for them; its list of
datacenters has Stockholm and Singapore, so OpsCrew reads them so, and design says so. Kamatera's
other datacenters (London, Toronto, Tokyo, Sydney, Israel and more) aren't offered.

## Server names

The server is named as on the other providers: after your app, `<app>`, and `<app>-<name>` for one
of its [other servers](split-placement.md). Kamatera takes names of 4 to 40 letters, digits, dashes
or dots, so an app named with fewer than 4 characters, or another character, can't have a Kamatera
server: the plan fails and says so. Choose another app name then.

Kamatera doesn't keep names unique. When a create of a name it already has reaches it a second
time, it makes a second server named `<name>(1)` (or `(2)`, and so on), which keeps billing. When
OpsCrew finds one, provision, destroy and snapshots stop and name it with its datacenter: terminate
it in Kamatera's console, then run the command again.

## Removing the app

While another app runs on the server (see
[A second app on another app's server](shared-server.md)), `npx opscrew destroy` refuses and
names it: remove or move that app first.

`npx opscrew destroy` shows the plan and asks you to type the server's name before it changes
anything. Then it:

- **terminates the server,** which ends its billing. Kamatera runs the terminate as a queued task,
  so the server can show in its console for a few minutes more;
- **deletes the DNS records OpsCrew made for the app.**

When the server holds your app's data, OpsCrew first offers a snapshot of it. **What may keep
billing:** the server's whole-server snapshots, named `opscrew-…`. Kamatera doesn't say whether it
keeps them once their server is terminated, so OpsCrew counts them as kept, names each, and deletes
none. OpsCrew reaches a Kamatera snapshot only through its server, so **delete the ones you don't
want with `npx opscrew snapshot delete <id>` before the destroy;** afterwards, check in Kamatera's
console and delete any left there.

### A create that stopped halfway

Kamatera can't tell a repeated create from a new one, so OpsCrew never repeats a create. When a
create stops halfway and the server exists anyway, OpsCrew can't take it over yet: Kamatera's
Terraform provider takes a server over only by Kamatera's internal id, so the next
`npx opscrew provision` names the server and its plan fails before anything is created. Terminate
that server in Kamatera's console, then run `npx opscrew provision` again.

## Snapshots

```bash
npx opscrew snapshot --server        # Kamatera's snapshot of the whole server
npx opscrew restore --server <id>    # put the server back to it
```

- **Billed per GB a month,** $0.05, for as long as Kamatera keeps it. The summary shows the rate
  before you take one.
- **Restoring reverts the server** to the snapshot: everything written since is lost. You type the
  server's name to approve it (see [Snapshots and restores](snapshots.md)).

## What isn't offered

Each of these is a limit of OpsCrew on Kamatera for now, with what to do instead:

- **No cloud firewall that OpsCrew manages.** The server's own firewall protects it, and Kamatera's
  console firewall is yours to add (see [The firewall](#the-firewall)).
- **Only hourly billing.** Kamatera's monthly billing costs the same per hour, and bills each
  calendar month begun in full, even after the server is terminated. OpsCrew offers only the hourly
  one, and doesn't switch a server to monthly.
- **No Kamatera daily backups.** Kamatera publishes no price for them. OpsCrew's own data snapshots,
  with their encrypted copy off the server, cover your data instead: see
  [Snapshots and restores](snapshots.md).
- **No resizing.** Kamatera's API fails a disk change, so design and advise refuse a new size on
  Kamatera. Instead:
  - **move to another provider** with `npx opscrew retarget --to <provider>`, with a short
    maintenance window while the data is copied (see [Moving your app somewhere else](retarget.md));
    `retarget` doesn't move an app within Kamatera;
  - or **stay on Kamatera, with downtime:** take a data snapshot with its off-server copy, remove
    the server with `npx opscrew destroy`, choose the new size with `npx opscrew design`, run
    `npx opscrew provision`, then restore the copy, as [on Contabo](contabo.md#changing-the-size).
- **No delete protection.** Terminating the server in Kamatera's console removes it and its disk
  for good. Use `npx opscrew destroy` instead, which shows the plan, offers a snapshot and asks for
  the typed name first.
- **No takeover of a lost server** (see [A create that stopped halfway](#a-create-that-stopped-halfway)).
- **Not yet:** Kamatera's private networks and load balancers. OpsCrew's own private network
  (WireGuard) connects the app's servers and your devices as on the other providers: see
  [Your devices on the private network](private-network.md). For your app's files, see
  [Object storage](object-storage.md).

## Without OpsCrew

The Terraform code OpsCrew writes to `opscrew/infra/<env>/` runs without OpsCrew too. Set
`KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET` as above; Kamatera's Terraform provider reads
them from the environment, and OpsCrew never writes them to a file.

## Replacing the credentials

`npx opscrew rotate` lists Kamatera's key among your own tokens. Create a new key in Kamatera's
console under API → Keys, set `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET` to it, run
`npx opscrew rotate kamatera`, then delete the old key there: see
[Rotating your app's credentials](credential-rotation.md).
