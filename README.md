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

## Agent skill

Install the Enable Banking MCP operating guide for supported AI agents:

```sh
npx skills add marcosvrs/enable-banking-mcp
```

The `enable-banking-mcp` skill documents onboarding, authorization status,
account and transaction reads, and safe session management.

## Requirements

- macOS, because credentials and certificate trust use macOS Keychain (credentials use the native `@napi-rs/keyring` API; `/usr/bin/security` remains used for certificate trust and legacy credential cleanup);
- Node.js 22 or newer;
- an Enable Banking Control Panel account and an eligible personal bank account; and
- an MCP client or AI host you trust with sensitive financial data.

For first-time Control Panel authentication, set
`ENABLE_BANKING_CONTROL_PANEL_EMAIL` in the local MCP server environment, or
let the server request it through MCP form elicitation when no local email or
Keychain identity exists and the client supports forms. The email authenticates
the Control Panel and is the data-protection contact for a Production
application; it does not identify a user's bank or retrieve account data.
An elicited email is in-band MCP data visible to the connected client, not a
tool argument or result. Use elicitation only with a trusted client; configure
the local environment instead when the client must not receive the email. The
email is reused from Keychain after authentication.

For a shell-launched process, set it before starting the server:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
```

Use the equivalent local environment setting in an MCP client launch
configuration. The server inherits it locally; it is not loaded from a `.env`
file. Keep this configuration local and out of cloud-managed synchronization.

Matching unexpired Control Panel sessions are reused. Expired sessions are
silently refreshed with the public Firebase client configuration used by
Enable Banking's Control Panel. `ENABLE_BANKING_FIREBASE_API_KEY` may override
that key for a different deployment. If refresh is rejected, the server
requests a Control Panel email sign-in link; the user must open it.

The bank-consent callback uses HTTPS and a generated or configured localhost certificate. The Control Panel email-link callback is loopback-only and state-bound. Setup can add the generated bank-callback certificate to the macOS login Keychain. The browser may still require the normal local-certificate trust confirmation.

### MCP form elicitation

Form elicitation is capability-negotiated MCP behavior, not a Claude-only
question API. This server checks whether the client advertises
`elicitation.form`. Claude Code displays supported requests automatically.
Codex's `approval_policy.granular.mcp_elicitations = true` allows these
prompts to surface instead of being auto-rejected; combine it with existing
approval settings. Other clients can use forms only when their MCP
implementation supports and advertises the capability. Without it, the server
returns provider-listed bank/country choices for the agent to ask through its
own interface. If a Control Panel email is missing, the tool instead returns
instructions to configure local `ENABLE_BANKING_CONTROL_PANEL_EMAIL`.

The server asks only for unresolved Control Panel email, country, or bank
choices. Form data is visible to the connected MCP client. Never enter bank
passwords, one-time codes, API keys, tokens, or bank credentials into an MCP
form; authentication and consent stay on the provider's browser pages. See the
[MCP elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests),
and [Codex configuration reference](https://developers.openai.com/codex/config-reference).


## Install and run

The published package is the easiest route for clients that support npm:

```sh
npx -y enable-banking-mcp@0.3.0-beta.10
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
      "args": ["-y", "enable-banking-mcp@0.3.0-beta.10"],
      "env": {
        "ENABLE_BANKING_CONTROL_PANEL_EMAIL": "you@example.com"
      }
    }
  }
}
```

Keep this configuration local. `ENABLE_BANKING_CONTROL_PANEL_EMAIL` is the
only environment value required for first-run registration; supported MCP
forms can collect it instead. Do not commit or synchronize it, or place it in
a conversational prompt or tool argument. The MCP form response is visible to
the connected client. Pass `"environment": "SANDBOX"` to the setup tool only
when sandbox testing is intended.

### Claude Code

Claude Code can write the local MCP entry without manual JSON editing:

```sh
claude mcp add --scope user \
  --env 'ENABLE_BANKING_CONTROL_PANEL_EMAIL=you@example.com' \
  --transport stdio \
  enable-banking-mcp -- \
  npx -y enable-banking-mcp@0.3.0-beta.10
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
configuration field and supplies it only to the local server process. The
setup tool fills its personal Production defaults automatically. If Claude
Code asks for a reload, run `/reload-plugins`.

### Codex

Codex can write the shared local `~/.codex/config.toml` entry from the CLI:

```sh
codex mcp add enable-banking-mcp \
  --env 'ENABLE_BANKING_CONTROL_PANEL_EMAIL=you@example.com' \
  -- npx -y enable-banking-mcp@0.3.0-beta.10
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
forwards the local `ENABLE_BANKING_CONTROL_PANEL_EMAIL` environment variable.
Export it before launching Codex when using the plugin:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
```

Use the direct `codex mcp add --env` form when Codex is launched outside a
shell that inherits these variables.

### Oh My Pi (OMP)

Oh My Pi can install the OMP-native marketplace entry from this repository:

