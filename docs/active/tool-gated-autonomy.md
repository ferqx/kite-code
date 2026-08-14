# 当前规则：Capability 执行与工具自治边界

状态：active

读取时机：修改工具路由、Capability binding、Tool Controller、副作用分类、审批、authorization、sandbox、MCP/Skill/Subagent 执行或最终完成条件时。

验证：`bun test tests/runtime/actions.test.ts tests/runtime/tool-controller.test.ts tests/runtime/kernel.test.ts tests/runtime/resource-budget-admission.test.ts tests/runtime/concurrent-shell-cancel.test.ts tests/runtime/scheduler.test.ts tests/runtime/tool-outcome-recovery.test.ts tests/tool-policy.test.ts tests/tool-definitions.test.ts tests/policies/approval-policy.test.ts tests/policies/mode-policy.test.ts tests/policies/protected-path.test.ts tests/execution/gateway.test.ts tests/subagent-approval.test.ts tests/subagent-continuation-codec.test.ts tests/subagent-runner.test.ts tests/subagent-delegation-contract.test.ts tests/git-broker.test.ts tests/runtime/git-tool-controller.test.ts tests/runtime/verification.test.ts tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts tests/session-manager.test.ts tests/tui-tool-progress.test.ts tests/stream-output.test.ts`、`bun run typecheck`。

相关：`authorization.md`、`mcp-runtime-governance.md`、`verification-governance.md`、`cancel-resume-cleanup.md`、ADR-0007、ADR-0008、ADR-0042、ADR-0048、ADR-0049。

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

Development Shell 的文件系统能力是逐 invocation 的：默认 `workspace_only` 使用 native backend；
`externalRead`、`externalWrite` 与 `uncertainEffects` 审批通过后投影为 `allow_all`，并在命令启动前
扩大当前 native sandbox 的文件系统 scope。该选择不是 host fallback，用户命令只能执行一次。Auto
模式由自动审批模型先判断；模型判定风险或技术异常时才升级真人审批。危险路径和 destructive operation
必须在审批前终止；canonical file target 与 native protected guard/mount/profile 继续在扩权后执行固定
deny。网络客户端自身的 output/input 参数必须独立贡献 external filesystem effects；普通临时目录和
Workspace 外文件不是硬拒绝对象。sealed production admission 仍独立治理，development capability 不形成
qualification evidence。

Shell 的 read-only fast path 是 Planning、免审批执行、只读 Subagent 和并行 read batch 的共同授权边界，
不是展示性 hint。分类必须按每个程序的参数与操作数语义 fail closed：只有有限、已验证的只读 grammar
可以得到 `read_only + sideEffect=false`。能够写文件、修改 Git、启动外部程序或把运行时输入追加为 argv 的
模式不得进入该 grammar；例如 Git branch mutation/diff output、ripgrep preprocessor、sed write、find
file-output action、sort output、uniq output operand、`file` compile/uncompress 与 xargs 均属于非只读。CR/LF 多命令、process
substitution、command substitution、backtick 和可能把安全参数展开成危险 option 的变量 expansion 同样不得
走只读 fast path；未加引号的 brace expansion 也必须拒绝，避免它在静态检查后合成危险 option。`file`
的 `-p/--preserve-date` 会恢复被检查文件的 atime，属于元数据写，同样不得归为只读。Scheduler 只并行已经通过这条分类和 Approval Policy 二次确认的调用；误分类不能依赖
Workspace sandbox 兜底，因为 development 的 `workspace_only` capability 仍可能允许 Workspace 写入。
`rg -f/--file` 保持只读，但其 pattern 文件与搜索路径都是读取目标；任一目标位于 Workspace 外时必须进入
external-read 审批，不得因 option value 没有被当作普通操作数而漏报。`grep` pattern 文件、`file`
magic 文件与 `sort --random-source` 同样属于显式读取目标。`file -f/--files-from` 会从文件内容动态取得
更多路径，静态命令无法证明其完整读取范围，因此直接退出只读 fast path。
这条只读证明同时依赖 executor 的 sanitized environment。Registry 只为重新通过同一
classifier 的命令签发 Runtime-owned `policy_proven_read_only` 执行信任；模型参数、审批
payload 与其他 Shell 调用不能伪造。POSIX 路径使用固定非登录 `/bin/sh`，并在进程
启动前投影最小环境；Windows restricted-token 保留密封 runtime/Coreutils 前缀。两者都将
继承 PATH 的每个绝对目录先 canonicalize，再删除相对/空条目、Workspace 目录、其子目录
和指向这些 identity 的 symlink alias。因此 Workspace 中的同名 `ls`/`rg` 不能在静态分类后
替换真实 executable；没有可用的可信 PATH 时命令查找按失败收敛，不回退 Workspace。
该最小环境也不继承 `BASH_ENV`/`ENV`、凭据或其他未白名单变量；
`RIPGREP_CONFIG_PATH` 必须在沙箱 wrapper 中额外 unset，防止普通 `rg` 通过配置文件注入
`--pre` 子进程。显式 `rg --pre` 仍由参数 grammar 直接拒绝。需审批/副作用 Shell 不使用该信任投影，保持原有工具链 PATH 语义。
Generic Shell Git 整体不属于 policy-proven read-only：即使 argv 看似只读，repository/config 仍可能通过
diff/textconv、fsmonitor、external diff 或 filter helper 启动子进程。Git inspection 必须使用 Runtime
披露的 typed `git_inspect` broker；未披露时不能退回 Shell 的免审批/Planning fast path。

