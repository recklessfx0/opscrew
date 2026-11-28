import type { FakeReply } from "@opscrew/core/testing";

/** Synthetic server UUIDs, shaped as UpCloud's (8-4-4-4-12 hexadecimal digits). */
export const SHOP_ID = "00a1b2c3-0000-4000-8000-000000000001";
export const WORKER_ID = "00a1b2c3-0000-4000-8000-000000000002";
export const OTHER_ID = "00a1b2c3-0000-4000-8000-000000000003";

/** Synthetic storage UUIDs: the servers' disks, a CD-ROM, and backups. */
export const SHOP_DISK = "01a1b2c3-0000-4000-8000-000000000011";
export const WORKER_DISK = "01a1b2c3-0000-4000-8000-000000000012";
export const CDROM = "01a1b2c3-0000-4000-8000-000000000013";
export const BACKUP_OLD = "01a1b2c3-0000-4000-8000-000000000021";
export const BACKUP_NEW = "01a1b2c3-0000-4000-8000-000000000022";
export const BACKUP_TAKEN = "01a1b2c3-0000-4000-8000-000000000023";
export const BACKUP_FOREIGN = "01a1b2c3-0000-4000-8000-000000000024";
export const BACKUP_BY_HAND = "01a1b2c3-0000-4000-8000-000000000025";
export const BACKUP_SIMPLE = "01a1b2c3-0000-4000-8000-000000000026";
export const BACKUP_ALIKE = "01a1b2c3-0000-4000-8000-000000000027";

/**
 * One server as `GET /server` lists it (developers.upcloud.com/1.3/8-servers/, "List servers"),
 * labelled `opscrew-app` = `app` unless `labels` says otherwise; `labels: null` leaves the field
 * out.
 */
export function listed(
  title: string,
  options: {
    uuid?: string;
    state?: string;
    zone?: string;
    labels?: Record<string, string> | null;
  } = {},
) {
  const labels = options.labels === undefined ? { "opscrew-app": "shop" } : options.labels;
  return {
    core_number: "2",
    hostname: title,
    ...(labels !== null && {
      labels: { label: Object.entries(labels).map(([key, value]) => ({ key, value })) },
    }),
    license: 0,
    memory_amount: "4096",
    plan: "PREMIUM-2xCPU-4GB",
    plan_ipv4_bytes: "0",
    plan_ipv6_bytes: "0",
    state: options.state ?? "started",
    tags: { tag: [] },
    title,
    uuid: options.uuid ?? SHOP_ID,
    zone: options.zone ?? "de-fra1",
  };
}

/** `GET /server`'s answer with these servers: `{ servers: { server: [...] } }`. */
export function serverList(...servers: ReturnType<typeof listed>[]): FakeReply {
  return { body: { servers: { server: servers } } };
}

/** One of a server's storage devices (8-servers, "Get server details"). */
function device(storage: string, type: "disk" | "cdrom") {
  return {
    address: type === "disk" ? "virtio:0" : "ide:0:0",
    part_of_plan: type === "disk" ? "yes" : "",
    labels: [],
    storage,
    storage_size: type === "disk" ? 50 : 1,
    storage_encrypted: "no",
    storage_tier: type === "disk" ? "maxiops" : "",
    storage_title: type === "disk" ? "shop-disk" : "Ubuntu Server 24.04 LTS (Noble Numbat)",
    type,
    boot_disk: "0",
  };
}

/**
 * `GET /server/{uuid}`'s answer (8-servers, "Get server details"): the server `shop` in `state`,
 * a CD-ROM first and then its disk, unless `disks` names others.
 */
export function details(
  state: string,
  options: { uuid?: string; title?: string; disks?: string[] } = {},
): FakeReply {
  const title = options.title ?? "shop";
  return {
    body: {
      server: {
        uuid: options.uuid ?? SHOP_ID,
        hostname: title,
        title,
        state,
        zone: "de-fra1",
        plan: "PREMIUM-2xCPU-4GB",
        labels: { label: [{ key: "opscrew-app", value: "shop" }] },
        storage_devices: {
          storage_device: [
            device(CDROM, "cdrom"),
            ...(options.disks ?? [SHOP_DISK]).map((disk) => device(disk, "disk")),
          ],
        },
      },
    },
  };
}

/** One backup as `GET /storage/backup` lists it (9-storages, "List storages"). */
export function backup(
  uuid: string,
  title: string,
  options: { origin?: string; created?: string; size?: number; state?: string } = {},
) {
  return {
    access: "private",
    created: options.created ?? "2026-11-20T08:00:05Z",
    encrypted: "no",
    labels: [],
    license: 0,
    origin: options.origin ?? SHOP_DISK,
    size: options.size ?? 50,
    state: options.state ?? "online",
    title,
    type: "backup",
    uuid,
    zone: "de-fra1",
  };
}

/** `GET /storage/backup`'s answer with these backups: `{ storages: { storage: [...] } }`. */
export function backupList(...backups: ReturnType<typeof backup>[]): FakeReply {
  return { body: { storages: { storage: backups } } };
}

/**
 * `POST /storage/{uuid}/backup`'s answer (9-storages, "Create backup"): 201 with the new backup,
 * in `maintenance`, whose `type` UpCloud's example gives as `normal`.
 */
export function backupCreated(title: string): FakeReply {
  return {
    status: 201,
    body: {
      storage: {
        access: "private",
        created: "2026-11-28T10:00:01Z",
        license: 0,
        origin: SHOP_DISK,
        progress: "0",
        servers: { server: [] },
        size: 50,
        state: "maintenance",
        title,
        type: "normal",
        uuid: BACKUP_TAKEN,
        zone: "de-fra1",
      },
    },
  };
}

/** UpCloud's empty `204 No Content` (a restore, a delete). */
export const NO_CONTENT: FakeReply = { status: 204 };
