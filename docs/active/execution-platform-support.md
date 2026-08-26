# Production execution platform support

状态：active

读取时机：修改 sandbox backend、production execution admission、process-tree 限制、
network boundary、TUI/CLI composition root、Skill/local stdio MCP child 或平台发布矩阵时。

验证：`bun test packages/builtin-runtime/test/sandbox/platform-backends.test.ts tests/qualification/sandbox/cgroup-pids.test.ts apps/kite/test/sandbox/app-sandbox-composition.test.ts tests/qualification/sandbox/process-tree-limit.test.ts
tests/qualification/sandbox/platform-capability-probe.test.ts tests/qualification/sandbox/platform-capability-verifier.test.ts apps/kite/test/isolated/sandbox/execution-boundary.test.ts
apps/kite/test/sandbox/network-boundary.test.ts apps/kite/test/sandbox/network-boundary-concurrency.test.ts
apps/kite/test/git-broker.test.ts apps/kite/test/runtime/git-tool-controller.test.ts
apps/kite/test/isolated/execution/sandbox-execution-provider.test.ts`、
`bun run scripts/release/platform-capability-probe.ts`，以及
`bun run scripts/release/verify-platform-capability-evidence.ts`、
`.github/workflows/platform-capability-probe.yml` 的声明平台原生 artifact。

相关：ADR-0054、ADR-0061、ADR-0065、ADR-0068、ADR-0097、ADR-0116、ADR-0131、ADR-0137、`release/platform-capabilities/support-matrix.json`、
`docs/space/plans/2026-07-29-agent-production-execution-isolation.md`。

## SAQ-10 scope contract

三平台的发行兼容性与 effectful execution qualification 独立。UI 展示的 scope 必须等于 sealed Runtime boundary、native
backend evidence 和实际 enforcement；backend `unsupported|unavailable`、evidence 缺失或 projection 不一致都 clean fail
closed、host/provider call 为零。Full 只由 `interactionMode=full` 表达，不依赖第二个 approval grant，也不因受限 backend unavailable
而隐式降级。

Planning 非 Full 的 baseline 是 Workspace read-only，Building 非 Full 的 baseline 是 Workspace read/write；已知扩 scope 按
Accept/Auto 进入 user/reviewer queue。Plan + Full 直接执行 Full scope 但保留 Plan lifecycle。native denial 终结为
`sandbox_denied`，不换更宽 backend replay；只有 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 才允许一次 host
availability。

## 当前支持集合

当前 effectful execution 的 production-supported platform/backend 集合为空，D-04 已按“空支持集”
关闭。ADR-0068 明确该空集合只阻止对应 Shell、writer、MCP write、effectful Skill 等能力，不再阻止
生成和安装普通开源 TUI/CLI 候选包。候选包与 effectful capability 支持声明是两个独立结论：

