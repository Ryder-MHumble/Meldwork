# V1.0.5 开发记录

日期：2026-09-09。分支：`feature/1.0.5`。状态：开发中，尚未完成整体目标；包版本仍为 `0.1.4`。

## 已复现与修复

- 认证误判：正常 HTTP 错误解释及包含 auth/credential 的文件错误被误判为登录失效。提交 `6fe4314` 收窄诊断条件，79 项相关测试通过。
- OpenClaw：本机 `2026.9.1` 在网关启动时迁移配置，增加默认 main Agent 和迁移元数据、规范化 discovery 字段；Meldwork 随后按旧文件身份拒绝执行。真实网关健康检查成功后可稳定复现 `OPENCLAW_RUNTIME_UNSAFE_PATH`，尚未进入模型调用。
- 当前修复在协议适配层、健康检查后验证配置语义，接受上述迁移并重新建立文件身份检查。工具、工作目录、Provider、凭证、网络绑定、额外未知配置、符号链接和权限变更仍拒绝。不能据此承诺未知 OpenClaw 版本的迁移均兼容。
- 凭证探测异常改为单 Agent 隔离，保留安装事实和未知状态，不阻止其他 Agent 刷新。不将未知探测直接当作登录失效或安装不存在。
- 安装目录保留能力探测超时原因；前端合并已注册自定义及本地 Connector，保留内置顺序与去重，不开放未完成的注册入口。
- 写入调度按真实目录路径协调跨群任务，符号链接别名使用同一资源键。同一目录最多一个运行中的写入者；只读任务仍可并行。审批挂起后重新获取原权限绑定，未知调度权限拒绝。
- Pi 能力检测要求实际调用使用的模式、会话、工具与审批参数，拒绝同名无关程序和缺少权限控制的 CLI；不改变用户本机损坏的 Pi 安装。
- 自然讨论中的有效 @ 不再被同一回复里的未知 @ 一并丢弃；移除第四轮后强制加入未发言成员的逻辑，保留 Agent 选择的参与者。
- 顺序讨论到达轮数上限、自动讨论耗尽单轮预算，以及对应恢复分支，均记录 `round-limit` 并发出上限提示，不再直接报告 `completed`。
- 历史运行卡片使用现有双语“最近一次话题运行”文案；活动话题保持运行中文案，避免已完成任务看起来仍在执行。
- 已选择的 Provider 凭证不可读时，检测不再根据原生登录或历史成功标成可用，保留安装/配置事实与未知凭证状态，界面显示双语“Provider 凭证不可用”。旧任务随后成功也不能覆盖这一阻塞；解除后刷新重新判断。执行仍拒绝静默切换 Provider。上述写入调度、路由、预算退出及历史卡片修复已提交为 `d0115c2`。

## 运行证据

- `/tmp/meldwork-openclaw-protocol-validation.cjs`：真实 OpenClaw CLI、隔离临时工作目录、本地 HTTP 模型协议桩；经网关、配置迁移、Agent 协议调用返回 `completed`，模型接口收到 1 次请求。没有消费真实模型额度；不能替代真实模型能力评测。
- `/tmp/meldwork-105-electron.cjs`：真实开发版 Electron，独立 userData；连续两次刷新均保留 12 项安装记录，OpenClaw 可调用。刷新耗时约 20.7 秒与 5.1 秒。截图：`/tmp/meldwork-105-startup.png`。耗时只代表此机器该次观察，尚无普遍性能结论。
- `/tmp/meldwork-105-electron-group.cjs`：真实 Electron preload 创建 Codex + OpenClaw 手动 V4 群组，Codex 为写入者、OpenClaw 只读；两者使用本机原生 Provider 完成调用，无待处理 Gate。Codex 写入并读回 `result.txt`，内容精确为 `MELDWORK_105_OK\n`，持久化运行状态为 completed。隔离目录 `/tmp/meldwork-105-group-Og9yQS`，运行 ID `3d019b8f-ee3f-422e-82ff-62273aefd41e`；截图 `/tmp/meldwork-105-group.png`。此证据限于手动群聊，不能证明自然自动讨论的写入与完成判断。
- `/tmp/meldwork-105-history.cjs` 重开上述隔离数据，未新增模型调用；确认历史卡片显示 `Latest topic run`，截图 `/tmp/meldwork-105-history.png` 已查看，Electron 正常关闭。
- 本机 Pi 包装脚本引用已经不存在的 Node 路径，终端直接执行同样失败；未修改用户 CLI 安装。MiMo 原生状态报告未认证。不能将这两项作为已修复可用的 Agent。
- 89 项桌面相关测试、全部 327 项前端测试通过；Web 与桌面构建通过；`pack` 通过但缺少 Developer ID 签名。新增配置读取限长与网关迁移后启动失败重试覆盖，配置语义比较使用同一受校验文件句柄读取的内容。
- 全量桌面测试为 1469/1471，两项 Auto V4 Gate/ACP 重启测试超时；独立串行重跑 2/2 通过，耗时分别约 8.9 秒、6.2 秒。不能据此宣称全量通过；最终需重新跑全套并查验结果。
- 本批新增修改验证：111 项 CLI 检测、调度、手动 V4 持久化、Gate 暂停及原生 ACP 重启测试通过；23 项自然讨论测试通过，覆盖预算退出、部分结果恢复与不重复调用。前端 `App.conversation-trace.spec.js` 28/28 通过，桌面前端构建及 `git diff --check` 通过。这些是聚焦回归，未重新执行全量测试或打包。
- Provider 检测一致性：71 项 Main 安全与 Agent catalog 测试、23 项前端 Agent catalog/i18n/Provider model 测试通过；补充历史成功、运行结果竞态、健康同伴与解除阻塞后恢复的断言，桌面前端构建通过。
- `/tmp/meldwork-105-provider-readiness.cjs`：独立 Electron 配置 `/tmp/meldwork-105-provider-rr3C5L` 使用合成不可解密数据，验证 Hermes 安装记录保留、不可调用且凭证状态未知，Codex 仍可用；设置页显示 `Provider credentials unavailable`，截图 `/tmp/meldwork-105-provider-readiness.png` 已查看。移除合成 Provider 后刷新，Hermes 恢复 `native-credential` 可用。未改日常配置、未调用模型；这验证解密失败处理，不是实际锁定用户 Keychain 的实验。
- 最新全量前端测试 36 个文件、328/328 通过；全量桌面仍待最终重跑。

