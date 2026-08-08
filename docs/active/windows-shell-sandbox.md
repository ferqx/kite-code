# Windows Shell 沙箱：direct restricted-token 与受管联网登录

状态：active

读取时机：修改 Windows execution backend、native runner protocol、restricted token/ACL/Job lifecycle、
受管 Online identity、Shell runtime policy、Windows filesystem/network boundary、Platform Capability
Probe，或 Windows Full/fallback UI 状态时。

验证：`bun test tests/tool-definitions.test.ts tests/tool-runner.test.ts
tests/sandbox/platform-backends.test.ts tests/sandbox/windows-restricted-token.test.ts
tests/sandbox/windows-network-setup.test.ts tests/sandbox/platform-capability-probe.test.ts
tests/sandbox/platform-capability-verifier.test.ts tests/sandbox/process-tree-limit.test.ts
tests/sandbox/app-sandbox-composition.test.ts tests/sandbox/execution-boundary.test.ts
tests/tui-exit-coordinator.test.ts tests/session-manager.test.ts tests/tui-reducer.test.ts`、
`bun run typecheck`、`bun run check:docs`。native runner
变更还必须运行 `cargo test --manifest-path native/windows-sandbox-runner/Cargo.toml` 和 release
script 指定的 Win11 native E2E/probe。direct backend E2E 为
`KITE_RUN_WINDOWS_RESTRICTED_TOKEN_E2E=1 bun test --max-concurrency=1
tests/sandbox/windows-restricted-token.test.ts`。需要实际创建/复用 Online 账户时，先通过 TUI onboarding
或 `bun run agent sandbox setup` 显式设置，再设置 `KITE_RUN_WINDOWS_MANAGED_NETWORK_E2E=1`。
Windows 10 使用 22H2 (10.0.19045) API/build baseline；本记录不声称 physical Win10 conformance。
runner evidence 在 Windows CI 中显式选择固定版本的 GNU toolchain，并通过
`bun run scripts/release/build-windows-runner.ts` 重映射 checkout/Cargo cache 路径、清除 PE 时间戳；
重新生成 manifest 后必须以 `git diff --exit-code` 证明提交的 runner pin 与构建产物一致。

相关：ADR-0074、ADR-0077、ADR-0079 至 ADR-0089，
`release/platform-capabilities/windows-runner-v1.json`。

## 当前 backend 选择

Windows 只有以下 runtime outcome：

| outcome | 选择条件 | Workspace 模型 | assurance 与 Full |
| --- | --- | --- | --- |
| windows_restricted_token | verified native runner 可用时的默认 development backend；已审批联网调用切到受管 Online 登录会话 | canonical 真实 Workspace，不复制 repository | lower-assurance hybrid；Full 不可用，production excluded |
| none / host Shell | 仅用户脚本前的 startup availability downgrade | 真实 host Workspace | 没有 sandbox evidence；Full 不可用 |

AppContainer backend、`KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL` 选择逻辑、private Workspace
staging、repository copy、预算 Worker 和 reconciliation 已由 ADR-0088 删除。设置旧环境变量不会改变
backend。该移除不降低 production 能力，因为实验路径从未取得 production qualification。

正常本地路径无需 UAC。TUI 在进入主界面前只读检查受管联网身份；缺失时显示 setup 选择，只有用户
确认 setup 才请求 UAC。foreground CLI 提供 `bun run agent sandbox status` 与
`bun run agent sandbox setup`。普通 Shell invocation 绝不创建或轮换账户；setup 未完成时，
已审批联网调用返回 `managed_network_setup_required` 并 fail closed。

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
7. 已审批 `allow_all` 时，受信 parent runner 通过
   `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` 切换到 `KiteSandboxOnline` 的非管理员登录会话。
   child 先加入 kill-on-close/active-process-limit Job 再 resume。Workspace/runtime 使用临时 ACL
   lease；existing protected paths 对 Online SID 使用显式 deny。
8. Online parent/child 使用拒绝远程客户端的随机 named pipe；DACL 只允许该账户、SYSTEM 与
   Administrators。cleanup 完成前不得转发 success receipt。
9. setup helper 在 machine-wide mutex 下创建或轮换账户，以 machine-scope DPAPI 保存密码，并最后
   提交 readiness marker。它只为 Online SID 配置 USERPROFILE 下明确允许的非敏感 read roots，
   排除凭据目录；普通 invocation 不修改 profile 祖先 ACL。
10. Online identity 不继承自己的 HKCU 代理。受信 native parent 在身份切换前读取发起用户 WinINet
   `ProxyEnable`/`ProxyServer`，仅把无凭据的 `localhost`/`127.0.0.1`/`::1` 固定端口
   投影为 proxy environment。该投影只用于已审批 `allow_all`；`off`、startup probe、远程代理、
   PAC 与带凭据代理都不继承。代理关闭、缺失、为空或不受支持时不产生错误，Online child 保持
   原有 direct network path。

runner 只使用 manifest 固定的 POSIX runtime 与最小 environment allowlist。可验证的 Bun executable
可通过 invocation runtime/PATH 暴露，但不会复制 repository。默认 command language 仍为 POSIX/Bash，
也可显式调用 cmd.exe、pwsh 或 powershell.exe。

