# Meldwork 文档

Meldwork 是一个本地优先的 Agent 工作系统。当前仓库是一个 Electron MVP：它把已支持的本地 Agent CLI、Skill、图片和显式知识来源放进同一个持久工作空间；长期方向是成为连接 Agent、知识上下文、Cloud Agent 与工作渠道的开放工作基座。

本目录是项目唯一的产品与工程文档入口。`documentation/` 已合并到这里；`archive/` 只保留历史战略版本，不能作为当前产品承诺。

## 核心文档

| 文档 | 用途 | 当前决策 |
| --- | --- | --- |
| [市场与用户调研](market-user-research.md) | 判断为什么做、为谁做、先验证什么 | 聚焦 Agent + Knowledge + Outcome，不做聚合聊天器 |
| [产品迭代规划](product-iteration-plan.md) | 把愿景拆成一个 OPC 能执行的优先级路线 | 先完成 Context Pack 与 Task Outcome，再扩展 Cloud/Channel |
| [Harness Engine 战略](harness-engine-strategy.md) | 定义异构 Agent 接入、动态协作、业务 Pack 与商业化路径 | 任意 CLI 是入口，Connector、Evaluation、Outcome 与业务交付才是壁垒 |
| [产品 BP](product-bp.md) | 对外解释定位、价值、增长和后续收入 | 开源优先，以重复使用和标准化回款决定商业化 |

## 配套文档

- [品牌策略](brand-strategy.md)：工作名、阶段化 Slogan、Logo 和传播边界。
- [发布与 PR 素材](launch-kit.md)：README、发布帖和演示口径。
- [公开 MVP 发布清单](public-mvp-release.md)：首发范围、阻断项、验证和仓库公开步骤。
- [macOS 签名与公证](macos-signing.md)：Apple Developer 申请、证书、electron-builder 配置和验收。
- [架构](architecture.md)：Electron、Renderer、Main、Connector 边界。
- [流程](flows.md)：工作流与状态流转。
- [权限边界](permissions.md)：本地执行、Provider、Installer 和写入权限。
- [自动化](automation.md)：当前自动讨论与外部副作用清单。
- [测试与验证](tests.md)：已执行检查、缺口和发布门槛。
- [变量与密钥](variables.md)：Provider、Agent 凭证和本地运行变量。

## 口径

- **已实现**：当前仓库和测试可以直接支持的能力。
- **验证中**：已经有原型或实验，但还没有稳定的用户/可靠性证据。
- **路线图**：希望通过 Context Pack、Connector、Task、Artifact、Evidence 等机制交付的未来能力。
- **商业假设**：定价、付费和团队治理相关假设，不能写成当前功能。

## 协议文件

- [许可证](../LICENSE)
- [商业使用政策](../COMMERCIAL_USE.md)
- [声明](../NOTICE)

对外宣传只能把第一类写成“现在可以用”。第二、三类必须带上阶段或路线图说明，第四类必须带“待验证”。

## 当前一句话

> **Meldwork brings the agents and knowledge sources you already use into one local, accountable workspace.**
>
> **Meldwork 把你已经在用的 Agent 和知识来源带进一个本地、可追溯的工作空间。**

## 目标一句话

> **An open, local-first work system where context and outcomes can move between agents without losing control or proof.**
>
> **一套开放、本地优先的 Agent 工作系统，让上下文和结果可以在不同 Agent 之间流转，同时保留控制和证据。**
