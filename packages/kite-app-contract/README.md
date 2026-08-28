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

所有 request/response 和嵌套对象都拒绝未知字段、缺失的必需字段、错误类型和越界值。明确声明的向后兼容可选字段
在decode时投影为当前安全默认值。mutation
response 可以表达 `outcome_unknown`；client 必须先查询当前状态，再由用户决定是否重试，contract
本身不定义自动重放。

## 不拥有职责

- 不包含 Node/Bun I/O、文件、网络、进程、listener、descriptor 或 lifecycle；
- 不包含 raw API key、OAuth/credential material、service PID、credential-bearing service endpoint、build/process identity；
- 不包含 Runtime Host/Server/Store/SQLite、Manager、callback、AbortController 或动态 method；
- 不包含 React、Ink、TUI reducer、Desktop IPC、Browser transport 或 future-only adapter。

MCP snapshot 只允许回传用于终端展示的 source path、transport/config 状态、CAS revision、已发现的
tool/prompt 摘要和经过 origin-only 脱敏的 HTTP(S) 地址；不得回传 raw command/address、query、fragment、
用户名、密码、API key 或其他 credential material。MCP add action 的 `value` 只表示用户当前输入的
bounded command/address；Service 不得在 snapshot 中回传它。认证、credential write、service
discovery/lifecycle 使用 Native-only owner 的 contract。

Workspace Trust query/decision先返回 canonical full identity、exact external-read scope及revision；TUI必须显示
Workspace外的canonical只读roots，decision用scope digest与revision双重绑定。mutation按exact CAS执行，conflict或
`outcome_unknown` 原样返回且不自动重试。Provider/model、Skill和MCP projection只包含当前终端 journey所需
safe metadata；actual Skill body/path、raw Provider config/API key、MCP command arguments、credential、OAuth URL和
raw diagnostic message不进入 contract。Native Provider credential write及其取消 signal只存在于
`kite-local-runtime/client`。

当前根contract revision保持`kite-app-contract-v1`。Workspace Trust external-read scope是同一v1 route的向后兼容
可选扩展：当前Service始终发送scope，decoder对缺少scope的旧响应投影empty scope；它不会联动Local Runtime handshake、
manager lifecycle或整个App Contract不兼容。scope/revision不匹配由query刷新后重新授权收敛。

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
