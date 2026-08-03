<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork - Agents change. Work continues." width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Multiple agents. One body of work.

**Meldwork gives different AI agents one persistent local workspace: context stays intact, collaboration stays visible, and you stay in control.**

The agent market is getting better and messier at the same time. One agent writes, another researches, another reviews. The hard part is no longer getting an answer. It is keeping the work coherent while the agents around it change.

Meldwork brings the agents you already use into direct conversations and working groups, without turning your work into another hosted service.

[PolyForm Noncommercial 1.0.0](LICENSE) · [Commercial use](COMMERCIAL_USE.md) · [Notice](NOTICE)

## Stop rebuilding context

Most multi-agent workflows are still tab switching with extra steps:

- repeat the brief every time you change tools;
- carry decisions and files between disconnected sessions;
- manually decide who should answer, challenge, revise, or continue;
- lose sight of what happened once a polished final response appears.

**That is not collaboration. It is context tax.**

Meldwork keeps the task, conversation, participants, permissions, and run history together, so a different agent can join the work without forcing you to reconstruct it.

## One workspace, clear roles

| What you need | What Meldwork changes |
| --- | --- |
| A fast answer from one agent | Start a focused direct conversation and keep it available for later |
| A second opinion | Bring selected agents into the same working group |
| Real critique, not polite agreement | Run a bounded multi-agent discussion and decide how many rounds it gets |
| Confidence in what happened | See who is queued, working, complete, or failed, with the run trace attached to the conversation |
| Control over your environment | Keep conversations and orchestration state local, with visible workspace write permissions |
| Freedom to use different vendors | Connect supported agents without replacing their accounts, providers, or native strengths |

## What feels different

### Start with one agent. Escalate only when the work deserves it.

Meldwork does not force every task through a committee. Use one agent when one is enough. Add another for a different capability, an independent attempt, or an adversarial review.

### Let agents challenge each other, with a limit.

Working groups can run automatic discussions across selected agents. You set the boundary, watch the run, and decide what is worth keeping.

### Keep the work, not just the final reply.

Persistent conversations, compatible native-session continuity, visible run state, Skills, images, and collected outputs stay connected to the task that produced them.

### Stay in charge of the machine.

Meldwork is local-first. Workspace access is explicit, sensitive credentials use operating-system-backed storage where supported, and agent execution stays behind the desktop application's controlled boundary.

## Built for work that cannot rely on one answer

- **Research:** one agent gathers evidence, another attacks the assumptions.
- **Product and strategy:** one develops the proposal, another looks for the expensive mistake.
- **Writing and content:** one creates, another edits for accuracy, structure, and tone.
- **Development:** one implements, another reviews the code and the reasoning behind it.
- **Operations:** different agents handle specialized parts while the full task remains visible in one place.

The point is not to use more agents. The point is to use the right agent for each part of the job without breaking the job apart.

## Agents you can bring in today

Meldwork currently connects to:

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code · OpenCodeReview**

Each agent keeps its own capabilities, provider configuration, permission model, and session behavior. Availability depends on the installed agent, its version, and your configuration.

## Local-first, without pretending the internet disappears

Conversations, groups, and orchestration state stay on your computer. Model requests still follow the agent and provider you choose. Meldwork keeps the workspace local; it does not make third-party models offline.

## Run Meldwork locally

Current desktop target: macOS. Requires Node.js 20.19 or newer and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

## License

Meldwork is source-available under the [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial use is permitted under the license terms. Commercial use requires a separate written agreement; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
