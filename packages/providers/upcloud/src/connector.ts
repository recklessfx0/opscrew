import type {
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  ProviderConnectorDeps,
  ProviderRedactor,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, listText, plural, Redactor, realSleep } from "@opscrew/core";
import { z } from "zod";
import { UpCloudCatalog } from "./catalog";
import { readUpcloudCredentials, UPCLOUD_ENV, UpcloudClient } from "./client";
import { upcloudServerApi } from "./servers";

/**
 * Credentials OpsCrew needs for UpCloud: one API token, which can't be limited to some resources,
 * so it is best made as a sub-account limited to servers and storage, and short-lived.
 */
export const UPCLOUD_CREDENTIALS: CredentialRequirement = {
  envVars: [UPCLOUD_ENV.token],
  description: `An UpCloud API token as ${UPCLOUD_ENV.token}, made in UpCloud's control panel under Account → API tokens. A token can't be limited to some resources: it acts with the rights of the account that made it.`,
  // As UPCLOUD_CREDENTIALS_HINT words them, so that an error which says them isn't repeated.
  scopes: ["a sub-account limited to servers and storage", "an expiry of 90 days or less"],
  // The control panel's API tokens page (upcloud.com/docs/guides/getting-started-upcloud-api/).
  createUrl: "https://hub.upcloud.com/account/api-tokens",
};

/** `GET /plan` ("List available plans", 7-plans): each plan's `name`. */
const plansSchema = z.looseObject({
  plans: z.looseObject({ plan: z.array(z.looseObject({ name: z.string() })) }),
});

/**
 * `GET /account` ("Get account information", 3-accounts): the user name, the credits (in cents,
 * as UpCloud's own CLI reads them) and the resource limits, memory and storage in MiB, each read
 * only where UpCloud shows it.
 */
const accountSchema = z.looseObject({
  account: z.looseObject({
    username: z.string(),
    credits: z.number(),
    resource_limits: z
      .looseObject({
        cores: z.number().optional(),
        memory: z.number().optional(),
        storage_maxiops: z.number().optional(),
        public_ipv4: z.number().optional(),
      })
      .optional(),
  }),
});
type Limits = NonNullable<z.infer<typeof accountSchema>["account"]["resource_limits"]>;

/** The UpCloud connector. */
export interface UpcloudConnector extends VpsConnector {
  readonly id: "upcloud";
}

/**
 * Creates the UpCloud connector: the credential check, the catalogue and the server API. The
 * token is read from `UPCLOUD_TOKEN` alone and registered with the redactor as it is read; without
 * it nothing calls UpCloud. The catalogue is the dated static table, made once; with the token it
 * offers only the plans UpCloud lists. The servers' firewall is their own, set at their first boot,
 * and Simple Backup is Terraform's, so there are no connector firewalls, backups or object storage.
 */
export function upcloudConnector(deps: ProviderConnectorDeps): UpcloudConnector {
  const redactor = deps.redactor ?? new Redactor();
  const read = readUpcloudCredentials(deps.env, redactor);
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const signedIn =
    "problem" in read
      ? read
      : {
          client: new UpcloudClient({
            token: read.token,
            redactor,
            ...(deps.fetch && { fetch: deps.fetch }),
            ...(deps.version && { version: deps.version }),
            sleep: deps.sleep ?? realSleep,
            now,
          }),
        };
  const client = "client" in signedIn ? signedIn.client : undefined;
  let catalog: ComputeCatalog | undefined;

  return {
    id: "upcloud",
    displayName: "UpCloud",
    credentials: UPCLOUD_CREDENTIALS,
    configured: client !== undefined,
    servers: client === undefined ? undefined : upcloudServerApi(client, { now }),
    catalog: () => {
      catalog ??= new UpCloudCatalog(
        client === undefined ? {} : { listPlans: () => planNames(client) },
      );
      return catalog;
    },
    verifyCredentials: async () =>
      "problem" in signedIn
        ? { ok: false, message: signedIn.problem }
        : verifyAccount(signedIn.client, redactor),
  };
}

/** The names of the plans UpCloud lists (`GET /plan`). */
async function planNames(client: UpcloudClient): Promise<string[]> {
  const { plans } = await client.get("/plan", plansSchema);
  return plans.plan.map((plan) => plan.name);
}

/**
 * Reads the token's account (`GET /account`) and says its user name, its credits and the limits
 * UpCloud shows. A failure is UpCloud's answer in plain English, with what to do.
 */
async function verifyAccount(
  client: UpcloudClient,
  redactor: ProviderRedactor,
): Promise<CredentialCheck> {
  try {
    const { account } = await client.get("/account", accountSchema);
    const limits = limitTexts(account.resource_limits ?? {});
    const credits = (account.credits / 100).toFixed(2);
    const message = `The UpCloud token works: it belongs to the account ${account.username}, whose credits are ${credits} in the account's currency. ${
      limits.length > 0
        ? `The account's limits: ${listText(limits)}.`
        : "UpCloud showed no limits for the account."
    }`;
    return {
      ok: true,
      identity: redactor.redact(account.username),
      message: redactor.redact(message),
    };
  } catch (error) {
    const message = errorText(error, "Could not check the UpCloud token.");
    return { ok: false, message: redactor.redact(message) };
  }
}

/** `200 cores`, `1024 GB of memory`, …: each limit UpCloud shows that a server uses. */
function limitTexts(limits: Limits): string[] {
  const texts: string[] = [];
  if (limits.cores !== undefined) texts.push(plural(limits.cores, "core"));
  if (limits.memory !== undefined) texts.push(`${gb(limits.memory)} of memory`);
  if (limits.storage_maxiops !== undefined) {
    texts.push(`${gb(limits.storage_maxiops)} of MaxIOPS storage`);
  }
  const ipv4 = limits.public_ipv4;
  if (ipv4 !== undefined) {
    texts.push(`${ipv4} public IPv4 ${ipv4 === 1 ? "address" : "addresses"}`);
  }
  return texts;
}

/** `1024 GB`, `1.5 GB`: mebibytes as UpCloud gives them, in GB. */
function gb(mib: number): string {
  return `${Number((mib / 1024).toFixed(1))} GB`;
}
