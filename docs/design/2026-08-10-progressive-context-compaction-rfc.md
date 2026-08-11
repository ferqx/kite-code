# 渐进式三级上下文压缩 RFC

状态：reviewed（独立整体架构验收 GO；P0=0、P1=0）
日期：2026-08-10
架构：ADR-0100、ADR-0101（accepted）
取代设计：`2026-08-10-progressive-session-memory-compaction-rfc.md`

## 摘要

新路线只解决当前会话的模型活动上下文，不把 Session Memory 当作必要能力。三级依次是确定性回收旧工具
输出、复用活动 checkpoint 组成工作集、必要时生成或更新单叙事 checkpoint。原始 transcript 永远保留，所有
压缩都只是 Provider projection。

```text
immutable transcript
  → bounded raw projection
  → MicroCompact
  → Checkpoint Working Set
  → SummaryCompact（必要时）
  → final payload admission
  → Provider
```

当前仓库已有的有限工具结果预算、verified terminal、prepared/final admission、exact CAS、generation fence 和
手动 checkpoint-v1 是安全底座。checkpoint-v1 只保留当前兼容投影，不具备新 Working Set 的 verified prefix
资格。旧 checkpoint-v2、cache-safe fork、Provider cache 资格和 refill guard 已清场，不得恢复。

## 设计原则

1. **最低成本优先**：先使用确定性 projection，再复用已有摘要，最后才调用摘要模型。
2. **单一真源**：transcript 是唯一正文真源；checkpoint、boundary 和 future memory 都是可丢弃 projection。
3. **完整协议块**：tool call/result、流式 assistant message、settled turn 不能被切开。
4. **不隐藏空洞**：checkpoint 后全部未覆盖 tail 必须出现，不能为了通过容量门禁跳过中间消息。
5. **最终实物验收**：每层产生的只是候选；真正 dispatch 前对最终 messages、tools、params 和 output reservation
   重新执行 resource 与 Provider data admission。
6. **失败可降级**：局部候选不合格则保留 raw；工作集不可用则进入摘要；摘要失败仍保留 transcript。
7. **默认关闭**：自动路径在完整 Gate 前不能由兼容配置、模型名称或 HTTP 错误隐式启用。

## 基础能力不计层级

Tool Result Budget 在结果产生时限制单块最坏大小；verified terminal 证明模型可见结果与持久事实一致。这些是
所有 projection 的输入安全条件，不是 MicroCompact 本身。当前确定性 reclaim 只处理已验证的只读工具块，可
作为第一级的实现起点，但需要由新 policy 和单一 orchestrator 接管后才属于新路线。

## 第一级：MicroCompact

MicroCompact 在 Provider projection 中替换旧的、可重建的工具结果正文，不修改 transcript：

- 候选必须是完整 settled ToolCallBlock，当前 turn 永不处理；
- verified receipt、terminal identity、失败、授权/交互事实、workspace mutation 和结构化结果必须保留；
- 首批白名单从 `read_file | search_content | search_files` 开始，扩展工具必须逐类定义 locator、重建条件和
  projection budget；
- pin/must-keep、最近窗口内 block、legacy/compat/mixed provenance 均 fail closed；
- 占位符只说明结果已回收及稳定类型，不包含路径、参数、正文、可执行 locator 或 digest 值；
- 应用必须达到冻结的绝对 token saving，否则返回 raw candidate；
- prepare 只产生 ephemeral candidate boundary；只有成功 primary 实际使用该 artifact 时，terminal CAS batch 才能
  推进 bounded Micro commit/receipt，不保存 selected entries 或正文。

MicroCompact 不调用模型。它可以在每次 normal prepare 中求值，但只有新 route flag 明确启用且最终 payload
一致性 Gate 通过后才能改变 Provider bytes。summary source、Working Set 的 recent window/tail、失败或未发送的
primary 都不能推进 Micro commit。

## 第二级：Checkpoint Working Set

### 输入

第二级只消费一个恢复时已从 immutable transcript 重算成功的 `VerifiedContextCheckpointV3`：

```text
active checkpoint summary
  + protected recent original window
  + all messages after checkpoint coverage
```

checkpoint-v1 和由 legacy checkpoint-v2 降级得到的 v1 都是 `legacy_unverified`，不得取得该资格。没有 V3、
V3 派生 proof 校验失败或 coverage 无法从 immutable transcript 重算时返回 `unavailable`，不调用模型，也不
阻断 raw/MicroCompact 路径；只有 Store/transcript/tool-pair 真源损坏才进入 correctness failure。

### 规范区间与最近窗口算法

把 durable、Provider-safe transcript 规范化为完整协议块序列 `B=[b0...b(n-1)]`。V3 coverage 是
`C=[0,c)`，overlap window 是 `W=[w,c)`，uncovered tail 是 `T=[c,n)`；最终历史严格为：

```text
checkpoint summary + B[w,c) + B[c,n)
```

`W` 与 `T` 的 message identity 必须不相交，每个 `index≥c` 的 block 恰好出现一次；禁止事后按 message ID
去重来掩盖选择器错误。summary 在语义上覆盖 `W` 是有意的信息重叠，不属于原始 message 重复。

窗口参数冻结为 policy v1：`minRecentTokens=2048`、`minTextMessages=4`、`maxRecentTokens=8192`。resolved
available input 已知时，max 再收紧为其 25%，min 收紧为 `min(2048,max)`；未知时使用绝对值。先无条件保留
全部 `T`；只有 tail 小于 max 时才从 `c-1` 向旧方向按完整 block 扩展 `W`，直到 `W+T` 同时达到 min token 与
文本消息数或达到 max。单个不可分割 block 超过 max 时整体保留；local estimate 只影响是否尝试摘要，不能
阻止 primary。

`text message` 的计数合同固定为：只统计 durable user/assistant message 中规范化后仍含非空白 text 的消息；
tool-only assistant、Tool Result、runtime/system/synthetic summary frame 与空 text 不计。multipart message 按一条
durable message 计数而不是按 part 计数；同时含 text 与 tool call 的 assistant message 因其 text 计一条，但仍与
对应 tool block 保持原子。实现需用 property test 覆盖角色、multipart、空白、tool-only 与 block boundary。

`W` 只能从 coverage 内完整 settled blocks 选择。当前 active turn 中已经 durable/settled 的 user、assistant text
和完整 tool pairs 属于 `T`；未终结 tool pair、interaction、required verification 及非 durable streaming fragment
是 scheduler barrier，在更高优先级 effect 收敛前不能进入 `call_model`。`W`、`T` 保持 raw，不应用
MicroCompact；MicroCompact 只负责第一层候选和 summary source 的旧工具降噪。

第二级本身零 Provider 调用。它复用已有摘要，但不是永久“记忆”：checkpoint 仍是为上下文压缩生成的低权限
assistant history，不能决定当前 Plan、Verification、Authorization、Tool、Skill 或 Runtime 状态。

### 持久边界

Working Set 不写独立持久 boundary。V3 checkpoint 自身是 summary coverage boundary；`w/c/n`、window/tail
identity 和 policy 只进入当次 deep-frozen request artifact。恢复时从 transcript 重算 V3 coverage，prepare 时重新
选择窗口。V3 派生验证失败回退 raw；Store checksum、event ordering、tool pairing 或 transcript 真源损坏仍是
correctness failure。

## 第三级：SummaryCompact

进入条件只有三类，但它们只是一次摘要尝试资格：

- 没有可用 checkpoint 且本地容量证明需要压缩；
- 现有 checkpoint + recent window + 全部 tail 的本地 estimate 仍高于自动尝试阈值；
- 用户执行普通或带自定义指令的手动 `/compact`，无需满足本地 pressure。

三类都必须存在 checkpoint coverage 之后的新 safe source、满足 best-case 1024 token 绝对收益并通过 summary
resource/Provider data admission。没有新 safe source 时 manual 以 durable no-op 收敛且 Provider call count 为零；
custom 只能改变新摘要侧重点，不能绕过 source、收益或 admission。

SummaryCompact 复用现有单叙事约束：一次 Provider request、无工具、零 SDK retry、固定输出预算，只接受单一
非空 Markdown narrative。输入为安全 settled source；已有 verified V3 时可使用旧 summary 加其后全部新 source
做增量更新，但新 V3 仍保存对完整 canonical prefix 独立重算的 digest。legacy v1 不得作为可信 base，只能从完整
transcript 重新生成。不分块、不 repair、不 merge 多份正文。摘要候选必须通过 source freshness、无 tool call、
非截断、bounded narrative、至少 1024 token 绝对收益和最终 working-set projection 验证。

摘要成功后原子激活 V3 checkpoint。只有 auto attempt 代表一个已持久暂停的 normal request；在资源已
`reconciled(actual)` 或以零外部执行 proof `released` 后，新的 scheduler effect 才从 committed state 重建
Working Set。摘要失败、stale 或 admission denial 不删除旧 checkpoint/transcript；只要资源终态是 reconciled 或
released，auto continuation 就 fresh prepare 并发送当前可安全构造的最佳 normal 候选。dispatch 后 usage unknown
时保守写 `resource_budget.unknown`，continuation 停在 `resource_resolution_required`，不得立即续跑 primary；
只有 bounded late reconciliation 得到 actual usage 后才转为 `normal_reprepare_required`。plain/custom manual 只
终结命令，不创建 normal continuation。任何已开始 attempt 都不自动 replay，同一 auto continuation 对相同
canonical source 只尝试一次。本地 over-window/ratio 不产生 typed capacity failure；通用 HTTP 400/413 也不属于
进入条件。只有明确的 Provider/adapter typed overflow 或权威请求上限合同可以形成容量失败。

## 单一编排器与状态转移

```text
prepare normal source
  → evaluate MicroCompact
  → pressure below auto trigger? dispatch admitted candidate
  → evaluate verified Checkpoint Working Set
  → local estimate below trigger? dispatch admitted working set
  → policy permits SummaryCompact? persist summary attempt + normal continuation
  → validate and atomically activate V3 checkpoint; terminalize summary
  → scheduler fresh-prepare from committed state
  → new primary lease/reservation + final admission + one normal dispatch
```

manual 与 auto 共用 source builder、candidate validator、checkpoint writer 和 final admission。差异只在触发原因：
plain/custom manual 可直接请求 SummaryCompact，但仍受 no-new-source、best-case saving 和 admission 约束；auto
必须同时满足已知 resolved input budget、`compact_due=90%`、显式 feature flag、距上次 summary attempt 至少 3 个
成功 primary turn、同 source 未尝试、resource 许可和零并发 Provider ownership。unknown window 不自动摘要。
旧 decision/rollout producer 不得复活。

auto feature flag 只控制自动调度，不控制 checkpoint writer format。schema v24 cutover 后，所有成功的
plain/custom manual Summary 也只写 `VerifiedContextCheckpointV3`；v1/v2 仅由 bounded compatibility reader 读取，
不再有生产 writer。关闭 auto flag 会停止自动 attempt，但不会降级持久 schema、把 manual writer 切回 v1，或
把已持久 V3 改写为旧格式。

## 并发、恢复与失败

- prepare 是 pure，不能获取 lease、写事件或预留 Provider；
- auto summary request 持久化 `NormalCompactionContinuationV1`；summary lease/reservation/dispatch identity 与后续
  primary 完全分离；
- auto summary dispatch 前由 Kernel 原子持久 request、continuation、reservation、
  `resource_budget.dispatch_started` 和 `context.summary_dispatch_started_v1`；manual request 可以先由命令持久，
  但 reservation 与两个 dispatch-started 仍必须同一 CAS batch；
- `dispatch_started` 后没有 terminal 的 attempt 恢复为 `unknown_external_outcome`，同一 attempt/source 不重放；
- terminal batch 必须使用现有 resource ledger 的判别终态：可信 actual usage 用
  `resource_budget.reconciled`；本地 Provider admission denial 等能证明零外部执行的路径用
  `resource_budget.released(proof)`；dispatch 后 usage 不可知用 `resource_budget.unknown`。不得把 released/unknown
  伪装为 reconciled；
- auto 的 reconciled/released terminal batch 同批提交 `context.normal_reprepare_required_v1`；unknown 同批提交
  `context.normal_resource_resolution_required_v1`，不得创建 primary reservation。late actual reconciliation 只有与
  `context.normal_reprepare_required_v1` 同一 CAS batch 才能解除等待；manual terminal 不包含两种 continuation 事件；
- scheduler 只能从 committed state fresh prepare；primary 另取 lease/reservation/dispatch identity，不能消费未提交
  summary candidate；
- activation 后、primary reservation 前崩溃时由 continuation 恢复 fresh primary；新用户 source 使旧
  continuation `superseded`，不恢复旧 primary；只有 projection environment drift 且原 turn/source 仍有效时才对
  最新 state 重新求值；
- rewind 按目标 event cut 重算 checkpoint/cooldown/成功 primary ordinal；fork 使用下面的独立 abandon/rebind
  matrix，不复用普通 auto unknown validator；generation fence 阻止旧 Kernel 写回；
- legacy checkpoint-v2 继续只读校验并降级为 legacy v1，任何新 writer 只产生 V3。

### Crash-cut 终态

| 崩溃位置 | 恢复结果 |
| --- | --- |
| summary request/reservation 前 | 无 attempt；normal 从当前 state 重新 prepare |
| reservation 已持久但缺任一 dispatch-started | 非法持久状态；batch validator 拒绝/quarantine，不允许外部调用 |
| 两个 dispatch-started 后无 terminal | 写 `unknown_external_outcome + resource_budget.unknown + resource_resolution_required`；同 attempt/source 不重放，暂不续跑 normal |
| summary terminal batch 前 | 候选不可见；按 started/unknown 处理 |
| V3 activation batch 后、primary reservation 前 | 仅 reconciled/released continuation 驱动 fresh prepare；不得再次 summary 同 source |
| primary `dispatch_started` 后 | 沿用 primary unknown/reconciliation；不得回滚 checkpoint 或重放 primary |

