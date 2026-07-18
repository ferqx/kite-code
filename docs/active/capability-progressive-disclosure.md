# Capability Progressive Disclosure

状态：active

读取时机：修改 MCP/Skill catalog、模型工具披露、`capability_search`、Runtime binding、Skill activation 或模型上下文预算策略时。

验证：`bun test tests/runtime/capability-search.test.ts tests/runtime/tool-controller.test.ts tests/mcp-supervisor.test.ts tests/tool-definitions.test.ts`、`bun run typecheck`。

`capabilityCatalogV1`、`mcpRuntimeBindingV1` 与 `capabilitySearchV1` 已完成迁移并默认开启。MCP Tool 一律使用 provider-neutral metadata 搜索，不再因小目录而全量注入 Schema；Skill 继续根据 provider 工具调用能力与 catalog 上下文预算在全量披露、metadata 搜索和 fail-closed 之间选择。显式关闭任一 MCP flag 只用于 fail-closed 诊断，不恢复旧 adapter。

模型初始只收到稳定排序、安全截断的 Provider/Tool 名称摘要和 `capability_search`。名称摘要不包含远端描述、input schema、参数、capability ID、binding 或调用句柄。搜索在本地 revisioned snapshot 上执行；远端描述可参与本地召回排序，但不得进入搜索结果。

`capability_search` 同时支持具体能力召回和明确的 MCP Tool 清单查询。包含 `MCP` 且只表达 `list/available/configured/tools/servers/catalog` 等清单意图的 query，必须按 capability ID 稳定枚举当前 available MCP Tools（仍受 12 条上限约束），不得混入 Skill；包含业务关键词的 query 继续使用相关性排序。Resource 列表为空不得被解释为 MCP Tool catalog 为空。

模型请求与其返回的 `capability_search` Tool Call 之间可能跨越 catalog revision。若明确的 MCP 清单查询在当前 snapshot 无候选，但 Provider Directory 仍有最近成功 discovery 的 Tool 名称，公共 Tool Result 可以返回这些稳定排序、names-only、标记为 `last_known` 的名称用于解释目录切换；它们不得进入 `capability.search_completed.candidates`、loaded set 或 Binding。具体 Tool 的后续搜索与执行仍必须基于当前 descriptor/revision fail closed。

当 MCP directory 存在 unavailable Provider 时，即使可用 catalog 未超预算，也可以同时暴露 `capability_search`。query 可匹配 provider 名称或最近一次成功 discovery 的 Tool 名称；公共 provider 结果最多 4 条，稳定排序，只包含安全截断名称、`pending_approval|rejected|disabled|login_required|connecting|degraded|failed|quarantined`、有限 diagnostic code 和固定 next action。首次 discovery 前不虚构 Tool 名称。Provider 摘要不进入候选 binding，也不提供可执行 handle。

当查询明确命中仍处于 `connecting` 的 Provider 且当前没有候选 Tool 时，`capability_search` 最多等待 5 秒完成该 Provider 的初始 discovery，然后基于最新 revisioned snapshot 重新搜索。等待接受 Runtime 取消信号；超时或失败仍只返回不可用 Provider 元数据，不虚构 Tool、Schema 或 binding。

有限 binding 的模型工具声明同样不得透传远端自然语言：工具 description 使用 Runtime 固定契约，模型可见 input schema 会递归移除 `description`、`title`、`$comment`、`examples` 和 `default` 注释；Runtime 参数校验仍使用原始 revisioned schema，因此该清理不会放宽执行边界。

搜索结果通过 `capability.search_completed` 持久化。下一次模型调用重新核对 catalog/capability revision，把命中的 MCP Tool 合并进 session-loaded set，并为全部仍有效的 loaded Tool 生成新的 turn-scoped binding；命中的 Skill 仍只生成本轮 disclosure。`capability.bindings_issued` 原子替换本轮 binding/disclosure、持久化完整 loaded set 并消费搜索结果。catalog 漂移会淘汰对应 loaded Tool，且不得回退到旧 MCP 注入。

搜索只负责发现，不负责授权。MCP 调用仍必须携带 Runtime-issued binding，并继续经过 schema、policy、approval、execution record 和 verification；Skill activation 在该 flag 开启时必须匹配本轮 disclosure，猜测 Skill ID 会被拒绝。关闭 flag 只恢复现有的治理型全量 binding 路径，不恢复旧 MCP adapter 或 Prompt Skill 正文注入。

MCP Resources 不进入 `capability_search`、session-loaded Tool set 或 turn-scoped binding。`list_mcp_resources` 与 `read_mcp_resource` 是稳定内置只读工具：前者从 Runtime Resource Directory 枚举静态 URI，后者只读取当前 discovery snapshot 中存在的 URI。Resource discovery 与 Tool progressive disclosure 保持独立。
