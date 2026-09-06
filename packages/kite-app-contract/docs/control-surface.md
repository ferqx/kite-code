# App Control 契约

入口：[公共导出](../src/index.ts)。此包描述本机应用控制面，供 Service 与 Native client 使用；不是 Browser 业务 API，也不拥有配置和凭据存储。

工作区信任、配置、Provider/model、MCP 等操作使用明确 request/response，校验 expected revision 和真实 target。客户端只提交意图，Service 决定配置和准入结果；确认界面不能直接修改 Repository。

App Control 可在 Runtime initialize 前提供受限操作，但这不等于已取得执行权。新增字段时同时修改 schema/codec、Service handler、Native client 和相关测试，不能让实现对象的新增成员自动暴露。

消费者入口：[Service App Control](../../../apps/kite-service/src/app-control/)、[Native adapter](../../kite-local-runtime/src/client/protocol-app-control.ts)。验证：[contract tests](../test/)。
