# Meldwork 市场与用户调研说明书

> 版本：General Agent + Knowledge 战略版
>
> 日期：2026-08-02
>
> 状态：战略工作稿；外部价格、竞品能力和法律结论在公开发布前需要刷新

## 0. 结论先行

### 0.1 值不值得继续做

**值得继续做，但不能继续把 Meldwork 定义为本地 Agent 聚合聊天器，也不应把产品重新锁死在 Coding Agent。**

更合理的产品方向是：

> **面向 General Agent 与用户已有知识来源的开放、本地优先工作系统。**

用户真正需要的不是更多聊天入口，而是让一项工作在不同 Agent、知识来源和人之间接续时，仍然保留：

- 被批准使用的上下文。
- 原生 Session 和 Agent 能力。
- 清晰的权限与数据出站边界。
- 可继续使用的 Artifact。
- 支持或反驳结果的 Evidence。
- 人类最终采用、拒绝或修改的 Decision。

因此，Meldwork 的核心闭环应从：

```text
Conversation -> More Agents -> More Messages
```

升级为：

```text
Agent + Knowledge Source
        -> Context Pack
        -> Task / Run
        -> Artifact / Evidence
        -> Decision / Adoption
```

### 0.2 这不是“什么 Agent 都能接”的宽泛平台

General Agent 表示产品不按 Coding、Research、PM 或 Operations 把 Agent 人为分割成不同品类；它不表示所有 Agent 拥有相同能力，也不表示 Meldwork 可以无条件接入任何 Agent。

每个 Agent 和 Knowledge Connector 都必须声明：

- 能做什么和不能做什么。
- 支持哪些输入、Session 和工具。
- 是否可读、可写、可联网和可取消。
- 哪些运行事件、Artifact、Evidence 和费用可以观测。
- 数据会流向哪里。

产品卖点应是“开放且可验证的连接”，不是“无限兼容”。

### 0.3 当前最有价值的新机会

当前仓库已经开始支持飞书、钉钉和 Obsidian 等知识来源。虽然现阶段只是经过验证的只读访问提示，而不是完整 RAG 或索引引擎，但它使 Meldwork 有机会形成比“多 Agent 控制面”更清晰的差异：

> **把用户已经拥有的 Agent 和知识上下文带进同一个可追溯工作空间。**

这条方向覆盖代码、研究、产品、咨询、规划、安全和运营等工作，不依赖某个 Agent 厂商，也不要求 Meldwork 自建模型。

### 0.4 投入判断

建议采用双层策略：

| 层次 | 当前目标 | 决策 |
| --- | --- | --- |
| 开源项目 | 可安装、可理解、可完成真实任务、可贡献 | 立即投入 |
| 产品验证 | 证明 Context-grounded Outcome 是否产生重复价值 | 立即投入，但只做一个主协议 |
| 平台扩张 | Cloud、Channel、Workflow、Team | 由重复使用和回款触发 |

不建议现在同时建设企业平台、云执行、多个 IM Channel、完整知识中台和大量 Connector。

## 1. 研究边界

### 1.1 已有证据

- `/Users/rydersun/Desktop/Meldwork Strategy` 中的市场、路线图和 BP 材料。
- 当前仓库对本地 Agent、Session、Provider、Skill、图片和知识来源的实现。
- 既有市场研究中关于 Agent 使用、AI 信任、控制面竞争和开源生态的公开资料。

### 1.2 尚未成立的事实

当前没有足够证据证明：

- 用户会为跨厂商 Agent 工作层单独付费。
- 多 Agent 在多数任务上稳定优于一个强 Agent。
- 用户需要 Meldwork 自建知识索引，而不是让 Agent 读取已有来源。
- 团队愿意把工作状态交给一个新的控制面。
- 开放 Connector 会自动形成网络效应。

这些均应作为需要真实任务、留存和回款验证的假设。

## 2. 市场正在发生什么

### 2.1 Agent 正从工具变成可替换执行单元

