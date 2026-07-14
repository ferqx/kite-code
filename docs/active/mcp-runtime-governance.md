# MCP Runtime Governance

状态：active
读取时机：修改 MCP discovery、动态工具绑定、MCP policy、MCP 调用或结果归一化时。
验证：`bun test tests/mcp.test.ts tests/mcp-manager.test.ts tests/tool-definitions.test.ts tests/runtime/tool-controller.test.ts tests/policies/approval-policy.test.ts`、`bun run typecheck`。

MCP tool execution is available only when both `capabilityCatalogV1` and `mcpRuntimeBindingV1` are enabled. The ModelController records bindings before the model call; a dynamic `mcp__<server>__<tool>` call must match its binding, turn, descriptor revision and input schema at execution time.

MCP list changes replace the immutable catalog snapshot. Existing bindings do not update in place and fail closed. P0 accepts object-root JSON Schema Draft-07 only. Invalid or unsupported schemas remain diagnosable but are not model-visible or executable.

Remote server annotations are untrusted by default. Local per-tool policy in `mcpServers.<server>.tools.<tool>` may set effects and `minimumApproval`; only an explicitly trusted server may contribute a read-only annotation. Unknown, write and destructive MCP effects require a single-use user approval even under `full_access`.

For auditable trust, prefer `trust: { provenance: 'admin' | 'user' | 'project', allowAnnotations: 'read_only' }`. This local decision only permits a server's `readOnlyHint` to classify a tool as read-only; it cannot lower an explicit per-tool `minimumApproval` or grant new effects. The legacy `trust: 'trusted'` form remains a user-configured compatibility spelling and records no elevated provenance.

MCP results retain protocol content blocks and structured content. `_meta` is not persisted. When `mcpExecutionRecordV1` is enabled, MCP calls with write, destructive or unknown effects persist intent and terminal digests; restart marks a non-terminal invocation `unknown` and never replays it automatically. Artifact handles, idempotency/reconciliation actions and verification remain deferred.
