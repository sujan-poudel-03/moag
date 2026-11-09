> **Draft — pending owner approval.** Private vulnerability reporting must be enabled in the repository settings (Security › Private vulnerability reporting) before this is published.

# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem: MOAG's bug reports are public.

Report it privately through GitHub:
[github.com/sujan-poudel-03/moag/security/advisories/new](https://github.com/sujan-poudel-03/moag/security/advisories/new).

Include what you found, how to reproduce it, and the MOAG version (`moag --version`, or the
Extensions view). **MOAG: Export Diagnostics** writes a redacted report you can attach; read it
before you share it.

We aim to acknowledge a report within 5 working days and to agree a disclosure date with you once a
fix is ready.

## Supported versions

Security fixes go into the latest released version of the extension. Update to it before
reporting, if you can.

## What is in scope

- The VS Code extension and the bundled `moag` command-line tool.
- Secret handling: the Anthropic API key in VS Code's secret storage, the ONOSOO device key in the
  user config folder, and the redaction applied to everything relayed to ONOSOO or put in a report.
- The headless daemon, the remote runner account isolation, and the host agent's gateway.

Problems in an AI engine's own CLI, in ONOSOO's hosted service, or in GitHub belong to those
projects.
