# Architecture

## Product Boundary

Meldwork is a local Electron desktop product for direct and multi-Agent conversations with explicitly selected Skill, image, and knowledge-source context. It has no account system, tenant model, application server, remote conversation service, database, email delivery, scheduled jobs, or public SEO surface.

The supported product surface is the packaged Electron application. The frontend is a renderer bundle; without the local preload bridge it shows a desktop-required state and cannot operate the workspace.

## Components

| Component | Responsibility | Primary evidence |
| --- | --- | --- |
| Vue renderer | Agent-first multi-session UI, direct-session rename/delete, live direct-chat conclusions and inline execution summaries, group-chat result streaming with an expandable per-Agent/right-side trace panel, per-round navigation, background completion markers, first-run carousel, conversation/Skill/image/knowledge composer UI, bounded attachment-preview cache, theme/i18n, user confirmation and input collection | `frontend/src/App.vue`, `frontend/src/components/RunTracePanel.vue`, `frontend/src/composables/useAttachmentPreviews.js`, `frontend/src/desktop.js`, `frontend/src/knowledgeBaseCatalog.js` |
| Electron preload | Exposes narrow workspace, installer/Skill, attachment, Provider, and knowledge-source methods through `window.roundrelayDesktop` only to a local `file:` document | `desktop/src/preload.cjs` |
| Electron main | Trust boundary for IPC authorization and shutdown gating, persistence, attachment import/preview, Skill and knowledge-source validation, process execution, navigation, sanitized run events, operating-system notifications, Provider storage, and installer control | `desktop/src/main.cjs` |
| Local workspace | Persists Meldwork conversations, final replies, compact evidence capsules, safe message metadata, one main-only native session reference per conversation and Agent, legacy topic-reference migration, Agent-specific transcript deltas, Agent preferences/runtime evidence, and active run coordination | `desktop/src/local-workspace.cjs` |
| Run Ledger | Atomically checkpoints bounded, sanitized per-run and per-Agent state for stop/crash recovery, marks nonterminal runs and Agent attempts interrupted after restart, supports idempotent reconciliation of missing terminal Agent messages, and purges records with their conversation | `desktop/src/run-ledger.cjs` |
| Attachment store | Imports validated local images into private app-owned storage, verifies metadata/checksums on read, and removes unreferenced entries | `desktop/src/attachment-store.cjs`, `desktop/src/image-dimensions.cjs` |
| Local Skill catalog | Scans bounded known roots per Agent and returns sanitized Skill coordinates without exposing paths or contents | `desktop/src/local-skill-catalog.cjs` |
| Local knowledge-source catalog | Detects and probes code-defined Feishu, DingTalk, and Obsidian access modes, returns sanitized readiness, validates task selections, and exposes reference-only future sources | `desktop/src/local-knowledge-base.cjs` |
| Knowledge-source store | Persists only the user-selected Obsidian Vault path; Feishu and DingTalk credentials remain owned by their local CLIs | `desktop/src/knowledge-base-store.cjs` |
| CLI adapters | Detect and invoke supported local Agent executables with per-Agent arguments and constrained child environments | `desktop/src/cli-adapters.cjs` |
| Agent installer | Detects Agents and runs allowlisted npm packages or official installer scripts after user confirmation | `desktop/src/agent-installer.cjs` |
| Provider store | Validates Provider metadata and encrypts the API key with Electron `safeStorage` | `desktop/src/provider-store.cjs` |
| Managed OpenClaw runtime | Creates isolated local configuration and a restricted tool policy for OpenClaw | `desktop/src/openclaw-runtime.cjs` |

## Trust Boundaries

1. The renderer is not trusted with Node.js, Agent executable paths, native Agent session IDs or storage paths, attachment paths, Skill paths/contents, raw Provider credentials after saving, arbitrary filesystem reads, or arbitrary process execution. User-selected conversation workdirs and the user-selected Obsidian Vault path are intentional UI-visible paths; pasted image bytes use one exact import payload.
2. Preload exposes only named IPC methods. Main validates that every request comes from the current main frame and exact bundled frontend file.
3. Main owns local files, OS dialogs, attachment validation/storage, Skill and knowledge-source discovery/revalidation, Agent discovery, child processes, installer downloads, and credential encryption.
4. Agent CLIs are external processes. They receive a selected working directory, a constrained environment, permission flags, main-resolved image paths, target-scoped Skill context, and validated read-only knowledge-source hints after capability checks.
5. Provider and installer network destinations are external trust boundaries. Provider URLs are user supplied and validated; installer URLs/packages are code-defined allowlists.
6. Harness events expose only allowlisted status, conclusion deltas, reasoning summaries, plans, tool lifecycle summaries, bounded result metadata, and source message IDs. Raw chain-of-thought, commands, executable paths, native session references, credentials, unrestricted stdout/stderr, and arbitrary tool payloads remain outside the renderer and shared Agent context.