## 待完成

1. 群聊写权限：自然讨论的实际写入与未知结果恢复已完成本轮检查点，见末节；仍需纳入最终全量测试与打包验收。
2. 群聊收尾：自然讨论已替代无 @ 推断成功的规则，详见下节。`needs-human` 当前记录为 partial 并提示原因，尚未连接可恢复的 Human Gate；人类采用记录与更多真实多 Agent 场景仍需验证。
3. 群聊路由及上下文：已限制自然讨论历史预算、修复长回复末尾请求丢失，并完成按原生会话确认状态发送增量的检查点，见末节。正文否定语境中的 @ 仍需处理，保留 Agent 的自主协作选择。
4. 启动检测：继续检查环境恢复、探测超时、Keychain 状态与执行事实一致性；首次扫描等待仍长。
5. 通用性：继续落实 review 中与当前范围有关的品牌/Skill/媒体词路由问题，业务核心不依赖指定 Agent；Pi 空能力探测已收紧。
6. 完成真实 Electron 群聊写文件、完成/阻塞、失败隔离、取消和重启恢复验收，再更新版本、复测和生成最终版本说明。成功恢复后历史错误隐藏完成卡片的问题已完成本轮修复，见末节。

研究与本地协议验证不等于 V1.0.5 已发布。尚未推送、合并或替换用户日常客户端。

## 自然任务判断与单 Agent 检查点

2026-09-09：自然讨论由首个选定参与者作为初始交付负责人，负责人可显式交接给选定参与者。完成、继续、阻塞与需要人类决定通过有界 `taskDecision` 回执记录；完成必须附理由和交付依据。它是 AI 的判断，不是系统独立验证或用户采用。待处理有效 @ 优先继续，缺少有效判断不再由沉默推断成功，也不再强制另一成员复核。

判断贯穿回执、Harness、账本和 journal。回归发现 journal 字段白名单遗漏导致落盘失败，已同步严格校验。恢复复用绑定有效的已完成结果；过期消息不能冒用旧操作判断。无结构化回执的 challenge 不再被外层编造成支持意见与职责图。

前端发送及主进程允许单个可用 Agent 启动自动任务，继续拦截无目标和不可用成员。历史卡片不再因 Agent 调用正常结束，将任务受阻、待人类决定或缺少完成判断显示为整项成功。

验证：

- `node --test desktop/test/collaboration/task-decision.test.cjs desktop/test/workspace/local-workspace-v4-natural-discussion.test.cjs desktop/test/workspace/local-workspace-v4-receipt.test.cjs`：52/52，通过完成/阻塞/需要人类决定、主动继续、有效/无效交接、部分结果恢复和旧消息绑定测试。
- `node --test desktop/test/runs/run-ledger.test.cjs desktop/test/runs/run-harness.test.cjs desktop/test/collaboration/orchestration-v4-records.test.cjs`：136/136，包括从损坏快照经 journal 恢复判断，以及拒绝无交付依据的完成记录。
- `node --test desktop/test/workspace/local-workspace-auto.test.cjs`：91/91。
- `npm --prefix frontend test`：36 文件、332/332；`npm --prefix frontend run build:desktop` 和 `git diff --check` 通过。构建仍有既有大 chunk 提示；本检查点未重跑全量桌面或打包。
- `/tmp/meldwork-105-task-decisions.cjs`：真实 Electron + 原生 Codex，独立配置 `/tmp/meldwork-105-decisions-Mh7mIS`。算术交付运行 `ed60537a-343e-49eb-960e-ad5fff33f586` 持久化为 completed，负责人给出答案和依据；缺失 `required-input.txt` 的运行 `7d242ebe-1cc9-4edd-a4ea-bfd704d29f42` 给出 blocked 判断，整项记录 partial，未生成替代文件。测试脚本最初错误地以空运行列表提前结束，修订为等待账本终态后才作断言；该首次中断不计通过。
- `/tmp/meldwork-105-decision-history.cjs` 重开上述真实记录，不新增模型调用；阻塞提示可见且无整项成功卡片，完成案例保留历史卡片。已查看 `/tmp/meldwork-105-decision-completed.png` 与 `/tmp/meldwork-105-decision-blocked-fixed.png`，Electron 正常退出。

