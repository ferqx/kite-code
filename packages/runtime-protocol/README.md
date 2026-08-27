# Runtime Protocol

`@kite-ai/runtime-protocol` owns Kite Runtime's browser-safe, transport-neutral JSON-RPC 2.0 Protocol V1 subset. It is a private, exact pre-release repository contract, not a public SDK or a compatibility promise.

## Responsibilities

- Defines the exact request/response/notification/result/error DTO codecs, `protocolVersion: 1` and `protocolSchema: 'kite.runtime-protocol.v1'`.
- Freezes explicit command, query, client-event and session-index vocabularies, and maps only admitted Contract projections to wire values.
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
- The only request methods are initialize, Runtime command/query/subscribe/unsubscribe and ping. Server notifications are subscription and draining facts; the Server never makes Client requests.
- New Contract discriminants do not become wire capabilities until an explicit exhaustive mapper and codec change admits them. Raw Runtime events, credentials, headers, provider bodies, authority identities and Store locators do not cross this boundary. User-local presentation may carry bounded reasoning, ordinary tool paths/commands/arguments and terminal output through their exact closed DTOs; obvious credential-shaped values remain redacted.
- `model.text_delta` and `reasoning.activity` carry a required `requestId`; codecs and mappers preserve it exactly and reject missing or additional fields.
- Approval interactions admit the same optional, control-filtered command projection in notifications, session projections, and `respond_interaction` commands. The wire value is bounded to 16,384 UTF-16 code units; cwd, sandbox evidence, grant subjects, credentials, and hidden execution arguments remain excluded.
- Session deletion is admitted only as the explicit `delete_session` V1 command with scoped command identity and revision fencing. It does not expose a Store/SQLite operation or an alternate App delete path.
- Workspace identity is App-injected at the command mapper and never accepted on the wire.

## Tests

`bun run --cwd packages/runtime-protocol test`

## Documentation impact

Owner-local behavior changes update this README. Cross-package Runtime protocol, security or recovery changes also update the applicable `docs/active/` authority.