### Stale Summary settlement

resource dispatch-started 后，final gate/Provider callback 前后若原 effect lease 因 revision 漂移不能 apply，Runner
只能请求 Kernel 的 `applyStaleSummarySettlementV1()`；它不能等待不存在的 Provider result，也不能把 context
terminal 丢掉后只做普通 resource reconciliation。该入口：

1. 从 current state 获取新的 settlement CAS owner，验证 generation 未变、同一 started attempt 仍存在，并逐项
   匹配 durable started receipt/start key；final gate 已通过时还须匹配 terminal admission evidence。旧 lease 的
   expected revision 不再作为写权限，也不能被伪造成 current；
2. 丢弃任何 summary candidate，绝不激活 V3。known actual 写 typed
   `summary_failed(stale_source|stale_environment|stale_runtime_revision) + resource_budget.reconciled`；零外部执行
   proof 写 `summary_failed + resource_budget.released`；usage unknown 写
   `summary_unknown_external_outcome + resource_budget.unknown`；
3. auto 且新用户 source/turn 已替代原 normal request 时，同批写 `normal_continuation_superseded_v1`，不创建
   reprepare/resource-resolution；以后若收到 actual，只能走普通 late resource reconciliation 记账，不能唤醒旧
   turn。environment drift，或 source/environment 均相同但仅 control revision 漂移时，只要原 normal turn 与
   SummarySourceIdentity 仍有效，才根据资源结果写 `normal_reprepare_required_v1` 或
   `normal_resource_resolution_required_v1`；
4. manual 不写 continuation。整批使用新的 terminal batch ID，并由 causation 指向原 summary dispatch-started；
   不匹配、attempt 已终结或 generation 已变化时拒绝，不得重放 Provider。

Kernel 在 start CAS 成功后为唯一 dispatch owner 创建单次 `ProviderDispatchEntryGuardV1`。其状态机固定为同步、
单调、互斥的 `open → entered | closed_without_entry`：Core-owned final-dispatch 函数必须先执行
`tryEnter()` 的原子 compare-and-set，只有 open→entered 的 winner 才能进入 adapter/Provider callback；stale
settlement 只能执行 `closeWithoutEntry()` 的 open→closed compare-and-set，只有 winner 才生成一次性
`prepared_dispatch_not_entered_v1` proof。任一 loser 永久失败：close 赢后迟到的 tryEnter 必须返回 false 并在
调用 callback 前退出；enter 赢后 close 永远不能生成 release proof。两者之间不得 `await` 或复制 guard。

proof 绑定同进程、generation、完整 durable started receipt 与单次 guard nonce，并只能被 matching settlement
消费一次；Controller/adapter 不能构造。source/environment/control revision 在网络前 stale 时用该 proof release；
final Provider-data gate 拒绝继续使用既有 `local_provider_admission_denied` proof。callback 已进入后禁止 release，
只能 reconciled(actual) 或 unknown。进程崩溃后 open guard 不恢复、不补造，started reservation 保守归为
unknown。

### Fork abandon/rebind matrix

fork transaction 必须在新 generation 中原子处理 V3、attempt、continuation 与复制的 resource ledger：

| parent 在目标 cut 的状态 | child 终态 |
| --- | --- |
| 无 V3、无 attempt | 不创建压缩事实 |
| V3 active | 写 `checkpoint_v3_rebound_v1`，绑定 parent checkpoint、fork-local `sourceProducingEventCutV1`、重算 source digest 与 generation |
| manual/auto requested、未 started | 写 `summary_branch_abandoned_v1(reason=fork,phase=requested)`，移除 attempt；auto 同时移除 pending continuation；无 reservation 变更 |
| manual/auto resource dispatch-started、无 terminal | 若复制 reservation 仍为 dispatch-started，先写 `resource_budget.unknown`，再写 `summary_branch_abandoned_v1(reason=fork,phase=started)`；移除 attempt/continuation，保守 charge 留在 child，永不 dispatch/replay |
| auto resource-resolution pending | 保留 copied unknown reservation，写 `summary_branch_abandoned_v1(reason=fork,phase=resource_resolution)` 并移除 continuation 与 `PendingSummaryResolutionV1`；parent late actual 不自动传播、退款或唤醒 child |
| auto normal-reprepare pending | 写 `normal_continuation_superseded_v1(reason=fork)` 并移除 continuation；已 reconciled/released 的资源终态不变 |
| idle + lastConsumption，primary in-flight | 有界重验 parent consumption receipt 后，在 target generation 以本节四事件 branch terminal batch 原子收敛为 error-terminal，再 detach lastConsumption；target turn 必须 aborted，禁止复制后重派 |
| idle + lastConsumption，primary settled | 有界重验 parent consumption receipt 后，从 child rolling lifecycle 删除 lastConsumption；同事务生成 target-owned copied terminal closure，复制的 primary terminal/resource facts 是唯一当前事实 |
| idle + lastDetach | 在 source branch/current selected cut 有界重验 detach event 与其引用的 settled primary terminal events，target generation 原子丢弃 lastDetach；不复制、不重绑，也不再产生 detach event |

manual 从不拥有 normal continuation。`summary_branch_abandoned_v1` 是 fork/rewind-only audit receipt，不是普通
summary terminal，也不要求普通 unknown batch 的 resource-resolution continuation。child 只有收到独立、可信且明确转发到
该 fork generation 的 actual usage receipt 才可通过普通 resource reconciliation 降低 unknown charge；即使记账
成功也不恢复旧 continuation；所有 abandon/supersede 分支把唯一 SummaryLifecycleState 切回 idle。fork/rewind、
V3 rebind 与上述全部状态必须有组合 fault matrix。

rewind 推进 generation 后，对目标 cut 中任何未终结 attempt/pending resolution/normal continuation 使用
`summary_branch_abandoned_v1(reason=rewind)` 与同等保守 resource 规则；不得让旧 generation 的 late result
唤醒回退后的 turn。已终结 V3、
cooldown 与 successful-primary ordinal 才按目标历史重算。parent consumption receipt/event 可保留为只读历史
审计，但旧 generation IDs 不重写、不进入 child current ownership；fork/rewind generation transaction 的 bounded
receipt 记录 detach。

detach 的 exact contract 固定为 `NormalReprepareConsumptionDetachKeyV1/ReceiptV1`。Store branch transaction 必须：

1. 在修改 target 前按 threadId 稳定顺序锁定并验证 `BranchMutationRequestV1`：fork 同时比较 source/current、
   selected rolling/named cut 与 target/current 三份 identity，rewind 比较 current 与 selected cut；按 source
   thread/generation/cut 对完整 lastConsumption 的 consumption/reserved/resource-started 三个 IDs 重算 canonical
   payload hash、role 与 cut；
2. `RuntimePersistenceIdentityV1` 只用于本次 mutation 前的完整 CAS，不进入 durable detach key，也不作为后续
   restore proof；Store 在同一事务从用户选择的 rolling/named cut 计算不含物理 eventPosition 的
   `BranchSelectedCutProofV1`，再原子推进 target generation、复制目标状态，计算 `BranchTargetBaseProofV1`，并
   要求 target lifecycle 精确为同一 `idle(lastConsumption)`。named cut 必须位于 observed head 之内；proof 使用
   canonical selected state/prefix digest，target proof 绑定 source proof digest；
3. in-flight 只允许 reservation=`dispatch_started`，固定提交
   `run.error(unknown_external_outcome) → resource_budget.unknown → turn.aborted(cause=error) →
   context.normal_reprepare_consumption_detached_v1(settled error detachKey)`；前三个事件携带同一
   `NormalRepreparePrimaryTerminalEvidenceV1`，第四个事件在前三个 envelope ID 已确定后携带 error-terminal
   detach key，因此没有 event-ID 自引用。reservation 已是 unknown 但缺 matching 三事件 terminal evidence 时属于
   非法半批，fork/rewind fail closed，绝不重派或猜测补齐；
4. Kernel 在调用 pure producer 前生成一次 128-bit receiptNonce；producer 按本节固定公式得到
   `branchMutationReceiptId`，in-flight 的前三个 evidence 与最终 detach key 都引用该 ID。settled 只提交 detached
   event，但必须先重验 success terminal 的 primary/resource IDs，或 error-terminal 的
   primary/resource/turn 三个 IDs 与 terminalBatch/outcome；reducer 清除 lastConsumption 并保存由 target detach
   envelope 物化的 `lastDetach`；
5. Store 在同一 SQLite transaction 写 target event/snapshot、immutable `BranchMutationReceiptV1`，以及 settled
   分支的 target-owned `BranchCopiedTerminalClosureV1`。receipt 的
   manifest 保存一事件 settled detach 或四事件 in-flight quartet 的 exact IDs/types/base/final revision，并以
   域分离 checksum 保护；closure 保存已验证 source canonical terminals、original producer identity/ID 与独立
   checksum并由receipt绑定。同 receiptId 不得覆盖或复用。相同 detach exact replay 幂等，旧两事件
   `resource.unknown → detached`、single event、reordered、
   missing/tampered receipt、wrong cut/thread/from-to generation 或 primary 判别冲突全部 fail closed。

第 1 步是在 Store fork/rewind transaction 内验证旧 generation receipt 的唯一窄例外；普通 live/replay/restore
仍要求 receipt 属于 current thread/generation。child restore 只按 current target cut 重验 detach event/receipt 与
普通 primary ledger/terminal，不把嵌套旧 receipt 恢复成 owner。`idle` 不得同时拥有 lastConsumption 与 lastDetach；
开始新的 Summary lifecycle 时可丢弃 bounded historical lastDetach。

唯一的恢复例外是判别式 **committed branch mutation receipt**，它只包含以下两种形态：

- `in_flight_quartet`：四者必须位于 receipt manifest 指定的同一 target
thread/generation、revision 连续、顺序固定，前三个 terminal evidence 字节相等且引用同一 receiptId，第四个 detach
key 的 receiptId 相同、lastConsumption.key 与该 evidence.consumption 字节相等；detach key 的 error-terminal
  三个 IDs 必须分别等于前三个经 canonical hash 重算后的 event ID；
- `settled_detach`：manifest 必须精确一个 target-generation detach ID/type，`finalRevision=baseRevision+1`，detach
  key/receiptId/sourceProof/targetBaseProof 逐项一致；nested lastConsumption 必须等于 write-time 在 source selected-cut
  proof 下已验证的 receipt，copied primary 的 success primary/resource IDs 或 error-terminal primary/resource/turn IDs
  必须从同事务写入的 target-owned `BranchCopiedTerminalClosureV1` 做固定上限 lookup 并通过 original canonical
  producer thread/generation/type/role/hash 校验；不能依赖随后可删除或 prune 的 source event rows，也不能把 source
  envelope 改写成 target canonical identity。

只有事件、immutable Store receipt、receipt checksum、source/target logical proof 与对应 manifest 全部一致时，tail
replay 或 snapshot restore 才可接受内部的 source-generation consumption：snapshot-before-quartet 的 loader 按
receiptId 跨 page 缓冲并一次验证/归约完整四事件；snapshot-before-settled 验证单事件+receipt；snapshot-after
由 lastDetach+receipt 做一或四个 event ID 的固定上限 indexed lookup。归约结果只保留 target-generation
historical lastDetach，绝不恢复 lastConsumption owner。source 已删除时不回查 live source，而重验 receipt 内
write-time source proof digest、copied terminal closure checksum 与 target copied-prefix linkage。缺失、拆批、重排、
ID/payload/proof/cut/role/receipt/closure 篡改一律 quarantine。

这不是对普通 receipt generation 规则的放宽：普通 live/startup/replay 三事件 terminal 及无 branch receipt 的
单事件 detach 必须引用 current
thread/generation 的 consumption；旧 generation evidence 若没有 matching 第四个 detach event 与 immutable branch
quartet receipt，也没有 matching settled-detach receipt，必定拒绝。writer/SQLite transaction 必须原子写
events+snapshot+receipt，以及 settled 分支所需的 copied terminal closure；恢复验证的是 canonical protocol branch
mutation 与 Store receipt/closure，而不是从扁平 event
rows 反推“曾属于同一次 append”。A→B→C 时 C 只验证 B 的
historical lastDetach 后丢弃，不能再次借用 A 的 consumption owner。

