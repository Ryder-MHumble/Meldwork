# Meldwork Landing 审查与优化依据

审查日期：2026-09-06。工作分支：`feature/landing-experience`。
范围：PM 定位与文案、GEO 可理解性、UI/UX、响应式视频过渡。
状态：实现与浏览器回归完成。PM、GEO、UI/UX 子代理分别审查，另由独立代码审查子代理检查交互与降级路径。

旧页面证据采用 `origin/main` 基线 `381b8fefef0bceb159b2e44c6752354fe36b620c`。
下文 `baseline:path:line` 指该提交中的文件，避免与正在修改的 landing 行号混淆。
架构、许可证和运行时引用来自本次读取的工作区；文档描述不等于所有 CLI/Provider 的实时认证。

## 首屏定位

旧首屏以 “Multi-Agent Work, Legible & Accountable” 为标题，品类和具体用途留在较长副标题中。
证据：`baseline:meldwork-landing/index.html:142`、`:147`。
“组织层”能承接产品方向，但首次访问者还需要立即知道它是桌面工作空间、需要本地 Agent、能协助哪类工作。
`AI coding agents` 又把定位限制在编程，与研究、产品分析的目标用户不一致。
证据：`baseline:meldwork-landing/index.html:7`；`README.zh-CN.md:31`。

建议首屏以 Meldwork 为明确品牌标题，副标题说明“让多个 Agent 围绕同一任务协作，由你检查过程与结果”。
紧接着呈现真实产品界面和具体任务，减少只有抽象氛围、没有可检查产品状态的首屏。
主行动保持下载；同屏说明 Apple 芯片 macOS 预览版和所需本地 Agent，避免下载后才暴露前置条件。
可见文字应传达产品与使用场景；设计意图、GEO 方法、动画机制留在文档中。

## 实际能力与证据边界

| 页面事实 | 已读取证据 | 文案约束 |
| --- | --- | --- |
| 本地优先 Electron 桌面工作空间 | `architecture.md:5`、`:7` | 不称为在线 SaaS，不让访问者误以为网页就是完整产品 |
| 用户选择参与者；直接会话、并发回复、自动讨论 | `README.zh-CN.md:48`、`:49`、`:50`、`:52` | 不承诺自动从全量 Agent 名单选人；会话能力取决于适配器支持 |
| 12 个内置 Agent 档案 | `desktop/src/agents/cli/cli-discovery.cjs:13` | “12 个内置适配器”比“12+”准确，不暗示随应用捆绑 CLI |
| 冻结上下文、结果、有限运行记录与人工审批 | `architecture.md:16`、`:18`、`:19`、`:20`、`:21` | 不把每条输出等同于已核实事实，不承诺记录所有内部推理 |
| 本地保存会话，Agent 仍可访问 Provider | `architecture.md:69`、`:75`、`:76` | 去掉易被理解为离线或数据绝不外发的“100% local” |
| 写入权限是工作流控制 | `README.zh-CN.md:140`；`architecture.md:97` | 不称为操作系统沙箱，不承诺任何 Agent 都无法越权 |
| 当前许可是 Apache-2.0 | `LICENSE:1`、`:2`；`desktop/package.json:7` | 以 LICENSE 为准，不能照抄旧 README 的非商业限制 |

旧页面 JSON-LD、FAQ、页脚仍写 V1.0.3 和非商业许可证。
证据：`baseline:meldwork-landing/index.html:22`、`:60`、`:637`、`:673`。
当前下载事实由实施负责人通过 GitHub API 实时核对：发布标签 `Meldwork-V1.0.4`，资源 `Meldwork-0.1.4-arm64.dmg`，大小 `124249572 B`。
此处记录负责人提供的 API 核验结果；本审查子任务未独立下载、安装或验证该二进制。
发布标签 V1.0.4 与应用包版本 0.1.4 是不同字段，JSON-LD 应与实际软件版本一致（`desktop/package.json:3`）。
旧页的 78 MB 不应继续沿用；下载大小可省略，避免下一版再次漂移。

## 信息架构