此检查点尚未解决自然自动任务的实际写入与未知写入恢复，也不代表所有 CLI 的完成回执已实测兼容。后续继续按上述待完成项推进。

## 自然讨论写入与审批恢复检查点

2026-09-09：任务开始时按参与者声明的能力选择首个可写 Agent，冻结为 `discussionWriterKind`。提案保持只读，讨论阶段仅该成员可写；实际调用、槽位与计划权限一致。这个字段与旧 synthesis 交付绑定分开，恢复时必须匹配原始快照。未知参与者、改写写入者、缺失绑定及计划/槽位权限不一致均拒绝。

中断的可写讨论若没有可复用的已完成结果，先请求一次重试审批；批准消耗在再次执行之前落盘，再次崩溃必须产生新的审批。明确拒绝不会重放，已有完成结果不会重复写文件。应用关闭时保留待批准记录；重开后等待用户决定，不提前创建执行控制器。修复自动恢复异常处理将正常关闭误记为失败的问题。

验证：

- 新增 `local-workspace-v4-natural-writer.test.cjs`：8/8，通过顺序/Agent-led 写入、声明能力选择、无可写参与者、权限篡改、拒绝/批准、审批页面重开、二次崩溃与已完成结果复用测试。初次扩展回归为 146/147，其中新增模拟回复仅有内部控制块而无可见正文，被正确判空；修正测试输入后完整新文件 8/8。
- 同批账本、V4 schema、Human Gate coordinator 与恢复文件的既有测试 139/139；自动流程、自然讨论、手动持久化与回执回归 159/159。`git diff --check` 通过。尚未重跑完整桌面套件或打包。
- `/tmp/meldwork-105-auto-writer.cjs`：真实 Electron + 原生 Codex/OpenClaw，在独立配置 `/tmp/meldwork-105-auto-writer-bVlg60` 完成自动群聊。运行 `7e52bda4-4eba-42d4-95b8-10424757876d` 为 completed；Codex 写入 `task/result.txt`，OpenClaw 在只读调用中回读核验，最终字节精确为 `MELDWORK_AUTO_105_OK\n`。四次调用均完成，交付负责人由 Codex 显式交接给 OpenClaw。已查看 `/tmp/meldwork-105-auto-writer.png`，脚本退出码 0，Electron 正常关闭。

上述验证不代表任意 Agent 组合均兼容；可恢复 `needs-human`、上下文回放、CLI 环境与启动延迟、剩余通用性问题及最终版本验收仍待完成。

## CLI 网络环境检查点

2026-09-09：登录 shell、版本/能力探测、认证探测及实际子进程使用同一网络配置白名单，保留 HTTP/HTTPS/ALL/NO_PROXY、大小写区别、显式空值和常用 CA 文件配置。OpenClaw 仅额外接收网络配置，原隔离 HOME、运行目录与选定凭据约束继续有效；不继承 `NODE_OPTIONS`、关闭 TLS 验证的变量或无关 Provider 凭据。

代理 URL 中的凭据在诊断、完整答案和分片流中脱敏，覆盖编码/解码形式与 Basic 凭据；错误格式且带用户信息的原始代理值也不直接暴露。此改动处理网络环境被外层丢弃的路径，AWS/Azure/Vertex 等原生 Provider 选择与认证环境仍需继续核查。

验证：

- 网络环境、CLI 探测、子进程、原生 readiness、流式事件与 Main 安全测试 158/158。实际 `/bin/sh` 执行环境采集命令，验证空值覆盖及探测/执行一致性；Windows 变量大小写行为由单元测试覆盖，未进行 Windows 运行验收。
- `npm --prefix desktop run test:agents`：447/447；补充错误格式代理值脱敏后，网络环境与流式协议文件重跑 34/34。`git diff --check` 通过。
- `/tmp/meldwork-105-network-check.cjs`：使用真实 shell 采集、共享子进程环境及系统 curl，通过本机临时 HTTP 代理访问测试域名，代理收到 1 次请求，返回 `MELDWORK_NETWORK_OK`；没有连接外部模型或外部测试站点。
- 独立 Electron 配置 `/tmp/meldwork-105-startup-iYvjcd` 连续两次扫描均保留 12 项安装记录，OpenClaw 可调用；耗时约 12.8 秒、6.7 秒，仅代表该机器本次观察。已查看 `/tmp/meldwork-105-startup.png`，Electron 正常退出。Pi 本机包装脚本损坏与 MiMo 未登录仍显示不可用，未改动用户 CLI 安装或凭据。

尚未重新执行完整桌面测试、打包或更新版本号，V1.0.5 继续处于开发状态。

## 不可用 Agent 的侧栏可见性

2026-09-09：`showInSidebar` 改为独立的用户偏好，不再由 `available` 强制覆盖。已安装但暂时不可用的 Agent 默认保留侧栏入口，显示现有双语不可用原因；新建会话按钮继续禁用，没有历史时点击进入设置，有历史时仍能查看原会话。用户主动隐藏的选择跨刷新、认证失败/恢复及重启保留。

验证：全量前端 36 文件、334/334；workspace、Agent catalog 和 Main 安全测试 146/146；桌面前端构建与 `git diff --check` 通过。旧测试将所有 Agent 标为已安装却只预期可用者可见，已按新的可见性要求调整，未放开新任务可用性校验。

