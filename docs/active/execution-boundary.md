# Production execution boundary contract

状态：active

读取时机：修改 `ExecutionBoundaryV1`、production composition root、sandbox capability
projection、release-controlled execution policy 或对应 feature flag 时。

验证：`bun test tests/sandbox/execution-boundary.test.ts tests/sandbox/network-boundary.test.ts
tests/sandbox/network-boundary-concurrency.test.ts tests/runtime/tool-controller.test.ts
tests/config/features.test.ts tests/sandbox/status-projection.test.ts
tests/workspace/worktree-controller.test.ts tests/mcp-transport-boundary.test.ts
tests/mcp-transport-boundary-concurrency.test.ts tests/git-broker.test.ts
tests/runtime/git-tool-controller.test.ts tests/execution/workspace-filesystem-provider.test.ts`、
`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/sandbox-mode.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0051、ADR-0054、ADR-0061、ADR-0070、ADR-0097、`execution-platform-support.md`。

## Schema ownership

`src/core/sandbox/types.ts` 是 `ExecutionBoundaryV1`、逐维 backend capability strength、
qualification registry 和只读工具 effect contract 的类型来源；
`src/core/config/execution-boundary.ts` 是严格解析、canonical digest、单调收紧和技术能力评估的
规范实现。`src/core/config/execution-qualification.ts` 只从仓库固定路径读取 release-pinned
qualification registry，并校验 revision 和 digest；调用方不能提供 registry 路径、批准 digest
或 production qualification。同一 OS/Bun/backend/network admission key 只能有一个
qualification，resolver 也只接受恰好一个匹配。Digest canonicalizer 显式重建每一层字段，
使用与 locale 无关的 code-unit 排序；JSON 对象字段插入顺序不能改变结果。

用户、project config 和 CLI 不能提供 boundary。普通 `loadAgentConfig()` 不接受或投影
execution artifact，只服务现有开发入口。production composition root 必须使用
`loadProductionAgentConfig()`，同时提供 release profile 的 boundary 与 flag ceiling；只有
artifact ceiling 和合并后的 rollout flag 都为 `true` 才进入 sealed admission。任一层为
`false` 都只能收紧；显式 user、project、CLI/App 层按逻辑与组合，缺少全部显式 rollout 时默认
关闭，因此后层的 `true` 不能提升前层的 `false`。production loader 使用 boundary 对应的
canonical Workspace 加载 project config，不使用进程启动目录代替该 identity。

## Fail-closed admission

production root 在创建 Runtime、Shell、writer、Skill child 或 local stdio MCP 之前必须通过
`loadProductionAgentConfig()`；它内部调用 sealed `admitProductionExecutionBoundaryV1()`。
准入同时要求：

- flag 开启且 boundary 严格有效；
- boundary 与实际 Workspace 的 canonical key 一致；
- 仓库固定的批准 registry 对实际 OS release/version、architecture、Bun、backend 和入口给出
  精确 qualification；
- native probe 与 runtime resolver 共用 `readExecutionEnvironmentIdentityV1()`，并要求同一
  qualification 同时绑定 TUI 与 foreground CLI 入口证据；
- backend 按 filesystem、network、process-tree、child inheritance 逐维报告 `enforced`；Linux
  候选还单独报告 syscall-filter strength。该字段进入 sealed
  `ExecutionBackendCapabilitiesV1` 与 registry canonical digest；缺少 native negative
  conformance 或不是 `enforced` 时 admission 以 `backend_syscall_filter_unsupported` fail
  closed。Seatbelt 使用独立 policy 机制，该字段可为 `unsupported`。旧 raw
  `PlatformCapabilityEvidenceV1` 缺少新增可选字段时规范化为 `unsupported`，不得抛错或推断为已执行；
- production boundary 要求 sandbox 配置和 CLI/App runtime restriction 均未关闭，且当前不接受
  `full_access`；成功返回的 `ProductionAgentConfigV1` 把 sandbox 固定为 enabled，并携带
  release-approved qualification proof。

任一条件失败返回全 false capability surface，不进入审批。审批、`full` interaction mode 或
裸 shell fallback 都不能改变结果。

成功 surface 的 `network`、`process`、`write`、`shell`、`skillChild` 和 `localStdioMcp`
是彼此独立的能力轴，不得合并成一个“只要仍有 process 就全部披露”的条件。例如原生
`read_only` 可以保留受 sandbox 约束的 Shell process，但 `write=false` 仍必须在模型 disclosure
和 Runner dispatch 两层拒绝进程内 writer，`network=false` 同样拒绝进程内网络工具。两层门禁
都消费 Registry Capability Descriptor 的 declared/effective effects；Shell 的保守 `unknown`
descriptor 只由显式 `process + shell` surface 接管，实际 filesystem/network 继续由 native
sandbox 强制。带外部 path 参数的进程内文件调用在任意 production surface 下都拒绝，不能因
保留 process capability 绕过 canonical Workspace identity。

`read_only_only` 是独立受限 surface：registry 必须携带 digest 校验通过的非空工具 catalog；每个
工具都固定 `workspace_read + network:none + process:false + write:false + externalPath:false`。
其 capability surface 保留 catalog revision/digest、每个 descriptor revision 和完整 effect
contract，而不是只列 tool ID，并显式关闭 network、process、writer、Shell、Skill child 和
local stdio MCP。模型工具 disclosure 和执行 runner 都会把当前 builtin capability descriptor 的
revision/effects 与该 catalog 精确匹配；不匹配、外部路径或动态 MCP 工具均 fail closed。技术
fixture evaluator 只返回 `technical_evaluation` 标记，且不从 Core config
barrel 导出；production loader 只接受带 registry proof 的 `release_approved` decision。当前批准
registry 是空支持集，因此所有 production 配置加载都在返回可运行配置前拒绝；现有 TUI/CLI
仍是开发入口，不构成生产旁路。

## 单调组合与 identity

`tightenExecutionBoundaryV1()` 只执行权限交集/限制收紧；不同 Workspace 禁止组合。解析后的
Workspace realpath、排序去重后的 host allowlist 和所有安全字段进入
`computeExecutionBoundaryDigestV1()`。字段、Workspace identity 或有效 allowlist 变化都会改变
digest，使旧 release evidence 失效。

## Network projection and durable admission

存在 sealed `ExecutionBoundaryV1` 时，Runner 总是派生不可变 `NetworkBoundaryPolicyV1`。
`networkBoundaryV1=false` 只会把 policy 收紧为 `off`，不会回到开发期 `allow_all`。开启后，当前
唯一具备透明逐调用执行层的网络工具是进程内 `web_fetch`：每次 robots、正文和 redirect hop
都重新校验精确 allowlisted DNS host，解析全部实际地址并拒绝 IP literal、loopback、private、
link-local、metadata 与 reserved range；transport 使用已批准地址的 pinned lookup，且不消费
proxy environment。这里只承诺 host 级 admission，不承诺 URL path 隔离。

每个 allow/deny 决定都带独立 invocation/hop、policy/endpoint revision 和 digest，并在任何已
批准 socket 打开前通过 `network.admission_decided` 写入 Runtime。decision store、resolver 或
observer 不可用时返回 typed `controller_unavailable`；并发 sibling 不共享 receipt，某个 denial
或 controller failure 不会覆盖或取消其他 sibling 已持久化的决定。这些决定保存在对应 Tool Call，
Tool Result 只投影 policy revision、receipt digests 与失败码，不保存
响应正文。

远程 HTTP MCP 另有独立 content-egress gate，并以 `mcp.egress_decided` 保存脱敏 permit/denial
原因；它不等于本节的 DNS/endpoint transport admission。该 gate 已能阻止非空参数在没有单次
许可时进入 MCP Tool request；secret、受保护 credential path 或无法在固定预算内完成检查的参数
不允许请求/消费 permit。许可、digest 与协议发送共同使用 await 前捕获的 immutable JSON-safe
参数快照，调用方或 receipt callback 后续修改原对象不会改变 wire payload。nonce 的持久化唯一
冲突会先保存 `permit_replayed` denial，不会悬挂执行循环或退化为协议请求。该内容许可仍不替代
下述 transport admission；两者必须同时允许，任一缺失都发送零请求。

当前原生 backend 不向任意 Shell/Skill descendant 授予结构性直连网络边界。Remote HTTP MCP
具有独立的 transport boundary：
connection、inventory、resource、Tool、OAuth 操作均绑定 canonical Workspace、execution boundary
digest、run/profile identity、network policy revision、canonical endpoint/endpoint revision 与单次
invocation/tool-call receipt；实际 SDK fetch 对每个请求和 redirect hop 复用 network enforcer 的
DNS/private/allowlist/pinned-address 检查，并忽略环境 proxy。并发 sibling 不能复用一次 receipt。
但是当前 production TUI 没有可签发这些 receipt 的 App controller，因此仍在 Provider readiness
前 fail closed；这与当前空 production support set 一致，不是已经开放 remote MCP 的声明。

## Native filesystem projection

macOS Seatbelt profile 在生成任何 allow rule 前 canonicalize Workspace 与受控 runtime temp。
每次 invocation 使用独立的 `0700` runtime directory；executor 在返回前先请求终止已跟踪的
process group，未确认退出时结果 fail closed 并保留 runtime，确认后再以不跟随 symlink 的物理
遍历恢复 hostile mode/BSD immutable flag 并删除该目录，删除不能确认时同样 fail closed。最后一个
invocation 还会用不递归的 `rmdir` 回收空的共享 runtime 容器；并发 invocation 使容器非空时该步骤
安全跳过。并发调用不能共享 invocation 目录，writable temp 也不进入 executable-map
allow root。`workspace_write` 只允许 Workspace 与该 runtime root 写入；`read_only` 不允许 Workspace 写入。系统与当前 Bun/Node runtime 依赖只有
显式只读 root；除此之外的 Workspace 外 read/write/create/unlink、指向外部的 symlink，以及
Workspace 内 Agent/MCP 配置、credential、shell profile 等 protected path 均由 Seatbelt deny，
`checkDangerousPaths()` 只保留为 defense-in-depth。启用 ADR-0097 的精确
`brokered-git-r1` revision 时，通用 Shell 的 Seatbelt profile 恢复 Workspace `.git` 原生 deny，
Linux bubblewrap 同样以 `.git` 目录或 gitfile mask 拒绝 metadata；只有 App 注入的 typed Git broker
拥有受限 metadata 通道。旧 ADR-0070 Git shell 豁免仅保留给 feature revision 切换前的开发兼容路径，
不得进入 broker qualification。Shell child 会继承相同 profile。共享规则除 exact literal/subpath 外，还编译 ASCII 大小写不敏感的 anchored regex；因此
case-insensitive APFS/HFS+ 上的 `.GIT`、`.Agents`、`.ENV.*` alias，以及 case-sensitive volume
上按混合大小写实际创建的同名 identity，都会由原生边界拒绝。
Seatbelt 的 `#"..."` regex literal 直接消费正则反斜杠；profile generator 必须只转义该 literal
的引号 delimiter，保留 `\.` 等单反斜杠 regex token，不能复用普通 Seatbelt string literal 的
反斜杠转义。生成器测试同时要求单反斜杠模式存在、双反斜杠模式不存在。

