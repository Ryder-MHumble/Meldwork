# Meldwork 桌面客户端

Meldwork 是完全本地运行的 Electron 客户端。它直接加载仓库中的桌面前端，在 Electron
主进程中检测和调用本机 Agent CLI，不需要登录、JWT、远端平台、Docker 或云端服务。

本地群聊、消息、群组配置和 CLI 会话引用保存在 Electron 用户数据目录。渲染进程只通过
`window.roundrelayDesktop` 调用经过约束的 preload API，不会获得可执行文件路径、Provider
API Key 或任意 Shell 执行能力。

支持检测和调用以下本机 Agent CLI：

- Codex
- Hermes
- OpenClaw
- WorkBuddy
- Kimi Code
- MiMo Code
- Claude Code
- Gemini CLI
- OpenCode
- Qwen Code

Agent 管理面板提供经过白名单约束的安装入口。安装命令和下载地址由主进程固定，不会根据页面
输入执行任意命令。对支持强制权限模式的 Agent，群聊级工作目录写入默认关闭，只有用户明确
授权后才会切换为写入模式；Hermes 和 OpenClaw 没有等价的强制只读参数，界面会明确标为
“由 Agent 自身权限控制”。Kimi 在只读对话中通过 Agent Client Protocol 的 `plan` 模式运行；
用户明确开启写入权限后，才切换到 Kimi 原生的 `stream-json --prompt` 模式。

## 首次启动与本地 Agent 检测

首次启动会显示三页引导轮播，依次介绍本地 Agent 检测、多 Agent 协作、Skill 与图片上下文。
客户端在引导打开时执行唯一一次启动刷新；检测任务真正结束前“开始使用”按钮保持禁用，不会
用固定计时器伪装完成。检测成功或失败后才释放按钮。完成或关闭引导后会在渲染层本地记录状态，
后续启动直接进入工作台；Agent 仍可在管理面板中重新检测。

## `@` Skill 引用

在消息输入框输入 `@` 或点击 `@` 按钮，可以选择当前目标 Agent 本机已发现的 Skill。列表只
返回清洗后的 Agent、命名空间、slug 和显示名称，不返回 Skill 文件路径或内容。一次消息最多
选择 4 个 Skill；主进程会在发送前按目标 Agent 重新扫描并验证选择，跨 Agent 冒用、过期条目
或前端构造的任意路径都会被拒绝。Hermes 使用原生 `--skills` 参数预加载已验证 Skill；其他
Agent 只会收到属于自己的 Skill 坐标提示，不会收到其他目标的选择。

## 图片附件

消息输入框支持系统文件选择器和剪贴板粘贴图片。当前接受 PNG、JPEG，单张不超过
8 MiB，一条消息最多 4 张。图片会复制到 Electron 用户数据目录下的私有附件存储，工作区
消息只保存 `id`、文件名、MIME 类型和大小；渲染层不能读取附件路径，只能按 `id` 请求经过
尺寸检查和缩放的预览。

当前适配器能力为：Codex 最多 4 张、Hermes 最多 1 张、OpenCode 最多 4 张，其余 Agent
不接收图片。发送或启动自动讨论前会先检查所有目标 Agent；任一目标无法接收同一组图片时，
整个运行在记录消息或启动进程前失败，避免不同 Agent 在不等上下文下继续讨论。未发送附件、
删除会话后的无引用附件和异常导入残留会由主进程回收。

## Provider 配置

用户可以在客户端内填写一个 OpenAI-compatible Provider：

```text
provider: Provider 显示名称
baseUrl: HTTPS 地址，或本机 loopback HTTP 地址
model: 模型名称
apiKey: API Key
```

API Key 仅通过 Electron `safeStorage` 加密保存到本机；操作系统安全存储不可用时拒绝落盘。
Provider 不设品牌、服务地址或模型默认值，也不会从远端自动获取配置。配置后可供 Hermes、
OpenClaw、WorkBuddy 和 Qwen 使用；其他 Agent 沿用各自的本机鉴权和 Provider 配置。

## 本地 CLI 支持矩阵

| Agent | 检测命令 | macOS 安装 | Windows 安装 | 用户 Provider |
| --- | --- | --- | --- | --- |
| Codex | `codex` | npm：`@openai/codex@latest` | npm：`@openai/codex@latest` | 不注入；沿用 Codex 本机配置 |
| Hermes | `hermes` | 官方 `install.sh` | 官方 `install.ps1` | 支持 |
| OpenClaw | `openclaw` | npm：`openclaw@latest` | npm：`openclaw@latest` | 支持，使用客户端隔离的托管配置 |
| WorkBuddy | `codebuddy` | npm：`@tencent-ai/codebuddy-code@2.115.0` | npm：`@tencent-ai/codebuddy-code@2.115.0` | 实验性支持 |
| Kimi Code | `kimi` | 官方 `install.sh` | 官方 `install.ps1` | 不注入；沿用 Kimi 本机配置 |
| MiMo Code | `mimo` | npm：`@mimo-ai/cli@latest` | npm：`@mimo-ai/cli@latest` | 不注入；沿用 MiMo 本机配置，Meldwork 固定使用只读 `plan` Agent |
| Claude Code | `claude` | npm：`@anthropic-ai/claude-code@latest` | npm：`@anthropic-ai/claude-code@latest` | 不注入；沿用 Claude 本机配置 |
| Gemini CLI | `gemini` | npm：`@google/gemini-cli@latest` | npm：`@google/gemini-cli@latest` | 不注入；沿用 Gemini 本机配置 |
| OpenCode | `opencode` | npm：`opencode-ai@latest` | npm：`opencode-ai@latest` | 不注入；沿用 OpenCode 本机配置 |
| Qwen Code | `qwen` | npm：`@qwen-code/qwen-code@latest` | npm：`@qwen-code/qwen-code@latest` | 支持 |

macOS 会在当前 `PATH` 之外搜索 Volta、pnpm、fnm、asdf、mise、bun、
`~/.local/bin`、`~/.kimi-code/bin`、`~/.mimocode/bin`、Homebrew 等常见目录。Windows 会额外搜索用户 npm、
WindowsApps、Node.js、WorkBuddy、Chocolatey 和 Scoop 目录，并按 `PATHEXT` 解析命令。

Hermes 和 Kimi 的安装脚本来自固定 HTTPS 白名单地址；客户端不内置脚本副本，因此离线环境
不能使用这两个一键安装入口。当前自动安装面向 macOS 和 Windows，Windows 安装流程仍需在
真实 Windows 设备上做发布前验证。

## 本地开发

```bash
cd desktop
npm install
npm run dev
```

可选环境变量：

- `ROUNDRELAY_CODEX_SANDBOX`：Codex 默认沙箱模式，支持 `read-only` 和
  `workspace-write`；未设置或值不受支持时使用 `read-only`。

## 测试与打包

```bash
npm test
npm run pack
npm run dist
```

`pack` 和 `dist` 会先构建桌面前端。发布产物输出到 `desktop/dist/`，其中包含本地前端，
不依赖服务器或容器。
