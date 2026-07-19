# MCP 与 Skills Runtime 治理 Phase 2–5 完成记录

状态：completed
实施日期：2026-07-14 至 2026-07-15
计划：`../../plans/2026-07-14-mcp-skills-runtime-governance-followup.md`
设计基线：`../../../design/2026-07-14-mcp-skills-runtime-governance-rfc.md`

## 完成内容

- Phase 2：建立受治理的 invocation intent、receipt、artifact、health、幂等与 crash reconciliation；unknown 外部写入禁止盲目重放。
- Phase 3：将 Skill 统一编译为 revisioned Workflow Contract，引入 activation/frame、capability ceiling、fork 隔离和受限 reference 读取。
- Phase 4：实现 `not_required`、`best_effort`、`required` 分级验证，以及 VerificationSpec、repair/replan、waiver、compensation 与 budget 门禁。
- Phase 5：实现按 provider/context budget 选择的 progressive disclosure、metadata-only `capability_search`、下一轮有限 binding 和 fail-closed fallback。
- 形成当前权威规则：`../../../active/mcp-runtime-governance.md`、`../../../active/verification-governance.md`、`../../../active/capability-progressive-disclosure.md`。

## 实现提交

- `7f0b8d2`：持久化受治理的 MCP invocation records。
- `c67c0f0`：完成 MCP recovery、reconciliation、idempotency 与 trust 治理。
- `3740558`：实现 Skill Workflow 编译、激活与执行约束。
- `8a76657`：实现分级 verification 与完成门禁。
- `8cabc35`：实现 capability progressive disclosure。

## 设计收敛

- `capabilitySearchV1` 关闭时回到 revisioned Runtime 全量治理 binding，不恢复旧 MCP adapter 或 Skill 正文注入。
- Runtime schema v10 使用一次性 `pendingSearch` 和 turn-scoped `disclosures` 保证搜索后的有限披露与 revision 校验。
- 模型可见 MCP schema 剥离不可信自然语言注释，Runtime 仍使用原始 revisioned schema 校验参数。

## 验证

目标 Runtime、MCP、Skill、verification 与 capability search 测试通过；仓库默认测试共 702 项通过。`bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs` 与 `git diff --check` 通过。Windows 上磁盘 Runtime suite 的 Bun SQLite 临时目录清理仍可能出现已知 `EBUSY`，不影响内存路径与本轮功能验收。

## 后续

RFC 的 Phase 0–5 已全部结束。后续行为变更应先更新对应 `docs/active/` 规则和 ADR，再建立新的计划；本计划不再追加阶段。
