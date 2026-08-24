# ADR-0132：Workspace 外敏感路径使用精确审批

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0100、ADR-0118、ADR-0131、`docs/active/authorization.md`、
`docs/active/execution-boundary.md`

## 背景

ADR-0131 已把 canonical Workspace 作为完整授权身份，但 Workspace 外凭据、持久化配置和关键系统路径
仍由 Tool Policy、preparation authority 与三个原生 backend 重复拒绝。用户即使对 exact invocation
明确批准，Seatbelt deny、bubblewrap mask 或 Windows guard ACE 仍会让同一调用失败，形成不可兑现的审批。

敏感路径需要更高强度的用户确认，但“敏感”不等于“永远禁止访问”。授权决策应由 Policy/approval
完成；native sandbox 负责落实批准后的 scope，并继续约束网络、进程树、资源与未批准的默认文件系统边界。

## 决策

1. canonical Workspace 内 read/write/execute 继续直接继承整体 Workspace scope，不按隐藏名称、凭据外观
   或系统祖先名称审批或拒绝。
2. Workspace 外 credential、Shell/Agent/IDE 配置、Git hook/config、启动项与关键系统 identity 不再硬拒绝，
   而是生成 `ask + effects.sensitiveExternalAccess`，绑定 exact invocation、canonical Workspace、effects 与
   target identity。Kernel 对该结构化 fact 强制真人审批；`full`、Auto review 或 same-command grant 不能静默
   绕过，未经批准不得 dispatch。
3. `read_file` 直接访问敏感外部 identity 必须审批。外部递归 `search_files`/`search_content` 无法在 I/O 前
   证明遍历不会覆盖 credential-looking identity，因此统一先审批；普通外部单文件只读路径仍可使用
   observe-only `external_read`。
   Shell 若因变量拼接、任意脚本或间接 child 无法证明文件目标，也保守投影 `sensitiveExternalAccess`，避免
   Full 模式绕过真人审批。
4. 审批通过后，Shell 的 `externalRead | externalWrite | uncertainEffects` 投影为该 invocation 的
   `filesystemMode=allow_all`；文件工具继续使用 sealed observe/mutation scope。preparation authority 不得再次
   运行不可绕过的敏感路径 deny。
5. macOS `full_access` profile、Linux `full_access` mount namespace 与 Windows approved-filesystem token
   不得对已批准敏感路径安装第二层 deny。Linux 在 bind 宿主 `/` 后必须用只读空挂载隐藏 Kite host-only
   control root；data root、PID/network namespace、seccomp/cgroup 能力与 cleanup contract 不变。
6. Windows protocol 暂时保留 approved-filesystem compatibility SID，避免仅为删除无效字段升级协议；runner
   不再生成 protected deny paths 或 guard ACE。旧 Workspace ledger 的 protected snapshot 仍按 V3 migration
   恢复并删除。
7. 关键破坏性删除、提权、planning phase mutation、sealed production capability 缺失、symlink/identity
   漂移及真实 OS ACL/TCC failure 仍可硬拒绝或 fail closed；本决定不把审批伪造成执行必定成功。
8. production support set 保持为空。Windows native source 变化必须由 canonical Windows build 重新生成
   runner 与 manifest digest；既有 artifact 不能作为本决定的实现证据。

## 替代关系

- 替代 ADR-0100 决策 5 中“Workspace 外敏感路径在审批前硬拒绝”的结论；其 exact approved-filesystem
  capability、no replay 与普通外部路径语义保留。
- 替代 ADR-0131 决策 3、5、6 及后果中要求命令预检和 native backend 永久拒绝 Workspace 外固定敏感
  identity 的部分；ADR-0131 的完整 Workspace 信任与空 production support set 保留。
- 扩展 ADR-0118 的可兑现审批语义，使外部敏感 read/search 与 Shell access 同样由 Policy/approval 管理。

## 后果

- 用户会在读取或修改 Workspace 外敏感 identity 前看到明确审批；拒绝时命令或文件 I/O 不启动。
- 用户批准后不会再收到 Kite 自身的 protected-path denial，但宿主权限、TCC、只读文件系统或命令错误仍
  如实返回。
- 原生 backend 的职责更清晰：默认 scope 保持隔离，扩大 scope 时不重新解释 Policy。

## 回滚

回滚必须由新的追加 ADR 定义哪些敏感 identity 永久不可批准，并同步 Policy、preparation、三平台 native
backend、测试、active 文档和原生 evidence。不得只在某个平台恢复隐式二次 deny。
