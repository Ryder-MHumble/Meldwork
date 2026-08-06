<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-zh-CN.png" alt="Meldwork：Agent 随时切换，工作始终连续" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Agent 可以换，工作不该断

**Meldwork 是一个本地优先的 Agent 桌面工作台，用于持续单聊和有边界的多 Agent 复核。每个会话的上下文、权限、附件、兼容的原生 Session 与脱敏运行记录都保存在你的电脑上。**

它解决的不是“同时打开更多 AI”，而是让一项复杂工作能够在不同 Agent 之间真正接力：前一个 Agent 留下的结论和证据，后一个可以继续使用；所有人的回答仍然回到同一条任务脉络里，由你决定哪些结果值得接受。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/latest"><strong>下载 macOS 私有预览版</strong></a>
  · <a href="LICENSE">AGPL-3.0 开源许可证</a>
  · <a href="COMMERCIAL_USE.md">商业使用说明</a>
</p>

## 先装客户端，再开始工作

当前私有预览版面向 Apple 芯片 Mac：

1. 打开 [最新 GitHub Release](https://github.com/Ryder-MHumble/Meldwork/releases/latest)。
2. 下载 `Meldwork-0.1.0-arm64.dmg`。
3. 将 Meldwork 拖入“应用程序”并打开。
4. 连接电脑上已经安装的 Agent CLI，或为某个 Agent 单独配置 Provider。

当前内测包采用临时签名，尚未完成 Apple Developer ID 签名与公证。申请与配置步骤见 [macOS 签名与公证指南](docs/macos-signing.md)。

## 先跑通一个可重复的工作流

公开 MVP 只围绕一个核心闭环：先产出交付物，再由第二个 Agent 质疑和复核，最后由人决定采用什么。

1. 创建一个只有两个已就绪 Agent 的群组。
2. 只附加任务真正需要的文件；除非任务必须修改工作区，否则保持写入权限关闭。
3. 明确让一个 Agent 形成交付物，让另一个检查假设、遗漏与证据，并限制讨论轮数。
4. 查看最终回答和脱敏运行轨迹，再决定采用、修改或放弃结果。

研究、产品、开发、写作和运营是使用示例，不是五套独立的 MVP 承诺。首发成功的标准，是这条双 Agent 复核闭环能在一台干净的 Apple 芯片 Mac 上稳定完成。

## 打开客户端，看到的是完整工作现场

![Meldwork 工作台总览](docs/assets/meldwork-workspace-overview.png)

单聊、工作群组和最近任务都在同一个桌面工作台里。一个 Agent 足够时使用单聊；需要独立检查时创建群组。Meldwork 当前不会自动合并两个独立会话的历史，因此群组需要的背景和文件仍应由用户明确附加或重述。

## 一项任务如何在 Meldwork 里推进

| 阶段 | 你的操作 | Meldwork 保留下来的内容 |
| --- | --- | --- |
| 先开工 | 选择最合适的 Agent 发起单聊 | 当前任务、对话和原生 Session 延续关系 |
| 再协作 | 创建群组，只选择真正需要参与的 Agent | 群组成员、工作目录和明确的执行权限 |
| 多轮打磨 | 手动点名，或启动有边界的自动多轮讨论 | 每轮回答、Agent 接力关系和运行状态 |
| 最终验收 | 查看结论与运行轨迹，决定是否采用 | 精简后的证据、状态和可追溯结果 |

![Meldwork 多 Agent 产品审查群聊](docs/assets/meldwork-multi-agent-review.png)

主对话只保留对工作有价值的内容；需要追问时，再展开某个 Agent 的执行过程。这样既不会让工具日志淹没结论，也不会只剩一段看似完整、却无法复盘的最终回答。

## 它适合哪些真实工作

- **研究与情报：** 一个 Agent 收集证据，另一个专门寻找证据缺口和错误假设。
- **产品与战略：** 一个完善方案，另一个从用户价值、商业风险和执行成本上进行压力测试。
- **软件开发：** 一个负责实现，另一个审查代码改动、测试覆盖和关键判断。
- **写作与内容：** 一个搭建结构和初稿，另一个检查事实、表达和读者体验。
- **复杂运营：** 不同 Agent 处理各自擅长的部分，但完整任务仍然留在一个地方。

Meldwork 不鼓励为了“看起来智能”而堆叠 Agent。一个 Agent 足够时就直接完成；只有当第二种能力确实能降低错误、返工或决策风险时，才把它加入工作。

## 客户端把这些能力放在一起

- 持续存在的 Agent 单聊与多 Agent 工作群组。
- 明确点名执行、手动接力和自动多轮讨论。
- 在兼容条件下，为每个群组和 Agent 延续原生 Session。
- 可复盘但经过脱敏和压缩的运行轨迹与证据摘要。
- 每个 Agent 独立的 Provider 档案，以及兼容系统下的安全凭据存储。
- Skill、经过验证的图片、音视频、文档、代码、压缩包、授权知识源和按需开启的工作目录访问。
- 会话与编排状态留在本机，不依赖 Meldwork 云账号或远程会话数据库。

模型请求仍然会按照你选择的 Agent 和 Provider 发出。“本地优先”指 Meldwork 自己的工作空间和编排状态留在电脑上，并不意味着第三方模型自动变成离线模型。

## 当前可以连接的 Agent

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code · OpenCodeReview · 自定义 Agent**

每个 Agent 保留自己的能力、Provider、权限模型和 Session 行为。能否使用取决于本机是否安装、版本是否兼容，以及对应认证是否就绪。

## 当前仍是私有 MVP

仓库和 Release 暂时保持 private，直到公开发布门禁完成。目前经过发布验证的目标只有 Apple 芯片 Mac；Windows、Intel Mac、Apple 公证以及所有第三方 Agent 的广泛兼容性还不属于本版本承诺。剩余门禁见 [公开 MVP 发布清单](docs/public-mvp-release.md)。

<details>
<summary><strong>开发者从源码运行</strong></summary>

源码开发需要 Node.js 20.19 或更高版本以及 npm：

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

完整验证命令见 [docs/tests.md](docs/tests.md)。

</details>

## 许可证

Meldwork 社区版采用 [GNU Affero General Public License v3.0 only](LICENSE) 开源。AGPL 允许个人和公司商用、修改与分发，但分发修改版本或通过网络向用户提供修改版本时，需要按照许可证提供对应源代码。

需要闭源分发、嵌入专有产品，或使用单独授权商业版的组织，可以申请商业许可证，详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。第三方标识归属见 [NOTICE](NOTICE)。
