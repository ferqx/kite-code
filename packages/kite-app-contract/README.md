# Kite App Contract

## 定位

`@kite-ai/kite-app-contract` 是 Kite 当前 CLI/TUI 与 Local Runtime Service
之间的 browser-safe、仓库私有 App Control contract。它只携带已经投影且不含 secret
的 exact DTO，不是公共 SDK、通用 RPC、插件协议或 UI component contract。

## 拥有职责

- Workspace Trust query/decision；
- Provider/model snapshot 与 model selection；
- MCP safe snapshot 与当前管理动作；
- admitted Workspace 的 Skill catalog/status；
- authoritative execution/release status；
- 每个当前 route 独立的 strict JSON codec。

所有 request/response 和嵌套对象都拒绝未知字段、缺失字段、错误类型和越界值。mutation
response 可以表达 `outcome_unknown`；client 必须先查询当前状态，再由用户决定是否重试，contract
本身不定义自动重放。

## 不拥有职责

- 不包含 Node/Bun I/O、文件、网络、进程、listener、descriptor 或 lifecycle；
- 不包含 raw API key、OAuth/credential material、service PID、service endpoint、build/process identity；
- 不包含 Runtime Host/Server/Store/SQLite、Manager、callback、AbortController 或动态 method；
- 不包含 React、Ink、TUI reducer、Desktop IPC、Browser transport 或 future-only adapter。

MCP add action 的 `value` 只表示用户当前输入的 bounded command/address；Service 不得在 snapshot
中回传它。认证、credential write、service discovery/lifecycle 使用 Native-only owner 的 contract。

## 公开入口

只导出 `src/index.ts`。根出口导出各 exact DTO、codec 和 closed `KiteAppControlClient` method
surface；没有 generic `call(method, payload)`。

## 依赖与验证

唯一 workspace dependency 是 `@kite-ai/runtime-contract`。此 package 的 build target 是 browser：

```text
bun run build
bun run typecheck
bun run test
```

跨包行为变化时同步更新对应 Runtime/Service current authority；此 package 本身不决定 Service
listener、History transport 或 Runtime Protocol。
