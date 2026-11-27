/**
 * The live pass of IONOS Cloud (docs/e2e.md "IONOS Cloud", SC-3514, SC-3515): `examples/flask-sqlite`
 * on one `vcpu-2-4` in `de/fra/1` (Frankfurt), on the IONOS Cloud contract `IONOS_TOKEN` reaches.
 * IONOS bills it by the hour (about €0.04 an hour for the server and its disk, plus its reserved
 * IPv4 address at €5 per 30 days and its snapshot at €0.04 per GB per 30 days while they exist).
 * The app is named after the run, so nothing of an earlier run is ever taken for this one's. Steps,
 * in order:
 * 1. the token check, and the interview chooses IONOS from its token alone;
 * 2. design: one `vcpu-2-4` in `de/fra/1`, priced in EUR, with no provider backups;
 * 3. provision: one server in its own data centre, its reserved address, first boot finished;
 * 4. the first deploy, verify, status, and the app on its domain;
 * 5. a whole-server snapshot, billed per GB per month; 6. its restore, and verify again;
 * 7. secure: the NIC firewall lets in SSH from the allowed network, the web ports and nothing
 *    else, and drift finds no change;
 * 8. a stop and a start through IONOS: the same address, the app answers again;
 * 9. destroy: the data centre gone; the snapshots then deleted by the test, and nothing of the app
 *    left (no data centre, IP block or snapshot of it);
 * 10. the token in no output, log, audit entry, state file, plan or commit.
 * Facts the pass settles are logged as `observed:` lines (research R5): the first boot's outbound
 * replies, the image alias, the IP block's location, the SSH rule's source as read back, the
 * seconds to ready, whether the stop is graceful, whether a restore needs the server stopped,
 * whether the token reads the contract, and whether snapshots outlive the data centre.
 * Whatever fails after provision, the cleanup still destroys the app, deletes every snapshot the run
 * recorded, and fails the run on any data centre, IP block or snapshot of the app left.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import type { ServerSnapshotApi, VpsConnector } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { IonosClient, readIonosCredentials } from "@opscrew/provider-ionos";
import { cloudProvider } from "@opscrew/providers";
import { describe, expect } from "vitest";
import { z } from "zod";
import { minutes } from "./cloud";
import { readValue, writeValue } from "./component-checks";
import { serverSnapshotId, takeoverLines, unsaid } from "./contabo-support";
import { AppEnvironments } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import {
  approvedRestore,
  type DeployRun,
  deployLogLeaks,
  listSnapshots,
  snapshotOf,
} from "./snapshots-checks";
import { serverShell } from "./split-checks";
import { missingVariables } from "./support";

const ENV = process.env;
const GATE = "OPSCREW_E2E_IONOS";
/** IONOS's one variable, read by OpsCrew under this name, as a user's run does. */
const TOKEN_VARIABLE = "IONOS_TOKEN";
const VARIABLES = [
  TOKEN_VARIABLE,
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
];
/**
 * The size the pass runs and its location. Design sizes 2 vCPU and 4 GB for 1,000 to 10,000 users
 * a month, which the `vcpu-2-4` holds with its 80 GB disk; `eu-central` maps to `de/fra/1` first.
 */
