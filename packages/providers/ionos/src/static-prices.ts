/**
 * IONOS Cloud prices, dated. IONOS publishes no price API (research R5 §7), so this table is the
 * catalogue's only source, checked against the list before each release.
 *
 * Source: IONOS Cloud's EUR price list (IONOS CLOUD GmbH),
 * https://docs.ionos.com/cloud/support/general-information/price-list/ionos-cloud-eur-en, version
 * v2026-10-29, valid from 2026-10-29: euros, net of any tax. A vCPU server is priced by its parts,
 * each by the hour; block storage and snapshots are priced per 30 days (research R5 §3, §7).
 */
export const STATIC_PRICES_AS_OF = "2026-10-29T00:00:00.000Z";

/** The hours OpsCrew counts in a month, as for every hourly provider. */
export const HOURS_A_MONTH = 730;

/** The hours in the 30 days IONOS prices storage and snapshots over. */
export const HOURS_PER_30_DAYS = 720;

/**
 * The locations OpsCrew maps its regions to (decision 15): Frankfurt 1 and 2 and Berlin
 * (eu-central, Berlin also eu-north), Newark (us-east) and Lenexa (us-west). Each has vCPU servers
 * (research R5 §6).
 */
export const IONOS_LOCATIONS = ["de/fra/1", "de/fra/2", "de/txl", "us/ewr", "us/mci"] as const;

/** One of {@link IONOS_LOCATIONS}. */
export type IonosLocation = (typeof IONOS_LOCATIONS)[number];

/** The list's rates OpsCrew uses, EUR. */
export interface IonosRates {
  /** One vCPU of a vCPU server, an hour. */
  vcpuHour: number;
  /** One GB of a vCPU server's memory, an hour. */
  ramGbHour: number;
  /** One GB of Essential block storage, per 30 days. */
  essentialDiskGbPer30Days: number;
  /**
   * One reserved public IPv4 address, per 30 days. Each server keeps one, because IONOS gives a
   * stopped server's dynamic address back to its pool (decision 21).
   */
  reservedIpv4Per30Days: number;
  /** One GB of snapshot, per 30 days. */
  snapshotGbPer30Days: number;
  /** Each GB of outgoing traffic above the contract's monthly allowance (the 2 to 10 TB tier). */
  trafficPerGbOver: number;
}

/** The list's rates. */
export const STATIC_RATES: IonosRates = {
  vcpuHour: 0.012,
  ramGbHour: 0.002,
  essentialDiskGbPer30Days: 0.04,
  reservedIpv4Per30Days: 5,
  snapshotGbPer30Days: 0.04,
  trafficPerGbOver: 0.03,
};

/** Outgoing traffic included each month, GB, per contract (not per server). */
export const TRAFFIC_INCLUDED_GB_A_MONTH = 2000;

/** One size OpsCrew offers: a vCPU server with one Essential boot disk and its reserved IPv4. */
export interface IonosSize {
  /** OpsCrew's id, `vcpu-<vCPUs>-<GB of memory>`. */
  id: string;
  vcpus: number;
  memoryGb: number;
  /** The Essential boot disk. */
  diskGb: number;
}

/** The sizes OpsCrew offers (decision 16), each with at least design's 40 GB of disk. */
export const STATIC_SIZES: readonly IonosSize[] = [
  { id: "vcpu-1-2", vcpus: 1, memoryGb: 2, diskGb: 40 },
  { id: "vcpu-2-4", vcpus: 2, memoryGb: 4, diskGb: 80 },
  { id: "vcpu-4-8", vcpus: 4, memoryGb: 8, diskGb: 160 },
  { id: "vcpu-2-8", vcpus: 2, memoryGb: 8, diskGb: 80 },
  { id: "vcpu-4-16", vcpus: 4, memoryGb: 16, diskGb: 160 },
];

/**
 * A size's price for one hour, EUR: its vCPUs, its memory, and the 30-day prices of its disk and
 * its reserved IPv4 address over 720 hours.
 */
export function hourlyPrice(size: IonosSize): number {
  return (
    size.vcpus * STATIC_RATES.vcpuHour +
    size.memoryGb * STATIC_RATES.ramGbHour +
    (size.diskGb * STATIC_RATES.essentialDiskGbPer30Days) / HOURS_PER_30_DAYS +
    STATIC_RATES.reservedIpv4Per30Days / HOURS_PER_30_DAYS
  );
}
