# ADR-0130：源码级架构门禁取代生成快照

**Status**: accepted
**Date**: 2026-08-24
**Decision makers**: 用户直接指令

## Context

Runtime modularization 曾把 State/Event/Store、package graph 和 public export 的完整事实序列化为五份提交的 JSON 快照，并用生成器比对其可复现性。它们只复制当前源码事实，不是运行时输入；每次正常实现或 export 变化都会产生大范围 hash 与排序噪音。

同一体系还保留了 operation owner、legacy-delete、source-migration 和 architecture exception 迁移清单。当前 clean cutover 已完成：生产组合、依赖图、public export、旧路径和唯一 composition root 都可由现有源码级门禁与行为测试直接验证。

## Decision

1. 删除所有 generated runtime modularization JSON 快照、生成器、漂移检查和仅验证这些快照的测试。
2. 删除已完成迁移的 owner、legacy-delete、source-migration 与 architecture-exception 清单；不保留 allowlist 机制。
3. `check:runtime-packages`、`check:core-boundary`、`check:pre-release-architecture` 与定向行为测试是唯一架构验证来源，并直接读取当前源码和 package manifest。
4. 非 `apps/kite/src/bootstrap.ts` 的 composition authority import 一律失败。若未来确有例外，必须通过新的 ADR 和明确的源码级规则建立，而不是登记临时 JSON allowlist。

## Consequences

- 正常的源码和 export 修改不再引入提交快照 churn，也不需要运行生成命令。
- 架构门禁减少第二事实源；失败信息直接指向当前实现。
- 历史计划与完成记录保留为历史证据，但不再作为当前验证输入。

## Verification

- `bun test tests/scripts/check-runtime-packages.test.ts`
- `bun run check:runtime-packages`
- `bun run check:core-boundary`
- `bun run check:pre-release-architecture`
- `bun run check:docs-impact && bun run check:docs`
