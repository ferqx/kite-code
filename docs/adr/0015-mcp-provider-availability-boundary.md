# ADR-0015：MCP Provider 可用性事实跨越 Supervisor 边界

状态：accepted
日期：2026-07-17
决策者：@chenchao
相关：ADR-0007、ADR-0010、ADR-0012、ADR-0014

## 背景

Runtime 已通过 `McpRuntimeProvider` 与具体 `McpManager` 类型解耦，但 Supervisor 过去把 Manager 本身作为 provider 返回。Manager 只知道已创建的连接，无法表达 pending approval、rejected、disabled、login required 或配置 quarantine。结果是 Agent 只能把这些 Provider 当作“不存在”，调用失败也只能依赖错误文本分类。

## 决策

`DefaultMcpSupervisor` 自身实现 Runtime-facing `McpRuntimeProvider`，同时继续把 transport、SDK discovery 与真实调用委托给唯一 `McpManager`。Provider contract 增加不可变 `McpProviderDirectorySnapshot`；directory 只包含 effective Provider 的稳定名称、归一化状态、required/source、有限 diagnostic code、retryable 和安全截断的 last-known Tool 名称。

Directory 不包含 URL、command、header、credential material、raw error、Tool description、schema、capability ID 或 executable handle。首次 discovery 前不虚构 Tool 名称；已经成功 discovery 的名称可在同一 effective Provider 暂时不可用时保留，Provider 被移除或 Supervisor stop 后清除。

Manager/Supervisor 通过 `McpProviderError` 抛出 `provider_auth_required`、`provider_approval_required`、`provider_unavailable` 或 `provider_capability_changed`。Tool Controller 直接映射 typed failure，不用错误字符串正则决定恢复语义。

开启既有 `capabilitySearchV1` 时，只要 directory 中存在不可用 Provider，模型可以获得 `capability_search`。匹配 provider name 或 last-known Tool name 的公共结果只返回 provider 名称、状态、有限 diagnostic code 和固定 next action；它不产生 disclosure、binding、approval 或调用重放。

本 ADR 只决定阶段 5 的可用性事实边界。Provider Action Runtime interaction、feature flag 和 required admission/waiver 仍须在后续切片以独立 ADR 决定。ADR-0012 保持有效，不能借此恢复 `/mcp` 管理路由。

## 备选方案

- 继续让 Runtime 直接持有 Manager：无法看到 transport 创建前的配置与认证门禁。
- 把完整 control snapshot 交给 Runtime：会扩大 Runtime 对 App/control-plane 字段的依赖，并暴露无关配置细节。
- 在 Tool Controller 正则匹配错误消息：Provider/SDK 文案变化会改变安全与恢复行为。
- 为 unavailable Provider 生成伪 descriptor：可能被误当成可绑定能力，违反 discovery 与授权分离。

## 影响

Agent 可以区分能力不存在与 Provider 暂不可用，同时 unavailable 结果仍不可执行。Supervisor 成为 Runtime provider façade，但 Manager 仍是唯一 SDK client 与调用路径。旧 binding 在 Provider/auth/catalog 变化后继续 fail closed；typed failure 只改善事实分类，不自动重试或恢复旧调用。

## 回滚

可以移除公共 unavailable 搜索摘要，但不得恢复 raw error 字符串分类、为未 discovery 能力伪造 binding、向 Runtime 暴露 secret/transport 细节，或建立第二条 MCP client 路径。
