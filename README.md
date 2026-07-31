<p align="center">
  <img src="frontend/public/logos/meldwork-mark.svg" alt="Meldwork" width="132">
</p>

# Meldwork

**Bring the local Agent CLIs already on your machine into one persistent workspace.**

Meldwork is building an open, local-first work system for agents across vendors. The current MVP brings multiple local AI Agent CLIs into the same local conversation and working directory, discovers the Agents already available on your computer, keeps conversations persistent, preserves resumable native sessions where compatible CLIs expose them, and coordinates manual or bounded automatic discussions without requiring a hosted orchestration service.

The long-term product direction is an open-source, local-first work system for agents across vendors. This repository is still `UNLICENSED`; the public open-source launch must not happen until a project license is selected and added.

## Product Direction

The target product promise is **Different agents. Work you can verify.** It describes the evidence-and-acceptance loop Meldwork intends to build, not a claim that the current MVP already verifies Agent output.

The current MVP proves local Agent discovery, guarded execution, persistent conversations, and native-session continuity where upstream CLIs support it. The next milestone is not a larger adapter count; it is an outcome loop that turns Agent activity into work a user can inspect and adopt:

```text
Task -> Runs -> Artifacts -> Evidence -> Human acceptance and adoption
```

Meldwork should use one Agent by default and add independent attempts or adversarial review only when task risk or uncertainty justifies the extra time and cost. Cloud Agents, Channels, Workflows, and team governance remain roadmap options until this loop demonstrates repeatable value.

## Why Meldwork

- **One workspace for different Agents.** Bring Codex, Claude Code, Kimi Code, MiMo Code, and other local CLIs into direct or group conversations.
- **Persistent collaborative context.** For compatible CLI versions that expose resumable sessions, continue with one native session per Agent and conversation; resumed prompts add only the group messages that Agent has not already seen.
- **Local orchestration with explicit boundaries.** Agent execution, groups, messages, and orchestration stay on the user's machine. Provider traffic still follows each selected Agent's configuration.
- **Narrow desktop security boundary.** Executable paths, attachment paths, and native session references stay in the Electron main process. Stored Provider credentials are never returned to the renderer after saving; newly entered credentials cross only the validated Provider IPC. The renderer has no unrestricted shell access.

## Core Capabilities

- Discover installed Agent CLIs without exposing executable paths to the renderer.
- Create multiple persistent direct conversations per Agent, then rename or delete each local conversation independently.
- Run one response at a time or an automatic discussion with a user-selected 1-10 round limit (6 by default).
- Preserve one logical native session per Agent and conversation where the selected CLI supports resume, with automatic migration from older topic-scoped references.
- Show per-Agent queued/running/completed state, automatic round progress, background direct-chat completion markers, and local desktop notifications.
- Reference validated local Skills with `@` and attach PNG or JPEG images with capability checks.
- Request read-only modes by default where an Agent can enforce them, with explicit write opt-in only when the adapter can preserve the workspace boundary. These are adapter-level controls, not an operating-system sandbox.
- Install supported missing Agents through fixed, allowlisted recipes. Upstream packages and scripts are not yet digest- or signature-pinned.
- Store compatible provider credentials with operating-system-backed secure storage.

## Supported Agents

| Agent | Adapter implemented | Installer recipes | Release validation | Provider and permission behavior |
| --- | --- | --- | --- | --- |
| Codex | Yes | macOS and Windows | Pending target-device matrix | Uses its existing Responses-compatible configuration |
| Hermes | Yes | macOS and Windows | Pending target-device matrix | Supports a shared OpenAI-compatible Provider |
| OpenClaw | Yes | macOS and Windows | Pending target-device matrix | Supports a managed OpenAI-compatible Provider |
| WorkBuddy | Yes | macOS and Windows | Pending target-device matrix | Experimental shared Provider support |
| Kimi Code | Yes | macOS and Windows | Pending target-device matrix | Uses its native configuration and ACP plan mode for read-only work |
| MiMo Code | Yes | macOS and Windows | Pending target-device matrix | Uses native configuration; Meldwork invokes the `plan` Agent and does not enable the global permission-bypass flag |
| Claude Code | Yes | macOS and Windows | Pending target-device matrix | Uses its existing Anthropic-compatible configuration |
| Gemini CLI | Yes | macOS and Windows | Pending target-device matrix | Uses its existing authentication and Provider settings |
| OpenCode | Yes | macOS and Windows | Pending target-device matrix | Uses its existing Provider settings |
| Qwen Code | Yes | macOS and Windows | Pending target-device matrix | Supports a shared OpenAI-compatible Provider |

These entries describe implemented adapters and installer recipes, not release-certified compatibility. Availability still depends on each upstream CLI, operating-system support, authentication, model configuration, and version compatibility. Live-Agent compatibility and real-device Windows validation remain pending.

## Privacy And Architecture

```text
Vue renderer
    | validated preload APIs
Electron main process
    |-- Agent discovery and execution
    |-- local group and message storage
    |-- local Skill discovery and validation
    |-- app-owned local image attachment storage and previews
    |-- provider credential storage
    `-- user-authorized provider and installer network access
```

The Electron main process owns filesystem paths, child processes, Agent configuration, and persistence. Provider credentials use Electron `safeStorage`; if operating-system encryption is unavailable, Meldwork refuses to persist them in plaintext. Conversations and participants remain local. Network activity occurs only through the selected Agent or Provider, guided installer downloads, or explicit external links.

Internal compatibility identifiers such as `window.roundrelayDesktop`, existing storage filenames, and `com.roundrelay.desktop` are intentionally retained during the brand transition so current local data and the preload contract continue to work.

## Development

Prerequisites: Node.js 20.19 or newer, npm, and macOS for the currently configured release packaging targets.

```bash
npm --prefix frontend ci
npm --prefix desktop ci

# Renderer-only preview
npm --prefix frontend run dev

# Electron desktop application
npm --prefix desktop run dev
```

The browser preview cannot execute Agents because it intentionally has no Electron bridge.

## Tests And Builds

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

Generated packages are written to `desktop/dist/` and are not committed.

## Repository Layout

```text
frontend/       Vue renderer and product assets
desktop/        Electron main process, preload bridge, Agent runtime, and tests
documentation/  Architecture, security, workflows, and launch material
.github/         Continuous integration workflows
```

The architecture review entry point is [`documentation/architecture.md`](documentation/architecture.md). Draft launch messaging lives in [`documentation/launch-kit.md`](documentation/launch-kit.md).

## Release Status

Meldwork is under active development. Local discovery, persistent direct/group conversations, guarded heterogeneous-Agent execution, automatic discussion, `@` Skill references, image attachments, provider storage, frontend tests, desktop tests, and macOS packaging configuration are implemented.

Before a public open-source release, the project still needs a selected license, a target-device Agent compatibility matrix, and signed/notarized macOS distribution. Windows support should remain implementation-level until it passes a real-device release matrix.
