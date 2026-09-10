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
| easy-pi | easy_pi.png | 用户于本次会话提供的红白机器人星球原图 | 原图1254×1254等比缩小后裁去外围透明留白，输出455×319；保留透明背景、立体光影与完整轨道，以contain保持比例。快捷栏单独使用22px容器，其余图标仍为17px，不改变按钮尺寸 |
| Oh My Pi | omp.svg | 用户于本次会话提供的紫蓝青渐变 π 图形 | 按参考图重绘透明背景 SVG，保留圆角、左短右长双脚及品牌渐变；去除边缘杂点和外围留白 |

LobeHub 目录未找到 Oh My Pi 或 easy-pi 的独立品牌项。Oh My Pi 原使用官方专属资源，现按用户提供的参考图替换；不宣称该参考图具有旧资源的 MIT 授权。easy-pi 的本地官方 fork `/Users/w/Projects/easy-pi/pi`，remote `https://github.com/yiwen65/pi.git`，提交 `c227dbb2ee1d69e8428edfa9cc1ca7ba315f6547`，`packages/coding-agent/README.md` 顶部仍引用 `https://pi.dev/logo-auto.svg`，因此旧版曾使用同一 Pi 品牌的 LobeHub 图形；现按用户指定替换为机器人星球原图，保留独立的 easy-pi 文字标签与入口。用户提供的原图不被宣称具有 LobeHub 的 MIT 授权。

## light / dark 处理

这批图标使用原站单色版本而非全局反色滤镜。当前七份 LobeHub 图标使用 `currentColor`；easy-pi 在两种主题下保持原图颜色和透明背景，图片不可拖动；Oh My Pi 按用户要求在 light/dark 下均保留紫蓝青渐变，背景透明；每个实例使用独立渐变 ID，避免多图标引用冲突。`AgentIcons.tsx` 的新增图标统一使用 `.themed-agent-icon`，其前景为应用语义变量 `--text`：dark `#f3f5fb`，light `#111217`。应用根节点切换 `data-theme` 时 SVG 自动同步，无远程图片加载或依赖系统主题与 App 主题一致的假设；easy-pi PNG由构建产物本地提供。图标为装饰，`aria-hidden=true`；按钮/选择器已有完整产品文字标签。

图标测试检查九种资源渲染、固定文件来源、无脚本/外链、`currentColor` 及明暗语义变量连通性。实际 App 截图由交付阶段检查，不以 jsdom 测试冒充像素或完整 WCAG 验证。

## 移动端同步

移动端启动选择界面支持同一组14种正式Agent品牌图标；Shell及未知类型仍使用终端符号。新增资源与许可同步到 `mobile/src/assets/agent-icons/`，由字节一致性回归测试防止两端再次漂移。Omp保持彩色渐变且实例ID独立；easy-pi使用裁掉留白的透明PNG，启动界面用38px容器，其余图标30px，不增加交互行为或改变启动权限。

移动端本次验证：仅包含本任务改动的暂存快照中，395项测试、TypeScript及Vite构建通过；包括全部新增图标、桌面/移动资源一致性和真实启动选择组件回归。首次验收时两台iPhone均不可连接；用户随后连接iPhone 17 Pro Max，已完成iOS调试归档、安装并启动 `com.agentport.mobile`，未重启Host/Agent。设备截图服务返回Invalid service，因此未宣称完成真机视觉验收。

## 许可（随源码与 App 保留）

完整条款另存 `src/src/assets/agent-icons/LICENSE.txt`，通过 raw import 随新增图标嵌入构建产物及不可见 HTML 注释，避免只在开发文档中保留而在分发 App 时遗漏。

### LobeHub — MIT

[固定版本 LICENSE](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/LICENSE)

Copyright (c) 2023 LobeHub

### Oh My Pi — 旧版图标 MIT 归属（历史保留）

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
