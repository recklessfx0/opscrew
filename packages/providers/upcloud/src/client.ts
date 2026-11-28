import type { FetchLike, ProviderRedactor } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  changedApiHint,
  durationText,
  type ErrorCode,
  type JsonClient,
  jsonClient,
  OpsCrewError,
  pollAction,
  RATE_LIMIT_HINT,
  type RequestFailure,
  type RetryRules,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";

/** UpCloud's API, version 1.3 (developers.upcloud.com/1.3/2-architecture/). */
export const UPCLOUD_API_URL = "https://api.upcloud.com/1.3";

/** UpCloud's control panel, where tokens, credits and sub-accounts are managed. */
export const UPCLOUD_CONTROL_PANEL_URL = "https://hub.upcloud.com/";

/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How often a server's or a storage's state is read while waiting for it. */
const STATE_INTERVAL_MS = 3_000;
/**
 * The waits before repeating a read UpCloud answered with 429, 60 seconds in all. UpCloud
 * documents no rate limit or `Retry-After`, so the read backs off.
 */
const RATE_LIMIT_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * The one environment variable OpsCrew reads for UpCloud: an API token. `UPCLOUD_USERNAME` and
 * `UPCLOUD_PASSWORD` are never read: UpCloud discourages Basic sign-in and will disable it.
 */
export const UPCLOUD_ENV = { token: "UPCLOUD_TOKEN" } as const;

const PANEL = `UpCloud's control panel (${UPCLOUD_CONTROL_PANEL_URL})`;

/** How to make the token, where it goes, and why under a sub-account. */
export const UPCLOUD_CREDENTIALS_HINT = `In ${PANEL}, open Account → API tokens and create a token, then set ${UPCLOUD_ENV.token} to it. A token acts with the rights of the account that made it and can't be limited to some resources, so make it as a sub-account limited to servers and storage, with an expiry of 90 days or less.`;

/**
 * The token from `env`, registered with `redactor` as soon as it is read; or a plain-English
 * `problem` naming `UPCLOUD_TOKEN` when it is missing (empty or blank). Without the token nothing
 * calls UpCloud.
 */
export function readUpcloudCredentials(
  env: Record<string, string | undefined>,
  redactor: ProviderRedactor,
): { token: string } | { problem: string } {
  const token = env[UPCLOUD_ENV.token];
  if (token === undefined || token.trim() === "") {
    return {
      problem: `${UPCLOUD_ENV.token} is not set: OpsCrew signs in to UpCloud with an API token only. ${UPCLOUD_CREDENTIALS_HINT}`,
    };
  }
  redactor.addLiteral(token, UPCLOUD_ENV.token);
  return { token };
}

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

/** A server's states (developers.upcloud.com/1.3/8-servers/, "Server states"). */
const serverStateSchema = z.enum(["started", "stopped", "maintenance", "error"]);

/** A storage's states (developers.upcloud.com/1.3/9-storages/, "Storage states"). */
const storageStateSchema = z.enum([
  "online",
  "maintenance",
  "cloning",
  "backuping",
  "syncing",
  "error",
]);

/** `GET /server/{uuid}`: `{ server: { uuid, state, … } }`. */
const serverSchema = z.looseObject({
  server: z.looseObject({ uuid: z.string(), state: serverStateSchema }),
});

/** `GET /storage/{uuid}`: `{ storage: { uuid, state, … } }`. */
const storageSchema = z.looseObject({
  storage: z.looseObject({ uuid: z.string(), state: storageStateSchema }),
});

/** A server as `GET /server/{uuid}` answers it, once it is in the awaited state. */
export type UpcloudServer = z.infer<typeof serverSchema>["server"];
/** A storage as `GET /storage/{uuid}` answers it, once it is online. */
export type UpcloudStorage = z.infer<typeof storageSchema>["storage"];

/** UpCloud's error answer: `{ error: { error_code, error_message } }` (2-architecture). */
const errorBodySchema = z.looseObject({
  error: z.looseObject({
    error_code: z.string().nullish(),
    error_message: z.string().nullish(),
  }),
});

/**
 * The account quotas UpCloud names in a 403 `*_LIMIT_REACHED` (8-servers, "Create server" and
 * "Start server"), in words; another such code is named from its own words.
 */
const LIMIT_NAMES: Record<string, string> = {
  SERVER_CORE: "cores",
  SERVER_MEMORY: "memory",
  HDD_STORAGE: "archive (HDD) storage",
  STANDARD_STORAGE: "standard storage",
  MAXIOPS_STORAGE: "MaxIOPS storage",
  SERVER_IP: "server IP addresses",
  NETWORK: "networks",
  DETACHED_FLOATING_IP: "detached floating IP addresses",
  NETWORK_PEERING: "network peerings",
};

