# Meldwork 商业调研证据清单

关联：[主报告](meldwork-commercial-research-2026-09-08.md)。全部来源于 2026-09-08 本次 HTTP 实抓；发布日期与抓取日期分列，不以搜索收录日期代替事件时间。30 项来源进入主报告，另有检索候选与失败请求。L1 为官方材料，L2 为研究原文，L3 为媒体，L5 为公开用户表达；层级不是统计可信度评分。官网只能证明厂商的公开承诺，用户 issue 只能证明有人报告了问题，均不代表独立实测。

## 来源与证据边界

| ID / 层级 | 原始链接 | 发表时间或快照 | 已读取事实与边界 |
| --- | --- | --- | --- |
| S02 / L1 | [Conductor Pricing](https://www.conductor.build/pricing) | 动态价格页 | Free $0；Pro $50/mo；Teams $60/mo/user。本地免费，付费增加云和协作。未取得付费人数。 |
| S03 / L1 | [Superset](https://superset.sh/) | 动态产品页 | 宣传并行 Agent 工作台、隔离工作区和团队工作。官网评价不作为独立用户证据。 |
| S04 / L1 | [Superset Pricing](https://superset.sh/pricing) | 动态价格页 | Free 单用户本地；Pro 月付 $20，年付 $180/人；远程、Linear、Slack。不能从表格纯文本推断所有勾选状态。 |
| S05 / L1 | [cmux](https://cmux.com/) | 原 cmux.dev 重定向 | 免费终端、通知、任意终端 Agent、恢复及 Founder's Edition。官网用户推荐经厂商筛选。 |
| S07 / L1 | [Claude Code Agent teams](https://code.claude.com/docs/en/agent-teams) | 滚动版本文档 | “Agent teams are experimental and disabled by default”；共享任务、互相通信；非交互 -p/SDK 不生成同类 teammates。版本限制必须与接口方式一起保留。 |
| S08 / L1 | [Anthropic 多 Agent 研究系统](https://www.anthropic.com/engineering/multi-agent-research-system) | 2025-06-13，历史背景 | “outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval”；15 倍 Token 比较聊天，非单 Agent。厂商自评、旧模型。 |
| S10 / L2 | [Scaling Agent Systems v3](https://arxiv.org/abs/2512.08296v3) | v1 2025-12-09；v3 2026-04-08 | 摘要：260 配置、六基准；金融推理 +80.8%、顺序规划 -70.0%。本次读取摘要及版本信息，未复现实验，不能外推 Meldwork 收益。 |
| S15 / L1 | [Notion AI](https://www.notion.com/product/ai) | 动态产品页 | Notion Agent、连接应用、企业搜索；Custom Agents 试用后 $10/1,000 credits。未核验账户结算。 |
| S19 / L5 | [Superset issues 列表](https://api.github.com/repos/superset-sh/superset/issues?state=all&per_page=30) | 抓取时最新 30 项 | 含 PR；剔除后 2 条 issue：#7318、#7310。不能将 30 项视为 30 个用户问题。 |
| S22 / L1 | [Claude Opus 4.6](https://www.anthropic.com/news/claude-opus-4-6) | 2026-02-05 | 公告明确推出 Agent teams 研究预览。模型 benchmark 不用于证明商业价值。 |
| S24 / L1 | [Notion 3.0 Agents](https://www.notion.com/releases/2025-09-18) | 2025-09-18 | 页面/数据库记忆、跨连接工具上下文与多步任务。用户推荐为官方选取。 |
| S25 / L1 | [Claude Sonnet 4.5](https://www.anthropic.com/news/claude-sonnet-4-5) | 2025-09-29 | 发布文章介绍 Claude Agent SDK。模型效果自报不作为本报告结论。 |
| S26 / L1 | [TRAE 国际价格](https://www.trae.ai/pricing) | 动态价格页 | Lite $3/月；Pro 7 天试用后 $10/月；Pro+ $30/月；Ultra $100/月。以页面列出权益为限，不和国内直接换汇比较。 |
| S30 / L2 | [METR 实验设计更新](https://metr.org/blog/2026-02-24-uplift-update/) | 2026-02-24 | 57 位开发者、143 仓库、800+ 任务；作者认为新的估计不可靠，存在选样与并行计时问题。不能继续用早期慢 19% 代表当前整体。 |
| S31 / L1 | [Conductor Changelog](https://www.conductor.build/changelog) | 引用 2026-08-27 条目 | 组织级 review/PR/conflict 指令及恢复、状态修正。未据此推断完整决策管理已交付。 |
| S33 / L1 | [Codex 桌面文档入口](https://developers.openai.com/codex/app) | 跳转 [当前桌面文档](https://learn.chatgpt.com/docs/app) | “Run projects in parallel, work with files ...”；统一桌面工作入口。抓取时产品名称与旧文档已有变化，不伪装成旧版快照。 |
| S34 / L1 | [生成式人工智能服务管理暂行办法](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm) | 2023-07-13，现行背景 | 第二条公众服务/非公众研发应用边界；不据此认定 Meldwork 免除全部法律义务。 |
| S35 / L1 | [欧盟 AI Act 官方说明](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai) | 动态政策说明 | 风险与用途分层、不同时间节点。非逐国法律意见，报告未做完整法条适用审查。 |
| S36 / L5 | [cmux HN 发布讨论](https://news.ycombinator.com/item?id=47079718) | 2026-02-19 主帖 | 通过 [Algolia 树](https://hn.algolia.com/api/v1/items/47079718) 读取 71 评论节点；含作者和非用户，禁止转为客户比例。 |
| S38 / L5 | [Superset 会话恢复搜索](https://api.github.com/search/issues?q=repo%3Asuperset-sh%2Fsuperset+is%3Aissue+session+restore&per_page=6) | 多个 issue，2026-04 至 08 | 6 条：#6343、#3496、#5989、#5792、#6308、#6846。关键词选样偏向痛点，非随机样本。 |
| S39 / L5 | [cmux 通知搜索](https://api.github.com/search/issues?q=repo%3Amanaflow-ai%2Fcmux+is%3Aissue+agent+notification&per_page=6) | 多个日期的 issue | 6 条：#11975、#8359、#9863、#10770、#8951、#2523。作者报告，不表示当前未修复。 |
| S41 / L1 | [TRAE 国内套餐与计费](https://docs.trae.cn/ide_plans-and-billing) | 动态价格文档 | Pro 单月 ¥99；连续包月 ¥89；首月 ¥69；积分和云任务额度，支持开票。不是永久免费。 |
| S43 / L1 | [TRAE 国内产品概览](https://docs.trae.cn/) | 动态产品文档 | TraeCode、TraeWork、CLI、插件、企业版；Work/Code/Design 模式及目标人群。仅是承诺覆盖，未实测。 |
| S48 / L1 | [Conductor Series A](https://www.conductor.build/blog/series-a) | 2026-03-30 | “We've raised a $22m Series A from Spark and Matrix.” 用户增长 10x 等为公司自报，未验证收入。 |
| S49 / L1 | [Conductor Claude subscription update](https://www.conductor.build/blog/claude-subscription-update) | 2026-06-15 | 公司称 5 月公布的 SDK 订阅政策变动被无限期延后；范围明确为 Conductor，不外推至 Meldwork。 |
| S58 / L1 | [Claude Cowork](https://claude.com/product/cowork) | 动态产品页 | 文件工具访问、步骤展示、审批、按条款引用的合同复核示例。示例不是独立真实客户交付。 |
| S59 / L3 | [TechCrunch Codex macOS 发布](https://techcrunch.com/2026/02/02/openai-launches-new-macos-app-for-agentic-coding/) | 2026-02-02 | 并行、Skills、自动化结果待审；作为原始公告反爬时的发布日期和功能来源。 |
| S60 / L3 | [TechCrunch Codex 知识工作](https://techcrunch.com/2026/06/02/openai-launches-new-codex-tools-for-white-collar-work/) | 2026-06-02 | 面向办公的扩展；5M 周活和 20% 知识用户是引用厂商公告，不能标为媒体独立核验。 |
| S64 / L2 | [METR 2026 技术工作者调查](https://metr.org/blog/2026-05-11-ai-usage-survey/) | 2026-05-11；调查 2026-02 至 04 | 349 人便利样本，自报价值 1.4–2x，速度 3x；邮件响应率约 2%，作者强调选样偏差，未推算支付意愿。 |
| S65 / L5 | [Superset 中文检索](https://api.github.com/search/issues?q=repo%3Asuperset-sh%2Fsuperset+is%3Aissue+%E4%BC%9A%E8%AF%9D&per_page=5) | #4242 2026-05-08；#4167 2026-05-07 | 返回 2 条；仅 #4242 正文/标题可作为中文表达样本。不能认定作者所在地。 |

## 用户表达与研究编码

样本范围在检索前聚焦运行中断、恢复、通知、并行管理和自主控制；非市场抽样。英语为主，中国用户与非代码专业买方证据不足。没有直接联系任何评论作者。

| 证据 | 日期 | 原文短摘 / 精确转述 | 支持的需求 | 不能推出 |
| --- | --- | --- | --- | --- |
| [Superset #7310](https://github.com/superset-sh/superset/issues/7310) | 2026-09-08 | “I want to manage my agent session in the workspace myself.” | 不强制提示词/模型，保留原生工作习惯 | 所有用户拒绝统一界面 |
| [Superset #7318](https://github.com/superset-sh/superset/issues/7318) | 2026-09-08 | 喜欢体验，但重复修改分支名和侧栏名烦扰 | 稳定命名、少重复操作 | 愿意为命名功能付费 |
| [Superset #3496](https://github.com/superset-sh/superset/issues/3496) | 2026-04-16 | 重启后需手动找 session ID 再 resume | 工作连续性与可恢复性 | 当前产品仍完全不支持恢复 |
| [Superset #5989](https://github.com/superset-sh/superset/issues/5989) | 2026-07-27 | 作者更正：会话能通过后台终端找回，布局丢失仍成立 | 状态与恢复入口需要清楚 | 不能再引用成“所有运行会话不可恢复丢失” |
| [Superset #4242](https://github.com/superset-sh/superset/issues/4242) | 2026-05-08 | “升级到1.8.7后原先的ws不见了，也无法import” | 升级稳定性，中文个案 | 中国市场规模、中文用户付费率 |
| [cmux #8359](https://github.com/manaflow-ai/cmux/issues/8359) | 2026-07-17 | 继续执行后仍显示旧的 Complete/Waiting for input | 当前状态与历史通知分离 | 单凭通知判断任务完成 |
| [cmux #11975](https://github.com/manaflow-ai/cmux/issues/11975) | 2026-09-04 | 过早、重复或遗漏完成/介入通知 | 统一生命周期与去重 | 每个 Agent 的同一套正则足够 |
| [cmux HN 47082577](https://news.ycombinator.com/item?id=47082577) | 2026-02-20 | “Gave this a run and it was pretty intuitive.” | 有真实试用后的正面体验表达 | 留存或付款 |
| [cmux HN 47080522](https://news.ycombinator.com/item?id=47080522) | 2026-02-19 | “I don't want to move to another terminal now” | 新入口有迁移阻力 | 用户无需求 |
| [cmux HN 47091352](https://news.ycombinator.com/item?id=47091352) | 2026-02-20 | 喜欢产品，但通知重排改变会话快捷键，增加负担 | 自动化不应破坏稳定控制 | 所有自动排序均无价值 |
| [cmux HN 47109046](https://news.ycombinator.com/item?id=47109046) | 2026-02-22 | “You will end up reinventing an IDE.” | 增加编辑器等功能有范围膨胀风险 | 产品不能加入任何编辑能力 |

本次未对正负评论计算比例：开发者重复发言、问题搜索偏样、发布日期不同、任务群体差异都破坏同分母比较。厂商首页推荐未混入这张表。完整 HN 树和搜索响应在本地临时采集目录留存，持久文档保留短摘与原始链接，避免复制整篇第三方内容。

## 检索缺口与失败记录

- 2026-09-09 归档复核：来源清单 30 项均有本地正文和元数据文件。复读采集脚本 `/tmp/meldwork_research_fetch.py` 后确认，`sha256` 的计算对象是 HTTP 响应经 UTF-8 解码再编码的内容；所保留 `.txt` 则是 HTML 提取正文或重新格式化的 JSON，两者不是相同字节。原始响应未随清单持久归档，保留原值，但不能将其宣称为留存正文的完整性验证，也无法据此独立复算原响应。引用依据仍为正文短摘及原始链接，抓取日期保持 2026-09-08，不伪装为本次重新联网抓取。

- [Codex 原始发布公告](https://openai.com/index/introducing-the-codex-app/) 直接请求 403；Firecrawl 虽返回 success=true，正文为验证等待页且 metadata.statusCode=403，判为失败。改用官方开发者文档和 TechCrunch 正文，不引用验证页为事实。
- [GPT-5.3-Codex 公告](https://openai.com/index/introducing-gpt-5-3-codex/) 403，未用于报告。
- Anthropic 旧候选地址 `/news/cowork-research-preview`、`/news/cowork`、`/product/cowork` 均 404；实际有效产品页为 [claude.com/product/cowork](https://claude.com/product/cowork)。
- TRAE 首页直接抓取仅得到 190/206 字符的壳页，国内 `/blog` 无正文，work.trae.cn 仅 43 字符；均不作为产品证据。改用 docs.trae.cn 正文与实际价格页。
- 两个猜测的 TechCrunch 发布地址 404；通过其 WordPress search API 找到 S59 正文。媒体搜索中 Conductor 和 TRAE 有大量同名误匹配，已排除。
- Firecrawl search 首次返回空；Bing RSS 多次出现词典、同名项目或忽略 site 限定，结果只用于发现链接，没有作为事实。HN 的 Conductor 查询包含 Microsoft/Orkes 同名工具、cmux 查询包含其他终端/网络项目，按域名及仓库精确消歧。
- 中国权威媒体未取得足以支撑新增结论的相关正文；中国市场主要为官方供给证据与少量中文公开表达，不能伪称完成中国目标买方访谈。海外 L3 使用两篇 TechCrunch 正文，也并非广泛媒体共识。
- 2025 Stack Overflow AI 调查、METR 2025 实验与 Cognition 2025 文章曾作为候选读取；主报告优先引用 2026 更新，避免以旧模型样本推断当下产品效果。
- 未测量竞品当前版本端到端成功率、速度、模型成本或本地隐私实现；没有得到竞品付费转化/续费数据、Meldwork 活跃与留存数据。官网无某个功能的描述不能推出该功能不存在。

## 从事实到判断

| 战略判断 | 支撑证据 | 反证与保留 |
| --- | --- | --- |
| 通用 CLI 聚合较难单独收费 | S02、S04 免费本地层；S05 免费终端 | 不等于所有本地软件无法收费；独特体验仍待测 |
| 中立层应降低干预和迁移负担 | S19、S36 用户自主控制；S07 不同调用方式能力差异 | 部分用户偏好集成体验，需观察真实操作 |
| 非代码 Decision Review 并非空白 | S15、S24、S43、S58 相邻平台功能 | 尚未找到所有跨厂商结果闭环均被覆盖的证据 |
| 可靠交付与工作连续性值得先做 | S38、S39、S65，及本次用户自身问题 | 可能只是免费产品应有质量，未证明溢价 |
| 群聊应按任务启用 | S07、S10、S08 | 不能排除某类任务中默认多 Agent 有净收益 |
| 服务先行可作为验证方法 | 项目现状与小规模成本情景推导 | 无成交证据；服务价值不能当作软件 PMF |
| 工作历史可成为候选壁垒 | S24 展示既有工作资产与 Agent 的结合 | 迁移、可导出、模型升级可能弱化优势；不是已存在的网络效应 |

## 历史口径修正

09-04 文档中的融资金额本次用 S48 官方原文确认；用户增长仍是厂商自报。旧文档以星标/下载诊断漏斗、以 push 间隔认定停更、以 Gartner 取消率预测推出刚需、以没有看见同类宣称竞争空白，均撤回作为当前决策依据。没有本次验证的数据不覆盖其历史快照，也不重复作为当前事实。
