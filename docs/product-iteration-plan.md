# Meldwork 产品迭代规划说明书

> 版本：General Agent + Knowledge + Outcome
>
> 日期：2026-08-02
>
> 适用范围：产品、工程、开源、内容和用户验证

## 0. 路线结论

Meldwork 后续不应继续沿着“增加 Agent 数量”和“强化群聊效果”迭代，也不应重新收窄为 Coding Agent 控制台。

建议主线是：

```text
Agent / Knowledge Source
        -> Context Pack
        -> Task / Run
        -> Artifact / Evidence
        -> Decision / Adoption
        -> Reusable Workflow / Connector
```

产品要解决的不是“让更多 Agent 同时说话”，而是让一项工作在 Agent、知识来源和人之间流转时，不丢失上下文、权限边界、产物和验证记录。

阶段性取舍：

1. 保持 General Agent 定位，但只验证一个通用工作协议。
2. 默认使用一个 Agent，只有高风险、低确定性或需要独立观点时才增加 Reviewer Agent。
3. 先完成本地 Task 和 Outcome 闭环，再决定 Cloud、Channel、Team 是否值得投入。
4. 知识源先做显式授权和可追溯上下文，不提前建设重型 RAG、向量数据库或企业知识中台。

## 1. 当前事实基线

### 1.1 已具备

- Electron 本地优先桌面应用。
- 已支持本地 Agent CLI 的发现、就绪状态和受控调用。
- 直接会话、群组会话和兼容条件下的原生 Agent Session 延续。
- 有界自动讨论、运行状态、失败状态和停止能力。
- Agent-specific Skill 与受限图片上下文。
- Provider 配置、操作系统安全存储和窄 Preload API。
- 飞书文档、钉钉文档和 Obsidian 的本地连接状态与只读任务上下文选择。
- Notion、Confluence、Google Drive 和 SharePoint 的规划入口，但尚未提供可用 Connector。

### 1.2 知识源能力的真实边界

当前能力是把用户明确选择、经过主进程验证的知识源访问方式作为只读提示交给目标 Agent：

- 飞书和钉钉通过本机已配置 CLI 连接。
- Obsidian 通过用户选择的本地 Vault 目录连接。
- Agent 被要求在相关时使用知识源、说明所用来源并避免修改源内容。

当前尚未实现：

- Meldwork 自己检索、索引或缓存知识库内容。
- 统一的引用片段、内容快照、版本哈希或权限快照。
- 确定性 RAG、跨知识库搜索排序或引用完整性校验。
- Notion、Confluence、Google Drive 和 SharePoint 的真实连接与授权。

因此近期对外应使用“Knowledge Sources / 知识来源”和“显式上下文访问”，不应宣传成完整知识库引擎。

### 1.3 最大结构缺口

当前持久化中心仍然是 Conversation。它能回答 Agent 说了什么，但不能稳定回答：

- 用户真正要完成的 Task 是什么。
- 哪些知识来源和上下文被允许用于这次任务。
- 哪次 Run 产生了哪个 Artifact。
- 哪些 Evidence 支持或反驳结果。
- 用户最终采用、拒绝或修改了什么。

## 2. 目标产品模型

### 2.1 Workspace

本地信任与工作边界，包含工作目录、Agent、知识来源、Provider、权限默认值和本地数据策略。

### 2.2 Knowledge Source

可被任务显式授权的输入来源，例如本地 Vault、文档 CLI、未来的 OAuth Connector 或用户选定文件。

每个 Knowledge Source 必须声明：

- 访问方式与就绪状态。
- 可读、可写和网络边界。
- 数据所在位置或服务区域的可见说明。
- 最后验证时间和已知限制。

### 2.3 Context Pack

一次 Task 实际使用的上下文集合，而不是整个知识库的永久镜像。至少记录：

- 用户输入、选定文件、图片和 Skill。
- 被授权的 Knowledge Source。
- 目标 Agent 和可见范围。
- 创建时间、版本和可复验引用。
- 敏感等级与允许出站范围。

Knowledge Source 是潜在输入，Context Pack 是本次任务被批准使用的输入。两者都不等于 Evidence。

### 2.4 Task

一个有目标、有约束、有验收标准的工作单元。Task 至少包含：目标、背景、Context Pack、预期 Artifact、验收标准、风险级别、预算和是否允许多 Agent。

建议状态：

```text
Draft -> Ready -> Running -> Needs review -> Adopted / Rejected / Blocked
                                             -> Reopened / Rolled back
```

### 2.5 Run

一次具体执行，记录 Agent、Connector 版本、Provider/模型标识、原生 Session 引用、权限模式、输入快照、状态、耗时和失败原因。

### 2.6 Artifact

用户可以继续使用的产物：文档、研究结论、方案、代码变更、清单、结构化数据、图片、链接或导出包。

### 2.7 Evidence

