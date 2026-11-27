import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerSnapshotApi, SnapshotRequest } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  accepted,
  fakeTime,
  ionosError,
  ionosFetch,
  requestStatus,
  TOKEN,
  TOKEN_ENV,
} from "./__fixtures__/client";
import {
  collection,
  DC_OTHER,
  DC_SHOP,
  DC_WORKER,
  datacenter,
  SHOP,
  SNAP_BUSY,
  SNAP_NEW,
  SNAP_OLD,
  SNAP_OTHER,
  SRV_OTHER,
  SRV_SHOP,
  SRV_WORKER,
  server,
  snapshot,
  TAKEN,
  VOL_SHOP,
} from "./__fixtures__/servers";
import { IonosClient, readIonosCredentials } from "./client";
import { ionosServerApi } from "./servers";

const DATACENTERS = "GET /datacenters?depth=1";
const SERVER = `GET /datacenters/${DC_SHOP}/servers/${SRV_SHOP}`;
const SNAPSHOTS = "GET /snapshots?depth=1";
const CREATE = `POST /datacenters/${DC_SHOP}/volumes/${VOL_SHOP}/create-snapshot`;
const RESTORE = `POST /datacenters/${DC_SHOP}/volumes/${VOL_SHOP}/restore-snapshot`;
const STOP = `POST /datacenters/${DC_SHOP}/servers/${SRV_SHOP}/stop`;
const START = `POST /datacenters/${DC_SHOP}/servers/${SRV_SHOP}/start`;
const REBOOT = `POST /datacenters/${DC_SHOP}/servers/${SRV_SHOP}/reboot`;

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = ionosFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the token is registered when it is read.
  readIonosCredentials(TOKEN_ENV, redactor);
  const client = new IonosClient({
    token: TOKEN,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
  });
  const api = ionosServerApi(client, { now: time.now });
  return { api, calls: fake.calls, time };
}

/** The requests sent, as `METHOD /path?query`. */
const requests = (calls: FakeCall[]) => calls.map((call) => `${call.method} ${call.path}`);

/** The requests sent that change something. */
const writes = (calls: FakeCall[]) => requests(calls).filter((line) => !line.startsWith("GET "));

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

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

const request = (
  labels: Record<string, string> = { app: "shop" },
  timeoutMs?: number,
): SnapshotRequest => ({
  name: "shop before destroy",
  description: "Taken by OpsCrew",
  labels,
  ...(timeoutMs !== undefined && { timeoutMs }),
});

