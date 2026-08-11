<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-en.png" alt="Meldwork - Agents change. Work continues." width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# AI agents are interchangeable. Your work should not be.

**Meldwork is a local-first desktop workspace for persistent direct Agent conversations and bounded multi-Agent review. Each conversation keeps its own context, permissions, attachments, compatible native sessions, and sanitized execution history on your computer.**

Most Agent tools are already good at completing one step. The fragile part starts when work crosses tools: context gets copied by hand, files are attached again, permission boundaries drift, and the final answer can look complete without showing how it was formed. Meldwork keeps the task stable while Agents change. Start with one Agent, add another only when the work needs a different capability or an independent challenge, then inspect the result before deciding what to keep.

Meldwork is not about opening more AI windows. It is about letting complex work move between Agents without losing the thread: one Agent's conclusions and evidence can support the next step, every answer returns to the same task context, and you decide which results are worth accepting.

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Release-V1.0.0/Meldwork-0.1.0-arm64.dmg"><strong>Download the macOS DMG</strong></a>
  · <a href="LICENSE">Non-commercial source license</a>
  · <a href="COMMERCIAL_USE.md">Commercial permission</a>
</p>

## Install the desktop client

The current desktop build is for Apple silicon Macs.

1. Open the [latest GitHub Release](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Release-V1.0.0).
2. Download `Meldwork-0.1.0-arm64.dmg`.
3. Drag Meldwork into Applications, then try to open it once.
4. If macOS blocks the current preview because it is not yet Apple-notarized, open **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** beside Meldwork, then confirm **Open**. The button appears only after the first blocked launch attempt. Use only a DMG downloaded from the official Release above.
5. Connect the supported Agent CLIs already installed on your computer, or configure an independent Provider profile for an Agent.

If the latest Release includes a DMG, it can be downloaded and installed locally. Developers can also run Meldwork from source with the commands below.

## See the core workflow

| Local Agent discovery | Direct multimodal work | Targeted multi-Agent review |
| --- | --- | --- |
| [![Meldwork detecting local Agent CLIs](assets/meldwork-agent-discovery.png)](assets/meldwork-agent-discovery.png) | [![A direct Agent conversation returning image, audio, and document outputs](assets/meldwork-direct-multimodal.png)](assets/meldwork-direct-multimodal.png) | [![A group conversation with targeted Agent replies](assets/meldwork-multi-agent-review.png)](assets/meldwork-multi-agent-review.png) |
| Detect supported Agent CLIs without presenting startup as an error state. | Keep prompts, generated media, files, permissions, and compatible native sessions in one direct conversation. | Ask only the selected Agents to respond, then inspect or collapse each reply independently. |

Click any screenshot to view it at full resolution.

## What Meldwork does today

- **Organizes local Agents:** detects supported CLI installations, keeps readiness visible, and lets users add approved CLI-based Custom Agents without turning the renderer into an unrestricted shell.
- **Keeps direct work continuous:** each direct conversation retains its local history, attachments, permission mode, compatible native Session, and sanitized execution details.
- **Moves multimodal files both ways:** users can paste or attach validated images, documents, code, archives, audio, and video; supported Agents and Providers can return locally previewable media and generated files to the same conversation.
- **Targets group work explicitly:** mention the exact Agents needed for a task, run a single response or bounded automatic discussion, stop individual Agents, collapse replies, and review regenerated response versions.
- **Makes execution inspectable and recoverable:** bounded run events, compact evidence capsules, checkpoints, completion states, and recovery actions remain available without exposing raw credentials, executable paths, or private reasoning.
- **Keeps control local:** conversations and orchestration state stay on the computer, credentials use operating-system-backed secure storage where supported, and workspace write access remains opt-in.

Capability still depends on the selected Agent, its installed version, authentication state, Provider, and declared attachment or tool support.

## A practical review loop

1. Start a direct conversation with the Agent best suited to produce the first deliverable.
2. Attach only the required context and enable workspace writes only when the task must modify files.
3. Move the task into a group when it needs another capability or an independent challenge; select only the Agents that should participate.
4. Compare final replies, generated artifacts, response versions, and sanitized run details before deciding what to accept.

Meldwork does not silently merge unrelated conversation histories. The user chooses which files, conclusions, Skills, and approved knowledge sources should cross into the next task.

## The Harness behind the workspace

![Meldwork Harness Engine](frontend/public/logos/Harness-readme.png)

The Harness is the layer that keeps Agent collaboration from turning into copied prompts and disconnected transcripts. It normalizes Agent events, builds bounded context for each target, keeps compatible native sessions separate, checkpoints local run state, and exposes recovery states when authentication or compatibility needs user action.

- **Run control:** explicit targets, manual handoffs, bounded automatic rounds, stop, and per-Agent controls.
- **Context control:** stable constraints, selected files, target-scoped Skills and knowledge sources, recent conclusions, and compact evidence capsules.
- **Inspectable execution:** conclusions, source context, warnings, terminal status, and, when exposed by the selected Agent or transport, plans and tool lifecycle summaries.
- **Durable local state:** conversations and bounded run records remain inspectable; context stays durable and traceable after completion or interruption.

## Where the workflow fits

| Work | First Agent | Independent check |
| --- | --- | --- |
| Research and intelligence | Build the evidence base | Challenge unsupported claims and missing sources |
| Product and strategy | Draft the proposal and decision model | Test user value, feasibility, and expensive failure modes |
| Software delivery | Implement and verify the change | Review the diff, tests, security boundaries, and regressions |
| Writing and operations | Produce the deliverable | Check structure, accuracy, tone, and execution risk |

The goal is not to maximize Agent count. Use one Agent when one is enough, and add another only when a different capability or independent review materially improves the result. Model requests still follow the Agent and Provider you choose; local-first describes Meldwork's workspace and orchestration state, not third-party model hosting.

## Connected Agents

Meldwork currently integrates with:

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code**

Specialized review:

**OpenCodeReview**

Availability depends on the installed Agent, supported version, authentication state, and declared capabilities. OpenCodeReview is a specialized review target rather than a general conversation Agent.

Each Agent keeps its own capabilities, provider configuration, permission model, and session behavior. Availability depends on the installed Agent, its version, and its authentication state.

## Current release scope

The first release-validated target is Apple silicon macOS. Windows has implementation-level support, but broad real-device validation is still incomplete. Broad third-party Agent certification is not yet claimed.

<details>
<summary><strong>Build from source for development</strong></summary>

Requires Node.js 20.19 or newer and npm.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Use the repository test scripts before distributing a build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

</details>

## License

Meldwork is source-available under the [Meldwork Non-Commercial Source License](LICENSE). You may inspect, run, modify, and share the software for non-commercial purposes, but commercial use is not permitted without prior written permission from the copyright holder.

Commercial use includes resale, paid hosting, managed services, consulting or outsourcing use, closed-source embedding, and business operations by or for a for-profit organization. To request permission or a separate commercial license, see [COMMERCIAL_USE.md](COMMERCIAL_USE.md). Third-party attribution is recorded in [NOTICE](NOTICE).
