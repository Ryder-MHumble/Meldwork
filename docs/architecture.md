# Architecture

## Product Boundary

Meldwork is a local Electron desktop product for direct and multi-Agent conversations. It has no account system, tenant model, application server, remote conversation service, database, email delivery, scheduled jobs, or public SEO surface.

The supported product surface is the packaged Electron application. The frontend is a renderer bundle; without the local preload bridge it shows a desktop-required state and cannot operate the workspace.

## Components

| Component | Responsibility | Primary evidence |
| --- | --- | --- |
| Vue renderer | Agent-first multi-session UI, direct-session rename/delete, per-Agent and per-round run status, background completion markers, first-run carousel, conversation/Skill/image composer UI, bounded attachment-preview cache, dismissible warnings, collapsed execution details, theme/i18n, user confirmation and input collection | `frontend/src/App.vue`, `frontend/src/composables/useAttachmentPreviews.js`, `frontend/src/desktop.js` |
| Electron preload | Exposes narrow workspace, installer/Skill, attachment, and Provider methods through `window.roundrelayDesktop` only to a local `file:` document | `desktop/src/preload.cjs` |
| Electron main | Trust boundary for IPC authorization and shutdown gating, persistence, attachment import/preview, Skill catalog access, process execution, navigation, sanitized run events, operating-system notifications, Provider storage, and installer control | `desktop/src/main.cjs` |
| Local workspace | Persists Meldwork conversations, safe message metadata, one main-only native session reference per conversation and Agent, legacy topic-reference migration, Agent-specific transcript deltas, Agent preferences/runtime evidence, and transient active/terminal run state | `desktop/src/local-workspace.cjs` |
| Attachment store | Imports validated local images into private app-owned storage, verifies metadata/checksums on read, and removes unreferenced entries | `desktop/src/attachment-store.cjs`, `desktop/src/image-dimensions.cjs` |
| Local Skill catalog | Scans bounded known roots per Agent and returns sanitized Skill coordinates without exposing paths or contents | `desktop/src/local-skill-catalog.cjs` |
| CLI adapters | Detect and invoke supported local Agent executables with per-Agent arguments and constrained child environments | `desktop/src/cli-adapters.cjs` |
| Agent installer | Detects Agents and runs allowlisted npm packages or official installer scripts after user confirmation | `desktop/src/agent-installer.cjs` |
| Provider store | Validates Provider metadata and encrypts the API key with Electron `safeStorage` | `desktop/src/provider-store.cjs` |
| Managed OpenClaw runtime | Creates isolated local configuration and a restricted tool policy for OpenClaw | `desktop/src/openclaw-runtime.cjs` |

## Trust Boundaries

1. The renderer is not trusted with Node.js, executable paths, native Agent session IDs or storage paths, attachment paths, Skill paths/contents, raw Provider credentials after saving, arbitrary filesystem reads, or arbitrary process execution. User-selected conversation workdirs are the only filesystem paths intentionally shown back to the renderer; pasted image bytes use one exact import payload.
2. Preload exposes only named IPC methods. Main validates that every request comes from the current main frame and exact bundled frontend file.
3. Main owns local files, OS dialogs, attachment validation/storage, Skill discovery/revalidation, Agent discovery, child processes, installer downloads, and credential encryption.
4. Agent CLIs are external processes. They receive a selected working directory, a constrained environment, permission flags, main-resolved image paths, and only their target-scoped Skill context after capability checks.
5. Provider and installer network destinations are external trust boundaries. Provider URLs are user supplied and validated; installer URLs/packages are code-defined allowlists.

## Local Data

| Data | Location | Protection |
| --- | --- | --- |
| Meldwork conversations, messages, native session-reference mappings, Agent preferences/runtime evidence | Electron user data: `roundrelay-workspace.json` | Local JSON written through main; native references are keyed by conversation and Agent, remain main-only, and snapshots remove executable paths |
| Imported image attachments | Electron user data under `attachments/` | App-owned copy; `0700` directories, `0600` files, magic/MIME/size/dimension validation, metadata checksum, ID-only renderer access |
| Provider metadata and encrypted key | Electron user data: `roundrelay-provider.json` | API key encrypted with `safeStorage`; file written atomically with mode `0600` |
| Managed OpenClaw state/config | Electron user data under `openclaw-managed/` | Per-scope directories, mode `0700`; config mode `0600`; API key passed by child environment |
| Theme, locale, and onboarding completion | Renderer `localStorage` | Non-secret UI preferences |

Active progress and terminal run events are transient and are not added to conversation messages. Persisted attachment references contain safe metadata only, and Skill references contain sanitized target/namespace/slug/name coordinates. Renaming a conversation preserves its native sessions; changing its working directory clears them to prevent cross-workspace resume. Deleting a Meldwork conversation removes its app-owned messages, native session-reference mapping, and attachments no longer referenced elsewhere, but does not call a CLI-specific deletion command or remove history stored by Codex, Hermes, or another Agent CLI.

There is no remote data store or application account namespace. Managed OpenClaw paths are isolated by local conversation and working-directory scope inside Electron's per-user data directory.

## Network Surface

- Agent CLIs may call their own configured model providers.
- Selected images and Skill-influenced prompts may be sent by an Agent CLI to its configured model provider after local validation.
- Compatible Agents may receive the user-configured Provider URL/model/key from main.
- The installer may download fixed Hermes/Kimi installer URLs or invoke npm for fixed package names.
- Credential-free HTTPS links may be opened in the operating-system browser; remote navigation is denied inside the Electron window.
- The renderer CSP uses `connect-src 'self'` and does not directly call model or application APIs.

## Known Risks And Assumptions

- Installer recipes use mutable upstream packages or scripts and currently do not verify a pinned digest or signature (`desktop/src/agent-installer.cjs`).
- Conversation history is local but not application-encrypted (`desktop/src/local-workspace.cjs`).
- Imported attachment copies are private and integrity-checked but not application-encrypted (`desktop/src/attachment-store.cjs`).
- Local Skill files are untrusted prompt input. Main prevents renderer-supplied paths and cross-Agent selection, but a selected Skill can still influence Agent behavior (`desktop/src/local-skill-catalog.cjs`, `desktop/src/local-workspace.cjs`).
- Native image support is currently limited to Codex, Hermes, and OpenCode, with different per-run limits; mixed groups fail before execution when they cannot receive equal image context (`desktop/src/cli-adapters.cjs`).
- Read-only enforcement depends partly on each upstream CLI honoring its permission flags; Meldwork adds per-CLI hardening where available (`desktop/src/cli-adapters.cjs`).
- Provider requests and native Agent authentication are external dependencies; Meldwork cannot guarantee their availability or data handling.
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
