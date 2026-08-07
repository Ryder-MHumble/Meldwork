# Meldwork 核心能力录屏场景

本文用于录制 README GIF、产品演示片和后续社媒视频素材。所有场景都以当前客户端已经具备的能力为基础，不把 Cloud Agent、Channel、自动选人或无条件断点续跑拍成现有功能。

核心叙事只有一条：

> **一项任务先由一个 Agent 开始；需要时加入第二种视角；讨论被限制在明确边界内；用户检查证据后做最终决定。**

## 一、录制基线

### 环境

- 使用当前仓库源码启动的 Electron 客户端，不使用旧安装包。
- 建议使用 Apple 芯片 Mac、英文界面和一个单独的演示用户数据目录。
- 准备两个已经通过就绪检测的通用 Agent。优先使用 Codex 与 Hermes；若其中一个不稳定，可以替换，但需要同步修改场景 4 的角色名。
- 不使用 OpenCodeReview 承担通用对话任务，它只作为专项审查目标。
- 使用一个复制出来的演示工作目录，不直接展示真实项目、个人目录或生产数据。
- 演示目录至少包含 `docs/architecture.md` 与 `docs/tests.md`。
- 默认关闭工作目录写入权限。需要展示写入时，单独创建可丢弃目录并明确开启。

### 录制规格

- 主素材：`2560 × 1440` 或 `1920 × 1080`，16:9，30 fps。
- GIF：每段保留 8-12 秒，导出 12-15 fps，宽度 1280 px，单文件尽量低于 8 MB。
- 鼠标移动保持缓慢，点击前停留约 0.5 秒，不使用快速甩动和连续缩放。
- 只保留真实产品界面、少量字幕和必要的局部放大，不加入通用机器人、粒子或网络节点素材。
- 系统时间、通知、用户名和完整本地路径应在录制前隐藏。

### 推荐演示数据

| 项目 | 建议内容 |
| --- | --- |
| 单聊名称 | `Positioning Review` |
| 群组名称 | `README Decision Room` |
| 工作目录 | 一个只包含演示仓库副本的目录 |
| Agent 数量 | 单聊 1 个，群组 2 个 |
| 自动讨论最大轮数 | 2 轮 |
| 写入权限 | 默认关闭 |
| 附件 | `docs/architecture.md`、`docs/tests.md` |

## 二、场景总览

| 场景 | 核心能力 | 建议成片时长 | README GIF |
| --- | --- | ---: | --- |
| 1. 回到一项真实任务 | 持续单聊、兼容 Session、行内运行状态 | 10-15 秒 | 是 |
| 2. 先确定工作边界 | 工作目录、只读模式、显式权限 | 8-12 秒 | 是 |
| 3. 只加入必要上下文 | 文件附件、单 Agent 点名、来源约束 | 12-18 秒 | 是 |
| 4. 两个 Agent 设置两轮上限 | 群组、自动讨论、最大轮数 | 18-25 秒 | 是 |
| 5. 检查后再接受 | Agent/轮次切换、上下文、脱敏事件、单 Agent 修订 | 18-25 秒 | 是 |

## 三、场景 1：回到一项真实任务

### 目的

展示 Meldwork 不是一次性问答窗口。用户可以回到同一个 Agent 单聊，看到此前结论，并继续下一步。

### 前置准备

1. 提前创建一个名为 `Positioning Review` 的单聊。
2. 在会话中保留一条已经完成的定位讨论，最后一条结论应清晰、简短。
3. 确认该 Agent 当前就绪，且会话没有运行中的任务。

### 操作步骤

1. 从工作台或左侧栏打开 `Positioning Review`。
2. 停留 1 秒，让历史对话完整出现。
3. 输入并发送以下英文指令。
4. 保留 Agent 行内运行状态和回答开始出现的过程。

### 英文测试指令

```text
Resume this task from the existing conversation. State the last confirmed decision in one sentence, identify the next smallest deliverable, and continue without modifying files.
```

### 预期可见状态

- 同一个单聊标题与历史消息保持不变。
- 运行状态直接显示在对话时间线中，不需要打开群组 Run 详情。
- Agent 能引用上一轮已经确认的决定，并给出下一步。
- 本轮不产生文件修改。

### 验收检查

- 回答没有把任务当作全新会话重新介绍。
- 没有重复创建第二个单聊。
- 回答完成后刷新或重新打开会话，消息仍然存在。
- 若 Agent 不支持稳定 Session，也必须能够基于 Meldwork 保存的明确会话上下文继续，而不是声称拥有不存在的原生历史。

### GIF 剪辑点

从点击历史会话开始，到第一句引用既有决定的回答出现为止。建议 10 秒，结尾停留 1 秒。

## 四、场景 2：先确定工作边界

### 目的