Codex、Claude Code、Hermes、OpenClaw、Kimi、MiMo、Qwen 等产品正在同时扩展研究、文件、工具、浏览器、代码、自动化和渠道能力。Coding Agent 与 General Agent 的边界正在变模糊。

这意味着：

1. 用户会长期同时使用多个能力不同的 Agent。
2. 单个 Agent 的品牌和能力会频繁变化。
3. 独立产品不能把 Agent 数量或聊天 UI 当作壁垒。
4. 更稳定的价值位于上下文、工作状态、权限、Evidence 和 Adoption。

### 2.2 知识上下文仍然碎片化

用户的真实上下文散落在本地文件、Obsidian、飞书、钉钉、Notion、Confluence、Google Drive、SharePoint、GitHub 和各种聊天记录中。

现有 Agent 往往通过各自插件、MCP、CLI、粘贴或索引方案读取这些内容，导致：

- 用户反复解释哪些来源可以用。
- 不同 Agent 获得的上下文范围不一致。
- 输出很难说明依据了哪些内容。
- 权限和数据出站由多个工具分别管理。
- 换 Agent 后，任务状态和决策链再次丢失。

Meldwork 不需要立即复制所有知识平台，而应先成为“本次任务允许使用哪些上下文”的本地控制层。

### 2.3 多 Agent 是按风险升级的能力

多数普通任务一个 Agent 足够。第二个 Agent 只有在以下情况下更可能产生净价值：

- 错误成本高，需要独立 Reviewer。
- 任务不确定，需要相互独立的方案。
- 不同 Agent 具备明显互补的工具或知识访问能力。
- 产物需要事实、约束或合规复核。

因此，产品默认行为应是一个 Agent 完成任务，并在风险、证据不足或用户主动选择时增加第二个 Agent。

### 2.4 控制面能力会商品化

GitHub Agent HQ、Cursor、Warp、OpenHands、Cline 和各家原生 Agent 都在增加并行运行、任务列表、团队协作和渠道入口。

Meldwork 不能只争夺“控制多个 Agent”这个功能，而应占据更具体的位置：

- 跨厂商而非单厂商。
- 本地控制而非强制云账户。
- 连接用户已有 Agent 与知识来源。
- 以 Artifact、Evidence 和 Decision 记录真实工作结果。

## 3. 市场位置

| 市场层 | 用户购买的结果 | Meldwork 的关系 |
| --- | --- | --- |
| Agent / 模型 | 推理、工具调用和执行能力 | 连接供给，不与其竞争 |
| IDE / Terminal | 在开发环境完成工作 | 不复制完整 IDE 或终端 |
| Knowledge Platform | 存储、搜索和协作文档 | 连接来源，不替代其内容系统 |
| Cloud Agent | 后台运行和远程交付 | 条件阶段 Connector |
| Agent Control Plane | 并行、状态、策略和审计 | 主要竞争层 |
| Work Channel | 在 GitHub、钉钉、飞书、Slack 等地派发工作 | 条件阶段入口 |

建议品类：

> **Open, local-first work system for agents and knowledge across vendors.**

不建议定位为：AI IDE、通用聊天应用、知识库 SaaS、模型聚合器、无限自治集群或企业 IM。

## 4. 目标用户与 Jobs to Be Done

### 4.1 首要用户：高频使用 Agent 的专业知识工作者

这类用户可能是产品经理、研究人员、顾问、开发者、安全人员、分析师或创业者。共同特征不是职业名称，而是：

- 已使用两个或以上 Agent，或频繁在 Agent 与知识来源之间切换。
- 处理有明确产物、来源和判断责任的工作。
- 愿意理解工作目录、知识授权和 Provider 边界。
- 不希望把全部工作状态迁移到单一厂商平台。

核心 Job：

> 当一项工作重要到不能只依赖一个 Agent 或一段记忆时，我希望把被批准的知识上下文交给合适的 Agent，让另一个 Agent 独立复核，并保留可以追溯和继续使用的结果。

### 4.2 第二用户：5-50 人 AI-native 团队

