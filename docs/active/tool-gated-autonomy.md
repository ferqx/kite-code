# 当前规则：Capability 执行与工具自治边界

状态：active

读取时机：修改工具路由、Capability binding、Tool Controller、副作用分类、审批、authorization、sandbox、MCP/Skill/Subagent 执行或最终完成条件时。

验证：`bun test packages/agent-kernel/test packages/runtime-spi/test packages/runtime-host/test packages/builtin-runtime/test tests/runtime tests/sandbox`、`bun run typecheck`。

附加验证：`bun run check:core-boundary`、`bun run check:runtime-packages`。

相关：`authorization.md`、`mcp-runtime-governance.md`、`verification-governance.md`、`cancel-resume-cleanup.md`、ADR-0007、ADR-0008、ADR-0042、ADR-0048、ADR-0049、ADR-0110、ADR-0111、ADR-0114、ADR-0115、ADR-0131、ADR-0137。

## 统一执行链路

```text
模型 tool call
  → 解析静态工具或 Runtime-issued binding
  → 校验 turn / token / capability revision / schema
  → 分类 effective effects
  → RuntimePolicy
  → auto review 或用户审批
  → invocation filesystem capability / sandbox / network boundary
  → provider adapter
  → ExecutionReceipt + RuntimeEvent
  → 必要时 Verification
```

工具声明只让模型表达意图。模型侧不得直接执行工具，TUI 不得绕过 Tool Controller 调用 provider。

Builtin capability 的 schema/parser/canonicalizer、availability、effects、traits、contract 与 operation identity
只来自一个 frozen `CapabilityRegistrySnapshot` 及其 `createBuiltinToolCatalogProjection()`；package tests
机械断言 projection 为 28 entries、20 model-visible、8 internal，不能在文档或 App bridge 中手工复制这些事实。
对应 package/manifests checks 与 RM-16 final manifest/docs/journey/fault/soak Gate 均已通过，并由完成记录绑定
implementation final SHA。
Kernel 只拥有纯 governance/admission decision，Host 只拥有该 snapshot 对应的 generic execution port，App 只组合
一个 Model Gateway、Builtin operation port 与 Tool Pipeline。源码 caller/owner closure 已切到唯一 App/Host/Builtin seams，
不得在 RA 中恢复 central controller、第二 registry 或 fallback。

## Tool Pipeline V1 迁移状态

Tool Pipeline V1 当前由 Runtime SPI neutral contracts、Host coordinator 与 App composition 接通以下类型状态：
`ToolCallSnapshot → ResolvedInvocation → ValidatedInvocation → ClassifiedInvocation →
PolicyEvaluatedInvocation → AuthorizedInvocation → AdmittedInvocation → RecordedInvocation →
DispatchedOutcome → NormalizedOutcome → ReceiptCommittedOutcome`。
snapshot 只接受严格 JSON value 并深拷贝、冻结模型参数；resolve 只消费调用前捕获的可用性、catalog、
binding、descriptor 与 disclosure 事实；validate 使用 Builtin catalog entry 的当前上下文 Schema 或 dynamic-MCP binding Schema
应用默认值，并校验 revision、turn 与 Skill disclosure freshness；classify 从 Builtin catalog entry 的 per-invocation
effects 或 MCP/Skill effective effects 派生风险、intent、receipt、retry candidate 与 verification requirement。
Zod Schema 的隐藏 `~standard` carrier 不是 provider-facing Schema，builtin resolution 只显式剥离这一项；
任何其他隐藏元数据、closure、accessor、非有限数字、稀疏数组、symbol key 或 lone surrogate 都 fail closed。

snapshot/resolve/validate/classify 仍是纯 stage：不读取 RuntimeState/Store、不建连 Provider、不 dispatch，
也不产生 Runtime Event。TP-02 已把 recovery/cancellation/execution-boundary/Skill ceiling、phase Policy、
approval/auto-review/ask_user 和本地 reservation/freshness admission 接到 production Tool Controller；每个
early terminal 都是显式 typed branch。Policy/approval 只消费已分类的不可变事实，admission 不允许网络、
Provider 等待或绕过 reservation。Controller 不再保留这些分支的旧 production fallback。

Provider readiness 由 `ProviderReadinessCoordinator` 作为独立 durable lifecycle 边界治理。稳定 key 覆盖
`providerId + route/config revision + execution-boundary digest`；每个 Tool Call 先登记 waiter，同 key 并发
调用只共享一个 lifecycle。可能建连的 attempt 必须在 `provider.readiness_attempt_started` 获得 Store ack
之后发生，success/failure receipt 也必须持久化；ack 前调用数为零，attempt 后 receipt 丢失恢复为 unknown，
不得自动重试。只有另行持久化的 `tool.retry_recorded` 才能授权第二次 readiness attempt。Supervisor 的
on-demand adapter 每次只做一次 reconnect，不在一次 ack 内隐藏 backoff/retry。`tool_search`、inventory 与
discovery 只读当前 revisioned snapshot，绝不直接调用或等待 readiness。

`createRuntimeHostToolPipelineAttemptCoordinator()` 是 Host generic dispatch lifecycle 的唯一 production coordinator；
Builtin、MCP、Skill 与 Subagent 外层 adapter 均由 App 注入同一 coordinator。每次调用先把 `capability.invocation_recorded` 与带单调 attempt ordinal 的
`capability.execution_started` 作为一个 RuntimeStore batch 获得 ack；adapter 的 `beforeDispatch` 在该 ack
完成前不会返回，ack 缺失、失败或 stale 时 provider/adapter 调用数必须为零。相同 invocation 的受限重试
复用稳定 identity 与 idempotency key，不生成第二份授权权威；Tool Controller、SPI registry 或 Runner 都不得在
失败时绕回无 intent/旧 executor adapter。Subagent 内部 filesystem tool 在 PS-01 已由 parent
Runtime 建立 namespaced queue identity，并递归进入同一完整 Tool Pipeline；child terminal durable 提交后
才交回受治理的 `BuiltinChildRuntimeDriver`。Builtin/SPI 已提供 protocol-first `SubagentProvider`、sealed single-use
delegation/resume grant 与唯一生产 `LocalSubagentProvider`：normal task、approval resume 与 Skill fork 都在
外层 attempt durable ack 后由 Pipeline 注入 runtime，Task adapter 不选择 Provider；Builtin Driver 只调用
invocation-scoped registration callback，且不存在 precomputed result、
现场 Model 重建或运行时 fallback。Provider 只拥有 lifecycle、cancel 与 bounded observation
transport，Policy、approval、parent event/receipt/journal merge 仍由父 Pipeline/Kernel 拥有。Provider 与 Driver
的进程内 recovery ledger 也必须有界：grant consumed tombstone 只保留到 sealed grant expiry，仍有效的
tombstone 满载时拒绝新的 lifecycle；stopped/unconfirmed handle tombstone 与 pending Driver registration 按
短 TTL 和固定总容量回收；expiry 使用 finite、非递减的进程内 high-water clock，wall-clock 回拨不能复活旧 hint。
回收或驱逐后不得猜测 stopped，缺少同进程 cleanup evidence 统一返回
`recovery_required`；该内存优化不能改变 ack-before-dispatch、single-use grant 或无 fallback 约束。

Task 的 production chain 固定为 `queue-time private request publish → public role/ref queue → exact hydrate →
invocation/attempt ack → final private task publish → dispatch-intent ack → Provider prepare → private handle publish →
handle-ready ack → activate`。正文只在进程内 schema/policy/Driver proof 中存在；公开 capability arguments、
authorization/admission、dispatch intent 与 child identity 只绑定 opaque ref 和不含 task 正文的稳定外部事实。
child identity 的派生 authority 进一步固定为 parent Model invocation identity、parent task tool call、outer
Task/capability attempt (`parentAttempt`) 与 role；该 attempt 与 typed grant 使用同一 exact capability attempt。
Capability invocation identity 或 Capability Artifact ref 变化不能改变 actor。已保存
suspended continuation 继续读取其原有 child identity，不触发 schema/epoch 迁移。
任一 ack 后重读若没有精确推进同一 attempt，或存在未 cleanup 的旧 lifecycle，Provider/Driver/Gateway/tool I/O
保持零。Task Tool 只消费 Pipeline 注入的 issuance/runtime interface；production composition 不公开 grants、
Provider、Driver 或 stores，也没有 factory 缺失时的新 Local composition fallback。重复 Provider tool-call ID 在
任何 request Artifact 发布或 `model.responded/tool.queued` 前使 Model attempt interrupted，不能按 ID 覆盖错配。

