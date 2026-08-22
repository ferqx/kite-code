# MCP Runtime Governance

状态：active
读取时机：修改 MCP discovery、动态工具绑定、MCP policy、MCP 调用或结果归一化时。
验证：`bun test tests/mcp.test.ts tests/mcp-manager.test.ts tests/mcp-tool-runner.test.ts tests/mcp-tool-policy.test.ts tests/mcp-supervisor.test.ts tests/mcp-config-catalog.test.ts tests/mcp-project-approval.test.ts tests/mcp/data-egress-policy.test.ts tests/mcp/data-egress-concurrency.test.ts tests/mcp-transport-boundary.test.ts tests/mcp-transport-boundary-concurrency.test.ts tests/tool-definitions.test.ts tests/runtime/tool-controller.test.ts tests/runtime/actions.test.ts tests/runtime/kernel.test.ts tests/runtime/scheduler.test.ts tests/runtime/verification.test.ts tests/golden/golden.test.ts tests/policies/approval-policy.test.ts tests/sandbox/network-boundary.test.ts tests/tui-system/scenarios/mcp-management-readonly.test.ts`、`bun run test:mcp:live`（`tests/e2e/live/mcp/` 下的显式公网 smoke）、`bun run typecheck`、`bun run check:core-boundary`。

MCP tool execution is available only when both `capabilityCatalogV1` and `mcpRuntimeBindingV1` are enabled. The ModelController records bindings before the model call; a dynamic model-visible name must match its binding, turn, descriptor revision and input schema. Runtime invokes `McpRuntimeProvider.callCapability({ capabilityId, expectedRevision, arguments, signal })`; the Supervisor façade rechecks effective Provider availability, and the connection manager atomically resolves the current descriptor, compares revision, validates the current schema and only then obtains the original Provider/Tool identity. Model-visible names are never parsed as execution identity.

RMV1-11 后，connect/discovery/read、Manager/Supervisor、auth/credential、transport/egress/write governance 与结果
归一化的物理 owner 是 `packages/builtin-runtime/src/mcp/`。动态 MCP、inventory 与 Resource 工具通过唯一
`kite-builtin-runtime-rmv1-11` executor 进入同一 acknowledged intent/attempt/Host receipt 链；App 只组合配置、
network mechanism、唯一 frozen catalog 与 supplied Host port，已删除的 Core MCP compatibility 文件不得恢复。Provider execution context 不取得完整
Host、AgentState、RuntimeStore 或另一个 Runtime Provider。

When a production execution capability surface is present, dynamic MCP disclosure and Runner dispatch also apply that surface before policy or approval. A descriptor whose declared/effective filesystem, network, or external-state effects exceed the independent `write`/`network` axes is omitted and rejected; when both remote network and local stdio MCP are closed, no MCP Tool binding is executable. Approval cannot widen this ceiling. The sealed no-process read-only fallback continues to omit every dynamic MCP binding.

Task 1B.8 adds a sealed transport identity to every MCP connection. Remote HTTP connect, discovery,
inventory, resource, Tool and OAuth operations require a fresh admission bound to canonical Workspace,
execution boundary/run/profile/network revisions, canonical endpoint/endpoint revision and invocation/
tool-call identity. The SDK receives a custom fetch that rechecks DNS, private destinations, exact host
allowlist and redirects per hop, pins the approved addresses and does not consume environment proxy
variables. A sibling operation cannot reuse another operation's receipt. Local stdio remains explicitly
excluded until a sandbox-backed transport factory and native child conformance exist. The production TUI
currently has no receipt-signing App controller, so sealed MCP Provider readiness remains fail closed;
the implementation is transport enforcement infrastructure, not a production availability claim.

Transport boundary conformance 使用真实存在且 canonicalize 后仍与目标 Workspace 不同的原生目录
验证 `workspace_mismatch`；fixture 不假定 `/tmp` 在 Windows runner 上存在。该可移植性约束只保证
先经过 Workspace identity gate，再验证零 catalog load/零 transport request，不放宽 sealed
admission 或任何 MCP production readiness 条件。