Windows standalone candidate 会将 runner manifest、固定 runner 与 `vendor/isksh` runtime 保留在当前
managed candidate payload。激活的 `kite.exe`/`kite-tui.exe` 通过 install marker 定位该 payload；缺失或
digest 不一致使 backend 不可用，不会加载未固定的 host runner。

## protocol V5 与 manifest V1

adapter 与 runner 必须要求 native invocation `protocolVersion=5`。V5 只描述 direct
`windows_restricted_token` invocation，携带 development `off | allow_all` authorization
projection，并删除 backend mode、AppContainer identity 与 staging 字段。任何 V1-V4 runner 都在
user script 前 fail closed。

`windows-runner-v1.json` 的 V1 仍表示 manifest schema/file naming，不是 invocation protocol。
manifest 固定 protocol V5、runner 0.7.1+、binary digest、Windows baseline 与 vendored runtime digest。

## 能力边界

local path 的 WRITE_RESTRICTED 通过 restricted SID check 限制写入，但 current user 仍可能拥有普通读取
权限。approved Online path 使用专用非管理员 identity + 临时 ACL lease。Job Object 只提供进程树数量和
终止边界，不是 filesystem 或 network boundary。

该 backend 没有 structural network-off、arbitrary-descendant allowlist 或 future root `.env.*`
动态名称保证。static protected paths 的 deny ACE 与 durable snapshot 只是 defence in depth。ledger
属于 trusted host state；外部 ACL 修改后需要显式 repair，无锁快路径不会在每次调用审计整个 Workspace。

因此 `windows_restricted_token` 是 development backend：

- 不能开启 Full；
- 不能为 arbitrary Shell descendant 资格化 network-off 或 allowlist；
- 不能承诺 future root `.env.*` 的 production protected-path deny；
- `productionSupported=false`，D-04 仍为 excluded。

Tool Policy 保持逐调用授权：可证明本地的 version query 投影为 `off`；网络命令和 uncertain script
经批准后投影为 `allow_all` 并切换受管 Online 会话。这里的模式是 development authorization，
不产生域名 allowlist 或 production network evidence。

## startup downgrade 与 no replay

TUI 静默预热不阻塞首帧、typing、timer 或 Working animation。bootstrap 在 setup gate 挂载前把 executor
注册到统一退出协调器；gate 的 Esc、Ctrl+C 和 Exit 选择都走该协调器。退出或等待 `prepare()` 的当前
SessionRuntime 被取消时会中止探针，runner 清空 Job 并回收 ephemeral ACL；中止结果不缓存。setup gate
与预热并行，并在用户确认时 re-check readiness。

development entrypoint 只在 user script 前确认 runner pin、OS baseline、initial restricted child/token
等 essential structural startup capability unavailable 时，才可缓存 backend=none 并使用 host Shell。
该 downgrade 不是 sandbox evidence，Full 仍不可用。

一旦 user script 交给 native runner，它至多执行一次。non-zero exit、timeout、cancellation、runner
error、Job cleanup、ACL lease cleanup 或其他 command-time failure 都作为该 backend 的结果返回，不得
在 host Bash/cmd/PowerShell replay。production composition 始终使用 fail-closed executor。

## evidence 与错误分类

native runner 在低于 Windows 10 22H2 (10.0.19045) 时 fail closed。Win11 native E2E 是主要 evidence
environment。token、ACL 与 Job conformance 通过也不能提升 strict network/protected-glob 或 production
资格。

正式 Platform Capability Probe 的 Windows 命令使用正常 persistent Workspace capability，而不是
startup probe 的 ephemeral Workspace SID，因此 protected-path write 结论必须经过真实 ledger/DACL
刷新路径。probe Workspace 仍是临时目录；采集结束时先调用 runner repair 恢复 snapshot、撤销 root ACE
并删除 ledger，再删除临时目录。资格 workflow 的 paths gate 必须覆盖 native runner、`vendor/isksh`、
Windows adapter 使用的 Core tool/runtime 文件以及 evidence scripts，不能让这些依赖单独变更而跳过原生
E2E/probe。

| 条件 | 必须的结果 |
| --- | --- |
| user script 前 runner pin/OS/token structural startup unavailable | development entrypoint 可选择 cached host backend none；Full 保持不可用 |
| user script 开始后的 command/timeout/cancel/cleanup failure | selected backend fail closed；不 host replay |
| static protected-path ACL/ledger recovery failure | fail closed 并保留 diagnostic |
| approved `allow_all` 缺少 readiness，或 Online SID/login/ACL lease 失败 | 稳定错误并 fail closed；不显示 UAC，不用 current-user token 或 host Shell 重试 |
| none 或 windows_restricted_token 请求 Full | disabled/rejected，并显示非沙箱环境无法开启 full |

未来 strict Windows profile 需要 direct Workspace 上的独立 Offline/Online principal、
descendant-safe firewall/WFP、dynamic protected-name interception、durable recovery 与新的原生
conformance。不得把这些要求转换成普通 Shell invocation 的 UAC prompt，也不得恢复 repository copy。
