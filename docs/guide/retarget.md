# Moving your app somewhere else: `opscrew retarget`

`opscrew retarget` moves a live app, with its data, to another place: [Hetzner Cloud](hetzner.md), [DigitalOcean](digitalocean.md), [Contabo](contabo.md),
[OVHcloud](ovhcloud.md), [Kamatera](kamatera.md), [UpCloud](upcloud.md), [a server you already have](own-server.md) or [a Portainer you already run](portainer-target.md),
in any direction. That includes moving from one server of yours to another. A site moves between
[Cloudflare's hosting](cloudflare-hosting.md) and [GitHub Pages](github-pages.md).

The new side is set up next to the old one, the app is deployed and checked there, its data is
copied while the app still serves and what changed since in a short maintenance window, and then
your DNS records switch to the new side. The old side stays until you say the new one is good.

```bash
npx opscrew retarget --to digitalocean   # start the move, or continue it after a stop
npx opscrew retarget --finish            # after the switch: remove the old side
npx opscrew retarget --abort             # before the switch: back to the old side
```

| `--to` | Moves the app to |
|---|---|
| `hetzner`, `digitalocean`, `contabo`, `ovhcloud`, `kamatera`, `upcloud` | A new server at that cloud provider |
| `own` | A server you already have (OpsCrew asks how to reach it), or [another app's server](#moving-onto-another-apps-server) |
| `portainer` | An environment in the Portainer you run (OpsCrew asks for it) |
| `cloudflare-workers`, `github-pages` | The other site host, for a site |

Without `--to`, the target in your answers (`opscrew/requirements.yaml`) is used. Moves run only in
your terminal; in [Claude Code](https://claude.com/product/claude-code), `opscrew_status` shows where a move stands. Like every command, it
takes `--app <key>` and `--env <name>` for [another app](several-apps.md) or
[environment](environments.md).

Some moves aren't possible yet; see [What can't move yet](#what-cant-move-yet). To move the app's
Cloudflare setup to another Cloudflare account instead, see
[`opscrew cloudflare move`](cloudflare-move.md).

## Before you move

- **The tokens of both sides:** `HCLOUD_TOKEN` for Hetzner, `DIGITALOCEAN_TOKEN` for DigitalOcean,
  the four `CNTB_OAUTH2_*` values for Contabo (see [the credentials](contabo.md#the-credentials)),
  the four `OVH_*` values for OVHcloud, whose region must be activated in your Public Cloud project
  first (see [Before you start](ovhcloud.md#before-you-start)), `KAMATERA_API_CLIENT_ID` and
  `KAMATERA_API_SECRET` for Kamatera (see [The API key](kamatera.md#the-api-key)),
  `UPCLOUD_TOKEN` for UpCloud (see [The token](upcloud.md#the-token)),
  `PORTAINER_API_KEY` for Portainer, plus your GitHub token, and `CLOUDFLARE_API_TOKEN` when your
  domain's DNS is on Cloudflare. A missing or rejected token stops the move before anything
  changes. In Portainer, use the token of the user who deployed the app's stacks (OpsCrew's own
  token for them), or an administrator's: a standard user's token can't stop containers another
  user created.
- **This computer:** run the move on the computer that deployed the app. It has the infrastructure
  state, the SSH keys and the database's password, and the data passes through it, so a fast
  connection shortens the copy and the window.
- **[Public SSH](public-ssh.md) open:** servers are reached over public SSH before they join the
  app's private network. If you closed it, open it with `npx opscrew secure --open-public-ssh`,
  move, then close it again with `npx opscrew secure --close-public-ssh`.
- **Your DNS, if it isn't on Cloudflare:** lower the TTL of the app's records (for example to 60
  seconds) beforehand, so the switch reaches your visitors quickly (see
  [Without DNS on Cloudflare](#without-dns-on-cloudflare)).
- **The cost:** both sides run until you finish the move. A new cloud server is billed from its
  creation, and the old one until `--finish` deletes it. The summary shows the new side's monthly
  price before anything changes; your own server, your Portainer and another app's server have
  none. A Contabo server is
  bought for at least a month, and one that `--finish` removes is billed to the end of its term
  (see [Removing the app](contabo.md#removing-the-app)). An OVHcloud server is billed by the hour
  until `--finish` deletes it, a Kamatera server until `--finish` terminates it, stopped or not,
  and an UpCloud server, paid from its prepaid credits, until `--finish` deletes it, stopped or
  not.
- **No other app on a server the move deletes:** a move off a server OpsCrew created ends by
  deleting it, so OpsCrew refuses it while another app runs there. An app that runs on another
  app's server can move off it, and an app can move onto another app's server (see
  [A second app on another app's server](shared-server.md)).
- **Onto another app's server:** that app's repository folder on this computer, where it was
  provisioned. OpsCrew reads its plan and the server's login from it.

## How a move works

```bash
npx opscrew retarget --to own
```

OpsCrew first checks that the app can run on the new side and stops, with nothing changed, when it
can't: a processor architecture OpsCrew builds no image for, too little memory or disk, or the same
place the app already runs. Then it reads the size of each piece of data on the old side, asks
whether to copy each one or start it empty (see [The data](#the-data)), and shows a summary: each
step, the extra monthly cost, the data and its size, the bucket, and the maintenance window's
expected length. Nothing changes until you continue.

1. **Start.** Pick the new target:
   - **a cloud provider:** OpsCrew offers its servers for the region and budget from your
     interview, as `opscrew design` does, and you pick one;
   - **your own server:** name it (address, SSH port, login and key, how visitors reach it), as
     `opscrew interview` asks. OpsCrew connects, shows the server's SSH host key fingerprint for
     you to check, and reads its size, memory, disk and architecture without changing anything;
   - **your Portainer:** name it (address, environment), confirm its certificate, and give the
     public address of its host, where the stack's [Caddy](https://caddyserver.com/) serves the app and the DNS records point;
   - **another app's server:** name that app's repository folder (see
     [Moving onto another app's server](#moving-onto-another-apps-server)).
2. **Prepare the new side.**
   - **A cloud provider:** the current server is renamed in OpsCrew's infrastructure state, so both
     fit in it (nothing changes in your cloud), and the new server is created next to it, from an
     infrastructure plan you approve by its hash.
   - **Your own server:** a host plan sets it up for the app, beside any other apps there, as for
     [several apps on one server](own-server.md#several-apps-on-one-server), and refuses what it
     refuses there. You approve it by its hash.
   - **Your Portainer:** the environment is checked for the app's stacks.
3. **Deploy and check.** The GitHub deploy secrets point to the new side (an approval), the app is
   deployed there and OpsCrew checks that it answers. Your visitors are still served by the old
   side, and the new side's web server stays stopped until the switch.
   - On a server, the deploy workflow runs. If the new side needs different deploy files (the
     workflow for another SSH port or an image built for another processor, or the [Compose](https://docs.docker.com/compose/) and
     web server files when the app comes from your Portainer, or Portainer's stack template when
     it goes there), OpsCrew opens one pull request with them and stops; merge it and run
     `npx opscrew retarget` again.
   - When the move copies data to a server, its deploys there bring up only the app's image and
     its services until the copy: the release command and the app start on the copied data, so an
     app whose migrations need its existing tables never runs on an empty database. OpsCrew checks that the image is there and the services run. A deploy workflow on
     your branch from an earlier OpsCrew doesn't know this, so OpsCrew proposes the new one in a
     pull request first, as for different deploy files.
   - In Portainer, the app's stacks are planned and approved by hash, as `opscrew provision` does,
     with the exact version the old side runs (the deploy branch is written with it, after your
     approval).

   Until you finish or abort the move, a push to your branch deploys to the new side only, so hold
   changes until the switch.
4. **The copy and the maintenance window.** The data is copied while the old side still serves
   your visitors, then the maintenance window copies what changed since (see below). The window
   needs its own approval.
5. **The switch.** DNS switches to the new side, from a plan you approve by its hash, and OpsCrew
   checks the app through its domain. The old side stays, with its app stopped, until you
   [finish the move](#finishing-the-move).

Each plan is shown first and applied only once you approve its exact hash. Storing the new deploy
secrets, pausing the [scheduled check](alerts.md) and starting the maintenance window each ask for
your approval too.

### Moving onto another app's server

An app can move, with its data, onto a server where another of your OpsCrew apps runs, and become
a [second app](shared-server.md) there. Pass `server.shares` with that app's repository folder in
the answers (see [In scripts](#in-scripts)):

```bash
npx opscrew retarget --to own --answers onto-shop.yaml
```

In a terminal, `--to own` first asks the interview's question about the server; choose
**A server another of your OpsCrew apps runs on** and name the folder. The app can come from a
server OpsCrew created for it, a server of yours, your Portainer, or another app's server.

- **The checks:** before any change, the move runs the checks design runs for a second app (see
  [What design checks](shared-server.md#what-design-checks)): the name, the hostnames, the
  `<app>-pr-<n>` form, the way of serving, the proxy, server-wide kernel settings and the memory,
  with a warning below 15% free. It also checks that the server has free disk for the data it
  copies. The summary shows no new server cost, the memory left and the
  [shared-access warning](shared-server.md#who-can-reach-what). An app with a
  [private network](private-network.md), [Portainer](portainer.md), [Beszel](beszel.md) or
  [self-hosted monitoring](monitoring.md) is refused, since those run server-wide.
- **On a server OpsCrew created for the other app,** the new side is set up as that server's second
  app. Its host plan holds only the moving app's deploy key line, folders and record. The
  infrastructure plans change nothing at your cloud provider before the switch: they rename the
  app's old server in OpsCrew's infrastructure state, when it has one, and change the DNS records
  at the switch. The app is then deployed and checked, its data is copied (its folders and
  volumes, exactly as they are), and DNS switches. The other app keeps
  serving throughout: its proxy keeps running and reloads once, at the switch.
- **On a server of yours,** the move takes the server's login from the other app, as the interview
  does, and runs as a move to your own server, beside the apps already there.
- **`--abort`,** before the switch, removes only the moving app's parts from the other app's
  server, and DNS stays on the old side.
- **`--finish`** removes the old side as for any move (see
  [Finishing the move](#finishing-the-move)). Afterwards the app is a second app on its new server,
  with its own deploy key, as after a second app's provision.

## The data

Every service on the app's server that keeps data moves with it: [PostgreSQL](https://www.postgresql.org/), [MySQL](https://www.mysql.com/), [MariaDB](https://mariadb.org/),
[MongoDB](https://www.mongodb.com/), [Valkey](https://valkey.io/), [Redis](https://redis.io/), [Dragonfly](https://www.dragonflydb.io/), [RabbitMQ](https://www.rabbitmq.com/), [NATS](https://nats.io/), [Kafka](https://kafka.apache.org/), [Redpanda](https://www.redpanda.com/), [Garage](https://garagehq.deuxfleurs.fr/), [OpenSearch](https://opensearch.org/),
[Elasticsearch](https://www.elastic.co/elasticsearch), [Meilisearch](https://www.meilisearch.com/), [Typesense](https://typesense.org/), [ClickHouse](https://clickhouse.com/) and [Neo4j](https://neo4j.com/), plus the app's own files (a [SQLite](https://www.sqlite.org/)
database, uploads) and [self-hosted monitoring](monitoring.md) on the app's server.

- **Most services:** their data (their [Docker](https://www.docker.com/) volumes) is copied as files to the same service on
  the new side: in full and as they are while they run, then, once each is stopped cleanly in the
  maintenance window, only what changed since. Both sides then compute a SHA-256 digest of the
  data, and the copy counts only when they match. Logins and passwords come along with the data.
  Both sides run the same image versions, which the plan pins.
- **MySQL and MariaDB** are dumped consistently while they serve (`--single-transaction`), and the
  dump is restored on the new side. In the window, with the service stopped, their data folder is
  copied as files and checked like the others; it differs after the restore, so this copies about
  its whole size.
- **PostgreSQL** is copied through its dump instead (`pg_dump` and `pg_restore`), which works across
  versions, in full both times: while it serves and again in the window. The dump is checked on
  both sides too, and your release command runs on it when the app has one.
- **A service that doesn't stop cleanly** (Docker kills it when the 120 seconds to stop run out, or
  for lack of memory) isn't copied: the window stops and starts the old app again.

The data streams through this computer and is never stored on it.

### Copy or start empty

For each service, OpsCrew asks whether to copy its data (the default) or start it empty on the new
side. In a script, name what starts empty with `--empty <service>`, once for each (`app` for the
app's own files, `monitoring` for the monitoring stack). The summary says what starting empty loses:

| Service | Starting it empty loses |
|---|---|
| PostgreSQL, MySQL, MariaDB, ClickHouse | Every table and row |
| MongoDB | Every collection and document |
| Neo4j | Every node and relationship |
| Valkey, Redis, Dragonfly as a cache | Cached values, which the app fills again: usually fine |
| Valkey, Redis, Dragonfly as a queue | The jobs waiting in it: let the queue drain first, or copy it |
| RabbitMQ | The messages waiting in its queues |
| NATS, Kafka, Redpanda | The messages their streams and topics keep |
| Garage | Every file stored in it |
| OpenSearch, Elasticsearch, Meilisearch, Typesense | The search index, which the app must build again |
| The app's own files | Its SQLite database and uploads |
| Monitoring | The metrics, logs and dashboards' history collected so far |

### The maintenance window

The data is copied twice: in full while the app still serves, then, in the maintenance window,
only what changed since. The app is offline only for the second copy: an app with 262 MB of files
and a 219 MB MySQL database, for example, is offline for about 5 minutes instead of for the whole
copy. The summary shows both lengths before anything changes, here "Expected maintenance window:
about 5 minutes, after about 12 minutes of copying while your app serves":

| Part | About |
|---|---|
| The copy while your app serves, between two servers (cloud or your own) | 2 minutes, plus 1 per 100 MB of data |
| The copy while your app serves, between a server and your Portainer | 2 minutes, plus 1 per 900 MB (about 15 MB/s through Portainer's API) |
| Onto a server | Add 5 minutes to the copy for the deploy that starts the app there |
| The maintenance window | 1 minute, plus PostgreSQL's dump and restore and MySQL's or MariaDB's whole data folder at the copy's rate, plus a share of the other files for what changed |
| With a bucket that moves | Add a minute per 2,000 objects to the window, for its last copy |

Data that starts empty doesn't count.

**While your app serves,** once the new side is deployed and with no downtime approval, each piece
of data is copied in full to the new side (the databases by their dumps), and the other services
that keep data start there on their copy. On a server, the deploy workflow then runs there with
the image its first deploy left, without a build: the release command runs on the copied data,
then the app, its workers and cron jobs start. Your domain still leads to the old side, so the run
skips its check through the domain and OpsCrew checks the app's health on the server itself; its
web server stays stopped until the switch, unless other apps there use it. After the check, the
app, its workers and cron jobs stop there again, so no job runs on both servers until the window.
Deploys from pushes to your branch wait meanwhile. If anything fails, a service that can't start
on its copy included, the new side's app stops and the move stops before any downtime: the old
side keeps serving, and the next run copies again. A run that stopped at the window's approval
doesn't copy again.

**In the window,** after your approval (which lists each step and each piece of data with its
size):

1. The app's deploys and the scheduled check pause.
2. The app, its workers and cron jobs stop on the old side, and PostgreSQL is dumped.
3. The services stop cleanly on the old side, and the app and services stop on the new side.
4. A bucket that moves gets its last copy.
5. Each piece of data gets what changed since its first copy (new, changed and removed files,
   compared by their content), MySQL's or MariaDB's data folder about whole, and is checked.
6. The services start on the new side and PostgreSQL is restored.
7. On a server, the release command runs once more, on the final data, and the app, its workers
   and cron jobs start again in place and must answer OpsCrew's check on the server; no workflow
   runs. In your Portainer, the release command runs, the app starts and must answer its health
   check.

A volume with a file whose name contains a line break, and any data when the old side lacks the
free disk to gather the changes, is copied whole in the window, and the run says so. A large
PostgreSQL, MySQL or MariaDB database still makes the window longer, since it is copied about in
full there.

If anything fails, the window rolls back: the data written on the new side is emptied, a server's
deploys there go back to bringing up only the image and the services, the old side's services and
app start again, and nothing has switched. Your visitors are served by the old side, and the next
run copies that data again while the app serves, then repeats the window. If the DNS switch
fails, the same happens. Finishing or aborting the move resumes the scheduled check.

Without data to copy (none, or a database hosted elsewhere) and without a bucket that moves, there
is no window: the old side serves until the switch.

## Buckets

A bucket the app has at the provider being left moves to the new provider's object storage, when
the new target is the other cloud provider ([Hetzner Object Storage](https://www.hetzner.com/storage/object-storage/) or [DigitalOcean Spaces](https://www.digitalocean.com/products/spaces)) with
object storage in the app's region. See [Object storage](object-storage.md).

- **Shown first:** the summary shows the bucket's size, its object count, the time to copy it and
  the egress. DigitalOcean Spaces includes 1,024 GiB of outbound traffic a month, then charges
  $0.01 per GiB. Hetzner Object Storage includes about 1 TB of traffic a month in its base price.
- **How it moves:** the new bucket is created from a plan you approve by its hash. The files are
  copied once before the window, from the new server, and the window copies only what changed
  since. The app on the new side uses the new bucket.
- **The keys:** OpsCrew needs a key for each bucket. A terminal asks for the new one once. In a
  script, `OPSCREW_STORAGE_ACCESS_KEY_ID` and `OPSCREW_STORAGE_SECRET_ACCESS_KEY` hold the key of
  the bucket being left, and `OPSCREW_NEW_STORAGE_ACCESS_KEY_ID` and
  `OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY` the new bucket's. A DigitalOcean key needs Full Access to
  create the bucket. The keys reach the copy only on its standard input, never a plan, log or
  audit entry.
- **To keep it where it is,** pass `--keep-bucket`. It keeps billing at the old provider.
- **At `--finish`,** the old bucket is deleted with its files, after you type the bucket's own name
  (the app's name doesn't count for it). Until then it keeps billing. `--abort` deletes the new
  bucket the same way, after its name.

A bucket stays where it is, and the summary says so, when the new target is your own server or
your Portainer: it keeps billing at its provider, and the app on the new side uses it (OpsCrew asks
for its key if this computer doesn't have it). An [R2](https://developers.cloudflare.com/r2/) bucket always stays, since it's Cloudflare's.
Garage is a service on the server, so its files are copied with the other data.

## Your own server and your Portainer

OpsCrew never deletes, rebuilds or resets a server you own, and never removes your Portainer or its
environment. On either side of a move:

- **As the new side,** the app is set up beside what is already there: a host plan on your server,
  stack plans in your Portainer, each approved by its hash.
- **As the old side,** `--finish` removes only the app, after you type its name:
  - from your server: its containers, its data, its site on the edge and its route, through a
    host plan you approve; the other apps on it keep running;
  - from your Portainer: the app's stacks and their volumes, and the deploy branch the stack was
    built from (OpsCrew asks first).

A move to your own server or Portainer refuses the same things `opscrew provision` refuses there
(see [Own server](own-server.md#when-opscrew-stops-without-changing-anything) and
[Portainer](portainer-target.md)). Your own server as the new side must be reachable from the
internet and serve the app directly (`server.serve: proxy` or `dns-only`). Portainer as the new
side serves the app with the stack's Caddy and the updater (`portainer.web: caddy`,
`portainer.redeploy: updater`), and runs the image the app runs now, so its environment needs the
same processor architecture: move to a server of that architecture first, or run `design` and
`provision` to build for it.

## Sites

A site on [Cloudflare's hosting](cloudflare-hosting.md) moves to [GitHub Pages](github-pages.md),
or the other way round, when design offers the new host for the app (GitHub Pages serves no
server-rendered pages, for example).

```bash
npx opscrew retarget --to github-pages
```

1. **Start:** the summary shows the steps and the new host's price.
2. **Deploy:** the new host is set up without your domain, from plans you approve by their hash.
   OpsCrew opens a pull request with the new deploy workflow; once you merge it, OpsCrew runs it
   and checks the site at its `github.io` address or on the Worker, while the old host still
   serves your domain. To GitHub Pages, OpsCrew also creates GitHub's domain verification record
   (`--pages-verification <value>` in a script; see [Verify your domain](github-pages.md#verify-your-domain)).
3. **The switch:** a site has no data, so there is no maintenance window. One Cloudflare plan,
   which you approve by its hash and the app's name, deletes the old host's DNS records and
   creates the new one's. The site is unreachable for the seconds between the two. On GitHub
   Pages, the certificate can take an hour or more to arrive: until then the site answers over HTTP
   only, and browsers that visited it on Cloudflare refuse HTTP.
4. **`--finish`** removes the old Worker or GitHub Pages site, after the app's name. GitHub's
   verification record stays, so your domain stays verified.

## Apps on several servers, and monitoring

For an app with [services on servers of their own](split-placement.md), only the app server moves.
The extra servers stay where they are, with their data. The new app server joins the app's
[private network](private-network.md), and the old one leaves it at `--finish` (or the new one at
`--abort`). The services on the app server move with their data.

[Self-hosted monitoring](monitoring.md) on the app server moves with its data, or starts empty
(`--empty monitoring`). On a server of its own it stays, and the new app server sends to it.

### To keep a service at the old provider

There is no special mode for it: place the service on an extra server first, then move. With the
app still on the old provider, add a server there and give the service its `server`
([Moving a service of a live app](split-placement.md#moving-a-service-of-a-live-app)), then run
`npx opscrew retarget`. The service stays on that server, and the new app server reaches it over
the private network.

## Without DNS on Cloudflare

When OpsCrew doesn't manage your DNS, it shows the records to change (or, without a domain, the new
side's address). Your confirmation is the switch: confirm only once you made the change, since
after it the move can't be aborted. OpsCrew then waits up to 5 minutes for your domain to point only
to the new side before checking the app; if it doesn't yet, run `npx opscrew retarget` again later
to check.

With data to copy, the app on the old side stays stopped from the maintenance window until your
change has reached your visitors, so the downtime is the window plus your DNS change. That is why a low TTL
matters.

## Finishing the move

Once the app runs on the new side and you are happy with it:

```bash
npx opscrew retarget --finish
```

OpsCrew first checks that the app answers on the new side through its URL; otherwise it keeps the
old side. Then it lists what it removes and asks you to type the app's name:

| Old side | What `--finish` removes |
|---|---|
| A cloud server | The server, after a snapshot when the database or backups lived there (`--snapshot` or `--no-snapshot` to choose); the snapshot is billed until you delete it in the provider's console |
| Your own server | Only the app and its data; never the server |
| Another app's server | Only the app's own parts; the proxy and the other apps stay |
| Your Portainer | Only the app's stacks, their volumes and the deploy branch; never Portainer or the environment |
| A site host | The old Worker or GitHub Pages site |

A bucket that moved is deleted next, after its own name (see [Buckets](#buckets)). OpsCrew forgets
the old server's host key and opens a pull request with the final infrastructure files: merge it,
so the repository describes the new deployment. The move is then done, and `opscrew provision` and
the other commands work as usual.

## Aborting the move

Until DNS switches, you can go back:

```bash
npx opscrew retarget --abort
```

OpsCrew starts the app on the old side again if it was stopped, removes the new side after you type
the app's name (a new cloud server is deleted; on your own server, your Portainer or another app's
server only the app goes),
deletes a new bucket after its own name, points the deploy secrets back to the old side and restores
your plan. Once you have typed the name, the move can only be aborted, not continued.

After the switch, `--abort` refuses: finish the move, then move back with
`npx opscrew retarget --to <the previous target>`.

## When a move stops

A move remembers each step in `opscrew/plan.yaml`. If it stops, because a step failed, you declined
an approval or the terminal closed, run `npx opscrew retarget` again: it continues from the last
completed step. If it stopped while copying the data before the maintenance window, the old side
kept serving, and the run copies again. If it stopped during the window before the copy was
complete, it first starts the app on the old side again.

If it stops after the window's copy, before the switch, the app stays offline: its data is already on the new
side. Run `npx opscrew retarget` soon to continue, or `npx opscrew retarget --abort` to start the
old app again. Don't start the app on the old side yourself, or what it saves won't reach the new
side.

While a move is in progress, `opscrew provision`, `design`, `dns`, `drift`, `destroy`, `rollback`,
`domain buy`, `domain connect` and the add-on commands stop and say how to continue, finish or abort
it. `opscrew status` shows where the move stands and the next command.

## In scripts

A run without a terminal stops at each plan, prints its hash and the command to continue with
`--approve <hash>`. Pass the flags of the first run again with each command. The other answers take
flags:

| Flag | What it does |
|---|---|
| `--option <id>` | The new cloud server to move to (the run lists the ids); without it, a script takes the recommended one |
| `--answers <file>` | Your own server's (`server.*`), another app's server (`server.shares*`) or your Portainer's (`portainer.*`) answers, as `opscrew interview --answers` takes them |
| `--host-key <fingerprint>` | Your new own server's SSH host key (`SHA256:…`), which you checked on the server |
| `--password-logins off\|keep` | Your new own server, when other users log in with a password: turn password logins off anyway, or keep them |
| `--portainer-address <ipv4[,ipv6]>` | The public address of your Portainer host, for example `203.0.113.10` |
| `--portainer-cert <fingerprint>` | Portainer's certificate fingerprint, trusted without a prompt |
| `--public-image` | Your Portainer pulls the app's public image without a registry entry |
| `--empty <service>` | Start that service's data empty (`app`, `monitoring`); repeat for each |
| `--keep-bucket` | Keep the bucket at the provider being left |
| `--pages-verification <value>` | GitHub's domain verification value, for a site moving to GitHub Pages |
| `--approve <hash>` | Applies exactly the saved plan with this hash and continues |
| `--allow-downtime` | Allows the maintenance window |
| `--dns-switched` | You changed the DNS records (or the address) to the new side yourself |
| `--yes` | Approves storing the GitHub deploy secrets, pausing the scheduled check, the push and the pull request |
| `--confirm <name>` | With `--finish` or `--abort`, the app's name instead of typing it; for a bucket's deletion, the bucket's name |
| `--engine <name>` | `tofu` or `terraform` |

For example, a move to your own server:

```yaml
# own.yaml
server.host: 203.0.113.20
server.port: 22
server.user: root
server.key: ~/.ssh/id_ed25519
server.reachable: true
server.serve: proxy
```

```bash
npx opscrew retarget --to own --answers own.yaml --host-key SHA256:... --empty cache --yes
# stops at the host plan and prints the command to continue, with its hash:
npx opscrew retarget --to own --answers own.yaml --host-key SHA256:... --empty cache --approve <hash> --allow-downtime --yes
# ... one run for each plan, up to the switch; later, once you are happy:
npx opscrew retarget --finish --approve <hash> --confirm example-app
```

A move onto another app's server, here the server `shop` runs on, takes its folder instead:

```yaml
# onto-shop.yaml
server.shares: /home/you/code/shop
server.shares-app: admin    # only when that repository has several apps
server.shares-env: prod     # only when it has several environments
```

```bash
npx opscrew retarget --to own --answers onto-shop.yaml --yes
```

When a bucket is deleted at `--finish` or `--abort`, its plan stops on its own, and the printed
command carries `--approve <its hash> --confirm <bucket name>`.

Without DNS on Cloudflare, pass `--allow-downtime --dns-switched` together only when the records are
ready to change right after the maintenance window: with `--allow-downtime` alone, the run stops
after the window, with the app offline, until you change them and run `npx opscrew retarget --dns-switched`.

## What can't move yet

`opscrew retarget` stops before any change, and says why, in these cases. Each can be done by hand.
Where that means removing the app, `npx opscrew destroy` deletes its data on a server it created (it
offers a snapshot first), so back up your data first and restore it on the new target (see
[Backups](databases.md#backups)).

- **This computer** ([your own computer](localhost.md)) on either side: it runs a copy for trying
  changes, not a deployment. Remove that environment with `npx opscrew env remove <name>` and add
  one for the target you want with `npx opscrew env add <name>`.
- **A [preview](previews.md) environment:** its previews come and go with pull requests. Remove it
  (`npx opscrew destroy --env <name>`, then `npx opscrew env remove <name>`) and add it again with
  `npx opscrew env add <name> --previews --target <provider>`.
- **An environment whose server runs another environment's previews,** while they run: remove the
  previews first with `npx opscrew destroy --env <previews environment>` (it leaves the server as it
  is), move, then set the previews up again.
- **A [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/) on either side:** an own server reached through one, Portainer's tunnel
  modes, or Portainer or [Beszel](https://beszel.dev/)'s hub on a subdomain through one. A move switches between address
  records only. First serve the app on a public address (`server.serve: proxy` or `dns-only` for
  your server; `portainer.web: caddy` with `portainer.redeploy: updater` for Portainer) with
  `npx opscrew interview`, `design` and `provision`, then move. Turn Portainer or Beszel on a
  subdomain off first (`npx opscrew portainer disable`, `npx opscrew addon disable beszel`), and on
  again afterwards. To use a tunnel on the new side, move first, then change its answers and run
  `design` and `provision`.
- **Portainer behind your own proxy, with Cloudflare DNS:** serve the app with the stack's Caddy
  first (`portainer.web: caddy`, then `interview`, `design` and `provision`), then move.
- **An Edge Agent environment in Portainer:** use an environment Portainer reaches through its
  Docker socket or the Portainer Agent, or a server. Otherwise remove the app with `destroy` and
  set it up there with `interview`, `design` and `provision`.
- **Two Portainer environments,** in one Portainer or two (the app has one deploy branch and one
  Portainer token): move the app to a server first, then into the other environment; or remove it
  with `destroy` and set it up there with `provision`.
- **A [hosting account](hosting-accounts.md) on either side:** the app's whole design changes. Run
  `npx opscrew destroy` (it offers a final dump of the database, kept on the account), then
  `interview`, `design` and `provision` for the new target, and load the dump there.
- **A site to a server, or a server to a site host:** the app's whole design changes. Run
  `npx opscrew destroy`, then `interview`, `design` and `provision` for the new target.
- **A move within one cloud provider:** for another size, see
  [Advice on size, cost and upkeep](advise.md#applying-a-proposal). For another location, back up
  the data, run `destroy`, then `interview` with the new location, `design` and `provision`, and
  restore the data; or move to another target and back.
