# 第十一章 MCP 与 Skill Workflow

MCP 和 Skill 都属于 Capability，不拥有独立于 Runtime 的授权或完成通道。

## 11.1 MCP Provider

`McpSupervisor` 组合 source-aware `McpConfigRepository`、项目审批门禁和唯一 `McpManager`。它在后台连接前发布不可变 `McpControlSnapshot`，串行处理 reload/mutation/retry，并把 health、list-changed 和 typed diagnostic 投影给 App。它同时作为 Runtime-facing provider façade 提供 capability snapshot 和脱敏 provider directory，真实 SDK discovery/call/resource 仍只委托给 `McpManager`。

每个 Manager 连接携带 generation。reconnect/disable/remove 的失效顺序是先撤销未来 capability 可见性，再关闭旧 client；迟到的旧 generation 结果不得更新状态。Runtime 只依赖 `McpRuntimeProvider`，TUI 只依赖 App controller/control snapshot。

Manager 保留完整原始 discovery，`CapabilitySnapshot` 只包含 enabled 且 schema-valid 的 Tool。可见性按 allowlist、denylist、精确 override 解析。MCP Tool 的稳定身份为 `mcp:<server>/<tool>`；`mcp__<server>__<tool>` 只是某一模型轮次的暴露名称。filter 或 policy 变化都会产生新 descriptor/catalog revision。

## 11.2 安全与执行

远端 description 和 annotation 不可信。Control snapshot 可以同时记录 declared 与 effective effects，但只有显式本地 trust 配置可让 read-only hint 参与 effective 分类，而且不能降低本地 `minimumApproval`。无效 schema、disabled Tool 和配置引用但未 discovery 的 Tool 可诊断但不可绑定或执行。

项目配置在 discovery 之前还有独立的 transport 门禁。规范 `<workspace>/.kite-code/mcp.json` 与只读 legacy project 声明只有匹配本地 config digest 批准后才进入 `McpManager`；配置变化、拒绝或 Approval Store 异常均 fail closed。默认优先级为 `project > user > legacy`，legacy 只能显式迁移。此批准不产生 annotation trust。项目 Tool 可以用 allowlist、denylist 或精确 disable 收紧可见性，但精确 enable、effect/minimum-approval 降级和 retry 放宽被忽略，保守基线仍是 unknown/user/never。

MCP 调用保留 structured content、content blocks、错误、资源和外部引用；`_meta` 不持久化。外部写入先记录 invocation intent，并根据 `never`、effective read 对应的 `safe_read` 或可信 idempotency key 决定重试边界。

MCP Tools 通过三个内置只读工具按意图使用：

- `list_mcp_tools` — 确定性盘点当前配置的 MCP Provider 和可执行 Tool。列出每个 Provider 的状态、next_action、可用 Tool 名称；支持 provider 过滤和分页。是回答"有哪些 MCP 工具/服务"的权威入口。
- `tool_search` — 按意图发现能完成特定动作的 Capability。使用简短动作查询（如 `create GitHub issue`），不用于全量枚举。
- `list_mcp_resources` / `read_mcp_resource` — 枚举和读取 Provider 暴露的静态资源 URI。

三个工具正交：Resource 为空不表示没有 MCP Tool，search 零匹配不表示 catalog 为空。

当配置携带 sealed production execution boundary 时，当前 Controller 会在任何 Provider
lookup/readiness 前拒绝上述 inventory/resource/search 和动态 MCP 调用；这用于在 Task 1B.8
完成逐 invocation transport admission 前保持 fail closed，不表示 MCP 已继承进程内
`web_fetch` 的 host allowlist。

## 11.3 Health 与恢复

Server 状态覆盖 connecting、discovering、ready、degraded、half-open/circuit-open 和断开等运行阶段。Catalog 或 capability revision 变化使旧 binding 失效。崩溃后的非终态写入进入 reconciliation，不自动重复创建外部对象。

Provider directory 让 Agent 区分不存在、等待项目批准、被拒绝、disabled、需要登录、连接中、失败和 quarantine。调用边界使用 typed provider failure，不从 SDK 错误字符串猜测恢复策略。Directory 和公共搜索摘要不包含 URL、command、secret、raw error、schema、capability ID 或调用句柄。

默认关闭的 `mcpProviderActionV1` 把可恢复 failure 转成独立 Runtime 交互：原 Tool Call 先终结，随后才请求 App shell 执行 login、approve 或 retry。Runtime 只保存固定动作与结果码，不保存旧参数、binding、approval 或认证材料。成功恢复后必须进入新 turn 再从当前 catalog 签发 binding；defer/failure 不会重放旧调用。TUI 使用既有 foreground/background interrupt surface 收集决定，并由 App controller 复用 Supervisor 的 login、project approval 与 retry。

同一 flag 让 `required` 获得任务准入语义。新 Agent run 在模型执行前接受 ready/degraded，其他 required Provider 进入稳定排序的持久 gate。Retry 由 App shell 执行；用户可以为当前 session 记录 waiver，或取消 run。Waiver 包含 provider/source/固定 reason/time，但不使任何 Tool 可见或可调用。

