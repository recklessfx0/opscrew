import type { ComputeCatalog, ComputeOffer, Money, ProviderExtras } from "@opscrew/contracts";
import { OpsCrewError, orText } from "@opscrew/core";
import {
  HOURS_A_MONTH,
  HOURS_PER_30_DAYS,
  hourlyPrice,
  IONOS_LOCATIONS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  STATIC_SIZES,
} from "./static-prices";

/**
 * IONOS Cloud's catalogue: the sizes OpsCrew offers in every mapped location, billed by the hour,
 * from the dated table in `static-prices.ts` (`source: "static"`). IONOS has no price API and
 * publishes no availability per account, so every offer is `available`; an apply IONOS refuses
 * takes the generic unavailable-size path.
 */
export class IonosCatalog implements ComputeCatalog {
  readonly provider = "ionos" as const;

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const out: ComputeOffer[] = [];
    for (const where of IONOS_LOCATIONS) {
      if (location !== undefined && where !== location) continue;
      for (const size of STATIC_SIZES) {
        const hourly = hourlyPrice(size);
        out.push({
          provider: "ionos",
          id: size.id,
          vcpus: size.vcpus,
          memoryGb: size.memoryGb,
          diskGb: size.diskGb,
          cpuType: "shared",
          architecture: "x86",
          location: where,
          billing: "hourly",
          hourly: eur(hourly),
          monthly: eur(hourly * HOURS_A_MONTH),
          pricesIncludeVat: false,
          deprecated: false,
          available: true,
          source: "static",
          asOf: STATIC_PRICES_AS_OF,
        });
      }
    }
    return out;
  }

  /**
   * The snapshot rate, by the hour and over 730 hours. No `ipv4Monthly`: a server's first
   * dynamic IPv4 is free. The contract's 2 TB of traffic and the rate above it have no field here;
   * they are in `static-prices.ts` for the texts.
   * @throws OpsCrewError `INVALID_INPUT` for a location OpsCrew doesn't map.
   */
  async extras(location: string): Promise<ProviderExtras> {
    if (!(IONOS_LOCATIONS as readonly string[]).includes(location)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew doesn't use the IONOS Cloud location ${location}.`,
        { hint: `Use one of ${orText(IONOS_LOCATIONS)}.` },
      );
    }
    const perHour = STATIC_RATES.snapshotGbPer30Days / HOURS_PER_30_DAYS;
    return {
      snapshotPerGbHour: eur(perHour),
      snapshotPerGbMonth: eur(perHour * HOURS_A_MONTH),
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    };
  }
}

function eur(amount: number): Money {
  return { amount, currency: "EUR" };
}
