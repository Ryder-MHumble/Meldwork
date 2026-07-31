# Meldwork 文档

Meldwork（工作名）是一个本地优先的 Agent 工作系统。当前仓库是一个 Electron MVP：它把已支持的本地 Agent CLI 放进同一个持久工作空间；长期方向是成为连接本地 Agent、Cloud Agent 与工作渠道的开放 Harness 基座。

本目录是项目唯一的产品与工程文档入口。`documentation/` 已合并到这里；`archive/` 只保留历史战略版本，不能作为当前产品承诺。

## 核心文档

| 文档 | 用途 | 当前决策 |
| --- | --- | --- |
| [市场与用户调研](market-user-research.md) | 判断为什么做、为谁做、先验证什么 | 开源优先，商业化可选 |
| [产品迭代规划](product-iteration-plan.md) | 把愿景拆成一个 OPC 能执行的优先级路线 | 先建立 Harness 基座，再扩展 Cloud/Channel |
| [产品 BP](product-bp.md) | 对外解释定位、价值、增长和后续收入 | 先积累开源资产与用户信号，不急于卖席位 |

## 配套文档

- [品牌策略](brand-strategy.md)：工作名、阶段化 Slogan、Logo 和传播边界。
- [发布与 PR 素材](launch-kit.md)：README、发布帖和演示口径。
- [架构](architecture.md)：Electron、Renderer、Main、Connector 边界。
- [流程](flows.md)：工作流与状态流转。
- [权限边界](permissions.md)：本地执行、Provider、Installer 和写入权限。
- [自动化](automation.md)：当前自动讨论与外部副作用清单。
- [测试与验证](tests.md)：已执行检查、缺口和发布门槛。
- [变量与密钥](variables.md)：Provider、Agent 凭证和本地运行变量。

## 口径

- **已实现**：当前仓库和测试可以直接支持的能力。
- **验证中**：已经有原型或实验，但还没有稳定的用户/可靠性证据。
- **路线图**：希望通过 Connector、Task、Artifact、Evidence 等机制交付的未来能力。
- **商业假设**：定价、付费和团队治理相关假设，不能写成当前功能。

对外宣传只能把第一类写成“现在可以用”。第二、三类必须带上阶段或路线图说明，第四类必须带“待验证”。

## 当前一句话

> **Meldwork brings the agents you already use into one local, accountable workspace.**
>
> **Meldwork 把你已经在用的 Agent 带进一个本地、可追溯的工作空间。**

## 目标一句话

> **An open harness for work that can move between agents without losing context, control, or proof.**
>
> **一套开放的 Agent Harness，让工作可以在不同 Agent 之间流转，同时保留上下文、控制和证据。**