每个当前工具终态在持久化和发布前由 Kernel 写入唯一 canonical `ToolOutcomeV1`；current reducer
及其消费者不再从 legacy result 字段推导 outcome，并且只投影一个成对 ToolMessage。历史 replay
先通过独立 decoder 保守补齐缺失 outcome。Registry/ToolSpec 只能提供 metadata-only
result classifier，不能自报 dispatch、external effect 或 timing。Policy/approval deny 一律证明为
`not_started/none` 且不产生新调用；timeout、cancel 与 unknown external effect 禁止自动重放。
Runtime 自动 retry 只允许一次，并且仅限明确 pre-dispatch、受信 safe-read，或已有可信
idempotency receipt 的调用。配置或参数中的 idempotency key 本身不是 receipt，不能授权 replay；
`correct_args` 只允许下一次模型响应提出一次新 invocation，绝不原样自动重放。
safe-read replay 前的 retry fact 必须由 RuntimeStore 明确 durable ack；仅同步 emit、持久化失败或
缺少 persister 时第二次 dispatch 为零。MCP readiness 本身属于 pre-dispatch boundary：如果它在任何
capability dispatch 前失败，失败 authority 必须为 `not_started/none/pre_dispatch`；durable ack 后可再做
一次 readiness attempt，但整个 lineage 仍只允许唯一一次后续 capability dispatch。已解析 identity 使用当前 ToolSpec/MCP binding schema 的
default 后参数与 revision；malformed raw 参数只进入私有 HMAC equality，不作为明文 state。
真实 Kernel 路径必须先持久化唯一一次有效 `tool.started`，再持久化可由 reducer 消费的
`tool.retry_recorded`，才允许第二次 Provider dispatch；retry ack 后即使进程在 terminal 前崩溃，
restore 仍保留 `recoveryOf` 与 automatic attempt=1，同 identity 总额外 dispatch 不得超过一次。

父 Runtime 与 task Subagent 共用 `ToolRecoveryJournalV1` 语义。journal 以 canonical-private 随机
HMAC key 生成内部 invocation fingerprint，持久化 failure instance、`recoveryOf`、模型修正/
自动 retry 次数与 tool-owned progress revision；key、fingerprint 和 lineage 不进入 SessionLog、
remote telemetry 或 eval。只有成功 receipt、内容/Plan/capability/provider revision 可以形成进展；
普通 state revision、文本变化或时间流逝不重置 ceiling。恢复数据缺失结构或损坏时 fail closed，
不会用空 journal 重置次数。重复无进展在 6 个同 identity failure 或 12 个未被 tool-owned
progress 分隔的累计 failure 时触发 quality guard，远早于 250 次 disaster tool-call cap；后续
提议在 Controller dispatch 前阻断并生成配对结果。
failure scope 绑定 task、turn 和 immediately-next eligible model response。deny/never 与没有合法修正的
下一 response 虽写入稳定 terminal/`next_response_elapsed` resolution，仍保留原 scope 的 suppression、
quality fact 与 CompletionGuard blocker；exhausted 不是 recovered。只有成功 `recoveryOf` receipt 或
显式 skip/replan/user/provider/capability revision 才可消除 blocker。task/turn close 只负责让旧 scope
不阻断新 scope。`alternative` 可在下一 eligible response 使用不同 capability，但 Runtime 必须绑定
`recoveryOf`。quality guard 允许 Plan、询问用户与 capability search 等逃逸工具形成真实替代进展。
主 Runtime 与 Subagent 的 deny 重提、MCP binding failure、legacy exhausted bypass、restart 与 parent
merge 全部走同一 typed terminal/journal 路径，不保留另一套正文或计数旁路。
Subagent 的正常执行与 approval resume 都只能把 `ToolExecutionResult` 的 canonical public model content
追加到下一次 Provider context；该内容与 parent reducer 共用唯一 helper，success 选择
`stdout || stderr || ''`，failure 选择 `stderr || stdout || ''`，并同时读取 `ok`/terminal status。
子 Agent 的单个工具失败只是一条步骤级 ToolOutcome/recovery 事实：它必须保留在 journal、步骤展示和 parent
recovery 中，但不得因为未恢复而把已经返回最终模型文本的 child 改投影为 `subagent.failed`。该情形 child
仍以 `completed` 终态把最终文本交给父 Agent；`subagent.failed` 仅表示 child lifecycle 本身未正常结束，例如
中断、超时、Provider/模型服务异常、循环耗尽或没有产生最终模型结果。
command、path、resultMeta、classifier advice 与 private recovery guidance
不得通过 `JSON.stringify(result)` 进入 transcript。ToolSpec advice 仍作为独立 metadata 输入同一
`classifyToolOutcomeV1`，因此父/子 `read_file` ENOENT 等失败得到相同 detail/recovery，而公开错误文本不重复路径。
生产 task Subagent 从创建时继承 parent journal 的 canonical-private `identityKey`，所以 child failure
merge 后的 fingerprint 已经属于 parent HMAC domain；foreign-key journal 不复制任何 failure/fingerprint，
而是 fail closed quality block。同一 child deny 被 parent 再次提出时，Controller 在 dispatch 前以同一
canonical identity 零调用阻断。该 key 与 fingerprint 仍不进入 Provider、SessionLog、metrics 或 TUI。