`BranchPersistenceCutV1` 只表示 receipt 绑定的逻辑 cut，不是 Store CAS identity：empty 只能 revision=0且无ID；
ledger_base 必须有 non-negative safe revision与baseId；event 必须有 positive safe revision、eventId且严格晚于其
ledger base。三种判别的ID字段不能互换。detach key 的 `source` 是用户选择的 source/
snapshot cut；`targetBase` 是 Store 已推进 target generation 并完成复制、但尚未追加 unknown/detach batch 时的
cut。修改前的并发防护仍必须比较完整 `RuntimePersistenceIdentityV1`（snapshot checksum/schema/eventPosition、
observed head position/revision/eventId 与 generation），不能以 BranchPersistenceCut 或 durable proof 替代。
`BranchSelectedCutProofV1` 的 digest 固定为
`sha256("branch-selected-cut:v1\\0" || canonical({cut,selectedSnapshotKind,selectedSnapshotId?,canonicalSelectedStateDigest,canonicalSelectedPrefixDigest}))`；
named 必须有 selectedSnapshotId，rolling 必须没有。prefix chain 固定为
`D0=sha256("runtime-branch-prefix:v1\\0" || eventLedgerBaseDigest)`、
`Di=sha256("runtime-branch-prefix:v1\\0" || Di-1 || canonical({revision,eventId,persistedPayloadDigest}))`，其中
persistedPayloadDigest 对 Store authority raw event bytes 做流式 SHA-256；语义 payload 仍须另行通过 canonical event-ID
validator，storage prefix digest不能替代语义验证。不含物理
eventPosition/occurredAt，v24 snapshot 保存其 cut 上的 D。state digest 使用域 `runtime-branch-state:v1` 对 exact
normalized `ContextRuntimeState` 编码，禁止 transient UI/对象 identity。
新 v24 session 的 eventLedgerBaseDigest 固定为
`sha256("runtime-event-ledger-empty-base:v1\\0")`。v23迁移 session 的 base 固定为
`sha256("runtime-event-ledger-legacy-base:v1\\0" || canonical({normalizedStateDigest,canonicalTranscriptDigest,historicalRowCount,historicalRawBytes,historicalRawDigest}))`；
它把迁移 cut 之前所有 pre-metadata 与 metadata rows 折叠成一个逻辑 base，不暴露/依赖其物理 positions。

三个内层 digest 也固定：`normalizedStateDigest=sha256("runtime-legacy-normalized-state:v1\\0" ||
canonicalPreV24RuntimeState(restoredState))`，编码 accepted pre-v24 semantic state、排除 storageFormat/eventLedger/
namedProof等新字段；`canonicalTranscriptDigest=sha256("runtime-legacy-transcript:v1\\0" ||
canonicalTranscriptBlocksV1(restoredTranscript))`，复用 sourceRangeDigest 的完整 block/Tool配对规则；raw row chain为
`R0=sha256("runtime-legacy-raw-row-chain:v1\\0")`、
`Ri=sha256("runtime-legacy-raw-row-chain:v1\\0" || Ri-1 || u64be(rawByteLength) || sha256(rawBlobBytes))`，严格按
Store row order，historicalRawDigest=Rn。长度前缀与顺序防止row boundary碰撞，所有raw bytes由BLOB stream取得。

verified named 与 fork target 的 base 分别使用域 `runtime-event-ledger-named-base:v1`（只输入先于 ledger 构造完成的
`LegacyNamedCutEvidenceV1.evidenceDigest`）和 `runtime-event-ledger-fork-base:v1`（输入source selected-cut proof digest、target
thread/generation）。named evidence、ledger base 与最终 proof checksum 必须按 evidence → evidenceDigest → ledger base →
proofChecksum 的单向 DAG 构造，最终 checksum 绝不反哺 base。`baseId=sha256("runtime-event-ledger-base-id:v1\\0" || canonical({kind,baseRevision,eventLedgerBaseDigest}))`，
`prefixDigestAtBase=D0`，`nextRevision=baseRevision+1`；这些字段必须持久于 v24 snapshot/storage-format metadata，
`writeEpoch` 只由独立 thread write fence 持有，禁止形成第二份 rolling mirror。后续首个
event 必须恰为 nextRevision，成功写后逐一推进 nextRevision/tailPrefixDigest。schema decode、migration、fork、
rewind、restore 对任一不一致 fail closed。
target proof 的 copiedFromSourceProofDigest 必须等于它。canonical state/prefix digest 在 mutation 时从 selected cut
重算并复制进 target 的 v24 prefix-digest chain；restore 只从 target-owned snapshot/prefix chain 与 immutable receipt
重验，不要求 source 仍存在，也不与之后已滚动覆盖的 source/target live `RuntimePersistenceIdentityV1` 比较。物理
eventPosition 从不进入 branch proof；fork position remap、source 删除、rolling snapshot 覆盖不改变 receipt 资格。
`BranchMutationReceiptV1.receiptChecksum` 固定为
`sha256("branch-mutation-receipt:v1\\0" || canonical(receiptWithoutChecksum))`，receipt exact schema 编码后最多
16KiB；Store 以 `(targetThreadId,targetGeneration,receiptId)` 唯一键持久且禁止 update。source proof 只证明 mutation
当时选择的逻辑 cut；后续恢复的 current correctness 由 target-owned copied-state/prefix digest、manifest event IDs 与
target generation 共同证明。`in_flight_quartet` 必须 `finalRevision=baseRevision+4`，`settled_detach` 必须
`finalRevision=baseRevision+1`；manifest IDs 按这些 revision 逐项匹配。
manifestDigest 固定为
`sha256("branch-mutation-manifest:v1\\0" || canonical({eventIds,eventTypes,eventPayloadDigests,baseRevision,finalRevision}))`。
`BranchMutationCompletionV1.completionChecksum` 固定为
`sha256("branch-mutation-completion:v1\\0" || canonical(completionWithoutChecksum))`，canonical bytes≤1KiB；它只
保存幂等 identity/digests，不保存正文、proof 或 snapshot。

对已含 lastDetach 的分支再次 fork/rewind（A→B→C）时，Store 先按 B 的 current selected cut 重验 historical
detach receipt，然后在 C/rewind target generation 中原子丢弃；named snapshot 也按各自 selected cut 执行。rewind
到原 detach 前按当时 lifecycle 走 lastConsumption/idle 规则，rewind 到 detach 后验证并丢 lastDetach。tamper、cut/
generation 不匹配均 fail closed。

## Runtime schema v24 合同

