# Runtime 韧性与 bounded soak 资格门禁

状态：active

读取时机：修改 Runtime 持久化/恢复、persistent command receipt、Protocol/Server/Client carrier/reconnect、模型或 MCP 故障处理、Sub-agent 取消清理、TUI 长生命周期测试，或生成 release fault/soak evidence 时。

验证：`bun run test:runtime:fault`、`bun run test:runtime:soak`、`bun test packages/runtime-host/test/persistent-command-crash-windows.test.ts packages/runtime-storage-sqlite/test/store-conformance.test.ts apps/kite-service/test/isolated/runtime-command-restart.test.ts apps/kite-service/test/isolated/runtime-server-multi-client.test.ts apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts apps/kite-service/test/isolated/runtime-transport-conformance.test.ts apps/kite-service/test/isolated/development-websocket-runtime-client.test.ts`、`bun test apps/kite-service/test/model-invocation-gateway.test.ts apps/kite-service/test/model-invocation-recovery.test.ts tests/integration/execution/workspace-filesystem-provider.test.ts apps/kite-service/test/isolated/execution/sandbox-execution-provider.test.ts apps/kite-service/test/isolated/execution/posix-supervisor.test.ts apps/kite-service/test/runtime/store.test.ts tests/integration/mcp-manager.test.ts`、`bun test apps/kite-service/test/subagent-artifacts.test.ts apps/kite-service/test/subagent-provider.test.ts apps/kite-service/test/isolated/runtime/agent.integration.test.ts tests/integration/runtime/event-codec.test.ts apps/kite-service/test/runtime/kernel.test.ts`、`bun run test:tui:system`、`bun run typecheck`。

相关：`six-concept-runtime-architecture.md`、`failure-classification.md`、`cancel-resume-cleanup.md`、`../../apps/kite-cli/docs/tui-system-testing.md`、ADR-0115、ADR-0116、ADR-0164、ADR-0165、ADR-0166、Task 1C.7。

## KASD-01局部资格

KASD-01 Store前置已取得局部资格：两个真实Bun进程可在同一空`kite-session.sqlite`上并发首次open并收敛到唯一exact epoch；同Workspace两个
真实进程可分别写不同Session，争用同一Session只有一个generation writer。旧epoch、partial与corrupt target均fail closed为
`store_upgrade_required`，现有`kite.sqlite`保持不变。全部Session write port进入统一mutation scope；并发open的深验固定单一read snapshot；
fork source fence、target generation 1与全部target事实同事务并覆盖后段fault rollback。

effect matrix证明prepare/dispatch/renew、State receipt settle、late terminal与unknown generation binding。真实SIGKILL fixture在prepared effect后杀死
owner；successor等待lease失效只能得到durable `recovery_required`，显式reconciliation把遗留effect改为unknown并与cleanup confirmation同事务，
随后才可取得更高generation，不能自动重放。该证据仍不覆盖KASD-02 App Server的Provider/child cancellation、stdio EOF/signal、完整response-loss
Host恢复或TUI lifecycle，因此不是release qualification。验证：`bun test packages/runtime-storage-sqlite/test/kite-session-runtime-file.test.ts packages/runtime-storage-sqlite/test/kite-session-execution-authority.test.ts packages/runtime-storage-sqlite/test/kite-session-mutation.test.ts packages/runtime-storage-sqlite/test/kite-session-effects.test.ts packages/runtime-storage-sqlite/test/kite-session-runtime-storage.test.ts`。

global config局部资格以真实process证明同一文件互斥、不同文件无global lock、两个TUI并发保留不同preference字段，以及TUI与模拟App Server并发
保留preference/provider字段。Workspace Trust不再按5秒mtime抢锁；MCP与provider/model在锁内重读revision。该证据不替代Windows owner ACL或完整
App Server lifecycle qualification。验证：`bun test packages/kite-local-runtime/test/config-file-mutation-lock.test.ts apps/kite-cli/test/preferences-concurrency.test.ts apps/kite-service/test/isolated/config-multi-process.test.ts`。

KASD-02真实process局部资格覆盖：stdio initialize/list/History/App Control只写protocol stdout且不创建global endpoint；History/App Control在
initialize前拒绝，未组合owner时fail closed，组合owner后可从同一SQLite read snapshot加载已创建Session的完整closed transcript；active model收到parent EOF后cancel并在
cleanup confirmed时释放generation；active model dispatch后SIGKILL会在短lease失效后阻断successor，显式reconciliation后resume只消费durable
attempt事实，mock Provider请求保持一次；第二App Server的list/get/checkpoint与退出不取得或取消第一Server的active Session。同build typed
client还验证exact server version/capability并在mismatch时关闭连接。该证据尚不替代Shell/MCP child crash、provider credential、
source/candidate resolver配对或三平台qualification。验证：
`bun test apps/kite-service/test/isolated/app-server-process.test.ts apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts`。

