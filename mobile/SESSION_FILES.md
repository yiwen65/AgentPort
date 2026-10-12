# Session 项目文件（只读）

在 Session 终端向左滑动，或展开终端顶部控制区后点击文件夹按钮，进入项目文件树。文件树右滑或点击「终端」返回；预览页点击「文件树」先返回目录。预览页的横向滑动用于阅读长代码行，不切换页面。

- 根目录是电脑端记录的 Session `cwd`，不跟随终端临时 `cd`，也不会替换成项目主 checkout。
- 文件夹按需加载；每次进入、重新连接或手动刷新会重新读取已加载目录。展开状态和树的滚动位置在页面往返时保留，不停止 Session。
- 文本/代码只读，支持常见代码语言高亮；Markdown 支持渲染/源码切换。可复制相对文件路径和文件内容。大型文本跳过语法高亮，仍可阅读和复制。
- 不包含编辑/新建/删除/重命名、Git 标记、搜索、图片预览或文件系统实时监听。

## 下载与另存为（iOS / Android）

文件行右侧「⋯ → 下载文件」，或只读预览中的「下载文件」，可下载根目录内的单个普通文件。文件类型不限，最大 **1 GiB**。无法预览的图片、PDF、压缩包等仍可下载；下载的是完整原始字节，不是 1 MiB 的文本预览片段。

- App 全局同时运行一个任务，显示文件名、已传输量/总量、进度及取消。切回终端或切换 Session 不会取消原任务；详情显示来源主机/Session/路径。
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
npm test -- src/features/files/SessionFiles.test.tsx src/features/files/FileDownloads.test.tsx src/platform/tauriFileDownloadClient.test.ts src/app/App.test.tsx src/features/sessions/SessionWorkspace.test.tsx src/terminal/MobileTerminal.test.tsx
npm run build
cd ..
cargo test -p agentport-service session_file --lib
cargo test --manifest-path mobile/src-tauri/Cargo.toml file_download --lib
cargo test -p agentport-remote-bridge --lib
cargo test -p agentport-remote-protocol --lib
node mobile/scripts/test-session-files.mjs
```

最后一项使用隔离的无头 Chrome、真实 App/xterm 及确定性 RemoteClient/保存客户端测试数据，不读取用户 Session，不代替 iOS/Android 系统实际保存、真机网络、键盘或无障碍验证。可用 `CHROME_BIN` 指定 Chrome；设置 `AGENTPORT_FILES_SCREENSHOTS=/tmp/agentport-files-evidence` 保存手机视口截图。
