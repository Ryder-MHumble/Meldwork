<p align="center">
  <img src="frontend/public/logos/meldwork-readme-banner-zh-CN.png" alt="Meldwork：Agent 可切换，工作不断线" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

# 多个 Agent，一项完整的工作

**Meldwork 把不同 AI Agent 放进一个持续的本地工作空间：上下文不重置，协作过程可见，最终决定权始终在人。**

Agent 越来越强，工作反而越来越碎。一个负责写作，一个擅长研究，另一个更适合审查。现在真正困难的已经不是得到一句回答，而是在工具不断切换时，让上下文、过程和决策保持完整。

Meldwork 把你已经在用的 Agent 带进单聊与工作群组，同时不把你的工作变成另一个托管在云端的孤岛。

[PolyForm 非商用许可证](LICENSE) · [商业使用](COMMERCIAL_USE.md) · [声明](NOTICE)

## 别再反复重建上下文

今天多数所谓的多 Agent 工作流，本质上仍然只是更复杂的窗口切换：

- 每换一个工具，就重新解释一次任务；
- 在彼此割裂的会话之间搬运决策、文件和中间结果；
- 手动判断谁该回答、质疑、修改或继续；
- 最终回答一旦足够流畅，之前发生过什么反而无从追踪。

**这不是协作，只是上下文税。**

Meldwork 把任务、会话、参与者、权限和运行记录留在一起。换一个 Agent 加入，也不需要你从头拼回整项工作。

## 一个工作空间，角色各自清楚

| 你真正需要的 | Meldwork 带来的改变 |
| --- | --- |
| 让一个 Agent 快速回答 | 发起聚焦的单聊，并在之后继续同一项工作 |
| 引入第二种判断 | 把选定的 Agent 放进同一个工作群组 |
| 得到真正的质疑，而不是礼貌附和 | 启动有轮次上限的多 Agent 讨论，由你决定讨论边界 |
| 确认过程里到底发生了什么 | 看清谁在排队、执行、完成或失败，并把运行轨迹留在会话中 |
| 掌控自己的工作环境 | 会话与编排状态保留在本机，工作区写入权限明确可见 |
| 自由选择不同厂商 | 连接已支持的 Agent，同时保留原有账号、Provider 与各自能力 |

## 真正不同的地方

### 一个 Agent 够用时，就只用一个

Meldwork 不会强迫每项任务都经过一场会议。只有当不同能力、独立尝试或对抗式审查确实有价值时，再加入另一个 Agent。

### 让 Agent 彼此交锋，但不给流程失控的机会

工作群组可以让选定的 Agent 自动进行多轮讨论。你设定边界，观察运行过程，并决定哪些结果值得留下。

### 留住的不只是最终回答

持续会话、兼容条件下的原生 Session 延续、可见的运行状态、Skill、图片与收集到的产出，都与产生它们的任务保持关联。

### 机器仍然由你掌控

Meldwork 坚持本地优先。工作区访问是明确的，兼容的敏感凭据使用操作系统安全存储，Agent 执行始终位于桌面应用的受控边界内。

## 适合这些不能只靠一次回答的工作

- **深度研究：** 一个 Agent 收集证据，另一个专门攻击假设。
- **产品与战略：** 一个完善方案，另一个寻找代价最高的错误。
- **写作与内容：** 一个创作，另一个检查事实、结构和语气。
- **软件开发：** 一个实现，另一个审查代码以及代码背后的判断。
- **复杂运营：** 不同 Agent 负责各自擅长的部分，完整任务仍然留在同一个地方。

重点从来不是使用更多 Agent，而是让每个环节使用更合适的 Agent，同时不把一项工作拆得支离破碎。

## 现在可以接入的 Agent

Meldwork 当前可连接：

**Codex · Hermes · OpenClaw · WorkBuddy · Kimi Code · MiMo Code · Claude Code · Gemini CLI · OpenCode · Qwen Code**

每个 Agent 仍然保留自己的能力、Provider 配置、权限模型和 Session 行为。实际可用性取决于已安装的 Agent、对应版本与用户配置。

## 本地优先，但不假装互联网消失了

会话、群组和编排状态保留在你的电脑上。模型请求仍然遵循你选择的 Agent 与 Provider。Meldwork 让工作空间留在本地，但不会把第三方模型伪装成离线服务。

## 在本地运行 Meldwork

当前桌面目标为 macOS，需要 Node.js 20.19 或更高版本以及 npm。

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

## 许可证

Meldwork 以 [PolyForm Noncommercial 1.0.0](LICENSE) 许可证开放源代码。符合许可证条款的非商业使用无需额外授权；商业使用需要单独签署书面协议，详见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
