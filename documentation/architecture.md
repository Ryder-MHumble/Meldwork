# Architecture

## Product Boundary

RoundRelay is a local Electron desktop product for direct and multi-Agent conversations. It has no account system, tenant model, application server, remote conversation service, database, email delivery, scheduled jobs, or public SEO surface.

The supported product surface is the packaged Electron application. The frontend is a renderer bundle; without the local preload bridge it shows a desktop-required state and cannot operate the workspace.

## Components

| Component | Responsibility | Primary evidence |
| --- | --- | --- |
| Vue renderer | Conversation UI, Agent catalog UI, theme/i18n, user confirmation and input collection | `frontend/src/App.vue`, `frontend/src/desktop.js` |
| Electron preload | Exposes a narrow `window.roundrelayDesktop` API only to a local `file:` document | `desktop/src/preload.cjs` |
| Electron main | Trust boundary for IPC authorization, persistence, process execution, navigation, Provider storage, and installer control | `desktop/src/main.cjs` |
| Local workspace | Persists groups, messages, session references, Agent availability, and running state | `desktop/src/local-workspace.cjs` |
| CLI adapters | Detect and invoke supported local Agent executables with per-Agent arguments and constrained child environments | `desktop/src/cli-adapters.cjs` |
| Agent installer | Detects Agents and runs allowlisted npm packages or official installer scripts after user confirmation | `desktop/src/agent-installer.cjs` |
| Provider store | Validates Provider metadata and encrypts the API key with Electron `safeStorage` | `desktop/src/provider-store.cjs` |
| Managed OpenClaw runtime | Creates isolated local configuration and a restricted tool policy for OpenClaw | `desktop/src/openclaw-runtime.cjs` |

## Trust Boundaries

1. The renderer is not trusted with Node.js, executable paths, raw Provider credentials after saving, or arbitrary process execution.
2. Preload exposes only named IPC methods. Main validates that every request comes from the current main frame and exact bundled frontend file.
3. Main owns local files, OS dialogs, Agent discovery, child processes, installer downloads, and credential encryption.
4. Agent CLIs are external processes. They receive a selected working directory, a constrained environment, and permission flags chosen by main.
5. Provider and installer network destinations are external trust boundaries. Provider URLs are user supplied and validated; installer URLs/packages are code-defined allowlists.

## Local Data

| Data | Location | Protection |
| --- | --- | --- |
| Groups, messages, sessions, Agent preferences/runtime state | Electron user data: `roundrelay-workspace.json` | Local JSON written through main; snapshots remove executable paths |
| Provider metadata and encrypted key | Electron user data: `roundrelay-provider.json` | API key encrypted with `safeStorage`; file written atomically with mode `0600` |
| Managed OpenClaw state/config | Electron user data under `openclaw-managed/` | Per-scope directories, mode `0700`; config mode `0600`; API key passed by child environment |
| Theme and locale | Renderer `localStorage` | Non-secret UI preferences |

There is no remote data store or application account namespace. Managed OpenClaw paths are isolated by local conversation and working-directory scope inside Electron's per-user data directory.

## Network Surface

- Agent CLIs may call their own configured model providers.
- Compatible Agents may receive the user-configured Provider URL/model/key from main.
- The installer may download fixed Hermes/Kimi installer URLs or invoke npm for fixed package names.
- Credential-free HTTPS links may be opened in the operating-system browser; remote navigation is denied inside the Electron window.
- The renderer CSP uses `connect-src 'self'` and does not directly call model or application APIs.

## Known Risks And Assumptions

- Installer recipes use mutable upstream packages or scripts and currently do not verify a pinned digest or signature (`desktop/src/agent-installer.cjs`).
- Conversation history is local but not application-encrypted (`desktop/src/local-workspace.cjs`).
- Read-only enforcement depends partly on each upstream CLI honoring its permission flags; RoundRelay adds per-CLI hardening where available (`desktop/src/cli-adapters.cjs`).
- Provider requests and native Agent authentication are external dependencies; RoundRelay cannot guarantee their availability or data handling.
- macOS packaging uses ad-hoc signing for local validation, not a notarized public release (`desktop/scripts/after-pack.cjs`).

## Capability Absences

- No email sending, so there is no `emails.md`.
- No cron or scheduled background work, so there is no `cron.md`.
- No supported public or indexable routes, so there is no `seo.md`.

## Related Documents

- [Flows](flows.md)
- [Permissions](permissions.md)
- [Variables And Secrets](variables.md)
- [Test Coverage](tests.md)
- [Automation](automation.md)
