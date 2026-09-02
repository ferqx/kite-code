# Runtime Protocol

`@kite-ai/runtime-protocol` owns Kite Runtime's browser-safe, transport-neutral JSON-RPC 2.0 Protocol V1 subset. It is a private, exact pre-release repository contract, not a public SDK or a compatibility promise.

## Responsibilities

- Defines the exact request/response/notification/result/error DTO codecs, `protocolVersion: 1` and `protocolSchema: 'kite.runtime-protocol.v1'`.
- Freezes explicit command, query, client-event and session-index vocabularies, and maps only admitted Contract projections to wire values.
- Admits the private closed `get_run`/bounded `list_runs` queries, Run projection results, and optional original Run resource on applied/replayed
  command receipts. This remains repo-private Protocol and does not expose an HTTP `/rpc` or Public Agent API route.
- Admits three bounded durable History reads: `history/list_sessions`, `history/list_events`, and
  `history/load_session`. They reuse the initialized JSON-RPC connection and closed client-safe DTOs; the App
  carrier owns their handlers and SQLite read snapshot, while Runtime Server core owns neither History nor Store.
- Supplies browser-safe schema-generation artifacts. Carriers frame complete logical messages; this package does not prescribe JSONL, WebSocket, streams, or sockets.

## Non-responsibilities

- Does not execute Runtime commands, own sessions, open listeners, frame streams, reconnect, retain client state, or authorize Workspace access.
- Does not import Bun, Node, App composition, Host, storage or TUI code.

## Dependencies

Only `@kite-ai/runtime-contract` for explicit boundary mappers and `zod` for browser-safe codecs.

## Public entry

Only `@kite-ai/runtime-protocol` is public. The root entry exports codecs, limits, mappers and schema generation APIs.

## Invariants

- `jsonrpc` is exactly `"2.0"`; request IDs are bounded strings; batch, client notification, binary frame, numeric/null IDs, unknown fields and dynamic methods fail closed.
- Inputs are bounded by UTF-8 bytes, object keys, array length, JSON depth and safe-number checks; prototype-shaped keys and accessors are rejected before schema parsing.
- The only request methods are initialize, Runtime command/query/subscribe/unsubscribe, the three exact History
  reads and ping. Server notifications are subscription and draining facts; the Server never makes Client requests.
- New Contract discriminants do not become wire capabilities until an explicit exhaustive mapper and codec change admits them. Raw Runtime events, credentials, headers, provider bodies, authority identities and Store locators do not cross this boundary. User-local presentation may carry bounded reasoning, ordinary tool paths/commands/arguments and terminal output through their exact closed DTOs; obvious credential-shaped values remain redacted.
- `model.text_delta` and `reasoning.activity` carry a required `requestId`; codecs and mappers preserve it exactly and reject missing or additional fields.
- `tool.queued.presentationGroupId`, when present, is a bounded opaque identifier copied from the App projection. It pairs the tool with `model.responded.messageId` for presentation only; it grants no Runtime authority and unknown/additional grouping fields fail closed.
- Every wire Session carries one complete `interactionQueue` replacement projection. Queue revision equals Session revision,
  every interaction carries that revision, identities are unique, and the optional active identity must name one queue member.
  `sessionRevision` is the current settlement CAS rather than a creation-time identity; stable kind-specific identity fields
  remain exact when a pending interaction is re-projected after an unrelated State revision advances. When active work repeats
  the focused interaction, its entire closed identity must equal the queue member; matching only ID/revision is rejected.
  Contract-to-wire mapping materializes independent closed values so JSON/WebSocket and in-process logical messages have
  identical ownership and cycle behavior.
- Approval interactions admit the same optional, control-filtered command projection in notifications, session projections, and `respond_interaction` commands. The wire value is bounded to 16,384 UTF-16 code units; cwd, sandbox evidence, grant subjects, credentials, and hidden execution arguments remain excluded.
- Approval response只接纳`approve_once|same_command|reject`；未知grant在路由前fail closed，不使用
  compatibility alias或字符串fallback。
- Session deletion is admitted only as the explicit `delete_session` V1 command with scoped command identity and revision fencing. It does not expose a Store/SQLite operation or an alternate App delete path.
- Workspace identity is App-injected at the command mapper and never accepted on the wire.
- Run pages are capped at 200 entries and use the exact `(createdRevision, runId)` cursor; unknown fields, invalid lifecycle values and
  resource/result shape drift fail closed in the same codec used by in-process and transport clients.

## Tests

`bun run --cwd packages/runtime-protocol test`

## Documentation impact

Owner-local behavior changes update this README. Cross-package Runtime protocol, security or recovery changes also update the applicable `docs/active/` authority.
