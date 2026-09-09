# Meldwork 市场与决策调研：多 Agent 协作的真实性、定位与商业化

> 2026-09-08 更正：本文保留为历史记录，当前判断以[新调研](meldwork-commercial-research-2026-09-08.md)及[证据清单](meldwork-commercial-evidence-2026-09-08.md)为准。撤回用星标/下载推算转化、以 push 间隔判停更、以融资/星标增长证明需求、以 Gartner 预测证明刚需，以及“没有竞品进入决策位置”的推论。Conductor 融资金额已找到官方原文确认，但收入、留存和 Meldwork 付费需求仍未证明；旧代码和分支状态也须按版本重新核验。

> 调研日期：2026-09-04（竞品星标与发布数据为当日 `gh api` 实测快照）
> 研究范围：全球公开市场、GitHub 仓库、融资与产品动态、Meldwork 当前仓库与发布数据
> 关联文档：[2026-08-16 深度竞品调研](meldwork-competitive-landscape-2026-08-16.md)、[产品战略](../product-strategy.md)、[产品迭代规划](../product-iteration-plan.md)、[技术可靠性优化方案](../reliability-optimization-plan.md)
> 证据边界：星标、下载与融资是传播与投入信号，不等于收入、留存或产品价值；无法核验的判断一律标记"推断"或"待验证"。所有外部链接在 2026-09-04 实测可达（标注例外）。

## 0. 结论先答：四个核心问题

本次调研围绕项目维护者提出的四个决策问题展开，先给结论，证据见后文。

### Q1：这个需求有机会成为产品吗？本地/云端多 Agent 协作是否真实场景？

**结论：是真实场景，且正处在需求被快速验证的窗口期；但"多 Agent 协作"本身不是产品，"多 Agent 协作产生的结果可信、可追责"才是产品。**

- 供给侧证据扎实：2026 年 3 月 Conductor 以 4 人团队拿下 2200 万美元 A 轮（Matrix Partners 领投），Superset、cmux、Vibe Kanban、Munder Difflin 全部高速增长，说明"一个人同时驱动多个 Agent"已是高频工作形态，不是伪需求。
- 有效性证据有明确边界：Anthropic 官方工程报告显示多 Agent（Opus 4 领航 + Sonnet 4 子代理）在内部研究类评测上比单 Agent Opus 4 高 90.2%，且性能差异约 80% 可由 token 用量解释——多 Agent 在**可并行、只读、研究型任务**上有真实增量；Cognition 的《Don't Build Multi-Agents》则证明在**串行写入型编码任务**上多 Agent 会因上下文冲突互相拆台。
- 对 Meldwork 的含义：赛道真实性成立，但 Meldwork 的生存空间恰好在于它选的位置——独立审查、冻结上下文、单一 Writer、人类采用决定——这正是有效性证据支持的区间；而并行编码吞吐（Conductor/Superset 主战场）是有效性证据最弱的区间，不应进入。

### Q2：核心定位、BP 是否需要改变？群聊模式是否合理？迭代方向在哪？

**结论：2026-08-16 确立的定位（Agent Organization & Decision Workspace + Decision Review 服务楔子）不需要推翻，但需要两处收敛：一是把"群聊"明确降格为输入手段而非产品结构；二是把路线图第一优先级从"机制完整性"换成"跨设备安装即可用的可靠性"。**

