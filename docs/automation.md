# Automation And External Side Effects

Meldwork embeds local Agent automation, optional main-process Cloud/Channel Connector runtimes, and an Agent installer. It has no required server, email automation, cron schedule, or unattended recurring Task trigger. No concrete Cloud or Channel Connector is enabled by default.

## Automation Inventory

| Automation | Trigger / owner | Automatic scope | External side effects |
| --- | --- | --- | --- |
| Manual Agent reply | Local user sends a message and selects targets | Invokes selected built-in or approved Connector Agents sequentially once | Agent process or Connector call, Provider/native network use, local message/session writes |
| Automatic discussion | Local user sends a group message in automatic mode | Runs the explicitly selected group Agents in complete rounds, 6 rounds by default, with either a finite 1-10 round limit or an explicitly confirmed no-round-limit mode; no-round-limit mode stops on consensus or manual stop, while every individual Agent invocation retains its own timeout | Same as manual replies, repeated within the selected round policy |
| Role Review workflow | An app-owned caller submits a typed review Task | Runs parallel-safe Primary branches, isolated Reviewer checks, optional Arbiter resolution, and a Human decision Gate | Agent/Connector calls plus durable Artifact, Evidence, Finding, Adoption, and Gate records |
| Agent detection/readiness | App startup or explicit refresh | Scans fixed command names and credential evidence | Local process/file reads; Claude may run `auth status --json` |
| Knowledge-source readiness | Explicit Knowledge Base settings refresh or source validation | Probes code-defined Feishu/DingTalk CLI status and Obsidian installation/Vault access | Local process/file reads; document-list permission probes may call the configured knowledge service through its CLI |
| Agent installation | Local user confirms installation | One installer task at a time | Network download/npm access and global CLI installation |
| Managed OpenClaw setup | OpenClaw invocation with configured Provider | Writes isolated runtime configuration if changed | Local config directories/files; Provider call by OpenClaw |
| Harness trace checkpoint | A run starts, emits a meaningful sanitized event, changes context, stops, or finishes | Atomically updates one bounded local Run Ledger record; terminal messages retain streamed conclusions, and restart marks unfinished attempts interrupted, reconstructs missing terminal messages, or enriches an existing matching message with missing output | Private Run Ledger/workspace file writes only; no network request and no automatic writable resume |
| Cloud Agent observation | An explicitly configured Cloud Connector owns a submitted remote job | Polls/observes with a durable cursor, reattaches after restart, resumes waiting input/permission, fetches declared Artifacts, and delivers idempotent cancel | External Cloud Connector calls plus private job/cursor/operation records |
| Channel Inbox receiver | An explicitly configured Channel Connector starts with Electron main | Verifies signed events, rejects replay/expiry, queues durable deliveries while the UI is closed, upserts scoped Tasks exactly once, and records outbound replies | External receiver/reply calls plus private Inbox, cursor, Task mapping, and audit writes |
| Run completion notification | A manual or automatic run reaches a terminal state while the app window is unfocused | Main emits one sanitized lifecycle event and one local operating-system notification | Local notification only; no network request or conversation message |

## Agent Invocation Contract

**Inputs Agents may read:**

- The current user message.
- One immutable Context Pack containing stable user constraints, bounded non-duplicated Task history, source hashes, compact evidence capsules, and target scope. A resumed native Session receives only the validated delta after that Agent's previous final reply.
- Group name/topic and selected working directory.
- Main-resolved paths for selected root images when the target Agent's declared capability accepts the complete set. Automatic discussion keeps offering the root images to each Agent until that Agent first receives them successfully.
- Up to four main-captured immutable Skill snapshots scoped to the selected target Agent. Hermes also receives the validated Skill slugs through its native `--skills` arguments.
- Up to four main-revalidated knowledge-source selections scoped to selected target Agents. Obsidian uses bounded Connector search/fetch/snapshot/citation; Feishu and DingTalk retain explicit live CLI-reference semantics.
- Only the selected Agent's native credentials and optional configured Provider values.

**Executable/tool surface:**

- Main may spawn only detected executables for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, MiMo Code, Claude Code, Qwen Code, Gemini CLI, OpenCode, and OpenCodeReview.
- An approved external Agent Connector can join through its manifest, registry instance, recipe, CredentialRef, and versioned Run Event contract without editing core Agent allowlists.
- Command shapes are code-defined in `desktop/src/cli-adapters.cjs`; prompt text does not select an arbitrary executable or shell command.
- Kimi read-only conversations use Agent Client Protocol `plan` mode. Write-authorized conversations retain Kimi's native stream-JSON prompt mode.
- OpenClaw receives an explicit tool allow/deny configuration. Execution, process, browser, gateway, cron, messaging, session spawning, and subagent tools are denied; write/edit/apply-patch are added only when the conversation permits writes.
- Other CLIs receive their supported plan/read-only or edit permission flags. These flags are hard guardrails outside the prompt, but enforcement ultimately depends on the upstream CLI.

**Steering:**

