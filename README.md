<p align="center">
  <img src="frontend/public/logos/meldwork-wordmark-v3.svg" alt="Meldwork local-first AI Agent workspace" width="260">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Meldwork - Local-first Multi-Agent Collaboration Workspace

> Coordinate local Agent CLIs, compare independent work, and review evidence before anything is written.

Meldwork is a source-available Electron desktop app and local-first multi-agent collaboration workspace for developers, researchers, and technical teams who use more than one AI Agent. It brings local Agent CLIs such as Codex, Claude Code, Gemini CLI, OpenCode, and Qwen Code into one place for direct chats, concurrent responses, evidence-aware runs, and human-in-the-loop Agent orchestration.

The current public preview is a single-user Apple-silicon macOS work cell. You choose the participants, working directory, context, permissions, and final adoption decision. No Meldwork account, server, or hosted conversation store is required.

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.3/Meldwork-0.1.3-arm64.dmg"><strong>Download the Apple silicon macOS preview</strong></a>
  · <a href="https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3">Release notes</a>
  · <a href="architecture.md">Architecture</a>
  · <a href="desktop/README.md">Desktop guide</a>
  · <a href="LICENSE">License</a>
</p>

## Who it is for

Use Meldwork when you:

- already have multiple local Agent CLIs and need one task to span them;
- need independent review for code, research, or product analysis before choosing a path;
- need inspectable traces, evidence, and human review before workspace writes.

## Workflow

1. **Select** the local Agents and participants.
2. **Scope** the goal, working directory, context, and permissions.
3. **Run** Direct, Concurrent Responses, or Auto Discussion V4.
4. **Review and adopt** the result, evidence, and any Human Gate before changing the workspace.

## Collaboration modes

| Mode | What happens | Best for |
| --- | --- | --- |
| **Direct** | One selected Agent keeps its conversation and native session when supported. | Focused work with one Agent. |
| **Concurrent Responses** | Selected Agents receive the same frozen task snapshot and return independent replies in stable order. | Comparing approaches before choosing one. |
| **Auto Discussion V4** | Selected Agents propose, challenge, negotiate responsibilities, execute dependency-aware work, then verify the result. | Multi-round work that needs explicit responsibility and review. |

Participants are always selected by the user. Automatic selection from a larger roster is outside the current preview.

## See it in action

| Local Agent discovery | Multi-agent review | Direct multimodal work |
| --- | --- | --- |
| [![Meldwork local-first multi-agent workspace detecting Agent CLIs](assets/meldwork-agent-discovery.png)](assets/meldwork-agent-discovery.png) | [![Meldwork multi-agent collaboration with evidence and human review](assets/meldwork-multi-agent-review.png)](assets/meldwork-multi-agent-review.png) | [![Meldwork direct Agent workspace with local files and media](assets/meldwork-direct-multimodal.png)](assets/meldwork-direct-multimodal.png) |

Example: give Codex, Claude Code, and Gemini CLI the same change-review context, compare their independent findings, then adopt only the evidence-backed result you approve.

## Supported local Agent CLIs

Meldwork detects and invokes an installed command when its adapter and the CLI version are compatible:

**Codex** (`codex`) · **Hermes** (`hermes`) · **OpenClaw** (`openclaw`) · **WorkBuddy** (`codebuddy`) · **Pi Agent** (`pi`, `pi-agent`, `piagent`) · **Kimi Code** (`kimi`) · **MiMo Code** (`mimo`) · **Claude Code** (`claude`) · **Gemini CLI** (`gemini`) · **OpenCode** (`opencode`) · **Qwen Code** (`qwen`) · **OpenCodeReview** (`ocr`)

Approved Agent Connectors can be added through the [Agent Connector SDK](docs/agent-connector-sdk.md); custom executable Agents use the desktop custom-Agent path. See the [desktop guide](desktop/README.md) for the full adapter and capability matrix.

## Quick start

### Apple silicon macOS preview

Download [`Meldwork-0.1.3-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.3/Meldwork-0.1.3-arm64.dmg) from the [official V1.0.3 prerelease](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3), move Meldwork to Applications, and install at least one supported local Agent CLI. The prerelease is ad-hoc signed and not notarized; macOS may require **Open Anyway** in **System Settings -> Privacy & Security** on first launch.

### Run from source

Prerequisites: Node.js `22.12+` and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Before distributing a build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## Current boundary

Meldwork is a local Electron app, not a hosted Agent fleet or a general Agent framework. The current preview does not provide remote/cloud/channel Agent execution, automatic participant selection, enterprise SSO/RBAC/governance, or an Outcome Network. Local-first does not mean fully offline: a selected Agent may send prompts, attachments, or Skills to its configured Provider. Workspace writes are opt-in workflow controls, not an operating-system sandbox.

## Docs

- [Architecture and product boundary](architecture.md)
- [Desktop setup and Agent matrix](desktop/README.md)
- [Agent Connector SDK](docs/agent-connector-sdk.md)
- [AI discoverability index](docs/ai-discoverability.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Meldwork is licensed under the [Apache License 2.0](LICENSE). You may use, modify, and redistribute the repository under its terms; third-party Agent products, models, dependencies, and brand assets remain subject to their own licenses and notices.
