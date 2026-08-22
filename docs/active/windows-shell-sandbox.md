# Windows Shell 沙箱：direct restricted-token 与已审批当前用户联网

状态：active

读取时机：修改 Windows execution backend、native runner protocol、restricted token/ACL/Job lifecycle、
已审批网络 token、Shell runtime policy、Windows filesystem/network boundary、Platform Capability
Probe，或 Windows Full/fallback UI 状态时。

验证：`bun test tests/tool-definitions.test.ts tests/tool-runner.test.ts
tests/sandbox/platform-backends.test.ts tests/sandbox/windows-restricted-token.test.ts
tests/sandbox/windows-network-setup.test.ts tests/sandbox/platform-capability-probe.test.ts
tests/sandbox/platform-capability-verifier.test.ts tests/sandbox/process-tree-limit.test.ts
tests/sandbox/app-sandbox-composition.test.ts tests/sandbox/execution-boundary.test.ts
tests/git-broker.test.ts tests/runtime/git-tool-controller.test.ts
tests/tui-exit-coordinator.test.ts tests/session-manager.test.ts tests/tui-reducer.test.ts`、
`bun run typecheck`、`bun run check:docs`。native runner
变更还必须运行 `cargo test --manifest-path native/windows-sandbox-runner/Cargo.toml` 和 release
script 指定的 Win11 native E2E/probe。direct backend E2E 为
`KITE_RUN_WINDOWS_RESTRICTED_TOKEN_E2E=1 bun test --max-concurrency=1
tests/sandbox/windows-restricted-token.test.ts`；它必须经 App composition，并由 test-only Runtime lifecycle
oracle 先 ack preparation intent。当前 Local Provider 随后必须以
数据化的 `windows_restricted_token_v1` prepared transport 通过 ready/dispatch lifecycle；native E2E 使用
`printf SANDBOX_OK` 断言受限 token runner 的实际 stdout、Job cleanup 与 `disposed=true` disposal receipt。
该 native conformance 显式设置 `hostFallbackPolicy=deny`，确保成功输出来自 runner 而不是 host fallback。
Online 账户 setup 已不属于该 backend；required conformance 不创建账户，也不发起单独的 Schannel smoke。
非 Windows 开发机缺少固定 GNU target/toolchain 时，本地 TypeScript 协议测试不能替代 native runner
编译证据；包含 runner Rust 源码的 PR 必须等绑定当前 head 的 `candidate-windows-x64` 或 Windows
Platform Capability Probe 完成 `build-windows-runner.ts` 构建，才能宣称该平台改动已通过；该构建必须
同时闭合 library 与 `kite-windows-runner` binary 的接口，不能用仅编译 library 的结果替代。
Windows 10 使用 22H2 (10.0.19045) API/build baseline；本记录不声称 physical Win10 conformance。
当前 GitHub-hosted E2E 不执行 Node/npm/Bun/cmd/PowerShell runtime smoke 或受管网络 Schannel smoke；
runner native 实现与可复现构建覆盖由独立 Cargo/protocol evidence 提供，不能绕过 Local Provider admission。
若未来 Provider 获得新 accepted authority，runtime smoke 必须拆为独立调用并给 Defender 冷启动各自有界预算，
Schannel smoke 也必须保持单一网络维度，不能用复合命令或错路由替代资格证据。
Windows 临时 Workspace 的原生断言比较 canonical、大小写不敏感的 path identity，不把 8.3 短路径与
同一目录的长路径 spelling 差异误报为 cwd 越界。
runner evidence 在 Windows CI 中显式选择固定版本的 GNU toolchain，并通过
`bun run scripts/release/build-windows-runner.ts` 固定 toolchain 内置 `rust-lld`、重映射
checkout/Cargo cache 路径并清除 PE 时间戳；
重新生成 manifest 后必须以 `git diff --exit-code` 证明提交的 runner pin 与构建产物一致。

相关：ADR-0074、ADR-0077、ADR-0079 至 ADR-0089、ADR-0097、ADR-0110，
`release/platform-capabilities/windows-runner-v1.json`。

## 当前 backend 选择

Windows 只有以下 runtime outcome：

| outcome | 选择条件 | Workspace 模型 | assurance 与 Full |
| --- | --- | --- | --- |
| windows_restricted_token | protocol V6/native runner compatibility path；Builtin Local Provider 在 durable intent 后生成 transport，Runtime lifecycle consumer 经唯一 Host spawn primitive 启动 | canonical 真实 Workspace，不复制 repository | development restricted-token sandbox；开发期 Full 可用，production qualification 不可用 |
| none / denied | candidate 不可用、sandbox 关闭或语义不受支持 | 不启动用户命令 | 零 host Shell fallback；Full 不可用 |

