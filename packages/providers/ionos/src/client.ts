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

/** IONOS's Cloud API v6, one front for every location (docs.ionos.com, Cloud API v6). */
export const IONOS_API_URL = "https://api.ionos.com/cloudapi/v6";

/** IONOS's guide to the Token Manager, where a token is made. */
export const IONOS_TOKEN_MANAGER_URL =
  "https://docs.ionos.com/cloud/set-up-ionos-cloud/management/identity-access-management/token-manager";

/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How often an accepted request's status is read. */
const REQUEST_INTERVAL_MS = 3_000;
/**
 * The waits before repeating a read IONOS answered with 429, 60 seconds in all. IONOS documents
 * no `Retry-After` for the Cloud API, so the read backs off.
 */
const RATE_LIMIT_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * The one environment variable OpsCrew reads for IONOS: a token. `IONOS_USERNAME` and
 * `IONOS_PASSWORD` are never read: Basic sign-in is being retired and needs an account without 2FA.
 */
export const IONOS_ENV = { token: "IONOS_TOKEN" } as const;

/** Overrides {@link IONOS_API_URL}, as it does for IONOS's Terraform provider. */
export const IONOS_API_URL_ENV = "IONOS_API_URL";

/** How to make the token and where it goes. */
export const IONOS_CREDENTIALS_HINT = `In IONOS's Data Center Designer, open the Token Manager (${IONOS_TOKEN_MANAGER_URL}) and generate a token, best as a sub-user whose group has only the "Create Data Center", "Create Snapshot" and "Reserve IP" privileges, then set ${IONOS_ENV.token} to it.`;

/**
 * The token from `env`, registered with `redactor` as soon as it is read, and the API's base
 * (`IONOS_API_URL` as {@link ionosApiUrl} reads it, else {@link IONOS_API_URL}); or a
 * plain-English `problem` naming `IONOS_TOKEN` when it is missing (empty or blank), or an
 * `IONOS_API_URL` that isn't an https:// address or a host name. Without the token nothing calls
 * IONOS.
 */
export function readIonosCredentials(
  env: Record<string, string | undefined>,
  redactor: ProviderRedactor,
): { token: string; apiUrl: string } | { problem: string } {
  const token = env[IONOS_ENV.token];
  if (token === undefined || token.trim() === "") {
    return {
      problem: `${IONOS_ENV.token} is not set: OpsCrew signs in to IONOS Cloud with a token only. ${IONOS_CREDENTIALS_HINT}`,
    };
  }
  redactor.addLiteral(token, IONOS_ENV.token);
  const value = env[IONOS_API_URL_ENV]?.trim();
  const apiUrl = value ? ionosApiUrl(value) : IONOS_API_URL;
  if (apiUrl === undefined) {
    return {
      problem: `${IONOS_API_URL_ENV} must be an https:// address or a host name, such as api.ionos.com. Unset it to use ${IONOS_API_URL}, or set it to one.`,
    };
  }
  return { token, apiUrl };
}

/**
 * The API's base from an `IONOS_API_URL`, read as IONOS's Go SDK reads it, since the same variable
 * sets the Terraform provider's endpoint (sdk-go `configuration.go` `getServerUrl`: `/cloudapi/v6`
 * added when the value doesn't end with it; `utils.go` `EnsureURLFormat`: a trailing `/` dropped
 * and `https://` added when there is no scheme). `undefined` for anything that isn't then an
 * https:// URL: the token travels in a header, so it goes to an https:// address only.
 */
