# ADR-0117：Production Runtime Format Cutover

状态：accepted

日期：2026-08-18

决策者：github:@ferqx

相关：ADR-0105、ADR-0107、ADR-0109、ADR-0110、ADR-0111、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

Model Gateway、Tool Pipeline、Workspace Filesystem Provider、Sandbox Execution Provider 与
Subagent Provider 已完成生产迁移和 no-bypass 验收。此前为了让这些 migration series 在同一未发布
Runtime epoch 内逐步落地，v24 仍保留少量只读兼容分支：缺失 `modelInvocations` 的 snapshot 归一、可选
readiness/completion state、raw Task/inline Subagent continuation restore，以及路径型 Capability Artifact
reference reader。

这些分支在迁移完成后不再有生产用途；继续保留会让新格式仍可恢复缺少 Model、Tool 或 Provider evidence
的状态，与 CUT-01 的唯一权威目标冲突。

## 决策

1. Production Runtime 切换为 schema v25、format epoch `kite-runtime-2026-08-18`。SQLite RuntimeStore
   表结构没有变化，store schema marker 保持 v4；format epoch marker 必须精确匹配。
2. v24、`kite-runtime-2026-08-15` 及其他缺失/错误 epoch 的数据库、snapshot、named snapshot 与 fork
   source 在任何 event decode、reducer、Scheduler、Model、Tool 或 Provider dispatch 前进入
   `incompatible_runtime_format`。源数据库和 Artifact 不迁移、不重放、不改写、不删除。
3. v25 snapshot 必须显式包含 Model invocation index、Provider readiness ledger、CompletionGuard state 与
   完整 transcript identity。缺失事实是 corruption，不得补默认值或从 transcript/config 反推。
4. durable Subagent suspension 只允许 low-information private Artifact ref；raw Task 只存在于模型输入并在
   queue commit 前转换为 private request Artifact。v25 不读取 raw queued Task 或 inline continuation。
5. Capability result Artifact 只接受 keyed opaque private ref 与 format v2 envelope。路径型 legacy ref 与
   format v1 reader 被删除。
6. 生产模型调用只经 ModelInvocationGateway，工具只经 Tool Pipeline，Filesystem/Sandbox/Subagent 只经
   对应受治理 Local Provider composition。静态 boundary gate 禁止重新引入上述兼容 shape 或旧 dispatch。
7. 切换后没有 runtime fallback flag 或在线 rollback。问题只能通过修复 v25 实现或在合并前回退整个
   cutover 改动；不得重新接入 v24 decoder、migration 或旧 adapter。

## 后果

- 既有本地 v24 会话无法继续恢复，但文件保持原样；用户可以创建新会话。
- 当前 RuntimeState、event tail、fork、private Artifact 和 Provider recovery evidence 使用唯一生产格式。
- `RUNTIME_STORE_SCHEMA_VERSION` 不因纯 epoch 切换提升，避免把未变化的 SQLite 表结构伪装成 migration。

## 回滚

合并前可整体回退 CUT-01。合并后不通过兼容 reader 或 fallback 回滚；若正式发布后需要支持公开旧格式，
必须新增 ADR 定义支持窗口与独立离线迁移工具。
