# Meldwork 产品 BP

> 版本：OPC / Open-source-first MVP
>
> 日期：2026-07-31
>
> 用途：项目介绍、开源发布、设计伙伴沟通和后续商业化讨论

## 1. 一句话

**Meldwork 把用户已经在用的本地 Agent 带进一个本地优先、可追溯的工作空间，并逐步演进为连接本地、云端和工作渠道的开放 Agent Harness。**

Current MVP is a local-first desktop workspace for supported Agent CLIs. The Harness, Cloud and Channel capabilities are roadmap directions, not current product claims.

## 2. 品牌与定位

### 工作名

**Meldwork** 继续作为工作名推进。它表达“把分散的工作重新接续起来”，不把产品锁死在 Multi-Agent、Coding 或某一家模型厂商上。

正式公开前仍需完成：商标、域名、社交账号、中文理解测试和软件许可证确认。`RoundRelay`、`MAC-Work` 和 `Open-MACWork` 不作为当前主品牌。

### 当前 MVP Slogan

> **Agents change. Work continues.**
>
> **Agent 可切换，工作不断线。**

这条文案与当前“持久工作空间、Session 延续”的已实现价值一致，适合现阶段 README 和演示。

### 目标产品 Slogan

> **Different agents. Work you can verify.**
>
> **不同 Agent，工作有据可验。**

当 Task、Artifact、Evidence 与 Acceptance 已经形成真实闭环后，再把这条升级为主 Slogan。它的重点不是“Agent 越多越好”，而是：不同 Agent 可以提供独立视角，但最终工作必须经过证据和人类判断。

### 品类描述

> **An open, local-first work system for agents across vendors.**
>
> **面向跨厂商 Agent 的开放、本地优先工作系统。**

### 产品主叙事

Agent 会变，模型会变，入口会变；工作不应该因为换了一个 Agent 就失去上下文、权限边界和复核记录。

## 3. 用户问题

当用户同时使用 Codex、Claude Code、OpenCode、Kimi、MiMo、Qwen 或其他 Agent 时，真实工作通常被拆散：

- 上下文和原生 Session 在不同终端或应用中断裂。
- 用户手工复制任务、文件、限制和前序结果。
- 不同 Agent 的输出难以比较，流畅文本被误认为已经完成。
- 权限、工作目录、Provider 和数据出站缺少统一可见性。
- 结果很难沉淀为可复用的 Artifact、Evidence 和模板。

市场已经有越来越多强 Agent，缺少的是用户可以控制的跨 Agent 工作层。

## 4. 解决方案

### 4.1 当前 MVP

- 发现和管理已支持的本地 Agent CLI。
- 在本地持久保存直接与群组会话。
- 在兼容条件下恢复原生 Agent Session。
- 用明确轮次和时间边界运行有限的多 Agent 讨论。
- 传递 Agent-specific Skill 和受限图片上下文。
- 在 Electron 主进程管理执行、工作目录、Provider 和敏感数据。

### 4.2 目标 Harness

将产品对象从 Conversation 升级为：

```text
Task -> Run -> Artifact -> Evidence -> Human Acceptance
```

Connector 负责把本地、云端、自定义和渠道型 Agent 接入同一套能力声明、Session 生命周期、运行事件、权限、出站和结果回传协议。

## 5. 目标用户

### 首要用户：多 Agent 重度个人用户

他们已经在不同 Agent 之间切换，愿意安装本地软件，且在高风险或复杂任务中需要第二个视角。开源项目的价值是降低他们的迁移、试用和信任成本。

### 次要用户：5-50 人 AI-native 团队

他们需要共享的任务模板、权限策略、Evidence 和兼容性信息，但只有在个人工作闭环成立后才进入产品验证。

### 未来用户：高责任专业团队

安全、架构、研究、咨询和重大迁移团队对可复核工作更敏感，可能成为 Harness 服务的付费客户；目前不宣传为企业生产级产品。

## 6. Why now

1. Agent 正从问答工具进入长任务、工具调用、后台执行和多渠道协作阶段。
2. 上游产品会继续增强自己的多 Agent，但用户仍会同时使用多个厂商和本地 CLI。
3. AI 使用率增长与信任、准确性、隐私和责任问题同时增长。
4. 开源社区需要一个不强迫迁移模型或账号的中立工作层。
5. OPC 的资源限制要求先从可验证的小切口建立分发，而不是先建设重型平台。

## 7. 核心竞争力

### 7.1 跨厂商中立

不绑定某个模型、IDE 或 Cloud。用户可以保留已有账号、Provider 和本地工作方式。

### 7.2 Session Fidelity

连接不是简单转发 Prompt，而是尽可能保留原生 Session、Agent-specific 能力和上下文边界。

### 7.3 Evidence-first 工作流

把对话输出变成 Artifact、Evidence 和 Acceptance，支持复盘、比较、导出和后续采用。

### 7.4 Local Control Plane

工作记录和编排状态默认在本地；Provider、权限、工作目录和数据出站可见。Local-first 不等于所有模型离线。

### 7.5 Open Connector Ecosystem

公开能力 Contract、兼容矩阵、任务模板和贡献路径，让生态贡献成为增长和维护的杠杆。

## 8. 与竞品的关系

Meldwork 不与 Agent、IDE、终端或云执行平台在同一层争夺全部价值：

