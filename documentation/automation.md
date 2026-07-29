# Automation And External Side Effects

RoundRelay embeds local Agent automation and an Agent installer. There are no webhooks, server jobs, email automations, cron schedules, or unattended recurring tasks.

## Automation Inventory

| Automation | Trigger / owner | Automatic scope | External side effects |
| --- | --- | --- | --- |
| Manual Agent reply | Local user sends a message and selects targets | Invokes selected Agents sequentially once | Agent process, Provider/native network use, local message/session writes |
| Automatic discussion | Local user starts it after sending a topic | Alternates group Agents for a user-selected bound of 2 to 12 turns | Same as manual replies, repeated within the bound |
| Agent detection/readiness | App startup or explicit refresh | Scans fixed command names and credential evidence | Local process/file reads; Claude may run `auth status --json` |
| Agent installation | Local user confirms installation | One installer task at a time | Network download/npm access and global CLI installation |
| Managed OpenClaw setup | OpenClaw invocation with configured Provider | Writes isolated runtime configuration if changed | Local config directories/files; Provider call by OpenClaw |

## Agent Invocation Contract

**Inputs Agents may read:**

- The current user message.
- A bounded recent transcript for the same group/topic.
- Group name/topic and selected working directory.
- Only the selected Agent's native credentials and optional configured Provider values.

**Executable/tool surface:**

- Main may spawn only detected executables for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, Claude Code, Qwen Code, Gemini CLI, and OpenCode.
- Command shapes are code-defined in `desktop/src/cli-adapters.cjs`; prompt text does not select an arbitrary executable or shell command.
- OpenClaw receives an explicit tool allow/deny configuration. Execution, process, browser, gateway, cron, messaging, session spawning, and subagent tools are denied; write/edit/apply-patch are added only when the conversation permits writes.
- Other CLIs receive their supported plan/read-only or edit permission flags. These flags are hard guardrails outside the prompt, but enforcement ultimately depends on the upstream CLI.

**Steering:**

- `LocalWorkspace.promptFor` identifies the Agent, includes bounded same-topic context, and asks it not to impersonate other Agents.

**Output contract:**

- CLI-specific parsers reduce output to `{ text, sessionRef }`.
- Output size and runtime are bounded in the adapter; secrets found in child errors are redacted before persistence.
- Successful text becomes a local Agent message. Failures become local system messages; an all-failed manual run rejects after recording each failure.

## Workspace Side Effects

- Read-only is the default.
- The user must explicitly enable `allowWrite` for a conversation.
- Main passes write permission per invocation; it does not grant a renderer filesystem API.
- Agents run with the local OS user's process identity. RoundRelay is not an OS-level sandbox.

## Installer Contract

**Approval:** The renderer requires confirmation before calling `agentInstaller.start`.

**Hard guardrails:**

- Fixed Agent catalog and OS-specific recipes.
- Fixed npm package names or HTTPS hosts.
- Validated npm executable/shim handling, especially on Windows.
- Sensitive ambient variables removed from the installer environment.
- One concurrent task, bounded download size, version verification after installation, and temporary-file cleanup.

**Known limitation:** Recipes currently use mutable upstream packages/scripts without digest or signature verification. Host/package allowlisting reduces arbitrary input risk but does not make upstream content immutable.

## Controls And Operations

| Control | Implementation |
| --- | --- |
| User approval | Send/start-auto/install actions originate from explicit UI commands; install uses confirmation |
| Rate/bounds | Manual targets run sequentially; auto discussion is capped at 12 turns; one installer task at a time |
| Cancellation | Per-group stop aborts the process tree; installer cancel aborts download/process; quit waits for cleanup |
| Failure handling | No background retry loop; errors are returned or stored as local system messages |
| Audit trail | Conversation messages and current run state are local; there is no separate immutable audit log |
| Kill switch | Stop the active group, cancel the installer, or quit the application |

## App-Owned Versus Agent-Owned Actions

- The app owns persistence, permission selection, process launch, installer selection, Provider encryption, and cancellation.
- Agents own generated text and any work they perform through their CLI under the granted mode.
- Agent suggestions do not directly mutate RoundRelay configuration; configuration changes require renderer IPC handled by main.
