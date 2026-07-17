# 第十一章 MCP 与 Skill Workflow

MCP 和 Skill 都属于 Capability，不拥有独立于 Runtime 的授权或完成通道。

## 11.1 MCP Provider

`McpSupervisor` 组合 source-aware `McpConfigRepository`、项目审批门禁和唯一 `McpManager`。它在后台连接前发布不可变 `McpControlSnapshot`，串行处理 reload/mutation/retry，并把 health、list-changed 和 typed diagnostic 投影给 App。它同时作为 Runtime-facing provider façade 提供 capability snapshot 和脱敏 provider directory，真实 SDK discovery/call/resource 仍只委托给 `McpManager`。

每个 Manager 连接携带 generation。reconnect/disable/remove 的失效顺序是先撤销未来 capability 可见性，再关闭旧 client；迟到的旧 generation 结果不得更新状态。Runtime 只依赖 `McpRuntimeProvider`，TUI 只依赖 App controller/control snapshot。

Manager 保留完整原始 discovery，`CapabilitySnapshot` 只包含 enabled 且 schema-valid 的 Tool。可见性按 allowlist、denylist、精确 override 解析。MCP Tool 的稳定身份为 `mcp:<server>/<tool>`；`mcp__<server>__<tool>` 只是某一模型轮次的暴露名称。filter 或 policy 变化都会产生新 descriptor/catalog revision。

## 11.2 安全与执行

远端 description 和 annotation 不可信。Control snapshot 可以同时记录 declared 与 effective effects，但只有显式本地 trust 配置可让 read-only hint 参与 effective 分类，而且不能降低本地 `minimumApproval`。无效 schema、disabled Tool 和配置引用但未 discovery 的 Tool 可诊断但不可绑定或执行。

项目配置在 discovery 之前还有独立的 transport 门禁。workspace legacy `.kite-code` 和 current `.mcp.json` 声明只有匹配本地 config digest 批准后才进入 `McpManager`；配置变化、拒绝或 Approval Store 异常均 fail closed。local、legacy project、project、user 的有效优先级固定；legacy 只能显式迁移。此批准不产生 annotation trust。项目 Tool 可以用 allowlist、denylist 或精确 disable 收紧可见性，但精确 enable、effect/minimum-approval 降级和 retry 放宽被忽略，保守基线仍是 unknown/user/never。

MCP 调用保留 structured content、content blocks、错误、资源和外部引用；`_meta` 不持久化。外部写入先记录 invocation intent，并根据 `never`、effective read 对应的 `safe_read` 或可信 idempotency key 决定重试边界。

## 11.3 Health 与恢复

Server 状态覆盖 connecting、discovering、ready、degraded、half-open/circuit-open 和断开等运行阶段。Catalog 或 capability revision 变化使旧 binding 失效。崩溃后的非终态写入进入 reconciliation，不自动重复创建外部对象。

Provider directory 让 Agent 区分不存在、等待项目批准、被拒绝、disabled、需要登录、连接中、失败和 quarantine。调用边界使用 typed provider failure，不从 SDK 错误字符串猜测恢复策略。Directory 和公共搜索摘要不包含 URL、command、secret、raw error、schema、capability ID 或调用句柄。

默认关闭的 `mcpProviderActionV1` 把可恢复 failure 转成独立 Runtime 交互：原 Tool Call 先终结，随后才请求 App shell 执行 login、approve 或 retry。Runtime 只保存固定动作与结果码，不保存旧参数、binding、approval 或认证材料。成功恢复后必须进入新 turn 再从当前 catalog 签发 binding；defer/failure 不会重放旧调用。TUI 使用既有 foreground/background interrupt surface 收集决定，并由 App controller 复用 Supervisor 的 login、project approval 与 retry。

同一 flag 让 `required` 获得任务准入语义。新 Agent run 在模型执行前接受 ready/degraded，其他 required Provider 进入稳定排序的持久 gate。Retry 由 App shell 执行；用户可以为当前 session 记录 waiver，或取消 run。Waiver 包含 provider/source/固定 reason/time，但不使任何 Tool 可见或可调用。

`/mcp` 只读面板响应式显示 effective Server 的连接状态与名称，不浏览 capability，也不执行配置、retry 或 reload。配置来源由文件路径决定，变更通过 watcher 与 Supervisor reconcile 生效；项目来源的摘要决定由 App shell 独立信任提示完成。changed/removed/disabled 仍先撤销未来 capability，provider version 变化使旧 binding fail closed，未变化连接继续保留。

## 11.4 MCP 凭据与 OAuth

HTTP 静态认证在配置中只保存环境变量名或 credential profile。生产 `McpCredentialStore` 使用原生 OS vault，不存在 JSON、加密文件或 keychain CLI fallback。Supervisor 在连接时附加 workspace/source/Server/profile 身份；Manager 只在 transport 构造期间把 secret 解析为 header。inline client secret 被拒绝，client secret 也必须通过独立 profile 引用。

HTTP 401 与 connection health 分开投影为 `login_required`。后台连接不打开浏览器；App shell 独立认证提示收到用户显式 Login 后，Coordinator 才绑定 127.0.0.1 随机端口并驱动 SDK discovery、dynamic registration、PKCE 和 state-bound callback。成功 code exchange 后 Manager 创建新连接并重新 discovery；已有 token 可在重启时静默恢复。callback timeout/cancel 关闭 listener，refresh 失败进入 `reauth_required`，任何恢复都不自动重放旧 Tool Call。

ADR-0012 仍然有效：`/mcp` 不承担 Login/Logout 或 auth 详情。认证提示只解决真实连接阻塞，不成为第二套配置管理中心。

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

当 catalog 超出 provider 上下文预算时，模型只看到 provider-neutral `capability_search`。搜索返回安全元数据候选，不返回调用句柄；下一轮重新校验 catalog/revision 后才签发有限 binding 或 Skill disclosure。Directory 中存在 unavailable Provider 时，小 catalog 也可同时暴露搜索；命中 provider/last-known Tool 只返回 bounded 状态与下一步，不产生 binding。

完整规则见 [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)、[`../active/mcp-control-plane.md`](../active/mcp-control-plane.md)、[`../active/mcp-authentication.md`](../active/mcp-authentication.md) 与 [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)。