另有 ADR-0100 定义的逐 invocation approved-filesystem scope：普通 Workspace 外读写或路径范围无法
证明的命令审批通过后，仍由去权 restricted token 与 Job Object 执行，只使用当前用户普通 ACL，而不使用
Workspace-only `WRITE_RESTRICTED` capability gate。它不是 host executor、startup fallback 或失败后 replay。

AppContainer backend、`KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL` 选择逻辑、private Workspace
staging、repository copy、预算 Worker 和 reconciliation 已由 ADR-0088 删除。设置旧环境变量不会改变
backend。该移除不降低 production 能力，因为实验路径从未取得 production qualification。

RMV1-13 的物理所有权不改变 protocol V6 或当前 fallback：runner manifest、transport preparation、
protected-path/network/resource 语义位于 `packages/builtin-runtime/src/sandbox/`，通用异步进程创建、POSIX
supervisor、output drain 与 process-tree cleanup 位于 `packages/runtime-host/src/`，唯一 App composition 位于
`apps/kite/src/sandbox/`。已删除的 `src/core/sandbox/**` 和 protocol/Core 旧路径不得恢复为兼容导出或
durable lifecycle adapter，也不得重新加入 `Bun.spawn`、第二个 runner handler 或 post-dispatch replay。

正常本地路径无需 UAC，TUI 不检查联网身份。foreground CLI 保留 `bun run agent sandbox status` 与
`bun run agent sandbox setup` 作为非提升兼容入口；两者在 pinned runner 可用时均报告
`current_user_restricted_token`。Runtime 记录该次 Shell 的 `allow_all` 用户授权后，native runner 直接
使用当前登录用户 token 运行该 exact command，不创建、登录或依赖另一 Windows 本地账户。

## direct Workspace restricted-token backend

1. TypeScript adapter 验证 pinned native runner，并在 TUI 首次渲染后安排 structural startup probe。
   它不枚举、复制、hash 或 reconciliation 用户仓库。
2. runner canonicalize 真实 Workspace 与 invocation-private runtime。command cwd 与 workspace root
   都是真实 Workspace，写入直接落到该 Workspace。
3. 每个 Workspace 有持久 synthetic capability SID 和 user-owned ledger。root inheritable write ACE
   保持持久；ledger 在 static protected-path DACL 变更前保存 snapshot，并以规范路径、protected set
   digest 与 setup 状态约束无锁快路径。
4. 每个 invocation 有单独 runtime capability SID，只授予 invocation runtime。startup probe 使用
   ephemeral Workspace SID，不修改真实 Workspace ledger。
5. `networkMode=off` 从 current user 派生 write-restricted primary token，使用
   `CreateRestrictedToken` 的 `DISABLE_MAX_PRIVILEGE`、`LUA_TOKEN`、`WRITE_RESTRICTED`
   与 capability SID。
6. persistent Workspace capability ledger 只持久化根 allow ACE，不把路径名称摘要当作当前对象
   已受保护的证明。每次 invocation 都在 Workspace mutex 下复核现存 protected object 的 deny ACE；
   宿主原子替换同名文件后，runner 必须先刷新该对象的 DACL snapshot，再重新施加 deny。
7. 只有同一次 invocation 同时获批 `allow_all` 与 `full_access` 时，native runner 才使用当前登录用户
   token 启动该 exact command，并先把它加入 kill-on-close/active-process-limit Job。它不调用
   `CreateProcessWithLogonW`，也不创建、登录或轮换 `KiteNet*`/其他本地账户。`allow_all` 配合
   `read_only` 或 `workspace_write` 必须由 TypeScript adapter 与 native runner 在 user script 前以
   `approved_network_requires_full_filesystem_scope` fail closed：不得为了 Schannel 静默放弃受限 token 的
   文件系统边界。
8. 上述同时获批网络与完整文件系统的 command environment 只保留当前用户 profile 中 Schannel 所需的 `APPDATA`、
   `LOCALAPPDATA`、`USERPROFILE` 等路径，再覆盖受信 runtime allowlist；这使 TLS 使用当前用户的
   credential store。此 exact `allow_all` invocation 还继承用户已有的标准 proxy variables
   （`HTTP[S]_PROXY`、`ALL_PROXY`、`NO_PROXY`；Windows environment 名称不区分大小写），使企业或本地代理可达；network-off、
   policy-proven read-only 与未批准调用不得继承这些变量。proxy 值只由 runner 在实际 spawn 时从当前进程
   读取，不能出现在持久化的 preparation 或 recovery artifact 中。
9. 未获网络授权的调用仍使用 write-restricted token。Windows development backend 不将该事实表述为
   structural network-off；已审批联网调用也不声称具备独立的 restricted-token filesystem ceiling。

runner 只使用 manifest 固定的 POSIX runtime 与最小 environment allowlist。可验证的 Bun executable
可通过 invocation runtime/PATH 暴露，但不会复制 repository。默认 command language 仍为 POSIX/Bash，
也可显式调用 cmd.exe、pwsh 或 powershell.exe。