`/tmp/meldwork-105-sidebar-check.cjs` 在独立 Electron 配置 `/tmp/meldwork-105-sidebar-CCOfwl` 验证真实 Pi 不可用时入口可见、原因显示为 `Required capability missing`、新建禁用、点击进入 Pi 设置且不创建会话。通过 preload 主动隐藏 Pi，关闭并重开 Electron 后安装事实和不可用状态仍在、隐藏偏好保留。已查看 `/tmp/meldwork-105-sidebar-status.png`，脚本退出码 0。没有修改日常用户配置或安装。

## 刷新结果一致性检查点

2026-09-09：前端原先并行请求工作区检测和安装目录，但 Main 的安装目录会合并工作区当前的 readiness。目录请求先返回时，同一次刷新可能拿到上一轮认证状态。现在先完成工作区检测，失效 Skill 缓存并发布新快照，再读取依赖该状态的目录。缓存失效发生在快照发布之前，避免 Vue 的 readiness 订阅启动新统计请求后又将其作废。

成功的检测快照不再因后续目录请求失败而丢弃；检测自身失败时仍保留上一次状态，刷新标记可正常退出并允许重试。并发刷新继续合并为一次后续检测。没有新增针对 Agent 品牌或 Skill 内容的分支，也未改变检测、认证或执行权限的判定规则。这是状态一致性修复，尚无启动耗时改善的测量结论。

验证：新增 `agentRefresh.spec.js` 5 项，覆盖旧目录竞态、目录失败、检测失败后重试、缓存失效顺序及并发合并；全量前端 37 文件、339/339 通过。桌面前端构建及 `git diff --check` 通过，仍有既有大 chunk 提示。

最终构建通过 `/tmp/meldwork-105-sidebar-check.cjs` 在独立配置 `/tmp/meldwork-105-sidebar-7JmBzQ` 验证不可用 Pi 保留侧栏原因、新建禁用、点击进入设置不创建会话，以及隐藏偏好跨重启保留；脚本退出码 0，Electron 正常关闭。该运行验证桌面可用性回归，异步返回顺序由上述可控 Promise 测试覆盖。没有改动日常用户配置或调用外部模型。本检查点未重跑全量桌面测试、打包或更新版本号，整体目标仍在开发中。

## 长历史与嵌套调度检查点

2026-09-09：自然讨论原先每轮拼接同一话题的全部 Agent 正文且没有历史限额。现在复用上下文打包器，历史正文限 48,000 字符，单条含标题限 20,000 字符；优先最新贡献和每位成员最近的贡献，再按时间顺序提供上下文。超长单条保留首尾，明确标记中段省略；丢失轮次或原文不可用时声明上下文不完整，提示按需向成员索取缺失依据。原始任务与当前交付负责人继续独立传递，不从裁剪后的文本推断完成。

集成测试发现聊天消息本身已有 20,000 字符上限，直接读取消息会丢掉更长回复的末尾请求。自然讨论现在优先恢复受截断回复的原始 conclusion 产物，核对内容哈希、生产运行、Agent 调用、成员、产物名称和消息前缀。历史组装、路由及重复贡献检查共同使用这份原文。原文不可用时保留可见片段并标记不完整，不把不完整内容当作重复停滞的充分证据。产物原文保持不变，聊天消息存储上限未扩大。

真实调用另暴露内外调度边界不清：Agent 可能在只读提案时继续尝试写入，或在 CLI 内等待外部 Meldwork 成员，而外层必须等当前调用结束才能调度该成员。共用提示现明确提案仅交付初步分析及拟议动作，写入等待后续授权调用；向外部成员交接须在最终回复里提出请求并结束本次调用。外部成员的 @ 名称不能作为原生子 Agent 消息或等待工具的地址。该约定对所有成员一致，不按品牌或 Skill 定制，也不限制 Agent 对任务语义的完成判断。

验证：

- 相关自动流程、自然讨论、写入恢复、回执与上下文文件 156/156 通过；补充交接提示后的自然讨论和上下文文件 38/38；最终增加不完整原文不能证明停滞的覆盖后，上下文文件 8/8。不是全量桌面测试结果。
- 十万字符回复的完整工作区测试验证原任务、首尾依据和省略标记进入下一轮，原始产物在重开工作区后仍完整；21,000 字符后的有效 @ 可以调度对应成员。短历史三份各约 9,000 字符提案仍全文传递。覆盖外部运行、不同 Agent 调用、错误成员、错误产物及缺失原文的拒绝/降级。
- `/tmp/meldwork-105-auto-writer-YXUooL` 首次真实 Electron 验证在四分钟窗口内未结束，Codex 在只读提案中尝试写入并等待，OpenClaw 提案正常；脚本停止任务并正常关闭 Electron，退出码 1，不计通过。
- 补充只读提案边界后的 `/tmp/meldwork-105-auto-writer-70oicr` 完成实际文件写入及 OpenClaw 回读，但负责人收尾超过四分钟窗口；记录出现 CLI 内部等待外部成员，脚本停止任务并退出码 1。文件字节符合要求不等于整项任务验收通过。
- 补充外部成员交接边界后的 `/tmp/meldwork-105-auto-writer-VguzSF` 完成写入及本地回读，负责人正确返回 continue，说明独立回读仍未完成；脚本的四分钟整项观察窗口到期，停止任务并退出码 1。没有记录为通过。
- 最终将验证脚本的整项观察窗口扩大为十分钟，保持任务、产品预算及验收断言不变。`/tmp/meldwork-105-auto-writer-kSAa4K` 的运行 `6ec20638-bcb9-4f53-9679-9b6f93a00807` 正常完成：两位成员只读提案，Codex 第 2 轮写入并返回 continue/回读请求，OpenClaw 第 3 轮实际回读，Codex 第 4 轮给出完成判断。所有 5 次调用均 completed，文件字节精确为 `MELDWORK_AUTO_105_OK\n`，共 21 字节。脚本退出码 0，已查看 `/tmp/meldwork-105-auto-writer.png`，Electron 正常退出。此样本不证明任意组合均稳定，也不构成时延改善的统计结论。
- 首次 `npm --prefix desktop test` 为 1514/1515：唯一失败的原生会话连续性测试仍使用无任务判断的模拟回复，却期待自动继续三轮。按当前显式任务判断协议为模拟负责人补充 continue，保留每个成员三轮相同 Session 与 ACP key 的断言；该文件 6/6 通过，生产完成逻辑未放宽。
- 最终再次执行 `npm --prefix desktop test`：1515/1515，退出码 0，约 308 秒；日志 `/tmp/meldwork-105-desktop-final.log`。之前未确认全量通过的 Gate/ACP 重启路径也在本次全套中通过。`git diff --check` 通过。本检查点未更新包版本或重新打包。