adapter 返回值先归一为 JSON-safe `CapabilityResult`，写入独立的私有不可变 Capability Artifact，再形成
capability terminal。Kernel 只原子接受 capability receipt 与匹配的 `tool.finished/failed/rejected/cancelled`；
需要的 file-change、resource reconciliation 与 `verification.requested` 同批提交。Artifact 写入失败在 dispatch
后收敛为 `capability.execution_unknown`，禁止自动重试；已知的只读 observation/provider admission failure
则写入失败 receipt，不伪造 unknown。Runtime-owned ask_user/approval/Subagent suspension 先以
`capability.execution_result_recorded` 保存结果 Artifact，之后由用户 action 与 Tool terminal 在同一批次闭合。
用户取消可以通过显式 `capability.reconciliation_resolved` waiver 释放该次 unknown；其他 unknown 继续全局
阻断恢复。TP-04 已把成功 receipt 继续推进为不可伪造的 `verification_planned` typed stage；该 stage 只接受
当前进程中由 Capability Artifact publish 产生的 `receipt_committed` token，并把 request 保持在同一 Kernel
terminal batch。伪造、失败或缺失 receipt 不能产生 verification。Tool terminal 的 canonical projection 也已
移入 Pipeline receipt stage，Controller 只保留 branch orchestration。

Host 的 Tool-terminal admission 会扫描 exact Tool identity 下全部 `recorded|running` capability invocation，而不是
只选择第一个 running 或带 receipt 的调用；调用方已提供的 terminal/reconciliation 会被移到 Tool terminal 之前，
其余缺少可信结果证据的调用原子补成 `capability.execution_unknown`。`auto_review.completed` 的明确拒绝会在 App
effect coordinator 中先为 suspended parent 写 `capability.reconciliation_resolved(confirmed_failure)`，再提交 reviewer
终态；`ask_user` 或技术异常升级人工只推进原 queue record，不能终结 parent Tool 或留下半终态。

`recorded` 与 `dispatched` 同样是进程内 opaque stage authority，而不是可由结构类型自证的 DTO。只有
Host coordinator 在 invocation 与 attempt batch durable ack 后签发 authentic
`RecordedInvocation`；同一 attempt 只能签发一个绑定 exact recorded/result identity 的
`DispatchedOutcome`。normalizer、result recorder 与 receipt commit 都重新验证该 authority，因此
clone/spread outcome、替换 result/recorded 或手造未 ack record 会在 Artifact 写入与 terminal 形成前失败。
adapter 在 ack 后抛出且 Controller 能证明为 confirmed failure 时，只能使用 error-only 专用投影：输入固定
`status=error + command + ClassifiedFailure`，不能携带 success、filesystem observation、Runtime event 或其他
adapter result 字段；其他 post-dispatch 异常仍按 unknown 收敛。dispatch authority issuer/import 的静态门禁
只允许 Pipeline dispatch issuer 与 receipt verifier 使用，不提供通用 seal/factory。

静态 Runtime package boundary 现在拒绝 Controller 或非 dispatch stage 直接导入 concrete Tool runner、Subagent runner、
Subagent task adapter 与 Builtin catalog/Host dispatch；Provider-neutral MCP contract、readiness 与 Policy metadata 仍可作为
Pipeline 输入。Verification 读取侧必须复用 production composition 注入的同一 Capability Artifact access，
不存在模块级默认 store；reader/key/artifact 缺失会在 reviewer 模型 dispatch 前收敛为 `inconclusive`。
迁移不增加 runtime execution fallback flag。SAQ clean cutover 已统一切换 State 27/SQLite Store/SAQ epoch；ADR-0138
只允许选中已知历史会话后导入安全 transcript/Task/Plan 投影，旧 dispatch、旧 approval grant、effect authority 和旧单槽
shape 不进入新 epoch，未知 source 静默忽略。

### Workspace filesystem Provider（PS-01）

`read_file`、`search_files`、`search_content`、`write_file` 与 `edit_file` 的旧 Core direct filesystem I/O 已删除。
Builtin catalog entry 只构造结构化 operation 并消费 Provider-neutral observation；
Tool Pipeline 在 invocation/attempt ack 后创建 dispatcher，并签发绑定 thread/turn/tool/invocation、
capability/effect、canonical Workspace、protected-path revision、approval summary、operation 与 TTL 的
sealed grant。Provider 不能自行读取 Policy、Runtime authority 或 App 状态，也不能扩大 grant。

读取链路是 `intent ack → observe grant → Local observe → receipt`。写入链路固定为
`intent ack → prepare grant → zero-write prepare → private preimage Artifact →
capability.filesystem_mutation_ready ack → single-use commit grant → atomic Local commit → receipt`。
ready ack 精确绑定 operation digest、target identity digest、preimage digest 与 opaque Artifact ref；任何
缺失、异常或 Runtime state 未精确反映该 ready fact，都不会签发 commit grant。commit 前重新验证
grant purpose/expiry/consumption、Workspace/path/no-follow identity、operation 与 preimage；stale、cancel 与
final check 前的 symlink swap 均为零文件写入。Unix final publish 使用 pinned parent `renameat`，所以检查后
parent swap 不能把 `workspace_only` 写入重定向到外部；因此失去 lexical terminal evidence 时属于
commit-unknown，不能伪装已知失败或自动重放。Windows write/edit 在安全 native backend 验收前 fail closed。

`read_file` 成功 terminal 才把 digest-only observation stamp 提升为 Runtime authority；未 durable commit
的 Provider 返回值不授权编辑。`edit_file` 要求同一 Runtime actor 与 lexical target 的最新 observation，
并把其 content digest 与 prepare preimage 对比，因此未读为 `read_required`、外部修改为 `stale_read`。
成功 mutation 再提交新 observation，形成后续 edit 的 freshness。`filesystemObservation` 是
Pipeline 保留证据命名空间；MCP/adapter 在 `CapabilityResult.structuredContent` 中自带同名字段会在
receipt 归一阶段被拒绝。顶层字段同样不是自证 authority：只有内部 filesystem dispatcher 在 Provider
成功后签发的同一进程内 observation 对象才能通过 normalizer；不可序列化的对象身份精确绑定
invocation/attempt、intent/operation digest、capability/effect、actor 与 target/content digest，clone、替换
recorded identity 或其他 builtin/MCP adapter 伪造都 fail closed；dispatch 同时把它绑定到同一冻结的
`ToolExecutionResult`，保留 observation 对象但替换外层 result 也不能重新获得 authority。只有与 admitted
`builtin:read_file|write_file|edit_file`、durable filesystem intent、exact effect 和 receipt 类型一致的内部
dispatcher 证据才能成为 freshness authority；write/edit 还必须存在同 attempt、同 intent/operation 的
mutation-ready，且 intent 与 observation 的 lexical target digest 必须一致。Legacy rewind recorder 只接收
best-effort 次级投影；其失败不扩大权限，但私有 preimage Artifact 或 ready ack 失败会阻止 commit。

生产 `LocalWorkspaceFilesystemProvider` 是唯一 Node filesystem owner。`tests/helpers/` 中的旧 file/search
实现和 legacy dispatcher 仅用于差分行为 oracle；`ScriptableFakeWorkspaceFilesystemProvider` 只返回脚本化
结果，deny/crash 后没有 Local 或旧 adapter fallback。此迁移没有 feature flag，也没有改变 Runtime format
epoch；private task request/final task/continuation/handle Artifact、two-phase handle-ready 与
same/cross-process recovery 均沿当前 Runtime State/SQLite Store seam，生产执行不存在旧 Provider adapter、raw Task restore
或 Capability Artifact reader fallback。

### Sandbox execution Provider（PS-02）

App Tool Pipeline 不再拥有缺省 `shellTool` production 执行入口。唯一 production dispatch 在 invocation/attempt ack 后由
Tool Pipeline 注入 sandbox identity 与 preparation lifecycle；allocating prepare 固定经过
`sandbox_preparation intent ack → sealed grant → Local prepare → private preparation Artifact →
sandbox_preparation_ready ack → single-use Runtime spawn → disposal intent/receipt`。任一 intent、Artifact、ready、
identity、expiry 或 cancellation 检查失败都保持零 spawn；Fake deny/crash 也不会回退 Local、裸 Shell 或直接
Windows runner。

