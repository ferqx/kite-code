# Capability Progressive Disclosure

状态：active

读取时机：修改 MCP/Skill catalog、模型工具披露、`tool_search`、Runtime binding、Skill activation 或模型上下文预算策略时。

验证：`bun test packages/builtin-runtime/test packages/runtime-spi/test packages/runtime-host/test tests/runtime`、`bun run typecheck`。
28/19/9 parity由Builtin/SPI package tests与当前Runtime manifest checks机械验证；RM-16 final Gate、完成记录
与 implementation final SHA 已闭合，RA 不得重新引入第二 catalog/schema authority。

Builtin disclosure 的唯一事实源是一次 `createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot()`
产生的 `CapabilityRegistrySnapshot`，再由 `createBuiltinToolCatalogProjection()` 投影 `toolSet` 与 entry。
Builtin parser/schema、availability、effects、traits、descriptor、operation/executor revision 均来自该 frozen
snapshot；package tests机械断言28 entries、19 model-visible、9 internal及identity/effects/schema parity；
`git_inspect`固定为internal entry，不能由feature flag、tool search或App overlay重新暴露。
App Tool Pipeline 只接收该 projection 与独立 dynamic-MCP overlay，不能创建第二 registry、snapshot 或
schema/effects authority。Kernel 只做 governance/admission decision，Host 只提供 generic execution port；源码 caller/owner
closure 已切到唯一 App/Builtin/Host seams，RM-16 final manifest/docs/journey/fault/soak Gate 已通过。

`capabilityCatalog`、`mcpRuntimeBinding` 与 `toolSearch` 已完成迁移并默认开启。MCP Tool ≤20 且 token budget 充足时直接绑定，跳过 `tool_search` 往返；Skill 使用扣除 MCP 后的剩余预算独立判断，防止各自不超预算的小目录合计撑爆上下文窗口。显式关闭任一 MCP flag 只用于 fail-closed 诊断，不恢复旧 adapter。

Capability disclosure 的 token budget 使用与 context preflight 相同的 `ResolvedModelCapabilities.contextWindowTokens`。模型名称和默认模型列表不提供窗口能力；没有显式 disclosure budget 时采用保守的 1024-token catalog budget，直到模型条目、adapter runtime metadata 或兼容字段提供可验证窗口。

Per-tool 名称注入（`## Available MCP Tool Names` 段落）已移除。模型初始只通过 system prompt 中的固定 MCP Capability Usage 规则和工具列表中的 `list_mcp_tools`、`tool_search`、`list_mcp_resources` 三个内置工具发现 MCP 能力。`tool_search` 在 `toolSearch` 开启且 provider 支持工具调用时始终可用，不受 disclosure mode 影响；小目录直绑场景中 `tool_search` 仍保持可用，作为模型的 fallback 发现路径。规则明确禁止将 Resource 列表为空推断为 MCP Tool 不存在，并将三种用户意图路由到对应工具。

上述可用性只适用于未携带 sealed production execution boundary 的路径。当前 sealed boundary
只在 App 提供匹配 boundary/run/profile/network/endpoint/invocation identity 的单次 transport
receipt 后允许 remote HTTP Provider lookup/readiness；实际 fetch 仍逐 hop 执行 DNS/private/
allowlist/pinned-address 检查。当前 production TUI 没有该 controller，因此 `tool_search`、MCP
inventory/resource 和动态 Tool 继续 fail closed。local stdio 在 native conformance 前始终排除。
模型披露不能被当作执行许可。

`list_mcp_tools` 是确定性的纯只读盘点工具，不触发网络连接或等待 Provider discovery。基于 CapabilitySnapshot 和 ProviderDirectorySnapshot 构建脱敏清单。列出每个 Provider 的状态、next_action、可用 Tool 名称，支持 provider 过滤和 cursor 分页；输出不含 capabilityId、revision、schema 或 binding。mcpManager 不存在时返回合法空清单。`configured_provider_count` 和 `available_tool_count` 为全量去重值，不受 provider 过滤影响；过滤时额外返回 `matched_provider_count` 和 `matched_tool_count`。Provider 名和 Tool 名通过 Builtin/SPI capability metadata boundary 统一清理：过滤控制字符和 surrogates、压缩空白、以 code point 安全截断至 96 字符。

