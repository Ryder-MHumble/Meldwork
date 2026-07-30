# Automation And External Side Effects

RoundRelay embeds local Agent automation and an Agent installer. There are no webhooks, server jobs, email automations, cron schedules, or unattended recurring tasks.

## Automation Inventory

| Automation | Trigger / owner | Automatic scope | External side effects |
| --- | --- | --- | --- |
| Manual Agent reply | Local user sends a message and selects targets | Invokes selected Agents sequentially once | Agent process, Provider/native network use, local message/session writes |
| Automatic discussion | Local user starts it after sending a topic | Runs every group Agent in complete rounds, up to 12 rounds or 30 minutes, and stops early on unanimous explicit consensus | Same as manual replies, repeated within the bound |
| Agent detection/readiness | App startup or explicit refresh | Scans fixed command names and credential evidence | Local process/file reads; Claude may run `auth status --json` |
| Agent installation | Local user confirms installation | One installer task at a time | Network download/npm access and global CLI installation |
| Managed OpenClaw setup | OpenClaw invocation with configured Provider | Writes isolated runtime configuration if changed | Local config directories/files; Provider call by OpenClaw |
| Run completion notification | A manual or automatic run reaches a terminal state while the app window is unfocused | Main emits one sanitized lifecycle event and one local operating-system notification | Local notification only; no network request or conversation message |

## Agent Invocation Contract

**Inputs Agents may read:**

- The current user message.
- A bounded recent transcript for the same group/topic.
- Group name/topic and selected working directory.
- Main-resolved paths for selected root images when the target Agent's declared capability accepts the complete set. Automatic discussion keeps offering the root images to each Agent until that Agent first receives them successfully.
- Up to four main-revalidated Skill hints scoped to the selected target Agent. Hermes also receives the validated Skill slugs through its native `--skills` arguments.
- Only the selected Agent's native credentials and optional configured Provider values.

**Executable/tool surface:**

- Main may spawn only detected executables for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, Claude Code, Qwen Code, Gemini CLI, and OpenCode.
- Command shapes are code-defined in `desktop/src/cli-adapters.cjs`; prompt text does not select an arbitrary executable or shell command.
- Kimi read-only conversations use Agent Client Protocol `plan` mode. Write-authorized conversations retain Kimi's native stream-JSON prompt mode.
- OpenClaw receives an explicit tool allow/deny configuration. Execution, process, browser, gateway, cron, messaging, session spawning, and subagent tools are denied; write/edit/apply-patch are added only when the conversation permits writes.
- Other CLIs receive their supported plan/read-only or edit permission flags. These flags are hard guardrails outside the prompt, but enforcement ultimately depends on the upstream CLI.

**Steering:**

- `LocalWorkspace.promptFor` identifies the Agent, includes bounded same-topic context, and asks it not to impersonate other Agents.
- Automatic discussion preflights root-image limits for every Agent, so each participant can receive the same root image set or the run does not start. This equal-context guarantee applies to root-image availability, not identical prompts: Agents still run sequentially, so later participants can see earlier replies, while native sessions and Skill hints remain Agent-specific.

**Output contract:**

- CLI-specific parsers reduce output to final text, a main-only native session reference, bounded execution metadata, and completion state where the protocol exposes it.
- Output size and runtime are bounded in the adapter; secrets found in child errors are redacted before persistence.
- Before launching Hermes, main makes a best-effort read of the message-ID watermark through Electron's read-only SQLite API. After exit, a non-empty post-watermark `assistant` row with `finish_reason` equal to `stop` or `length` is authoritative. If the database is absent, locked, incompatible, or has no current-turn final row, RoundRelay falls back to the ANSI-stripped official `--quiet` stdout instead of blocking the Agent. Any newly reported native session reference is persisted before this lookup. Final text becomes `message.content`; up to eight sanitized process steps and elapsed time remain separate metadata and are not included in later Agent prompts.
- Successful final text becomes a local Agent message. User-visible failure diagnostics remain local system messages; an all-failed manual run resolves after recording each failure because the user message has already been accepted and persisted.
- Active progress and terminal statuses are separate transient events. They are not appended to the durable message history, native session references are never exposed to the renderer, listener failures cannot change a completed run result, and shutdown suppresses terminal desktop notifications.
- Automatic replies carry an internal final-line consensus marker. RoundRelay removes the marker before persistence and stops only when every Agent completes and agrees in the same round.

## Workspace Side Effects

- `allowWrite` defaults to false. Adapters with enforceable permission modes receive read-only/plan arguments until the user explicitly opts into writes.
- Hermes and OpenClaw do not expose an equivalent RoundRelay-enforced read-only switch, so their capability label remains Agent-managed permissions regardless of `allowWrite`.
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
| Rate/bounds | Manual targets run sequentially; auto discussion is capped at 12 complete rounds and 30 minutes; one installer task at a time |
| Cancellation | Per-group stop aborts the process tree; installer cancel aborts download/process; quit waits for cleanup |
| Failure handling | Validation and submission errors are returned before persistence; execution failures after acceptance are stored as local diagnostic messages. Automatic runs isolate a failed Agent, continue the round, and retry it in later bounded rounds; terminal state is emitted separately |
| Audit trail | Conversation messages and bounded execution metadata are local; active/terminal events are transient and there is no separate immutable audit log |
| Kill switch | Stop the active group, cancel the installer, or quit the application |

## App-Owned Versus Agent-Owned Actions

- The app owns RoundRelay conversation persistence, permission selection, process launch, run lifecycle events, operating-system notifications, installer selection, Provider encryption, and cancellation.
- Agents own generated text, their CLI-native session/history stores, and any work they perform through their CLI under the granted mode. Removing an app-owned session reference does not delete the Agent-owned native session.
- Agent suggestions do not directly mutate RoundRelay configuration; configuration changes require renderer IPC handled by main.