密封配置还会从同一份 protected-path V1 定义编译平台无关 evaluator。每项访问都携带
canonical target、未 realpath 的 lexical Workspace identity 与 `read`/`write`/`execute` operation；
最近存在祖先先经 realpath，尚未创建的后缀再拼回，因此 `..`、Workspace alias、symlink ancestor
以及把 `.git`/`.env` 指向普通 Workspace 文件的 inward alias 都不能绕过。Workspace 外路径、
`.git`、Agent/MCP 配置、credential 与 shell profile 都返回 `deny`（`prompt` 也保持非执行终态，
直到存在单独的 typed approval protocol）；additional deny 与内建 deny 取并集，deny 在可选
allow root 前求值。内建 protected identity 使用保守的 ASCII 大小写不敏感比较，不能借
case-insensitive filesystem alias 绕过。PS-01 后 Tool Pipeline 在 grant 签发前固定 evaluator revision，
filesystem ToolSpec 在结果投影前应用同一 evaluator，Local Provider 再验证 canonical Workspace、path scope
与 no-follow target identity。
`read_file`、`write_file`、`edit_file` 和 search spec 通过
结构化 path-access 声明接入；Registry conformance 从完整 builtin tuple 派生所有
`filesystem!=none` spec。没有通用 path hook 的 `read_plan`、`read_skill_reference`、
`shell_execute`、`git_inspect`、`task`、`activate_skill` 必须分别登记由 typed Plan Artifact、Skill reference
allowlist、native sandbox、typed Git broker 的 shared protected-path/repository admission、child Harness 和 compiled inline/fork adapter 接管的闭合例外，因此新增
filesystem builtin 不能静默遗漏 evaluator。workspace-wide search 会剪枝 protected descendants，而不是只检查
搜索根。未携带 sealed boundary 的开发入口继续使用既有外部路径审批语义。

