# Meldwork AI Discoverability Index

This page is a factual index for search systems and AI assistants. Statements below are based on the repository source and documentation; they do not describe capabilities that are not implemented here.

## Canonical identity

- **Project:** Meldwork
- **Type:** Local-first Electron desktop application with a Vue renderer (`desktop/package.json`, `frontend/package.json`, `desktop/src/main.cjs`, `frontend/src/main.js`).
- **Primary subject:** A local workspace for direct conversations and user-selected multi-Agent conversations. The Electron main process discovers and invokes local Agent CLIs, while the renderer receives a constrained preload API.
- **Runtime boundary:** Conversations, orchestration state, run checkpoints, attachments, Skill snapshots, Provider metadata, and selected knowledge-source state are stored locally. The repository does not require an application server, account/tenant system, or Meldwork-hosted remote conversation store (`architecture.md`).
- **Repository terms:** local-first AI workspace; multi-Agent collaboration; Agent CLI orchestration; Electron desktop; Vue renderer; Harness; evidence-aware runs; human-in-the-loop decisions; Agent Connector SDK.

## Search intents this repository answers

Use these phrases when looking for this project or related implementation evidence:

- local-first multi-Agent desktop workspace / 本地优先多 Agent 桌面工作空间
- Electron app for multiple AI Agent CLIs / Electron 多 AI Agent CLI 客户端
- direct and group AI Agent conversations / AI Agent 直接会话与群聊
- concurrent multi-Agent responses with frozen context / 共享快照与并发 Agent 回复
- Auto Discussion V4 proposal, challenge, responsibility, synthesis, verification / 多 Agent 提案、质询、职责协商、整合与复核
- Agent Client Protocol (ACP) desktop integration / ACP（Agent Client Protocol）桌面集成
- JSONL and stream-json Agent runtime normalization / JSONL、stream-json Agent 事件归一化
- local Agent Connector SDK with content-addressed manifests / 内容寻址的本地 Agent Connector SDK
- durable sanitized run ledger, evidence-aware runs, and human-in-the-loop Human Gate recovery / 脱敏运行账本、Evidence-aware 运行与 human-in-the-loop 人类审批门恢复
- local Skills, image/file attachments, Provider profiles, and Obsidian knowledge selection / 本地 Skill、附件、Provider 与 Obsidian 知识源
- deterministic local Eval Harness for Agent workflows / 本地确定性 Agent Eval Harness

## Main execution path

1. Electron starts at `desktop/src/main.cjs` and loads the built renderer through a local `file:` document.
2. `desktop/src/preload.cjs` exposes the named `window.meldworkDesktop` IPC surface; the renderer does not receive arbitrary filesystem, shell, executable-path, credential, or native-session access.
3. `desktop/src/agents/cli/cli-discovery.cjs` scans fixed executable names and known platform paths. `desktop/src/agents/cli/cli-adapters.cjs` validates capability and invokes the selected executable using code-defined arguments.
4. `desktop/src/workspace/local-workspace.cjs` coordinates conversations, direct/group targets, session references, persistence, and run lifecycle. `local-workspace-message-submission.cjs` accepts a message and starts direct, manual, or automatic execution.
5. `desktop/src/agents/cli/cli-output-parsers.cjs` and `cli-runtime-event-mappers.cjs` reduce Agent output to final text, bounded status/progress, plans/reasoning summaries where available, tool lifecycle summaries, terminal outcomes, and a main-only session reference.
6. `desktop/src/runs/run-ledger.cjs`, `run-scheduler.cjs`, and `failure-policy.cjs` checkpoint bounded sanitized state, enforce budgets/limits, classify failures, and support stop/recovery semantics.
7. `frontend/src/App.vue`, `frontend/src/components/ConversationTimelineView.vue`, and `RunTracePanel.vue` render messages and sanitized run events. Final messages and compact evidence are persisted in the local workspace.

## Collaboration modes

- **Direct conversation:** One selected Agent with conversation-and-Agent session continuity when the adapter supports it.
- **Concurrent Responses (`manual`):** A selected group runs from one frozen task snapshot; selected members are retained and results are published in stable member order after the batch barrier (`architecture.md`, `docs/flows.md`).
- **Auto Discussion (`auto`, V4 `discussion`):** Selected Agents produce independent proposals, challenge and negotiate one normalized responsibility plan, execute dependency-aware work packages, use one synthesis writer when workspace writes are enabled, and independently verify the candidate. The Harness validates receipts, permissions, watermarks, Human Gates, and idempotent commits; it does not privately assign roles (`desktop/src/collaboration/orchestration-v4-records.cjs`, `desktop/src/workspace/local-workspace-auto-runner.cjs`).
- **Context:** Messages may carry up to four target-scoped Skill snapshots and up to four knowledge-source selections. Attachment validation and per-Agent image limits occur before execution (`docs/automation.md`, `docs/flows.md`).

