# Web 会话展示

产品说明：[History](../../../docs/handbook/clients/web/guides/conversation.md)。入口：[reducer](../src/presentation/reducer.ts)、[merge messages](../src/presentation/merge-messages.ts)、[共享页面投影](../src/presentation/page.ts)。

History tool.lifecycle 按 tool_call_id 折叠为稳定项；queued/started 更新当前态，terminal 替换前态。缺失新 label 时沿用同次调用已知名称，不能在 terminal 后残留 loading 卡。

rejected 是 pre-dispatch 结果，独立显示脱敏原因，不渲染不存在的 exit code 或 No output，不与 failed 混同。缺少原始内部字段时不绕过 API 从 Store 补数据。

Web 不重现 TUI Static、Thought 聚合与 scrollback。共享结果含义，主页面、侧栏和消息渲染与桌面端共用 [kite-client-ui](../../../packages/kite-client-ui/README.md)，REST 更新方式仍由 Web owner 负责。loading/empty/error/selected 保持可读文字，不以颜色作为唯一状态表达。

验证：[presentation reducer](../test/presentation-reducer.test.ts)、[共享目录与阅读回归](../../../packages/kite-client-ui/test/reading.test.tsx)。视觉规则见[设计系统](ui-design-system.md)。

按轮复制由共享 Conversation 根据正文与 settled 状态提供；剪贴板操作仅复制页面已有文本，不增加 Runtime 写权限。流式助手正文下显示“正在回复”，落定后移除。

## 当前差异：取消与未知状态丢失

[transport.runStatus](../src/transport/client.ts) 将 Run 的 failed、cancelled、unknown 都投影为 failed；工具取消也被降为 ok=false 的 tool_result，[共享页面投影](../src/presentation/page.ts) 仍只按 ok 映射 completed/failed。当前 Web 无法完整表达 Public contract 中的取消与未知结果；不能将该投影作为已知失败、可安全重试的证据。

修复需在本地 presentation 保留明确终态，并为 cancelled/unknown 添加 transport与组件断言。现有 [transport tests](../test/transport.test.ts) 的 completed/running/rejected 覆盖不足以证明全部终态语义。


共享页面采用点击直接加载消息、消息折叠和阅读位置恢复。Web 入口仅提供只读导航与诊断；不提供 Composer、审批、停止、新建、配置或本地文件打开回调。助手 Markdown 的相对文件链接只显示文字，HTTP(S) 链接仍可打开；消息 HTML 不执行，图片不自动请求。数据转换不补造 Public API 未提供的路径、工具名或父子关系。[页面投影回归](../test/page-presentation.test.ts)核对原始可展示内容和终态保留；[页面生命周期](../test/app-lifecycle.test.tsx)核对只读操作缺席与点击直接导航。

共享页面可渲染明确工具类型的探索摘要与已确认文件记录；当前 Public History 只有安全 label／summary，Web 不推导工具身份、路径或文件变更，因此保持独立工具记录且不提供文件副层。MCP／Skills 设置属于 Native App Control，Browser 权限不变。
