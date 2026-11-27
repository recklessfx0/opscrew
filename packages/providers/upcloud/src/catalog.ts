import type { ComputeCatalog, ComputeOffer, Money, ProviderExtras } from "@opscrew/contracts";
import { OpsCrewError, orText } from "@opscrew/core";
import {
  BILLED_HOURS_A_MONTH,
  HOURS_PER_30_DAYS,
  STATIC_PLANS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  UPCLOUD_ZONES,
} from "./static-prices";

export interface UpCloudCatalogOptions {
  /**
   * The plan names UpCloud lists (`GET /1.3/plan`); the connector passes one when a token is set.
   * Without it every table plan is `available`.
   */
  listPlans?: () => Promise<readonly string[]>;
}

/**
 * UpCloud's catalogue: the Premium plans OpsCrew offers in every mapped zone, billed by the
 * started hour up to their monthly price, from the dated table in `static-prices.ts`
 * (`source: "static"`). With a plan lister, read at most once per catalogue, an offer whose plan
 * UpCloud doesn't list is `available: false`, so a guessed plan name never reaches a plan; when
 * the listing fails, the table stands as it is.
 */
export class UpCloudCatalog implements ComputeCatalog {
  readonly provider = "upcloud" as const;
  readonly #listPlans: (() => Promise<readonly string[]>) | undefined;
  #listed: Promise<ReadonlySet<string> | undefined> | undefined;

  constructor(options: UpCloudCatalogOptions = {}) {
    this.#listPlans = options.listPlans;
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const listed = await this.#readListed();
    const out: ComputeOffer[] = [];
    for (const zone of UPCLOUD_ZONES) {
      if (location !== undefined && zone !== location) continue;
      for (const plan of STATIC_PLANS) {
        out.push({
          provider: "upcloud",
          id: plan.id,
          vcpus: plan.vcpus,
          memoryGb: plan.memoryGb,
          diskGb: plan.diskGb,
          cpuType: "shared",
          architecture: "x86",
          location: zone,
          billing: "hourly",
          hourly: eur(plan.monthly / BILLED_HOURS_A_MONTH),
          monthly: eur(plan.monthly),
          pricesIncludeVat: false,
          deprecated: false,
          available: listed === undefined || listed.has(plan.id),
          source: "static",
          asOf: STATIC_PRICES_AS_OF,
        });
      }
    }
    return out;
  }

  /**
   * The on-demand backup rate per GB (OpsCrew's snapshots), by the month and by the hour, and
   * Simple Backup's week plan as a percentage of the plan. No `ipv4Monthly`: a plan's one IPv4 is
   * in its price.
   * @throws OpsCrewError `INVALID_INPUT` for a zone OpsCrew doesn't map.
   */
  async extras(location: string): Promise<ProviderExtras> {
    if (!(UPCLOUD_ZONES as readonly string[]).includes(location)) {
      throw new OpsCrewError("INVALID_INPUT", `OpsCrew doesn't use the UpCloud zone ${location}.`, {
        hint: `Use one of ${orText(UPCLOUD_ZONES)}.`,
      });
    }
    return {
      backupPercent: STATIC_RATES.weekPlanBackupPercent,
      snapshotPerGbMonth: eur(STATIC_RATES.backupGbMonth),
      snapshotPerGbHour: eur(STATIC_RATES.backupGbMonth / HOURS_PER_30_DAYS),
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    };
  }

  /** The plan names UpCloud lists, read once; `undefined` without a lister or when it fails. */
  #readListed(): Promise<ReadonlySet<string> | undefined> {
    const listPlans = this.#listPlans;
    if (listPlans === undefined) return Promise.resolve(undefined);
    this.#listed ??= listPlans().then(
      (names) => new Set(names),
      () => undefined,
    );
    return this.#listed;
  }
}

function eur(amount: number): Money {
  return { amount, currency: "EUR" };
}
