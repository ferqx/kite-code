# 查询、History、Checkpoint 与 Artifact

入口：[log query](../src/log-query.ts)、[directory](../src/kite-home-directory.ts)、[checkpoint query](../src/workspace-checkpoint-query.ts)、[artifacts](../src/kite-home-artifacts.ts)。

查询返回只读 DTO，消费者通过既有 Host/API 入口访问，不直接暴露数据库或 canonical 文件路径。History、短期 subscription replay、诊断 logs 和 checkpoint metadata 是不同读模型，不能相互替代。

分页以规定的顺序键和 cursor 继续，after-sequence 用于增量读取，不是无限量抓取全部内部事件。多次 query 不应创建 Session、writer 或新的授权。

阶段 D0 的独立子 Agent Session 是内部线程。Store11 候选以持久父 Session 血缘识别它；Space/Workspace 目录、搜索、最近会话、History 索引及旧 `sessions.listSessions` 的根线程过滤已位于 SQL `WHERE`，先于排序、keyset cursor 和 LIMIT，防止子线程占满有界第一页或使根会话丢失。Store 公共日志读取拒绝已知子线程 ID；`listChildSessions`、`readChildSession` 和 `openChildSessionHistoryLogs` 则要求准确父 Session ID，History 每次读取重新核验血缘。候选迁移、重启和分页回归须随独立子 Session 路径一同验收。

内部恢复可在同一 Store read snapshot 中按 childThreadId 查询不可变父 Tool 意图，或按 parentSessionId／childThreadId cursor 有界列出尚未失败、尚未结算的意图。返回创建、预算激活、父 dispatch ACK 和结算 marker，不返回 Task Artifact 正文或 sealed grant JSON。后者仅由准确父 Session execution／recovery handle scope 的私有 getter 读取并复核字节 digest；普通 Session 列表和客户端已知 ID 日志不使用此读口。

Artifact 保存与执行有关的有界大内容、结果或恢复资料；引用、digest、可读权限与安装范围共同校验。读取引用失败不能从另一个 invocation 或 profile 补数据。文件 preimage 与模型输入证据各有 privacy owner，不混用同一公开下载接口。

checkpoint metadata 可展示，不代表任意客户端获准恢复。真正恢复仍经过对应命令、数据校验及 execution authority。

修改查询需同时核对结果字段、排序、访问限制和实际消费者；不因新增 UI 字段返回 raw Store event。规范见[日志查询](../../../docs/active/sqlite-runtime-log-query.md)、[私有 Artifact](../../../docs/active/private-artifact-storage.md)。

验证：[log query](../test/log-query.test.ts)、[checkpoint query](../test/workspace-checkpoint-query.test.ts)、[artifacts](../test/kite-home-artifacts.test.ts)。

当前 Store 9 的目录分页与索引会话读取共用已打开的 SQLite connection，不访问项目文件系统；目录分页同时返回已保存的 Session 模型路由，供客户端切换会话时立即显示模型名称；完整跨包契约见[SQLite Runtime Log](../../../docs/active/sqlite-runtime-log-query.md)。