```typescript
interface VerifiedContextCheckpointV3 {
  version: 3;
  checkpointId: string;
  compactionId: string;
  reason: 'manual' | 'auto';
  source: {
    firstMessageId: string;
    coveredThroughMessageId: string;
    coveredThroughTurnId: string;
    sourceRevision: number;
    sourceProducingEventCutV1: { revision: number; eventId: string };
    sourceRangeDigest: string;
    sourceProjectionPolicyId: string;
  };
  summary: string;
  summaryContentDigest: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  promptContractId: string;
  routeIdentityDigest: string;
  baseCheckpoint?: { checkpointId: string; summaryContentDigest: string };
  createdAt: string;
}

interface SummarySourceIdentityV1 {
  version: 1;
  firstMessageId: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  canonicalSourceDigest: string;
  sourceProjectionPolicyId: string;
}

interface NormalCompactionContinuationV1 {
  turnId: string;
  requestedAtRevision: number;
  summarySourceIdentity: SummarySourceIdentityV1;
}

interface AutoSummaryCooldownV1 {
  version: 1;
  lastAttemptSourceIdentity: SummarySourceIdentityV1;
  successfulPrimaryOrdinalAtAttempt: number;
  nextEligibleSuccessfulPrimaryOrdinal: number;
}

interface SummaryAttemptV1 {
  attemptId: string;
  compactionId: string;
  reason: 'manual' | 'auto';
  trigger: 'manual_plain' | 'manual_custom' | 'auto_pressure';
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
}

interface SummaryStartedReceiptV1 {
  requestedEventId: string;
  startBatchKey: SummaryStartBatchKeyV1;
  resourceReservedEventId: string;
  resourceDispatchStartedEventId: string;
  summaryDispatchStartedEventId: string;
}

interface SummaryDispatchStartBindingV1 {
  startBatchId: string;
  summaryEffectLeaseId: string;
  resourceReservationId: string;
  preparedSummaryRequestIdentity: string;
  requestId: string;
  expectedPayloadDigest: string;
  expectedMaxOutputTokens: number;
  expectedToolSetSchemaDigest: string;
}

interface SummaryTerminalAdmissionEvidenceV1 {
  admittedRequestDigest: string;
  finalPayloadDigest: string;
  providerDataAdmissionReceiptDigest: string;
  finalMaxOutputTokens: number;
  finalToolSetSchemaDigest: string;
}

type SummaryTerminalAdmissionStateV1 =
  | { stage: 'not_completed' }
  | { stage: 'denied'; proof: 'local_provider_admission_denied' }
  | { stage: 'admitted'; evidence: SummaryTerminalAdmissionEvidenceV1 }
  | { stage: 'indeterminate_after_crash' };

interface SummaryStartBatchKeyV1 {
  startBatchId: string;
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  dispatchStart: SummaryDispatchStartBindingV1;
}

interface SummaryTerminalBatchKeyV1 {
  terminalBatchId: string;
  causationId: string; // prior context.summary_dispatch_started_v1 envelope ID
  resourceDispatchCausationId?: string; // absent only for manual pre-reservation denial
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  dispatchStart?: SummaryDispatchStartBindingV1; // absent only for manual pre-reservation denial
  admission: SummaryTerminalAdmissionStateV1;
}

interface SummaryResolutionBatchKeyV1 {
  resolutionBatchId: string;
  causationId: string; // original resource_budget.unknown event ID
  originalTerminalBatchId: string;
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  resourceReservationId: string;
  continuationTurnId: string;
}

interface PendingSummaryResolutionV1 {
  version: 1;
  generation: number;
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  started: SummaryStartedReceiptV1;
  originalTerminalBatchId: string;
  resourceUnknownEventId: string;
  resourceReservationId: string;
  continuation: NormalCompactionContinuationV1;
}

type NormalReprepareOriginV1 =
  | {
      kind: 'summary_terminal';
      terminalBatchId: string;
      terminalEventId: string;
      resourceTerminalEventId: string;
    }
  | {
      kind: 'late_resolution';
      originalTerminalBatchId: string;
      resolutionBatchId: string;
      resourceUnknownEventId: string;
      resourceReconciledEventId: string;
    };

interface NormalReprepareReceiptV1 {
  version: 1;
  generation: number;
  attemptId: string;
  compactionId: string;
  continuation: NormalCompactionContinuationV1;
  origin: NormalReprepareOriginV1;
}

interface NormalReprepareConsumptionKeyV1 {
  consumptionBatchId: string;
  reprepare: NormalReprepareReceiptV1;
  primaryEffectLeaseId: string;
  primaryResourceReservationId: string;
  primaryInvocationId: string;
  primaryRequestId: string;
  preparedPrimaryRequestIdentity: string;
  expectedPrimaryPayloadDigest: string;
  expectedPrimaryMaxOutputTokens: number;
  expectedPrimaryToolSetSchemaDigest: string;
}

interface NormalReprepareConsumedReceiptV1 {
  key: NormalReprepareConsumptionKeyV1;
  consumptionEventId: string;
  resourceReservedEventId: string;
  resourceDispatchStartedEventId: string;
}

type BranchPersistenceCutV1 =
  | {
      kind: 'empty';
      threadId: string;
      generation: number;
      revision: 0;
    }
  | {
      kind: 'ledger_base';
      threadId: string;
      generation: number;
      revision: number; // non-negative safe integer
      baseId: string;
    }
  | {
      kind: 'event';
      threadId: string;
      generation: number;
      revision: number; // positive safe integer, > ledger base revision
      eventId: string;
    };

interface RuntimeEventLedgerBaseV1 {
  version: 1;
  kind: 'empty_v24' | 'migrated_v23' | 'verified_named_v24' | 'fork_rebound_v24';
  baseRevision: number;
  baseId: string;
  eventLedgerBaseDigest: string;
  prefixDigestAtBase: string; // D0
  nextRevision: number; // baseRevision + 1
}

interface RuntimeStorageFormatV1 {
  version: 1;
  format: 'v24_strict';
  canonicalEventRegistryId: 'runtime-event-registry:v24';
  ledgerBase: RuntimeEventLedgerBaseV1;
  tailEventCount: number;
  tailCanonicalBytes: number;
  tailPrefixDigest: string;
}

type LegacyNamedSourceEvidenceV1 =
  | {
      kind: 'metadata_prefix';
      revision: number;
      eventId: string;
      prefixDigest: string;
    }
  | {
      kind: 'legacy_unverified';
      stateRevision: number;
      reason: 'metadata_missing' | 'prefix_unavailable' | 'content_conflict';
    };

interface LegacyNamedCutEvidenceV1 {
  version: 1;
  threadId: string;
  generation: number;
  snapshotId: string;
  namedCatalogVersion: number;
  rawBytes: number;
  rawDigest: string;
  normalizedStateDigest: string;
  canonicalTranscriptDigest: string;
  source: LegacyNamedSourceEvidenceV1;
}

type LegacyNamedCutProofV1 =
  | {
      version: 1;
      trust: 'verified_metadata_prefix';
      evidence: LegacyNamedCutEvidenceV1;
      evidenceDigest: string;
      selectedCut: BranchPersistenceCutV1;
      eventLedgerBase: RuntimeEventLedgerBaseV1;
      proofChecksum: string;
    }
  | {
      version: 1;
      trust: 'legacy_unverified';
      evidence: LegacyNamedCutEvidenceV1;
      evidenceDigest: string;
      proofChecksum: string;
    };

interface RuntimeThreadWriteFenceV1 {
  version: 1;
  generation: number;
  format: 'v23_compat' | 'v24_strict';
  writeEpoch: number;
  lifecycle: 'active' | 'deleted';
}

type EphemeralRuntimeEventV24 = Extract<
  ExactVersionedRuntimeEventUnion<24>,
  {
    type:
      | 'tool.progress'
      | 'model.text_delta'
      | 'model.reasoning_delta'
      | 'model.reasoning_completed';
  }
>;

type DurableRuntimeEventV24 = Exclude<
  ExactVersionedRuntimeEventUnion<24>,
  EphemeralRuntimeEventV24
>;

interface RuntimeEventEnvelopeV24 {
  schemaVersion: 24;
  eventId: string;
  threadId: string; // canonical producer identity
  generation: number; // canonical producer generation at write time
  revision: number;
  causationId: string | null; // absent input normalizes to null
  occurredAt: string;
  event: DurableRuntimeEventV24;
}

interface RuntimeEventStoreRecordV24 {
  ownerThreadId: string;
  ownerGeneration: number;
  envelope: RuntimeEventEnvelopeV24;
  canonicalBytes: number;
}

type CanonicalRuntimeEventRegistryV24 = Readonly<{
  [K in DurableRuntimeEventV24['type']]: CanonicalRuntimeEventDescriptorV24<K>;
}>;

type BranchSelectedCutIdentityV1 =
  | {
      kind: 'rolling';
      cut: BranchPersistenceCutV1;
      expectedRuntimePersistenceIdentity: RuntimePersistenceIdentityV1;
    }
  | {
      kind: 'named';
      threadId: string;
      generation: number;
      snapshotId: string;
      cut: BranchPersistenceCutV1;
      canonicalSnapshotBytesDigest: string;
      expectedNamedCatalogVersion: number;
      expectedNamedCutProofChecksum: string;
      requiredTrust: 'verified_metadata_prefix';
    };

type BranchMutationRequestV1 =
  | {
      kind: 'fork';
      sourceThreadId: string;
      expectedSourceIdentity: RuntimePersistenceIdentityV1;
      selectedSource: BranchSelectedCutIdentityV1;
      targetThreadId: string;
      expectedTargetIdentity: RuntimePersistenceIdentityV1;
    }
  | {
      kind: 'rewind';
      threadId: string;
      expectedCurrentIdentity: RuntimePersistenceIdentityV1;
      selectedTarget: BranchSelectedCutIdentityV1;
    };

interface BranchMutationDerivationInputV1 {
  request: BranchMutationRequestV1;
  receiptNonce: Uint8Array; // exactly 16 bytes, generated once by Kernel
}

interface ValidatedBranchMutationCandidateV1 {
  readonly version: 1;
  readonly requestDigest: string;
  readonly receipt: BranchMutationReceiptV1;
  readonly events: readonly RuntimeEventEnvelopeV24[]; // exact manifest count: 1 or 4
  readonly terminalClosure:
    | { readonly kind: 'none' }
    | { readonly kind: 'copied'; readonly closure: BranchCopiedTerminalClosureV1 };
  readonly nextSnapshot: RuntimeSnapshotV24;
  readonly candidateDigest: string;
  // module-private brand; only deriveBranchMutationV1 constructs it
}

type BranchMutationCommitResultV1 =
  | { kind: 'committed'; receiptId: string }
  | { kind: 'already_committed'; receiptId: string }
  | { kind: 'commit_ack_unknown'; receiptId: string }
  | { kind: 'identity_stale' }
  | { kind: 'contention_timeout' }
  | { kind: 'invalid_candidate' }
  | { kind: 'quota_denied'; failureKind: 'resource_saturated' }
  | { kind: 'receipt_collision_or_corruption' };

type BranchMutationResolutionResultV1 =
  | { kind: 'committed'; receiptId: string }
  | { kind: 'definitely_not_committed'; receiptId: string }
  | { kind: 'unknown_or_superseded'; receiptId: string }
  | { kind: 'resolution_unavailable'; receiptId: string }
  | { kind: 'receipt_collision_or_corruption'; receiptId: string };

type DetachedPrimaryStateV1 =
  | {
      kind: 'in_flight';
      resourceReservationId: string;
      reservationState: 'dispatch_started';
    }
  | {
      kind: 'settled';
      terminal:
        | {
            kind: 'success';
            primaryTerminalEventId: string;
            resourceTerminalEventId: string;
          }
        | {
            kind: 'error_terminal';
            outcome: 'provider_admission_denied' | 'unknown_external_outcome';
            primaryTerminalBatchId: string;
            primaryTerminalEventId: string;
            resourceTerminalEventId: string;
            turnTerminalEventId: string;
          };
    };

interface NormalReprepareConsumptionDetachKeyV1 {
  version: 1;
  detachBatchId: string;
  branchMutationReceiptId: string;
  reason: 'fork' | 'rewind';
  source: BranchPersistenceCutV1;
  targetBase: BranchPersistenceCutV1;
  lastConsumption: NormalReprepareConsumedReceiptV1;
  primary: DetachedPrimaryStateV1;
}

interface NormalReprepareConsumptionDetachReceiptV1 {
  key: NormalReprepareConsumptionDetachKeyV1;
  detachEventId: string;
}

type NormalRepreparePrimaryTerminalEvidenceV1 = {
  version: 1;
  primaryTerminalBatchId: string;
  consumption: NormalReprepareConsumptionKeyV1;
  primaryInvocationId: string;
  primaryRequestId: string;
  turnId: string;
} &
  (
    | {
        outcome: 'provider_admission_denied';
        denialFailureKind: 'policy_denied' | 'mandatory_policy_unavailable';
      }
    | {
        outcome: 'unknown_external_outcome';
        branchMutationReceiptId?: string;
      }
  );

interface BranchSelectedCutProofV1 {
  version: 1;
  cut: BranchPersistenceCutV1;
  selectedSnapshotKind: 'rolling' | 'named';
  selectedSnapshotId?: string; // required only for named
  canonicalSelectedStateDigest: string;
  canonicalSelectedPrefixDigest: string;
  proofDigest: string;
}

interface BranchTargetBaseProofV1 {
  version: 1;
  cut: BranchPersistenceCutV1;
  copiedFromSourceProofDigest: string;
  canonicalTargetBaseStateDigest: string;
  canonicalTargetPrefixDigest: string;
}

type BranchMutationEventManifestV1 =
  | {
      kind: 'in_flight_quartet';
      eventIds: [string, string, string, string];
      eventTypes: [
        'run.error',
        'resource_budget.unknown',
        'turn.aborted',
        'context.normal_reprepare_consumption_detached_v1',
      ];
    }
  | {
      kind: 'settled_detach';
      eventIds: [string];
      eventTypes: ['context.normal_reprepare_consumption_detached_v1'];
    };

interface BranchMutationReceiptV1 {
  version: 1;
  receiptId: string;
  detachBatchId: string;
  reason: 'fork' | 'rewind';
  sourceProof: BranchSelectedCutProofV1;
  targetBaseProof: BranchTargetBaseProofV1;
  manifest: BranchMutationEventManifestV1;
  baseRevision: number;
  finalRevision: number;
  postSnapshotDigest: string;
  terminalClosure:
    | { kind: 'none' } // iff manifest.kind=in_flight_quartet
    | { kind: 'copied'; closureChecksum: string }; // iff settled_detach
  receiptChecksum: string;
}

type BranchCopiedTerminalRoleV1 =
  | 'continuation_consumed'
  | 'primary_resource_reserved'
  | 'primary_resource_dispatch_started'
  | 'primary_terminal'
  | 'resource_terminal'
  | 'turn_terminal';

interface BranchCopiedTerminalEnvelopeV1 {
  role: BranchCopiedTerminalRoleV1;
  envelope: RuntimeEventEnvelopeV24; // preserves original canonical producer identity/ID
}

interface BranchCopiedTerminalClosureV1 {
  version: 1;
  targetThreadId: string; // storage owner, not canonical producer
  targetGeneration: number;
  branchMutationReceiptId: string;
  sourceThreadId: string;
  sourceGeneration: number;
  sourceSelectedCutProofDigest: string;
  terminal:
    | {
        kind: 'success';
        envelopes: readonly [
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
        ];
      }
    | {
        kind: 'error_terminal';
        outcome: 'provider_admission_denied' | 'unknown_external_outcome';
        envelopes: readonly [
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
          BranchCopiedTerminalEnvelopeV1,
        ];
      };
  closureChecksum: string;
}

interface BranchMutationCompletionV1 {
  version: 1;
  receiptId: string;
  targetThreadId: string;
  targetGeneration: number;
  requestDigest: string;
  candidateDigest: string;
  manifestDigest: string;
  postSnapshotDigest: string;
  completionChecksum: string;
}

interface BranchMutationPrecommitProofV1 {
  version: 1;
  requestDigest: string;
  reloadedBasisDigest: string;
  candidateDigest: string;
  receiptBytes: number;
  eventBytes: number;
  snapshotBytes: number;
  refDeltaDigest: string;
}

type SummaryLifecycleStateV1 =
  | {
      phase: 'idle';
      lastConsumption?: NormalReprepareConsumedReceiptV1;
      lastDetach?: NormalReprepareConsumptionDetachReceiptV1;
    }
  | {
      phase: 'requested';
      attempt: SummaryAttemptV1;
      requestedEventId: string;
      autoContinuation?: NormalCompactionContinuationV1;
    }
  | {
      phase: 'dispatch_started';
      attempt: SummaryAttemptV1;
      started: SummaryStartedReceiptV1;
      autoContinuation?: NormalCompactionContinuationV1;
    }
  | {
      phase: 'resource_resolution_required';
      pending: PendingSummaryResolutionV1;
    }
  | {
      phase: 'normal_reprepare_required';
      reprepare: NormalReprepareReceiptV1;
    };
```

schema v24 新增 immutable `runtime_branch_mutation_receipts`、`runtime_branch_mutation_completions` 与
`runtime_branch_copied_terminal_closures`（逻辑名称）Store records；它们不是普通 RuntimeEvent。closure 以
`(targetThreadId,targetGeneration,receiptId)` 为唯一 owner/key，只允许 settled_detach，保存 consumed receipt 的
consumed/reserved/resource-dispatch-started 三个依赖 envelope，加 success 的 primary/resource 两个 terminal 或 error
的 primary/resource/turn 三个 terminal，共 exact 五或六个 original `RuntimeEventEnvelopeV24` 及角色；source
thread/generation/eventId 不改写，target owner 单独存储。这是 committed branch receipt 下 source rows删除时，对全局
consumption receipt envelope lookup 的唯一窄替代；普通 restore/receipt 不能使用。
closure 表的 authority 是 `canonical_blob BLOB NOT NULL`、独立 `closure_checksum BLOB(32)` 与
`canonical_bytes INTEGER NOT NULL`，数据库约束
`canonical_bytes=length(canonical_blob) AND canonical_bytes<=786432 AND length(closure_checksum)=32`。唯一编码
`encodeBranchCopiedTerminalClosureV1` 固定为：ASCII magic `BCTC` + u8 version=1 + u8 terminal-kind
(success=1,error=2) + u8 envelope-count(5|6) + target/source threadId（各u16be UTF-8 length+bytes，≤256B）+
u64be target/source generation + receiptId（32 raw bytes）+ sourceSelectedCutProofDigest（32 raw bytes）+ ordered
envelope frames；每个 frame 是 u8 role code（consumed=1,reserved=2,dispatch-started=3,primary-terminal=4,
resource-terminal=5,turn-terminal=6）+ u32be length + exact `canonicalRuntimeEnvelopeBytesV24`。success role序列固定
1,2,3,4,5，error固定1,2,3,4,5,6；trailing/duplicate/reordered bytes拒绝。checksum 直接绑定唯一 authority bytes：
`sha256(utf8("branch-copied-terminal-closure:v1\\0") || canonical_blob)`，不再对另一个 object representation hash。
receipt/digest 输入必须是校验过的64字符lowercase hex再解码成32 raw bytes；generation必须是positive safe integer，
用u64be承载但禁止超JS safe range。`canonicalRuntimeEnvelopeBytesV24` 是包含eventId在内的完整
`RuntimeEventEnvelopeV24` canonical JSON UTF-8 bytes；它与计算eventId时“排除eventId”的projection不是同一编码。
reader 必须先只读取固定 owner/key、
`canonical_bytes` 与 SQLite `length(canonical_blob)`，三者通过后才 materialize；随后用 u32be framed envelope length
逐项验证 exact 5/6 count、每 frame≤131072、总长、depth≤64、每string UTF-8≤131072、每nested array≤4096项
（event descriptor可更严）、unknown-field预算，再 exact decode/hash。
不得在 length/count/frame gate 前 JSON.parse、normalize、hash 或构造 envelope array。closure row↔receipt checksum/
ref-index/count/byte ledger 任一不一致 quarantine；oversized/unknown/deep/truncated/extra frame 或 decode 后不能逐字段
重编码成完全相同 canonical_blob 一律拒绝，不得读取后续正文。
唯一生产 API 为 `appendBranchMutationV1(request: BranchMutationRequestV1, candidate:
ValidatedBranchMutationCandidateV1)`。fork request 必须同时
提供 expected source identity、exact selected rolling/named cut identity 与 expected target identity；rewind request
必须提供同 thread expected current identity 与 exact selected cut identity。Store 在同一 SQLite transaction 以
threadId 稳定顺序锁定并重载全部 session/named-snapshot rows，逐字段比较 generation/snapshot/head 与 named raw-
bytes digest；source-only/target-only advance、named replace、target delete+recreate ABA 任一发生都整批 stale、零写入。

