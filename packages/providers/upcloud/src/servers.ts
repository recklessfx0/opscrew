import type {
  AppServer,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { type ErrorCode, listText, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { UPCLOUD_CONTROL_PANEL_URL, type UpcloudClient } from "./client";

/** How long a backup may take when the request sets no limit (the contract's default). */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
/** How long a disk's restore, a start or a restart may take. */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/**
 * How long UpCloud waits for the system to shut down on a soft stop before it stops the server
 * hard (8-servers, "Stop server": 1 to 600 seconds), and the same for a restart. UpCloud's API
 * has no soft stop without that hard end, so OpsCrew gives the system the longest wait it allows.
 */
const SOFT_STOP_SECONDS = 600;
/** How long a stop may take in all: the soft stop's 10 minutes, then UpCloud's hard stop. */
const STOP_TIMEOUT_MS = 11 * 60_000;
/** The label OpsCrew's servers carry, with the app's name (decision 27). */
const APP_LABEL = "opscrew-app";
/** How the titles of the backups OpsCrew takes start: `opscrew-<app>-<server>-<time>`. */
const SNAPSHOT_PREFIX = "opscrew-";
/** An OpsCrew backup's title: the prefix, the app and the server's title, and the time. */
const SNAPSHOT_TITLE = new RegExp(`^${SNAPSHOT_PREFIX}.+-\\d{8}T\\d{6}Z$`);
/** UpCloud's servers and storages have UUIDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PANEL = `UpCloud's control panel (${UPCLOUD_CONTROL_PANEL_URL})`;

// --- Answer schemas: the fields OpsCrew reads (developers.upcloud.com/1.3/8-servers/ and
// 9-storages/). States stay strings, so a new value is shown, not refused.

/** A server's labels: `{ label: [{ key, value }] }`. */
const labelsSchema = z.looseObject({
  label: z.array(z.looseObject({ key: z.string(), value: z.string() })),
});

/** `GET /server` ("List servers"): `{ servers: { server: [...] } }`, every server of the account. */
const serverListSchema = z.looseObject({
  servers: z.looseObject({
    server: z.array(
      z.looseObject({
        uuid: z.string(),
        title: z.string(),
        state: z.string(),
        zone: z.string(),
        labels: labelsSchema.optional(),
      }),
    ),
  }),
});
type ListedServer = z.infer<typeof serverListSchema>["servers"]["server"][number];

/** `GET /server/{uuid}` ("Get server details"): its title, state and storage devices. */
const serverSchema = z.looseObject({
  server: z.looseObject({
    uuid: z.string(),
    title: z.string(),
    state: z.string(),
    storage_devices: z.looseObject({
      storage_device: z.array(z.looseObject({ storage: z.string(), type: z.string() })),
    }),
  }),
});
type Server = z.infer<typeof serverSchema>["server"];

/**
 * `GET /storage/backup` ("List storages", by type): every backup of the account, each with the
 * storage it was taken of (`origin`), when, and its size in GB.
 */
const backupListSchema = z.looseObject({
  storages: z.looseObject({
    storage: z.array(
      z.looseObject({
        uuid: z.string(),
        title: z.string(),
        origin: z.string(),
        created: z.string(),
        size: z.number(),
      }),
    ),
  }),
});
type Backup = z.infer<typeof backupListSchema>["storages"]["storage"][number];

/** `POST /storage/{uuid}/backup` ("Create backup"): 201 with the new backup. */
const backupCreatedSchema = z.looseObject({ storage: z.looseObject({ uuid: z.string() }) });

export interface UpcloudServerApiOptions {
  /** Epoch milliseconds, for the time a backup's title ends with. */
  now: () => number;
}

/**
 * Server lookup by title and label, and snapshots and power actions for the provider-neutral
 * teardown and snapshot commands. A server's id is its UUID. A snapshot is an on-demand backup of
 * the server's first disk (decision 28), which outlives the server. UpCloud answers a change at
 * once and carries it out after, so each is awaited through the server's or the disk's state with
 * the client's injected clock and sleep. A server is never installed again from its image, and
 * its delete is Terraform's.
 */
export function upcloudServerApi(
  client: UpcloudClient,
  options: UpcloudServerApiOptions,
): ServerSnapshotApi {
  const { now } = options;

  const fail = (message: string, hint: string, code: ErrorCode = "PROVIDER_ERROR") =>
    new OpsCrewError(code, message, { hint });

  const getServer = async (uuid: string): Promise<Server> =>
    (await client.get(`/server/${uuid}`, serverSchema)).server;

  /** The UUID of the server's first disk (not a CD-ROM), if it has one. */
  const diskOf = (server: Server): string | undefined =>
    server.storage_devices.storage_device.find((device) => device.type === "disk")?.storage;

  /** The server's first disk, to `verb`; refused when it has none. */
  const firstDisk = (server: Server, verb: "back up" | "restore"): string => {
    const disk = diskOf(server);
    if (disk === undefined) {
      throw fail(
        `The UpCloud server ${server.title} has no disk, so OpsCrew has nothing to ${verb}.`,
        `Check the server in ${PANEL}: OpsCrew's servers start from their disk.`,
      );
    }
    return disk;
  };

  /** Every backup of the account whose title is OpsCrew's. */
  const opscrewBackups = async (): Promise<Backup[]> => {
    const { storages } = await client.get("/storage/backup", backupListSchema);
    return storages.storage.filter((backup) => SNAPSHOT_TITLE.test(backup.title));
  };

  /**
   * Stops the server softly: UpCloud stops it hard once the system hasn't shut down after 10
   * minutes. Waits until it is stopped.
   */
  const stop = async (server: Server): Promise<void> => {
    await client.post(`/server/${server.uuid}/stop`, z.unknown(), {
      stop_server: { stop_type: "soft", timeout: String(SOFT_STOP_SECONDS) },
    });
    await client.awaitServer(server.uuid, "stopped", {
      what: `stop the server ${server.title}`,
      timeoutMs: STOP_TIMEOUT_MS,
    });
  };

  /** Starts the server without waiting in the request, then waits until it is started. */
  const start = async (server: Server): Promise<void> => {
    await client.post(`/server/${server.uuid}/start`, z.unknown(), {
      server: { start_type: "async" },
    });
    await client.awaitServer(server.uuid, "started", {
      what: `start the server ${server.title}`,
      timeoutMs: ACTION_TIMEOUT_MS,
    });
  };

  return {
    /**
     * The account's servers titled one of `names`, or without them `<app>` or `<app>-<name>`, that
     * carry the label `opscrew-app` = `app`; one listed without labels is matched by its title
     * alone and marked `nameOnly`. Only `names` tell the app's servers from another app's or
     * environment's titled `<app>-<something>` (`shop-staging`). UpCloud lists every server
     * without `limit` (8-servers, "List servers").
     * @throws OpsCrewError `PHASE_PRECONDITION` when two of them have one title, naming each.
     */
    async findAppServers(app: string, names?: readonly string[]): Promise<AppServer[]> {
      const titled = (title: string) =>
        names === undefined ? title === app || title.startsWith(`${app}-`) : names.includes(title);
      const labelled = ({ labels }: ListedServer) =>
        labels?.label.some(({ key, value }) => key === APP_LABEL && value === app);
      const { servers } = await client.get("/server", serverListSchema);
      const ours = servers.server.filter(
        (server) => titled(server.title) && labelled(server) !== false,
      );
      const duplicates = [...new Set(ours.map(({ title }) => title))]
        .map((title) => ours.filter((server) => server.title === title))
        .filter((same) => same.length > 1);
      if (duplicates.length > 0) {
        const named = listText(
          duplicates.map(
            (same) =>
              `${same.length} servers titled ${same[0]?.title} (${listText(same.map((s) => `${s.uuid} in ${s.zone}`))})`,
          ),
        );
        throw fail(
          `UpCloud has ${named}, so OpsCrew can't tell which one is the app's.`,
          `Keep the app's server and delete or retitle the others in ${PANEL}, then run the command again.`,
          "PHASE_PRECONDITION",
        );
      }
      return ours.map((server) => ({
        id: server.uuid,
        name: server.title,
        status: server.state,
        ...(server.labels === undefined && { nameOnly: true }),
      }));
    },

    /**
     * Backs up the server's first disk as `opscrew-<app>-<server title>-<time>` (the app from
     * `request.labels.app`, the time from the injected clock), waits until the disk is online
     * again, and answers the backup's UUID. UpCloud's backups take a title only, so the request's
     * description and labels are not kept.
     */
    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const uuid = serverUuid(serverId);
      const app = request.labels.app;
      if (app === undefined) {
        throw fail(
          `OpsCrew titles an UpCloud backup after its app, and the snapshot of the server ${serverId} names none.`,
          "Please report this to OpsCrew.",
          "INVALID_INPUT",
        );
      }
      const server = await getServer(uuid);
      const disk = firstDisk(server, "back up");
      const title = `${SNAPSHOT_PREFIX}${app}-${server.title}-${timeStamp(now())}`;
      const { storage } = await client.post(`/storage/${disk}/backup`, backupCreatedSchema, {
        storage: { title },
      });
      // The disk is `backuping` until the backup is complete (9-storages, "Create backup").
      await client.awaitStorage(disk, {
        what: `back up the disk of the server ${server.title}`,
        timeoutMs: request.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      });
      return { snapshotId: storage.uuid };
    },

    /**
     * The backups of the server's first disk titled as OpsCrew's, oldest first by the time
     * UpCloud made them, each with its size in GB; none for a server without a disk.
     */
    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      const disk = diskOf(await getServer(serverUuid(serverId)));
      if (disk === undefined) return [];
      return (await opscrewBackups())
        .filter((backup) => backup.origin === disk)
        .map(({ uuid, created, size }) => ({ id: uuid, createdAt: created, sizeGb: size }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    /**
     * Deletes one of OpsCrew's backups (`DELETE /storage/{uuid}`, UpCloud's delete of a storage,
     * which answers once it is gone). Anything else, a disk above all, is refused before the
     * delete.
     */
    async deleteSnapshot(snapshotId: string): Promise<void> {
      const uuid = backupUuid(snapshotId);
      if (!(await opscrewBackups()).some((backup) => backup.uuid === uuid)) {
        throw fail(
          `${uuid} is not a backup OpsCrew took at UpCloud, so OpsCrew deletes nothing.`,
          "`opscrew snapshot list` shows each snapshot's id.",
          "INVALID_INPUT",
        );
      }
      await client.delete(`/storage/${uuid}`, z.undefined());
    },

    /**
     * Restores the server's first disk from one of OpsCrew's backups of it: stops the server (a
     * restore needs it stopped), restores the disk, waits until it is online, and starts the
     * server again. The server keeps its UUID, disk and addresses.
     * @throws OpsCrewError `INVALID_INPUT` for a backup OpsCrew didn't take of this server's disk,
     * before anything is changed.
     */
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const uuid = serverUuid(serverId);
      const backup = backupUuid(snapshotId);
      const server = await getServer(uuid);
      const disk = firstDisk(server, "restore");
      const ours = (await opscrewBackups()).some(
        (taken) => taken.uuid === backup && taken.origin === disk,
      );
      if (!ours) {
        throw fail(
          `${backup} is not a backup OpsCrew took of the UpCloud server ${server.title}: OpsCrew restores a server only from its own backups.`,
          "`opscrew snapshot list` shows each snapshot with its server.",
          "INVALID_INPUT",
        );
      }
      if (server.state !== "stopped") await stop(server);
      try {
        await client.post(`/storage/${backup}/restore`, z.undefined());
        await client.awaitStorage(disk, {
          what: `restore the disk of the server ${server.title} from the backup ${backup}`,
          timeoutMs: ACTION_TIMEOUT_MS,
        });
      } catch (error) {
        // The stop went through, so the server stays stopped: the user must know.
        throw fail(
          `${error instanceof Error ? error.message : String(error)} The UpCloud server ${server.title} was stopped for the restore and is still stopped.`,
          `Check the disk in ${PANEL}, then start the server there (or run the restore again).`,
        );
      }
      await start(server);
    },

    /**
     * Stops the server softly and waits until it is stopped, 11 minutes at most. UpCloud has no
     * soft stop without a hard end: it stops the server hard when the system hasn't shut down
     * after 10 minutes, the longest wait it allows (the contract's "never forces" can't hold).
     */
    async powerOff(serverId: string): Promise<void> {
      const server = await getServer(serverUuid(serverId));
      // Already stopped (a destroy run again after a stop): nothing to send.
      if (server.state === "stopped") return;
      await stop(server);
    },

    /** Starts the server and waits until it is started. */
    async powerOn(serverId: string): Promise<void> {
      const server = await getServer(serverUuid(serverId));
      if (server.state === "started") return;
      await start(server);
    },

    /**
     * Restarts the server softly, stopped hard and started when its system hasn't shut down
     * after 10 minutes (UpCloud's `timeout_action` `destroy`), and waits until it is started.
     */
    async restart(serverId: string): Promise<void> {
      const server = await getServer(serverUuid(serverId));
      await client.post(`/server/${server.uuid}/restart`, z.unknown(), {
        restart_server: {
          stop_type: "soft",
          timeout: String(SOFT_STOP_SECONDS),
          timeout_action: "destroy",
        },
      });
      await client.awaitServer(server.uuid, "started", {
        what: `restart the server ${server.title}`,
        timeoutMs: ACTION_TIMEOUT_MS,
      });
    },
  };
}

/** `20261128T100000Z`: the time a backup's title ends with. */
function timeStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** `value` as a server's UUID; anything else is refused before calling the API. */
function serverUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not an UpCloud server's UUID.`, {
      hint: "Please report this to OpsCrew.",
    });
  }
  return value;
}

/** `value` as a backup's UUID; anything else is refused before calling the API. */
function backupUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not an UpCloud backup's UUID.`, {
      hint: "`opscrew snapshot list` shows each snapshot's id.",
    });
  }
  return value;
}
