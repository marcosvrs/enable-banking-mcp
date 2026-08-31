# Enable Banking MCP

A local MCP server for read-only personal Enable Banking account-information access on macOS, with explicit setup and credential/session cleanup tools.

This repository is not operated by Enable Banking and is not an Enable Banking partner or approved application. Provider access is subject to the current provider terms, eligibility decision, bank consent flow, and technical requirements.

## Supported boundary

This release is intentionally limited to one person's own accounts and personal, noncommercial AIS use:

- Control Panel email-link authentication and application registration;
- personal bank authorization through the provider's consent flow;
- account details, balances, and transaction history; and
- local Keychain storage and cleanup.

It does not provide payment initiation or submission, PIS, arbitrary Control Panel requests, arbitrary session access, a hosted service, a multi-user service, or business/professional/commercial account access. Do not use it where current provider terms prohibit this integration or automation.

The source code is open source under the [MIT License](LICENSE). MIT permits downstream commercial reuse of the code; it does not grant commercial or other access rights to Enable Banking, a bank, an ASPSP, or another provider.

## Requirements

- macOS, because local credentials and certificate trust use macOS Keychain and `/usr/bin/security`;
- Node.js 22 or newer;
- an Enable Banking Control Panel account and an eligible personal bank account; and
- an MCP client or AI host you trust with sensitive financial data.

Set `ENABLE_BANKING_CONTROL_PANEL_EMAIL` in the local MCP server environment
before authentication. The email is deliberately not an MCP tool argument or
result. Do not put it in a prompt, tool call, issue, log, or committed
configuration.

For a shell-launched process, set it before starting the server:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
```

Use the equivalent local environment setting in an MCP client launch
configuration. The server inherits the value locally; it is not loaded from a
`.env` file. Keep the value out of cloud-managed prompts, tool arguments, logs,
and configuration synchronization.

The bank-consent callback uses HTTPS and a generated or configured localhost certificate. The Control Panel email-link callback is loopback-only and state-bound. Setup can add the generated bank-callback certificate to the macOS login Keychain. The browser may still require the normal local-certificate trust confirmation.

## Install and run

The published package is the easiest route for clients that support npm:

```sh
npx -y enable-banking-mcp@0.3.0
```

The release workflow publishes the unscoped `enable-banking-mcp` package to
the public npm registry from a matching `vX.Y.Z` tag. Until a release is
published, use the checkout instructions below.

### MCP client JSON configuration

For clients that accept an `mcpServers` JSON block, use the published package:

```json
{
  "mcpServers": {
    "enable-banking-mcp": {
      "command": "npx",
      "args": ["-y", "enable-banking-mcp@0.3.0"],
      "env": {
        "ENABLE_BANKING_CONTROL_PANEL_EMAIL": "you@example.com",
        "ENABLE_BANKING_GDPR_EMAIL": "privacy-contact@example.com",
        "ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION": "true"
      }
    }
  }
}
```

Keep this configuration local. This example opts into the restricted
Production path through a local environment value. Do not commit it,
synchronize it to a cloud-managed host, or put either email in a prompt or
tool call. To use SANDBOX instead, pass `"environment": "SANDBOX"` and omit
the Production-only fields.

### Claude Code

Claude Code can write the local MCP entry without manual JSON editing:

```sh
claude mcp add --scope user \
  --env 'ENABLE_BANKING_CONTROL_PANEL_EMAIL=you@example.com' \
  --env 'ENABLE_BANKING_GDPR_EMAIL=privacy-contact@example.com' \
  --env 'ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true' \
  --transport stdio \
  enable-banking-mcp -- \
  npx -y enable-banking-mcp@0.3.0
```

Use `--scope local` instead of `--scope user` to limit the server to the
current project. Verify the entry with:

```sh
claude mcp get enable-banking-mcp
```

Claude Code also has a plugin distribution. Add this repository as a
marketplace and install the plugin:

```text
/plugin marketplace add marcosvrs/enable-banking-mcp
/plugin install enable-banking-mcp@enable-banking-mcp
```

The plugin prompts for the Control Panel email through its sensitive
configuration field and supplies it only to the local server process. It also
supports the Production configuration fields; the restricted Production
opt-in is off by default and must be enabled intentionally. If Claude Code
asks for a reload, run `/reload-plugins`.

### Codex

Codex can write the shared local `~/.codex/config.toml` entry from the CLI:

```sh
codex mcp add enable-banking-mcp \
  --env 'ENABLE_BANKING_CONTROL_PANEL_EMAIL=you@example.com' \
  --env 'ENABLE_BANKING_GDPR_EMAIL=privacy-contact@example.com' \
  --env 'ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true' \
  -- npx -y enable-banking-mcp@0.3.0
```

The resulting MCP configuration is shared by Codex CLI, ChatGPT desktop
Codex, and the Codex IDE extension. Check it with:

```sh
codex mcp list
```

Codex also supports the bundled plugin marketplace in this repository:

```sh
codex plugin marketplace add marcosvrs/enable-banking-mcp
codex plugin add enable-banking-mcp@enable-banking-mcp
codex plugin list
```

Alternatively, open the Codex plugin browser with `codex`, then `/plugins`,
install **Enable Banking MCP**, and start a new session. The Codex plugin
forwards the local
`ENABLE_BANKING_CONTROL_PANEL_EMAIL`, `ENABLE_BANKING_GDPR_EMAIL`, and
`ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION` environment variables. Export
them before launching Codex when using the plugin:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
export ENABLE_BANKING_GDPR_EMAIL='privacy-contact@example.com'
export ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true
```

