# Browser 请求与错误处理

入口：[AgentApiBrowserClient](../src/index.ts)。唯一 workspace 依赖是 agent-api-contract，fetch 可注入；不持有 Native bearer、Store 或 Service concrete type。

getServerInfo 检查服务信息，目录/会话列表使用 cursor 与 limit，History/logs 可带 afterSequence，Model Context 绑定 exact Session 与 invocation。AbortSignal 控制请求生命周期，但中断本地等待不应被解释成服务端业务取消。

每个响应通过对应 schema 解码。HTTP 非成功返回 AgentApiClientError 与允许的 problem，不把失败变成空列表。客户端提供读取原语，不拥有 Web 的两秒更新 scheduler，也不维护另一套持久状态。

revokeBrowser 只结束浏览器访问会话，不关闭产品 Session 或 daemon。Web route unmount 与 document pagehide 的调用时机由 Web adapter 负责。

验证：[client tests](../test/client.test.ts)。页面策略见[Web 数据更新](../../../apps/kite-web/docs/data-and-updates.md)。