Windows standalone candidate 会将 runner manifest、固定 runner 与 `vendor/isksh` runtime 保留在当前
managed candidate payload。激活的 `kite.exe`/`kite-tui.exe` 通过 install marker 定位该 payload；缺失或
digest 不一致使 backend 不可用，不会加载未固定的 host runner。

## protocol V6 与 manifest V1

adapter 与 runner 必须要求 native invocation `protocolVersion=6`。V6 只描述 direct
`windows_restricted_token` invocation，携带 development network `off | allow_all` 与 filesystem
`read_only | workspace_write | full_access` authorization projection；`full_access` 只允许来自已批准的单次
invocation；`allow_all` 也必须同时带有 `full_access`，否则在 user script 前拒绝。未获网络授权的
`full_access` 要求 `approvedFilesystemGuardSid`，并仍创建去权 restricted token 与 Job Object。已审批
`allow_all + full_access` 的当前用户 token 不携带该 synthetic SID，runner 不得创建无效的 protected-path
ACL lease（否则会在不增加约束的情况下逐次改写用户 profile DACL）。V6 继承 V5
删除的 backend mode、AppContainer identity 与 staging 字段；任何 V1-V5 runner 都在 user script 前
fail closed。

`windows-runner-v1.json` 的 V1 仍表示 manifest schema/file naming，不是 invocation protocol。
新 runner pin 必须固定 protocol V6、runner 0.8.3+、binary digest、Windows baseline 与 vendored runtime
digest。当前仓库 pin 已由 canonical Windows build 提升为 0.8.3/V6，并固定该构建生成的 binary
digest `sha256:1a40a5c0cf096f191087e95e499b3c5c0639b333dc9abf6fba0e5cae6100b04c`；后续任何 native
runner 变更都必须重新运行同一可复现构建并提交新的 digest，不能只改 protocol、版本或 manifest 文本，
也不能复用旧 binary digest。

## 能力边界

local path 的 `WRITE_RESTRICTED` 通过 restricted SID check 限制写入，但 current user 仍可能拥有普通读取
权限。approved filesystem path 同样保留 `WRITE_RESTRICTED`、LUA 与 privilege stripping，使 read/execute
只服从 current user 普通 ACL，并让 restricted SID check 仅参与写访问；token 的 restricted SID 集合镜像
user/group SID 并加入专用 guard，同时保留 Logon/World SID。这样 GitHub runner toolcache 等只向普通用户
ACL 身份授予执行权的 system/toolchain binary 仍可运行，而既有固定路径对 guard SID 的 write deny ACE
仍会拒绝写入，宿主当前用户不受该 ACE 影响。approved token 与普通 Workspace token 使用同一
Logon/World/capability default DACL 初始化，确保 shell 创建的 pipe 与 Node/npm 等 descendant process
object 可由该 token 继续访问。只有已审批 `allow_all + full_access` 的网络调用才改用当前用户 token，
以便 Schannel 读取当前 profile；因此它不保留 restricted-token filesystem ceiling，普通用户 ACL 成为该
exact 已审批 command 的文件权限边界，也不得安装该 token 无法命中的 temporary guard ACE。任何较小
filesystem scope 的网络调用均被拒绝，不能把 network approval 变成该 filesystem 扩权。
Job Object 提供进程树数量和终止边界，不单独作为 filesystem 或 network boundary。

该 backend 没有 structural network-off、arbitrary-descendant allowlist 或 future root `.env.*`
动态名称保证。static protected paths 的 guard deny 与 Workspace ledger 是 native enforcement，但不能冒充
future-name interception。ledger
属于 trusted host state；外部 ACL 修改后需要显式 repair，无锁快路径不会在每次调用审计整个 Workspace。
持久 Workspace capability ledger 只记录 canonical Workspace 内的 protected path；用户目录等外部
protected path 不得写入该 ledger，因为 Workspace capability 在外部没有 allow ACE，本来就无法通过
restricted write check。approved filesystem guard 仍可在单次 invocation 内保护既有外部固定路径，
并在 Job 清空后撤销，不把外部路径交给 Workspace repair。
Rust 回归测试 `persistent_protected_paths_never_escape_the_workspace` 以纯路径成员判断锁定该边界，
不依赖 CI host 预先存在特定绝对路径。

因此 `windows_restricted_token` 是 development backend：

- 可以开启 ADR-0121 定义的开发期 Full，但不能以此宣称 production Full qualification；
- 不能为 arbitrary Shell descendant 资格化 network-off 或 allowlist；
- 不能承诺 future root `.env.*` 的 production protected-path deny；
- `productionSupported=false`，D-04 仍为 excluded。

