# Terms of Use

**Status:** Draft template — complete the bracketed fields and obtain any legal review required for your use before relying on these terms in a Production application.

**Last updated:** [INSERT DATE]

**Operator:** [YOUR FULL LEGAL NAME OR COMPANY]

**Contact:** [YOUR CONTACT EMAIL]

These Terms of Use govern access to and use of the Enable Banking MCP deployment identified by the operator. By installing, configuring, or using the deployment, you agree to these Terms. If you do not agree, do not use it.

## 1. What the software does

The Enable Banking MCP is local software that helps an authorized user interact with the Enable Banking Control Panel and Enable Banking API. It can start bank authorization flows, retrieve authorized account information, and, when explicitly requested, create or submit payments.

The MCP is not a bank, payment institution, financial adviser, lender, accounting service, or investment service. It does not guarantee that a bank, ASPSP, Enable Banking, or any other third-party service will be available, accurate, complete, or compatible with the deployment.

### Self-hosted software; user responsibility

Unless the repository maintainer has separately agreed in writing to operate a specific deployment, the repository maintainer only distributes the software and does not operate the user's Enable Banking application, provide a hosted banking service, or control the user's data. The person or organization that installs, configures, and uses a deployment is responsible for the deployment, its users, its data-protection obligations, its provider agreements, and all actions taken through its Enable Banking application.

## 2. Eligibility and authority

You may use the deployment only if you are legally able to enter these Terms and have authority to:

- access the Enable Banking Control Panel account;
- register or operate the relevant Enable Banking application;
- authorize access to the bank accounts and data you select; and
- initiate or approve any payment you submit.

You must not use the deployment to access another person's account or data without valid authority and consent. You must comply with applicable law, bank terms, Enable Banking terms, payment-network rules, and any regulatory obligations that apply to your use.

## 3. Credentials and local security

The deployment may generate and store an Enable Banking application private key, application ID, certificate, Control Panel tokens, and session identifiers on the local computer. You are responsible for:

- protecting the computer, operating-system account, Keychain, backups, and MCP client;
- keeping private keys, tokens, authorization codes, and session IDs confidential;
- not placing credentials or financial data in source control, public issues, prompts, logs, or untrusted tools;
- revoking or rotating credentials if they may have been exposed; and
- checking the identity and security of any MCP client or AI host that can invoke the deployment.

Anyone with sufficient access to the local computer or MCP client may be able to request or view sensitive financial data. The operator is not responsible for disclosure caused by failure to secure those systems, except to the extent liability cannot legally be excluded.

## 4. Authorization and account access

A Control Panel email-link login authenticates the Control Panel user. It does not by itself authorize access to bank data.

Bank data access requires a separate authorization and consent flow with the relevant bank or ASPSP. The user must review the authorization screen and approve only the access they intend to grant. Sessions and consents may expire, be revoked, or be limited to particular accounts, services, dates, or transaction types.

A Production application activated by linking the operator's own accounts may remain in restricted mode. Restricted applications can access only the accounts whitelisted through the applicable Enable Banking process. Linking an account does not grant unrestricted access to other accounts.

## 5. Financial data and payments

You are responsible for reviewing all account and transaction information before relying on it. Data may be delayed, incomplete, reformatted, unavailable, or changed by a bank or Enable Banking.

Payment functions can create financial consequences. Before creating or submitting a payment, you must independently verify the beneficiary, account identifier, amount, currency, reference, execution date, and destination. You are responsible for confirming that the payment is intended and authorized. Do not rely solely on an AI-generated instruction or summary.

The operator does not promise that a payment will be accepted, settled, reversed, or completed by a bank or payment network. Bank and payment-provider terms govern the payment itself.

## 6. Prohibited use

You must not:

- access, copy, or disclose data without authorization;
- impersonate another person or bypass bank, Enable Banking, or application security;
- use the deployment for fraud, money laundering, sanctions evasion, or other unlawful activity;
- submit an unauthorized, deceptive, or malicious payment;
- interfere with, overload, probe, or reverse-engineer third-party services except where expressly permitted;
- upload private keys, tokens, bank data, or personal data to public repositories or untrusted services;
- use the deployment to make decisions about another person where applicable law requires safeguards, notice, or human review; or
- remove security warnings, consent notices, audit information, or access restrictions.

## 7. Third-party services

The deployment depends on Enable Banking, banks, ASPSPs, payment networks, the operating system, the MCP client, and potentially other providers. Those providers have separate terms, privacy notices, fees, availability commitments, and security responsibilities.

The operator is responsible for reviewing and complying with the terms of each provider used. A provider may change, suspend, limit, or terminate access without control by the operator. These Terms do not grant rights to use any third-party API, brand, account, or financial service.

## 8. Availability and changes

The deployment may contain defects and may stop working when a provider changes an API, authentication flow, bank integration, certificate requirement, or policy. The operator may update, suspend, or discontinue the deployment at any time. No particular uptime, response time, data freshness, or feature availability is promised unless a separate written agreement says otherwise.

## 9. Intellectual property

The software, documentation, names, and original materials remain owned by their respective rights holders. Use of the software is subject to the license included with the applicable repository or release, if any. These Terms do not transfer ownership of the software, Enable Banking services, bank data, payment-network data, or third-party materials.

You retain your rights in data that you are legally entitled to provide and process. You grant only the permissions needed for the deployment and its configured providers to perform the requested operations.

## 10. Privacy

Processing of personal data is described in the [Privacy Policy](privacy-policy.md). You must provide any additional notice, obtain any additional consent, and maintain any required records when you use the deployment for other people or for a business service.

## 11. Disclaimers

To the maximum extent permitted by law, the deployment and related information are provided **as is** and **as available**, without warranties of any kind, whether express, implied, or statutory. This includes no warranty that the deployment will be uninterrupted, error-free, secure, accurate, current, suitable for a particular purpose, or compatible with every bank or provider.

Nothing in these Terms excludes or limits liability, rights, warranties, or remedies that cannot legally be excluded or limited. The operator should obtain professional legal, regulatory, tax, accounting, and financial advice for the intended use.

## 12. Liability

To the maximum extent permitted by law, [YOUR FULL LEGAL NAME OR COMPANY] is not liable for indirect, incidental, special, consequential, exemplary, or punitive losses, or for losses caused by a bank, Enable Banking, payment network, MCP client, AI host, operating system, network, unauthorized access, inaccurate data, delayed data, rejected payment, or provider outage.

Any liability cap, exclusions, or indemnity language must be reviewed and adapted to the operator's jurisdiction, business model, and applicable consumer-protection law.

## 13. Suspension and termination

You must stop using the deployment if you no longer have authorization, if these Terms are breached, or if continued use could harm another person or provider. The operator may suspend access where necessary for security, legal compliance, provider requirements, or misuse prevention.

On termination, stop using the deployment, revoke active consents and sessions where appropriate, remove locally stored credentials, and securely delete data that is no longer needed. Termination does not undo transactions already submitted or obligations owed to a bank or provider.

## 14. Governing law and disputes

These Terms are governed by the laws of **[INSERT JURISDICTION]**, without regard to conflict-of-law rules. Courts located in **[INSERT VENUE]** will have jurisdiction, subject to any mandatory consumer or statutory rights that apply.

## 15. Changes and contact

The operator may update these Terms when the deployment, providers, or legal requirements change. The current version should be made available at the terms URL supplied to Enable Banking.

Questions about these Terms should be sent to:

**[YOUR FULL LEGAL NAME OR COMPANY]**  
**[YOUR CONTACT EMAIL]**  
**[YOUR BUSINESS OR POSTAL ADDRESS, IF REQUIRED]**

This template is not legal advice. Replace the bracketed fields and adapt the Terms to the actual operator, jurisdiction, license, deployment, providers, commercial model, and legal obligations before Production use.