`SandboxExecutionProvider` 只接受精确 approved argv/command digest 和冻结 execution boundary，返回
data-first prepared plan 与 backend evidence。Runtime consumer 唯一拥有 Seatbelt/bubblewrap shell 与 Windows
framed restricted-token runner 的 process spawn、output、timeout、cancel、process-tree/Job cleanup；Provider 不
导入 Policy、approval、Runtime state/event 或 App。ready 后 crash 由 Kernel 从 keyed private Artifact 恢复
cleanup handle，并先记录 disposal intent，再执行 provider reconciliation 与 receipt。旧 Windows executor
入口已删除；intent 后、ready 前的崩溃通过 preparation digest 可重建的确定性 allocation identity 和独立
abandonment intent/receipt 回收。Local Provider 对 backend unavailable 仍 fail closed；按 ADR-0119，App 只在
typed pre-dispatch unavailable 且 cleanup receipt 已确认后，为同一条已获 Policy/approval 与 attempt ack 的
命令选择一次 host Shell。该 availability 路径不属于 Provider fallback，也不改变 schema/format epoch。

Development Shell 的文件系统能力是逐 invocation 的：Planning 非 Full 使用 Workspace read-only baseline，Building 非 Full 使用
Workspace read/write baseline；默认 baseline 使用 native backend。`externalRead`、`externalWrite` 与 `uncertainEffects` 在命令
启动前按 phase/mode 路由到 user approval 或 Auto reviewer，批准后投影为 backend 实际可兑现的 sealed scope。该选择本身不是
host fallback；ADR-0119 的 App availability 仍只在 native command 尚未启动且 cleanup 已确认时生效，用户命令只能执行一次。Auto
模式由自动审批模型先判断；模型可批准、拒绝或请求真人审批，技术异常、无效响应和 circuit breaker 也升级
真人审批。显式敏感路径以及因变量、任意脚本或间接 child 无法证明文件目标的 Shell 都投影
`sensitiveExternalAccess`。Workspace 外固定 credential/persistence/system identity 也必须投影该 fact：Full 直接授权，Auto 三态
审查，其他模式进入 exact user approval；显式敏感 identity 不允许 same-command 静默复用；Auto reviewer 的新响应使用
`approve_once|reject|ask_user`；旧/未知或矛盾
响应 fail closed；不产生 Full 或 same-command grant。
批准后 native guard/mount/profile 不得二次拒绝。关键 destructive operation 仍在执行前硬拒绝，且不得按名称
拒绝 Workspace member。网络客户端自身的 output/input 参数必须独立贡献 external filesystem effects；普通临时目录和
Workspace 外文件不是硬拒绝对象。sealed production admission 仍独立治理，development capability 不形成
qualification evidence。

Shell command surface 不可穷举。按 ADR-0137，Policy 不再把只读、Workspace-only 或 Git subcommand grammar 当作正向授权；
Building 的 Workspace baseline 与 Planning 的 read-only baseline 内 Shell 可 direct，已知扩 scope 才进入当前 mode 的审批
route，而不是 fixed-list allow/deny。Auto 先由模型 reviewer 结合结构化 effects 与 exact command 选择
`approve_once|reject|ask_user`；Accept Edits 请求真人 exact approval；Full 对允许 bypass 的 invocation 直接授权。该 reviewer
不接管关键系统 hard deny 或 native capability qualification。
新配置与新 TUI 会话默认 Auto；显式配置和 live `/permissions` mode 不被覆盖。内部 Runtime/child grant 缺少
mode 时仍回退 Accept Edits，以区分“产品推荐的 reviewer 路径”和“缺失授权事实时的 fail-safe 行为”。Full 只由
interactionMode 表达，不能由 approval grant 或 reviewer payload 产生第二个 Full authority。

Shell 的 read-only classifier 不是 Policy 授权来源，也不能让命令在 Planning 或 Building 中免审。它只用于
只读 Subagent role ceiling、scheduler metadata，以及已按 mode 授权后选择 hardened execution environment。
分类仍必须按每个程序的参数与操作数语义 fail closed：只有有限、已验证的只读 grammar 可以得到
`read_only + sideEffect=false`。能够写文件、修改 Git、启动外部程序或把运行时输入追加为 argv 的
模式不得进入该 grammar；例如 Git branch mutation/diff output、ripgrep preprocessor、sed write、find
file-output action、sort output、uniq output operand、`file` compile/uncompress 与 xargs 均属于非只读。CR/LF 多命令、process
substitution、command substitution、backtick 和可能把安全参数展开成危险 option 的变量 expansion 同样不得
走只读 fast path；未加引号的 brace expansion 也必须拒绝，避免它在静态检查后合成危险 option。`file`
的 `-p/--preserve-date` 会恢复被检查文件的 atime，属于元数据写，同样不得归为只读。由于 raw Shell 必须经过
mode review，它不会作为无需交互的 read batch 成员；RM-09 后 Scheduler 从 Builtin catalog 投影的
`access/resourceScopes/conflictKeys/isolation/causalGroup/interactionBarrier/concurrencyGroup/leaseFenceRequired`
判定 overlap，不读取具体工具名。误分类不能依赖
Workspace sandbox 兜底，因为 development 的 `workspace_only` capability 仍可能允许 Workspace 写入。
`rg -f/--file` 保持只读，但其 pattern 文件与搜索路径都是读取目标；任一目标位于 Workspace 外时必须进入
external-read 审批，不得因 option value 没有被当作普通操作数而漏报。`grep` pattern 文件、`file`
magic 文件与 `sort --random-source` 同样属于显式读取目标。`file -f/--files-from` 会从文件内容动态取得
更多路径，静态命令无法证明其完整读取范围，因此直接退出只读 fast path。
这条只读证明同时依赖 executor 的 sanitized environment。SPI registry 只为重新通过同一
classifier 的命令签发 Runtime-owned `policy_proven_read_only` 执行信任；模型参数、审批
payload 与其他 Shell 调用不能伪造。POSIX 路径使用固定非登录 `/bin/sh`，并在进程
启动前投影最小环境；Windows restricted-token 保留密封 runtime/Coreutils 前缀。两者都将
继承 PATH 的每个绝对目录先 canonicalize，再删除相对/空条目、Workspace 目录、其子目录
和指向这些 identity 的 symlink alias。因此 Workspace 中的同名 `ls`/`rg` 不能在静态分类后
替换真实 executable；没有可用的可信 PATH 时命令查找按失败收敛，不回退 Workspace。
该最小环境也不继承 `BASH_ENV`/`ENV`、凭据或其他未白名单变量；
`RIPGREP_CONFIG_PATH` 必须在沙箱 wrapper 中额外 unset，防止普通 `rg` 通过配置文件注入
`--pre` 子进程。显式 `rg --pre` 仍由参数 grammar 直接拒绝。需审批/副作用 Shell 不使用该信任投影，保持原有工具链 PATH 语义。
按 ADR-0137，Building 的 Workspace baseline 与 Planning 的 read-only baseline 内 direct `git status`、不产生
patch 的 `git log` 和其他可证明 baseline Shell 可直接执行；已知 external/sensitive scope 才按当前 mode 审查。
命中 ADR-0134 闭集 classifier 的 status/log 仍使用 hardened environment，固定关闭 system/global config、
credential prompt、pager、external diff、optional locks 与 repository fsmonitor helper。Planning 与关键系统
destructive hard deny 保持独立。`git_inspect` 仍可作为结构化 capability，但不由 raw Git token 强制路由，
也不从 generic Shell grant 推导资格。

每个当前工具终态在持久化和发布前由 Kernel 写入唯一 canonical `ToolOutcome`；current reducer
及其消费者不从其他 result 字段推导 outcome，并且只投影一个成对 ToolMessage。当前 epoch 缺失或
损坏 outcome 时直接 fail closed，不存在 historical decoder。Builtin catalog entry 只能提供 metadata-only
result classifier，不能自报 dispatch、external effect 或 timing。Policy/approval deny 一律证明为
`not_started/none` 且不产生新调用；timeout、cancel 与 unknown external effect 禁止自动重放。
Runtime 自动 retry 只允许一次，并且仅限明确 pre-dispatch、受信 safe-read，或已有可信
idempotency receipt 的调用。配置或参数中的 idempotency key 本身不是 receipt，不能授权 replay；
`correct_args` 只允许下一次模型响应提出一次新 invocation，绝不原样自动重放。
safe-read replay 前的 retry fact 必须由 RuntimeStore 明确 durable ack；仅同步 emit、持久化失败或
缺少 persister 时第二次 dispatch 为零。MCP readiness 本身属于 keyed pre-dispatch lifecycle：如果它在
任何 capability dispatch 前失败，失败 authority 必须为 `not_started/none/pre_dispatch`；durable retry ack
后可再做一次 readiness attempt，但整个 lineage 仍只允许唯一一次后续 capability dispatch。已解析 identity 使用当前 Builtin catalog/MCP binding schema 的
default 后参数与 revision；malformed raw 参数只进入 domain-separated SHA-256 equality，不作为明文 state。
真实 Kernel 路径中，capability dispatch 后的 safe-read retry 必须先有唯一一次有效 `tool.started`；
readiness 的 pre-dispatch retry 则允许在 Tool Call 仍为 queued/approved 时记录。两者都必须先持久化可由
reducer 消费的 `tool.retry_recorded`，才允许第二次 Provider attempt；retry ack 后即使进程在 terminal 前
崩溃，restore 仍保留 `recoveryOf` 与 automatic attempt=1，同 identity 总额外 dispatch 不得超过一次。
Controller 不能自行把 `safe_read` 解释成重试授权：它只能把 descriptor、dispatch certainty 与结构化
Provider failure 投影给 Agent Kernel，由 Kernel 先构造候选 failure、执行 `automatic_retry` admission 并
返回精确 `recoveryOf`；只有该 identity 与待持久化事件完全一致时才允许写 retry fact。admission deny、
identity mismatch 或 durable ack 失败时第二次 Provider/Host dispatch 都为零。

