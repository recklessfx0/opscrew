import type { ProviderConnectorDeps, VpsConnector } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  accepted,
  ionosError,
  ionosFetch,
  requestStatus,
  TOKEN,
  TOKEN_ENV,
} from "./__fixtures__/client";
import {
  collection,
  DC_SHOP,
  DC_WORKER,
  datacenter,
  SHOP,
  SRV_SHOP,
  server,
} from "./__fixtures__/servers";
import { IONOS_API_URL } from "./client";
import { IONOS_CREDENTIALS, type IonosConnector, ionosConnector } from "./connector";

// Type-level check: the IONOS connector satisfies the VPS connector contract.
const asVps = (c: IonosConnector) => c satisfies VpsConnector;

const DATACENTERS = "GET /datacenters?depth=0";
const CONTRACTS = "GET /contracts";

/** `GET /contracts`'s answer (`Contracts`) with one contract whose limits are `limits`. */
function contracts(limits?: Record<string, number>): FakeReply {
  return {
    body: {
      type: "contract",
      href: `${IONOS_API_URL}/contracts`,
      items: [
        {
          type: "contract",
          properties: {
            contractNumber: 31_000_000,
            status: "BILLABLE",
            regDomain: "ionos.de",
            ...(limits !== undefined && { resourceLimits: limits }),
          },
        },
      ],
    },
  };
}

/** A contract's `resourceLimits`, RAM and disks in MB as IONOS gives them. */
const LIMITS = {
  coresPerServer: 62,
  coresPerContract: 24,
  coresProvisioned: 4,
  ramPerServer: 235_520,
  ramPerContract: 49_152,
  ramProvisioned: 8_192,
  hddLimitPerVolume: 4_194_304,
  hddLimitPerContract: 2_048_000,
  hddVolumeProvisioned: 81_920,
  ssdLimitPerVolume: 4_194_304,
  ssdLimitPerContract: 1_024_000,
  ssdVolumeProvisioned: 0,
};

/** `GET /datacenters?depth=0`'s answer: each data centre as a reference. */
function datacenterRefs(...ids: string[]): FakeReply {
  return collection(
    ...ids.map((id) => ({ id, type: "datacenter", href: `${IONOS_API_URL}/datacenters/${id}` })),
  );
}

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string> = TOKEN_ENV,
  extra: Partial<ProviderConnectorDeps> = {},
) {
  const fake = ionosFetch(routes, extra.env?.IONOS_API_URL);
  const waits: number[] = [];
  let time = Date.parse("2026-11-27T10:00:00Z");
  const c = ionosConnector({
    env,
    fetch: fake.fetch,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    now: () => new Date(time),
    ...extra,
  });
  return { connector: c, calls: fake.calls, waits };
}

const paths = (calls: { method: string; path: string }[]) =>
  calls.map((call) => `${call.method} ${call.path}`);

