import type { FakeReply } from "@opscrew/core/testing";

/**
 * `GET /account`'s answer (developers.upcloud.com/1.3/3-accounts/, "Get account information"),
 * with the example's credits and limits (memory and storage in MiB), the fields in `overrides`
 * replaced; an `undefined` one is left out.
 */
export function account(overrides: Record<string, unknown> = {}): FakeReply {
  return {
    body: {
      account: {
        credits: 9972.2324,
        username: "opscrew-deploy",
        resource_limits: {
          cores: 200,
          detached_floating_ips: 10,
          load_balancers: 50,
          managed_databases: 100,
          managed_kubernetes: 100,
          managed_object_storages: 100,
          memory: 1048576,
          network_gateways: 100,
          network_peerings: 100,
          networks: 100,
          ntp_excess_gib: 20000,
          public_ipv4: 100,
          public_ipv6: 100,
          routers: 100,
          storage_hdd: 10240,
          storage_maxiops: 10240,
          storage_standard: 10240,
          storage_total: 30720,
        },
        ...overrides,
      },
    },
  };
}

/** The account of UpCloud's example. */
export const ACCOUNT = account();

/** `GET /plan`'s answer (7-plans, "List available plans") with plans of these names. */
export function planList(...names: string[]): FakeReply {
  return {
    body: {
      plans: {
        plan: names.map((name) => ({
          core_number: 2,
          memory_amount: 4096,
          name,
          public_traffic_out: 4096,
          storage_size: 50,
          storage_tier: "maxiops",
        })),
      },
    },
  };
}
