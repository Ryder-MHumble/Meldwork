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
3. 群聊路由及上下文：检查正文引用、未知 @、强制公平轮转与重复全文回放，保留 Agent 的自主协作选择。
4. 启动检测：继续检查环境恢复、探测超时、Keychain 状态与执行事实一致性；首次扫描等待仍长。
5. 通用性：继续落实 review 中与当前范围有关的品牌/Skill/媒体词路由问题，业务核心不依赖指定 Agent；Pi 空能力探测已收紧。
6. 完成真实 Electron 群聊写文件、完成/阻塞、失败隔离、取消和重启恢复验收，再更新版本、复测和生成最终版本说明。

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
