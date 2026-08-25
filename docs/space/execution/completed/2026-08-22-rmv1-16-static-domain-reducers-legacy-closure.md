# RMV1-16 静态领域 Reducer、Legacy 删除与闭合完成记录

状态：completed

日期：2026-08-22

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-15-model-context.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

Implementation final SHA：`e5a64c212a3e6a5207b00ed6e7f220c899cd7663`

Accepted RFC revision SHA-256：`a8fd3f35b5ca2331ff800c5a71f8a7907da5f6c5d11778b00e90c647c4d8be62`

## 交付结论

RMV1-16 已完成 Runtime 的最终物理闭合：

- `@kite-ai/agent-kernel` 以 11 个编译期固定 domain 组合纯确定性 State 25 reducer，不持有 I/O、Store、Model、Prompt、ToolSet 或 Provider authority；
- `@kite-ai/runtime-host` 只持有通用 Session/mailbox、transaction、effect lifecycle、prepared authority、process supervision 与 recovery 机制；
- `@kite-ai/runtime-spi` 是私有、无行为的编译边界，`@kite-ai/builtin-runtime` 唯一拥有具体 Context/Prompt/Skill/Model/Capability 语义；
- 六个 Builtin module 的冻结 registry snapshot 精确拥有 29 个 operation，其中 20 个 model-visible、9 个 internal；App bootstrap 是唯一 concrete composition root；
- Tool Pipeline、Model、Compaction、Reviewer、Verification、Subagent、Skill、MCP、Filesystem、Shell/Sandbox 的 production caller 均已切到 package owner；dynamic MCP 与 `ask_user` 保持各自独立边界；
- Legacy Runtime access/module/session handlers、central executor/controller/registry、root compatibility shim、App 到旧 Core 的 production import 和 architecture exception 已删除；没有 fallback、双写、双 handler 或第二 registry。

## 格式与行为保持

- Runtime State schema 保持 `25`，Runtime Store schema 保持 `4`，epoch 保持 `kite-runtime-2026-08-18`；
- 旧 Session restore、Event replay、effect lease、ack-before-dispatch、receipt-before-terminal、unknown recovery、private Artifact 与 secret-free logging 行为保持；
- 未引入 ProjectIdentity、统一 authenticity、cross-Host fence、DataOrigin/Egress/Credential 重写、State 26、Store 5 或新 epoch；这些范围只由后续 RAV1 承接；
- 2026-08-22 用户直接裁决本版本 evaluation 已无继续保留价值，因此 `scripts/evals/**`、`tests/evals/**`、相关 package scripts、CI jobs、active 文档及旧 ModelReplay evaluator/source seam 已全部删除。产品自身 restore/replay 并未删除，仍由常规产品测试、TUI journey、fault 与 soak Gate 验证。

## Owner、Delete 与生成事实

最终 manifest verifier 通过并证明：

- 29 个 operation、19 个 responsibility、107 条 Legacy delete rule；所有 Legacy rule 均为 deleted，manual manifest 无 `legacy-owned`；
- source migration 的旧 source 数为 0，test consumer 为 393，package public export 为 2060；
- architecture exception 为 0，package graph 为 7 个 package、12 条允许依赖边，唯一 composition root 为 `apps/kite/src/bootstrap.ts`；
- generated State/Event/Store/package graph/public exports 可重复生成并与工作树一致。

## Required Gate 证据

| Gate | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | passed；lockfile 无漂移 |
| `bun run typecheck`、`bun run build` | passed；7 个 workspace |
| `bun run format:check`、`bun run lint` | passed；18 条既有 warning、0 error |
| `bun run check:core-boundary` | passed |
| `bun run check:runtime-packages` | passed；7 package、12 edge、唯一 App composition root |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `bun run test` | passed；root 3520 pass、7 skip、0 fail、15683 expects，全部 workspace test 通过 |
| `bun run test:tui:system` | passed；38 个隔离 PTY scenario |
| `bun run test:runtime:fault` | passed；32 pass、1 platform skip、0 fail |
| `bun run test:runtime:soak` | passed；7/7 case、0 fail、无残留路径或 orphan worktree |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；29 operation、19 responsibility、107 Legacy rule、0 source、393 test consumer、2060 public export、0 architecture exception |
| `git diff --check` 与正常 pre-commit hooks | passed；未使用 `--no-verify` |

本地平台不支持的正式 56-probe GitHub qualification 没有运行，也未登记为通过；RMV1 权威计划明确它不阻塞本架构计划完成。

## 阶段裁决

RMV1-01 至 RMV1-16 的完成定义和全部 Required Gate 已闭合，RMV1 状态现为 `completed`。本记录绑定上列 implementation final SHA；RAV1 前置依赖因此解除，并从 RAV1-00 开始实施 Authority/Identity/Fencing/State26/Store5/new epoch。未来 evaluation 必须按新设计单独重建，不恢复本次删除的 evaluator 或兼容 seam。
