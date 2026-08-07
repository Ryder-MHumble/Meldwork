<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-zh-CN.png" alt="Meldwork：Agent 随时切换，工作始终连续" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# Agent 可以换，工作不该断

**Meldwork 是一个本地优先的 Agent 桌面工作台，用于持续单聊和有边界的多 Agent 复核。每个会话的上下文、权限、附件、兼容的原生 Session 与脱敏运行记录都保存在你的电脑上。**

多数 Agent 已经能够完成一段工作。真正脆弱的是切换工具之后：上下文需要手工复制，文件要重新附加，权限边界容易丢失，最终答案看起来完整，却很难说明它是如何形成的。Meldwork 让任务保持稳定，让 Agent 按需变化。先从一个 Agent 开始；只有当任务需要另一种能力或独立质疑时，再加入第二个 Agent；最后由你检查结果并决定保留什么。

它解决的不是“同时打开更多 AI”，而是让一项复杂工作能够在不同 Agent 之间真正接力：前一个 Agent 留下的结论和证据，后一个可以继续使用；所有人的回答仍然回到同一条任务脉络里，由你决定哪些结果值得接受。

<p align="center">
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/latest"><strong>下载 macOS DMG 安装包</strong></a>
  · <a href="LICENSE">AGPL-3.0 开源许可证</a>
  · <a href="COMMERCIAL_USE.md">商业使用说明</a>
</p>

## 先装客户端，再开始工作

当前桌面客户端面向 Apple 芯片 Mac：

1. 打开 [最新 GitHub Release](https://github.com/Ryder-MHumble/Meldwork/releases/latest)。
2. 下载 `Meldwork-0.1.0-arm64.dmg`。
3. 将 Meldwork 拖入“应用程序”并打开。
4. 连接电脑上已经安装的 Agent CLI，或为某个 Agent 单独配置 Provider。

如果最新 Release 中包含 DMG 文件，就可以直接下载到本地安装。开发者也可以使用下方命令从源码运行。

## 先跑通一个可重复的工作流

首个公开工作流很简单：先产出交付物，再由第二个 Agent 质疑和复核，最后由人决定采用什么。

1. 创建一个只有两个已就绪 Agent 的群组。
2. 只附加任务真正需要的文件；除非任务必须修改工作区，否则保持写入权限关闭。
3. 明确让一个 Agent 形成交付物，让另一个检查假设、遗漏与证据，并限制讨论轮数。
4. 查看最终回答和脱敏运行轨迹，再决定采用、修改或放弃结果。

研究、产品、开发、写作和运营是使用示例，不是几套独立的产品承诺。首发成功的标准，是这条双 Agent 复核闭环能在一台干净的 Apple 芯片 Mac 上稳定完成。


## 打开客户端，看到的是完整工作现场

![Meldwork 工作台总览](frontend/public/logos/meldwork-workspace-overview.png)

单聊、工作群组和最近任务都在同一个桌面工作台里。一个 Agent 足够时使用单聊；需要独立检查时创建群组。Meldwork 当前不会自动合并两个独立会话的历史，因此群组需要的背景和文件仍应由用户明确附加或重述。

## 一项任务如何在 Meldwork 里推进

| 阶段 | 你的操作 | Meldwork 保留下来的内容 |
| --- | --- | --- |
| 先开工 | 选择最合适的 Agent 发起单聊 | 当前任务、对话和原生 Session 延续关系 |
| 再协作 | 创建群组，只选择真正需要参与的 Agent | 群组成员、工作目录和明确的执行权限 |
| 多轮打磨 | 手动点名，或启动有边界的自动多轮讨论 | 每轮回答、Agent 接力关系和运行状态 |
| 最终验收 | 查看结论与运行轨迹，决定是否采用 | 精简后的证据、状态和可追溯结果 |

![Meldwork 多 Agent 产品审查群聊](frontend/public/logos/meldwork-multi-agent-review.png)

主对话只保留对工作有价值的内容；需要追问时，再展开某个 Agent 的执行过程。这样既不会让工具日志淹没结论，也不会只剩一段看似完整、却无法复盘的最终回答。

## 工作空间背后的 Harness

![Meldwork Harness Engine](frontend/public/logos/Harness-readme.png)

Harness 是让 Agent 协作不退化成复制 Prompt 和散落会话的关键层。它统一 Agent 事件，为每个目标构建有边界的上下文，隔离兼容的原生 Session，保存本地 Run 状态，并在认证或兼容性需要用户处理时暴露明确的恢复状态。

- **运行控制：** 明确点名、手动接力、有边界的自动轮次、停止与单 Agent 控制。
- **上下文控制：** 稳定约束、选定文件、按目标分配的 Skill 与知识来源、近期结论和精简证据摘要。
- **可检查的执行过程：** 结论、上下文来源、警告、终态，以及所选 Agent 或传输方式能够提供的计划和工具生命周期摘要。
- **持久本地状态：** 会话与有界 Run 记录在完成或中断后仍可查看；上下文保持持久并可追溯。

## 它适合哪些真实工作

- **研究与情报：** 一个 Agent 建立证据基础，另一个寻找证据缺口与错误假设。
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

Meldwork 当前已支持：

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code**

专项审查：
**OpenCodeReview**

能否实际使用取决于本机安装情况、受支持版本、认证状态和 Agent 声明的能力。OpenCodeReview 是专项审查目标，不作为通用对话 Agent 使用。

每个 Agent 保留自己的能力、Provider、权限模型和 Session 行为。能否使用取决于本机是否安装、版本是否兼容，以及对应认证是否就绪。

## 当前发布范围

首个经过发布验证的目标是 Apple 芯片 Mac。Windows 已具备实现层支持，但广泛的真实设备验证仍未完成；所有第三方 Agent 的广泛兼容性还不属于当前承诺。

<details>
<summary><strong>开发者从源码运行</strong></summary>

源码开发需要 Node.js 20.19 或更高版本以及 npm：

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

分发前请运行仓库测试脚本：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

</details>

## 许可证

Meldwork 社区版采用 [GNU Affero General Public License v3.0 only](LICENSE) 开源。AGPL 允许个人和公司商用、修改与分发，但分发修改版本或通过网络向用户提供修改版本时，需要按照许可证提供对应源代码。

需要闭源分发、嵌入专有产品，或使用单独授权商业版的组织，可以申请商业许可证，详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。第三方标识归属见 [NOTICE](NOTICE)。