Kernel-owned `deriveBranchMutationV1(selectedBasis, input: BranchMutationDerivationInputV1)` 是唯一纯 producer：
Kernel 在每个逻辑 mutation 首次 derive 前用 CSPRNG 生成恰好 16-byte receiptNonce，并在未知 ACK/同 candidate 重试
中复用，绝不为重试重新生成。receiptId 固定为 lowercase hex
`sha256("branch-mutation-receipt-id:v1\\0" || receiptNonce || requestDigest)`；receiptNonce 不持久、不进日志，
requestDigest 在 receiptId 前可由完整 request 独立计算，因此构造无环。producer 复用 live/replay 相同的 canonical
event builder、branch batch validator 与 reducer，生成 branded opaque candidate（receipt/proofs、primary closure、
canonical events/event IDs、next snapshot），无 Store 写入或外部副作用。RuntimeStore 不解释 Summary/resource/turn
业务，也不能自行构造或修补 candidate。
requestDigest 固定为
`sha256("branch-mutation-request:v1\\0" || canonicalBranchMutationRequestV1(request))`；canonical request 使用 exact
判别 schema、Unicode code-point key order、规范 JSON escaping、safe-integer number，`undefined`/unknown/non-finite
先拒绝，并编码 RuntimePersistenceIdentity、selected cut identity 的全部字段，不省略 kind。field-order 等价、kind/
identity/snapshot digest 任一变化与 fork↔rewind 均有固定 golden。
candidateDigest 固定为
`sha256("branch-mutation-candidate:v1\\0" || canonical({requestDigest,receipt,events,terminalClosure,nextSnapshotDigest}))`；
nextSnapshotDigest 使用 schema v24 snapshot canonical checksum，requestDigest 覆盖判别 request 的全部字段。Store
重算这两类 digest，不能信任 module-private brand。

Store 先在 writer reservation **之外**加载 bounded selected basis，用同一个 Core pure
`validateBranchMutationCandidateV1(basis,candidate)` 完整重算 builder/batch/reducer、canonical bytes/event IDs/
receipt/checksum/nextSnapshot，生成固定大小 `BranchMutationPrecommitProofV1`；candidate nextSnapshot canonical bytes
硬上限16MiB、manifest events总计64KiB、receipt16KiB、copied terminal closure 768KiB、ref delta最多16项，任一
超限在加锁前 `quota_denied`。完整
state/reducer/canonical snapshot traversal 绝不在 `BEGIN IMMEDIATE` 后执行。

读取 basis 也必须先有界：rolling/source/target/named snapshot 的每个 raw BLOB 最大32MiB；selected tail 每 event
最大128KiB、最多50,000条且总canonical bytes≤64MiB；combined materialized basis≤96MiB。Store 在读取正文前先用
SQLite `length()`、事务维护的 thread event count/byte ledger 与 indexed cut range aggregate检查，超限返回
`quota_denied(resource_saturated)`；不得先 materialize/JSON.parse/normalize/构造大数组。v24 snapshot/event writer
在同一事务维护这些 ledger，counter mismatch 是 corruption quarantine。

所有 SQLite TEXT authority 的“bytes”一律指 `length(CAST(column AS BLOB))` 的持久 UTF-8 bytes，分块读取使用
`substr(CAST(column AS BLOB),...)` 或等价 blob stream；禁止用 `length(TEXT)`、字符 substring 或 JS string.length。
snapshot_json、event_json、named snapshot 与 migration build 全部遵守同一规则。

`reloadedBasisDigest` 固定为
`sha256("branch-mutation-basis:v1\\0" || canonical(basisIdentity))`；fork 的 basisIdentity 精确包含 reloaded
source RuntimePersistenceIdentity、selected rolling/named cut identity（含 named raw digest）、reloaded target
RuntimePersistenceIdentity、target receipt-ref ledger version、receipt/closure quota-ledger version 与
completion-ledger version；rewind 使用 kind+同 thread current/selected identity 与相同 ledger versions。`refDeltaDigest` 固定为
`sha256("branch-mutation-ref-delta:v1\\0" || canonical(sortedRefDelta))`，按
`receiptId,refKind,refOwnerId,operation` 排序。锁内必须逐字段重读并匹配这些 version/digest，proof生成后发生的
source/target/named/ref/quota 任一变化都返回 `identity_stale`、零写，不能沿用旧 proof 或自动 rederive。

随后专用连接 `BEGIN IMMEDIATE`，先按 candidate target thread/generation/receiptId 查询不回收的
`BranchMutationCompletionV1`。任何 fast path 前必须先 length-first decode row、校验 PK/owner/checksum，并在同一
transaction 验证 completion-ledger membership、count/bytes/version 与 row 精确一致；row孤立、ledger孤立或counter
错配均 corruption quarantine，绝不能 already_committed。通过后若 request/candidate/manifest/postSnapshot digests 全等，返回
`already_committed` 幂等零写，即使 full receipt/events/snapshot 已GC或current identity后来推进；同ID任一字段不同
返回 `receipt_collision_or_corruption`。不存在 completion 时才重载固定大小的 identity/named-row digest/counter，
与 precommit proof 逐项比较；identity 不同返回 `identity_stale`，proof/candidate 不同返回 `invalid_candidate`。

identity稳定且quota通过时，Store只机械核对固定大小 precommit digests/ref delta，然后在同一 transaction 插入
completion、full receipt、完整 manifest events、settled 分支 copied terminal closure 与 next snapshot，成功返回
`committed`。closureChecksum 固定为
`sha256(utf8("branch-copied-terminal-closure:v1\\0") || encodeBranchCopiedTerminalClosureV1(closureWithoutChecksum))`，
并由receipt引用，且编码结果必须逐字节等于Store canonical_blob；success必须
exact五个角色，error必须exact六个角色，前三个依赖 envelope 必须逐项等于 lastConsumption 的 consumed/reserved/
resource-dispatch-started IDs，后两/三个terminal与detach key逐项相等。`in_flight_quartet` 的 candidate/receipt
terminalClosure 必须都是 none，`settled_detach` 必须都是 copied
且 checksum exact 相等，表外组合拒绝。completion、receipt与closure checksum分别在
写前重算；不能先/后补任一项，也不能由 generic append API 构造携带
branchMutationReceiptId 的事件。reader 遇到 receiptId 时先 exact-load receipt；跨 tail page
最多缓存 manifest 的四个 event IDs，只有 manifest 完整才交给 reducer。flat `runtime_events` 邻接本身不被当作
原子性证明，snapshot cut 也不得落在 manifest baseRevision 与 finalRevision 之间。

branch mutation 使用专用 SQLite connection，其 busy handler/PRAGMA 与 SQLite progress handler 仅在该连接固定为
250ms，不修改普通 Store
连接的 5000ms 配置。事务禁止 `await`、Provider/网络/文件系统调用、用户 callback 或任意非纯外部代码；只允许固定
上限的 completion/identity/digest/counter/ref-index 查询与 capped BLOB 写入，不运行完整 candidate validator/reducer。
以 monotonic clock 从 `BEGIN IMMEDIATE` 开始计250ms deadline；任何第一笔写入前再次检查，progress handler 在
COMMIT 前可中断超时并回滚。只有在 COMMIT 尚未进入且 rollback 已确认时才可返回 definite
`contention_timeout`；COMMIT 已进入而返回/进程状态不能证明 commit 或 rollback 时必须返回
`commit_ack_unknown(receiptId)`。调用方只重试/查询同 candidate，由 completion proof判定。
COMMIT 进入前的 `SQLITE_BUSY|SQLITE_BUSY_SNAPSHOT` 或 deadline 只返回 `contention_timeout`，绝不冒充 source/identity stale，也不
触发 rederive/branch-abandon。Kernel 对 precommit contention 只可用完全相同 nonce/candidate 做至多一次有界
重试；但一旦出现 commit_ack_unknown，随后 completion lookup 若再次 contention/timeout，结果仍保持
commit_ack_unknown，禁止降成 persistence_unavailable、禁止宣称 lifecycle unchanged，也禁止新nonce/rederive。
WAL 与 DELETE journal 都必须遵守同一协议。

只读 `resolveBranchMutationCommitV1(receiptId,candidate digests,precommit identities)` 必须在一次 SQLite read
transaction/consistent snapshot 中 length-first 读取 completion row、completion ledger/version 与 current target
identity/generation；fork 还必须在同一 read snapshot 读取 current source identity、selected rolling/named row
identity/raw digest及precommit绑定的ref/receipt/completion/event-ledger versions，rewind读取同thread current+
selected全部对应字段，不能跨查询拼接。matching且row↔ledger一致=committed；completion absent且全部precommit
identities仍完全相等=definitely_not_committed，可由用户显式重发同candidate；completion absent且任一identity已变化/
target missing、delete+recreate或replacement=unknown_or_superseded，永久禁止自动 apply；same ID不同completion或
row↔ledger错配=collision quarantine；read BUSY/timeout/IO不可达=resolution_unavailable，外部状态继续保持
commit_ack_unknown。resolution 与 target delete/replacement 并发按该 read snapshot 线性化：读到 matching proof即
committed，读到删除/新generation且无proof即unknown_or_superseded。commit crossed→ACK lost→retry BUSY 必须保持
unknown，稍后 matching completion 才收敛成功。

`BranchMutationCommitResultV1` 的 Kernel 映射封闭如下：`committed|already_committed` 都是同一成功，加载 current
target 后结束原 mutation，不再生成 branch event；`identity_stale` 零写且禁止自动 rederive/reapply，由调用方重新
读取后显式重发 fork/rewind；`contention_timeout` 仅按上一段同 candidate重试一次，绝不改 lifecycle；
`commit_ack_unknown` 是用户可见但不泄露ID的 indeterminate 状态，只能走 resolution API；`quota_denied` 映射既有
`resource_saturated`，full receipt quota 可通过删除无引用 snapshot/event释放，但 completion 1024/1MiB 上限只能
通过导出后删除当前 session 或迁移到新 session 解除，零 branch 状态变化；
`invalid_candidate` 是 Runtime correctness failure，以 `transcript_invariant_error` quarantine target；
`receipt_collision_or_corruption` 以 `digest_invalid` quarantine target。后两者禁止自动 retry、rederive、GC证明或
降级成普通 stale，且错误展示不泄露 candidate/receipt digest。

receipt 表以 canonical bytes BLOB 为 authority，数据库约束 `length(canonical_bytes)<=16384`；reader 必须先查询
SQLite `length()` 与固定列长度，未通过前不得 materialize BLOB、JSON.parse、normalize、访问后续字段或生成 digest。
receiptId/detachBatchId/eventId/digest/checksum 最大 128 UTF-8 bytes，threadId 最大 256，selectedSnapshotId 最大
512；array count 先验 manifest 上限 4，exact-key/depth/finite-number 检查均在 canonical decode 前执行。

completion 表的复合主键/唯一键固定为 `(target_thread_id,target_generation,receipt_id)`，authority 同样是
canonical bytes BLOB，数据库约束 `length(canonical_bytes)<=1024`；target_thread_id≤256 bytes，其余 ID/digest/
checksum≤128 bytes，exact schema 深度≤2、无 array/unknown/optional正文。lookup 必须先 SELECT 固定列与
`length(canonical_bytes)`，通过后才materialize/parse/checksum；重复主键、oversized raw row、ledger无row或row无ledger
都 quarantine。所有表与 snapshot/event 写入共用同一 transaction。

v23→v24 对 receipt/completion/ref/quota 表做空初始化、零伪造 backfill，但 **event storage ledger 必须从既有非空
runtime_events真实构建**。migration 先记录 source snapshot/head/generation identity，在 SQLite 内用
`COUNT(*)`、`SUM(length(CAST(event_json AS BLOB)))`、`MAX(length(CAST(event_json AS BLOB)))` 与 row/revision/eventId
metadata 建立每256 stored-row的 count/byte/cut segment；这些查询不把 JSON BLOB materialize 到 Runtime。raw digest
以 `substr(CAST(event_json AS BLOB),...)`/blob API 的≤64KiB chunks 流式读取
每行 raw bytes，保持常量内存；单event>128KiB可记录但使后续branch mutation quota_denied，不得伪造较小长度。

pre-v24 允许任意多个 leading/mixed legacy rows 使用 revision=0/eventId=null；迁移不得要求它们 revision连续或伪造
eventId。accepted rolling snapshot 在通过既有 checksum/schema/state invariant 后是 semantic base authority；migration
只从该 snapshot 严格 replay/normalize 它的 tail 到 recorded head，不声称从 genesis 重放全部历史 rows，也不以
historicalRawDigest替代semantic验证。migration 把当时全部 historical rows（legacy 与
metadata-complete）折叠进 `runtime-event-ledger-legacy-base:v1`：normalized state/transcript digest + row count/raw
bytes/raw digest。新 v24 snapshot 从该逻辑 base 开始，tail 为空；只有切 v24 后追加的 event 才必须 positive
consecutive revision+nonempty canonical eventId并进入 D1..Dn。历史 named snapshot 以其 bounded canonical snapshot
state/digest和可回查事件前缀构造独立 selected-cut proof，不需要给 legacy rows 补ID；不能选择单个 legacy raw row
作为v24 branch cut。

named snapshot proof 采用 **eager migration**。Store 为每个thread维护单调 `namedCatalogVersion`；create/replace/
delete均与catalog version+1同事务。ledger build记录catalog version并枚举每个named row，先做BLOB byte gate/raw digest、
strict schema/state/transcript normalize，再尝试按其selected cut有界回查metadata-complete canonical prefix。只有前缀、
generation/state/transcript均可验证时写 `trust=verified_metadata_prefix`，计算`verified_named_v24` ledger base并允许
fork/rewind；缺metadata、只有self-hash、cut无法对应或内容冲突一律写`legacy_unverified`，仅允许兼容read/export，
不得作为branch source、不得restore进v24 rolling state，也不得因后来重新hash而升级。切v24后的新named snapshot由
v24 writer直接生成verified proof。

final migration CAS 必须比较namedCatalogVersion、proof count与catalog digest；build期间任一named create/replace/
delete使CAS stale并重建。named proof 的无环公式固定为：

