# Runtime 韧性与 bounded soak 资格门禁

状态：active

读取时机：修改 Runtime 持久化/恢复、模型或 MCP 故障处理、Sub-agent 取消清理、TUI 长生命周期测试，或生成 release fault/soak evidence 时。

验证：`bun run test:runtime:fault`、`bun run test:runtime:soak`、`bun test tests/model-invocation-gateway.test.ts tests/model-invocation-recovery.test.ts tests/execution/workspace-filesystem-provider.test.ts tests/execution/sandbox-execution-provider.test.ts tests/execution/posix-supervisor.test.ts tests/runtime/store.test.ts tests/mcp-manager.test.ts`、`bun test tests/subagent-artifacts.test.ts tests/subagent-provider.test.ts tests/runtime/agent.integration.test.ts tests/runtime/event-codec.test.ts tests/runtime/kernel.test.ts`、`bun run test:tui:system`、`bun run typecheck`。

相关：`six-concept-runtime-architecture.md`、`failure-classification.md`、`cancel-resume-cleanup.md`、`tui-e2e-testing-limits.md`、ADR-0115、ADR-0116、Task 1C.7。

## 两级运行契约

`scripts/runtime/run-fault-soak.ts` 是固定 seed、固定 case manifest、单 case硬上限和 runner 级全局 deadline 受限的 runner。它只输出版本化 JSON 元数据，不把测试 stdout/stderr、prompt、工具 payload 或 workspace 绝对路径写入 evidence。失败诊断最多保留在当前进程 stderr 中；写入 `--output` 后必须显式收紧为 `0600`，包括覆盖已存在的宽权限文件。Required CI 运行 fault contract 与 CI profile；`.github/workflows/runtime-resilience-qualification.yml` 提供显式手动 qualification。正式 workflow 只允许 `seed=1729`、`iterations=8`，输入先进入环境变量并以引号传给 runner，禁止把 dispatch input 直接拼进 shell。qualification 的全局 deadline 固定为 `56 × 180000 ms = 168` 分钟；每个 child 的实际运行时间从剩余全局预算和单 case 上限中取更小值，并预留 30 秒做 SIGKILL、最多 5 秒二级 reap、最多 2 秒输出 drain 与单次最多 1 秒的有界 `ps`/Git inspection。全局预算不足时不再启动 child，而是为剩余 attempt 写入 typed failure。job 的 190 分钟上限在 runner deadline 之外保留 22 分钟 workflow 余量；验证和上传步骤使用 `always()`。checkout、Bun 安装或 GitHub 基础设施在 runner 启动前失败时不会伪造报告。

- `--profile=ci` 默认每个 case 运行 1 次。它验证 case 覆盖、退出状态、从实际通过测试输出提取的必需终态断言、状态不变量、runner 自有临时目录清理、Git worktree registry、进程树回收和报告结构；平台不支持的资源指标会显式记录为 `supported: false`，但不会把 CI smoke 误判为 release qualification。
- `--profile=qualification` 默认每个 case 运行 8 次。少于 8 次、任一必需资源指标不支持或无法确认 owned descendant PID 时，结果必须为 `inconclusive`；case、状态、清理、deadline 或资源趋势失败则为 `failed`。只有全部条件收敛时才能为 `passed`。
- runner 退出码为 `0=passed`、`1=failed`、`2=inconclusive`。`inconclusive` 不是成功，也不得被 completion/Release evidence 表述为通过。

固定 case ID 为：

