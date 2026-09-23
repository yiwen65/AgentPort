# 个人自用 iPhone 后台 Agent 提醒

本功能只适用于自己控制的 Mac/iPhone，不是公开多用户推送服务。Mac 上的独立 `agentport-connector` 检测已有持久语义事件（待审批、轮次完成、执行失败），通过 APNs 发送只含事件类别、不透明主机 ID 与 Session ID 的**可见警报**。没有 Agent 回复正文、终端输出或秘密。iPhone 不依赖后台连接或静默推送；点击后验证已配对的 Mac 并通过现有消息箱补收。APNs 接受请求不等于手机展示，更不等于已读；系统可能延迟、合并或丢弃。

## 前提与配置

1. 在 Apple Developer 为 `com.agentport.mobile` 对应的 App ID 启用 Push Notifications，并用包含 `aps-environment` 的 profile 对 iPhone App 正确签名。Debug 使用 sandbox，TestFlight/发行包使用 production。当前实现不修改开发者网站或读取 Apple 凭据；没有这些前提，不能验证真实锁屏投递。iOS 原生授权被拒绝时手机仍可前台增量补收。
2. 配对 iPhone 与 Mac 的 Relay；普通 SSH/Mosh profile 不具备这里所需的已认证设备公钥，不能登记推送 token。首次打开有配对 Relay 的手机 App 时授权系统通知；手机通过端到端加密的认证注册通道把 APNs token 绑定至该手机公钥。撤销配对会删除该 token；与撤销同时进行的发送请求及此前已被 APNs 接受的警报仍可能稍后出现。
3. 仅在自己控制的 Mac 上取得与 App 签名 Team 一致的 Apple APNs `.p8` 私钥、**Key ID** 与 **Team ID**。不可把私钥放入仓库、App 安装包、命令行参数、二维码或 Relay 配置。将私钥文件权限设为 `0600`，使用此安装包的 `agentport-connector` 导入同一安装/data-root 正在运行的 connector：

   ```bash
   "<APP>/Contents/MacOS/agentport-connector" \
     --data-dir "<该安装使用的 AgentPort 数据目录绝对路径>" \
     --configure-apns-key-file "<私有 AuthKey_XXXXXXXXXX.p8 绝对路径>" \
     --key-id "<10 位 Key ID>" --team-id "<10 位 Team ID>" \
     --topic com.agentport.mobile --environment production
   ```

   调试签名的 iPhone App 改用 `--environment sandbox`。CLI 通过同 UID 私有 Unix socket 把私钥导入 Mac 钥匙串，只在私有 state JSON 保存账号引用和非秘密标识；不会打印私钥。导入后必须**重启该安装的 connector**让新凭据生效；不要杀掉 Session Host，也不要对整个 App 路径使用 `pkill -f`。可从桌面 App 的手机配对设置明确 Stop/Start connector；这会短暂断开手机 Relay，但不会停止 Session。配置错误、私钥不可用或对应环境不匹配时不发送 APNs，前台消息箱仍正常工作。
4. Mac 必须保持开机、联网，Relay connector 必须运行；它关闭 GUI 后继续运行，但没有系统开机/登录自启。Mac 重启后先打开桌面 App。

**安全边界：** APNs 私钥只适合这一受控个人安装。不得把相同 Team 的 `.p8` 密钥预置在面向其他用户发行的 Mac App 中；公开多用户用途需要独立受控 provider。更换设备 token/环境后手机会在下次启动或回前台重新注册；无已授权手机、无私钥或无 Apple Push capability 时不会假装推送成功。通知失败或错过时以手机回前台后的 `attention.poll` 消息箱为准。

## 验证限制

代码测试可验证签名请求结构、配对身份、存储与游标、通知点击冷启动元数据。**本次未提供真实 Key ID/Team ID/.p8，也未配置 Apple 开发者网站；真实设备锁屏/退出态的 APNs 投递和点击导航必须在签名 iPhone 上另外验收。**