Seatbelt profile 直接消费该共享定义的目录/文件集合；Shell 的命令字符串扫描不再是权威 gate。
production execution surface 或 evaluator 任一缺失时，Runner 在任何 builtin adapter I/O 前拒绝。
普通 Task child 与 forked Skill 的文件工具都继承父级同一 `taskConfig` evaluator。local stdio MCP
manager 可接收同一 evaluator，并在 transport construction 前以 `execute` operation 拒绝
protected/outside cwd 与 path-like executable，再把 canonical cwd 和 path-like executable identity
交给 transport factory。sealed transport identity 固定把 `localStdioMcp=false`：在存在真实
sandbox-backed stdio factory、argv/runtime pinning 与 native child inheritance conformance 前，
即使 capability surface bit 被错误设为 true 也以 `transport_denied` 拒绝，生产不会构造本地 child。
typed Git/worktree controller 仍是共享 checkout / worktree placement 的 App 授权主体；模型 Git
操作必须走下述 broker，文件工具和通用 Shell 始终不能直接访问 `.git`。

### Governed Workspace filesystem seam

PS-01 将进程内文件工具的 production filesystem authority 固定到
`LocalWorkspaceFilesystemProviderV1`。Execution boundary 与 Policy 先确定 canonical Workspace、
protected-path revision、effective effect 和批准范围；Tool Pipeline 在 invocation/attempt durable ack 后
把这些事实密封进短时 grant。Provider 只验证 `workspace_only | approved_external` operation scope 与
target identity，不读取 mode、Policy 或 App 配置，也不能扩大授权。

