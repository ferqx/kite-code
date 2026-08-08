# Production execution boundary contract

状态：active

读取时机：修改 `ExecutionBoundaryV1`、production composition root、sandbox capability
projection、release-controlled execution policy 或对应 feature flag 时。

验证：`bun test tests/sandbox/execution-boundary.test.ts tests/sandbox/network-boundary.test.ts
tests/sandbox/network-boundary-concurrency.test.ts tests/runtime/tool-controller.test.ts
tests/config/features.test.ts tests/sandbox/status-projection.test.ts
tests/workspace/worktree-controller.test.ts tests/mcp-transport-boundary.test.ts
tests/mcp-transport-boundary-concurrency.test.ts`、
`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/sandbox-mode.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0051、ADR-0054、ADR-0061、ADR-0070、`execution-platform-support.md`。

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
或 controller failure 不会覆盖或取消其他 sibling 已持久化的决定。Runtime schema v21 保留 v20 的这些
决定保存在对应 Tool Call，Tool Result 只投影 policy revision、receipt digests 与失败码，不保存
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
遍历恢复 hostile mode/BSD immutable flag 并删除该目录，删除不能确认时同样 fail closed。并发调用不能共享该目录，writable temp 也不进入 executable-map
allow root。`workspace_write` 只允许 Workspace 与该 runtime root 写入；`read_only` 不允许 Workspace 写入。系统与当前 Bun/Node runtime 依赖只有
显式只读 root；除此之外的 Workspace 外 read/write/create/unlink、指向外部的 symlink，以及
Workspace 内 Agent/MCP 配置、credential、shell profile 等 protected path 均由 Seatbelt deny，
`checkDangerousPaths()` 只保留为 defense-in-depth。ADR-0070 起，seatbelt executor 对 git 命令
豁免 Workspace `.git` 目录的原生 deny，并放行用户 git config 与 `/var/select/developer_dir`
CLT shim 解析（详见下文 Git access）；直接 `.git` 访问仍由 tool-policy evaluator 与
`checkDangerousPaths()` 拒绝。Shell child 会继承相同 profile。共享规则除 exact literal/subpath 外，还编译 ASCII 大小写不敏感的 anchored regex；因此
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
case-insensitive filesystem alias 绕过。Tool Runner 在审批前执行一次，并在异步 `beforeDispatch` hook 返回后、旧内容
预读/pre-image capture 前重新求值；Registry dispatch 在 `spec.execute` 前再重复一次。
`read_file`、`write_file`、`edit_file` 和 search spec 通过
结构化 path-access 声明接入；Registry conformance 从完整 builtin tuple 派生所有
`filesystem!=none` spec。没有通用 path hook 的 `read_plan`、`read_skill_reference`、
`shell_execute`、`task`、`activate_skill` 必须分别登记由 typed Plan Artifact、Skill reference
allowlist、native sandbox、child Harness 和 compiled inline/fork adapter 接管的闭合例外，因此新增
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
typed Git/worktree controller 仍是共享 checkout / worktree 写操作的唯一 App 授权主体；seatbelt
边界（ADR-0070）放行 git 命令对 Workspace `.git` 的原生访问，但不会向模型通用文件工具或裸
shell 命令文本开放 `.git`（tool-policy evaluator 与 `checkDangerousPaths()` 仍拒绝）。

### Git access（ADR-0070）

seatbelt profile 新增 `gitAccess: 'deny' | 'allow'`，profile 函数默认 `'deny'`，seatbelt executor
显式选择 `'allow'`。允许时：

- `/private/var/select/developer_dir` 进入 `SYSTEM_READ_FILES`。Apple CLT shim
  （`/usr/bin/git`、`/usr/bin/clang`、`/usr/bin/make`）经 `xcode-select`/`xcrun` 解析真实二进制，
  消除误导性的 `unable to read data link at '/var/select/developer_dir'` 错误；
- 存在的用户 git config（`~/.gitconfig`、`$XDG_CONFIG_HOME/git/config`）可读；
- Workspace `.git` 目录从原生 protected-path deny 中豁免（读与写），git 命令可操作仓库；
  `.git-credentials`、`.gitmodules`、`.env*` 等 protected file 仍被 deny。

直接 `.git` 访问不随之开放：模型文件工具走 protected-path evaluator（`.git` 仍在
`PROTECTED_WORKSPACE_DIRECTORIES_V1`，返回 deny），shell 命令文本命中 `checkDangerousPaths()`
的 `.git/config`、`.git/hooks/`、`.gitmodules`、`.git-credentials` 等模式仍被拒绝。因此开放的
是「git 二进制管理 `.git`」，不是「shell 任意读写 `.git`」。

Linux bubblewrap 早已绑定完整 Workspace（含 `.git`），本变更使 macOS Seatbelt 与之一致。

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
