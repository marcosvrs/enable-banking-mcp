---
name: enable-banking-mcp
description: Use when operating this Enable Banking MCP to onboard a personal bank connection, check authorization, list accounts, retrieve balances or transactions, inspect account/transaction details, or manage local connection state safely.
---

# Enable Banking MCP agent guide

Use this skill whenever the user asks to connect their bank, inspect account status, retrieve account details, balances or transactions, or manage this MCP's local authentication/session state. It documents the `enable-banking` MCP server's current tool contract; the connected host's live tool schemas remain authoritative if they differ.

## Operating model and boundaries

- This is a local macOS MCP server using stdio transport. The MCP host starts its own process. If the tools are already exposed in the current agent session, call them directly; starting another `node dist/server.js` process does not connect it to the current host's tool route.
- It supports personal, noncommercial, read-only account-information access (AIS): accounts, balances and transaction history. It does **not** initiate payments or support PIS, arbitrary Control Panel requests, arbitrary session access, business/commercial accounts, or a hosted multi-user service.
- The bank and Enable Banking decide which data are actually authorized. An access profile is a request, not a guarantee; a bank may grant less.
- Account, balance and transaction data are sensitive. Retrieve only what the user asked for, minimize returned identifiers and transaction text, and do not send financial data to another service or include it in persistent notes, logs, issues or source control.
- Never ask the user to paste a bank password, MFA/OTP code, API key, private key, access/refresh token, authorization code, session ID, or bank-consent response into chat or an agent-owned form. The user performs bank sign-in, MFA and explicit consent on the provider/bank browser page. MCP form values are visible to the connected MCP client; only use a client the user trusts with them.
- Do not call destructive tools unless the user explicitly requested the corresponding action. `connect_bank`, `setup_enable_banking`, `register_application`, and `authorize_bank` can begin setup, create an application, open a browser, or start bank authorization. `delete_session`, `control_panel_logout`, and especially `clear_local_credentials` change or remove local/provider state.
- If this MCP is not present in the current tool list, do not claim a shell-launched process will make it available to the current agent. Ask the user to configure/connect the MCP host, then use its exposed tools.

## Fast decision tree

1. Call `connection_status` (no arguments) before setup or account reads. It is read-only and does not return account data.
2. If `connection` is `connected` and the user wants every balance, either call `connect_bank` to retrieve balances for all authorized accounts or use `list_accounts` followed by `get_account_balances` for each returned UID. Use account-specific tools when the request names or selects an account.
3. If the user wants transactions, obtain account UIDs with `list_accounts`, select the requested account(s), then call `get_account_transactions`. Follow `continuationKey` while `hasMore` is true if the user asked for all results in that range.
4. If setup is required, use `connect_bank` as the primary guided path. Follow the state and `next_action` from `connection_status`; when the user completes a browser/dashboard step, call `connect_bank` again to resume.
5. Do not infer that an expired Control Panel login means the bank session is invalid. `control_panel_session` and `bank_session` are separate states.

## Guided onboarding: `connect_bank`

`connect_bank` is the primary onboarding and resume tool. It takes optional `app_name` (default `Enable Banking MCP`), `environment` (`PRODUCTION` default, or `SANDBOX`), `access_profile` (`balances_and_transactions` default, or `balances`), and optional future RFC3339 `valid_until`.

### First-run Production