`/mcp` 使用 Select 驱动的 list/detail 管理 Overlay：列表只导航，详情只读展示安全投影，动态菜单可 retry/reconnect、认证、启停、移除和 review 项目摘要。最小 Add flow 只写 project/user 两个规范位置，配置变化仍通过 Repository 与 Supervisor reconcile 生效。changed/removed/disabled 先撤销未来 capability，provider version 变化使旧 binding fail closed，未变化连接继续保留。

## 11.4 MCP 凭据与 OAuth

HTTP 静态认证在配置中只保存环境变量名或 credential profile。生产 `McpCredentialStore` 使用原生 OS vault，不存在 JSON、加密文件或 keychain CLI fallback。Supervisor 在连接时附加 workspace/source/Server/profile 身份；Manager 只在 transport 构造期间把 secret 解析为 header。inline client secret 被拒绝，client secret 也必须通过独立 profile 引用。

HTTP 401 与 connection health 分开投影为 `login_required`。后台连接不打开浏览器；用户从 Server Detail 进入认证页并选择 Open browser 后，Coordinator 才绑定 127.0.0.1 随机端口并驱动 SDK discovery、dynamic registration、PKCE 和 state-bound callback。成功 code exchange 后 Manager 创建新连接并重新 discovery；已有 token 可在重启时静默恢复。callback timeout/cancel 关闭 listener，refresh 失败进入 `reauth_required`，任何恢复都不自动重放旧 Tool Call。

ADR-0018 替代 ADR-0012 的 UI 结论：`/mcp` 承担显式 Login 恢复，但不展示或编辑 credential material，也不提供 logout/revoke、多账号或 auth metadata 表单。

## 11.5 Skill Workflow

Kite Skill 是严格 YAML frontmatter 加正文/资源组成的版本化 Workflow Contract，而不是普通 Prompt 片段。编译结果声明：

- input/output schema；
- invocation 方式；
- context mode；
- capability ceiling；
- effects 与 approval 要求；
- verification 与 recovery。

激活产生 Runtime `SkillActivation`/frame。Inline Skill 在当前上下文执行；fork Skill 在隔离 Subagent 中执行。Skill 只能调用 ceiling 内、仍通过 Runtime Policy 的能力。

Supporting `scripts/`、`references/`、`assets/`、`evals/` 不会整体注入模型。活动 frame 只能通过 `read_skill_reference` 读取声明过、路径安全且大小受限的文件。

## 11.6 Progressive disclosure

启用 progressive disclosure 后，MCP Schema 默认全部延迟加载。模型初始通过 system prompt 中的固定 MCP Capability Usage 规则和 `list_mcp_tools`、`tool_search`、`list_mcp_resources` 三个内置工具发现 MCP 能力。搜索返回安全元数据候选，不返回调用句柄。命中的 Tool 进入会话 loaded set，后续轮次在 revision 匹配时持续获得新的 turn binding。短暂断线只改变 Provider Health，不改变 Tool contract；HTTP 在执行时有限重连，STDIO 等待显式 Retry。

`list_mcp_tools` 是确定性的盘点工具：列出每个 Provider 的状态（ready/degraded/login_required/pending_approval/disabled/failed 等）、next_action 和可用 Tool 名称。这解决了之前模型把 `list_mcp_resources` 返回空列表误判为”没有 MCP Server”的问题。

`tool_search` 的具体业务 query 使用相关性召回。包含”有哪些 MCP 工具”等清单意图的中英文查询会被重定向到 `list_mcp_tools`，避免把搜索零匹配误解为空 catalog。

Resource discovery 与 Tool discovery 分离：需要盘点 Provider 和 Tool 时用 `list_mcp_tools`，需要可执行能力时用 `tool_search`，需要 MCP 内容 URI 时用 `list_mcp_resources` / `read_mcp_resource`。三类 MCP 概念（Provider、Tool、Resource）正交：任何一个为空不自动推出另外两个为空。当前不支持 `@resource` 输入补全和 Resource Templates。

Remote HTTP MCP Tool 还有独立内容外发门禁。最终参数非空时，Runtime 使用脱敏 route identity
和规范化参数 digest 请求 `RemoteMcpEgressPermitV1`；许可与 Tool Approval、模型 Provider
consent、read-only annotation 和 network allowlist 正交。每个并发 invocation 使用独立 nonce，
Manager 在 SDK 调用前校验进程内 ledger，Runtime Store 再把 nonce digest 与无正文 receipt
同事务唯一持久化，重启或并行进程 replay 均在零请求处拒绝并保存 `permit_replayed`。最终参数还会
在 ToolController 和 Manager 两处执行有界 secret 检查；credential 字段/形状、受保护路径以及
无法完成检查的输入都不能通过 permit 外发。边界在任何异步授权前创建 immutable JSON-safe 深
快照，schema、检查、digest 和最终 SDK request 使用同一份内容，禁止 accessor/custom serializer
造成签署后变更。permit 最长五分钟；空参数 HTTP Tool 和 local stdio 不消费该 permit；Tool
Search/discovery 只处理元数据，也不会触发正文许可。

完整规则见 [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)、[`../active/mcp-control-plane.md`](../active/mcp-control-plane.md)、[`../active/mcp-authentication.md`](../active/mcp-authentication.md) 与 [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)。
