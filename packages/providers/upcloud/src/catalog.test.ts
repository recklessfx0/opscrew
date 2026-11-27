import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import { UpCloudCatalog } from "./catalog";
import {
  BILLED_HOURS_A_MONTH,
  HOURS_PER_30_DAYS,
  STATIC_PLANS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  UPCLOUD_ZONES,
} from "./static-prices";

/** Design's smallest disk for a new cloud server (`MIN_DISK_GB` in agents' sizing). */
const DESIGN_MIN_DISK_GB = 40;

/** Decision 24's plans, as `[id, vCPUs, GB of memory, GB of MaxIOPS disk, EUR a month]`. */
const PLANS: [string, number, number, number, number][] = [
  ["PREMIUM-2xCPU-2GB", 2, 2, 50, 16],
  ["PREMIUM-2xCPU-4GB", 2, 4, 50, 26],
  ["PREMIUM-2xCPU-8GB", 2, 8, 100, 38],
  ["PREMIUM-4xCPU-8GB", 4, 8, 100, 52],
  ["PREMIUM-4xCPU-16GB", 4, 16, 150, 92],
];

describe("UpCloudCatalog offers", () => {
  it("offers the five Premium plans in every mapped zone, billed by the hour from the dated list", async () => {
    const offers = await new UpCloudCatalog().listOffers();

    expect(UPCLOUD_ZONES).toEqual([
      "de-fra1",
      "nl-ams1",
      "pl-waw1",
      "fi-hel1",
      "fi-hel2",
      "us-nyc1",
      "us-sjo1",
      "sg-sin1",
    ]);
    expect(offers).toHaveLength(PLANS.length * UPCLOUD_ZONES.length);
    for (const zone of UPCLOUD_ZONES) {
      const here = offers.filter((o) => o.location === zone);
      expect(here.map((o) => [o.id, o.vcpus, o.memoryGb, o.diskGb, o.monthly.amount])).toEqual(
        PLANS,
      );
    }
    for (const offer of offers) {
      expect(offer).toMatchObject({
        provider: "upcloud",
        cpuType: "shared",
        architecture: "x86",
        billing: "hourly",
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "static",
        asOf: "2026-10-24T00:00:00.000Z",
      });
      expect(offer.monthly.currency).toBe("EUR");
      expect(offer.setupFee).toBeUndefined();
      expect(offer.diskGb).toBeGreaterThanOrEqual(DESIGN_MIN_DISK_GB);
    }
    expect(STATIC_PRICES_AS_OF).toBe("2026-10-24T00:00:00.000Z");
  });

  it("prices each hour at the monthly cap over 28 days of 24 hours", async () => {
    const offers = await new UpCloudCatalog().listOffers();

    expect(BILLED_HOURS_A_MONTH).toBe(28 * 24);
    for (const offer of offers) {
      expect(offer.hourly).toEqual({ amount: offer.monthly.amount / 672, currency: "EUR" });
    }
    const smallest = offers.find((o) => o.id === "PREMIUM-2xCPU-2GB");
    expect(smallest?.hourly?.amount).toBeCloseTo(0.02381, 5);
  });

  it("offers one zone's plans when a zone is named, and none for a zone it doesn't map", async () => {
    const catalog = new UpCloudCatalog();

    const helsinki = await catalog.listOffers("fi-hel2");
    expect(helsinki).toHaveLength(PLANS.length);
    expect(helsinki.every((o) => o.location === "fi-hel2")).toBe(true);
    expect(await catalog.listOffers("se-sto1")).toEqual([]);
  });

  it("keeps the table's plan sizes in step with their names", () => {
    for (const plan of STATIC_PLANS) {
      expect(plan.id).toBe(`PREMIUM-${plan.vcpus}xCPU-${plan.memoryGb}GB`);
    }
  });
});

describe("UpCloudCatalog with a plan lister", () => {
  it("marks unavailable each offer whose plan UpCloud doesn't list", async () => {
    const listPlans = vi.fn(async () => ["PREMIUM-2xCPU-4GB", "PREMIUM-4xCPU-8GB", "STARTER-1"]);
    const offers = await new UpCloudCatalog({ listPlans }).listOffers();

    expect(offers).toHaveLength(PLANS.length * UPCLOUD_ZONES.length);
    const available = new Set(offers.filter((o) => o.available).map((o) => o.id));
    expect([...available]).toEqual(["PREMIUM-2xCPU-4GB", "PREMIUM-4xCPU-8GB"]);
    for (const offer of offers) {
      expect(offer.source).toBe("static");
    }
  });

  it("lists UpCloud's plans at most once per catalogue", async () => {
    const listPlans = vi.fn(async () => PLANS.map(([id]) => id));
    const catalog = new UpCloudCatalog({ listPlans });

    await catalog.listOffers();
    await catalog.listOffers("de-fra1");
    await catalog.extras("de-fra1");
    expect(listPlans).toHaveBeenCalledTimes(1);
    expect((await catalog.listOffers()).every((o) => o.available)).toBe(true);
  });

  it("keeps the table as it is when the listing fails, and tries no more", async () => {
    const listPlans = vi.fn(async (): Promise<string[]> => {
      throw new OpsCrewError("PROVIDER_ERROR", "UpCloud refused the request.");
    });
    const catalog = new UpCloudCatalog({ listPlans });

    const offers = await catalog.listOffers();
    expect(offers).toEqual(await new UpCloudCatalog().listOffers());
    await catalog.listOffers();
    expect(listPlans).toHaveBeenCalledTimes(1);
  });
});

describe("UpCloudCatalog extras", () => {
  it("gives the on-demand backup rate per GB, by the month and by the hour, and backups at 20%", async () => {
    const extras = await new UpCloudCatalog().extras("de-fra1");

    expect(HOURS_PER_30_DAYS).toBe(720);
    expect(STATIC_RATES.backupGbMonth).toBe(0.056);
    expect(extras).toEqual({
      backupPercent: 20,
      snapshotPerGbMonth: { amount: (0.056 / 720) * 730, currency: "EUR" },
      snapshotPerGbHour: { amount: 0.056 / 720, currency: "EUR" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
  });

  it("refuses a zone OpsCrew doesn't map, naming the ones it does", async () => {
    const failure = await new UpCloudCatalog().extras("se-sto1").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OpsCrewError);
    expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    expect((failure as OpsCrewError).message).toContain("se-sto1");
    expect((failure as OpsCrewError).hint).toContain("de-fra1");
  });
});