describe("findAppServers", () => {
  it("without names, returns the servers of the data centres opscrew-<app> and opscrew-<app>-…, each id <datacenter id>/<server id>", async () => {
    const { api, calls } = setup({
      [DATACENTERS]: collection(
        datacenter(DC_SHOP, "opscrew-shop"),
        datacenter(DC_WORKER, "opscrew-shop-worker"),
        datacenter(DC_OTHER, "opscrew-shopfront"),
        datacenter(DC_OTHER, "shop"),
        datacenter(DC_OTHER, "opscrew-SHOP"),
        datacenter(DC_OTHER, "my-opscrew-shop"),
        datacenter(DC_OTHER, "opscrew-shop_2"),
      ),
      [`GET /datacenters/${DC_SHOP}/servers`]: collection(server(SRV_SHOP)),
      [`GET /datacenters/${DC_WORKER}/servers`]: collection(
        server(SRV_WORKER, { name: "shop-worker", vmState: "SHUTOFF" }),
      ),
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: SHOP, name: "shop", status: "running", nameOnly: true },
      {
        id: `${DC_WORKER}/${SRV_WORKER}`,
        name: "shop-worker",
        status: "shutoff",
        nameOnly: true,
      },
    ]);
    expect(requests(calls)).toEqual([
      DATACENTERS,
      `GET /datacenters/${DC_SHOP}/servers?depth=1`,
      `GET /datacenters/${DC_WORKER}/servers?depth=1`,
    ]);
  });

  // Environment apps are named `<app>-<env>`: staging's `shop-staging` is not prod's `shop`.
  it("given the names, keeps exactly their data centres and never a sibling app's opscrew-shop-staging", async () => {
    const { api, calls } = setup({
      [DATACENTERS]: collection(
        datacenter(DC_SHOP, "opscrew-shop"),
        datacenter(DC_OTHER, "opscrew-shop-staging"),
        datacenter(DC_OTHER, "opscrew-shop-staging-worker"),
      ),
      [`GET /datacenters/${DC_SHOP}/servers`]: collection(server(SRV_SHOP)),
      [`GET /datacenters/${DC_OTHER}/servers`]: collection(
        server(SRV_OTHER, { name: "shop-staging" }),
      ),
    });
    expect(await api.findAppServers("shop", ["shop", "shop-worker"])).toEqual([
      { id: SHOP, name: "shop", status: "running", nameOnly: true },
    ]);
    expect(requests(calls)).toEqual([DATACENTERS, `GET /datacenters/${DC_SHOP}/servers?depth=1`]);
    // The sibling's own lookup finds its server.
    expect(await api.findAppServers("shop-staging", ["shop-staging"])).toEqual([
      {
        id: `${DC_OTHER}/${SRV_OTHER}`,
        name: "shop-staging",
        status: "running",
        nameOnly: true,
      },
    ]);
  });

  it("reports every server of the data centre, and each data centre IONOS has twice", async () => {
    const { api } = setup({
      [DATACENTERS]: collection(
        datacenter(DC_SHOP, "opscrew-shop"),
        datacenter(DC_OTHER, "opscrew-shop"),
      ),
      [`GET /datacenters/${DC_SHOP}/servers`]: collection(
        server(SRV_SHOP),
        server(SRV_WORKER, { name: "by-hand" }),
      ),
      [`GET /datacenters/${DC_OTHER}/servers`]: collection(server(SRV_OTHER)),
    });
    const found = await api.findAppServers("shop", ["shop"]);
    expect(found.map((s) => [s.id, s.name])).toEqual([
      [SHOP, "shop"],
      [`${DC_SHOP}/${SRV_WORKER}`, "shop"],
      [`${DC_OTHER}/${SRV_OTHER}`, "shop"],
    ]);
  });

  it("finds nothing in a data centre without a server, and says IONOS's state while it makes one", async () => {
    const { api } = setup({
      [DATACENTERS]: collection(
        datacenter(DC_SHOP, "opscrew-shop"),
        datacenter(DC_WORKER, "opscrew-shop-worker"),
      ),
      [`GET /datacenters/${DC_SHOP}/servers`]: collection(
        server(SRV_SHOP, { vmState: undefined, state: "BUSY" }),
      ),
      [`GET /datacenters/${DC_WORKER}/servers`]: collection(),
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: SHOP, name: "shop", status: "busy", nameOnly: true },
    ]);
  });
});