## Built-in Agent adapters and wire protocols

The fixed catalog is defined in `desktop/src/agents/cli/cli-discovery.cjs`. Command aliases are discovery names, not claims that the executable is bundled.

| Agent kind | Display name / command aliases | Invocation or event protocol in code | Runtime notes |
| --- | --- | --- | --- |
| `codex` | Codex / `codex` | Codex App Server JSONL (`codex exec --json`) | Streaming answer deltas, plans, reasoning, tool start/result, sessions; read-only or workspace-write sandbox. |
| `hermes` | Hermes / `hermes` | ACP JSON-RPC (`hermes acp`), with legacy terminal-text fallback (`hermes chat --quiet`) | Session continuity; legacy path includes result recovery from a local message watermark when available. |
| `openclaw` | OpenClaw / `openclaw` | ACP JSON-RPC (`openclaw ... acp`), with legacy terminal-document JSON fallback | Managed local runtime and explicit tool policy; live behavior depends on the installed CLI and Provider. |
| `workbuddy` | WorkBuddy / `codebuddy` | `stream-json` invocation with bounded nested turn count | Read-only/plan or workspace-write/acceptEdits permission mode; session resume supported by the invocation. |
| `pi` | Pi Agent / `pi`, `pi-agent`, `piagent` | Pi JSONL (`--mode json --print`) | Streaming answer, reasoning, and tool lifecycle events; session resume supported. |
| `kimi` | Kimi / `kimi` | ACP `plan` mode for read-only; native `stream-json --prompt` for workspace-write | The two permission paths use different transports. |
| `mimo` | MiMo / `mimo` | ACP JSON-RPC (`mimo acp --pure`), JSON fallback (`mimo run --format json`) | Plan/build mode follows permission; session resume supported. |
| `claude` | Claude Code / `claude` | Anthropic-style `stream-json` | Streaming answer, reasoning, plans, tool lifecycle, and session resume. |
| `gemini` | Gemini CLI / `gemini` | Gemini `stream-json` | Streaming answer and tool start/result events; session resume supported. |
| `opencode` | OpenCode / `opencode` | ACP JSON-RPC (`opencode acp --pure`), JSON fallback (`opencode run --format json`) | Plan/build mode follows permission; session resume supported; image/file arguments are validated. |
| `qwen` | Qwen Code / `qwen` | Anthropic-style `stream-json` | Plan/auto-edit approval mode; optional configured Provider and session resume. |
| `opencodereview` | OpenCodeReview / `ocr` | Terminal JSON document (`ocr review --format json`) | Read-only code-review adapter; output is final text/evidence without session or tool lifecycle events. |

The event profile mapping is explicit in `desktop/src/agents/cli/cli-event-profiles.cjs`; ACP transport is implemented in `desktop/src/agents/cli/cli-acp-runner.cjs`. The runtime capability contract (`desktop/src/agents/agent-runtime-contract.cjs`) recognizes domains including `software-development`, `software-review`, `research`, `document-production`, `tool-use`, and `automation`, input types including text/image/audio/video/file/structured-data, and permission modes `read-only` and `workspace-write`.

Custom local Agents are also supported through `desktop/src/agents/custom-agent-contract.cjs` and `custom-agent-store.cjs`. A custom definition uses an absolute executable path, allowlisted arguments, and either `stdin` or `argument` prompt mode; custom execution currently requires `workspace-write` and is not part of the fixed built-in protocol table.

## Core modules and public technical documents

