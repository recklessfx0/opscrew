import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  fakeTime,
  serverState,
  storageState,
  TOKEN,
  TOKEN_ENV,
  upcloudError,
  upcloudFetch,
} from "./__fixtures__/client";
import {
  readUpcloudCredentials,
  UPCLOUD_API_URL,
  UPCLOUD_ENV,
  UpcloudClient,
  UpcloudStatusError,
} from "./client";

const servers = z.looseObject({
  servers: z.looseObject({ server: z.array(z.looseObject({ uuid: z.string() })) }),
});
const backup = z.looseObject({ storage: z.looseObject({ uuid: z.string() }) });
const WAIT = { what: "stop the server", timeoutMs: 10 * 60_000 };
const STOP = "/server/srv-1/stop";
const BACKUP = "/storage/sto-1/backup";
const PANEL = "UpCloud's control panel (https://hub.upcloud.com/)";

function setup(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { version?: string; timeoutMs?: number } = {},
) {
  const fake = upcloudFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the token is registered when it is read.
  readUpcloudCredentials(TOKEN_ENV, redactor);
  const client = new UpcloudClient({
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

describe("readUpcloudCredentials", () => {
  it("names UPCLOUD_TOKEN alone", () => {
    expect(UPCLOUD_ENV).toEqual({ token: "UPCLOUD_TOKEN" });
  });

  it("returns the token, registering it with the redactor", () => {
    expect(TOKEN).toMatch(/^ucat_[0-9A-HJKMNP-TV-Z]{26}$/);
    const redactor = new Redactor();
    expect(readUpcloudCredentials(TOKEN_ENV, redactor)).toEqual({ token: TOKEN });
    expect(redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it.each([{}, { UPCLOUD_TOKEN: "" }, { UPCLOUD_TOKEN: "  " }])(
    "names a missing or blank UPCLOUD_TOKEN, how to make one and why a sub-account (%j)",
    (env) => {
      const read = readUpcloudCredentials(env, new Redactor());
      expect("token" in read).toBe(false);
      const problem = "problem" in read ? read.problem : "";
      expect(problem).toMatch(
        /^UPCLOUD_TOKEN is not set: OpsCrew signs in to UpCloud with an API token only\. /,
      );
      expect(problem).toContain(PANEL);
      expect(problem).toContain("API tokens");
      expect(problem).toContain("sub-account limited to servers and storage");
      expect(problem).toContain("90 days or less");
    },
  );

  it("never reads UPCLOUD_USERNAME or UPCLOUD_PASSWORD, with or without a token", () => {
    for (const base of [TOKEN_ENV, {}]) {
      const read: string[] = [];
      const env = new Proxy(
        { ...base, UPCLOUD_USERNAME: "someone", UPCLOUD_PASSWORD: "x" },
        {
          get(target, key, receiver) {
            if (typeof key === "string") read.push(key);
            return Reflect.get(target, key, receiver);
          },
        },
      ) as Record<string, string | undefined>;
      readUpcloudCredentials(env, new Redactor());
      expect(read).toEqual(["UPCLOUD_TOKEN"]);
    }
  });
});

describe("UpcloudClient requests", () => {
  it("sends Authorization: Bearer to api.upcloud.com/1.3 and parses each answer with the caller's schema", async () => {
    const list = { servers: { server: [{ uuid: "srv-1", title: "shop", extra: 1 }] } };
    const { client, calls } = setup(
      {
        "GET /server": { body: list },
        [`POST ${BACKUP}`]: { status: 201, body: { storage: { uuid: "bak-1" } } },
        "PUT /server/srv-1": { body: { server: { uuid: "srv-1" } } },
        "DELETE /storage/bak-1": { status: 204 },
      },
      { version: "9.9.9" },
    );

    await expect(client.get("/server", servers, { label: "opscrew-app=shop" })).resolves.toEqual(
      list,
    );
    await expect(
      client.post(BACKUP, backup, { storage: { title: "opscrew-shop-web-1" } }),
    ).resolves.toEqual({ storage: { uuid: "bak-1" } });
    await client.put("/server/srv-1", z.unknown(), { server: { title: "shop" } });
    await expect(client.delete("/storage/bak-1", z.undefined())).resolves.toBeUndefined();

    expect(UPCLOUD_API_URL).toBe("https://api.upcloud.com/1.3");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${UPCLOUD_API_URL}/server?label=opscrew-app%3Dshop`,
      `POST ${UPCLOUD_API_URL}${BACKUP}`,
      `PUT ${UPCLOUD_API_URL}/server/srv-1`,
      `DELETE ${UPCLOUD_API_URL}/storage/bak-1`,
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        "User-Agent": "opscrew/9.9.9",
      });
    }
    expect(calls[1]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[1]?.body).toEqual({ storage: { title: "opscrew-shop-web-1" } });
    expect(calls[2]?.body).toEqual({ server: { title: "shop" } });
  });

  it("sends a delete's query and a post without a body", async () => {
    const { client, calls } = setup({
      "DELETE /server/srv-1": { status: 204 },
      [`POST ${STOP}`]: { body: { server: { uuid: "srv-1" } } },
    });
    await client.delete("/server/srv-1", z.undefined(), { storages: "1", backups: "keep" });
    await client.post(STOP, z.unknown());
    expect(calls[0]?.path).toBe("/server/srv-1?storages=1&backups=keep");
    expect(calls[1]?.body).toBeUndefined();
    expect(calls[1]?.headers["Content-Type"]).toBeUndefined();
  });

  it("refuses an answer that doesn't match the caller's schema", async () => {
    const { client } = setup({ "GET /server": { body: { server: [] } } });
    const error = await failure(client.get("/server", servers));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/^UpCloud returned an unexpected answer for GET \/server: /);
    expect(error.hint).toBe("The UpCloud API may have changed; please report this to OpsCrew.");
  });

  it("refuses an answer that isn't JSON", async () => {
    const { client } = setup({ "GET /server": { text: "<html>" } });
    const error = await failure(client.get("/server", servers));
    expect(error.message).toBe("UpCloud returned invalid JSON for GET /server.");
  });
});

describe("UpcloudClient waits for a state", () => {
  it("reads a server every 3 seconds until it is stopped", async () => {
    const { client, calls, time } = setup({
      "GET /server/srv-1": [
        serverState("started"),
        serverState("maintenance"),
        serverState("stopped"),
      ],
    });
    await expect(client.awaitServer("srv-1", "stopped", WAIT)).resolves.toMatchObject({
      uuid: "srv-1",
      state: "stopped",
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /server/srv-1",
      "GET /server/srv-1",
      "GET /server/srv-1",
    ]);
    expect(time.waits).toEqual([3000, 3000]);
  });

  it("reads a server until it is started", async () => {
    const { client } = setup({
      "GET /server/srv-1": [serverState("maintenance"), serverState("started")],
    });
    await expect(
      client.awaitServer("srv-1", "started", { what: "start the server", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ state: "started" });
  });

  it("reads a storage until it is online", async () => {
    const { client, time } = setup({
      "GET /storage/sto-1": [storageState("backuping"), storageState("online")],
    });
    await expect(
      client.awaitStorage("sto-1", { what: "back up the disk", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ uuid: "sto-1", state: "online" });
    expect(time.waits).toEqual([3000]);
  });

  it("fails plainly when a server goes into its error state", async () => {
    const { client, time } = setup({
      "GET /server/srv-1": [serverState("maintenance"), serverState("error")],
    });
    const error = await failure(client.awaitServer("srv-1", "stopped", WAIT));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "UpCloud's request to stop the server failed: the server is in UpCloud's error state, which means UpCloud's cloud service can't reach it.",
    );
    expect(error.hint).toBe(
      `Check the server in ${PANEL}, and contact UpCloud's support if it stays in its error state.`,
    );
    expect(time.waits).toEqual([3000]);
  });

  it("fails plainly when a storage goes into its error state", async () => {
    const { client } = setup({ "GET /storage/sto-1": storageState("error") });
    const error = await failure(
      client.awaitStorage("sto-1", { what: "back up the disk", timeoutMs: 60_000 }),
    );
    expect(error.message).toBe(
      "UpCloud's request to back up the disk failed: the disk is in UpCloud's error state, which means UpCloud's cloud service can't reach it.",
    );
    expect(error.hint).toBe(
      `Check the disk in ${PANEL}, and contact UpCloud's support if it stays in its error state.`,
    );
  });

  it("stops at the timeout with a plain message, never waiting past it", async () => {
    const { client, calls, time } = setup({ "GET /server/srv-1": serverState("started") });
    const error = await failure(
      client.awaitServer("srv-1", "stopped", { ...WAIT, timeoutMs: 7_000 }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      'UpCloud\'s request to stop the server did not finish within 7 seconds: the server is still "started".',
    );
    expect(error.hint).toBe(
      `It may still finish: check the server in ${PANEL} before trying again.`,
    );
    expect(time.waits).toEqual([3000, 3000, 1000]);
    expect(calls).toHaveLength(4);
  });

  it("refuses a state it doesn't know", async () => {
    const { client } = setup({ "GET /server/srv-1": serverState("paused") });
    const error = await failure(client.awaitServer("srv-1", "stopped", WAIT));
    expect(error.message).toMatch(
      /^UpCloud returned an unexpected answer for GET \/server\/srv-1: /,
    );
  });
});

describe("UpcloudClient errors", () => {
  it("says a 401 is a wrong or expired token, and how to make one", async () => {
    const { client } = setup({
      "GET /account": upcloudError(
        401,
        "AUTHENTICATION_FAILED",
        "Authentication failed using the given username and password.",
      ),
    });
    const error = await failure(client.get("/account", z.unknown()));
    expect(error).toBeInstanceOf(UpcloudStatusError);
    expect((error as UpcloudStatusError).status).toBe(401);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "UpCloud refused the token in UPCLOUD_TOKEN (HTTP 401, AUTHENTICATION_FAILED, GET /account): Authentication failed using the given username and password.",
    );
    expect(error.hint).toMatch(/^The token is wrong or has expired\. In UpCloud's control panel/);
    expect(error.hint).toContain("UPCLOUD_TOKEN");
  });

  it("says a 402 means too few credits, and to add some", async () => {
    const { client } = setup({
      [`POST ${BACKUP}`]: upcloudError(
        402,
        "INSUFFICIENT_CREDITS",
        "There are not enough credits to perform the requested action.",
      ),
    });
    const error = await failure(client.post(BACKUP, backup, {}));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `UpCloud refused POST ${BACKUP}: your UpCloud account has too few credits (HTTP 402, INSUFFICIENT_CREDITS): There are not enough credits to perform the requested action.`,
    );
    expect(error.hint).toBe(
      `Add credits to your UpCloud account in ${PANEL}, then try again. UpCloud bills from prepaid credits and disables the account's servers while it has none.`,
    );
  });

  it.each([
    ["SERVER_FORBIDDEN", "this server", "servers"],
    ["STORAGE_FORBIDDEN", "this storage", "storage"],
  ])("names the access a 403 %s lacks", async (code, thing, access) => {
    const { client } = setup({
      [`POST ${STOP}`]: upcloudError(
        403,
        code,
        "The resource exists, but is owned by another account.",
      ),
    });
    const error = await failure(client.post(STOP, z.unknown(), {}));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      `UpCloud refused POST ${STOP} (HTTP 403, ${code}): the token's account has no access to ${thing}. The resource exists, but is owned by another account.`,
    );
    expect(error.hint).toBe(
      `If the token belongs to a sub-account, give that sub-account access to ${access} in ${PANEL}, or use a token of the account that owns it, then try again.`,
    );
  });

  it("says a 403 without a code is missing access", async () => {
    const { client } = setup({ "GET /account": { status: 403, text: "" } });
    const error = await failure(client.get("/account", z.unknown()));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "UpCloud refused GET /account (HTTP 403): the token's account has no access to this.",
    );
    expect(error.hint).toBe(
      `If the token belongs to a sub-account, give that sub-account the access this needs in ${PANEL}, or use a token of the main account, then try again.`,
    );
  });

  it.each([
    ["SERVER_CORE_LIMIT_REACHED", "cores", "Server core account quota limit reached."],
    [
      "MAXIOPS_STORAGE_LIMIT_REACHED",
      "MaxIOPS storage",
      "MaxIOPS storage account quota limit reached.",
    ],
    ["SERVER_IP_LIMIT_REACHED", "server IP addresses", "Server IP account quota limit reached."],
  ])("names a resource limit (%s) and says support raises it", async (code, name, text) => {
    const { client } = setup({ "POST /server/srv-1/start": upcloudError(403, code, text) });
    const error = await failure(client.post("/server/srv-1/start", z.unknown()));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `UpCloud refused POST /server/srv-1/start: your UpCloud account's limit on ${name} was reached (HTTP 403, ${code}): ${text}`,
    );
    expect(error.hint).toBe(
      "UpCloud's support raises an account's resource limits: ask it to raise this one, or remove what you no longer need, then try again.",
    );
  });

  it("names another 403 as UpCloud says it", async () => {
    const { client } = setup({
      "POST /server": upcloudError(
        403,
        "PLAN_CORE_NUMBER_ILLEGAL",
        "The specified core_number does not match the selected plan.",
      ),
    });
    const error = await failure(client.post("/server", z.unknown(), {}));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "UpCloud refused POST /server (HTTP 403, PLAN_CORE_NUMBER_ILLEGAL): The specified core_number does not match the selected plan.",
    );
    expect(error.hint).toBe("Fix what UpCloud named above, then try again.");
  });

  it("says a 404 is a resource UpCloud didn't find", async () => {
    const { client } = setup({
      "GET /server/srv-9": upcloudError(
        404,
        "SERVER_NOT_FOUND",
        "The server srv-9 does not exist.",
      ),
    });
    const error = await failure(client.get("/server/srv-9", z.unknown()));
    expect((error as UpcloudStatusError).status).toBe(404);
    expect(error.message).toBe(
      "UpCloud found no such resource (GET /server/srv-9, SERVER_NOT_FOUND): The server srv-9 does not exist.",
    );
    expect(error.hint).toBe(`It may have been deleted: check your UpCloud account in ${PANEL}.`);
  });

  it("names the server's state after a 409 SERVER_STATE_ILLEGAL", async () => {
    const { client, calls } = setup({
      [`POST ${STOP}`]: upcloudError(
        409,
        "SERVER_STATE_ILLEGAL",
        "The server is in a state in which it cannot be used.",
      ),
      "GET /server/srv-1": serverState("maintenance"),
    });
    const error = await failure(client.post(STOP, z.unknown(), {}));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `UpCloud refused POST ${STOP}: the server is "maintenance" (HTTP 409, SERVER_STATE_ILLEGAL): The server is in a state in which it cannot be used.`,
    );
    expect(error.hint).toBe(
      "Wait for any change in progress to finish, and start or stop the server as this needs (a stop needs it started; a start, a disk restore and a delete need it stopped), then try again.",
    );
    // The post itself was sent once.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${STOP}`,
      "GET /server/srv-1",
    ]);
  });

  it("names the disk's state after a 409 STORAGE_STATE_ILLEGAL", async () => {
    const { client } = setup({
      [`POST ${BACKUP}`]: upcloudError(
        409,
        "STORAGE_STATE_ILLEGAL",
        "The storage is in a state in which it cannot be used.",
      ),
      "GET /storage/sto-1": storageState("backuping"),
    });
    const error = await failure(client.post(BACKUP, backup, {}));
    expect(error.message).toBe(
      `UpCloud refused POST ${BACKUP}: the disk is "backuping" (HTTP 409, STORAGE_STATE_ILLEGAL): The storage is in a state in which it cannot be used.`,
    );
    expect(error.hint).toBe(
      "Wait until the disk is online again (a backup or another change in progress must finish first), then try again.",
    );
  });

  it("says which state is wrong when the path doesn't name it, or its read fails", async () => {
    const restore = "/storage/bak-1/restore";
    const { client, calls } = setup({
      [`POST ${restore}`]: upcloudError(409, "SERVER_STATE_ILLEGAL", "The server is started."),
    });
    const error = await failure(client.post(restore, z.unknown()));
    expect(error.message).toBe(
      `UpCloud refused POST ${restore}: the server is in a state that doesn't allow this (HTTP 409, SERVER_STATE_ILLEGAL): The server is started.`,
    );
    expect(calls).toHaveLength(1);

    const gone = setup({
      [`POST ${STOP}`]: upcloudError(409, "SERVER_STATE_ILLEGAL", "Illegal state."),
      "GET /server/srv-1": upcloudError(404, "SERVER_NOT_FOUND", "Gone."),
    });
    const unread = await failure(gone.client.post(STOP, z.unknown()));
    expect(unread.message).toBe(
      `UpCloud refused POST ${STOP}: the server is in a state that doesn't allow this (HTTP 409, SERVER_STATE_ILLEGAL): Illegal state.`,
    );
    expect(gone.calls).toHaveLength(2);
  });

  it("reads no state after a read refused with a state error", async () => {
    const { client, calls } = setup({
      "GET /server/srv-1": upcloudError(409, "SERVER_STATE_ILLEGAL", "Illegal state."),
    });
    const error = await failure(client.get("/server/srv-1", z.unknown()));
    expect(error.message).toBe(
      "UpCloud refused GET /server/srv-1: the server is in a state that doesn't allow this (HTTP 409, SERVER_STATE_ILLEGAL): Illegal state.",
    );
    expect(calls).toHaveLength(1);
  });

  it("names another 409 as UpCloud says it", async () => {
    const { client } = setup({
      "DELETE /storage/sto-1": upcloudError(
        409,
        "STORAGE_ATTACHED",
        "The storage is attached to a server.",
      ),
    });
    const error = await failure(client.delete("/storage/sto-1", z.undefined()));
    expect(error.message).toBe(
      "UpCloud refused DELETE /storage/sto-1 (HTTP 409, STORAGE_ATTACHED): The storage is attached to a server.",
    );
    expect(error.hint).toBe("Fix what UpCloud named above, then try again.");
  });

  it("waits on a read's 429, at most 60 seconds in all, then says to wait", async () => {
    const { client, calls, time } = setup({
      "GET /server": upcloudError(429, "TOO_MANY_REQUESTS", "Too many requests."),
    });
    const error = await failure(client.get("/server", servers));
    expect(error.message).toBe(
      "UpCloud's rate limit was reached (GET /server, TOO_MANY_REQUESTS): Too many requests.",
    );
    expect(error.hint).toBe("Wait a minute and try again.");
    expect(time.waits).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(time.waits.reduce((a, b) => a + b)).toBe(60_000);
    expect(calls).toHaveLength(6);
  });

  it("goes on once a read's 429 has passed", async () => {
    const { client, time } = setup({
      "GET /server": [{ status: 429 }, { body: { servers: { server: [] } } }],
    });
    await expect(client.get("/server", servers)).resolves.toEqual({ servers: { server: [] } });
    expect(time.waits).toEqual([2000]);
  });

  it("says UpCloud failed on its side after a 5xx, and that a change may have been made", async () => {
    const { client } = setup({ "/": upcloudError(503, "SERVICE_UNAVAILABLE", "Maintenance.") });
    const read = await failure(client.get("/server", servers));
    expect(read.message).toBe(
      "UpCloud answered HTTP 503 to GET /server (SERVICE_UNAVAILABLE): Maintenance.",
    );
    expect(read.hint).toBe(
      "UpCloud failed on its side: try again in a few minutes, and contact UpCloud's support if it keeps failing.",
    );
    const write = await failure(client.post(STOP, z.unknown()));
    expect(write.hint).toBe(
      `UpCloud failed on its side, and the change may still have been made: check your UpCloud account in ${PANEL} before trying again.`,
    );
  });

  it("says the status alone when the body names nothing", async () => {
    const { client } = setup({ "GET /server": { status: 500, text: "oops" } });
    const error = await failure(client.get("/server", servers));
    expect(error.message).toBe("UpCloud answered HTTP 500 to GET /server.");
  });

  it("names a 400 as UpCloud says it", async () => {
    const { client } = setup({
      [`POST ${BACKUP}`]: upcloudError(
        400,
        "TITLE_MISSING",
        "The required attribute title is missing.",
      ),
    });
    const error = await failure(client.post(BACKUP, backup, {}));
    expect(error.message).toBe(
      `UpCloud refused POST ${BACKUP} (HTTP 400, TITLE_MISSING): The required attribute title is missing.`,
    );
    expect(error.hint).toBe("Fix what UpCloud named above, then try again.");
  });
});

