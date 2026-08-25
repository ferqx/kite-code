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
`cargo test` 还必须编译 binary 的 `cfg(test)` target；bootstrap/frame material fixture 比较 exact bytes，
不能把内部 `Arc`/`Vec` ownership shape 当作 wire contract 或因此跳过 native test target。每个 fresh runner
control stream 接受一次合法 bootstrap；同一 stream 的第二份 bootstrap 位于 request frame 位置，必须由
frame decoder 拒绝，不能把“single-use”误写成跨独立 stream 拒绝相同测试向量。
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

相关：ADR-0074、ADR-0077、ADR-0079 至 ADR-0089、ADR-0097、ADR-0110、ADR-0131、ADR-0137，
`release/platform-capabilities/windows-runner.json`。

## SAQ-10 当前 contract

Windows restricted-token 只兑现明确的 sealed scope；UI 展示的 scope、prepared transport 中的
scope，以及 native runner 的实际 boundary 必须一致。`interactionMode=full` 是 Full 的唯一表达，
不再存在 `full_access` approval grant 或第二个 authorization mode。`none`/能力不可用时，受限
执行 clean fail closed，不能退回 host Shell；这不应把 Full 选择器误报为需要一个旧 grant。

SAQ-10 的阶段基线是 Building 的 Workspace 读写 baseline 与 Planning 的 Workspace 只读 baseline。
已知的 external/sensitive scope 由 Tool Policy 路由到 `approve_once`、`same_command` 或 Auto
review；同一 invocation 的 sealed scope 仍须在 approval、recovery 与 dispatch 中保持不变。Plan 与
Full 正交：Planning + Full 可直接执行但仍保留 Plan lifecycle。只有同一轮并发多个 Explore children
才派生 Auto；单个 Explore 及 plan/code/review children 继承 parent route。

人工队列由 State 27/SAQ epoch 持久化。Enter 提交 exact interactionId/generation，Esc 只拒绝当前
可见焦点，Ctrl+C 才取消 whole turn；`/permissions` 的 session grants 清除通过 canonical event
持久化，并在 session/revision/generation 不匹配时 no-op。旧 queue/grant 或旧 epoch 不能在 restore
后复活。

## 当前 backend 选择

Windows 只有以下 runtime outcome：

| outcome | 选择条件 | Workspace 模型 | assurance 与 Full |
| --- | --- | --- | --- |
| windows_restricted_token | protocol V6/native runner compatibility path；Builtin Local Provider 在 durable intent 后生成 transport，Runtime lifecycle consumer 经唯一 Host spawn primitive 启动 | canonical 真实 Workspace，不复制 repository | development restricted-token sandbox；开发期 Full 可用，production qualification 不可用 |
| none / denied | candidate 不可用、sandbox 关闭或语义不受支持 | 不启动用户命令 | 零 host Shell fallback；受限 scope clean fail closed，Full 不转成旧 grant |

另有 ADR-0100 定义的逐 invocation approved-filesystem scope：普通 Workspace 外读写或路径范围无法
证明的命令审批通过后，仍由去权 restricted token 与 Job Object 执行，只使用当前用户普通 ACL，而不使用
Workspace-only `WRITE_RESTRICTED` capability gate。它不是 host executor、startup fallback 或失败后 replay。

AppContainer backend、`KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL` 选择逻辑、private Workspace
staging、repository copy、预算 Worker 和 reconciliation 已由 ADR-0088 删除。设置旧环境变量不会改变
backend。该移除不降低 production 能力，因为实验路径从未取得 production qualification。

RM-13 的物理所有权不改变 protocol V6 或当前 fallback：runner manifest、transport preparation、
protected-path/network/resource 语义位于 `packages/builtin-runtime/src/sandbox/`，通用异步进程创建、POSIX
supervisor、output drain 与 process-tree cleanup 位于 `packages/runtime-host/src/`，唯一 App composition 位于
`apps/kite/src/sandbox/`。已删除的 `src/core/sandbox/**` 和 protocol/Core 旧路径不得恢复为兼容导出或
durable lifecycle adapter，也不得重新加入 `Bun.spawn`、第二个 runner handler 或 post-dispatch replay。

