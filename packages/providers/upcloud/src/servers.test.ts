import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotRequest } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  fakeTime,
  storageState,
  TOKEN,
  TOKEN_ENV,
  upcloudError,
  upcloudFetch,
} from "./__fixtures__/client";
import {
  BACKUP_ALIKE,
  BACKUP_BY_HAND,
  BACKUP_FOREIGN,
  BACKUP_NEW,
  BACKUP_OLD,
  BACKUP_SIMPLE,
  BACKUP_TAKEN,
  backup,
  backupCreated,
  backupList,
  details,
  listed,
  NO_CONTENT,
  OTHER_ID,
  SHOP_DISK,
  SHOP_ID,
  serverList,
  WORKER_DISK,
  WORKER_ID,
} from "./__fixtures__/servers";
import { readUpcloudCredentials, UpcloudClient } from "./client";
import { upcloudServerApi } from "./servers";

/** The title OpsCrew gives the backup it takes at the fake clock's start. */
const TAKEN = "opscrew-shop-shop-20261128T100000Z";
const PANEL = "UpCloud's control panel (https://hub.upcloud.com/)";

const SERVER = `GET /server/${SHOP_ID}`;
const DISK = `GET /storage/${SHOP_DISK}`;
const BACKUPS = "GET /storage/backup";
const STOP = `POST /server/${SHOP_ID}/stop`;
const START = `POST /server/${SHOP_ID}/start`;
const RESTART = `POST /server/${SHOP_ID}/restart`;

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = upcloudFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the token is registered when it is read.
  readUpcloudCredentials(TOKEN_ENV, redactor);
  const client = new UpcloudClient({
    token: TOKEN,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
  });
  const api = upcloudServerApi(client, { now: time.now });
  return { api, calls: fake.calls, time };
}

/** The requests sent, as `METHOD /path?query`. */
const requests = (calls: FakeCall[]) => calls.map((call) => `${call.method} ${call.path}`);

/** The bodies of the `POST`s sent, in order. */
const posted = (calls: FakeCall[]) =>
  calls.filter((call) => call.method === "POST").map((call) => call.body);

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const errorText = (error: OpsCrewError) =>
  `${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`;

const request = (labels: Record<string, string> = { app: "shop" }): SnapshotRequest => ({
  name: "opscrew-shop-20261128T100000Z",
  description: "Taken by OpsCrew",
  labels,
});

describe("findAppServers", () => {
  it("returns the servers titled exactly app or app-<name> with the app's label, by UUID and UpCloud's state", async () => {
    const { api, calls } = setup({
      "GET /server": serverList(
        listed("shop"),
        listed("shop-worker", { uuid: WORKER_ID, state: "stopped", zone: "fi-hel1" }),
        listed("shopfront", { uuid: OTHER_ID }),
        listed("myshop", { uuid: OTHER_ID }),
        listed("SHOP", { uuid: OTHER_ID }),
        listed("shop_2", { uuid: OTHER_ID }),
        // Titled as the app's, but another app's label, or none at all.
        listed("shop-cache", { uuid: OTHER_ID, labels: { "opscrew-app": "cache" } }),
        listed("shop-old", { uuid: OTHER_ID, labels: {} }),
      ),
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: SHOP_ID, name: "shop", status: "started" },
      { id: WORKER_ID, name: "shop-worker", status: "stopped" },
    ]);
    expect(requests(calls)).toEqual(["GET /server"]);
  });

  // Environment apps are named `<app>-<env>`: staging's `shop-staging` is not prod's `shop`.
  const SIBLINGS = [
    listed("shop-staging", { uuid: OTHER_ID, labels: { "opscrew-app": "shop-staging" } }),
    listed("shop-staging-worker", { uuid: OTHER_ID, labels: { "opscrew-app": "shop-staging" } }),
    // Even one that carries `shop`'s label: the names alone decide.
    listed("shop-staging", { uuid: OTHER_ID }),
  ];

  it("given the plan's names, keeps exactly those and never a sibling app's servers", async () => {
    const { api } = setup({
      "GET /server": serverList(
        listed("shop"),
        listed("shop-worker", { uuid: WORKER_ID, state: "stopped" }),
        ...SIBLINGS,
      ),
    });
    expect(await api.findAppServers("shop", ["shop", "shop-worker"])).toEqual([
      { id: SHOP_ID, name: "shop", status: "started" },
      { id: WORKER_ID, name: "shop-worker", status: "stopped" },
    ]);
    expect(await api.findAppServers("shop", ["shop-db"])).toEqual([]);
  });

  it("finds the sibling's own server by its name and label", async () => {
    const { api } = setup({
      "GET /server": serverList(listed("shop"), ...SIBLINGS.slice(0, 2)),
    });
    expect(await api.findAppServers("shop-staging", ["shop-staging"])).toEqual([
      { id: OTHER_ID, name: "shop-staging", status: "started" },
    ]);
  });

  it("matches the title alone, nameOnly, when UpCloud's list carries no labels", async () => {
    const { api } = setup({
      "GET /server": serverList(
        listed("shop", { labels: null }),
        listed("shop-staging", { uuid: OTHER_ID, labels: null }),
      ),
    });
    expect(await api.findAppServers("shop", ["shop"])).toEqual([
      { id: SHOP_ID, name: "shop", status: "started", nameOnly: true },
    ]);
  });

  it("stops at two of the app's servers with one title, naming both", async () => {
    const { api } = setup({
      "GET /server": serverList(
        listed("shop"),
        listed("shop", { uuid: OTHER_ID, zone: "fi-hel1", state: "stopped" }),
        listed("shop-worker", { uuid: WORKER_ID }),
      ),
    });
    for (const names of [undefined, ["shop", "shop-worker"]]) {
      const error = await failure(api.findAppServers("shop", names));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        `UpCloud has 2 servers titled shop (${SHOP_ID} in de-fra1 and ${OTHER_ID} in fi-hel1), so OpsCrew can't tell which one is the app's.`,
      );
      expect(error.hint).toBe(
        `Keep the app's server and delete or retitle the others in ${PANEL}, then run the command again.`,
      );
    }
  });

  it("counts as a duplicate only a server that is the app's", async () => {
    const { api } = setup({
      "GET /server": serverList(
        listed("shop"),
        listed("shop", { uuid: OTHER_ID, labels: { "opscrew-app": "other" } }),
        listed("shop-staging", { uuid: WORKER_ID, labels: { "opscrew-app": "shop-staging" } }),
        listed("shop-staging", { uuid: OTHER_ID, labels: { "opscrew-app": "shop-staging" } }),
      ),
    });
    expect(await api.findAppServers("shop", ["shop"])).toEqual([
      { id: SHOP_ID, name: "shop", status: "started" },
    ]);
  });
});

