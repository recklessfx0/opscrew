import { createHash } from "node:crypto";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { UPCLOUD_API_URL } from "../client";

/** Crockford's base32 alphabet, which UpCloud's token ids use. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The token, synthetic and made at runtime so no token-shaped literal is committed: `ucat_` and 26
 * characters of Crockford's base32, the first four `FAKE`.
 */
export const TOKEN = `ucat_FAKE${[...createHash("sha256").update("opscrew:upcloud-token").digest()]
  .slice(0, 22)
  .map((byte) => CROCKFORD[byte % CROCKFORD.length])
  .join("")}`;

/** The environment with the token set. */
export const TOKEN_ENV = { UPCLOUD_TOKEN: TOKEN } as const;

/** Core's fake fetch with routes relative to the API's base (`GET /server`, `/storage/`). */
export function upcloudFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  return fakeFetch(routes, { base: UPCLOUD_API_URL });
}

/**
 * UpCloud's error answer (developers.upcloud.com/1.3/2-architecture/):
 * `{ "error": { "error_code", "error_message" } }`.
 */
export function upcloudError(status: number, code: string, message: string): FakeReply {
  return { status, body: { error: { error_code: code, error_message: message } } };
}

/** `GET /server/{uuid}`'s answer (developers.upcloud.com/1.3/8-servers/) in `state`. */
export function serverState(state: string, uuid = "srv-1"): FakeReply {
  return {
    body: {
      server: { uuid, hostname: "shop", title: "shop", state, zone: "de-fra1", plan: "2xCPU-4GB" },
    },
  };
}

/** `GET /storage/{uuid}`'s answer (developers.upcloud.com/1.3/9-storages/) in `state`. */
export function storageState(state: string, uuid = "sto-1"): FakeReply {
  return {
    body: {
      storage: { uuid, title: "shop-disk", state, size: 50, tier: "maxiops", type: "normal" },
    },
  };
}

/** A clock that the recorded sleeps move forward. */
export function fakeTime(start = Date.parse("2026-11-28T10:00:00Z")) {
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
