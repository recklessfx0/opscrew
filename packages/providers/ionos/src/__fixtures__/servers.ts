import type { FakeReply } from "@opscrew/core/testing";
import { IONOS_API_URL } from "../client";

/** Synthetic data-centre ids (IONOS's ids are UUIDs). */
export const DC_SHOP = "d0000000-0000-4000-8000-000000000001";
export const DC_WORKER = "d0000000-0000-4000-8000-000000000002";
export const DC_OTHER = "d0000000-0000-4000-8000-000000000003";

/** Synthetic server ids. */
export const SRV_SHOP = "5e000000-0000-4000-8000-000000000001";
export const SRV_WORKER = "5e000000-0000-4000-8000-000000000002";
export const SRV_OTHER = "5e000000-0000-4000-8000-000000000003";

/** The boot volume of the app's server. */
export const VOL_SHOP = "b0000000-0000-4000-8000-000000000001";

/** Synthetic snapshot ids. */
export const SNAP_OLD = "5a000000-0000-4000-8000-000000000001";
export const SNAP_NEW = "5a000000-0000-4000-8000-000000000002";
export const SNAP_BUSY = "5a000000-0000-4000-8000-000000000003";
export const SNAP_OTHER = "5a000000-0000-4000-8000-000000000004";

/** The app's server as OpsCrew names it: `<datacenter id>/<server id>`. */
export const SHOP = `${DC_SHOP}/${SRV_SHOP}`;

/** The name OpsCrew gives the snapshot of the app's server it takes at the fake clock's start. */
export const TAKEN = `opscrew-shop-${SRV_SHOP}-20261127T100000Z`;

/** The Cloud API's `DatacenterElementMetadata`, with the fields OpsCrew reads. */
function metadata(state: string, createdDate = "2026-11-20T09:00:00Z") {
  return { etag: "fake-etag", createdDate, lastModifiedDate: createdDate, state };
}

/**
 * One data centre as `GET /datacenters?depth=1` lists it (the Cloud API v6's `Datacenter`): its
 * id and its properties, with the name OpsCrew reads.
 */
export function datacenter(id: string, name: string, location = "de/fra") {
  return {
    id,
    type: "datacenter",
    href: `${IONOS_API_URL}/datacenters/${id}`,
    metadata: metadata("AVAILABLE"),
    properties: { name, description: "", location, version: 4, secAuthProtection: false },
    entities: {
      servers: { id: `${id}/servers`, type: "collection", href: "" },
      volumes: { id: `${id}/volumes`, type: "collection", href: "" },
    },
  };
}

/**
 * One server as `GET /datacenters/{id}/servers?depth=1` lists it, and as
 * `GET /datacenters/{id}/servers/{id}` answers it (the Cloud API v6's `Server`): its `vmState`
 * (`RUNNING`, `SHUTOFF`, …), absent while IONOS makes it, and its boot volume's reference.
 */
export function server(
  id: string,
  options: {
    name?: string;
    vmState?: string | undefined;
    state?: string;
    bootVolume?: string | null;
  } = {},
) {
  const bootVolume = options.bootVolume === undefined ? VOL_SHOP : options.bootVolume;
  const vmState = "vmState" in options ? options.vmState : "RUNNING";
  return {
    id,
    type: "server",
    href: `${IONOS_API_URL}/datacenters/${DC_SHOP}/servers/${id}`,
    metadata: metadata(options.state ?? "AVAILABLE"),
    properties: {
      name: options.name ?? "shop",
      cores: 2,
      ram: 4096,
      type: "VCPU",
      ...(vmState !== undefined && { vmState }),
      ...(bootVolume !== null && {
        bootVolume: { id: bootVolume, type: "volume", href: `${IONOS_API_URL}/volumes` },
      }),
    },
  };
}

/**
 * One snapshot as `GET /snapshots?depth=1` lists it, and as the volume's `create-snapshot`
 * answers it (the Cloud API v6's `Snapshot`): its name, its size in GB, its location, and in its
 * metadata when it was made and its state.
 */
export function snapshot(
  id: string,
  name: string | null,
  createdDate: string,
  options: { state?: string; size?: number } = {},
) {
  return {
    id,
    type: "snapshot",
    href: `${IONOS_API_URL}/snapshots/${id}`,
    metadata: metadata(options.state ?? "AVAILABLE", createdDate),
    properties: {
      name,
      description: "Taken by OpsCrew",
      location: "de/fra",
      size: options.size ?? 80,
      licenceType: "LINUX",
    },
  };
}

/** A collection of the Cloud API (`Datacenters`, `Servers`, `Snapshots`) holding `items`. */
export function collection(...items: unknown[]): FakeReply {
  return { body: { id: "collection", type: "collection", href: "", items } };
}
