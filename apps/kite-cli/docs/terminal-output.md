# 终端输出与 RenderEpoch

用户可观察行为见[终端指南](../../../docs/handbook/clients/tui/guides/terminal-behavior.md)。入口：[OutputArea](../src/tui/OutputArea.tsx)、[useStaticContent](../src/tui/render/useStaticContent.tsx)、[Timeline](../src/tui/presentation/timeline.ts)。

主屏与原生 scrollback 是输出载体。Static 位于 OutputArea 的零高 overflow hidden Box 内，不外置到 App root。render 只消费 Timeline，不再决定业务完成；只有连续安全前缀取得静态物理所有权，后方 mutable item 留在 dynamic tree。

Session、clear、theme/language、model header 和双向 resize 推进独立 RenderEpoch。epoch 进入 Static 与动态 React identity，block id 单调、不因 clear 归零；Overlay 只挂载自身子树，不改变 App 根 key。

整体重绘以 DEC synchronized output 包围完整帧。终端写入在 commit/layout effect 执行，React render 阶段不得写 stdout。resize 去抖后更新真实布局 generation；root 不使用撑满屏幕 spacer，动态帧保留 Ink 全屏阈值余量。

visualDigest 只包含 renderer-visible 输入，业务 fence 不进入像素摘要；sealed item 的 digest 在同一 epoch 不变。没有变化的 render model 保持引用稳定，Footer 队列更新不重算 OutputArea。

消息区不实现行估算、viewport culling 或历史裁剪。Overlay 列表可虚拟化；并发子任务步骤按真实剩余空间显示，不以新增输入队列强制折叠。内容隐藏只影响展示，不删除 Runtime 事实。

FocusIn/Out 只进入共享 focus store，不解释成 Esc。当前工作树的 [useActivityClock](../src/tui/components/use-activity-clock.ts) 为已挂载活动指示器共享 250ms 定时器，最后一个订阅者退出后停止；[StatusBar](../src/tui/StatusBar.tsx) 和工具卡消费该时钟更新显示。它不写 Runtime 状态，但可能触发终端重绘。

这与[终端手册](../../../docs/handbook/clients/tui/guides/terminal-behavior.md)现有“无执行事件或用户操作时不因计时持续刷新”的预期冲突，尚未在本轮确认新行为取代旧预期。[Shell 活动测试](../test/tui-shell-activity.test.tsx)明确断言等待时产生新帧，不能作为运行中静默的证据；完成后静默与运行中静默需分别验证。待决项见[Backlog](../../../docs/plans/backlog.md#tui-活动时钟与终端静默)。

验证：[渲染](../test/tui-mock-render.test.tsx)、[Timeline](../test/tui-timeline-closeout.test.ts)和相关 resize/scrollback PTY。设计理由：业务 terminal 与物理输出生命周期不同，混用会重复写入 append-only scrollback。
