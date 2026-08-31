# Enable Banking MCP

A local, read-only MCP server for personal Enable Banking account-information access on macOS.

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

The bank-consent callback uses HTTPS and a generated or configured localhost certificate. The Control Panel email-link callback is loopback-only and state-bound. Setup can add the generated bank-callback certificate to the macOS login Keychain. The browser may still require the normal local-certificate trust confirmation.

## Install and run

```sh
npm install
npm run build
npm start
```

The server uses MCP stdio transport. Configure your MCP client to launch `node dist/server.js` from this repository.

To install the repository's optional privacy pre-push hook explicitly:

```sh
npm run privacy:install-hooks
```

The npm lifecycle does not modify Git configuration automatically.

## First-run flow

Call `setup_enable_banking` from the MCP client with:

- the Control Panel email;
- an application name;
- `SANDBOX` or explicitly permitted restricted `PRODUCTION`;
- the HTTPS loopback redirect URL, defaulting to `https://localhost:8765/callback`;
- the target ASPSP name and two-letter country code; and
- `access_profile` set to `balances` (default) or `balances_and_transactions`.

Setup authenticates the Control Panel, registers the application, starts the personal AIS consent flow, and stores the application and current session in macOS Keychain. Complete the browser and bank steps, then use `setup_status`.

Production setup is deliberately blocked unless the operator sets:

```sh
export ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true
```

That flag is only an explicit operator opt-in. It is not provider approval and does not bypass restricted linked-account eligibility, review, KYC, privacy URL, terms URL, or any provider agreement. Production also requires completed HTTPS `privacy_url` and `terms_url` values and the other provider-required application fields.

For an already configured application, use `authorize_bank` to start a new personal consent flow. `list_banks` is restricted to personal AIS institutions. Account tools use the current locally stored session only.

The provider requires an application JWT for ASPSP discovery, so `list_banks` is available after application credentials exist. During first-run setup, provide the target ASPSP name and country directly.

## Local cleanup

- `delete_session` deletes the current provider session and clears the matching local session ID.
- `clear_local_credentials` clears local session, application, and Control Panel records and attempts to remove the locally trusted callback certificate. If certificate removal fails, it preserves the application record so the cleanup can be retried.

Local cleanup does not revoke bank consent, unlink accounts, delete provider-side records not covered by the session call, remove environment variables, erase MCP-client or AI-host history, or erase backups. Perform those actions through the relevant provider and operating-system controls.

## Privacy and terms

The [privacy policy](privacy-policy.md) and [terms of use](terms-of-use.md) provide general personal-use information for self-hosted deployments. This repository does not appoint an operator or controller and does not assume responsibility for any deployment or user's actions. The pages are published on the public GitHub branch below; a deployment's operator must provide any separate contact and legal information required by the provider:

- Privacy: https://github.com/marcosvrs/enable-banking-mcp/blob/personal-production-notices/privacy-policy.md
- Terms: https://github.com/marcosvrs/enable-banking-mcp/blob/personal-production-notices/terms-of-use.md

Review the current provider materials directly:

- [Enable Banking Terms](https://enablebanking.com/terms/)
- [Enable Banking Privacy Notice](https://enablebanking.com/privacy/)
- [Enable Banking API End User Terms](https://tilisy.enablebanking.com/terms)
- [Enable Banking API documentation](https://enablebanking.com/docs/api/)

## Security

Never put private keys, tokens, authorization codes, session IDs, account data, or transaction data in source control, prompts, issues, logs, or untrusted MCP clients. Report repository vulnerabilities privately according to [SECURITY.md](SECURITY.md).

See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for the resolved dependency license inventory.
