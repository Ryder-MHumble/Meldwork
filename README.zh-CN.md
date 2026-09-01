<!-- <p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logos/meldwork-wordmark-v3-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/logos/meldwork-wordmark-v3.svg">
    <img src="frontend/public/logos/meldwork-wordmark-v3.svg" alt="Meldwork" width="360">
  </picture>
</p> -->

<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-cn.png" alt="Meldwork README banner" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Meldwork：Local-first 多 Agent 协作工作空间

> Meldwork 是一个 Local-first Electron 桌面工作空间，用于多 Agent 协作与 Agent 编排。它把受支持的本地 Agent CLI 放进同一个 AI Agent 工作空间，支持并发或协商式工作，保留可检查的 Evidence，并在工作区写入和采用决定之前让人类保持在环（human-in-the-loop）。

Meldwork 是一个源码可见（source-available）的 Local-first 桌面应用，面向已经使用多个 AI 编程或研究 Agent 的用户。当前公开预览版是单用户工作单元：由你选择参与者、工作目录、上下文和最终决定。Meldwork 不要求服务器、账号或远程对话存储。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3"><strong>下载 V1.0.3 Apple 芯片 macOS 预览版</strong></a>
  · <a href="architecture.md">架构</a>
  · <a href="desktop/README.md">桌面端指南</a>
  · <a href="LICENSE">许可证</a>
</p>

## 它解决什么问题？

同时使用多个 Agent，通常意味着手动选择工具、在终端之间搬运上下文、处理互相冲突的答案，并记住最终为什么采用某个结果。Meldwork 提供单个 Agent 与最终决定之间的组织层：

- 一个共享 Goal 和明确的验收边界；
- 独立提案，而不是隐藏路由；
- 声明式的权限、责任、交接、依赖和停止条件；
- 可持续复核的 Artifact 与 Evidence，不因切换 Agent 而消失；
- 由人类掌握的权限、预算、写入和采用决定。

## 核心能力

### 多 Agent 协作与 Agent 编排

- **直接会话和持久群组**：在本地工作空间中保留 Agent Session、消息、工作目录、Skill、知识引用、图片和其他附件。
- **并发回复（Concurrent Responses）**：为全部已选 Agent 冻结同一份任务快照，收集独立回复，再按稳定的成员顺序提交完成结果。
- **Auto Discussion V4**：已选 Agent 先独立提案，再交叉质询并协商一张共享职责图，按依赖执行工作包，由单一整合写入者收敛结果，最后独立复核。
- **Harness 控制平面**：约束上下文、权限、预算、恢复、阶段、回执和提交边界；不会绕过协商计划在模型之外私自分配职责。
- **Evidence 与可追溯性**：持久化经过脱敏的运行轨迹，以及 Artifact、Evidence、Finding 和 Adoption 等紧凑类型化记录。Raw chain-of-thought、凭据、可执行路径和不受限工具输出不会进入渲染层。
- **Human-in-the-loop 安全控制**：工作区写入默认关闭。权限、预算、存在歧义的写入结果和评审决定可以要求显式 Human Gate；人类采用结果会作为独立 Outcome 记录。
- **Local-first 上下文**：导入经过校验的本地文件和媒体，选择有边界的知识源引用，使用面向目标 Agent 的 Skill，并为兼容 Agent 配置 Provider；Meldwork 对话不会迁移到托管服务。

### 当前支持的本地 Agent CLI

当对应命令已安装且兼容时，Meldwork 可以检测并调用以下内置本地 CLI profile：

| Agent | 本地命令 |
| --- | --- |
| Codex | `codex` |
| Hermes | `hermes` |
| OpenClaw | `openclaw` |
| WorkBuddy | `codebuddy` |
| Pi Agent | `pi`、`pi-agent` 或 `piagent` |
| Kimi Code | `kimi` |
| MiMo Code | `mimo` |
| Claude Code | `claude` |
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |
| Qwen Code | `qwen` |
| OpenCodeReview | `ocr` |

Custom Agent 和本地 Agent Connector SDK 提供明确的扩展路径。Connector package 采用内容寻址，由用户批准，并受声明能力约束；详见 [Agent Connector SDK](docs/agent-connector-sdk.md)。

## 适用场景与不适用场景

| 适合在这些场景使用 Meldwork | 这些需求应优先选择原生工具或其他产品 |
| --- | --- |
| 需要多个本地 Agent 针对同一目标给出独立判断 | 一个 Agent 和一个工作面已经足够 |
| 需要并发回复，或提案、协商、执行、复核等多轮流程 | 需要托管式团队工作空间或远程 Agent Fleet |
| 需要可检查的 Evidence、受边界约束的运行轨迹和明确验收 | 需要从大型候选池自动选人组队 |
| 需要本地文件、Skill、知识引用和显式开启的工作区写入 | 当前就需要企业 SSO、集中治理或组织级审计 |

