import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accepted,
  fakeTime,
  ionosError,
  ionosFetch,
  requestStatus,
  TOKEN,
  TOKEN_ENV,
} from "./__fixtures__/client";
import {
  IONOS_API_URL,
  IONOS_ENV,
  IonosClient,
  IonosStatusError,
  readIonosCredentials,
} from "./client";

const datacenters = z.looseObject({
  items: z.array(
    z.looseObject({ id: z.string(), properties: z.looseObject({ name: z.string() }) }),
  ),
});
const snapshot = z.looseObject({ id: z.string() });
const WAIT = { what: "stop the server", timeoutMs: 10 * 60_000 };
const STOP = "/datacenters/dc-1/servers/srv-1/stop";

function setup(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { apiUrl?: string; version?: string; timeoutMs?: number } = {},
) {
  const fake = ionosFetch(routes, extra.apiUrl);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the token is registered when it is read.
  readIonosCredentials(TOKEN_ENV, redactor);
  const client = new IonosClient({
    token: TOKEN,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
    ...extra,
  });
  return { client, calls: fake.calls, time };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const errorText = (error: OpsCrewError) =>
  `${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`;

describe("readIonosCredentials", () => {
  it("names IONOS_TOKEN alone", () => {
    expect(IONOS_ENV).toEqual({ token: "IONOS_TOKEN" });
  });

  it("returns the token and the default API, registering the token with the redactor", () => {
    const redactor = new Redactor();
    expect(readIonosCredentials(TOKEN_ENV, redactor)).toEqual({
      token: TOKEN,
      apiUrl: IONOS_API_URL,
    });
    expect(IONOS_API_URL).toBe("https://api.ionos.com/cloudapi/v6");
    expect(redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it.each([{}, { IONOS_TOKEN: "" }, { IONOS_TOKEN: "  " }])(
    "names a missing or blank IONOS_TOKEN and how to make one (%j)",
    (env) => {
      const read = readIonosCredentials(env, new Redactor());
      expect("token" in read).toBe(false);
      expect("problem" in read && read.problem).toMatch(
        /^IONOS_TOKEN is not set: OpsCrew signs in to IONOS Cloud with a token only\. .*Token Manager/,
      );
    },
  );

  it("never reads IONOS_USERNAME or IONOS_PASSWORD, with or without a token", () => {
    for (const base of [TOKEN_ENV, {}]) {
      const read: string[] = [];
      const env = new Proxy(
        { ...base, IONOS_USERNAME: "someone@example.test", IONOS_PASSWORD: "x" },
        {
          get(target, key, receiver) {
            if (typeof key === "string") read.push(key);
            return Reflect.get(target, key, receiver);
          },
        },
      ) as Record<string, string | undefined>;
      readIonosCredentials(env, new Redactor());
      expect(read).not.toContain("IONOS_USERNAME");
      expect(read).not.toContain("IONOS_PASSWORD");
    }
  });

  it("takes IONOS_API_URL as the base, without a trailing slash", () => {
    const read = readIonosCredentials(
      { ...TOKEN_ENV, IONOS_API_URL: " https://ionos.example.test/cloudapi/v6/ " },
      new Redactor(),
    );
    expect(read).toEqual({ token: TOKEN, apiUrl: "https://ionos.example.test/cloudapi/v6" });
  });

  it.each(["http://api.ionos.com/cloudapi/v6", "api.ionos.com", "not a url"])(
    "refuses IONOS_API_URL=%s, which would send the token unencrypted or nowhere",
    (url) => {
      const read = readIonosCredentials({ ...TOKEN_ENV, IONOS_API_URL: url }, new Redactor());
      expect("token" in read).toBe(false);
      expect("problem" in read && read.problem).toMatch(
        /^IONOS_API_URL must be an https:\/\/ address\. /,
      );
    },
  );
});

describe("IonosClient requests", () => {
  it("sends Authorization: Bearer on every call and parses each answer with the caller's schema", async () => {
    const list = { items: [{ id: "dc-1", properties: { name: "opscrew-shop" }, extra: 1 }] };
    const { client, calls } = setup(
      {
        "GET /datacenters": { body: list },
        "POST /datacenters/dc-1/volumes/vol-1/create-snapshot": accepted("req-1", { id: "snap-1" }),
        "GET /requests/req-1/status": requestStatus("DONE"),
      },
      { version: "9.9.9" },
    );

    await expect(client.get("/datacenters", datacenters, { depth: "1" })).resolves.toEqual(list);
    await expect(
      client.post("/datacenters/dc-1/volumes/vol-1/create-snapshot", snapshot, WAIT, {
        properties: { name: "opscrew-shop-web-1" },
      }),
    ).resolves.toEqual({ id: "snap-1" });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${IONOS_API_URL}/datacenters?depth=1`,
      `POST ${IONOS_API_URL}/datacenters/dc-1/volumes/vol-1/create-snapshot`,
      `GET ${IONOS_API_URL}/requests/req-1/status`,
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        "User-Agent": "opscrew/9.9.9",
      });
    }
    expect(calls[1]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[1]?.body).toEqual({ properties: { name: "opscrew-shop-web-1" } });
  });

  it("sends every call to the base IONOS_API_URL set", async () => {
    const apiUrl = "https://ionos.example.test/cloudapi/v6";
    const { client, calls } = setup({ "GET /datacenters": { body: { items: [] } } }, { apiUrl });
    await client.get("/datacenters", datacenters);
    expect(calls[0]?.url).toBe(`${apiUrl}/datacenters`);
  });

  it("refuses an answer that doesn't match the caller's schema", async () => {
    const { client } = setup({ "GET /datacenters": { body: { datacenters: [] } } });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/^IONOS returned an unexpected answer for GET \/datacenters: /);
    expect(error.hint).toBe("The IONOS Cloud API may have changed; please report this to OpsCrew.");
  });

  it("refuses an answer that isn't JSON", async () => {
    const { client } = setup({ "GET /datacenters": { text: "<html>" } });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error.message).toBe("IONOS returned invalid JSON for GET /datacenters.");
  });
});

describe("IonosClient awaits a 202's request", () => {
  it("reads GET /requests/{id}/status from Location every 3 seconds until DONE", async () => {
    const { client, calls, time } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": [
        requestStatus("QUEUED"),
        requestStatus("RUNNING"),
        requestStatus("DONE", "Request has been successfully executed"),
      ],
    });

    await expect(client.post(STOP, z.undefined(), WAIT)).resolves.toBeUndefined();

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${STOP}`,
      "GET /requests/req-7/status",
      "GET /requests/req-7/status",
      "GET /requests/req-7/status",
    ]);
    expect(calls[0]?.body).toBeUndefined();
    expect(time.waits).toEqual([3000, 3000]);
  });

  it("awaits a delete's request the same way", async () => {
    const { client, calls } = setup({
      "DELETE /snapshots/snap-1": accepted("req-8"),
      "GET /requests/req-8/status": [requestStatus("RUNNING"), requestStatus("DONE")],
    });
    await client.delete("/snapshots/snap-1", z.undefined(), {
      what: "delete the snapshot",
      timeoutMs: 60_000,
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /snapshots/snap-1",
      "GET /requests/req-8/status",
      "GET /requests/req-8/status",
    ]);
  });

  it("reads the status from the API's own base, whatever host Location names", async () => {
    const { client, calls } = setup({
      [`POST ${STOP}`]: accepted("req-9", undefined, "https://elsewhere.example.test/cloudapi/v6"),
      "GET /requests/req-9/status": requestStatus("DONE"),
    });
    await client.post(STOP, z.undefined(), WAIT);
    expect(calls[1]?.url).toBe(`${IONOS_API_URL}/requests/req-9/status`);
  });

  it("doesn't wait for an answer that isn't 202", async () => {
    const { client, calls } = setup({
      "POST /datacenters/dc-1/servers/srv-1/start": { status: 200, body: { id: "srv-1" } },
    });
    await client.post("/datacenters/dc-1/servers/srv-1/start", snapshot, WAIT);
    expect(calls).toHaveLength(1);
  });

  it.each<[string, FakeReply]>([
    ["no Location", { status: 202 }],
    ["a Location without a request", { status: 202, headers: { Location: "https://x.test/y" } }],
  ])("refuses a 202 with %s, sending nothing more", async (_, reply) => {
    const { client, calls } = setup({ [`POST ${STOP}`]: reply });
    const error = await failure(client.post(STOP, z.undefined(), WAIT));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `IONOS accepted POST ${STOP} without the address of its request's status.`,
    );
    expect(error.hint).toBe("The IONOS Cloud API may have changed; please report this to OpsCrew.");
    expect(calls).toHaveLength(1);
  });

  it("fails with the request's message on FAILED", async () => {
    const { client } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": [
        requestStatus("RUNNING"),
        requestStatus("FAILED", "The server is locked by another request."),
      ],
    });
    const error = await failure(client.post(STOP, z.undefined(), WAIT));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "IONOS's request to stop the server failed: The server is locked by another request.",
    );
    expect(error.hint).toBe(
      "Fix what IONOS named, or check the data centre in IONOS's Data Center Designer, then try again.",
    );
  });

  it("says a FAILED request without a message failed", async () => {
    const { client } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": requestStatus("FAILED"),
    });
    const error = await failure(client.post(STOP, z.undefined(), WAIT));
    expect(error.message).toBe("IONOS's request to stop the server failed.");
  });

  it("stops at the timeout with a plain message, never waiting past it", async () => {
    const { client, calls, time } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": requestStatus("RUNNING"),
    });
    const error = await failure(client.post(STOP, z.undefined(), { ...WAIT, timeoutMs: 7_000 }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "IONOS's request to stop the server did not finish within 7 seconds.",
    );
    expect(error.hint).toBe(
      "It may still finish: check the data centre in IONOS's Data Center Designer before trying again.",
    );
    expect(time.waits).toEqual([3000, 3000, 1000]);
    expect(calls.filter((call) => call.path.startsWith("/requests/"))).toHaveLength(4);
  });

  it("refuses a status it doesn't know", async () => {
    const { client } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": requestStatus("PAUSED"),
    });
    const error = await failure(client.post(STOP, z.undefined(), WAIT));
    expect(error.message).toMatch(
      /^IONOS returned an unexpected answer for GET \/requests\/req-7\/status: /,
    );
  });
});

