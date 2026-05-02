# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues, pull requests, or discussions first.

Use GitHub private vulnerability reporting when it is enabled for the public repository. If that private channel is not available yet, contact the maintainer privately through [indielabs.tech](https://indielabs.tech/) rather than opening a public exploit report. Clearly label the message as `Security`. Include:

- A short summary of the issue
- Affected components, files, or endpoints
- Reproduction steps or proof of concept
- Impact assessment
- Any suggested mitigation, if you have one

Project maintainers will review the report privately and follow up from there.

## Scope

Security reports are especially helpful for:

- Secrets handling
- Worker authentication or abuse protections
- Browser extension permission boundaries
- Cross-origin request handling
- Data leakage in logs, docs, or public assets

## Supported usage model

This repository is designed for self-hosted deployments. Operators are responsible for:

- Protecting their own API keys and Cloudflare account resources
- Configuring any optional abuse controls they need
- Reviewing changes before deploying them into their own environment