Sandbox fail-closed executor 在 backend/flag 不可用且禁止 unsandboxed fallback 时写入结构化
`terminationReason=sandbox_denied`。Runtime 由该字段分类为 `sandbox_error/sandbox_denied`，不得解析 stderr，
不得把它投影成 approval/phase rejection，也不得尝试底层命令或自动 replay。测试通过同一 factory 的
可触发 fallback sentinel 证明底层 executor 确实可观测，并从 persisted Runtime event 计数证明没有 approval grant、
authorization/interaction-mode widening；不存在生产计数 seam 的“权限提升尝试”不得以常量伪造。

schema v23/current Runtime snapshot 与当前 Subagent continuation 都必须携带 journal；缺失即 fail closed
quality block，只有 pre-v23 migration 可初始化空 journal。invalid provider raw args 在
`model.responded/tool.queued` 之前立即替换为固定 `invalid_json + redacted` sentinel；HMAC fingerprint
只放独立 canonical-private 字段，event store、state、transcript 和 diagnostics 不得出现原文，Provider
projection 也不得出现 fingerprint/key。当前 auto-review 风险判定升级人工审批，不产生 ToolMessage；
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

`promptContractV2` 开启时，phase 不改变 production builtin declaration：Planning 与 Building 使用相同的 edit/write/shell 声明和完整 `task` role schema；当前已绑定动态 MCP 也保持声明稳定，避免 phase 切换破坏 Provider 的工具前缀。动态 Runtime block 和 ToolSpec description 引导 Planning 只调用只读能力，Runtime Policy/Controller 仍以当前 phase 和 Registry/MCP effective effects 强制裁决：policy-proven read-only Shell、MCP 与 Registry capability 可运行，edit/write、非只读 Shell、code/review child 和 side-effectful MCP 均不执行、不进入审批，并产生配对的结构化 phase Tool Result。模型可以为有界、自包含、独立且值得额外调用的工作自主选择 `task`；用户明确要求不委派时必须遵守。Capability availability、execution surface、binding、Skill lifecycle 与 flags 仍可改变实际工具面；稳定披露不是授权。

Runtime 不解析 active Task 的 `userGoal` 来授权委派、匹配 role 或推导 code scope；delegated task 的硬校验只复用 schema 的 trim 后 `8..8000` 长度边界，不按语言、单词数或语义短语猜测“是否自包含”。自包含、独立和收益判断属于模型可见 Tool contract。explore/plan/review 保持各自只读 ceiling；code 仅用于当前用户任务要求实施的情形，并与 Parent 共用 phase、interaction mode、authorization、sandbox、protected path、execution surface 和累计预算。Project、Shell、工具结果或远端内容不能提升这些结构化权限；它们是否影响模型选择属于指令遵循边界，不能表述成新的 Runtime 授权。Planning 只允许 explore 及只读 plan，code/review 一律拒绝；
审批只解决具体调用的 Runtime policy gate，不能扩大 Subagent role ceiling。explore/plan/review 的
非只读 Shell 即使在暂停后获得批准，resume 仍必须经过与首次 child loop 相同的只读 executor 并被拒绝。
plan child 返回后的唯一 continuation 是 `write_plan:save`
再 `write_plan:submit`。同一模型响应中连续、属于同一 task、尚未暂停且经 Policy 判定为无需审批的
独立 `task` sibling 可以组成最多 4 个调用的并发批次；实际派发数量还受共享
`maxConcurrentSubagents`、writer ceiling 和累计预算限制。模型应把有价值的独立任务一起派发，依赖
前序结果或写范围重叠的任务必须串行；若减少用户要求的数量，需要明确说明原因。多个并发 child
动态请求审批时只呈现一个 canonical interaction，其余 continuation 以
`subagent.approval_deferred` 持久化排队，随后从 snapshot 继续，不得重启 child 模型。每个 child 的
原始审批路由必须随 snapshot 持久化；恢复不得把 `minimumApproval=user` 或其他人工审批降级为
auto-review，缺少该字段的历史 snapshot 必须保守回退到人工审批。重新呈现延后审批不是新的
Sub-agent lifecycle attempt，不创建或结算 parent/tool reservation；真正获批恢复时才打开新的
parent attempt。已经自动或人工获批的 active continuation 优先于 deferred queued sibling；获批 child
完成或再次暂停前，后者不得插队占用 canonical interaction。每个 child 的 model/tool reservation
仍来自父 run 的共享累计预算 ledger（ADR-0104）。自动审查升级人工审批时，`reviewFailure` 必须携带
reviewer 的风险判断或技术失败原因，TUI 不得把升级表现成无原因的永久等待。Runtime 调用 reviewer
时必须提供当前用户任务、workspace root，以及可用时的 Subagent 身份和角色；reviewer 不得只依据
脱离任务语境的单条命令做决定。实际并发派发的 task sibling 共用 Runtime 签发的
`concurrencyGroupId`，使 TUI 能聚合显示 queued、auto-reviewing、awaiting-user 与恢复后的状态；该字段
不是授权凭据，串行调用不得由 App 根据相邻卡片或时间顺序推断成并发批次。自动审查明确拒绝或
error abort 必须把对应活动 child 投影为终态，不能留下永久“等待审批/进行中”的展示。