建议阅读顺序：品牌与用途 → 实际工作界面 → 适合的任务 → 三种协作模式 → 上下文与复核边界 → 开始使用与 FAQ。
每个章节只回答一个采用问题，并以真实截图、可检查状态或具体行为支撑结论。
把旧页重复的 definition、capabilities、difference、boundary 内容合并，减少抽象术语反复出现。
产品截图保持可辨认比例，提供放大入口；演示对话明确标注示例，不冒充真实运行或客户成功案例。
比较内容描述 Meldwork 的选择和适用场景，不再宣称“终端一次只能运行一个 Agent”。
该表述出现在 `baseline:meldwork-landing/index.html:628`，既不准确，也降低比较内容的可信度。
将架构、Agent 设置、许可证和发布记录作为事实来源链接，而不是塞进正文的长篇实现说明。

## 视频过渡

现有 H3 背景素材具有可复用价值，本轮方案优先复用 `assets/meldwork-bg-v2.mp4` 与对应静帧。
本轮已实现素材复用与连续退场，没有调用 H3 生成新视频。ffprobe 确认素材为 1440×704、24fps、8.032 秒。
旧页两个 video 播放同一素材，并在片尾交叉淡化；这是循环接缝处理，不是章节转场。
证据：`baseline:meldwork-landing/index.html:129`；`baseline:meldwork-landing/main.js:519`。
旧背景绝对定位于 hero，正文另行流动；hero 又叠加缩放与内容透明度变化。
证据：`baseline:meldwork-landing/styles.css:392`；`baseline:meldwork-landing/main.js:571`。

固定尺寸视频与响应式排版分别处理：视频通过 `cover` 保持比例并裁切，DOM 文本通过网格、换行与断点重排。
`cover` 只解决铺满，不保证主体安全区；宽屏和竖屏必须分别检查裁切焦点，不能直接拉伸视频。
采用一个连续首屏场景：滚动离开时背景统一退场，接入稳定的正文底色；正文不随视频时间轴移动。
避免每章切换一条视频，否则不同镜头、比例、亮度和加载时机都会放大断裂感。
媒体层不决定正文高度；保留静帧，并在播放失败、减少动态效果、页面离开可视范围时按策略降级或暂停。
若现有素材的主体位置仍无法适配，再设计 H3 prompt：稳定构图、中心安全区、边缘可裁切、无内嵌文字、低运动幅度、首尾可衔接。
生成前先确定镜头在页面中的职责与宽竖屏裁切样例，再评估是否确需单独竖屏素材；不能用生成更多视频替代布局修复。

## 双语索引与 GEO

GEO 的目标是让搜索与 AI 系统准确提取“是什么、适合谁、支持什么、边界是什么”，不保证排名、引用率或富结果展示。
旧页已有静态正文、SoftwareApplication 与 FAQPage，值得保留；问题主要是事实过期、定义过窄和双语覆盖不足。
证据：`baseline:meldwork-landing/index.html:13`、`:30`、`:592`；旧页 `html lang` 固定为 `en`（`:2`）。
中文定义：Meldwork 是本地优先的多 Agent 桌面工作空间，让你选择已安装的 Agent，围绕任务协作，并检查运行记录、结果与权限。
英文定义：Meldwork is a local-first desktop workspace for multi-Agent collaboration, with user-selected Agents, inspectable runs, and explicit permissions.
标题、描述、正文、FAQ 和结构化数据必须描述同一产品；语言切换同步 `lang`、可访问名称和元数据。
静态 HTML 应包含可读内容，不能只把中文藏在脚本对象里便声称中文已被独立索引。
若采用纯客户端切换，应明确其索引局限；需独立中文索引时，再部署可抓取的独立语言 URL。
FAQ 优先回答：需要安装哪些 CLI、三种模式如何选择、是否离线、何时写入、支持平台、软件与 Provider 费用、许可证。
同一问答的 DOM 与 JSON-LD 保持一致，避免双份文案各自漂移；不添加虚构评分、排名、客户数量或证言。
公开域名目前未知：canonical、hreflang、OG 绝对 URL 与 sitemap 等待真实部署地址，不使用虚构域名或 localhost 作为正式标识。
确认部署后再检查各语言 URL 的 HTTP 状态、互相引用和可抓取性；已有 GitHub 架构、LICENSE、release 链接可作为事实来源。