父 Runtime 与 task Subagent 共用 `ToolRecoveryJournal` 语义。journal 以 canonical operation facts
生成 deterministic invocation fingerprint，持久化 failure instance、`recoveryOf`、模型修正/
自动 retry 次数与 tool-owned progress revision；fingerprint 和 lineage 不进入 SessionLog、
remote telemetry。只有成功 receipt、内容/Plan/capability/provider revision 可以形成进展；
普通 state revision、文本变化或时间流逝不重置 ceiling。恢复数据缺失结构或损坏时 fail closed，
不会用空 journal 重置次数。重复无进展只按同一 recovery root、工具、task/turn 与 progress revision
的 6 个 failure 触发 quality guard；`observedFailures` 是上限 250 的有界诊断计数，不是另一套 12 次准入
门槛。后续
提议在 Controller dispatch 前阻断并生成配对结果。
failure scope 绑定 task、turn 和 immediately-next eligible model response。deny/never 与没有合法修正的
下一 response 虽写入稳定 terminal/`next_response_elapsed` resolution，仍保留原 scope 的 suppression、
quality fact 与 CompletionGuard blocker；exhausted 不是 recovered。只有成功 `recoveryOf` receipt 或
显式 skip/replan/user/provider/capability revision 才可消除 blocker。task/turn close 只负责让旧 scope
不阻断新 scope。`alternative` 可在下一 eligible response 使用不同 capability，但 Runtime 必须绑定
`recoveryOf`。quality guard 允许 Plan、询问用户与 capability search 等逃逸工具形成真实替代进展。
主 Runtime 与 Subagent 的 deny 重提、MCP binding failure、restart 与 parent merge 全部走同一 typed
terminal/journal 路径，不保留另一套正文或计数旁路。Runtime State continuation 只携带当前 canonical
`executionJournal/exhaustedFingerprints`；旧字节不读取、不归一，Kernel journal 是唯一 recovery ceiling。
Subagent 的正常执行与 approval resume 都只能把 `ToolExecutionResult` 的 canonical public model content
追加到下一次 Provider context；该内容与 parent reducer 共用唯一 helper，success 选择
`stdout || stderr || ''`，failure 选择 `stderr || stdout || ''`，并同时读取 `ok`/terminal status。
子 Agent 的单个工具失败只是一条步骤级 ToolOutcome/recovery 事实：它必须保留在 journal、步骤展示和 parent
recovery 中，但不得因为未恢复而把已经返回最终模型文本的 child 改投影为 `subagent.failed`。该情形 child
仍以 `completed` 终态把最终文本交给父 Agent；`subagent.failed` 仅表示 child lifecycle 本身未正常结束，例如
中断、超时、Provider/模型服务异常、循环耗尽或没有产生最终模型结果。
command、path、resultMeta、classifier advice 与 private recovery guidance
不得通过 `JSON.stringify(result)` 进入 transcript。Builtin classifier advice 仍作为独立 metadata 输入同一
`classifyToolOutcome`，因此父/子 `read_file` ENOENT 等失败得到相同 detail/recovery，而公开错误文本不重复路径。
生产 task Subagent 继承 parent journal 的非秘密 recovery identity，所以 child failure merge 后的
fingerprint 与 parent 使用同一 session scope；foreign-session journal 不复制任何 failure/fingerprint，而是
fail closed quality block。同一 child deny 被 parent 再次提出时，Controller 在 dispatch 前以同一 canonical
identity 零调用阻断。recovery identity 与 fingerprint 不进入 Provider、SessionLog、metrics 或 TUI。
Runtime State 的根 recovery identity 由 App 生成、Runtime Host 通过同一 SQLite Store writer按 Session 持久化；restore
只允许采用 snapshot 中已有 identity，metadata 与 snapshot 必须精确一致。conversation fork 与
recovery-continuation fork 是新 Session：App 分配新的 target identity，Kernel fork projection 清空 source
recovery journal，SQLite 在同一 transaction 中提交 target snapshot 与 private metadata；source identity/journal
不变。code-only rewind 继续使用原 identity。该字段是 fork/recovery identity，不是 secret key 或 authenticator。

Sandbox fail-closed executor 在 backend/flag 不可用且禁止 unsandboxed fallback 时写入结构化
`terminationReason=sandbox_denied`。Runtime 由该字段分类为 `sandbox_error/sandbox_denied`，不得解析 stderr，
不得把它投影成 approval/phase rejection，也不得尝试底层命令或自动 replay。测试通过同一 factory 的
可触发 fallback sentinel 证明底层 executor 确实可观测，并从 persisted Runtime event 计数证明没有 approval grant、
authorization/interaction-mode widening；不存在生产计数 seam 的“权限提升尝试”不得以常量伪造。

当前 Runtime snapshot 与 Subagent continuation 都必须携带 journal；缺失即 fail closed quality block，不得补默认 journal 后继续调度。invalid provider raw args 在
`model.responded/tool.queued` 之前立即替换为固定 `invalid_json + redacted` sentinel；digest fingerprint
只放独立 canonical-private 字段，event store、transcript 和 diagnostics 不得出现原文，Provider
projection 也不得出现 fingerprint。当前 auto-review 的 `ask_user` 判定升级人工审批，不产生 ToolMessage；
只有没有 `escalatedToUser` 的历史 auto-review rejection 在 replay/next-model projection 对原 AI tool call
恰好追加一个 ToolMessage。
restore 还必须从 toolCallId、canonical fingerprint 与 outcome 重算 failure instance ID，并交叉验证
map key、lineage `failureInstanceId/recoveryOf`、attempt counters、progress revision 与 order；即使攻击者把
多处 ID 一致改成同一伪造值，也必须以 `journal_invalid` fail closed。正常无进展 ceiling 使用独立
`no_progress` cause，并投影为 `loop_exhausted`，不能伪装成 `persistence_unavailable`。
`journal_invalid` 是吸收态：success receipt、skip/replan、task/turn close、后续 failure/exhaustion 以及
child merge 都不得清除或降级它，Plan/escape tool 也不能继续损坏 continuation。其 task/turn 仅为来源
metadata；下一 turn、新 task、task close 后及 SQLite restore 后都必须全局 `recovery_blocked /
persistence_unavailable`，model/tool dispatch 均为零。普通 `no_progress` guard 才按 task/turn scope 过滤。
该检查优先于已入队 read/write/MCP sibling、pending verification/compaction 及所有 interaction。Controller
direct execution 入口必须读取可用的当前 Kernel state；任何 task child 也必须从这份 live state 继承
`toolRecovery.identityKey`，不得使用 leased/stale `params.state`，否则 child merge 会错误触发
`journal_invalid`。approval 后的 suspended child resume 必须在实际 dispatch 前重新读取 live state，并拒绝
continuation journal 与父 identity 不一致的恢复，不能先执行外部工具再依赖 lease 丢弃结果。旧 schema 迁移时，
缺少 journal 的父 Runtime 与每个 suspended child 必须注入同一个新 identity；不得为每个 child 独立随机生成 key。
任何 child journal（即使 identity 相同）也必须先结构化归一化，损坏时转换为 `journal_invalid` 而不能把畸形数据
合并进 RuntimeState 或触发 invariant 异常。健康 journal 的 `qualityGuard` 只能包含 `blocked:false` 与
`observedFailures`；`taskId`/`turnId` 仅属于已阻断 guard，避免下一轮 Kernel restore 把健康 child merge
误判为损坏。Runner 在 async prepare 后、resource admission 后
与 lease 进入 executor 前重复校验，任何 stale `run_tools` effect 都不得触达 Shell/MCP/Provider dispatch。
128 条 journal 上限采用
lineage-aware compaction：优先保留 active/recent failure，并连同完整 `recoveryOf` ancestor closure 一起
保留或一起裁剪；历史 terminal ToolCall 可引用已裁剪 lineage，live ToolCall 的 parent 则必须 retained。