```sh
omp plugin marketplace add marcosvrs/enable-banking-mcp
omp plugin install --scope user enable-banking-mcp@enable-banking-mcp
omp plugin list
```

Export the local Control Panel email before launching OMP. The plugin passes
that environment variable only to the local MCP server process:

```sh
export ENABLE_BANKING_CONTROL_PANEL_EMAIL='you@example.com'
```

Start a new OMP session after installation. After marketplace updates, run
`/reload-plugins` to refresh the current session.

### Run from a checkout

For development or before the first npm release:

```sh
npm install
npm run build
npm start
```

The server uses MCP stdio transport. Configure a client to launch
`node /absolute/path/to/enable-banking-mcp/dist/server.js` and pass the local
Control Panel email environment value.

### Run E2E checks

The deterministic MCP E2E suite uses a local fixture server. It verifies the
stdio protocol handshake, the exact 20-tool contract, schemas and safety
annotations, successful and failed tool calls, both plugin launch manifests,
and the packed npm executable:

```sh
npm run e2e:mcp
```

The Claude Code and Codex plugin checks are fully offline. They validate the
fixture-backed plugin manifests, Claude's strict plugin schema, and Codex's
local marketplace discovery and installation. They do not start an agent,
make an LLM request, require credentials, or contact a bank:

```sh
npm run e2e:claude
npm run e2e:codex
npm run e2e
```

`npm run e2e:published` checks the package version referenced by both bundled
plugin manifests after publication. Every GitHub Actions E2E job is
credential-free and can run on pull requests, pushes, schedules, or manual
dispatches.

To install the repository's optional privacy pre-push hook explicitly:

```sh
npm run privacy:install-hooks
```

The npm lifecycle does not modify Git configuration automatically.

### Run test gates

```sh
npm test
npm run test:coverage
npm run test:mutation
```

The coverage gate requires 100% statement and function coverage for `src/`;
line and branch coverage are reported but have no minimum. Mutation testing
requires a score of at least 99% for the deterministic configuration,
localhost-redirect, and session-recovery logic. This is a focused mutation
gate, not a repository-wide mutation score. Provider, OS, browser, and
stdio-facing code remains covered by the regression suite but is excluded from
the score; in particular, the stdio integration test launches a child process
outside Stryker's mutant instrumentation.

The only coverage exclusions are narrow defensive states and a V8 source-map
gap on `authorize_bank`'s request literal, which is exercised by the isolated
stdio integration test.
CI runs coverage on every pull request and push to `main`; it runs mutation
testing only when source, tests, or test configuration changes. CI caches npm
downloads and the incremental mutation report.

### Publish a release

Configure an npm Trusted Publisher for this repository before tagging:

- provider: GitHub Actions;
- user or organization: `marcosvrs`;
- repository: `enable-banking-mcp`;
- workflow filename: `publish.yml`; and
- allowed action: `npm publish`.