```text
evidenceDigest = sha256(utf8("legacy-named-cut-evidence:v1\0") || canonical(evidence))
eventLedgerBaseDigest = sha256(utf8("runtime-event-ledger-named-base:v1\0") || evidenceDigest)
proofChecksum = sha256(utf8("legacy-named-cut-proof:v1\0") || canonical(proofWithoutChecksum))
```

`evidence` 只含 raw length/digest、normalized state/transcript、catalog version 与 metadata-prefix 或
legacy-unverified source evidence，不含 ledger/proof checksum。只有 verified evidence 才构造 selected cut 与
`verified_named_v24` ledger base；unverified proof 不得携带这两项。branch request 必须匹配
`expectedNamedCutProofChecksum`；proofChecksum、evidenceDigest、selected ledger_base/baseId与trust逐项重算。
source delete后target branch correctness仍由已复制的target-owned proof负责，不回查已删除source。字段顺序等价、
任一 evidence/base/checksum tamper 与试图构造 checksum→base 回边均 fail closed。

`RuntimeThreadWriteFenceV1` 是独立于 rolling snapshot 的单调写 fence。v23 additive migration 不能把全部旧 fence
默认成 active：对每个 existing fence，在同一 consistent basis 中若有一份通过 checksum/schema invariant 的
runtime session/rolling snapshot authority，则保留 existing generation并标
`{format:v23_compat,writeEpoch:1,lifecycle:active}`；若 session/snapshot/event/named/receipt/artifact 等所有
session-owned rows 均不存在，则保留 generation并标 deleted tombstone；“无session authority但仍有任一owned row”、
重复/非法generation或session authority与fence缺失/冲突均 quarantine，不猜 active/deleted。合法的 active empty
session 由其空 rolling snapshot/session authority识别，不能因event count=0当作deleted。

仅当 DB 中从未存在该 thread fence 时，v24 新 thread 才以
`{generation: 1, format: v24_strict, writeEpoch: 1, lifecycle: active}` 创建。
`writeEpoch` 必须是 positive safe integer；v23→v24
cutover、generation-changing rewind、fork target replacement、delete/recreate 或明确 ownership reset 才原子 `+1`，
普通 append/named mutation 不推进 epoch，但仍须 CAS 当前 epoch 加各自 revision/catalog identity。达到
`Number.MAX_SAFE_INTEGER` 时 correctness quarantine，禁止 wrap、reset 或继续写。

v24 cutover 必须在该 fence 中原子写 `format=v24_strict` 并推进 `writeEpoch`，同时安装
`RuntimeStorageFormatV1`；format/epoch不随rewind回退。所有生产 writer——`appendEvents`、
`appendEventsAndSnapshot`、snapshot save、named create/replace/delete、fork/rewind/branch writer，以及
`deleteSession`——都必须携带 expected generation+format+writeEpoch 并以同一 conditional fence CAS验证。
`deleteSession` 没有 admin bypass：它在同一事务验证 exact fence，推进 retained fence 的 generation+writeEpoch，
把 lifecycle 切为 deleted，再删除 session/snapshot/event/named/receipt/completion/closure/build rows；**fence tombstone
永久保留至整个 Store 被销毁**。recreate 必须 exact CAS 该 deleted row，再次推进 generation+writeEpoch、切 active，
并保持 `v24_strict`（v23 tombstone 只能单向升级，任何 tombstone 都不得降级/reset）。旧 connection 或 stale delete/
recreate 零写，source delete
仍不得级联删除 target-owned branch proof。format/epoch 冲突返回 typed `storage_format_conflict`。
completion unknown-resolution 在同一 consistent read 中读取 retained fence：deleted 或已 recreate 的更高
generation/epoch 且无 matching completion 固定为 `unknown_or_superseded`，不能误判 never committed 或复用旧 identity。

永久 fence 使用 Store-level transaction ledger 限界：每 row canonical bytes≤256，整个 Store 最多 1,048,576 个
thread fence 且总 canonical bytes≤256MiB；active/deleted都计入，delete/recreate不改变count，只有从未存在过的新
thread insertion消耗quota。新thread create必须在同一事务先比较 ledger version/count/bytes，再插fence并推进counter；
超过任一上限返回现有 `resource_saturated`、零session/fence mutation。row无ledger、ledger无row、under/overflow或
crash半更新均corruption quarantine。tombstone不做GC；若未来需要回收，必须另引所有writer携带的Store-wide monotonic
incarnation ADR，不能复用thread ID/reset identity。fence IDs/counters不得进入模型上下文或telemetry正文。

首次 v23→v24 Store migration 必须在开放任何新 writer 前真实 backfill fence ledger，而不是空初始化。Store 持久
`RuntimeFenceLedgerBuildV1`：store schema epoch、buildId、source fence-catalog version、next threadId、running
count/canonical-bytes/digest、active/deleted counts 与build checksum。每≤4096 rows chunk都在短事务CAS schema epoch、
fence-catalog version及上一progress/checksum；create/delete/recreate在v23_compat期间同事务推进catalog version，使
并发worker stale。final CAS逐row分类证明摘要、count/bytes/digest与catalog version完全相等后安装ledger并开放writer；
crash只可续相同basis，竞争builder一胜，其余零写。legacy实际count/bytes若已超过新quota，ledger仍记录真实值并标
`saturated_legacy`：现有不新增fence的writer和exact recreate可运行，但任何新unique thread insert都
`resource_saturated`；单row>256B、孤儿/歧义分类或counter overflow仍quarantine。迁移中断、超quota、deleted legacy
fence→recreate、active empty、orphan/tamper与并发create/delete均必须保持旧事实且不暴露半ledger。
旧connection/旧candidate在cutover后命中0 row，返回typed `storage_format_conflict`、零写，不能以reload前旧schema
继续；这是Store内部结果而非新`FailureKind`，Kernel丢弃旧writer并按current format重新restore，绝不重放旧batch。

`v24_strict` 禁止generic metadata-less `appendEvents()`；普通runtime写只能通过metadata-complete event+snapshot
原子API，batch每个event都必须positive consecutive revision、nonempty canonical eventId、同generation/writeEpoch，
并从ledgerBase.nextRevision开始。mixed metadata/nonmetadata、revision0/null ID、非canonical ID、tail chain/storage
ledger/snapshot不一致整批拒绝。legacy generic append只允许format≤v23的兼容fixture/migration入口，且cutover fence
之后永久失效。这样final migration CAS既挡迁移期间并发写，也挡commit后仍存活的旧连接。

ledger build 使用独立 resumable build rows，唯一键为 `(threadId,buildId)`，并保存 generation、预期
`format=v23_compat`、`lifecycle=active`、writeEpoch、source snapshot/head identity、namedCatalogVersion、next stored-row ordinal、running
count/bytes/raw digest、normalized base candidate、segment checksum 与 build-row checksum。**每个 chunk** 都在短事务
中重载并逐项 CAS fence、source snapshot/head、namedCatalogVersion、上一 build checksum/progress；任一漂移、format
已变 v24、竞争 worker 已推进或 build checksum 冲突都返回 stale，且不能追加、覆盖或复活 artifact。crash 后仅在
完整 basis 相等时续跑，否则删除旧 build 并以新 buildId 重建。所有全量 COUNT/SUM、strict restore、segment与base
digest核对都在 writer reservation 外完成并封入 finalBuildChecksum。最终短 `BEGIN IMMEDIATE` 只重读固定大小
fence/source snapshot/head/named catalog、completed build row与finalBuildChecksum；完全相等才同CAS安装v24
snapshot+ledger、推进 fence 并删除build row，绝不在锁内重扫runtime_events。cutover 后旧worker的下一chunk必为
storage-format conflict/零写；v24 startup 只可用 bounded internal GC 清理无引用 v23 build artifact，不得改变 runtime
state。并发 append、rewind、fork、delete 任一漂移都使 final CAS stale，不能切v24。
迁移中 Runtime仍按v23事实读取，branch API不可用；中断/重试不得暴露半ledger。

receipt/completion/copied-terminal-closure 都是 target-session owned。completion 是 session-lifetime idempotency tombstone：与 branch
mutation 同事务创建，full receipt/event/snapshot 是否回收都不影响它，除 `deleteSession(target)` 外不得 GC/update；
每 session 最多1024条且总canonical bytes≤1MiB，与 full receipt quota 同时在 mutation 前检查。target delete 必须
在同一事务删除该 target 的全部 completion/receipt/closure；删除 source session 绝不级联。rewind、fork target replacement、rolling/named snapshot
删除后，只能回收已无 retained target event manifest、rolling snapshot 或任一 named snapshot 引用的 receipt；不能
按 generation 粗暴删除；closure 与其 receipt 同生共死。Store 维护 `(targetThreadId,receiptId,refKind,refOwnerId)`
事务性引用索引，以及每 session receipt/closure count/canonical-byte ledger；GC 与 quota 只做 indexed lookup/counter CAS，禁止扫描或解析 snapshot/event
正文。每 session 最多 1024 个 receipt 且 canonical 总字节最多 16MiB，任一上限将在 branch mutation 前固定为
现有 `resource_saturated` failure/terminal reason、零 target mutation；单个 copied closure ≤768KiB、exact五或六个
envelope、每个≤128KiB，session closure canonical 总字节≤96MiB且count≤1024。删除引用/receipt/closure 时同事务
递减，counter underflow/mismatch fail closed。completion counter/bytes 同样事务维护但不随 full receipt GC 递减。
receipt/completion/closure 的 ID、digest、
selectedSnapshotId、proof 与 manifest 全部禁止进入 telemetry、session log、模型上下文或用户错误正文；只允许本地
Store correctness 诊断记录 bounded count/bytes。

v24 的 `ContextRuntimeState` 使用判别 union 保存
`LegacyUnverifiedCheckpointV1 | VerifiedContextCheckpointV3`，并新增 bounded summary attempt/normal
continuation、唯一 `SummaryLifecycleStateV1`、`successfulPrimaryOrdinal`、
`AutoSummaryCooldownV1` 与
`projectionBaseIdentity`。新 context 事件 union 固定为
`context.summary_requested_v1 | context.summary_dispatch_started_v1 | context.summary_completed_v1 |
context.summary_failed_v1 | context.summary_unknown_external_outcome_v1 |
context.normal_resource_resolution_required_v1 | context.normal_reprepare_required_v1 |
context.normal_reprepare_consumed_v1 |
context.normal_continuation_superseded_v1 | context.summary_branch_abandoned_v1 |
context.normal_reprepare_consumption_detached_v1 |
context.checkpoint_v3_rebound_v1`。它与现有 `resource_budget.reserved/dispatch_started/reconciled/released/unknown`
事件组合；只有 completed 可携带 V3。

batch key 明确位于各事件 **payload**，不修改通用 `RuntimeEventEnvelope`。v24 为参与 Summary 的 resource event
payload 增加可选 `summaryStartBatchKey|summaryTerminalBatchKey|summaryResolutionBatchKey` 字段；一旦 reservation
的 purpose 是 Summary，对应阶段的 key 就是必填；continuation-derived primary 的 reserved/dispatch-started 另带
`normalReprepareConsumptionKey`，branch detach 的 primary unknown 另带
`NormalRepreparePrimaryTerminalEvidenceV1`，最终 detach event 才带
`normalReprepareConsumptionDetachKey`；普通 model/tool resource event 不携带这些扩展。start batch 的四/三
个事件携带完全相同的 `SummaryStartBatchKeyV1`；它不含任何 start event 自身的 event ID，validator 按
`startBatchId + ordered event type` 从 envelope 映射各角色，避免 canonical event ID 对最终 envelope 的自引用。
terminal/continuation/resource event 携带完全相同的
`SummaryTerminalBatchKeyV1`；late resolution 两事件携带完全相同的 `SummaryResolutionBatchKeyV1`。key 与
Runtime envelope 的 event ID/revision 分别校验，不能用 generic envelope metadata 替代。`terminalBatchId` 在批内
完全相等，`causationId` 与 `resourceDispatchCausationId` 分别指向 start batch 中既有的 context/resource
dispatch-started envelope；pre-dispatch manual denial 的 `causationId` 指向既有 `summary_requested_v1`，且没有
resource dispatch causation。

schema v24 的 **完整 closed durable `RuntimeEvent` subset**（user/model/tool/plan/context/resource/run/turn 等全部可持久
类型，显式排除 presentation-only progress/delta）统一使用
一个 canonical event ID，不再保留 Summary 专用公式或 hash 后补 timestamp 的路径：

```text
eventId = sha256(
  utf8("runtime-event:v24\0") ||
  canonicalRuntimeEnvelopeIdentityV24({
    schemaVersion: 24,
    threadId,
    generation,
    revision,
    causationId: normalizedCausationId,
    occurredAt,
    event: finalNormalizedPayload
  })
)
```

构造顺序固定为：对完整 RuntimeEvent 判别 union 做 exact decode（未知 type/字段拒绝）→归一协议默认值→由 Kernel
注入最终持久的 payload `createdAt`/其他 timestamp 与 envelope `occurredAt`，并分配 thread/generation/revision→对
**最终持久 envelope projection** canonical 编码→计算 eventId→持久。canonical projection 排除且只排除 eventId
自身；input 缺失的 causationId 必须规范化并持久为 `null`。generic `causationId` 保持 ADR-0096 的 opaque、bounded
correlation identity：non-null 必须为1..128 UTF-8 bytes，可等于 terminalBatchId，不被解释或 dereference 为 event
edge；它仍进入 hash并受 exact byte
校验。需要前序 event edge 的 Summary/continuation 协议必须使用 payload 中具名的 requested/started/terminal/
resource event-ID 字段，并按各自 validator 验证先后关系，不能借 generic causationId 代替。对象 key 按 Unicode
code point 升序，array 保持协议顺序，string 使用规范 JSON escaping，boolean/null/finite
number 使用唯一 JSON 表示。unknown key、`undefined`、non-finite number、重复语义字段或超预算 payload 先拒绝。
调用方 supplied/auto timestamp、field order、caller envelope 走同一归一流程；hash 后不得再注入或改写任何持久字段。

