# Meldwork Landing

单屏全屏背景 Landing Page，静态 HTML + CSS + 原生 JS，无构建步骤。风格参照「视频背景 + 点阵显示字体 + 白色 pill 导航」的参考 prompt，视觉系统完全适配 Meldwork 品牌。

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
- 显示字体 BubbledotICG-FinePos（点阵复古风，OnlineWebFonts CDN）仅覆盖拉丁字形；中文标题自动降级为思源黑体 900，字距单独调整。
- 统计条数字为产品真实事实：12 个已支持 CLI、3 种协作模式、100% 本地工作单元、1 道人工采用门。
- 动效遵循 `prefers-reduced-motion` 降级；弹窗/移动菜单支持 Escape 与遮罩关闭并锁定背景滚动。

## 双语

右上角 `EN / 中` 切换，文案以 `data-en` / `data-zh` 属性内联，选择记忆在 localStorage（不可用时仅本次会话生效）。默认语言跟随浏览器 `navigator.language`。

## 升级为视频背景（可选）

当前背景为关键帧 + Ken Burns 缓慢推拉动画（`styles.css` 的 `.bg-still`）。生成一段与 `bg-keyframe.png` 同构的 10s 循环视频（Seedance image_to_video，提示词：coral trace line gently drawing forward, particles drifting, slow push-in, no text），保存为：

```
assets/meldwork-bg.mp4
```

`<video>` 层会自动覆盖静态层，无需改代码；视频加载失败时仍回退到静态关键帧。