describe("ionosConnector", () => {
  it("describes the token, that it acts as its user, and where to make it", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("ionos");
    expect(c.displayName).toBe("IONOS Cloud");
    expect(c.credentials).toBe(IONOS_CREDENTIALS);
    expect(IONOS_CREDENTIALS).toEqual({
      envVars: ["IONOS_TOKEN"],
      description:
        'An IONOS Cloud token as IONOS_TOKEN, made in the Token Manager of IONOS\'s Data Center Designer. A token can\'t be limited: it acts as the user who made it, so make it as a sub-user whose group has only the "Create Data Center" privilege, and "Create Snapshot" for whole-server snapshots.',
      scopes: ["Create Data Center", "Create Snapshot"],
      createUrl:
        "https://docs.ionos.com/cloud/set-up-ionos-cloud/management/identity-access-management/token-manager",
    });
  });

  it("is configured, with a server API, only with the token", () => {
    const full = asVps(connector({}).connector);
    expect(full.configured).toBe(true);
    expect(full.servers).toBeDefined();
    const envs: Record<string, string>[] = [
      {},
      { IONOS_TOKEN: " " },
      { ...TOKEN_ENV, IONOS_API_URL: "http://x.test" },
    ];
    for (const env of envs) {
      const c = connector({}, env).connector;
      expect(c.configured).toBe(false);
      expect(c.servers).toBeUndefined();
    }
  });

  it("has no firewalls, backups or object storage", () => {
    const c = connector({}).connector;
    expect("firewalls" in c || "backups" in c || "objectStorage" in c).toBe(false);
  });

  it("registers the token with the redactor as it reads it", () => {
    const redactor = new Redactor();
    connector({}, TOKEN_ENV, { redactor });
    expect(redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("makes the static catalogue once, calling nothing, with or without the token", async () => {
    for (const env of [TOKEN_ENV, {}]) {
      const { connector: c, calls } = connector({}, env);
      const catalog = c.catalog();
      expect(c.catalog()).toBe(catalog);
      expect(catalog.provider).toBe("ionos");
      const offers = await catalog.listOffers("de/fra/1");
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) expect(offer.source).toBe("static");
      expect(calls).toEqual([]);
    }
  });

  it("finds the app's servers through its server API", async () => {
    const { connector: c, calls } = connector({
      "GET /datacenters?depth=1": collection(datacenter(DC_SHOP, "opscrew-shop")),
      [`GET /datacenters/${DC_SHOP}/servers`]: collection(server(SRV_SHOP, { vmState: "SHUTOFF" })),
    });
    expect(await c.servers?.findAppServers("shop", ["shop"])).toEqual([
      { id: SHOP, name: "shop", status: "shutoff", nameOnly: true },
    ]);
    expect(paths(calls)).toEqual([
      "GET /datacenters?depth=1",
      `GET /datacenters/${DC_SHOP}/servers?depth=1`,
    ]);
  });

  it("awaits a request with the injected clock and sleep", async () => {
    const {
      connector: c,
      calls,
      waits,
    } = connector({
      [`GET /datacenters/${DC_SHOP}/servers/${SRV_SHOP}`]: {
        body: server(SRV_SHOP, { vmState: "SHUTOFF" }),
      },
      [`POST /datacenters/${DC_SHOP}/servers/${SRV_SHOP}/start`]: accepted("req-1"),
      "GET /requests/req-1/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    await c.servers?.powerOn(SHOP);
    expect(waits).toEqual([3_000]);
    expect(paths(calls)).toContain(`POST /datacenters/${DC_SHOP}/servers/${SRV_SHOP}/start`);
  });

  it("sends the token to the address IONOS_API_URL names", async () => {
    const base = "https://ionos.example.test/cloudapi/v6";
    const env = { ...TOKEN_ENV, IONOS_API_URL: base };
    const { connector: c, calls } = connector({ "GET /datacenters?depth=1": collection() }, env, {
      env,
    });
    await c.servers?.findAppServers("shop");
    expect(calls.map((call) => call.url)).toEqual([`${base}/datacenters?depth=1`]);
  });
});

describe("verifyCredentials", () => {
  it("names the missing token and calls nothing", async () => {
    const { connector: c, calls } = connector({}, {});
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/^IONOS_TOKEN is not set: /);
    expect(calls).toEqual([]);
  });

  it("refuses an API address that isn't https:// before any call", async () => {
    const { connector: c, calls } = connector(
      {},
      { ...TOKEN_ENV, IONOS_API_URL: "http://ionos.example.test" },
    );
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("IONOS_API_URL must be an https:// address");
    expect(calls).toEqual([]);
  });

  it("reads the data centres and the contract's limits, and says what it found", async () => {
    const { connector: c, calls } = connector({
      [DATACENTERS]: datacenterRefs(DC_SHOP, DC_WORKER),
      [CONTRACTS]: contracts(LIMITS),
    });
    expect(await c.verifyCredentials()).toEqual({
      ok: true,
      message:
        "The IONOS Cloud token works: its user sees 2 data centres. The contract's limits: 24 cores (4 in use), 48 GB of memory (8 GB in use), 2000 GB of HDD storage (80 GB in use) and 1000 GB of SSD storage (0 GB in use).",
    });
    expect(paths(calls)).toEqual([DATACENTERS, CONTRACTS]);
  });

  it("says only the limits IONOS shows, or that it shows none", async () => {
    for (const [limits, said] of [
      [
        { coresPerContract: 8, ramPerContract: 1_536 },
        "The IONOS Cloud token works: its user sees 1 data centre. The contract's limits: 8 cores and 1.5 GB of memory.",
      ],
      [
        undefined,
        "The IONOS Cloud token works: its user sees 1 data centre. IONOS showed no limits for the contract.",
      ],
    ] as const) {
      const { connector: c } = connector({
        [DATACENTERS]: datacenterRefs(DC_SHOP),
        [CONTRACTS]: contracts(limits),
      });
      expect(await c.verifyCredentials()).toEqual({ ok: true, message: said });
    }
  });

  it("counts no data centre", async () => {
    const { connector: c } = connector({
      [DATACENTERS]: datacenterRefs(),
      [CONTRACTS]: contracts({ coresPerContract: 8 }),
    });
    const check = await c.verifyCredentials();
    expect(check.message).toBe(
      "The IONOS Cloud token works: its user sees 0 data centres. The contract's limits: 8 cores.",
    );
  });

  it("shows IONOS's refusal in plain English", async () => {
    const { connector: c } = connector({
      [DATACENTERS]: ionosError(401, "Unauthorized"),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("IONOS refused the token in IONOS_TOKEN (HTTP 401");
    expect(check.message).toContain("Unauthorized");
  });

  it("fails when the contract can't be read", async () => {
    const { connector: c } = connector({
      [DATACENTERS]: datacenterRefs(DC_SHOP),
      [CONTRACTS]: ionosError(403, "Access denied"),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("IONOS refused GET /contracts (HTTP 403)");
  });
});

describe("connector leaks", () => {
  it("puts the token in no check, even when IONOS repeats it", async () => {
    const echo = `bad ${TOKEN}`;
    const routes: Record<string, FakeReply>[] = [
      { [DATACENTERS]: ionosError(401, echo) },
      { [DATACENTERS]: ionosError(500, echo) },
      { [DATACENTERS]: { error: new Error(echo) } },
      { [DATACENTERS]: { body: { unexpected: echo } } },
      { [DATACENTERS]: datacenterRefs(DC_SHOP), [CONTRACTS]: ionosError(403, echo) },
      { [DATACENTERS]: datacenterRefs(DC_SHOP), [CONTRACTS]: { text: echo } },
    ];
    const checks = await Promise.all(
      routes.map((route) => connector(route).connector.verifyCredentials()),
    );
    expect(checks.map((check) => check.ok)).toEqual([false, false, false, false, false, false]);
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });
});
