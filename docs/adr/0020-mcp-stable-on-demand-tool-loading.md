# ADR-0020：MCP 工具使用稳定目录与会话级按需加载

状态：accepted
日期：2026-07-18
补充：ADR-0007、ADR-0010、ADR-0015

## 决策

MCP Tool contract 与瞬时 transport health 分离。成功 discovery 后，Runtime catalog 保留最后一个 revisioned descriptor，直到配置删除、禁用、可见性变化或成功的 `list_changed` 改变契约。connecting、degraded 和 failed 只改变 Provider Directory，不改变 Tool identity。

`capabilitySearchV1` 开启时，MCP Schema 默认全部延迟加载。模型初始只收到安全的 Provider/Tool 名称摘要与 `capability_search`；搜索命中的 MCP Tool 进入持久化的 session-loaded set。后续每次模型调用仍基于当前 descriptor 为这些 Tool 签发新的 turn-scoped binding。

执行前必须重新检查 Provider health、descriptor revision、Schema、Policy 和 Approval。HTTP Provider 可在 30 秒调用预算内有限重连；STDIO 只允许显式 Retry。连接恢复不得重放已经失败的 Tool Call。

## 理由

把短暂连接状态编码进模型工具集合会造成声明抖动、Prompt Cache 前缀变化和重复搜索。稳定目录保持模型上下文与缓存身份稳定，而逐轮 binding 和执行前校验继续提供 fail-closed 安全边界。

## 后果

- Runtime state schema 13 持久化 session-loaded capability。
- 首次 discovery 失败时不虚构 Tool。
- Schema、策略、删除或禁用仍使旧 binding 失效。
- Provider-neutral `capability_search` 保持跨模型兼容，不依赖 Anthropic `tool_reference`。
