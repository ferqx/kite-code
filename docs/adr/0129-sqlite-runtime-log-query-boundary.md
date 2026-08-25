# ADR-0129：SQLite Runtime Log 的只读查询边界

**Status**: accepted
**Date**: 2026-08-23
**Decision makers**: 用户直接指令

## Context

Runtime Store 的 current event journal 是可恢复会话的唯一 durable 事实源。历史 Session Logger、JSONL、Trace 和 metadata/content logging 是独立诊断设施；它们不具备 replay authority，也不能成为本地日志页面的数据补偿、校验或 fallback。

需要为后续本地日志 Server/Web 提供查询能力，但不能把浏览器或服务端接入可写 `SessionStore`，不能因查询需求修改 Store5/State26/format epoch，也不能以 raw event JSON 或 private Artifact 内容绕过既有边界。

## Decision

1. SQLite Runtime Store（`runtime_sessions`、`runtime_events` 与 current codec）是所有可回放日志的唯一事实源。Session Logger/JSONL 不参与该路径。
2. `@kite-ai/runtime-contract` 拥有 transport-neutral 的 cursor、完整性、展示和 typed-error DTO；`@kite-ai/runtime-host/storage` 单独拥有 generic `RuntimeLogQueryPort`。它不属于 `SessionStore`，不提供 transaction、effect、checkpoint、delete 或 Artifact reader。
3. `@kite-ai/runtime-storage-sqlite` 以 `SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW` 打开独立短生命周期 reader，先进行 current-format preflight，随后以 current codec 解码 event。旧 epoch、未知或损坏 event 均 fail closed；不会返回 `event_json`、建表、写库或引入 compatibility decoder。
4. `apps/kite` 是 `RuntimeEvent → Web-safe` 展示投影 owner。投影使用固定字段、长度和 secret/control-character 边界；Artifact 仅可显示 kind/availability，不可返回 locator 或正文。它不复用 Session Logger mapper。
5. 本阶段不创建 HTTP listener、SSE、Web UI 或 CLI command。后续 Server 只能由显式 `kite logs serve` admission 启动，且必须 bind loopback、使用每次启动的临时授权、严格 Host/Origin/CSP、无宽松 CORS，并保持 query-only composition。
6. V1 保持 Store schema、index、State schema 与 format epoch 不变。任何索引、迁移或跨 epoch 兼容需求必须先由新 ADR 决定。

## Consequences

- reader 与 writer 可在 WAL 和 DELETE journal 模式并发；reader 不持有跨请求事务，busy/locked 以 typed temporary-unavailable 形式收敛。
- 后续 HTTP/SSE/UI 只能消费 `RuntimeLogQueryPort` 和 App projection，不能扫描会话日志目录或直接读取 SQLite/Artifact 文件。
- Runtime 继续是唯一写 owner；关闭未来日志服务不会修改或中断 Runtime Session。

## Verification

- Contract cursor/limit/cursor-conflict validation，Host port shape，以及 SQLite read-only adapter 的 current-format/corrupt/busy/WAL/DELETE/live-writer pagination tests。
- App projector tests 覆盖 stored XSS、terminal escape、secret redaction、Unicode length cap、未知 detail fallback 和 Artifact locator/body exclusion。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、`bun run check:docs-impact`、`bun run check:docs`。
