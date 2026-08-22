# RMV1-14 Verification/Subagent 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-13-shell-sandbox.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-14 已把 Verification、Subagent 与配套 Plan/Task operation 物理迁入目标边界：

- `@kite/runtime-spi` 唯一拥有 JSON-safe Subagent Provider、continuation 与 Verification contract；根
  `src/protocol/subagent-provider.ts`、`subagent.ts`、`verification.ts` 只保留 RMV1-16 前 compatibility re-export；
- `@kite/builtin-runtime` 唯一拥有 `builtin:ask_user/read_plan/update_plan/write_plan/task`、
  `subagent:start/resume`、`verification:deterministic` 八个 operation，以及 deterministic Verification executor、
  Subagent grant/provider/continuation/ceiling/replay/Child Driver 和结果投影；
- Core Plan/Task ToolSpec 已收窄为 capability-backed schema/Policy declaration，不再拥有 executor/projector；
  `ask_user` 仍由 Kernel interrupt node 唯一处理，Builtin operation 只冻结 identity/schema，不建立第二 handler；
- Core Verification 只保留 State 25/Event 生命周期 adapter，Completion/required/repair/compensation 决策仍由 Kernel
  唯一拥有；具体 file/schema/command/MCP/reviewer check 与 evidence aggregation 在 Builtin 执行；
- Core Subagent Model runner 在 RMV1-15 前保留为 invocation-scoped adapter；Builtin Child Driver 唯一拥有注册、
  single-use start/resume、expiry、capacity 与 abandon，Builtin composition 唯一选择 grant/provider；
- 八个 operation 已从 `LegacyRuntimeModule` 原子删除。当前五个 Builtin module 合计拥有 24 个 operation，Legacy
  module 只剩五类 Model purpose operation，共 5 个。

每个 operation 只有一个 production owner；不存在 try-new-catch-old、异常 fallback、双 handler、双写、隐式
adapter 或 post-dispatch replay。PS-03 qualification 同样通过真实 Builtin registry 与 Host arbitration port，不再绕过
`builtin:task` owner。

## 行为与安全等价

- Verification mode、required completion、repair budget、user waiver、compensation、reviewer与 deterministic check
  顺序未改变；Provider data admission fatal error 仍保留 `knownExternalEffects=unknown` 并 fail closed；
- command、filesystem、schema、MCP read-after-write、external reference 与 reviewer evidence schema、预算上限和
  workspace confinement 未改变；
- Subagent start→blocked→approval→resume、actor-local replay cursor、role ceiling、private Artifact exact owner/readback、
  cleanup、crash recovery 与 recovery journal merge 未改变；
- Child/reviewer Model call 继续经过当前唯一 Model Gateway，没有第二 Gateway 或 live fallback；
- Plan active identity/version/structural digest、Task private request Artifact 与公开结果投影未改变；
- 未引入 Project/Composition identity、统一 authenticity、cross-Host fence、DataOrigin/Egress/Credential IR、State 26、
  Store 5 或新 epoch。

## Owner、Delete、Source 与 Replay 清单

- owner manifest 的 interaction/planning、Subagent 与 Verification responsibility 均锚定 Builtin RMV1-14 module；
- Legacy delete manifest 保持 100 条并新增精确规则，证明 Controller/Runner 的 task-name branch 与旧 Local Subagent
  composition owner 已删除；
- Runtime SPI/Builtin Subagent/Verification 的 public exports 已登记；生成事实为 291 个 source、424 个 test consumer、
  789 个 package public export 与 2 个 architecture exception；
- Required replay closure 为 310 个文件，digest
  `sha256:cc63c734413540365754ec5b37881ec3eab4163dbf33ad544a47e553aa514e15`，manifest authority 为
  `sha256:f3c42f077ac7580f04e148d54088051dc13637ed8f27e93ecf19e6d89fc3961b`；pilot/risk digest、suite revision、
  case、fixture、cassette、catalog 与 oracle 均未改变。

Generated facts 继续证明 Runtime State schema 25、Runtime Store schema 4、epoch
`kite-runtime-2026-08-18`；29 operation、19 responsibility、100 Legacy rule、291 source、424 test consumer、789
public export 与 2 architecture exception 均闭合。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| RMV1-14 四组 Required Verification/Subagent 命令 | 104 pass、0 fail |
| Verification execution/resource/completion/required 扩展 parity | 21 pass、0 fail |
| Runtime SPI、Builtin Runtime 与 RMV1-14 schema parity | 17 pass、0 fail |
| PS-03 qualification 与 Core boundary 定向回归 | 60 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS Seatbelt 网络隔离下执行 |
| `bun run scripts/run-runtime-workspace-script.ts test` | passed；7 workspace、75 pass、0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、19 responsibility、100 Legacy、State 25/Store 4/原 epoch |
| `bun test tests/scripts/runtime-modularization-manifests.test.ts` | 4 pass、0 fail |
| `bun run check:runtime-packages`、`bun run check:core-boundary` | passed；7 package、12 edge、唯一 composition root，Core boundary closed |
| `bun run typecheck`、`bun run build` | passed；7 workspace |
| `bun run format:check` | passed；仅保留 16 条既有测试 `any` warning，0 error |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-14 completion evidence 已闭合。下一阶段为 RMV1-15 Model/Context/Compaction/Reviewer；RMV1 总计划仍为
active，RAV1 继续 blocked。RMV1-15 仍必须保持 State 25、Store 4 与原 epoch，并在 package/import closure 变化时
重算 replay manifest authority，禁止通过修改 cassette 掩盖回归。