/** What a 403 `*_FORBIDDEN` has no access to, and the sub-account access that grants it. */
const ACCESS: Record<string, { thing: string; access: string }> = {
  SERVER: { thing: "this server", access: "servers" },
  STORAGE: { thing: "this storage", access: "storage" },
  TAG: { thing: "this tag", access: "tags" },
  HOST: { thing: "this host", access: "hosts" },
};

// --- Client -------------------------------------------------------------------------------------

/** A path of UpCloud's API under `/1.3`, such as `/server`. */
export type UpcloudPath = `/${string}`;

export interface UpcloudClientOptions {
  /** `UPCLOUD_TOKEN`, from {@link readUpcloudCredentials}. */
  token: string;
  /** Masks the token in every error. */
  redactor: ProviderRedactor;
  fetch?: FetchLike;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay between reads of a state, and after a read's 429. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for a wait's timeout. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 30 seconds). */
  timeoutMs?: number;
}

/** What a wait is for, for its errors, and how long it may take. */
export interface UpcloudWait {
  /** Ends "UpCloud's request to <what> failed": `stop the server`. */
  what: string;
  timeoutMs: number;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

const NO_RETRY: RetryRules = {
  serverErrors: 0,
  serverErrorDelayMs: () => 0,
  rateLimits: 0,
  rateLimitDelayMs: () => 0,
};

/**
 * Typed client for UpCloud's API 1.3. Every request carries `Authorization: Bearer` with the
 * token, every answer is validated against the schema the caller passes, and every error is plain
 * English with its next step. UpCloud answers a change at once and carries it out after, so a
 * caller waits for the server's or the storage's state. Only a read answered with 429 is sent
 * again, after a wait (60 seconds in all); a write is never sent twice.
 */
export class UpcloudClient {
  readonly #token: string;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;
  readonly #writes: JsonClient;
  readonly #reads: JsonClient;

  constructor(options: UpcloudClientOptions) {
    this.#token = options.token;
    this.#redactor = options.redactor;
    this.#userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.#writes = jsonClient(options, { timeoutMs: REQUEST_TIMEOUT_MS, retry: NO_RETRY });
    this.#reads = {
      ...this.#writes,
      retry: {
        ...NO_RETRY,
        rateLimits: RATE_LIMIT_WAITS_MS.length,
        rateLimitDelayMs: (attempt) => RATE_LIMIT_WAITS_MS[attempt] ?? 0,
      },
    };
  }

