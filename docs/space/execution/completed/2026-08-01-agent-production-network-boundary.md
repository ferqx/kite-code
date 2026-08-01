# Agent 生产化 Phase 1B Task 1B.4 完成记录

状态：completed
日期：2026-08-01
计划：
[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
执行者：`github:@ferqx`
实现提交：`bc03f77a3dac2962cd3158d3413f292b8388a0d8`
测试治理提交：`9bc626a1996261545c94e1e5950274029152bf1e`

## Gate 决策

结论：`approved_to_complete_1B.4_and_activate_1A.6`。

该结论只确认 Task 1B.4 的 invocation-local network policy、DNS/redirect/SSRF enforcement、
durable admission receipt、并发隔离和非 HTTP capability fail-closed 边界已经完成，并允许依赖
它的 Task 1A.6 进入内部实现。它不生成 production artifact，不改变 D-04 的
`accepted_empty_support_set`，也不允许 Shell、Skill child、local stdio MCP 或远程 MCP transport
进入 production support set。

## 实际 commit / artifact

- `bc03f77a3dac2962cd3158d3413f292b8388a0d8`：实现 network policy/enforcer、Runtime schema
  v20 durable receipt、`web_fetch` DNS/redirect/pinned socket enforcement、Tool Controller
  provider-zero-touch preflight，以及并发/边界测试；
- `9bc626a1996261545c94e1e5950274029152bf1e`：把有状态 TUI system 流程收敛为单一 journey
  test、独立用例改为 per-test fixture，并加固共享状态静态契约；该提交不扩大 network capability；
- 没有生成 production artifact；release-pinned qualification 仍为
  `accepted_empty_support_set`。

## 结论

- `networkBoundaryV1` 默认关闭；production rollback 固定为 network off，不恢复旧的任意出站。
- `web_fetch` 对每次 invocation 和每个 redirect hop 独立解析 exact-host allowlist，拒绝 IP literal、
  loopback/private/reserved/link-local/metadata 地址，并把实际解析 IP 固定到 socket，防止 redirect、
  DNS rebinding 或并发请求借用其他 invocation 的许可。
- Runtime schema v20 的 `network.admission_decided` receipt 在创建 socket 前持久化。allow receipt
  绑定 tool-call/invocation/hop、policy revision、canonical origin、host、resolved address/family、
  endpoint revision 和 receipt digest；deny receipt 绑定同一调用身份、policy revision、canonical
  origin、host、typed failure code、可选 expected endpoint revision 和 receipt digest。端口只作为
  canonical origin 的一部分表达，不存在独立 port 或通用 decision-reason 字段。
- Tool Controller 在查询 MCP Provider、binding、readiness、resource 或 `tool_search` 前执行
  provider-zero-touch preflight；被拒绝路径不会触碰 Provider。
- Shell 与 Skill descendants 强制 network off。MCP inventory/resource/dynamic tool 与
  `tool_search` 在 Task 1B.8 transport boundary 完成前保持关闭；Task 1A.6 只负责独立的 remote
  content egress permit，不能绕过该 transport 关闭状态。

## 验证命令与结果

- `bun test tests/config/features.test.ts tests/runtime/schema-v17-migration.test.ts
  tests/runtime/tool-controller.test.ts tests/sandbox/network-boundary.test.ts
  tests/sandbox/network-boundary-concurrency.test.ts`：61 pass、0 fail、219 expect calls；
- `bun test tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts`：
  19 pass、0 fail、84 expect calls；
- 独立复核最终集合：59 pass、0 fail，Provider zero-touch、mixed Runtime batch、durable receipt、
  Shell network off 与并发终态全部通过；
- `bun run test`：2175 pass、6 skip、0 fail；五个 process-isolated 文件全部通过；
- `bun run test:tui:system`：5 个 harness、36 个 scenario 文件全部通过，资源趋势 RSS +1 MiB、
  active +0、FD +0；
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、
  `bun run check:docs`、Biome 与 `git diff --check`：全部通过；
- 实现提交与测试治理提交的 pre-commit golden：各 10 pass、0 fail。

独立只读复核先发现 Tool Controller 在拒绝前触碰 Provider、并发测试未经过真实 Runtime sibling
batch 两项问题；修复并补充真实 `createRuntimeEffectExecutor()` 并发路径后最终 GO，无剩余
P0/P1/P2。后续 TUI 测试治理复核也最终 GO，无剩余 P0/P1/P2。

## 未运行项

- 未运行 native child allowlist bypass 正向 smoke。ADR-0061/D-04 的首发支持集为空，当前选择的
  production network mode 是 off，没有可合法声明 allowlist support 的平台组合；不能用开发机
  可联网行为制造正向 support evidence。
- 未运行 live MCP/provider/release smoke，也未验证 HTTP MCP transport enforcement；这些分别属于
  Task 1A.6、1B.8、1B.9 与后续 Release Gate，不能作为 1B.4 绿色 evidence。

## 风险与限制

- allowlist 是 exact host 边界，不包含 URL path 级授权；调用方不能把同 host 的不同路径误当作
  不同安全域。
- 当前 allowlist enforcement 只适用于受控的进程内 `web_fetch`；Shell/Skill child 只能 network
  off，MCP/search Provider 路径保持关闭，不能宣称通用跨进程 allowlist。
- 没有平台因此获得 production support；qualification、artifact 与 D-04 仍为空支持集。

## 与计划偏差

- 原矩阵要求 child bypass native smoke；空支持集与 network-off 结论意味着没有可测试的正向
  allowlist backend。实现采用 fail-closed：进程型 descendants 禁网，不以 proxy 环境变量或
  未验证 native backend 代替技术边界。
- MCP transport integration 延后到 Task 1B.8；Task 1B.4 只在 Controller/Runner 关闭所有可能
  绕过受控 fetch 的 MCP/search 路径，没有伪称已经完成 MCP transport enforcement。

## Active 文档与 ADR 收敛

- 当前行为已同步到 `docs/active/execution-boundary.md`、
  `docs/active/execution-platform-support.md`、`docs/active/mcp-runtime-governance.md`、
  `docs/active/feature-flags.md`、`docs/active/tool-gated-autonomy.md` 和相关 book；
- TUI evidence 规则已同步到 `docs/active/tui-e2e-standards.md` 与
  `docs/active/tui-e2e-testing-limits.md`；
- 没有新增架构决策；实现遵循 accepted ADR-0054 与 ADR-0061，未改写 accepted ADR 历史结论。