核心 Job：

> 当团队成员使用不同 Agent 和知识来源时，我希望复用同一套任务、上下文、权限、Evidence 和交付规则，而不是依赖每个人的私人 Prompt 和工具习惯。

只有个人闭环形成重复使用后，才验证共享模板、策略、审计和预算。

### 4.3 未来用户：高责任团队

研究、咨询、安全、合规、架构和重大决策场景更需要证据与复核，但也要求更强的隔离、审计和支持。当前只适合作为设计伙伴，不应宣传为生产级企业方案。

### 4.4 暂不优先

- 只需要单次聊天或低价模型切换的消费者。
- 期待无人值守自动赚钱的泛自动化用户。
- 需要完整 IDE、企业知识中台或大规模云 Runtime 的客户。
- 要求 Meldwork 自动读取所有个人和企业知识而不做显式授权的用户。

## 5. 痛点优先级

| 优先级 | 痛点 | 用户损失 | 产品机会 |
| --- | --- | --- | --- |
| P0 | Agent、Session、文件和知识来源割裂 | 重复解释、遗漏约束、无法继续 | Workspace + Context Pack |
| P0 | 不知道结果依据了什么 | 错误进入决策和交付 | Source Usage + Evidence |
| P0 | 多 Agent 输出难以比较和采用 | 手工整理、责任不清 | Artifact + Decision |
| P0 | 权限与数据出站不透明 | 隐私、安全和误写入风险 | Local Control Plane |
| P1 | Agent 和知识连接随版本失效 | 激活失败、维护成本高 | Connector Contract + Compatibility |
| P1 | 有效工作方式无法复用 | 每次重新写 Prompt | Typed Task / Workflow Template |
| P2 | 本地与 Cloud Agent 无法连续交接 | 长任务中断 | Local / Cloud Handoff |
| P2 | 工作不能从现有渠道进入 | 额外切换入口 | Channel Connector |

## 6. 核心竞争力

### 6.1 Context Portability

用 Context Pack 明确记录一项任务实际使用的文件、图片、Skill、知识来源、权限和出站范围，使工作换 Agent 后仍能继续。

### 6.2 Session Fidelity

尽可能保留不同 Agent 的原生 Session、能力和增量上下文，而不是把所有连接降级为无状态模型 API。

### 6.3 Outcome & Evidence Graph

建立 Task、Run、Artifact、Evidence、Source 和 Decision 的关系，使用户可以回答：谁在什么条件下，基于什么上下文，产生了什么结果，最后为何被采用。

### 6.4 Local Control Plane

工作状态与编排记录默认留在本机；Agent 和 Provider 是否联网、访问哪些知识来源、获得什么写入能力，都应在任务层可见。

### 6.5 Open Connector Ecosystem

对 Agent 和 Knowledge Source 使用明确的能力 Manifest、事件 Contract、兼容矩阵和贡献流程。生态价值来自可复现适配和真实失败数据，而不是 Logo 数量。

### 6.6 Routing Intelligence

只有在用户单独同意后，才贡献不含 Prompt、原文和 Artifact 的最小派生数据，例如任务类型、Connector 版本、结果评分、时间区间和采用标签。若授权样本不足，路由建议应保持为本地私有能力，不宣传成网络效应。

## 7. 首发验证协议

Meldwork 需要保持 General Agent 定位，但首轮不能验证所有场景。建议用一个协议覆盖多个职业：

```text
Primary Agent produces an Artifact
        -> Reviewer Agent checks constraints and Evidence
        -> Human adopts, rejects or requests revision
```

先收集 10-15 个探索任务，再从以下模板中选择痛点最稳定的一类作为主样本：

- 研究与决策核验。
- 方案与交付物评审。
- 代码与技术审查。

首轮不把三类任务混合成一个质量结论，只共享产品协议和数据模型。

## 8. 12 周验证计划

### 8.1 需求验证