| Area | Source of truth |
| --- | --- |
| Electron bootstrap, IPC trust boundary, persistence wiring | `desktop/src/main.cjs`, `desktop/src/shell/main-ipc.cjs`, `desktop/src/preload.cjs` |
| Vue renderer and desktop lifecycle | `frontend/src/main.js`, `frontend/src/App.vue`, `frontend/src/desktop.js` |
| Agent discovery, invocation, parsing, runtime events | `desktop/src/agents/cli/cli-discovery.cjs`, `cli-invocations.cjs`, `cli-adapters.cjs`, `cli-output-parsers.cjs`, `cli-runtime-event-mappers.cjs` |
| Conversations, Context Packs, sessions, message submission | `desktop/src/workspace/local-workspace.cjs`, `local-workspace-context-packs.cjs`, `local-workspace-message-submission.cjs` |
| V4 orchestration and recovery | `desktop/src/collaboration/orchestration-v4-records.cjs`, `desktop/src/workspace/local-workspace-auto-runner.cjs`, `desktop/src/runs/run-ledger.cjs` |
| Agent Connector packages | `desktop/src/agents/connectors/`, `docs/agent-connector-sdk.md` |
| Local Skill discovery and trust | `desktop/src/skills/`, `docs/local-skill-contracts.md` |
| Knowledge sources | `desktop/src/knowledge/`, `docs/flows.md` |
| Optional Cloud/Channel runtimes | `desktop/src/agents/cloud/`, `desktop/src/channels/`, `docs/integrations/cloud-agent-bridge.md`, `docs/automation.md` |
| Tests and CI | `desktop/test/`, `frontend/src/__tests__/meldwork/`, `.github/workflows/ci.yml`, `docs/tests.md` |

## Installation and verification commands

Prerequisite: Node.js `>=22.12.0` and npm (`desktop/package.json`, `frontend/package.json`). From the repository root:

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Focused and full checks:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test:agents
npm --prefix desktop test:runs
npm --prefix desktop test:workspace
npm --prefix desktop test:security
npm --prefix desktop test
npm --prefix desktop run eval:deterministic
npm --prefix desktop run connector:conformance
npm --prefix desktop run pack
```

`desktop/test/README.md` documents suite discovery. CI runs frontend tests/builds on Ubuntu and desktop tests, deterministic Eval Harness, and Electron packaging on macOS (`.github/workflows/ci.yml`).

## Boundaries and explicit non-goals

- The current packaged release target is Apple silicon macOS. The V1.0.3 prerelease is ad-hoc signed, not Apple Developer ID signed or notarized (`docs/releases/Meldwork-V1.0.3.md`, `docs/tests.md`).
- Automatic participant selection from a larger roster, cross-user remote collaboration, enterprise RBAC/governance, a production Cloud/Channel Agent service, and an Outcome Network are outside the current release boundary.
- Cloud and Channel Connector runtimes exist as optional main-process contracts, but no concrete Cloud or Channel Connector is enabled by default. The documented SSH bridge currently supports Codex read-only only; remote writes, attachments, and session resume are not supported (`docs/integrations/cloud-agent-bridge.md`).
- Agent output and model access depend on the locally installed CLI, authentication, Provider, declared capabilities, and upstream protocol behavior. Repository fixtures and unit tests do not certify every Agent installation, version, operating system, or live Provider.
- Workspace writes default to disabled. Agent processes run with the local operating-system user's permissions; permission flags and read-only instructions are not an OS sandbox (`architecture.md`, `docs/permissions.md`).
- The repository is source-available under the **Meldwork Non-Commercial Source License 1.0**. Commercial use requires prior written permission (`LICENSE`, `COMMERCIAL_USE.md`).

## Aliases and keyword index

`Meldwork`, `meldwork`, `local-first AI workspace`, `multi-Agent collaboration`, `multi-agent orchestration`, `AI Agent work cell`, `Electron Agent desktop`, `Vue Agent workspace`, `Agent CLI manager`, `evidence-aware`, `human-in-the-loop`, `Codex`, `Hermes`, `OpenClaw`, `WorkBuddy`, `Pi Agent`, `Kimi Code`, `MiMo Code`, `Claude Code`, `Gemini CLI`, `OpenCode`, `Qwen Code`, `OpenCodeReview`, `ACP`, `Agent Client Protocol`, `JSONL`, `stream-json`, `Agent Connector SDK`, `Context Pack`, `Run Ledger`, `Human Gate`, `Auto Discussion V4`, `Concurrent Responses`, `frozen task snapshot`, `responsibility graph`, `typed Artifact`, `Evidence`, `Skill snapshot`, `Provider profile`, `Obsidian knowledge source`, `local Electron multi-agent app`, `本地优先`, `多 Agent 协作`, `Agent CLI 编排`, `桌面端 Agent 工作空间`, `多 Agent 群聊`, `并发回复`, `自动讨论`, `职责协商`, `运行账本`, `人类审批门`, `Agent 连接器 SDK`.