1. Call `connect_bank` without asking the user to provide secrets in chat. If no local app exists, the MCP requires MCP form elicitation for the Control Panel email. If the client does not support/advertise `elicitation.form`, setup stops; do not replace it with an agent-owned form or environment-variable prompt.
2. The MCP authenticates the user's Enable Banking Control Panel account. It reuses a same-name app only if exactly one local private key matches its registered certificate. Otherwise it registers a new app, even if a same-name app exists. If asked, the user may restore the matching `<application-id>.pem` from `~/Downloads` or configure `ENABLE_BANKING_APPLICATION_PRIVATE_KEY_FILE`; never ask them to paste the key.
3. The user must open the Control Panel email sign-in link if one is required. The MCP handles its loopback callback and continues setup in the background.
4. For a new/inactive Production app, the MCP opens the Enable Banking dashboard and returns promptly with `status: "awaiting_user"`, a phase and `flow_id`. The user must link an account in the dashboard to activate the application. That dashboard linking step is **not** the later API bank session or bank consent.
5. After activation, the MCP identifies the linked bank from the Control Panel app. It then offers a consent settings form when supported and starts the separate bank authorization in the browser. The user must sign in at the bank, complete any MFA, and explicitly consent there.
6. Check `connection_status` for progress/`next_action`. Once it reports `connected`, call `connect_bank` again to retrieve balances for every authorized account, or use the account-specific tools.

### Sandbox

Pass `environment: "SANDBOX"` only when sandbox use is intended. The MCP asks for a two-letter country code and bank when needed; it may skip either prompt when a single unambiguous provider choice exists. Bank names should come from `list_banks` or the MCP's provider-backed selection form, not guessed. Sandbox does not use Production dashboard account activation.

### Existing app/session and resume behavior

- A stored Production app skips first-run email input. If inactive, the MCP opens the dashboard; the user links an account and then calls `connect_bank` again.
- A valid stored bank session skips setup and `connect_bank` returns balances.
- If an onboarding call returns `awaiting_user`, follow its stated action and call `connection_status`; do not start overlapping `connect_bank` calls while a call is still running. Resume by calling `connect_bank` after the user/provider step, not by starting a second flow.
- `flow_id` and current onboarding phase are in-memory progress state. Application/session credentials are stored separately. After an MCP process restart, call `connect_bank` to recover/resume from stored/provider state; there is no durable in-memory flow checkpoint.
- Consent settings form choices: `balances_and_transactions` requests balances and transaction history (default); `balances` requests balances only. `valid_until` is an optional future RFC3339 date-time. Omit it or leave it blank for a 30-day expiry calculated when bank authorization actually starts; this avoids consuming the consent period during a long Production activation. Declining the settings form stops before bank authorization. If the optional form is unsupported, supplied/default settings are used. The bank still decides the granted scope.

## Checking state and progress

### `connection_status`

Call with `{}`. It verifies a stored provider session, reports setup/onboarding state and next action, and returns no account data. Possible `connection` values:

- `connected`: a stored provider session was accepted; account-specific operations are available.
- `setup_required`: no application is configured; start `connect_bank`.
- `application_activation_required`: a Production application is inactive; link an account in the dashboard, then resume with `connect_bank`.
- `bank_authorization_required`: app exists but no usable bank session; use `connect_bank` (or an explicitly requested advanced authorization flow).
- `onboarding_active`: guided flow is still running; use the current `phase`/`flow_id` and check again, without starting another flow.
- `awaiting_user`: a human/browser action is required; follow `next_action`, then resume with `connect_bank`.
- `status_unavailable`: provider state could not be verified. This is **not** proof that the session is invalid; retry later and do not discard local credentials.

Other useful fields: `application` (`configured`, `active`, `inactive`, `not_configured`, `unknown`), `bank_session` (`valid`, `missing`, `invalid`, `unknown`), `control_panel_session` (`not_stored`, `stored`, `expired`), optional `application_environment`, `phase`, `flow_id`, and `onboarding_status`, and `next_action`. An expired Control Panel session can coexist with a valid bank session.

### `setup_status`

No arguments. Informational status for an advanced `setup_enable_banking`/registration flow. It does not start, resume, or monitor provider callbacks by itself; use `connection_status` for guided `connect_bank` progress. May include the current phase, pending flag, app ID, dashboard/authorization URL, message, error and sessionStored flag. Treat returned URLs and identifiers as sensitive; do not repeat them unnecessarily.

## Retrieving balances

### Fetch all authorized balances

