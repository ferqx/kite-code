# 可信 Runtime 收敛完成记录

状态：completed

日期：2026-08-18

关联计划：[`2026-08-16-trustworthy-runtime-convergence.md`](../../plans/2026-08-16-trustworthy-runtime-convergence.md)

决策：ADR-0109、ADR-0110、ADR-0111、ADR-0112、ADR-0113、ADR-0114、ADR-0115、ADR-0116、ADR-0117

## 结论

Model Surface/Gateway、Tool Pipeline、strict evaluation replay，以及 Workspace Filesystem、Sandbox、
Subagent 三条受治理 Local Provider seam 已完成协议、实现、恢复证据和静态 no-bypass 收敛。CUT-01
随后把 Production Runtime 切换到 schema v25、format epoch `kite-runtime-2026-08-18`，完成本计划的
唯一 production format cutover。

SQLite RuntimeStore 的表结构没有变化，因此 store schema marker 继续为 v4。这个数字与 RuntimeState
schema 分属不同边界，不存在隐式 migration。

## CUT-01 行为

- v24、`kite-runtime-2026-08-15`、缺失 epoch 或错误 epoch 的数据库、snapshot、named snapshot 与 fork
  source 在 event decode、reducer、Scheduler、Model、Tool 或 Provider dispatch 前 fail closed。
- 不迁移、不重写、不删除旧数据库、WAL/SHM 或 Artifact；旧格式没有在线 restore、replay 或 fallback。
- v25 snapshot 必须显式包含 Model invocation index、Provider readiness ledger、CompletionGuard state 与
  完整 transcript identity，缺失事实按 corruption 处理。
- durable Subagent suspension 只保存 private continuation Artifact ref；raw Task 在 queue commit 前转为
  private request Artifact，不能作为 v25 queued argument 或 inline continuation 恢复。
- Capability result Artifact 只接受 keyed opaque private ref 与 format v2 envelope；路径型 ref 和 format v1
  reader 已删除。
- 模型调用只经 ModelInvocationGateway，工具只经 Tool Pipeline，Filesystem、Sandbox、Subagent 只经各自
  受治理 Local Provider composition；静态门禁拒绝重新引入已退役 authority shape。

## 证据边界

- old-epoch、缺失/错误 epoch 与缺失必需状态的 no-write/fail-closed 测试。
- current event codec、Runtime invariant、named restore/fork、journey、fault 与 recovery 测试。
- Model Gateway、Tool Pipeline、三条 Provider seam、static no-bypass 与 closed strict replay 门禁。
- typecheck、format、默认全量测试、docs-impact、docs 与 diff 检查。

PS-02 的 GitHub-hosted 原生证据仍绑定
[run 32096568806](https://github.com/ferqx/kite-code/actions/runs/32096568806)；其三平台 outcome 仍为
`excluded`、`productionSupported=false`，production support set 仍为空。CUT-01 不把 native candidate、
evaluation replay 或 closed synthetic qualification提升为平台/模型生产支持。

## 后续边界

本计划已归档。后续如需支持旧公开格式，必须新增 ADR 和独立离线迁移工具；不得恢复 v24 reader、旧
dispatch composition 或 runtime fallback flag。