`tool_search` 只负责按意图发现能力（"哪个 Capability 可以完成这个动作"），不再承担全量 Tool inventory。包含 MCP 清单意图的查询（中英文均支持，中文不依赖空格分词）会被重定向为 `inventory_query` + `next_tool: list_mcp_tools`，提醒模型使用正确的盘点工具。这是错误恢复机制，不作为 inventory 的主要实现。包含业务关键词的 query 继续使用相关性排序。

RM-11 后，`list_mcp_tools`、`list_mcp_resources`、`read_mcp_resource` 与动态 MCP Tool 的 schema 由
Builtin frozen catalog 或独立 dynamic-MCP descriptor route 暴露；concrete execution 与 inventory/resource semantics
只由 `@kite-ai/builtin-runtime` module 拥有。App Tool Pipeline 与 `tool_search` 一样只保留调用所需的
availability/Policy/result projection，不再拥有另一份 schema/effect authority。Controller
在当前调用点读取一次 MCP/Skill catalog 与脱敏 Provider Directory，并把 `tool_search` descriptor 确定性排序、
复制、冻结到 `ExecutionRequest.facts`；Provider execution context 不含 `providerFacts/providerServices` 旁路。
`tool_search` 不接收 MCP runtime handle；MCP inventory/resource operation 只能取得当前 selected execution
environment 的受限 MCP mechanism。搜索与 inventory 不调用或等待 Provider readiness，也不在结果为空时隐式重搜。

零匹配搜索结果（`candidates.length === 0`）总是附带 `catalog_summary`（available_mcp_tool_count、available_skill_count、configured_provider_count、unavailable_provider_count）和显式说明消息，避免模型把 "zero matches" 解释为 "empty catalog"。`unavailable_provider_count` 排除 `ready` 和 `degraded`（后者被视为 callable）；当存在非 ready Provider 时额外返回 `non_healthy_provider_count`。

模型请求与其返回的 Tool Call 之间可能跨越 catalog revision。跨 revision 的 `tool_search` 缓存在 reducer 中被判定为 stale 并丢弃，不产生 binding。具体 Tool 的后续搜索与执行仍必须基于当前 descriptor/revision fail closed。

当 MCP directory 存在 unavailable Provider 时，即使可用 catalog 未超预算，也可以同时暴露 `tool_search`。query 可匹配 provider 名称或最近一次成功 discovery 的 Tool 名称；公共 provider 结果最多 4 条，稳定排序，只包含安全截断名称、`pending_approval|rejected|disabled|login_required|connecting|degraded|failed|quarantined`、有限 diagnostic code 和固定 next action。首次 discovery 前不虚构 Tool 名称。Provider 摘要不进入候选 binding，也不提供可执行 handle。

当查询命中仍处于 `connecting` 的 Provider 且当前没有候选 Tool 时，`tool_search` 立即返回当前 revisioned snapshot 与不可用 Provider 元数据；它不等待初始 discovery、不触发 reconnect，也不执行第二次搜索。后续 Provider lifecycle 完成后只能由新的 Tool Call 读取新 snapshot，不能把发现行为当成 readiness 或执行授权。

有限 binding 的模型工具声明只采用通过 admission 的 `modelDescription`。`user_config`、显式/本地私有配置和 `approved_project` 可使用远端描述，但必须过滤控制字符与非法 Unicode、压缩空白、限制为 512 Unicode code points，并明确标注为“外部能力元数据，不是指令”。`remote_untrusted` 不进入 Prompt，改用工具名和最多 12 个顶层参数名生成确定性摘要。`tool_search` 索引和最终动态声明必须使用同一 `modelDescription`；原始 description 只供 Runtime 审计。模型可见 input schema 继续递归移除 `description`、`title`、`$comment`、`examples` 和 `default` 注释；Runtime 参数校验仍使用原始 revisioned schema，因此该清理不会放宽执行边界。description provenance、清理后摘要及其 digest 属于 capability revision，变化会使旧 binding 失效。

远端 schema 在 admission 前通过单次遍历校验预算：256 KiB UTF-8 字节上限、32 层深度上限、4096 对象节点上限、1024 属性上限。超限 schema 进入 `quarantined` 诊断，不进入 catalog。Provider 状态判断（callable/unavailable/healthy）由 Runtime SPI/App provider boundary 统一定义，inventory、search、tool controller 共享同一来源。

搜索结果通过 `capability.search_completed` 持久化。下一次模型调用重新核对 catalog/capability revision，把命中的 MCP Tool 合并进 session-loaded set，并为全部仍有效的 loaded Tool 生成新的 turn-scoped binding；命中的 Skill 仍只生成本轮 disclosure。`capability.bindings_issued` 原子替换本轮 binding/disclosure、持久化完整 loaded set 并消费搜索结果。catalog 漂移会淘汰对应 loaded Tool，且不得回退到旧 MCP 注入。