Remote HTTP Tool content has an additional boundary independent of transport admission, Tool effects
approval and model Provider consent. `McpRuntimeProvider.getCapabilityRoute()` exposes only the redacted
`transport + serverIdentity + endpointRevision + toolRevision` identity. Local stdio does not enter this
HTTP egress gate. For remote HTTP, any non-empty final argument object has unknown field provenance and is
conservatively bound as `confidential` plus all supported payload kinds (`user_prompt`、`file_snippet`、
`tool_result`); neither project MCP config nor a read-only annotation can lower that floor.
Before permit resolution, ToolController applies the shared bounded Runtime secret detector to the final
structured arguments; Manager repeats the inspection immediately before ledger consumption. Credential
fields, credential-shaped values and protected credential paths are `secret_detected` and cannot be made
sendable by a permit. Cyclic, unsupported, over-depth, over-node or over-character input is
`content_inspection_unknown` and also fails closed. Before either inspection or any asynchronous resolver/
receipt work, the boundary captures one deeply immutable JSON-safe snapshot. Schema validation,
classification, inspection, argument digest and SDK dispatch all consume that same snapshot; accessors,
custom `toJSON`, symbols, non-enumerable properties, cycles and non-JSON objects are rejected, so callback
mutation cannot create a digest-to-wire TOCTOU gap. Empty arguments are content-free; all other clear
remote arguments require one exact
`RemoteMcpEgressPermitV1` when `remoteMcpEgressPolicyV1=true`. With the flag false, remote content remains
no-egress rather than falling back to the old path.

The permit binds invocation, server, endpoint revision, Tool revision, canonical final-argument digest,
classification, payload kind, expiry and nonce. Permit TTL is positive and at most five minutes. The
Manager owns the process-local fast-path ledger and synchronously validates it immediately before the SDK
call; the Runtime Store then claims the redacted nonce digest under a database-wide unique constraint in
the same transaction as the receipt. A restart, sibling process or deleted/rewound session therefore
cannot replay a still-live permit. A durable uniqueness conflict is translated into, and durably records, a
`permit_replayed` denial before returning to the Tool lifecycle. Expiry, excessive TTL, malformed shape,
secret/unknown inspection, any binding mismatch, missing permit, replay or receipt-persistence failure sends
zero Tool requests. Parallel siblings require independent
invocation IDs and nonces; one sibling cannot consume, transfer or authorize another's permit. The
Manager persists a redacted `mcp.egress_decided` receipt before dispatch; admitted dispatch is impossible
without a recorder. The receipt contains digests, permit expiry and reason codes, never raw arguments,
content or nonce. Tool Search and metadata discovery do not request a content
permit. This content gate and the transport boundary are independent; both must admit the same invocation
before a remote Tool request is sent.

`McpConnectionManagerOptions` 可注入 sealed run 的 protected-path V1 evaluator。local stdio
connection 在 SDK transport construction 前，以 `execute` operation 校验 `cwd`（缺省为 evaluator
绑定的 canonical Workspace）和 path-like executable；protected、Workspace 外、无效或 prompt-only
路径都拒绝，且不会调用 transport factory。准入后 manager 把 canonical cwd 和 path-like
executable identity 而非未解析 alias 交给 factory。注入 evaluator 的 stdio config 对任意非空
`args` 都在 factory 前 fail closed；不能通过 interpreter argv 把 protected 或 Workspace 外脚本交给
child。sealed transport identity 无条件关闭 local stdio，不能由 surface bit、审批或配置重新开启。
bare PATH command pinning、真实 sandbox/network/process inheritance 与 native child conformance
完成前，现有开发 adapter 不代表 local stdio 已获得 production admission。

