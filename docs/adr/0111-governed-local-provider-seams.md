# ADR-0111：受治理的 Local Provider Seams

状态：accepted

日期：2026-08-16

决策者：github:@ferqx

相关：ADR-0001、ADR-0054、ADR-0097、ADR-0100、ADR-0101、ADR-0102、ADR-0105、ADR-0106、ADR-0110、`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

MCP 已有明确的 Runtime Provider contract；Workspace filesystem、sandbox execution 与 Subagent 主要仍以
实现模块或 runner 形式存在。若直接把这些实现包装为可自由调用的通用 adapter，会制造绕过 Capability
Binding、Policy、approval、execution boundary、receipt 与 Verification 的新入口。

本项目只需要可测试、可拒绝、受 Runtime 治理的本地执行后端，不需要动态插件发现、通用依赖注入容器
或 everything-is-plugin 体系。

## 决策

1. 定义 protocol-first 的 `WorkspaceFilesystemProviderV1`、`SandboxExecutionProviderV1` 与
   `SubagentProviderV1`。Production 只组合仓库内受控 Local 实现；Provider 不拥有 Policy、approval、
   Runtime Event 或 RuntimeState。
2. 每个 Provider 方法只接受 Tool Pipeline 签发、绑定 capability/tool/attempt/effect/workspace identity 的
   sealed grant，并返回 bounded JSON-safe observation/receipt。缺少、过期、重复消费或身份不匹配都在
   Provider I/O 前拒绝。
3. Filesystem seam 保留 canonical Workspace、path admission、read-before-edit、preimage/stale check 与
   effect classification；它不是任意路径文件 API，也不能自行扩大批准范围。
4. Sandbox seam 区分 pure preparation 与可能分配资源的 preparation。任何 allocating prepare 前同样需要
   durable intent；prepared plan 单次消费。进程 spawn 由 Runtime consumer 拥有并继续受 execution boundary、
   cancellation、network/protected-path 和 cleanup 约束，不能降级到裸 host shell。
5. Subagent seam 只执行 Runtime 已签发的 child context，继承 parent ceiling、budget、interaction mode、
   cancellation、replay mode 和 parent invocation/tool identity。Provider 返回 child observation，不直接修改
   parent Runtime 或把 private continuation 投影给模型。
6. fake Provider 是 denial、crash、stale、leak 与 recovery 测试 seam，不是 production fallback。三条 Local
   seam 通过 parity 后删除旧 adapter composition；运行时不存在第二入口。
7. 只有 `CUT-01` 在 Model Gateway、Tool Pipeline 与三条 seam 全部迁移后切换 Runtime format epoch。未完成
   seam 不得以 fallback 方式进入新 epoch。
8. ADR-0105 的同改动替换要求按 PS-01 至 PS-03 的未接入 production migration series 验收：协议和 fake 可
   先建立，Local adapter 只有在相应旧调用点同一迁移中删除后才可进入 production composition。一般 Engine
   feature flag 由 static boundary、parity/no-bypass evidence 和 CUT-01 替代，不提供旧 adapter fallback flag。

## 备选方案

- 通用 `run(command)`、`read(path)` 或 service locator：拒绝。它们丢失 capability、effect 与 grant identity。
- 把 sandbox 当作授权来源：拒绝。技术隔离不能替代 Runtime Policy 和用户 approval。
- 让 Provider 直接持久化 event/receipt：拒绝。它会与 Kernel 和 Pipeline 形成第二状态权威。
- 失败时调用旧 filesystem/sandbox/subagent 实现：拒绝。它会把 seam 变成可选包装层。

## 后果

- 三条 seam 必须在 Tool Pipeline 已形成明确 dispatch/receipt boundary 后迁移。
- Local 实现与 fake 实现共用协议，但 production composition 只能选择受控 Local 实现并 fail closed。
- 静态 boundary tests 必须证明 Provider 不能导入 Runtime reducer/store、Policy、approval 或 App/TUI 类型。

## 回滚

CUT-01 前可以撤销未合并 seam 迁移；不能保留 production fallback。CUT-01 后 Provider 缺失、grant 无效、
prepare/dispatch receipt 不完整或 cleanup certainty 未知时一律 fail closed。