phase 不改变 production builtin declaration：Planning 与 Building 使用相同的 edit/write/shell 声明和完整 `task` role schema；当前已绑定动态 MCP 也保持声明稳定，避免 phase 切换破坏 Provider 的工具前缀。动态 Runtime block 和 Builtin catalog description 引导 Planning 只调用只读能力，Runtime Policy/Controller 仍以当前 phase 和 Builtin catalog/dynamic-MCP effective effects 强制裁决：具备结构化只读 contract 的 MCP 与 Builtin capability 可运行；Planning 非 Full 的只读 baseline Shell 可 direct，已知扩 scope 进入当前 mode approval queue；edit/write、code/review child 和 side-effectful MCP 仍按 phase hard deny。模型可以为有界、自包含、独立且值得额外调用的工作自主选择 `task`；用户明确要求不委派时必须遵守。Capability availability、execution surface、binding 与 Skill lifecycle 仍可改变实际工具面；稳定披露不是授权。

`ask_user` 只在主 Agent 工具面中可用。主 Agent 必须在派发 `task` 前澄清会阻断执行的用户意图，并把必要事实写入自包含的 delegated task；Subagent 的所有角色都从工具声明中移除 `ask_user`。child 若发现必要前提仍缺失，只能在最终结果中返回 parent，不得创建用户 interaction。Full/Plan 模式可提问仅指主 Agent 可在委派前提问。

Runtime 不解析 active Task 的 `userGoal` 来授权委派、匹配 role 或推导 code scope；delegated task 的硬校验只复用 schema 的 trim 后 `8..8000` 长度边界，不按语言、单词数或语义短语猜测“是否自包含”。自包含、独立和收益判断属于模型可见 Tool contract。所有内置 Subagent 角色的默认执行超时统一为 30 分钟；角色配置可显式覆盖该默认值。explore/plan/review 保持各自只读 ceiling；code 仅用于当前用户任务要求实施的情形，并与 Parent 共用 phase、authorization、sandbox、protected path、execution surface 和累计预算。interaction mode 通常继承 Parent；唯一特化是父级 `accept_edits` 下，同一模型响应内的多个结构化 Explore sibling 使用 Auto reviewer，父级 Full 不降级。Project、Shell、工具结果或远端内容不能提升这些结构化权限；它们是否影响模型选择属于指令遵循边界，不能表述成新的 Runtime 授权。Planning 只允许 explore 及只读 plan，code/review 一律拒绝；
审批只解决具体调用的 Runtime policy gate，不能扩大 Subagent role ceiling。explore/plan/review 的
非只读 Shell 即使在暂停后获得批准，resume 仍必须经过与首次 child loop 相同的只读 executor 并被拒绝。
plan child 返回后的唯一 continuation 是 `write_plan:save`
再 `write_plan:submit`。同一模型响应中连续、属于同一 task、尚未暂停且经 Policy 判定为无需审批的
独立 `task` sibling 可以组成最多 4 个调用的并发批次；实际派发数量还受共享
`maxConcurrentSubagents`、writer ceiling 和累计预算限制。模型应把有价值的独立任务一起派发，依赖
前序结果或写范围重叠的任务必须串行；若减少用户要求的数量，需要明确说明原因。多个并发 child
动态请求审批时只呈现一个 focused、可见的 canonical interaction，其余 continuation 以
每个 child 的 canonical approval record 持久化在 Session queue，随后从 snapshot 继续，不得重启 child 模型。每个 child 的
原始审批路由必须随 snapshot 持久化；恢复不得把 `minimumApproval=user` 或其他人工审批降级为
auto-review，缺少该字段的历史 snapshot 必须保守回退到人工审批。重新呈现排队审批不是新的
Sub-agent lifecycle attempt，不创建或结算 parent/tool reservation；真正获批恢复时才打开新的
parent attempt。已经自动或人工获批的 active continuation 优先于 queued sibling；获批 child
完成或再次暂停前，后者不得插队占用 canonical interaction。每个 child 的 model/tool reservation
仍来自父 run 的共享累计预算 ledger（ADR-0104）。自动审查升级人工审批时，内部 `reviewFailure` 继续
记录 reviewer 的判断或技术失败，但按 ADR-0142 不作为 raw client payload；App projector 只可输出有界、
低敏感度的 approval title/summary，TUI 不得重新读取 raw command、scope、Provider body 或 Host payload。
升级后的 canonical approval interaction 本身必须可见，不能表现成永久等待。当 durable approval interaction 早于 Runtime action waiter 到达 TUI 时，Enter/Esc 决定必须绑定 exact interaction id 排队，waiter 建立后立即消费；错配的后续 interaction 不得继承该决定。Runtime 调用 reviewer
时必须提供当前用户任务、workspace root，以及可用时的 Subagent 身份和角色；reviewer 不得只依据
脱离任务语境的单条命令做决定。实际并发派发的 task sibling 共用 Runtime 签发的
`concurrencyGroupId`，使 TUI 能聚合显示 queued、auto-reviewing、awaiting-user 与恢复后的状态；该字段
不是授权凭据，串行调用不得由 App 根据相邻卡片或时间顺序推断成并发批次。自动审查明确拒绝或
error abort 必须把对应活动 child 投影为终态，不能留下永久“等待审批/进行中”的展示。
并发组的紧凑 TUI 投影只保留一个组入口；每个 child 占两行，首行显示角色、任务、状态与其自身
执行时长，次行用唯一的 `└─` 显示当前未结算工具或等待状态。后续同级 child 与首行文字对齐，

TUI 对 tool 和 Subagent 生命周期的可见标签可以按用户语言本地化；Runtime 事件、状态枚举、Tool Outcome 和授权判断始终使用稳定结构化值，不得从翻译文字反推执行状态。
不得绘制 `├─`、竖线或伪父子树。该布局只消费 Runtime 已签发的 group、child status 与 step
事实，不得改变调度、审批顺序、reservation 或并发判断。

ADR-0134 的 direct status/log 闭集只提供已批准执行的 hardening 分类，不依赖 `gitInspect` surface，也不产生
Policy allow。typed `git_inspect` 仍只在精确 feature revision、`gitInspect` surface 与 App broker 同时存在时
披露/执行。ADR-0137 要求 status/log 等 baseline Shell 按 phase/mode 直接执行或进入相应 scope route；
stage、commit、remote、未知 raw Git 与其他扩 scope 仍不作为 typed model tool 披露，并按当前 mode 治理。
Git log revision 使用 broker、Provider schema 与 Builtin catalog 共用的闭集 grammar；Runtime 的预算/资源 admission 与模型 surface 都必须接收同一个 `gitBroker` dependency，避免“已披露但不可执行”或相反的漂移。Git process stdout/stderr 在 App adapter 内流式限界，溢出是 typed terminal，不把异常或 protected 历史正文投影给模型。

V2 写入前还执行项目指令 snapshot guard。edit/write 使用目标路径，shell 与 code task 至少使用已解析 cwd/Workspace 根；若目标首次引入当前模型快照未见的嵌套 `CLAUDE.md`/`AGENTS.md`，或适用文档 digest 已变化，本次副作用以可恢复的 `project_instructions_changed` 拒绝。下一轮重新投影后模型可重新发起，审批与 sandbox 不得绕过此检查。

`resourceBudget` 启用时，策略/审批仍先于 child reservation；只有调用已经可执行时才原子写入
reservation，再单独写入 `dispatch_started`，最后进入 adapter。Subagent parent 只代表一次
lifecycle attempt，child 模型及工具/Shell/MCP 调用各自链接独立 reservation；artifact bytes
计入产出它的 tool/MCP reservation，不另建一个虚构 invocation。延后审批的重新呈现只打开
interaction，不属于 dispatch 或 lifecycle attempt，因而不进入 resource admission；child tool/shell permit 使用
durable FIFO waiter、原子 promotion + reservation 与有界 wait deadline；超时通过主 Runtime 的
canonical failure terminal 收敛，不转换成普通 child tool error。
本地 Provider 最终 gate 明确拒绝且能证明未 dispatch 时可携带证明 release；已经执行部分
command/MCP check 的组合 Verification 必须转 `unknown`，不能整体退款。`resourceBudget`
开启但 `boundedCancellation` 关闭时，模型不披露 writer、Shell 或 child capability，
Controller 也必须拒绝直接执行，不能退回无界副作用路径。

