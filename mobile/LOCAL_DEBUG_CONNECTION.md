# 持久本地调试连接（macOS → iOS Simulator）

模拟器中的 `Local AgentPort Debug` 通过 `127.0.0.1:51222` 连接当前用户的
AgentPort 数据库。此端口只供本机使用；真机上的 `127.0.0.1` 不指向 Mac。

## 安装 / 重建

1. 构建桌面调试包：`bash scripts/rebuild-debug-app.sh`。
2. 在移动端设备配置中生成 Ed25519 密钥并保存配置。私钥由移动端 Keychain
   保管；将界面返回的**公钥**保存为本机文件，不要导出私钥。
3. 在仓库根目录以当前登录用户运行（不要 sudo）：

   ```bash
   python3 scripts/setup-mobile-debug-ssh.py --public-key /path/to/mobile.pub
   ```

4. 在移动端连接 `用户名@127.0.0.1:51222`，核对脚本输出的 SHA256 主机指纹。
   更换主机密钥时，必须核对并重新确认信任，不能关闭主机密钥校验。

安装后再次运行 `python3 scripts/setup-mobile-debug-ssh.py` 即可重启服务，
**保留**已有服务器密钥和授权公钥。只有显式传入 `--public-key` 才会替换
授权公钥（此端点仅保留一个移动端授权）。移动端重装或清除 Keychain 后需重新绑定。
移动端 App 冷启动后仍需点击 Connect；本脚本不改变 App 的自动连接策略。

## 持久位置

- 服务：`~/Library/LaunchAgents/com.agentport.mobile-debug-ssh.plist`
- 配置、服务器密钥、授权公钥与日志：`~/.local/share/agentport-mobile-debug/`
- 数据库：`~/Library/Application Support/AgentPort/`
- Bridge：安装时 checkout 的 `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport-remote-bridge`

LaunchAgent 在**用户登录后**自动启动，监听进程退出后由 launchd 拉起；不依赖
临时目录中的配置或密钥。目录权限 0700，私钥权限 0600。Bridge 的 TMPDIR
使用该 macOS 用户的系统临时目录，与桌面 Host 的 socket 路径一致。
移动或删除 checkout 后需在新 checkout 中重新运行安装脚本。

仅允许公钥认证与固定 `agentport-remote-bridge serve --stdio` 命令；禁用
密码、root 登录、PTY、用户 SSH RC 和端口转发。不修改系统 sshd 或 `~/.ssh`。
这仍授予移动端该用户的 AgentPort 操作权限，不是只读连接。

## 维护

```bash
# 状态及日志
launchctl print "gui/$(id -u)/com.agentport.mobile-debug-ssh"
tail -n 40 "$HOME/.local/share/agentport-mobile-debug/sshd.log"
lsof -nP -iTCP:51222 -sTCP:LISTEN

# 重启（不终止 agentport-host）
python3 scripts/setup-mobile-debug-ssh.py

# 停用到下次登录
launchctl bootout "gui/$(id -u)/com.agentport.mobile-debug-ssh"
```

永久停用时在 bootout 后删除上述单个 LaunchAgent plist。保留持久目录可在以后
恢复同一主机身份；不要把其中的服务器私钥加入 Git。服务不需要管理员权限。

## 本次验证边界

已验证 sshd 配置校验、仅 loopback 监听、密钥文件权限、非 Bridge 命令拒绝、
重复安装保留主机指纹、监听进程退出后 launchd 自动拉起，以及 iOS 26.5
Simulator 经 Keychain 公钥认证、Bridge v1.1 协商、服务重启后重新连接和真实
Session 列表读取。未通过重启整台 Mac 验证登录流程；自动登录启动依据为已加载的
RunAtLoad / KeepAlive LaunchAgent 配置。