## 两级运行契约

## Runtime Server V1 恢复与 transport 资格

Host 仍是唯一 mailbox/lifecycle/recovery/receipt owner。一个 applied Runtime command 的 State/event/snapshot/revision decision 与 scoped Store 6 receipt 是同一 transaction。必测 crash windows 为：commit 前没有任何 applied 事实；commit 后、response 前，以相同 scope/session 加 command ID retry 返回原 committed fact；restart/recovery 后，该 retry 是 idempotent replay，绝不再次 prepare 或 dispatch external effect。同 scope/key 而 command digest 改变必须 fail closed。receipt 不是 transport cache：parse、codec、admission、overload 和 transport failure 不创建 receipt；close/delete 保留 receipt；fork 不复制 source receipt；retention 不设 TTL/capacity pruning。

Agent API context是纯Worker内存admission事实，不是receipt或Session lifecycle。contract incompatibility、Workspace
untrusted/unavailable与context overload在认证前拒绝且不消费capability；一旦one-shot capability已认证并消费，后续private read connection
初始化失败也不恢复或重放该secret，Client必须重新mint。context TTL、logout、generation supersede、Native connection close或Worker restart只释放
HTTP admission并关闭其private read logical connection，不取消Run/Session、不触发recovery、不写Store。每次read request重验Trust；Trust撤销会
撤销context，Trust暂时不可用返回503。History cursor把first-page through sequence与boundary event digest固定；boundary被rewind/delete替换时409
invalidated，不把新History拼到旧watermark。response loss后Client必须重新mint/exchange，不从descriptor或旧token恢复。
每context最多16个in-flight request；第17个返回retryable 429。logout、Trust撤销、generation fence、drain与replacement先阻止新admission，
等待已认证read（包括pending Trust重验）收敛后关闭一次private connection；迟到admission复核closed/revoked事实并返回503/401，不能进入owner。
History response达到1 MiB encoded上限时以last public ordinal提前分页，不能用oversize 503丢弃已安全投影的前缀。KASAPI-02D reference client
覆盖Worker close/replacement、capability replay、body/response limit及non-disclosure；当前Web static/auth surface随single-Service restart
重建，由同listener carrier与真实child suite证明且不代理`/v1`。

KRSRUN-01B已关闭unpublished Store 8 Host transaction与private transport Gate：start atomically提交State/event/snapshot、queued Run和
digest-bound original resource receipt；Run/receipt任一fault完整rollback。activation、waiting/running与terminal/cancel由deterministic
commit clock推进，Store writer拒绝同Session第二个active Run。response loss/restart retry从persistent lookup直接返回同一original
queued resource，且不调用recovery/inspect/prepare/activation/schedule；different digest仍fail closed。Private Client/Server只允许最多200项
Run keyset page，SQLite query plan命中专用index且不扫event journal。

KRSRUN-02A focused matrix现已证明unpublished Store 8 owner上的delete FK cascade/retained receipt、rewind partial-boundary refusal与fault
rollback、fork settled-terminal copy/origin/coverage/no-source-receipt、reopen及cross-Workspace binding isolation。Host GET/list在resume前只做
`unknown/recovery_required`投影且不recover，resume只运行一次existing recovery；unknown refinement保留原finish clock，既有recovery suite继续
证明不重复external dispatch。late retry与current Run missing是两个独立事实，retained receipt revision可高于rewound Session head。

KRSRUN-02B focused matrix已证明Store 7→Store 8 whole-generation copy、per-Session coverage、不回填历史Run、Catalog完整fact copy、
安全WAL隔离snapshot、source immutability、active/corrupt/unowned/partial/Catalog/copy fault整体阻断，以及pointer/journal/fence与旧Store 7
writer fence。迁移会用authority owner codec校验Controller/recovery/effect/resource与recovery identity，拒绝活动、损坏或无归属记录，并验证
合法记录只把LayoutGeneration重绑到target；Store 8 writer在journal `committed`前仍fail closed。manager orchestration只有在exact完整
maintenance barrier后才建立source-bound fence；Catalog存在`in_progress`operation或未登记Worker scope时不创建target。

KRSRUN-03A focused与Service owner suite已证明production Worker只打开committed Store 8、reopen仍保留Controller/read/Run façade、fresh layout与
new Workspace直接物化Store 8、Catalog first-write fence、idle History source不变、Store 7 active profile无fallback，以及private `list_runs`
不再返回unsupported。Service 1525、SQLite 90、Runtime fault 36与CI soak 7/7通过；本机dirty-source macOS arm64 candidate完成
build/verify/install/upgrade/rollback/uninstall smoke。Public Run route/ServerInfo capability继续关闭，GitHub-hosted三平台candidate evidence仍不能由本机结果替代。