  /** `GET path` (with `query`), its answer parsed with `schema`. */
  get<S extends z.ZodType>(
    path: UpcloudPath,
    schema: S,
    query?: Record<string, string>,
  ): Promise<z.output<S>> {
    return requestJson(this.#reads, this.#json("GET", path, schema, { query }));
  }

  /** `POST path` with the JSON `body`, if any, its answer parsed with `schema`. Never sent twice. */
  post<S extends z.ZodType>(path: UpcloudPath, schema: S, body?: unknown): Promise<z.output<S>> {
    return requestJson(this.#writes, this.#json("POST", path, schema, { body }));
  }

  /** `PUT path` with the JSON `body`, its answer parsed with `schema`. Never sent twice. */
  put<S extends z.ZodType>(path: UpcloudPath, schema: S, body: unknown): Promise<z.output<S>> {
    return requestJson(this.#writes, this.#json("PUT", path, schema, { body }));
  }

  /**
   * `DELETE path` (with `query`), its answer parsed with `schema` (`z.undefined()` for UpCloud's
   * empty 204). Never sent twice.
   */
  delete<S extends z.ZodType>(
    path: UpcloudPath,
    schema: S,
    query?: Record<string, string>,
  ): Promise<z.output<S>> {
    return requestJson(this.#writes, this.#json("DELETE", path, schema, { query }));
  }

  /**
   * The server, read through `GET /server/{uuid}` every 3 seconds until its `state` is `state`.
   * @throws OpsCrewError when the server is in UpCloud's `error` state, or not yet in `state`
   * after `wait.timeoutMs`.
   */
  async awaitServer(
    uuid: string,
    state: "started" | "stopped",
    wait: UpcloudWait,
  ): Promise<UpcloudServer> {
    const { server } = await this.#await(
      () => this.get(`/server/${uuid}`, serverSchema),
      ({ server }) => server.state,
      state,
      "server",
      wait,
    );
    return server;
  }

  /**
   * The storage, read through `GET /storage/{uuid}` every 3 seconds until its `state` is `online`.
   * @throws OpsCrewError when the storage is in UpCloud's `error` state, or not yet `online` after
   * `wait.timeoutMs`.
   */
  async awaitStorage(uuid: string, wait: UpcloudWait): Promise<UpcloudStorage> {
    const { storage } = await this.#await(
      () => this.get(`/storage/${uuid}`, storageSchema),
      ({ storage }) => storage.state,
      "online",
      "disk",
      wait,
    );
    return storage;
  }

  #await<T>(
    read: () => Promise<T>,
    stateOf: (answer: T) => string,
    target: string,
    thing: "server" | "disk",
    wait: UpcloudWait,
  ): Promise<T> {
    return pollAction({
      read,
      finished: (answer) => {
        const state = stateOf(answer);
        if (state === "error") {
          throw this.#failure(
            "PROVIDER_ERROR",
            `UpCloud's request to ${wait.what} failed: the ${thing} is in UpCloud's error state, which means UpCloud's cloud service can't reach it.`,
            `Check the ${thing} in ${PANEL}, and contact UpCloud's support if it stays in its error state.`,
          );
        }
        return state === target;
      },
      timedOut: (answer) =>
        this.#failure(
          "PROVIDER_ERROR",
          `UpCloud's request to ${wait.what} did not finish within ${durationText(wait.timeoutMs)}: the ${thing} is still "${stateOf(answer)}".`,
          `It may still finish: check the ${thing} in ${PANEL} before trying again.`,
        ),
      timeoutMs: wait.timeoutMs,
      intervalMs: STATE_INTERVAL_MS,
      sleep: this.#writes.sleep,
      now: this.#writes.now,
    });
  }

  #json<S extends z.ZodType>(
    method: Method,
    path: UpcloudPath,
    schema: S,
    options: { query?: Record<string, string> | undefined; body?: unknown },
  ) {
    return {
      url: `${UPCLOUD_API_URL}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "User-Agent": this.#userAgent },
      ...(options.query !== undefined && { query: options.query }),
      ...(options.body !== undefined && { body: options.body }),
      schema,
      fail: (failure: RequestFailure) => this.#error(failure, method, path),
    };
  }

  async #error(failure: RequestFailure, method: Method, path: UpcloudPath): Promise<OpsCrewError> {
    const request = `${method} ${path}`;
    switch (failure.kind) {
      case "unreachable": {
        const what = failure.timedOut
          ? `UpCloud's API did not answer within ${durationText(this.#writes.timeoutMs)}`
          : "Lost the connection to UpCloud's API";
        return this.#failure(
          "PROVIDER_ERROR",
          `${what} (${request}).`,
          method === "GET"
            ? CONNECTION_HINT
            : `The change may still have been made: check your UpCloud account in ${PANEL} before trying again.`,
        );
      }
      case "invalid-json":
        return this.#failure("PROVIDER_ERROR", `UpCloud returned invalid JSON for ${request}.`);
      case "unexpected":
        return this.#failure(
          "PROVIDER_ERROR",
          `UpCloud returned an unexpected answer for ${request}: ${failure.issues}`,
          changedApiHint("UpCloud"),
        );
      case "status":
        return this.#statusError(failure.response, method, path);
    }
  }

  async #statusError(
    response: Response,
    method: Method,
    path: UpcloudPath,
  ): Promise<UpcloudStatusError> {
    const { status } = response;
    const fail = (code: ErrorCode, message: string, hint: string) =>
      new UpcloudStatusError(
        status,
        code,
        this.#redactor.redact(message),
        this.#redactor.redact(hint),
      );
    const { code, message } = errorInfo(await response.text().catch(() => ""));
    const request = `${method} ${path}`;
    const said = message === undefined ? "." : `: ${message}`;
    const codeTail = code === undefined ? "" : `, ${code}`;
    const http = `(HTTP ${status}${codeTail})`;
    const fixIt = "Fix what UpCloud named above, then try again.";

    switch (status) {
      case 401:
        return fail(
          "CREDENTIALS_INVALID",
          `UpCloud refused the token in ${UPCLOUD_ENV.token} (HTTP 401${codeTail}, ${request})${said}`,
          `The token is wrong or has expired. ${UPCLOUD_CREDENTIALS_HINT}`,
        );
      case 402:
        return fail(
          "PROVIDER_ERROR",
          `UpCloud refused ${request}: your UpCloud account has too few credits ${http}${said}`,
          `Add credits to your UpCloud account in ${PANEL}, then try again. UpCloud bills from prepaid credits and disables the account's servers while it has none.`,
        );
      case 403: {
        const limit = code?.match(/^(.+)_LIMIT_REACHED$/)?.[1];
        if (limit !== undefined) {
          const name = LIMIT_NAMES[limit] ?? limit.toLowerCase().replaceAll("_", " ");
          return fail(
            "PROVIDER_ERROR",
            `UpCloud refused ${request}: your UpCloud account's limit on ${name} was reached ${http}${said}`,
            "UpCloud's support raises an account's resource limits: ask it to raise this one, or remove what you no longer need, then try again.",
          );
        }
        const forbidden = code?.match(/^(.+)_FORBIDDEN$/)?.[1];
        if (code !== undefined && forbidden === undefined) {
          return fail("PROVIDER_ERROR", `UpCloud refused ${request} ${http}${said}`, fixIt);
        }
        const access = forbidden === undefined ? undefined : ACCESS[forbidden];
        const extra = message === undefined ? "" : ` ${message}`;
        return fail(
          "CREDENTIALS_INVALID",
          `UpCloud refused ${request} ${http}: the token's account has no access to ${access?.thing ?? "this"}.${extra}`,
          access === undefined
            ? `If the token belongs to a sub-account, give that sub-account the access this needs in ${PANEL}, or use a token of the main account, then try again.`
            : `If the token belongs to a sub-account, give that sub-account access to ${access.access} in ${PANEL}, or use a token of the account that owns it, then try again.`,
        );
      }
      case 404:
        return fail(
          "PROVIDER_ERROR",
          `UpCloud found no such resource (${request}${codeTail})${said}`,
          `It may have been deleted: check your UpCloud account in ${PANEL}.`,
        );
      case 409: {
        const thing =
          code === "SERVER_STATE_ILLEGAL"
            ? "server"
            : code === "STORAGE_STATE_ILLEGAL"
              ? "disk"
              : undefined;
        if (thing === undefined) {
          return fail("PROVIDER_ERROR", `UpCloud refused ${request} ${http}${said}`, fixIt);
        }
        return fail(
          "PROVIDER_ERROR",
          `UpCloud refused ${request}: the ${thing} is in a state that doesn't allow this ${http}${said}`,
          thing === "server"
            ? "Wait for any change in progress to finish, and start or stop the server as this needs (a stop needs it started; a start, a disk restore and a delete need it stopped), then try again."
            : "Wait until the disk is online again (a backup or another change in progress must finish first), then try again.",
        );
      }
      case 429:
        return fail(
          "PROVIDER_ERROR",
          `UpCloud's rate limit was reached (${request}${codeTail})${said}`,
          RATE_LIMIT_HINT,
        );
    }
    if (status < 500 && (code !== undefined || message !== undefined)) {
      return fail("PROVIDER_ERROR", `UpCloud refused ${request} ${http}${said}`, fixIt);
    }
    return fail(
      "PROVIDER_ERROR",
      `UpCloud answered HTTP ${status} to ${request}${code === undefined ? "" : ` (${code})`}${said}`,
      status < 500
        ? `Check your UpCloud account in ${PANEL}, then try again.`
        : method === "GET"
          ? "UpCloud failed on its side: try again in a few minutes, and contact UpCloud's support if it keeps failing."
          : `UpCloud failed on its side, and the change may still have been made: check your UpCloud account in ${PANEL} before trying again.`,
    );
  }

  /** An `OpsCrewError` with its message and hint passed through the redactor. */
  #failure(code: ErrorCode, message: string, hint?: string): OpsCrewError {
    return new OpsCrewError(code, this.#redactor.redact(message), {
      ...(hint !== undefined && { hint: this.#redactor.redact(hint) }),
    });
  }
}

/** An error of a request UpCloud answered with an error `status` (a 404 when a thing is gone). */
export class UpcloudStatusError extends OpsCrewError {
  constructor(
    readonly status: number,
    code: ErrorCode,
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
  }
}

/** An error answer's `error_code` and `error_message`, each `undefined` when it says nothing. */
function errorInfo(text: string): { code?: string; message?: string } {
  const parsed = errorBodySchema.safeParse(parseJson(text));
  if (!parsed.success) return {};
  const code = parsed.data.error.error_code?.trim();
  const message = parsed.data.error.error_message?.trim();
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