ADR-0097 的 Git 路由不属于 generic Shell 权限。`git_inspect` 只在精确 feature
revision、`gitInspect` surface 与 App broker 同时存在时披露/执行。Shell 中绝对路径、nested shell 或间接 child 的 Git executable token同样 fail closed。stage、commit 与 remote Git 均不向模型披露，也不得由 interaction mode、Shell grant 或 raw shell fallback 恢复。
Git log revision 使用 broker、Provider schema 与 Registry 共用的闭集 grammar；Runtime 的预算/资源 admission 与模型 surface 都必须接收同一个 `gitBroker` dependency，避免“已披露但不可执行”或相反的漂移。Git process stdout/stderr 在 App adapter 内流式限界，溢出是 typed terminal，不把异常或 protected 历史正文投影给模型。

V2 写入前还执行项目指令 snapshot guard。edit/write 使用目标路径，shell 与 code task 至少使用已解析 cwd/Workspace 根；若目标首次引入当前模型快照未见的嵌套 `CLAUDE.md`/`AGENTS.md`，或适用文档 digest 已变化，本次副作用以可恢复的 `project_instructions_changed` 拒绝。下一轮重新投影后模型可重新发起，审批与 sandbox 不得绕过此检查。

`resourceBudgetV1` 启用时，策略/审批仍先于 child reservation；只有调用已经可执行时才原子写入
reservation，再单独写入 `dispatch_started`，最后进入 adapter。Subagent parent 只代表一次
lifecycle attempt，child 模型及工具/Shell/MCP 调用各自链接独立 reservation；artifact bytes
计入产出它的 tool/MCP reservation，不另建一个虚构 invocation。延后审批的重新呈现只打开
interaction，不属于 dispatch 或 lifecycle attempt，因而不进入 resource admission；child tool/shell permit 使用
durable FIFO waiter、原子 promotion + reservation 与有界 wait deadline；超时通过主 Runtime 的
canonical failure terminal 收敛，不转换成普通 child tool error。
本地 Provider 最终 gate 明确拒绝且能证明未 dispatch 时可携带证明 release；已经执行部分
command/MCP check 的组合 Verification 必须转 `unknown`，不能整体退款。`resourceBudgetV1`
开启但 `boundedCancellationV1` 关闭时，模型不披露 writer、Shell 或 child capability，
Controller 也必须拒绝直接执行，不能退回无界副作用路径。

sealed `ExecutionBoundaryV1` 还会在 dispatch 时派生逐调用 network policy。当前 `web_fetch`
对 robots、正文和每个 redirect hop 分别做 DNS/endpoint admission，并在 socket 前持久化
`network.admission_decided`；Tool Result 只携带 policy revision、receipt digest 和 typed failure。
feature 关闭、决定无法持久化或 controller 不可用都 fail closed。因为当前没有可证明的跨进程
host allowlist，Shell/Skill descendant 固定 network-off，MCP inventory/resource/tool 与可能触发
Provider readiness 的 `tool_search` 在 Controller provider lookup 前拒绝；审批或 `full` mode 不能
把这些路径提升为 `allow_all`。

在非 sealed 开发路径中，remote HTTP MCP 的非空最终参数还必须通过独立 content-egress
permit；read-only effects、Tool Approval、`full_access`、Provider consent 或 host allowlist 都不
能替代。Controller 在 readiness 前拒绝确定性的缺失/过期/mismatch，Manager 在 SDK dispatch
前原子消费 nonce 并等待 durable `mcp.egress_decided` receipt。stdio 与空参数 HTTP 调用不消费
remote content permit；项目配置不能降低保守分类。