KRSRUN-03B focused evidence增加formal maintenance CLI parser/blocked exit、Coordinator v2 authenticated stop/draining、manager exact-exit确认、
empty process-chain Store 7→8 end-to-end command、持锁后Coordinator absence复核及State convergence negatives。正式入口不接收caller-supplied zero barrier；Gateway/Worker
state残留、busy activity、PID/start-token/control uncertainty、unknown external effect或source deep-validation失败均保持blocked。当前本机结果仍只
是macOS arm64 local evidence。Runtime fault 36、CI-profile soak 7/7（digest
`sha256:c91a603e5ef88a4c5552e2bb8c14972c78d955741e83a18aa2dfc5663ac7fcd6`）、release 211、最终focused 38及
candidate `af43f919f756c276fb945834`已通过；完整边界见
[03B本地证据](../space/understanding/2026-08-30-kite-runtime-run-store-v1-local-evidence.md)。GitHub-hosted
macOS/Linux/Windows command/candidate结果未登记前，三平台qualification继续pending。

两个 outer Client 可以订阅同一 Host/Server instance、retry 一个 command、race 一个 revision 或 settle 一个 interaction。FIFO mailbox 和 revision/interaction identity 决定 domain outcome：恰好一个 admissible mutation 被 applied；相同 retry 被 replay；不同或 stale 的并发 mutation conflict 或 reject；Server 与 Client 绝不增加第二个 domain waiter 或 decision cache。slow subscription、carrier close 或 reconnect 只释放所属 connection/subscription，不取消 live Runtime work。
TUI普通prompt的client-local FIFO必须等待当前或恢复中的远端active work到达Host cleanup idle，再逐条取得reservation；
远端active但本地没有run Promise不能被当作idle，reservation拒绝或command失败也不能静默清空消息。terminal先于idle projection时，
每轮remote-idle waiter必须绑定该轮completion callback；前轮waiter的迟到finally不能遮蔽后继轮terminal/query或其presentation flush。
只有applied receipt后才能登记current accepted completion；每轮2秒后、至多每2秒一次的bounded query fallback只在projection满足
current revision floor且权威idle时收敛它，使terminal/idle notification gap不依赖下一条subscription event。
Ink flush是非权威展示屏障，正常等待真实commit但最多1秒；迟到/失败不能停止subscription消费answer/terminal，也不能阻塞后继prompt。
模型terminal可以省略optional summary；qualification必须覆盖无换行ordinary delta由request-scoped cumulative buffer收口，不能丢失尾段。
run promise只接受跨过current command floor且匹配canonical receipt `runId`的`run.terminal|run.failure`；`turn.terminal`、`task.terminal`
与previous Run的迟到终态不能结束successor。

Native TUI interaction不能fire-and-forget：approval、input、plan及其Enter/Esc都必须等待`respond_interaction` receipt，
失败时保留可见interaction与可重试identity，且不得把失败提交加入永久local dedupe。Protocol qualification必须证明approval的bounded command在live
notification与response command两向codec中一致；History可见而live subscription丢失同一interaction属于hard failure。
gap/reset snapshot还必须携带完整、同revision的interaction queue替换集：无interaction的active snapshot清旧focus，
新queue删除旧entry并保留仍pending的并发sibling，idle snapshot清除残留Map。相同notification经JSON/WebSocket与
InProcess logical-message必须得到同一Client state；共享对象引用不能被误判为cycle或静默关闭subscription。Service
启动/index hydration从纯持久State生成该完整queue，不得提交伪空替换集。pending interaction的公开`sessionRevision`
随当前CAS前进，稳定kind-specific identity不变；Host inspect接受后结算CAS固定，inspect→commit间revision前进必须失败，
旧generation/digest或被修改的input/command字段仍拒绝。activeTurn/queue同ID但完整身份漂移也拒绝。双Client相同response
只有一个applied，另一个只可idempotent replay。真实process-death资格还必须覆盖pending approval从Store恢复、response receipt、
原Turn continuation与Tool一次dispatch；进程内broker/waiter不能作为恢复证据。batch中每个notification必须携带自身revision的
exact post-event queue，无法读取时unavailable而不是空queue。

Local Service contract要求descriptor/lock/token/lifecycle/credential exact，connection不携带control token，mutation不自动
重放。当前唯一production composition位于`apps/kite-service`：它在同一process拥有真实Host、State 27 / Store 6、Builtin、
History与App Control；CLI/TUI只消费Native client且没有embedded fallback或第二default Store。focused local tests覆盖
多connection/Workspace、persisted restart、Trust、History、App Control、operation gate、disconnect后Runtime继续、20-way
ensure、dead-only stale/orphan lock、busy/unknown stop、ticket TTL/replay与frame/queue limits。

