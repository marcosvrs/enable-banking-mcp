# Security Policy

## Supported versions

Only the latest commit on `main` is supported. This project is a local, personal, noncommercial, read-only AIS client; it is not a hosted service or payment product.

## Report a vulnerability

Do not open a public issue for a vulnerability or include credentials, private keys, tokens, authorization codes, session IDs, account numbers, or transaction data in any report.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/marcosvrs/enable-banking-mcp/security/advisories/new>

If private reporting is unavailable, open a minimal issue containing only the words `security contact requested`; do not disclose exploit details or sensitive data. The maintainer will provide a private channel.

Include:

- the affected commit or version;
- the affected file, tool, or configuration;
- a concise reproduction that uses synthetic data only;
- impact and likely prerequisites; and
- a suggested mitigation, if known.

Please allow reasonable time for investigation and remediation before public disclosure. This project cannot revoke provider credentials or bank consent for you; if a local deployment may be exposed, immediately revoke or rotate the affected provider credentials and consent, delete the provider session, clear local credentials, and contact Enable Banking or the relevant bank.

## Deployment security

- Run the server only with an MCP client or AI host you trust.
- Keep macOS, the Keychain, browser, backups, environment variables, and logs protected.
- Never commit credentials or financial data.
- Use the personal, noncommercial boundary documented in [README.md](README.md).
- Review current Enable Banking terms and bank consent screens before use.
