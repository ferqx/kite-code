# ADR-0107：Runtime payload 与恢复完整性

状态：accepted

日期：2026-08-15

决策者：github:@ferqx

相关：ADR-0091、ADR-0096、ADR-0105、ADR-0106、`docs/space/plans/2026-08-15-runtime-architecture-convergence.md`

## 背景

ADR-0105 已决定预发布 Runtime 只接受当前格式，但只校验数据库 marker、snapshot schema 和事件
envelope 仍不足以兑现该边界：当前 marker 下的未知或退役 event payload 仍可能进入 reducer；SQLite
`immutable=1` 预检会忽略 WAL；named snapshot 在验证 state 前可能先截断事件；嵌套 Subagent
continuation 也可能晚到 Controller 才暴露损坏。Plan Artifact 先于 Runtime event 发布时，还需要同一
首次保存能够在崩溃后安全重试。

## 决策

1. 当前 epoch 的持久 `RuntimeEvent` 必须经过运行时 decoder 校验 discriminant 和当前事件所需身份，
   再进入 reducer。未知、退役或身份不完整的事件是 store corruption；reducer 不再静默忽略未知事件。
   `tool.execution_ready` 从当前事件集合中删除，不能通过历史事件把 queued 调用提升为 approved。
2. RuntimeStore 预检必须读取包含 WAL 的一致视图，并对源数据库保持只读。只有 marker 与完整当前表
   shape 均匹配后才打开源文件写连接；DDL 与 marker 初始化作为单个事务完成，失败不得留下“当前
   marker + 旧表”的半初始化数据库。
3. rolling/named snapshot 都绑定 event position、state revision、schema version 与 state checksum。
   rewind/fork 在任何 delete、truncate 或 upsert 前验证 checksum、thread ownership、revision/position
   边界和完整 Runtime invariant；验证失败为零写入。
4. `suspendedSubagents` 的 continuation 是 RuntimeState 的嵌套持久格式，不是 Controller 的宽松输入。
   当前格式必须包含 recovery journal、blocked reason 与身份元数据，并在 restore invariant 阶段整体
   校验；不再延迟归一旧 continuation。
5. 首次 Plan identity 由 task identity 确定生成，使“Artifact 已发布、Runtime event 未提交”的重试
   命中同一不可变内容。Artifact no-clobber 发布后必须同步目录项，再允许 Runtime 提交 `plan.drafted`。
6. Tool terminal authority 取决于真实生命周期：pre-dispatch rejection 不产生 `tool.started`；若已持久化
   `tool.started` 后才收到业务拒绝，outcome 必须保留 `dispatchState=started`，不能回写为
   `not_started`。

## 后果

- RuntimeStore schema 提升为 4；项目未正式发布，因此 schema 3 不迁移、不兼容且源文件不改写。
- TUI 会话恢复与 stats 读取必须先经过相同的只读 store 预检和严格 restore，不能自行 replay 宽松事件。
- event、snapshot、Subagent continuation 与 Plan crash-window 测试成为当前格式门禁的一部分。
- 这些校验收紧现有权威，不新增第二套恢复路径、迁移器或隔离 UI。

## 回滚

不通过恢复 legacy decoder、宽松 continuation 或可写预检回滚。若需要支持已公开格式，必须新增 ADR
定义支持窗口和独立迁移边界。
