# ADR-0133：Workspace 外敏感访问采用模式感知授权

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0118、ADR-0131、ADR-0132、`docs/active/authorization.md`、
`docs/active/tool-gated-autonomy.md`

## 背景

ADR-0132 将 Workspace 外 credential、持久化配置、系统敏感 identity，以及无法证明文件目标的脚本从
不可批准的路径拒绝改为结构化 `ask + effects.sensitiveExternalAccess`。但它又让该 fact 强制进入真人
审批，从而覆盖了用户已经选择的 Full 授权，也绕过了 Auto 模式原有的模型审查决策。

路径敏感性应作为审查事实，而不是一个独立且优先级更高的交互模式。Full 已是用户显式授予的扩大权限；
Auto 则应让 reviewer 根据调用身份、参数、effects、用户任务与上下文选择执行、拒绝或请求用户确认。

## 决策

1. `sensitiveExternalAccess` 继续作为 Workspace 外敏感 identity 和无法证明目标的脚本的结构化 Policy fact，
   并继续绑定 exact invocation、canonical Workspace、effects 与 target/command identity。该 fact 不再自身
   强制真人审批。
2. `full` interaction mode 对应的 `authorizationMode=full_access` 可以绕过这些调用的 `ask` 并直接执行，
   当前 invocation 投影 `filesystemMode=allow_all`。关键 Workspace/系统根删除、提权、planning mutation、
   sealed capability 缺失和其他独立 hard deny 不可被 Full 绕过。
3. `auto` interaction mode 将 `externalRead`、`externalWrite`、`uncertainEffects` 与
   `sensitiveExternalAccess` 交给自动审批模型。reviewer 必须返回三态决定：
   `approve` 生成 operation-bound grant，`reject` 终止该调用，`ask_user` 创建真人审批；技术失败、无效响应、
   不受支持的 grant 和 circuit breaker 仍升级真人审批。
4. `accept_edits` 与其他非 Full、非 Auto 的普通交互路径继续为这些 `ask` 创建 exact user approval。
   显式 same-command grant 是否可复用由编译策略的 `sameCommandMayBypassApproval` 决定：无法证明目标的普通
   脚本可复用 exact command grant；显式敏感 identity 保持不可复用。
5. 审批或模式授权完成后，preparation authority、Seatbelt、bubblewrap 与 Windows runner 只机械落实 sealed
   scope，不得重新按 protected path 名称拒绝。宿主 ACL/TCC、symlink/identity 漂移和真实命令失败仍如实返回。
6. Full 扩大的是用户文件系统 authority，不包含 Kite 的 Host-control state。POSIX `controlRoot` 与可写
   `dataRoot` 必须位于两个独立 private base；macOS Seatbelt 显式拒绝整个 control base，Linux Full mount
   namespace 以只读空 tmpfs 覆盖整个 control base，使当前及并发 invocation 的 supervisor socket、lock 与
   identity 都不可见。

## 替代关系

- 替代 ADR-0132 决策 2、3 中“`sensitiveExternalAccess` 强制真人审批，且 Full、Auto review 或
  same-command 均不能绕过”的模式路由结论。
- 保留 ADR-0132 对 Workspace 外敏感访问使用结构化 Policy fact、普通模式 exact approval、批准后 native
  不二次拒绝、关键 destructive hard deny、Windows compatibility SID 与 production support set 的其余结论。
- 保留 ADR-0131 对 canonical Workspace 完整信任的结论。

## 后果

- Full 不再因外部 credential、系统敏感 identity 或目标不确定脚本出现额外审批中断。
- Auto 能区分安全执行、明确拒绝和需要用户确认，不再把所有 reviewer 否定结果都等同于人工审批。
- 路径分类、模式选择与 native 执行职责分离：Policy 提供事实，Kernel 决定模式路由，Provider 执行已密封 scope。
- Full 不暴露 Kite 自身或其他并发 invocation 的 Host-control identity；该隔离不缩小用户 Workspace 或外部
  文件访问权限。

## 回滚

回滚必须以新的追加 ADR 说明哪些调用需要无条件真人审批，并同步 Kernel、Builtin reviewer、Policy 编译器、
active 文档与模式差异测试；不得只恢复 native protected-path deny。