Trusted publishing cannot bootstrap a brand-new npm package because npm
requires the package to exist before its publisher can be configured. This
package has been bootstrapped; configure the Trusted Publisher above before
tagging a new, unpublished release. If an interactive beta publish is
required, use:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org
npm publish --access public --tag beta --registry=https://registry.npmjs.org
```

Do not tag an already-published version with the publishing workflow; npm
rejects duplicate versions.

The workflow runs the build, tests, privacy scan, `npm pack --dry-run`, and
provenance-enabled public npm publication through GitHub Actions OIDC, then
smoke-tests the published MCP package through both bundled plugin manifests.
Do not put npm tokens in this repository, an MCP configuration, or a prompt.

## First-run flow

The setup tools read the Control Panel email from local
`ENABLE_BANKING_CONTROL_PANEL_EMAIL` configuration or reuse a Keychain
identity. When neither exists, `connect_bank` and the authentication tools use
MCP form elicitation if supported; otherwise configure the local environment.
Application credentials and callback certificates are stored in the macOS
login Keychain.

The setup schemas default to personal `PRODUCTION` and use the Control Panel
email as the Production application's data-protection contact. They also
supply the project's read-only description, privacy policy URL, and terms URL
by default. Those values can be overridden in the setup arguments. To use
`SANDBOX`, pass `"environment": "SANDBOX"` explicitly.

### Check bank authorization state

Call `connection_status` when the agent needs to distinguish MCP transport
connectivity from a usable bank session. It verifies the stored provider
session and reports application activation, consent, pending, or unavailable
status without returning accounts, opening a browser, or starting consent.
`connection: "connected"` means Enable Banking accepted the stored session.
`control_panel_session` reports Control Panel login storage/expiry separately;
it is not bank authorization. `status_unavailable` means the provider state
could not be verified, not that the bank session is invalid.

### Recommended: guided connection

Call `connect_bank` as the primary guided setup. It reuses valid sessions,
application credentials, and stored Control Panel identity before asking for
anything.

1. Start with `connect_bank({})`. A valid bank session returns its authorized
   accounts without asking for more input. If a new application is needed, the
   server uses the personal Production defaults and asks for a Control Panel
   email only when it is missing locally and the MCP client supports forms.
2. The assistant owns all safe follow-up calls and status checks. The user
   completes only a requested Control Panel email link, Production dashboard
   account linking, bank sign-in/MFA and explicit consent, or a local
   certificate-trust prompt.
3. After the application is active, the server uses Enable Banking data before
   asking. A supplied bank name is searched against the global personal-AIS
   institution list; a unique exact match supplies its country automatically.
   If multiple country matches remain, the form offers those bank/country
   pairs.
4. If no country is known, the server uses `GET /application` metadata. When
   multiple countries are available or metadata is empty, it checks the global
   personal-AIS catalog before prompting and filters to countries with listed
   banks that the application supports. A single catalog country removes the
   country question; without a supplied bank name, a sole catalog bank resolves
   both fields. Otherwise, the form asks only for unresolved country/bank
   choices. A sole bank in the selected country is used only when it does not
   conflict with a supplied bank name. If the client cannot elicit, the tool
   returns provider choices so the assistant can ask through its own interface
   and resume `connect_bank` with the selection.
5. Once the bank is resolved, `connect_bank` opens authorization and handles
   the callback. The user completes bank sign-in/MFA and explicitly consents;
   the assistant calls `connect_bank({})` afterward to verify the session and
   return authorized accounts.

Email is not a lookup key for user, bank, or account information. With valid
application credentials, `GET /application` returns application metadata and
`GET /aspsps` lists institutions; personal account data requires an account ID
from a user-authorized session. See the [Enable Banking API
reference](https://enablebanking.com/docs/api/reference/) and [Production
linked-accounts guide](https://enablebanking.com/docs/api/linked-accounts/);
dashboard account linking does not itself authorize an API session.

The default access profile is balances. Request transaction history only when
needed. A Production linked-account restriction limits which accounts may be
accessed, but it does not create the API session: API bank consent remains
required even when the user linked that same account in the dashboard.

### Advanced: register the application before choosing a bank

Call `register_application` with:

- an application name; and
- the HTTPS loopback redirect URL, defaulting to `https://localhost:8765/callback`.

For example:

```json
{
  "app_name": "Enable Banking MCP",
  "redirect_url": "https://localhost:8765/callback"
}
```

The tool authenticates the Control Panel, registers the application, stores
its credentials locally, and returns. In Production it opens the application
dashboard and reports `account_link`; the user completes account linking there.
Afterward, the assistant/MCP client resumes with `authorize_bank` when the bank
and country are known. In SANDBOX, the assistant proceeds immediately.
The assistant may poll `setup_status`; do not ask the user to rerun MCP tools.

### Advanced: register the application and authorize a bank in one flow

Call `setup_enable_banking` with:

- an application name;
- the HTTPS loopback redirect URL, defaulting to `https://localhost:8765/callback`;
- the target ASPSP name and two-letter country code; and
- `access_profile` set to `balances` (default) or `balances_and_transactions`.

For example, the default Production call can contain:

```json
{
  "app_name": "Enable Banking MCP",
  "redirect_url": "https://localhost:8765/callback",
  "aspsp_name": "Example Bank",
  "country": "IE",
  "access_profile": "balances"
}
```

This combined flow authenticates the Control Panel, registers the application,
waits for Production account linking when required, starts the personal AIS
consent flow, and stores the application and current session in the macOS
Keychain. The MCP agent polls setup status and resumes all follow-up calls
itself. The user completes only required browser actions.

For an already configured application, `control_panel_authenticate` takes no
arguments and reuses the Keychain session, refreshing it silently when
possible. If refresh is rejected, a new sign-in link uses a stored email,
supported MCP form elicitation, or local `ENABLE_BANKING_CONTROL_PANEL_EMAIL`
configuration. `control_panel_status` reports authentication state and expiry
without returning the email or tokens.

For an application registered with `register_application`, or any other
already configured application, use `authorize_bank` to start a new personal
consent flow. `list_banks` is restricted to personal AIS institutions. Account
tools use the current locally stored session only.
If `authorize_bank.redirect_url` is omitted, the first redirect URL registered
on the stored application is used.

The provider requires an application JWT for ASPSP discovery, so `list_banks`
is available after application credentials exist. The split first-run path
creates those credentials before bank selection; the combined path accepts the
target ASPSP name and country directly.

## Local cleanup

- `delete_session` deletes the current provider session and clears the matching local session ID.
- `control_panel_logout` removes the persisted Control Panel session.
- `clear_local_credentials` clears local session, application, and Control Panel records and attempts to remove the locally trusted callback certificate. If stored application metadata is invalid or certificate removal fails, it preserves the application record and reports cleanup failure.

Logout and credential cleanup are refused while Control Panel authentication,
bank authorization, or setup is pending, preventing a later callback from
restoring credentials after removal.

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
