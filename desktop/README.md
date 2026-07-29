# RoundRelay 桌面客户端

RoundRelay 是完全本地运行的 Electron 客户端。它直接加载仓库中的桌面前端，在 Electron
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
- Claude Code
- Qwen Code
- Gemini CLI
- OpenCode

Agent 管理面板提供经过白名单约束的安装入口。安装命令和下载地址由主进程固定，不会根据页面
输入执行任意命令。群聊级工作目录写入权限默认关闭，只有用户明确授权后才会传给 Agent。
Kimi 的无头模式无法安全限制为只读，因此只有开启写入权限后才能参加普通群聊。

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
| Claude Code | `claude` | npm：`@anthropic-ai/claude-code@latest` | npm：`@anthropic-ai/claude-code@latest` | 不注入；沿用 Claude 本机配置 |
| Qwen Code | `qwen` | npm：`@qwen-code/qwen-code@latest` | npm：`@qwen-code/qwen-code@latest` | 支持 |
| Gemini CLI | `gemini` | npm：`@google/gemini-cli@latest` | npm：`@google/gemini-cli@latest` | 不注入；沿用 Gemini 本机配置 |
| OpenCode | `opencode` | npm：`opencode-ai@latest` | npm：`opencode-ai@latest` | 不注入；沿用 OpenCode 本机配置 |

macOS 会在当前 `PATH` 之外搜索 Volta、pnpm、fnm、asdf、mise、bun、
`~/.local/bin`、`~/.kimi-code/bin`、Homebrew 等常见目录。Windows 会额外搜索用户 npm、
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
