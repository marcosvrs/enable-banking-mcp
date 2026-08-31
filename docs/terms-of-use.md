---
title: Terms of Use
permalink: /terms-of-use/
---

# Terms of Use

**Status:** General personal-use terms for self-hosted deployments
**Effective date:** 2026-08-31
**Operator:** The person who runs a deployment; this repository appoints no operator
**Contact:** This repository publishes no deployment contact address
**Governing law and venue:** These repository terms do not appoint a controller, establish a hosted-service contract, or assert an exclusive venue.

These terms describe the intended personal, self-hosted use of
**Enable Banking MCP**. They do not create an agreement between the repository
maintainer and a user, do not make the maintainer responsible for a deployment
or a user's actions, and do not create terms for a hosted service or other
users.

The repository's [MIT License](../LICENSE) governs the software itself. These
terms do not replace that license or the separate terms of Enable Banking, a
bank, an ASPSP, an MCP client, an AI host, or any other provider.

## 1. Supported personal deployment

This release is a read-only personal AIS client intended only for:

- one individual using a local installation;
- that individual's own Enable Banking Control Panel application;
- that individual's own bank accounts and financial data;
- Sandbox use or a personal linked-account evaluation in restricted
  Production, where Enable Banking permits that use; and
- account details, balances, and transaction history explicitly authorized
  through a bank consent flow.

This release is not a hosted service, multi-user platform, business tool,
professional service, or commercial banking integration. Do not use it for a
business or professional account, another person's account, third-party data,
shared credentials, resale, or any use prohibited by a provider.

The source code is open source under the MIT License. That license permits
downstream reuse of the code; it does not grant permission to use Enable
Banking, a bank, an ASPSP, or any provider commercially or outside that
provider's eligibility rules.

## 2. Provider terms and authorization

Use is subject to the current terms, privacy notices, technical requirements,
and eligibility decisions of Enable Banking, the selected bank or ASPSP, the
MCP client, the AI host, and the operating system. Relevant Enable Banking
materials include:

- [Enable Banking Terms](https://enablebanking.com/terms/)
- [Enable Banking Privacy Notice](https://enablebanking.com/privacy/)
- [Enable Banking API End User Terms](https://tilisy.enablebanking.com/terms)
- [Enable Banking API documentation](https://enablebanking.com/docs/api/)

Enable Banking may limit free or restricted Production use to personal
linked-account evaluation and may prohibit business, commercial, third-party,
resale, or automated use. This software does not override those restrictions
or represent that Enable Banking has approved this repository.

The individual operator must review the bank authorization screen and grant
only the intended access. A Control Panel email link authenticates the Control
Panel user; it does not itself authorize bank-data access. The deployment must
not access an account or data without valid authority and consent.

## 3. Included functions and excluded side effects

The available functions cover Control Panel authentication/status/logout,
first-run application setup, personal AIS authorization, application and
health status, personal AIS bank discovery, current-session operations,
account details, balances, transactions, and local credential cleanup.

This release does not expose payment initiation, payment submission, PIS,
payment cancellation, arbitrary Control Panel requests, arbitrary session
IDs, or forwarded PSU header injection. It must not be treated as a payment
product or used to approve a financial side effect.

## 4. Credentials and local security

The deployment may generate or use an Enable Banking application ID, RSA
private key, certificate, Control Panel authentication record, and current
session ID in macOS Keychain or operator-supplied environment variables. A
person running a deployment should:

- protect the macOS account, Keychain, browser, MCP client, AI host, backups,
  and network;
- keep private keys, tokens, authorization codes, session IDs, and financial
  data confidential;
- never put credentials or financial data in source control, prompts, public
  issues, or untrusted tools;
- verify the MCP client and AI host before allowing them to invoke tools;
- rotate or revoke affected credentials, sessions, and consents after
  suspected exposure; and
- use `clear_local_credentials` when local teardown is required, understanding
  that environment variables and provider-side records need separate cleanup.

The person running a deployment chooses whether and how to use the software.
This repository does not control, approve, or accept responsibility for that
use.

## 5. Prohibited use

The individual operator must not:

- access, copy, disclose, or infer financial data without authorization;
- impersonate a user or bypass bank, provider, application, or consent
  controls;
- use the deployment for fraud, money laundering, sanctions evasion, or
  unlawful activity;
- use it with business, professional, commercial, hosted, shared, or
  third-party account access;
- use it where current provider terms prohibit bots, automation, or this
  integration;
- probe, overload, reverse-engineer, scrape, or bypass limits or security of a
  third-party service;
- upload private keys, tokens, bank data, or personal data to public or
  untrusted services;
- remove consent notices, state checks, TLS protections, access restrictions,
  or security warnings; or
- misrepresent this repository as an Enable Banking service, partner, approved
  application, bank, payment institution, or financial adviser.

## 6. Data and privacy

Processing is described in the [Privacy Policy](privacy-policy.md). A person
running a deployment should review that policy and the provider notices before
using a Production application. The repository maintainer distributes source
code and does not operate deployments or receive their tool results.

## 7. Third-party services and availability

Enable Banking, banks, ASPSPs, the Control Panel, the operating system,
browsers, MCP clients, AI hosts, networks, and other providers may change,
suspend, restrict, or terminate service. They may impose fees, limits, review,
KYC, consent, data-retention, or regional requirements.

The deployment may contain defects or stop working after a provider changes an
API, bank connector, authentication flow, certificate rule, or policy. No
uptime, response time, data freshness, compatibility, or continued availability
is promised.

## 8. Intellectual property

Original repository code and documentation are licensed under the [MIT
License](../LICENSE). Enable Banking names, marks, APIs, Control Panel, bank
services, bank data, and third-party materials remain the property of their
respective rights holders. These terms grant no right to use a third-party
service or brand.

## 9. Disclaimers and liability

To the maximum extent permitted by law, the deployment and related information
are provided **as is** and **as available**, without warranties of any kind,
including warranties of uninterrupted operation, accuracy, security,
currentness, fitness for a particular purpose, or compatibility with a
particular provider.

The deployment is not financial, investment, tax, accounting, legal,
regulatory, payment, or security advice. Obtain professional advice for any
use beyond the supported personal scope.

Nothing in these terms excludes or limits liability, rights, warranties, or
remedies that cannot legally be excluded or limited under applicable law.

## 10. Suspension and termination

A person running a deployment should stop using it if authorization ends, a
provider prohibits the use, applicable terms are breached, or continued use
could harm a person or provider. On teardown, delete the provider session and
revoke or unlink consent where appropriate, call
`clear_local_credentials`, remove environment variables, and remove logs or
backups under the person's control. Local cleanup does not undo provider-side
records or completed transactions.

## 11. Changes and contact

This page is reference information for personal self-hosted use. A person
running a deployment must publish and maintain any deployment-specific terms,
contact channel, jurisdiction, and other legal information required for that
deployment.

This repository publishes no personal or corporate contact address.

These terms are not legal advice and do not replace the separate terms of
Enable Banking or any bank.
