import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { FIRST_BOOT_LOG } from "@opscrew/iac-templates";
import { cloudProvider } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { providerProfile, VPS_PROVIDERS } from "../providers";
import {
  createTestPhaseDeps,
  FakeFirstBoot,
  FIRST_BOOT_SERVER_ID,
  type FirstBootOptions,
  firstBootErrors,
  HOST_KEY,
  NEW_HOST_KEY,
  ScriptedApprovalHandler,
} from "../testing";
import { providerConsole } from "./provider-text";
import {
  confirmChangedHostKey,
  failedSetupSteps,
  isNewServerRepairRequest,
  type NewServerRepair,
  readyNewServer,
  serverInstallFile,
} from "./wait";

describe("confirmChangedHostKey", () => {
  it("names the server in the details only: the title goes to the approvals record and the audit log", async () => {
    const seen: ApprovalRequest[] = [];
    const approvals = {
      async request(request: ApprovalRequest) {
        seen.push(request);
        return { approved: true };
      },
    } as unknown as PhaseDeps["approvals"];
    const confirm = confirmChangedHostKey({ approvals });
    const approved = await confirm({
      host: "203.0.113.10",
      previous: ["ssh-ed25519 AAAAold"],
      current: ["ssh-ed25519 AAAAnew"],
    });
    expect(approved).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe("Trust the server's new SSH host key");
    expect(seen[0]?.title).not.toContain("203.0.113.10");
    expect(seen[0]?.details).toContain("Server: 203.0.113.10");
  });
});

const HOST = "203.0.113.10";
const AGAIN = "run `opscrew provision` again; it continues where it stopped.";
/** A marker cloud-init's errors quote, which no output, audit entry or approval may show. */
const QUOTED = fakeSecret("hcloud-token", "first-boot");
const USER_DATA = "#cloud-config\n# the first-boot file the module renders\n";

/**
 * A new server's first boot (`server`, or one built from `options`), waited for by
 * `readyNewServer` with a repair through its provider's fake API (or `servers`) unless `repair`
 * is false; `answer` decides each approval (default: the app's name typed); `remote` replaces
 * the deploy user's shell. The clock is the test's.
 */
async function firstBoot(
  provider: (typeof VPS_PROVIDERS)[number],
  options: FirstBootOptions & {
    answer?: (request: ApprovalRequest) => boolean;
    repair?: boolean;
    server?: FakeFirstBoot;
    servers?: NewServerRepair["servers"];
    remote?: (host: string) => RemoteExec;
  } = {},
) {
  const server =
    options.server ?? new FakeFirstBoot({ errors: firstBootErrors(QUOTED), ...options });
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: server.runner(),
  });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  let clock = 0;
  const repair: NewServerRepair = {
    servers: options.servers ?? server.servers,
    serverId: FIRST_BOOT_SERVER_ID,
    app: "shop",
    image: providerProfile(provider).defaultImage,
    userData: async () => USER_DATA,
    command: "opscrew provision",
    script: "run `opscrew provision --confirm shop`",
  };
  const result = await readyNewServer(deps, {
    host: HOST,
    server: "server",
    profile: providerProfile(provider),
    keyFile: deps.paths.files.deployKey,
    again: AGAIN,
    services: {
      tcpConnect: server.tcpConnect,
      remote: options.remote ?? server.remote,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    ...(options.repair === false ? {} : { repair }),
  }).catch((error: unknown) => error);
  /** Every text the run showed or kept, and the error's. */
  const everything = [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(handler.requests),
    result instanceof OpsCrewError ? `${result.message}\n${result.hint ?? ""}` : "",
  ].join("\n");
  return { server, deps, handler, result, everything };
}

/** The leak check: cloud-init's errors (their quoted commands) and the first-boot file never show. */
function expectNoLeak(everything: string) {
  expect(everything).not.toContain(QUOTED);
  for (const raw of [
    "apt-get",
    "Exit code",
    "ProcessExecutionError",
    "Runparts",
    "#cloud-config",
  ]) {
    expect(everything).not.toContain(raw);
  }
}

