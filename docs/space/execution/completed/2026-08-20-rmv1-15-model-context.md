# RMV1-15 Model/Context/Compaction/Reviewer 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-14-verification-subagent.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

> RMV1-16 后续审计勘误（2026-08-20）：本记录证明 RMV1-15 的物理实现、Builtin operation registration、唯一 App
> Gateway/Source composition 与阶段 Gate；它不证明五类 production effect caller 已从 Core/App 清零。当前
> `model-controller.ts`、`runtime/executor.ts`、`subagent/runner.ts` 与 TUI standalone manual compaction seam 仍承担
> orchestration/translation，必须在 RMV1-16 删除后才能把 effect caller、policy projection、persistence 与 receipt
> owner 视为最终闭合。下文“Core 只保留 State25 类型兼容 adapter”应按这一范围限制阅读。

## 交付结论

RMV1-15 已把 Model、Context、Compaction 与 Reviewer 物理迁入目标边界：

- `@kite-ai/runtime-spi` 唯一拥有 Model Surface contract；根 `src/protocol/model-surface.ts` 只保留 RMV1-16 前
  compatibility re-export；
- `@kite-ai/builtin-runtime` 唯一拥有 Gateway、transport、response source、Surface compiler/canonicalizer、消息与
  token、Artifact、Context compiler/projection/serialization、Prompt assembly、Compaction 与 reviewer 具体语义；
- `model:primary`、`model:compaction`、`model:auto_review`、`model:verification_review` 与 `model:subagent`
  五个 operation 均由 RMV1-15 Builtin module 唯一注册并执行；六个 Builtin module 合计拥有全部 29 个 operation，
  `LegacyRuntimeModule` operation 列表为 0；
- App `model-runtime-composition.ts` 唯一组合安装级 integrity key、private Artifact stores、live response source、
  Gateway、Workspace Filesystem 与 Subagent mechanisms，并由 production bootstrap 显式注入 TUI/CLI Session；
- Core Runtime entry 要求调用方注入 `modelInvocationRuntime`，不再构造具体 Gateway/Artifact owner，也没有
  try-new-catch-old、异常 fallback、双 handler、双写或隐式 production adapter；
- Host 继续只拥有 ContextCompilerPort 与通用 effect lifecycle，不解释 Context、Prompt、Model purpose 或 reviewer
  语义；Kernel 的确定性 State 25/Event/Completion/Verification Policy authority 未改变。

## 行为与安全等价

- 五类 purpose 继续通过同一个 Gateway；Model Surface、provider-data admission、route/owner binding、Artifact key、
  prepared/attempt acknowledgement、retry/abort/finalization、streaming 与 private evidence 行为未改变；
- strict replay 仍无 credential、live transport 或 network fallback，且继续执行完整消费、route/owner/digest 检查；
- Context projection、Prompt Contract、manual/auto compaction、summary replacement、cooldown/breaker、revision lease 与
  reviewer evidence 行为未改变；
- package/import closure 变化只更新 qualification file/closure 与 parser 外 manifest authority；pilot/risk digest、
  suite revision、case、fixture、cassette、catalog 与 oracle 均未修改；
- 未引入 Project/Composition identity、统一 authenticity、cross-Host fence、DataOrigin/Egress/Credential IR、State 26、
  Store 5 或新 epoch。

## Owner、Delete、Source 与 Replay 清单

- owner manifest 将 `model-context-compaction-reviewer` responsibility 和五类 Model operation 锚定 RMV1-15 Builtin
  module；Legacy delete manifest 证明旧 concrete composition owner、Core Prompt assets 与 Legacy operation 已删除；
- Runtime SPI/Builtin Model public exports 与 App composition 已登记；生成事实为 290 个 source、425 个 test consumer、
  847 个 package public export 与 2 个 architecture exception；
- Required replay closure 为 343 个文件，digest
  `sha256:8ad3a0202b1b94529cc323977fe8de41ab57f7d0036c2a1adc125a7261761018`，manifest authority 为
  `sha256:a858700bfece4c2c787f01b34b91be8476a9a94c16666310d44c8b7c80fe93d2`；fixed pilot/risk/cassette/
  fixture/catalog/oracle 均未改变。

Generated facts 继续证明 Runtime State schema 25、Runtime Store schema 4、epoch
`kite-runtime-2026-08-18`；29 operation、19 responsibility、100 Legacy rule、290 source、425 test consumer、847
public export 与 2 architecture exception 均闭合。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| RMV1-15 五组 Required Model/Artifact/Compaction 命令 | 69 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS Seatbelt 网络隔离下执行，`contentLogged=false` |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| `bun run scripts/run-runtime-workspace-script.ts test` | passed；7 workspace、75 pass、0 fail |
| manifest verifier、manifest/parity tests | passed；29 operation、19 responsibility、100 Legacy rule；7 pass、0 fail |
| `bun run check:runtime-packages`、`bun run check:core-boundary` | passed；7 package、12 edge、唯一 composition root，Core boundary closed |
| `bun run typecheck`、`bun run build` | passed；7 workspace |
| `bun run format:check` | passed；仅保留 20 条既有/兼容边界 warning，0 error |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-15 completion evidence 已闭合。下一阶段为 RMV1-16 静态领域 Reducer、Legacy 删除与 final closure；RMV1 总计划
仍为 active，RAV1 继续 blocked。RMV1-16 仍必须保持 State 25、Store 4 与 epoch `kite-runtime-2026-08-18`，并在
完成 full suite/journey/replay/fault/CI soak/docs 与最终 owner/delete/source closure 前禁止激活 RAV1。