此检查点仍未实现自然讨论按原生 Session 的确认状态去重发送，也未完成可恢复 `needs-human`、剩余 CLI 环境问题或最终版本验收。

## 原生云认证环境与显式 Provider 检查点

2026-09-09：原生调用现在按 Agent 协议白名单传递 Claude 的 Bedrock、Vertex、Foundry、OAuth/API 认证与模型配置，以及 Gemini 的 Google Cloud 项目和 ADC 配置路径。登录 shell 采集及回退均保留显式空值，避免用户清空的配置又被旧进程环境覆盖。云 SDK 配置的存在不直接证明认证成功，新增 AWS access key 也进入完整结果与流式分片脱敏。

选择 Meldwork Provider 后，原生环境只保留当前 Agent 的配置根，排除其他原生凭据和 Provider 选择；网络与 PATH 继续独立传递。真实 Claude CLI 进一步证明 `settings.json.env` 优先于进程环境：仅注入云开关为 0，仍选择原生云 Provider；原生 API 地址和密钥也会覆盖所选值。Claude 协议适配器因此使用高优先级 `--settings` 指定非秘密地址、清除冲突认证选择，并通过原生 `apiKeyHelper` 从子进程环境读取所选密钥。密钥不写入 argv 或临时配置文件，不改写用户原生配置，也不关闭全部设置或 Skills。此处属于必要协议适配，没有新增品牌或 Skill 驱动的业务调度。

认证探测区分证据强度：真实 CLI 在没有实际云凭据时也会返回 `loggedIn: true / third_party`，现在仅标记尚未验证；`api_key` 的肯定状态仍是凭据配置证据，不当作一次实际认证成功。两者均不能在刷新时立即抹去近期运行鉴权失败；没有近期失败时仍允许用户尝试原生运行。

验证与边界：

- 首批 readiness、Provider、CLI 协议和 Main 安全测试 189/189；完善云状态和空值后 Agent 套件 454/454。加入实际 Provider 密钥 helper 后 Agent 套件再次 454/454，Main/Provider 60/60。
- 新增 `cli-claude-provider.test.cjs`：通过 `MELDWORK_TEST_CLAUDE_EXECUTABLE` 指向实际 Claude CLI 的可选集成测试，与两项 helper 测试合计 3/3。使用本机 HTTP/SSE 模拟服务、合成凭据和隔离 HOME，实际 `runAgent` 请求在冲突原生配置下到达所选地址、携带所选密钥并返回 `LOCAL_PROVIDER_OK`；原生设置字节不变。默认未指定真实 CLI 时该集成项明确跳过。
- shell helper 对包含命令替换、引号和控制运算符的合成密钥按数据输出，不执行其中的 shell 文本。Windows helper 使用系统 PowerShell 读取环境变量，已有参数断言，但未在 Windows 主机实测。
- `/tmp/meldwork-105-provider-electron.cjs` 在独立配置 `/tmp/meldwork-105-provider-ui-DBsHOV` 完成真实 Electron 的保存 Provider、刷新 Agent、创建直聊及收取回复。会话 `946a2fac-8177-4471-bc5c-b0ec64eba92c` 显示 `LOCAL_PROVIDER_UI_OK`；两次模拟服务请求均使用所选地址与密钥，原生配置未变。已查看 `/tmp/meldwork-105-provider-ui.png`，脚本退出码 0，Electron 正常关闭。
- 最后补充 API key 配置证据不能清除近期运行失败的修正后，readiness 与 Agent catalog 回归 53/53。完整桌面测试结果另记于下方，不能把不同批次相加为一次全量结果。
- `MELDWORK_TEST_CLAUDE_EXECUTABLE=... npm --prefix desktop test`：1525/1525，跳过 0，退出码 0，约 290 秒；日志 `/tmp/meldwork-105-cloud-desktop.log`。该批次启动后新增了上述 API key 证据分类及两项回归，因此全量数字对应分类修正前的状态；最终分类行为由随后 53/53 的针对性测试覆盖。`git diff --check` 通过，尚未在最终分类修正后重跑整个桌面套件。

