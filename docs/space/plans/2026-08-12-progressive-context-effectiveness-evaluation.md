# 渐进式上下文缩减有效性评测

状态：in_progress

日期：2026-08-12

## 目标

在不改变任何默认开关或发布资格的前提下，确认渐进式上下文缩减是否比简单 rolling summary 更适合真实
coding agent。结论只能是 `passed`、`failed` 或 `inconclusive`；它不自动授权 default-on、production route
qualification、删除策略或改变 accepted ADR。

## 非目标

- 不把 PSMC-06 的 deterministic structural/performance gate 表述为真实模型质量证据；
- 不以一次 Provider smoke、单个 benchmark、模型名或本机结果取得 rollout 资格；
- 不记录 prompt、模型正文、工具正文、工作区绝对路径、密钥或完整 endpoint；
- 不在没有专门触发用例时把 composite 结果归因给 Micro、Working Set 或 L2.5。

## 预注册的对照

每个 arm 必须使用相同 case revision、隔离 workspace、provider/model route、工具集、output budget、最大
turn、timeout 和随机/交错执行顺序。每次 attempt 都进入 append-only、脱敏 ledger；不得只保留最佳结果。

| Arm | 定义 | 目的 |
| --- | --- | --- |
| `raw` | 不启用 L1 V2、Micro、Working Set/L2.5 或 auto L3 | 质量上限与超窗参照，不是 rollout baseline |
| `rolling_summary` | 只在阈值触发 summary，并使用 `summary + tail`，不混入 Micro/L2/L2.5 | 与常见开源 rolling-summary 方案的直接基线 |
| `local_projection` | L1、Micro、Verified Working Set 与 L2.5（如有效）；禁止 L3 | 验证无额外 summary 调用的局部收益 |
| `progressive` | `local_projection` 加 SummaryCompact | 验证完整链路的净收益 |

四个 arm 必须由 evaluator-owned `contextStrategyProfile` 表达并进入 run identity；不能通过一组松散 feature
flags 推断。尤其 `rolling_summary` 必须明确禁用 Working Set，避免把 V3 checkpoint 的 `summary + W + T`
投影误当作简单 baseline。

## 三组证据

1. **真实 agent task 主矩阵**：使用隔离 fixture 与确定性 oracle，比较最终 diff/check、task success、未授权
   side effect、超窗/forced stop、input/output token、模型与端到端时延、cache hit/miss、summary 次数、重复
   read 与压缩后 3–5 个 primary turn 的恢复。
2. **checkpoint-seeded continuation 子矩阵**：使用同一 canonical transcript 和 V3 checkpoint，专门验证
   Working Set/L2.5。必须覆盖超大只读 block、offload 后按原参数重读和关键事实恢复；未触发的子路径记录
   `not_exercised`。
3. **离线 replay/资格**：继续运行 PSMC-06 和现有 deterministic tests，覆盖 selector、投影、token、tool
   pairing、immutable transcript、性能和 fail-closed。它只证明机制正确性。

为避免入口语义重叠，公开命令固定收敛为两个：`qualify:context` 封装 PSMC-06 的 producer/verifier，只输出
本地 aggregate；`eval:context:live-pilot` 是唯一真实模型上下文 runner，并同时覆盖 direct/incremental
summary compatibility 与压缩后的 continuation。Slice A 与 `tests/evals/compaction/` 继续存在，但只标为
legacy regression，不得被报告为策略质量或发布证据。

先运行 pilot：4 个有意构造的长上下文 case × 4 arm × 3 次；仅当 pilot 不出现 correctness/safety blocker
时，扩展到批准 suite 的 12 case × 5 次。

## 硬门槛

- identity/config/attempt coverage 为 100%，无遗失 terminal；
- transcript/projection 不变量错误和未授权 side effect 均为 0；
- 对 `rolling_summary`，`local_projection` 和 `progressive` 的 paired bootstrap 95% CI 任务成功率下界均不得低于
  -5pp；
- `progressive` 还必须满足一项预注册收益：median total billed tokens 降低至少 15%，**或** overflow/forced-stop
  rate 相对降低至少 25%；同时 p95 end-to-end latency 不得恶化超过 15%；
- 未满足、样本不足、Provider usage/cache counter 缺失到无法计算，或 CI 跨越门槛，一律为 `inconclusive`，保持
  默认关闭。

composite 通过后才可做消融：`progressive − Micro`、`progressive − L2.5`（必要时再减 Working Set）。未达到
触发覆盖或未产生预注册质量/成本收益的子路径，标记为候选删除或继续关闭，而不是视为已证实有效。

## 实施顺序与验收

1. 新增 versioned evaluation contract、strategy profile identity、脱敏 report/ledger 与其 deterministic unit tests。
2. 新增 opt-in live runner 和 package script；默认 `bun run test` 绝不触网，dry-run 不读取 Provider 凭据。
3. 为 `rolling_summary` 实现 evaluator-only `summary + tail` 投影，并确保它不复用 L2；为 primary preparation
   输出仅枚举值的 tier/reason telemetry。
4. 实现主矩阵与 checkpoint-seeded 子矩阵，冻结 fixture/case revision 和 profile/route digest。
5. 运行 pilot；只有实际 live run 的脱敏聚合结果写入 completed record。随后按结果决定扩大样本、做消融或停止。

实现阶段必须同步更新 `docs/active/real-model-test-boundary.md`、
`docs/active/compaction-release-qualification.md`、`docs/active/three-tier-context-reduction.md`、
`docs/book/12-测试体系.md` 和 `docs/documentation-map.json`。其中 `docs/book/12-测试体系.md` 的 PSMC-06
阈值需以当前 verifier 为准：continuation >=95%、raw delta >=-2pp、prepare p95 <=75ms、restore p95 <=100ms、
incremental RSS <=96MiB。

## Pilot 记录（2026-08-12）

已用本机 `deepseek / deepseek-v4-flash` 执行一次实际 Provider summary 与三个实际 continuation（raw、
`summary + tail`、progressive Working Set）。结果记录在
[`../execution/completed/2026-08-12-progressive-context-live-pilot.md`](../execution/completed/2026-08-12-progressive-context-live-pilot.md)。
它的 raw 为 4/4 事实恢复，而两个压缩 arm 均为 0/4；因此该 pilot 为**失败信号**，不是通过或 rollout 证据。
下一步必须先修正摘要事实保留/评测 fixture，再运行已预注册的四臂 agent-task pilot。
