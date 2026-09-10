# 新增 Agent 图标来源与明暗主题

本次仅增加九种图标；现有 Claude、Codex、Kimi、Qoder、Pi 图标不变。获取时间：2026-09-10。品牌图标仅用于识别对应产品，不表示获得品牌背书；软件资源许可不授予商标权。

## 来源

LobeHub 图标目录：<https://lobehub.com/icons>。实际 SVG 来自其官方开源仓库，固定提交 `a94750e3f5f8fc33757b839d85030e742284e43a`，以避免 master 漂移。

下表 LobeHub 源文件 URL 的共同前缀为：
`https://raw.githubusercontent.com/lobehub/lobe-icons/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/`

| Agent | 本地文件（src/src/assets/agent-icons/） | 源文件 / 来源 | 修改 |
| --- | --- | --- | --- |
| OpenCode | opencode.svg | LobeHub `opencode.svg` | 无 |
| Amp | amp.svg | LobeHub `amp.svg` | 无 |
| Gemini CLI | gemini.svg | LobeHub `geminicli.svg`（CLI 专属版本） | 仅文件名 |
| Cline CLI | cline.svg | LobeHub `cline.svg` | 无 |
| Kiro CLI | kiro_cli.svg | LobeHub `kiro.svg` | 仅文件名 |
| Cursor CLI | cursor_agent.svg | LobeHub `cursor.svg` | 仅文件名 |
| Grok Build | grok_build.svg | LobeHub `grok.svg`，对应 xAI Grok 产品标识 | 仅文件名 |
| easy-pi | easy_pi.svg | LobeHub `pi.svg`；当前 fork README 仍采用 Pi 官方 logo（证据见下） | 仅文件名 |
| Oh My Pi | omp.svg | [官方 assets/icon.svg](https://raw.githubusercontent.com/can1357/oh-my-pi/969062200754ea02cfac922e5ebb8c608c079e15/assets/icon.svg) | `#fafafa` 主图形改为 `currentColor`，120×90 固定尺寸改为 1em；保留 viewBox、橙色连接器与深色插孔 |

LobeHub 目录未找到 Oh My Pi 或 easy-pi 的独立品牌项。Oh My Pi 使用官方专属资源，不借用 Pi 图标。easy-pi 的本地官方 fork `/Users/w/Projects/easy-pi/pi`，remote `https://github.com/yiwen65/pi.git`，提交 `c227dbb2ee1d69e8428edfa9cc1ca7ba315f6547`，`packages/coding-agent/README.md` 顶部仍引用 `https://pi.dev/logo-auto.svg`，因此使用同一 Pi 品牌的 LobeHub 图形，并保留独立的 easy-pi 文字标签与入口；未虚构 easy-pi 新品牌。

## light / dark 处理

这批图标使用原站单色版本而非全局反色滤镜。八份 LobeHub 图标原本使用 `currentColor`；Oh My Pi 仅将白色主体转为 `currentColor`，保留品牌橙色。`AgentIcons.tsx` 的新增图标统一使用 `.themed-agent-icon`，其前景为应用语义变量 `--text`：dark `#f3f5fb`，light `#111217`。应用根节点切换 `data-theme` 时 SVG 自动同步，无外部图片加载、闪烁或依赖系统主题与 App 主题一致的假设。图标为装饰，`aria-hidden=true`；按钮/选择器已有完整产品文字标签。

图标测试检查九种资源渲染、固定文件来源、无脚本/外链、`currentColor` 及明暗语义变量连通性。实际 App 截图由交付阶段检查，不以 jsdom 测试冒充像素或完整 WCAG 验证。

## 许可（随源码与 App 保留）

完整条款另存 `src/src/assets/agent-icons/LICENSE.txt`，通过 raw import 随新增图标嵌入构建产物及不可见 HTML 注释，避免只在开发文档中保留而在分发 App 时遗漏。

### LobeHub — MIT

[固定版本 LICENSE](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/LICENSE)

Copyright (c) 2023 LobeHub

### Oh My Pi — MIT

[固定版本 LICENSE](https://github.com/can1357/oh-my-pi/blob/969062200754ea02cfac922e5ebb8c608c079e15/LICENSE)

Copyright (c) 2025 Mario Zechner

Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

上述两组版权通知各自适用以下完整许可条款：

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
