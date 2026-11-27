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
import { IonosCatalog } from "./catalog";
import { IONOS_ENV, IONOS_TOKEN_MANAGER_URL, IonosClient, readIonosCredentials } from "./client";
import { ionosServerApi } from "./servers";

/** Credentials OpsCrew needs for IONOS Cloud: one token, which acts as the user who made it. */
export const IONOS_CREDENTIALS: CredentialRequirement = {
  envVars: Object.values(IONOS_ENV),
  description: `An IONOS Cloud token as ${IONOS_ENV.token}, made in the Token Manager of IONOS's Data Center Designer. A token can't be limited: it acts as the user who made it, so make it as a sub-user whose group has only the "Create Data Center", "Create Snapshot" and "Reserve IP" privileges: data centres for the servers, snapshots for whole-server snapshots, and one reserved IPv4 address per server.`,
  // The group privileges, as the Data Center Designer names them.
  scopes: ["Create Data Center", "Create Snapshot", "Reserve IP"],
  createUrl: IONOS_TOKEN_MANAGER_URL,
};

/** `GET /datacenters?depth=0`'s `Datacenters`: each data centre as a reference. */
const datacentersSchema = z.looseObject({ items: z.array(z.unknown()) });

/**
 * `GET /contracts`'s `Contracts`: each contract's `resourceLimits`, RAM and disks in MB, each
 * read only where IONOS shows it.
 */
const contractsSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      properties: z.looseObject({
        resourceLimits: z
          .looseObject({
            coresPerContract: z.number().optional(),
            coresProvisioned: z.number().optional(),
            ramPerContract: z.number().optional(),
            ramProvisioned: z.number().optional(),
            hddLimitPerContract: z.number().optional(),
            hddVolumeProvisioned: z.number().optional(),
            ssdLimitPerContract: z.number().optional(),
            ssdVolumeProvisioned: z.number().optional(),
          })
          .optional(),
      }),
    }),
  ),
});
type Limits = NonNullable<
  z.infer<typeof contractsSchema>["items"][number]["properties"]["resourceLimits"]
>;

/** The IONOS Cloud connector. */
export interface IonosConnector extends VpsConnector {
  readonly id: "ionos";
}

/**
 * Creates the IONOS Cloud connector: the credential check, the catalogue and the server API. The
 * token is read from `IONOS_TOKEN` and registered with the redactor as it is read; without it, or
 * with an `IONOS_API_URL` that isn't `https://`, nothing calls IONOS. The catalogue is the dated
 * static table, the same with or without the token. The servers' firewall is Terraform's (the NIC
 * firewall), and OpsCrew turns on no IONOS backups, so there are no connector firewalls, backups
 * or object storage.
 */
export function ionosConnector(deps: ProviderConnectorDeps): IonosConnector {
  const redactor = deps.redactor ?? new Redactor();
  const read = readIonosCredentials(deps.env, redactor);
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const signedIn =
    "problem" in read
      ? read
      : {
          client: new IonosClient({
            token: read.token,
            apiUrl: read.apiUrl,
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
    id: "ionos",
    displayName: "IONOS Cloud",
    credentials: IONOS_CREDENTIALS,
    configured: client !== undefined,
    servers: client === undefined ? undefined : ionosServerApi(client, { now }),
    catalog: () => {
      catalog ??= new IonosCatalog();
      return catalog;
    },
    verifyCredentials: async () =>
      "problem" in signedIn
        ? { ok: false, message: signedIn.problem }
        : verifyContract(signedIn.client, redactor),
  };
}

/**
 * Reads the data centres the token's user sees (`GET /datacenters?depth=0`) and its contract's
 * limits (`GET /contracts`), and says how many data centres there are and the limits IONOS shows.
 * A failure is IONOS's answer in plain English, with what to do.
 */
async function verifyContract(
  client: IonosClient,
  redactor: ProviderRedactor,
): Promise<CredentialCheck> {
  try {
    const datacenters = await client.get("/datacenters", datacentersSchema, { depth: "0" });
    const contracts = await client.get("/contracts", contractsSchema);
    // A token's user belongs to one contract.
    const limits = limitTexts(contracts.items[0]?.properties.resourceLimits ?? {});
    const message = `The IONOS Cloud token works: its user sees ${plural(datacenters.items.length, "data centre")}. ${
      limits.length > 0
        ? `The contract's limits: ${listText(limits)}.`
        : "IONOS showed no limits for the contract."
    }`;
    return { ok: true, message: redactor.redact(message) };
  } catch (error) {
    const message = errorText(error, "Could not check the IONOS Cloud token.");
    return { ok: false, message: redactor.redact(message) };
  }
}

/** `24 cores (4 in use)`, `48 GB of memory (8 GB in use)`, …: each limit IONOS shows. */
function limitTexts(limits: Limits): string[] {
  const inUse = (used: number | undefined, show: (n: number) => string) =>
    used === undefined ? "" : ` (${show(used)} in use)`;
  const texts: string[] = [];
  const { coresPerContract: cores, ramPerContract: ram } = limits;
  const { hddLimitPerContract: hdd, ssdLimitPerContract: ssd } = limits;
  if (cores !== undefined) {
    texts.push(`${plural(cores, "core")}${inUse(limits.coresProvisioned, String)}`);
  }
  if (ram !== undefined) texts.push(`${gb(ram)} of memory${inUse(limits.ramProvisioned, gb)}`);
  if (hdd !== undefined) {
    texts.push(`${gb(hdd)} of HDD storage${inUse(limits.hddVolumeProvisioned, gb)}`);
  }
  if (ssd !== undefined) {
    texts.push(`${gb(ssd)} of SSD storage${inUse(limits.ssdVolumeProvisioned, gb)}`);
  }
  return texts;
}

/** `48 GB`, `1.5 GB`: megabytes as IONOS gives them, in GB. */
function gb(mb: number): string {
  return `${Number((mb / 1024).toFixed(1))} GB`;
}
