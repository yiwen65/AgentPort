# macOS 构建服务上下文失效

## 识别

长时间运行的 Connector/Host 可能在 WindowServer/loginwindow 重建后继续存活，
子进程仍继承旧 bootstrap 上下文。不能仅凭错误码判定原因；需比较同一用户
在独立 Terminal 和 AgentPort Session 中的结果。

典型组合：

- Terminal 中 `xcrun devicectl list devices` 正常，Session 中崩溃。
- Session 中 `id -un` 只返回数字 UID，签名身份查询返回 0。
- `launchctl managername` 失败，`launchctl asuser` 返回 141。
- 清理 `XPC_FLAGS` 等环境变量无效：bootstrap/audit context 不是环境变量。

不要因此重置钥匙串、删除证书、重装 Xcode 或关闭现有 Session Host。
新建 Session 若仍由旧 Connector 创建，也可能继承同样问题。

## 本次已验证的恢复路径

1. 从健康的系统 SSH 服务建立新的同用户本机连接，核验主机公钥。
2. 在该连接中验证用户识别、设备服务及签名身份查询恢复。
3. 后台 SSH 中直接签名可能报 `errSecInternalComponent`；不能把能枚举证书
   等同于能使用签名私钥。直接 `launchctl asuser` 也可能被 audit session 权限拒绝。
4. 通过健康上下文的 LaunchServices 在 GUI Terminal 打开固定构建脚本，让构建
   在正常登录会话中执行；成功后再安装、启动 App。

如需临时 SSH 授权，必须先取得用户明确许可，只授权 loopback 来源、禁用转发和
PTY、限制为固定命令，使用内存中的临时私钥，并在成功/失败后移除该条授权。
不得替换已有 authorized_keys、关闭主机公钥验证或留下通用远程命令入口。
正常 Terminal 已可用时，直接在那里运行构建脚本更简单，无需修改 SSH 授权。

2026-09-07 验证：上述路径完成包含 `9183ad4` 的 iPhone Debug 构建、签名、安装
及启动。临时授权已移除，没有终止 Connector/Host。此流程恢复的是构建安装的
执行路径，不会原地修复已存活进程的 bootstrap 上下文。长期 Connector 生命周期
恢复仍需独立设计，不能通过强杀 Host 解决。