- For the shortest route after onboarding, call `connect_bank` once `connection_status.connection` is `connected`. It returns `status: "connected"`, the ASPSP, authorized accounts, a `balances` array keyed by `account_id`, and the session access information.
- For explicit account-by-account retrieval, call `list_accounts`, then call `get_account_balances({"account_id":"<uid from list_accounts>"})` for each requested authorized account. Never invent or reuse a UID from another user/session.

Balance result objects are provider-defined and can contain several balance types per account, each with `balance_amount.amount`, `balance_amount.currency`, `balance_type`, `name`, and `reference_date`. Report the provider's label/type and date. Prefer an explicitly available balance (for example a provider item labelled available) when the user asks for spendable funds; do not silently substitute a book/opening/intraday balance. Do not add amounts with different balance types or reference dates into a total unless the user asks for an aggregate and the semantics are compatible. If one account lacks an explicit available balance, state that rather than relabeling another type.

`list_accounts` can also return `aspsp`, `accounts_data`, and `access` metadata. These may contain account-identifying information; only expose the minimum needed to identify the requested accounts. Ask the user to choose when multiple accounts exist and the request is account-specific; use all accounts only when the user asks for all/their overall accounts.

## Retrieving transactions

1. Confirm `connection_status.connection === "connected"`.
2. Call `list_accounts` and use the exact `uid` from the returned `accounts` list (or account objects where the live schema exposes them). Choose the user-requested account. If multiple accounts exist and the user did not request all, ask which one rather than guessing.
3. Call `get_account_transactions` with `account_id` and only the requested filters. `date_from` and `date_to` use inclusive `YYYY-MM-DD`; `date_to` is invalid without `date_from`. With no date range, the provider's default range applies. `limit` defaults to 25 and accepts integers 1–100; it is a **target count**, not a strict maximum because provider pages are indivisible and the final page can exceed it.
4. The result contains `transactions`, `pages`, `hasMore`, and optional `continuationKey`. If `hasMore` is true and a continuation key is returned, call again with that `continuation_key` and the same account/date/status/strategy filters. Continue until `hasMore` is false or there is no continuation key. Do not drop or change filters between pages; this can skip or duplicate records. If the provider returns a repeated continuation key, report the failure instead of looping.
5. Present the requested subset only; preserve transaction dates, currencies, signs, status and provider wording. Do not invent merchant/category descriptions or silently convert/aggregate currencies.

Optional `get_account_transactions` inputs:

- `date_from`: inclusive start date `YYYY-MM-DD`.
- `date_to`: inclusive end date; requires `date_from`.
- `continuation_key`: provider continuation key from the previous result.
- `transaction_status`: one of `BOOK`, `CNCL`, `HOLD`, `OTHR`, `PDNG`, `RJCT`, `SCHD`.
- `strategy`: `default` or `longest`; pass only when the user/request has a reason to select a provider strategy.
- `limit`: target transaction count, 1–100, default 25.

Transactions require an authorized account and sufficient granted scope. A balance-only consent can omit transaction access; if the bank granted a narrower scope, do not keep retrying or try to bypass it. Explain the authorization requirement and let the user decide whether to reauthorize.

## Advanced setup and account tools

Use these only when the user requests lower-level control; prefer guided `connect_bank` otherwise.

- `register_application`: create/reuse and persist an Enable Banking application. It does **not** complete bank authorization. In Production, the user still needs dashboard account linking, then a separate bank authorization.
- `setup_enable_banking`: advanced combined setup for a known bank and country. It continues in the background; pass the required ASPSP name and two-letter country. Once the bank is identified, consent settings are reviewed before API bank authorization.
- `authorize_bank`: start a separate personal bank-consent flow for an already configured application. Use exact ASPSP name (from `list_banks`), country, and optional redirect/profile/expiry. It opens the bank browser flow and returns while callback authorization is pending; this is not a read operation.
- `list_banks`: personal AIS institutions only; optional two-letter country filter. Application credentials are required because ASPSP discovery uses an application JWT.
- `get_application`: inspect the provider application associated with configured credentials.
- `get_session`: fetch the current provider session. Prefer `connection_status` and `list_accounts` when a full session object is unnecessary.