- 访谈至少 20 名已使用 Agent 的专业用户，覆盖研究/产品与技术工作。
- 只讨论过去两周的真实任务，不询问抽象偏好。
- 记录上下文搬运、来源确认、手工复核、失败损失和当前工具预算。
- 第 6 周前固定最先完成真实 Task 的 15 名用户 cohort。

### 8.2 产品验证

- 至少完成 30 个真实 Task，其中前 10 个用于发现流程，后 20 个按冻结模板验证。
- 每个任务记录 Context Pack、Primary Artifact、Reviewer Finding、Evidence 和 Decision。
- 至少 8/15 固定用户在首次任务后 30 天内再次完成一个真实 Task。
- 相对用户当前手工工作方式，上下文搬运和结果整理主动时间中位数下降至少 25%。
- Reviewer 新增 Finding 需要记录被采用、修复或拒绝及其原因。

### 8.3 生态与商业信号

- 至少 1 个外部 Connector 或 Task Template 贡献。
- 至少 3 个团队愿意使用同一标准化试点边界；实际回款与定制服务分开记录。
- Star、曝光、候补名单和 LOI 仅作为辅助信号。

## 9. Go / Pivot / Stop

### Go

- 首次任务可以独立完成。
- 15 名固定用户中至少 8 名在 30 天内重复。
- 至少 20 个 Task 形成 Artifact、Evidence 和 Decision。
- 用户主动协调时间明显下降，Reviewer 产生可采用的新价值。
- 出现外部贡献或标准化付费信号。

### Pivot

- 用户需要单 Agent + Knowledge + Outcome，但多 Agent 价值弱：聚焦本地 Agent 工作台和 Evidence，不强推协作。
- 知识访问是主要价值：强化 Context Pack 和 Source Connector，延后 Cloud Agent。
- 技术用户重复使用而非技术用户不成立：保留 General Agent 架构，但收窄首发市场。

### Stop / 收缩

- 用户只喜欢统一界面，不会再次完成真实任务。
- 维护 Connector 的时间长期超过用户价值开发。
- 多 Agent 增加的成本和整合负担大于新增价值。
- 只有定制开发和咨询收入，没有标准化需求。

## 10. 开源与商业化

开源仍是当前最合理的信任和分发方式，但不能把“开源”当作价值验证本身。

收入选项按证据逐步开放：

| 阶段 | 可售价值 | 进入条件 |
| --- | --- | --- |
| Community | 本地核心、基础 Agent/Knowledge 连接、任务协议 | 公开边界和许可证明确 |
| Pro | 高级 Context Pack、比较、导出、模板和更新便利 | 个人用户持续重复使用 |
| Team | 共享模板、策略、预算、Evidence 和兼容报告 | 多个团队出现同类需求 |
| Enterprise | 私有部署、签名 Connector、审计、离线更新和 SLA | 3 个以上标准化付费客户 |

不默认对模型 Token 加价，不提前承诺无限定制 Connector。

## 11. 最终判断

Meldwork 最值得做的不是“所有 Agent 的客户端”，而是：

> **一个让 Agent、知识上下文和可验证结果持续接续的本地工作系统。**

这条路径比 Coding Agent 聚合更宽，但比通用 Agent 平台更具体。它允许代码、研究、产品和运营共享同一工作协议，同时用 Context Pack、Artifact、Evidence 和 Decision 保持产品边界。

## 12. 参考来源

以下来源延续上一版调研，正式发布前需重新核验价格、产品状态和日期：

- [Stack Overflow 2025 AI Survey](https://survey.stackoverflow.co/2025/ai)
- [METR: Early-2025 AI and experienced developers](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- [GitHub Agent HQ](https://github.blog/news-insights/product-news/welcome-home-agents/)
- [Cursor Cloud Agents](https://cursor.com/blog/cloud-agents)
- [Warp Oz](https://www.warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents)
- [OpenHands](https://www.openhands.dev/)
- [OpenAI Codex](https://developers.openai.com/codex/)
- [Cline](https://github.com/cline/cline)
- [Factory](https://www.factory.ai/)
- [Devin](https://devin.ai/)
