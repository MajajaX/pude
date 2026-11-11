# Security policy

`pude` is a local-first editor, but it can read and modify files, start local
processes, invoke Git, and load local plugins. Treat the desktop application as a
program with access to the workspace and the permissions of the logged-in OS user.

## Security scope

pude prioritizes a fast, reliable local code editor. Locally installed plugins are
code the user chooses to trust; users are responsible for their plugin selection and
execution. pude does not promise to contain malicious plugins or provide an OS sandbox
for plugins, terminals, Git, or language servers.

pude keeps the protections needed for the editor itself:

- Preserve user data through conflict-aware saves, atomic replacement, dirty-buffer
  protection, and recoverable checkpoints.
- Validate paths and operation targets to prevent accidental writes outside the
  intended location; bound IO, messages, and process cleanup to keep the editor usable.
- Protect application and release credentials, and avoid recording secrets or
  document contents in logs.
- Keep automatic workspace inspection distinct from explicit program execution.
- Make installation and permission choices accurately describe actual capabilities.
  Plugin-level trust confirmation is the current design; any individual deny
  controls must behave as stated.

Existing checks remain implementation safeguards. Comprehensive malicious-plugin
containment, fine-grained authorization expansion, WebView bypass certification,
encrypted recovery storage, and additional supply-chain isolation are future
hardening work.

## Private reporting

Report vulnerabilities through GitHub Private Vulnerability Reporting for this
repository. Maintainers must enable it in the repository's **Settings → Security and
quality → Advanced Security → Private vulnerability reporting** before this channel
is available ([GitHub setup guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)).

When enabled, open the repository's **Security and quality** tab and select **Report
a vulnerability**. Do not report a vulnerability in a public issue, discussion, or
pull request ([GitHub reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)).

If the private reporting option is unavailable, do not send vulnerability details
publicly. Contact a maintainer through GitHub only to request an enabled private
channel, without including sensitive details in that request.

Please include, when safe to do so:

- a short description of the issue and its potential impact;
- the affected version, commit, platform, and configuration;
- minimal reproduction steps using synthetic files or values;
- a redacted log or stack trace; and
- any known workaround or indication that the issue may already be public.

Maintainers will try to confirm receipt, reproduce the report privately, coordinate a
fix or mitigation, and publish release or advisory details when appropriate. Response
times and disclosure dates are not guaranteed.

## Supported versions

Security fixes target the latest release and the `main` branch.

| Version | Security support |
| --- | --- |
| Latest 0.1.x release | Supported on a best-effort basis. |
| `main` branch | Supported on a best-effort basis. |
| Forks and older builds | Reproduce on the latest release; fixes for older copies are not promised. |

## Trust boundaries and user data

The following describes the current implementation and its intended boundaries.
WebView bypass validation has not been performed. These controls do not isolate
terminal commands or repositories at OS level.

### Plugins

Plugins are installed from local files and run in a Web Worker with a small
`pude` facade. The Worker is hosted by an opaque-origin sandbox
(`allow-scripts` without `allow-same-origin`). API 2 uses saved grants for host calls;
the legacy API 1 facade checks the manifest rather than saved grants.
These implementation controls are not a guarantee against malicious plugin code.
Production CSP is intended to block direct plugin network APIs; API 2
HTTPS requests instead use a host proxy with current domain grants. The restricted
LSP manager starts only approved executables/arguments. Neither mechanism is a complete OS sandbox. Install only
plugins whose source and origin you trust.

### Terminal and external processes

The terminal starts local processes with the user's OS account, environment, filesystem
access, and usually network access. Shell startup files, scripts, build tools, Git
hooks, and commands entered there can read or modify data outside the open workspace.
The terminal is a command console rather than a security boundary or a secret manager;
do not paste passwords, tokens, private keys, or recovery material into it.

A project's Python virtual environment (`.venv`, `venv` or `env`) is not activated
automatically, because a cloned repository could otherwise put its own executables
first on `PATH`. The terminal reports that it found one and activates it only after
you run **Terminal: Trust Python Environment** for that project folder. The choice is
remembered per folder on this machine and **Terminal: Stop Trusting Python
Environment** reverts it. Shell startup files and commands you type still run
unrestricted, so this limits only what pude does for you.

### File access

The file commands (read, save, save as, rename, delete and list directory) act on any
path the logged-in OS user can reach; they are not confined to the open workspace.
The frontend that calls them is the application's own, loaded from the app bundle
under a strict production Content-Security-Policy that allows no remote scripts and
connects only to the app's own IPC, and it is trusted. Only the workspace image preview is restricted
to the open workspace.

### Git and repositories

Git operations use the external Git installation and repository configuration. A
repository can contain hooks, attributes, filters, submodules, and scripts that affect
commands such as commit, checkout, merge, or build. Review repository contents and
hooks before running commands, and treat an untrusted repository as untrusted code.

### Local storage and recovery

The app may persist workspace paths, open tabs, settings, plugin state, and recovery
content in local WebView storage. This application layer does not promise encryption;
access to the OS account, profile, backups, or other local processes may expose that
data. Do not paste recovery snapshots or unsaved proprietary source into public issue
trackers.

## Public issue hygiene

Never put the following in an issue, pull request, screenshot, or log:

- passwords, API tokens, SSH keys, signing keys, certificates with private material,
  cookies, or recovery codes;
- complete recovery/session exports, unsaved document contents, or proprietary source;
- unredacted paths, environment dumps, terminal transcripts, or plugin bundles that
  contain private data.

Use synthetic values and the smallest reproducible fixture. If a secret was exposed,
revoke or rotate it first, then use the private reporting channel with a redacted
description.