Shell 执行的 `onShellProgress` 必须在命令仍处于 running术语（运行中）状态时直接发布 `tool.progress`，不得在 Controller 私有数组中无界累积并等待终态结果。`tool.progress` 是仅供当前进程展示的 ephemeral event术语（瞬态事件）：Runner 按 `toolCallId + stream` 合并尚未消费的批次并保留有界 tail，不写入 Runtime event store 或 snapshot，也不推进 revision；任何 started/terminal/durable event 都是顺序屏障，必须先交付此前 progress，终态事件不得被 progress 淘汰。批次可携带仅保留的完整行和原始 `lineCount`，TUI 因而能在丢弃中间展示帧后继续显示准确总行数。前台 Session 以 50ms presentation frame 合并，同一 call/stream 内保序；一个 frame 内 stdout/stderr 不承诺跨 stream 全序。后台 Session 同样只保留每个 call/stream 的有界聚合 tail，缓冲容量是 presentation soft limit，不能通过 `shift oldest` 丢弃 terminal/lifecycle fact。未提供 event sink术语（事件接收器）的直接调用兼容路径仍在返回数组中收集事件。

## 工具名单单一事实源（ADR-0043）

阶段 2 的 computer、coordination、interrupt 与 runtime action 静态工具也已完成 Registry 单路径切换。`task` 的 role-based effects、子 Agent 依赖和结果传播由 spec 驱动；`tool_search` 在 spec 内完成 feature gate、inventory redirect、provider readiness 重试、候选裁剪和 `capability.search_completed` 事件投影；`ask_user` 以 `kind: interrupt` 注册。Controller 先执行 effective interaction-mode policy；当前所有 mode（包括 `full`）都允许产生 `user_input.requested`，Full mode 尤其可在 Planning 中澄清约束。

事件型 ToolSpec 可通过 `ProjectedToolResult.runtimeEvents` 产出 Core Runtime 事件；controller 只追加这些结构化事件，不得重新计算 capability search、Skill activation 或 Plan 状态结果。该通道只引用 Core 事件类型，不引入 App/TUI 依赖。

ToolSpec Registry 阶段 3 进一步以统一 helper 原子追加这些事件并生成 terminal Tool
Result。Controller 不得构造 `plan.drafted`、`plan.review_requested`、
`plan.progress_updated`、`plan.completed`、`skill.activation_started` 或
`skill.frame_closed`；该所有权由 Registry conformance 测试守护。Skill activation 的
disclosure、approval 与 fork adapter 仍属于 Controller 的跨领域治理边界。

`read_skill_reference` 与 `complete_skill` 已迁入 Registry：spec 校验当前 task 的 active frame、Skill revision 和 compiled contract；reference 读取继续限制为声明文件、非 symlink、Skill 根目录内且不超过 128 KiB；completion 在 output schema 验证后投影 `skill.frame_closed` 与可选 verification 事件。

`activate_skill` 也已迁入 Registry：controller 保留 disclosure、approval 与 mode-policy 前置治理；spec 负责 activation validation、inline/fork 生命周期、fork 结构化输出校验、frame close 和 verification 投影。fork 子 Agent 仅作为受治理 provider adapter 注入。

`read_plan` 已作为 `runtime_action` 接入 Registry：spec 只接受当前 Task 的 active plan identity 与版本，可选 structural digest 必须匹配，并从不可变 Plan Artifact 返回完整文档及可用的 metadata-only completion evidence；controller 不再重复解析或读取 Artifact。

`update_plan` 也已作为 `runtime_action` 接入 Registry：spec 限定 building/executing 的 V2 Plan，精确校验 `plan_id + version + structural_digest` 与稳定 step ID，拒绝重复更新、终态回退、all-skipped completion、缺 Runtime receipt/required verification 的完成请求，以及 command/path/stdout/evidence self-report；接受后只从 Runtime state 投影 metadata-only evidence，并产生带相同 identity 的 `plan.progress_updated`、可选 `plan.completed` 与模型结果。

`write_plan` 已作为 `runtime_action` 接入 Registry：spec 保持 save→submit 两阶段 Artifact 协议、幂等保存、版本冲突、replan 元数据、review interrupt 和同批后续调用取消；首次 save 后的 save/submit/replan 共用严格 identity 校验，新 write 只产生 PlanDocument V2。V1 executing 恢复态只允许 `read_plan` 与 `write_plan` V2 replan/save；无 queued replan 时 Scheduler 使用只披露这两个工具的 `legacy_plan_recovery` model surface，Runner 对 prepare 后 effect 复核，Model/Tool Controller 将历史 queued、模型伪造或直达的 Shell/write/MCP/effect 稳定拒绝为 `legacy_plan_replan_required`。模型表面不再携带 execute，controller 只追加 spec 投影事件，并仅在 save 立即完成时写入 `tool.finished`。