1. `long_runtime_replay`：长事件回放、真实 Runtime 多轮/工具/审批和 compaction 状态；
2. `subagent_cancel_recovery`：Sub-agent 读写、审批、恢复与中途取消；
3. `model_transient_stream`：partial stream/reconnect、瞬时连接/5xx 和 rate-limit failure-mode 预算；
4. `mcp_churn`：真实 stdio 调用中退出、HTTP reconnect、auth、catalog revision drift 和 circuit 状态；
5. `runtime_sigkill_recovery`：在持久化 active Task、Plan、Verification、reservation intent 后 `SIGKILL`，重开后把未确认 dispatch 收敛为 `unknown`；
6. `storage_and_logger_faults`：真实 SQLite writer lock、确定性 `SQLITE_FULL` 和 logger failure containment；
7. `tui_lifecycle_churn`：session switch、tool lifecycle 和 model stream reconnect 的 PTY 进程生命周期，
   并通过 `--with-lifecycle-harness` 显式追加专用 focus-reporting lifecycle harness。

TP-03 把该恢复契约扩展到 parent Runtime 的 builtin、MCP、Skill 与 Subagent 外层 invocation。每次 adapter attempt 必须在
`capability.invocation_recorded + capability.execution_started` batch ack 后发生；已知 adapter failure 写失败
Artifact receipt，dispatch 后 Artifact/terminal receipt 无法确认则进入 `capability.execution_unknown` 且不得
自动重试。进程恢复时，非 suspension 的 recorded/running invocation 都收敛为 unknown；拥有 durable
Subagent continuation 或 Runtime interaction 的 suspension 保持可恢复，并在后续 action 的 Tool terminal
批次闭合其已记录结果 Artifact。测试必须覆盖 no-intent-no-dispatch、artifact crash point、atomic terminal、
unknown reconciliation 与 restart 后零重复 dispatch。

PS-01 已让 Subagent 内部 filesystem tool 由 parent Runtime 建立 namespaced queue，并递归执行同一完整
Tool Pipeline；PS-03 又把 child lifecycle/observation 接到唯一 `SubagentProviderV1`/Local composition。启动顺序
固定为外层 attempt exact ack → private dispatch intent → Provider prepare（零 Driver/Gateway/tool I/O）→ private
sealed handle publish → low-information handle-ready ack → activate。Provider denial 在 intent 后以显式 undispatched
cleanup intent/receipt 闭合；ready ack 前失败不得 activate。ready/activate 后 crash、stale、oversize、Artifact fault
或 cleanup timeout 必须进入 `capability.execution_unknown`，不得提交普通失败 receipt 或自动重放。

current schema v25 以五类 `capability.subagent_*` 事实保存 exact attempt、opaque task/handle ref、keyed
dispatch intent、observation 与 cleanup ordinal；event codec、reducer 和 snapshot invariant 都拒绝额外字段、非法
digest、字段组或 lifecycle 倒退。startup 在任何新模型/Driver dispatch 前以同一 installation-private handle
verifier 回读，对 prepared handle 直接 abandon，对 active handle 执行一次 bounded cancel/settle/reconcile；跨进程
只在 sealed PID 与 process-start identity 证明旧 owner 死亡后确认 cleanup。pending/unknown 不重复 start/resume。
cleanup 未确认继续 hard block，确认后 outer invocation 收敛 unknown。Fork 在 source current 或 named recovery
point 仍持有 pending Subagent authority 时于写 target 前拒绝；cleanup-confirmed fork 会清除 target 的私有 handle authority。

Local cancel 只有一个不超过 3 秒的绝对 cleanup grace；prepared cancellation、activate-before-observe crash 与
same-process startup 都必须有界收敛并释放 registration/handle。Fake deny/crash/stale/recovery 没有 Local 或
legacy fallback。Provider 的 consumed-grant、stopped/unconfirmed handle 与 Driver pending-registration ledger
不能随进程寿命无界增长：grant tombstone 按 sealed expiry 回收，其他 recovery hint 按短 TTL/固定总容量回收；
expiry clock 必须是 finite safe integer 的非递减 high-water，wall-clock 回拨后不能让旧 grant/hint 重新有效；
丢失 hint 时只能保守进入 `recovery_required`，不能把未知 cleanup 解释为 stopped。