sealed `ExecutionBoundary` 还会在 dispatch 时派生逐调用 network policy。当前 `web_fetch`
对 robots、正文和每个 redirect hop 分别做 DNS/endpoint admission，并在 socket 前持久化
`network.admission_decided`；Tool Result 只携带 policy revision、receipt digest 和 typed failure。
feature 关闭、决定无法持久化或 controller 不可用都 fail closed。因为当前没有可证明的跨进程
host allowlist，Shell/Skill descendant 固定 network-off，MCP inventory/resource/tool 与读取 Provider
snapshot 的 `tool_search` 在 Controller provider lookup 前拒绝；审批或 `full` mode 不能
把这些路径提升为 unrestricted sealed scope。

remote HTTP MCP 的最终参数在 SDK dispatch 前只经过一次 deep-frozen bounded
JSON/schema/secret inspection，并绑定 exact endpoint 与已批准的 execution boundary。空或非空合法参数
都不签发 content-egress permit、nonce 或 durable egress receipt；项目配置不能绕过这些真实边界。

Shell 执行的 `onShellProgress` 必须在命令仍处于 running术语（运行中）状态时直接发布 `tool.progress`，不得在 Controller 私有数组中无界累积并等待终态结果。`tool.progress` 是仅供当前进程展示的 ephemeral event术语（瞬态事件）：Runner 按 `toolCallId + stream` 合并尚未消费的批次并保留有界 tail，不写入 Runtime event store 或 snapshot，也不推进 revision；任何 started/terminal/durable event 都是顺序屏障，必须先交付此前 progress，终态事件不得被 progress 淘汰。批次可携带仅保留的完整行和原始 `lineCount`，TUI 因而能在丢弃中间展示帧后继续显示准确总行数。前台 Session 以 50ms presentation frame 合并，同一 call/stream 内保序；一个 frame 内 stdout/stderr 不承诺跨 stream 全序。后台 Session 同样只保留每个 call/stream 的有界聚合 tail，缓冲容量是 presentation soft limit，不能通过 `shift oldest` 丢弃 terminal/lifecycle fact。未提供 event sink术语（事件接收器）的直接调用兼容路径仍在返回数组中收集事件。

## 工具名单单一事实源（ADR-0043）

computer、coordination、interrupt 与 runtime action 静态工具由 Builtin frozen catalog projection 统一描述；dynamic MCP
仍走独立 binding/descriptor route。Prepared production request 先由 Pipeline/Kernel governance admission 形成
exact authority，再经 Host coordinator 只调用 supplied Host port；旧 dispatch/helper owner 已物理删除。测试只可使用显式
test-only helper，静态边界拒绝 production source 导入该 helper，因而它不能成为 production fallback。Tool Controller 不直接调用具体 executor 或创建第二
registry/snapshot。`ask_user` 作为 `kind: interrupt` 保留在 Kernel request-user-input → RuntimeActionProvider/TUI
terminal 路由，不进入 catalog dispatch；Builtin module 只冻结其 operation identity/schema，不能建立第二 interaction
handler。

Builtin operation receipt/result projection 只产生模型内容、双流内容与 Runtime 结果元数据，不包含 display hint。Skill 与 Plan executor 输出可以携带领域 events；capability-backed `tool_search` 没有第二 concrete executor，Builtin prepared adapter 从 frozen search result 逐字段投影既有 `capability.search_completed` 与 stdout。App Tool Pipeline 只按顺序提交这些事实并形成 terminal，不重新计算搜索结果。App 根据持久 RuntimeEvent 与结果元数据决定展示。Skill activation 的 disclosure、approval 与 fork adapter 仍属于 App tool coordinator 的跨领域治理边界。

`read_skill_reference` 与 `complete_skill` 已迁入 Builtin catalog：entry parser 校验当前 task 的 active frame、Skill revision 和 compiled contract；reference 读取继续限制为声明文件、非 symlink、Skill 根目录内且不超过 128 KiB；completion 在 output schema 验证后投影 `skill.frame_closed` 与可选 verification 事件。

`activate_skill` 也已迁入 Builtin catalog：Controller 保留 disclosure、approval 与 mode-policy 前置治理；entry parser 负责 activation validation、inline/fork 生命周期、fork 结构化输出校验、frame close 和 verification 投影。fork 子 Agent 仅作为受治理 provider adapter 注入。

`read_plan` 已作为 capability-backed `runtime_action` 接入 Builtin catalog：App composition 只声明模型 schema、effects、Policy 与 exact Builtin revision。Builtin executor 消费 invocation-scoped Plan Runtime mechanism；该 mechanism 仍只接受当前 Task 的 active plan identity 与版本，可选 structural digest 必须匹配，并从不可变 Plan Artifact 返回完整文档及可用的 metadata-only completion evidence。Controller 不重复解析或读取 Artifact。

`update_plan` 也已作为 capability-backed `runtime_action` 接入 Builtin catalog：Builtin executor 是唯一 operation handler，App 注入的 Plan Runtime mechanism 限定 building/executing 的 V2 Plan，精确校验 `plan_id + version + structural_digest` 与稳定 step ID，拒绝重复更新、终态回退、all-skipped completion、缺 Runtime receipt/required verification 的完成请求，以及 command/path/stdout/evidence self-report；接受后只从 Runtime state 投影 metadata-only evidence，并产生带相同 identity 的 `plan.progress_updated`、可选 `plan.completed` 与模型结果。

`write_plan` 已作为 capability-backed `runtime_action` 接入 Builtin catalog：Builtin executor 经注入 mechanism 保持 save→submit 两阶段 Artifact 协议、幂等保存、版本冲突、replan 元数据、review interrupt 和同批后续调用取消；首次 save 后的 save/submit/replan 共用严格 identity 校验，新 write 只产生 PlanDocument V2。当前 execution path 不接受缺少当前 Plan/Runtime 格式身份的状态；历史会话兼容投影会终结旧 active lifecycle，因此不存在 recovery-only 工具面或 legacy governance 分支。

静态工具的 Schema、契约与副作用分类收敛到 `packages/builtin-runtime/src/tool-catalog.ts` 投影的 Builtin catalog；
SPI registry 保留 immutable definition/executor identity，App 只保留 composition/request adapter。RM-10 至
RM-15 已依次迁移 `tool_search`、Skills/MCP/Web、Filesystem/Git、Shell、Plan/Task 与四类 Model operations。
App 的 `read_plan/update_plan/write_plan/task` 没有 concrete executor；Task 的公开模型投影由 Builtin
`projectSubagentResult()` 唯一产生，完整 child journal/continuation 只走私有 Runtime 通道。一致性不变量由
`packages/builtin-runtime/test/builtin-runtime.test.ts`、`apps/kite-service/test/tool-definitions.test.ts`、`tests/integration/tool-parse-error.test.ts`
与 RM schema parity 测试棘轮守护：Builtin catalog 的 28/20/8、exact schema/revision/executor/effects、model
ToolSet 无 execute、internal 不可伪装 visible、以及 supplied-port-only dispatch 均机械验证。shell_execute 的
模型参数仅保留 `command`、可选 `description`、可选 `timeout_ms`；未提供 `timeout_ms` 时 Builtin/Host execution
path 必须使用 600000ms 默认硬超时，显式正整数可以覆盖；副作用分类和审计 `action.intent` 可由命令形态
派生，但审批 payload 不接受模型建议授权或 prefix rule。ADR-0137 的回归语料必须证明 `ls`、`pwd`、`rg`、
direct `git status`/无 patch `git log` 在 phase baseline 内可 direct，Workspace mutation、local Git 扩 scope
与未知脚本进入相应 mode-aware route，而固定 classifier 只能保留 advisory effects 或已批准执行的 hardening
metadata。typed `git_inspect`
保持独立可选 capability。

生产静态模型工具面必须直接由 `createBuiltinToolCatalogProjection(snapshot).toolSet` 投影；
App tool composition 只合并独立 Runtime-issued MCP overlay，不拥有第二 schema/effects table。
默认开发入口继续暴露完整 projection；production surface 必须逐项按 `network/process/write/shell/skillChild/localStdioMcp`
独立收窄，并同时检查 Capability Descriptor 的 declared/effective effects。Prepared Runner/Pipeline 在 dispatch 前
重复同一检查，防止仅在模型 disclosure 层收窄；`process=true` 不能提升 `write=false` 或 `network=false`。原生
sandbox Shell 由显式 `process + shell` surface 接管其保守的 `unknown` descriptor；进程内 writer/network 工具仍按
各自 effect 被拒绝。`verified_in_process_read_only` 进一步要求当前 capability descriptor 中的 capability ID、
descriptor revision 与只读副作用契约完全匹配，并省略动态 MCP；这不是第二份 Registry。Builtin projection 只来自
唯一 frozen snapshot，并同时用于执行前的静态调用解析。工具表当前不做模块级缓存，避免长进程无界增长与运行中
配置变化复用陈旧表面。Builtin Capability Descriptor 包含规范化输入 Schema，因此 Schema 变化必须改变 revision。
静态工具进入审批与模型队列时，副作用分类优先且必须来自 catalog entry 的 parser/effects classifier；手写名称分类器
仅用于 dynamic MCP 名称或未知调用的保守回退。

