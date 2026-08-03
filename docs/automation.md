# Automation And External Side Effects

Meldwork embeds local Agent automation and an Agent installer. There are no webhooks, server jobs, email automations, cron schedules, or unattended recurring tasks.

## Automation Inventory

| Automation | Trigger / owner | Automatic scope | External side effects |
| --- | --- | --- | --- |
| Manual Agent reply | Local user sends a message and selects targets | Invokes selected Agents sequentially once | Agent process, Provider/native network use, local message/session writes |
| Automatic discussion | Local user sends a group message in automatic mode | Runs the explicitly selected group Agents in complete rounds, 6 rounds by default, with either a finite 1-10 round limit or an explicitly confirmed no-round-limit mode; every mode stops on consensus, manual stop, or the 30-minute safety timeout | Same as manual replies, repeated within the bound |
| Agent detection/readiness | App startup or explicit refresh | Scans fixed command names and credential evidence | Local process/file reads; Claude may run `auth status --json` |
| Knowledge-source readiness | Explicit Knowledge Base settings refresh or source validation | Probes code-defined Feishu/DingTalk CLI status and Obsidian installation/Vault access | Local process/file reads; document-list permission probes may call the configured knowledge service through its CLI |
| Agent installation | Local user confirms installation | One installer task at a time | Network download/npm access and global CLI installation |
| Managed OpenClaw setup | OpenClaw invocation with configured Provider | Writes isolated runtime configuration if changed | Local config directories/files; Provider call by OpenClaw |
| Harness trace checkpoint | A run starts, emits a meaningful sanitized event, changes context, stops, or finishes | Atomically updates one bounded local Run Ledger record; terminal messages retain streamed conclusions, and restart marks unfinished attempts interrupted, reconstructs missing terminal messages, or enriches an existing matching message with missing output | Private Run Ledger/workspace file writes only; no network request and no automatic writable resume |
| Run completion notification | A manual or automatic run reaches a terminal state while the app window is unfocused | Main emits one sanitized lifecycle event and one local operating-system notification | Local notification only; no network request or conversation message |

## Agent Invocation Contract

**Inputs Agents may read:**

- The current user message.
- Stable group-level user constraints plus a bounded non-duplicated group transcript and compact evidence capsules from prior Agent results. A resumed native session receives only messages after that Agent's previous final reply.
- Group name/topic and selected working directory.
- Main-resolved paths for selected root images when the target Agent's declared capability accepts the complete set. Automatic discussion keeps offering the root images to each Agent until that Agent first receives them successfully.
- Up to four main-revalidated Skill hints scoped to the selected target Agent. Hermes also receives the validated Skill slugs through its native `--skills` arguments.
- Up to four main-revalidated knowledge-source hints scoped to selected target Agents. Active sources are currently Feishu, DingTalk, and Obsidian; planned OAuth sources cannot be selected.
- Only the selected Agent's native credentials and optional configured Provider values.

**Executable/tool surface:**

- Main may spawn only detected executables for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, MiMo Code, Claude Code, Qwen Code, Gemini CLI, OpenCode, and OpenCodeReview.
- Command shapes are code-defined in `desktop/src/cli-adapters.cjs`; prompt text does not select an arbitrary executable or shell command.
- Kimi read-only conversations use Agent Client Protocol `plan` mode. Write-authorized conversations retain Kimi's native stream-JSON prompt mode.
- OpenClaw receives an explicit tool allow/deny configuration. Execution, process, browser, gateway, cron, messaging, session spawning, and subagent tools are denied; write/edit/apply-patch are added only when the conversation permits writes.
- Other CLIs receive their supported plan/read-only or edit permission flags. These flags are hard guardrails outside the prompt, but enforcement ultimately depends on the upstream CLI.

**Steering:**

- `LocalWorkspace.promptFor` identifies the Agent, repeats bounded stable user constraints, adds only the group transcript delta needed by that Agent's conversation-scoped native session, and asks it not to impersonate other Agents.
- Selected knowledge sources add an explicit read-only instruction, source identity, and either a main-resolved local Vault location or detected CLI command name. Meldwork asks the Agent to identify sources used, but does not independently guarantee retrieval completeness or citation correctness.
- Automatic discussion preflights root-image limits for every explicitly targeted Agent, so each selected participant can receive the same root image set or the run does not start. This equal-context guarantee applies to root-image availability, not identical prompts: Agents still run sequentially, so later participants can see earlier replies, while native sessions remain conversation-and-Agent-specific and Skill hints remain Agent-specific.