- 定位无需改变的依据：08-16 之后的三周里，增长最快的竞品（Munder Difflin +162%、Omnigent 三个月 9.7k 星）全部集中在"运行更多 Agent / 管理 Agent 组织"，没有任何一家占据"独立判断 + 证据复验 + 可追责采用决定"这个位置。定位文档的差异化判断仍然成立。
- 群聊模式的判断：群聊（Auto Discussion）作为**探索和观察手段**合理，作为**结果交付结构**不合理。外部证据（Munder Difflin 的爆发）说明用户要的是"交代一句话，看到可信结果"，不是"经营一个 Agent 群"。这与 08-16 调研"群聊降为 Exploration Discussion"的结论一致，应加速落地。
- 迭代方向（按优先级）：
  1. **跨设备可靠性**（见 [技术可靠性优化方案](../reliability-optimization-plan.md)）：本次调研实测发现新设备安装即遇到导航渲染与 Provider 判定两类 bug，这是当前比任何新功能都更紧急的事项——可靠性不成立，定位和商业化都无从谈起。
  2. **修复许可证表述不一致**（见 §6）：LICENSE 实为 Apache-2.0，但 README 与战略文档仍写非商用许可，4 小时前刚对齐又被覆盖。这直接影响企业 Pilot 与商业化叙事。
  3. 按 08-16 规划推进 Decision Review 服务工作台（Case / Finding / Evidence / Decision / Disposition），先用真实 Case 证明相对最佳单 Agent 的净收益。

### Q3：有商业化可能性吗？还是只能做 GitHub 开源项目？

**结论：存在商业化窗口，但窗口不由"功能"决定，由"信任与分发"决定。当前数据（128 星、约 15 次 DMG 下载、2 Fork、单一维护者）距离商业化的前置条件还很远；未来 90 天的正确动作不是商业化，而是先达到商业化的入场资格。**

- 商业化成立的正面证据：Conductor 证明 4 人团队可以靠"组织多个编码 Agent"拿到 2200 万美元估值支持和真实企业用户（Google、Meta、Stripe 等工程师）；Paperclip（8.0 万星）证明"管理 Agent"叙事有大众级传播力；Munder Difflin 的"免费本地应用 + 付费云组织网络"路线证明本地优先产品可以预留云端商业化接口。
- 商业化的现实障碍（按严重度）：
  1. **采用漏斗断裂**：128 星但累计约 15 次 DMG 下载，星标→安装转化极低。原因大概率是安装摩擦（ad-hoc 签名、需 Open Anyway、装完即遇 bug）——与 Q4 直接相关。
  2. **许可证表述矛盾**：实际 Apache-2.0（允许商用）与文案"非商用许可"并存，企业法务无法评估。必须先统一口径再谈 Pilot。
  3. **单人维护 + 未公证发行**：无法支撑企业采购对供应链与责任主体的基本要求。
- 路线建议：**开源（Apache-2.0）换分发 → 可靠性与真实 Case 换信任 → 服务/产品化换收入**。当前阶段把代码完全闭源没有收益（没有分发就没有可闭源的价值）；把 Apache-2.0 用足换取 Connector 生态和采用，把 Decision Review 的交付逻辑、评测数据与服务流程作为不开放的核心资产，与 08-16 战略 §9.1 的"服务优先 → 闭源产品化 → 可选开放层"一致，但前提是先把许可证口径理顺。

### Q4：技术架构是否需要针对性优化？

**结论：需要，且优先级最高。两个被报告的 bug 有明确架构根因，均可修复；它们共同暴露的是同一类问题——系统的"事实源"不唯一（静态目录/检测结果/持久化状态三套并存；原生认证/Provider 注入两套 readiness 判定混用）。**

- Bug 1（未安装的 Agent 仍渲染在导航）：渲染以静态 12 项目录为基底，检测失败仅降级为徽标；侧边栏还会渲染持久化直聊会话对应的 Agent，userData 跨机迁移时未安装 Agent 会重现。
- Bug 2（CLI 可用却被要求重新配置 Provider）：readiness 把"原生认证可用"与"需要 Provider 注入"混为一谈；原生凭据探测的启发式在打包环境可能误判（`-lc` 不读 `.zshrc`、Keychain、探测超时），误判后宽泛的 `credentialFailure` 正则把 Agent 打成 needsLogin，UI 引导用户去配 Provider；而一旦配了 Provider 又跳过原生探测，形成循环。
- 完整机制、证据位置与修复方案见 [技术可靠性优化方案](../reliability-optimization-plan.md)。

