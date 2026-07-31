<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork - Agents change. Work continues." width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Meldwork

**Agents change. Work continues.**

Meldwork is a local-first desktop workspace for general-purpose AI agents.

AI agents are no longer one narrow product category. Tools that began with coding, research, personal assistance, or operations are converging into general-purpose systems that can reason, use tools, handle files, and carry multi-step work. People will use more than one of them. The work still needs one place to continue.

Meldwork is not another Agent, and it is not a coding-only Agent aggregator. It keeps conversations, compatible native sessions, collaboration state, and human control in one persistent workspace while work moves between different Agents.

> **Current MVP:** Meldwork connects the supported local Agent CLIs listed below. The product direction is an open connector layer for local, cloud, custom, and channel-native Agents, but arbitrary Agent connectors are not shipped yet. This repository also remains `UNLICENSED` until a public software license is selected.

## Better Agents do not solve fragmented work

When real work moves between Agents, users still have to:

- rebuild context across disconnected sessions and interfaces;
- collect decisions, files, and intermediate results from different places;
- decide manually which Agent should answer, challenge, revise, or continue;
- remember which Agent still holds which part of the task;
- reconcile different Provider traffic, permissions, and tool behavior;
- treat a fluent answer as completion because there is no durable work record.

This affects research, planning, writing, operations, analysis, design, development, and review. Coding is one use case, not the product boundary.

## One workspace for the work

| Fragmented Agent use | With the current Meldwork MVP |
| --- | --- |
| Context trapped in separate sessions | Persistent direct and group conversations in one local workspace |
| Re-explaining the task after every switch | Native-session continuity where the upstream Agent exposes a compatible resume mechanism |
| Manually routing work across several interfaces | Direct responses or user-bounded multi-Agent discussions with visible run state |
| Unclear write and Provider behavior | Explicit per-Agent Provider profiles and visible per-conversation write mode where enforceable |
| A hosted orchestration account becomes the new dependency | Groups, messages, and orchestration state remain on the user's machine |

Local-first does not mean every model runs offline. Network traffic still follows the Agent and Provider configuration the user selects. Meldwork keeps its workspace and control state local.

## General Agents, modeled by real capabilities

Codex, Claude Code, Hermes, OpenClaw, and similar tools may have different origins, but their capabilities increasingly extend beyond a single coding workflow. Meldwork treats them as Agents and keeps their actual differences explicit: supported inputs, Skills, session behavior, Provider configuration, permissions, and output handling.

The name of an upstream tool does not define Meldwork's category. Continuity of work across Agents does.

## What works today

### Discover supported local Agents

Refresh one catalog to find supported Agent CLIs already installed or available through an allowlisted installer recipe. Executable paths stay in the Electron main process.

### Keep work in persistent conversations

Create multiple direct conversations for the same Agent, return later, or bring selected Agents into a group around the same body of work.

### Continue native sessions where possible

For compatible CLI versions, Meldwork keeps one logical native session per Agent and conversation. A resumed Agent receives only the group messages it has not already seen.

### Bring in another Agent without rebuilding the workflow

Run one response or a bounded automatic discussion from 1 to 10 rounds. Each Agent has a visible queued, running, completed, or failed state, and the user decides what to accept.

### Carry useful context and outputs

Reference validated local Skills with `@`, attach supported PNG or JPEG images, and collect supported image, audio, or video outputs from the authorized workspace's `.meldwork-output` directory. Capability checks remain Agent-specific.

### Keep execution boundaries explicit

Executable paths, attachment paths, session references, and child processes stay in the Electron main process. Compatible Provider credentials use operating-system-backed secure storage and are not returned to the renderer after saving.

## Any Agent is the direction, not the current claim

The product principle is simple:

> **If it can act as an Agent, it should be able to join Meldwork.**

The current MVP starts with fixed adapters for supported local CLIs. The next architecture milestone is a publicly documented Agent connector contract and capability manifest so new local runtimes, cloud Agents, and channel-native Agents can join without being hardcoded into the client.

| Horizon | Product outcome |
| --- | --- |
| **Now: local MVP** | Supported local Agent discovery, persistent direct/group conversations, compatible native-session resume, bounded discussions, Skills, images, and explicit local boundaries |
| **Next: open connection layer** | Connector contract, capability manifest, structured tasks, comparable runs, artifacts, evidence, and explicit human acceptance |
| **Later: after validation** | Cloud-Agent handoff, Meldwork Channels, typed workflows, team policy, cost controls, and enterprise governance |

These later capabilities are roadmap direction, not shipped behavior.

## Initial Agent connections

The current codebase contains adapters and allowlisted installer recipes for:

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code**

These are the first supported connections, not Meldwork's definition of what an Agent can be. An implemented adapter is also not the same as release-certified compatibility; availability depends on the upstream CLI, operating system, authentication, model configuration, and version.

## A practical workflow

```text
Start with one Agent
        ↓
Keep the work in one persistent conversation
        ↓
Bring in another Agent when a different capability or perspective helps
        ↓
Continue in the same workspace instead of rebuilding context
        ↓
Inspect the result and decide what to adopt
```

Use one Agent when one is enough. Add another when the value of a different capability, independent attempt, or adversarial review justifies the extra time and cost.

## Who Meldwork is for

- People who regularly move research, planning, creation, operations, development, or review work between multiple Agents.
- AI-native teams whose members use different Agent vendors or specialized capabilities.
- Work that benefits from a second perspective without losing the original context.
- Users who want to preserve existing Agent accounts, Provider relationships, and a local workspace boundary.

Meldwork is not yet the right choice if you only use one Agent for isolated tasks, need a managed cloud execution queue today, or require audited enterprise controls and release-certified Windows support.

## Try the MVP locally

Prerequisites: Node.js 20.19 or newer, npm, and macOS for the currently configured desktop packaging target.

```bash
npm --prefix frontend ci
npm --prefix desktop ci

# Start the Electron desktop app
npm --prefix desktop run dev
```

For a renderer-only preview:

```bash
npm --prefix frontend run dev
```

The browser preview intentionally cannot execute local Agents because it has no Electron bridge.

<details>
<summary><strong>Development checks</strong></summary>

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

Generated packages are written to `desktop/dist/` and are not committed.

</details>

<details>
<summary><strong>Architecture and security boundaries</strong></summary>

The Vue renderer reaches Agent functionality only through validated preload APIs. The Electron main process owns filesystem paths, child processes, Agent configuration, persistence, and secure credential storage. The renderer has no unrestricted shell API.

New conversations currently allow workspace writes by default; users can disable write mode per conversation. Adapter-level read-only modes reduce accidental writes where upstream CLIs can enforce them, but they are not an operating-system sandbox. Guided installers use fixed allowlisted recipes; upstream packages and scripts are not yet digest- or signature-pinned.

Internal identifiers such as `window.roundrelayDesktop`, existing storage filenames, and `com.roundrelay.desktop` are intentionally retained during the brand transition to preserve the current local-data and preload contracts.

</details>

## Project status

Meldwork is a market-validation MVP, not a finished platform. Before a public release, the project still needs:

- a selected and committed software license;
- target-device compatibility tests for supported Agents;
- a public connector contract before "any Agent" is presented as shipped capability;
- signed and notarized macOS distribution;
- real-device Windows validation before Windows support is marketed as production-ready;
- product validation that persistent cross-Agent work creates enough value to justify a new workspace.
