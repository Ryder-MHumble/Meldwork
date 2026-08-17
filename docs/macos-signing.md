# macOS 预发布签名与正式发行

Meldwork-V1.0.2 的 Apple silicon 预发布候选使用 ad-hoc 临时签名，没有 Apple Developer ID 签名，也未提交 Apple 公证。预最终候选曾通过 `codesign --verify --deep --strict` 完整性检查；最终提交对应的精确应用仍须重新构建和验证。`spctl` 拒绝是这一分发方式的预期结果，不代表已经通过 Gatekeeper。计划通过 GitHub prerelease 获取该候选的用户，首次启动时可能需要在“系统设置 -> 隐私与安全性”中选择“仍要打开 / Open Anyway”。

未来面向公众的正式发行必须改用 `Developer ID Application` 证书签名并提交 Apple 公证，使应用能够在全新 Mac 上通过 Gatekeeper。仓库中的 `dist:public` 是这条正式发行路径，缺少签名或公证凭据时会安全失败，不会降级生成 ad-hoc 公共产物。

## 1. 加入 Apple Developer Program

1. 使用将来负责发布 Meldwork 的 Apple ID 登录 [Apple Developer Program](https://developer.apple.com/programs/)。
2. 为 Apple ID 开启双重认证，然后加入 Apple Developer Program。Apple 会收取年度会员费，具体人民币价格和身份验证要求以申请页面为准。
3. 如果未来由公司或机构发布，建议使用法人主体加入，而不是个人账号。Apple 可能要求提供 D-U-N-S 编号，并验证申请人是否有权代表该组织签署协议。
4. 申请通过后，在 Membership 页面记录十位字符的 Apple Team ID。

审核时间可能从几小时到数个工作日不等，取决于个人身份或组织资质验证。这个申请过程无法通过本仓库自动完成。

## 2. 注册固定的应用标识

Meldwork 的正式 Bundle ID 是 `com.rydersun.meldwork`。必须在第一次签名并公证发布前注册这个标识，之后保持不变。后续修改 Bundle ID 可能影响 macOS 应用身份、系统权限、钥匙串数据访问和升级连续性。

进入 Apple Developer 网站的 Certificates, Identifiers & Profiles，在 Identifiers 中注册 `com.rydersun.meldwork`。首次公开发布后不要更换这个标识。

## 3. 创建签名证书

推荐在发布用 Mac 上通过 Xcode 创建证书：

1. 安装发布 Mac 所支持的最新稳定版 Xcode。
2. 打开 Xcode 设置，进入 Accounts，添加已经加入 Apple Developer Program 的 Apple ID，并选择正确的 Team。
3. 打开 Manage Certificates，创建 `Developer ID Application` 证书。
4. 确认登录钥匙串中同时存在证书和对应私钥：

```bash
security find-identity -v -p codesigning
```

分发 DMG 和 ZIP 需要的是 `Developer ID Application`。只有分发签名 `.pkg` 安装包时才需要 `Developer ID Installer`。

将证书和私钥导出为加密的 `.p12` 文件，并保存在仓库之外的安全位置。不要把证书、私钥、密码、API Key 或公证配置提交到 Git。

## 4. 创建 Apple 公证凭据

CI/CD 推荐使用 App Store Connect API Key：

1. 打开 App Store Connect，依次进入 Users and Access、Integrations、App Store Connect API。
2. 创建一个能够代表当前 Team 提交公证任务、但权限尽可能小的 API Key。
3. 下载只能获取一次的 `.p8` 私钥文件，同时记录 Key ID 和 Issuer ID。

如果只在本机发布，可以让 `notarytool` 把 Apple ID 凭据保存到钥匙串：

```bash
xcrun notarytool store-credentials "meldwork-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"
```

需要在 [Apple ID 账户页面](https://appleid.apple.com/) 创建 App 专用密码。这里不能使用 Apple ID 的普通登录密码。

## 5. 配置 electron-builder

当前仓库已经使用 Bundle ID `com.rydersun.meldwork`，项目采用非商用源码许可，商用需要单独书面授权。公开发布配置必须保持 Hardened Runtime 开启，并在现有 `afterPack` Electron Fuses 加固完成后，由 electron-builder 执行签名和公证。

使用本机钥匙串证书时，electron-builder 可以自动发现有效的 `Developer ID Application` 身份。在 CI 中，需要把证书导出为加密的 `.p12`，并配置以下 Secrets：

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

`CSC_LINK` 指向 `.p12` 证书或其安全编码内容，`CSC_KEY_PASSWORD` 是 `.p12` 密码。`APPLE_API_KEY` 必须指向 CI 运行环境中的 `.p8` 私钥文件。

如果不使用 App Store Connect API Key，也可以配置 Apple ID 方案：

```text
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

如果使用本机钥匙串中的 `notarytool` Profile，设置 `APPLE_KEYCHAIN_PROFILE=meldwork-notary`。Profile 位于默认钥匙串时，通常不需要设置 `APPLE_KEYCHAIN`。

公开发布命令 `dist:public` 会依次执行以下保护：

1. `scripts/public-release-preflight.cjs` 检查签名身份和完整的公证凭据。
2. `electron-builder.public.cjs` 强制启用 `forceCodeSigning: true` 和 `mac.notarize: true`。
3. `scripts/after-sign.cjs` 拒绝临时签名、缺失 Team ID、未开启 Hardened Runtime，或者 Bundle ID 不是 `com.rydersun.meldwork` 的产物。

不要增加任何明文凭据降级方案。缺少签名或公证凭据时，公开发布必须在打包前失败，不能生成可能被误发布的临时签名产物。

## 6. 构建并验证产物

### V1.0.2 预发布候选

本地预发布候选使用普通 `dist` 路径：

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist
```

验证应用完整性和临时签名：

```bash
codesign --verify --deep --strict --verbose=2 \
  desktop/dist/mac-arm64/Meldwork.app

codesign -dv --verbose=4 \
  desktop/dist/mac-arm64/Meldwork.app
```

`codesign -dv` 应显示 `Signature=adhoc` 且没有 Team ID。此候选执行 `spctl --assess` 时应被拒绝；不要把这一结果描述为正式签名失败或 Gatekeeper 验收通过。

当前 `desktop/dist` 中的候选早于最终源码状态，其校验值不得写入 Release 或文档。最终提交锁定后必须重新构建并生成新值：

```bash
npm --prefix desktop run dist
shasum -a 256 \
  desktop/dist/Meldwork-0.1.2-arm64.dmg \
  desktop/dist/Meldwork-0.1.2-arm64.zip
```

只有这次精确构建生成的值才可以写入同批次的 `SHA256SUMS.txt` 和 Release Notes。校验值只能证明文件与该次构建一致，不能替代 Developer ID 信任或 Apple 公证。

### 未来正式发行

安装锁定依赖并构建公开分发包：

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:public
```

`npm --prefix desktop run dist` 生成 ad-hoc 签名的本地或 prerelease 候选，不是正式公开发布命令。

发布前检查实际生成的应用和 DMG：

```bash
codesign --verify --deep --strict --verbose=2 \
  desktop/dist/mac-arm64/Meldwork.app

spctl --assess --type execute --verbose=4 \
  desktop/dist/mac-arm64/Meldwork.app

xcrun stapler validate desktop/dist/mac-arm64/Meldwork.app
xcrun stapler validate desktop/dist/Meldwork-0.1.2-arm64.dmg
```

必须在没有安装过 Meldwork、没有历史应用数据的全新 Apple 芯片 Mac 用户账户中安装 DMG，并通过正常双击启动。不能使用右键绕过、删除隔离属性或执行 `xattr` 的方式通过测试。只有 Gatekeeper 正常接受应用，才算满足公开发布门槛。

Developer ID 签名、公证和 Stapling 全部完成后，再为正式发行重新生成校验值：

```bash
shasum -a 256 \
  desktop/dist/Meldwork-0.1.2-arm64.dmg \
  desktop/dist/Meldwork-0.1.2-arm64.zip
```

正式发行的 DMG、ZIP 和 `SHA256SUMS.txt` 必须来自同一个干净的 Git 标签和同一次 `dist:public` 构建，不能复用 V1.0.2 ad-hoc 候选的校验值。

## 7. 常见错误

- `CSSMERR_TP_NOT_TRUSTED`：证书链无效、证书已过期、缺少对应私钥，或者证书在当前钥匙串中不受信任。
- `no identity found`：没有安装有效的 Developer ID 证书，或者 electron-builder 无法访问证书所在的钥匙串。
- 公证拒绝二进制文件：使用 `notarytool` 查看详细日志，重点检查未签名的嵌套可执行文件、缺失 Hardened Runtime、无效 Entitlements 或额外打包的可执行内容。
- `spctl` 拒绝已经签名的应用：通常是没有完成公证或 Stapling、公证票据无效，或者本地验证的应用并不是提交给 Apple 的同一份产物。
- 签名版本启动后出现全新数据目录：Bundle ID 或产品身份可能在内测后发生了变化。应停止发布并先设计明确的数据迁移方案。

## 8. 当前项目状态

- Bundle ID 已固定为 `com.rydersun.meldwork`。
- `dist:public` 已配置为缺少正式签名或公证凭据时安全失败。
- 预最终 Meldwork-V1.0.2 候选已通过本地构建和 ad-hoc `codesign` 验证，但它早于最终源码状态，不能作为发布产物或校验值来源。
- 最终提交对应的 DMG、ZIP、应用、SHA-256、ad-hoc `codesign` 和远端资产一致性仍待重新生成并验证。
- V1.0.2 不包含 Developer ID、Apple 公证或 Gatekeeper 验收；最终 ad-hoc 候选执行 `spctl` 时仍应被拒绝，安装时可能需要用户明确选择 Open Anyway。
- 在完成 Apple Developer Program 申请、证书安装和公证凭据配置之前，不能把任何 Meldwork 产物描述为正式签名或公证发行版。
- 最终校验值生成规则、自动化测试和实时 Agent 验收边界见 [Meldwork V1.0.2 预发布与分发边界](public-mvp-release.md) 和 [Verification And Test Coverage](tests.md)。
