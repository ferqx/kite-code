# 查询、History、Checkpoint 与 Artifact

入口：[log query](../src/log-query.ts)、[directory](../src/kite-home-directory.ts)、[checkpoint query](../src/workspace-checkpoint-query.ts)、[artifacts](../src/kite-home-artifacts.ts)。

查询返回只读 DTO，消费者通过既有 Host/API 入口访问，不直接暴露数据库或 canonical 文件路径。History、短期 subscription replay、诊断 logs 和 checkpoint metadata 是不同读模型，不能相互替代。

分页以规定的顺序键和 cursor 继续，after-sequence 用于增量读取，不是无限量抓取全部内部事件。多次 query 不应创建 Session、writer 或新的授权。

阶段 D0 的独立子 Agent Session 是内部线程。Store11 候选以持久父 Session 血缘识别它；Space/Workspace 目录、搜索、最近会话、History 索引及旧 `sessions.listSessions` 的根线程过滤已位于 SQL `WHERE`，先于排序、keyset cursor 和 LIMIT，防止子线程占满有界第一页或使根会话丢失。Store 公共日志读取拒绝已知子线程 ID；`listChildSessions`、`readChildSession` 和 `openChildSessionHistoryLogs` 则要求准确父 Session ID，History 每次读取重新核验血缘。子会话列表按不可变 `session_id` 倒序分页；现有 cursor 仍带 `updatedAt`，但只有 `sessionId` 决定下一页边界，避免分页期间子会话更新而漏项。客户端读完所有页后可按返回的 `updatedAt` 排列显示。候选迁移、重启和分页回归须随独立子 Session 路径一同验收。

Directory 的 `hasRootSession(sessionId)` 直接按 `runtime_sessions` 主键查询；存在父子血缘列时同时要求 `parent_session_id IS NULL`。Browser 的 direct Session read 以此逐次核对可见性，不依赖有界目录页覆盖全部根线程，也不重复运行目录聚合查询。

当前 Store16 同事务维护 `history_generation`、`history_rewrite_generation`、历史追加水位和 `history_instance_id`。Event 的 UPDATE／DELETE 与历史序号内 INSERT 推进改写代次；纯尾部 INSERT 只推进内容代次和追加水位。历史追加水位不随删除回退，因此删后重插不能伪装为尾部追加；Session 删除重建取得新的实例身份。索引 `getSession` 只向内部 History adapter 返回这些证明，不加入客户端目录 DTO。Service 在同一只读快照内核验准确 Session／父子范围；固定前缀与实例、改写代次均未变时，不再逐页扫描原始前缀。Store15→16 只转换私有候选，旧行及原来源保持，全部 trigger 定义参与严格 schema 校验；见 [Store16 回归](../test/kite-session-store15-to16.test.ts)。

旧读取端口仍可提供固定 sequence 前缀的原始行摘要，按顺序覆盖事件身份、schema、causation、时间和原始 JSON，不解码事件；没有改写代次／实例证明时，代次变化才按该摘要核对，缺少任何复用证明则重新投影。当前 Store16 worker 不为纯尾部追加重新扫描前缀。证明不授予执行权限，也不代替跨页投影摘要。实现与验证见 [log query](../src/log-query.ts) 和 [History worker 回归](../../../apps/kite-service/test/isolated/history-page-pool.test.ts)。

内部恢复可在同一 Store read snapshot 中按 childThreadId 查询不可变父 Tool 意图，或按 parentSessionId／childThreadId cursor 有界列出尚未失败、尚未结算的意图。返回创建、预算激活、父 dispatch ACK 和结算 marker，不返回 Task Artifact 正文或 sealed grant JSON。后者仅由准确父 Session execution／recovery handle scope 的私有 getter 读取并复核字节 digest；普通 Session 列表和客户端已知 ID 日志不使用此读口。

Artifact 保存与执行有关的私有大内容、结果或恢复资料；Store15 对子任务与模型私有 Artifact 不再施加旧单件固定字节上限，具体表转换及完整性校验见[事务 owner](transactions-and-state.md)。引用、digest、可读权限与安装范围共同校验。读取引用失败不能从另一个 invocation 或 profile 补数据。文件 preimage 与模型输入证据各有 privacy owner，不混用同一公开下载接口。

单会话树删除与空间批量删除共用数据删除路径；空间删除合并全部目标树，只收集一次候选 Artifact、扫描一次保留引用，在同一 Store 写事务内，先收集树内行中的 typed Artifact ref，删除会话及子线程，再检查候选 Artifact ID 是否仍出现在保留的 Store 行中。保留引用检查对各表文本只扫描一次，同时匹配本次全部候选 ID；候选正文之间的引用按原删除顺序处理，避免对每个附件反复扫描全库。自身记录不算外部引用，共享引用、原始文本中的子串引用及无法解析的 JSON 文本仍参与保留判断。只有可证明已无保留引用的候选私有正文才删除；共享正文及无法从树内 ref 证明归属的孤立 Artifact 保留。该窄范围删除不开放常规 Artifact GC，也不提供物理文件覆写保证。

checkpoint metadata 可展示，不代表任意客户端获准恢复。真正恢复仍经过对应命令、数据校验及 execution authority。

修改查询需同时核对结果字段、排序、访问限制和实际消费者；不因新增 UI 字段返回 raw Store event。规范见[日志查询](../../../docs/active/sqlite-runtime-log-query.md)、[私有 Artifact](../../../docs/active/private-artifact-storage.md)。

验证：[log query](../test/log-query.test.ts)、[checkpoint query](../test/workspace-checkpoint-query.test.ts)、[artifacts](../test/kite-home-artifacts.test.ts)。

当前 Store 9 的目录分页与索引会话读取共用已打开的 SQLite connection，不访问项目文件系统；目录分页同时返回已保存的 Session 模型路由，供客户端切换会话时立即显示模型名称；完整跨包契约见[SQLite Runtime Log](../../../docs/active/sqlite-runtime-log-query.md)。