const SIZE = "vcpu-2-4";
const LOCATION = "de/fra/1";
/** An app with its own SQLite file, whose value shows that the restore put the snapshot back. */
const EXAMPLE = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV), app: EXAMPLE };
const MISSING = missingVariables(ENV, GATE, VARIABLES);
if (ENV[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (IONOS Cloud): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "IONOS Cloud").`,
  );
}

/** The NIC firewall rules the module makes, by name: protocol and port (ICMP has none). */
const ALLOWED_RULES: Record<string, { protocol: string; port: number | null }> = {
  SSH: { protocol: "TCP", port: 22 },
  HTTP: { protocol: "TCP", port: 80 },
  HTTPS: { protocol: "TCP", port: 443 },
  "HTTP/3": { protocol: "UDP", port: 443 },
  Ping: { protocol: "ICMP", port: null },
};

// --- The Cloud API v6's answers the test reads (unknown fields kept) ---------------------------

const named = z.looseObject({
  id: z.string(),
  properties: z.looseObject({ name: z.string().nullish() }),
});
const collectionOf = <T extends z.ZodType>(item: T) => z.looseObject({ items: z.array(item) });
const ipBlockSchema = z.looseObject({
  id: z.string(),
  properties: z.looseObject({
    name: z.string().nullish(),
    location: z.string(),
    ips: z.array(z.string()).nullish(),
  }),
});
const nicSchema = z.looseObject({
  id: z.string(),
  properties: z.looseObject({
    firewallActive: z.boolean().nullish(),
    firewallType: z.string().nullish(),
  }),
});
const ruleSchema = z.looseObject({
  id: z.string(),
  properties: z.looseObject({
    name: z.string().nullish(),
    protocol: z.string(),
    sourceIp: z.string().nullish(),
    portRangeStart: z.number().nullish(),
    type: z.string().nullish(),
  }),
});
const volumeSchema = z.looseObject({
  properties: z.looseObject({
    image: z.string().nullish(),
    imageAlias: z.string().nullish(),
  }),
});
const serverSchema = z.looseObject({
  properties: z.looseObject({ bootVolume: z.looseObject({ id: z.string() }).nullish() }),
});

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live IONOS Cloud (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "IONOS Cloud")`
    : `live IONOS Cloud: examples/${EXAMPLE} on one ${SIZE} in ${LOCATION}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "IONOS Cloud",
      name: "ionos",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const credentials: Record<string, string> = {
      [TOKEN_VARIABLE]: ENV[TOKEN_VARIABLE]?.trim() ?? "",
    };
    // Only to point OpsCrew at another address of IONOS's API, as a user may.
    if (ENV.IONOS_API_URL !== undefined) credentials.IONOS_API_URL = ENV.IONOS_API_URL;
    run.scrubber.add(ENV[TOKEN_VARIABLE], TOKEN_VARIABLE);
    const app = `e2e-ion-${run.runId}`;
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    const deployRuns: DeployRun[] = [];
    const site = () => `https://${run.appHost}`;
    const ageKey = () => join(run.work, "age-key.txt");
    /** The app's server as OpsCrew's IONOS connector names it: `<datacenter id>/<server id>`. */
    let serverId = "";
    let ipv4: string | undefined;
    /** The whole-server snapshot of step 5, which step 6 restores. */
    let snapshot = "";
    /** Every snapshot of the app's server the run knows of, until the test deletes it. */
    const snapshots = new Set<string>();
    let connector: VpsConnector | undefined;
    let ionosClient: IonosClient | undefined;

    /** OpsCrew's own IONOS connector, with the token, built on first use. */
    function ionosConnector(): VpsConnector {
      connector ??= cloudProvider("ionos").connector({ env: credentials });
      return connector;
    }

    /** IONOS's server API through OpsCrew's connector. */
    function ionos(): ServerSnapshotApi {
      const api = ionosConnector().servers;
      if (api === undefined) throw new Error("OpsCrew's IONOS connector has no server API.");
      return api;
    }

    /** The package's Cloud API client, for what the server API doesn't read. */
    function client(): IonosClient {
      if (ionosClient !== undefined) return ionosClient;
      const redactor = new Redactor();
      const read = readIonosCredentials(credentials, redactor);
      if ("problem" in read) throw new Error(read.problem);
      ionosClient = new IonosClient({ token: read.token, apiUrl: read.apiUrl, redactor });
      return ionosClient;
    }

    /** The server's data centre and server ids, from `serverId`. */
    function serverParts(): { datacenter: string; server: string } {
      const [datacenter = "", server = ""] = serverId.split("/");
      return { datacenter, server };
    }

    /** `opscrew-<app>` or `opscrew-<app>-…`: the names OpsCrew gives the app's things at IONOS. */
    const ours = (name: string | null | undefined) =>
      typeof name === "string" && (name === `opscrew-${app}` || name.startsWith(`opscrew-${app}-`));

    /**
     * What the contract still holds with the app's names: data centres (`opscrew-<app>`,
     * `opscrew-<app>-…`), IP blocks (`opscrew-<app>…`) and snapshots (`opscrew-<app>-…`).
     */
    async function leftovers(): Promise<string[]> {
      const api = client();
      const depth = { depth: "1" };
      const datacenters = (await api.get("/datacenters", collectionOf(named), depth)).items;
      const blocks = (await api.get("/ipblocks", collectionOf(ipBlockSchema), depth)).items;
      const taken = (await api.get("/snapshots", collectionOf(named), depth)).items;
      return [
        ...datacenters
          .filter((dc) => ours(dc.properties.name))
          .map((dc) => `data centre ${dc.properties.name} (${dc.id})`),
        ...blocks
          .filter((block) => ours(block.properties.name))
          .map((block) => `IP block ${block.properties.name} (${block.id})`),
        ...taken
          .filter((s) => s.properties.name?.startsWith(`opscrew-${app}-`) ?? false)
          .map((s) => `snapshot ${s.properties.name} (${s.id})`),
      ];
    }

    /** Records every snapshot IONOS lists for the app's server, so the cleanup deletes them. */
    async function recordServerSnapshots(): Promise<void> {
      if (serverId === "") return;
      for (const { id } of await ionos().listSnapshots(serverId)) snapshots.add(id);
      log(`observed: ${snapshots.size} snapshots of the server recorded for the cleanup`);
    }

    /** How many clean shutdowns the server's login records hold (`last -x shutdown`). */
    async function cleanShutdowns(): Promise<number> {
      const shell = await serverShell(run, envs, "app");
      const out = await shell.ok("last -x shutdown | grep -c '^shutdown' || true");
      return Number.parseInt(out.trim(), 10) || 0;
    }

    run.step(
      `1. examples/${EXAMPLE} named ${app}: the token check, init, analyze and the interview, which chooses IONOS from its token alone`,
      minutes(15),
      async () => {
        // Settles whether a sub-user's token reads `GET /contracts` (the check reads it).
        const check = await ionosConnector().verifyCredentials();
        log(`observed: the token check ${check.ok ? "passed" : "failed"}: ${check.message}`);
        expect(check.ok, `IONOS's token check: ${check.message}`).toBe(true);
        await run.prepareRepo({
          commit: `e2e: examples/${EXAMPLE} on IONOS Cloud`,
          env: { ...credentials, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
          // Only IONOS's token, so the interview has no other provider to choose.
          drop: [
            "CNTB_OAUTH2_CLIENT_ID",
            "CNTB_OAUTH2_CLIENT_SECRET",
            "CNTB_OAUTH2_USER",
            "CNTB_OAUTH2_PASS",
            "OVH_ENDPOINT",
            "OVH_CLIENT_ID",
            "OVH_CLIENT_SECRET",
            "OVH_CLOUD_PROJECT_SERVICE",
            "KAMATERA_API_CLIENT_ID",
            "KAMATERA_API_SECRET",
          ],
        });
        await envs.snapshotGithub();
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const file = run.paths().files.architecture;
        const architecture = await readArtifact("architecture", file);
        await writeArtifact("architecture", file, {
          ...architecture,
          facts: { ...architecture.facts, name: app },
        });
        const answers = join(run.work, "answers.json");
        // No provider: with only IONOS's token set, the interview chooses it.
        await writeFile(
          answers,
          JSON.stringify({
            expectedMonthlyUsers: "1k-10k",
            budgetMonthly: 45,
            region: "eu-central",
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: run.appHost,
            keepExternalServices: { s3: false },
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        const requirements = await readArtifact("requirements", run.paths().files.requirements);
        expect(requirements.provider, "the provider the interview chose").toBe("ionos");
      },
    );

    run.step(
      `2. design: one ${SIZE} in ${LOCATION}, priced in EUR, with no IONOS backups`,
      minutes(10),
      async () => {
        await run.opscrewOk("design");
        const plan = await envs.designed("prod");
        expect(plan.app.name, "the app's name").toBe(app);
        const target = cloudTarget(plan.target);
        expect(
          {
            provider: target.provider,
            size: target.serverType,
            location: target.location,
            backups: target.backups,
          },
          "the server design planned",
        ).toEqual({ provider: "ionos", size: SIZE, location: LOCATION, backups: false });
        expect(plan.cost.monthly.currency, "the price's currency").toBe("EUR");
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        // The pass tests IONOS, not off-server copies, whose R2 bucket needs a key only the user
        // can make in Cloudflare's dashboard; the recovery copy still needs its age key.
        await run.opscrewOk("snapshot", "offsite", "off");
        const copies = join(run.work, "copies");
        await mkdir(copies, { recursive: true });
        await run.opscrewOk("secrets", "folder", copies);
        run.provisionFlags = ["--key-out", ageKey()];
        log(
          `observed: ${SIZE} in ${target.location} at ${plan.cost.monthly.amount} ${plan.cost.monthly.currency} a month (${plan.cost.source} prices)`,
        );
      },
    );

    run.step(
      `3. provision: one server in its own data centre opscrew-${app}, its reserved address, the first boot finished, and no takeover`,
      minutes(60),
      async () => {
        await run.adaptAndMerge();
        expect(await leftovers(), "the app's things at IONOS before provision").toEqual([]);
        envs.provisioned.add("prod");
        const started = Date.now();
        const output = await run.provisionUntilDone("provision");
        const seconds = Math.round((Date.now() - started) / 1000);
        await envs.remember("prod");
        await run.rememberSecretFile(ageKey(), "age-identity");
        expect(takeoverLines(output), "provision's takeover notes").toEqual([]);
        const servers = await ionos().findAppServers(app);
        expect(
          servers.map((server) => server.name),
          "the app's servers at IONOS",
        ).toEqual([app]);
        serverId = servers[0]?.id ?? "";
        ipv4 = (await readServerAddresses(run.paths())).deployment?.ipv4;
        expect(ipv4, "the server's address OpsCrew recorded").toBeDefined();
        log(`observed: server ${serverId} (${servers[0]?.status}), provision took ${seconds} s`);

        // The reserved address: an IP block named after the server, in its location.
        const blocks = (
          await client().get("/ipblocks", collectionOf(ipBlockSchema), { depth: "1" })
        ).items.filter((block) => block.properties.name === `opscrew-${app}`);
        expect(
          blocks.map((block) => block.properties.ips ?? []),
          "the app's IP block and its address",
        ).toEqual([[ipv4]]);
        log(`observed: the IP block opscrew-${app} in ${blocks[0]?.properties.location}`);

        // The image the alias `ubuntu:24.04` chose.
        const { datacenter, server } = serverParts();
        const boot = (
          await client().get(`/datacenters/${datacenter}/servers/${server}`, serverSchema, {
            depth: "1",
          })
        ).properties.bootVolume?.id;
        if (boot !== undefined) {
          const volume = await client().get(
            `/datacenters/${datacenter}/volumes/${boot}`,
            volumeSchema,
            { depth: "1" },
          );
          log(
            `observed: the boot volume's image ${volume.properties.image} (alias ${volume.properties.imageAlias})`,
          );
        }

        // The first boot reaches the internet (apt, Docker) only if the NIC firewall lets the
        // replies to the server's own traffic back in.
        const shell = await serverShell(run, envs, "app");
        const cloudInit = await shell.run("cloud-init status --wait --long", minutes(15));
        expect(
          { exitCode: cloudInit.exitCode, done: cloudInit.stdout.includes("status: done") },
          `cloud-init's status:\n${cloudInit.stdout}`,
        ).toEqual({ exitCode: 0, done: true });
        log("observed: cloud-init finished: the NIC firewall lets the outbound replies back in");
      },
    );

    run.step(
      "4. deploy, verify and status: the first deploy, and the app answers on its domain through Cloudflare",
      minutes(45),
      async () => {
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        await run.opscrewOk("verify");
        await run.opscrewOk("status");
        await writeValue(site(), before);
      },
    );

    run.step(
      "5. snapshot --server: a whole-server snapshot, billed per GB per month",
      minutes(30),
      async () => {
        // A snapshot taken by a run that failed or timed out may still be at IONOS: record them all.
        const taken = await run
          .opscrewWithin(minutes(25), "snapshot", "--server")
          .catch(async (error: unknown) => {
            await recordServerSnapshots();
            throw error;
          });
        if (taken.exitCode !== 0) {
          await recordServerSnapshots();
          throw new Error(
            `opscrew snapshot --server exited with ${taken.exitCode}:
${run.tail(taken.output)}`,
          );
        }
        expect(unsaid(taken.output, ["per GB per month"]), "its price").toEqual([]);
        const id = serverSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        snapshot = id;
        snapshots.add(id);
        const listed = snapshotOf(await listSnapshots(run), id);
        expect(listed.kind, "its kind").toBe("server");
        expect(listed.server?.name, "its server").toBe(app);
        log(`observed: the whole-server snapshot ${id}`);
      },
    );

    run.step(
      "6. restore --server <id> after the server's name typed, while it runs: the same server and address, the snapshot's data back, and verify again",
      minutes(45),
      async () => {
        await writeValue(site(), after);
        // OpsCrew restores the boot volume while the server runs; a refusal here settles that
        // IONOS needs the server stopped first.
        const restored = await approvedRestore(run, ["--server", snapshot]);
        log("observed: IONOS restored the boot volume while the server ran");
        expect(restored.confirm, "the name the restore asks to type").toBe(app);
        expect(
          restored.applied.output.includes("and the app answers"),
          `the result says the app answers:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        expect(
          (await ionos().findAppServers(app)).map((server) => server.id),
          "the app's servers after the restore",
        ).toEqual([serverId]);
        expect(
          (await readServerAddresses(run.paths())).deployment?.ipv4,
          "the server's address after the restore",
        ).toBe(ipv4);
        await run.waitForHealth();
        await readValue(site(), before);
        await run.opscrewOk("verify");
      },
    );

    run.step(
      "7. secure and drift: the NIC firewall on, SSH only from the allowed network, the web ports and nothing else, and no drift (a /32 source reads back unchanged)",
      minutes(20),
      async () => {
        const secure = await run.opscrew("secure");
        expect(secure.output, "secure's report").toContain("SECURITY_REPORT.md");
        const report = await readFile(run.paths().files.securityReport, "utf8");
        const { unattachedText, keylessText } = cloudProvider("ionos").texts.secops;
        expect(
          [unattachedText, keylessText].filter((text) => report.includes(text)),
          "SECURITY_REPORT.md's findings on the server",
        ).toEqual([]);

        // The NIC firewall as IONOS reads it back.
        const { datacenter, server } = serverParts();
        const nics = `/datacenters/${datacenter}/servers/${server}/nics` as const;
        const nic = (await client().get(nics, collectionOf(nicSchema), { depth: "1" })).items;
        expect(
          nic.map((n) => ({
            active: n.properties.firewallActive,
            type: n.properties.firewallType,
          })),
          "the server's NIC and its firewall",
        ).toEqual([{ active: true, type: "INGRESS" }]);
        const rules = (
          await client().get(`${nics}/${nic[0]?.id}/firewallrules`, collectionOf(ruleSchema), {
            depth: "1",
          })
        ).items.map(({ properties: p }) => p);
        expect(
          rules
            .filter((rule) => {
              const allowed = ALLOWED_RULES[rule.name ?? ""];
              return (
                allowed === undefined ||
                allowed.protocol !== rule.protocol ||
                (allowed.port !== null && allowed.port !== rule.portRangeStart)
              );
            })
            .map((rule) => `${rule.name} ${rule.protocol} ${rule.portRangeStart}`),
          "the NIC firewall's rules beyond SSH, the web ports and ping",
        ).toEqual([]);
        const ssh = rules.filter((rule) => rule.name === "SSH");
        expect(ssh.length, "the SSH rules").toBeGreaterThan(0);
        expect(
          ssh.filter((rule) => !rule.sourceIp || rule.sourceIp.startsWith("0.0.0.0")).length,
          "SSH rules open to every address",
        ).toBe(0);
        for (const name of ["HTTP", "HTTPS"]) {
          expect(
            rules.some((rule) => rule.name === name),
            `a ${name} rule`,
          ).toBe(true);
        }
        log(
          `observed: ${rules.length} NIC firewall rules; the SSH sources read back ${
            ssh.every((rule) => rule.sourceIp?.endsWith("/32")) ? "with" : "without"
          } /32`,
        );

        // A second plan shows no change, whatever form IONOS gives the sources back in.
        const drift = await run.opscrew("drift");
        expect(drift.exitCode, `opscrew drift:\n${run.tail(drift.output)}`).toBe(0);
      },
    );

    run.step(
      "8. a stop and a start through IONOS: the reserved address kept, the app answers again, and whether the stop was graceful",
      minutes(30),
      async () => {
        const shutdowns = await cleanShutdowns();
        await ionos().powerOff(serverId);
        log(`observed: the server ${serverId} stopped through IONOS`);
        await ionos().powerOn(serverId);
        log(`observed: the server ${serverId} started through IONOS`);
        await run.waitForHealth();
        await readValue(site(), before);
        const blocks = (
          await client().get("/ipblocks", collectionOf(ipBlockSchema), { depth: "1" })
        ).items.filter((block) => block.properties.name === `opscrew-${app}`);
        expect(
          blocks.map((block) => block.properties.ips ?? []),
          "the app's IP block after the stop",
        ).toEqual([[ipv4]]);
        const graceful = (await cleanShutdowns()) > shutdowns;
        log(
          `observed: IONOS's stop ${graceful ? "shut the system down gracefully" : "left no clean shutdown record (a hard stop)"}`,
        );
      },
    );

    run.step(
      "9. destroy: the data centre deleted, nothing in Cloudflare; then the test deletes the run's snapshots, and nothing of the app is left at IONOS",
      minutes(45),
      async () => {
        await envs.destroy("prod");
        expect(await ionos().findAppServers(app), "the app's servers at IONOS").toEqual([]);
        await run.expectCloudflareClean();
        // Settles whether IONOS keeps a server's snapshots once its data centre is deleted.
        if (serverId !== "") {
          const kept = await ionos().listSnapshots(serverId);
          log(
            `observed: ${kept.length} of the server's snapshots outlived its data centre (${snapshots.size} recorded)`,
          );
          for (const { id } of kept) snapshots.add(id);
        }
        for (const id of [...snapshots]) {
          await ionos().deleteSnapshot(id);
          snapshots.delete(id);
          log(`observed: the snapshot ${id} deleted by the test`);
        }
        expect(await leftovers(), "the app's data centres, IP blocks and snapshots").toEqual([]);
        log(`observed: no data centre, IP block or snapshot of ${app} left at IONOS`);
      },
    );

    run.step(
      "10. neither the IONOS token nor any other secret in any output, deploy job's log, audit entry, state file, plan or commit",
      minutes(10),
      async () =>
        run.expectNothingLeaked([
          // IONOS's provider reads the token from the environment: it is in no state file either.
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
        ]),
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        for (const id of [...snapshots]) {
          await attempt(`delete the snapshot ${id} at IONOS`, async () => {
            await ionos().deleteSnapshot(id);
            snapshots.delete(id);
            log(`cleanup: the snapshot ${id} deleted at IONOS`);
          });
        }
        await attempt(`check that nothing of ${app} is left at IONOS`, async () => {
          const left = await leftovers();
          if (left.length > 0) {
            throw new Error(
              `IONOS still has ${left.join(", ")}: delete each in IONOS's Data Center Designer (the data centre first, then its IP block under Network → IP Management, and the snapshots under Snapshots).`,
            );
          }
        });
      },
    });
  },
);