| 竞品类型 | 他们的优势 | Meldwork 的回答 |
| --- | --- | --- |
| 单厂商 Agent | 模型、工具和原生体验强 | 连接用户已有的多个 Agent |
| AI IDE / Terminal | 入口和编辑体验强 | 不复制 IDE；聚焦跨 Agent 工作连续性 |
| 云端控制面 | 并行、后台和企业治理强 | 先做本地控制面，再按证据接 Cloud |
| 开放 Agent 平台 | 协议、Runtime 和生态广 | 以易安装、真实任务、兼容验证和 OPC 速度切入 |

最大风险是上游会吸收多 Agent 控制面能力。因此产品必须持续保持中立、开放和可迁移，而不是围绕某个供应商做深度锁定。

## 9. 开源优先的 Go-to-Market

### 9.1 发布路径

1. GitHub 公开仓库：清晰的 README、安装说明、许可证、支持矩阵和安全边界。
2. 真实演示：用一个任务展示“实施 Agent + 独立审查 Agent + 人类验收”。
3. 兼容性内容：持续发布 Agent 版本、平台和失败复盘，不只发布 Logo。
4. 社区入口：Issue 模板、Connector/Task Template 贡献指南和公开路线图。
5. 国内外双语传播：GitHub、Bilibili、V2EX、掘金、知乎、X、YouTube、Hacker News、Reddit 等渠道择少而做。

### 9.2 内容策略

内容必须证明一个用户结果，而不是讲抽象 AI 愿景：

- “两个 Agent 审查同一个真实变更，谁发现了什么？”
- “为什么某个 Agent 不能安全地加入这个任务？”
- “一次 Connector 失效是如何被定位和修复的？”
- “本地优先到底保留了什么，哪些数据仍会出网？”
- “一个 OPC 如何在每周 10 小时内维护开源 Agent Harness？”

### 9.3 90 天目标

产品目标优先于曝光目标：

- 15 名外部用户完成真实任务。
- 同一批至少 8 名在首次任务后 30 天内重复使用。
- 至少 1 个外部 Connector 或 Task Template 贡献。
- 形成 20 个有 Acceptance 结果的任务记录。
- 以 Star、Fork、视频播放、Issue、安装和重复任务建立完整漏斗，而不是只追求单一数字。

## 10. 商业模式：延后，但保留选项

### 10.1 开源层

核心桌面客户端、基础本地工作流、Connector 文档和社区适配器免费开放。具体许可证必须在公开发行前单独完成法律审查与选定。

### 10.2 可选收入层

| 收入层 | 可售价值 | 进入条件 |
| --- | --- | --- |
| 支持/培训 | 安装、兼容和工作流辅导 | 问题重复且可形成标准服务包 |
| Pro | 个人模板、比较、导出、更新便利 | 个人用户持续重复使用 |
| Team | 策略、共享模板、Evidence、预算和审计 | 多个团队出现相同需求 |
| Harness / Enterprise | 私有部署、Cloud/Channel、签名 Connector、SLA | 至少 3 个相似付费客户，交付可复用 |

### 10.3 不做的收入

- 不把 Token 加价作为默认商业模式。
- 不在没有标准化边界时承诺定制 Connector 无限支持。
- 不把一次咨询、定制开发或未到账意向写成 ARR。
- 不因为“企业感兴趣”就提前建设完整企业版。

## 11. 投入与资源策略

当前不以融资为项目成立条件。若未来需要外部资金，优先用于：

1. Connector 兼容测试与发布基础设施。
2. Task/Artifact/Evidence 产品闭环。
3. 签名、公证、安装和安全审查。
4. 真实用户研究、评测和设计伙伴。
5. 开源文档、内容和社区运营。

不优先投入：自建模型、重型云平台、销售团队、全量 Agent 适配和复杂多租户。

## 12. 关键质疑

### 只是 Wrapper？

MVP 阶段部分成立。产品必须通过 Session Fidelity、Connector Contract、Evidence、Acceptance 和兼容数据把价值从 UI 包装升级为可复用的执行层。

### 用户为什么不直接用一个强 Agent？

多数任务确实应该只用一个。Meldwork 只服务重要到需要独立审查、不同能力或明确权限控制的工作。

### 开源会被复制？

代码会被复制。难复制的是长期兼容数据、真实任务评测、社区贡献、用户信任和可复用的 Harness 工作方式。如果这些没有建立，项目就不应把自己包装成有护城河的平台。

### 一个 OPC 能做完吗？

不能同时做完所有方向。因此路线以一个主场景、少数 Tier-1 Connector、公开文档和内容反馈为约束；Cloud、Channel、Team 只在证据成熟后推进。

## 13. 成功定义

### 开源成功

别人能安装、完成任务、复现问题、提交贡献，并且项目能持续产生职业与行业影响力。

### 产品成功

同一批用户在 30 天内重复使用跨 Agent 工作闭环，并愿意提供真实 Task、Artifact 和 Evidence 反馈。

### 商业成功

存在 3 个以上相似的标准化付费需求，且支持、兼容或治理能力的边际交付成本可被一个人或小团队承受。

### 应收缩

如果用户只喜欢统一窗口、不重复使用、不愿贡献或付费，多 Agent 质量收益也不稳定，就把项目定位收缩为高质量个人开源工具，不再继续平台化。

## 14. 对外最终叙事

> **Meldwork is the open, local-first harness for work that moves between agents.**
>
> **Meldwork 是面向跨 Agent 工作的开放、本地优先 Harness。**

当前宣传补充：

> **Bring the agents you already use into one accountable workspace.**
>
> **把你已经在用的 Agent 带进一个可追溯的工作空间。**

愿景和当前能力必须分开写。不要在公开页面把 Cloud、任意 Connector、Team Governance 或 Enterprise Security 写成已交付。