Windows、Linux 与 macOS 同时是本地 Bun TUI/CLI 的发行目标，正式 GitHub workflow 统一 pin Bun `1.4.0`。发行/启动/PTY/路径/ACL/keyring
兼容性与 effectful execution capability 是两个 Gate：某个平台可以通过普通 TUI/CLI 发行验证，
但其 Shell、writer、Skill child 或 local stdio MCP 仍可因原生隔离证据不足而关闭。常规三平台
验证使用 GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025`，不要求 self-hosted Ubuntu；
Docker、WSL2 和架构模拟只作开发预检。

Runtime Protocol V1 不扩大该生产支持集合。shipped production consumer 仍只有本地 TUI 与用户在场的
foreground CLI；stdio 只作为 Desktop/test 父进程拥有的 reference child，loopback WebSocket/browser/Desktop
只作 development/reference/conformance evidence，均不进入 release manifest 或 platform support matrix。`.github/workflows/runtime-stdio-smoke.yml`
与 `.github/workflows/runtime-transport-qualification.yml` 的 macOS 15、Ubuntu 24.04、Windows 2025 矩阵只提供
qualification checks；KRSV1-07/09 的三平台 PR 结果返回前，必须标记为 pending，不能把 workflow 定义或本地测试
写成三平台通过或 production support evidence。

ADR-0097 的 brokered Git 仍有独立 typed schema、broker positive/hostile、binary/repository identity 与
TUI/foreground CLI composition 证据组。但 ADR-0131 已取消通用 Shell 对 Workspace `.git` metadata 的
名称级 read/write deny；依赖该 native deny 的既有 qualification 模型不再可满足，当前三平台
`brokeredGit.currentOutcome` 固定为 `excluded`。probe 不得用代码存在、generic read/process evidence 或
旧 protected-path artifact 替代新的治理决定。后续若要披露 `gitInspect`，必须先由追加 ADR 定义不缩小
Workspace 的资格模型，并取得新鲜 broker/schema/repository/executable/invocation receipt 与入口证据。

源码安装仍以 Bun 为包管理器；候选版本另使用 Bun standalone executable、manifest/checksum 和安全
安装器，不要求目标机预装 Node。开发依赖安装不再执行仓库自定义 root `postinstall`；Git hook 安装由
`lefthook` 包自身的安装生命周期负责，不下载仓库管理的备用二进制，也不修改 `node_modules` 内的上游文件。
lefthook 安装失败继续是非关键开发工具故障，不能阻断应用构建或发行验证。

| runner 候选 | backend 候选 | 当前结论 | 主要缺口 |
| --- | --- | --- | --- |
| macOS 15 | Seatbelt | excluded | fresh candidate artifact 证明 filesystem 与 network-off，但没有硬 process-tree 上限、cleanup、Skill/MCP 继承与入口组合证据 |
| Ubuntu 24.04 | none（bubblewrap namespace probe 不可用） | excluded | runner 不能启动所需 namespace；没有 filesystem、process-tree、继承与入口组合证据 |
| Windows 10 22H2+（Win11 为主要原生证据） | windows_restricted_token（默认开发 backend） | excluded | direct token 缺少结构性网络与 strict production 资格；V3 ledger migration 尚待新 runner artifact |

ADR-0081 的 windows_restricted_token 是 Windows 默认开发路径：固定 runner 可用时，普通
`networkMode=off` 调用以 restricted current-user token、capability-SID ACL 和 Job Object 直接运行
canonical 真实 Workspace，不创建 staging 副本。按 ADR-0110，只有明确 `interactionMode=full` 且 sealed scope 为
`filesystem=full_access, network=allow_all` 的调用
才直接使用当前登录用户 token 与该用户 Schannel profile；不创建本地账号、不请求 UAC、不保存密码或 readiness
state。无法由当前 interactionMode/endpoint 同时兑现网络与 filesystem scope 的调用必须在 user script 前 fail closed，不能借联网授权扩大文件系统
权限。这条网络调用仍进入 Job Object，但不再宣称 restricted-token filesystem ceiling。两条路径都不是 D-04 或
Full qualification。

direct token 是 lower-assurance backend。WRITE_RESTRICTED 只限制相应 SID 的写入检查；它不能证明
Workspace 外普通读取全部被拒绝，也不能为任意 descendant 提供结构性 network-off/allowlist。按 ADR-0131，
Workspace 内 `.env.*` 不再需要或允许单独 ACL deny。因此 productionSupported 仍为 false，outcome 仍为 excluded。
但 ADR-0121 将已选 windows_restricted_token 的 TUI/CLI Full 定义为开发期交互模式；它不改变该
production verdict。受限 backend=none 时只显示该 backend 的 unsupported/fail-closed 状态；Full 仍由
`interactionMode=full` 表达，不显示旧 grant，也不触发 host fallback。

ADR-0082/ADR-0101/ADR-0110 对齐 development 权限交互与 Windows TLS 可执行性：protocol V6 接受 Tool Policy
在 `interactionMode=full` 或 exact approval 后产生的 sealed scope，并要求 backend contract 明确其实际 token；更窄 filesystem scope 的
更窄 scope 被 runner 拒绝。精确 runtime version query 等可证明
本地命令继续投影为 `off`。该字段不表示 direct token 已经强制 network-off，也不改变 release capability
verdict 或 D-04 空支持集。ADR-0088 已删除 AppContainer、private staging 与 repository reconciliation。

### Unified startup downgrade

ADR-0100 另行定义 development approved-filesystem capability：审批通过的 `externalRead`、
`externalWrite` 或 `uncertainEffects` invocation 在用户命令开始前扩大所选 native backend 的文件系统
scope。它不是 startup downgrade、host Shell 或 native failure replay；三个平台保持相同产品语义，
且进程、网络与资源 sandbox 继续有效。此能力不能写入 capability probe 的静态 enforced 项，也不能
改变下表或 D-04 production support verdict。

ADR-0077、ADR-0080 与 ADR-0081 使 TUI 和 foreground CLI 在 Windows、macOS、Linux 使用同一
startup state machine。允许 host fallback 的开发入口只在用户脚本前确认 selected sandbox environment
或 essential structural startup capability unavailable 时缓存 host Bash/cmd/PowerShell/POSIX，effective
backend=none 且受限 capability 不可用；Full mode 仍由 interactionMode 表达，实际 boundary 不可用时执行 fail closed。若 static candidate 只有在 durable preparation intent 后才暴露不可用，App 还可
消费 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 后选择同一 host availability。缺失或损坏的
pinned runner、低于 API baseline 的系统、或 initial restricted child/token verification failure 都属于这种
用户命令启动前的 availability 情形。

windows_restricted_token 的正常 probe 和执行不扫描、复制或 hash 用户 repository；TUI 在首个可编辑
render 后异步启动 probe。

正式 Windows capability evidence 使用临时 Workspace 运行正常 persistent capability ledger 路径，
而不是 application startup 的 ephemeral preflight 模式；这样完整 Workspace admission 与 V3 legacy snapshot
migration/ledger refresh 才是运行时同构证据。证据采集结束必须显式 repair 临时 Workspace 的 DACL snapshot/root ACE/ledger
后再删除目录。`.github/workflows/platform-capability-probe.yml` 的 paths gate 同时覆盖 native source、
vendored `isksh`、Windows sandbox 直接依赖的 App/Builtin/Host/SPI 文件和 release evidence scripts。

backend 选中后，user command 一旦可能启动就绝不跨 environment replay。只有 typed
`backend_unavailable + pre_dispatch + cleanupConfirmed` 证明 native 用户命令未启动且 abandonment 已 durable
收敛时，ADR-0119 才允许 App 把同一条已获准调用交给 host Shell 一次。script failure、timeout、cancellation、
runner failure、ACL cleanup failure、reconciliation failure 和 process-tree cleanup failure 都是 selected backend 的
fail-closed result。host fallback 不是 isolation evidence，也不能改变 excluded production-support outcome。

### Windows 10 API 兼容性基线

ADR-0074 保留 Windows 10 22H2 (10.0.19045) 作为 API/build baseline。native startup gate 与 release
manifest 会在低于该 baseline 时 fail closed。Win11 是 priority native-E2E environment；不得声称未经测试的
physical Win10 behavior。该 baseline 不会让任一 Windows development backend 成为 production-qualified profile。

### native protocol 兼容性

ADR-0101 将 native invocation protocol 提升到 V6。adapter 与 runner 必须以 manifest 内固定的
`protocolVersion=6` 相互校验；V6 只描述 direct restricted-token invocation，显式携带 development
network `off | allow_all` 与 filesystem `read_only | workspace_write | full_access` sealed-scope projection，并删除 backend mode、AppContainer identity 与 staging
字段。只有 `interactionMode=full` 且 backend 明确支持 `full_access + allow_all` scope 时才可使用当前登录用户 token；更窄 scope fail closed，非网络
approved filesystem invocation 暂时携带 protocol compatibility SID，但按 ADR-0132 不安装 protected-path deny。
V1-V5 runner 必须在 user script 前 fail closed。
`windows-runner.json` 仍表示 manifest schema/file naming V1，不表示 invocation protocol。
仓库当前 release pin 已由 canonical Windows build 固定为 0.8.3/V6 及其对应 binary digest；adapter
仍必须拒绝 V1-V5 或 digest 不一致的 runner。native runner 改动后，只有同一可复现 Windows 构建重新
生成并提交匹配 pin，才能恢复可用性；不得回退旧协议或手工复用旧 digest。
当前 canonical digest 为
`sha256:bd83cc949494c9fde20b7b58a4f08a35055bfaa9b9f6a0eef5be11490bfb2ecd`。

固定证据来自
[Platform Capability Probe run 30579701659](https://github.com/ferqx/kite-code/actions/runs/30579701659)，
绑定提交 `a4bdf22aa7c2a987734524c278c4750e7b9faa96`。macOS arm64、Ubuntu x64 与 Windows
x64 artifact 均为 `excluded`、`productionSupported=false`；三个 artifact 的 archive digest
固定在 support matrix。它们不包含 TUI/CLI composition evidence，也不能产生 production
资格。

2026-08-01 的候选加固证据来自
[Platform Capability Probe run 30693651821](https://github.com/ferqx/kite-code/actions/runs/30693651821)，
绑定实现提交 `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`。该 run 不替换上述 D-04
固定证据或批准 registry，只验证最新候选实现仍安全排除：macOS evidence digest 为
`sha256:439b29a506a43d8ff684a289a0ee083fffff2ac08849798a2082299f78029590`，Ubuntu 为
`sha256:88e9de9a7480dc27bd651a477d5befd2ca3b3bdb1413b30b8d07cfdf24dcf176`，Windows 为
`sha256:7dfd1390fae758ac64d74476231e53dd4f5233bef6a5e8832fc324dcb6a82f7d`；三者均为
`excluded`、`productionSupported=false`，且 `hardCountMechanism=none`。因此 Task 1B.2/1B.3
以负向结果完成，但 production support set 继续为空。

## 准入语义

矩阵当前显式选择 `selectedNetworkMode=off`。`supported` 要求 filesystem allow/deny、
network-off、完整 process-tree 硬数量上限与 kill 后清理、TUI/foreground CLI 组合根，以及
`processCapabilitySurface` 声明为 `true` 的每一种 child inheritance 全部为 `enforced`。声明为
`false` 的 forked Skill/local stdio MCP 不会因 Shell 通过而继承资格。无旁路 allowlist 可以是
`unsupported`，但该平台此时只能支持 network-off profile；
需要 allowlist 的 profile 仍不可准入；若未来选择 allowlist，evaluator 必须改为要求
`network.allowlist=enforced`。`read_only_only` 只接受单独通过 conformance 的无进程
Workspace-bound 只读工具、network-off 和两个入口组合证据；当前不存在该 fallback。

backend discovery、sandbox 命令成功、顶层 shell invocation permit、PID namespace、
`--die-with-parent`、child 自然退出或 proxy 环境变量都不是对应能力的 enforcement evidence。
`ProcessTreeCapabilityEvidence` 把 hard-count limiter 与 termination cleanup 分开投影；只有具名的
cgroup pids、Windows Job active-process limit 或已接受等价机制同时通过 native conformance，
前者才能为 `enforced`。成功清理 process group/Job descendants 不会提升 hard-count verdict。
探针无法执行或不能证明时按 `unavailable/unsupported` 处理，最终结论为 `excluded`。
Linux backend detection 还会执行与真实 executor 相同的 PID/network namespace 最小启动探针；
只有 binary 在 PATH 上但宿主禁止这些 namespace 时投影为 `backend=none`，而不是创建随后必败的
runtime 或把 binary discovery 当成可执行边界。
`outcome` 只是技术能力分类；探针固定输出 `productionSupported=false`，不能自行完成治理签署。
即使某 runner 的技术项全部为 `enforced`，也必须由新的追加 ADR、新鲜证据与独立 release
gate 才能改变已关闭 D-04 的空支持集并产生 production support 声明。`backend=none` 不可能产生进程型
`supported`，只能在另行验证的无进程 fallback 条件下产生 `read_only_only`。

当前 macOS 本机增量 probe 已能证明 Workspace read/write、Workspace read-only、Workspace 外
read/write、symlink escape、network-off 和
shell descendant filesystem inheritance；executor 还使用逐 invocation、`0700`、结束清理且不
共享的 runtime temp，返回前请求终止已跟踪 process group；未确认退出时 fail closed 并保留 runtime，
确认后才以不跟随 symlink 的物理清理恢复 hostile mode/BSD immutable flag，删除不能确认时也
fail closed。这些只是未固定的开发 evidence。ADR-0131 之后，Workspace 内
`.GIT/config` read 与 `.ENV.TEST` write 必须正向通过；旧 run `30705493919` 的名称级负向场景已经过时，
不得作为当前实现 evidence。按 ADR-0132，旧的 Workspace 外 protected identity native deny 场景同样过时；
新证据必须证明敏感访问未经 Policy approval 不 dispatch、批准后 sealed scope 不被 native backend 二次拒绝，
但本次 profile 变化尚无绑定当前 source 的 release-pinned native artifact。
Seatbelt 没有实现并
证明每次 Shell invocation 的硬 process-tree 数量上限，forked Skill/local stdio MCP 与两个
production composition entrypoint 也尚未形成 native evidence，因此 outcome 仍必须是
`excluded`、`productionSupported=false`。

Task 1B.4 的进程内网络控制器已能对 `web_fetch`
逐 invocation/hop 执行精确 host allowlist、
DNS 实际地址检查、manual redirect 复查、endpoint revision 与 pinned socket，并在 dispatch 前
持久化 allow/deny receipt。该控制器不依赖 proxy environment，但也不能约束任意 descendant。
因此所有候选平台的 Shell/Skill descendant 仍无直连网络。Remote HTTP MCP 已有逐 invocation
transport/endpoint admission 实现，但当前 production TUI 未提供 receipt controller，local stdio 也因
缺少 native child conformance 明确排除；没有平台因此进入支持集。

Linux bubblewrap 的开发边界现已把 canonical Workspace 按 `workspace_write` 或 `read_only`
分别投影为 rw/ro bind，并把逐 invocation runtime 显式 rw bind；runtime 清理在只暴露该 runtime
和只读系统工具的独立 mount namespace 内执行，避免 nested symlink 把宿主清理重定向到
Workspace 或其他宿主路径。Ubuntu workflow 区分“namespace probe 可用并运行真实 executor”与
“runner 禁止 user namespace 因而明确排除”；后者保持 `backend=none`，不能用绿色 workflow
伪装 bubblewrap native qualification。probe 还单独投影 bubblewrap `syscallFilter` 强度；vendored
binary 存在但没有 negative syscall conformance 时仍为 `unavailable`，并产生稳定 limitation。
审批前 Policy/dispatch boundary、审批后 control-root 隐藏、syscall filter、硬 process-tree 上限和完整 child/入口继承未证明时，Linux 结论
继续是 `excluded`。

当前本地增量实现把 TUI 与 foreground CLI 收敛到同一个 App sandbox composition root，并为
Linux 候选已加入带 Runtime 唯一 `--unit=...` 的 `systemd-run --user --scope` + cgroup v2 `TasksMax`
argv-only contract，以及 strict exact-unit/path、kill-all、`populated=0`/空 `cgroup.procs` candidate parser；
但当前 dispatch record 不能在 GO 前 durable ack ControlGroup，也不能持久化 empty receipt，因此 Local
Provider 对该 hard-count plan 保持 `cgroup_pids_cleanup_authority_unavailable`，不会启动 scope。候选
hard-count native probe 同样保持 `unsupported`、整体 `excluded`，而不是把二进制/controller presence 当成证据。候选
capability surface 只声明 Shell；forked Skill 和 local stdio
MCP 明确为 false。GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025` matrix 是该组原生
平台证据的唯一 authority；required job 必须在当前 head 上真实运行并上传经独立 verifier 校验的
不可变 evidence/verification artifact。本地测试或代码存在不能替代该 artifact，也不能提前改变
`excluded`/空支持集结论。PS-02 的实现验收与平台能力准入分开：没有绑定当前 head 的成功 Actions
run 时，计划状态只能写 `waiting_ci`，不能把 workflow 存在写成 passed。allowlist 不会映射为 development `allow_all`；App composition 对 descendant
allowlist 继续 fail closed。

