# RMV1-11 Skills、Context Ports 与 MCP Read 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-10-tool-search-pilot-slice.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-11 已把 Skills、Context ports、MCP connect/discovery/read 与 Web fetch 物理迁入目标边界：

- `@kite/builtin-runtime` 的 RMV1-11 module 唯一拥有 8 个 operation：Web fetch、MCP inventory/resource/dynamic
  Tool 与三个 Skill lifecycle operation；`tool_search` module 继续独立拥有第 9 个已迁移 operation；
- Skill workflow/catalog/activation/lifecycle 实现位于 Builtin `skills/`，Core 只保留 RMV1-16 前的兼容导出；
  调用点把 Agent State 投影为冻结的 active task/workspace/Skill frames 最小 view；
- Builtin `ContextSource` 只同步投影 committed facts，Builtin `ContextCompilerPort` 唯一决定选择、排序、authority、
  disclosure、预算与 required-overflow；Host 只收集、验证和委托；
- MCP Manager/Supervisor、auth、credential、transport、egress、write governance 与目录/结果语义位于 Builtin
  `mcp/` 子路径；Web SSRF、robots、extractor 与 worker 位于 Builtin `web/` 子路径；
- Core MCP compatibility composition 只注入配置 repository 和通用 network mechanism；Core Web composition 只注入
  受治理 fetch。旧 MCP/Web/Skill concrete implementation 与 8 个 Legacy operation 已删除；
- SPI execution context 中的 `providerFacts/providerServices` 旁路已删除。冻结 catalog facts 属于
  `ExecutionRequest.facts`；受限进程内 mechanism 属于 selected `ExecutionEnvironmentRef`。Host 运行时证明 Provider
  context 精确只有 grant、request digest、signal、environment 与 attempt identity。

每个 operation 仍只有一个 production owner，不存在 try-new-catch-old、双 handler、异常 fallback、双写或隐式
adapter。MCP 动态调用还会核对 inner capability/revision，Skill/MCP/Web executor 不直接调用另一个 Runtime
Provider。

## 行为与安全等价

- project MCP approval、source precedence、config digest/TOCTOU 与 store fail-closed 未改变；
- OAuth/PKCE/state、native keyring、credential reference 与 header materialization 未改变；
- transport admission、endpoint revision、redirect/DNS pinning、remote content egress、write admission 与 unknown
  recovery 未改变；
- Manager/Supervisor generation、last-known catalog、readiness、safe-read retry 与 cancellation 未改变；
- Skill strict workflow/revision/effect join、frame、reference、fork output、verification 与 scan budgets 未改变；
- Context compaction、prompt authority 与 replay输出未改变；
- 未引入通用 DataOrigin/Egress/Credential IR、Project/Composition identity、统一 authenticity、cross-Host fence、
  State 26、Store 5 或新 epoch。

## Owner、Delete、Source 与 Replay 清单

- owner manifest 的 `skills-context-mcp-read` 与两个 operation group 均锚定
  `packages/builtin-runtime/src/rmv1-11-operations.ts#createRmv111RuntimeModuleV1`；
- 当前 29 个 operation 由 9 个 Builtin operation 与 20 个 Legacy operation 组成；
- Legacy delete manifest 为 69 条，新增规则证明 Core MCP Manager/Supervisor/auth、MCP SDK import、Web extractor/
  SSRF/worker implementation 与 8 个 Legacy operation 均不可达；
- Builtin MCP/Web 子路径的 public exports 全量登记，生成事实为 377 个 package exports；
- Required replay import resolver 已覆盖 `#builtin-runtime/mcp` 与 `#builtin-runtime/web`，当前 closure 为 280 个文件，
  摘要为 `sha256:6f193ae2bb4e5137c3a152717c12e4f00901e89362f22a6af392a3a049b61ab1`；manifest
  authority 为 `sha256:6e6fbf370f085ad62a2458112da41e657d7bf7288869f48d99161899a0046944`。cassette 未修改。

Generated facts 继续证明 Runtime State schema 25、Runtime Store schema 4、epoch
`kite-runtime-2026-08-18`；29 operation、19 responsibility、69 Legacy rule、294 source、418 test consumer、
377 public export 与 2 architecture exception 均闭合。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| RMV1-11 三组 Required MCP 命令 | 62 pass、0 fail；覆盖 Manager/transport、project approval/auth、egress/write admission |
| Required Context 命令 | 43 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS seatbelt 网络隔离下执行 |
| approved replay 固定 6 文件 | 101 pass、0 fail |
| `bun test tests/skills/*.test.ts` 的四个 workflow/activation/effect 文件 | 30 pass、0 fail |
| 非 UI MCP 治理矩阵 | 171 pass、0 fail、1 个 native keyring smoke 按环境跳过 |
| Host/Builtin/Pipeline/Schema/Network 边界回归 | 87 pass、0 fail；含 exact Provider context、最小 Skill state、forged inner identity |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、19 responsibility、69 Legacy、State 25/Store 4/原 epoch |
| `bun run check:runtime-packages` | passed；7 workspace、12 edge、唯一 composition root |
| `bun install --frozen-lockfile`、`bun run typecheck`、`bun run build` | passed |
| `bun run format:check` | passed；仅保留 16 条既有测试 `any` warning，0 error |
| `bun run check:docs-impact`、`bun run check:docs` | passed |

## 阶段边界

RMV1-11 completion evidence 已闭合，形成可审计 checkpoint。下一阶段为 RMV1-12 Filesystem read/write；RMV1 总
计划仍为 active，RAV1 继续 blocked。RMV1-12 不得改变 State 25、Store 4、epoch 或引入 RAV1 authority/format
产物。