Use the direct `codex mcp add --env` form when Codex is launched outside a
shell that inherits these variables.

### Run from a checkout

For development or before the first npm release:

```sh
npm install
npm run build
npm start
```

The server uses MCP stdio transport. Configure a client to launch
`node /absolute/path/to/enable-banking-mcp/dist/server.js` and pass the local
environment values.

To install the repository's optional privacy pre-push hook explicitly:

```sh
npm run privacy:install-hooks
```

The npm lifecycle does not modify Git configuration automatically.

### Publish a release

Configure an npm Trusted Publisher for this repository before tagging:

- provider: GitHub Actions;
- user or organization: `marcosvrs`;
- repository: `enable-banking-mcp`;
- workflow filename: `publish.yml`; and
- allowed action: `npm publish`.

Trusted publishing cannot bootstrap a brand-new npm package because npm
requires the package to exist before its publisher can be configured. Complete
the one-time initial `0.3.0` publish interactively with npm 2FA, then add the
Trusted Publisher configuration above. After the package exists, tag the
matching package version:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
git tag v0.3.0
git push origin v0.3.0
```

The workflow runs the build, tests, privacy scan, `npm pack --dry-run`, and
provenance-enabled public npm publication through GitHub Actions OIDC. Do not
put npm tokens in this repository, an MCP configuration, or a prompt.

## First-run flow

The setup tool reads the Control Panel email from the local
`ENABLE_BANKING_CONTROL_PANEL_EMAIL` environment variable. Its schema defaults
to `PRODUCTION`; that default does not bypass the explicit restricted
Production guard.

For the default Production path, set all three local environment values:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
export ENABLE_BANKING_GDPR_EMAIL='privacy-contact@example.com'
export ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true
```

The `true` value is an explicit operator opt-in. It is not provider approval
and does not bypass restricted linked-account eligibility, review, KYC, privacy
URL, terms URL, or any provider agreement. To use SANDBOX, pass
`"environment": "SANDBOX"` explicitly and omit the Production-only fields.

Call `setup_enable_banking` with only non-email setup fields:

- an application name;
- `PRODUCTION` by default, or explicit `SANDBOX`;
- the HTTPS loopback redirect URL, defaulting to `https://localhost:8765/callback`;
- the target ASPSP name and two-letter country code;
- `access_profile` set to `balances` (default) or `balances_and_transactions`;
- for Production, a description; and
- for Production, completed HTTPS `privacy_url` and `terms_url` values.

For example, the default Production call can contain:

```json
{
  "app_name": "Enable Banking MCP",
  "redirect_url": "https://localhost:8765/callback",
  "aspsp_name": "Example Bank",
  "country": "IE",
  "description": "Read-only personal account-information access",
  "privacy_url": "https://example.com/privacy",
  "terms_url": "https://example.com/terms",
  "access_profile": "balances"
}
```

Setup authenticates the Control Panel, registers the application, waits for
Production account linking when required, starts the personal AIS consent
flow, and stores the application and current session in macOS Keychain.
Complete the browser and bank steps, then use `setup_status`.

For an already configured application, `control_panel_authenticate` takes no
arguments and reads the same local environment variable. `control_panel_status`
reports only authentication state and expiry; it does not return the email or
tokens.

Do not pass either email through MCP. Production requires
`ENABLE_BANKING_GDPR_EMAIL` in the local MCP server environment. Production
setup also requires the explicit `ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true`
value and the completed HTTPS policy URLs above.

For an already configured application, use `authorize_bank` to start a new personal consent flow. `list_banks` is restricted to personal AIS institutions. Account tools use the current locally stored session only.

The provider requires an application JWT for ASPSP discovery, so `list_banks` is available after application credentials exist. During first-run setup, provide the target ASPSP name and country directly.

## Local cleanup

- `delete_session` deletes the current provider session and clears the matching local session ID.
- `clear_local_credentials` clears local session, application, and Control Panel records and attempts to remove the locally trusted callback certificate. If certificate removal fails, it preserves the application record so the cleanup can be retried.

Local cleanup does not revoke bank consent, unlink accounts, delete provider-side records not covered by the session call, remove environment variables, erase MCP-client or AI-host history, or erase backups. Perform those actions through the relevant provider and operating-system controls.

## Privacy and terms

The [privacy policy](docs/privacy-policy.md) and [terms of use](docs/terms-of-use.md) provide general personal-use information for self-hosted deployments. This repository does not appoint an operator or controller and does not assume responsibility for any deployment or user's actions. The documents are stored under `docs/` as the source for the GitHub Pages site:

- Privacy: https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/
- Terms: https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/

Review the current provider materials directly:

- [Enable Banking Terms](https://enablebanking.com/terms/)
- [Enable Banking Privacy Notice](https://enablebanking.com/privacy/)
- [Enable Banking API End User Terms](https://tilisy.enablebanking.com/terms)
- [Enable Banking API documentation](https://enablebanking.com/docs/api/)

## Security

Never put private keys, tokens, authorization codes, session IDs, account data, or transaction data in source control, prompts, issues, logs, or untrusted MCP clients. Report repository vulnerabilities privately according to [SECURITY.md](SECURITY.md).

See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for the resolved dependency license inventory.