/** The install's hash: the action, the provider, the server, the image and the file's SHA-256. */
function installHash(provider: string): string {
  return sha256Hex(
    JSON.stringify({
      action: "reinstall",
      provider,
      serverId: FIRST_BOOT_SERVER_ID,
      image: providerProfile(provider as (typeof VPS_PROVIDERS)[number]).defaultImage,
      userData: sha256Hex(USER_DATA),
    }),
  );
}

describe.each(VPS_PROVIDERS)("a new server's first boot on %s", (provider) => {
  const profile = providerProfile(provider);
  const named = `the new ${profile.displayName} ${profile.serverNoun} shop`;
  const target = `${provider} server ${FIRST_BOOT_SERVER_ID}`;
  const hash = installHash(provider);
  // A server whose firewall is its own (Kamatera) is never restarted: see `ownFirewall` in wait.ts.
  const ownFirewall = cloudProvider(provider).texts.secops.firewallCheck === "server";

  it("names the failed steps in plain words when no repair is offered", async () => {
    const { result, server, handler, everything } = await firstBoot(provider, { repair: false });
    expect(result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed.`,
    });
    expect((result as OpsCrewError).hint).toContain("cloud-init status --long");
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
    expectNoLeak(everything);
  });

  it.skipIf(ownFirewall)(
    "restarts a server that never opened SSH, after the app's name, then goes on",
    async () => {
      const { result, server, handler, deps, everything } = await firstBoot(provider, {
        network: false,
        setup: "ready",
      });
      expect(result).toMatchObject({ created: true, changed: false });
      expect(result).not.toHaveProperty("installHash");
      expect(server.calls).toEqual([`restart ${FIRST_BOOT_SERVER_ID}`]);
      expect(handler.requests).toHaveLength(1);
      const request = handler.requests[0] as ApprovalRequest;
      expect(request).toMatchObject({
        kind: "remote-exec",
        title: `Restart ${named}`,
        confirmPhrase: "shop",
      });
      // No data is lost by a restart: the typed name only, bound to no hash.
      expect(request.allowDestroy).toBeUndefined();
      expect(request.planHash).toBeUndefined();
      expect(isNewServerRepairRequest(request)).toBe(true);
      expect(request.details).toContain(`The server at ${HOST} did not open SSH within 5 minutes.`);
      expect(request.details).toContain("OpsCrew has no record of a deploy to it.");
      expect(request.details).not.toContain("holds nothing");
      expect(request.details).toContain(
        `OpsCrew restarts ${named} through ${profile.displayName}'s API`,
      );
      expect(deps.audit.entries.filter((e) => e.kind === "provider-call")).toEqual([
        expect.objectContaining({ action: "restart server", target }),
        expect.objectContaining({ action: "server restarted", target }),
      ]);
      expect(deps.reporter.text()).toContain(`success: The server at ${HOST} is ready.`);
      // The title is kept in the approvals record and the audit log: no address there.
      expect(request.title).not.toContain(HOST);
      expect(JSON.stringify(deps.audit.entries)).not.toContain(HOST);
      expectNoLeak(everything);
    },
  );

  it("installs a server whose setup failed again, approved by its hash and the app's name, and pins the new key with no question", async () => {
    const { result, server, handler, deps, everything } = await firstBoot(provider);
    expect(server.calls).toEqual([`reinstall ${FIRST_BOOT_SERVER_ID}`]);
    expect(server.installed).toEqual({ image: profile.defaultImage, userData: USER_DATA });
    // One approval: the install's; the changed host key asks nothing (FR-3110).
    expect(handler.requests.map((r) => r.title)).toEqual([`Install ${named} again`]);
    const request = handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({
      kind: "remote-exec",
      planHash: hash,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(request.details).toContain(
      `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed.`,
    );
    expect(request.details).toContain(
      "It holds no app (no app folder, no running container), and OpsCrew has no record of a deploy to it.",
    );
    expect(request.details).toContain("its disk is wiped");
    expect(request.details).toContain(`Install hash: ${hash}`);
    // Recorded by its hash, so that provision tells it from an infrastructure plan.
    const record = JSON.parse(await readFile(serverInstallFile(deps.paths, hash), "utf8"));
    expect(record).toEqual({
      provider,
      serverId: FIRST_BOOT_SERVER_ID,
      image: profile.defaultImage,
      userDataSha256: sha256Hex(USER_DATA),
    });
    expect(result).toEqual({
      knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n`,
      changed: true,
      created: false,
      installHash: hash,
    });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(`${HOST} ${NEW_HOST_KEY}\n`);
    expect(deps.audit.entries.filter((e) => e.kind === "provider-call")).toEqual([
      expect.objectContaining({
        action: "reinstall server",
        target,
        detail: expect.stringContaining(hash),
      }),
      expect.objectContaining({ action: "server reinstalled", target }),
    ]);
    expectNoLeak(everything);
  });

  it("keeps the install's hash from one run to the next", async () => {
    const answer = (request: ApprovalRequest) => request.planHash === undefined;
    const first = await firstBoot(provider, { answer });
    const second = await firstBoot(provider, { answer });
    expect(first.handler.requests[0]?.planHash).toBe(hash);
    expect(second.handler.requests[0]?.planHash).toBe(hash);
  });

  it("audits an install the provider refused, and stops", async () => {
    const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED) });
    const failing = {
      ...server.servers,
      reinstall: async () => {
        throw new OpsCrewError("PROVIDER_ERROR", "The provider refused the install.");
      },
    };
    const { result, deps } = await firstBoot(provider, { servers: failing });
    expect(result).toMatchObject({ message: "The provider refused the install." });
    expect(deps.audit.entries.filter((e) => e.kind === "provider-call")).toEqual([
      expect.objectContaining({ action: "reinstall server", target }),
      expect.objectContaining({
        action: "reinstall failed",
        detail: expect.stringContaining("The provider refused the install."),
      }),
    ]);
  });

  it.skipIf(ownFirewall)(
    "repairs the live case: a restart, then an install, at most one of each",
    async () => {
      const { result, server, handler } = await firstBoot(provider, { network: false });
      expect(server.calls).toEqual([
        `restart ${FIRST_BOOT_SERVER_ID}`,
        `reinstall ${FIRST_BOOT_SERVER_ID}`,
      ]);
      expect(handler.requests.map((r) => r.title)).toEqual([
        `Restart ${named}`,
        `Install ${named} again`,
      ]);
      expect(result).toMatchObject({ knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n` });

      // A server that fails again after the install is not installed a second time.
      const again = await firstBoot(provider, { network: false, setupAfterInstall: "failed" });
      expect(again.server.calls).toEqual([
        `restart ${FIRST_BOOT_SERVER_ID}`,
        `reinstall ${FIRST_BOOT_SERVER_ID}`,
      ]);
      expect(again.result).toMatchObject({
        code: "PROVIDER_ERROR",
        message: expect.stringContaining("did not finish its first-boot setup"),
      });
    },
  );

  it.runIf(ownFirewall)(
    "never restarts a server whose own firewall may have failed: it may have powered itself off",
    async () => {
      const { result, server, handler } = await firstBoot(provider, { network: false });
      expect(server.calls).toEqual([]);
      expect(handler.requests).toEqual([]);
      expect(result).toMatchObject({
        code: "PROVIDER_ERROR",
        message: `The server at ${HOST} did not open SSH within 5 minutes.`,
      });
      expect((result as OpsCrewError).hint).toContain(
        "powers it off rather than leave it reachable",
      );
    },
  );

  it.skipIf(ownFirewall)(
    "restarts once: a server still without SSH after it stops plainly",
    async () => {
      const stuck = new FakeFirstBoot({ network: false });
      // A restart that brings no network.
      const stays = {
        ...stuck.servers,
        restart: async (id: string) => {
          stuck.calls.push(`restart ${id}`);
        },
      };
      const { result } = await firstBoot(provider, { network: false, servers: stays });
      expect(stuck.calls).toEqual([`restart ${FIRST_BOOT_SERVER_ID}`]);
      expect(result).toMatchObject({
        code: "PROVIDER_ERROR",
        message: `The server at ${HOST} did not open SSH within 5 minutes after OpsCrew restarted it.`,
      });
    },
  );

  it("points a server that doesn't answer at its first boot's log where that runs as a startup script", async () => {
    const script = cloudProvider(provider).terraform.firstBoot === "script";
    const firewall = cloudProvider(provider).texts.secops.firewallCheck === "server";
    const silent = await firstBoot(provider, { network: false, repair: false });
    const locked = await firstBoot(provider, { login: false, repair: false });
    expect(silent.result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not open SSH within 5 minutes.`,
    });
    expect(locked.result).toMatchObject({ code: "PROVIDER_ERROR" });
    for (const { result } of [silent, locked]) {
      const hint = (result as OpsCrewError).hint ?? "";
      expect(hint.includes(`Read its log, ${FIRST_BOOT_LOG}, from the server's console`)).toBe(
        script || firewall,
      );
      expect(hint.includes("powers it off rather than leave it reachable")).toBe(firewall);
      if (script || firewall) {
        const runs = script
          ? "runs OpsCrew's first boot as its startup script"
          : "sets up its own firewall first at its first boot";
        expect(hint).toBe(
          `The server ${runs}${firewall ? ", which powers it off rather than leave it reachable without its own firewall" : ""}. Read its log, ${FIRST_BOOT_LOG}, from the server's console in the ${providerConsole(profile)}, then ${AGAIN}`,
        );
      }
    }
    expect((silent.result as OpsCrewError).hint).toContain(providerConsole(profile));
  });

  it("without the approval restarts and installs nothing, and prints the command that approves it", async () => {
    if (!ownFirewall) {
      const restart = await firstBoot(provider, { network: false, answer: () => false });
      expect(restart.server.calls).toEqual([]);
      expect(restart.result).toMatchObject({ code: "APPROVAL_REFUSED" });
      const refused = restart.result as OpsCrewError;
      expect(refused.message).toContain("did not open SSH");
      expect(refused.message).toContain("OpsCrew did not restart it");
      expect(refused.message).toContain("Nothing was changed.");
      expect(refused.hint).toBe(
        "To restart it, run `opscrew provision` again and type shop when asked; in a script, run `opscrew provision --confirm shop`.",
      );
    }

    const install = await firstBoot(provider, { answer: () => false });
    expect(install.server.calls).toEqual([]);
    const error = install.result as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("OpsCrew did not install it");
    expect(error.hint).toBe(
      `To install it again, run \`opscrew provision\` again and type shop when asked; in a script, run \`opscrew provision --approve ${hash} --confirm shop\`.`,
    );
  });

  it("never offers an install when the deploy user's shell never answered", async () => {
    const { result, server, handler } = await firstBoot(provider, { login: false });
    expect(result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not let the deploy user in to check its first-boot setup within 8 minutes.`,
    });
    // A first boot run as a startup script is read from its log in the console instead.
    const script = cloudProvider(provider).terraform.firstBoot === "script";
    expect((result as OpsCrewError).hint).toContain(
      script ? FIRST_BOOT_LOG : "cloud-init status --long",
    );
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("never offers an install for a server that shows an app, and names none of it", async () => {
    for (const app of ["folder", "container"] as const) {
      const { result, server, handler, everything } = await firstBoot(provider, { app });
      expect(result).toMatchObject({
        code: "PROVIDER_ERROR",
        message: `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed. It shows an app (OpsCrew's ready mark, an app's folder or a running container), so OpsCrew does not offer to install it again.`,
      });
      expect(handler.requests).toEqual([]);
      expect(server.calls).toEqual([]);
      expectNoLeak(everything);
    }
  });

  it("never offers an install when the shell stops answering at the look for an app", async () => {
    const { result, server, handler } = await firstBoot(provider, { app: "silent" });
    expect(result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed. It stopped answering the deploy user, so OpsCrew could not check what it holds and does not offer to install it again.`,
    });
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("waits for the new system's key while the old one still answers, and stops when it never comes", async () => {
    const slow = await firstBoot(provider, { oldScans: 5 });
    expect(slow.result).toMatchObject({ knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n` });
    const scans = (slow.deps.runner as ReturnType<FakeFirstBoot["runner"]>).calls.filter(
      (call) => call.command === "ssh-keyscan",
    );
    // The pin before the install, five scans of the old system, then the new one, pinned as read.
    expect(scans).toHaveLength(7);

    const never = await firstBoot(provider, { oldScans: 1_000 });
    expect(never.result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} still had its old SSH host key 10 minutes after ${profile.displayName} accepted its install: the install did not take effect.`,
    });
    // The old pin stays.
    expect(await readFile(never.deps.paths.files.knownHosts, "utf8")).toBe(`${HOST} ${HOST_KEY}\n`);
  });

  it("offers nothing where the provider's connector cannot restart or install", async () => {
    const { result, server, handler } = await firstBoot(provider, { repairs: false });
    expect(result).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});

it("looks for an app by the ready mark, the apps' folders and Docker's running containers", async () => {
  const commands: string[] = [];
  const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED) });
  const recording = (host: string) => {
    const remote = server.remote(host);
    return {
      host,
      run: (command: string, options?: Parameters<typeof remote.run>[1]) => {
        commands.push(command);
        return remote.run(command, options);
      },
    };
  };
  await firstBoot("hetzner", { remote: recording, server });
  const look = commands.find((command) => command.includes("/srv/apps")) ?? "";
  for (const part of ["test ! -e /var/lib/opscrew-ready", "ls -A /srv/apps", "docker ps -q"]) {
    expect(look).toContain(part);
  }
});

describe("failedSetupSteps", () => {
  const answering = (stdout: string, exitCode = 0) => ({
    host: HOST,
    run: async () => ({ exitCode, stdout, stderr: "" }),
  });

  it("names each module once, others by their name, and reads nothing it cannot parse", async () => {
    const result = JSON.stringify({
      v1: {
        errors: [
          "('scripts_user', RuntimeError('Runparts: 1 failures (runcmd)'))",
          "('runcmd', OSError('x'))",
          "('write_files', OSError('y'))",
          "Something without a module",
        ],
      },
    });
    expect(await failedSetupSteps(answering(result))).toEqual([
      "OpsCrew's setup script",
      "cloud-init's write_files step",
      "a step cloud-init does not name",
    ]);
    for (const remote of [answering("not json"), answering("{}"), answering(result, 1)]) {
      expect(await failedSetupSteps(remote)).toEqual([]);
    }
  });
});

it("asks nothing again over the private network, where a server was set up long ago", async () => {
  const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED) });
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({ approvalHandler: handler, runner: server.runner() });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `[10.0.0.2]:22 ${HOST_KEY}\n`);
  let clock = 0;
  const error = await readyNewServer(deps, {
    host: HOST,
    server: "server",
    profile: providerProfile("contabo"),
    keyFile: deps.paths.files.deployKey,
    again: AGAIN,
    services: {
      tcpConnect: server.tcpConnect,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    network: { host: "10.0.0.2", port: 22, remote: server.remote("10.0.0.2") },
    repair: {
      servers: server.servers,
      serverId: FIRST_BOOT_SERVER_ID,
      app: "shop",
      image: "image",
      userData: async () => USER_DATA,
      command: "opscrew provision",
      script: "run `opscrew provision --confirm shop`",
    },
  }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
  expect(handler.requests).toEqual([]);
  expect(server.calls).toEqual([]);
});
