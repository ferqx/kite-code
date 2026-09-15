# ADR-0187：执行权绑定实际工作，恢复与空间连接分离

状态：accepted
日期：2026-09-14

## 背景

完成的会话继续持有执行租约，休眠后可能进入无法继续的 recovery_required；客户端仅得到 session_unavailable。桌面切换执行空间关闭原服务，扩大了操作影响范围。底层已有多 workspace Host/Store 与恢复事务，无需新增进程池或恢复状态库。

## 决定

Host 在现有会话 mailbox 中串行化命令和空闲释放，等待实际执行 completion 与 coordinator 清理，并由 Store 核对 generation/revision 和 effect 事实。下一次执行按需取得新 generation、重建 Runtime；活动执行保留既有租期作为失联检测。只看到 completed 不构成清理证明。

失权后先中止并等待本地资源，清理确认仍保留 recovery_required。用户继续或显式检查才提交绑定 authority revision 的恢复命令；恢复与业务发送有独立持久回执。查询恢复摘要与命令回执均只读，不扫描全库、不重放未知效果。确认外部结果仍 unknown 不替代旧执行已停止的证据。

Electron 持有同一配套 Service。切换空间仅替换逻辑连接、授权上下文和订阅；新会话显式请求目标 workspace，已有会话按持久 identity 路由，服务始终验证该空间授权。退出应用与显式取消保持真实清理语义。Git 分支改变仍需要重载配置依赖，当前只在配套 Service 全部空闲时执行原关闭、切换、重接流程，不取消其他空间任务；按空间重建配置 owner 留待独立实现。

## 影响与限制

多进程争用、generation、effect lease、mailbox、命令回执和 tombstone 各有独立职责，继续保留。旧版本只留 completed 而没有 cleanup 证明的会话不能自动解锁；缺证据的历史操作保持阻断并给出具体原因。权限设置与执行仍按 ADR-0186 分离，失权清理期间不可使用正在关闭的 coordinator。

当前实现与测试见 [Host 生命周期](../../packages/runtime-host/docs/execution-lifecycle.md)、[Service](../../apps/kite-service/docs/runtime-application.md)、[Store 恢复](../../packages/runtime-storage-sqlite/docs/authority-and-recovery.md)。回滚必须让配套协议客户端和 Service 一起回滚，不以忽略过期或写库伪造清理作为兼容办法。
