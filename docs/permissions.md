# Permissions

## Identity Model

Meldwork has no login, account, role, claim, tenant, server session, or database authorization layer. The local OS user who launches the application is the only human actor.

Authorization is process-bound:

- Electron main is the trusted enforcement boundary.
- The renderer is an untrusted UI client.
- Preload exposes a fixed IPC surface only to the local `file:` document.
- Every privileged IPC handler verifies the current main frame and exact bundled frontend path.

## Resource Matrix

| Resource / operation | Local user through trusted renderer | Other document/frame | Agent child process | Enforcement |
| --- | --- | --- | --- | --- |
| Read sanitized workspace snapshot | Allowed | Denied | No IPC access | `requireDesktopRenderer`; `LocalWorkspace.snapshot` removes executable paths |
| Create/update/delete Meldwork conversations and messages | Allowed | Denied | No direct state-file API | Named IPC handlers plus `LocalWorkspace` validation; deletion is blocked while running and must purge app-owned Run Ledger records before conversation state |
| Receive active/terminal run state | Sanitized events and compact message traces only | Denied | N/A | Main allowlists run/conversation IDs, Agent kinds, status, conclusion deltas, summarized reasoning/plan/tool events, source message IDs, and bounded result metadata; direct details render inline and group details render in the right panel |
| Read or mutate the private Run Ledger | No direct API | Denied | No direct API | Electron main owns `RunLedger`; renderer receives live allowlisted events and durable compact message capsules, never the ledger file or arbitrary records |
| Create operating-system notifications | Not directly allowed | Denied | N/A | Main creates notifications only from trusted terminal run events; renderer cannot supply notification content |
| Select a working directory | Allowed through OS dialog | Denied | Receives selected path only at invocation | Main-owned `dialog.showOpenDialog` |
| List/select local Skills | Sanitized coordinates and display names for installed target Agents | Denied | Receives only its validated selections in prompt/native arguments | Installed-Agent gate; main-owned `LocalSkillCatalog`; per-target revalidation; no renderer-supplied path |
| Probe/select knowledge sources | Sanitized readiness plus the user-selected Obsidian Vault path | Denied | Receives only target-scoped, validated read-only access hints | Code-defined catalog; main-owned probes/dialog; per-run revalidation; planned OAuth sources cannot be selected |
| Import/preview/discard images | Allowed through picker, exact paste payload, attachment ID, and discard list | Denied | Receives a main-resolved path only for an authorized invocation | Main-owned dialog and `AttachmentStore`; type/size/dimension/checksum validation; referenced files cannot be discarded |
| Enable workspace writes | Explicit per-conversation opt-in | Denied | Enforced adapters receive write mode only when enabled; Hermes/OpenClaw remain Agent-managed | Stored `allowWrite`; per-CLI permission flags where supported |
| Detect Agents | Allowed | Denied | N/A | Code-defined command catalog; executable paths stay in main |
| Install an Agent | Explicit confirmation; one active task | Denied | Installer child runs fixed recipe | Allowlisted Agent, command, package/URL, and OS checks |
| Read Provider status | Metadata only | Denied | N/A | `ProviderStore.status` excludes API key |
| Save/remove Provider key | Allowed through Provider form | Denied | Compatible Agent receives scoped environment at invocation | Exact four-field payload, URL validation, `safeStorage` |
| Open external URL | Credential-free HTTPS in OS browser | In-window navigation denied | N/A | `isAllowedExternalUrl`; `setWindowOpenHandler`; `will-navigate` |
| Camera, microphone, Bluetooth, webview, generic Electron permissions | Denied | Denied | N/A | BrowserWindow settings and permission handlers |

## Renderer Boundary

`desktop/src/preload.cjs` exposes only:

- `localWorkspace`: get/refresh/create/update/delete/send/directory selection, a stop request bound to the current `(groupId, runId)`, plus sanitized change, run-event, run-finished, and notification-open events.
- `agentInstaller`: catalog/Skill listing/state/start/cancel/sidebar visibility/change events. Skill listing accepts one Agent kind and returns sanitized records only.
- `localAttachments`: `pickImages`, exact-payload `importImage`, ID-only `preview`, and ID-list `discard`. It exposes no filesystem read, path resolution, or arbitrary file picker method.
- `localAgentProvider`: non-probing status, explicit encryption probe, save, and delete.
- `localKnowledgeBase`: source status, code-defined external setup guides, and a main-owned Obsidian Vault directory picker.

