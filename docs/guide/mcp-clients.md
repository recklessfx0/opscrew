# OpsCrew in other AI apps

OpsCrew's MCP server gives an AI app OpsCrew's tools: the security scan, the interview, the design
with real prices, the code changes and the deploy. One command adds it to the AI apps on your
computer: [Claude Code](claude-code-plugin.md) (through OpsCrew's plugin), Claude Desktop, Codex,
Cursor and VS Code.

```bash
npx opscrew mcp install
```

In the Codex CLI and the ChatGPT desktop app, [OpsCrew's Codex plugin](codex-plugin.md) adds the
same server with OpsCrew's skills. Codex's IDE extension loads no plugin and needs this entry.

It looks for each app on your computer, shows the file it changes in each and the entry it adds,
and asks once before it writes anything. Then restart each app it changed.

- `--client <id...>` sets up only the apps you name, even one it didn't find (it creates the app's
  folder and file): `claude-code`, `claude-desktop`, `codex`, `cursor` or `vscode`. For example
  `npx opscrew mcp install --client codex cursor`.
- `--yes` writes without asking. In a script without `--yes`, the command only shows the changes.

Each app starts OpsCrew's server with `npx -y opscrew@<version> mcp`, at the version of OpsCrew you
ran the command with, so you need [Node.js](https://nodejs.org/) 22 or newer and npm on your `PATH`.
The first start downloads OpsCrew (about 37 MB) and takes longer than the next ones.

## What it changes in each app

| App | What OpsCrew changes | Approval dialogs in the chat |
|---|---|---|
| Claude Code | Its [plugin](claude-code-plugin.md), with OpsCrew's skills: `claude plugin marketplace add opscrew-hub/opscrew`, then `claude plugin install opscrew@opscrew` (`update` when another version is installed) | Yes |
| Claude Desktop | `claude_desktop_config.json` in `%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS, `~/.config/Claude/` on Linux (`$XDG_CONFIG_HOME/Claude/` when that is set) | Not documented |
| Codex (the CLI, the IDE extension and the desktop app share the file) | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when that is set) | Yes |
| Cursor | `~/.cursor/mcp.json` | Yes |
| VS Code (GitHub Copilot) | `~/.copilot/mcp-config.json` (`$COPILOT_HOME/mcp-config.json` when that is set) | Yes, during an active turn |

Claude Desktop from the Microsoft Store keeps its file under
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` (from users' reports; Anthropic's
documentation doesn't name it). OpsCrew writes there too when that folder exists.

OpsCrew finds Claude Code when `claude --version` runs, Claude Desktop, Codex and Cursor when their
folder above exists, and VS Code when its Copilot folder above or its user folder exists
(`%APPDATA%\Code\User` on Windows, `~/Library/Application Support/Code/User` on macOS,
`~/.config/Code/User` on Linux).

In each file OpsCrew keeps every other server and setting, and before it changes a file it copies it
to `<file>.opscrew-backup`. A file it can't change without touching the rest stays as it is, and
OpsCrew prints the entry to add by hand instead: a JSON file with comments, or a Codex file that
writes its servers as an inline table or with dotted keys. Running the command again with the same
version changes nothing; another version replaces OpsCrew's entry.

### Approvals

Every change OpsCrew's tools make waits for your approval of its exact plan, in a dialog that only
you can answer ([how approvals work](claude-code-plugin.md#how-approvals-work)). An app that doesn't
show the dialog changes nothing: the tool stops and names the command to run in your terminal.
Claude Desktop's documentation doesn't say whether it shows these dialogs, so where none appears,
run the command it names in your terminal.

## Your tokens

No token goes into any app's file. OpsCrew's server reads your tokens (`HCLOUD_TOKEN`,
`CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` and the others the guide's pages name) from the environment
the app starts it in.

- **Codex** passes on only a short list of its own variables (such as `HOME` and `PATH`) and the
  variables its entry names. OpsCrew's entry lists the names of the tokens OpsCrew reads
  (`env_vars`, names only, never a value). Set the tokens in the environment Codex starts in.
- **Apps started from the desktop on Windows** read your user environment variables: set the tokens
  there, in Windows' settings, then restart the app.
- **Elsewhere** the vendors don't document which variables an app started from the desktop passes
  on. Run the steps that need tokens in your terminal (`npx opscrew provision`, for example), or
  start the app from a terminal where the tokens are set.
- **Never paste a token into the chat.**

## Remove it

```bash
npx opscrew mcp uninstall
```

It removes only OpsCrew's entry (in Codex, its tables) and leaves the rest of each file as it was;
in Claude Code it runs `claude plugin uninstall opscrew@opscrew`. An app without OpsCrew's entry is
reported as not set up. `--client` and `--yes` work as for `install`. Restart each app it changed.

## Adding the entry by hand

Each app's entry is named `opscrew`. Replace `<version>` with an OpsCrew version, for example the
one `npx opscrew --version` prints. `npx opscrew mcp install --client <id>` shows the exact entry
before it writes anything.

**Claude Desktop and Cursor:**

```json
{
  "mcpServers": {
    "opscrew": {
      "command": "npx",
      "args": ["-y", "opscrew@<version>", "mcp"]
    }
  }
}
```

**VS Code**, in `mcp-config.json`:

```json
{
  "mcpServers": {
    "opscrew": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opscrew@<version>", "mcp"],
      "tools": ["*"]
    }
  }
}
```

**Codex**, in `config.toml`. The entry sets these besides the command:
- **The start limit:** Codex waits 10 seconds for a server to start by default, less than the first
  download of OpsCrew, so the entry gives it 120.
- **The call limit:** Codex stops a tool call after 60 seconds by default, much less than an apply
  takes, so the entry gives each call 30 minutes.
- **`OPSCREW_MCP_CLIENT`:** tells OpsCrew's server that it runs under Codex, for its error
  messages. It isn't a token.

```toml
[mcp_servers.opscrew]
command = "npx"
args = ["-y", "opscrew@<version>", "mcp"]
startup_timeout_sec = 120
tool_timeout_sec = 1800
env = { OPSCREW_MCP_CLIENT = "codex" }
env_vars = [
  "HCLOUD_TOKEN",
  "DIGITALOCEAN_TOKEN",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "CNTB_OAUTH2_CLIENT_ID",
  "CNTB_OAUTH2_CLIENT_SECRET",
  "CNTB_OAUTH2_USER",
  "CNTB_OAUTH2_PASS",
  "OVH_ENDPOINT",
  "OVH_CLIENT_ID",
  "OVH_CLIENT_SECRET",
  "OVH_CLOUD_PROJECT_SERVICE",
  "KAMATERA_API_CLIENT_ID",
  "KAMATERA_API_SECRET",
  "IONOS_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
  "OPSCREW_NEW_CLOUDFLARE_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPSCREW_GHCR_READ_TOKEN",
  "PORTAINER_API_KEY",
  "GODADDY_API_TOKEN",
  "NAMECHEAP_API_USER",
  "NAMECHEAP_API_KEY",
  "NAMECHEAP_USERNAME",
  "NAMECHEAP_CLIENT_IP",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "OPSCREW_HOSTING_URL",
  "OPSCREW_HOSTING_USER",
  "OPSCREW_HOSTING_TOKEN",
  "OPSCREW_SFTP_HOST",
  "OPSCREW_SFTP_USER",
  "OPSCREW_SFTP_KEY",
  "OPSCREW_BESZEL_TOKEN",
  "OPSCREW_GRAFANA_CLOUD_TOKEN",
  "OPSCREW_CHECK_WEBHOOK",
  "OPSCREW_CHECK_NTFY_TOKEN",
  "OPSCREW_APP_ENV_FILE",
  "OPSCREW_STORAGE_ACCESS_KEY_ID",
  "OPSCREW_STORAGE_SECRET_ACCESS_KEY",
  "OPSCREW_OFFSITE_ACCESS_KEY_ID",
  "OPSCREW_OFFSITE_SECRET_ACCESS_KEY",
  "OPSCREW_OFFSITE_SFTP_KEY",
  "OPSCREW_HOME",
]
```

**Claude Code:** the two commands on [the plugin's page](claude-code-plugin.md#install).
