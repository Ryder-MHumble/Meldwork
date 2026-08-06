# Meldwork Launch Kit

This document contains draft public-relations and repository-launch copy for the current MVP. `Meldwork` still requires trademark, domain, and user-understanding checks. Publish only copy that matches the repository's AGPL Community Edition and commercial-license policy docs.

## Positioning

**Current MVP category:** Local-first desktop workspace for a bounded two-Agent produce-and-review loop

**Current product line:** Agents change. Work continues.

**Chinese:** Agent 可切换，工作不断线。

**Current one sentence:** Meldwork lets two supported local Agents produce and challenge one deliverable in a persistent local workspace, with explicit context, permissions, and reviewable execution state.

**Chinese:** Meldwork 让两个已支持的本地 Agent 在同一个持续存在的本地工作空间里产出并复核一份交付物，同时保留明确的上下文、权限和可复盘运行状态。

**Target product category:** An open, local-first work system for compatible Agents and knowledge sources across vendors.

**Target architecture line:** Agents and knowledge sources should join through explicit capabilities, permissions, events, and egress declarations.

The target category and architecture line describe product direction. The current MVP still uses a fixed set of local CLI adapters and does not automatically merge separate direct and group conversation histories.

## Launch headline

Introducing Meldwork: a persistent workspace for the Agents you already use

After the public connector contract is added, use:

Introducing Meldwork: an open, local-first workspace for Agents and knowledge

## Short announcement

Meldwork is a local-first desktop workspace for a bounded two-Agent review loop. The current MVP discovers supported local Agent CLIs, keeps direct and group conversations persistent, resumes compatible native sessions, accepts validated task files, and records sanitized execution state. Its first public workflow is simple: one Agent produces a deliverable, a second challenges assumptions and evidence, and the human decides what to adopt. Other domains and future Connector capabilities remain examples or roadmap items.

## Chinese announcement

Meldwork 是面向双 Agent 有界复核的本地优先桌面工作空间。当前 MVP 可以发现已支持的本地 Agent CLI、持久保存单聊与群组会话、在兼容条件下恢复原生 Session、接收经过验证的任务文件，并记录脱敏运行状态。公开首发只承诺一个闭环：一个 Agent 形成交付物，第二个检查假设与证据，最后由人决定是否采用。其他业务领域和未来 Connector 能力仍属于示例或路线图。

## Story structure

1. People and teams increasingly use several capable Agents and many knowledge sources, but their context, sessions, permissions, and outputs remain fragmented.
2. Meldwork gives supported local Agents and explicitly selected knowledge sources one persistent workspace without asking users to replace their Agent, Provider, or content platform relationships.
3. The current MVP demo should show one clean-profile two-Agent produce-and-review task from Agent readiness through human review.
4. Connector contracts, Cloud transport, and Channel ingress are platform capabilities, not required public-MVP demo claims until a production implementation is configured.
5. Task, Context Pack, Run, Artifact, Evidence, and human Adoption records support durability and review, but the launch story should stay focused on the user-visible produce-and-review loop.
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