MCP list changes replace the immutable catalog snapshot. Existing bindings do not update in place and fail closed. P0 accepts object-root JSON Schema Draft-07 only; each schema is validated against an admission budget (256 KiB UTF-8 bytes, 32 levels depth, 4096 object nodes, 1024 properties) in a single traversal. Manager retains the complete raw Tool discovery, while the capability catalog contains only enabled and schema-valid Tools. Disabled, invalid, budget-exceeding or unsupported Tools remain diagnosable through the control snapshot but are not model-visible or executable; direct Manager calls also require a current available descriptor.

Transport health does not define Tool identity. After one successful discovery, Manager retains the last revisioned descriptor set while an effective Provider is connecting, degraded or failed. Remove, disable, visibility-policy change and successful `list_changed` refresh may replace or remove it. Runtime schema 13 persists session-loaded MCP capabilities; each model request revalidates their revisions and issues fresh turn bindings. Provider health is checked again immediately before execution.

Visibility is resolved as `enabledTools` allowlist → `disabledTools` denylist → exact `tools.<name>.enabled` override. Remote server annotations are recorded as declared effects but are untrusted by default. Local per-tool policy may set effects and `minimumApproval`; only an explicitly trusted server may make a read-only annotation effective. Unknown, write and destructive MCP effects require a single-use user approval even under `full_access`. `safe_read` retry is effective only when every effective effect is `none|read`; `idempotency_key` requires a configured key argument, otherwise retry fails closed to `never`.

远端自然语言描述有独立的 Prompt admission，不继承 effect annotation trust。Capability descriptor 保留审计用原始 `description`，另携带 `modelDescription` 和 provenance。用户/显式/本地私有配置以及已批准项目 Server 的描述可在过滤控制字符与非法 Unicode、压缩空白并截断到 512 code points 后进入模型视图，且必须标明为外部元数据而非指令；其他 `remote_untrusted` 来源只使用工具名与最多 12 个顶层参数名生成摘要。搜索索引与动态声明共享同一摘要，schema 注释仍全部剥离，摘要 digest 变化会推动 capability revision 和 binding 失效。

Project-controlled MCP declarations are gated before transport construction. An effective Server from current `.kite-code/mcp.json` or a read-only legacy project source must match a local approval bound to its workspace, source, name and raw-config digest; pending, rejected, changed, invalid or unreadable-store entries never enter the connection map. This execution approval is separate from annotation trust and Tool Approval. Project allowlists, denylists and exact disable overrides may reduce visibility; annotation trust, exact enable, effect/minimum-approval reductions and retry expansion are ignored after approval. Project Tools therefore remain remote, unknown-effect, user-approved and non-retryable unless the project only makes them stricter. The complete source and approval contracts are defined in [`mcp-config-management.md`](mcp-config-management.md) and [`mcp-project-approval.md`](mcp-project-approval.md).

`McpSupervisor` is the sole App-facing MCP control plane and the sole producer of the Runtime provider façade. It publishes the config catalog before background connection, serializes config reload/mutation/retry, projects internal `McpConnectionManager` health/list changes into an immutable `McpControlSnapshot`, and re-runs the config/approval gate. The connection manager is not exported by the public MCP barrel and does not implement `McpRuntimeProvider`. Connections carry generation and provider-version tokens; late or stale connect/discovery/list-changed work cannot restore an old capability snapshot or binding. Runtime depends only on `McpRuntimeProvider`, while TUI depends only on an App controller and the control snapshot. See [`mcp-control-plane.md`](mcp-control-plane.md).

Tool execution 的 Provider readiness 由 Runtime-owned `ProviderReadinessCoordinatorV1` 治理，而不是
Controller、Builtin catalog entry、search 或 Supervisor adapter 隐式重试。lifecycle key 精确绑定 provider、当前
route/config revision 与 execution-boundary digest；Runtime 持久化 intent、每个 Tool Call 的 waiter、
attempt ack 及 success/failure receipt。同 key 的并发 waiter 合并为一次 attempt；config/route revision
变化产生新 key。attempt 后缺 terminal receipt 在 restore 时为 unknown，调用方不得猜测成功或重试；只有
已经 durable ack 的 `tool.retry_recorded` 可授权受限第二次 attempt。Supervisor 的 on-demand readiness
入口每次最多执行一次 reconnect，startup 自身的 bounded connect policy 不得泄漏为 Tool attempt 内部 retry。
`tool_search`、`list_mcp_tools` 与 capability discovery 只读 snapshot，不触发 readiness。

