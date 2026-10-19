# Agent Note: 会话缓存恢复的视觉与资源生命周期

Status: implemented

## Problem

用户反馈缓存会话切回时复制按钮、图片和高亮组件仍闪动。原 DOM 虽保留，原生 fieldset disabled 使子按钮临时透明度降至0.45，未悬停的复制按钮反而闪现再淡出；Activity 重建 effect 又重置复制反馈、撤回已核验复制展示，并释放图片 URL。图片 key 含 viewSelection／historyEpoch，返回后继续重建卡片。原节点保留本身不能保证外观连续。后续完整 Native 页面检查发现，缓存树外的审核标签又绑定了读取编号，Composer 未收到普通加载状态；原生禁用使选择器与发送按钮变淡，Main 确认前提前切换草稿，环境 hook 把选中切换误标成真实不可用。正文夹具无法覆盖这些壳层问题。

## Decision

- 部分替代[初版 DOM KeepAlive](../architecture/2026-10-19-native-conversation-dom-cache.md)中的上述策略，不恢复旧读取资格。缓存页以 aria-disabled、激活事件捕获与各 reader gate 暂停动作，避免原生 disabled 或 inert 改变整树透明度及悬停命中。重新连接的首个绘制周期取消后代过渡，随后保留正常悬停动画。
- UI entry owner 位于 Activity 外，持有登记的展示资源。Native 图片切走时只 abort 未完成读取；准确消息／图片引用决定展示身份，viewSelection／historyEpoch 只决定读取范围。已核验 URL 保留至远离可见区、隐藏窗口、真实移除或 entry 回收；窗口隐藏由 cache owner 统一释放停用树的媒体。
- 图片编码载荷加入原8MiB单项／16MiB合计体积预算，条数和节点预算不变，超限活动内容仍完整显示、离开后释放。不声称限制解码像素或浏览器总 heap。实际组件卸载与 Activity 停用分开，避免删除图片后仍留资源。
- Native adapter 保留同一正文身份的复制展示，按 generation／Store／Session 归属，并在实际关闭、正文改变和缓存回收时撤回。公共 ModelOutputMessage 的 readActive 通知撤回契约不变；Native 所保留的文案只供原 DOM 显示，复制动作仍核当前 gate，不产生网络或提交资格。文件链接同样保留展示，由当前 gate 阻止旧回调。
- 复制成功的短暂反馈按原到期时间恢复。隐藏时停止计时并废止未完成尝试；重新激活不把原反馈直接重置，也不接收迟到剪贴板答复。

- 缓存树外的控件仍复用原 Native／Composer 实例。审核模式只按会话身份保留有界展示值，当前读取编号继续控制操作；Composer 单独保留最近12项控件启用外观，临时禁用不改变透明度及悬停，但原本禁用的空发送保持原样。原生禁用、捕获与当前回调同时阻止交互，范围改变关闭旧弹层。草稿显示等 Main 确认再切换；环境 handoff 使用独立 paused 原因，停止旧 IO 但保留 busy 卡，不混淆真实失败。

- 冷会话不能从其他 Session 的模型标签或全局默认猜测目标路由。导航在 Main 确认目标后，经原模型 GET 准备准确目录，再发布目标页；导航与 Picker 共享原有界展示缓存和该次结果，省去冷首帧的占位与重复读取，暖命中仍立即恢复。准备期间目标 state 暂存一份最新值，目录／全局失败继续发布；所有历史启动入口遵循同一门禁。同模型的新范围也重新发布 ready，迟到准备不启动离开的历史。读取失败结束准备并显示真实错误，不把缺失路由改成默认。

## Alternatives considered

1. 全面保留隐藏组件的 effect：不能保证隐藏读取与监听停止，仍拒绝。
2. 只修改 disabled 透明度：仍改变 hover 选择器，不能解决图片销毁和复制反馈重置。
3. 用 inert 代替 disabled：能阻止输入，但同时退出悬停命中；采用 aria-disabled 与事件／读取 gate 保留可读外观。
4. 只在 Activity cleanup 中保留 URL：真正淘汰已停用树时不会再有同一次 cleanup，容易泄漏；由 Activity 外的有界 entry 负责释放。
5. 无界单独缓存图片：绕过会话预算；改为与同一 entry 共同计量和回收。
6. 给全部 disabled 统一恢复亮度：会把原本禁用的空发送变亮，也会遮住真实失败；只保留已知会话的既有启用外观，并单独标记普通校准。壳层验证使用完整 NativeDesktop，不再由正文夹具推断。
7. 只给模型选择器固定宽度仍会出现占位和名称的两次值变化；套用上个会话或全局默认可能显示错误的持久路由；让所有会话等待模型读取又削弱暖缓存恢复。只为冷会话提前准备准确结果，代价是冷页等待这次原有 GET 结束，已有页面继续可读。

## Consequences

预算内恢复复用已解码图片、复制按钮和文件链接；当前读取仍须重新准入，失败、过期反馈、实际新内容与正常用户交互继续改变显示。超预算、窗口隐藏后重新读取及真实布局重建不在原资源复用保证内。当前行为、执行证据和独立浏览器命令由[桌面手册](../../../../docs/handbook/clients/desktop/README.md)、[UI owner](../../../../packages/ui/README.md)和[Native owner](../../../../apps/desktop/README.md)维护。