该 recovery surface 不覆盖全局 barrier：unknown external invocation 先进入 reconciliation hard block，全部
awaiting interaction 先请求或处理对应 action。Provider 把非白名单调用放入 `invalid_tool_calls` 时，surface
policy 优先于参数解析错误，仍生成 `tool.rejected(legacy_plan_replan_required)`；白名单 Plan 工具的 malformed
参数才是 `model_invalid_tool_args`。无合法 save 的 final 或伪造调用按 CompletionGuard V1 只允许一次模型纠正，
第二次终止 turn，不能无限重试。
白名单调用的 failed/rejected/cancelled/exhausted 也消费该 correction；submit、错误 identity/schema 或 invalid
arguments 不能借工具名白名单无限循环。只有成功 `read_plan` 可以继续 recovery，成功 `write_plan(save)` 必须
产生 V2 draft。最终 response 的 surface marker 由 Runner 从 effect lease 绑定，Controller/executor 不是信任根。
同样，prepare adapter 不是调度信任根：Runner 会从当前 state 重算 canonical effect，并要求 prepared effect 的
类型与 identity 等价。正确的 recovery surface 或 `read_plan`/`write_plan` 名称不能覆盖 interaction、unknown
external outcome、subagent recovery 或 completion correction barrier。

恢复出的 V1 executing queue 若含非 `read_plan`/`write_plan` 调用，Scheduler 必须先把该 call 交给 Tool
Controller 的 legacy governance gate，持久化稳定 `legacy_plan_replan_required` rejection，再发起 Provider
recovery model 请求。不得等 Provider 成功响应后才补 rejection；即使 Provider dispatch 随后失败，旧 call 也已
终结且不会在 V2 save 后复活。unknown external invocation 仍是更高优先级 hard barrier。

静态工具的 Schema、契约、副作用分类与执行器收敛到 ToolSpec Registry（`src/core/tools/registry/`）。六个计算原语 `read_file`、`search_content`、`search_files`、`write_file`、`edit_file`、`shell_execute` 已完成切换，迁移 flag 与旧执行器不再保留。一致性不变量由 `tests/tools/tool-registry-conformance.test.ts` 棘轮守护：Policy 分类引用的工具名必须是已知名单；模型 ToolSet 不得携带 `execute`；写工具必须声明 mutation scope。write_file 同批落地 ADR-0042 §2；edit_file 同批落地 ADR-0043 §3 与 ADR-0042 §1。shell_execute 的模型参数仅保留 `command`、可选 `description`、可选 `timeout_ms`；未提供 `timeout_ms` 时 Registry术语（工具注册表）必须向执行器传递 600000ms 默认硬超时，显式正整数可以覆盖；副作用、只读免审和审计 `action.intent` 全部由命令形态派生，审批 payload 不接受模型建议授权或 prefix rule。i10 以 `ls`、`pwd`、`rg` 等 policy-proven 语料守护真实 Approval Policy 的免审命中率；generic Shell Git 不属于该语料，只读 Git 检查必须走 `git_inspect`。

生产静态模型工具面必须直接由 `builtinToolRegistry.toSchemaOnlyToolSet()` 投影；`definitions.ts` 只负责构造不可变的可用性快照并合并 Runtime-issued MCP bindings。默认开发入口继续暴露完整投影；production surface 必须逐项按 `network/process/write/shell/skillChild/localStdioMcp` 独立收窄，并同时检查 Capability Descriptor 的 declared/effective effects。Runner 在 dispatch 前重复同一检查，防止仅在模型 disclosure 层收窄；`process=true` 不能提升 `write=false` 或 `network=false`。原生 sandbox Shell 由显式 `process + shell` surface 接管其保守的 `unknown` descriptor；进程内 writer/network 工具仍按各自 effect 被拒绝。`verified_in_process_read_only` 进一步要求密封 qualification catalog 中的 capability ID、descriptor revision 与只读副作用契约完全匹配，并省略动态 MCP；这不是第二份 Registry。该快照包含 feature flags、task adapter、Tool Search、Skill catalog 与 active frame 可见性，并同时用于执行前的静态调用解析。工具表当前不做模块级缓存，避免长进程无界增长与运行中配置变化复用陈旧表面。Builtin Capability Descriptor 包含规范化输入 Schema，因此 Schema 变化必须改变 revision。静态工具进入审批与模型队列时，副作用分类优先且必须来自 `spec.effects()`；手写名称分类器仅用于动态或历史状态的保守回退。

`ToolSpec` 按 kind 构成可辨识联合：`computer`、`coordination` 与 `runtime_action` 具有 `execute/projectResult`；`interrupt` 只具有 `createInterrupt`，类型上不得出现执行器或结果投影。Interrupt 的模型输入与中断协议输出可以是不同类型，但转换只能发生在 `createInterrupt()`。`ask_user` 不能误入 Registry dispatch；Tool Controller 先应用 interaction-mode policy，获准后才可创建 `user_input.requested`。模型只提交 1-3 项的规范 `questions` 数组，每项提供 2-3 个 `{label, description}` 选项，单问题同样使用数组。`askUserSpec.createInterrupt()` 负责生成稳定 ID、将第一项标为推荐并启用客户端自由输入，Controller 不得手工组装中断内容。子 agent 审批恢复路径的 `task` 结果同样复用 `taskSpec.projectResult()`，不存在第二份手写 task 结果格式。

