# Runtime 韧性与 bounded soak 资格门禁

状态：active

读取时机：修改 Runtime 持久化/恢复、模型或 MCP 故障处理、Sub-agent 取消清理、TUI 长生命周期测试，或生成 release fault/soak evidence 时。

验证：`bun run test:runtime:fault`、`bun run test:runtime:soak`、`bun test tests/mcp-manager.test.ts`、`bun run test:tui:system`、`bun run typecheck`。

相关：`six-concept-runtime-architecture.md`、`failure-classification.md`、`cancel-resume-cleanup.md`、`tui-e2e-testing-limits.md`、Task 1C.7。

## 两级运行契约

`scripts/runtime/run-fault-soak.ts` 是固定 seed、固定 case manifest、单 case 硬超时和全局调用预算受限的 runner。它只输出版本化 JSON 元数据，不把测试 stdout/stderr、prompt、工具 payload 或 workspace 绝对路径写入 evidence。失败诊断最多保留在当前进程 stderr 中；写入 `--output` 后必须显式收紧为 `0600`，包括覆盖已存在的宽权限文件。

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
7. `tui_lifecycle_churn`：session switch、tool lifecycle 和 model stream reconnect 的 PTY 进程生命周期。

seed 只决定每轮 case 的旋转顺序；不能减少固定 case 集。每个 probe 只允许一次 runner invocation，超时后必须终止整个子进程树。Unix probe 使用独立 process group，并以 parent/PGID 双重采样 owned PID；正常退出后发现的后代同样先记录为 orphan 再强制清理。`ps`/`git worktree` 因平台缺失或权限策略无法启动、抛错或非零退出时必须转为 inspection unsupported，使 qualification 结构化 `inconclusive`，不能在报告前崩溃。stdout/stderr 在进程退出后最多等待 2 秒 EOF，持有继承 pipe 的漏杀后代不能让 runner 永久挂起。runner 为每个 attempt 分配独立临时目录，并把普通临时残留记录为 `residualPaths`；`orphanWorktrees` 只来自 probe 前后 `git worktree list --porcelain` 的 registry 差集。任一残留、orphan worktree 或 orphan PID 都是 hard failure。

## 报告与资源判定

报告 schema 当前为 v1，并包含 runner revision、seed、profile、平台/Bun 版本、预算使用、每个 case 的 p50/p95/p99、状态不变量、清理结果、资源摘要和 SHA-256 canonical digest。

`terminalTaxonomyAssertions` 表示“通过的 probe 对该终态分类完成过断言”的覆盖次数，不是线上事件发生频率。runner 只能从对应测试的 `(pass)` evidence 中提取该字段，不能因为进程 exit=0 就按 manifest 硬编码覆盖；任一固定 case 缺少必需分类证据时直接失败。不得把它解释为 incident count 或成功率。

qualification 必需指标为 child RSS、active resource、FD、process listener、active handle 和 owned descendant PID。只有 warm-up 后在同一进程内执行 bounded repeated lifecycle 的资源样本才能标记 `qualificationEligible: true`。这类样本每个 attempt 的 `after - before` 超过下列阈值就是 hard failure，不能由跨轮样本形状掩盖；此外，最后 8 个 `after` 样本中至少 6 个相邻步骤增长且首尾增长超过同一阈值时，也视为持续正斜率：

- RSS：32 MiB；
- active resource、FD、listener、handle：2。

当前普通 Bun test probe 通过 preload 采集 fresh child 的 `beforeAll/afterAll`，其中包含模块加载、JIT 和测试 fixture 冷启动；报告保留这些诊断值，但必须标记 `qualificationEligible: false`，不得套用 leak 阈值。TUI case 会启动多个独立 test/TUI 子进程，现有数据同样不能证明同一 TUI 进程 repeated mount/unmount 无泄漏，因此该 case 的 child resource 指标保持 unsupported。正式 qualification 当前应返回 `inconclusive`，而不是因冷启动增长误报 `failed` 或误报通过；后续只有在 warm-up 后的同一进程内完成可重复 lifecycle fixture，并能关联全部 child/descendant telemetry 后才能解除该限制。

## 持久化故障边界

每个 `RuntimeStore` 连接在设置 journal mode 或执行 schema 写入前先安装 5000 ms `busy_timeout`，因此 journal/schema/事件写竞争都受同一有界等待约束。SQLite writer lock 释放后只允许一次成功提交；不能因为重试重复事件。

`RuntimeStoreOptions.faultInjectionMaxPageCount` 仅供测试把连接限制到确定性 page ceiling，从而触发 `SQLITE_FULL`。生产组合根不得设置它。失败写入必须完整回滚，重开后事件集合、Runtime state 和恢复状态仍满足不变量。

真实 MCP stdio server 在 tool invocation 中退出时，调用必须返回 typed `provider_unavailable`，provider 进入 `degraded`，并保留最后一次成功 catalog 供诊断；它不等于签发新 Binding 或自动重放调用。

模型 HTTP `429` 属于可重试的 rate-limit failure，但只允许消费统一的 bounded attempt/time budget；生产分类必须读取 AI SDK `APICallError.statusCode`（并兼容旧 adapter 的 `status`），预算耗尽必须抛出最后一次 429，并由 failure-mode policy 收敛为 `model_retry_exhausted`。本地 HTTP fixture 必须穿透 `createChatModel` 和 provider middleware 证明 429 后恢复；其他 4xx 仍不可重试。