支持或反驳 Artifact 的证据：来源引用、文件位置、测试、命令结果、差异、截图、Reviewer Finding 和人类判断。

Evidence 必须区分：

- Declared：Agent 自称已经验证。
- Observed：Meldwork 捕获到结果或引用。
- Reproduced：用户或另一个 Agent 成功复验。
- Human accepted：人类确认该证据足以支持决策。

### 2.8 Decision 与 Adoption

Acceptance 不能只是点击“接受”。需要记录：

- 接受、拒绝、要求修改或选择另一个方案。
- Artifact 被 Apply、Commit、Export、发送或用于哪项后续决定。
- 采用后的测试、复核或结果反馈。

只有 Artifact 被实际使用，并完成与任务验收标准匹配的复验，才计入产品北极星。

## 3. 首发工作协议

首发不按 Coding、Research 或 PM 分裂三套产品，而是实现一个可复用协议：

```text
Create Task
  -> Select Context Pack
  -> Primary Agent produces Artifact
  -> Reviewer Agent checks Artifact and Evidence
  -> Human adopts, rejects or requests revision
```

可以用三类模板验证，但首轮只能选择一个作为主样本：

1. 研究与决策核验：基于文档来源形成结论，再由另一个 Agent 检查证据和遗漏。
2. 方案与交付物评审：主 Agent 生成 PRD、方案、报告或演示结构，Reviewer 检查约束、冲突和可执行性。
3. 代码与技术审查：实施 Agent 产出变更，Reviewer 检查缺陷、测试和风险。

这三类任务共享相同对象和指标。产品不为每个领域建立独立聊天模式。

## 4. Outcome Roadmap

### Phase 0：可信激活，0-4 周

**目标结果：** 新用户能理解边界，并在 10 分钟内用一个 Agent 完成第一项真实工作。

最小交付：

- Agent 与 Knowledge Source readiness 的清晰状态和修复提示。
- 当前支持矩阵、访问边界和最后验证日期。
- 首次任务引导，不要求用户先创建群组。
- 一个 Agent + 可选知识来源的真实任务演示。
- 安装、失败诊断和数据出站说明。

验证：

- 5 名新用户不依赖现场解释完成安装和首个任务。
- 首次任务失败能归因到安装、登录、权限、Connector 或任务输入。
- README、应用状态和代码能力一致。

### Phase 1：Context Pack + Task Outcome，4-10 周

**目标结果：** 用户能把一次 Agent 工作变成可复盘、可采用的结果，而不是一段聊天记录。

最小交付：

- Task、Context Pack、Run、Artifact、Evidence、Decision 的本地最小模型。
- 一个 Primary + Reviewer 工作协议。
- Reviewer 默认只看到 Artifact、验收标准和声明过的 Evidence，不默认读取 Primary 的完整对话。
- Artifact 导出、接受、拒绝、要求修改和 Reopen。
- 来源和 Evidence 的人工校正入口。

验证：

- 至少 20 个任务能回答“用了什么上下文、谁产生了什么、为什么采用”。
- 80% 的测试用户不需要手工整理聊天内容就能导出或采用 Artifact。
- 任何 Verified 状态都能追溯到具体 Evidence。

### Phase 2：Connector Contract + Evidence Graph，10-16 周

**目标结果：** 新 Agent 和知识来源可以通过稳定能力协议加入，且结果关系能够被搜索和复验。

最小交付：

- Agent Connector Manifest：能力、Session、权限、事件、成本和出站声明。
- Knowledge Connector Manifest：访问方式、范围、引用、快照能力和限制。
- 统一 Run Event：Started、Progress、Permission、SourceUsed、Artifact、Evidence、Usage、Completed/Failed/Cancelled。
- Artifact、Evidence、Source 和 Decision 的关系图。
- 可导出的 Evidence Bundle 和诊断包。

验证：

- 用第二种实现验证 Contract 边界，而不是继续硬编码核心业务。
- 至少一个外部 Connector 或 Task Template 贡献。
- Connector 失败不会造成静默丢失或错误的“已完成”。

### Phase 3：Local / Cloud Handoff 与一个 Channel，4-8 个月，条件阶段

**进入条件：** 15 名固定用户中至少 8 名在 30 天内重复使用，并有 3 个以上重复的后台执行或外部渠道需求。

候选能力：

- 本地 Context Pack 的出站预览与用户批准。
- 一个 Cloud Agent 的创建、取消、状态和 Artifact 回传。
- 优先接一个任务型 Channel。开发者样本优先 GitHub Issue/PR；知识工作样本优先钉钉或飞书。
- Channel 只承载 Task、待验收结果和有效上下文，不复制完整 IM。

### Phase 4：Typed Workflow、预算和停止条件，8-12 个月，条件阶段

**进入条件：** 同一工作协议被至少 5 名用户重复执行，且手工步骤稳定。

候选能力：