## 1. 研究方法

| 方法 | 覆盖 | 限制 |
| --- | --- | --- |
| `gh api` 实测（2026-09-04） | 11 个既有竞品仓库 + 4 个新发现仓库的星标、Fork、Issue、创建/推送时间、许可证 | 星标不证明活跃使用；open_issues 含 PR |
| `gh api search` | 2026-06-01 之后创建的多 Agent 编排项目 Top 12 | 仅覆盖 GitHub 公开项目 |
| WebSearch + 原文核验 | 融资（Conductor）、市场预测（Gartner）、工程师采用（Temporal）、有效性证据（Anthropic/Cognition 原文数据） | 部分中文二手信源仅作线索，未采用其数字 |
| 本地仓库审计 | Meldwork 发布资产下载量、git 历史、许可证文件一致性、bug 代码机制追踪 | 单机证据，未做多设备实测 |

## 2. 市场信号：多 Agent 工作形态正在被快速验证

### 2.1 资本与增长信号（2026-09-04 核验）

| 信号 | 数据 | 决策含义 |
| --- | --- | --- |
| Conductor 融资 | 2026-03-30 完成 2200 万美元 A 轮，Matrix Partners 领投（Ilya Sukhar 入董事会），Spark Capital、YC 及 Notion/Linear 创始人跟投；团队 4 人；macOS-only；自称 1 月以来 10 倍增长；用户含 Google、Meta、Stripe、Ramp、Datadog、Spotify、Amazon、Intercom、Flexport 工程师 | "组织多个本地 Agent"已被一线资本与企业用户验证为可付费场景；4 人团队规模说明单人/小团队在该赛道有生存空间 |
| Gartner 预测 | 2025-06-25 新闻稿：到 2027 年底超过 40% 的 agentic AI 项目将被取消（成本、ROI 不清、风险控制不足） | 市场同时存在大量失败；"可追责、可审计、有证据"的治理层恰是对取消原因的直接回应——这是 Meldwork 叙事的顺风，但必须在文案里引用失败率以建立可信度 |
| Temporal《2026 State of Development Report: AI Agents》 | 工程师 AI Agent 使用量同比增长 70.8%（经 Wedbush 发布，二手转述） | 开发者侧 Agent 使用密度快速上升，"人均多个 Agent"的假设成立 |
| Gartner 应用集成预测 | 2026 年 40% 企业应用将集成 AI Agent（CSDN 转述，未获一手核验） | 仅作方向参考，不作为证据引用 |

### 2.2 有效性证据：多 Agent 什么时候有用、什么时候有害

| 证据 | 数据 | 边界 |
| --- | --- | --- |
| Anthropic 多 Agent 研究系统（官方工程博客，2026-09-04 实测可达） | Opus 4 领航 + Sonnet 4 子代理在内部研究评测上比单 Agent Opus 4 高 90.2%；token 用量单独解释约 80% 的性能方差；多 Agent 架构本质是"用更多 token 换能力"，适合可并行的研究/浏览任务 | 适用于只读、可分解、结果可合并的任务；成本数倍于单 Agent |
| Cognition《Don't Build Multi-Agents》（官方博客，实测可达） | 并行编码 Agent 因上下文共享不完整而产生相互冲突的决定（conflicting decisions），主张单线程上下文压缩而非多代理并行 | 主要针对写入型编码任务；与 Meldwork"单一 Writer 交付"设计反而同向 |

**综合判断**：有效性证据把多 Agent 的适用区间切成了两半——只读/研究/审查区间收益真实，写入/执行区间风险高。Meldwork 的机制设计（冻结上下文 → 独立判断 → 质询 → 单一 Writer → 人类采用）恰好落在收益区间，这是对 Q1 最重要的技术性支撑。

## 3. 竞品格局更新：2026-08-16 → 2026-09-04

### 3.1 既有竞品快照（全部 `gh api` 实测）

