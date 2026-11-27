import type {
  AppServer,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { type ErrorCode, escapeRegExp, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { IonosClient, IonosPath } from "./client";

/** How long a snapshot may take when the request sets no limit (the contract's default). */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
/** How long a snapshot's deletion, a restore, a start or a reboot may take. */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How long a stop may take before OpsCrew stops waiting. */
const SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
/** How the names of the data centres OpsCrew makes start: `opscrew-<server name>` (decision 13). */
const DATACENTER_PREFIX = "opscrew-";
/** How the names of the snapshots OpsCrew takes start: `opscrew-<app>-<server id>-<time>`. */
const SNAPSHOT_PREFIX = "opscrew-";
/** The time a snapshot's name ends with: `20261127T100000Z`. */
const TAKEN_AT = "\\d{8}T\\d{6}Z";
/** IONOS's ids of data centres, servers, volumes and snapshots are UUIDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DCD = "IONOS's Data Center Designer";

// --- Answer schemas: the fields OpsCrew reads of the Cloud API v6 (docs.ionos.com, Cloud API v6).
// States stay strings, so a new value is shown, not refused.

/** A collection (`Datacenters`, `Servers`, `Snapshots`): its `items`. */
const collectionOf = <T extends z.ZodType>(item: T) => z.looseObject({ items: z.array(item) });

/** `Datacenter` at depth 1: its id and name. */
const datacenterSchema = z.looseObject({
  id: z.string(),
  properties: z.looseObject({ name: z.string() }),
});

/**
 * `Server` at depth 1: its `vmState` (`RUNNING`, `SHUTOFF`, …), absent while IONOS makes it, its
 * resource state in `metadata.state` (`AVAILABLE`, `BUSY`, …), and its boot volume's reference.
 */
const serverSchema = z.looseObject({
  id: z.string(),
  metadata: z.looseObject({ state: z.string() }),
  properties: z.looseObject({
    vmState: z.string().nullish(),
    bootVolume: z.looseObject({ id: z.string() }).nullish(),
  }),
});
type Server = z.infer<typeof serverSchema>;

/**
 * `Snapshot` at depth 1: when IONOS made it and its state, its name (absent on one made without
 * one) and its size in GB. `GET /snapshots` lists every snapshot of the contract, OpsCrew's or not.
 */
const snapshotSchema = z.looseObject({
  id: z.string(),
  metadata: z.looseObject({ createdDate: z.string(), state: z.string() }),
  properties: z.looseObject({ name: z.string().nullish(), size: z.number().nullish() }),
});

/** A server OpsCrew reaches: its data centre's id and its own. */
interface ServerRef {
  datacenter: string;
  server: string;
}

export interface IonosServerApiOptions {
  /** Epoch milliseconds, for the time a snapshot's name ends with. */
  now: () => number;
}

/**
 * Server lookup by data centre (each server lives in a data centre of its own named
 * `opscrew-<server name>`, decision 13), and snapshots and power actions for the provider-neutral
 * teardown and snapshot commands. A server's id is `<datacenter id>/<server id>`. A snapshot is of
 * the server's boot volume. Every change is a request IONOS accepts with 202, which the client
 * awaits with the injected clock and sleep. A server is never installed again from its image, and
 * the data centre's delete is Terraform's.
 */
export function ionosServerApi(
  client: IonosClient,
  options: IonosServerApiOptions,
): ServerSnapshotApi {
  const { now } = options;

  const fail = (message: string, hint: string, code: ErrorCode = "PROVIDER_ERROR") =>
    new OpsCrewError(code, message, { hint });

  const serverPath = ({ datacenter, server }: ServerRef): IonosPath =>
    `/datacenters/${datacenter}/servers/${server}`;

  const getServer = (ref: ServerRef) => client.get(serverPath(ref), serverSchema);

  /** The server's boot volume, to `verb`; refused when it has none. */
  const bootVolume = async (
    ref: ServerRef,
    serverId: string,
    verb: "snapshot" | "restore",
  ): Promise<string> => {
    const volume = (await getServer(ref)).properties.bootVolume?.id;
    if (volume === undefined) {
      throw fail(
        `The IONOS server ${serverId} has no boot volume, so OpsCrew has no disk to ${verb}.`,
        `Check the server in ${DCD}: OpsCrew's servers boot from their volume.`,
      );
    }
    return volume;
  };

  /** Sends `action` for the server and awaits its request; IONOS answers it with no body. */
  const powerAction = (
    ref: ServerRef,
    action: "start" | "stop" | "reboot",
    what: string,
    timeoutMs: number,
  ) => client.post(`${serverPath(ref)}/${action}`, z.unknown(), { what, timeoutMs });

  /** The server's snapshots named `opscrew-<app>-<its id>-<time>`, oldest first. */
  const snapshotsOf = async ({ server }: ServerRef): Promise<ServerSnapshot[]> => {
    const ours = new RegExp(`^${SNAPSHOT_PREFIX}.+-${escapeRegExp(server)}-${TAKEN_AT}$`);
    const { items } = await client.get("/snapshots", collectionOf(snapshotSchema), {
      depth: "1",
    });
    return items
      .filter(({ properties: { name } }) => typeof name === "string" && ours.test(name))
      .map(({ id, metadata, properties: { size } }) => ({
        id,
        createdAt: metadata.createdDate,
        // IONOS knows a snapshot's size once it is made.
        ...(metadata.state === "AVAILABLE" && typeof size === "number" ? { sizeGb: size } : {}),
      }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  };

  return {
    /**
     * The servers of the data centres named `opscrew-<name>` for each of `names`, or without them
     * `opscrew-<app>` and `opscrew-<app>-<name>`, each named after its data centre and `nameOnly`
     * (no label is read). Only `names` tell the app's data centres from another app's or
     * environment's named `opscrew-<app>-<something>` (`opscrew-shop-staging`). IONOS's names are
     * not unique, so a data centre it has twice yields a server of that name twice.
     */
    async findAppServers(app: string, names?: readonly string[]): Promise<AppServer[]> {
      const ours = (name: string) =>
        names === undefined
          ? name === `${DATACENTER_PREFIX}${app}` || name.startsWith(`${DATACENTER_PREFIX}${app}-`)
          : names.some((wanted) => name === `${DATACENTER_PREFIX}${wanted}`);
      const { items } = await client.get("/datacenters", collectionOf(datacenterSchema), {
        depth: "1",
      });
      const found: AppServer[] = [];
      for (const { id, properties } of items.filter((dc) => ours(dc.properties.name))) {
        const servers = await client.get(`/datacenters/${id}/servers`, collectionOf(serverSchema), {
          depth: "1",
        });
        for (const server of servers.items) {
          found.push({
            id: `${id}/${server.id}`,
            name: properties.name.slice(DATACENTER_PREFIX.length),
            status: statusOf(server),
            nameOnly: true,
          });
        }
      }
      return found;
    },

    /**
     * Snapshots the server's boot volume as `opscrew-<app>-<server id>-<time>` (the app from
     * `request.labels.app`, the time from the injected clock, the server's id because
     * `GET /snapshots` lists the whole contract's), with the request's description, and awaits
     * IONOS's request.
     */
    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const ref = serverRef(serverId);
      const app = request.labels.app;
      if (app === undefined) {
        throw fail(
          `OpsCrew names an IONOS snapshot after its app, and the snapshot of the server ${serverId} names none.`,
          "Please report this to OpsCrew.",
          "INVALID_INPUT",
        );
      }
      const volume = await bootVolume(ref, serverId, "snapshot");
      const name = `${SNAPSHOT_PREFIX}${app}-${ref.server}-${timeStamp(now())}`;
      const created = await client.post(
        `/datacenters/${ref.datacenter}/volumes/${volume}/create-snapshot`,
        z.looseObject({ id: z.string() }),
        {
          what: `snapshot the server ${serverId}`,
          timeoutMs: request.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
        },
        { properties: { name, description: request.description } },
      );
      return { snapshotId: created.id };
    },

    /**
     * The server's snapshots from `GET /snapshots`, named `opscrew-<app>-<its id>-<time>`, oldest
     * first by the time IONOS made them, each with its size once IONOS has made it.
     */
    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      return snapshotsOf(serverRef(serverId));
    },

    /** Deletes the snapshot and awaits IONOS's request. */
    async deleteSnapshot(snapshotId: string): Promise<void> {
      const id = snapshotRef(snapshotId);
      await client.delete(`/snapshots/${id}`, z.unknown(), {
        what: `delete the snapshot ${id}`,
        timeoutMs: ACTION_TIMEOUT_MS,
      });
    },

    /**
     * Restores the server's boot volume from one of its own snapshots (the volume's
     * `restore-snapshot`) and awaits IONOS's request: the server and its volume stay, the disk as
     * the snapshot had it. Unverified, since IONOS's documentation doesn't say: whether IONOS
     * needs the server stopped first, and whether it runs after.
     * @throws OpsCrewError `INVALID_INPUT` for a snapshot OpsCrew didn't take of this server,
     * before anything is changed.
     */
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const ref = serverRef(serverId);
      const id = snapshotRef(snapshotId);
      if (!(await snapshotsOf(ref)).some((snapshot) => snapshot.id === id)) {
        throw fail(
          `The snapshot ${id} is not one OpsCrew took of the IONOS server ${serverId}: OpsCrew restores a server only from its own snapshots.`,
          "`opscrew snapshot list` shows each snapshot with its server.",
          "INVALID_INPUT",
        );
      }
      const volume = await bootVolume(ref, serverId, "restore");
      await client.post(
        `/datacenters/${ref.datacenter}/volumes/${volume}/restore-snapshot`,
        z.unknown(),
        {
          what: `restore the server ${serverId} from the snapshot ${id}`,
          timeoutMs: ACTION_TIMEOUT_MS,
        },
        { properties: { snapshotId: id } },
      );
    },

    /**
     * Stops the server with IONOS's stop, which frees its cores and memory (a shutdown from its
     * own system frees nothing), and awaits the request, 5 minutes at most. IONOS's documentation
     * doesn't say whether its stop shuts the system down gracefully, and says it returns a public
     * IPv4 address that isn't reserved to IONOS's pool: a start gives the server a new one.
     */
    async powerOff(serverId: string): Promise<void> {
      const ref = serverRef(serverId);
      // Already off (a destroy run again after a stop): nothing to send.
      if ((await getServer(ref)).properties.vmState === "SHUTOFF") return;
      await powerAction(ref, "stop", `stop the server ${serverId}`, SHUTDOWN_TIMEOUT_MS);
    },

    /** Starts the server and awaits the request. */
    async powerOn(serverId: string): Promise<void> {
      const ref = serverRef(serverId);
      if ((await getServer(ref)).properties.vmState === "RUNNING") return;
      await powerAction(ref, "start", `start the server ${serverId}`, ACTION_TIMEOUT_MS);
    },

    /** Reboots the server through IONOS (a hard reboot) and awaits the request. */
    async restart(serverId: string): Promise<void> {
      const ref = serverRef(serverId);
      await powerAction(ref, "reboot", `restart the server ${serverId}`, ACTION_TIMEOUT_MS);
    },
  };
}

/** The server's `vmState` once IONOS has it, else its resource state (`busy`), lower case. */
function statusOf(server: Server): string {
  return (server.properties.vmState ?? server.metadata.state).toLowerCase();
}

/** `20261127T100000Z`: the time a snapshot's name ends with. */
function timeStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * A server id OpsCrew gave out, `<datacenter id>/<server id>`, as its two parts; anything else is
 * refused before calling the API.
 */
function serverRef(value: string): ServerRef {
  const [datacenter, server, ...rest] = value.split("/");
  if (
    datacenter === undefined ||
    server === undefined ||
    rest.length > 0 ||
    !UUID.test(datacenter) ||
    !UUID.test(server)
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${value}" is not an IONOS server id: OpsCrew writes them as <datacenter id>/<server id>.`,
      { hint: "Please report this to OpsCrew." },
    );
  }
  return { datacenter, server };
}

/** `value` as an IONOS snapshot id; anything else is refused before calling the API. */
function snapshotRef(value: string): string {
  if (!UUID.test(value)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not an IONOS snapshot id.`, {
      hint: "`opscrew snapshot list` shows each snapshot's id.",
    });
  }
  return value;
}