PS-01 把相同 crash boundary 延伸到 Workspace filesystem mutation：invocation/attempt ack 之前不得签发
prepare grant；prepare 必须零写入；private preimage Artifact 与
`capability.filesystem_mutation_ready` ack 任一失败时 commit 调用数为零。commit grant 是 purpose-bound、
short-lived、single-use，并精确绑定 prepare target/preimage；final check 前发现的外部修改、symlink swap、
取消或 expiry 都必须留下原文件不变。Unix final publish 必须消费 pinned parent descriptor，使 final check 后
的 namespace swap 不能重定向越界；atomic rename 已发生而 Provider 无法返回 terminal evidence 时必须收敛为
commit-unknown，恢复与 retry 都不能重复 dispatch。成功 read observation 只有随 terminal receipt durable
commit 后才可授权同 actor edit；未读和 stale read 分别稳定失败。Fake deny/crash 不调用 Local，生产路径
也没有 legacy file/search fallback。current-format restore 对 filesystem intent/ready 使用 exact schema 与
digest 校验；attempt ordinal 前进时先清除旧 attempt authority。带 observation 的成功 receipt 还必须用
同一 installation Capability Artifact reader 验证 payload owner、result/evidence digest 与 observation exact
binding；production restore 不匹配时进入 corrupted，verification/edit consumption 则在任何模型或 Provider
dispatch 前 fail closed。fault/soak evidence 不得记录 preimage 正文、路径或 grant。

PS-02 把 crash boundary 继续延伸到 allocating sandbox preparation 与 process dispatch。allocation 前必须
durable ack preparation intent，完整 private plan Artifact/ready ack 后仍不得立即 spawn；Runtime 还要先
durable ack single-use dispatch identity。POSIX Runtime 在 spawn 前创建 owner-only exact dispatch lock，并把
已持有的 `flock` 作为 fd 3 继承给 supervisor；即使 host 在 spawn 返回与 PID/start identity durable ack 之间
崩溃，restore 也只能在该继承锁可重获后确认 supervisor 已退出。GO 前还必须用 Linux boot ID/start ticks/PGID/
executable digest 或 Darwin `proc_pidinfo` 微秒 start timeval/PGID/executable digest 精确绑定 supervisor；不得用
秒级 `ps lstart`，identity mismatch 时不得 signal 可能复用的 PID/PGID。control socket 位于 host-only
control root，sandbox 只获得独立 data root；首个合法连接后立即停止 listen。release executable 内嵌同一
supervisor mode，supervisor 只继承显式最小环境，output pipe EOF 使用固定 deadline，超时 abort 且
`cleanupConfirmed=false`。Darwin Seatbelt 的实际 detached/session negative conformance 位于
`tests/execution/posix-supervisor.test.ts`；恢复路径即使成功终止 PGID，也必须把
`descendantContainmentProven=false` 传给 reconciliation，保留 pending cleanup authority。Apple
`launchd.plist(5)` 仅定义同 process group 的 kill 行为，不能替代 detached/session descendant 的
kernel/descriptor owner；因此 Seatbelt 当前直接 backend unavailable。Windows 也因 handle-relative
runtime cleanup 未证明而 unavailable。

Linux bubblewrap 的 hard-count candidate 已有 Runtime-owned unit/strict path 与 kill/empty parser contract，
但当前 dispatch record 不能在 GO 前 durable ack 实际 ControlGroup，也不能持久化 empty receipt。Local Provider
因此对 `maxProcessTreeTasks` 保持 `cgroup_pids_cleanup_authority_unavailable`，不会启动该 scope；restore
不会把 GO 后临时观察、unit/path 消失或缺失 empty receipt 当作成功。该 negative/contract 测试不改变 Linux
excluded/support-set 结论；只有后续 lifecycle authority 完整后才可加入 native qualification。