describe("IonosClient errors", () => {
  it("says a 401 is a wrong or expired token, and how to make one", async () => {
    const { client } = setup({
      "GET /datacenters": ionosError(401, "Unauthorized: the token has expired"),
    });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error).toBeInstanceOf(IonosStatusError);
    expect((error as IonosStatusError).status).toBe(401);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "IONOS refused the token in IONOS_TOKEN (HTTP 401, GET /datacenters): Unauthorized: the token has expired",
    );
    expect(error.hint).toMatch(/^The token is wrong or has expired\. .*Token Manager.*IONOS_TOKEN/);
  });

  it.each([
    ["POST", "/datacenters/dc-1/volumes/vol-1/create-snapshot", "Create Snapshot"],
    ["POST", "/datacenters", "Create Data Center"],
  ])("names the privilege a 403 on %s %s lacks", async (method, path, privilege) => {
    const { client } = setup({ [`${method} ${path}`]: ionosError(403, "Access denied") });
    const error = await failure(client.post(path as `/${string}`, z.unknown(), WAIT, {}));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      `IONOS refused ${method} ${path} (HTTP 403): the token's user lacks the "${privilege}" privilege. Access denied`,
    );
    expect(error.hint).toBe(
      `In IONOS's Data Center Designer, give the group of the token's user the "${privilege}" privilege (Users & Groups, the group's Privileges tab), then try again.`,
    );
  });

  it("says a 403 elsewhere needs Edit access to the data centre", async () => {
    const { client } = setup({ [`POST ${STOP}`]: ionosError(403, "Access denied") });
    const error = await failure(client.post(STOP, z.unknown(), WAIT));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      `IONOS refused POST ${STOP} (HTTP 403): the token's user has no access to this. Access denied`,
    );
    expect(error.hint).toBe(
      "In IONOS's Data Center Designer, give the group of the token's user Edit access to the data centre (Users & Groups, the group's Resources tab), or use a token of the user that created it, then try again.",
    );
  });

  it("says a 404 is a resource IONOS didn't find, naming IONOS_API_URL when it is set", async () => {
    const plain = setup({ "GET /datacenters/dc-1": ionosError(404, "Resource does not exist") });
    const error = await failure(plain.client.get("/datacenters/dc-1", z.unknown()));
    expect((error as IonosStatusError).status).toBe(404);
    expect(error.message).toBe(
      "IONOS found no such resource (GET /datacenters/dc-1): Resource does not exist",
    );
    expect(error.hint).toBe(
      "It may have been deleted: check your data centres in IONOS's Data Center Designer.",
    );

    const custom = setup(
      { "GET /datacenters/dc-1": ionosError(404, "Resource does not exist") },
      { apiUrl: "https://ionos.example.test/cloudapi/v6" },
    );
    const overridden = await failure(custom.client.get("/datacenters/dc-1", z.unknown()));
    expect(overridden.hint).toBe(
      "It may have been deleted: check your data centres in IONOS's Data Center Designer. If every request fails this way, check IONOS_API_URL, or unset it to use https://api.ionos.com/cloudapi/v6.",
    );
  });

  it("names what a 422 found invalid", async () => {
    const { client } = setup({
      "POST /datacenters/dc-1/volumes/vol-1/restore-snapshot": ionosError(
        422,
        "[(root).properties.snapshotId] Attribute is mandatory",
      ),
    });
    const error = await failure(
      client.post("/datacenters/dc-1/volumes/vol-1/restore-snapshot", z.unknown(), WAIT, {}),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "IONOS found POST /datacenters/dc-1/volumes/vol-1/restore-snapshot invalid (HTTP 422): [(root).properties.snapshotId] Attribute is mandatory",
    );
    expect(error.hint).toBe("Fix what IONOS named above, then try again.");
  });

  it.each([422, 403, 400])(
    "names a contract limit (HTTP %i) and says support raises it",
    async (status) => {
      const { client } = setup({
        "POST /datacenters/dc-1/volumes/vol-1/create-snapshot": ionosError(
          status,
          "The resource limit for snapshot storage has been exceeded",
        ),
      });
      const error = await failure(
        client.post("/datacenters/dc-1/volumes/vol-1/create-snapshot", z.unknown(), WAIT, {}),
      );
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        `IONOS refused POST /datacenters/dc-1/volumes/vol-1/create-snapshot: your contract's limit was reached (HTTP ${status}): The resource limit for snapshot storage has been exceeded`,
      );
      expect(error.hint).toBe(
        "IONOS's support raises a contract's limits: ask it to raise this one, or remove what you no longer need, then try again.",
      );
    },
  );

  it("waits on a read's 429, at most 60 seconds in all, then says to wait", async () => {
    const { client, calls, time } = setup({
      "GET /datacenters": ionosError(429, "Request rate limit exceeded"),
    });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error.message).toBe(
      "IONOS's rate limit was reached (GET /datacenters): Request rate limit exceeded",
    );
    expect(error.hint).toBe("Wait a minute and try again.");
    expect(time.waits).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(time.waits.reduce((a, b) => a + b)).toBe(60_000);
    expect(calls).toHaveLength(6);
  });

  it("goes on once a read's 429 has passed", async () => {
    const { client, time } = setup({
      "GET /datacenters": [ionosError(429, "Request rate limit exceeded"), { body: { items: [] } }],
    });
    await expect(client.get("/datacenters", datacenters)).resolves.toEqual({ items: [] });
    expect(time.waits).toEqual([2000]);
  });

  it("says IONOS failed on its side after a 5xx, and that a change may have been made", async () => {
    const { client } = setup({ "/": ionosError(503, "Service unavailable") });
    const read = await failure(client.get("/datacenters", datacenters));
    expect(read.message).toBe("IONOS answered HTTP 503 to GET /datacenters: Service unavailable");
    expect(read.hint).toBe(
      "IONOS failed on its side: try again in a few minutes, and contact IONOS's support if it keeps failing.",
    );
    const write = await failure(client.post(STOP, z.unknown(), WAIT));
    expect(write.hint).toBe(
      "IONOS failed on its side, and the change may still have been made: check the data centre in IONOS's Data Center Designer before trying again.",
    );
  });

  it("says the status alone when the body names nothing", async () => {
    const { client } = setup({ "GET /datacenters": { status: 500, text: "oops" } });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error.message).toBe("IONOS answered HTTP 500 to GET /datacenters.");
  });
});