- `LocalWorkspace.promptFor` identifies the Agent, repeats bounded stable user constraints, adds only the delivery delta required by that Task-scoped group Session or conversation-scoped direct Session, and asks it not to impersonate other Agents.
- Selected knowledge sources add an explicit read-only instruction plus immutable snapshot/citation records or an explicit live-reference limitation. Reviewer workflows receive the Artifact, acceptance criteria, and declared Evidence instead of the Primary's complete conversation.
- Automatic discussion preflights root-image limits for every explicitly targeted Agent, so each selected participant can receive the same root image set or the run does not start. Agents still run sequentially, so later participants can see earlier conclusions; native Sessions remain Agent-specific while the approved Task context is shared.

**Output contract:**

- CLI-specific parsers reduce output to final text, a main-only native session reference, bounded execution metadata, and completion state where the protocol exposes it.
- Output size and runtime are bounded in the adapter; secrets found in child errors are redacted before persistence.
- The Harness exposes only allowlisted status, conclusion deltas, reasoning summaries, plans, tool lifecycle summaries, warnings, bounded result metadata, and source message IDs. It never exposes raw chain-of-thought, commands, unrestricted stdout/stderr, credentials, executable paths, native session references, or arbitrary tool payloads.
- Versioned Connector events preserve Permission, SourceUsed, Artifact, Evidence, Usage, WaitingInput, Completed, Failed, and Cancelled fields through main, persistence, preload sanitization, replay, and restart.
- Before launching Hermes, main makes a best-effort read of the message-ID watermark through Electron's read-only SQLite API. After exit, a non-empty post-watermark `assistant` row with `finish_reason` equal to `stop` or `length` is authoritative. If the database is absent, locked, incompatible, or has no current-turn final row, Meldwork falls back to the ANSI-stripped official `--quiet` stdout instead of blocking the Agent. Any newly reported native session reference is persisted before this lookup. Final text becomes `message.content`; up to eight sanitized process steps and elapsed time remain separate metadata and are not included in later Agent prompts.
- Successful final text becomes a local Agent message. User-visible failure diagnostics remain local system messages; an all-failed manual run resolves after recording each failure because the user message has already been accepted and persisted.
- Live progress events are transient renderer updates. Main also stores bounded sanitized checkpoints in the private Run Ledger and persists compact evidence capsules with terminal conversation messages, including partial, failure, stop, timeout, and interruption outcomes. Native session references are never exposed to the renderer, listener failures cannot change a completed run result, and shutdown suppresses terminal desktop notifications.
- Artifacts, Evidence, Reviewer Findings, Adoption, exact delivery fingerprints, and Human Gate decisions are durable records separate from reasoning and tool summaries.
- Automatic replies carry an internal final-line consensus marker. Meldwork removes the marker before persistence and stops only when every Agent completes and agrees in the same round.

## Workspace Side Effects

- `allowWrite` defaults to false. Adapters with enforceable permission modes receive read-only/plan arguments until the user explicitly opts into writes.
- Knowledge-source selections are Task-scoped and do not change `allowWrite`. Main-owned filesystem Connectors enforce read-only retrieval; CLI-mediated sources still depend on upstream permissions and receive explicit live-reference limitations.
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
| User approval | Send/install actions originate from explicit UI commands; install uses confirmation; permission, budget, and review decisions use durable Human Gates |
| Rate/bounds | Manual targets run sequentially; auto discussion defaults to 6 complete rounds, finite mode is capped at 10 rounds, no-round-limit mode has no total runtime cap, every Agent invocation retains its watchdog timeout, budgets cover tokens/cost/tools/outbound bytes/elapsed time, and Task/workspace/global scheduler limits are enforced |
| Cancellation | Stop is bound to the current `(groupId, runId)`; queued or active Agents can be cancelled/retried/replaced independently; Cloud cancel is idempotent; installer cancel aborts download/process; quit uses bounded runtime shutdown |
| Failure handling | Failures are classified before retry. Network/rate-limit failures use bounded backoff. Authentication and compatibility failures fail once without an automatic retry, recovery handoff, or group-membership mutation; the user can explicitly retry or replace the affected Agent after correcting configuration |
| Audit trail | Context Packs, delivery records, Run Ledger state, Connector provenance/events, Artifacts, Evidence, Findings, Adoption, Human Gates, Cloud operations, and Channel delivery/outbound records remain main-owned and bounded; raw execution data is excluded |
| Kill switch | Stop the active Task or Agent, cancel the installer/Cloud job, disable a Connector, or quit the application |

## App-Owned Versus Agent-Owned Actions

- The app owns Meldwork conversation persistence, Context Packs, permission/budget/Gate decisions, process and Connector launch, bounded Run Ledger checkpoints, typed outcomes, run lifecycle events, Cloud observation, Channel Inbox mapping, operating-system notifications, installer selection, Provider encryption, and cancellation.
- Agents own generated text, their CLI-native session/history stores, and any work they perform through their CLI under the granted mode. Removing an app-owned session reference does not delete the Agent-owned native session.
- Agent suggestions do not directly mutate Meldwork configuration; configuration changes require renderer IPC handled by main.
