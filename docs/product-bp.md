# Meldwork 产品 BP

> 版本：General Agent + Knowledge / Open-source-first
>
> 日期：2026-08-02
>
> 用途：项目介绍、开源发布、设计伙伴沟通和后续商业化讨论

## 1. 一句话

**Meldwork 把用户已经在用的 Agent 和知识来源带进一个本地优先、可追溯的工作空间，让工作可以跨 Agent 接续，并留下可采用的产物与证据。**

English:

> **Meldwork brings the agents and knowledge you already use into one local, accountable workspace.**

## 2. 产品定位

### 品类

> **An open, local-first work system for agents and knowledge across vendors.**
>
> **面向跨厂商 Agent 与知识来源的开放、本地优先工作系统。**

### 当前 MVP Slogan

> **Agents change. Work continues.**
>
> **Agent 可切换，工作不断线。**

当前产品已经能够连接已支持的本地 Agent、维持工作空间和兼容条件下的原生 Session，并让用户显式选择部分知识来源。这条 Slogan 仍与现阶段价值一致。

### 目标产品承诺

> **Different agents. Context stays. Work can be verified.**
>
> **不同 Agent，上下文不断，结果有据可验。**

只有当 Context Pack、Artifact、Evidence 和 Decision 形成真实闭环后，才应把这条表达用于主宣传。

### 品牌逻辑

Meld 表示不同 Agent 的工作可以接续，但不要求答案被强行融合或达成共识。Work 表示产品处理的是真实任务、产物和决定，而不是闲聊。

品牌标志中的连续线代表工作延续，独立的珊瑚色端点代表结果被检查并由人类采用或拒绝。品牌承诺应落在“连续性 + 可验证结果”，而不是 Agent 数量。

## 3. 用户问题

Agent 能力越来越强，但用户的工作仍然被拆散：

- 不同 Agent 拥有独立 Session、工具、Provider 和权限。
- 上下文散落在本地文件、Obsidian、飞书、钉钉、Notion、Confluence、GitHub 和聊天记录中。
- 用户不断复制任务、约束和前序结果。
- 不同 Agent 的输出难以比较，流畅文本容易被误认为已完成。
- 用户不知道结果具体依据了哪些来源，也无法稳定复验。
- 切换 Agent 后，Artifact、Evidence 和最终 Decision 很难继续。

市场并不缺更多 Agent，缺少的是用户能够掌控的跨 Agent 工作与上下文层。

## 4. 解决方案

Meldwork 的目标闭环：

```text
Agent + Knowledge Source
        -> Context Pack
        -> Task / Run
        -> Artifact / Evidence
        -> Human Decision / Adoption
```

### 4.1 当前 MVP 已实现

- 本地 Electron 桌面工作空间。
- 已支持本地 Agent CLI 的发现、就绪状态和受控运行。
- 直接与群组会话，以及兼容条件下的原生 Session 延续。
- 有界自动讨论、取消、失败状态和本地通知。
- Agent-specific Skill 与受限图片上下文。
- Provider 配置和操作系统安全存储。
- 飞书、钉钉和 Obsidian 的连接状态与只读知识来源选择。

当前知识来源能力是显式访问提示，不是由 Meldwork 执行的统一搜索、索引或 RAG。Notion、Confluence、Google Drive 和 SharePoint 仍是规划入口。

### 4.2 下一阶段核心

- Knowledge Source 与 Context Pack。
- Task、Run、Artifact、Evidence、Decision。
- Primary Agent 产出 + Reviewer Agent 独立复核。
- Agent / Knowledge Connector Contract。
- Evidence Bundle、导出和真实 Adoption 记录。

### 4.3 后续条件能力

- Local / Cloud Agent Handoff。
- GitHub、钉钉、飞书或其他任务型 Channel。
- Typed Workflow、预算和 Human Gate。
- Team 策略、审计和可选同步。

这些属于路线图，不是当前功能承诺。

## 5. 首要用户

### ICP 1：Agent 重度专业用户

产品经理、研究人员、顾问、开发者、安全人员、分析师和创业者中，已经使用多个 Agent 并需要对产物负责的人。

他们购买的不是“更多 Agent”，而是：

