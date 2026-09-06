# Web 会话展示

产品说明：[History](../../../docs/handbook/clients/web/guides/conversation.md)。入口：[reducer](../src/presentation/reducer.ts)、[merge messages](../src/presentation/merge-messages.ts)、[message list](../src/components/timeline/message-list.tsx)。

History tool.lifecycle 按 tool_call_id 折叠为稳定项；queued/started 更新当前态，terminal 替换前态。缺失新 label 时沿用同次调用已知名称，不能在 terminal 后残留 loading 卡。

rejected 是 pre-dispatch 结果，独立显示脱敏原因，不渲染不存在的 exit code 或 No output，不与 failed 混同。缺少原始内部字段时不绕过 API 从 Store 补数据。

Web 不重现 TUI Static、Thought 聚合与 scrollback。共享结果含义，布局和更新方式由 Web owner 决定。loading/empty/error/selected 保持可读文字，不以颜色作为唯一状态表达。

验证：[presentation reducer](../test/presentation-reducer.test.ts)、[sidebar](../test/session-sidebar.test.tsx)。视觉规则见[设计系统](ui-design-system.md)。

## 当前差异：取消与未知状态丢失

[transport.runStatus](../src/transport/client.ts) 将 Run 的 failed、cancelled、unknown 都投影为 failed；工具取消也被降为 ok=false 的 tool_result，[message list](../src/components/timeline/message-list.tsx) 只按 ok 显示 completed/failed。当前 Web 无法完整表达 Public contract 中的取消与未知结果；不能将该投影作为已知失败、可安全重试的证据。

修复需在本地 presentation 保留明确终态，并为 cancelled/unknown 添加 transport与组件断言。现有 [transport tests](../test/transport.test.ts) 的 completed/running/rejected 覆盖不足以证明全部终态语义。
