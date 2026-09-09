# Mobile foreground replay veil

- Status: verified
- Authority: 用户要求“排查修复”；不重启现有Host/Agent，无子代理。
- Baseline: `5893766`。

## Failure and causal evidence

完整快照修复保证最终状态，不保证恢复中间帧不可见。真机Mobile页面后台返回时，逐帧记录显示：

- `at=313018ms`: visible / attaching，只有一条输入框边框。
- `at=313119ms`: visible / attaching，两条边框完整。
- `at=313136ms`: visible / live。

因此本次捕获的问题发生在回放阶段，而非最终画面缺失。Workspace仅在Stop时遮挡终端；foreground recovery没有视觉屏障，ReplayDone也只等待parser callback，没有等待实际render。

证据：`/tmp/agentport-flicker-red-frames.json`。回归最初在“恢复开始后仍无遮挡”断言失败：`/tmp/agentport-flicker-regression-red.log`。

## Fix

- hidden阶段预置不透明终端表面遮罩，foreground/断线恢复保留遮罩。
- ReplayDone → parser barrier → 注册xterm onRender并请求refresh → 同generation才移除遮罩。
- 重复恢复、替换render waiter、组件释放均有取消/代际隔离。
- 不对xterm使用display/visibility隐藏，不卸载，不改焦点；原生textarea与渲染器继续工作。
- 恢复时显示现有“重连中/附加中”提示，失败显示“附加失败”，保留页面Retry。
- 不改变首次冷attach既有小尾部显示策略；不改变Host协议、已有Agent生命周期或输入重放语义。
- 此版本使用恢复提示，不是冻结上一帧截图；短暂恢复提示仍可能可见，不宣称零过渡。

## Verification

- Mobile完整前端372测试通过，TypeScript检查通过；新增parser/render分离、陈旧generation不能揭罩、render订阅替换与卸载取消、遮罩不替换/隐藏已聚焦textarea测试。
- iPhone调试App在03:12安装。两次后台切换实测：
  - 约14.2秒hidden：378帧，底层缺边发生时遮罩存在，未遮挡缺边帧0。visible→揭罩约806ms。
  - 约49.5秒hidden：799帧，未遮挡缺边帧0。visible→揭罩约1089ms。
- 遮罩实际计算背景`rgb(40,44,52)`（不透明），z-index10；揭罩时已live且边框完整。
- 记录：`/tmp/agentport-flicker-green-frames.json`、`/tmp/agentport-flicker-green-long-frames.json`；截图对应`/tmp/agentport-flicker-green.png`及`green-long.png`。
- Inspector临时监听器和terminal引用均移除。未向Agent输入测试内容或发送停止/重启请求。
- 按统一脚本`--skip-build`重开未修改的桌面调试GUI，PID87706精确路径确认；`/tmp/agentport-flicker-debug.png`确认非空白。iOS生成文件已恢复构建前副本。

## Limits

验证的是此次捕获的foreground replay中间态，非所有实时TUI分片重绘、所有主题或所有输入法情形。未单独进行键盘已弹出时的物理按键验收。现有LEARNS中parser/render与不透明veil条目已覆盖本次教训，不重复添加；未改动其无关工作。