Kernel 是唯一 event builder；Store 对每个 v24 event 使用同一 pure canonical function 从最终 bytes 重算 ID，再检查
type/thread/generation/revision/ledger chain，不能信任 caller-supplied envelope/eventId。pre-v24 event IDs 保持原样并
仅由 migration reader消费，不追认成 v24 identity。两个 payload 正文相同但 revision/timestamp 不同会得到不同 ID；
exact replay 的所有最终字段相同才得到同 ID。后续事件可引用已先行物化的 event ID，任何事件都不得引用自身，因而
Summary start/terminal、normal continuation 与 branch quartet 的 ID 依赖仍是有向无环图。

`CanonicalRuntimeEventRegistryV24` 必须在编译期 exhaustively 覆盖 `DurableRuntimeEventV24['type']`，每个 descriptor 冻结
exact字段、default归一、timestamp owner、canonical-byte上限与event-level validator；runtime conformance/golden 对完整
union逐类执行。新增 durable event type/字段、改变 default/timestamp 或 canonical encoding 必须提升 Runtime schema 与
registry ID，不能静默修改 v24 registry；旧 registry reader只能按其原版本fail closed读取。四类
`EphemeralRuntimeEventV24` 只走 presentation callback，无 eventId/generation/revision，durable builder、reducer、Store
与snapshot admission 必须硬拒，维持 current active boundary。

v24 event row 持久 `RuntimeEventStoreRecordV24`：owner thread/generation 与 canonical envelope thread/generation 是
不同字段。普通 runtime_events append 强制二者逐项相等且等于 current active write fence；row 中 canonical thread、
generation、revision、causationId、occurredAt、payload/eventId 以及 canonical byte length 都与 decoded envelope exact
相等，任一 mirror mismatch quarantine。replay 只能使用行内 canonical generation 重算，禁止从 current fence猜测。
branch copied-terminal closure 由 target owner保存 original source canonical envelope，因此 owner与producer可以不同，
但它不是 runtime_events row，不能推进 target ledger/revision。

Store schema 对 v24 rows 固定持久 `owner_thread_id, owner_generation, canonical_thread_id,
canonical_generation, revision, event_id, causation_id NULL|TEXT, causation_bytes, occurred_at, canonical_envelope BLOB,
canonical_bytes`；`causation_bytes=0` iff null，否则必须等于 `length(CAST(causation_id AS BLOB))` 且1..128，DB CHECK
先阻止oversized mirror。reader 的第一查询只取固定key、`causation_bytes`、SQLite raw length与canonical_bytes，不得先
materialize causation TEXT/BLOB；通过后才加载canonical envelope并逐项比对。普通 row 以
`(owner_thread_id,owner_generation,revision)` 唯一，event ID 在 owner generation 内唯一，
`canonical_bytes=length(canonical_envelope)` 且≤128KiB。reader 必须 length-first，再 exact decode并逐列比对 BLOB；
不能让索引列覆盖 BLOB 真值。v23历史 row 不补造 generation/envelope，它们只折入 migration base；v24 tail 从新
schema row开始。copied closure 使用独立 target-owned表，不插入 runtime_events，也不占用/改写 target revision。

在物化/使用任何 causation receipt 前，live batch reducer、tail replay、snapshot restore 与 fork/rewind rebind
都必须对其引用 envelopes 逐个执行全局 v24 canonical hash、exact type/role、thread/generation、revision/cut 与 batch key
校验。`SummaryStartedReceiptV1` 最多有四个 start IDs；`NormalReprepareOriginV1` 最多有两个前序 IDs；
`NormalReprepareConsumedReceiptV1` 有 consumption/reserved/resource-started 三个 IDs；
`NormalRepreparePrimaryTerminalEvidenceV1` 的 error-terminal 有 primary/resource/turn 三个 IDs，并由 detach key
逐角色引用；Pending/terminal 使用同一
规则。普通 snapshot restore 按 receipt IDs 对 runtime_events 做固定上限 indexed lookup；committed
`settled_detach` 只允许用 matching branch receipt 绑定的五/六-envelope copied closure完成同样的 exact lookup，且只在
source dependency rows已prune/delete时作为窄替代。两者都不扫描全 event log；缺失、payload 不变
但 ID 改变、ID 不变但 payload 改变、角色互换或 cut 外引用都 quarantine。

generation 校验只有 committed branch mutation receipt 例外：`in_flight_quartet` 按完整四事件，
`settled_detach` 按单 detach+copied target terminal facts，分别结合 `BranchMutationReceiptV1` manifest 作为一个
target-generation protocol mutation 验证，不能让通用 terminal/detach reducer 逐事件接收旧 generation evidence。
前三个 evidence 的 branchMutationReceiptId 只允许出现在 unknown quartet，ordinary startup unknown 禁止该字段；
tail 分页可暂存最多 manifest 声明的四个 ID，EOF/下一不相干事件前仍不完整即 quarantine。除此之外，任何
receipt/evidence 中的 thread/generation 都必须等于当前 owner。

Kernel 的 summary batch reducer 必须消费完整 `RuntimeEventEnvelopeV24[]`，不能只消费 payload：requested event
提交后在唯一 `SummaryLifecycleStateV1` 中保存 requestedEventId；完整 start batch 验证后，在同一次 state
transition 中切换到 dispatch_started，并保存 `SummaryStartedReceiptV1` 的 requested、reserved、resource-
dispatch-started、context-dispatch-started 四个 envelope ID 与完整 start key。它们是 terminal/stale 的唯一 durable
causation handle；restart 或中间插入任意 control event 后不得用 `lastAppliedEventId` 猜测，也不得回扫无界 event
log。manual pre-reservation denial 只从 requested phase 取 causation；resource-resolution phase 的 Pending 嵌入
同一 started receipt。

immutable `SummaryAttemptV1` 与 `NormalCompactionContinuationV1` 不携带 phase。Context state 不再另存 top-level
attempt/continuation/Pending 镜像，所有权只有 `SummaryLifecycleStateV1`：manual 的 requested/started phase 必须没有
autoContinuation；auto 必须有且字节匹配 attempt source/turn；resource-resolution 与 normal-reprepare 只允许 auto；
任一事件 batch 原子地从一个 phase 迁到另一个。schema decode、migration、replay、fork/rewind 和 scheduler 发现
多 owner、reason/continuation 不匹配或非法 phase 时一律 fail closed。

`sourceRangeDigest` 的 canonical contract 固定为 `canonical-transcript-prefix:v1`：按 durable 顺序编码 messageId、
turnId、ordinal、role、规范化 content bytes，以及 tool call 的 id/name/args digest、terminal kind/status、verified
model-result digest；不编码 transient UI、时间估算或 Runtime authority projection。实现必须流式/有界重算，禁止
先构造与 transcript 等大的 JSON 字符串。

V3 的 `sourceRevision` 必须等于 `sourceProducingEventCutV1.revision`，后者的 eventId 必须是产生
`coveredThroughMessageId` 所属最后一个 canonical block 的 durable event；它不是 snapshot/event-table current head。

`SummarySourceIdentityV1` 只由 canonical transcript covered message/turn identity、source digest 与 source
projection policy 组成，不包含 Runtime revision/event cut、checkpoint/summary output、model route、ToolSet、
projection environment 或时间。V3 的 `sourceProducingEventCutV1` 是独立 restore proof，只能指向 covered prefix
最后一个 durable transcript-producing event；user command、resource/lease/config/telemetry、checkpoint activation
与 cooldown 等 control-only event 不推进它，也不改变 SummarySourceIdentity。相同 source 在 checkpoint 激活
前后保持相同 dedupe identity。`successfulPrimaryOrdinal` 只在成功 normal primary terminal 递增；summary 后立即
续跑且成功的 primary 是 cooldown 三次中的第一次，failed/unknown/aborted 不计。restart 保留；rewind 从目标
event history 重算；fork 复制目标 cut 的已完成 ordinal/cooldown 并由新 generation 隔离。

所有真正持久到 `resource_budget.dispatch_started` 的 manual/auto Summary attempt 都更新
`lastAttemptSourceIdentity` 与 cooldown baseline；pure/no-op/pre-reservation denial 不更新。任意 control-only event
序列下 identity 必须字节不变，只有新增 settled source block 才改变；该性质进入 property Gate。

`lastAttemptSourceIdentity` 与 cooldown 只限制 auto eligibility，不禁止用户显式 manual retry。上次 manual
failed/stale 且 active checkpoint 未覆盖该 source 时，用户可对同一 source 串行重试，但仍须通过相对 active
checkpoint 的 no-new-source、best-case saving 与 admission；上次成功已覆盖该 source 时因无新 safe source
durable no-op。manual dispatch 仍会更新 auto cooldown，防止紧接着自动重复。

事件共同键固定为 `attemptId + compactionId + SummarySourceIdentityV1 + requestedAtRevision + requestedAtTurnId`。
`requested_v1` 携带完整 `SummaryAttemptV1`；start batch 只绑定此时已经存在的
`SummaryDispatchStartBindingV1`：prepared identity、requestId、expected payload/max-output/ToolSet、effect lease
与 resource reservation 必须逐项相等。final Provider-data gate 在 start CAS 后执行，所以 admitted digest/receipt
绝不进入 start key，也不在 gate 与 Provider callback 之间新增持久写。`completed_v1` 携带 V3；`failed_v1` 携带
bounded typed failure；
`unknown_external_outcome_v1` 不携带模型正文。相同键 exact replay 幂等，任一内容冲突整批 fail closed。

terminal 必须携带判别式 `SummaryTerminalAdmissionStateV1`。final gate 未完成时为 `not_completed` 且 evidence
禁止；明确拒绝时为 `denied(local_provider_admission_denied)` 且 evidence 禁止；真正通过后为 `admitted` 且
`SummaryTerminalAdmissionEvidenceV1` 必填，并验证 final payload/max-output/ToolSet 与 start expected identity 一致；
只有 crash recovery 无法知道 gate 是否通过时可用 `indeterminate_after_crash`，evidence 禁止且资源只能 unknown。
Provider 返回成功、返回错误或返回非法 summary 时必须是 admitted。`prepared_dispatch_not_entered_v1` release proof
可与 not_completed 或 admitted 配对：若 gate 已通过、callback 前才 stale，则 admitted evidence 必填；local denial
只能是 denied；validator 按分支拒绝伪造或缺失。

完整允许矩阵冻结如下；表外组合全部拒绝：

| admission state | guard/事实 | summary terminal | resource terminal | admission evidence |
| --- | --- | --- | --- | --- |
| `not_completed`（manual requested-only） | 无 guard、无 dispatch start；causation=requestedEventId | `failed(pre_reservation_denied)` | 无 | 禁止 |
| `not_completed` | `closed_without_entry` winner + `prepared_dispatch_not_entered_v1` | typed stale `failed` | `released(prepared_dispatch_not_entered_v1)` | 禁止 |
| `denied` | `closed_without_entry` + final data gate denial | `failed(provider_admission_denied)` | `released(local_provider_admission_denied)` | 禁止 |
| `admitted` | `closed_without_entry` winner + `prepared_dispatch_not_entered_v1` | typed stale `failed` | `released(prepared_dispatch_not_entered_v1)` | 必填 |
| `admitted` | `entered` + trusted actual usage | `completed|failed|unknown` | `reconciled(actual)` | 必填 |
| `admitted` | `entered` + usage unavailable | `completed|failed|unknown` | `unknown` | 必填；completed 可激活 V3，但 continuation 等待 resource resolution |
| `indeterminate_after_crash` | guard 不可恢复 | `unknown` | `unknown` | 禁止 |

必须显式拒绝 `not_completed + reconciled/unknown`、`denied + prepared proof`、`admitted + local denial`、
`indeterminate + released/reconciled`、任意 `guard=open` terminal、`guard!=entered` 的 Provider result，以及 evidence
presence 与表不符的组合。

Kernel 对 starting 与原 effect lease 仍 current 的 terminal batch 固定以下完整形态；stale lease 只能走前述
`applyStaleSummarySettlementV1()`：

1. auto start：只有 summary 已通过 pure preparation 与 pre-reservation admission 时，才提交
   `summary_requested_v1(lifecycle requested + autoContinuation) → resource_budget.reserved →
   resource_budget.dispatch_started → context.summary_dispatch_started_v1`，四事件同一 effect lease CAS；在此
   之前被拒绝时不创建 attempt/continuation，原 normal scheduler 继续；
2. manual start：命令可先单独提交 `summary_requested_v1(no continuation)`；实际 dispatch 时必须以
   `resource_budget.reserved → resource_budget.dispatch_started → context.summary_dispatch_started_v1` 同一 lease
   CAS 提交；
3. manual no-reservation denial：已由命令持久 request、但尚未取得 reservation 时，以单一
   `summary_failed_v1` 收敛；auto 不存在这种半开始状态；
4. actual usage：`summary_completed_v1(V3)|summary_failed_v1|summary_unknown_external_outcome_v1 →
   resource_budget.reconciled(actual) → normal_reprepare_required_v1`；manual 精确省略第三项；unknown terminal
   不携带/激活 V3，但 actual usage 可以独立可信；
