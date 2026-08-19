# Security Policy

## Supported Versions

Security updates are currently provided only for the latest version of Signal.

| Version | Supported |
| ------- | --------- |
| Latest release / `main` | ✅ |
| Older versions | ❌ |

Users should always use the latest deployed version of the application.

## Reporting a Vulnerability

Please do not publish security vulnerabilities in public GitHub Issues.

To report a vulnerability:

1. Open the **Security** tab of this repository.
2. Select **Advisories**.
3. Click **Report a vulnerability**.
4. Describe the problem and provide clear steps to reproduce it.

Please include:

- the affected page or API endpoint;
- steps needed to reproduce the issue;
- screenshots or logs without passwords, tokens, PINs, card details, ICCIDs, or other personal information;
- the potential impact;
- suggested remediation, if available.

## Response Process

- We aim to acknowledge a report within 3 business days.
- We aim to provide an initial assessment within 7 business days.
- Confirmed critical vulnerabilities will be prioritized immediately.
- The reporter will receive updates while the issue is being investigated.
- Public disclosure should occur only after a fix has been released.

Reports made in good faith will not result in action against the reporter, provided they avoid accessing, changing, downloading, or deleting other users’ data and do not disrupt the service.

## Scope

Security reports may cover:

- account authentication and PIN protection;
- administrator-panel access;
- unauthorized access to user information;
- payment and Stripe integration security;
- eSIM information exposure;
- support-ticket access;
- session handling;
- privilege escalation;
- exposed secrets or credentials.

General support requests, payment refunds, eSIM activation problems, and feature suggestions are not security vulnerabilities and should be submitted through the application’s support section.