| 项目 | 2026-08-16 | 2026-09-04 | 变化 | 最新推送 | 许可证 |
| --- | ---: | ---: | ---: | --- | --- |
| block/buzz | 27,707 | 32,092 | +16% | 2026-09-04（当日） | Apache-2.0 |
| paperclipai/paperclip | 78,431 | 79,973 | +2% | 2026-09-04（当日） | MIT |
| manaflow-ai/cmux | 26,106 | 26,763 | +2.5% | 2026-09-04（当日） | 未标注 |
| BloopAI/vibe-kanban | 27,818 | 28,008 | +0.7% | **2026-04-24（停更约 4 个月）** | Apache-2.0 |
| superset-sh/superset | 12,951 | 13,720 | +6% | 2026-09-04（当日） | 未标注 |
| chaitanyagiri/munder-difflin | 2,390 | **6,262** | **+162%** | 2026-09-03 | MIT |
| Dicklesworthstone/mcp_agent_mail | 2,089 | 2,125 | +1.7% | 2026-09-04（当日） | 未标注 |
| nimbalyst/nimbalyst | 1,493 | 1,643 | +10% | 2026-09-03 | MIT |
| pqpo/pragma | 71 | 120 | +69% | 2026-09-04（当日） | 未标注（非标准） |
| **Ryder-MHumble/Meldwork** | ~75 | **128** | **+71%** | 2026-09-01 | Apache-2.0（API 检测） |

### 3.2 三个新信号

1. **Munder Difflin 三周 +162%（2,390 → 6,262）**：增长最快的直接竞品。它验证了"用户是老板、经理负责组织"的低门槛叙事。对 Meldwork 的含义在 08-16 报告中已经写明：借鉴低认知负担的角色结构，但不复制拟人化公司，把价值放在判断与证据链上。本次增长数据把这条建议从"应该"升级为"紧迫"。
2. **Omnigent（omnigent-ai/omnigent）是本次新发现的最危险竞品**：创建于 2026-06-11，三个月 9,671 星 / 1,501 Fork / 1,178 开放 Issue，Apache-2.0，官网 omnigent.ai 实测可达。自我定位："meta-harness——编排 Claude Code、Codex、Cursor、Pi 与自定义 Agent；不重写即可换 harness；强制策略与沙箱；任意设备实时协作。"它与 Meldwork 的 BYO-Agent 前提完全重叠，且多出"策略 + 沙箱 + 跨设备协作"三个卖点。Meldwork 必须在 90 天内用"独立判断 + 证据复验 + 采用记录"建立它没有的差异化证据，否则将被归入同类并被其规模压制。
3. **Vibe Kanban 停更**：最后推送 2026-04-24。28,008 星的项目停更说明：高星不等于可持续维护，也不等于商业闭环（08-16 结论再次被验证）。对单人维护的 Meldwork 这是双重警示——既要控制维护面，也要避免重蹈"星标高、产品停"的覆辙。

### 3.3 相邻生态（规模参照）

- OpenHands（86,127 星）、goose（53,898 星）：通用编码 Agent 生态的体量参照，说明 Agent 工具链整体热度。
- claude-squad（8,423 星，AGPL）：终端形态的多 Agent 管理器，与 cmux 同层，属于"够用就好"替代品的持续供给。
- Emdash（generalaction/emdash，5,593 星，YC W26）："开源 Agentic 开发环境"，资本支持的多 Agent 执行环境新玩家。
- pilotfish（683 星）："前沿模型规划、廉价模型执行"的多模型编排层——成本优化正成为新竞争维度，Meldwork 的评测体系（eval-harness）未来应把成本/质量比纳入公开指标。

## 4. Meldwork 自身采用信号审计

### 4.1 公开数据（2026-09-04 实测）

