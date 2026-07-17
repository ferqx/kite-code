# Capability Progressive Disclosure

状态：active

读取时机：修改 MCP/Skill catalog、模型工具披露、`capability_search`、Runtime binding、Skill activation 或模型上下文预算策略时。

验证：`bun test tests/runtime/capability-search.test.ts tests/runtime/tool-controller.test.ts tests/mcp-supervisor.test.ts tests/tool-definitions.test.ts`、`bun run typecheck`。

当 `capabilitySearchV1` 开启时，Runtime 根据 provider 工具调用能力与 catalog 上下文估算，在全量治理披露、metadata 搜索和 fail-closed 之间选择。估算预算默认取模型上下文窗口的 1%，并限制在 1024～8192 tokens；可通过 provider `modelKwargs.contextWindowTokens` 和 `modelKwargs.capabilityDisclosureBudgetTokens` 显式覆盖。

大目录只向模型暴露 provider-neutral `capability_search`。搜索在本地 revisioned snapshot 上执行，只返回候选引用、种类、安全截断后的名称和 provider metadata；不返回 capability ID、描述、input schema、参数、binding 或调用句柄。远端描述可参与本地召回排序，但不得进入搜索结果，避免把不可信描述注入模型上下文。

当 MCP directory 存在 unavailable Provider 时，即使可用 catalog 未超预算，也可以同时暴露 `capability_search`。query 可匹配 provider 名称或最近一次成功 discovery 的 Tool 名称；公共 provider 结果最多 4 条，稳定排序，只包含安全截断名称、`pending_approval|rejected|disabled|login_required|connecting|degraded|failed|quarantined`、有限 diagnostic code 和固定 next action。首次 discovery 前不虚构 Tool 名称。Provider 摘要不进入候选 binding，也不提供可执行 handle。

有限 binding 的模型工具声明同样不得透传远端自然语言：工具 description 使用 Runtime 固定契约，模型可见 input schema 会递归移除 `description`、`title`、`$comment`、`examples` 和 `default` 注释；Runtime 参数校验仍使用原始 revisioned schema，因此该清理不会放宽执行边界。

搜索结果通过 `capability.search_completed` 持久化。下一次模型调用必须重新核对 catalog revision 和每个 capability revision，随后只为命中的 MCP tool 生成 turn-scoped binding，并为命中的 Skill 生成 turn-scoped disclosure。`capability.bindings_issued` 会原子替换本轮 binding/disclosure 并消费一次搜索结果。catalog 漂移、过期 turn、搜索无结果或 provider 不支持工具调用时均不得回退到旧 MCP 注入。

搜索只负责发现，不负责授权。MCP 调用仍必须携带 Runtime-issued binding，并继续经过 schema、policy、approval、execution record 和 verification；Skill activation 在该 flag 开启时必须匹配本轮 disclosure，猜测 Skill ID 会被拒绝。关闭 flag 只恢复现有的治理型全量 binding 路径，不恢复旧 MCP adapter 或 Prompt Skill 正文注入。