- 有类型的输入、输出和 Evidence 要求。
- Reviewer、重试、停止条件和 Human Gate。
- Task、Workspace 和 Channel 预算。
- Observed / Estimated / Unavailable 三态成本。
- Workflow 版本、运行历史和失败恢复。

### Phase 5：Team 与企业治理，12 个月后，条件阶段

**进入条件：** 至少 3 个团队对同一标准化能力实际付费，且不是定制 Connector 或咨询收入。

候选能力：

- 可选加密同步与纯本地模式并存。
- 共享模板、策略、RBAC、审计和预算。
- SSO/SCIM、签名 Connector Registry、离线更新和兼容 SLA。

## 5. UI / UX 方向

### 5.1 导航从聊天转向工作状态

左侧导航优先级：

1. Inbox：需要授权、补充输入或验收的事项。
2. Active Tasks：进行中、待复核、失败和待重试。
3. Workspaces / Channels：持续主题和工作边界。
4. Conversations：Task 内的交互记录。
5. Agents / Knowledge Sources：连接与能力状态。

### 5.2 Task 工作台

首屏必须回答：

- 目标和验收标准是什么。
- 哪些 Context 被允许使用。
- 哪些 Run 已完成或失败。
- 当前 Artifact 和 Evidence 是什么。
- 用户下一步需要采用、修改、授权还是重试。

完整聊天流水作为辅助视图，不应占据默认主界面。

### 5.3 多 Agent 对照

- 使用相同 Context Pack 的独立 Attempt。
- Artifact 差异、证据覆盖和冲突高亮。
- 时间、成本和失败状态明确显示。
- 不用 Agent 卡片墙代替可比较的信息结构。

### 5.4 通知

只通知需要人类行动的事件：权限请求、缺少输入、结果待验收、预算风险、Run 失败和 Connector 退化。

## 6. 指标体系

### 6.1 北极星

**每周被用户实际采用并完成验证的任务产出数。**

同时披露：创建 Task 数、Adopted Task 数、失败激活用户数和每个安装 cohort 的人均值。不得只统计多 Agent Task，以免诱导不必要的 Agent 数量增长。

### 6.2 当前 OMTM

**固定首批用户的 30 天重复 Outcome 率。**

第 6 周前固定最先完成真实 Task 的 15 名用户，要求至少 8 名在各自首次任务后的 30 天内再次完成一个有 Artifact、Evidence 和 Decision 的 Task。

### 6.3 价值指标

- 首次 Task 完成率和完成时间。
- Context Pack 被实际使用和校正的比例。
- Artifact 被采用、导出或继续使用的比例。
- Reviewer 新增有效 Finding 的采用率和误报率。
- 相对手工跨 Agent 的上下文搬运与协调时间。
- 单 Agent 与多 Agent 的质量、等待和成本差异。

### 6.4 可靠性指标

- Agent Session resume 成功率。
- Knowledge Source readiness 和读取成功率。
- Run 取消、失败恢复和 Artifact 捕获完整率。
- Connector 版本退化率。
- 权限越界、错误写入和数据丢失事件。

## 7. 明确不做

近期不应优先：

- 用更多 Agent Logo 作为版本卖点。
- 通用消费者聊天或社交产品。
- 自建模型、Token Marketplace 或默认 Token 加价。
- 自动抓取并索引用户所有知识库。
- 无限制 Swarm、无限轮次和无人值守写入。
- 在 Outcome 闭环成熟前建设 Cron、Webhook 和复杂自动化市场。
- 同时开发多个 Cloud Agent、多个 IM Channel 和完整 Team 平台。
- 把 General Agent 理解为“没有边界、什么都能做”。

## 8. 决策门

| 时间 | 必须回答的问题 | 决策 |
| --- | --- | --- |
| 第 4 周 | 新用户是否能独立完成首个真实任务？ | 否则先修激活，不增加平台范围 |
| 第 10 周 | Task、Context Pack 和 Outcome 是否减少手工整理并提高采用？ | 否则简化对象和首发协议 |
| 第 12-16 周 | 15 名固定用户中是否至少 8 名重复，是否出现外部贡献？ | 成立才投入 Cloud/Channel |
| 第 6-8 个月 | Cloud 或 Channel 是否被真实重复使用并愿意付费？ | 只扩展被证明的入口 |
| 第 12 个月后 | 是否有 3 个团队为同一标准化能力回款？ | 成立才进入 Team/Enterprise |

## 9. 最终判断

Meldwork 的迭代顺序应该是：

1. 从 Agent 会话升级到可采用的 Task Outcome。
2. 从临时提示升级到可授权、可复验的 Context Pack。
3. 从硬编码适配升级到 Agent 与 Knowledge Connector Contract。
4. 从本地工作台扩展到经用户授权的 Cloud 和 Channel。
5. 最后才把重复工作方式产品化为 Workflow 与 Team Governance。

第一和第二步没有完成时，Cloud、Channel、Workflow 和企业功能只会放大当前聊天产品的复杂度。
