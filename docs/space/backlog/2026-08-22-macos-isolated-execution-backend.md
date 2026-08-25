# B34 — macOS 真正隔离的命令执行后端

日期：2026-08-22
状态：backlog
范围：macOS effectful Shell、Skill child 与 local stdio MCP 的真实隔离执行；不改变当前 production support 空集合。

## 当前状态

当前 macOS Seatbelt profile 能限制已启动子进程的文件系统和网络面，但不能证明 invocation 对调用
`setsid()`、daemonize 或 double-fork 后代的生命周期所有权。只终止 POSIX process group 会留下
detached descendant 的可能性，因此 `LocalSandboxExecutionProviderV1` 对 Seatbelt 必须继续返回
`seatbelt_descendant_containment_unproven`，不得把 profile 成功或 PGID 清理写成 sandbox success。

`c0a1ddcc` 已恢复已确认普通命令的可用性：仅在 native command 尚未启动且
`backend_unavailable + pre_dispatch + cleanupConfirmed` 时，prepared Shell port 可以执行一次
acknowledged host-shell fallback。该 fallback 是未隔离的 availability，不是本待办的完成条件。

## 影响

- macOS 上需要真实隔离的 effectful command 不能获得 native Seatbelt admission；
- 未经证明的 `setsid` 后代会使 cleanup、恢复和 process-tree hard limit 不可信；
- 不能通过启用开关、放宽 Provider 判断、轮询 `ps`、PGID/launchd 清理或把 host fallback 伪装成 sandbox 来解决。

## 建议方向

评估并选择一个提供调用级别 process-tree authority 的新 backend。首选候选是受管理的本地 VM：

1. 每次 invocation 在独立 VM 生命周期中运行，VM 销毁即为完整 descendant boundary；
2. 只以受控 VirtioFS 挂载 canonical Workspace 与 invocation-private runtime root，默认不提供网络设备；
3. 绑定可验证的 guest image、kernel、配置、backend revision 与完整 prepared transport identity；
4. 由唯一 Runtime lifecycle owner 记录 VM start/dispatch/disposal receipt；取消、超时、崩溃与恢复都必须以
   VM 停止和 guest exit 为 cleanup 成功条件；
5. 对 TUI、foreground CLI、Shell、forked Skill、local stdio MCP 分别完成 native conformance；
6. 在 `macos-15` GitHub-hosted native workflow 生成 verifier-checked artifact。只有新的 accepted ADR、原生
   evidence 和 release gate 都完成后，才可调整 production support registry。

另一种方向是带专用系统权限/安装流程的受管理服务；它需要明确的权限、升级、撤销与卸载方案，不能作为
普通用户进程的隐式依赖。

## 完成条件

- 新 backend 对 `setsid` 与 double-fork negative fixture 证明 zero residual；
- hard process-tree limit 由具名 kernel/VM 机制 enforce，并有超限负向证据；
- Workspace 外、protected path、网络、credential 和 runtime cleanup 边界均有 native negative conformance；
- command 从未在 host 与 sandbox 间重放，host fallback 不进入 native qualification；
- GitHub-hosted macOS 原生 artifact、独立 verifier、源身份/digest 与两种 App entrypoint 都通过；
- 新 ADR、active 平台规则、release qualification registry 和用户可见状态共同收敛。

## 相关

- `docs/active/execution-platform-support.md`
- `docs/active/execution-boundary.md`
- ADR-0061、ADR-0116、ADR-0119
- `packages/builtin-runtime/src/sandbox/execution/local-provider.ts`
- `packages/runtime-host/src/posix-supervisor.ts`