mutation 的 prepare 只捕获 lexical/canonical/no-follow identity 与 preimage，保持零写入；私有 preimage
Artifact 和 `capability.filesystem_mutation_ready` 精确 ack 后才存在 single-use commit grant。commit 前
identity、preimage、expiry、cancel 或 final check 前的 symlink swap 任一不匹配都保持零文件写入。Unix
发布消费 pinned parent descriptor；final check 后的 parent swap 不能越界重定向，若因此失去 lexical terminal
certainty 则属于 commit-unknown。Windows 在 handle-relative backend 验收前 write/edit fail closed。不得尝试
旧 adapter 或 Local 二次 dispatch。旧 file/search 实现只存在于
`tests/helpers/` 差分 oracle；Fake deny/crash 也没有生产 fallback。该 seam 没有新增 feature flag，也不
改变 Runtime format epoch。

### Brokered Git access（ADR-0097）

`ExecutionCapabilitySurfaceV1` 只投影只读 `gitInspect`，并绑定精确
`brokered-git-r1` feature revision。Registry disclosure、Controller dispatch 与 native `.git`
deny/mask 必须以同一 revision 原子切换；只打开 feature boolean、只披露 Tool 或只改 sandbox
profile都 fail closed，generic process/read-only fallback 也不能隐式产生 Git capability。

