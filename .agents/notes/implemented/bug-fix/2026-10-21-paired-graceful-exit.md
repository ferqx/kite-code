# Agent Note: 配套进程正常退出等待原终态与资源收尾

Status: implemented

## Problem

用户在退出客户端后仍看到多 Agent 会话 running。原保存记录说明 Run／工具未结算而执行组锁已释放，但不能单独还原当时具体退出事件。实际回归证实两条独立缺陷：paired launcher 普通 close 在5秒后强杀原 child，早于 Native 的20秒等待选择；配套进程没有处理 SIGINT／SIGTERM，进程组信号可在进入 Runtime drain 前终止它。Native 开发父通道错误也会直接退出 Main，握手前停止则可能丢失。

这些窗口可以留下正在执行或取消中的持久记录。读取时把它们显示为待核实可以保留事实，但不能代替修复正常退出。

## Decision

普通 paired close 结束本次私有父通道，等待原 child 实际退出，不再隐式套用5秒硬停止。只在可信 owner 明确指定 shutdownTimeoutMs，或启动准入／bootstrap 协议失败时，保留本次 child 的有界强制回收；后者默认5秒。2026-10-22 [单次确认退出决定](2026-10-22-single-confirmation-exit.md)替代 Native 原二十秒继续等待／再次确认策略：用户确认后立即销毁界面，Main 在后台保留原收尾直到完成；本篇的 Service drain 与 paired launcher 边界继续适用，真实异常不补写成功。

配套进程收到 SIGINT／SIGTERM，执行与父 EOF 相同的 Service／Runtime drain。启动输入未完整时可取消准确 reader；装配已开始时保留原 Promise，等返回后关闭真实资源。运行中的模型、工具与子 Agent 沿原 owner 取消，终态和 Store／Worker／lease 收束成功后才正常退出。失败 drain 继续保资源和诊断。

Native 的信号、开发父 EOF／error／close 共用一次停止意图和资源 close；异步菜单检查、用户决定与异常返回不能撤销后来已接管的停止。控制器在认证前收到 stop 也保存意图，准确连接到来后立即 EOF，不授予错误 token 或迟到 reload 新资格。原[本实例原子停止接纳](../architecture/2026-10-02-atomic-service-shutdown.md)与[开发重载](../architecture/2026-10-14-desktop-development-reload.md)合同继续适用。

## Alternatives considered

- 把 launcher 的5秒改为20秒或更长固定值：仍可能提前强杀，不能证明终态已保存；普通 paired close 因而等待真实收尾。Native 按[新决定](2026-10-22-single-confirmation-exit.md)先关闭界面，再由原 Main 在后台继续清理。
- 只让 Main 捕获信号：终端进程组信号也可直接到达 Service；两层各自等待所属资源，不依赖谁先收到信号。
- 只在重开时改写旧 Run 终态：进程／锁消失不能证明外部副作用和清理已确认；保留显式恢复边界，不让只读展示取得写权。
- 为退出建立新的任务登记或全 Profile 扫描：会复制 Runtime owner 事实并可能取消其他 Service；沿原自有执行、父通道和 exact child。
- 收到信号便直接 race 丢弃启动装配：会失去已取得资源的 owner；仅未完成的启动读取可取消，装配必须完整交接和关闭。

## Consequences

正常关闭可能合法超过旧5秒期限；当前 Native 按[单次确认退出](2026-10-22-single-confirmation-exit.md)立即关闭窗口并在后台等待原清理，不再以二十秒截断。测试为失败收尾指定的显式 hard timeout 保持，强制退出仍属于结果待核实。共享 daemon 的普通客户端 detach 不获得停止权。

[真实三层 paired 回归](../../../../apps/service/test/isolated/paired-shutdown.test.ts)核 EOF／本机 POSIX 信号、5.5秒时仍在原清理屏障、释放后的自然退出0与冷读 Run 全部取消、零在途 Execution／Job及零 Model 重放。[Main 有限宿主回归](../../../../apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts)核进程退出先后、菜单／信号接管与资源幂等；[父控制回归](../../../../tests/isolated/unified-agent/development-desktop-reload.test.ts)核认证前停止和迟到结果。有限宿主不冒称真实 Electron 窗口，POSIX 信号不代证 Windows；完整平台和发布资格继续独立核对。