describe("snapshotServer", () => {
  it("backs up the server's first disk, titled for OpsCrew, waits for the disk and answers the backup's UUID", async () => {
    const { api, calls, time } = setup({
      [SERVER]: details("started"),
      [`POST /storage/${SHOP_DISK}/backup`]: backupCreated(TAKEN),
      [DISK]: [storageState("backuping", SHOP_DISK), storageState("online", SHOP_DISK)],
    });
    expect(await api.snapshotServer(SHOP_ID, request())).toEqual({ snapshotId: BACKUP_TAKEN });
    expect(requests(calls)).toEqual([SERVER, `POST /storage/${SHOP_DISK}/backup`, DISK, DISK]);
    expect(posted(calls)).toEqual([{ storage: { title: TAKEN } }]);
    expect(time.waits).toEqual([3_000]);
  });

  it("backs up the first of several disks, titled with the server's title", async () => {
    const { api, calls } = setup({
      [`GET /server/${WORKER_ID}`]: details("stopped", {
        uuid: WORKER_ID,
        title: "shop-worker",
        disks: [WORKER_DISK, SHOP_DISK],
      }),
      [`POST /storage/${WORKER_DISK}/backup`]: backupCreated("taken"),
      [`GET /storage/${WORKER_DISK}`]: storageState("online", WORKER_DISK),
    });
    await api.snapshotServer(WORKER_ID, request());
    expect(posted(calls)).toEqual([
      { storage: { title: "opscrew-shop-shop-worker-20261128T100000Z" } },
    ]);
  });

  it("refuses a request that names no app, or an id that isn't a server's UUID, before any call", async () => {
    const { api, calls } = setup({});
    const error = await failure(api.snapshotServer(SHOP_ID, request({})));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `OpsCrew titles an UpCloud backup after its app, and the snapshot of the server ${SHOP_ID} names none.`,
    );
    const id = await failure(api.snapshotServer("shop", request()));
    expect(id.code).toBe("INVALID_INPUT");
    expect(id.message).toBe('"shop" is not an UpCloud server\'s UUID.');
    expect(calls).toEqual([]);
  });

  it("says so, and backs up nothing, when the server has no disk", async () => {
    const { api, calls } = setup({ [SERVER]: details("started", { disks: [] }) });
    const error = await failure(api.snapshotServer(SHOP_ID, request()));
    expect(error.message).toBe(
      "The UpCloud server shop has no disk, so OpsCrew has nothing to back up.",
    );
    expect(error.hint).toBe(
      `Check the server in ${PANEL}: OpsCrew's servers start from their disk.`,
    );
    expect(requests(calls)).toEqual([SERVER]);
  });

  it("stops waiting after 15 minutes, or the request's limit, with a plain message", async () => {
    const routes = {
      [SERVER]: details("started"),
      [`POST /storage/${SHOP_DISK}/backup`]: backupCreated(TAKEN),
      [DISK]: storageState("backuping", SHOP_DISK),
    };
    const first = setup(routes);
    const error = await failure(first.api.snapshotServer(SHOP_ID, request()));
    expect(error.message).toBe(
      'UpCloud\'s request to back up the disk of the server shop did not finish within 15 minutes: the disk is still "backuping".',
    );
    expect(first.time.now() - Date.parse("2026-11-28T10:00:00Z")).toBe(15 * 60_000);

    const second = setup(routes);
    const limited = await failure(
      second.api.snapshotServer(SHOP_ID, { ...request(), timeoutMs: 60_000 }),
    );
    expect(limited.message).toContain("did not finish within 1 minute:");
  });
});

