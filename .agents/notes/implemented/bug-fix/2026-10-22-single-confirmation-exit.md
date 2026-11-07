# Agent Note: 明确退出立即关闭界面并在五秒内结束进程

Status: implemented

## Problem

2026-10-22 用户明确要求退出应用最多提示一次，随后澄清“未清理完可以在后台继续进行，客户端界面必须关闭”。原 Native 在首次确认后仍保留窗口等清理，二十秒后还会弹“继续等待／强制退出”；清理失败另弹警告。即使改为二十秒后自动强退，窗口仍需等清理，且会中断本可在后台完成的收尾。

2026-11-06 用户进一步明确：只要选择退出，就必须立即退出可见界面，任何活动检查、确认或失败提示都不能要求用户等待。随后同日进一步要求“直接退出进程，不超过5s”，撤销无限后台等待。当前采用4秒清理截止，给实际进程结束留余量；正常释放与强退未知事实仍分别核对。

## Decision

当前[Native Main](../../../../apps/desktop/electron/main.ts)收到明确退出时，直接进入菜单、信号与开发父通道共用的唯一停止owner，停止新准入并立即隐藏窗口／Native展示和托盘，macOS同时hide应用与Dock。不读取活动工作、不等待确认、不提供取消退出，也不发送退出确认失败Toast。activate、ready-to-show及迟到whenReady不能重新展示界面。正常清理期间原页面和page host保留到Service准确lease释放及exited确认后才destroy，避免把意外销毁造成的stale当释放成功。在停止入口即启动4秒截止，正常清理可提前结束Main；仍在等待启动、重载或资源关闭时，到期沿准确自有Service句柄终止并退出1，使整个退出不超过5秒，不追加提示。

旧可取消确认曾需要在启动及重载交接点等待同一次决定，避免用户保留服务后仍卡在draining。现在明确退出不再撤销停止意图，相关决定Promise与等待屏障一并删除；在途资源仍交回同一owner准确关闭，不让迟到完成发布新caller或窗口。退出中的迟到窗口加载错误仍不追加启动错误框。

[收尾函数](../../../../apps/desktop/electron/quit-settlement.ts)核原清理Promise及4秒期限；完成后退休计时，迟到完成或失败不能二次退出。实际清理失败或到期时保留准确所属child句柄与`finally app.exit(1)`，不扫描其他进程；取消和文件副作用未知仍保留原记录。该决定替代[正常退出决定](2026-10-21-paired-graceful-exit.md)与[helper 收尾决定](2026-10-10-native-main-helper-shutdown.md)中 Native 等待期间保留界面、二十秒后继续等待／再次确认的策略。paired launcher 无默认五秒强杀、Service 信号 drain、helper 实际关闭与共享 daemon 权限边界继续适用。

## Alternatives considered

- 只隐藏界面、无限后台等待：进程仍可长期存在，不符合用户最新五秒退出上限。
- 退出前等待状态读取或确认：Service或对话框异常会挡住用户退出。
- 立即终止所有工作：正常清理通常可很快完成，保留至多四秒用于准确释放和保存终态；到期不再等待。
- 给paired launcher的所有宿主强加同一期限：扩大用户要求；本次仅Native Main明确退出施加截止，其他宿主的原关闭契约保持。
- 另建后台daemon或转移原清理：增加资源和authority交接，不能解决当前进程五秒结束要求。

## Consequences

界面关闭不作为业务成功或清理已确认的证据；清理期限内原进程和使用锁仍可能存在；到期强退后仍须按真实进程和锁事实判断维护资格。实际失败后的强退仍可能中断终态或副作用，下次启动按原会话与恢复资料核对。普通关闭窗口仍只隐藏并可激活恢复；明确退出没有取消分支。

2026-10-22当时的[有限 Main 回归](../../../../apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts)与 helper 共32项／340条断言通过，核销毁窗口先于关闭、原启动／重载后台等待、晚到 ready 不建窗口、取消恢复及外部停止接管；[实际 Electron 退出 driver](../../../../apps/desktop/test/native-quit-electron.fixture.ts)核单次确认、窗口一秒内销毁、实际 Service 暂停超过20.5秒仍在无窗口后台等待、恢复后自然退出0、异常 Service、双锁释放和零 Model 重放。2026-10-22 macOS 当前源码外完整窗口回归1项／42条Bun断言及driver断言通过。原生系统消息框仍由隔离 dialog port 代答，不将本机自动场景称为人工系统点击、Windows／Linux原生或完整发行资格。

2026-10-29浏览器007实机重新打开了立即destroy这一实现取舍：窗口和页面先销毁，Service原租约随后revoke／release被拒stale，正确的unknown监督使正常退出无法确认，最终隔离夹具强杀Main和原Service。不能把stale一概解释为释放成功，因为身份变更和意外销毁同样产生该错误。该轮保留了立即关闭可见界面、一次确认和无额外期限的行为，只将destroy移到真实释放及子进程退出之后；旧10-22窗口证据保留为当时制品，不证明新候选。原Main／BrowserPageHost／DesktopTransport的agent／human关闭先红后绿，完整生命周期32通过、3项Windows专用跳过、387断言，退出结算5项18断言和Desktop类型通过；上述历史记录不授予本轮五秒退出资格，当前输入与验证归[Native owner](../../../../apps/desktop/README.md#原窗口关闭与退出收尾)。