The Runtime provider also exposes a redacted provider directory so pending approval, rejected, disabled, login-required, connecting, failed and quarantined providers are not confused with absent capabilities. Manager/Supervisor failures cross this boundary as `provider_auth_required`, `provider_approval_required`, `provider_unavailable` or `provider_capability_changed`; Tool Controller maps these typed errors without parsing SDK error strings.

Error classification in `packages/builtin-runtime/src/mcp/diagnostics.ts` reads the `status`/`statusCode`/`code` record fields and accepts numeric strings, so HTTP-like status codes delivered as strings or via `code` are still recognized as typed failures (e.g. `auth_required`, `provider_unavailable`) without parsing SDK error strings. After an interactive OAuth connect, a server whose connected diagnostic is `auth_required` returns `authorization_required` immediately instead of `connected`, so the Provider Action surface (`provider_auth_required` → `login`) stays consistent with a missing credential. The Supervisor's `authStatus` projection maps an `auth_required` diagnostic to `login_required`, but never overrides an in-progress `authorizing`/`refreshing` flow, so transient states (e.g. `browser_open_failed` after a failed opener) stay visible while the browser prompt is active.

`mcpProviderActionV1` is registered and defaults to false. When enabled, auth-required, approval-required and retryable-unavailable failures first terminate the old Tool Call as `failed`, then open a persisted Provider Action interaction for fixed `login`、`approve` or `retry`. The interaction contains no old arguments, binding, approval, URL, token, authorization code or raw error. Its originating Tool must remain terminal and unscheduled. The App shell owns the actual control-plane action; Runtime only records required/started/completed/deferred/failed facts. Completion atomically starts a new turn so only the current catalog can issue later bindings. Deferred and failed actions clear the interaction and remain explicit transcript facts. `provider_capability_changed` stays model-fixable and never creates an external recovery action. TUI maps the interrupt through its existing foreground/background input routing and delegates the selected action to `TuiMcpController`; CLI without an interactive recovery controller safely defers.

The same flag gates required-provider admission. Before the first model request, effective required providers in `ready` or `degraded` state are admitted; every other required provider is queued in stable provider-id order. Scheduler exposes one admission interaction at a time and cannot call the model until all are resolved. Retry records a control-plane attempt outcome, Session Waive persists provider/source/fixed reason/time, and Cancel records task/turn cancellation and stops the run. A provider-admission UI or transport exception is not Cancel: it produces an error-caused terminal and never forges a user cancellation. A waiver only releases admission: it never changes availability, creates a descriptor, disclosure or binding, and the model receives an explicit Runtime fact that the capability remains unavailable. Schema 12 persists the queue and session waivers. TUI presents Retry/Session Waive/Cancel Run through the existing interrupt surface. PTY coverage proves that no model request occurs before the gate and that Session Waive releases the run without exposing the unavailable capability.

For auditable trust, prefer `trust: { provenance: 'admin' | 'user' | 'project', allowAnnotations: 'read_only' }`. This local decision only permits a server's `readOnlyHint` to classify a tool as read-only; it cannot lower an explicit per-tool `minimumApproval` or grant new effects. The legacy `trust: 'trusted'` form remains a user-configured compatibility spelling and records no elevated provenance.

