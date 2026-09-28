# Agent Note: Preserve the shared connection during cancelled subscription setup

Status: implemented

## Problem

Desktop 离开子 Agent 详情时会取消该详情的订阅。若取消发生在 `runtime/subscribe` 已发出、回执尚未到达的窗口，Runtime Client 原先立即关闭共享 logical connection，以释放可能已建立的远端订阅。父会话和侧栏也使用该连接；快速切换可能使整个会话列表暂时不可点击。

## Decision

本地订阅等待立即结束；未拿到远端订阅 ID 时，客户端以原订阅请求 ID 调用 `runtime/unsubscribe`，由 Service 在同一连接内定位并清理待建立或已建立的订阅。拿到远端 ID 后仍以 ID 取消。取消接口自身失败或超时才关闭该 logical connection；代际检查禁止旧请求作用于新连接。Desktop 在子历史与投影读取结束后再次核对当前读取身份，已离开时不再投影历史或发起子订阅；进入子详情时脱离父页面订阅，返回时重新校准父页面。

请求身份和取消语义由 [Runtime Protocol](../../../../packages/runtime-protocol/src/codecs.ts) 与 [Runtime Server](../../../../packages/runtime-server/src/server.ts) 拥有；[Runtime Client](../../../../packages/runtime-client/src/client.ts) 只调用取消接口，[Desktop Host](../../../../apps/kite-desktop/electron/runtime/renderer-connection.ts) 将 renderer 请求 ID 映射到对应的 Service 连接代际。具体期限和子会话读取交接见[请求与历史](../../../../packages/runtime-client/docs/requests-and-history.md)。

Desktop 的常驻会话索引订阅独立于当前阅读页；它只更新已知侧栏目录行的状态。离开阅读页释放该页订阅与 Runtime Client 展示快照，Run 仍由 Service 持续执行；侧栏无需为每个后台会话保留页面订阅或查询后台执行列表。目录、订阅、索引的当前分工见[历史目录与连接恢复](../../../../apps/kite-desktop/docs/history-and-recovery.md)。

## Alternatives considered

- 继续在取消时立即关闭连接：能可靠释放未知远端订阅，但正常页面切换也会中断其他会话的读取与导航。
- 保留原请求关联直到回执，再按远端 ID 取消：正常迟到回执可清理，但服务端迟迟不回执时仍只能关闭共用连接；页面切换不应依赖订阅建立的完成时间。

## Consequences

订阅取消不再等待原订阅回执；Service 只结束通知读取，不取消 Runtime Run。取消接口本身无法核实结果时仍以关闭连接作为异常清理边界。Runtime Client、Runtime Server 与真实 Service 的 Desktop 回归分别覆盖请求身份取消、建立中的订阅清理、父子页面切换、多个 Run 并行完成后的侧栏状态及快照回收。
