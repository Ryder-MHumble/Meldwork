# Meldwork Launch Kit

This document contains draft public-relations and repository-launch copy for the current MVP. `Meldwork` still requires trademark, domain, and user-understanding checks. Publish only copy that matches the repository's non-commercial license and policy docs.

## Positioning

**Current MVP category:** Local-first desktop workspace for supported general-purpose Agent CLIs

**Current product line:** Agents change. Work continues.

**Chinese:** Agent 可切换，工作不断线。

**Current one sentence:** Meldwork brings supported local Agent CLIs and explicitly selected knowledge sources into one persistent workspace, so conversations, compatible native sessions, and task context can continue when work moves between Agents.

**Chinese:** Meldwork 把已支持的本地 Agent CLI 和用户明确选择的知识来源带进一个持续工作空间，让工作在不同 Agent 之间流转时，对话、兼容条件下的原生 Session 和任务上下文仍然保留。

**Target product category:** An open, local-first work system for compatible Agents and knowledge sources across vendors.

**Target architecture line:** Agents and knowledge sources should join through explicit capabilities, permissions, events, and egress declarations.

The target category and architecture line describe product direction. The current MVP still uses a fixed set of local CLI adapters.

## Launch headline

Introducing Meldwork: a persistent workspace for the Agents you already use

After a license and public connector contract are added, use:

Introducing Meldwork: an open, local-first workspace for Agents and knowledge

## Short announcement

Meldwork is a local-first desktop workspace for general-purpose AI agents. The current MVP discovers supported local Agent CLIs, keeps direct and group conversations persistent, resumes compatible native sessions, runs bounded discussions, and lets users explicitly select ready Feishu, DingTalk, or Obsidian knowledge sources. It is not a coding-only Agent aggregator or a knowledge-base engine: coding, research, planning, creation, operations, and review share one cross-Agent workspace, while source access and Provider traffic still follow the selected local tools and Agent configuration.

## Chinese announcement

Meldwork 是面向通用 AI Agent 的本地优先桌面工作空间。当前 MVP 可以发现已支持的本地 Agent CLI、持久保存直接与群组会话、在兼容条件下恢复原生 Session、运行有界讨论，并让用户显式选择已就绪的飞书、钉钉或 Obsidian 知识来源。它既不是 Coding Agent 聚合器，也不是知识库引擎：开发、研究、规划、创作、运营和审查共享同一个跨 Agent 工作空间，知识访问和 Provider 流量仍遵循所选本地工具与 Agent 配置。

## Story structure

1. People and teams increasingly use several capable Agents and many knowledge sources, but their context, sessions, permissions, and outputs remain fragmented.
2. Meldwork gives supported local Agents and explicitly selected knowledge sources one persistent workspace without asking users to replace their Agent, Provider, or content platform relationships.
3. The current MVP demo should show discovery, persistent conversations, compatible session continuity, Agent-specific capabilities, and bounded collaboration only where verified.
4. The next architecture milestone is a public Agent and Knowledge Connector contract with capability, permission, event, and egress manifests.
5. The next product milestone is an explicit Context Pack -> Task -> Run -> Artifact -> Evidence -> Human decision loop.
6. The product difference must come from continuity, open connection, evidence, acceptance, and explicit permission boundaries, not from displaying more Agent avatars.
7. Local-first does not mean every model is offline; selected Providers may still use the network.

## Pull request summary

### What changed

- Repositioned Meldwork from a coding-Agent CLI aggregator to a persistent workspace for general-purpose Agents.
- Rewrote the English and Chinese READMEs around user work fragmentation, current MVP facts, and the open Agent/knowledge Connector direction.
- Adopted the asymmetric Trace V3 identity across the client, Electron icon, favicon, brand board, and README campaign assets.
- Added separate English and Chinese 1600 x 640 README banners using a generated text-free visual plate with exact local logos and typography.
- Removed the superseded V2 and coding-specific README banner assets.

### Why

Agent products are converging toward general-purpose work systems. Meldwork's category should be defined by persistent cross-Agent work and an open connection model, not by the coding origins or names of the first supported tools. The Trace line represents continuity across Agent changes; the open connector and separated coral point represent extensibility and explicit human control.

### Verification

Before merge, record the exact frontend and desktop tests executed, image dimensions, SVG validation, README-link checks, theme-logo checks, live-Agent checks, Electron screenshots, and release steps that were intentionally not run. Do not claim arbitrary Agent connectivity, packaging, signing, notarization, or target-device compatibility without direct evidence.
