# ADR-0082：Windows development Shell 采用逐调用网络授权语义

状态：accepted

日期：2026-08-06

相关：ADR-0043、ADR-0054、ADR-0061、ADR-0072、ADR-0081

## 背景

macOS Seatbelt 与 Linux bubblewrap development executor 都消费 Shell Tool Policy 产生的逐调用
`disabled | allow_all` 网络模式：可证明为本地的命令在 network-off 形态运行，明确网络命令和无法证明
local-only 的脚本先取得用户授权，再以 `allow_all` 执行。

ADR-0081 引入的 Windows `windows_restricted_token` adapter 却拒绝所有 `allow_all` 请求。上层将
`node script.js`、`npm run build` 等任意代码保守分类为 uncertain effect 并在批准后投影为
`allow_all`，因此批准成功仍会在 native runner 启动前失败。`node --version` 与 `npm --version`
也因没有精确只读分类而进入同一路径。这破坏了三平台 development Shell 的用户权限语义。

restricted current-user token 没有结构性 network-off enforcement。解决交互语义不等于产生
production network evidence，也不能改写 ADR-0081 对 lower-assurance backend 的结论。

## 决策

1. Development Shell 使用统一的逐调用权限语义：精确、可证明本地的命令使用 `disabled`；明确网络
   命令及 uncertain script 必须先获得现有 Tool approval，批准后使用 `allow_all`；拒绝时不执行命令。
2. `node|npm|pnpm|yarn|bun` 的精确 `--version`/`-v` 形态属于本地只读命令。附加脚本、参数或复合
   代码不继承该分类。
3. Windows restricted-token native protocol 升至 V3，并显式接受 `off | allow_all`。`allow_all` 只表示
   trusted adapter 已取得该 invocation 的开发期网络授权；它不是 network-off、allowlist 或 production
   isolation evidence。
4. restricted-token 继续拒绝 host allowlist broker。实验性 AppContainer 保持 zero direct-network
   capability，只接受 `off`；其 `kite-http` broker 规则不变。
5. Windows verified POSIX runtime 为裸 `npm`、`npx`、`pnpm`、`pnpx`、`yarn`、`yarnpkg` 与
   `corepack` 提供固定函数转发到对应 `.cmd` shim，避免命中 Windows 无法执行的 extensionless Unix
   shim。审批、日志和 receipt 仍记录原始用户命令。
6. `windows_restricted_token` 仍禁用 Full，仍为 `productionSupported=false`，不得进入 D-04 production
   support set。严格 network-off/allowlist 资格仍需要 AppContainer、WFP 或其他 descendant-safe 原生
   enforcement 及新鲜 conformance evidence。

## 后果

- Windows 用户批准 `npm run build`、`node script.js` 等命令后可以实际执行；批准不再被 backend
  二次否定。
- 精确 runtime 版本查询无需网络授权，并在三平台保持 network-disabled 投影。
- Windows development backend 的交互行为与 macOS/Linux 对齐，但其隔离强度仍明确较低；任何状态页、
  release evidence 或 production gate 都不能把 V3 的 `off` 字段解释为结构化 network-off 已验证。
- V2 runner 与 V3 adapter 因 manifest protocolVersion 不匹配而在用户脚本前 fail closed。

## 替代关系

本 ADR 仅替代 ADR-0081 中“restricted-token adapter 拒绝 development `allow_all` invocation”的隐含
执行选择；不替代 ADR-0081 关于无结构性网络边界、Full 不可用与 production excluded 的结论，也不改变
ADR-0054/ADR-0061 的 production admission 要求。
