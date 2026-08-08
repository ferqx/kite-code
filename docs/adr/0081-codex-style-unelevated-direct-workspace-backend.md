# ADR-0081：Codex 式无 UAC restricted-token 直接 Workspace 后端

状态：accepted

日期：2026-08-06

相关：ADR-0061、ADR-0065、ADR-0072、ADR-0073、ADR-0074、ADR-0077、ADR-0078、ADR-0079、ADR-0080

## 背景

私有 Workspace AppContainer 候选对其 staging 的路径具有较强隔离形态，但即使把工作移出
TUI 线程，复制并回写大仓库仍会让首个命令等待很久。这样的等待不能成为 Windows 交互式默认体验。

Codex 的 Windows 实现展示了另一种开发期沙箱形态：从当前用户创建无 UAC 的 write-restricted token，
向 token 附加 capability SID，只在需要写入的路径上授予这些 SID，并让子进程运行在 Job Object 中。
它直接操作真实 Workspace，普通使用不需要管理员确认。但它不等价于受管身份、结构性网络边界或
投影文件系统。

ADR-0079 曾把 elevated managed restricted-token profile 作为默认目标，并把 ADR-0073 对动态根级
.env.* 创建的保证保留为门槛。这仍是更强的 profile；但若把它作为普通开发路径前置条件，就会把不必要、
并非每台机器都具备的 setup 强加给用户。

## 决策

1. 当 digest-verified native runner 与 Windows 10 API baseline 可用时，windows_restricted_token 是
   Windows 的默认 development backend。它不触发 UAC，不 provisioning local account，不改 firewall
   policy；cwd 是 canonical 真实 Workspace，绝不创建 whole-repository staging copy。native invocation
   protocol 升为 V2；仅支持 pre-direct V1 的 runner 必须因 protocolVersion 不匹配而 fail closed，不能
   忽略 sandboxMode。release manifest 文件名 windows-runner-v1.json 与其 manifest schema 仍为 V1，
   但 manifest 内 protocolVersion 必须固定为 2。
2. native runner 使用 CreateRestrictedToken 创建 current-user primary token，组合
   DISABLE_MAX_PRIVILEGE、LUA_TOKEN 与 WRITE_RESTRICTED；它传入 caller-owned capability SID，挂起
   创建 child，验证 child token，关联 Job Object 后才恢复执行。Job 负责 descendant 生命周期和终止，
   但本身不是 filesystem 或 network 边界。
3. 每个 canonical Workspace 使用持久 synthetic capability-SID ACL，并在 user-owned recovery ledger 中
   记录。runner 会在修改 static、已存在 protected path 的 DACL 前保存 snapshot，并提供 explicit
   repair/uninstall：先还原 snapshot，再删除 Workspace grant。每次 invocation 另有一个 runtime
   capability grant，在 Job 已清空后移除。crash recovery 失败必须 fail closed，不能猜测或重造 ACL。
4. 该 backend 有意保持比 strict managed profile 更低的 assurance。write-restricted current-user token
   不会结构性拒绝 Workspace 外的所有普通读取；它没有 structural network-off 或 arbitrary descendant
   allowlist；static ACL 也无法保证 future root .env.* 一定被拒绝。已存在 protected path 的 deny
   只作 defence in depth，不能表示成 dynamic protected-glob guarantee。
5. 因此 windows_restricted_token 不能开启 Full，不能满足 production full_access boundary，不能为任意
   descendant 资格化 networkMode=off 或 allowlist，也不能把 Windows 加入 D-04 production support set。
   即使 lower-assurance backend 已选中，TUI/CLI 也必须将 Full 置为不可用，并对禁用项显示
   非沙箱环境无法开启full。
6. windows_appcontainer 仍是 KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL=1 后才选择的 migration/
   experimental backend。它的 private staging 和 admission budget 不再是 default large-Workspace path。
   worker、budget、staging、reconciliation、command 或 cleanup error 均 fail closed，绝不能变成
   host-Shell replay。
7. 允许 host fallback 的 foreground development entrypoint 只能在用户脚本前、selected sandbox
   environment 或 essential startup capability unavailable 时，选择 host Bash/cmd/PowerShell。决定缓存为
   backend none。已选中 sandbox 的 command failure、timeout、cancellation、ACL cleanup failure 或
   AppContainer admission failure 都不得在 host 上重试脚本。
8. Windows 11 是 primary native-E2E target。Windows 10 22H2 (10.0.19045) 只保留 API/build
   baseline；没有独立证据时不得声称 physical Windows 10 conformance。

## 后果

- 正常 Windows TUI 启动可以异步 probe direct backend，真实 Shell command 不再承担 repository
  copy/hash/reconciliation 延迟。
- 普通使用不会出现管理员确认。未来可以提供 explicit 的 elevated managed stronger profile，但它不是
  default backend 的前置条件。
- 持久 Workspace ACL state 是有意的、可恢复的状态，而非每条 command 改动 DACL 所造成的竞争；
  它必须绑定 canonical Workspace identity，绝不复用于不相关路径。
- 产品和 release surface 必须区分“development sandbox backend 已选中”和“strict/producible isolation
  已获资格”；后者对该 backend 仍为 false。
- 显式 AppContainer experiment 保留自己的 private-staging 语义，不能用 direct backend 的
  lower-assurance 状态放宽其 fail-closed admission rule。

## 非目标

- 不将该 token 声称为 AppContainer、VM 或等价的 structural network sandbox。
- 不将 static deny ACE 说成对任意 future root .env.* 的保护。
- 不因 restricted-token child 成功启动而让 Full 可选。
- 不在 normal launch 或 normal command path 上使用 UAC、local-account provisioning、WFP setup 或
  elevated ACL installer。
- 不在 user script 已开始后 fallback 到 host execution。

## 替代关系

本 ADR 替代 ADR-0079 中“elevated managed profile 或 projection/COW capability 必须先于全部 direct
Workspace development execution”的默认排序，并仅就 Windows 默认排序替代 ADR-0080 决策项 4--5。
它**不**削弱 ADR-0073 或 ADR-0079 的 stronger requirement：strict/producible profile 仍必须满足
它们。ADR-0080 的 startup-only、no-replay fallback rule 保持不变。
