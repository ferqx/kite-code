# Runtime 韧性与 bounded soak 资格门禁

状态：active

读取时机：修改 Runtime 持久化/恢复、模型或 MCP 故障处理、Sub-agent 取消清理、TUI 长生命周期测试，或生成 release fault/soak evidence 时。

验证：`bun run test:runtime:fault`、`bun run test:runtime:soak`、`bun test tests/mcp-manager.test.ts`、`bun run test:tui:system`、`bun run typecheck`。

相关：`six-concept-runtime-architecture.md`、`failure-classification.md`、`cancel-resume-cleanup.md`、`tui-e2e-testing-limits.md`、Task 1C.7。

## 两级运行契约

`scripts/runtime/run-fault-soak.ts` 是固定 seed、固定 case manifest、单 case 硬超时和全局调用预算受限的 runner。它只输出版本化 JSON 元数据，不把测试 stdout/stderr、prompt、工具 payload 或 workspace 绝对路径写入 evidence。失败诊断最多保留在当前进程 stderr 中；写入 `--output` 后必须显式收紧为 `0600`，包括覆盖已存在的宽权限文件。Required CI 运行 fault contract 与 CI profile；`.github/workflows/runtime-resilience-qualification.yml` 提供显式手动 qualification，并无论结果如何上传版本化报告 artifact。

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
   并通过 `--with-lifecycle-harness` 显式追加专用 focus-listener lifecycle harness。

seed 只决定每轮 case 的旋转顺序；不能减少固定 case 集，也不得传入 Bun test 改写 test scheduler。每个 probe 只允许一次 runner invocation；测试型 probe 由 coordinator 把各功能文件放入隔离 child 且各运行一次，避免共享 Yoga/全局 fixture。Qualification 只对 manifest 中每个 case 明确选定的真实代表 lifecycle 文件执行 1 次 warm-up 和 8 次 measured rerun；不能重放整个大型功能 suite 后把 Bun test runner 自身保留的断言/fixture 内存归因于产品泄漏。long-runtime 当前以 deterministic state replay 和真实 `runRuntimeAgent` budget workload 为资源 lifecycle；其他 case 分别选择 cancel/recovery、deadline、MCP supervisor、SIGKILL/SQLite fault lifecycle。超时后必须终止整个子进程树。Unix probe 使用独立 process group；fault-soak 内的 TUI per-file 与 lifecycle child 必须继承该 group，不能再创建 `ps` 缺失时无法发现的 nested detached group。runner 同时以 parent/PGID 双重采样 owned PID；每条 telemetry 还必须匹配 attempt nonce、PID、OS process-start identity、lifecycle ID 和 group nonce。报告必须精确收到 manifest 声明的全部 qualification lifecycle group；短命 child 即使错过 50 ms 采样，也只能凭有效 nonce 绑定补入 owned PID 集，任一声明组缺失、重复或未绑定均使 qualification `inconclusive`；同一 probe 中仅运行一次的功能文件 telemetry 不进入 qualification series。正常退出后发现的后代同样先记录为 orphan；runner 必须重新读取并匹配 OS process-start identity 后才可将 PID 计为 orphan 或强制清理，数值 PID 已被复用时不得触碰新进程，身份无法确认则 inspection unsupported。`ps`/`git worktree` 因平台缺失或权限策略无法启动、抛错或非零退出时必须转为 inspection unsupported，使 qualification 结构化 `inconclusive`，不能在报告前崩溃。stdout/stderr 在进程退出后最多等待 2 秒 EOF，持有继承 pipe 的漏杀后代不能让 runner 永久挂起。外层 probe 超时时对已经采样的 PID 先绑定 process-start identity，kill 前再次核验；可发现的 nested detached group 先按 PPID/PGID 快照并由深到浅终止，最后终止 coordinator group，不能先杀 coordinator 导致后代 reparent 后失去 ownership。runner 为每个 attempt 分配独立临时目录，并把普通临时残留记录为 `residualPaths`；`orphanWorktrees` 只来自 probe 前后 `git worktree list --porcelain` 的 registry 差集。任一残留、orphan worktree 或 orphan PID 都是 hard failure。

## 报告与资源判定

报告 schema 当前为 v2，并包含 runner revision、seed、profile、平台/Bun 版本、每个 case 的 p50/p95/p99、状态不变量、清理结果、资源摘要和 SHA-256 canonical digest。`runnerBudgetUsage` 只表示外层 probe invocation 与 wall-clock 上限；`runtimeBudgetUsage` 仅来自 long-runtime case 中真实 `runRuntimeAgent` workload 的 actual reconciled/committed `ResourceBudgetV1` ledger receipt，reducer-only 合成状态不得作为该证据，二者也不得混写。Qualification 的每个 long-runtime attempt 必须收到完整 receipt 组；每条 receipt 还必须与同一条 process resource lifecycle 在 case、lifecycle、PID、sequence、attempt nonce、OS process-start identity 和 group nonce 上完全匹配，错轮或未绑定的 receipt 一律使该证据 unsupported。

