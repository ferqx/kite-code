# Capability Progressive Disclosure

状态：active

读取时机：修改 MCP/Skill catalog、模型工具披露、`tool_search`、Runtime binding、Skill activation 或模型上下文预算策略时。

验证：`bun test tests/runtime/capability-search.test.ts tests/runtime/tool-controller.test.ts tests/mcp-supervisor.test.ts tests/tool-definitions.test.ts`、`bun run typecheck`。

`capabilityCatalogV1`、`mcpRuntimeBindingV1` 与 `toolSearchV1` 已完成迁移并默认开启。MCP Tool 一律使用 provider-neutral metadata 搜索，不再因小目录而全量注入 Schema；Skill 继续根据 provider 工具调用能力与 catalog 上下文预算在全量披露、metadata 搜索和 fail-closed 之间选择。显式关闭任一 MCP flag 只用于 fail-closed 诊断，不恢复旧 adapter。

Per-tool 名称注入（`## Available MCP Tool Names` 段落）已移除。模型初始只通过 system prompt 中的固定 MCP Capability Usage 规则和工具列表中的 `list_mcp_tools`、`tool_search`、`list_mcp_resources` 三个内置工具发现 MCP 能力。规则明确禁止将 Resource 列表为空推断为 MCP Tool 不存在，并将三种用户意图路由到对应工具。

`list_mcp_tools` 是确定性的 MCP 工具盘点工具，基于 CapabilitySnapshot 和 ProviderDirectorySnapshot 构建脱敏清单。列出每个 Provider 的状态、next_action、可用 Tool 名称，支持 provider 过滤和 cursor 分页；输出不含 capabilityId、revision、schema 或 binding。mcpManager 不存在时返回合法空清单。Provider 配置为空和 Provider 不可用（login_required、pending_approval、disabled、failed 等）产生不同结果。

`tool_search` 只负责按意图发现能力（"哪个 Capability 可以完成这个动作"），不再承担全量 Tool inventory。包含 MCP 清单意图的查询（中英文均支持，中文不依赖空格分词）会被重定向为 `inventory_query` + `next_tool: list_mcp_tools`，提醒模型使用正确的盘点工具。这是错误恢复机制，不作为 inventory 的主要实现。包含业务关键词的 query 继续使用相关性排序。

零匹配搜索结果现在附带 `catalog_summary`（available_mcp_tool_count、available_skill_count、configured_provider_count、unavailable_provider_count）和显式说明消息，避免模型把 "zero matches" 解释为 "empty catalog"。

模型请求与其返回的 Tool Call 之间可能跨越 catalog revision。`lastKnownMcpToolMetadata` fallback 仅作为 `tool_search` 中非 inventory 查询的目录切换说明，不得进入 `capability.search_completed.candidates`、loaded set 或 Binding。具体 Tool 的后续搜索与执行仍必须基于当前 descriptor/revision fail closed。

当 MCP directory 存在 unavailable Provider 时，即使可用 catalog 未超预算，也可以同时暴露 `tool_search`。query 可匹配 provider 名称或最近一次成功 discovery 的 Tool 名称；公共 provider 结果最多 4 条，稳定排序，只包含安全截断名称、`pending_approval|rejected|disabled|login_required|connecting|degraded|failed|quarantined`、有限 diagnostic code 和固定 next action。首次 discovery 前不虚构 Tool 名称。Provider 摘要不进入候选 binding，也不提供可执行 handle。

当查询明确命中仍处于 `connecting` 的 Provider 且当前没有候选 Tool 时，`tool_search` 最多等待 5 秒完成该 Provider 的初始 discovery，然后基于最新 revisioned snapshot 重新搜索。等待接受 Runtime 取消信号；超时或失败仍只返回不可用 Provider 元数据，不虚构 Tool、Schema 或 binding。

有限 binding 的模型工具声明同样不得透传远端自然语言：工具 description 使用 Runtime 固定契约，模型可见 input schema 会递归移除 `description`、`title`、`$comment`、`examples` 和 `default` 注释；Runtime 参数校验仍使用原始 revisioned schema，因此该清理不会放宽执行边界。

搜索结果通过 `capability.search_completed` 持久化。下一次模型调用重新核对 catalog/capability revision，把命中的 MCP Tool 合并进 session-loaded set，并为全部仍有效的 loaded Tool 生成新的 turn-scoped binding；命中的 Skill 仍只生成本轮 disclosure。`capability.bindings_issued` 原子替换本轮 binding/disclosure、持久化完整 loaded set 并消费搜索结果。catalog 漂移会淘汰对应 loaded Tool，且不得回退到旧 MCP 注入。

搜索只负责发现，不负责授权。MCP 调用仍必须携带 Runtime-issued binding，并继续经过 schema、policy、approval、execution record 和 verification；Skill activation 在该 flag 开启时必须匹配本轮 disclosure，猜测 Skill ID 会被拒绝。关闭 flag 只恢复现有的治理型全量 binding 路径，不恢复旧 MCP adapter 或 Prompt Skill 正文注入。

MCP Resources 不进入 `tool_search`、session-loaded Tool set 或 turn-scoped binding。`list_mcp_resources` 与 `read_mcp_resource` 是稳定内置只读工具：前者从 Runtime Resource Directory 枚举静态 URI，后者只读取当前 discovery snapshot 中存在的 URI。Resource discovery 与 Tool progressive disclosure 保持独立。

三类 MCP 暴露概念必须正交：Provider != Tool != Resource。任何一个为空不自动推出另外两个为空。
