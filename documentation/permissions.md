# Permissions

## Identity Model

RoundRelay has no login, account, role, claim, tenant, server session, or database authorization layer. The local OS user who launches the application is the only human actor.

Authorization is process-bound:

- Electron main is the trusted enforcement boundary.
- The renderer is an untrusted UI client.
- Preload exposes a fixed IPC surface only to the local `file:` document.
- Every privileged IPC handler verifies the current main frame and exact bundled frontend path.

## Resource Matrix

| Resource / operation | Local user through trusted renderer | Other document/frame | Agent child process | Enforcement |
| --- | --- | --- | --- | --- |
| Read sanitized workspace snapshot | Allowed | Denied | No IPC access | `requireDesktopRenderer`; `LocalWorkspace.snapshot` removes executable paths |
| Create/update/delete groups and messages | Allowed | Denied | No direct state-file API | Named IPC handlers plus `LocalWorkspace` validation |
| Select a working directory | Allowed through OS dialog | Denied | Receives selected path only at invocation | Main-owned `dialog.showOpenDialog` |
| Enable workspace writes | Explicit per-conversation opt-in | Denied | Receives write mode only when enabled | Stored `allowWrite`; per-CLI permission flags |
| Detect Agents | Allowed | Denied | N/A | Code-defined command catalog; executable paths stay in main |
| Install an Agent | Explicit confirmation; one active task | Denied | Installer child runs fixed recipe | Allowlisted Agent, command, package/URL, and OS checks |
| Read Provider status | Metadata only | Denied | N/A | `ProviderStore.status` excludes API key |
| Save/remove Provider key | Allowed through Provider form | Denied | Compatible Agent receives scoped environment at invocation | Exact four-field payload, URL validation, `safeStorage` |
| Open external URL | Credential-free HTTPS in OS browser | In-window navigation denied | N/A | `isAllowedExternalUrl`; `setWindowOpenHandler`; `will-navigate` |
| Camera, microphone, Bluetooth, webview, generic Electron permissions | Denied | Denied | N/A | BrowserWindow settings and permission handlers |

## Renderer Boundary

`desktop/src/preload.cjs` exposes only:

- `localWorkspace`: get/refresh/create/update/delete/send/start/stop/directory selection/change events.
- `agentInstaller`: catalog/state/start/cancel/sidebar visibility/change events.
- `localAgentProvider`: non-probing status, explicit encryption probe, save, and delete.

Node integration, webviews, insecure content, and renderer permission requests are disabled. The packaged Electron fuses disable `runAsNode`, Node option injection, CLI inspect arguments, and loading app code outside `app.asar`.

## Filesystem Permissions

- RoundRelay state is written only by main.
- Provider and managed OpenClaw secret-bearing files use atomic writes and mode `0600`; their directories use mode `0700` where created by those modules.
- Conversation data is local JSON and is not application-encrypted.
- Agent executable paths are stripped from renderer snapshots.
- Agent filesystem access is scoped to the selected working directory by RoundRelay arguments/configuration where the upstream CLI supports it.

## Process And Network Permissions

- Only supported Agent kinds can be invoked.
- Child environments begin with a system-variable allowlist, then add only the selected Agent's native credentials and optional configured Provider values.
- Installer environments remove variables whose names look like keys, tokens, secrets, passwords, credentials, cookies, authorization, or prompts.
- Provider URLs require HTTPS, except loopback HTTP for local development.
- Installer scripts require HTTPS and an allowlisted host; npm packages are selected from a fixed map.

## Explicit Limitations

- There is no per-user permission separation inside the app because there is no account model.
- An Agent process runs with the operating-system permissions of the local user. RoundRelay permission flags reduce capability but are not an OS sandbox.
- Installer approval authorizes an external system modification. Package/script integrity is not currently pinned.