manager identity probe先执行`GET /readyz` liveness，再以`Kite-Local-Access`、exact`{}`body调用
`POST /_kite/instance`。response的content type、4 KiB上限、closed keys及
`{schema, instanceId, protocolVersion, clientContractRevision, serverVersion, buildId}`全部strict verify。malformed、server
identity drift、PID reuse或无关listener返回`unavailable/identity_uncertain`。single-Service只读Native `describe`允许兼容客户端跨
expected build复用Service真实descriptor/access；Protocol/client-contract不兼容仍fail closed，跨build `service stop/restart`返回
`incompatible/build_mismatch`。source TUI默认standalone并删除previous-build stop路径；qualification验证invocation endpoint、临时Runtime Home
隔离与退出cleanup，普通source restart与source↔installed仍保持`spawn=0`。installed qualification还用门控Provider证明真实TUI Turn active期间换代返回`service_busy`并保持old build/instance，
terminal后第二次ensure才替换且兼容旧TUI可reconnect。这些结果不能从caller build或descriptor合成健康身份。restart后
descriptor/access与client generation重建；旧Session readiness/ephemeral stream清空，mutation lost response不自动重放。
source↔installed双向矩阵均已覆盖：任一方向只要actual/expected mode不同就返回`incompatible/build_mismatch`，且stop=0、spawn=0；
不能只验证source client面对installed owner而遗漏installed client面对source owner。
同一journey还覆盖两个旧TUI并发连接：一个Turn active时另一个仍可query，manager收到busy后第二个TUI可创建Session证明admission已resume；
同一active Turn上的连续外部ensure都稳定返回busy且不遗留quiesce lease；换代后两者都显式reconnect。后续candidate面对approval waiting
interaction仍返回busy，取消并terminal后才允许再次换代。
同一V2→V3真实endpoint journey在V2接受`service_stop`并返回`applied`后由测试transport丢弃响应；manager只观察exact
reservation/PID/start/instance absence，previous-build stop请求在丢失后保持0次重发，随后启动V3且两个旧TUI以新generation重连。
对称模拟响应丢失但old PID/start/reservation仍alive时，manager返回`outcome_unknown/identity_uncertain`并保持old owner，单次ensure内
previous-build stop仍只发送一次且`spawn=0`；只有confirmed absence才能把同一不确定响应收敛为成功。
两个独立active-candidate manager并发V1→V2时各自最多发送一次authenticated previous-build stop；Service shell将并发请求合并为一个
quiesce/commit/cleanup flight。两边随后都可尝试spawn，但native reservation只允许一个instance ready，loser观察同一winner并返回applied。
并发busy control requests同样共享一个quiesce结果；control flight进行中到达的ordinary stop或signal加入同一barrier。busy settlement释放flight，
active work结束后的下一次stop创建新flight并完成唯一cleanup，不存在残留busy Promise吞掉retry或重复owner disposal。
deterministic Application race另证明：Session work刚terminal但interaction settlement mutation仍在gate临界区时，quiesce继续报告busy；
resume后settlement完成，下一次quiesce才允许drain。因此Host active事实与mutation gate任一方都不能单独冒充全局idle。
模拟current candidate首次`waitForReady`失败时，manager返回typed unavailable而不伪造ready；旧installed stop保持一次且不重放，ensure flight释放，
下一次ensure只重试current spawn并收敛唯一ready owner。若失败child已写入current lifecycle reservation，后续ensure只在PID/start identity确认dead
后清理该exact reservation，再spawn一次；不会清理不匹配证据或重放旧stop。该证据不承诺自动回滚已停止的旧Service。

Native TUI client的Ctrl+C路径会提交exact`cancel_turn`，在revision conflict时用新command ID与current revision有界重试；
TUI exit只关闭connection，不调用`abortAll()`或dispose Service Host。rewind client在intent receipt applied后等待
Service持久化`session.rewind_completed|failed`，再消费与原commandId绑定的exact `rewind.terminal` safe projection；
conversation rewind使用Service返回的target Session加载safe History，file outcome只含bounded path/error/conflict投影，
不从source、checkpoint或显示文本推断target，也不重放mutation。完整TUI PTY、本地fault/CI-profile soak与本机
release smoke已经执行并通过；这些仍不能推导formal资源资格或三平台通过。KLSV1-07的macOS/Ubuntu/Windows process/
release matrix及正式hosted qualification仍pending。Windows state primitive现以current-user SID、protected
owner-only DACL与non-reparse验证fail closed；其owner负向测试已接入Windows candidate job，但必须等待当前实现head
的远端结果，不能用POSIX或本机测试替代。