/** OpsCrew's backups of the server's disk, and others of the account that aren't. */
const BACKUPS_OF_ACCOUNT = backupList(
  backup(BACKUP_NEW, "opscrew-shop-shop-20261126T120000Z", {
    created: "2026-11-26T12:00:07Z",
    size: 50,
  }),
  backup(BACKUP_OLD, "opscrew-shop-shop-20261120T080000Z", {
    created: "2026-11-20T08:00:05Z",
    size: 50,
  }),
  // Another disk's, a backup taken by hand, Simple Backup's, and one titled almost as OpsCrew's.
  backup(BACKUP_FOREIGN, "opscrew-shop-shop-worker-20261121T000000Z", { origin: WORKER_DISK }),
  backup(BACKUP_BY_HAND, "On demand backup"),
  backup(BACKUP_SIMPLE, "Automatic backup 2026-11-27"),
  backup(BACKUP_ALIKE, "opscrew-shop-shop-20261121"),
);

describe("listSnapshots", () => {
  it("lists OpsCrew's backups of the server's disk, oldest first, with their time and size", async () => {
    const { api, calls } = setup({
      [SERVER]: details("started"),
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
    });
    expect(await api.listSnapshots(SHOP_ID)).toEqual([
      { id: BACKUP_OLD, createdAt: "2026-11-20T08:00:05Z", sizeGb: 50 },
      { id: BACKUP_NEW, createdAt: "2026-11-26T12:00:07Z", sizeGb: 50 },
    ]);
    expect(requests(calls)).toEqual([SERVER, BACKUPS]);
  });

  it("lists none for a server without a disk", async () => {
    const { api, calls } = setup({ [SERVER]: details("started", { disks: [] }) });
    expect(await api.listSnapshots(SHOP_ID)).toEqual([]);
    expect(requests(calls)).toEqual([SERVER]);
  });
});

describe("deleteSnapshot", () => {
  it("deletes one of OpsCrew's backups by its UUID", async () => {
    const { api, calls } = setup({
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
      [`DELETE /storage/${BACKUP_OLD}`]: NO_CONTENT,
    });
    await api.deleteSnapshot(BACKUP_OLD);
    expect(requests(calls)).toEqual([BACKUPS, `DELETE /storage/${BACKUP_OLD}`]);
  });

  it("deletes no storage that isn't a backup OpsCrew took", async () => {
    // A disk, a backup taken by hand, an id UpCloud doesn't list.
    for (const id of [
      SHOP_DISK,
      BACKUP_BY_HAND,
      BACKUP_ALIKE,
      "01a1b2c3-0000-4000-8000-0000000000ff",
    ]) {
      const { api, calls } = setup({ [BACKUPS]: BACKUPS_OF_ACCOUNT });
      const error = await failure(api.deleteSnapshot(id));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(
        `${id} is not a backup OpsCrew took at UpCloud, so OpsCrew deletes nothing.`,
      );
      expect(error.hint).toBe("`opscrew snapshot list` shows each snapshot's id.");
      expect(requests(calls)).toEqual([BACKUPS]);
    }
  });

  it("refuses an id that isn't a UUID before any call", async () => {
    const { api, calls } = setup({});
    for (const id of ["shop:17", "../server", ""]) {
      const error = await failure(api.deleteSnapshot(id));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(`"${id}" is not an UpCloud backup's UUID.`);
    }
    expect(calls).toEqual([]);
  });
});