PS-02 实现证据提交 `28e857f8f41913feee5eacd17a2e61fe6cbb439e` 已由
[run 32096568806](https://github.com/ferqx/kite-code/actions/runs/32096568806) 的三个 Required
GitHub-hosted job 产生并通过独立 verifier 的 evidence/verification artifact，因此 PS-02 状态已从
`waiting_ci` 收敛为 `completed`。三个 outcome 均仍为 `excluded`且 `productionSupported=false`；
该状态变化只确认 Provider/lifecycle/recovery/no-bypass 实现和原生负向证据齐备，不证明任一
allocating backend 已获 production admission。
所有失败分支先通过 fixture 私有 stop sentinel 做 bounded settle；这只是防泄漏措施，不能
被计为 exact kill 或 empty cgroup proof。

当前 fault/soak 只运行本页固定的 Runtime contract cases；不会引入旁路评估数据或生产 Runtime authority。

ready-but-undisposed restore 要交叉验证 exact Artifact、ready backend/capability/enforcement/semantics 与全部 plan
digest；POSIX process group 或 Windows Job/ACL cleanup 未证明时 `cleanupConfirmed=false`，禁止删除 runtime 或
提交成功 disposal receipt。intent-before-ready allocation 通过确定性 identity 与 abandonment receipt 回收。
若 POSIX 私有 runtime base 在 cleanup 开始时精确不存在，则它证明该 preparation identity 没有留下任何
runtime allocation，cleanup 可幂等确认；除 `ENOENT` 外的查询失败仍 fail closed，不能被解释为“已清理”。
failed cleanup receipt 保持同一 lifecycle intent pending，并记录递增 attempt/last failure；下一次 recovery 只尝试
一次且不 reprepare/respawn，成功 receipt 才 completed。Fork 在 source snapshot 或其将复制的任一历史 named
snapshot 仍有 preparation/ready/disposal/abandonment cleanup authority 时必须在写 target 前拒绝该 recovery point，
不能复制或争抢 cleanup owner。测试必须覆盖 compiled standalone、cross-consumer reuse、spawn/identity crash
window、same-era PID identity forgery、Artifact corruption、cleanup unknown、Fake deny/no-fallback 与 source/named
fork negatives；这些定向测试不替代本文件的完整 fault/soak qualification。

seed 只决定每轮 case 的旋转顺序；不能减少固定 case 集，也不得传入 Bun test 改写 test scheduler。每个 probe 只允许一次 runner invocation；测试型 probe 由 coordinator 把各功能文件放入隔离 child 且各运行一次，避免共享 Yoga/全局 fixture。Qualification 只对 manifest 中每个 case 明确选定的真实代表 lifecycle 文件保留 1 次 warm-up 和 8 次 measured rerun；dedicated long-replay 还先执行 2 次不进入报告的 allocator/JIT prewarm，其他 lifecycle 不增加该步骤。不能重放整个大型功能 suite 后把 Bun test runner 自身保留的断言/fixture 内存归因于产品泄漏。测试 helper 在每个测试边界必须清除它自己创建的临时根；依赖进程退出或整个重复文件结束的清理不构成 lifecycle cleanup。long-runtime 当前以 deterministic state replay 和测试专用 `runTestRuntimeAgentV1` 对 production `executeRuntimeTurnV1` 的真实 budget workload 为资源 lifecycle；该 helper 只组合 State 25/Store 4 test port，不是 production fallback；其他 case 分别选择 cancel/recovery、deadline、MCP supervisor、SIGKILL/SQLite fault lifecycle。超时后必须终止整个子进程树。Unix probe 使用独立 process group；fault-soak 内的 TUI per-file 与 lifecycle child 必须继承该 group，不能再创建 `ps` 缺失时无法发现的 nested detached group。runner 同时以 parent/PGID 双重采样 owned PID；每条 telemetry 还必须匹配 attempt nonce、PID、OS process-start identity、lifecycle ID 和 group nonce。报告必须精确收到 manifest 声明的全部 qualification lifecycle group；短命 child 即使错过 50 ms 采样，也只能凭有效 nonce 绑定补入 owned PID 集，任一声明组缺失、重复或未绑定均使 qualification `inconclusive`；同一 probe 中仅运行一次的功能文件 telemetry 不进入 qualification series。正常退出后发现的后代同样先记录为 orphan；runner 必须重新读取并匹配 OS process-start identity 后才可将 PID 计为 orphan 或强制清理，数值 PID 已被复用时不得触碰新进程，身份无法确认则 inspection unsupported。`ps`/`git worktree` 因平台缺失或权限策略无法启动、抛错或非零退出时必须转为 inspection unsupported，使 qualification 结构化 `inconclusive`，不能在报告前崩溃。stdout/stderr 在进程退出后最多等待 2 秒 EOF，持有继承 pipe 的漏杀后代不能让 runner 永久挂起。外层 probe 超时时对已经采样的 PID 先绑定 process-start identity，kill 前再次核验；可发现的 nested detached group 先按 PPID/PGID 快照并由深到浅终止，最后终止 coordinator group，不能先杀 coordinator 导致后代 reparent 后失去 ownership。runner 为每个 attempt 分配独立临时目录，并把普通临时残留记录为 `residualPaths`；`orphanWorktrees` 只来自 probe 前后 `git worktree list --porcelain` 的 registry 差集。任一残留、orphan worktree 或 orphan PID 都是 hard failure。

## 报告与资源判定

报告 schema 当前为 v2，并包含 runner revision、seed、profile、平台/Bun 版本、逐 attempt 的状态/清理/resource series、每个 case 的 p50/p95/p99、状态不变量、资源摘要和 SHA-256 canonical digest。CI 报告可记录 `source.kind=local`；qualification 只有在 `source.kind=github_actions` 且 repository、40 位 head SHA、完整 ref、workflow 文件名、GitHub `workflow_ref`/`workflow_sha`、run ID 和正整数 run attempt 全部存在时才可能为 `passed`，缺失时必须为 `inconclusive`。这些字段和 retained attempt evidence 都进入 canonical digest，不能靠 artifact 页面上的旁证补写。digest 是完整性字段，不是单独的真实性证明；真实性根是成功的 GitHub Actions run、由可信 GitHub context 提供的 expected identity 以及被审查 head。`runnerBudgetUsage` 只表示外层 probe invocation 与 wall-clock 上限；`runtimeBudgetUsage` 仅来自 long-runtime case 中 `runTestRuntimeAgentV1 → executeRuntimeTurnV1` workload 的 actual reconciled/committed `ResourceBudgetV1` ledger receipt，reducer-only 合成状态不得作为该证据，二者也不得混写。Qualification 的每个 long-runtime attempt 必须保留 9 条 receipt provenance；每条 receipt 还必须与同一条 process resource lifecycle 在 case、iteration、lifecycle、PID、sequence、attempt nonce、OS process-start identity 和 group nonce 上完全匹配，错轮或未绑定的 receipt 一律使该证据 unsupported。

正式 workflow 在上传前运行 `scripts/runtime/verify-fault-soak-qualification.ts`。verifier 以 workflow 的可信 GitHub context 重新匹配 source identity、重算 report digest，再从 retained attempts 重新构建 case/aggregate 摘要；它要求 Linux x64/Bun 1.3.14、固定 7 case、每 case 8/8 通过、合计 56/56 probe、精确 wall time、完整 terminal/state assertion、零 orphan/residual、long-runtime 每项资源 128 个 measured 样本、其他 case 每项 64 个样本、全部资源不超阈值，以及 long-runtime 分 8 个 attempt 的 72 条带 provenance Runtime ledger receipt。runner 或 verifier 任一失败都使 workflow 失败；artifact 即使被保留也只是诊断材料，不能登记为通过证据。

`terminalTaxonomyAssertions` 表示“通过的 probe 对该终态分类完成过断言”的覆盖次数，不是线上事件发生频率。runner 只能从对应测试的 `(pass)` evidence 中提取该字段，不能因为进程 exit=0 就按 manifest 硬编码覆盖；任一固定 case 缺少必需分类证据时直接失败。不得把它解释为 incident count 或成功率。

`stateInvariantAssertions` 同样只能从 manifest 声明的实际 `(pass)` evidence 提取；测试标题变化时必须在同一改动中同步对应 matcher。child 进程成功退出但 matcher 未命中时仍应 fail closed，不能把“测试执行成功”冒充“目标不变量已被断言”。

qualification 必需指标为 child RSS、active resource、FD、process listener、active handle、owned descendant PID、Git worktree inspection，以及 long-runtime attempt 的 actual Runtime budget ledger receipt。只有 warm-up 后在同一 PID、同一 process start nonce 内执行 bounded repeated lifecycle 的资源样本才能标记 `qualificationEligible: true`；每个 case 的 attempt iteration 必须精确覆盖 `1..8`。由 fault-soak telemetry preload 采集的 Bun test repeated lifecycle 在 before/after 采样边界各执行两次强制 GC，并在 GC 前、两次 GC 之间及末次 GC 后各让出一个 event-loop turn，使第一轮 finalizer 安排的清理先完成；这只移除不可达的 fixture/JIT 临时对象，不改变仍被 Runtime 活引用保留的对象，GC/settle 失败必须使 probe 失败。CI fresh-process diagnostic 与使用独立采样 fixture 的 TUI Ink lifecycle 不执行该 preload settle。warm-up point 固定 `sequence=0`，before/after 必须为有限数、duration 非负、deadline 为正且 cleanup 已确认；8 个 measured lifecycle point 必须携带 before/after、连续 `sequence=1..8`、正 deadline 和 cleanup receipt。跨 metric 的 lifecycle/process provenance 使用结构化字段比较，不能用允许字段边界碰撞的分隔符拼接。资源 leak 的 hard gate 只统计稳定 retained state：第一个 measured `before` 是本 lifecycle 的基线，任何增长必须在随后两个已 settle 的 measured `before` 边界仍存在，才与该基线比较下列阈值并构成 hard failure；最后 8 个 measured `before` 中至少 6 个相邻步骤增长且首尾增长超过同一阈值时，也视为持续正斜率。单轮 `after - before` 和少于三条边界的 allocator plateau 仍进入带 digest 的审计证据，但不能冒充 retained leak；这不放宽阈值，也不允许跨轮或跨进程样本掩盖保留状态：

long-runtime 的 repeated resource lifecycle 固定使用只包含 10,000-event replay 的
`fault-soak-long-runtime-lifecycle.test.ts`。它先运行 2 次不进入 retained evidence 的 allocator/JIT
prewarm，再保留规范的 warm-up 和 8 个 measured point；actual Runtime budget lifecycle 仍只运行
规范的 warm-up + 8 measured，从而继续产生精确 9 条 receipt/attempt、72 条 receipt/run。其他
SQLite corruption/recovery stability tests 仍进入默认功能门禁，但不得混入 long-replay RSS lifecycle；
这样资源门禁测量的是已声明工作负载，而不是同文件中无关 fixture 的 allocator 叠加。

- RSS：32 MiB；
- active resource、FD、listener、handle：2。

CI profile 的普通 Bun test probe 通过 preload 采集 fresh child 的 `beforeAll/afterAll`，其中包含模块加载、JIT 和测试 fixture 冷启动；报告保留这些诊断值，但必须标记 `qualificationEligible: false`，不得套用 leak 阈值。Qualification profile 仅使用 manifest 选定 lifecycle 文件的同进程 rerun series。TUI 的 session switch、tool lifecycle 和 model reconnect PTY 场景仍按文件隔离，只证明功能与 terminal taxonomy，不提供资源斜率结论；fault-soak 必须使用 runner 的显式 `--with-lifecycle-harness` 参数把专用 harness 作为单独文件加入同一 probe，不能依赖普通 scenario 发现规则或历史输出偶然执行它。TUI 资源资格范围明确限定为该专用 child 中的 `InputLine`/`TerminalFocusStore` focus-reporting mount/unmount lifecycle。该 child 在同一真实 Ink 进程内完成 warm-up 加 8 次重复，逐次证明 DEC 1004 先开启、随后关闭，并确认没有竞争性的 `process.stdin` `data` listener 和残留 descendant。只有 `tui-input-focus-lifecycle` 可以作为该范围的 TUI qualification 资源样本；它不得被表述为完整 session/tool/model PTY 生命周期的内存证明，PTY parent 和跨文件父 runner 趋势也不得替代它。

本机或 CI 若不能确认 `ps` 进程树、Git worktree registry、完整 same-process series 或上述 TUI child ownership，正式 qualification 必须返回 `inconclusive`。Task 1C.7 只有 workflow 已存在于默认分支、Ubuntu 手动 run 在被审查 head 上完成、verifier 通过且上传 `status=passed` artifact 后才可关闭；两轮本地 CI profile 通过只证明 smoke 可重复，不等于 release qualification。

`package.json` 中的 `release:contract:build`、`release:contract:verify`、`release:contract:smoke` 与
`release:gate:foundation` 只运行 non-production synthetic Release Contract fixture；它们不重跑、
替代或升级本节的正式 Ubuntu fault/soak qualification artifact。后续 release evidence 若引用
Runtime 韧性结论，仍必须绑定上文默认分支 run、独立 verifier 与完整 retained attempts identity。

ADR-0068/ADR-0069 的 G0/G1 不以该深度 qualification artifact 为门禁；当前 `release:build`、
`release:verify`、`release:smoke` 是普通开源候选包构建、校验与安装/启动/回滚 smoke。上文
qualification 流程只保留为按需诊断工具，不是发布后 Task 或 milestone；未运行时不得登记为已通过。

## 持久化故障边界

Model Gateway 的 crash boundary 以 durable invocation evidence 为准：Surface Artifact 与 prepared facts 未
ack 时零 dispatch；每次 `model.invocation_attempt_started` ack 后才可触发对应 Provider attempt；Response
Artifact 写入后仍需 `model.invocation_completed` 与 purpose terminal/reconciliation batch ack，response 才可
被上层消费。restore/fork 严格验证 completed Surface/Response 链；missing/corrupt/key unavailable 保留已确认
transcript 但禁用 strict replay。prepared 且无 attempt ack 的 invocation 以 `none` 释放未 dispatch
reservation，已有 attempt ack 无 completion receipt 的 invocation 与 reservation 收敛为 `unknown`，不会自动
重发。当前定向 recovery journey 覆盖这些边界；response source/catalog 继续使用 ack-before-lookup、
strict mismatch 与 no-fallback contract。production 缺省仍使用加密随机 identity 与系统时钟；当前保持 schema v25、Store 4 与 epoch `kite-runtime-2026-08-18`。

RMV1-04 production Store 由 App 组合根创建一个 `SqliteRuntimeStorageAdapter` 并注入 Runtime Host；
旧 v4 storage driver 已删除，Kernel 只通过 Host storage port 取得非-owning State25 type view。CLI、TUI、Kernel 与
App adapter 不得直接创建 SQLite 连接。adapter 的四类 transaction method 都映射到一次既有
Store 4 event+snapshot 原子提交，没有 retry/fallback/双写。每个底层连接在设置 journal mode 或执行 schema
写入前先安装 5000 ms `busy_timeout`，因此 journal/schema/事件写竞争都受同一有界等待约束。SQLite writer
lock 释放后只允许一次成功提交；不能因为重试重复事件。

RMV1-05 的 deterministic Host contract 额外验证 same-session FIFO、cross-session concurrency、bridge 前
revision conflict、Host 生命周期内 scoped idempotency、committed Query、history-gap snapshot、stale
ephemeral drop、slow subscriber 断开，以及 subscriber close 不取消 Runtime work。TUI PTY 继续验证真实
production bootstrap；不兼容 Store 必须在历史会话加载边界 fail closed，而不能让 Host 组合阶段阻止 TUI
挂载。

RMV1-06 已把 root AbortController、same-session cleanup barrier、durable-before-signal、四类 Store 4 transaction
acknowledgement、effect lease claim/renew/release 与 restart recovery 切到 Host。Host contract 和 Runtime fault
suite 证明 attempt ack 失败为零 dispatch、stale/renew-lost lease 不能 dispatch/commit、lease loss 中止 lifecycle、
cancel 在 signal 前提交、successor 等待 cleanup、dispose 等待 drain，以及 recovery 在首次 execution 前恰好一次且
失败关闭。`bun run test:runtime:soak` 仍只是 7-case CI profile smoke；它可以形成 RMV1-06 stage evidence，但不能
升级为正式 release qualification。当前单-Store lease 没有被解释为 cross-Host Project fence。

RMV1-07 将相同 State 25 input 经纯 `@kite/agent-kernel` transition 后再由 Store 4 原子提交；进程内 State 只在
commit 成功后推进。Required Kernel/reducer 与 scheduling/completion suite 证明 snapshot/terminal/revision 行为
等价。Host applied receipt 后的
`AuthorizedEffect` 精确绑定 execution identity，App adapter 只允许单次消费和 exact match；mismatch、重复消费
或未 applied receipt 均不得 dispatch。本阶段没有改变 crash/restore/fork format、Store 4 transaction、正式
fault/soak qualification 或 cross-Host fence 语义。

`RuntimeStoreOptions.faultInjectionMaxPageCount` 仅供测试把连接限制到确定性 page ceiling，从而触发 `SQLITE_FULL`。生产组合根不得设置它。失败写入必须完整回滚，重开后事件集合、Runtime state 和恢复状态仍满足不变量。

真实 MCP stdio server 在 tool invocation 中退出时，调用必须返回 typed `provider_unavailable`，provider 进入 `degraded`，并保留最后一次成功 catalog 供诊断；它不等于签发新 Binding 或自动重放调用。

模型 HTTP `429` 属于可重试的 rate-limit failure，但只允许消费统一的 bounded attempt/time budget；attempt budget 包含首次请求，time budget 从第一次可重试失败开始，首次请求在失败前的 wall time 不得提前耗尽重试窗口。长时间 in-flight 后发生 socket/网络错误时，只要 attempt budget 尚有余量就必须观察到第一次 retry。生产分类必须读取 AI SDK `APICallError.statusCode`（并兼容旧 adapter 的 `status`），预算耗尽必须抛出最后一次 429，并由 failure-mode policy 收敛为 `model_retry_exhausted`。本地 HTTP fixture 必须穿透 `createChatModel` 和 provider middleware 证明 429 后恢复；其他 4xx 仍不可重试。

专门验证下游统一取消信号的 wall-clock deadline fixture 必须给 provider 或 interaction 留出在繁忙
CI worker 上完成入场的调度余量，再断言 in-flight AbortSignal。若 deadline 在 provider admission 前
到期，这是另一条合法的 fail-closed 路径，不能用来否定取消传播，也不能与 in-flight 断言混为一谈。
验证“原子完成后慢 consumer 不得反向 abort”的 fixture 同样先保留该调度余量，再让 consumer 明确
跨过 deadline；不得使用会在 hosted runner 负载下先于 `run.completed` 到期的亚秒窗口制造竞态。
RAV1-06 target State26/Store5 is now the production path for new sessions; resilience qualification must separately prove old Store4 remains untouched and old sessions fail closed rather than being migrated or used as fallback.

Target transaction commits normalize legacy explicit snapshot metadata to State26 before persistence, preventing mixed-format snapshot rows during replay/fault qualification.
