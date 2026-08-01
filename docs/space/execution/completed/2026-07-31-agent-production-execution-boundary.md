# Agent 生产化 Phase 1B Task 1B.1 完成记录

状态：completed
日期：2026-07-31
计划：
[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
执行者：`github:@ferqx`
实现提交：
`cd2bd8819c86f4585cdf45fd6c6d785152cdba98`；
测试治理提交：`e4ed8a05106e3a49f110dbcc0066efa874d4c382`；
复核修复提交：`3ada4246b149444ce27ed713cd5425090367c1fc`

## Gate 决策

结论：`approved_to_complete_1B.1_and_activate_1B.2_1B.3_1B.4`。

该结论只确认 Task 1B.1 的 schema、composition、capability projection 与 fail-closed dispatch
边界已经完成，并允许依赖它的 1B.2–1B.4 进入内部实现。它不生成 production artifact，不改变
D-04 的 `accepted_empty_support_set`，也不允许任何平台、Shell 或 writer 进入 production support
set。

## 实际 commit / artifact

- `cd2bd8819c86f4585cdf45fd6c6d785152cdba98`：冻结 `ExecutionBoundaryV1`、qualification
  registry、composition root、feature flag 与首批 schema/property tests；
- `e4ed8a05106e3a49f110dbcc0066efa874d4c382`：整体重构 TUI system 场景同步、屏幕断言、fixture
  identity 和 native sandbox smoke，消除 stale-output 与伪 session 命中；
- `3ada4246b149444ce27ed713cd5425090367c1fc`：关闭独立复核发现的 capability projection、
  canonical digest、production loader、session replay 与 Workspace 外路径绕过；
- release-pinned qualification artifact：
  `release/platform-capabilities/approved-execution-qualifications-v1.json`，状态保持
  `accepted_empty_support_set`；没有生成 production artifact。

## 结论

- `ExecutionBoundaryV1` 已冻结 filesystem、network、protected-path、process-tree、sandbox
  requirement 与 unavailable fallback；Workspace 使用 canonical identity，host allowlist 规范化、
  排序并去重。
- 多来源边界只能收紧：filesystem 取更小 scope、allowlist 取交集、protected path deny wins、
  process-tree limit 取更小值，sandbox 与 fallback 不能被后层放宽。
- production composition root 只接受 release-pinned qualification registry；registry revision、
  digest、环境 identity、backend strength 与双入口 evidence 均需精确匹配。当前批准 registry 是
  `accepted_empty_support_set`，因此没有任何 production-supported platform 或 artifact。
- capability surface 的 network/process/write/shell/Skill child/local stdio MCP 各轴独立执行。
  模型 disclosure 与 Runner dispatch 都按 Registry descriptor effects fail closed；原生只读
  surface 可保留受 sandbox 约束的 Shell，但不能披露或执行进程内 writer/network 工具。
- `verified_in_process_read_only` 只接受 sealed catalog 中 descriptor revision/effect contract
  完全匹配的 Workspace-bound 只读 builtin；动态 MCP、Shell、writer、外部路径、相对遍历与
  符号链接逃逸均在 dispatch 前拒绝。
- qualification/catalog digest 显式重建嵌套字段并使用 code-unit 排序，不依赖调用方对象字段
  插入顺序或 locale。

## 验证命令与结果

- `bun test tests/sandbox/execution-boundary.test.ts tests/config/features.test.ts`：26 pass、
  0 fail、733 assertions；
- `bun test tests/tool-definitions.test.ts tests/tool-runner.test.ts tests/model-capabilities.test.ts
  tests/tools/tool-registry-conformance.test.ts`：112 pass、0 fail；
- `bun run test:tui:system`：4 个 harness、36 个 scenario 全部通过，资源趋势 RSS 30→31 MiB、
  active 0→0、FD 5→5；
- `bun run test:tui:system:core`：62 pass、0 fail；
- `bun run test`：2128 pass、6 skip、0 fail；
- `bun run check:docs-impact`：passed；
- `bun run check:docs`：10 plans、108 tasks、14 decisions passed；
- `bun run check:core-boundary`：passed；
- `bun run typecheck`：passed；
- `bunx biome check`（本批 TypeScript/测试变更）：passed；
- `git diff --check`：passed；
- 三个实现提交的 pre-commit golden：10 pass、0 fail。

独立只读复核先发现 2 个 P1 与 3 个 P2；修复后再次对抗性验证，最终 GO，未发现剩余
P0/P1/P2。复核实测 writer/network 双层门禁、Shell 保留、production loader 强制拒绝、digest
canonicalization、Runtime Store session identity、fresh replay，以及绝对/相对/符号链接外部路径
均符合契约。

## 未运行项

- Task 1B.1 矩阵要求的 schema/property、sandbox 定向测试、默认回归和 TUI system 回归均已运行，
  没有未运行的 1B.1 必需验证。
- 未运行 1B.2–1B.4 的 macOS/Linux/Windows process-tree、filesystem、DNS/redirect/proxy 与 child
  bypass native smoke，也未运行 `bun run release:smoke`、live Provider/MCP 或 artifact build；这些
  属于后续 Task/Gate，不能作为 1B.1 绿色 evidence，也未被本记录如此表述。

## 风险与限制

- 本记录只完成 fail-closed schema、composition 与 capability projection，不产生
  production artifact，也不改变 D-04 的空支持集结论。
- `executionBoundaryV1=false` 或 qualification/backend 任一不匹配时，production process/write
  capability 全部关闭；审批、`full_access` 或裸 shell 不能恢复。
- 1B.2–1B.4 以 `3ada4246b149444ce27ed713cd5425090367c1fc` 为共同基线，分别实施
  macOS、跨平台 backend/process-tree 与 network enforcement；它们通过前不得加入非空支持项。

## 与计划偏差

- Task 1B.1 原矩阵以 schema/property tests 为主；实施期间确认原有 TUI system 场景会因全量
  历史输出与伪 session ID 产生假阳性，因此在同一批整体切换为 fresh-output checkpoint、真实
  Runtime Store identity 和明确的 screen contract。该调整只提高 evidence 可信度，不扩大生产
  capability。
- 独立复核发现 model disclosure 与 Runner dispatch 的 capability 轴未完全同源，因而新增
  `execution-capability-surface.ts` 作为独立投影门禁，并在 dispatch 前增加 canonical Workspace
  path ceiling；二者均属于 1B.1 的 fail-closed 边界加固。
- D-04 原本允许在 native evidence 后选择非空支持项；实际 evidence 不足，ADR-0061 已接受空
  支持集。本 Task 没有以开发期 sandbox 行为替代 release qualification。

## Active 文档与 ADR 收敛

- 当前行为已同步到 `docs/active/execution-boundary.md`、
  `docs/active/execution-platform-support.md`、`docs/active/feature-flags.md`、
  `docs/active/tool-gated-autonomy.md`、`docs/active/file-reading-shared-boundary.md` 和
  `docs/active/mcp-runtime-governance.md`。
- TUI evidence 规则已同步到 `docs/active/tui-e2e-standards.md`、
  `docs/active/tui-e2e-testing-limits.md` 与根 `README.md`；`docs/documentation-map.json` 已覆盖
  execution qualification 与 TUI system harness/scenario。
- 没有新增架构决策；实现遵循 accepted ADR-0054（生产执行隔离）和 ADR-0061（生产平台能力
  admission 空支持集），未改写 accepted ADR 历史结论。
