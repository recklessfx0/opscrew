import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { IonosCatalog } from "./catalog";
import {
  HOURS_A_MONTH,
  HOURS_PER_30_DAYS,
  IONOS_LOCATIONS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  STATIC_SIZES,
  TRAFFIC_INCLUDED_GB_A_MONTH,
} from "./static-prices";

/** Design's smallest disk for a new cloud server (`MIN_DISK_GB` in agents' sizing). */
const DESIGN_MIN_DISK_GB = 40;

/** The sizes of plan 13., as `[id, vCPUs, GB of memory, GB of disk]`. */
const SIZES: [string, number, number, number][] = [
  ["vcpu-1-2", 1, 2, 40],
  ["vcpu-2-4", 2, 4, 80],
  ["vcpu-4-8", 4, 8, 160],
  ["vcpu-2-8", 2, 8, 80],
  ["vcpu-4-16", 4, 16, 160],
];

/** The 730-hour figures, EUR, worked out by hand from the list v2026-10-29. */
const MONTHLY: [string, number][] = [
  ["vcpu-1-2", 13.3022],
  ["vcpu-2-4", 26.6044],
  ["vcpu-4-8", 53.2089],
  ["vcpu-2-8", 32.4444],
  ["vcpu-4-16", 64.8889],
];

describe("IonosCatalog offers", () => {
  it("offers the five sizes in every mapped location, billed by the hour from the dated list", async () => {
    const offers = await new IonosCatalog().listOffers();

    expect(offers).toHaveLength(SIZES.length * IONOS_LOCATIONS.length);
    for (const location of IONOS_LOCATIONS) {
      const here = offers.filter((o) => o.location === location);
      expect(here.map((o) => [o.id, o.vcpus, o.memoryGb, o.diskGb])).toEqual(SIZES);
    }
    for (const offer of offers) {
      expect(offer).toMatchObject({
        provider: "ionos",
        cpuType: "shared",
        architecture: "x86",
        billing: "hourly",
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      });
      expect(offer.monthly.currency).toBe("EUR");
      expect(offer.hourly?.currency).toBe("EUR");
      expect(offer.setupFee).toBeUndefined();
      expect(offer.diskGb).toBeGreaterThanOrEqual(DESIGN_MIN_DISK_GB);
    }
  });

  it("prices each size from its parts: vCPU, RAM, and the disk's 30-day price over 720 hours", async () => {
    const offers = await new IonosCatalog().listOffers();
    for (const offer of offers) {
      const hourly = offer.vcpus * 0.012 + offer.memoryGb * 0.002 + (offer.diskGb * 0.04) / 720;
      expect(offer.hourly?.amount).toBeCloseTo(hourly, 10);
      expect(offer.monthly.amount).toBeCloseTo(hourly * 730, 10);
    }
    const frankfurt = await new IonosCatalog().listOffers("de/fra/1");
    for (const [id, monthly] of MONTHLY) {
      expect(frankfurt.find((o) => o.id === id)?.monthly.amount).toBeCloseTo(monthly, 4);
    }
  });

  it("keeps the list's rates, its date and the month's hours", () => {
    expect(STATIC_PRICES_AS_OF).toBe("2026-10-29T00:00:00.000Z");
    expect(HOURS_A_MONTH).toBe(730);
    expect(HOURS_PER_30_DAYS).toBe(720);
    expect(STATIC_RATES).toEqual({
      vcpuHour: 0.012,
      ramGbHour: 0.002,
      essentialDiskGbPer30Days: 0.04,
      snapshotGbPer30Days: 0.04,
      trafficPerGbOver: 0.03,
    });
    expect(TRAFFIC_INCLUDED_GB_A_MONTH).toBe(2000);
    expect(STATIC_SIZES.map((s) => s.id)).toEqual(SIZES.map(([id]) => id));
  });

  it("lists one location's offers, and none for a location OpsCrew doesn't map", async () => {
    const catalog = new IonosCatalog();
    const berlin = await catalog.listOffers("de/txl");
    expect(berlin).toHaveLength(SIZES.length);
    expect(new Set(berlin.map((o) => o.location))).toEqual(new Set(["de/txl"]));
    expect(await catalog.listOffers("us/las")).toEqual([]);
    expect(await catalog.listOffers("de/fra")).toEqual([]);
  });

  it("maps the five locations of decision 15, in order", () => {
    expect(IONOS_LOCATIONS).toEqual(["de/fra/1", "de/fra/2", "de/txl", "us/ewr", "us/mci"]);
  });
});

describe("IonosCatalog extras", () => {
  it("gives the snapshot rate, per GB an hour and over 730 hours, from the dated list", async () => {
    const catalog = new IonosCatalog();
    for (const location of IONOS_LOCATIONS) {
      expect(await catalog.extras(location)).toEqual({
        snapshotPerGbHour: { amount: 0.04 / 720, currency: "EUR" },
        snapshotPerGbMonth: { amount: (0.04 / 720) * 730, currency: "EUR" },
        pricesIncludeVat: false,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      });
    }
  });

  it("refuses a location OpsCrew doesn't map, in plain English", async () => {
    const error = await new IonosCatalog().extras("us/las").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
    expect((error as OpsCrewError).message).toContain("IONOS");
    expect((error as OpsCrewError).hint).toContain("de/fra/1");
  });
});