`git_inspect` 只接受 `status | diff | log | branch_list` 的逐 operation 严格有界 schema；unknown/无关字段拒绝。path 必须是 literal，相对路径中的 pathspec magic、glob、casefold 与反斜杠形式一律在进程前拒绝。Core broker 在任何 Git
process 前验证 canonical repository/common-dir、Workspace 外受信 binary identity、受限 config、
attributes、replace refs、grafts 与 shared protected-path evaluator；无法证明安全时零 dispatch。
`core.excludesFile`、include/url/protocol/remote/credential 及其他可跨越仓库边界的 config 一律视为 hostile，且 broker 环境不得继承用户 Git 配置。`diff` 在 dispatch 前还要以有界历史/对象 provenance 证明请求路径从未由 protected 名称或 protected blob 派生；无法证明时只返回低信息量拒绝。每次 adapter request 都携带独立 stdout/stderr byte ceiling，App 以流式 UTF-8 安全读取并在溢出时终止 process tree。Unix adapter 在 timeout、取消或输出超限后还要在有界窗口内等待 detached process group 消失；只有系统返回 `ESRCH` 才记录 `cleanupConfirmed=true`，超时、权限错误或其他无法证明的结果继续 fail closed。
`.gitattributes`、`.git/info/attributes`、grafts、`refs/replace` 与 `packed-refs` 在读取前逐级验证 metadata boundary、拒绝任意 symlink；packed refs 中出现 replace ref 同样视为 hostile。
命令 argv 和环境由 broker 构造，禁用 system/global config、credential/askpass、hooks、filters、
pager、external diff 和可执行 attributes。`log` 只返回 hash/time 等 metadata，不读取 subject、blob
或 protected 内容。每次 terminal 产生绑定 repo、binary、schema、native-deny、operation 与可信
timing 的 typed evidence/receipt；App process adapter 只执行 broker 已准入的 invocation。

Git stage、commit 与远端 fetch/pull/push 不在当前模型工具表中；本地写操作留给用户或独立后续设计，不能由 `auto`、`accept_edits`、Shell 授权或 raw shell fallback 恢复。远端操作仍需独立 network/credential/descendant boundary；
Shell Git metadata denial 返回稳定 `nextCapability=git_inspect`，远端 Git 返回
`managed_network_setup_required`，二者都不得回退 raw shell。

三平台 probe 仅在 native metadata read/write deny 都为 enforced 后，才通过真实 App broker composition 与固定 binary 运行 positive/hostile；TUI/foreground CLI composition 仍是独立证据。probe 分别记录 native metadata read/write deny、broker positive/hostile 与 composition
identity。当前 macOS、Linux、Windows 都不能同时证明这些证据，因此 brokered Git production
qualification 明确为 excluded；开发 fixture 通过不产生 production support。
`qualified` evidence 还必须直接绑定真实 profile revision/digest、protected-rules digest、broker/schema revision、repository/executable/native-deny identity 与 invocation receipt UUID；由标签字符串临时哈希出的值不能作为资格证据。当前 probe 不拥有这组 release evidence，因此即使本地 positive/hostile 控制通过也保持 excluded。

`createSandboxExecutor()` 的 `unavailableFallback='fail'` 返回稳定拒绝而不返回裸 `shellTool`；
production consumer 必须使用该策略。现有开发 TUI/CLI 仍保留显式 legacy bare-shell fallback，
但它们不通过 production composition root，不能形成 production qualification。
裸 shell fallback 的说明只通过可选的 non-UI diagnostic sink 输出；TUI 不提供该 sink，避免
`[sandbox]` 等内部诊断污染正常终端渲染。需要命令行诊断时由 CLI 显式接收并写入 stderr。


### Unified sandbox startup downgrade

ADR-0077 and ADR-0080 give TUI and foreground CLI the same startup state machine on Windows,
macOS, and Linux. For sandbox-enabled flows, it caches a host Shell only when the unified resolver
finds the selected sandbox environment or a required enforcement capability unavailable before any
user script; ordinary preparation errors are not availability results. Host execution projects
backend `none`, keeps Full unavailable, and never counts as native evidence or production
qualification.

ADR-0081 将 windows_restricted_token 设为 digest-verified runner 可用时的默认 Windows development
backend。它遵循无 UAC 的 Codex 式路径：current-user WRITE_RESTRICTED token、capability-SID ACL 与 Job
Object 直接操作 canonical 真实 Workspace，不 staging/copy repository，normal path 不显示 UAC prompt。
它的 Bash/cmd/PowerShell fallback 仍受“sandbox environment 或必要 capability unavailable”的 startup-only
规则约束。

