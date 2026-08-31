---
title: Privacy Policy
permalink: /privacy-policy/
---

# Privacy Policy

**Status:** General personal-use notice for self-hosted deployments
**Effective date:** 2026-08-31
**Controller:** Each deployment's controller, if any, is the person running that deployment; this repository appoints none.
**Contact:** This repository publishes no deployment contact address.

This notice describes the personal-data processing that may occur when a
person runs a local installation of **Enable Banking MCP**. It is not the
privacy policy of Enable Banking, a bank, an ASPSP, an MCP client, an AI host,
or the repository maintainer. It does not identify, appoint, or make the
repository maintainer responsible for any deployment or user's actions.

## 1. Scope and roles

Enable Banking MCP runs on the computer where the individual operator installs
it. It is used only for the operator's own personal, noncommercial
account-information access:

- Control Panel email-link authentication and application registration;
- personal AIS authorization for the operator's own linked account;
- retrieval of account details, balances, and transaction history; and
- local storage and deletion of application, session, and Control Panel
  credentials.

This deployment is not a hosted service and is not intended for another
person's data, business accounts, professional use, payment initiation, or
commercial use.

The person running each deployment determines the purposes and means of that
deployment's local processing. This repository does not operate deployments,
receive their tool results, or assume responsibility for their users. Enable
Banking and each participating bank or ASPSP process data under their own
terms and privacy notices and may have their own controller or processor role:

- [Enable Banking Privacy Notice](https://enablebanking.com/privacy/)
- [Enable Banking Terms](https://enablebanking.com/terms/)
- [Enable Banking API End User Terms](https://tilisy.enablebanking.com/terms)

## 2. Data processed

Depending on the functions used, the local deployment may handle:

- **Control Panel data:** the sign-in email, one-time-link callback data, and
  authentication tokens returned by the Control Panel;
- **application security data:** the application ID, RSA private key,
  certificate, authorization state, session ID, and expiry values;
- **banking data:** account identifiers and details, balances, transaction
  records, account metadata, consent status, and ASPSP information returned by
  Enable Banking;
- **configuration data:** application name, environment, redirect URL, country,
  selected ASPSP, description, data-protection email, privacy URL, terms URL,
  and consent access profile; and
- **technical data:** timestamps, request outcomes, error information, network
  metadata, and operating-system or MCP-client data created while the operator
  uses the deployment.

The deployment does not intentionally add advertising identifiers, analytics,
profiling, or a central database.

## 3. Sources and purposes

Data comes from the individual operator, the Enable Banking Control Panel, the
operator's selected bank or ASPSP, the local operating system, and the MCP
client or AI host.

The operator uses it to:

1. authenticate to the Control Panel;
2. register and maintain the operator's Enable Banking application;
3. sign API requests with the application's private key;
4. start and complete a personal bank consent flow;
5. retrieve the account information the operator authorized;
6. maintain local security, troubleshoot failures, and delete local
   credentials; and
7. meet applicable provider and legal obligations.

The applicable legal basis depends on the operator's jurisdiction and facts,
and may include the operator's consent or a contract with the relevant
provider. This notice does not claim a legal basis for Enable Banking or a
bank.

## 4. Disclosures and data flows

The deployment sends or exposes data as follows:

- **Enable Banking Control Panel:** the operator's email and
  application-registration fields during setup;
- **Enable Banking API:** signed requests and the account, balance, and
  transaction data returned for the current session;
- **selected bank or ASPSP:** information exchanged during authorization and
  consent;
- **local browser:** the authorization URL and the local HTTPS loopback
  callback;
- **MCP client or AI host:** every result returned by an invoked tool,
  including sensitive financial data; and
- **operator-controlled systems:** backups, logs, endpoint protection, or
  diagnostics if they capture process or filesystem data.

The repository maintainer does not receive tool results from a self-hosted
deployment.

## 5. Local storage and retention

The current macOS implementation stores the following in macOS Keychain:

- the application ID, private key, and certificate;
- the current Enable Banking session ID; and
- the Control Panel authentication record.

Large credential records may be stored across multiple related Keychain
records. The private key is generated or supplied by the operator and is used
to sign API requests. The certificate is registered with Enable Banking and
may be trusted locally for the HTTPS loopback callback. API responses and
callback codes are held in process memory while used; the MCP does not
intentionally persist banking responses.

The retention schedule for this personal deployment is:

| Data | Retention |
| --- | --- |
| Control Panel authentication | Until logout, expiry, or `clear_local_credentials` |
| Application private key and certificate | Until application teardown or `clear_local_credentials` |
| Current session ID | Until `delete_session`, expiry, or `clear_local_credentials` |
| API responses and callback data | Process memory only unless the MCP client, AI host, logs, or backups retain them |
| Operational logs and diagnostics | Only as retained by the operator's operating system and tools |

`clear_local_credentials` clears local Keychain records and attempts to remove
the locally trusted certificate. It does not delete provider-side records,
revoke bank consent, erase environment variables, erase MCP-client or AI-host
history, or erase backups. The operator must use the relevant provider controls
and `delete_session` where appropriate.

## 6. Security

The deployment uses HTTPS for remote API requests and the bank-consent
callback, binds callback responses to a one-time state value, restricts
callbacks to an explicit loopback host and port, and avoids returning
credentials in status tools. The Control Panel email-link callback is also
loopback-only and state-bound.

The person running a deployment controls the macOS account and Keychain,
environment variables, certificate trust, browser, MCP client, AI host,
network, backups, logs, and access to the computer. This repository does not
control those systems. Private keys, tokens, authorization codes, session IDs,
account data, and transactions should not be placed in source control,
prompts, public issues, or untrusted tools.

If data or credentials may have been exposed, the person running the affected
deployment should stop use, clear or rotate local credentials, delete or revoke
the relevant provider session or consent, and contact Enable Banking or the
bank as appropriate.

## 7. Rights and requests

Subject to applicable law, data subjects may have rights of access,
correction, deletion, restriction, portability, objection, and withdrawal of
consent. Requests about a deployment should be sent to the controller or
operator of that deployment, or to the relevant provider. This repository
does not operate the deployment and does not provide a data-subject contact
channel.

Do not send passwords, private keys, tokens, full account numbers, or
unnecessary transaction data with a request. Enable Banking and a bank may
independently control their data, so a request may also need to be directed to
the relevant provider. A complaint may be made to the applicable supervisory
authority.

## 8. International transfers and providers

The person running a deployment does not control the locations, subprocessors,
or transfer mechanisms used by Enable Banking, banks, MCP clients, AI hosts,
operating systems, or infrastructure. Their current terms and privacy notices
govern those services. The person running a deployment should review those
materials and applicable law.

## 9. Children

This deployment is intended for the individual operator's own personal
financial information and is not designed for children's data.

## 10. Changes and contact

This notice is reference information for personal self-hosted use. The person
running a deployment must publish and maintain any deployment-specific notice,
contact channel, retention schedule, and legal information required for that
deployment.

This repository publishes no personal or corporate contact address.

This notice is not legal advice. It does not replace the separate notices and
terms of Enable Banking or any bank.