describe("UpcloudClient never sends a write twice", () => {
  it.each<[string, FakeReply]>([
    ["a 429", upcloudError(429, "TOO_MANY_REQUESTS", "Too many requests.")],
    ["a 500", upcloudError(500, "INTERNAL_ERROR", "Internal error.")],
    ["a 503 without a body", { status: 503 }],
  ])("sends a post, a put and a delete once after %s", async (_, reply) => {
    const { client, calls, time } = setup({ "/": reply });
    await failure(client.post(STOP, z.unknown()));
    await failure(client.put("/server/srv-1", z.unknown(), {}));
    await failure(client.delete("/storage/sto-1", z.undefined()));
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(time.waits).toEqual([]);
  });

  it("sends a post once after no answer, saying it may have been made", async () => {
    const { client, calls } = setup({ [`POST ${STOP}`]: { error: new Error("socket hang up") } });
    const error = await failure(client.post(STOP, z.unknown()));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(`Lost the connection to UpCloud's API (POST ${STOP}).`);
    expect(error.hint).toBe(
      `The change may still have been made: check your UpCloud account in ${PANEL} before trying again.`,
    );
  });

  it("says the API did not answer in time", async () => {
    const { client, calls } = setup({ [`POST ${STOP}`]: { hang: true } }, { timeoutMs: 1_000 });
    const error = await failure(client.post(STOP, z.unknown()));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(`UpCloud's API did not answer within 1 second (POST ${STOP}).`);
  });

  it("says to check the connection after a read that got no answer", async () => {
    const { client } = setup({ "GET /server": { error: new Error("ECONNREFUSED") } });
    const error = await failure(client.get("/server", servers));
    expect(error.hint).toBe("Check your internet connection and try again.");
  });
});

describe("UpcloudClient leaks", () => {
  it("puts the token in no error, request line or body, nor in a fixture", async () => {
    const echo = `bad ${TOKEN}`;
    const failing: FakeReply[] = [
      ...[400, 401, 402, 403, 404, 409, 429, 500, 503].map((status) =>
        upcloudError(status, `CODE_${TOKEN}`, echo),
      ),
      upcloudError(403, "SERVER_CORE_LIMIT_REACHED", echo),
      upcloudError(409, "SERVER_STATE_ILLEGAL", echo),
      { status: 500, text: echo },
      { error: new Error(echo) },
      { body: { unexpected: echo } },
      { text: echo },
    ];
    const errors: OpsCrewError[] = [];
    const requests: FakeCall[] = [];
    for (const reply of failing) {
      const { client, calls } = setup({ "/": reply });
      errors.push(await failure(client.get("/server", servers)));
      errors.push(await failure(client.post(STOP, backup, {})));
      requests.push(...calls);
    }
    const { client, calls } = setup({ "GET /server/srv-1": serverState(echo) });
    errors.push(await failure(client.awaitServer("srv-1", "stopped", WAIT)));
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