**Output contract:**

- CLI-specific parsers reduce output to final text, a main-only native session reference, bounded execution metadata, and completion state where the protocol exposes it.
- Output size and runtime are bounded in the adapter; secrets found in child errors are redacted before persistence.
- The Harness exposes only allowlisted status, conclusion deltas, reasoning summaries, plans, tool lifecycle summaries, warnings, bounded result metadata, and source message IDs. It never exposes raw chain-of-thought, commands, unrestricted stdout/stderr, credentials, executable paths, native session references, or arbitrary tool payloads.
- Before launching Hermes, main makes a best-effort read of the message-ID watermark through Electron's read-only SQLite API. After exit, a non-empty post-watermark `assistant` row with `finish_reason` equal to `stop` or `length` is authoritative. If the database is absent, locked, incompatible, or has no current-turn final row, Meldwork falls back to the ANSI-stripped official `--quiet` stdout instead of blocking the Agent. Any newly reported native session reference is persisted before this lookup. Final text becomes `message.content`; up to eight sanitized process steps and elapsed time remain separate metadata and are not included in later Agent prompts.
- Successful final text becomes a local Agent message. User-visible failure diagnostics remain local system messages; an all-failed manual run resolves after recording each failure because the user message has already been accepted and persisted.
- Live progress events are transient renderer updates. Main also stores bounded sanitized checkpoints in the private Run Ledger and persists compact evidence capsules with terminal conversation messages, including partial, failure, stop, timeout, and interruption outcomes. Native session references are never exposed to the renderer, listener failures cannot change a completed run result, and shutdown suppresses terminal desktop notifications.
- Automatic replies carry an internal final-line consensus marker. Meldwork removes the marker before persistence and stops only when every Agent completes and agrees in the same round.

## Workspace Side Effects

- `allowWrite` defaults to false. Adapters with enforceable permission modes receive read-only/plan arguments until the user explicitly opts into writes.
- Knowledge-source selections are task-scoped hints and do not change `allowWrite`. The Agent may read the selected source under local OS and upstream CLI permissions; Meldwork instructs it not to modify source content.
- Hermes and OpenClaw do not expose an equivalent Meldwork-enforced read-only switch, so their capability label remains Agent-managed permissions regardless of `allowWrite`.
- Main passes write permission per invocation; it does not grant a renderer filesystem API.
- Agents run with the local OS user's process identity. Meldwork is not an OS-level sandbox.

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
| User approval | Send/install actions originate from explicit UI commands; install uses confirmation |
| Rate/bounds | Manual targets run sequentially; auto discussion defaults to 6 complete rounds, finite mode is capped at 10 rounds, optional no-round-limit mode remains capped at 30 minutes, and one installer task runs at a time |
| Cancellation | Stop is bound to the current `(groupId, runId)` and acknowledges the abort request while cleanup retains the group lock; installer cancel aborts download/process; quit waits for settled cleanup |
| Failure handling | Synchronous shape/target validation fails before reservation. Asynchronous attachment/Skill/knowledge preflight may fail after the preparing Ledger checkpoint but before user-message acceptance; the reservation is terminalized without accepting the message. Execution failures after acceptance are stored as local diagnostics, and automatic runs isolate a failed Agent and continue within the configured bounds |
| Audit trail | Conversation results and compact evidence capsules are local; a private 64-run bounded Ledger supports crash/restart reconciliation and stop traceability. It is sanitized, mutable, and not an immutable forensic log |
| Kill switch | Stop the active group, cancel the installer, or quit the application |

## App-Owned Versus Agent-Owned Actions

- The app owns Meldwork conversation persistence, permission selection, process launch, bounded Run Ledger checkpoints, run lifecycle events, operating-system notifications, installer selection, Provider encryption, and cancellation.
- Agents own generated text, their CLI-native session/history stores, and any work they perform through their CLI under the granted mode. Removing an app-owned session reference does not delete the Agent-owned native session.
- Agent suggestions do not directly mutate Meldwork configuration; configuration changes require renderer IPC handled by main.