正常本地路径无需 UAC，TUI 不检查联网身份。foreground CLI 保留 `bun run agent sandbox status` 与
`bun run agent sandbox setup` 作为非提升兼容入口；两者在 pinned runner 可用时均报告
`current_user_restricted_token`。Runtime 记录该次 Shell 的 sealed-scope 授权后，native runner 直接
使用当前登录用户 token 运行该 exact command，不创建、登录或依赖另一 Windows 本地账户。

## direct Workspace restricted-token backend

1. TypeScript adapter 验证 pinned native runner，并在 TUI 首次渲染后安排 structural startup probe。
   它不枚举、复制、hash 或 reconciliation 用户仓库。
2. runner canonicalize 真实 Workspace 与 invocation-private runtime。command cwd 与 workspace root
   都是真实 Workspace，写入直接落到该 Workspace。
3. 每个 Workspace 有持久 synthetic capability SID 和 user-owned ledger。root inheritable allow ACE
   保持持久；V3 ledger 把 canonical Workspace 作为完整身份，并在升级时恢复、删除 V2 留下的内部
   protected-path DACL snapshot。
4. 每个 invocation 有单独 runtime capability SID，只授予 invocation runtime。startup probe 使用
   ephemeral Workspace SID，不修改真实 Workspace ledger。
5. `networkMode=off` 从 current user 派生 write-restricted primary token，使用
   `CreateRestrictedToken` 的 `DISABLE_MAX_PRIVILEGE`、`LUA_TOKEN`、`WRITE_RESTRICTED`
   与 capability SID。
6. persistent Workspace capability ledger 只持久化根 allow ACE；Workspace member 不再生成或刷新
   名称级 deny。升级时在 Workspace mutex 下只对仍带旧 capability deny ACE 的 snapshot 执行恢复，
   已被宿主替换且不再带该 ACE 的对象不会套用 stale snapshot。
7. 只有同一次 invocation 在 `interactionMode=full` 下获得
   `filesystem=full_access, network=allow_all` sealed scope 时，native runner 才使用当前登录用户
   token 启动该 exact command，并先把它加入 kill-on-close/active-process-limit Job。它不调用
   `CreateProcessWithLogonW`，也不创建、登录或轮换 `KiteNet*`/其他本地账户。`network=allow_all` 配合
   `read_only` 或 `workspace_write` 必须由 TypeScript adapter 与 native runner 在 user script 前以
   `approved_network_requires_full_filesystem_scope` fail closed：不得为了 Schannel 静默放弃受限 token 的
   文件系统边界。
8. 上述同时获批网络与完整文件系统的 command environment 只保留当前用户 profile 中 Schannel 所需的 `APPDATA`、
   `LOCALAPPDATA`、`USERPROFILE` 等路径，再覆盖受信 runtime allowlist；这使 TLS 使用当前用户的
   credential store。此 exact `full_access + allow_all` invocation 还继承用户已有的标准 proxy variables
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
`read_only | workspace_write | full_access` sealed-scope projection；`full_access` scope 只能由当前
interaction/policy facts 产生，不能由一个旧 grant 隐式扩大。没有匹配 scope 时在 user script 前拒绝。
`full_access + allow_all` 的当前用户 token 不携带 Workspace synthetic SID；Workspace 外固定路径仍由
approved-filesystem guard 保护。V6 继承 V5
删除的 backend mode、AppContainer identity 与 staging 字段；任何 V1-V5 runner 都在 user script 前
fail closed。

`windows-runner.json` 的 V1 仍表示 manifest schema/file naming，不是 invocation protocol。
新 runner pin 必须固定 protocol V6、runner 0.8.3+、binary digest、Windows baseline 与 vendored runtime
digest。当前仓库 pin 已由 canonical Windows build 提升为 0.8.3/V6，并固定该构建生成的 binary
digest `sha256:bd83cc949494c9fde20b7b58a4f08a35055bfaa9b9f6a0eef5be11490bfb2ecd`；后续任何 native
runner 变更都必须重新运行同一可复现构建并提交新的 digest，不能只改 protocol、版本或 manifest 文本，
也不能复用旧 binary digest。
Windows candidate 的 standalone resolver 还必须把 `@kite-ai/builtin-runtime/sandbox` 及其他 workspace public
exports 直接映射到仓库 source，禁止经过 `node_modules/@kite-ai/*` symlink；否则 Bun 1.3.14 会因反斜杠
pretty path 崩溃，导致已验证 runner 无法进入候选包。release test 从 package exports 机械验证该闭包。