- 少复制一次上下文。
- 少遗漏一个关键来源或约束。
- 多一个独立且可追溯的复核视角。
- 把结果直接变成可以继续使用的 Artifact。

### ICP 2：5-50 人 AI-native 团队

团队成员使用不同 Agent 和知识来源，希望复用相同任务、权限、Evidence 和交付规则。只有个人重复使用成立后，才进入共享模板、策略、预算和审计验证。

### ICP 3：未来高责任团队

研究、咨询、安全、合规和重大决策团队对 Evidence 和 Decision 链更敏感，但需要更强隔离、审计和支持。当前只作为设计伙伴，不宣传为生产级企业能力。

## 6. 首发场景

Meldwork 保持 General Agent 定位，但首轮只实现一个通用协议：

```text
Primary Agent produces an Artifact
        -> Reviewer Agent checks constraints and Evidence
        -> Human adopts, rejects or requests revision
```

候选模板：

- 研究与决策核验。
- 方案、PRD、报告或交付物评审。
- 代码与技术审查。

首轮根据真实任务频率选择一个主模板，不同时为三个领域开发独立产品。

## 7. Why now

1. Agent 正从 Coding、Research 或 Chat 工具演化为跨领域执行单元。
2. 用户会长期同时使用全球与中国、开源与专有、本地与云端 Agent。
3. 知识与工作上下文仍然分散在不同平台，换 Agent 就容易失去连续性。
4. 上游平台会快速商品化并行 Agent，但天然优先优化自家生态。
5. AI 使用增长与准确性、隐私、成本和责任问题同步增长。
6. 本地优先和开源可以降低新控制层的信任门槛。

## 8. 核心竞争力

### 8.1 Cross-vendor Neutrality

不绑定某个模型、IDE、知识平台或 Cloud。用户保留已有 Agent、账号、Provider 和知识来源。

### 8.2 Context Portability

Context Pack 记录本次任务实际允许使用的文件、图片、Skill、知识来源、敏感等级和出站范围，使工作换 Agent 后仍可继续。

### 8.3 Session Fidelity

连接不是简单转发 Prompt，而是尽可能保留原生 Session、工具、权限和增量上下文。

### 8.4 Outcome & Evidence Graph

把 Task、Run、Artifact、Evidence、Source 和 Decision 关联起来，使结果可以比较、复验、导出和继续使用。

### 8.5 Local Control Plane

工作状态默认保留在本机，Agent、Provider、知识访问和写入权限在任务层显式可见。Local-first 不等于所有模型离线。

### 8.6 Open Connector Ecosystem

公开 Agent 与 Knowledge Connector 的能力 Manifest、兼容矩阵、事件 Contract 和贡献路径。生态价值来自可复现适配与真实失败数据，不是 Logo 数量。

## 9. 竞争关系

| 竞品类型 | 他们的优势 | Meldwork 的回答 |
| --- | --- | --- |
| 单厂商 Agent | 模型、工具和原生体验强 | 连接用户已有的不同 Agent |
| AI IDE / Terminal | 强入口和编辑执行体验 | 不复制 IDE，聚焦跨 Agent 工作状态 |
| Knowledge Platform | 内容、搜索和组织协作成熟 | 不替代内容平台，只管理任务上下文和来源关系 |
| Cloud Agent Control Plane | 后台执行、并行和企业治理强 | 先做本地控制与可验证 Handoff |
| 开放 Agent Platform | Runtime、协议和生态广 | 以易安装、知识接入、Session 和 Outcome 切入 |

最大风险是上游平台覆盖多 Agent 控制面。因此 Meldwork 必须持续保持跨厂商、可迁移和知识平台中立。

## 10. Go-to-Market

### 10.1 开源发布

1. 提供真实能力矩阵、安装说明、数据边界和故障排查。
2. 用一个真实任务演示“知识上下文 -> Primary Artifact -> Reviewer Finding -> Human Decision”。
3. 持续发布 Connector 兼容报告和失败复盘。
4. 提供 Task Template、Connector 和评测任务的贡献入口。
5. 国内外使用同一产品叙事，但只选择少量渠道持续经营。

### 10.2 内容策略