describe("rebuild", () => {
  it("stops the server, restores its disk from the backup, waits, and starts it again", async () => {
    const { api, calls } = setup({
      [SERVER]: [
        details("started"),
        // The stop, awaited.
        details("started"),
        details("stopped"),
        // The start, awaited.
        details("maintenance"),
        details("started"),
      ],
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
      [STOP]: details("started"),
      [`POST /storage/${BACKUP_OLD}/restore`]: NO_CONTENT,
      [DISK]: [storageState("maintenance", SHOP_DISK), storageState("online", SHOP_DISK)],
      [START]: details("maintenance"),
    });
    await api.rebuild(SHOP_ID, BACKUP_OLD);
    expect(requests(calls)).toEqual([
      SERVER,
      BACKUPS,
      STOP,
      SERVER,
      SERVER,
      `POST /storage/${BACKUP_OLD}/restore`,
      DISK,
      DISK,
      START,
      SERVER,
      SERVER,
    ]);
    expect(posted(calls)).toEqual([
      { stop_server: { stop_type: "soft", timeout: "600" } },
      undefined,
      { server: { start_type: "async" } },
    ]);
  });

  it("says the server stays stopped when UpCloud refuses the restore after the stop", async () => {
    const { api, calls } = setup({
      [SERVER]: [details("started"), details("stopped")],
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
      [STOP]: details("maintenance"),
      [`POST /storage/${BACKUP_OLD}/restore`]: upcloudError(
        409,
        "STORAGE_STATE_ILLEGAL",
        "The storage is in a state in which it cannot be used.",
      ),
    });
    const error = await failure(api.rebuild(SHOP_ID, BACKUP_OLD));
    expect(error.message).toContain("was stopped for the restore and is still stopped");
    expect(error.hint).toContain("start the server there");
    expect(requests(calls)).not.toContain(START);
  });

  it("restores a stopped server without stopping it again", async () => {
    const { api, calls } = setup({
      [SERVER]: [details("stopped"), details("started")],
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
      [`POST /storage/${BACKUP_NEW}/restore`]: NO_CONTENT,
      [DISK]: storageState("online", SHOP_DISK),
      [START]: details("started"),
    });
    await api.rebuild(SHOP_ID, BACKUP_NEW);
    expect(requests(calls)).toEqual([
      SERVER,
      BACKUPS,
      `POST /storage/${BACKUP_NEW}/restore`,
      DISK,
      START,
      SERVER,
    ]);
  });

  it("refuses a backup that isn't OpsCrew's of this server's disk, before any change", async () => {
    for (const id of [BACKUP_FOREIGN, BACKUP_SIMPLE, SHOP_DISK]) {
      const { api, calls } = setup({
        [SERVER]: details("started"),
        [BACKUPS]: BACKUPS_OF_ACCOUNT,
      });
      const error = await failure(api.rebuild(SHOP_ID, id));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(
        `${id} is not a backup OpsCrew took of the UpCloud server shop: OpsCrew restores a server only from its own backups.`,
      );
      expect(error.hint).toBe("`opscrew snapshot list` shows each snapshot with its server.");
      expect(requests(calls)).toEqual([SERVER, BACKUPS]);
    }
  });

  it("refuses ids that aren't UUIDs before any call", async () => {
    const { api, calls } = setup({});
    expect((await failure(api.rebuild("shop", BACKUP_OLD))).code).toBe("INVALID_INPUT");
    expect((await failure(api.rebuild(SHOP_ID, "shop:17"))).code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  it("stops waiting for the restored disk after 15 minutes, with a plain message", async () => {
    const { api } = setup({
      [SERVER]: details("stopped"),
      [BACKUPS]: BACKUPS_OF_ACCOUNT,
      [`POST /storage/${BACKUP_OLD}/restore`]: NO_CONTENT,
      [DISK]: storageState("maintenance", SHOP_DISK),
    });
    const error = await failure(api.rebuild(SHOP_ID, BACKUP_OLD));
    expect(error.message).toBe(
      `UpCloud's request to restore the disk of the server shop from the backup ${BACKUP_OLD} did not finish within 15 minutes: the disk is still "maintenance". The UpCloud server shop was stopped for the restore and is still stopped.`,
    );
  });
});

describe("power", () => {
  it("stops the server softly, which UpCloud forces after 10 minutes, and waits until it is stopped", async () => {
    const { api, calls, time } = setup({
      [SERVER]: [details("started"), details("started"), details("stopped")],
      [STOP]: details("started"),
    });
    await api.powerOff(SHOP_ID);
    expect(requests(calls)).toEqual([SERVER, STOP, SERVER, SERVER]);
    expect(posted(calls)).toEqual([{ stop_server: { stop_type: "soft", timeout: "600" } }]);
    expect(time.waits).toEqual([3_000]);
  });

  it("leaves a stopped server, and stops waiting for a stop after 11 minutes", async () => {
    const stopped = setup({ [SERVER]: details("stopped") });
    await stopped.api.powerOff(SHOP_ID);
    expect(requests(stopped.calls)).toEqual([SERVER]);

    const slow = setup({ [SERVER]: details("started"), [STOP]: details("started") });
    const error = await failure(slow.api.powerOff(SHOP_ID));
    expect(error.message).toBe(
      'UpCloud\'s request to stop the server shop did not finish within 11 minutes: the server is still "started".',
    );
    expect(error.hint).toBe(
      `It may still finish: check the server in ${PANEL} before trying again.`,
    );
  });

  it("starts the server and waits until it is started, and leaves one that is started", async () => {
    const { api, calls } = setup({
      [SERVER]: [details("stopped"), details("maintenance"), details("started")],
      [START]: details("maintenance"),
    });
    await api.powerOn(SHOP_ID);
    expect(requests(calls)).toEqual([SERVER, START, SERVER, SERVER]);
    expect(posted(calls)).toEqual([{ server: { start_type: "async" } }]);

    const started = setup({ [SERVER]: details("started") });
    await started.api.powerOn(SHOP_ID);
    expect(requests(started.calls)).toEqual([SERVER]);
  });

  it("restarts the server softly, forced after 10 minutes, and waits until it is started", async () => {
    const { api, calls } = setup({
      [SERVER]: [details("started"), details("maintenance"), details("started")],
      [RESTART]: details("started"),
    });
    await api.restart?.(SHOP_ID);
    expect(requests(calls)).toEqual([SERVER, RESTART, SERVER, SERVER]);
    expect(posted(calls)).toEqual([
      { restart_server: { stop_type: "soft", timeout: "600", timeout_action: "destroy" } },
    ]);
  });

  it("shows UpCloud's refusal in plain English", async () => {
    const { api } = setup({
      [SERVER]: details("stopped"),
      [START]: upcloudError(402, "INSUFFICIENT_CREDITS", "Not enough credits."),
    });
    const error = await failure(api.powerOn(SHOP_ID));
    expect(error.message).toContain("your UpCloud account has too few credits");
    expect(error.hint).toContain("Add credits to your UpCloud account");
  });

  it("has no reinstall and no cancel", () => {
    const { api } = setup({});
    expect(api.reinstall).toBeUndefined();
    expect(api.cancelServer).toBeUndefined();
  });
});

describe("server API leaks", () => {
  it("puts the token in no error or request line, even when UpCloud repeats it, nor in a fixture", async () => {
    const echo = `bad ${TOKEN}`;
    const replies: FakeReply[] = [
      upcloudError(401, "AUTHENTICATION_FAILED", echo),
      upcloudError(403, "SERVER_FORBIDDEN", echo),
      upcloudError(409, "SERVER_STATE_ILLEGAL", echo),
      { status: 500, text: echo },
      { error: new Error(echo) },
      { body: { unexpected: echo } },
    ];
    const errors: OpsCrewError[] = [];
    const sent: FakeCall[] = [];
    for (const reply of replies) {
      const { api, calls } = setup({ "/": reply });
      errors.push(await failure(api.findAppServers("shop")));
      errors.push(await failure(api.snapshotServer(SHOP_ID, request())));
      errors.push(await failure(api.listSnapshots(SHOP_ID)));
      errors.push(await failure(api.deleteSnapshot(BACKUP_OLD)));
      errors.push(await failure(api.rebuild(SHOP_ID, BACKUP_OLD)));
      errors.push(await failure(api.powerOff(SHOP_ID)));
      errors.push(await failure(api.powerOn(SHOP_ID)));
      sent.push(...calls);
    }
    // A state UpCloud repeats the token in, while OpsCrew waits for it.
    const { api, calls } = setup({
      [SERVER]: [details("started"), details(echo)],
      [STOP]: NO_CONTENT,
    });
    errors.push(await failure(api.powerOff(SHOP_ID)));
    sent.push(...calls);

    for (const error of errors) expect(errorText(error)).not.toContain(TOKEN);
    // The token travels only in the Authorization header.
    expect(JSON.stringify(sent.map(({ url, body }) => ({ url, body })))).not.toContain(TOKEN);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      expect(await readFile(join(fixtures, name), "utf8")).not.toContain(TOKEN);
    }
  });
});