当前local evidence为manager 37/135、carrier 23/129、Service shell 23/97、Runtime transport 3/852、Runtime fault
36/106、CI-profile soak 7/7 cases、Service owner 1365 parallel tests / 6795 expects加34个isolated files、CLI owner
757 tests，以及完整40个isolated TUI PTY scenario files。13-workspace typecheck/build、docs/static Gate与macOS arm64
candidate build/verify/smoke也通过；smoke结束后无残留Service进程。该结果不升级任何上述pending三平台或formal
qualification结论，CI-profile soak按设计`qualificationMetricsSupported=false`。

本地 implementation evidence 覆盖 in-process、stdio 与 development loopback WebSocket path：bounded stdio JSONL 与 protocol-only stdout；queued 与 in-flight send 共同计入 connection/global byte ceiling 的 outbound/backpressure；malformed/oversized frame rejection；generation 切换清空旧 Session readiness/projection、cursor 超前时 authoritative reset、stale-generation rejection 和 atomic Session-index reset 的 reconnect/resubscribe；WebSocket bootstrap auth、Host/Origin checks、heartbeat 与对 restarted carrier 的 reconnect；以及 bounded sequential ping soak。这些只是 local/conformance evidence，不构成 production Web support claim。development-only WebSocket carrier 不改变 ADR-0053。