| 指标 | 数值 | 解读 |
| --- | --- | --- |
| 星标 | 128（08-16 约 75，+71%） | 传播在增长，README/GEO 优化有效 |
| Fork | 2 | 社区共建几乎为零；08-16 报告的"12 Fork"与当前 API 数据不符，以本次实测为准 |
| 开放 Issue | 22 | 对 128 星的项目偏高，需分类处理 |
| 发布 | 5 个（08-11 ~ 09-01），节奏健康 | 发布频率不是瓶颈 |
| DMG 下载 | 全部版本累计约 15 次（V1.0.0~V1.0.4 分别约 1/7/2/4/1） | **星标→安装转化极低，是最严重的漏斗断点** |

### 4.2 漏斗诊断

```
传播（128 星，+71%）
   ↓  转化极低（约 15 次下载）          ← 断点在这里
安装（ad-hoc 签名 + Open Anyway + arm64-only）
   ↓  首启即遇可靠性问题（本次审计实测发现两类机制性 bug）
激活（首个工作流完成）
   ↓  未知（无遥测）
留存 / 付费（无数据）
```

关键判断：**Meldwork 当前不缺"更多人知道"，缺的是"装得上、用得起来"。** 继续投入传播（README/GEO/视频）的边际收益递减；把安装-激活段修好，同样的传播量能带来数倍的真实用户。这直接回答 Q4 的优先级问题。

## 5. 定位与群聊模式的再评估（Q2 展开）

### 5.1 定位：保持，不重写

08-16 确立的三层定位（品类：Agent Organization & Decision Workspace；切入：高风险工作 Decision Review；证明：本地 Work Cell）在本次数据下依然成立，且有两个新增强化：

1. Gartner"40% agentic 项目将被取消"的预测，把"证据、责任、采用记录"从差异化卖点变成市场刚需叙事——对外文案应主动引用该预测。
2. 三周内没有任何竞品进入"独立判断 + 复验 + 采用决定"位置（最接近的 Omnigent 强调的是策略与沙箱，不是判断质量），窗口仍开放。

需要警惕的一种定位漂移：把"支持更多 CLI / 更多知识源"当成进展汇报。本次审计确认仓库近期提交大量集中在 README 与发现性优化，这是必要的，但北极星必须回到 08-16 定义：**每周被用户实际采用、达到验收标准并保留责任证据的 OutcomeReceipt 数**——当前该数字没有测量手段，90 天内应至少建立本地可导出的 Case/Decision 计数。

### 5.2 群聊：降格为输入，不再承担结果

- 代码事实：当前群聊（Auto Discussion）已经有 V4 的独立提案/质询/单写机制在分支内运行（110/110 聚焦测试通过），但这些结构在 UI 上仍以聊天流为主呈现。
- 市场事实：Munder Difflin 三周 +162% 说明用户接受的是"交代目标 → 看到组织化结果"，不是"管理一个群"。
- 结论（与 08-16 一致，执行优先级上调）：群聊保留为 Exploration Discussion 与审计详情；正式结果必须进入 Case → Finding → Evidence → Decision → Disposition 的结构化视图。群聊不是要删除的功能，而是要让位给结果层的交互层。

## 6. 关键发现：许可证表述不一致（影响 Q3）

**事实链（git 审计，全部可复核）：**

1. `LICENSE` 文件内容为 Apache License 2.0；`COMMERCIAL_USE.md` 明确"商业使用、私有使用、修改、再分发、用于付费服务均被许可"。
2. 提交 `a68c53b`（2026-09-01 10:21，"docs: align main license references"）把 README 中英文与 ai-discoverability 的许可证表述统一为 Apache-2.0。
3. 同日提交 `897b4ee`（2026-09-01 14:11，"docs: expand supported cli table to six columns"）在重写 README 时**把表述覆盖回 "Meldwork Non-Commercial Source License 1.0 / 商业使用需事先书面许可"**。
4. 同日 17:47 发布 V1.0.4，README（英/中）、`docs/product-strategy.md`（§9.1、§10.2）、`docs/README.md` 均写"非商用许可"，与 LICENSE 文件直接矛盾。