内容必须展示真实结果：

- 同一份知识上下文交给两个 Agent，差异在哪里。
- Reviewer 找到了什么，用户最终采用了什么。
- 哪些知识来源被允许使用，哪些数据仍会出网。
- 一次 Agent 或 Knowledge Connector 失效如何被诊断。
- 为什么某项任务只需要一个 Agent。

不展示“十个头像轮流说话”或没有 Artifact 的自动讨论 Demo。

### 10.3 90 天目标

- 15 名固定外部用户完成真实 Task。
- 同一批至少 8 名在首次任务后 30 天内重复。
- 至少 20 个 Task 形成 Artifact、Evidence 和 Decision。
- 至少 1 个外部 Connector 或 Task Template 贡献。
- 相对手工跨 Agent，上下文搬运和整理主动时间中位数下降至少 25%。
- 至少 3 个团队对同一标准化试点表达真实采购意愿，回款和定制收入分开记录。

## 11. 商业模式

### Open Core + BYO Agent / BYO Knowledge

| 层级 | 可售价值 | 进入条件 |
| --- | --- | --- |
| Community | 本地核心、基础 Agent/Knowledge 连接、任务协议 | 公开边界和许可证明确 |
| Pro | 高级 Context Pack、比较、导出、模板和更新便利 | 个人用户持续重复使用 |
| Team | 共享策略、Evidence、预算、兼容报告和可选同步 | 多个团队出现同类问题 |
| Enterprise | 私有部署、签名 Connector、审计、离线更新和 SLA | 至少 3 个标准化付费客户 |

不默认对模型 Token 加价。用户已经为 Agent、模型或知识平台付费，Meldwork 应对工作连续性、验证、兼容和治理收费。

## 12. 投入顺序

1. 新用户激活、安装和真实能力边界。
2. Context Pack 与 Task Outcome 闭环。
3. Agent / Knowledge Connector Contract 和兼容测试。
4. Evidence、导出和评测。
5. 一个 Cloud Handoff 或 Channel。
6. Workflow、预算和 Team。

不优先投入：自建模型、重型云平台、完整知识中台、销售团队、全量 Agent 适配和复杂多租户。

## 13. 关键质疑

### “只是 Wrapper。”

MVP 阶段部分成立。只有 Context Pack、Session Fidelity、Connector Contract、Outcome & Evidence Graph 和兼容数据形成闭环后，才具备独立产品层价值。

### “为什么不直接使用一个强 Agent？”

多数任务应该只用一个 Agent。Meldwork 的价值首先是工作和上下文连续性；第二个 Agent 只在风险、证据不足或能力互补时加入。

### “为什么不直接使用知识平台自己的 AI？”

知识平台优先优化自己的内容和 Agent。Meldwork 服务用户跨多个 Agent、文件和知识平台的工作，并保留本地任务与 Decision 记录。

### “General Agent 会不会过于宽泛？”

如果产品按职业建立大量模式，会失去焦点。Meldwork 用统一 Task、Context、Artifact、Evidence 和 Decision 协议保持边界，并只验证一个首发模板。

### “开源会被复制？”

代码可以复制。长期兼容数据、真实任务评测、Connector 社区、用户信任和可复用工作协议更难复制。如果这些没有形成，项目就不应自称拥有平台护城河。

## 14. 成功定义

### 开源成功

别人能安装、完成真实任务、理解数据边界、复现问题并提交有效贡献。

### 产品成功

同一批用户在 30 天内重复完成有 Context Pack、Artifact、Evidence 和 Decision 的 Task。

### 商业成功

至少 3 个团队为同一标准化能力付费，且支持和兼容成本可以由小团队承受。

### 应收缩

若用户只喜欢统一窗口、不重复使用，或多 Agent 价值不成立，则保留单 Agent + Knowledge + Outcome 的个人开源工具，不继续建设平台。

## 15. 最终叙事

> **Agents will change. Knowledge will live in different places. Work still needs continuity and proof.**

Meldwork 不试图成为另一个万能 Agent，也不取代用户的知识平台。它要成为 Agent 和知识来源之间的本地工作层，让任务能够接续、结果能够复验、决定能够留下。