describe("snapshotServer", () => {
  it("snapshots the boot volume as opscrew-<app>-<server id>-<time>, awaits the request and answers its id", async () => {
    const { api, calls, time } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [CREATE]: accepted(
        "req-1",
        snapshot(SNAP_NEW, TAKEN, "2026-11-27T10:00:01Z", { state: "BUSY" }),
      ),
      "GET /requests/req-1/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    expect(await api.snapshotServer(SHOP, request())).toEqual({ snapshotId: SNAP_NEW });
    expect(requests(calls)).toEqual([
      SERVER,
      CREATE,
      "GET /requests/req-1/status",
      "GET /requests/req-1/status",
    ]);
    expect(calls[1]?.body).toEqual({
      properties: { name: TAKEN, description: "Taken by OpsCrew" },
    });
    expect(time.waits).toEqual([3000]);
  });

  it("refuses a request without the app before calling IONOS", async () => {
    const { api, calls } = setup({});
    const error = await failure(api.snapshotServer(SHOP, request({})));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `OpsCrew names an IONOS snapshot after its app, and the snapshot of the server ${SHOP} names none.`,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a server without a boot volume, taking nothing", async () => {
    const { api, calls } = setup({ [SERVER]: { body: server(SRV_SHOP, { bootVolume: null }) } });
    const error = await failure(api.snapshotServer(SHOP, request()));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `The IONOS server ${SHOP} has no boot volume, so OpsCrew has no disk to snapshot.`,
    );
    expect(error.hint).toBe(
      "Check the server in IONOS's Data Center Designer: OpsCrew's servers boot from their volume.",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("stops at the request's own limit with the injected clock and sleep, saying it may still finish", async () => {
    const { api, time } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [CREATE]: accepted("req-1", snapshot(SNAP_NEW, TAKEN, "2026-11-27T10:00:01Z")),
      "GET /requests/req-1/status": requestStatus("RUNNING"),
    });
    const error = await failure(api.snapshotServer(SHOP, request({ app: "shop" }, 7_000)));
    expect(error.message).toBe(
      `IONOS's request to snapshot the server ${SHOP} did not finish within 7 seconds.`,
    );
    expect(error.hint).toBe(
      "It may still finish: check the data centre in IONOS's Data Center Designer before trying again.",
    );
    expect(time.waits).toEqual([3000, 3000, 1000]);
  });

  it("waits 15 minutes when the request sets no limit", async () => {
    const { api, time } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [CREATE]: accepted("req-1", snapshot(SNAP_NEW, TAKEN, "2026-11-27T10:00:01Z")),
      "GET /requests/req-1/status": requestStatus("QUEUED"),
    });
    const error = await failure(api.snapshotServer(SHOP, request()));
    expect(error.message).toContain("did not finish within 15 minutes.");
    expect(sum(time.waits)).toBe(15 * 60_000);
  });

  it("says IONOS's words when the snapshot's request failed", async () => {
    const { api } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [CREATE]: accepted("req-1", snapshot(SNAP_NEW, TAKEN, "2026-11-27T10:00:01Z")),
      "GET /requests/req-1/status": requestStatus("FAILED", "Storage quota exceeded"),
    });
    const error = await failure(api.snapshotServer(SHOP, request()));
    expect(error.message).toBe(
      `IONOS's request to snapshot the server ${SHOP} failed: Storage quota exceeded`,
    );
  });
});

describe("listSnapshots", () => {
  it("lists the server's snapshots from GET /snapshots by their names, oldest first", async () => {
    const { api, calls } = setup({
      [SNAPSHOTS]: collection(
        snapshot(SNAP_NEW, `opscrew-shop-${SRV_SHOP}-20261127T100000Z`, "2026-11-27T10:00:01Z", {
          size: 80,
        }),
        snapshot(SNAP_OLD, `opscrew-shop-${SRV_SHOP}-20261120T080000Z`, "2026-11-20T08:00:02Z", {
          size: 80,
        }),
        snapshot(SNAP_BUSY, `opscrew-shop-${SRV_SHOP}-20261127T110000Z`, "2026-11-27T11:00:01Z", {
          state: "BUSY",
        }),
        // Another server's, one made by hand, one without a name, and names that only look like it.
        snapshot(SNAP_OTHER, `opscrew-shop-${SRV_OTHER}-20261127T100000Z`, "2026-11-27T10:00:00Z"),
        snapshot(SNAP_OTHER, "before-upgrade", "2026-11-27T10:00:00Z"),
        snapshot(SNAP_OTHER, null, "2026-11-27T10:00:00Z"),
        snapshot(SNAP_OTHER, `opscrew-shop-${SRV_SHOP}-yesterday`, "2026-11-27T10:00:00Z"),
        snapshot(
          SNAP_OTHER,
          `my-opscrew-shop-${SRV_SHOP}-20261127T100000Z`,
          "2026-11-27T10:00:00Z",
        ),
        snapshot(SNAP_OTHER, `opscrew-${SRV_SHOP}-20261127T100000Z`, "2026-11-27T10:00:00Z"),
      ),
    });
    expect(await api.listSnapshots(SHOP)).toEqual([
      { id: SNAP_OLD, createdAt: "2026-11-20T08:00:02Z", sizeGb: 80 },
      { id: SNAP_NEW, createdAt: "2026-11-27T10:00:01Z", sizeGb: 80 },
      { id: SNAP_BUSY, createdAt: "2026-11-27T11:00:01Z" },
    ]);
    expect(requests(calls)).toEqual([SNAPSHOTS]);
  });
});

