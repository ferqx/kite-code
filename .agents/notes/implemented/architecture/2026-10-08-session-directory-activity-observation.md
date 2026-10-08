# Agent Note: 会话目录复用原状态与封存事件时间

Status: implemented

## Problem

原 PC 侧栏需要全局会话的运行／待输入状态和更新时间排序。当前选择的 view 不能证明未打开会话的状态，Run 开始／完成时间也不能覆盖无 Run 的改名等实际变化。重构已经固定 Store baseline 与维护格式；客户端读取不应为了展示创建另一份运行权威或修改数据格式。

## Decision

在原 Session 目录的同一只读事务提供有限 activity：准确 active Run 优先、否则 latest Run 的原 ID/status/isActive/必需结果等待，未取消且越过停止边界的 accepted 新运行，以及同主体当前 Store 的 pending presentation Interaction 数量。时间只取该 Session 最后 Core event 已封存的 `kite.session-log@1.occurredAt`；未知／缺席／损坏时间保持 null，不补写旧历史。原日志封存决定与导航资格继续适用，见[原 Note](2026-10-03-bounded-session-log-observation.md)。

公共 HTTP 响应保持 additive，宣告 `session_directory_activity` 的服务必须提供真实摘要。新的完整 SDK reader 固定 upper 与 snapshotCursor，冲突丢弃全部前缀，最多三次扫描后明确失败。旧身份集合 API 的兼容合同保留。目录成功只表示这一观察完整，不 ACK、恢复或授予执行权。

正式 Native 复用原 Sidebar 的排序、时间格式与提示，不复制展示组件。Main 的全局目录读取与选中 view 分别持有生命周期，SSE ready/change 合并触发 GET；断线/reset/读取失败保上次事实并撤去当前活动标记，迟到读取按 attach／Store／epoch 拒绝。切换会话不停止原任务，detach 只停止所属读取。

## Alternatives considered

- 只映射当前选择的 view：不能表示其他会话的运行或待输入；以同快照公共目录提供全局事实。
- 用读取时钟或 Run 时间填更新时间：阅读会改变排序，或漏掉无 Run 的改名；复用实际最后 Core 事件时间。
- 增加 Session 时间列或借扩展记录保存第二份 clock：需要格式准入／备份兼容变化，并重复已经持久的信息；本次不修改 baseline、Store major 或维护资产。
- 固定分配 upper 后直接拼接活动页：并发变化会制造不存在的全局组合；同 cursor 验证，持续变化明确失败。
- 目录和当前正文共用刷新等待：慢目录会挡住原阅读；分别持有读取，失败保事实。

## Consequences

没有第二个执行索引或新增 I/O clock。旧历史缺少时间时不承诺可恢复；将来若实施事件物理清理，必须保留活 Session 最后更新时间依据或明确缺席，不能在清理后改用当前时钟。目录只提供元数据，完整输出／取消／审批仍沿原身份端口。

当前实际 SQLite／HTTP、Native／Browser SDK、原 Sidebar DOM 与源码外 macOS Native 窗口已经验证，准确输入、原失败及资格边界归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-全局会话状态与时间排序)。这项决定不证明完整 PC／installed／跨平台或 V1.3 退出。当前实现由[Store owner](../../../../packages/agent/src/storage/README.md#目录分页)、[Client owner](../../../../packages/client/README.md#完整目录读取)和[Native owner](../../../../apps/desktop/README.md#native-项目会话目录)维护。