未使用真实 AWS、Azure、Vertex 凭据进行外部模型调用；云状态实测证明配置优先级和证据边界，不证明账户权限、配额或模型可用性。动态 `VERTEX_REGION_<MODEL>` 尚未纳入固定环境白名单，其他 Agent 的云 SDK 环境支持仍需核查；也未证明所有 Agent 原生配置均无法覆盖显式 Provider。本检查点未更新版本、重新打包或替换日常应用，完整 V1.0.5 目标仍在开发中。

## 自然讨论增量交付与完成回执检查点

2026-09-09：自然讨论复用现有 prepared/acknowledged/uncertain 交付状态，按接收者、原生 Session、来源绑定、任务快照及消息内容哈希判断已送达消息。只有完整交付且成功确认的消息可以省略；消息修改、会话失效或更换、来源变化和不确定发送均重发。首个任务指令每次保留，省略提示不表达同意或完成。裁剪和缺失原文不进入确认清单，每个来源最多保留 100 条 ID/哈希，不复制聊天正文到交付元数据。

真实 Electron 暴露完成说明与回执存储契约冲突：OpenClaw 在 taskDecision 中给出绝对文件路径，Agent 已完成回读，但公开协作回执拒绝该路径，最终触发 LOCAL_RUN_PERSIST_FAILED/LOCAL_RUN_TERMINAL_PERSIST_FAILED，账本仍为 running。现在在创建及计算回执哈希之前，使用已有 publicCollaborationText 脱敏判断理由与交付说明；原始 Agent-run taskDecision 保留。未改变通用判断解析器、旧账本规范化规则或回执路径校验。

验证：

- 自然增量交付、自然讨论与 V4 记录文件 84/84。新增完整工作区测试覆盖同 Session 去重、Session 失效后完整重建、重开账本与绝对路径完成持久化。修复前路径测试稳定失败，修复后通过。恢复测试原来错误地要求重发第一轮 Codex 内容；该内容已经送达 Hermes，修订为不重发并检查未见的 Hermes 第一轮与 Codex 第二轮仍存在。
- `/tmp/meldwork-105-auto-writer-hUZ52m` 为失败样本：运行 `c32e1810-eb14-43e9-9b01-e3d213fe1886` 文件字节正确、四次调用完成，但终态写入失败。首次脚本退出码 1，不能计作成功。
- 修复后 `/tmp/meldwork-105-auto-writer.cjs` 在独立配置 `/tmp/meldwork-105-auto-writer-Zvz9zk` 完成真实 Codex/OpenClaw 群聊；运行 `9814b377-fb56-467e-a0d7-ad68edb7d163` 的五次调用均完成，任务 completed，result.txt 精确为 21 字节 `MELDWORK_AUTO_105_OK\n`。七条来源交付记录 acknowledged。脚本退出码 0，已查看 `/tmp/meldwork-105-auto-writer.png`，Electron 正常关闭。
- `/tmp/meldwork-105-path-recovery.cjs` 重开上述旧失败样本，保留恢复前账本副本。任务恢复为 completed，Agent 调用仍为四次，没有重复调用；原始判断包含路径，公开回执不包含路径。脚本退出码 0，Electron 正常关闭。已查看 `/tmp/meldwork-105-path-recovery.png`：原有历史停止提示仍在，且前端因该提示隐藏完成卡片。这项界面缺陷尚未修复，不能把账本恢复通过描述为完整恢复体验已通过。
- 首次修复后全量桌面 1534/1535，唯一失败为 OpenClaw ACP 流事件测试读取 ready 文件后过早断言父进程已消费全部 stdout。独立重跑 1/1；随后将测试同步点改为实际收到第五个事件，保留调用尚未结束与全部五个事件顺序的断言，完整 ACP 生命周期文件 11/11。未放宽产品超时或事件协议。
- 最终 `MELDWORK_TEST_CLAUDE_EXECUTABLE=... npm --prefix desktop test`：1535/1535，跳过 0，退出码 0，约 306 秒；日志 `/tmp/meldwork-105-delivery-desktop-verified.log`。`git diff --check` 通过。本轮未改前端，未重新跑前端测试或构建。

本检查点未更新包版本、打包或替换日常应用；剩余目标继续按上方待办推进。

## 持久化任务终态与历史界面一致性

2026-09-09：主进程快照新增最小 runOutcomes 投影，每个可见话题只保留最新发起运行的状态、标识、参与者和时间。读取复用等待审批快照已有的账本读取，不增加一次完整账本克隆；不传递原生 Session、执行正文、配置或完整账本。已删除话题、不同群和未知任务的记录不进入投影。前端对字段、状态、时间、参与者和话题所属群进行校验。

历史运行卡片及话题栏优先使用账本状态。旧失败提示仍作为历史保留，不再隐藏恢复成功后的卡片；整项 partial、round-limit、stopped 等状态不会因为各次 Agent 调用 completed 被覆盖。最新任务运行即使尚无可见回复，也不复用上一次运行的成功记录。活动运行仍优先显示；没有终态投影的旧数据继续使用现有降级展示。单 Agent 历史卡片不再同时展示整项“部分完成”和重复的绿色调用“已完成”，调用状态仍在执行详情中。

验证：