## 能力边界

local path 的 `WRITE_RESTRICTED` 通过 restricted SID check 限制写入，但 current user 仍可能拥有普通读取
权限。approved filesystem path 同样保留 `WRITE_RESTRICTED`、LUA 与 privilege stripping，使 read/execute
只服从 current user 普通 ACL，并让 restricted SID check 仅参与写访问；token 的 restricted SID 集合镜像
user/group SID 并加入 compatibility SID，同时保留 Logon/World SID。这样 GitHub runner toolcache 等只向普通用户
ACL 身份授予执行权的 system/toolchain binary 仍可运行；按 ADR-0132，Workspace 外固定路径不再对该 SID
安装 write deny ACE。approved token 与普通 Workspace token 使用同一
Logon/World/capability default DACL 初始化，确保 shell 创建的 pipe 与 Node/npm 等 descendant process
object 可由该 token 继续访问。只有带 `full_access + allow_all` sealed scope 的网络调用才改用当前用户 token，
以便 Schannel 读取当前 profile；因此它不保留 restricted-token filesystem ceiling，普通用户 ACL 成为该
exact 已审批 command 的文件权限边界，也不得安装该 token 无法命中的 temporary guard ACE。任何较小
filesystem scope 的网络调用均被拒绝，不能把 network approval 变成该 filesystem 扩权。
Job Object 提供进程树数量和终止边界，不单独作为 filesystem 或 network boundary。

该 backend 没有 structural network-off 或 arbitrary-descendant allowlist。按 ADR-0131，Workspace 内
`.env.*` 等名称不再需要动态 deny；ledger 属于 trusted host state，并只保留完整 Workspace root capability。
用户目录等 Workspace 外 protected path 不得写入该 ledger，因为 Workspace capability 在外部没有 allow ACE。
按 ADR-0132/ADR-0133，approved filesystem invocation 已在 Tool Policy 完成当前模式授权，runner 不再为外部固定路径
安装 guard deny ACE；compatibility SID 暂时保留以维持 protocol V6，且外部路径不进入 Workspace repair。

因此 `windows_restricted_token` 是 development backend：

- 可以开启 ADR-0121 定义的开发期 Full，但不能以此宣称 production Full qualification；
- 不能为 arbitrary Shell descendant 资格化 network-off 或 allowlist；
- 不再提供或要求 Workspace 内 `.env.*` protected-path deny；
- `productionSupported=false`，D-04 仍为 excluded。

Tool Policy 保持逐调用授权：可证明本地的 version query 投影为 `off`；网络命令和 uncertain script
经批准后投影为 `allow_all`；Windows 仅在 interaction/policy facts 明确给出对应 filesystem scope 时使用当前
登录用户 token，否则在 native runner 前 fail closed。这里的模式是 development scope projection，不产生域名 allowlist 或
production network evidence。

文件系统 effects 独立处理：`externalRead`、`externalWrite` 与 `uncertainEffects` 审批通过后与其他平台
相同投影 approved filesystem scope；Full 直接授权，Auto 模型选择批准、拒绝或请求真人审批，技术异常和
circuit breaker 转真人审批。
该 invocation 不准备或修改 restricted-token Workspace ACL ledger。canonical Workspace 内全部名称均允许；
普通临时目录和外部文件可在批准后执行；Workspace 外凭据、持久化入口和关键系统文件进入相同模式感知
授权，其他模式请求 exact user approval；授权后 runner 不再二次拒绝。关键 destructive 操作仍硬拒绝。
命令自身或宿主 ACL 失败仍原样返回。

## startup denial 与 no replay

TUI 静默预热不阻塞首帧、typing、timer 或 Working animation。bootstrap 把 executor
注册到统一退出协调器。退出或等待 `prepare()` 的当前
SessionRuntime 被取消时会中止探针，runner 清空 Job 并回收 ephemeral ACL；中止结果不缓存。setup gate
与预热并行，并在用户确认时 re-check readiness。

development/production App 在 user script 前确认 runner pin、OS baseline 或 token capability
等 essential capability unavailable 时，缓存 backend=`none`/mode=`denied`，不使用 host Shell。
该 denial 只表示受限执行不可用；Full 选择仍由 `interactionMode=full` 表达，实际执行在缺能力时
按 sealed scope clean fail closed。

