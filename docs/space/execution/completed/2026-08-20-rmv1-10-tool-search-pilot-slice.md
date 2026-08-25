# RMV1-10 `tool_search` Pilot Slice 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-09-capability-binding-execution-traits-scheduler.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-10 已把 `builtin:tool_search` 作为首个完整 vertical slice 原子切到目标 Runtime 边界：

- `@kite-ai/runtime-spi` 定义 `CapabilityExecutionInvocationV1` 与 `CapabilityExecutionPortV1`，继续只作为私有编译
  边界，不解释 Policy、Provider 语义或授权；
- `@kite-ai/runtime-host#createRuntimeHostCapabilityExecutionPortV1` 对启动时冻结的 Registry 做 exact arbitration，
  校验 binding、request、grant、attempt 与 receipt identity，并按 `invocationId + attemptId` 单次 claim；
- `@kite-ai/builtin-runtime#createToolSearchRuntimeModuleV1` 注册唯一 Capability definition 与 executor，只消费已复制、
  冻结的 catalog/provider JSON facts；descriptor 还会确定性排序，executor 不持有 Workspace、MCP Manager、Skill
  catalog 或 Model handle；
- Core `tool_search` ToolSpec 只保留 schema、availability、effects 与 Policy surface，类型上禁止
  `execute/projectResult`；Controller 只在调用点取得一次 MCP、Skill 与 Provider Directory snapshot；
- Tool Pipeline 先写 Store 4 invocation intent 与 attempt acknowledgement，再签发精确 invocation/grant/environment/
  attempt facts 给 Host。经 Host 验证的 Receipt 仍通过既有 Capability Artifact、terminal commit、Mailbox、Kernel 与
  Client projection；`capability.search_completed` 和 stdout 与原行为等价；
- `LegacyRuntimeModule` 已删除 `builtin:tool_search`，Core concrete executor 与 live catalog execution context 同时
  删除。生产中只有一个 registry-selected executor，不存在 try-new-catch-old、第二 handler、双写或 fallback。

## Acceptance 证据

- zero-call fault：binding、request、grant 或 attempt identity 错误均在 executor 前失败；
- single-use CAS：同一 invocation/attempt 第一次 claim 后永久拒绝第二次进入，executor call count 始终为 1；
- identity equality：Host 同时核对 Capability revision、request/grant identity、attempt membership、Provider、
  executor revision 与 request digest；伪造 Receipt fail closed；
- late receipt：dispatch 后 signal 取消不会触发第二次派发，精确 late Receipt 仍可被 Host 接收并交给既有 terminal
  语义处理；
- single executor 与 Legacy branch deletion：Builtin module 恰好注册一个 `tool_search` executor，Core 与 Legacy
  禁词/清单测试证明旧 owner 不可达；
- Client projection parity：真实 Tool Pipeline 测试验证同一 stdout、`capability.search_completed`、Capability
  Artifact、terminal receipt、Mailbox 与 Kernel 链路。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-10` 并由生成事实闭包验证：

- `builtin-tool-search` current/target owner 均为 `target-builtin-operation`，production entry 锚定
  `packages/builtin-runtime/src/tool-search.ts#createToolSearchRuntimeModuleV1`；
- `capability-execution-port` current/target owner 均为 `target-host-mechanism`，production entry 锚定
  `packages/runtime-host/src/capability-execution.ts#createRuntimeHostCapabilityExecutionPortV1`；
- Core concrete executor、Core live catalog import/context 与 Legacy `builtin:tool_search` operation 四条规则均为
  deleted，并由源码禁词和 owner equality 测试守护；
- SPI invocation/port、Host execution port 与 Builtin tool-search exports 均进入 source migration manifest。

当前 29 个 operation 由一个 Builtin operation 与 28 个 Legacy operation 组成；每个 operation 仍只有一个
production owner。

## Replay qualification 与格式冻结

`tool_search` 的 Host/SPI/Builtin/Pipeline closure 已进入 Required replay qualification。当前 closure 为 266 个文件，
摘要为 `sha256:b27c65499748eb754f990fff88902ddc93a7f5a4e472c0228cdbfb3ca815cb30`；parser 外 manifest
authority 为 `sha256:379c7ad3e438cb2c5b18397e1e719a884a8e9d9d6e8a0ed45c34736e199743a3`。Required replay
在 macOS seatbelt 网络隔离下通过，证据仍为 metadata-only。

Generated facts 与回归共同证明：

- Runtime State schema 25、30 个 root field；
- Runtime Event codec 136 个 discriminant；
- Runtime Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- operation 29、responsibility 19、Legacy rule 47、source file 294、test consumer 417、public export 179、
  architecture exception 2；
- 没有 ProjectIdentity、Composition identity、统一 cryptographic authenticity、cross-Host fence、
  DataOrigin/Egress/Credential 重写、State 26、Store 5、新 epoch 或 RAV1 production artifact。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/execution/tool-pipeline-stages.test.ts` | 18 pass、0 fail；包含完整 ack/Host/Builtin/Receipt/Client 链路 |
| `bun test tests/evals/tool-journey-v1.test.ts` | 5 pass、0 fail |
| `bun run test:tui:system:core` | 14 个隔离 PTY 场景文件、32 pass、0 fail |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| `bun test packages/runtime-host/test/capability-execution.test.ts packages/builtin-runtime/test/builtin-runtime.test.ts tests/tools/tool-registry-conformance.test.ts tests/runtime/capability-search.test.ts tests/scripts/runtime-modularization-manifests.test.ts tests/scripts/check-runtime-packages.test.ts` | 116 pass、0 fail；覆盖 zero-call、single-use、forged/late receipt、唯一 executor 与 package negative Gate |
| `bun run eval:replay:required` | passed；approved suite 在 macOS seatbelt 网络隔离下执行 |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、19 responsibility、47 Legacy、294 source、417 consumer、179 export、2 exception；State 25/Store 4/原 epoch |
| `bun run check:runtime-packages`、`bun run check:core-boundary` | passed；7 workspace、12 edge、1 composition root，Core boundary passed |
| `bun run typecheck`、`bun run build` | passed；root + 7 workspace typecheck、7 workspace build |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `bun run format:check` | passed；仅保留 `tests/session-manager.test.ts` 阶段前既有 16 条 `any` warning |

## 阶段边界

RMV1-10 completion evidence 已闭合并形成 stop-and-report checkpoint。下一阶段为 RMV1-11 Skills、Context ports
与 MCP read；RMV1 总计划仍为 active，RAV1 继续 blocked。RMV1-11 尚未开始，State 25、Store 4 与当前 epoch
必须继续保持，只有 RMV1-16 completion evidence 闭合后才可解除 RAV1 阻塞。