- workspace state 与 Human Gate recovery 文件 29/29，覆盖最新运行选择、群/话题绑定、投影无私有字段与等待审批恢复。
- 全量前端 37 文件、343/343；新增回归验证恢复终态覆盖旧停止消息、任务与调用状态分离、最新运行无回复时不继承旧结果、话题栏状态及中英文文案。桌面前端构建通过，仍有既有大 chunk 提示。
- `/tmp/meldwork-105-outcome-ui.cjs` 重开隔离配置 `/tmp/meldwork-105-auto-writer-hUZ52m` 和 `/tmp/meldwork-105-decisions-Mh7mIS`。真实历史恢复任务显示 Completed，缺材料任务显示 Partially completed，原成功任务显示 Completed；前后账本运行标识与 Agent 调用数量不变，没有新增模型调用。两次脚本均退出 0，Electron 正常关闭。
- 最终查看 `/tmp/meldwork-105-outcome-c32e1810-eb14-43e9-9b01-e3d213fe1886.png` 与 `/tmp/meldwork-105-outcome-7d242ebe-1cc9-4edd-a4ea-bfd704d29f42.png`，确认完成卡片可见、原错误提示保留、单 Agent 卡片没有重复的相反状态。
- 最终 `MELDWORK_TEST_CLAUDE_EXECUTABLE=... npm --prefix desktop test`：1536/1536，跳过 0，退出码 0，约 317 秒；日志 `/tmp/meldwork-105-outcomes-desktop.log`。`git diff --check` 通过；本轮未执行 Web 构建或打包，桌面构建与运行结果如上。

本检查点不改变 AI 的完成判断，不代表人类采用；needs-human 续跑、路由语义和剩余启动检测问题继续开发。尚未更新包版本或打包。

## 原生 shell 配置缓存与手动刷新

2026-09-09：复现相同 PATH 下修改合成认证配置仍返回旧缓存值。原缓存只绑定平台、HOME、shell 与 PATH，手动刷新也不会重新采集 shell 配置，可能继续使用最多 30 秒的旧配置。现在缓存键包含允许传递环境的 SHA-256 摘要，不保存原始凭据作为键；环境值变更、移除和显式清空都会改变缓存身份。串行 Agent 刷新在检测与认证检查前强制重新采集原生 shell 配置，同一轮后续调用共享新缓存。

验证与边界：

- readiness 与 Main 安全测试 87/87，覆盖真实 shell 配置文件修改、显式刷新、缓存复用、环境清空及刷新顺序；日志 `/tmp/meldwork-105-shell-refresh-focused.log`。
- Agent 套件共 460 项，459 通过、1 项可选真实 Claude 集成测试因未配置 executable 跳过，失败 0；日志 `/tmp/meldwork-105-shell-refresh-agents.log`。不能把该结果写成全部真实 CLI 均已完成调用。
- `/tmp/meldwork-105-shell-refresh-ui.cjs` 使用隔离 Electron 配置、临时 shell 和合成本机地址，通过真实 preload refreshAgents 验证：修改文件后刷新前仍为缓存地址，手动刷新后立即读到新地址，前后 12 个 Agent 条目一致且包含 OpenClaw。首次成功配置 `/tmp/meldwork-105-shell-refresh-CGjibK`，脚本退出 0，Electron 正常关闭，没有模型调用，也没有修改日常 shell 配置。已查看 `/tmp/meldwork-105-shell-refresh.png`。
- 前期验证脚本因 Playwright 求值环境没有 require、process.mainModule 不存在及绝对路径导入 Electron 得到包路径而失败，均未执行到产品刷新断言；最终改用隔离启动器提供只读取合成地址的验证函数，不新增产品接口。
- 修改前两次真实版本/能力扫描为 2343ms 与 1935ms，均返回 12 个条目；这是基线，不是提速证据。本次不改变探测调度或能力缓存策略。

本检查点未重跑完整桌面或前端套件、构建与打包，之前 1536/1536 桌面全量结果对应本次缓存改动之前。群聊语义路由、可恢复 needs-human 与最终版本验收仍未完成，版本号尚未更新。

## 自然讨论的明确协作请求

2026-09-09：移除 Agent 回复正文中的 @ 正则派发。自然讨论使用已有 taskDecision 回执中的可选 nextKinds 表达下一批请求成员；正文可以自由讨论、引用或否定提及，不触发新调用。请求由 Agent 决定，运行层仅校验成员标识、活动参与者和状态契约。没有请求时仍由交付负责人判断继续、完成或阻塞，不将空列表解释为任务成功；用户输入的 @ 选择不受此改动影响。

nextKinds 使用最多 32 个唯一标识，与现有 V4 成员上限一致；大小写统一为小写，不接受空标识、命令文本或不存在的参与者。非空列表要求 continue；未知参与者混入时整批不派发，也不当作接受结果。字段沿用现有调用上下文、回执和账本持久化，恢复时读取绑定的请求，不重新解析正文。旧判断不包含 nextKinds 时仍可读，不改写既有理由、交付物或历史规范化结果。

验证与实际失败：