**影响**：企业评估方看到"非商用"表述会直接放弃 Pilot；开源用户看到 LICENSE=Apache-2.0 又会对文案产生不信任。两种方向都可以是正确决策（Apache-2.0 换分发，或非商用许可保商业独占），但**必须二选一并全仓对齐**。本报告按"以 LICENSE 文件为事实源"处理，即当前有效许可为 Apache-2.0；若维护者的真实意图是非商用许可，则应改 LICENSE 文件而非文案。本次调研已把 `product-strategy.md` 中的两处非商用表述更正为 Apache-2.0 并标注决策点；README 因面向公众且涉及许可方向选择，留给维护者确认后修改。

## 7. 关键发现：跨设备可靠性根因（影响 Q4）

基于代码追踪的完整证据与修复方案见 [技术可靠性优化方案](../reliability-optimization-plan.md)，此处给结论：

- **Bug 1（未安装的 Agent 仍出现在导航/设置）**：渲染基底是静态 12 项目录而非检测结果；设置页恒渲染全部条目（检测失败仅降级为徽标）；侧边栏额外渲染持久化直聊会话对应的 Agent，导致 userData 迁移或残留状态下未安装 Agent 重现。这是"事实源不唯一"问题：静态目录、检测结果、持久化会话三套状态并存。
- **Bug 2（CLI 原生可用却被要求配置 Provider）**：readiness 判定把"原生认证"与"Provider 注入"混为一谈。原生凭据探测依赖文件启发式与 CLI 探针，在打包环境存在三类误判源（登录 shell 用 `-lc` 不读 `.zshrc`、Keychain 访问、探针超时）；误判或运行失败命中宽泛 `credentialFailure` 正则后，Agent 被打成 needsLogin，HomeDashboard 的 setup guide 随即引导用户配置 Provider；而一旦配置 Provider，`refreshOnce` 又跳过原生探测——形成"配了 Provider 才算好"的循环。代码层面不存在"必须先配 Provider"的硬门禁，问题出在状态判定与 UI 引导。
- **共同根因**：检测/凭据/渲染三条链路各自维护状态，缺少单一的、可审计的 Agent Readiness 事实源。修复不是打补丁，而是收敛事实源（见技术方案 §3）。

## 8. 行动建议（按优先级）

| # | 行动 | 时间 | 验收标准 |
| --- | --- | --- | --- |
| 1 | 执行[技术可靠性优化方案](../reliability-optimization-plan.md) P0 项：Readiness 事实源收敛、导航渲染由检测结果驱动、`-lc` 改 `-lic` 或补 `.zshrc` 解析、收紧 `credentialFailure` 正则 | 1-2 周 | 全新 macOS 设备（无/有已登录 CLI 两种）安装后 10 分钟内完成首个直聊；未安装 Agent 不出现在工作导航；原生认证可用的 CLI 零 Provider 配置可运行 |
| 2 | 统一许可证口径：确认采用 Apache-2.0 或改回专用非商用许可，全仓文案一次对齐（README 英/中、product-strategy、ai-discoverability、GEO 实体卡） | 本周内 | 任意页面不再出现与 LICENSE 文件矛盾的表述 |
| 3 | 建立最小采用遥测（本地计数 + 可导出）：完成的 Case 数、Decision 数、Disposition 分布 | 2-3 周 | 能回答"上周有多少个被采用的 Outcome" |
| 4 | 对外叙事引用 Gartner 40% 取消率预测 + Anthropic/Cognition 有效性边界，强化"决策治理层"定位；把 Omnigent 加入竞品对照表 | 2 周内 | README/战略文档对比表更新，措辞通过"Today/Branch/Next/Future"口径检查 |
| 5 | 按 08-16 规划启动 5 个真实 Decision Review Case（允许人工补位），对照最佳单 Agent 记录证据覆盖率、有效 Finding、人工时间与成本 | 30-90 天 | 至少 1 项指标出现可重复净收益，否则触发 08-16 定义的停止条件评估 |