Tool Policy 保持逐调用授权：可证明本地的 version query 投影为 `off`；网络命令和 uncertain script
经批准后投影为 `allow_all`；Windows 还必须同时拥有 explicit `full_access`，才使用当前登录用户 token，
否则在 native runner 前 fail closed。这里的模式是 development authorization，不产生域名 allowlist 或
production network evidence。

文件系统 effects 独立处理：`externalRead`、`externalWrite` 与 `uncertainEffects` 审批通过后与其他平台
相同投影 approved filesystem scope；Auto 模型判断安全时自动批准，判断风险或技术异常时转真人审批。
该 invocation 不准备或修改 restricted-token Workspace ACL ledger。普通临时目录和外部文件允许执行；
凭据、持久化入口、关键系统
文件和 destructive 操作必须在审批前拒绝。命令自身或宿主 ACL 失败仍原样返回。

## startup denial 与 no replay

TUI 静默预热不阻塞首帧、typing、timer 或 Working animation。bootstrap 把 executor
注册到统一退出协调器。退出或等待 `prepare()` 的当前
SessionRuntime 被取消时会中止探针，runner 清空 Job 并回收 ephemeral ACL；中止结果不缓存。setup gate
与预热并行，并在用户确认时 re-check readiness。

development/production App 在 user script 前确认 runner pin、OS baseline 或 token capability
等 essential capability unavailable 时，缓存 backend=`none`/mode=`denied`，不使用 host Shell。
该 denial 不是 sandbox evidence，Full 仍不可用。

一旦 user script 交给 native runner，它至多执行一次。non-zero exit、timeout、cancellation、runner
error、Job cleanup、ACL lease cleanup 或其他 command-time failure 都作为该 backend 的结果返回，不得
在 host Bash/cmd/PowerShell replay。production composition 始终使用 fail-closed executor。

## evidence 与错误分类

native runner 在低于 Windows 10 22H2 (10.0.19045) 时 fail closed。Win11 GitHub-hosted environment 是
runner build/Cargo/protocol、Local Provider 及成功 command dispatch conformance 的原生 evidence 来源。token、ACL
与 Job conformance 通过仍不能提升 strict network/protected-glob
或 production 资格。

正式 Platform Capability Probe 的 Windows 命令使用正常 persistent Workspace capability，而不是
startup probe 的 ephemeral Workspace SID，因此 protected-path write 结论必须经过真实 ledger/DACL
刷新路径。probe Workspace 创建后立即固定 canonical identity，采集与 finally repair 必须共用该值，
不能让 Windows 8.3/长路径 alias 分裂 ledger。probe Workspace 仍是临时目录；采集结束时先调用 runner repair 恢复 snapshot、撤销 root ACE
并删除 ledger，再删除临时目录。资格 workflow 的 paths gate 必须覆盖 native runner、`vendor/isksh`、
Windows adapter 使用的 App composition、Builtin sandbox、Host lifecycle、SPI contract 以及 evidence scripts，不能让这些依赖单独变更而跳过原生
E2E/probe。

| 条件 | 必须的结果 |
| --- | --- |
| user script 前 runner pin/OS/token/cleanup structural capability unavailable | App 缓存 backend none/mode denied，不启动 host command；Full 保持不可用 |
| user script 开始后的 command/timeout/cancel/cleanup failure | selected backend fail closed；不 host replay |
| static protected-path ACL/ledger recovery failure | fail closed 并保留 diagnostic |
| 已审批 `allow_all + full_access` | 当前用户 token 在 Job Object 中运行 exact command；不创建账户、不请求 UAC |
| 已审批 `allow_all + read_only/workspace_write` | `approved_network_requires_full_filesystem_scope`，不启动 user script，不 host replay |
| none 请求 Full | disabled/rejected，并显示非沙箱环境无法开启 full |
| windows_restricted_token 请求 Full | 允许开发期 Full；不改变 `productionSupported=false` 或 strict production evidence 要求 |

ADR-0120 开始实现 direct Workspace 的临时 AppContainer strict candidate：它不是 Windows 登录账户，
不请求 UAC，也不恢复 repository copy。默认零 capability profile 与已批准网络 profile 必须分离；在
offline network、Workspace 外 read/write、动态 protected-name、Job/ACL/profile cleanup 和两入口 native
conformance 全部通过前，它仍不是可选择 backend，也不能用于 production Full qualification。开发期 Full
已由 ADR-0121 的 direct backend 语义提供。

Windows restricted-token 开发 backend 尚不能证明通用 Shell 对 `.git` metadata 的
独立 read 与 write deny；既有 ACL ledger 和 protected-name 测试不能冒充该证据。
因此 `brokered-git-r1` 在 Windows production qualification 固定 excluded，直到新
principal/profile 路径通过 native read/write negative、broker positive/hostile 与入口 composition
全部证据；不得退回 raw Shell Git。
