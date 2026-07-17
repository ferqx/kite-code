# 第十一章 MCP 与 Skill Workflow

MCP 和 Skill 都属于 Capability，不拥有独立于 Runtime 的授权或完成通道。

## 11.1 MCP Provider

`McpSupervisor` 组合 source-aware `McpConfigRepository`、项目审批门禁和唯一 `McpManager`。它在后台连接前发布不可变 `McpControlSnapshot`，串行处理 reload/mutation/retry，并把 health、list-changed 和 typed diagnostic 投影给 App。`McpManager` 使用 `@modelcontextprotocol/sdk` 管理 stdio 与 streamable HTTP 连接，负责 tools/resources/prompts discovery、circuit breaker、调用与资源读取。

每个 Manager 连接携带 generation。reconnect/disable/remove 的失效顺序是先撤销未来 capability 可见性，再关闭旧 client；迟到的旧 generation 结果不得更新状态。Runtime 只依赖 `McpRuntimeProvider`，TUI 只依赖 App controller/control snapshot。

Manager 保留完整原始 discovery，`CapabilitySnapshot` 只包含 enabled 且 schema-valid 的 Tool。可见性按 allowlist、denylist、精确 override 解析。MCP Tool 的稳定身份为 `mcp:<server>/<tool>`；`mcp__<server>__<tool>` 只是某一模型轮次的暴露名称。filter 或 policy 变化都会产生新 descriptor/catalog revision。

## 11.2 安全与执行

远端 description 和 annotation 不可信。Control snapshot 可以同时记录 declared 与 effective effects，但只有显式本地 trust 配置可让 read-only hint 参与 effective 分类，而且不能降低本地 `minimumApproval`。无效 schema、disabled Tool 和配置引用但未 discovery 的 Tool 可诊断但不可绑定或执行。

项目配置在 discovery 之前还有独立的 transport 门禁。workspace legacy `.kite-code` 和 current `.mcp.json` 声明只有匹配本地 config digest 批准后才进入 `McpManager`；配置变化、拒绝或 Approval Store 异常均 fail closed。local、legacy project、project、user 的有效优先级固定；legacy 只能显式迁移。此批准不产生 annotation trust。项目 Tool 可以用 allowlist、denylist 或精确 disable 收紧可见性，但精确 enable、effect/minimum-approval 降级和 retry 放宽被忽略，保守基线仍是 unknown/user/never。

MCP 调用保留 structured content、content blocks、错误、资源和外部引用；`_meta` 不持久化。外部写入先记录 invocation intent，并根据 `never`、effective read 对应的 `safe_read` 或可信 idempotency key 决定重试边界。

## 11.3 Health 与恢复

Server 状态覆盖 connecting、discovering、ready、degraded、half-open/circuit-open 和断开等运行阶段。Catalog 或 capability revision 变化使旧 binding 失效。崩溃后的非终态写入进入 reconciliation，不自动重复创建外部对象。

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

当 catalog 超出 provider 上下文预算时，模型只看到 provider-neutral `capability_search`。搜索返回安全元数据候选，不返回调用句柄；下一轮重新校验 catalog/revision 后才签发有限 binding 或 Skill disclosure。

完整规则见 [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)、[`../active/mcp-control-plane.md`](../active/mcp-control-plane.md)、[`../active/mcp-authentication.md`](../active/mcp-authentication.md) 与 [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)。