远程 Agent、Cloud 和 Channel Connector、自动选人组队、企业治理以及 Outcome Network 不在当前公开预览边界内。本预览版也不等于商业授权；请查看[许可证](LICENSE)和[商业使用说明](COMMERCIAL_USE.md)。

## 使用流程

1. **检测并选择**要使用的本地 Agent CLI。
2. **定义上下文**：设置工作目录、Prompt、经过校验的文件或媒体、Skill 和可选知识引用。
3. **选择模式**：直接会话、并发回复或 Auto Discussion V4。
4. **检查轨迹**：查看阶段进度、Agent 结果、Artifact、Evidence 和待处理的 Human Gate。
5. **决定是否采用**。Meldwork 不会静默写入工作区，也不会替你做最终决定。

## 效果演示

| 本地 Agent 检测 | 直接会话中的多模态工作 | 并发多 Agent 工作 |
| --- | --- | --- |
| [![Meldwork 检测已支持的本地 Agent CLI](assets/meldwork-agent-discovery.png)](assets/meldwork-agent-discovery.png) | [![直接 Agent 会话返回本地文件和媒体](assets/meldwork-direct-multimodal.png)](assets/meldwork-direct-multimodal.png) | [![用户选择多个 Agent 并查看各自回复](assets/meldwork-group-collaboration.png)](assets/meldwork-group-collaboration.png) |
| 查看哪些受支持 Agent 已就绪。 | 让 Prompt、文件、权限和兼容 Session 保持在一起。 | 运行并发回复，或让已选择的 Agent 自主协商协作方式。 |

## 与相邻工具的区别

| 类别 | 通常关注什么 | Meldwork 的范围 |
| --- | --- | --- |
| 单 Agent CLI 或 AI IDE | 在一个 Agent 生态中完成深度工作 | 让上下文和决定跨异构本地 Agent 保持连续 |
| 并行 Coding-Agent 工作台 | 吞吐量和隔离的代码任务 | 方案质量、责任、Evidence 和验收 |
| Cloud Agent 控制平面 | 远程 Job、Sandbox 和 Agent Fleet | Local-first 执行，使用电脑上已经安装的 Agent |
| 可编程 Agent 框架 | 开发者定义 Graph、角色和路由 | 面向使用者的 Agent 组织与复核工作流 |
| 多终端与脚本 | 直接访问原生 Agent 能力 | 持久上下文、边界、轨迹和明确的人类决定 |

## 安装

### Apple 芯片 macOS 打包预览版

当前经过发布验证的目标是 Apple 芯片 macOS。

1. 打开 [Meldwork V1.0.3 预发布页](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.3)。
2. 下载 `Meldwork-0.1.3-arm64.dmg`。
3. 将 Meldwork 拖入“应用程序”，然后打开一次。
4. 当前预发布版使用 ad-hoc 临时签名，没有 Apple Developer ID 签名，也没有经过 Apple 公证。如果 macOS 阻止启动，请打开“系统设置 -> 隐私与安全性”，找到 Meldwork 提示，选择“仍要打开 / Open Anyway”并确认。
5. 至少安装或连接一个受支持的本地 Agent CLI，然后让 Meldwork 执行检测。

请只使用官方 GitHub Release 下载的产物。

### 从源码运行

前置条件：Node.js `22.12` 或更高版本以及 npm。

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

分发前运行仓库检查：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

桌面端开发、打包、完整 Agent 矩阵和 Provider 配置见[桌面端指南](desktop/README.md)。

## 信任边界与本地数据

- 对话、群组、编排状态、受边界约束的运行记录和附件元数据保存在本地 Electron 用户数据中。
- Agent 执行、文件访问、附件校验、Provider 存储、Connector 审批和安装器控制都在 Electron 主进程中完成，并通过窄化的 preload API 暴露能力。
- Provider API Key 在兼容环境中使用操作系统安全存储；凭据和可执行路径不会暴露给渲染层。
- 工作区写入必须显式开启。Agent CLI 及其配置的模型 Provider 仍是外部依赖，各自适用自己的数据处理条款。
- Local-first 不等于所有模型都离线运行：选定的 Agent 仍可能把 Prompt、附件或 Skill 发送到其配置的 Provider。

完整边界和已知限制见[架构说明](architecture.md)与[安全策略](SECURITY.md)。

## 文档与贡献

- [架构与产品边界](architecture.md)
- [桌面端设置、Agent 矩阵和打包](desktop/README.md)
- [Agent Connector SDK](docs/agent-connector-sdk.md)
- [AI 可发现性索引](docs/ai-discoverability.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [变更记录](CHANGELOG.md)

## 许可证

Meldwork 采用 [Meldwork 非商用源码许可](LICENSE)。它不是 OSI 意义上的开源许可证。你可以为非商用目的查看、运行、修改和分享；商业使用需要事先书面许可，详见[商业使用说明](COMMERCIAL_USE.md)。
