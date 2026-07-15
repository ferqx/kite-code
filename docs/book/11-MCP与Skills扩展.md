# 第十一章 MCP 与 Skill Workflow

MCP 和 Skill 都属于 Capability，不拥有独立于 Runtime 的授权或完成通道。

## 11.1 MCP Provider

`McpSupervisor` 组合 source-aware config catalog、项目审批门禁和唯一 `McpManager`。它在后台连接前发布不可变 `McpControlSnapshot`，并把 health、list-changed、retry 和 typed diagnostic 投影给 App。`McpManager` 使用 `@modelcontextprotocol/sdk` 管理 stdio 与 streamable HTTP 连接，负责 tools/resources/prompts discovery、circuit breaker、调用与资源读取。

每个 Manager 连接携带 generation。reconnect/disable/remove 的失效顺序是先撤销未来 capability 可见性，再关闭旧 client；迟到的旧 generation 结果不得更新状态。Runtime 只依赖 `McpRuntimeProvider`，TUI 只依赖 App controller/control snapshot。

Discovery 生成不可变 `CapabilitySnapshot`。MCP Tool 的稳定身份为 `mcp:<server>/<tool>`；`mcp__<server>__<tool>` 只是某一模型轮次的暴露名称。

## 11.2 安全与执行

远端 description 和 annotation 不可信。只有显式本地 trust 配置可让 read-only hint 参与分类，而且不能降低本地 `minimumApproval`。无效 schema 的能力可诊断但不可绑定或执行。

项目配置在 discovery 之前还有独立的 transport 门禁。workspace `.kite-code` 和 `.mcp.json` 声明只有匹配本地 config digest 批准后才进入 `McpManager`；配置变化、拒绝或 Approval Store 异常均 fail closed。此批准不产生 annotation trust。项目 Tool 的 effect、minimum approval 和 retry override 被忽略，保持 unknown/user/never 的保守策略。

MCP 调用保留 structured content、content blocks、错误、资源和外部引用；`_meta` 不持久化。外部写入先记录 invocation intent，并根据 `never`、`safe_read` 或可信 idempotency key 决定重试边界。

## 11.3 Health 与恢复

Server 状态覆盖 connecting、discovering、ready、degraded、half-open/circuit-open 和断开等运行阶段。Catalog 或 capability revision 变化使旧 binding 失效。崩溃后的非终态写入进入 reconciliation，不自动重复创建外部对象。

`/mcp` 管理中心可响应式浏览全部 Server 和 discovered capability；`/mcp <server>` 打开详情，`/mcp retry <server>` 重新经过 config/approval gate。Phase 1 不提供普通配置 mutation。

## 11.4 Skill Workflow

Kite Skill 是严格 YAML frontmatter 加正文/资源组成的版本化 Workflow Contract，而不是普通 Prompt 片段。编译结果声明：

- input/output schema；
- invocation 方式；
- context mode；
- capability ceiling；
- effects 与 approval 要求；
- verification 与 recovery。

激活产生 Runtime `SkillActivation`/frame。Inline Skill 在当前上下文执行；fork Skill 在隔离 Subagent 中执行。Skill 只能调用 ceiling 内、仍通过 Runtime Policy 的能力。

Supporting `scripts/`、`references/`、`assets/`、`evals/` 不会整体注入模型。活动 frame 只能通过 `read_skill_reference` 读取声明过、路径安全且大小受限的文件。

## 11.5 Progressive disclosure

当 catalog 超出 provider 上下文预算时，模型只看到 provider-neutral `capability_search`。搜索返回安全元数据候选，不返回调用句柄；下一轮重新校验 catalog/revision 后才签发有限 binding 或 Skill disclosure。

完整规则见 [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)、[`../active/mcp-control-plane.md`](../active/mcp-control-plane.md) 与 [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)。