Skill frame 的模型提示、工具面与 Subagent resume 注入只读取匹配当前 `activeTaskId` 的 active frame；旧 Task
保留的 active 历史帧不得继续向后继 Task 披露指令、capability ceiling 或工具。Model Controller 与 Tool
Controller 必须复用 Runtime 的 current-work 判定，不能各自用 Thread 级 `status=active` 扫描恢复状态。

已删除的 Core surface 不得重新声明生产 `ToolSpec` union；Builtin catalog entry 拥有 model schema/parser/effects/traits，
capability-backed operation 只通过 `executionOwner=runtime_capability + capabilityRevision` 标识其唯一 Builtin executor，
interrupt 只走 `createInterrupt`/Kernel request-user-input seam。Interrupt 的模型
输入与中断协议输出可以是不同类型，但转换只能发生在 `createInterrupt()`。`ask_user` 不能误入 catalog dispatch；
Tool Controller 先应用 interaction-mode policy，获准后才可创建 `user_input.requested`。模型只提交 1-3 项的规范
`questions` 数组，每项提供 2-3 个 `{label, description}` 选项，单问题同样使用数组。Builtin 的
`normalizeAskUserRequest()` 负责生成稳定 ID、将第一项标为推荐并启用客户端自由输入，Controller 不得手工组装中断内容。子 agent 正常执行与
审批恢复路径都经同一 `builtin:task` executor 和 Builtin `projectSubagentResult()`，不存在 Core 或手写的第二份
task 结果格式。

Prepared production dispatch 在执行前验证 frozen catalog entry 的 parsed arguments、identity、revision、schema、
availability 与 governance facts，然后只通过 supplied Host `CapabilityExecutionPort` 调用对应 Builtin operation；
旧 direct dispatch/helper owner 已删除，test-only helper 不得由 production source 导入。filesystem entry 只经 Pipeline
注入的 dispatcher 取得 observation/preimage 投影，读取 freshness 与 mutation-ready authority 留在 Runtime，permit、
network mode 和授权来源仍为治理事实。Controller 不得直接 dispatch executor、创建第二 registry/snapshot 或绕过 Host
port。双路模型文本继续使用 `streams`，单流工具使用 `modelContent`，`resultMeta` 与 classifier advice 保持结构化。
Runtime-action/coordination execute 输出中的 events 在模型投影之外返回给 Controller 原子提交，展示不由 Builtin contract
决定。

当 run 携带 sealed `ExecutionBoundary` 时，Builtin catalog entry 还从 capability contract 的
`protectedPathAccesses()` 取得结构化 `path + operation`。Evaluator 同时匹配未 realpath 的 lexical
Workspace identity 和 canonical target。按 ADR-0118，文件 read 对任何有效路径 allow，Workspace 内
write 对所有名称 allow，Workspace 外 write 返回 prompt；按 ADR-0131，execute/process 对 Workspace 内所有
名称同样 allow，additional deny/allow 与 protected name 只能约束 Workspace 外 identity。Tool Pipeline 在 grant 签发前固定 evaluator revision；Local Provider 再验证
canonical Workspace、`workspace_only | external_read | approved_external` scope 与 no-follow identity。
read/write/edit 分别声明实际 access，search 声明 root read且不再按 protected 名称过滤。完整 builtin tuple 的
`filesystem!=none` spec 必须具有该声明，或显式位于闭合例外集：`read_plan`、
`read_skill_reference`、`shell_execute`、`task`、`activate_skill` 分别由 typed Plan Artifact、Skill
reference allowlist、native sandbox、child Harness、compiled inline/fork adapter 接管。闭合例外测试
会让新增 filesystem builtin 在遗漏 hook 或边界说明时失败。
production execution 标记存在但 surface/evaluator 缺失时同样在 adapter I/O 前 fail closed。external mutation
与敏感 external read、任何 external recursive search 必须在 adapter I/O 前完成当前模式授权：Full 直接授权、
Auto 三态审查、其他模式 exact approval；一旦获批，文件 Provider 与 Shell native
profile 都不得按 protected path 二次拒绝。`checkDangerousPaths()` 是 Policy approval classifier；关键 destructive
command deny 仍独立存在，且两者不得重新引入 Workspace 内名称级拒绝。

## 自治规则

1. 普通问答不使用全局 stop-check；没有未决 Effect 或 required verification 时可直接完成。
2. Read-only Builtin 对普通有效单文件路径免审并为 Workspace 外读取使用 observe-only `external_read`；敏感
   external `read_file` 或任何 external recursive search 必须完成模式感知授权。当前受信任 Workspace 无论位于
   何处，Building 阶段内可证明只作用于其内部的结构化 `write_file`/`edit_file` 可直接执行；raw Shell 与 Git
   在对应 phase baseline 内可 direct，已知 external/sensitive scope 才在 Full 直接授权、Auto 三态审查、Accept
   Edits 请求用户审批并密封为 `approved_external`，批准后不再受文件名称 deny。Local Provider 不从 mode、用户字符串或旧 `allowExternal`
   boolean 推导批准。Windows operation 使用 runtime context 指示的原生路径，并按 ADR-0122 由 locked directory
   handle 发布；native handle capability 不可用时仍以技术能力不足 fail closed。
3. `accept_edits`、`auto`、`full` 是当前唯一可密封到 Subagent grant 的交互模式，只决定交互策略，不取消
   capability schema、revision、minimum approval 或 sandbox 检查；旧的 `default` identity 必须在 Driver/
   Provider I/O 前拒绝。
4. Authorization grant 只在声明的 thread/workspace/command 范围有效；新 thread 不继承单次授权。
5. 空命令、明确的关键系统递归删除和关键系统 repository destructive Git 保持 hard deny。其他所有 Shell
   不从固定 grammar 推导 allow：Full 可直接授权，Auto 由模型批准、拒绝或升级用户，Accept Edits 请求用户审批；
   same-command 是否可复用仍由编译策略决定。
6. 批量 tool calls 必须逐个进入相同策略；一个只读调用不能掩盖同批写入调用。连续调用仅在
   每项都已持久化为 `read_only + sideEffect=false`、属于无交互语义的内置读取工具且
   Approval Policy 再确认无需审批时，才可组成最多 4 项的并行批次。`ask_user`、Plan/
   Skill/Task/Tool Search、动态 MCP、已审批恢复、写入、未知分类和需要审批的调用都是
   独占屏障；屏障后的读取不得越过它。同一模型消息、同一任务中的连续
   `shell_execute` 逐项完成策略预检并进入 durable approval queue；获批调用先进入
   `authorized_queued`，仍受 scheduler concurrency 和独立 receipt/attempt 约束。单个调用的策略拒绝
   只终结自身；Approval overlay 的 Esc 只拒绝 focused target，不主动取消 sibling，且在 sibling 自身收敛后以一个
   exactly-once `turn.aborted` 关闭不可继续调模型的拒绝轮次。Ctrl+C 才立即取消整个当前 turn：其余未终结 sibling cancelled，
   已启动执行收到 AbortSignal，Runner 不再继续审批、执行或调用模型。策略拒绝和系统失败不套用这一用户取消语义。Shell 重叠在非 Shell 调用、
   不同模型消息或不同任务边界处截断，不得
   跨越 `ask_user`、方案审核或其他工具。当前事件集合不包含 `tool.execution_ready`；审批推进只接受
   带精确 interaction/tool identity 与 generation 的 canonical release：单调用为 `approval.granted`，
   same-command 为单个原子 `approval.batch_released`，不得循环 N 个旧 grant 事件。
7. `ask_user` 的拒答或取消不是工具审批拒绝。它只产生一个失败的成对 Tool Result 并清除
   用户输入交互，Runner 必须继续同一 turn，让模型在缺少该答案的情况下继续；不得发出
   `turn.aborted` 或中止其他执行。Schema 校验失败尚未创建用户输入交互，TUI 必须把它
   显示为工具错误，不能伪装成 `(no answer)` 或 `User: ...`。
8. 方案执行确认是授权屏障。用户取消 `request_plan_review` 时保留方案 draft，但取消方案
   工具和所有未终结 sibling，发出 `turn.aborted(cause=user)`，Runner 立即退出；不得把
   取消投影成成功的 `review_cancelled` Tool Result，也不得继续调用模型。