一旦 user script 交给 native runner，它至多执行一次。non-zero exit、timeout、cancellation、runner
error、Job cleanup、ACL lease cleanup 或其他 command-time failure 都作为该 backend 的结果返回，不得
在 host Bash/cmd/PowerShell replay。production composition 始终使用 fail-closed executor。

## evidence 与错误分类

native runner 在低于 Windows 10 22H2 (10.0.19045) 时 fail closed。Win11 GitHub-hosted environment 是
runner build/Cargo/protocol、Local Provider 及成功 command dispatch conformance 的原生 evidence 来源。token、ACL
与 Job conformance 通过仍不能提升 strict network/protected-glob
或 production 资格。

正式 Platform Capability Probe 的 Windows 命令使用正常 persistent Workspace capability，而不是
startup probe 的 ephemeral Workspace SID，因此完整 Workspace read/write/execute 与 V3 legacy protected
snapshot migration 结论必须经过真实 ledger/DACL 刷新路径。probe Workspace 创建后立即固定 canonical identity，采集与 finally repair 必须共用该值，
不能让 Windows 8.3/长路径 alias 分裂 ledger。probe Workspace 仍是临时目录；采集结束时先调用 runner repair 恢复 snapshot、撤销 root ACE
并删除 ledger，再删除临时目录。资格 workflow 的 paths gate 必须覆盖 native runner、`vendor/isksh`、
Windows adapter 使用的 App composition、Builtin sandbox、Host lifecycle、SPI contract 以及 evidence scripts，不能让这些依赖单独变更而跳过原生
E2E/probe。

| 条件 | 必须的结果 |
| --- | --- |
| user script 前 runner pin/OS/token/cleanup structural capability unavailable | App 缓存 backend none/mode denied，不启动 host command；受限 scope clean fail closed，Full 不转成旧 grant |
| user script 开始后的 command/timeout/cancel/cleanup failure | selected backend fail closed；不 host replay |
| legacy protected snapshot migration 或 Workspace ACL/ledger recovery failure | fail closed 并保留 diagnostic |
| `full_access + allow_all` sealed scope + `interactionMode=full` | 当前用户 token 在 Job Object 中运行 exact command；不创建账户、不请求 UAC |
| `allow_all + read_only/workspace_write` | `approved_network_requires_full_filesystem_scope`，不启动 user script，不 host replay |
| none 请求受限 scope | disabled/rejected，并显示当前 backend 不可用；不 host fallback |
| windows_restricted_token 请求 Full | 允许开发期 Full；不改变 `productionSupported=false` 或 strict production evidence 要求 |

ADR-0120 开始实现 direct Workspace 的临时 AppContainer strict candidate：它不是 Windows 登录账户，
不请求 UAC，也不恢复 repository copy。默认零 capability profile 与已批准网络 profile 必须分离；在
offline network、Workspace 外 read/write/protected identity、Job/ACL/profile cleanup 和两入口 native
conformance 全部通过前，它仍不是可选择 backend，也不能用于 production Full qualification。开发期 Full
已由 ADR-0121 的 direct backend 语义提供。

按 ADR-0131，Windows restricted-token 开发 backend 不再尝试证明通用 Shell 对 Workspace `.git`
metadata 的独立 read/write deny；旧 ACL snapshot 会由 V3 ledger migration 恢复并删除。依赖该 deny 的
`brokered-git-r1` production qualification 固定 excluded，直到后续 ADR 建立不缩小 Workspace 的新证据模型；
typed broker schema 与 hostile repository 检查保留。按 ADR-0137，Windows raw Shell 先按 interactionMode
与 phase 选择 Workspace baseline：Building 使用 Workspace 读写，Planning 非 Full 使用 Workspace 只读；
baseline 不再因为命令名进入全量人工审批，已知 external/sensitive scope 才路由到 durable approval/Auto
review。命中 ADR-0134 read-only classifier 的命令仍可使用 hardened environment，并固定关闭 external
config、prompt、pager、optional locks 与 fsmonitor；该分类不跳过 mode/policy review。raw Git token 不被
硬拒绝，typed broker qualification 保持独立且不得由 generic process evidence 推导。
