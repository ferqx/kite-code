# Session 管理 Store owner

[session-management-operations.ts](../session-management-operations.ts) 提供 `renameSession` 与 `deleteSession`，是当前 Store 原 root Session 主体的具名控制命令。请求必须带准确 Store、commandId、sessionId、subjectId 和 Decimal64 `ifRevision`；改名另带非空、最多 4096 UTF8 bytes 的 title。同一 controlRevision 的并发修改只有一个成功，INT64_MAX 拒绝并整体回滚。同 ID 的同意图返回原回执和原 Session 快照，不选择后来状态或重新执行；改变字段冲突。child Session 的公共管理拒绝 group_root_required，其 Task 停止仍使用准确原 Run/Execution 端口。

删除短事务给整个 root 执行组保存 tombstone 与实际毫秒 deletedAt，并提高 root controlRevision；根工作来源 stop_boundary 与删除意图是迟到创建/派发的最终门禁。现有 accepted 命令撤销，active Run 和 Execution 写取消请求，未接纳 Interaction 取消，pending delivery 标为 suppressed/session_deleted。终态、正文、来源和 Artifact 授权引用保留，不物理删除、不把 unknown 改成已停止或成功。正常 Session 目录隐藏 tombstone，准确旧 ID 的历史查询保留。回执 outcome=delete_requested、stopConfirmed=false，只证明删除意图已提交。

Runtime 在提交后复用已 owned Command/Execution flags 的观察路径通知 signal/资源监督；它不抢其他 Service owner、不初始化 Provider、也不从回执猜清理完成。冻结/远端 owner 或未知外部效果保留原事实，持久意图仍防止后代复活。当前版本未包含 export、GC、backup、Workspace 批量删除或扩展 copy/rebuild。

[session-management.test.ts](../../../../test/isolated/storage/session-management.test.ts) 以真实双 SQLite Worker 验证 CAS、同 ID、主体/Store、INT64 overflow、trigger rollback、readonly tombstone 与零 Model。实际固定 Model/Tool/detached Job 验证删除后的 abort、unknown 清理、planned 后迟到派发零调用、迟到创建拒绝、准确 child 公共管理拒绝与另一 Session 独立完成。删除受理不等待停止确认；测试单独观察最终 Run/Job 事实。