## Local Data

| Data | Location | Protection |
| --- | --- | --- |
| Meldwork conversations, messages, native session-reference mappings, Agent preferences/runtime evidence | Electron user data: `roundrelay-workspace.json` | Local JSON written through main; native references are keyed by conversation and Agent, remain main-only, and snapshots remove executable paths |
| Bounded run checkpoints | Electron user data: `roundrelay-run-ledger.json` | Atomic private writes; `0600` file, with new parent directories created as `0700`; at most 64 sanitized runs with bounded Agent output/events/source IDs; no raw commands, paths, credentials, or native session references |
| Imported image attachments | Electron user data under `attachments/` | App-owned copy; `0700` directories, `0600` files, magic/MIME/size/dimension validation, metadata checksum, ID-only renderer access |
| Provider metadata and encrypted key | Electron user data: `roundrelay-provider.json` | API key encrypted with `safeStorage`; file written atomically with mode `0600` |
| Knowledge-source preference | Electron user data: `roundrelay-knowledge-base.json` | Stores the selected absolute Obsidian Vault path only; written atomically as a private file |
| Managed OpenClaw state/config | Electron user data under `openclaw-managed/` | Per-scope directories, mode `0700`; config mode `0600`; API key passed by child environment |
| Theme, locale, and onboarding completion | Renderer `localStorage` | Non-secret UI preferences |

Live renderer events remain transient. Main separately checkpoints a bounded sanitized run snapshot, while final replies and compact evidence capsules are stored with local conversation messages so a group result can reopen its trace without retaining raw tool output. A conclusion already emitted through answer deltas is retained in the terminal failure, timeout, stop, or interruption message. On restart, nonterminal checkpoints become `interrupted`, then every recoverable terminal Agent checkpoint that is not already represented in the conversation is materialized with its recorded status and output. Completed and partial attempts become Agent messages; failed, timed-out, stopped, and interrupted attempts become status-specific system messages. If a matching `agentRunId` message already exists but lacks its Ledger output, reconciliation enriches it once. Writable Agents are never auto-resumed. Persisted attachment references contain safe metadata only, and Skill references contain sanitized target/namespace/slug/name coordinates. Renaming a conversation preserves its native sessions; changing its working directory clears them to prevent cross-workspace resume. Deleting a Meldwork conversation must first remove its Run Ledger records, then remove its app-owned messages, native session-reference mapping, and attachments no longer referenced elsewhere. It does not call a CLI-specific deletion command or remove history stored by Codex, Hermes, or another Agent CLI.

There is no remote data store or application account namespace. Managed OpenClaw paths are isolated by local conversation and working-directory scope inside Electron's per-user data directory.

## Network Surface

- Agent CLIs may call their own configured model providers.
- Selected images and Skill-influenced prompts may be sent by an Agent CLI to its configured model provider after local validation.
- Compatible Agents may receive the user-configured Provider URL/model/key from main.
- Feishu and DingTalk readiness probes may invoke their configured local CLIs; a selected Agent may then use those CLI connections with read-only instructions.
- A selected Obsidian Vault may be read by the invoked Agent under the local OS user's permissions.
- The installer may download fixed Hermes/Kimi installer URLs or invoke npm for fixed package names.
- Credential-free HTTPS links may be opened in the operating-system browser; remote navigation is denied inside the Electron window.
- The renderer CSP uses `connect-src 'self'` and does not directly call model or application APIs.

## Known Risks And Assumptions

- Installer recipes use mutable upstream packages or scripts and currently do not verify a pinned digest or signature (`desktop/src/agent-installer.cjs`).
- Conversation history is local but not application-encrypted (`desktop/src/local-workspace.cjs`).
- Sanitized Run Ledger checkpoints are local and private but not application-encrypted. The store assumes one Electron main-process writer and recovers only the last persisted bounded checkpoint, not every in-memory event (`desktop/src/run-ledger.cjs`).
- Conversation deletion is privacy-first across two local JSON stores rather than transactional: Ledger records are removed first; if the workspace write then fails, in-memory conversation state is rolled back and remains retryable, but the deleted trace checkpoints are not recreated.
- Imported attachment copies are private and integrity-checked but not application-encrypted (`desktop/src/attachment-store.cjs`).
- Local Skill files are untrusted prompt input. Main prevents renderer-supplied paths and cross-Agent selection, but a selected Skill can still influence Agent behavior (`desktop/src/local-skill-catalog.cjs`, `desktop/src/local-workspace.cjs`).
- Knowledge-source access is currently prompt-mediated. Meldwork validates readiness and scope, but it does not yet index content, capture deterministic source snapshots, verify every citation, or enforce read-only behavior inside every upstream Agent tool.
- Feishu and DingTalk authentication and document permissions remain owned by their local CLIs. Notion, Confluence, Google Drive, and SharePoint are reference-only planned sources and are not active Connectors.
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
