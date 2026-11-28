import type { ProviderConnectorDeps, VpsConnector } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { TOKEN, TOKEN_ENV, upcloudError, upcloudFetch } from "./__fixtures__/client";
import { ACCOUNT, account, planList } from "./__fixtures__/connector";
import { details, listed, SHOP_ID, serverList, WORKER_ID } from "./__fixtures__/servers";
import { UPCLOUD_CREDENTIALS, type UpcloudConnector, upcloudConnector } from "./connector";

// Type-level check: the UpCloud connector satisfies the VPS connector contract.
const asVps = (c: UpcloudConnector) => c satisfies VpsConnector;

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string | undefined> = TOKEN_ENV,
  extra: Partial<ProviderConnectorDeps> = {},
) {
  const fake = upcloudFetch(routes);
  const waits: number[] = [];
  let time = Date.parse("2026-11-28T10:00:00Z");
  const c = upcloudConnector({
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

describe("upcloudConnector", () => {
  it("describes the token, why a sub-account, and where to create it", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("upcloud");
    expect(c.displayName).toBe("UpCloud");
    expect(c.credentials).toBe(UPCLOUD_CREDENTIALS);
    expect(UPCLOUD_CREDENTIALS).toEqual({
      envVars: ["UPCLOUD_TOKEN"],
      description:
        "An UpCloud API token as UPCLOUD_TOKEN, made in UpCloud's control panel under Account → API tokens. A token can't be limited to some resources: it acts with the rights of the account that made it.",
      scopes: ["a sub-account limited to servers and storage", "an expiry of 90 days or less"],
      createUrl: "https://hub.upcloud.com/account/api-tokens",
    });
  });

  it("is configured, with a server API, only with the token", () => {
    const full = asVps(connector({}).connector);
    expect(full.configured).toBe(true);
    expect(full.servers).toBeDefined();
    for (const env of [{}, { UPCLOUD_TOKEN: "" }, { UPCLOUD_TOKEN: "  " }]) {
      const c = connector({}, env).connector;
      expect(c.configured).toBe(false);
      expect(c.servers).toBeUndefined();
    }
  });

  it("never reads a user name or password", () => {
    const c = connector({}, { UPCLOUD_USERNAME: "someone", UPCLOUD_PASSWORD: "x" }).connector;
    expect(c.configured).toBe(false);
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

  it("makes the catalogue once; without the token it calls nothing and offers every plan", async () => {
    const { connector: c, calls } = connector({}, {});
    const catalog = c.catalog();
    expect(c.catalog()).toBe(catalog);
    const offers = await catalog.listOffers("de-fra1");
    expect(offers.length).toBe(5);
    expect(offers.every((offer) => offer.available)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("with the token, offers only the plans GET /plan lists, read once with the token", async () => {
    const { connector: c, calls } = connector({
      "GET /plan": planList("PREMIUM-2xCPU-2GB", "PREMIUM-2xCPU-4GB", "STARTER-1xCPU-1GB"),
    });
    const offers = await c.catalog().listOffers("de-fra1");
    expect(offers.filter((offer) => offer.available).map((offer) => offer.id)).toEqual([
      "PREMIUM-2xCPU-2GB",
      "PREMIUM-2xCPU-4GB",
    ]);
    await c.catalog().listOffers();
    expect(paths(calls)).toEqual(["GET /plan"]);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps every plan when UpCloud's plan list fails", async () => {
    const { connector: c } = connector({
      "GET /plan": upcloudError(401, "AUTHENTICATION_FAILED", "Authentication failed."),
    });
    const offers = await c.catalog().listOffers("de-fra1");
    expect(offers.every((offer) => offer.available)).toBe(true);
  });

  it("reaches the account through its server API, with the injected clock and sleep", async () => {
    const {
      connector: c,
      calls,
      waits,
    } = connector({
      "GET /server": serverList(listed("shop"), listed("shop-worker", { uuid: WORKER_ID })),
      [`GET /server/${SHOP_ID}`]: [details("stopped"), details("maintenance"), details("started")],
      [`POST /server/${SHOP_ID}/start`]: details("maintenance"),
    });
    expect(await c.servers?.findAppServers("shop")).toEqual([
      { id: SHOP_ID, name: "shop", status: "started" },
      { id: WORKER_ID, name: "shop-worker", status: "started" },
    ]);
    await c.servers?.powerOn(SHOP_ID);
    expect(waits).toEqual([3_000]);
    expect(paths(calls)).toContain(`POST /server/${SHOP_ID}/start`);
  });
});

describe("verifyCredentials", () => {
  it("names the missing token, how to make one and why a sub-account, and calls nothing", async () => {
    const { connector: c, calls } = connector({}, {});
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/^UPCLOUD_TOKEN is not set: /);
    expect(check.message).toContain("a sub-account limited to servers and storage");
    expect(calls).toEqual([]);
  });

  it("reads the account and says its user name, credits and limits", async () => {
    const { connector: c, calls } = connector({ "GET /account": ACCOUNT });
    expect(await c.verifyCredentials()).toEqual({
      ok: true,
      identity: "opscrew-deploy",
      message:
        "The UpCloud token works: it belongs to the account opscrew-deploy, whose credits are 99.72 in the account's currency. The account's limits: 200 cores, 1024 GB of memory, 10 GB of MaxIOPS storage and 100 public IPv4 addresses.",
    });
    expect(paths(calls)).toEqual(["GET /account"]);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("says the limits UpCloud shows, or that it showed none", async () => {
    const some = connector({
      "GET /account": account({ credits: 0, resource_limits: { cores: 1 } }),
    });
    expect((await some.connector.verifyCredentials()).message).toBe(
      "The UpCloud token works: it belongs to the account opscrew-deploy, whose credits are 0.00 in the account's currency. The account's limits: 1 core.",
    );
    const none = connector({ "GET /account": account({ resource_limits: undefined }) });
    expect((await none.connector.verifyCredentials()).message).toBe(
      "The UpCloud token works: it belongs to the account opscrew-deploy, whose credits are 99.72 in the account's currency. UpCloud showed no limits for the account.",
    );
  });

  it("shows UpCloud's refusal in plain English, with how to make a token", async () => {
    const { connector: c } = connector({
      "GET /account": upcloudError(401, "AUTHENTICATION_FAILED", "Authentication failed."),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("UpCloud refused the token in UPCLOUD_TOKEN");
    expect(check.message).toContain("Authentication failed.");
    expect(check.message).toContain("Account → API tokens");
  });
});

describe("connector leaks", () => {
  it("puts the token in no check, even when UpCloud repeats it", async () => {
    const echo = `bad ${TOKEN}`;
    const replies: FakeReply[] = [
      upcloudError(401, "AUTHENTICATION_FAILED", echo),
      upcloudError(403, `CODE_${TOKEN}`, echo),
      { status: 500, text: echo },
      { error: new Error(echo) },
      { body: { unexpected: echo } },
      account({ username: echo }),
    ];
    const checks = await Promise.all(
      replies.map((reply) => connector({ "GET /account": reply }).connector.verifyCredentials()),
    );
    expect(checks.map((check) => check.ok)).toEqual([false, false, false, false, false, true]);
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });
});
