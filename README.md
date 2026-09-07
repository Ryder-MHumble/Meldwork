# Meldwork Landing

多章节 Landing Page，静态 HTML + CSS + 原生 JS，无构建步骤。保留首屏视频与点阵显示字体，下方章节使用低对比度 PixelBlast 背景。

## 打开方式

直接双击 `index.html`，或本地起服务：

```bash
npx serve .   # 或 python3 -m http.server
```

## 品牌物料复用（assets/）

| 物料 | 来源 | 用途 |
| --- | --- | --- |
| `meldwork-mark-v3.svg` | frontend/public/logos | 头部圆形 logo 徽章 |
| `meldwork-wordmark-v3-dark.svg` | frontend/public/logos | 产品弹窗品牌字标 |
| `meldwork-favicon*.png` | frontend/public/logos | 站点图标 |
| `meldwork-readme-banner-en.png` | frontend/public/logos | Open Graph 分享图 |
| `agents/*` (12 个 CLI logo) | frontend/public/agent-logos | 信任条头像环（取 Codex / Claude / Gemini / Qwen / Kimi 5 枚） |
| `screenshots/*` (4 张) | assets/ | Product 弹窗实拍画廊 |
| `bg-keyframe.png` | AI 生成（Trace mark 视觉语言：珊瑚色工作线 + 点阵节点） | 背景层 + video poster |

## 设计决策

- 配色取自产品暗色主题 token（`#121516` 底、`#93a0a5` 弱化文字）与 logo 珊瑚色 `#EF5A45`；导航激活的三点指示器刻意使用珊瑚色，呼应 Trace mark 的「人类采用点」。
- 显示字体 BubbledotICG-FinePos（OnlineWebFonts CDN）仅覆盖拉丁字形；中文标题使用本地 Fusion Pixel 12px 补充，正文使用苹方等无衬线字体。字体来源与 OFL 许可位于 `assets/fonts/fusion-pixel/`。
- 统计条数字为产品真实事实：12 个已支持 CLI、3 种协作模式、100% 本地工作单元、1 道人工采用门。
- 动效遵循 `prefers-reduced-motion` 降级；弹窗/移动菜单支持 Escape 与遮罩关闭并锁定背景滚动。

## 双语

页面默认英文，显式使用 `?lang=zh` 时显示中文。右上角 `EN / 中` 原页切换，并同步 URL 参数。`locale.js` 复用已有 `data-en` / `data-zh` 和翻译字典，保留阅读锚点、FAQ 展开项、演示模式和暂停状态；标题点阵在切换后重建。不刷新页面，不写入 localStorage。

## 页面交互

- 下载文案与结构化版本为 V1.0.4，DMG 链接指向发布页的 `Meldwork-0.1.4-arm64.dmg`。
- FAQ 默认打开第一项，点击其他问题会收起旧答案；使用可中断的 280ms 高度动画，减少动态效果时立即切换。
- `run-demo.js` 用中英文聊天气泡分别演示直接会话的用户追问、多个 Agent 同时回复的独立建议，以及自动讨论的 @ 接续。新消息淡入并在固定高度的聊天区内滚动，示例文本不代表真实会话记录。模式选中样式仅包含文字变化和橙色下划线，无背景块或灰色边框。
- 模式标签支持方向键、Home、End；演示支持暂停，离开可视区或进入后台时停止计时，减少动态效果时呈现完成状态。
- 顶部导航无边框：首屏横跨页面，向下滚动超过 64px 后收窄为圆角毛玻璃浮栏。Logo 与章节入口靠左，下载、主题和语言切换靠右；窄屏使用左侧菜单和右侧下载图标。

## 背景动效

首屏继续使用 `assets/meldwork-bg-v2.mp4`，保留原版循环与视差效果。视频失败或系统减少动态效果时使用静态关键帧。

`chapter-scene.js` 原样复用桌面 Agent CLI 加载页 `frontend/src/components/PixelBlast.vue` 的 GLSL 片元着色器（源自 React Bits PixelBlast），直接通过 WebGL2 绘制。沿用点阵尺寸 3.7px、密度 1.26、透明度 0.42、缩放 2.2、主题配色与每毫秒 0.00036 的时间推进速度，设备像素比上限为 1.5。点阵持续自行流动、聚散，不监听鼠标事件，也不随滚动重置动画。测试逐字比较加载页与 Landing 的片元着色器，防止效果再次偏离。来源许可见 `assets/react-bits-LICENSE.md`。

右下角按钮暂停/继续章节背景；首屏范围内、后台标签页及系统减少动态效果时不运行章节动画循环。减少动态效果模式保留静态背景。按钮图标沿用产品的 Ionicons 图形。

## 验证

在仓库根目录运行（需要已安装 frontend 开发依赖）：

```bash
node --test meldwork-landing/tests/landing.test.cjs
node --check meldwork-landing/locale.js
node --check meldwork-landing/chapter-scene.js
node --check meldwork-landing/run-demo.js
```

安装 Playwright 后运行 `node meldwork-landing/tests/browser-check.cjs`；也可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright 模块路径。检查 FAQ、原页语言切换、三个模式与 @ 接续、暂停、减少动态效果，以及 1440/900/390/320px 视口；截图写入系统临时目录。
