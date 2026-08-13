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
  <a href="https://github.com/Ryder-MHumble/Meldwork/releases/download/Meldwork-V1.0.1/Meldwork-0.1.1-arm64.dmg"><strong>下载 macOS DMG 安装包</strong></a>
  · <a href="LICENSE">非商用源码许可</a>
  · <a href="COMMERCIAL_USE.md">商业授权说明</a>
</p>

## 先装客户端，再开始工作

当前桌面客户端面向 Apple 芯片 Mac：

1. 打开 [最新 GitHub Release](https://github.com/Ryder-MHumble/Meldwork/releases/tag/Meldwork-V1.0.1)。
2. 下载 `Meldwork-0.1.1-arm64.dmg`。
3. 将 Meldwork 拖入“应用程序”，然后先尝试打开一次。
4. 当前预览版尚未经过 Apple 公证。如果 macOS 阻止启动，请打开“系统设置 → 隐私与安全性”，向下滚动到“安全性”，在 Meldwork 提示旁点击“仍要打开”，再确认“打开”。“仍要打开”只会在首次启动被拦截后出现。请只使用从上方官方 Release 下载的 DMG。
5. 连接电脑上已经安装的 Agent CLI，或为某个 Agent 单独配置 Provider。

如果最新 Release 中包含 DMG 文件，就可以直接下载到本地安装。开发者也可以使用下方命令从源码运行。

## 三个核心工作现场

| 本地 Agent 检测 | 单聊中的多模态产物 | 指定 Agent 的群聊复核 |
| --- | --- | --- |
| [![Meldwork 正在检测本地 Agent CLI](assets/meldwork-agent-discovery.png)](assets/meldwork-agent-discovery.png) | [![Agent 在单聊中返回图片、音频和文档产物](assets/meldwork-direct-multimodal.png)](assets/meldwork-direct-multimodal.png) | [![多个指定 Agent 在群聊中分别回复](assets/meldwork-multi-agent-review.png)](assets/meldwork-multi-agent-review.png) |
| 检测受支持的 Agent CLI，用明确的启动动画表达“正在准备”，而不是制造报错感。 | Prompt、生成媒体、文件、权限和兼容的原生 Session 都留在同一条单聊中。 | 只让用户点名的 Agent 参与，并可单独查看或收起每个 Agent 的回复。 |

单击任意截图可以查看完整尺寸。

## Meldwork 当前已经具备的能力

- **统一管理本地 Agent：** 检测受支持的 CLI 安装和就绪状态，也允许用户引入经过批准、支持 CLI 控制的 Custom Agent，同时不向渲染层开放任意 Shell。
- **让单聊持续存在：** 每条单聊保留本地历史、附件、权限模式、兼容的原生 Session 和经过脱敏的执行详情。
- **让多模态文件双向流动：** 用户可以粘贴或附加经过验证的图片、文档、代码、压缩包、音频和视频；受支持的 Agent 与 Provider 也可以把可本地预览的媒体和生成文件返回到同一条会话。
- **明确控制群聊参与者：** 点名真正需要的 Agent，运行单轮回复或有边界的自动讨论，停止指定 Agent，单独收起回复，并查看重新生成后的回答版本。
- **让执行过程可检查、可恢复：** 有界运行事件、精简证据摘要、检查点、完成状态和恢复操作会被保留下来，同时避免暴露凭据、可执行路径或私有推理。
- **把控制权留在本机：** 会话和编排状态保存在电脑上；兼容环境使用操作系统安全存储保存凭据；工作目录写入必须由用户主动开启。

具体能力仍取决于所选 Agent、本机版本、认证状态、Provider，以及该 Agent 声明的附件和工具支持。

## 一条实际可用的复核流程

1. 先用最适合产出初稿的 Agent 发起单聊。
2. 只附加任务真正需要的上下文；只有任务必须修改文件时才开启工作目录写入。
3. 当任务需要另一种能力或独立质疑时，再转入群聊，并且只选择真正需要参与的 Agent。
4. 对照最终回答、生成产物、回答版本和脱敏运行详情，再决定采用什么。

Meldwork 不会在用户不知情的情况下合并无关会话。哪些文件、结论、Skill 和授权知识源可以进入下一项任务，始终由用户决定。

## 工作空间背后的 Harness

![Meldwork Harness Engine](frontend/public/logos/Harness-readme.png)

Harness 是让 Agent 协作不退化成复制 Prompt 和散落会话的关键层。它统一 Agent 事件，为每个目标构建有边界的上下文，隔离兼容的原生 Session，保存本地 Run 状态，并在认证或兼容性需要用户处理时暴露明确的恢复状态。

- **运行控制：** 明确点名、手动接力、有边界的自动轮次、停止与单 Agent 控制。
- **上下文控制：** 稳定约束、选定文件、按目标分配的 Skill 与知识来源、近期结论和精简证据摘要。
- **可检查的执行过程：** 结论、上下文来源、警告、终态，以及所选 Agent 或传输方式能够提供的计划和工具生命周期摘要。
- **持久本地状态：** 会话与有界 Run 记录在完成或中断后仍可查看；上下文保持持久并可追溯。

## 适合放进哪些工作流

| 工作类型 | 第一个 Agent | 独立复核 |
| --- | --- | --- |
| 研究与情报 | 建立证据基础 | 检查无证据结论和缺失来源 |
| 产品与战略 | 形成方案与决策模型 | 压测用户价值、可行性和高成本失败点 |
| 软件开发 | 实现并验证改动 | 审查 Diff、测试、安全边界和回归风险 |
| 写作与运营 | 形成交付物 | 检查结构、准确性、语气和执行风险 |

目标不是堆叠尽可能多的 Agent。一个 Agent 足够时就直接完成；只有当另一种能力或独立复核能明显提高结果质量时，再加入第二个 Agent。模型请求仍然会按照你选择的 Agent 和 Provider 发出；“本地优先”描述的是 Meldwork 的工作空间和编排状态，而不是第三方模型的部署方式。

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

Meldwork 采用 [Meldwork 非商用源码许可](LICENSE)。你可以为个人学习、研究、评估、安全审查等非商用目的查看、运行、修改和分享本项目，但未经版权所有者事先书面许可，不得用于商业目的。

商业使用包括转售、付费托管、托管服务、咨询或外包交付、闭源嵌入，以及由营利组织或为营利组织开展的业务使用。需要商用、集成、分发或单独商业许可，请先查看 [COMMERCIAL_USE.md](COMMERCIAL_USE.md) 并取得授权。第三方标识归属见 [NOTICE](NOTICE)。