MCP results retain protocol content blocks and structured content. `_meta` is not persisted. The JSON-safe
`CapabilityResult` contract is owned by `@kite/runtime-contract`; MCP normalization、Builtin executor、Host Tool
Pipeline 与 App State25 projection share that single result shape without introducing a duplicate DTO. TP-03 后，MCP Tool 和 MCP Resource 与
所有其他 governed Tool 共用唯一 Host Tool Pipeline coordinator：每个 attempt 在协议请求前 durable ack，结果
经严格 JSON normalize 后写入独立 private Capability Artifact，capability receipt 与 Tool terminal 原子提交。
只读 observation 的已知失败写入失败 receipt 并继续给模型成对 Tool Result；write/unknown effect 在 dispatch
后缺少可信 terminal receipt 时保持 `execution_unknown`，不会因 provider error 或 Artifact failure 自动重放。
Runtime retry 仍只允许另行 ack 的 safe-read attempt；idempotency key 本身不是 receipt。When
`verificationV1` is enabled, a successful side-effecting receipt creates required verification backed by its
immutable artifact and external references; existing verification remains binding after the flag is disabled.

When Runtime resource admission governs an MCP invocation, its capability receipt, Tool terminal fact and
actual resource reconciliation must be committed through the required atomic event-batch persistence
boundary. Runtime has no sequential single-event fallback for this batch: persistence failure leaves the
dispatch outcome conservative instead of exposing a terminal MCP result whose budget ledger was not
reconciled. `read_mcp_resource` 的失败 projection 会省略未定义的可选 metadata，而不是把 `undefined`
带入严格 Artifact；Resource 不存在仍形成 canonical failure receipt 与成对 Tool Result。

Skill Workflow Contract Phase 3 is complete. A Skill is not a prompt fragment: only a strict, versioned YAML `SKILL.md` compiled into a `skill` capability can become activatable. While `skillWorkflowV1` and `skillActivationV2` are disabled, Skill activation fails closed. The legacy body-injection path and `Skill` tool are removed; valid inline activations are revision-checked Runtime frames and can close only with output that validates against the contract schema. Compilation resolves Builtin and current MCP dependencies and produces one `effectiveCapabilityCeiling = require - deny`; deny entries outside require are invalid. Skill effective effects conservatively join the manifest with every effective dependency, and effective minimum approval is the maximum of manifest and dependencies. Model activation passes this effective risk through the normal approval/auto-review gateway before creating a frame, while explicit initial user activation is already user-requested. Verification derives its mode from effective effects. Inline and fork frames use the same effective ceiling, and dependency revisions participate in the Skill revision. Only an available higher-priority candidate may shadow a same-name lower-priority Skill, so an invalid project Skill cannot disable a valid user Skill. Scanning is bounded to depth 8, 256 files, 1 MiB per file and 8 MiB total, ignores common VCS/build/cache directories, rejects symlinks, and hashes sorted path/length/content without base64 expansion. Verification and compensation entrypoints cannot point into ignored directories. Supporting files are never injected wholesale; an active frame may read only declared regular files through `read_skill_reference`, subject to the source/revision boundary and 128 KiB direct-read limit.

RMV1-11 已把 Skill 领域规则物理迁入 `packages/builtin-runtime/src/skills/lifecycle.ts`。active frame 的
task/revision 校验、声明文件读取边界、inline 结构化完成、activation、fork 输出校验、
`skill.frame_closed` 与 Verification 请求均由该服务统一产生；三个 Skill Builtin catalog entry 只保留 Schema、契约、
effects 与 result contract，唯一 concrete execution 位于 Builtin module。调用点只投影冻结的最小 Skill state
view，不把完整 AgentState 交给 Builtin；事件和回放形状不变。

Phase 5 progressive disclosure is complete. With `toolSearchV1` enabled, MCP Tools ≤20 within token budget are directly bound to avoid a search round-trip; Skill disclosure uses an independent budget decision and is never force-disclosed by a small MCP catalog. `tool_search` is always exposed regardless of disclosure mode, reverting to metadata search when the catalog exceeds budget. Selected Tools remain loaded for the session while their revisions match. Search never authorizes execution. Stale search results, unsupported providers and revision drift fail closed.

