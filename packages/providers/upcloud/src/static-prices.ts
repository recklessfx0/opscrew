/**
 * UpCloud prices, dated. The catalogue's prices come from this table alone, checked against the
 * list before each release; with a token, UpCloud's plan list only says which plans exist.
 *
 * Source: UpCloud's pricing page, https://upcloud.com/pricing/ ("Pricing updated: 24/10/2026"),
 * read 2026-11-28 in a browser: euros, before VAT, one "Global price" for every zone. Servers are
 * billed by the started hour, at most 28 days a month; storage and backups by the hour, their
 * monthly figures over a 30-day month (research R6 §3, §5, §7).
 */
export const STATIC_PRICES_AS_OF = "2026-10-24T00:00:00.000Z";

/**
 * The hours UpCloud bills a server for in a month at most (28 days): a plan's hourly price is its
 * monthly price over these, and a 730-hour month costs the monthly price (decision 25).
 */
export const BILLED_HOURS_A_MONTH = 672;

/** The hours in a month of OpsCrew's monthly figures. */
export const HOURS_A_MONTH = 730;

/** The hours in the 30-day month UpCloud prices storage and backups over. */
export const HOURS_PER_30_DAYS = 720;

/**
 * The zones OpsCrew maps its regions to (decision 26): Frankfurt, Amsterdam and Warsaw
 * (eu-central), Helsinki 1 and 2 (eu-north), New York (us-east), San Jose (us-west) and Singapore
 * (ap-southeast). Each has the newer CPU generations Premium plans run on (research R6 §6).
 */
export const UPCLOUD_ZONES = [
  "de-fra1",
  "nl-ams1",
  "pl-waw1",
  "fi-hel1",
  "fi-hel2",
  "us-nyc1",
  "us-sjo1",
  "sg-sin1",
] as const;

/** One of {@link UPCLOUD_ZONES}. */
export type UpCloudZone = (typeof UPCLOUD_ZONES)[number];

/** One Premium plan OpsCrew offers, with its included MaxIOPS disk. */
export interface UpCloudPlan {
  /**
   * UpCloud's plan name, `PREMIUM-<cores>xCPU-<GB of memory>GB`. Only `PREMIUM-1xCPU-1GB` and
   * `PREMIUM-2xCPU-4GB` are confirmed in UpCloud's sources; the others follow the pattern
   * (research R6 §7), so a plan lister drops any UpCloud doesn't list.
   */
  id: string;
  vcpus: number;
  memoryGb: number;
  /** The included MaxIOPS disk. */
  diskGb: number;
  /** EUR a month: the cap of its hourly billing. */
  monthly: number;
}

/** The plans OpsCrew offers (decision 24), each with at least design's 40 GB of disk. */
export const STATIC_PLANS: readonly UpCloudPlan[] = [
  { id: "PREMIUM-2xCPU-2GB", vcpus: 2, memoryGb: 2, diskGb: 50, monthly: 16 },
  { id: "PREMIUM-2xCPU-4GB", vcpus: 2, memoryGb: 4, diskGb: 50, monthly: 26 },
  { id: "PREMIUM-2xCPU-8GB", vcpus: 2, memoryGb: 8, diskGb: 100, monthly: 38 },
  { id: "PREMIUM-4xCPU-8GB", vcpus: 4, memoryGb: 8, diskGb: 100, monthly: 52 },
  { id: "PREMIUM-4xCPU-16GB", vcpus: 4, memoryGb: 16, diskGb: 150, monthly: 92 },
];

/** The list's rates besides the plans, EUR. */
export interface UpCloudRates {
  /** One GB of a flexible or on-demand backup (OpsCrew's snapshots), a 30-day month. */
  backupGbMonth: number;
  /** Simple Backup's week plan (`dailies`: a daily backup kept 7 days), % of the plan's price. */
  weekPlanBackupPercent: number;
}

/** The list's rates. */
export const STATIC_RATES: UpCloudRates = {
  backupGbMonth: 0.056,
  weekPlanBackupPercent: 20,
};
