// Feature 030: a second app on a server OpsCrew created for another app, `target.shares` (T3001).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DeployPlanSchema, OwnTargetSchema, parseArtifact } from "./index";
import { toJsonSchemas } from "./json-schema";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

const REFUSAL = "a server OpsCrew created is reached at its public address";

const ownTarget = (overrides: Record<string, unknown> = {}) => ({
  provider: "own",
  mode: "vps-compose",
  arch: "amd64",
  access: "public",
  shares: { app: "example-app", provider: "hetzner" },
  edge: "caddy",
  ...overrides,
});

/** A second app's plan at shop.example.com behind Cloudflare's proxy. */
async function secondAppPlan(target: Record<string, unknown>) {
  const plan = parseArtifact(
    "plan",
    await readFile(new URL("plan.yaml", FIXTURES), "utf8"),
    "fixture",
  );
  return {
    ...plan,
    target,
    dns: {
      provider: "cloudflare",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: false,
    },
    security: { ...plan.security, httpAllowedFrom: "edge" },
  };
}

describe("target.shares", () => {
  it("is a strict { app, provider } on the own target, and optional", () => {
    expect(OwnTargetSchema.parse(ownTarget()).shares).toEqual({
      app: "example-app",
      provider: "hetzner",
    });
    const { shares: _shares, ...plain } = ownTarget();
    expect(OwnTargetSchema.parse(plain)).not.toHaveProperty("shares");
    for (const shares of [
      { app: "example-app", provider: "hetzner", host: "x" },
      { app: "example-app", provider: "own" },
      { app: "Example_App", provider: "hetzner" },
      { app: "example-app" },
    ]) {
      expect(OwnTargetSchema.safeParse(ownTarget({ shares })).success).toBe(false);
    }
  });

  it("parses a second app's plan on a created server", async () => {
    const plan = DeployPlanSchema.parse(await secondAppPlan(ownTarget()));
    expect(plan.target).toMatchObject({
      provider: "own",
      access: "public",
      shares: { app: "example-app", provider: "hetzner" },
    });
  });

  it("refuses shares with the tunnel", async () => {
    const result = DeployPlanSchema.safeParse(await secondAppPlan(ownTarget({ access: "tunnel" })));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["target", "shares"],
        message: expect.stringContaining(REFUSAL),
      }),
    );
  });

  it("refuses shares with home", async () => {
    const result = OwnTargetSchema.safeParse(ownTarget({ home: { ipv4: true } }));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["shares"],
        message: expect.stringContaining(REFUSAL),
      }),
    );
  });

  it("is in the plan's JSON schema", () => {
    const plan = toJsonSchemas().plan as {
      properties: { target: { oneOf: { properties: Record<string, { const?: string }> }[] } };
    };
    const own = plan.properties.target.oneOf.find((t) => t.properties.provider?.const === "own");
    expect(own?.properties.shares).toMatchObject({
      additionalProperties: false,
      required: ["app", "provider"],
      properties: {
        provider: { enum: ["hetzner", "digitalocean", "contabo", "ovhcloud", "kamatera", "ionos"] },
      },
    });
  });
});