HTTP connection uses up to three initial transient attempts. When an already loaded Tool targets a non-callable HTTP Provider, Supervisor serializes a 1/2/4/8/16-second reconnect sequence per Provider and the Tool Call waits at most 30 seconds; one Provider's recovery never queues a healthy or unrelated Provider. Auth, not-found, invalid-config and approval failures do not retry. STDIO never auto-restarts. Recovery success rechecks generation and descriptor revision; timeout returns typed `provider_unavailable`. Transport handles only in-connection protocol recovery, Supervisor handles Provider recovery, and Runtime/Execution may automatically replay exactly once only for a policy-authorized `safe_read`; it must persist `tool.retry_recorded` before the second provider dispatch. An idempotency key is not a receipt and does not authorize replay; a keyed write remains single-dispatch until a trusted idempotency receipt contract exists. The connection manager sends exactly one SDK call per invocation, and a safe-read replay re-enters `callCapability` revision/schema checks with unchanged arguments. The circuit breaker only rejects quickly and never reconnects. Runtime cancellation propagates through discovery waiting, reconnect backoff and the SDK Tool Call.

Model-visible MCP Tool names preserve the legacy `mcp__<provider>__<tool>` spelling when it already satisfies strict model-provider limits. Unsafe or overlong remote names are normalized to a deterministic ASCII identifier of at most 64 characters with a collision-resistant suffix. The turn binding remains authoritative, and execution maps that identifier back to the original Provider and remote Tool name rather than parsing the normalized alias as an executable identity.

MCP protocol results retain their complete governed `capabilityResult` for execution receipts and artifacts, while the model-facing serialized Tool output is bounded to 128 KiB. Oversized output becomes an explicit `partial` result with a truncation marker and original character count; it must not expand the transcript without limit.

MCP 对模型暴露三个正交概念，各自有独立的发现工具：

- **Provider**（是否配置、是否可调用、需要什么恢复动作）→ `list_mcp_tools`
- **Tool / Capability**（当前可执行什么，或什么能力能完成目标）→ `tool_search` + `list_mcp_tools`
- **Resource**（Provider 暴露了哪些静态内容）→ `list_mcp_resources` / `read_mcp_resource`

任何一个结果为空都不能自动推出另外两个为空。

`list_mcp_tools` 是确定性的纯只读内置工具，不触发 Provider 连接或 discovery 等待。基于 Capability Snapshot 和 Provider Directory Snapshot 构建脱敏清单，所有输出字段经过控制字符和代理对清理。列出每个 Provider 的状态、next_action、可用 Tool 数，按 provider/name 稳定排序；支持分页（默认 50 条，最大 100 条，cursor 绑定 snapshot revision）。`configured_provider_count`、`callable_provider_count` 和 `available_tool_count` 为全量去重值，不受 provider 过滤影响；Capability Snapshot 中存在但 Provider Directory 中缺失的 Provider 被防御性补标为 `ready` 并计入 callable（状态 `explicit`）；过滤时额外返回 `matched_provider_count`、`matched_callable_provider_count` 和 `matched_tool_count`。输出不含 capabilityId、revision、schema、transport、credential 或 binding。模型询问"有哪些 MCP 工具/服务"时应调用此工具，而不是 `list_mcp_resources` 或 `tool_search`。

MCP Resources 使用客户端内置的 `list_mcp_resources → read_mcp_resource` 闭环，不假设 Provider 暴露 `mcp__<server>__list_resources` Tool。Resource Directory 只包含 effective 且 callable Provider 最近成功 `resources/list` 返回的静态资源，并按 Provider/URI/name 稳定排序。列表可按 Provider 过滤，最多返回 100 条 `server/uri/name/mime_type`，不得透传远端 description；读取前必须重新确认 Provider Health 和 URI 仍存在于当前 snapshot。`resources/list_changed` 成功替换目录，失败保留最近成功目录并标记 degraded。两项工具均为无审批只读内置工具，不进入 capability search、loaded set 或 turn binding；读取输出同样受 128 KiB 上限约束。

