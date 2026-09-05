# Meldwork Landing

静态 HTML、CSS 和原生 JavaScript，无运行服务或构建步骤。

## 本地预览

用浏览器打开 `index.html`。视频、图片与脚本均以相对路径加载；正式部署时发布本目录即可。

页面支持中文和英文、明暗主题。语言默认跟随浏览器，语言和主题选择保存在可用的 localStorage 中。关闭 JavaScript 时，英文正文、全部产品截图、导航与原生 FAQ 仍可阅读。

## 页面与素材

- `index.html`：静态英文正文、内联中文文案、辅助名称、元数据和 JSON-LD。
- `styles.css`：响应式布局、品牌样式和同一视频场景的退场规则。
- `main.js`：语言与主题切换、截图 tabs、菜单焦点、视频循环与生命周期。
- `assets/meldwork-bg-v2.mp4`：复用的 H3 背景，1440 × 704、约 8 秒；本轮未生成新视频。
- `assets/bg-keyframe.png`：静态背景和视频失败回退。
- `assets/screenshots/`：现有产品截图，完整比例显示，点击查看原图。
- `AUDIT.md`：PM、GEO、UI/UX 审查依据和验证结果。
- `DESIGN.md`：本页布局与动态效果的维护约定。

唯一外部展示依赖是原页面沿用的点阵字体 CDN；加载失败会回退为本机无衬线字体。图标沿用产品标识与 Ionicons 轮廓图标。

## 媒体行为

背景固定在视口内，由容器按比例裁切，独立于章节尺寸。首屏离开时整体平滑退场到统一正文底色。两个视频元素交叉淡入隐藏循环接缝，切换过程中保留出场画面作为底层。

背景提供暂停控制。离开首屏或切到后台会暂停；减少动态效果使用静帧且不请求视频；节省流量设置默认暂停。正文和示例不自动播放，不依赖动画显现。

## 校验

需要 Node.js、Playwright 和已安装的 Chrome。Playwright 可以安装在独立工具目录，不需要给 landing 增加应用依赖。

```bash
node --check meldwork-landing/main.js
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node --test meldwork-landing/tests/landing.test.cjs
git diff --check
```

测试会启动临时本地 HTTP 端口并在结束时关闭；截图写入系统临时目录，路径打印在结果中。覆盖静态正文与 JSON-LD、中英元数据、偏好持久化、截图键盘操作、菜单、媒体像素与循环、降级，以及 7 组视口。可用 `PLAYWRIGHT_CHANNEL` 覆盖 Chrome 通道。

## 发布前

当前下载入口为已核验的 `Meldwork-V1.0.4` Apple 芯片 macOS 预览版，软件包版本为 `0.1.4`，许可证以仓库 `LICENSE` 的 Apache-2.0 为准。发布版本变化时同时更新可见正文、下载链接、元数据、JSON-LD 和相应测试。

正式域名尚未确定，未写入虚构 canonical、hreflang、站点 URL 或 sitemap。上线后使用实际地址配置这些字段及绝对 Open Graph 图片 URL。当前中文由客户端切换，不等于已经部署可独立索引的中文 URL；需要独立中文索引时再发布相应静态语言地址。

本轮仅修改 landing，不涉及 Electron 的执行、权限或聊天行为。桌面应用的构建与完整测试不属于本页浏览器验证的替代或结论。