function ionosApiUrl(value: string): string | undefined {
  let base = value.replace(/\/+$/, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `https://${base}`;
  if (!base.endsWith(BASE_PATH)) base = `${base}${BASE_PATH}`;
  return URL.parse(base)?.protocol === "https:" ? base : undefined;
}

/** The Cloud API v6's path on its host (sdk-go `DefaultIonosBasePath`). */
const BASE_PATH = "/cloudapi/v6";

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

/** `GET /requests/{requestId}/status`'s `RequestStatus`: its `metadata.status` and `message`. */
const requestStatusSchema = z.looseObject({
  metadata: z.looseObject({
    status: z.enum(["QUEUED", "RUNNING", "DONE", "FAILED"]),
    message: z.string().nullish(),
  }),
});

/** The Cloud API's `Error`: `{ httpStatus, messages: [{ errorCode, message }] }`. */
const errorBodySchema = z.looseObject({
  httpStatus: z.number().optional(),
  messages: z
    .array(z.looseObject({ errorCode: z.string().nullish(), message: z.string().nullish() }))
    .optional(),
});

/** Words of an answer refused by a contract's limit (unverified: no real one was seen). */
const LIMIT_WORDS = /\blimit|\bquota|\bexceed/i;

// --- Client -------------------------------------------------------------------------------------

/** A path of the Cloud API v6, such as `/datacenters`. */
export type IonosPath = `/${string}`;

export interface IonosClientOptions {
  /** `IONOS_TOKEN`, from {@link readIonosCredentials}. */
  token: string;
  /** The API's base (default {@link IONOS_API_URL}), from {@link readIonosCredentials}. */
  apiUrl?: string;
  /** Masks the token in every error. */
  redactor: ProviderRedactor;
  fetch?: FetchLike;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay between reads of a request's status, and after a read's 429. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for a request's timeout. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 30 seconds). */
  timeoutMs?: number;
}

/** What an accepted request does, for its errors, and how long it may take. */
export interface IonosWait {
  /** Ends "IONOS's request to <what> failed": `stop the server`. */
  what: string;
  timeoutMs: number;
}

type Method = "GET" | "POST" | "DELETE";

const NO_RETRY: RetryRules = {
  serverErrors: 0,
  serverErrorDelayMs: () => 0,
  rateLimits: 0,
  rateLimitDelayMs: () => 0,
};

/**
 * Typed client for IONOS's Cloud API v6. Every request carries `Authorization: Bearer` with the
 * token, every answer is validated against the schema the caller passes, and every error is plain
 * English with its next step. A write IONOS answers with 202 is awaited through its request's
 * status. Only a read answered with 429 is sent again, after a wait (60 seconds in all); a write
 * is never sent twice.
 */
export class IonosClient {
  readonly #token: string;
  readonly #apiUrl: string;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;
  readonly #writes: JsonClient;
  readonly #reads: JsonClient;

  constructor(options: IonosClientOptions) {
    this.#token = options.token;
    this.#apiUrl = options.apiUrl ?? IONOS_API_URL;
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
    path: IonosPath,
    schema: S,
    query?: Record<string, string>,
  ): Promise<z.output<S>> {
    return requestJson(this.#reads, this.#json("GET", path, schema, { query }));
  }

  /**
   * `POST path` with the JSON `body`, if any, its answer parsed with `schema`; a 202 is awaited
   * (see {@link IonosClient.delete}). Never sent twice.
   */
  post<S extends z.ZodType>(
    path: IonosPath,
    schema: S,
    wait: IonosWait,
    body?: unknown,
  ): Promise<z.output<S>> {
    return this.#write("POST", path, schema, wait, body);
  }

  /**
   * `DELETE path`, its answer parsed with `schema` (`z.undefined()` for an empty one). A 202 is
   * awaited: its `Location` names the request, whose status `GET /requests/{id}/status` is read
   * every 3 seconds until it is `DONE`. Never sent twice.
   * @throws OpsCrewError with the request's `message` when it is `FAILED`, or when it is still
   * running after `wait.timeoutMs`.
   */
  delete<S extends z.ZodType>(path: IonosPath, schema: S, wait: IonosWait): Promise<z.output<S>> {
    return this.#write("DELETE", path, schema, wait);
  }

  async #write<S extends z.ZodType>(
    method: Method,
    path: IonosPath,
    schema: S,
    wait: IonosWait,
    body?: unknown,
  ): Promise<z.output<S>> {
    // requestJson returns the body alone; the status and `Location` are kept from the answer.
    const seen = { status: 0, location: null as string | null };
    const http: JsonClient = {
      ...this.#writes,
      fetch: async (input, init) => {
        const response = await this.#writes.fetch(input, init);
        seen.status = response.status;
        seen.location = response.headers.get("Location");
        return response;
      },
    };
    const answer = await requestJson(http, this.#json(method, path, schema, { body }));
    if (seen.status !== 202) return answer;
    // The status is read from the API's own base, so the token never follows `Location` elsewhere.
    const id = /\/requests\/([^/]+)\/status\/?$/.exec(
      URL.parse(seen.location ?? "")?.pathname ?? "",
    )?.[1];
    if (id === undefined) {
      throw this.#failure(
        "PROVIDER_ERROR",
        `IONOS accepted ${method} ${path} without the address of its request's status.`,
        changedApiHint("IONOS Cloud"),
      );
    }
    await this.#awaitRequest(id, wait);
    return answer;
  }

  async #awaitRequest(id: string, wait: IonosWait): Promise<void> {
    const timedOut = () =>
      this.#failure(
        "PROVIDER_ERROR",
        `IONOS's request to ${wait.what} did not finish within ${durationText(wait.timeoutMs)}.`,
        "It may still finish: check the data centre in IONOS's Data Center Designer before trying again.",
      );
    await pollAction({
      read: () => this.get(`/requests/${id}/status`, requestStatusSchema),
      finished: ({ metadata }) => {
        if (metadata.status === "FAILED") {
          const message = metadata.message?.trim();
          throw this.#failure(
            "PROVIDER_ERROR",
            `IONOS's request to ${wait.what} failed${message ? `: ${message}` : "."}`,
            "Fix what IONOS named, or check the data centre in IONOS's Data Center Designer, then try again.",
          );
        }
        return metadata.status === "DONE";
      },
      timedOut,
      timeoutMs: wait.timeoutMs,
      intervalMs: REQUEST_INTERVAL_MS,
      sleep: this.#writes.sleep,
      now: this.#writes.now,
    });
  }

  #json<S extends z.ZodType>(
    method: Method,
    path: IonosPath,
    schema: S,
    options: { query?: Record<string, string> | undefined; body?: unknown },
  ) {
    return {
      url: `${this.#apiUrl}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "User-Agent": this.#userAgent },
      ...(options.query !== undefined && { query: options.query }),
      ...(options.body !== undefined && { body: options.body }),
      schema,
      fail: (failure: RequestFailure) => this.#error(failure, method, path),
    };
  }

  async #error(failure: RequestFailure, method: Method, path: IonosPath): Promise<OpsCrewError> {
    const request = `${method} ${path}`;
    switch (failure.kind) {
      case "unreachable": {
        const what = failure.timedOut
          ? `IONOS's API did not answer within ${durationText(this.#writes.timeoutMs)}`
          : "Lost the connection to IONOS's API";
        return this.#failure(
          "PROVIDER_ERROR",
          `${what} (${request}).`,
          method === "GET"
            ? CONNECTION_HINT
            : "The change may still have been made: check the data centre in IONOS's Data Center Designer before trying again.",
        );
      }
      case "invalid-json":
        return this.#failure("PROVIDER_ERROR", `IONOS returned invalid JSON for ${request}.`);
      case "unexpected":
        return this.#failure(
          "PROVIDER_ERROR",
          `IONOS returned an unexpected answer for ${request}: ${failure.issues}`,
          changedApiHint("IONOS Cloud"),
        );
      case "status":
        return this.#statusError(failure.response, method, path);
    }
  }

  async #statusError(
    response: Response,
    method: Method,
    path: IonosPath,
  ): Promise<IonosStatusError> {
    const { status } = response;
    const fail = (code: ErrorCode, message: string, hint: string) =>
      new IonosStatusError(
        status,
        code,
        this.#redactor.redact(message),
        this.#redactor.redact(hint),
      );
    const detail = errorDetail(await response.text().catch(() => ""));
    const tail = detail === undefined ? "." : `: ${detail}`;
    const request = `${method} ${path}`;

    if (status === 401) {
      return fail(
        "CREDENTIALS_INVALID",
        `IONOS refused the token in ${IONOS_ENV.token} (HTTP 401, ${request})${tail}`,
        `The token is wrong or has expired. ${IONOS_CREDENTIALS_HINT}`,
      );
    }
    if (status >= 400 && status < 500 && status !== 404 && status !== 429) {
      if (detail !== undefined && LIMIT_WORDS.test(detail)) {
        return fail(
          "PROVIDER_ERROR",
          `IONOS refused ${request}: your contract's limit was reached (HTTP ${status})${tail}`,
          "IONOS's support raises a contract's limits: ask it to raise this one, or remove what you no longer need, then try again.",
        );
      }
    }
    switch (status) {
      case 403: {
        const privilege = privilegeFor(method, path);
        const extra = detail === undefined ? "" : ` ${detail}`;
        return privilege === undefined
          ? fail(
              "CREDENTIALS_INVALID",
              `IONOS refused ${request} (HTTP 403): the token's user has no access to this.${extra}`,
              "In IONOS's Data Center Designer, give the group of the token's user Edit access to the data centre (Users & Groups, the group's Resources tab), or use a token of the user that created it, then try again.",
            )
          : fail(
              "CREDENTIALS_INVALID",
              `IONOS refused ${request} (HTTP 403): the token's user lacks the "${privilege}" privilege.${extra}`,
              `In IONOS's Data Center Designer, give the group of the token's user the "${privilege}" privilege (Users & Groups, the group's Privileges tab), then try again.`,
            );
      }
      case 404: {
        const hint =
          "It may have been deleted: check your data centres in IONOS's Data Center Designer.";
        return fail(
          "PROVIDER_ERROR",
          `IONOS found no such resource (${request})${tail}`,
          this.#apiUrl === IONOS_API_URL
            ? hint
            : `${hint} If every request fails this way, check ${IONOS_API_URL_ENV}, or unset it to use ${IONOS_API_URL}.`,
        );
      }
      case 422:
        return fail(
          "PROVIDER_ERROR",
          `IONOS found ${request} invalid (HTTP 422)${tail}`,
          "Fix what IONOS named above, then try again.",
        );
      case 429:
        return fail(
          "PROVIDER_ERROR",
          `IONOS's rate limit was reached (${request})${tail}`,
          RATE_LIMIT_HINT,
        );
    }
    return fail(
      "PROVIDER_ERROR",
      `IONOS answered HTTP ${status} to ${request}${tail}`,
      status < 500
        ? "Check your data centres in IONOS's Data Center Designer, then try again."
        : method === "GET"
          ? "IONOS failed on its side: try again in a few minutes, and contact IONOS's support if it keeps failing."
          : "IONOS failed on its side, and the change may still have been made: check the data centre in IONOS's Data Center Designer before trying again.",
    );
  }

  /** An `OpsCrewError` with its message and hint passed through the redactor. */
  #failure(code: ErrorCode, message: string, hint?: string): OpsCrewError {
    return new OpsCrewError(code, this.#redactor.redact(message), {
      ...(hint !== undefined && { hint: this.#redactor.redact(hint) }),
    });
  }
}

/** An error of a request IONOS answered with an error `status` (a 404 when a thing is gone). */
export class IonosStatusError extends OpsCrewError {
  constructor(
    readonly status: number,
    code: ErrorCode,
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
  }
}

/**
 * The group privilege a request needs beyond access to its data centre (the Cloud API's
 * `GroupProperties`: `createDatacenter`, `createSnapshot`), as the Data Center Designer names it.
 */
function privilegeFor(method: Method, path: IonosPath): string | undefined {
  if (method !== "POST") return undefined;
  if (path === "/datacenters") return "Create Data Center";
  if (path.endsWith("/create-snapshot")) return "Create Snapshot";
  return undefined;
}

/** What an error answer's `messages[].message` say; `undefined` when they say nothing. */
function errorDetail(text: string): string | undefined {
  const parsed = errorBodySchema.safeParse(parseJson(text));
  if (!parsed.success) return undefined;
  const parts = (parsed.data.messages ?? []).flatMap(({ message }) =>
    message?.trim() ? [message.trim()] : [],
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