展示工作目录和写入权限在任务开始前就可见，而不是在 Agent 已经执行之后才补充说明。

### 前置准备

- 使用一个由适配器明确支持只读模式的 Agent，优先 Codex 或 Kimi Code。
- 演示工作目录中不放任何未提交改动或个人文件。
- 录制前保存一次目录状态，便于录制后核对没有文件变化。

### 操作步骤

1. 新建单聊或群组。
2. 通过系统目录选择器选择演示工作目录。
3. 明确展示写入开关处于关闭状态。
4. 发送以下英文指令。
5. 回答完成后，短暂展示只读标识与引用的文件名。

### 英文测试指令

```text
Inspect this workspace in read-only mode. Identify three documentation risks that could confuse a first-time user. Do not modify any files. Cite the file names you used.
```

### 预期可见状态

- 工作目录在会话顶部或设置区域可见，但录屏中只保留缩略路径。
- 写入权限保持关闭。
- Agent 输出三条风险，并引用读取过的文件名。
- 不出现文件创建、修改或删除结果。

### 验收检查

- 录制前后的工作目录差异为零。
- 界面没有把“只读”描述成操作系统沙箱。
- 如果选择的 Agent 无法可靠执行只读约束，立即更换 Agent，不使用该段素材。

### GIF 剪辑点

从选择目录开始，经过关闭的写入开关，到发送英文指令为止。分析结果可另剪一段，避免一个 GIF 同时承载太多信息。

## 五、场景 3：只加入必要上下文

### 目的

展示文件不会自动倾倒给所有 Agent。用户明确选择文件、目标 Agent 和本轮任务范围。

### 前置准备

- 打开 `README Decision Room` 群组，但本轮只点名一个通用 Agent。
- 准备 `docs/architecture.md` 与 `docs/tests.md`。
- 确保两个文件不包含密钥、真实用户名或需要隐藏的本地路径。

### 操作步骤

1. 在输入区切换到“单轮回答”模式。
2. 只选择一个目标 Agent。
3. 点击附件按钮，依次选择两个文档。
4. 确认输入框中出现两个附件项。
5. 发送以下英文指令。
6. 回答完成后打开对应运行详情，展示该用户消息是本次注入来源；点击来源回到消息，再展示两个附件名。

### 英文测试指令

```text
Review only the two attached documents. Produce a concise readiness assessment with three sections: confirmed capabilities, unresolved risks, and the next best validation step. Support every claim with an attached file name.
```

### 预期可见状态

- 两个附件在发送前均可见。
- 只有被点名的 Agent 运行。
- 回答包含三个指定部分，并以文件名支撑关键判断。
- 运行详情展示经过允许的注入消息与上下文摘要；附件名可从对应的原始消息查看，但不暴露真实存储路径。

### 验收检查

- 两个文件均成功导入且没有签名、类型或大小错误。
- 未选择的 Agent 没有产生回答。
- 回答没有引用未附加且未授权的文件。
- 上下文来源能回到包含这两个附件的用户消息。

### GIF 剪辑点

从两个附件项出现开始，到单 Agent 回答的三个小标题出现为止。建议 10-12 秒，使用 1.5-2 倍速但保留关键停顿。

## 六、场景 4：两个 Agent 设置两轮上限

### 目的

展示多 Agent 协作不是无限聊天。用户确认参与者、讨论模式和最大轮数，两个 Agent 在同一任务范围内形成不同视角。

### 前置准备

- 群组中只保留 Codex 与 Hermes 两个已就绪通用 Agent；若使用其他 Agent，需要同步修改测试指令中的角色名。
- 工作目录和写入权限已经设置完成。
- 关闭其他运行中的会话，避免系统资源和通知干扰。

### 操作步骤

1. 打开 `README Decision Room`。
2. 在输入区切换到自动讨论模式。
3. 确认群组仅包含两个 Agent，并把“最大轮数”设为 2。
4. 发送以下英文指令。
5. 录制两个 Agent 依次回答、轮次切换以及第 2 轮结束状态。

### 英文测试指令

```text
Run a two-round review of Meldwork's current README. Codex should argue from first-time user value; Hermes should challenge every claim against the available product evidence. Round 1 must surface disagreements and must not converge. In round 2, each Agent should answer the strongest opposing point, then converge on exactly three message changes and one claim to remove.
```

### 预期可见状态

- 自动讨论模式、两个群组成员和“最大轮数 2”在发送前可见。
- 每个完整轮次中两个 Agent 各运行一次。
- 后执行的 Agent 能看到前序结论的精简上下文，而不是完整工具日志。
- 第 2 轮结束后 Run 进入明确终态，不继续第 3 轮。

### 验收检查