## 可访问性

旧 `.reveal` 默认透明并依赖脚本显现；脚本失败或禁用时，关键正文可能始终不可见。
证据：`baseline:meldwork-landing/styles.css:762`。应让内容默认可见，动态效果作为增强层。
背景视频超过五秒时提供明确的暂停控制；减少动态效果模式应停掉媒体与相关持续动画，不能仅缩短 CSS 时长。
菜单支持键盘、Escape、关闭后焦点归还与必要的滚动锁定；截图放大支持同样的关闭路径。
模式选择、语言切换、FAQ、媒体控制都有可理解名称、可见焦点及正确状态；颜色不是唯一状态信号。
检查 200% 缩放、中文长句、窄屏导航与下载按钮，避免文本被裁切或遮挡后续内容。

## 验证矩阵

| 检查 | 通过条件 | 当前记录 |
| --- | --- | --- |
| 产品事实 | 版本、许可、Agent 数量和边界与证据一致 | 已复核；下载版本 V1.0.4、应用版本 0.1.4、Apache-2.0、12 个适配器 |
| 桌面与手机 | 常见宽屏、短屏、竖屏无横向溢出、遮挡或异常裁切 | 中英各 7 组视口通过；设计师另外检查 8 组语言/主题组合；已查看运行视频下的桌面和手机截图 |
| 转场与媒体 | 首屏退场连续；播放失败有静帧；离屏暂停；正文稳定 | 像素非空且随时间变化；循环交叉淡入中暂停/恢复通过；离屏停止、静帧回退和动态偏好切换通过 |
| 双语 | 两种语言正文、标题、FAQ、按钮、辅助名称一致 | 切换、刷新持久化和存储被阻止时的降级通过 |
| 可访问性 | 键盘完整闭环；焦点可见；减少动态效果和无脚本可读 | 菜单焦点、Escape、截图 tabs、原生 FAQ、无 JS 和减少动态效果通过；axe 4 组 WCAG 2 A/AA 与 2.1 AA 检查无 violation |
| GEO | JSON-LD 可解析、与正文一致；实际部署后验证索引地址 | 6 项默认英文 FAQ 与 schema 一致，切换后同步中文；未虚构正式域名与索引结果 |
| 下载与资源 | CTA 指向已核验发布；图片视频无损坏或错误路径 | GitHub API 已核验资源；全部本地引用存在，4 张产品图成功解码且 contain 显示 |

最终执行：`node --check meldwork-landing/main.js`、`git diff --check`、`PLAYWRIGHT_MODULE=/Users/rydersun/.npm/_npx/e41f203b7505f1fb/node_modules/playwright node --test meldwork-landing/tests/landing.test.cjs`。浏览器回归 8/8 通过，耗时约 47 秒。

视口：1920×1080、1440×900、1280×720、768×1024、390×844、320×568、720×450。正常手机/桌面首屏能看到下一节提示；小尺寸和缩放情况下正文保持可滚动。

完整回归截图：`/var/folders/k7/4n40pkld6s35zjrfgvhpf_h00000gn/T/meldwork-landing-check-XL1fZS/`。
最终运行视频截图及转场中间帧：`/Users/rydersun/.codex/visualizations/2026/09/05/01a07207-a542-7422-8268-b0e3a34d02f1/`，文件为 `landing-desktop.png`、`landing-mobile.png`、`transition-middle.png`、`transition-end.png`。

独立审查发现无 JS 时语言按钮因 CSS 优先级仍然显示，已修复并补入回归。快速切换动态效果时媒体按钮状态更新滞后，已将停止与状态同步集中处理。HTML 排版空白不再影响 FAQ schema 对齐。

验证限制：未执行真实屏幕阅读器认证；自动化 Chrome 的两个页面始终报告 visible，真实切后台暂停未取得独立运行证据，相关 visibilitychange 分支已代码复核。未运行 Electron 构建、打包或应用全套测试，本轮没有修改桌面执行路径。正式域名、独立中文 URL 与上线索引检查仍需在部署环境验证。
