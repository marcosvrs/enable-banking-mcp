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

- macOS, because credentials and certificate trust use macOS Keychain (credentials use the native `@napi-rs/keyring` API; `/usr/bin/security` is used for certificate trust);
- Node.js 22 or newer;
- an Enable Banking Control Panel account and an eligible personal bank account; and
- an MCP client or AI host you trust with sensitive financial data.

On first-run Production onboarding, when no local application is configured,
`connect_bank` asks for the Control Panel email and checks that account for
the requested application name. It reuses an application only when exactly
one matching local private key is available and matches that application's
certificate. If no unique usable key is found, onboarding registers a new app,
including when a same-name app already exists. Control Panel-generated key
exports are named `~/Downloads/<application-id>.pem`; otherwise set
`ENABLE_BANKING_APPLICATION_PRIVATE_KEY_FILE` to the local path of the
matching private key.

A stored Production application skips the first-run form. If it is inactive,
`connect_bank` opens the Enable Banking dashboard and promptly returns
`awaiting_user` with a `flow_id`. Link an account, then call `connect_bank`
again to resume; the existing app is reused and no duplicate registration
occurs. Provider dashboard sign-in is handled there; the first-run MCP form is
not used for this stored-app step.

Sandbox asks for country and bank when needed. No email environment setting is
required. The Control Panel email authenticates that account and is the
data-protection contact for a new Production application; it does not identify
the user's bank or retrieve account data. Elicited form values are visible to
the connected MCP client.


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
implementation supports and advertises the capability. A first-run
`connect_bank` call requires MCP form elicitation; if unavailable, it stops
without starting setup. Do not collect the missing information through an
agent-owned form or environment fallback.

