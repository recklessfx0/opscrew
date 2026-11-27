import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { IONOS_API_URL } from "../client";

/** The token, synthetic. */
export const TOKEN = fakeSecret("generic-password", "ionos-token");

/** The environment with the token set. */
export const TOKEN_ENV = { IONOS_TOKEN: TOKEN } as const;

/** Core's fake fetch with routes relative to `base` (`GET /datacenters`, `/requests/`). */
export function ionosFetch(routes: Record<string, FakeReply | FakeReply[]>, base = IONOS_API_URL) {
  return fakeFetch(routes, { base });
}

/**
 * A 202 answer: the request was accepted, and `Location` is its status's address (the Cloud API
 * v6 pages: "Callback URL to poll async operation status", `https://[apiBaseUri]/requests/[requestId]/status`).
 */
export function accepted(
  requestId: string,
  body?: unknown,
  base: string = IONOS_API_URL,
): FakeReply {
  return {
    status: 202,
    ...(body !== undefined && { body }),
    headers: { Location: `${base}/requests/${requestId}/status` },
  };
}

/** `GET /requests/{id}/status`'s answer (`RequestStatus`): `metadata.status` and `message`. */
export function requestStatus(status: string, message?: string): FakeReply {
  return {
    body: {
      id: "req-1",
      type: "request-status",
      href: `${IONOS_API_URL}/requests/req-1/status`,
      metadata: {
        status,
        ...(message !== undefined && { message }),
        etag: "fake-etag",
        targets: [{ target: { id: "srv-1", type: "server" }, status }],
      },
    },
  };
}

/** The Cloud API's error answer (`Error`): `{ httpStatus, messages: [{ errorCode, message }] }`. */
export function ionosError(status: number, ...messages: string[]): FakeReply {
  return {
    status,
    body: {
      httpStatus: status,
      messages: messages.map((message, i) => ({ errorCode: String(100 + i), message })),
    },
  };
}

/** A clock that the recorded sleeps move forward. */
export function fakeTime(start = Date.parse("2026-11-27T10:00:00Z")) {
  let time = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}
