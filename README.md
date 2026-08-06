<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork - Agents change. Work continues." width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# AI agents are interchangeable. Your work should not be.

**Meldwork is a local-first desktop workspace for persistent direct Agent conversations and bounded multi-Agent review. Each conversation keeps its own context, permissions, attachments, compatible native sessions, and sanitized execution history on your computer.**

Start with one Agent. Bring in others when the work needs a different capability, a second opinion, or an adversarial review. Meldwork keeps the conversation, participants, permissions, outputs, and sanitized run evidence together on your computer.

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/latest"><strong>Download the private macOS preview</strong></a>
  · <a href="LICENSE">AGPL-3.0 license</a>
  · <a href="COMMERCIAL_USE.md">Commercial use</a>
</p>

## Install the desktop client

The current private preview is built for Apple silicon Macs.

1. Open the [latest GitHub Release](https://github.com/Ryder-MHumble/Meldwork/releases/latest).
2. Download `Meldwork-0.1.0-arm64.dmg`.
3. Drag Meldwork into Applications and open it.
4. Connect the supported Agent CLIs already installed on your computer, or configure an independent Provider profile for an Agent.

The private preview is ad-hoc signed and not yet Apple-notarized. A public distribution build will require Developer ID signing and notarization; see [the macOS signing guide](docs/macos-signing.md).

## Start with one repeatable workflow

The public MVP is built around one workflow: produce a deliverable, have a second Agent challenge it, and let the human decide what to keep.

1. Create a group with two locally ready Agents.
2. Attach only the files needed for the task and keep workspace write access off unless the task requires it.
3. Ask one Agent to produce the deliverable and the other to check assumptions, omissions, and evidence in a bounded discussion.
4. Inspect the final replies and sanitized run trace before accepting, revising, or discarding the result.

Other domains are examples, not separate MVP promises. The release is successful when this two-Agent review loop works predictably on a clean Apple silicon Mac.

## One place to see the work

![Meldwork workspace overview](docs/assets/meldwork-workspace-overview.png)

Direct conversations and working groups live in the same desktop workspace. Start directly when one Agent is enough; create a group when the task needs an independent check. Meldwork does not currently merge separate conversation histories automatically, so attach or restate the context the group must share.

## From a first answer to a reviewed decision

| Step | What happens in Meldwork |
| --- | --- |
| Start | Open a direct conversation with the Agent best suited to the first step |
| Escalate | Create a working group and select only the Agents that should participate |
| Discuss | Run a manual handoff or a bounded automatic multi-round discussion |
| Verify | Inspect final replies, status, source context, and sanitized execution traces before accepting the result |

![Multi-Agent product review in Meldwork](docs/assets/meldwork-multi-agent-review.png)

The conversation remains readable while Agent-specific process details stay available on demand. Group runs preserve compact evidence for later Agents and for the human making the final decision.

## Why teams use Meldwork

- **Research:** one Agent builds the evidence base while another challenges unsupported assumptions.
- **Product and strategy:** one develops the proposal, another tests positioning, feasibility, and expensive failure modes.
- **Software delivery:** one implements, another reviews the diff and the reasoning behind it.
- **Writing and content:** one creates, another checks structure, factual accuracy, and tone.
- **Operations:** specialized Agents handle different parts of the task while the full work record stays visible.

The goal is not to maximize Agent count. It is to use the right Agent at the right moment without fragmenting the work.

## What the desktop client keeps together

- Persistent direct conversations and multi-Agent working groups.
- Explicit Agent targeting, manual runs, and automatic multi-round discussions.
- Compatible native-session continuity for each conversation and Agent.
- Sanitized run traces, completion state, and compact evidence capsules.
- Agent-specific Provider profiles and operating-system-backed credential storage where supported.
- Skills, validated images, media, documents, code, archives, approved knowledge sources, and opt-in workspace access.
- Local conversation and orchestration state with no Meldwork cloud account or remote conversation store.

Model requests still follow the Agent and Provider you choose. Local-first describes Meldwork's workspace and orchestration state; it does not make third-party models offline.

## Connected Agents

Meldwork currently integrates with:

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code · OpenCodeReview · Custom Agents**

Each Agent keeps its own capabilities, provider configuration, permission model, and session behavior. Availability depends on the installed Agent, its version, and its authentication state.

## Private MVP status

This repository and its Releases are currently private while the public MVP release gates are completed. The macOS Apple silicon client is the only release-validated target in this preview. Windows, Intel Mac, Apple notarization, and broad third-party Agent certification are not yet claimed. The remaining release gates are tracked in [the public MVP checklist](docs/public-mvp-release.md).

<details>
<summary><strong>Build from source for development</strong></summary>

Requires Node.js 20.19 or newer and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Verification commands are documented in [docs/tests.md](docs/tests.md).

</details>

## License

Meldwork Community Edition is open source under the [GNU Affero General Public License v3.0 only](LICENSE). The AGPL permits commercial use, modification, and redistribution while requiring covered source to remain available when modified versions are distributed or offered over a network.

Organizations that need proprietary redistribution, closed-source embedding, or a separately licensed commercial edition can request a commercial license; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md). Third-party attribution is recorded in [NOTICE](NOTICE).