## Complete tool reference

The live MCP tool schema is authoritative. This list describes the current 20 public tools and their normal inputs.

### Onboarding and state

| Tool | Inputs | Behavior |
|---|---|---|
| `connect_bank` | Optional `app_name` (default `Enable Banking MCP`), `environment` (`PRODUCTION` default or `SANDBOX`), `access_profile` (`balances_and_transactions` default or `balances`), `valid_until` (future RFC3339; omitted = 30 days at authorization start) | Primary resumable onboarding. If already connected, fetches balances for all accounts. Otherwise asks supported MCP forms, launches browser steps, and returns progress. |
| `connection_status` | None | Read-only provider/application/session/onboarding status and `next_action`; no account data or side effects. |
| `setup_status` | None | Reports advanced setup progress; does not start/resume work. |
| `control_panel_authenticate` | None | Reuses/refreshes Control Panel login or initiates email-link sign-in. Does not take email/token as a tool argument; MCP form may ask for email if needed. |
| `control_panel_status` | None | Reports stored/expired Control Panel login without revealing email or tokens. |
| `control_panel_logout` | None | Removes local Control Panel authentication only; does not delete the bank session or provider application. |

### Advanced application and authorization

| Tool | Inputs | Behavior |
|---|---|---|
| `register_application` | `app_name` default `Enable Banking MCP`; `environment` default `PRODUCTION`; `redirect_url` default `https://localhost:8765/callback`; optional/defaulted `description`, `privacy_url`, `terms_url` | Registration only. Reuses a same-name app only with exactly one local private key matching its certificate; otherwise registers a new app. Production account linking and bank authorization remain separate. |
| `setup_enable_banking` | `aspsp_name` and `country` required; optional/defaulted `app_name`, `environment`, `redirect_url`, `description`, `privacy_url`, `terms_url`; `access_profile` default `balances_and_transactions`; optional future RFC3339 `valid_until` | Advanced full setup for a known bank/country; proceeds asynchronously through Control Panel, app activation, consent settings, browser authorization and session storage. |
| `authorize_bank` | Required `aspsp_name`; `country` default `IE`; optional `redirect_url` (stored app's first registered redirect by default), `access_profile` (default `balances_and_transactions`), `valid_until` (30-day default) | Starts separate browser authorization for a configured app. This starts consent; the user must authorize at the bank. |
| `list_banks` | Optional `country` (two-letter ISO 3166-1 code) | Lists institutions for personal AIS; requires application credentials. |
| `get_application` | None | Gets the application bound to configured credentials. |
| `get_health` | None | Checks public Enable Banking API health; does not require account authorization. |

### Account and transaction reads

| Tool | Inputs | Behavior |
|---|---|---|
| `list_accounts` | None | Lists accounts in the current authorized personal AIS session plus provider session/access metadata. Use returned UIDs as account IDs. |
| `get_account_details` | Required `account_id` | Gets provider details for one account authorized by the current session. May contain sensitive identifiers. |
| `get_account_balances` | Required `account_id` | Gets provider balance entries for one account authorized by the current session. |
| `get_account_transactions` | Required `account_id`; optional `date_from`, `date_to`, `continuation_key`, `transaction_status`, `strategy`; `limit` default 25, range 1–100 | Gets transaction pages and returns `transactions`, `pages`, `hasMore`, and optional `continuationKey`. |
| `get_transaction_details` | Required `account_id`, `transaction_id` | Gets details for one transaction in that authorized account. |

### Session and local credential changes

| Tool | Inputs | Behavior |
|---|---|---|
| `get_session` | None | Fetches the current provider session. May reveal sensitive authorized-account/session data. |
| `delete_session` | None | Deletes the current provider session remotely and clears its matching local session ID. Use only when the user explicitly wants to revoke/disconnect that session. |
| `clear_local_credentials` | None | Destructive local cleanup: clears Keychain session/application private key/Control Panel auth and attempts to remove trusted callback certificate. It does not itself revoke bank consent or unlink dashboard accounts, and it does not remove environment variables or backups. Before a user-requested cleanup, warn that the exact matching private key must be backed up if the provider-side application is to be reused; without it, a new application may be required. Do not use as a troubleshooting shortcut. |

All account-specific read tools validate the requested account UID against the current provider session. Never call a tool with a guessed UID. `get_transaction_details` additionally requires the transaction ID from the relevant account's transaction results.

## Configuration and local prerequisites

The server is intended for macOS (native Keychain and local certificate trust) and Node.js 22+. Normally the user completes first-run configuration through `connect_bank`; do not ask for or copy secrets. Advanced/preconfigured deployments may use these environment variables:

- `ENABLE_BANKING_APP_ID` (preferred) or legacy alias `ENABLE_BANKING_ID`, with `ENABLE_BANKING_PRIVATE_KEY` for signing.
- `ENABLE_BANKING_SESSION_ID` for a preconfigured session.
- `ENABLE_BANKING_CONTROL_PANEL_EMAIL` for a locally configured Control Panel contact/email input.
- `ENABLE_BANKING_APPLICATION_PRIVATE_KEY_FILE` to locate a matching local private-key export when restoring/reusing an app; default export location is `~/Downloads/<application-id>.pem`.
- `ENABLE_BANKING_TLS_CERT` and `ENABLE_BANKING_TLS_KEY` to override the callback certificate/key files; defaults are under `~/.config/enable-banking-mcp/tls/`.
- `ENABLE_BANKING_FIREBASE_API_KEY` to override the public Firebase client key used for Control Panel refresh.

These values belong in the user's local secret/configuration manager, not in prompts or repository files. A partial/mismatched app ID/private key is invalid. First-run registration/setup refuses to proceed when environment app credentials are configured; for an existing app with environment credentials, use the explicit advanced authorization path only when requested.

Credentials, application/session state and Control Panel authentication are stored locally in macOS Keychain. A locally trusted callback certificate is separate. Clearing local state does not erase backups, environment variables, client history, dashboard links or all provider-side records.

## Common errors and how to respond

- Missing app/session: do not retry account reads; start `connect_bank` if the user wants onboarding.
- Authorization pending: tell the user to finish the already-open browser step, check `connection_status`, then resume. Do not start duplicate authorization/setup calls.
- `status_unavailable`: provider state could not be verified; retry later, but do not report disconnected or clear sessions.
- Account not authorized: refresh the account list from the current session and use an exact returned UID. Do not reuse account IDs across sessions/users.
- Transaction scope/date/filter error: correct the request according to the schema. `date_to` requires `date_from`; a balance-only bank grant cannot be bypassed.
- Provider API error: preserve the reported HTTP status/message and any `retry_after` value; avoid blind retries for authorization, validation, or permission failures. Retry transient read failures only when appropriate and within any provider retry-after guidance.
- Elicitation declined: treat as cancellation; do not proceed to bank authorization. Required first-run input unavailable/unsupported: setup stops. Do not simulate MCP elicitation by asking for credentials in chat.

## Example tool-call arguments

After `list_accounts` returns a real UID:

```json
{"account_id":"<exact UID returned by list_accounts>"}
```

For a transaction query with an inclusive date range:

```json
{
  "account_id": "<exact UID returned by list_accounts>",
  "date_from": "2026-01-01",
  "date_to": "2026-01-31",
  "limit": 100
}
```

The placeholders above are documentation only; substitute values returned by the live MCP, never fabricate identifiers. If the result includes `hasMore: true`, repeat the query with its `continuationKey` and unchanged filters.
