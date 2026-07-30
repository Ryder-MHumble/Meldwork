<p align="center">
  <img src="frontend/public/logos/meldwork-mark.svg" alt="Meldwork" width="132">
</p>

# Meldwork

**Put your local agents to work, together.**

Meldwork is a local-first desktop workspace where multiple AI Agent CLIs can collaborate on the same task. It discovers the Agents already available on your computer, keeps their conversations and native sessions persistent, and coordinates manual or bounded automatic discussions without requiring a hosted orchestration service.

The long-term product direction is open-source multi-agent collaboration. This repository is still `UNLICENSED`; the public open-source launch must not happen until a project license is selected and added.

## Why Meldwork

- **One workspace for different Agents.** Bring Codex, Claude Code, Kimi Code, MiMo Code, and other local CLIs into direct or group conversations.
- **Persistent collaborative context.** Continue the same task with one native session per Agent and conversation; resumed prompts add only the group messages that Agent has not already seen.
- **Local orchestration with explicit boundaries.** Agent execution, groups, messages, and orchestration stay on the user's machine. Provider traffic still follows each selected Agent's configuration.
- **Narrow desktop security boundary.** The renderer never receives executable paths, provider credentials, unrestricted shell access, attachment paths, or native session references.

## Core Capabilities

- Discover installed Agent CLIs without exposing executable paths to the renderer.
- Create multiple persistent direct conversations per Agent, then rename or delete each local conversation independently.
- Run one response at a time or an automatic discussion with a user-selected 1-10 round limit (6 by default).
- Preserve one logical native session per Agent and conversation, with automatic migration from older topic-scoped references.
- Show per-Agent queued/running/completed state, automatic round progress, background direct-chat completion markers, and local desktop notifications.
- Reference validated local Skills with `@` and attach PNG or JPEG images with capability checks.
- Request read-only modes by default where an Agent can enforce them, with explicit write opt-in only when the adapter can preserve the workspace boundary.
- Install supported missing Agents through fixed, allowlisted flows.
- Store compatible provider credentials with operating-system-backed secure storage.

## Supported Agents

| Agent | Local detection | Guided installation | Provider and permission behavior |
| --- | --- | --- | --- |
| Codex | Yes | macOS and Windows | Uses its existing Responses-compatible configuration |
| Hermes | Yes | macOS and Windows | Supports a shared OpenAI-compatible Provider |
| OpenClaw | Yes | macOS and Windows | Supports a managed OpenAI-compatible Provider |
| WorkBuddy | Yes | macOS and Windows | Experimental shared Provider support |
| Kimi Code | Yes | macOS and Windows | Uses its native configuration and ACP plan mode for read-only work |
| MiMo Code | Yes | macOS and Windows | Uses native configuration; Meldwork invokes the `plan` Agent and does not enable the global permission-bypass flag |
| Claude Code | Yes | macOS and Windows | Uses its existing Anthropic-compatible configuration |
| Gemini CLI | Yes | macOS and Windows | Uses its existing authentication and Provider settings |
| OpenCode | Yes | macOS and Windows | Uses its existing Provider settings |
| Qwen Code | Yes | macOS and Windows | Supports a shared OpenAI-compatible Provider |

Availability still depends on each upstream CLI, operating-system support, authentication, model configuration, and version compatibility.

## Privacy And Architecture

```text
Vue renderer
    | validated preload APIs
Electron main process
    |-- Agent discovery and execution
    |-- local group and message storage
    |-- local Skill discovery and validation
    |-- private image attachment storage and previews
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

Meldwork is under active development. Local discovery, persistent direct/group conversations, guarded heterogeneous-Agent execution, automatic discussion, `@` Skill references, image attachments, provider storage, frontend tests, desktop tests, and macOS package generation are implemented.

Before a public open-source release, the project still needs a selected license, real-device Windows validation, a target-device Agent compatibility matrix, and signed/notarized macOS distribution.