本 tranche 的 implementation head `f3646fec1d99db053304dfc013806caf0e3d8272` 已形成三平台 PR CI evidence：
[Required run 32978173084](https://github.com/ferqx/kite-code/actions/runs/32978173084) 的 unit、quality、
runtime-e2e、runtime-fault-soak、compaction 与四个 TUI shard/aggregate 全部成功；非 protected branch 的
`protected-branch` job 按设计 skipped；[stdio run 32978173098](https://github.com/ferqx/kite-code/actions/runs/32978173098)
与 [transport run 32978173105](https://github.com/ferqx/kite-code/actions/runs/32978173105) 的 macOS、Linux、Windows
matrix 全部成功；[Platform run 32978173074](https://github.com/ferqx/kite-code/actions/runs/32978173074) 与
[OSS RC run 32978173210](https://github.com/ferqx/kite-code/actions/runs/32978173210) 也全部成功。该 evidence 绑定
[PR #65](https://github.com/ferqx/kite-code/pull/65) 的被审查实现 head，只证明本 tranche 的 native
implementation/carrier conformance；它不构成下文 formal release qualification、production Web support 或 Web 准入。

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

任何会把 Tool 推入 `succeeded|failed|rejected|cancelled|exhausted` 的 durable batch，都必须同时闭合同一 Tool 下的
全部 `recorded|running` capability invocation，而不只处理第一个带 receipt 的 running invocation。已有可信 Artifact
时提交对应 success/failure receipt；无法确认时先提交 `capability.execution_unknown`，用户放弃 reconciliation 时提交
`capability.reconciliation_resolved(waived)`。`auto_review.completed` 的明确拒绝与 `approval.rejected` 虽不是
`tool.*` 事件，但会间接产生 Tool 终态，因而受同一原子屏障约束；技术性自动审查失败转人工时不得终结父 Tool。

跨进程 Session admission 必须在 TUI replay 前执行同一恢复纪律：Host 通用 restart facts 提交后，App 立即完成
Subagent Provider handle 与 sandbox preparation cleanup，随后按 dispatch certainty 收敛非可恢复 Tool；TUI 只有在
readiness 完成并重新读取 Store head 后才能切换与渲染。具备 exact durable approval/continuation 的 suspension 保留，
其他 running Tool/Subagent/model stream 不得在重开后继续显示为 live，也不得因展示收敛触发 Provider 重放。

PS-01 已让 Subagent 内部 filesystem tool 由 parent Runtime 建立 namespaced queue，并递归执行同一完整
Tool Pipeline；PS-03 又把 child lifecycle/observation 接到唯一 `SubagentProvider`/Local composition。启动顺序
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
秒级 `ps lstart`，identity mismatch 时不得 signal 可能复用的 PID/PGID。control socket 位于独立 private
base 下的 host-only control root，sandbox 只获得另一 private base 下的 data root；macOS Seatbelt 拒绝整个
control base，Linux Full 也用只读空 tmpfs 覆盖整个 control base，因而当前及并发 invocation 的 Host-control
identity 都不可见。首个合法连接后立即停止 listen。release executable 内嵌同一
supervisor mode，supervisor 只继承显式最小环境，output pipe EOF 使用固定 deadline，超时 abort 且
`cleanupConfirmed=false`。Darwin Seatbelt 的实际 detached/session negative conformance 位于
`apps/kite-service/test/isolated/execution/posix-supervisor.test.ts`；恢复路径即使成功终止 PGID，也必须把
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

seed 只决定每轮 case 的旋转顺序；不能减少固定 case 集，也不得传入 Bun test 改写 test scheduler。每个 probe 只允许一次 runner invocation；测试型 probe 由 coordinator 把各功能文件放入隔离 child 且各运行一次，避免共享 Yoga/全局 fixture。Qualification 只对 manifest 中每个 case 明确选定的真实代表 lifecycle 文件保留 1 次 warm-up 和 8 次 measured rerun；dedicated long-replay 还先执行 2 次不进入报告的 allocator/JIT prewarm，其他 lifecycle 不增加该步骤。不能重放整个大型功能 suite 后把 Bun test runner 自身保留的断言/fixture 内存归因于产品泄漏。测试 helper 在每个测试边界必须清除它自己创建的临时根；依赖进程退出或整个重复文件结束的清理不构成 lifecycle cleanup。long-runtime 当前以 deterministic state replay 和测试专用 `runTestRuntimeAgent` 对 production `executeRuntimeTurn` 的真实 budget workload 为资源 lifecycle；该 helper 只组合 Runtime State/SQLite Store test port，不是 production fallback；其他 case 分别选择 cancel/recovery、deadline、MCP supervisor、SIGKILL/SQLite fault lifecycle。超时后必须终止整个子进程树。Unix probe 使用独立 process group；fault-soak 内的 TUI per-file 与 lifecycle child 必须继承该 group，不能再创建 `ps` 缺失时无法发现的 nested detached group。runner 同时以 parent/PGID 双重采样 owned PID；每条 telemetry 还必须匹配 attempt nonce、PID、OS process-start identity、lifecycle ID 和 group nonce。报告必须精确收到 manifest 声明的全部 qualification lifecycle group；短命 child 即使错过 50 ms 采样，也只能凭有效 nonce 绑定补入 owned PID 集，任一声明组缺失、重复或未绑定均使 qualification `inconclusive`；同一 probe 中仅运行一次的功能文件 telemetry 不进入 qualification series。正常退出后发现的后代同样先记录为 orphan；runner 必须重新读取并匹配 OS process-start identity 后才可将 PID 计为 orphan 或强制清理，数值 PID 已被复用时不得触碰新进程，身份无法确认则 inspection unsupported。`ps`/`git worktree` 因平台缺失或权限策略无法启动、抛错或非零退出时必须转为 inspection unsupported，使 qualification 结构化 `inconclusive`，不能在报告前崩溃。stdout/stderr 在进程退出后最多等待 2 秒 EOF，持有继承 pipe 的漏杀后代不能让 runner 永久挂起。外层 probe 超时时对已经采样的 PID 先绑定 process-start identity，kill 前再次核验；可发现的 nested detached group 先按 PPID/PGID 快照并由深到浅终止，最后终止 coordinator group，不能先杀 coordinator 导致后代 reparent 后失去 ownership。runner 为每个 attempt 分配独立临时目录，并把普通临时残留记录为 `residualPaths`；`orphanWorktrees` 只来自 probe 前后 `git worktree list --porcelain` 的 registry 差集。任一残留、orphan worktree 或 orphan PID 都是 hard failure。

## 报告与资源判定

报告 schema 当前为 v2，并包含 runner revision、seed、profile、平台/Bun 版本、逐 attempt 的状态/清理/resource series、每个 case 的 p50/p95/p99、状态不变量、资源摘要和 SHA-256 canonical digest。CI 报告可记录 `source.kind=local`；qualification 只有在 `source.kind=github_actions` 且 repository、40 位 head SHA、完整 ref、workflow 文件名、GitHub `workflow_ref`/`workflow_sha`、run ID 和正整数 run attempt 全部存在时才可能为 `passed`，缺失时必须为 `inconclusive`。这些字段和 retained attempt evidence 都进入 canonical digest，不能靠 artifact 页面上的旁证补写。digest 是完整性字段，不是单独的真实性证明；真实性根是成功的 GitHub Actions run、由可信 GitHub context 提供的 expected identity 以及被审查 head。`runnerBudgetUsage` 只表示外层 probe invocation 与 wall-clock 上限；`runtimeBudgetUsage` 仅来自 long-runtime case 中 `runTestRuntimeAgent → executeRuntimeTurn` workload 的 actual reconciled/committed `ResourceBudget` ledger receipt，reducer-only 合成状态不得作为该证据，二者也不得混写。Qualification 的每个 long-runtime attempt 必须保留 9 条 receipt provenance；每条 receipt 还必须与同一条 process resource lifecycle 在 case、iteration、lifecycle、PID、sequence、attempt nonce、OS process-start identity 和 group nonce 上完全匹配，错轮或未绑定的 receipt 一律使该证据 unsupported。

正式 workflow 在上传前运行 `scripts/runtime/verify-fault-soak-qualification.ts`。verifier 以 workflow 的可信 GitHub context 重新匹配 source identity、重算 report digest，再从 retained attempts 重新构建 case/aggregate 摘要；它要求 Linux x64/Bun 1.4.0、固定 7 case、每 case 8/8 通过、合计 56/56 probe、精确 wall time、完整 terminal/state assertion、零 orphan/residual、long-runtime 每项资源 128 个 measured 样本、其他 case 每项 64 个样本、全部资源不超阈值，以及 long-runtime 分 8 个 attempt 的 72 条带 provenance Runtime ledger receipt。runner 或 verifier 任一失败都使 workflow 失败；artifact 即使被保留也只是诊断材料，不能登记为通过证据。

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
strict mismatch 与 no-fallback contract。production缺省仍使用加密随机identity与系统时钟；默认Workspace Worker writer精确为
State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29`，显式legacy Service maintenance仍为State 27 / Store 6 /
`kite-runtime-server-v1-2026-08-26`，Store 7只作offline migration source。State 26 / Store 5 / `kite-runtime-modularization-v1-2026-08-19`
与State 27 / Store 5 / `kite-runtime-saq-v1-2026-08-25`都只属于explicit readonly historical source profile，不能进入当前Worker执行路径。

RM-04 production Store 由 Service 组合根创建一个 `SqliteRuntimeStorageAdapter` 并注入 Runtime Host；
旧 SQLite Store production export/caller 已删除，Kernel 只通过 Host storage port 取得非-owning Runtime State type view。CLI、TUI、Kernel 与
App adapter 不得直接创建 SQLite 连接。adapter 的四类 transaction method 都映射到一次既有
SQLite Store event+snapshot+provenance 与 applied scoped command receipt 原子提交，没有 retry/fallback/双写或 sidecar receipt writer。每个底层连接在设置 journal mode 或执行 schema
写入前先安装 5000 ms `busy_timeout`，因此 journal/schema/事件写竞争都受同一有界等待约束。SQLite writer
lock 释放后只允许一次成功提交；不能因为重试重复事件。

RM-05 的 deterministic Host contract 额外验证 same-session FIFO、cross-session concurrency、bridge 前
revision conflict、Host 生命周期内 scoped idempotency、committed Query、history-gap snapshot、stale
ephemeral drop、slow subscriber 断开，以及 subscriber close 不取消 Runtime work。TUI PTY 继续验证真实
production bootstrap。未知 Store/profile 在只读发现阶段静默忽略，不能让 Host 组合阶段阻止 TUI 挂载或当前 Store 写入；
明确支持的历史 profile 只在用户选中 exact session 后原子导入。会话发现对每个候选 journal 使用有界 batch，并在首个
session-name candidate 后停止；具体会话仍执行全量 checksum/sequence/identity 校验，失败只隔离该 session。
current target 的格式判定复用 current Store preflight；合法的 `WAL present / SHM absent` 恢复形态必须在隔离副本中重建
SHM 后继续打开，不能误报为未知 target 或让 exact session import 静默失效。marker、表/索引或 WAL 真正损坏仍 fail closed。
历史 source 只要存在 WAL 或 SHM sidecar 就必须通过 no-follow 隔离副本读取；不得让只读 SQLite 连接接触并更新真实 SHM
共享索引。WAL/无 SHM 形态只在副本中重建，source database/WAL/SHM 的 identity、mtime 与字节保持不变。
CLI explicit resume 在 `create_session` 前完成该边界，失败不得创建同 ID 空会话。State 26 file preimage 不导入；current-format
named snapshot/preimage 还必须满足 head 上界、Workspace containment 和无 traversal，否则只隔离 exact session。
State 26 的旧 Project ID 只有在 source session row 与 decoded State identity 完全一致、Workspace 为当前仍存在的绝对路径，
且用 Runtime Host `resolveProjectIdentity()`（也是 Coordinator admission 的唯一 Project digest owner）重算出的 digest
与持久 evidence 相等时，才可静默映射为确定性的当前
`project_<digest>` identity；named snapshot 必须通过同一映射。相对路径、已删除 Workspace、digest drift、row/state
mismatch 或当前 State 27 identity 都不得被兼容器猜测重写。旧 source 继续 byte-for-byte 不变，无法证明 identity 的失败只
隔离所选 session。对应正反、symlink 与 removed-workspace 证据位于
`apps/kite-service/test/state-store-project-identity-compatibility.test.ts`。

Store-only Session可能在subscriber先注册后才由query加载；qualification要求query projection经NotificationProjector唤醒该pending
subscriber且仍保持Store read non-mutating。TUI shutdown另以权威projection区分idle release与active/pending/unknown detach；重启后已完成
Session必须可重新取得Controller，未完成Turn不得被clean exit误释放。

RM-06 已把 root AbortController、same-session cleanup barrier、durable-before-signal、四类 storage transaction
acknowledgement、effect lease claim/renew/release 与 restart recovery 切到 Host。Host contract 和 Runtime fault
suite 证明 attempt ack 失败为零 dispatch、stale/renew-lost lease 不能 dispatch/commit、lease loss 中止 lifecycle、
cancel 在 signal 前提交、successor 等待 cleanup、dispose 等待 drain，以及 recovery 在首次 execution 前恰好一次且
失败关闭。`bun run test:runtime:soak` 仍只是 7-case CI profile smoke；它可以形成 RM-06 stage evidence，但不能
升级为正式 release qualification。当前单-Store lease 没有被解释为 cross-Host Project fence。

focused approval rejection 也必须穿过同一 durable terminal boundary。无未终结 sibling 时，一个 action transaction
按序提交 `approval.rejected`、`tool.rejected` 与 `turn.aborted(cause=user)`；存在 sibling 时先只终结 exact target，
等 sibling 自身收敛后由 scheduler `stop` 边界 exactly-once 追加 `turn.aborted`。恢复后重复进入 runner 不得再次追加
abort，也不得产生新的 `model.requested` 或重放已拒绝 invocation。fault/PTY cleanup 只有观察到该 terminal fact 才能
结束 fixture；仅看到输入提示符或本地 TUI idle 投影不构成持久化完成证据。

当前链路将 Runtime State input 经纯 `@kite-ai/agent-kernel` transition 后再由 SQLite Store 原子提交；进程内 State 只在
commit 成功后推进。Required Kernel/reducer 与 scheduling/completion suite 证明 snapshot/terminal/revision 行为
等价。Host applied receipt 后的
`AuthorizedEffect` 精确绑定 execution identity，App adapter 只允许单次消费和 exact match；mismatch、重复消费
或未 applied receipt 均不得 dispatch。crash/restore/fork 全部复用同一 SQLite Store authority transaction；正式
fault/soak qualification 仍由独立 workflow 绑定最终 SHA。

`RuntimeStoreOptions.faultInjectionMaxPageCount` 仅供测试把连接限制到确定性 page ceiling，从而触发 `SQLITE_FULL`。生产组合根不得设置它。失败写入必须完整回滚，重开后事件集合、Runtime state 和恢复状态仍满足不变量。

真实 MCP stdio server 在 tool invocation 中退出时，调用必须返回 typed `provider_unavailable`，provider 进入 `degraded`，并保留最后一次成功 catalog 供诊断；它不等于签发新 Binding 或自动重放调用。

模型 HTTP `429` 属于可重试的 rate-limit failure，但只允许消费统一的 bounded attempt/time budget；attempt budget 包含首次请求，time budget 从第一次可重试失败开始，首次请求在失败前的 wall time 不得提前耗尽重试窗口。长时间 in-flight 后发生 socket/网络错误时，只要 attempt budget 尚有余量就必须观察到第一次 retry。生产分类必须读取 AI SDK `APICallError.statusCode`（并兼容旧 adapter 的 `status`），预算耗尽必须抛出最后一次 429，并由 failure-mode policy 收敛为 `model_retry_exhausted`。本地 HTTP fixture 必须穿透 `createChatModel` 和 provider middleware 证明 429 后恢复；其他 4xx 仍不可重试。

专门验证下游统一取消信号的 wall-clock deadline fixture 必须给 provider 或 interaction 留出在繁忙
CI worker 上完成入场的调度余量，再断言 in-flight AbortSignal。若 deadline 在模型 dispatch 前
到期，这是另一条合法的 fail-closed 路径，不能用来否定取消传播，也不能与 in-flight 断言混为一谈。
验证“原子完成后慢 consumer 不得反向 abort”的 fixture 同样先保留该调度余量，再让 consumer 明确
跨过 deadline；不得使用会在 hosted runner 负载下先于 `run.completed` 到期的亚秒窗口制造竞态。
RA-06 current Runtime State/SQLite Store 是新会话的唯一 production writer；qualification 分别证明未知 source 被静默忽略，
已知历史 source 保持 byte-for-byte 不变，且选中的单个 session exactly-once 导入。current write API 仍拒绝历史 metadata；迁移
只能经过 ADR-0138 的 readonly-source/atomic-target boundary，并清除旧 authority/effect。corrupt Event/Snapshot、writer
mismatch、fork/rollback/delete inconsistency 只隔离受影响 session，且都必须在 dispatch 前 fail closed；健康会话与新会话
继续可用。内部 Runtime/Artifact key、authority ledger 与 key-loss Gate 已删除。
> 路径同步：runtime resilience 验证引用当前无版本命名的 state/store 实现路径；格式版本仍由 metadata 校验。