5. zero-execution proof：`summary_failed_v1 → resource_budget.released(proof) →
   normal_reprepare_required_v1`；manual 精确省略第三项；
6. dispatched usage unknown：`summary_completed_v1(V3)|summary_failed_v1|
   summary_unknown_external_outcome_v1 → resource_budget.unknown →
   normal_resource_resolution_required_v1`；manual 精确省略第三项；completed 仍可激活 V3，但在资源 resolution
   前不得启动 primary。auto reducer 必须从已验证 batch envelopes 原子物化 `PendingSummaryResolutionV1`，保存
   durable started receipt、original terminal batch、resource unknown event ID、reservation、continuation、generation 与
   source common key；`normal_resource_resolution_required_v1` payload 携带同构 pending seed，Kernel 先构造
   resource-unknown envelope，再把其已知 event ID 写入后续 continuation event，因此没有 event-ID 自引用，也不
   增加中间持久写。不得依赖后续回扫完整 event log；
7. late resolution：专用 Kernel `applyLateSummaryResourceResolutionV1()` 只接受
   `resource_budget.reconciled(actual) → normal_reprepare_required_v1`，两事件携带同一独立 resolution key/CAS，
   causation 指向 record 内原 `resource_budget.unknown`。它只消费当前 `PendingSummaryResolutionV1`，验证原
   reservation=unknown、matching auto continuation=resource_resolution_required、original terminal/start binding、
   normal turn/source 与 generation，并在同批清除 pending record；重复、缺失、fork generation 或任一 identity
   不同都拒绝。普通 late-resource path 仍只接受 resource reconciliation 且不能唤醒调度。不得通过估算、超时或
   普通 HTTP 状态释放 unknown。

每个 `normal_reprepare_required_v1` payload 必须携带自包含 `NormalReprepareReceiptV1`。直接 terminal 分支先构造
summary terminal 与 resource terminal envelopes，再把两者 event ID、terminalBatchId 写入后续 reprepare event；
late-resolution 分支从 `PendingSummaryResolutionV1` 复制原 `resourceUnknownEventId`，再写入新
resource-reconciled event ID、resolutionBatchId 与 original terminal batch；不引用后续 reprepare event 自身。
Reducer 只从已验证完整 batch 原子保存该 receipt，不能只保存裸 continuation。

scheduler 消费 continuation 时先从 committed state fresh prepare，取得新的 primary effect lease；只有 Provider-
ready candidate 才允许一个 CAS batch 提交：

```text
context.normal_reprepare_consumed_v1(NormalReprepareConsumptionKeyV1)
→ resource_budget.reserved(primary)
→ resource_budget.dispatch_started(primary)
```

三个 payload 携带相同 consumption key，并绑定 receipt origin、current generation、新 primary lease/reservation、
独立 `primaryInvocationId` 与 `primaryRequestId`、prepared request 与 expected payload/output/
ToolSet。resource reserved/dispatch-started 的 invocation identity 必须匹配 `primaryInvocationId`；final
`AdmittedContextRequestV2`、`model.requested` 与 primary terminal evidence 必须匹配 `primaryRequestId`；二者原值
不得互相替代或要求相等。完整 canonical `NormalReprepareConsumptionKeyV1` 已同时包含 consumptionBatchId 与两个
原值，不另存冗余 pair digest；swapped 或任一 mismatch 都拒绝。
Reducer 必须要求 current lifecycle 的 receipt 字节完全相等，
然后原子切到 `idle(lastConsumption)`；`NormalReprepareConsumedReceiptV1` 的三个 envelope IDs 由完整 batch metadata
物化并使用同一 canonical hash 校验。双 scheduler 只有一个 current-state CAS 能成功；exact replay 幂等，key 或
payload 不同拒绝。

consume batch 前崩溃时 lifecycle 仍为 normal-reprepare，可重新 fresh prepare，尚无 external primary；batch 后崩溃
时 lifecycle 已 idle 且 primary resource 已 dispatch-started，恢复沿现有 primary unknown 路径，绝不再次消费或
dispatch。reserve/admission 无法开始时不得提前清 lifecycle；新用户 source 在 consume 前使 receipt superseded 并
切 idle；fork/rewind 使用 branch-abandon。final admission denial 或 callback 后 outcome 由普通 primary terminal/
resource 协议收敛，不复活 continuation。

continuation-derived primary 的 final admission/unknown 终态不得沿用当前分步 App error path。其
`run.error`、resource terminal 与 turn terminal 都携带相同
`NormalRepreparePrimaryTerminalEvidenceV1`，并精确匹配 lastConsumption 的 consumption key、invocationId 与
requestId：

1. final Provider-data admission 同进程明确拒绝时，Kernel 单一 CAS 提交
   `run.error(provider_admission_denied) → resource_budget.released(local_provider_admission_denied) →
   turn.aborted`；三事件齐全后才可见，禁止先 release 再由 App 补 error/abort；
2. consume batch 后、任何 primary terminal batch 前崩溃时，guard/admission 内存事实不可恢复。startup 只在
   reservation=`dispatch_started` 且三个 terminal 事件一个都不存在时，允许
   `run.error(unknown_external_outcome) → resource_budget.unknown → turn.aborted` 的单一 CAS，不得重新 prepare、
   consume 或 dispatch。三个事件已完整存在时只能按三个 canonical IDs/terminalBatchId 做 exact replay/no-op；
   reservation 已 unknown 但缺 run/turn，或任意其他 terminal 子集，一律是非法半批并 quarantine，禁止补齐洗白；
3. 两类 batch 的 primaryTerminalBatchId、event order、consumption key 与 request/invocation identities 必须一致；
   `run.error` 是 detach settled 的 primary terminal，released/unknown 是 resource terminal，`turn.aborted` 是 turn
   terminal。三个事件的 `turnId` 必须逐项等于 evidence.turnId 与
   `consumption.reprepare.continuation.turnId`，且 `turn.aborted.cause='error'`。denial 分支必须逐项对应
   evidence.denialFailureKind 与现有 failure taxonomy：明确 policy 拒绝为
   `run.error.failure.kind=policy_denied`，强制 admission authority 不可用为
   `run.error.failure.kind=mandatory_policy_unavailable`；两者都由既有 `classifyFailure()` 与
   `failedTerminalOutcomeV1(...,{knownExternalEffects:'none'})` 生成，并对应
   `resource_budget.released(proof=local_provider_admission_denied)` 与 evidence.outcome。unknown 分支必须对应
   `run.error.failure.kind=unknown` 与 terminal `status=unknown, reasonCode=unknown,
   knownExternalEffects=unknown, safeRetry=false, recoveryEntry=reconcile`、`resource_budget.unknown` 与
   evidence.outcome，且禁止携带 denialFailureKind。本协议不新增 `FailureKind`，协议 outcome 也不得冒充
   `ClassifiedFailure.kind`。缺一、重排、跨 turn/request、错误 failure/proof/cause、重复不同 outcome 或 batch前后 crash
   都 fail closed/exact replay；三个 IDs 均进入 bounded canonical lookup。

因此不存在 durable `idle(lastConsumption) + released + no primary terminal` cut：要么终态三事件全部提交，要么
仍是 dispatch-started 的 in-flight 状态，并由第 2 条确定性收敛；孤立 unknown 是非法半批。该窄协议只适用于由
NormalReprepareConsumptionKey 派生的 primary；普通 primary 的现行行为不在本 ADR/RFC 中被追认或改写。

fork/rewind 若在 consume 后且上述三事件尚未存在，只允许在 Store branch transaction 中提交完全相同的 unknown
三事件，随后以第四个 `context.normal_reprepare_consumption_detached_v1` 引用其三个 envelope ID 并清除
lastConsumption；这四个事件同一 target-generation CAS 可见。若三事件已经完整存在，则 primary 是 settled，branch
只写 detach；若只发现 resource unknown 或任意三事件子集，则视为非法半批并 quarantine。无论 source 漂移发生在
final gate 前、gate 后 callback 前或进程恢复期间，target 都只能得到 aborted turn + settled detach，绝不重新
prepare/consume/dispatch。

completed 分支原子激活 V3 并清除/失效 Micro commit；failed/unknown 不改变 checkpoint。Kernel batch validator
按 reason、dispatch presence 与 resource outcome 检查精确事件数、固定顺序、完整 common key、terminalBatchId、
causation、lease/reservation/prepared-request identity。Reducer 只在整个 CAS batch 验证通过后更新 rolling state；
任何孤儿 terminal、孤儿 continuation、重复不同正文、reservation/lease mismatch 都拒绝整批。

manual terminal 不创建 normal continuation，只收敛命令；auto terminal 必须有 continuation。v23→v24 migration
把所有 checkpoint-v1（含 legacy-v2 降级结果）标为 `legacy_unverified`，不伪造 V3 proof。新 flag 关闭时仍可读取
V3 和 legacy 手动投影，但不运行 auto orchestrator；schema v24 后所有成功 manual writer 仍只产生 V3，v1/v2
完全只读。开启后 legacy checkpoint 对 Working Set 返回 unavailable。V3 restore 从 transcript/event cut 重算，
不依赖最多 128 条的历史 checkpoint chain。

V3 cut 不保存 SQLite/Store 物理 position。fork 时在目标事务写 `context.checkpoint_v3_rebound_v1`，保存 parent
checkpoint identity、fork-local `sourceProducingEventCutV1`、重算 `sourceRangeDigest` 与 generation；验证失败则
child 退回 raw。未终结 attempt/continuation 与 resource reservation 必须执行上面的 fork abandon/rebind matrix，
不能套用普通 auto unknown terminal。rewind 按目标 cut 恢复并重算，不借用父分支未来事实。

### Projection writer 所有权

- `MicroCandidateBoundaryV1` 仅存在于 prepare artifact；成功 primary terminal batch 才推进现有 bounded
  Micro/Reclaim commit；
- V3 activation 是 checkpoint writer，必须清除现有 Micro commit/receipt，并把
  `projectionBaseIdentity` 切换为 `checkpoint:<checkpointId>:<sourceRangeDigest>`；
- checkpoint reset 清除 Micro commit 并创建绑定 reset event cut 的新 raw base identity；
- Working Set 不写 boundary；summary source/candidate、failed primary 和 recent window/tail 不推进 Micro commit；
- rewind/fork 从目标 cut 重建 checkpoint/base identity，并依赖 Store generation fence 拒绝旧 writer。

## 可选 Session Memory 扩展点

未来可以把 prefix 获取抽象为：

```typescript
type CompactPrefix = VerifiedContextCheckpointV3 | SessionMemory;

interface CompactPrefixProvider {
  getVerifiedPrefix(input: CompactPrefixRequest): CompactPrefix | 'unavailable';
}
```

本 RFC 的首版 provider 只返回 `VerifiedContextCheckpointV3`。Session Memory 不在本 RFC 的 Task、Gate、schema 或发布声明中；
若未来实施，必须另立 accepted ADR/计划，证明 lifecycle、source coverage、低权限、隐私、恢复和 continuation，且
其 unavailable/invalid 只回退 checkpoint/raw，不阻断主链。

## 交付与资格

当前计划只分四个实施切片：

1. MicroCompact policy、ephemeral candidate 与 primary-used commit；
2. schema v24、Verified V3、Checkpoint Working Set、recent window 与恢复；
3. 单一 orchestrator、SummaryCompact durable continuation 和最终 admission；
4. 故障/replay/性能/语义 Gate、current docs 与完成记录。

每个切片完成后进行整体 review，不逐文件反复停审。计划在 RFC 独立评审为 GO 前保持 draft；代码实现开始后
才可把计划切到 active。Session Memory 不参与这四个切片。

## 冻结参数

- Micro policy v1：只允许当前三种 verified read-only 工具；至少早于 active turn 两个 settled turn；至少选择
  2 个完整 block，同时节省 `≥1024 tokens` 且 `≥raw transcript tokens 的 5%`。V1 不开放模型/工具可写 pin；
  current turn、recent window/tail、pending interaction/verification 和 Core must-keep 类天然受保护。
- recent policy v1：`2048 min tokens / 4 text messages / 8192 max tokens`，并按已知 available input 的 25%
  收紧 max；超大原子 block 整体保留。
- auto policy v1：只在已知 window 的 `compact_due=90%` 尝试；任何真正到达 resource dispatch-started 的
  manual/auto summary attempt 后冷却 3 个成功 primary turn，同 source continuation 永不二次尝试。local estimate
  不阻断 primary。
- summary policy v1：沿用单叙事 `maxOutputTokens=6000`、至少 1024 token 绝对收益；附件/图片在 summary source
  中只保留由现有 Tool Result Budget 产生的 bounded metadata marker，不做正文重新注入。项目指令、Skill、工具
  schema 和 current Runtime authority 不交给摘要恢复，normal fresh prepare 会按当前环境重新注入。
- schema/event/batch：以本 RFC 的 v24/V3/continuation/双 writer 合同为准。

结构 Gate 使用 exhaustive property/fault matrix；语义与 continuation Gate 使用至少 20 条长会话 fixture，每条
覆盖目标、约束、决定、失败、验证结论、未完成事项和压缩后继续执行，要求 mandatory field retention 100%、
continuation task success ≥95%，并与不压缩基线比较不得下降超过 2 个百分点。性能继续使用 2000-block/8MiB
fixture，新增 Working Set prepare p95≤75ms、restore proof p95≤100ms、增量 peak RSS≤96MiB。独立评审未 GO 前，
不开始 PSMC-03 实现；当前独立评审已 GO，后续按活动计划从 PSMC-03 开始，并继续受各 Task 依赖与 Gate 约束。