Production onboarding elicits the Control Panel email when no local application
is configured. After authentication, the server looks for requested-name apps
in the Control Panel account and reuses one only when exactly one matching
local private key is available. Otherwise it registers a new app, even if a
same-name app exists. The bank is detected from linked accounts for the chosen
application; no Production bank form is shown. Sandbox onboarding elicits
country and bank when needed. Form values are visible to the connected MCP
client. Never enter bank passwords, one-time codes, API keys, tokens, or bank
credentials into an MCP form; authentication and consent stay on the provider's
browser pages. See the [MCP elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests),
and [Codex configuration reference](https://developers.openai.com/codex/config-reference).


## Install and run

The published package is the easiest route for clients that support npm:

```sh
npx -y enable-banking-mcp@0.4.0-beta.2
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
      "args": ["-y", "enable-banking-mcp@0.4.0-beta.2"]
    }
  }
}
```

No email environment variable is needed. First-time Production onboarding
asks for the Control Panel email and detects the bank after dashboard account
linking. Form values are visible to the connected MCP client; use only a client
trusted with that data. Pass `"environment": "SANDBOX"` to
`connect_bank` only when sandbox testing is intended.

### Claude Code

Claude Code can write the local MCP entry without manual JSON editing:

```sh
claude mcp add --scope user \
  --transport stdio \
  enable-banking-mcp -- \
  npx -y enable-banking-mcp@0.4.0-beta.2
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

The plugin has no email configuration. `connect_bank` collects first-run
inputs using MCP form elicitation. If Claude Code asks for a reload, run
`/reload-plugins`.

### Codex

Codex can write the shared local `~/.codex/config.toml` entry from the CLI:

```sh
codex mcp add enable-banking-mcp \
  -- npx -y enable-banking-mcp@0.4.0-beta.2
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
install **Enable Banking MCP**, and start a new session. The plugin requires
no email environment variable; Production `connect_bank` asks only for the
Control Panel email through MCP form elicitation.

### Oh My Pi (OMP)

Oh My Pi can install the OMP-native marketplace entry from this repository:

```sh
omp plugin marketplace add marcosvrs/enable-banking-mcp
omp plugin install --scope user enable-banking-mcp@enable-banking-mcp
omp plugin list
```

The plugin requires no email environment variable. First-time Production
`connect_bank` asks only for the Control Panel email; Sandbox also asks for
the bank country and name.

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
`node /absolute/path/to/enable-banking-mcp/dist/server.js`. No email
environment value is required for `connect_bank`.

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

The asynchronous application core uses Effect 3.22.2 for provider calls,
credential storage, callback lifecycles, and setup workflows. Effect values are
run at the MCP transport and process boundaries; pure validation and
transformation functions remain ordinary TypeScript functions.

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

For Production onboarding without a local application, `connect_bank` asks for
the Control Panel email, then checks the authenticated account for applications
with the requested name. It reuses one only when exactly one local private key
matches its registered certificate. If no unique match exists, it registers a
new application rather than failing. Control Panel-generated keys can be
restored from their `<application-id>.pem` exports in `~/Downloads`; otherwise
set `ENABLE_BANKING_APPLICATION_PRIVATE_KEY_FILE` to a matching local key path.

A stored Production application does not show the first-run form. If inactive,
`connect_bank` opens the dashboard and returns `awaiting_user` with a `flow_id`;
link the account and call `connect_bank` again. Sandbox connections ask for
country and bank when needed. A valid stored session skips setup questions and
returns balances.

Bank discovery reads the authenticated Control Panel application-list response
(`whitelisted_accounts[].aspsp`) and retains only the bank name and country.
This relies on the dashboard response shape, not the public AIS API contract.

Accounts at the same institution collapse to one bank. If an application has
multiple distinct linked banks, `connect_bank` reports their names and
countries and stops rather than choosing one silently.

The server handles the Control Panel email callback on its loopback listener
and continues guided setup and provider callbacks in the background while the
MCP process remains running. `connect_bank` returns promptly with
`awaiting_user` and a `flow_id` when a human or provider step is pending. After
`connection_status` reports `connected`, call `connect_bank` again to retrieve
balances for every authorized account.

The application credentials, current Enable Banking session, and Control
Panel authentication share one native Keychain credential item. A locally
trusted callback certificate remains a separate non-secret Keychain item.
The defaults are personal `PRODUCTION`, a read-only description, project
privacy/terms URLs, and a request for balances plus transaction-history access.
The bank may grant a narrower scope. The Control Panel email is also the
Production application's data-protection contact. To use `SANDBOX`, pass
`"environment": "SANDBOX"` explicitly.

### Check bank authorization state

Call `connection_status` to distinguish MCP transport connectivity from a
usable bank session. It verifies the stored provider session and reports
application activation, consent, pending, or unavailable status without
returning accounts, opening a browser, or starting consent.
`connection: "connected"` means Enable Banking accepted the stored session.
`control_panel_session` reports Control Panel login storage/expiry separately;
it is not bank authorization. `status_unavailable` means the provider state
could not be verified, not that the bank session is invalid. `onboarding_active`
reports a running guided flow without querying provider session status. When a
phase is active, the status includes its phase, `flow_id`, and next action.
`awaiting_user` means follow that action, then resume with `connect_bank`; do
not overlap tool calls that are still running.

### Recommended: guided connection

Call `connect_bank` as the primary resumable onboarding path.

1. On first run, the form asks for the Control Panel email. The server checks
   that account for applications with the requested name. It reuses one only
   when exactly one local key matches its certificate; otherwise it registers
   a new app, even if a same-name app exists. Sandbox also asks for country and
   bank. An already stored Production app skips this first-run form. If
   inactive, the server opens the dashboard and returns `awaiting_user` with a
   `flow_id`; link the account, then call `connect_bank` again. Clients without
   form elicitation stop before first-run input; no agent-owned form is used.
2. For a new application, the server requests a Control Panel email sign-in
   link when needed and handles its loopback callback in the background. The
   user clicks the link; check `connection_status` for progress. If the MCP
   process restarts before the callback, call `connect_bank` again to resume
   from stored application state.
3. For a new Production application, the server opens the Enable Banking
   dashboard. The user must activate it by linking an account. The provider's
   [linked-accounts guide](https://enablebanking.com/docs/api/linked-accounts/)
   says this step routes through Enable Banking and the bank, where the user
   accepts provider terms and confirms the account link. Follow
   `connection_status.next_action` to resume.
4. After activation, the server detects the linked bank from that application's
   Control Panel account links, then starts separate API authorization through
   Enable Banking and opens the bank flow. The user must complete bank
   sign-in/MFA and explicitly consent. The server processes the callback and
   stores the session in Keychain. Once `connection_status` reports
   `connected`, call `connect_bank` again to fetch balances for each authorized
   account.
5. While `connection_status` reports an active phase, avoid overlapping
   `connect_bank` invocations. For `awaiting_user`, follow `next_action`; the
   same flow ID is retained when resuming. Application and session state
   persist in Keychain/provider state, but the onboarding flow itself is
   in-memory. This flow uses the system browser and local callbacks, not a
   Chrome DevTools or other MCP.

The Production account link and the API session authorization are separate
provider operations. The linked-account step does not create the API session.
Enable Banking's [`POST /auth` API](https://enablebanking.com/docs/api/reference/)
initiates a PSU redirect, and `POST /sessions` exchanges the returned
authorization code. The user therefore cannot complete a fresh real-account
setup with only an email-link click: Production account linking and bank
authorization/consent remain required.

After the bank is identified, an onboarding form lets the user choose the
requested access profile and consent expiry before bank authorization. The
default profile is `balances_and_transactions`; choose `balances` for
balance-only access. Enter an optional future RFC3339 `valid_until`, or leave it
blank for the 30-day default from authorization. The bank determines what it
grants. A Production linked-account restriction limits which accounts may be
accessed; the API session is still required even when that same account was
linked in the dashboard.

`list_accounts` returns account UIDs as strings from the Enable Banking
session. Pass one of these strings as `account_id` to account detail, balance,
or transaction tools; each tool checks the UID against the stored session.

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

The tool authenticates the Control Panel, reuses a same-name application only
when exactly one local private key matches its certificate, and otherwise
registers a new application, even if a same-name app exists. It stores the
selected application's credentials locally and returns. In Production it
opens the application dashboard and reports `account_link`; the user completes
account linking there.
This is a lower-level registration path. Use `connect_bank` for the
server-orchestrated flow through API authorization and balances; use
`authorize_bank` only for explicit advanced control.

### Advanced: register the application and authorize a bank in one flow

Call `setup_enable_banking` with:

- an application name;
- the HTTPS loopback redirect URL, defaulting to `https://localhost:8765/callback`;
- the target ASPSP name and two-letter country code;
- optional `valid_until` as a future RFC3339 date-time (default: 30 days from
  bank authorization); and
- `access_profile` set to `balances_and_transactions` (default) or `balances`
  for balance-only access.

For example, the default Production call can contain:

```json
{
  "app_name": "Enable Banking MCP",
  "redirect_url": "https://localhost:8765/callback",
  "aspsp_name": "Example Bank",
  "country": "IE",
  "access_profile": "balances_and_transactions"
}
```

This advanced tool reuses a matching Control Panel application only when
exactly one local private key matches its certificate; otherwise it registers
a new app, even if a same-name app exists. It starts the full server-side setup
workflow and returns before balances are fetched. The server continues
monitoring activation and bank authorization callbacks in the background. Use
`connect_bank` for guided onboarding and balance retrieval.

For an already configured application, `control_panel_authenticate` takes no
arguments and reuses the Keychain session, refreshing it silently when
possible. If refresh is rejected, advanced authentication tools use a stored
email, MCP form elicitation, or local `ENABLE_BANKING_CONTROL_PANEL_EMAIL`
configuration. `control_panel_status` reports authentication state and expiry
without returning the email or tokens. For an existing Production application,
`connect_bank` detects the linked bank without asking for a bank name.

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
- `clear_local_credentials` clears local session, application (including its private key), and Control Panel records and attempts to remove the locally trusted callback certificate. Back up the exact application signing key before clearing if the provider-side app must be reused; Control Panel-generated exports are named `<application-id>.pem` in `~/Downloads`. Without a matching key, a later onboarding cannot sign requests for that app and registers a new application instead. If stored application metadata is invalid or certificate removal fails, it preserves the application record and reports cleanup failure.

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
