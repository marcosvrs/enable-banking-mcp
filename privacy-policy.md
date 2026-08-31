# Privacy Policy

**Status:** Draft template — complete the bracketed fields and obtain any legal review required for your use before relying on this policy in a Production application.

**Last updated:** [INSERT DATE]

**Data controller:** [YOUR FULL LEGAL NAME OR COMPANY]

**Privacy contact:** [YOUR PRIVACY CONTACT EMAIL]

This Privacy Policy explains how the operator of an Enable Banking MCP deployment handles personal data when the deployment is used to connect to the Enable Banking Control Panel, the Enable Banking API, and participating banks.

## 1. Scope and roles

The Enable Banking MCP is local software. It runs on the computer where it is installed and sends requests to third-party services only when the user or an authorized MCP client invokes a function.

For a self-hosted deployment, the person or organization operating and configuring the deployment is normally responsible for determining the purposes and means of processing. That operator is referred to as **the operator**, **we**, or **us** in this policy.

Enable Banking and each participating bank operate their own services and may act as independent controllers or processors depending on the relevant transaction and legal arrangement. Their own privacy notices, terms, and data-processing arrangements also apply. This policy does not replace them.

### Self-hosted deployment responsibility

Unless the repository maintainer has separately agreed in writing to operate a specific deployment, the repository maintainer does not operate the user's Enable Banking application and is not the data controller for data processed by that deployment. The person or organization that configures and uses a deployment is responsible for identifying itself as the operator, selecting the lawful purposes and retention periods, providing the required notices and contact details, and complying with applicable data-protection law.

## 2. Personal data we process

Depending on which functions are used, the deployment may process the following categories:

- **Control Panel identity data:** the email address used for Enable Banking Control Panel sign-in and authentication identifiers returned by the Control Panel.
- **Application and security data:** the Enable Banking application ID, certificate, locally generated private key, Control Panel access and refresh tokens, session IDs, consent IDs, authorization codes, and expiry information.
- **Banking data:** account identifiers and details, account names, balances, transaction records, account metadata, consent status, and related bank or ASPSP information returned after authorization.
- **Payment data:** payment instructions, beneficiary details, amounts, currencies, payment IDs, payment status, and payment transactions if payment functions are used.
- **Configuration data:** application name, redirect URL, selected country and bank, application description, data-protection contact, privacy-policy URL, terms URL, and consent-expiry settings.
- **Technical data:** request and response metadata, timestamps, error information, network information, and operating-system information processed by Enable Banking, the bank, the operating system, or the MCP client as part of providing their services.

The deployment does not intentionally collect advertising identifiers, sell personal data, or include independent advertising or analytics tracking. The operating system, MCP client, AI host, Enable Banking, and the bank may nevertheless create their own logs.

## 3. How data is used

Personal data is used only as necessary to:

1. authenticate the operator to the Enable Banking Control Panel;
2. register and maintain an Enable Banking application;
3. generate and use application authentication credentials;
4. start and complete bank authorization and consent flows;
5. retrieve authorized account, balance, transaction, and payment information;
6. create, monitor, or submit payments when explicitly requested and authorized;
7. maintain security, prevent misuse, troubleshoot failures, and comply with legal obligations; and
8. provide support when the operator contacts us.

The operator must define and document the lawful basis for each processing activity. Depending on the deployment, this may include consent, performance of a contract, compliance with a legal obligation, or a legitimate interest that does not override the data subject's rights.

## 4. Where data is sent and who receives it

The deployment may send data to or receive data from:

- **Enable Banking**, to authenticate the Control Panel user, register the application, manage authorization, and provide API connectivity;
- **the selected bank or ASPSP**, when the user completes a bank authorization or payment-consent flow;
- **the local MCP client or AI host**, because data returned by an MCP function is made available to the client that requested it; and
- **service providers or authorities**, only where necessary to operate the deployment, comply with law, protect rights, or investigate misuse.

We do not sell personal data or share it for targeted advertising. The operator must not use the MCP with an untrusted MCP client or AI host, because that client may receive sensitive financial data returned by the API.

## 5. Local storage and retention

The current macOS implementation stores application credentials, Control Panel authentication, and the current Enable Banking session in macOS Keychain. The application private key is generated locally and is not sent to Enable Banking; the corresponding certificate is used when registering the application.

The MCP does not operate a central database for the operator's banking data. API responses may exist temporarily in process memory and may be retained by the MCP client, AI host, operating system, backups, diagnostic tools, or third-party providers according to their own settings and policies.

The operator should retain data only for as long as necessary for the stated purpose. The operator can clear locally stored credentials using the available logout or cleanup functions, revoke or delete sessions where supported, unlink accounts through the relevant Control Panel or bank flow, and remove operating-system backups or logs under their control. Deleting local data does not automatically delete data held by Enable Banking or a bank.

## 6. Security

The deployment is designed to keep application credentials in macOS Keychain, use TLS for remote requests, use a local loopback callback for browser authorization, and avoid exposing access or refresh tokens in normal status responses. No security measure is perfect.

The operator is responsible for securing the computer, macOS user account, Keychain, MCP client, AI host, backups, environment variables, redirect configuration, and any logs. Private keys, tokens, session IDs, bank data, and payment data must not be placed in source control, issue reports, prompts, or other untrusted locations.

If you believe credentials or personal data have been exposed, immediately revoke or rotate the affected credentials, contact Enable Banking or the relevant bank where appropriate, and contact the privacy address above.

## 7. Data subject rights

Subject to applicable law, data subjects may have rights to request access, correction, deletion, restriction, portability, or objection, and to withdraw consent. Requests should be sent to:

**Privacy contact:** [YOUR PRIVACY CONTACT EMAIL]

Please provide enough information for us to identify the relevant deployment without sending passwords, private keys, tokens, full account numbers, or unnecessary transaction data. Because Enable Banking and banks may independently control some data, a request may also need to be sent to the relevant provider.

A complaint may be made to the data-protection supervisory authority applicable to the data subject or the operator.

## 8. International transfers

Enable Banking, participating banks, MCP clients, AI hosts, and infrastructure providers may process data in countries different from the data subject's country. The operator must review the applicable provider terms and ensure that any required transfer mechanism, notice, and safeguards are in place.

## 9. Children

The deployment is not intended for children. Do not use it to process a child's personal or financial data unless the operator has a lawful basis and all required safeguards and consents.

## 10. Changes

We may update this policy when the deployment, providers, or legal requirements change. The current version should be made available at the policy URL used for the Enable Banking application.

## 11. Contact

For privacy questions or requests, contact:

**[YOUR FULL LEGAL NAME OR COMPANY]**  
**[YOUR PRIVACY CONTACT EMAIL]**  
**[YOUR BUSINESS OR POSTAL ADDRESS, IF REQUIRED]**

This template is not legal advice. Replace the bracketed fields and adapt the policy to the actual operator, jurisdiction, deployment, data flows, retention periods, and legal obligations.