direct route 不是 ADR-0079 的 strict managed profile。它没有 structural descendant-safe network boundary，
也不能保证 dynamic root .env.* creation；因此永远不具备 Full qualification、不是 production supported，
也不能把请求的 full_access surface 变为 allowed。future elevated managed/projection profile 是独立
qualification 的更强 configuration。

A user script is executed exactly once. Non-zero exit, timeout, cancellation, cleanup failure,
or later runner failure never retries unsandboxed. A sealed
surface without Shell or with unsupported `full_access` remains a policy denial and cannot
downgrade.

Qualification is background work, not an input gate. The TUI projects pending qualification as
backend `none`, keeps Full unavailable, and accepts prompt input. Raw native execution remains
fail closed.
Linux bubblewrap 使用同一 `filesystemScope` 投影 canonical Workspace 的 rw/ro bind，并显式
绑定 invocation runtime。Linux runtime 清理另起只包含该 runtime 与只读系统工具的 mount
namespace；这只收紧开发实现，不构成 Linux production qualification。protected path、seccomp、
process-tree 与入口/child inheritance 未有完整原生证据前，Linux 仍 fail closed 为 `excluded`。
binary discovery 之前还会运行真实 PID/network namespace 最小启动探针；宿主禁止 namespace 时
backend 直接视为 unavailable，production 拒绝执行，cleanup 也保留未知旧 runtime 而不降级到
可能遭 symlink swap 的宿主物理遍历。

`src/core/sandbox/process-tree-capability.ts` 是 native process-tree evidence 的分离投影：
`hardCountLimit` 需要具名 limiter mechanism 与 native conformance；`terminationCleanup` 只表达
终止后残留确认。process group、PID namespace、Windows Job termination 或清理成功都不能单独
产生 `processTreeLimit=enforced`，所以 Seatbelt、bubblewrap 与 Windows `none` 均保持
hard-count `unsupported`，production surface 在 admission 阶段全关闭。Windows
`windows_restricted_token` 只在 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 真实生效（第 N+1 个进程创建
失败）且 Job 清空确认后投影 `windows_job_active_process_limit=enforced`；这不改变空支持集。
raw artifact 同时保留 `hardCountMechanism`；旧 V1 artifact 缺失时按 `none` 解释，
不能从 verdict 反推机制。通用布尔 projector 不从 sandbox barrel 导出，release producer 只能
读取当前保守投影。

## App-owned writer placement and status

`src/app/workspace/worktree-controller.ts` 是唯一拥有 Git/worktree authority 的 typed App
controller。共享 checkout 默认只读；只有用户在场且显式选择的 foreground TUI writer 可使用当前
checkout。D-09 继续排除 foreground Headless CLI writer；后台、定时、无人值守、并发和委派 writer
只有在 controller 开启时才可进入 identity-bound worktree，创建失败不得回退共享 checkout。
controller 要求 clean、精确 40-hex baseline，使用持久单 writer lease、opaque Runtime binding 与
ownership nonce；branch collision、Git/磁盘失败、crash recovery identity 不匹配全部 fail closed。
cleanup 只移除 identity 验证通过且 clean 的 controller-owned worktree；dirty、conflict、operation
lock 或 identity drift 都保留现场供人工恢复。它不 push、merge 或删除 branch，并关闭 checkout
hooks。

`src/app/release/execution-status.ts` 只投影已经通过 Core production admission 的有效状态：实际
sandbox backend/availability/fallback、filesystem scope、network mode 与 host 数量、protected-path
policy、controller worktree 状态以及 capability 的 typed disabled reasons。它不暴露 Workspace
路径、host 名、process limit、qualification proof 或完整安全 profile，也不产生 capability。
TUI 的 `/permissions` 只用于选择 interaction mode，不显示或授予 production boundary；CLI
`--execution-status` 在创建 Runtime、MCP 或 Skill 前输出状态并退出。CLI 直接启用
`executionBoundaryV1`/`networkBoundaryV1` 会在参数解析阶段拒绝，显式 `false` 仍可单调收紧。

运行中的 `/permissions full` 仍不构成 production boundary admission。它必须在 Kernel 的 live-control
事件入口重新验证 Full-qualified sandbox；失败时不改变 Runtime authorization 或 interaction mode。