Registry dispatch 在执行后注入已解析参数（`invocationInput`，类型化且恒等于 Schema 解析结果）并调用 `projectResult()`，其输出是静态工具模型内容、`resultMeta`、展示提示和 Runtime events 的规范来源。Tool Controller 对 runtime action、Skill 与 Tool Search 直接以该投影生成 `tool.finished`；Tool Runner 对 read/search/edit/write/shell/web_fetch 与 MCP inventory/resource 同样直接消费投影，不得再次按工具名重算 diff、截断、mutation scope 或 raw digest。产出双路模型就绪文本的工具经投影的 `streams` 字段逐流处理：shell_execute、search_content、search_files 逐流截断且失败时 stdout/stderr 两路保留；MCP 清单/资源三件（list_mcp_resources、list_mcp_tools、read_mcp_resource）逐流透传，结构化载荷（含 stale_cursor 等结构化拒绝）保持在 execute 产出的原流。单流工具（read_file、edit_file、write_file、web_fetch、task、Skill/Plan/Tool Search）以 `modelContent` 为唯一模型通道，Runner 按 ok 分流到 stdout 或 stderr。执行适配器仍可负责读取指纹、文件原像、permit、network mode 和授权来源等治理事实，但不得覆盖 spec 已投影的结果语义。

当 run 携带 sealed `ExecutionBoundaryV1` 时，Registry 还从 ToolSpec 的
`protectedPathAccesses()` 取得结构化 `path + operation`。Evaluator 同时匹配未 realpath 的 lexical
Workspace identity 和 canonical target，防止 protected 名称通过 inward symlink alias 消失。
Runner 必须在 policy 审批前检查，并在异步 `beforeDispatch` 返回后、文件旧内容预读与 rewind
pre-image capture 前重检；Registry dispatch 在
`preExecute/execute` 前再次执行同一 evaluator。read/write/edit 分别声明实际 read/write access，
search 声明 root read 并在遍历中剪枝 protected descendants。完整 builtin tuple 的
`filesystem!=none` spec 必须具有该声明，或显式位于闭合例外集：`read_plan`、
`read_skill_reference`、`shell_execute`、`task`、`activate_skill` 分别由 typed Plan Artifact、Skill
reference allowlist、native sandbox、child Harness、compiled inline/fork adapter 接管。闭合例外测试
会让新增 filesystem builtin 在遗漏 hook 或边界说明时失败。
production execution 标记存在但 surface/evaluator 缺失时同样在 adapter I/O 前 fail closed。所有拒绝都发生在 adapter I/O 前；
approval grant、`full_access` 或 optional allow root 不能重开内建/追加 deny。Shell 仍以原生
sandbox profile 为权威，`checkDangerousPaths()` 只作 defense-in-depth。

## 自治规则

1. 普通问答不使用全局 stop-check；没有未决 Effect 或 required verification 时可直接完成。
2. Read-only Builtin（`read_file`、`search_content`、`search_files`）在工作区内可按 mode 直通；路径指向工作区外部时需用户审批（`externalRead` effect），与 `write_file`/`edit_file` 的外部路径处理一致。外部性判断前，路径参数先经 MSYS2 归一化（`msys2ToWindowsPath`，非 Windows 透传）——否则 Windows 上 `/c/proj/...` 形式路径会被 `resolve()` 挂到当前盘符，工作区内路径被误判为外部。该归一化与 `resolvePath` 的 MSYS2 防御层（见 [[file-reading-shared-boundary]]）口径一致；`tool-runner` 的 `isExternalPathArg` 同样先归一化再判定 `allowExternal`。
3. `accept_edits`、`auto`、`full` 只决定交互策略，不取消 capability schema、revision、minimum approval 或 sandbox 检查。
4. Authorization grant 只在声明的 thread/workspace/command 范围有效；新 thread 不继承单次授权。
5. Destructive shell 与未知外部副作用保持保守边界，不能因 full access 或 same-command grant 自动放行。
6. 批量 tool calls 必须逐个进入相同策略；一个只读调用不能掩盖同批写入调用。连续调用仅在
   每项都已持久化为 `read_only + sideEffect=false`、属于无交互语义的内置读取工具且
   Approval Policy 再确认无需审批时，才可组成最多 4 项的并行批次。`ask_user`、Plan/
   Skill/Task/Tool Search、动态 MCP、已审批恢复、写入、未知分类和需要审批的调用都是
   独占屏障；屏障后的读取不得越过它。同一模型消息、同一任务中的连续
   `shell_execute` 逐项完成策略预检与审批；任一调用一经批准就立即启动，Runner 可在它
   运行期间继续请求下一个 sibling 的审批，后一个获批后同样立即启动。单个调用的策略拒绝
   只终结自身；用户拒绝或取消任一工具审批时则中止整个当前 turn：审批目标 rejected，
   其余未终结 sibling cancelled，已启动执行收到 AbortSignal，Runner 不再继续审批、执行
   或调用模型。策略拒绝和系统失败不套用这一用户取消语义。Shell 重叠在非 Shell 调用、
   不同模型消息或不同任务边界处截断，不得
   跨越 `ask_user`、方案审核或其他工具；`tool.execution_ready` 只用于旧回放兼容。