绑定提交 `28e857f8f41913feee5eacd17a2e61fe6cbb439e` 的
[Platform Capability Probe run 32096568806](https://github.com/ferqx/kite-code/actions/runs/32096568806)
已在 `macos-15`、`ubuntu-24.04` 与 `windows-2025` 三个 Required job 上通过原生
conformance、probe、独立 verifier 与 artifact upload，因此 PS-02 的实现/负向平台证据验收已完成。
三份 evidence 仍分别是 `excluded`、`productionSupported=false`：macOS digest 为
`sha256:ba0016cc5d92e544e05fc9ce4f2aed5929134f3a20a59d2a576247a56b5dcff4`，Ubuntu 为
`sha256:9023330ff608f959aeaadc529299f0074051bda31e21b1dfdd9ec0d914d6c077`，Windows 为
`sha256:35d2422de603a53b191e047c02d55a152fa8c6d6f1809228902e33d369205548`。这只消除
`waiting_ci`，不改变空 support set。当前版本已移除 evaluation-only Linux diagnostics；平台支持只消费本页列出的
production contract tests、原生 probe 与 verifier artifact。未来诊断必须重新建立独立计划，不能恢复旧评测脚本。

## ExecutionBoundary schema 与 composition gate

`ExecutionBoundary` 由 Builtin sandbox contract 冻结，App config 只负责 production 解析：filesystem 只允许
`read_only | workspace_write | full_access`，network 只允许 `off | allowlist`，local/private
network 固定为 `false`，process-tree 上限必须是有限正整数。Workspace root 在解析时使用真实
路径 canonicalize，并与 Workspace Trust 共用 `canonicalWorkspaceKey()`；allowlist 只接受精确
DNS host、统一小写/排序/去重，不接受 URL、IP literal 或空的 allowlist 模式。

边界组合只能收紧：filesystem scope 取更小权限、allowlist 取交集（空交集变成 network off）、
protected policy 取 deny、process-tree limit 取更小值、sandbox required 取逻辑或、unavailable
fallback 取 fail。不同 canonical Workspace 的边界禁止组合。

production composition gate 不接受单一 `sandboxAvailable`，也不接受调用方传入 raw
`supported | read_only_only`。它只读取
`release/platform-capabilities/approved-execution-qualifications.json`，校验固定 revision/digest，
再按实际 OS release/version、architecture、Bun、backend、network mode 和 TUI/foreground CLI
入口精确解析 qualification。probe 与 resolver 共用 canonical environment identity producer，且
Windows identity 直接读取 Runtime 的 OS version API，不启动 PowerShell/CIM 子进程，避免冷启动或
runner 负载把 production admission 变成无界同步等待；native evidence 与 resolver 仍消费同一值。
每个可批准 qualification 必须同时包含两个入口的 composition evidence。qualification 内逐维固定 filesystem、network、完整 process tree、
child inheritance 和 verified in-process read-only strength。flag/artifact 缺失、Workspace 不匹配、
`full_access`、环境无匹配 qualification 或任一必需维度 `unsupported` 时 capability surface 全部
关闭；同一环境 admission key 重复也按歧义拒绝，不能由 registry 文件顺序选择首项。

`read_only_only` 还要求 digest 校验通过的非空 tool catalog；每个 tool contract 明确禁止 network、
process 与 write。原生 `externalPath=false` 仍关闭进程的 Workspace 外路径，但 ADR-0118 的 governed
filesystem read 可由独立 Provider `external_read` scope 读取任意有效路径。准入 surface 保留 catalog
revision/digest、descriptor revision 与 effect contract，供后续 tool disclosure/execution 对照，
不能只按相同 tool ID 放行。当前 builtin disclosure 与 runner 已执行该匹配，并拒绝动态 MCP、进程
external path 与所有 writer；governed read/search 的外部路径由 Provider scope 独立验证。该 surface 的
shell、writer、Skill child 和 local stdio MCP 始终关闭。

对未来非空的原生 `supported` qualification，surface 各能力轴同样独立执行：例如
`filesystemScope=read_only` 可以保留受 native sandbox 约束的 process/Shell，但模型披露和
Runner 都必须按 descriptor effects 拒绝进程内 writer；`network=off` 拒绝进程内网络工具，
governed file read 对 Workspace 外路径仍只使用 observe-only `external_read`；external mutation 需要
writer surface 与 exact approval，不能由只读 surface 或普通审批提升 capability ceiling。

`loadProductionAgentConfig()` 是 App composition root 必须使用的配置准入入口，并在返回
任何可供 Runtime/进程使用的配置前完成 sealed gate；它不改变当前开发 TUI/CLI。当前静态
support matrix 与批准 qualification registry 都是空支持集，1B.1 schema 或技术评估 fixture
不能自行提升为 release approval。未来改变 registry 必须绑定新的固定 evidence/manifest，不能
从用户、项目、CLI 或普通 App 调用参数构造。

production loader 按 boundary 的 canonical Workspace 读取 project config，并将 user、project、
CLI/App 的 rollout 与 sandbox restriction 按 deny-wins 组合。`sandbox.enabled=false` 或
`--no-sandbox` 等价 restriction 必须在 composition 阶段拒绝，不能获得 shell/process surface；
成功的 production config 固定 `sandbox.enabled=true`，后续入口必须直接消费该 sealed config。

PS-02 后三种 native backend 共享 `SandboxExecutionProvider` 协议，但共享协议不代表三者当前都可进入
production execution。composition 的 startup discovery 只解析静态候选；bubblewrap/cgroup 等会启动进程或申请
资源的 usability probe 必须等 allocating preparation intent durable ack 后才由 Runtime lifecycle consumer
执行。RM-13 后 consumer 只验证 durable identity 并调用 `@kite-ai/runtime-host` 的唯一 process supervisor；
Provider 不启动进程，ready 与 dispatch durable ack 之前也没有 user-command spawn。

App composition 的 preparation abort 不依赖平台 probe 主动观察 `AbortSignal`：一旦 controller 轮换，当前
`prepare()` waiter 必须立即以 typed abort 收敛，下一次 `prepare()` 重新执行 discovery。旧 probe 的迟到结果或异常
仍由组合层消费以避免未处理 rejection，但不得写入 cache、选择 backend 或触发 host/native dispatch。该边界保证
Windows 等平台的阻塞式 discovery 不能占住 Runtime shutdown 或 Actions workflow，同时保持 discovery allocation-free。

当前 Local Provider 对 Darwin Seatbelt 返回 `seatbelt_descendant_containment_unproven`：process group 无法覆盖
`setsid`/detached descendant，不能据此提交 cleanup success。Windows restricted-token preparation/runtime codec
使用 protocol V6 的严格 framed request/receipt 验证：allocating admission 在 durable intent 后创建唯一 runtime，
返回 immutable transport；Runtime consumer 在 ready/dispatch ack 后把 runner 交给唯一 Host spawn primitive，且仅在 Job empty、ACL revoke
与 runtime cleanup 皆确认后提交 disposal。`filesystem=full_access`/`network=allow_all` 仍只是精确 invocation 的 development execution projection，
不提供 strict network 或 production Full 资格。只有 Linux
bubblewrap 的 workspace-scoped confinement 是当前可继续验证的候选；它仍需 native PID namespace/cgroup、完整
descendant exit 与入口组合证据，不能由本机静态/单元测试升级。旧 Windows direct executor 不再是 production
或 public barrel 入口。此 seam 不改变 qualification registry，当前空支持集仍为空。

Darwin 的 native negative conformance 还会在
`apps/kite/test/isolated/execution/posix-supervisor.test.ts` 中让命令通过 `/usr/bin/python3` 调用 `setsid()` 并留下独立
session descendant；即使 supervisor 的 PGID 被终止，测试也必须得到
`cleanupConfirmed=false`，并回收该 fixture。系统 `launchd.plist(5)` 的
`AbandonProcessGroup=false` 只承诺终止与 job 相同的 process group，`sandbox(7)` 只描述新进程继承
sandbox restriction；二者都不是 detached/session descendant 的 owner/descriptor authority。
`launchctl(1)` 的 service `print` 输出也明确不是稳定 API。因此 Foundation `Process`、launchd 同 PGID
清理或 `proc_pidinfo` 身份读取都不能提升 Darwin 资格；没有新增原生 authority 前，allocating
Seatbelt 继续 blocked/fail closed。
`.github/workflows/platform-capability-probe.yml` 的 PR path gate 也覆盖
`packages/builtin-runtime/src/sandbox/**`、`packages/runtime-host/src/**`、
`packages/runtime-spi/src/sandbox-execution-provider.ts`、`apps/kite/src/sandbox/**` 与平台 probe
脚本和 `tests/execution/**`；macOS required job 只运行 Seatbelt profile、Provider fail-closed contract 与
POSIX supervisor detached/session negative/conformance，不再把旧 direct Seatbelt executor 的成功执行当作
资格 oracle；Linux 运行对应 native bubblewrap candidate，三平台共同运行 `sandbox-execution-provider`
contract。该 CI 运行只产生非生产候选 evidence，不改变当前空支持集。

Windows 代码物理拆为 Builtin-owned no-spawn `packages/builtin-runtime/src/sandbox/execution/windows-preparation.ts`
与仅由 Runtime consumer/recovery 导入的 `windows-runtime.ts` lifecycle adapter；后者只能调用 Host spawn
primitive。静态门禁检查 Local Provider 的完整依赖闭包，不能靠间接 helper 隐藏 spawn。Local Provider
生成 transport 但不启动进程；当前
Provider evidence 不把 direct restricted-token 尚未由 accepted qualification 证明的 Workspace 外 read、结构性
network-off、syscall filter 或 process-tree hard-limit 维度标为 enforced；consumer 必须与 sealed expected
capability evidence 精确比较，不能从 runner 可发现性推断升级。Windows required native conformance 只在
acknowledged preparation intent 后确认 actual restricted-token command dispatch、`disposed=true` 的 disposal
receipt 与 Local Provider 零 spawn；runner build/Cargo/protocol evidence 与此 conformance 一起证明 development
sandbox 可用，但不能解释为 production support。

## PS-02 原生证据边界（ADR-0116）

PS-02 的 protocol、Pipeline、allocating lifecycle、Host-owned spawn、recovery 与 no-bypass
实现可以由定向 contract/conformance 测试验收；当前开发机不是三平台原生证据来源。原生平台资格只由
`.github/workflows/platform-capability-probe.yml` 的 required GitHub-hosted matrix 提供。矩阵 job
必须先通过声明的 native conformance，再运行 probe、独立 verifier 与 `if-no-files-found: error`
的 artifact upload；任一 required step、source identity、canonical digest 或 artifact 缺失都使 job
失败。Linux cgroup descendant cleanup 与 full-chain 仍是显式 opt-in candidate-only diagnostic，不能
冒充该 evidence。
Cross-platform exclusion contracts 在每个 runner 内固定 `max-concurrency=1` 并有 10 分钟硬上限；尤其
Windows 不得让多个 Bun sandbox/process lifecycle fixture 并行持有 native handle，测试完成后进程不收敛
也必须以 timeout 失败，不能无限占用 matrix 或跳过后续 Cargo/native E2E。

该证据边界不改变当前 backend 的 fail-closed 行为或 production support 空集。workflow 配置、fake/DI、
Docker、WSL、emulation 与本机非目标 OS 均不能宣称某次原生 Actions run 已通过；未绑定当前 head 的
成功 run 只能记录为 `waiting_ci`。

## Evidence 生命周期

探针 JSON 记录实际 OS release/version、architecture、Bun、backend、逐项 verdict、限制和
canonical digest。静态 support matrix 当前为 `accepted_empty_support_set`。任一 backend、
profile、composition root、runner image 或边界实现变化都需要新 evidence；只有新的追加 ADR
与独立 release gate 才能加入非空生产支持项。

GitHub-hosted evidence 还绑定 repository/head/ref/workflow ref/workflow SHA/run ID/attempt 与封闭
runner class：`macos-15-arm64-github-hosted`、`ubuntu-24.04-x64-github-hosted`、
`windows-2025-x64-github-hosted`。缺任一来源字段或未知 runner class 时 probe 直接失败；WSL2、
Docker 或 self-hosted 结果不能伪装成上述 class。

workflow 还绑定 numeric repository ID，并在上传 artifact 前调用独立 verifier；expected source 来自
GitHub workflow 环境，不从待验证 JSON 自报。verifier 对 top-level、source 和每个嵌套对象执行 exact-key
检查；producer 以 exclusive-create 写入无尾随空白的 canonical JSON bytes，verifier 再重建 digest、outcome
与 limitations，并固定拒绝 `productionSupported=true`。当前 foreground CLI/TUI
入口探针固定 `unavailable`，直到入口拥有的真实集成测试能注入断连/取消并证明同一 composition root；
普通函数调用不能伪造该 evidence。cgroup TasksMax 只能投影 hard-count，cleanup 在 unit-owned cgroup
empty/populated verifier 完成前固定不通过；当前代码只保留未接入 production 的 strict candidate seam，
且对 unit/path 消失或无法 durable 绑定一律 fail closed。process group 自然退出或 `setsid` 逃逸不能当作
零 residual 证明。

同一 workflow 的跨平台 exclusion contract 使用 workspace-relative、由 Bun 执行的 marker fixture；不得把
未引用的宿主绝对路径直接拼入 shell 命令。这样 Windows Git Bash/cmd 与 POSIX shell 都实际验证 marker
创建或未创建，路径语法差异不能造成正向假失败或把 release-boundary bypass 隐藏成负向通过。

`scripts/release/execution-boundary-smoke.ts` 与
`.github/workflows/execution-boundary-conformance.yml` 把当前空支持集带入 actual synthetic artifact
smoke：三个 target 只能输出 `excluded`，八类 adversarial contract 只能输出
`excluded_not_admitted`，report 固定 `productionSupported=false`、supported count=0、
`distributable=false`。默认分支
[run 30739946155](https://github.com/ferqx/kite-code/actions/runs/30739946155) 已在 head
`dc64d25d67c9e40330676668b5f039872d04269a` 生成 macOS 15、Ubuntu 24.04 与 Windows 2025
三个 artifact；独立 verifier 重建 canonical/report digest、检查 3 target/8 case，并对三个实际
synthetic bundle 完成 bootstrap verification。Task 1B.9 因此以负向 conformance 完成并唯一产生
`MS:1B-DONE`。该 milestone 只证明 exclusion 和 fail-closed contract，不改变 D-04 空支持集，也不
产生 production qualification 或可分发制品。完整身份见
[Phase 1B 完成记录](../space/execution/completed/2026-08-02-agent-production-phase-1b.md)。

三平台 conformance 的测试夹具必须只依赖 runner 上可移植、可规范化的身份：临时路径按
canonical native path 比较，不假定 POSIX `/tmp` 或未规范化的短路径；需要生成提交或 merge
状态的 fixture 显式提供本地 Git author/committer identity；恢复 baseline 内容时直接恢复已知
blob bytes，不继承宿主 `autocrlf` 或 filter。上述约束只消除 runner 假设，不改变任何 admission、
excluded verdict 或生产支持声明。

上述 workflow 的第三方 Actions 全部固定到 immutable commit SHA，并由 release workflow contract
test 阻止 tag 回退。App worktree controller 的 Git 子进程使用最小环境，不继承宿主 credential/
askpass/SSH/proxy 等任意变量，隔离 system/global config，并禁用 hooks、fsmonitor、external diff/
textconv。controller 以 `worktree add --no-checkout` 建立 worktree，再从 Git tree 读取有界 regular blob
并直接写入，结构上不调用 smudge/process filter；tracked `.gitattributes`、common-dir
`info/attributes`、repo-local `filter.*` 或 config include 声明都会在 materialization 前后拒绝。
首次拒绝检查发生在任何 `status`/`diff` 等 worktree-aware Git 命令之前，避免 stat-dirty tracked
file 让 Git clean/process filter 在 admission 失败前执行。
Git replacement objects 在最小环境中固定禁用；common-dir replacement refs、packed replacement refs
或 legacy grafts 存在时 baseline admission 直接拒绝。单文件、总字节与文件数量都有显式上限。
`provisioning` 记录只保留给 operator 诊断，不能经 `recover()` 自动提升为 `active`；必须显式丢弃并
重新创建，只有已经 active 的 worktree 才能轮换 recovery lease。

Review handoff 对 tracked 内容使用 binary diff，对 untracked owned regular file 生成有界、SHA-256
绑定、base64 binary-safe 的 `KITE_UNTRACKED_FILE_` 内容记录。symlink、特殊文件、硬链接、超限、
owner/path/前后快照变化全部 fail closed；changed-files 只有文件名而没有内容的 handoff 不再成立。
