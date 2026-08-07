<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork - Agents change. Work continues." width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# One task. Different Agents. A result you can inspect.

**Meldwork is a local-first desktop workspace that keeps conversations, files, permissions, compatible Agent sessions, and sanitized run evidence together while work moves between general-purpose Agents.**

Most Agent tools are good at completing a step. The work becomes fragile when you cross tools: context is copied by hand, files are attached again, permission boundaries drift, and the final answer arrives without a clear record of how it was reached.

Meldwork keeps the task stable while Agents change. Start with one Agent, add another only when the work needs a different capability or an independent challenge, then inspect the result before deciding what to keep.

<p align="center">
  <a href="docs/harness-engine-strategy.md"><strong>Understand the Harness</strong></a>
  · <a href="#run-from-source">Run from source</a>
  · <a href="LICENSE">AGPL-3.0 license</a>
</p>

## The problem is fragmented work

| When work crosses Agent tools | What Meldwork keeps together |
| --- | --- |
| Conversation history is split across apps | A persistent direct conversation or working group |
| Files and instructions are repeatedly copied | Explicit task files, Skills, knowledge sources, and bounded context |
| Permission scope is easy to lose | A visible working directory and opt-in workspace write access |
| Multiple answers create more noise | Bounded rounds, Agent-specific results, and a human decision |
| The final output is hard to reconstruct | Sanitized events, context provenance, status, and compact evidence |

Meldwork does not automatically merge unrelated conversation histories. You decide which messages, files, Skills, and knowledge sources enter a task.

## A repeatable workflow

1. **Start focused.** Open a direct conversation with the Agent best suited to the first step.
2. **Add only necessary context.** Attach task files, choose compatible Skills or configured knowledge sources, and keep workspace writes off unless the task requires them.
3. **Bring in a second perspective.** Create a group, select only the Agents that should participate, and use a manual handoff or a bounded automatic discussion.
4. **Inspect before accepting.** Review each Agent, round, conclusion, injected source context, and sanitized event history, then decide whether to adopt, revise, or discard the result.

## One workspace for direct work and collaboration

![Meldwork workspace overview](docs/assets/meldwork-multi-agent-review.png)

Direct conversations and working groups live in the same desktop workspace. The sidebar reflects the Agents available on that computer; the main surface keeps active tasks, working directories, permissions, and recent conversations within reach.

## The Harness behind the workspace

![Meldwork Harness Engine](frontend/public/logos/Harness-readme.png)

Direct conversations stream progress inline. Group Runs add Agent- and round-specific trace details. Behind both surfaces, the Harness normalizes Agent events, builds bounded Context Packs, keeps compatible native Sessions separate, checkpoints local Run state, and exposes explicit recovery states.

- **Run control:** explicit targets, manual handoffs, bounded automatic rounds, stop, and per-Agent controls.
- **Context control:** stable constraints, selected files, target-scoped Skills and knowledge sources, recent conclusions, and compact evidence capsules.
- **Inspectable execution:** conclusions, source context, warnings, terminal status, and, when exposed by the selected Agent or transport, plans and tool lifecycle summaries, without revealing raw chain-of-thought or credentials.
- **Durable local state:** conversations and bounded Run records remain inspectable; Context Packs remain durable and traceable after completion or interruption.
- **Explicit recovery:** authentication and compatibility failures require correction and a user retry instead of blind repeated attempts.

Interrupted multi-Agent work is recorded, but not every workflow can resume from the exact previous Agent slot yet. The current behavior favors an inspectable interruption over silently duplicating work or side effects.

## What you can do today

- Keep persistent direct conversations and multi-Agent working groups.
- Target one or more Agents explicitly, or run an automatic discussion with a chosen maximum round limit.
- Attach validated images, media, documents, code, and archives, subject to the selected Agent's capabilities.
- Add up to four compatible Skills and configured Feishu, DingTalk, or Obsidian knowledge sources to the relevant Agent target.
- Continue compatible native Sessions without exposing their identifiers to the renderer.
- Keep workspace write access off by default and enable it per conversation when the task needs file changes.
- Inspect sanitized direct-run details inline and group-run details by Agent and round.
- Store Agent-specific Provider profiles with operating-system-backed encryption where supported.

## Where it helps

- **Research and intelligence:** one Agent builds the evidence base while another challenges unsupported assumptions.
- **Product and strategy:** one develops a proposal while another tests user value, feasibility, and expensive failure modes.
- **Software delivery:** one implements while another reviews the diff, tests, and reasoning behind the change.
- **Writing and operations:** one produces the deliverable while another checks accuracy, structure, and execution risk.

The goal is not to maximize Agent count. It is to use the smallest useful team without losing the task, the boundary, or the evidence.

## Connected Agents

General Agents:

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code**

Specialized review:

**OpenCodeReview**

Availability depends on the installed Agent, supported version, authentication state, and declared capabilities. OpenCodeReview is a specialized review target rather than a general conversation Agent.

## Data and control boundary

Meldwork keeps its workspace and orchestration records on the local computer and does not require a Meldwork cloud account or remote conversation store. Model and tool requests still follow the Agent and Provider you configure.

Workspace write access is an explicit per-conversation choice, but Meldwork is not an operating-system sandbox. Agent processes run with the local user's identity, and upstream tools remain responsible for enforcing the capabilities they declare.

## Run from source

Requires Node.js 20.19 or newer and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

The strongest current packaging and runtime verification is on Apple silicon macOS. Windows has implementation-level support, but broad real-device validation is still incomplete.

Verification commands and known gaps are documented in [docs/tests.md](docs/tests.md).

## Documentation

- [Harness Engine strategy](docs/harness-engine-strategy.md)
- [Architecture](docs/architecture.md)
- [Permissions](docs/permissions.md)
- [Tests and verification](docs/tests.md)

## License

Meldwork Community Edition is open source under the [GNU Affero General Public License v3.0 only](LICENSE). The AGPL permits commercial use, modification, and redistribution while requiring covered source to remain available when modified versions are distributed or offered over a network.

Organizations that need proprietary redistribution, closed-source embedding, or a separately licensed commercial edition can request a commercial license; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md). Third-party attribution is recorded in [NOTICE](NOTICE).