- 两个 Agent 都完成两轮；若第 1 轮提前收敛，或某个 Agent 失败、认证中断，不使用该次录制。
- 界面不显示内部共识标记、原始思维链、凭据或完整命令输出。
- 最终内容确实包含三条文案修改和一条应删除声明。
- 自动讨论停止后仍可打开历史消息和运行详情。

### GIF 剪辑点

不要把两轮完整等待过程全部放进 GIF。建议剪成三个连续动作：启动自动讨论、Agent/轮次状态变化、第二轮完成。总时长控制在 10-12 秒。

## 七、场景 5：检查后再接受

### 目的

展示 Meldwork 的核心不是“让两个 Agent 都说完”，而是让用户能够检查每个 Agent、每一轮、上下文与脱敏事件，再指定一个 Agent 完成最终修订。

### 操作步骤

1. 在场景 4 的群组中打开 Run 详情。
2. 依次切换两个 Agent。
3. 切换第 1 轮与第 2 轮。
4. 展开结论、事件和上下文来源，停留在每个区域约 1 秒。
5. 关闭 Run 详情，将输入区切换到“单轮回答”模式，只选择一个目标 Agent。
6. 发送以下英文指令，生成最终定位段落。

### 英文测试指令

```text
Using the review above, rewrite only the product positioning paragraph in no more than 80 words. Keep claims supported by the evidence and remove anything the review could not verify.
```

### 预期可见状态

- Run 详情可以按 Agent 和轮次切换。
- 结论、上下文来源和终态彼此分离；若所选 Agent 或传输能够提供，还会显示计划或工具生命周期摘要。
- 详情中没有原始思维链、凭据、原生 Session 标识或可执行路径。
- 最终修订只由用户点名的一个 Agent 完成。

### 验收检查

- 第 1 轮与第 2 轮内容可以明确区分。
- 上下文来源能对应之前的用户消息、Agent 结论，或包含附件的原始消息。
- 最终段落不超过 80 个英文单词。
- 用户可以选择复制、继续修改或放弃结果；视频不暗示 Meldwork 自动替用户做最终决策。

### GIF 剪辑点

优先展示 Run 详情中的 Agent 切换、轮次切换和上下文展开。最终修订可作为第二个 GIF，避免文字太小。

## 八、可选素材

以下内容只有在录制机器上能够稳定复现时才使用：

- 已配置的飞书、钉钉或 Obsidian 知识来源选择。
- 已安装 Agent 的兼容 Skill 选择与目标分配。
- 一个不会产生真实外部副作用的 Human Gate。
- 单 Agent 停止、重试或替换后的状态变化。

以下内容不进入当前产品演示：

- 没有真实 Connector 的 Cloud Agent 或 Channel 页面。
- 已在界面隐藏的自定义 Agent 配置。
- 自动选择“最佳 Agent”或自动组队。
- 中断后从任意多 Agent 节点无条件精确续跑。
- 安装 Agent、修改系统环境或写入真实项目的过程。

## 九、README GIF 组合建议

| 文件名建议 | 内容 | 时长 |
| --- | --- | ---: |
| `meldwork-resume-task.gif` | 打开历史单聊并继续任务 | 8-10 秒 |
| `meldwork-add-context.gif` | 选择目录、保持只读、附加两个文件 | 10-12 秒 |
| `meldwork-two-agent-review.gif` | 设置两轮上限并显示轮次变化 | 10-12 秒 |
| `meldwork-inspect-run.gif` | 切换 Agent、轮次、事件与上下文 | 10-12 秒 |

示例导出命令：

```bash
ffmpeg -i source.mov -vf "fps=12,scale=1280:-2:flags=lanczos" -loop 0 output.gif
```

导出后逐帧检查：文字是否可读、是否出现鼠标残影、是否包含真实路径或通知、循环点是否自然。

## 十、录制隐私检查

- [ ] 使用演示目录，不包含真实业务数据。
- [ ] 隐藏完整用户名、用户目录和外接磁盘名称。
- [ ] 关闭系统通知、聊天软件、邮箱和日历提醒。
- [ ] Provider 表单、API Key、环境变量和认证终端不入镜。
- [ ] 不展开原生 Agent 的隐私数据、完整日志或 Session 文件。
- [ ] 附件内容已人工检查，可公开展示。
- [ ] 工作目录写入默认关闭；需要写入时只使用可丢弃目录。
- [ ] 录制结束后检查每一帧，不只检查视频开头和结尾。

## 十一、最终验收

一组可用素材应让第一次看到 Meldwork 的人，在 30 秒内回答三个问题：

1. 它解决什么问题：不同 Agent 之间的工作容易被切碎。
2. 它如何工作：从一个 Agent 开始，按需加入另一个，并限制协作范围。
3. 为什么值得信任：用户能看到权限、上下文、每轮结果和脱敏运行证据，并保留最终决定。