明确不做：不以新增 CLI 适配数量、不以下一代群聊交互、不以宣传视频作为 90 天内的主线指标；在可靠性修复完成前不扩大下载传播（避免把坏第一印象扩散给更多潜在用户）。

## 9. 来源清单（2026-09-04 实测）

### 9.1 一手数据

- GitHub API 实测（2026-09-04）：`repos/{block/buzz, pqpo/pragma, chaitanyagiri/munder-difflin, superset-sh/superset, manaflow-ai/cmux, BloopAI/vibe-kanban, paperclipai/paperclip, Dicklesworthstone/mcp_agent_mail, nimbalyst/nimbalyst, Ryder-MHumble/Meldwork, andyrewlee/awesome-agent-orchestrators, omnigent-ai/omnigent, generalaction/emdash, smtg-ai/claude-squad, Nanako0129/pilotfish, aaif-goose/goose, OpenHands/OpenHands}` 及 `search/repositories?q=multi-agent+orchestrator+created:>2026-06-01`
- Meldwork 本地仓库：`LICENSE`、`COMMERCIAL_USE.md`、git 提交 `a68c53b`/`897b4ee`/`709a9e9`、Release 资产下载量（gh api）

### 9.2 融资与市场

- Conductor 2200 万美元 A 轮（2026-03-30，Matrix Partners 领投）：https://aiturnpoint.com/conductor-raises-22m-series-a （实测可达）
- Conductor 从本地走向云端（Vercel Sandbox 合作）：https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox （实测可达）
- Conductor 官网：https://www.conductor.build/ （实测可达）
- Superset 官网与仓库：https://superset.sh/ 、https://github.com/superset-sh/superset （实测可达）
- Omnigent 官网与仓库：https://omnigent.ai 、https://github.com/omnigent-ai/omnigent （实测可达）
- Munder Difflin 官网与仓库：https://munderdiffl.in/ 、https://github.com/chaitanyagiri/munder-difflin （实测可达）
- Gartner：超过 40% 的 agentic AI 项目将在 2027 年底前被取消（2025-06-25 新闻稿）：https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027 （链接实测返回 403 反爬，标题与内容经搜索索引核验）
- Temporal《2026 State of Development Report: AI Agents》（工程师 Agent 使用 +70.8%，经 Wedbush 发布）：二手转述，未获一手报告原文，置信度中
- Superset 功能描述（10+ 并行、worktree、Apache-2.0、零遥测）：https://byteiota.com/superset-ide-run-10-parallel-ai-coding-agents-2026/ （实测可达；其"3,285 星"为旧数据，本文以 gh api 实测为准）

### 9.3 有效性证据

- Anthropic: How we built our multi-agent research system（90.2%、token 解释 80% 方差等数据经原文核验）：https://www.anthropic.com/engineering/multi-agent-research-system （实测可达）
- Cognition: Don't Build Multi-Agents：https://cognition.ai/blog/dont-build-multi-agents （实测可达）

### 9.4 内部证据

- [2026-08-16 深度竞品调研](meldwork-competitive-landscape-2026-08-16.md)
- [产品战略](../product-strategy.md)、[产品迭代规划](../product-iteration-plan.md)、[架构](../../architecture.md)
- Bug 机制追踪：`desktop/src/agents/cli/cli-discovery.cjs`、`desktop/src/workspace/local-workspace-agent-catalog.cjs`、`desktop/src/workspace/local-agent-readiness.cjs`、`frontend/src/composables/useAgentCatalog.js`、`frontend/src/components/WorkspaceSidebar.vue`、`frontend/src/components/HomeDashboard.vue`（详见技术方案文档）

---

本报告以 2026-09-04 为快照日期。星标、下载、融资与 Issue 数据会快速漂移，对外引用前应重新核验高漂移字段；所有"推断"与"待验证"标记不得在对外文案中省略。
