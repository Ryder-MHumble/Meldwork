<p align="center">
  <img src="frontend/public/logos/meldwork-wordmark-v3.svg" alt="Meldwork 本地优先 AI Agent 工作空间" width="260">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Meldwork：本地优先（Local-first）AI Agent 工作空间

> 协同本地 Agent CLI，比较独立结果，在写入前检查证据。

Meldwork 是一个源码可见的 Electron 桌面应用，也是本地优先的多 Agent 协作与 AI Agent 编排工作空间，面向使用多个 AI Agent 的开发者、研究人员和技术团队。它把 Codex、Claude Code、Gemini CLI、OpenCode、Qwen Code 等本地 Agent CLI 放进同一个工作空间，支持直接会话、并发回复、有证据可追溯（evidence-aware）运行和人类在环（human-in-the-loop）复核。

当前公开预览版是 Apple 芯片 macOS 上的单用户工作单元。参与者、工作目录、上下文、权限以及是否采用最终结果，都由你决定。Meldwork 不要求账号、服务器或托管式对话存储。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.3/Meldwork-0.1.3-arm64.dmg"><strong>下载 Apple 芯片 macOS 预览版</strong></a>
  · <a href="https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3">发布说明</a>
  · <a href="architecture.md">架构</a>
  · <a href="desktop/README.md">桌面端指南</a>
  · <a href="LICENSE">许可证</a>
</p>

## 适合谁

当你有以下需求时，Meldwork 更适合：

- 已经安装多个本地 Agent CLI，希望让同一任务跨 Agent 协作；
- 需要在代码评审、研究或产品分析中获得独立判断，再选择方案；
- 需要在写入工作区前检查可追溯的运行轨迹、证据并保留人工复核。

## 工作流程

1. **选择**本地 Agent 和参与者。
2. **限定**目标、工作目录、上下文和权限。
3. **运行**直接会话、并发回复或 Auto Discussion V4。
4. **复核并采用**结果、证据和待处理的人工审批门（Human Gate），再写入工作区。

## 协作模式

| 模式 | 运行方式 | 适合场景 |
| --- | --- | --- |
| **直接会话** | 一个已选 Agent 在适配器支持时保持对话和原生会话。 | 使用单个 Agent 完成聚焦工作。 |
| **并发回复** | 已选 Agent 收到同一份冻结任务快照，并按稳定顺序返回独立回复。 | 在选择方案前比较不同路径。 |
| **Auto Discussion V4** | 已选 Agent 先提案、质询并协商责任，按依赖执行工作，再独立复核结果。 | 需要明确责任和复核的多轮工作。 |

参与者始终由用户选择。从更大候选池自动选人不属于当前预览版。

## 运行示例

| 本地 Agent 检测 | 多 Agent 评审 | 直接会话中的多模态工作 |
| --- | --- | --- |
| [![Meldwork 本地优先多 Agent 工作空间检测 Agent CLI](assets/meldwork-agent-discovery.png)](assets/meldwork-agent-discovery.png) | [![Meldwork 多 Agent 协作、证据与人工复核](assets/meldwork-multi-agent-review.png)](assets/meldwork-multi-agent-review.png) | [![Meldwork 直接 Agent 工作空间处理本地文件和媒体](assets/meldwork-direct-multimodal.png)](assets/meldwork-direct-multimodal.png) |

示例：把同一份变更评审上下文交给 Codex、Claude Code 和 Gemini CLI，比较各自的独立发现，再只采用你批准且有证据支持的结果。

## 支持的本地 Agent CLI

当适配器和 CLI 版本兼容时，Meldwork 会检测并调用已安装的命令：

**Codex**（`codex`）· **Hermes**（`hermes`）· **OpenClaw**（`openclaw`）· **WorkBuddy**（`codebuddy`）· **Pi Agent**（`pi`、`pi-agent`、`piagent`）· **Kimi Code**（`kimi`）· **MiMo Code**（`mimo`）· **Claude Code**（`claude`）· **Gemini CLI**（`gemini`）· **OpenCode**（`opencode`）· **Qwen Code**（`qwen`）· **OpenCodeReview**（`ocr`）

已批准的 Agent Connector 可通过 [Agent Connector SDK](docs/agent-connector-sdk.md) 接入；自定义可执行 Agent 使用桌面端的自定义 Agent 入口。完整适配器和能力矩阵见[桌面端指南](desktop/README.md)。

## 快速开始

### Apple 芯片 macOS 预览版

从[官方 V1.0.3 预发布页](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3)下载 [`Meldwork-0.1.3-arm64.dmg`](https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.3/Meldwork-0.1.3-arm64.dmg)，将 Meldwork 移入“应用程序”，并至少安装一个受支持的本地 Agent CLI。该预发布版使用 ad-hoc 临时签名且未公证；首次启动时，macOS 可能要求你在“系统设置 -> 隐私与安全性”中选择“仍要打开 / Open Anyway”。

### 从源码运行

前置条件：Node.js `22.12+` 和 npm。

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

分发构建前运行：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## 当前边界

Meldwork 是本地 Electron 应用，不是托管式 Agent Fleet，也不是通用 Agent 框架。当前预览版不提供远程、云端或频道 Agent 执行，不提供自动选人组队、企业 SSO/RBAC/治理或 Outcome Network。Local-first 不等于完全离线：选定的 Agent 仍可能把 Prompt、附件或 Skill（技能）发送到其配置的 Provider（模型服务商）。工作区写入是可选的工作流控制，不是操作系统级沙箱。

## 文档

- [架构与产品边界](architecture.md)
- [桌面端设置与 Agent 矩阵](desktop/README.md)
- [Agent Connector SDK](docs/agent-connector-sdk.md)
- [AI 可发现性索引](docs/ai-discoverability.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Meldwork 采用 [Apache License 2.0](LICENSE)。你可以按照许可证条款使用、修改和再发布本仓库；第三方 Agent 产品、模型、依赖和品牌资产仍分别受其自身许可证与声明约束。
