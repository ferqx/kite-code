# 设计提案与历史 RFC

本目录存放设计提案及其历史 RFC。它们不代表当前行为；实施前必须在 `docs/space/plans/` 形成可验证的计划。每份 RFC 都应明确标注自身状态（如 `draft`、`implemented` 或 `superseded`）及其当前实施或替代入口。RFC 应说明背景、备选方案、边界影响、迁移/回滚方案与验收条件。

## 当前提案

- [`Kite Runtime Modularization V1 RFC`](2026-08-19-kite-runtime-modularization-v1-rfc.md) — `accepted`；ADR-0123 建立最终目标权威，ADR-0124 将实施拆为保持 State 25/Store 4 的 [`Runtime Modularization V1`](../space/plans/2026-08-19-kite-runtime-modularization-v1-implementation.md) 与后续 [`Runtime Authority & Format V1`](../space/plans/2026-08-20-kite-runtime-authority-format-v1-implementation.md)，ADR-0125 已把分期、包名、Host 上限、信任模型和格式切换事实同步回 RFC 正文。
