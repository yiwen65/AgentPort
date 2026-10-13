# Session 项目文件（只读）

在 Session 终端向左滑动，或展开顶部控制区后点击文件夹按钮，进入项目文件树。文件树右滑或点击左上返回图标回终端。点文件打开预览；普通正文右滑返回文件树，树左滑回到最后打开的文件，也可通过更多菜单「继续阅读」进入。页面跟随手指移动，短滑可回弹，一次手势只返回一层。

## 文件树样式

- 与桌面端一致的单行树结构：目录使用展开箭头，文件按类型使用彩色图标；同层文件名对齐，每层缩进16 CSS px。不再显示第二行 `Directory/File`，读屏仍可识别类型和目录展开状态。
- 文件名过长单行省略，打开预览或文件操作菜单可查看完整名称/路径；文件行及右侧操作按钮保留至少44 CSS px触控高度。去掉逐行分隔线，突出层级而不是表格边界。

## 沉浸阅读

- 顶部常驻单行「返回图标 · 文件/根目录名 · ⋯」，长标题省略，不改变按钮热区。正文紧接标题栏；完整路径、只读及安全说明不再常驻。
- 「⋯」中提供刷新、下载、复制路径/内容、Markdown源码/渲染切换、文件信息与安全说明。Markdown本地链接以行内链接呈现，不是大按钮，读取安全策略不变。
- 树/预览持续挂载，同一文件往返保留树和正文滚动位置、代码横向位置及源码/渲染模式，不额外重读文件。切换新文件或显式刷新可能改变内容，不承诺跨App重启保存阅读历史。
- 代码横滚、文本选择、链接/按钮/菜单、多指及纵滚不触发本层切页。长按开始选字后，不把结束动作当作导航；系统「减弱动态效果」下不播放完成/回弹动画。
- 断线/缓存/截断保留紧凑提示；读取失败明确显示并可重试。截断提示可查看详细限制，不能把已截断片段当作完整文件。

- 根目录是电脑端记录的 Session `cwd`，不跟随终端临时 `cd`，也不会替换成项目主 checkout。
- 文件夹按需加载；每次进入、重新连接或手动刷新会重新读取已加载目录。展开状态和树的滚动位置在页面往返时保留，不停止 Session。
- 文本/代码只读，支持常见代码语言高亮；Markdown 支持渲染/源码切换。可复制相对文件路径和文件内容。大型文本跳过语法高亮，仍可阅读和复制。
- 不包含编辑/新建/删除/重命名、Git 标记、搜索、图片预览或文件系统实时监听。

## 下载与另存为（iOS / Android）

文件行右侧「⋯ → 下载文件」，或只读预览中的「下载文件」，可下载根目录内的单个普通文件。文件类型不限，最大 **1 GiB**。无法预览的图片、PDF、压缩包等仍可下载；下载的是完整原始字节，不是 1 MiB 的文本预览片段。

- App 全局同时运行一个任务。文件阅读期间不显示大任务卡片：顶部「⋯」有轻量进度/待处理标记，通过更多菜单「文件下载」打开详情，可查看进度、取消及另存为。重要变化有短提示，完整警告仍保留在指示器和详情。
- 切回终端或切换 Session 不取消原任务；文件页之外恢复现有任务卡片。详情显示来源主机/Session/路径，不能把其他Session的任务误当作当前文件。
- 前台分块下载到 App 私有临时文件，校验长度与 SHA-256 后显示「等待选择保存位置」。点击「另存为…」打开系统文件界面，选择目录和文件名。
- 系统负责同名重命名或显式替换确认，App 不自行覆盖。可以选择本机目录或系统提供的云盘；「已保存」只确认保存流程完成，不保证云端同步完成。
- 另存为期间在系统界面取消；App 不删除仍被系统读取的源文件。Android 写入失败会尝试删除系统新建的目标，无法删除时明确提示检查不完整文件。
- 不承诺锁屏/退后台继续，不支持续传；断线、源文件可检测的变化或完整性失败后从头重试。普通取消在当前请求完成后停止，不切断终端共享连接。
- 失败/取消清理自有临时文件；清理失败会保留明确提示，可再次清理。成功保存但缓存清理失败时仍如实显示目标已保存，不建议重复下载；启动会清理上次遗留的自有任务目录。
- 不含批量、目录打包、下载历史或自动打开。本功能仅在安装版 iOS/Android App 中可用，浏览器开发页面不伪造系统保存能力。
- `.git` 不列出；其他普通隐藏项可见。目录最多返回 2,000 项，文本最多读取 1 MiB，截断时明确提示，复制也只包含已读取片段。
- Markdown 不执行 HTML/脚本、不自动加载图片及外部资源。仅支持根目录内相对文件链接；外部链接禁用。

