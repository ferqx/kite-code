# 终端输出与 RenderEpoch

用户可观察行为见[终端指南](../../../docs/handbook/clients/tui/guides/terminal-behavior.md)。入口：[OutputArea](../src/tui/OutputArea.tsx)、[useStaticContent](../src/tui/render/useStaticContent.tsx)、[Timeline](../src/tui/presentation/timeline.ts)。

主屏与原生 scrollback 是输出载体。Static 位于 OutputArea 的零高 overflow hidden Box 内，不外置到 App root。render 只消费 Timeline，不再决定业务完成；只有连续安全前缀取得静态物理所有权，后方 mutable item 留在 dynamic tree。

Session、clear、theme/language、model header 和双向 resize 推进独立 RenderEpoch。epoch 进入 Static 与动态 React identity，block id 单调、不因 clear 归零；Overlay 只挂载自身子树，不改变 App 根 key。

整体重绘以 DEC synchronized output 包围完整帧。终端写入在 commit/layout effect 执行，React render 阶段不得写 stdout。resize 去抖后更新真实布局 generation；root 不使用撑满屏幕 spacer，动态帧保留 Ink 全屏阈值余量。

visualDigest 只包含 renderer-visible 输入，业务 fence 不进入像素摘要；sealed item 的 digest 在同一 epoch 不变。没有变化的 render model 保持引用稳定，Footer 队列更新不重算 OutputArea。

消息区不实现行估算、viewport culling 或历史裁剪。Overlay 列表可虚拟化；并发子任务步骤按真实剩余空间显示，不以新增输入队列强制折叠。内容隐藏只影响展示，不删除 Runtime 事实。

FocusIn/Out 只进入共享 focus store，不解释成 Esc。当前工作树的 [useActivityClock](../src/tui/components/use-activity-clock.ts) 为已挂载活动指示器共享 250ms 定时器，最后一个订阅者退出后停止；[StatusBar](../src/tui/StatusBar.tsx) 和工具卡消费该时钟更新显示。StatusBar 仅用共享时钟推进动画，不维护本地耗时基准，也不显示整轮计时。共享时钟不写 Runtime 状态，但可能触发终端重绘。

动态区域由根容器与消息区的实际布局约束高度，保留终端全屏阈值余量；使用完整的有界动态帧重绘，关闭 Ink 的增量行绘制，避免活动窗口增高时留下旧题头。它不重放已取得 Static 所有权的历史。审批仅接管输入，运行中工具按各自状态更新；错峰启动的小圆点共享动画相位，耗时仍独立计算。

[activityDot](../src/tui/components/activity-dot.ts) 每 1000ms 切换圆点与等宽空白，完整周期为两秒；动画相位由共享时钟计算，不改变时钟采样间隔或耗时计算。

验证必须分别检查进行中和完成后：[动态滚动](../../../tests/tui-system/scenarios/live-scroll.test.ts)持续采样题头、旧输出残留和上滚位置；[两轮子任务](../../../tests/tui-system/scenarios/thought-scroll-live.test.ts)覆盖长 reasoning 与并发子任务的活动过渡。终态画面正确不能替代中间帧证据。

验证：[渲染](../test/tui-mock-render.test.tsx)、[Timeline](../test/tui-timeline-closeout.test.ts)和相关 resize/scrollback PTY。设计理由：业务 terminal 与物理输出生命周期不同，混用会重复写入 append-only scrollback。