describe("IonosClient never sends a write twice", () => {
  it.each<[string, FakeReply]>([
    ["a 429", ionosError(429, "Request rate limit exceeded")],
    ["a 500", ionosError(500, "Internal error")],
    ["a 503 without a body", { status: 503 }],
  ])("sends a post once after %s", async (_, reply) => {
    const { client, calls, time } = setup({ [`POST ${STOP}`]: reply });
    await failure(client.post(STOP, z.unknown(), WAIT));
    expect(calls).toHaveLength(1);
    expect(time.waits).toEqual([]);
  });

  it("sends a delete once after a 429", async () => {
    const { client, calls } = setup({
      "DELETE /snapshots/snap-1": ionosError(429, "Request rate limit exceeded"),
    });
    await failure(client.delete("/snapshots/snap-1", z.unknown(), WAIT));
    expect(calls).toHaveLength(1);
  });

  it("sends a post once after no answer, saying it may have been made", async () => {
    const { client, calls } = setup({ [`POST ${STOP}`]: { error: new Error("socket hang up") } });
    const error = await failure(client.post(STOP, z.unknown(), WAIT));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(`Lost the connection to IONOS's API (POST ${STOP}).`);
    expect(error.hint).toBe(
      "The change may still have been made: check the data centre in IONOS's Data Center Designer before trying again.",
    );
  });

  it("says the API did not answer in time", async () => {
    const { client, calls } = setup({ [`POST ${STOP}`]: { hang: true } }, { timeoutMs: 1_000 });
    const error = await failure(client.post(STOP, z.unknown(), WAIT));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(`IONOS's API did not answer within 1 second (POST ${STOP}).`);
  });

  it("says to check the connection after a read that got no answer", async () => {
    const { client } = setup({ "GET /datacenters": { error: new Error("ECONNREFUSED") } });
    const error = await failure(client.get("/datacenters", datacenters));
    expect(error.hint).toBe("Check your internet connection and try again.");
  });
});