`terminalTaxonomyAssertions` 表示“通过的 probe 对该终态分类完成过断言”的覆盖次数，不是线上事件发生频率。runner 只能从对应测试的 `(pass)` evidence 中提取该字段，不能因为进程 exit=0 就按 manifest 硬编码覆盖；任一固定 case 缺少必需分类证据时直接失败。不得把它解释为 incident count 或成功率。

qualification 必需指标为 child RSS、active resource、FD、process listener、active handle、owned descendant PID、Git worktree inspection，以及 long-runtime attempt 的 actual Runtime budget ledger receipt。只有 warm-up 后在同一 PID、同一 process start nonce 内执行 bounded repeated lifecycle 的资源样本才能标记 `qualificationEligible: true`；每个 lifecycle point 必须携带 before/after、sequence、deadline 和 cleanup receipt。每个 attempt 的 `after - before` 超过下列阈值就是 hard failure，不能由跨轮或跨进程样本形状掩盖；此外，最后 8 个 `after` 样本中至少 6 个相邻步骤增长且首尾增长超过同一阈值时，也视为持续正斜率：

- RSS：32 MiB；
- active resource、FD、listener、handle：2。

CI profile 的普通 Bun test probe 通过 preload 采集 fresh child 的 `beforeAll/afterAll`，其中包含模块加载、JIT 和测试 fixture 冷启动；报告保留这些诊断值，但必须标记 `qualificationEligible: false`，不得套用 leak 阈值。Qualification profile 仅使用 manifest 选定 lifecycle 文件的同进程 rerun series。TUI 的 session switch、tool lifecycle 和 model reconnect PTY 场景仍按文件隔离，只证明功能与 terminal taxonomy，不提供资源斜率结论；fault-soak 必须使用 runner 的显式 `--with-lifecycle-harness` 参数把专用 harness 作为单独文件加入同一 probe，不能依赖普通 scenario 发现规则或历史输出偶然执行它。TUI 资源资格范围明确限定为该专用 child 中的 `InputLine`/`TerminalFocusStore` focus-listener mount/unmount lifecycle。该 child 在同一真实 Ink 进程内完成 warm-up 加 8 次重复，逐次先证明 listener/DEC 1004 已挂载，再证明卸载和 descendant 清理。只有 `tui-input-focus-lifecycle` 可以作为该范围的 TUI qualification 资源样本；它不得被表述为完整 session/tool/model PTY 生命周期的内存证明，PTY parent 和跨文件父 runner 趋势也不得替代它。

本机或 CI 若不能确认 `ps` 进程树、Git worktree registry、完整 same-process series 或上述 TUI child ownership，正式 qualification 必须返回 `inconclusive`。Task 1C.7 只有 Ubuntu 手动 qualification workflow 产生 `status=passed` artifact 后才可关闭；两轮本地 CI profile 通过只证明 smoke 可重复，不等于 release qualification。

## 持久化故障边界

每个 `RuntimeStore` 连接在设置 journal mode 或执行 schema 写入前先安装 5000 ms `busy_timeout`，因此 journal/schema/事件写竞争都受同一有界等待约束。SQLite writer lock 释放后只允许一次成功提交；不能因为重试重复事件。

`RuntimeStoreOptions.faultInjectionMaxPageCount` 仅供测试把连接限制到确定性 page ceiling，从而触发 `SQLITE_FULL`。生产组合根不得设置它。失败写入必须完整回滚，重开后事件集合、Runtime state 和恢复状态仍满足不变量。

真实 MCP stdio server 在 tool invocation 中退出时，调用必须返回 typed `provider_unavailable`，provider 进入 `degraded`，并保留最后一次成功 catalog 供诊断；它不等于签发新 Binding 或自动重放调用。

模型 HTTP `429` 属于可重试的 rate-limit failure，但只允许消费统一的 bounded attempt/time budget；生产分类必须读取 AI SDK `APICallError.statusCode`（并兼容旧 adapter 的 `status`），预算耗尽必须抛出最后一次 429，并由 failure-mode policy 收敛为 `model_retry_exhausted`。本地 HTTP fixture 必须穿透 `createChatModel` 和 provider middleware 证明 429 后恢复；其他 4xx 仍不可重试。

专门验证下游统一取消信号的 wall-clock deadline fixture 必须给 provider 或 interaction 留出在繁忙
CI worker 上完成入场的调度余量，再断言 in-flight AbortSignal。若 deadline 在 provider admission 前
到期，这是另一条合法的 fail-closed 路径，不能用来否定取消传播，也不能与 in-flight 断言混为一谈。