describe("deleteSnapshot", () => {
  it("deletes the snapshot and awaits its request", async () => {
    const { api, calls } = setup({
      [`DELETE /snapshots/${SNAP_OLD}`]: accepted("req-2"),
      "GET /requests/req-2/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    await api.deleteSnapshot(SNAP_OLD);
    expect(requests(calls)).toEqual([
      `DELETE /snapshots/${SNAP_OLD}`,
      "GET /requests/req-2/status",
      "GET /requests/req-2/status",
    ]);
  });

  it("says when the delete didn't finish in 15 minutes", async () => {
    const { api, time } = setup({
      [`DELETE /snapshots/${SNAP_OLD}`]: accepted("req-2"),
      "GET /requests/req-2/status": requestStatus("RUNNING"),
    });
    const error = await failure(api.deleteSnapshot(SNAP_OLD));
    expect(error.message).toBe(
      `IONOS's request to delete the snapshot ${SNAP_OLD} did not finish within 15 minutes.`,
    );
    expect(sum(time.waits)).toBe(15 * 60_000);
  });
});

describe("rebuild", () => {
  const ours = collection(
    snapshot(SNAP_OLD, `opscrew-shop-${SRV_SHOP}-20261120T080000Z`, "2026-11-20T08:00:02Z"),
    snapshot(SNAP_OTHER, `opscrew-shop-${SRV_OTHER}-20261120T080000Z`, "2026-11-20T08:00:02Z"),
  );

  it("restores the boot volume from the server's own snapshot and awaits the request", async () => {
    const { api, calls } = setup({
      [SNAPSHOTS]: ours,
      [SERVER]: { body: server(SRV_SHOP) },
      [RESTORE]: accepted("req-3"),
      "GET /requests/req-3/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    await api.rebuild(SHOP, SNAP_OLD);
    expect(requests(calls)).toEqual([
      SNAPSHOTS,
      SERVER,
      RESTORE,
      "GET /requests/req-3/status",
      "GET /requests/req-3/status",
    ]);
    expect(calls[2]?.body).toEqual({ properties: { snapshotId: SNAP_OLD } });
  });

  it("refuses a snapshot OpsCrew didn't take of the server, changing nothing", async () => {
    const { api, calls } = setup({ [SNAPSHOTS]: ours, [SERVER]: { body: server(SRV_SHOP) } });
    const error = await failure(api.rebuild(SHOP, SNAP_OTHER));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `The snapshot ${SNAP_OTHER} is not one OpsCrew took of the IONOS server ${SHOP}: OpsCrew restores a server only from its own snapshots.`,
    );
    expect(error.hint).toBe("`opscrew snapshot list` shows each snapshot with its server.");
    expect(writes(calls)).toEqual([]);
  });

  it("says IONOS's words when the restore failed", async () => {
    const { api } = setup({
      [SNAPSHOTS]: ours,
      [SERVER]: { body: server(SRV_SHOP) },
      [RESTORE]: accepted("req-3"),
      "GET /requests/req-3/status": requestStatus("FAILED", "Volume is busy"),
    });
    const error = await failure(api.rebuild(SHOP, SNAP_OLD));
    expect(error.message).toBe(
      `IONOS's request to restore the server ${SHOP} from the snapshot ${SNAP_OLD} failed: Volume is busy`,
    );
  });
});

describe("power", () => {
  it("stops the server with IONOS's stop, never a shutdown of its system, and awaits it", async () => {
    const { api, calls, time } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [STOP]: accepted("req-4"),
      "GET /requests/req-4/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    await api.powerOff(SHOP);
    expect(requests(calls)).toEqual([
      SERVER,
      STOP,
      "GET /requests/req-4/status",
      "GET /requests/req-4/status",
    ]);
    expect(writes(calls)).toEqual([STOP]);
    expect(calls[1]?.body).toBeUndefined();
    expect(time.waits).toEqual([3000]);
  });

  it("sends no stop to a server already off", async () => {
    const { api, calls } = setup({ [SERVER]: { body: server(SRV_SHOP, { vmState: "SHUTOFF" }) } });
    await api.powerOff(SHOP);
    expect(requests(calls)).toEqual([SERVER]);
  });

  it("waits 5 minutes for a stop, then says it may still finish", async () => {
    const { api, time } = setup({
      [SERVER]: { body: server(SRV_SHOP) },
      [STOP]: accepted("req-4"),
      "GET /requests/req-4/status": requestStatus("RUNNING"),
    });
    const error = await failure(api.powerOff(SHOP));
    expect(error.message).toBe(
      `IONOS's request to stop the server ${SHOP} did not finish within 5 minutes.`,
    );
    expect(sum(time.waits)).toBe(5 * 60_000);
  });

  it("starts a stopped server and awaits it; one running is left alone", async () => {
    const { api, calls } = setup({
      [SERVER]: [
        { body: server(SRV_SHOP, { vmState: "SHUTOFF" }) },
        { body: server(SRV_SHOP, { vmState: "RUNNING" }) },
      ],
      [START]: accepted("req-5"),
      "GET /requests/req-5/status": requestStatus("DONE"),
    });
    await api.powerOn(SHOP);
    await api.powerOn(SHOP);
    expect(requests(calls)).toEqual([SERVER, START, "GET /requests/req-5/status", SERVER]);
    expect(calls[1]?.body).toBeUndefined();
  });

  it("waits 15 minutes for a start", async () => {
    const { api, time } = setup({
      [SERVER]: { body: server(SRV_SHOP, { vmState: "SHUTOFF" }) },
      [START]: accepted("req-5"),
      "GET /requests/req-5/status": requestStatus("RUNNING"),
    });
    const error = await failure(api.powerOn(SHOP));
    expect(error.message).toBe(
      `IONOS's request to start the server ${SHOP} did not finish within 15 minutes.`,
    );
    expect(sum(time.waits)).toBe(15 * 60_000);
  });

  it("reboots the server through IONOS and awaits it", async () => {
    const { api, calls } = setup({
      [REBOOT]: accepted("req-6"),
      "GET /requests/req-6/status": [requestStatus("QUEUED"), requestStatus("DONE")],
    });
    await api.restart?.(SHOP);
    expect(requests(calls)).toEqual([
      REBOOT,
      "GET /requests/req-6/status",
      "GET /requests/req-6/status",
    ]);
    expect(calls[0]?.body).toBeUndefined();
  });

  it("offers no install again and no cancel", () => {
    const { api } = setup({});
    expect(api.reinstall).toBeUndefined();
    expect(api.cancelServer).toBeUndefined();
  });
});

describe("ids", () => {
  const BAD_SERVERS = [
    "shop",
    SRV_SHOP,
    `${DC_SHOP}/`,
    `${DC_SHOP}/${SRV_SHOP}/stop`,
    `../${SRV_SHOP}`,
    `${DC_SHOP}/x?depth=9`,
    "",
  ];

  const METHODS: [string, (api: ServerSnapshotApi, id: string) => Promise<unknown>][] = [
    ["snapshotServer", (api, id) => api.snapshotServer(id, request())],
    ["listSnapshots", (api, id) => api.listSnapshots(id)],
    ["rebuild", (api, id) => api.rebuild(id, SNAP_OLD)],
    ["powerOff", (api, id) => api.powerOff(id)],
    ["powerOn", (api, id) => api.powerOn(id)],
    ["restart", (api, id) => api.restart?.(id) ?? Promise.resolve()],
  ];

  it.each(METHODS)(
    "%s refuses a server id that isn't <datacenter id>/<server id> before calling IONOS",
    async (_, call) => {
      for (const id of BAD_SERVERS) {
        const { api, calls: sent } = setup({});
        const error = await failure(call(api, id));
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).toBe(
          `"${id}" is not an IONOS server id: OpsCrew writes them as <datacenter id>/<server id>.`,
        );
        expect(sent).toEqual([]);
      }
    },
  );

  it("refuses a snapshot id that isn't IONOS's before calling it", async () => {
    for (const id of ["snap", `${SNAP_OLD}/x`, `../${SNAP_OLD}`, ""]) {
      const { api, calls: sent } = setup({});
      for (const call of [() => api.deleteSnapshot(id), () => api.rebuild(SHOP, id)]) {
        const error = await failure(call());
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).toBe(`"${id}" is not an IONOS snapshot id.`);
        expect(error.hint).toBe("`opscrew snapshot list` shows each snapshot's id.");
      }
      expect(sent).toEqual([]);
    }
  });
});

describe("server API leaks", () => {
  it("puts the token in no error, request line or body, nor in a fixture", async () => {
    const echo = `bad ${TOKEN}`;
    const replies: FakeReply[] = [
      ...[400, 401, 403, 404, 422, 429, 500].map((status) => ionosError(status, echo)),
      { error: new Error(echo) },
      { body: { unexpected: echo } },
    ];
    const errors: unknown[] = [];
    const sent: FakeCall[] = [];
    const record = async (
      routes: Record<string, FakeReply | FakeReply[]>,
      run: (api: ServerSnapshotApi) => Promise<unknown>,
    ) => {
      const { api, calls } = setup(routes);
      const error = await run(api).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (error !== undefined) errors.push(error);
      sent.push(...calls);
    };
    const runs: ((api: ServerSnapshotApi) => Promise<unknown>)[] = [
      (api) => api.findAppServers("shop"),
      (api) => api.snapshotServer(SHOP, request()),
      (api) => api.listSnapshots(SHOP),
      (api) => api.deleteSnapshot(SNAP_OLD),
      (api) => api.rebuild(SHOP, SNAP_OLD),
      (api) => api.powerOff(SHOP),
      (api) => api.powerOn(SHOP),
      (api) => api.restart?.(SHOP) ?? Promise.resolve(),
    ];
    for (const reply of replies) {
      for (const run of runs) await record({ "/": reply }, run);
    }
    // A request IONOS accepted and then failed with the token in its message.
    const failed = requestStatus("FAILED", echo);
    await record(
      {
        [SERVER]: { body: server(SRV_SHOP) },
        [CREATE]: accepted("req-1", snapshot(SNAP_NEW, TAKEN, "2026-11-27T10:00:01Z")),
        "GET /requests/req-1/status": failed,
      },
      (api) => api.snapshotServer(SHOP, request()),
    );
    await record(
      { [STOP]: accepted("req-4"), [SERVER]: { body: server(SRV_SHOP) }, "/requests/": failed },
      (api) => api.powerOff(SHOP),
    );

    // Every call fails, but a delete and a reboot IONOS answered 200 without a request to await.
    expect(errors.length).toBeGreaterThanOrEqual(replies.length * runs.length - 2);
    for (const error of errors) {
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(errorText(error as OpsCrewError)).not.toContain(TOKEN);
    }
    // The token travels only in the Authorization header.
    expect(JSON.stringify(sent.map(({ url, body }) => ({ url, body })))).not.toContain(TOKEN);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      expect(await readFile(join(fixtures, name), "utf8")).not.toContain(TOKEN);
    }
  });
});
