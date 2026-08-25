# ADR-0138：历史会话静默兼容与按会话懒迁移

状态：accepted

日期：2026-08-25

决策者：用户直接指令

相关：ADR-0105、ADR-0117、ADR-0128、ADR-0137、
`docs/active/runtime-resilience-qualification.md`、`docs/active/tui-session-startup-card.md`、
`docs/active/layer-boundary-enforcement.md`

## 背景

State/Store epoch 的 clean cutover 保证当前 writer、reducer 和执行权威只有一套，但旧实现把这种严格性扩展成了
“任一历史 Store 格式不匹配就让整个会话服务不可用”。一次 State 27/SAQ epoch 切换因此会使用户无法查看原有
State 26 会话，即使这些会话的 transcript、Task 与 Plan 历史仍可安全读取。

发布后的持久格式还会继续演进。若每次演进都全局拒绝旧 Store，正常升级就会变成用户数据不可达；若为避免拒绝而
长期保留双 writer、旧 reducer 或执行 fallback，又会复活旧授权、审批和 effect authority。兼容读取必须与当前执行
格式严格分离。

## 决策

### 1. 未知格式静默忽略，故障按会话隔离

历史源的 Store schema、State schema 或 format epoch 不在显式支持集合中时，发现阶段直接忽略该源：不报错、不提示、
不改写源文件，也不阻止当前 generation 的新会话创建和普通输入。未知源不得作为空的当前 Store、不得尝试其他 driver，
也不得通过启发式字段猜测版本。

已知源采用 metadata-only 会话发现；列表阶段不全量解码每个 journal。某个已知会话在选中后若 snapshot、event、checksum、
sequence、identity 或 named snapshot 校验失败，只让该会话打开失败；其他当前或历史会话继续可列出、打开和运行。TUI 只显示
脱敏的单会话失败提示，不出现全局“历史会话服务不可用”状态。

### 2. 只在选中会话时做无提示迁移

当前明确支持 State 26、Store 5、epoch `kite-runtime-modularization-v1-2026-08-19` 到 State 27/SAQ epoch 的单向迁移。
`/resume` 可以把该会话作为普通历史会话列出，不展示“旧版”“迁移”“兼容”等标签。只有用户选中该会话，或 CLI 明确
恢复该 session ID 时，App 才在 session-scoped restore 前执行迁移；启动和列表查询不批量导入。
CLI 的 explicit resume 必须在 `create_session` 之前完成 exact-session preparation；已知损坏、导入冲突或不存在的 session
只返回脱敏的该会话失败，不得以同一 ID 创建空 current session 覆盖历史身份。

每个未来版本若要读取新的历史格式，必须新增精确的 profile、纯迁移器和正反测试。不存在“接受任意较小版本”的范围
比较，也不存在把未知字段默认补齐后继续执行的通用迁移。

### 3. 当前 writer 单格式，历史源只读

每个当前 format epoch 使用 epoch 派生的独立 SQLite target 路径。升级到新 epoch 时，新 writer 不复用旧 generation 的
target；旧 generation 只作为显式已知的只读 source。源连接使用 no-follow/read-only 与有界 WAL snapshot，迁移前后验证
源路径/身份未被替换；不得 checkpoint、删除、重命名或修改 source database/WAL/SHM。
历史 source 存在 WAL 但缺少可重建 SHM 时，只在 no-follow 临时副本旁重建 SHM 后读取；源路径、database、WAL 和缺失的
SHM 保持原状。source database/WAL/SHM identity 在打开前后都必须稳定，否则本次发现忽略该 source。

当前 target 的格式判定必须复用 current Store 的只读 preflight。SQLite 在正常关闭、复制或重启窗口内可以留下 WAL 而没有
SHM；SHM 是可重建索引，这一形态不得被误判为未知 target。preflight 只在隔离视图中重建 WAL 索引，再由 current writer
打开同一 target；格式 marker、表/索引或 WAL 内容确实不合法时仍 fail closed，不能改走历史 source 或空 Store。