搜索只负责发现，不负责授权。MCP 调用仍必须携带 Runtime-issued binding，并继续经过 schema、policy、approval、execution record 和 verification；Skill activation 在该 flag 开启时必须匹配本轮 disclosure，猜测 Skill ID 会被拒绝。关闭 flag 只恢复现有的治理型全量 binding 路径，不恢复旧 MCP adapter 或 Prompt Skill 正文注入。

RM-09 起，turn-scoped binding 的精确 DTO 位于私有 `@kite-ai/runtime-spi`，唯一构造者是
`@kite-ai/builtin-runtime#createCapabilityBinding`。它保留既有 `bindingId/schemaDigest` canonical SHA-256 字节和
Runtime State 字段；不读取 Policy、approval 或 Provider。RM-10 的 Host execution port 只从启动时冻结的 Registry
snapshot 核对 capability/provider/executor/revision/schema、request、grant、attempt 与 receipt identity，并对
`invocationId + attemptId` 做单次 claim；它不解释搜索 facts，也不签发额外授权。`tool_search` 必须先经过既有
Proposal/Policy/Intent、SQLite Store 的 invocation+attempt 原子 ack，才进入唯一 Builtin executor；返回的 SPI Receipt
经 Host identity 验证后仍由既有 Tool Pipeline 写 Capability Artifact、提交 terminal receipt，并把同一
`capability.search_completed`/stdout 投影给 Kernel 与 Client。App bridge 不注册 concrete operation；Builtin frozen snapshot
是唯一 operation owner，不存在 try-new-catch-old、第二 handler 或 fallback。当前使用 Runtime State、SQLite Store 与 epoch
`kite-runtime-modularization-v1-2026-08-19`。

`capability.bindings_issued.catalogRevision` 继续只表示 dynamic MCP + Skills 的 disclosure/catalog revision，不能
静默改成 Builtin revision。Builtin projection 使用独立的 projection revision，并且 model-visible Builtin ToolSet
不包含 `mcp:dynamic_tool`；dynamic MCP 仍由 Model Controller/Tool Pipeline 按 binding、descriptor、schema、
availability 与其自身 revision 验证。该双路线是两个明确的 catalog contract，不是第二份 Builtin schema authority。

MCP Resources 不进入 `tool_search`、session-loaded Tool set 或 turn-scoped binding。`list_mcp_resources` 与
`read_mcp_resource` 是由 Builtin module 唯一执行的稳定内置只读工具：前者从 Runtime Resource Directory 枚举静态
URI，后者只读取当前 discovery snapshot 中存在的 URI。Resource discovery 与 Tool progressive disclosure 保持独立。

三类 MCP 暴露概念必须正交：Provider != Tool != Resource。任何一个为空不自动推出另外两个为空。

Disclosure/search 仍只表示发现，不表示 release admission。Phase 5 profile 即使列出 capability，也必须
重新验证实际 feature flags、dependency revision、embedded ceiling、route/platform allowlist 和实际
G3/G4/G5 freshness；unknown/stale/failed 全部 blocked。当前 MCP write 与 Skills production route/
profile 均为空或 off。

V2 不再按 Runtime phase 裁剪已经发现并绑定的动态 MCP：同一 binding/revision 在 Planning 与 Building 保持相同模型声明，避免 phase 切换破坏工具前缀缓存。Planning 调用仍由 Tool Controller 读取 binding 的 effective effects：全部为 `none/read` 才可执行；任何 `write`、`destructive`、`unknown` 或缺失可信 policy 的能力都以 phase constraint 拒绝且不进入审批/Provider dispatch。Catalog、binding revision、execution surface 与 feature flags 变化仍会重建披露，这是 capability freshness，不是 phase 授权。

不兼容 Runtime format 不进入 Capability disclosure：未知 source 在会话发现阶段静默忽略；已知历史会话必须先经
ADR-0138 迁移为 current State 并清空旧 binding/invocation。current snapshot 的 schema/epoch 不精确匹配时，Kernel
仍在模型表面和 Provider 调用生成前使该会话失败。当前 Runtime 不为旧 Plan 建立 recovery-only capability surface。
> 路径同步：能力运行时引用当前无版本命名的 state/store 路径；不引入兼容 alias。