## 主机与安全边界

手机与电脑均需包含本功能版本。电脑端新增 `session.files.list` / `session.files.read`，参数为 `{ sessionId, path }`，`path` 为根目录相对路径，目录根为 `.`。服务端由 Session ID 查询 cwd，客户端不能提交另一个 rootPath。

目录及文件通过真实路径包含检查、固定目录句柄和禁止跟随替换后的符号链接来读取，不回退到旧的无根限定 `document.*` 接口。指向根外、失效或特殊文件的符号链接不列出；直接请求越界路径仍返回明确错误。二进制、非 UTF-8 及非普通文件不预览。

下载使用 `session.files.download.open/chunk/finish/close`：由服务端固定 Session 根目录及文件句柄，按最多 256 KiB 顺序分块读取，固定大小与文件身份/修改时间检查，完成返回 SHA-256。下载句柄仅对当前服务连接有效，有数量和闲置超时限制；替换连接不会自动重放或续传。手机原生负责磁盘文件，前端只收到进度/任务 ID，不接收整文件正文或任意本地源路径。

目前安全文件访问实现支持 Unix 主机（macOS/Linux）；非 Unix 主机明确返回 `unsupported_platform`，不使用不安全的降级方案。旧版本主机返回不支持时，手机提示升级。现有 `document.*` 接口行为不变，本功能不是对已配对设备全部能力的重新授权。

## 回归验证

```bash
cd mobile
npm test -- src/features/files/FileTreeIcon.test.tsx src/features/files/SessionFiles.test.tsx src/features/files/useFilePageSwipe.test.tsx src/features/files/FileDownloads.test.tsx src/platform/tauriFileDownloadClient.test.ts src/app/App.test.tsx src/features/sessions/SessionWorkspace.test.tsx src/terminal/MobileTerminal.test.tsx
npm run build
cd ..
cargo test -p agentport-service session_file --lib
cargo test --manifest-path mobile/src-tauri/Cargo.toml file_download --lib
cargo test -p agentport-remote-bridge --lib
cargo test -p agentport-remote-protocol --lib
node mobile/scripts/test-session-files.mjs
```

文件树单行样式验证：完整前端856项测试通过，生产构建及Chrome触控回归通过；实测默认行高44 CSS px、层级差16 CSS px、无类型副标题或行分隔线，明暗主题及窄屏/横屏截图复核。包含该改动的签名iPhoneOS包已保留数据覆盖安装并启动，进程路径与本次安装目录一致；实体手机上的新文件树交互仍未独立验收，不以安装成功代替验证。Android本轮未重打包。

最后一项使用隔离的无头 Chrome、真实 App/xterm 及确定性 RemoteClient/保存客户端测试数据，不读取用户 Session，不代替 iOS/Android 系统实际保存、真机网络、键盘或无障碍验证。可用 `CHROME_BIN` 指定 Chrome；设置 `AGENTPORT_FILES_SCREENSHOTS=/tmp/agentport-files-evidence` 保存手机视口截图。