迁移在 target 上用一个 `BEGIN IMMEDIATE` 事务写入 session、events、current snapshot、named snapshots、file preimages
和 exactly-once ledger。失败完整回滚；重复导入返回已完成事实；已有 target session 永不被历史源覆盖。删除已迁移或仍在
源中的会话时，先在当前 Store 原子记录 source/session tombstone，再删除当前 session，防止下次启动重新出现。

### 4. 兼容投影不能恢复历史权限或执行

迁移只保留经过当前 validator 接受的会话身份、transcript、已终结 Task/Plan 历史和安全 metadata。活动旧 turn 终止为
`legacy_state_migrated`，活动 Task 取消；pending tools、model/capability invocation、provider admission、effect lease、
Subagent continuation、single-slot interaction、approval queue、grant、receipt、recovery attempt、session waiver 和 State 26
file preimage 全部清空。旧 file preimage 可驱动未来 `/rewind` 写文件，因此属于旧 effect authority，不作为被动历史导入。

旧 `authorization.mode=full_access`、旧 `interactionMode=full`、`approval.*`、`auto_review.*` 和旧 same-command facts 只转换为
当前 reducer 可接受的无副作用 `runtime.action_ignored`。State 26 中无法由当前 event union 解释的具类型 event 也转换为同样
的 inert fact，以保持 journal sequence 连续；非 JSON、缺 type 或结构损坏仍使该单个会话导入失败。迁移后的 live mode 最宽
只允许 `auto`，任何旧 Full/授权组合都降为 `accept_edits`。

当前 State 27 writer、event encoder、reducer、governance 和 dispatch 继续 strict current-only。兼容模块不能被 Tool、Policy、
Scheduler、TUI reducer 或 execution path 作为 fallback 调用。
current-format source 的 named snapshot 必须满足 `revision == eventPosition <= session head`；file preimage 必须位于 canonical
Workspace、无 traversal/NUL 且不越过 session head。任一 recovery point 或 preimage 失败都隔离所选 session，不得静默丢项。

### 5. 分层 owner

- Agent Kernel 只拥有纯 State/event 安全投影，不依赖 I/O、SQLite、Host 或 TUI。
- Runtime Host codec 绑定精确 schema/epoch，并把兼容结果变成 current in-memory State/event。
- SQLite package 只拥有通用 readonly source、原子 target import、ledger 与 tombstone，不解释授权语义。
- App composition root 枚举已知 source generation，合并普通会话列表，并在 exact session selection 后组合迁移。
- TUI/CLI 只消费普通 session API；不得自行解析旧格式、显示迁移状态或创建 UI-only 兼容事实。

## 与旧决策的关系

本 ADR 部分替代 ADR-0105、ADR-0117、ADR-0128 和 ADR-0137 中“旧 epoch 一律不读取/不迁移”的结论。它保留这些 ADR 的
current writer 单格式、无双权威、无旧执行 fallback、严格 checksum/identity/revision 和旧授权不可复活结论。ADR-0137 的
SAQ approval contract、State 27 queue 与 clean-cutover 写格式不变。

## 后果

- 正常升级不会让整个历史会话功能失效；未知格式静默消失，单个损坏会话只影响自身。
- 已知历史会话首次打开有一次本地导入成本，之后从 current Store exactly-once 恢复。
- 兼容范围必须逐 profile 增长并带安全降权测试；不能靠宽松 decoder 获得“看起来可用”的兼容性。
- 旧 source 长期保持只读，因此迁移失败可重试且不会破坏用户原始数据。

## 回滚

回滚兼容读取时可以删除新 profile 的发现与迁移入口，但不得删除或改写历史 source，也不得把 tombstone/ledger 解释为授权。
若回滚会再次使已知历史会话不可达，必须先以新 ADR 提供等价的数据可达方案。任何回滚都不得恢复双 writer、旧 reducer、
`full_access` grant、旧 single-slot approval 或 effect replay。
