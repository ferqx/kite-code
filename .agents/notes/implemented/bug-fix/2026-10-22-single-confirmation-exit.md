# Agent Note: 桌面退出只确认一次并立即关闭界面

Status: implemented

## Problem

2026-10-22 用户明确要求退出应用最多提示一次，随后澄清“未清理完可以在后台继续进行，客户端界面必须关闭”。原 Native 在首次确认后仍保留窗口等清理，二十秒后还会弹“继续等待／强制退出”；清理失败另弹警告。即使改为二十秒后自动强退，窗口仍需等清理，且会中断本可在后台完成的收尾。

## Decision

当前 [Native Main](../../../../apps/desktop/electron/main.ts)保留空闲直接退出、活动或未知任务默认保留服务的一次确认。选择退出后，由菜单、信号与开发父通道共用一个停止 owner；提交原停止 Promise 后，在任何清理await前清空全局窗口引用并hide原窗口／Native展示；原页面和page host只留作后台准确释放，Service原lease释放及exited确认后才destroy窗口，macOS 同时 hide 应用和 Dock。最后窗口关闭不提前退出 Main，activate、ready-to-show 与迟到 whenReady 不能重新展示界面。原 Main 持有启动、在途重载和资源关闭 Promise，在后台收尾完成后才退出；没有默认二十秒强杀，不追加提示。无可用窗口时确认不绑定父窗口，窗口或确认异常仍结束界面并收尾。

确认未答时，已开始的启动和重载在交接前等待同一次决定；取消后恢复原 Promise，确认或外部停止后继续清理。真实回归复现了缺少该屏障的竞态：旧 Service 在确认期间关闭完成，重载便因临时 quitting 拒绝，用户随后保留服务也无法打开 caller。屏障覆盖旧 Service 关闭后，以及在途新 Service／Profile 取得后的检查点；不让新调用绕过退出封门。退出中迟到的窗口加载错误不再追加启动错误框。

[收尾函数](../../../../apps/desktop/electron/quit-settlement.ts)只等待一个清理 Promise，不持有期限或提示回调。实际清理失败时保留准确所属 child 句柄与 `finally app.exit(1)`，不扫描其他进程；取消和文件副作用未知仍保留原记录。该决定替代[正常退出决定](2026-10-21-paired-graceful-exit.md)与[helper 收尾决定](2026-10-10-native-main-helper-shutdown.md)中 Native 等待期间保留界面、二十秒后继续等待／再次确认的策略。paired launcher 无默认五秒强杀、Service 信号 drain、helper 实际关闭与共享 daemon 权限边界继续适用。

## Alternatives considered

- 保留可见窗口直到清理结束：清理、启动或重载卡住时界面也卡住，违反确认后立即关闭界面的要求。
- 保留二十秒自动强退：虽无第二次确认，仍会中断本可在后台继续的正常清理；用户已明确允许后台收尾。
- 确认后立即强杀：窗口会消失，但主／子 Run 和工具来不及保存终态；保留原 Main 静默清理能继续使用原资源 owner。
- 保留二十秒后的继续等待选项：会再次要求用户决定，与本次明确的单次确认要求冲突。
- 另建后台 daemon 或转移原清理：会增加资源和 authority 交接；保留现有Main即可在无可见界面时继续清理。

## Consequences

界面关闭不作为业务成功或清理已确认的证据；清理未完时原进程和使用锁仍可在后台存在，不能据此允许卸载或维护写入。实际失败后的强退仍可能中断终态或副作用，下次启动按原会话与恢复资料核对。首次取消保持原服务、页面和草稿，普通关闭窗口仍只隐藏。

[有限 Main 回归](../../../../apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts)与 helper 共32项／340条断言通过，核销毁窗口先于关闭、原启动／重载后台等待、晚到 ready 不建窗口、取消恢复及外部停止接管；[实际 Electron 退出 driver](../../../../apps/desktop/test/native-quit-electron.fixture.ts)核单次确认、窗口一秒内销毁、实际 Service 暂停超过20.5秒仍在无窗口后台等待、恢复后自然退出0、异常 Service、双锁释放和零 Model 重放。2026-10-22 macOS 当前源码外完整窗口回归1项／42条Bun断言及driver断言通过。原生系统消息框仍由隔离 dialog port 代答，不将本机自动场景称为人工系统点击、Windows／Linux原生或完整发行资格。

2026-10-29浏览器007实机重新打开了立即destroy这一实现取舍：窗口和页面先销毁，Service原租约随后revoke／release被拒stale，正确的unknown监督使正常退出无法确认，最终隔离夹具强杀Main和原Service。不能把stale一概解释为释放成功，因为身份变更和意外销毁同样产生该错误。当前保留原立即关闭可见界面、一次确认和无额外期限的产品行为，只将destroy移到真实释放及子进程退出之后；旧10-22窗口证据保留为当时制品，不证明新候选。原Main／BrowserPageHost／DesktopTransport的agent／human关闭先红后绿，完整生命周期32通过、3项Windows专用跳过、387断言，退出结算5项18断言和Desktop类型通过；真实候选正常退出仍待后续客户端核实。
