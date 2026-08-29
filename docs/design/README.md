# 设计提案与历史 RFC

本目录存放设计提案及其历史 RFC。它们不代表当前行为；实施前必须在 `docs/space/plans/` 形成可验证的计划。每份 RFC 都应明确标注自身状态（如 `draft`、`implemented` 或 `superseded`）及其当前实施或替代入口。RFC 应说明背景、备选方案、边界影响、迁移/回滚方案与验收条件。

## 当前提案

- [`Kite Agent Server API V1 RFC`](2026-08-29-kite-agent-server-api-v1-rfc.md) — `accepted`；ADR-0149 接受在现有私有 Runtime
  Protocol/Server 之上增加本机稳定 REST/SSE façade，以 Session、Run、Interaction、Checkpoint 为资源，复用现有
  admission、receipt、revision 与 History authority，并为只读 Web 页面增加无执行能力的 `/api-docs` 文档路由；当前不代表
  已实现行为；[`Public contract freeze`](../space/understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)已关闭status/auth/
  pagination/SSE/compatibility选择，ADR-0150与[`Run Store子计划`](../space/plans/2026-08-29-kite-runtime-run-store-v1.md)固定Store 8
  migration。具体[`实施方案`](../space/plans/2026-08-29-kite-agent-server-api-v1.md)已完成KASAPI-01A～02A contract、同源
  OpenAPI/Schema artifacts及现有Workspace Worker listener上的authenticated Agent API context/route shell；当前进入KASAPI-02B
  read-only Session/History/Checkpoint adapter，未创建第二listener或任何Run mutation。
- [`Kite Runtime Modularization V1 RFC`](2026-08-19-kite-runtime-modularization-v1-rfc.md) — `accepted`；ADR-0123 建立最终目标权威，ADR-0124 将实施拆为保持 State 25/Store 4 的 [`Runtime Modularization V1`](../space/plans/2026-08-19-kite-runtime-modularization-v1-implementation.md) 与后续 [`Runtime Authority & Format V1`](../space/plans/2026-08-20-kite-runtime-authority-format-v1-implementation.md)，ADR-0125 已把分期、包名、Host 上限、信任模型和格式切换事实同步回 RFC 正文。
