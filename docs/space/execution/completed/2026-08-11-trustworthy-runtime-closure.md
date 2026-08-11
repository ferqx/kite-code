# 可信运行时收口完成记录

状态：completed
日期：2026-08-11
关联计划：[`2026-08-11-trustworthy-runtime-closure.md`](../../plans/2026-08-11-trustworthy-runtime-closure.md)
起始提交：`5f0fdf4c`

## 结论

可信运行时的最后两项收口已完成。current Tool terminal 事件只由 Kernel 写入并
发布 canonical `ToolOutcomeV1`；历史 pre-v23 记录只在 restore/Session replay 边界由唯一
decoder 保守转换。统一审查没有未解决的 P0/P1，也没有发现有明确证据应在本计划内继续删除的架构或工程冗余。

## ToolOutcome 最终边界

- 删除公共 `legacyToolOutcomeV1`、reducer/TUI/Session Logger/metrics 的 optional fallback、
  历史 terminal fallback 辅助函数和 Kernel envelope 绕过入口。
- Kernel batch 依次使用前一个 canonical state 归一化每个当前事件；current reducer 会机械拒绝缺失或非法 outcome。
- Runner 与 Agent cancel 路径只向 consumer 发布 Kernel 实际应用的 canonical payload，不再发布未归一化的 producer fact。
- `decodeHistoricalToolOutcomeEventV1` 是唯一 legacy 读路径：缺失 outcome 映射为
  `legacy_unclassified/unknown/never`，非法 persisted outcome 映射为
  `classifier_invalid/unknown/never`，二者都不解析错误文本也不自动重放。
- 工具 `result`、结构化 `failure` 和历史 `error` 仍用于 transcript、显示与历史数据读取，
  但不再是 current outcome 的状态、recovery 或 metric 权威来源。
- 收口中还修复了两个被旧 fallback 遮蔽的 canonical 矛盾：未启动调用的
  external effects 固定为 `none`；policy/mandatory-policy/approval deny 固定为 `recovery=never`。

## 统一审查

- `promptContractV2` 的默认常量和 config 回归断言仍为 `false`。
- `git_inspect` 只公开 status/diff/log/branch-list，仍经 Core broker 的 repository、binary、
  hostile config/attributes/replace/grafts、protected path 和 native deny 证据门禁。stage、commit、
  remote Git 与 raw-shell fallback 没有公开执行入口；三平台 production qualification 仍为 `excluded`。
- `task` 不在通用并行 read allowlist 中，Scheduler 每次只调度一个 Subagent；resource
  budget 中的 subagent permit 仅是共享 ledger 的防御性上限，不是专用并行 batch。
- Subagent lifecycle event 仍用于 UI/observability，parent `tool.finished` 仍是 Runtime 工具终态；
  recovery 是否成功只由合并后的 canonical Recovery Journal 保留，没有第二个 recovery terminal 状态源。
- Core 仍不依赖 App/TUI 类型，CompletionGuard、Plan evidence、Recovery Journal、取消/恢复和安全门禁均保留原职责。

## 验证

- ToolOutcome current/replay、failure recovery、terminal、Session Logger、metrics 与 TUI：93 pass、0 fail。
- 只读 Git broker、Controller、execution boundary、protected path 与 tool surface：102 pass、0 fail。
- 串行 Subagent 委派、审批、continuation、budget、cancel/resume 与 scheduler：130 pass、0 fail。
- `bun run test`：主套件 3384 pass、8 skip，5 个 process-isolated 文件 62 pass；合计
  3446 pass、8 skip、0 fail。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、
  `bun run check:docs`、`bun run format:check` 和 `git diff --check` 均以 0 退出。
- `format:check` 保留 18 个与本轮无关的既有 `noExplicitAny` warning；其余验证未输出 warning。

## 交付边界

统一审查已通过并获用户授权提交；未 push。
