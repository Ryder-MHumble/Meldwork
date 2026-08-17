# Meldwork V1.0.2 预发布与分发边界

Meldwork-V1.0.2 对应桌面包版本 `0.1.2`，当前验证目标是 Apple silicon macOS。该候选计划作为 GitHub prerelease 分发，使用 ad-hoc 临时签名，没有 Apple Developer ID 签名，也未提交 Apple 公证。它不能被描述为通过 Gatekeeper 的正式 macOS 发行版；首次启动可能需要在“系统设置 → 隐私与安全性”中选择“仍要打开 / Open Anyway”。

## 当前产品合同

V1.0.2 是一个本地优先的多 Agent Work Cell，由用户明确选择参与 Agent、工作目录和写入权限。

- 直接会话保留本地历史、附件、Skill、Provider、受控权限、兼容的原生 Session 和脱敏运行事件。
- 群聊“并发回复”在调度前为所有已选 Agent 冻结同一份任务快照，保留全部成员，并在批次屏障后按稳定顺序提交独立回复。
- Auto Discussion 从全员独立并行提案开始。已选 Agent 交叉质询并自主协商一份职责图；只有全员同意同一 `planHash` 后，Harness 才按该图调度各自的工作包。
- 提案、质询、分工工作和复核默认只读。开启工作区写入时，只有协商确定的整合者在合成阶段拥有写权，不同的复核 Agent 独立验证当前候选 Artifact。
- Harness 持久化冻结快照、阶段、槽位、结构化回执、Artifact/Evidence 引用、交付水位、Human Gate 和幂等提交状态。它验证协作协议，不在 Agent 之外私下分配职责。
- 用户可停止 Run 或指定 Agent，检查阶段、异议、候选产物和恢复选项，并保留最终采用决定。

当前不承诺从大规模候选池自动选人组队、生产级 Cloud/Channel Agent、跨用户远程协作、企业 RBAC/治理、Outcome Network，也不承诺目录中每个 Agent 都已通过实时发布认证。

## V1.0.2 预发布产物

DMG、ZIP 和 `SHA256SUMS.txt` 必须来自最终已验收提交和同一次 `npm --prefix desktop run dist` 构建。当前 `desktop/dist` 中的产物早于最终源码状态，因此本页不记录或复用它们的校验值。

最终提交锁定后，必须重新运行 `dist`，对新生成的 DMG 和 ZIP 执行 `shasum -a 256`，生成同批次的 `SHA256SUMS.txt`，再把新值写入 Release Notes。上传后还必须重新下载或读取远端资产，确认远端字节与本地最终构建一致。

## 验收状态

- 当前发布候选源码的前端测试 `299/299`；桌面测试 `1270/1270`，无失败或取消；确定性 Eval Harness 共 `6` 个案例、`18` 个结果。最终提交仍须重跑这三项验证。
- Web 和 Electron renderer 两个前端构建与 `pack` 已在发布候选源码上通过；最终提交仍须重新运行 `pack`，对应的 DMG 和 ZIP 仍须通过 `dist` 重新构建。
- 预最终候选的 ad-hoc 签名通过 `codesign --verify --deep --strict`；最终精确产物仍须重复验证。由于没有 Developer ID 和公证，`spctl` 拒绝是预期结果。
- 预最终 V1.0.2 打包候选中，Codex、Claude 和 Hermes 完成了真实流式回复与工具生命周期验收；这不等于最终提交产物已经完成重新验收。
- OpenClaw 的预发布实时流式/工具验收仍未完成；Auto Discussion 的精确打包端到端验收也仍未完成。这两项不得在 Release Notes 中写成已验证。

完整的自动化证据、实时 Agent 边界和剩余风险见[Verification And Test Coverage](tests.md)。

## 未来正式签名发行

计划中的 GitHub prerelease 不代替正式签名公开发行。要让应用在全新 Mac 上直接通过 Gatekeeper，后续发行仍必须：

1. 使用有效的 `Developer ID Application` 证书和完整的 Apple 公证凭据。
2. 从干净标签运行 `npm --prefix desktop run dist:public`，不允许明文凭据或 ad-hoc 降级。
3. 验证 Developer ID 身份、永久 Bundle ID `com.rydersun.meldwork`、Hardened Runtime、Apple 公证、Stapling 和 Gatekeeper。
4. 在没有历史 Meldwork 数据的全新 Apple silicon Mac 账户中安装 DMG 并正常双击启动。

详细操作见 [macOS Developer ID 签名与 Apple 公证](macos-signing.md)。