9. Planning 非 Full 使用 Workspace read-only baseline；baseline 内可证明的 Shell direct，已知扩 scope 按 Accept/Auto
   进入 user/reviewer approval queue。Planning Full direct 执行并保持 Plan lifecycle。`write_file`、`edit_file` 与实现型 Subagent 等其他阶段越界使用
   `phase_denied` 硬拒绝，不创建 approval；模型结果必须明确当前阶段不可审批并要求把实现
   意图写入 Plan。文件编辑拒绝在 TUI 保留“Plan mode 只读、文件未修改、方案批准后执行”的
   可操作提示，但不物化未获准执行的 Tool Card，不能只显示通用 `Rejected ...`。破坏性
   Shell 仍使用硬安全策略拒绝。
10. 统一 AbortSignal 命中时，正在执行的 Shell 必须先完成有界 process-tree 清理并回传
    `processCleanup`；未确认 descendant 退出时另发 `cancel_incomplete`。若此时前台正等待
    sibling approval，Runner 必须先排空后台 terminal/diagnostic 再结束，不能提前关闭
    RuntimeStore 或 logger。

## 文件原像与可逆性（ADR-0042 §4）

`write_file` / `edit_file` 改动工作区文件前，工具执行链捕获目标文件原像，成功写入后记录
最后一次 Kite 写入结果的内容指纹，一并存入 RuntimeStore。这是 `accept_edits` 等模式
自动放行工作区写入的可逆性底牌：`/rewind` 可以独立恢复代码，或在保留源会话的前提下
fork 恢复会话并恢复代码。约束：

1. 捕获是 best-effort：同一检查点窗口（上一次 turn 快照之后）内每个 path 只保留最早
   原像，并持续更新最新成功写入的后像指纹；捕获失败不得中断工具执行。
2. 子 agent（task）的工具写入经同一条记录链捕获。
3. TUI 的会话恢复默认使用 `forkSession`，不截断源会话；“代码和会话”先确保 fork
   成功，再按源 thread 的恢复计划修改共享工作区。
4. “仅恢复代码”不改变 transcript；“仅恢复会话”不改变共享工作区。
5. App checkpoint 调用方若使用破坏性的 `restoreNamedSnapshot`，文件恢复仍必须先于它执行，
   因为该原语会截断检查点之后的原像。
6. Fork 复制选中恢复点及其之前的命名恢复点与原像行，并把二者的事件位置重映射到新
   thread 的事件 ID；本身不改动共享工作区文件，恢复后的会话仍可继续向更早边界回退。
7. 文件恢复必须先确认当前内容仍等于最后一次 Kite 写入结果；后续手动/Bash 修改或删除
   形成冲突并跳过。旧数据库中没有后像指纹的记录不得盲目恢复。
8. Fork 的事件复制保留原始时间和 envelope metadata；事件日志损坏时在目标 thread 写入前
   fail closed。新 thread 清除 full access、命令 grant、turn-scoped capability、Provider
   session waiver 及所有待处理交互/执行，不把源会话授权扩大到恢复出的会话。
9. 自动命名恢复点在 `turn.completed` 后创建；TUI 对恢复确认和执行双层防重，并在所有范围
   执行前验证恢复点存在且快照可解析。

## 动态 Capability

MCP Tool 必须具有当前轮 binding；catalog 或 descriptor revision 漂移时 fail closed。Skill 必须是已编译 Workflow Contract 并形成 Runtime activation/frame；不存在返回 SKILL.md 正文的旧 `Skill` 工具。Subagent 与 Skill fork 的能力集合是 ceiling，不是授权。

通过 binding 解析出的 MCP 本地策略必须从 Tool Controller 传递到 prepared Tool Pipeline dispatch，不能在防御性二次审批时丢失。只有 `minimumApproval=none` 且 filesystem、network、external state 三个 effect 维度都为 `none/read` 时，能力才属于已证明只读；任一维度为 write 或未知都保留审批边界。该规则同样适用于 Subagent 内的 MCP 调用。

Capability search 只负责发现。搜索候选不能作为调用句柄，也不能绕过后续 binding、policy 和 approval。

`list_mcp_resources` 与 `read_mcp_resource` 是无审批只读内置工具，但仍经过统一 Tool Controller、Provider/URI 有效性和输出大小治理。MCP Tool、Resource 列表或读取的任何错误只终止当前 Tool Call，并必须向模型产生结构化、成对的 Tool Result；Tool Controller 不得把 Transport 异常升级为会话级未捕获错误。HTTP/SSE 恢复由 Supervisor 串行处理，STDIO 断线等待用户显式 Retry，均不扩大原调用授权。

## 执行与完成

`ok` 或 provider success 只表示一次 Execution 收敛。外部写入先持久化 invocation intent；未知终态禁止盲重放。包含 write/destructive/unknown effect 的受治理能力按 Verification policy 创建 required 验收，未通过时不得 `run.completed`。

## 禁止事项

- 不得根据 `mcp__` 名称字符串直接推断权威能力身份。
- 不得相信远端 annotation 自行降低审批。
- 不得让 Skill manifest 自行授予权限。
- 不得把 approval 与 sandbox 合并为一个开关。
- 不得从 UI summary、模型 final 或 ToolMessage 文本推断任务完成。
- 新的 Builtin catalog entry 自动获得与其 classifier `effectClass` 对应的审批默认策略（`read_only`→放行、`plan_only`→放行、`workspace_write`→模式策略、`external_side_effect`→审批），不再需要逐工具手工维护审批矩阵。仅存在明确安全边界（URL 校验、外部路径、命令分类、MCP binding）的工具才需要专用分支。

Skill 的 readonly 分类比单个 Tool 名或 manifest 声明更严格：自身和全部 dependency 的 effective
effects 必须明确为 `none|read`，且 provenance/Workspace Trust 满足；write、destructive、unknown、
解析失败或 revision drift 都归 effectful/off。`allowed-tools` 只是 ceiling，不是授权；effectful Skill
还必须经过 required Verification。

## 工具结果结构化元数据

工具完成时的 `resultMeta`（`path`、`totalLines`、`command`、`matchCount`、`rawResultDigest`、`modelContentDigest`、`digestScope`、`intent`、`truncated`、`resourceRevision`）由 App Tool Pipeline 写入 Runtime Tool Call record，通过 `ToolCallResult` 进入 `RuntimeState.tools.calls`。Runner 必须在 MCP normalization、serialization 和任何模型可见截断前计算 raw digest，并显式传播截断状态；Controller 对模型可见内容计算 model digest，不能把 projected digest 标记成 raw。这些字段用于审计、恢复和摘要输入中的结构化事实；当前模型上下文不执行工具结果投影折叠。行为上不改变权限决策或审批路由。

## 子 Agent 阻塞审批请求构造

子 Agent 因工具审批阻塞时，Controller 通过 `buildBlockedToolRequest` 构造 `PendingToolRequest`：优先走 Builtin projection 的
`toolRequestFromCall` parser 获得类型化请求。未知/不可用工具只产生最小失败 request；App adapter 不执行 executor、不提供 schema/effects/authority，
也不是 production executor fallback。不再手工 `as PendingToolRequest` 强转。失败分类的 `parseFailureCode`
（`invalid_json` | `unknown_tool` | `tool_unavailable` | `invalid_arguments`）通过 `InvalidToolRequest` 透传到 `ClassifiedFailure`；
前两类参数错误映射为 `tool_invalid_args`，`unknown_tool`/`tool_unavailable` 映射为 `tool_not_found`，父 Runtime 与 Subagent 使用同一恢复策略。Builtin `projectSubagentResult()` 只序列化显式 model allowlist（ok、summary、error、toolCallCount、durationMs 与 planning continuation action）；Controller 在私有事件通道合并 child journal，`toolRecovery`、execution journal、exhausted fingerprints、steps/args 与 continuation 不得进入 parent transcript 或下一次 Provider payload。

Subagent 的执行上下文由父 Runtime 显式传递：`interactionMode` 使用当前 live state，并仅对可由同一 model message、turn 和 `subagent_type=explore` 证明的多 Explore sibling 把 `accept_edits` 特化为 `auto`；恢复不复用挂起时的过期模式，也不从展示组或 task 正文猜测。Workspace 先 canonicalize，再同源用于模型 `Workspace`/`CWD` 与工具路径解析。文件编辑的 read-before-edit freshness 使用 Runtime-issued child id 作 actor scope，正常 child loop、阻塞工具获批与恢复后续 loop 必须保持同一 id；Parent 或 sibling 的读取不能为当前 child 授权编辑。
> Test path synchronization: tool pipeline qualification suites now use domain-neutral filenames; the tested acknowledgement, receipt, and terminal ordering remains unchanged.
