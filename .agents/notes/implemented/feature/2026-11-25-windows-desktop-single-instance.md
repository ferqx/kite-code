# Agent Note: Windows 桌面单实例与原窗口恢复

Status: implemented

## Problem

Windows 用户重复点开桌面应用时，另一 Electron Main 可以继续申请私有存储并尝试启动服务。已有窗口在托盘隐藏或最小化时尤其容易重现。重复操作应唤起原窗口并保留原主进程持有的会话、草稿和任务。

## Decision

Windows Desktop 在正式候选核验之后、窗口和 Service 初始化之前取得 Electron 单实例锁，以应用数据目录和可执行文件名区分。第二实例正常退出，原进程按现有托盘行为恢复并聚焦窗口。Root 尚未就绪时合并激活，待原窗口准备好后处理。主进程从启动到退出收尾持有该锁。使用权核验与业务许可各自继续沿原入口。相关实现与验证归 [Desktop owner](../../../../apps/desktop/README.md#windows-托盘与窗口图标)。

## Alternatives considered

- 在私有 Profile 或 SQLite 层拒绝。它们已经能保护数据，但只会在更晚阶段拒绝，第二次启动也无法通过该锁唤醒原窗口。
- 在原生 launcher 新增跨进程要求。Electron 已支持以同一应用身份互斥并向原实例发出激活事件，无需另建 Windows 管道或窗口查找机制。

## Consequences

同一 Electron 应用数据与映像名只允许一个运行中的桌面宿主，测试制品可使用各自独立的数据目录。重复启动时原窗口负责激活，原有 Service 与 Profile 保持归属。退出收尾完成后，下一次启动取得新的锁。