describe("IonosClient leaks", () => {
  it("puts the token in no error, request line or body, nor in a fixture", async () => {
    const echo = `bad ${TOKEN}`;
    const failing: FakeReply[] = [
      ...[400, 401, 403, 404, 422, 429, 500, 503].map((status) => ionosError(status, echo)),
      { status: 500, text: echo },
      { error: new Error(echo) },
      { body: { unexpected: echo } },
      { text: echo },
    ];
    const errors: OpsCrewError[] = [];
    const requests: FakeCall[] = [];
    for (const reply of failing) {
      const { client, calls } = setup({ "/": reply });
      errors.push(await failure(client.get("/datacenters", datacenters)));
      errors.push(await failure(client.post(STOP, snapshot, WAIT, {})));
      requests.push(...calls);
    }
    const { client, calls } = setup({
      [`POST ${STOP}`]: accepted("req-7"),
      "GET /requests/req-7/status": requestStatus("FAILED", echo),
    });
    errors.push(await failure(client.post(STOP, z.undefined(), WAIT)));
    requests.push(...calls);

    for (const error of errors) expect(errorText(error)).not.toContain(TOKEN);
    // The token travels only in the Authorization header.
    const sent = JSON.stringify(requests.map(({ url, body }) => ({ url, body })));
    expect(sent).not.toContain(TOKEN);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      expect(await readFile(join(fixtures, name), "utf8")).not.toContain(TOKEN);
    }
  });
});
