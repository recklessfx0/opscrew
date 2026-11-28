import type { ProviderSecOps, ProviderTerraform } from "@opscrew/contracts";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { MODULE_FILES as OWN_MODULE_FILES, SERVER_MODULE_FILES } from "../generated/modules";
import { FIRST_BOOT_SCRIPT } from "./first-boot";
import { SERVER_FIREWALL_FILE } from "./server-firewall";

/**
 * The files of one provider's server module: its own, and the files OpsCrew adds to every server
 * module (the first boot's `cloud-init.yaml.tftpl`, ADR 0029 D5). A provider whose servers take the
 * first boot as a startup script also gets `first-boot.sh.tftpl` (D12). A provider whose firewall
 * is the server's own (`firewallCheck` `server`, issue #13) gets `server-firewall.sh.tftpl`, the
 * first step of its first boot: of the startup script (Kamatera), or a boothook before the
 * cloud-config (UpCloud, #69). The others never do.
 */
export function serverModuleFiles(
  terraform: Pick<ProviderTerraform, "module" | "firstBoot">,
  firewallCheck?: ProviderSecOps["firewallCheck"],
): Record<string, string> {
  const script = terraform.firstBoot === "script";
  const shared = Object.entries(SERVER_MODULE_FILES).filter(([path]) =>
    path === FIRST_BOOT_SCRIPT
      ? script
      : path === SERVER_FIREWALL_FILE
        ? firewallCheck === "server"
        : true,
  );
  return { ...terraform.module.files, ...Object.fromEntries(shared) };
}

/**
 * Every module OpsCrew vendors beside a root module, by `<module>/<path>`: its own (Cloudflare's),
 * and each cloud provider's server module with the files OpsCrew adds to it (ADR 0029 D5 and D12).
 */
export const MODULE_FILES: Readonly<Record<string, string>> = Object.fromEntries([
  ...Object.entries(OWN_MODULE_FILES),
  ...CLOUD_PROVIDERS.flatMap(({ terraform, texts }) =>
    Object.entries(serverModuleFiles(terraform, texts.secops.firewallCheck)).map(
      ([path, content]) => [`${terraform.module.name}/${path}`, content] as const,
    ),
  ),
]);