7. `ask_user` 的拒答或取消不是工具审批拒绝。它只产生一个失败的成对 Tool Result 并清除
   用户输入交互，Runner 必须继续同一 turn，让模型在缺少该答案的情况下继续；不得发出
   `turn.aborted` 或中止其他执行。Schema 校验失败尚未创建用户输入交互，TUI 必须把它
   显示为工具错误，不能伪装成 `(no answer)` 或 `User: ...`。
8. 方案执行确认是授权屏障。用户取消 `request_plan_review` 时保留方案 draft，但取消方案
   工具和所有未终结 sibling，发出 `turn.aborted(cause=user)`，Runner 立即退出；不得把
   取消投影成成功的 `review_cancelled` Tool Result，也不得继续调用模型。
9. Planning 的 phase 边界不可审批升级。非只读 `shell_execute` 在该阶段不创建 approval，
   Controller 以 `phase_deferred` 终结本次 Tool Call，并向模型返回原始参数、
   `until_phase=building` 与“写入方案、批准后重新调用”的结构化指引。TUI 消费对应的离屏
   queued 元数据但不生成 Bash 卡、失败提示或 deferred command 行；这不是 Runtime 可自动
   恢复的执行队列。`write_file`、`edit_file` 与实现型 Subagent 等其他阶段越界使用
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
5. Core 调用方若直接使用破坏性的 `restoreNamedSnapshot`，文件恢复仍必须先于它执行，
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

通过 binding 解析出的 MCP 本地策略必须从 Tool Controller 传递到最终 Tool Runner，不能在防御性二次审批时丢失。只有 `minimumApproval=none` 且 filesystem、network、external state 三个 effect 维度都为 `none/read` 时，能力才属于已证明只读；任一维度为 write 或未知都保留审批边界。该规则同样适用于 Subagent 内的 MCP 调用。

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
- 新的已注册工具自动获得与其 Registry `effectClass` 对应的审批默认策略（`read_only`→放行、`plan_only`→放行、`workspace_write`→模式策略、`external_side_effect`→审批），不再需要逐工具手工维护审批矩阵。仅存在明确安全边界（URL 校验、外部路径、命令分类、MCP binding）的工具才需要专用分支。

Skill 的 readonly 分类比单个 Tool 名或 manifest 声明更严格：自身和全部 dependency 的 effective
effects 必须明确为 `none|read`，且 provenance/Workspace Trust 满足；write、destructive、unknown、
解析失败或 revision drift 都归 effectful/off。`allowed-tools` 只是 ceiling，不是授权；effectful Skill
还必须经过 required Verification。

## 工具结果结构化元数据

工具完成时的 `resultMeta`（`path`、`totalLines`、`command`、`matchCount`、`rawResultDigest`、`modelContentDigest`、兼容字段 `contentDigest`、`digestScope`、`intent`、`truncated`、`resourceRevision`）从 `harness/tool-runner.ts` 写入 `ToolCallRecord`，通过 `ToolCallResult` 进入 `RuntimeState.tools.calls`。Runner 必须在 MCP normalization、serialization 和任何模型可见截断前计算 raw digest，并显式传播截断状态；Controller 对模型可见内容计算 model digest，不能把 projected digest 标记成 raw。这些字段用于审计、恢复和摘要输入中的结构化事实；当前模型上下文不执行工具结果投影折叠。行为上不改变权限决策或审批路由。

## 子 Agent 阻塞审批请求构造

子 Agent 因工具审批阻塞时，Controller 通过 `buildBlockedToolRequest` 构造 `PendingToolRequest`：优先走 `toolRequestFromCall`（Registry → request adapter）获得类型化请求；仅在工具未注册时 fallback 到最小构造（builtin 或 MCP 取决于 `mcp__` 前缀）。不再手工 `as PendingToolRequest` 强转。失败分类的 `parseFailureCode`（`invalid_json` | `unknown_tool` | `tool_unavailable` | `invalid_arguments`）通过 `InvalidToolRequest` 透传到 `ClassifiedFailure`；前两类参数错误映射为 `tool_invalid_args`，`unknown_tool`/`tool_unavailable` 映射为 `tool_not_found`，父 Runtime 与 Subagent 使用同一恢复策略。`taskSpec.projectResult()` 只序列化显式 model allowlist（ok、summary、error、toolCallCount、durationMs）；Controller 在私有事件通道合并 child journal，`toolRecovery`、execution journal、exhausted fingerprints、steps/args 与 continuation 不得进入 parent transcript 或下一次 Provider payload。

Subagent 的执行上下文由父 Runtime 显式传递：`interactionMode` 使用当前 live state，恢复不复用挂起时的过期模式；Workspace 先 canonicalize，再同源用于模型 `Workspace`/`CWD` 与工具路径解析。文件编辑的 read-before-edit freshness 使用 Runtime-issued child id 作 actor scope，正常 child loop、阻塞工具获批与恢复后续 loop 必须保持同一 id；Parent 或 sibling 的读取不能为当前 child 授权编辑。