- 新增中英文否定提及、历史未知成员、空/缺省请求、成员大小写、重复及越界请求测试。原有顺序、并发、预算、会话连续性与恢复测试的模拟 Agent 改为显式请求回执；保留原调用顺序和账本断言。最终针对性协议/否定提及/路由恢复文件筛选 6/6。
- 第一轮完整桌面 1542 项，1541 通过、1 项可选 Claude 集成跳过、失败 0，日志 `/tmp/meldwork-105-routing-desktop.log`。运行期间补充了成员标识大小写规范化，因此不能以这轮结果证明最后代码的全部覆盖。
- 首次真实 Electron 样本 `/tmp/meldwork-105-auto-writer-124GBI` 已写出正确文件，但 Codex 请求标识为 OpenClaw，原严格小写解析触发 LOCAL_RUN_TASK_DECISION_INVALID，运行 `ea88ef57-c9cc-48e7-8113-9baa93df8454` 为 partial，脚本退出 1。该失败未计为通过；依据原始最终回复增加通用大小写规范化，并在提示中列出准确标识，没有按品牌分支。
- 修正后 `/tmp/meldwork-105-auto-writer-HE04nu` 的运行 `bfeec25e-2202-4180-9d38-9afcd3188181` 完成两位成员提案、Codex 写入与 readback、OpenClaw 独立回读、Codex 最终判断。5 次调用均 completed，文件精确为 `MELDWORK_AUTO_105_OK\n` 共 21 字节，账本任务 completed。两次 nextKinds 分别为 openclaw、codex，最终为空。负责人最终正文包含描述性的 @openclaw，没有再次派发。
- `/tmp/meldwork-105-auto-writer.cjs` 退出 0，Electron 正常关闭；已查看 `/tmp/meldwork-105-auto-writer.png`，正文不泄露回执、整项完成卡片可见。单次实际任务不证明所有 Agent 组合稳定。
- `/tmp/meldwork-105-outcome-ui.cjs /tmp/meldwork-105-auto-writer-HE04nu` 重开已完成任务，完成卡片仍正确显示，运行标识与调用数量不变，无新模型调用；脚本退出 0，已查看 `/tmp/meldwork-105-outcome-bfeec25e-2202-4180-9d38-9afcd3188181.png`。
- 第二轮 `MELDWORK_TEST_CLAUDE_EXECUTABLE=... npm --prefix desktop test`：1542/1542，跳过 0，退出 0，约 319 秒；日志 `/tmp/meldwork-105-routing-final-desktop.log`。该轮启动后仅将 nextKinds 上限从 16 对齐现有 32 成员上限并补充边界断言，最终协议和完整自然讨论文件再次 37/37，退出 0，日志 `/tmp/meldwork-105-routing-final-focused.log`。不将不同批次计数相加。
- `git diff --check` 通过。本轮未改前端源码，未重跑前端测试、构建或打包；桌面实际运行与历史重开验证如上。

本检查点未改变人类采用的含义，needs-human 仍待接入可恢复人类决定流程。尚未更新版本号、构建、打包或替换日常应用。

## 自然讨论的人类输入与重启恢复

2026-09-09：交付负责人返回 needs-human 后，通过现有输入 Gate 等待用户澄清，回复后继续同一任务，不再直接结束为 partial。新增 v4_task_decision continuation，绑定实际已完成的来源调用、讨论轮次、slot、operation、任务快照和判断哈希；重启恢复验证来源与当前负责人，避免重放已完成的提问。原生 CLI 暂停输入仍使用既有 session/request 绑定，用户澄清不会增加工作区写权限。

重复提交已记录 Gate 决定时保留原决定时间，并在校验内容一致后返回，不重复触发恢复回调；冲突决定仍被拒绝。关闭应用时保留待输入 Gate，取消输入则停止任务。已批准的回答经来源校验后进入现有有界上下文打包。

验证：

- 新增任务输入测试 7/7，覆盖 agent-led/sequential、取消、等待时重启、来源与选项篡改、批准后分发前恢复、重复提交，以及 continuation 检查点后下一次调用前恢复。Gate/账本/任务输入针对性验证 74/74。
- 最终桌面全量 1549/1549，失败和跳过均为 0，退出码 0，约 311 秒。命令为 `MELDWORK_TEST_CLAUDE_EXECUTABLE=/Users/rydersun/.local/opt/npm-global/bin/claude npm --prefix desktop test`，日志 `/tmp/meldwork-105-human-task-desktop.log`；该轮包含最终产品代码。
- 真实 Electron 脚本 `/tmp/meldwork-105-human-task-ui.cjs /tmp/meldwork-105-human-task-3UxpAQ` 退出 0，正常关闭应用。复用已有任务，两次调用完成后账本 waiting；关闭并重开仍保留输入，界面提交后仅新增一次调用，答案为 HUMAN_DECISION_105_OK，任务和 continuation 均 completed。重复通过真实 preload 提交相同回答，调用总数仍为 3；群组 allowWrite 仍为 false。
- 已查看 `/tmp/meldwork-105-human-task-waiting.png` 和 `/tmp/meldwork-105-human-task-completed.png`，确认恢复后的输入入口与最终完成卡片。等待截图捕获在面板过渡过程中，不能用其透明度判断静止界面样式。
- 前期验证脚本曾因 onboarding 遮挡、异步 waitForFunction 判断及误读活动快照 status 而退出或超时，未计入成功。最终使用真实账本及 waitingGateIds 判断，并复用已有等待任务，没有重发任务制造新样本。

本检查点未修改前端源码，未重新构建或打包，版本仍为 0.1.4。剩余通用调度耦合、CLI 环境覆盖与最终版本验收继续推进；此输入流程不代表人类采用或写入授权。