MCP failure isolation is a session-level invariant. Protocol errors, unavailable Providers, timeout, cancellation, invalid results and unexpected local adapter exceptions terminate only the current Tool Call. Every failed or rejected call produces exactly one paired, structured error Tool Message before scheduling returns to the model; the Runtime must not leave an orphaned assistant tool call, abort the conversation loop or surface a local stack trace as the assistant's final answer. The single App Runtime effect coordinator and Host Tool Pipeline convert a confirmed dynamic MCP failure into one State25 terminal receipt; a post-ack uncertainty becomes non-replayable unknown. This containment never marks the failed call successful or automatically replays it.

When the MCP provider directory contains unavailable entries, `tool_search` may also be exposed beside a catalog that otherwise fits the budget. A query matching a provider name or last-known Tool name returns only a bounded provider status, diagnostic code and fixed next action. `degraded` providers are excluded from unavailable search results (they remain callable). It never returns a schema, capability ID or executable handle and never creates a binding. Provider status predicates (callable/unavailable/healthy) and next-action mapping are centralized in `packages/builtin-runtime/src/mcp/provider-status.ts`. Provider Action and required-provider admission lifecycles are available only behind their shared default-off flag and preserve ADR-0012.

The E2E contract uses real MCP transports and real on-disk scope resolution. It covers user-level authenticated HTTP MCP with environment-expanded bearer headers, invalid-token fail-closed behavior, project-level authenticated stdio MCP after production approval, absence of stdio process and HTTP requests before approval, project-over-user precedence, plus user/project Skill discovery, shadowing, tool execution and frame closure. Credentials must not appear in Runtime or persisted events. OAuth/interactive `authProvider` is implemented through the same Manager/SDK path and has a local HTTP integration covering discovery, dynamic registration, PKCE/state, code exchange and post-auth discovery. TUI PTY Login/Cancel/opener failure and macOS Keychain, Windows Credential Manager and Linux Secret Service native smoke have passed. See [`mcp-authentication.md`](mcp-authentication.md).

Builtin skill/tool catalog (`packages/builtin-runtime/src/skills/catalog.ts`) tracks known agent tools. `apply_patch` was removed — it had a contract (`TOOL_CONTRACTS`) but was never registered as an agent tool.

## Production Capability Release 边界

MCP write profile 当前 `under_development/off`，production route registry 为空。未来 admission 必须同时
验证 `mcpExecutionRecordV1`、`mcpProviderActionV1`、stable Verification dependency、精确
provider/server/tool schema/revision、Provider Data/egress/network policy、route qualification 与实际
G3–G5 freshness。外部写入先写 intent；只有同 invocation 的可信 idempotency replay 可以返回已有
receipt，unknown external effect 只能 reconciliation，Provider Action 不能重放业务调用。

Manager 现有独立 production write dispatch guard 接线：对 write/destructive/unknown external effect，
sealed production 配置在 SDK/transport dispatch 前强制要求 guard；缺 guard、admission/intent 持久化失败
或明确拒绝均产生零 Provider call。guard 只接收实际 discovery/route 的 server、endpoint、tool revision、
schema/policy/effects、approval 与 Provider Data receipt、transport/remote-egress receipt 和 arguments digest，
不接收正文；这些 invocation facts 任一缺失即拒绝。成功 dispatch 后记录 provider result digest，调用异常或
MCP `isError=true` 都记录 `unknown`，receipt 持久化失败继续 fail closed。普通
未启用 production requirement 的开发组合保持现有用户审批行为；该接线不会把空 route registry 打开。

Skill readonly/effectful 按 ADR-0064 保守分类：只有自身和全部 dependency 的 effective effects 均为
`none|read` 且 provenance 允许时才是 readonly；write、destructive、unknown、解析或 revision drift
一律 effectful/off，并要求 Verification。当前两个 Skill profile 均 off；本地 conformance 是当前路线
终态，旧 rollout/promotion adapter 只保留为 fail-closed 负向资产。
