# Agent Note: 开发期 Web 显式网络策略

Status: implemented

## Problem

2026-09-30 最新工具自测会话 `131364d4-4bcf-4d7f-a93f-9fe8d20dac05` 的两次 `web_fetch` 在审批后均返回缺少显式网络边界。普通配置加载不提供封存 `ExecutionBoundary`，Service 原路由只从该字段派生网络机制，导致公开网站抓取无法执行。

## Decision

Service 仅为无封存边界、无 production 标记的普通配置，在工具授权之后显式构造开发期 `public` 网络机制策略。它允许公开 DNS 主机和跨主机跳转，复用 Builtin 对实际地址、连接 pinning、逐跳准入和 socket 前持久决定的检查。封存配置仍优先使用原 `off`／`allowlist`；缺配置、production 缺边界和缺持久记录端口继续拒绝。

`public` 只扩展机制策略，不进入封存 `ExecutionBoundary`，不改 Shell 或 MCP 的封存权限。当前完整规则由[执行边界](../../../../docs/active/execution-boundary.md#network-projection-and-durable-admission)与[Service composition](../../../../apps/kite-service/docs/composition-and-execution.md)负责。

## Alternatives considered

- 用初始 URL 主机生成临时 allowlist：会拒绝有效的跨主机跳转，不能恢复普通开发配置的公开网站抓取行为。
- 为普通配置制造 production `ExecutionBoundary`：会混淆开发期调用策略与 release 封存 authority，且当前封存支持集不能作为开发功能准入。
- 缺边界时直接使用裸 fetch：绕过逐调用持久准入和地址 pinning，不能满足已有网络机制契约。

## Consequences

主、子会话共用 Service 工具路由，均能取得准确的开发期策略。新增[回归测试](../../../../apps/kite-service/test/runtime/web-development-boundary.test.ts)核对公开跨主机跳转、持久决定先于请求、私有地址拒绝、记录失败不派发，以及封存策略优先和缺 authority 拒绝。公开网络实际可达性仍取决于 DNS、远端服务器和宿主网络；测试中的模拟 transport 不证明这些外部条件。