Node integration, webviews, insecure content, and renderer permission requests are disabled. The packaged Electron fuses disable `runAsNode`, Node option injection, CLI inspect arguments, and loading app code outside `app.asar`.

## Filesystem Permissions

- Meldwork state is written only by main.
- `roundrelay-run-ledger.json` is written atomically by main as a private `0600` file; parent directories created by the private writer use `0700`. It retains at most 64 bounded sanitized runs and is purged before its conversation is removed.
- Provider and managed OpenClaw secret-bearing files use atomic writes and mode `0600`; their directories use mode `0700` where created by those modules.
- Imported PNG/JPEG copies live under the Electron user-data attachment directory. The root/entry directories use mode `0700`, files use `0600`, metadata carries a SHA-256 checksum, and symlink/path escape or tampering fails closed.
- Conversation data and bounded sanitized Run Ledger records are private local JSON but are not application-encrypted. The ledger assumes one Electron main-process writer and is a recovery/audit aid, not an immutable forensic log.
- Raw chain-of-thought, commands, unrestricted stdout/stderr, arbitrary tool payloads, Agent executable paths, native session IDs, native session storage paths, attachment paths, Skill paths, preview payloads, and credential material are stripped from renderer snapshots, lifecycle events, compact trace capsules, and Run Ledger records. User-selected conversation workdirs are intentionally returned for display and editing.
- Main scans known per-Agent Skill roots and reads only bounded Skill manifest prefixes for catalog metadata. The renderer cannot request an arbitrary directory or file.
- `KnowledgeBaseStore` persists only the normalized user-selected Obsidian Vault path. Feishu and DingTalk authentication remain in their local CLI-owned stores; Meldwork does not receive or persist their tokens.
- Knowledge-source selection accepts only code-defined source kinds. Main resolves an allowlisted CLI command name or the selected absolute Vault path and scopes the hint to explicit target Agents.
- Agent filesystem access is scoped to the selected working directory by Meldwork arguments/configuration where the upstream CLI supports it.

## Process And Network Permissions

- Only supported Agent kinds can be invoked.
- Skill selections are limited to four, must still exist in the selected Agent's current catalog, and are routed only to that Agent. Hermes receives validated slugs through its native `--skills` flags; no renderer value becomes an arbitrary CLI argument.
- Knowledge-source selections are limited to four, must be currently readable, and are routed only to their selected target Agents. Feishu/DingTalk command names come from main-side detection, not renderer input; Obsidian paths come from the main-owned directory picker.
- Image references are limited to four and are resolved inside main. Codex and OpenCode accept up to four; Hermes accepts one; unsupported or unequal multi-Agent context is rejected before any child process starts.
- Child environments begin with a system-variable allowlist, then add only the selected Agent's native credentials and optional configured Provider values.
- Installer environments remove variables whose names look like keys, tokens, secrets, passwords, credentials, cookies, authorization, or prompts.
- Provider URLs require HTTPS, except loopback HTTP for local development.
- Installer scripts require HTTPS and an allowlisted host; npm packages are selected from a fixed map.
- Once `before-quit` starts, every trusted IPC handler rejects new work with `DESKTOP_CLIENT_SHUTTING_DOWN` until active runs and installer work have settled.
- A renderer stop request must name the currently visible `runId`; stale or malformed run identifiers cannot abort a newer run. A successful response acknowledges cancellation, while the conversation remains locked until bounded child/output cleanup settles.

## Explicit Limitations

- There is no per-user permission separation inside the app because there is no account model.
- An Agent process runs with the operating-system permissions of the local user. Meldwork permission flags reduce capability but are not an OS sandbox.
- Imported images are private local copies but are not application-encrypted; when sent, their contents may reach the selected Agent's configured model Provider.
- Knowledge-source content is not copied into Meldwork by the selection flow, but an invoked Agent may read selected documents or Vault files and send relevant content to its configured Provider. Current read-only behavior is an explicit task instruction plus source capability constraints, not an OS sandbox or a universal upstream-tool guarantee.
- Installer approval authorizes an external system modification. Package/script integrity is not currently pinned.
