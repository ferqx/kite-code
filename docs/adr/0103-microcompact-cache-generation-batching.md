# ADR-0103：MicroCompact 的缓存世代批量切换

状态：accepted
日期：2026-08-11
决策者：`github:@ferqx`
补充：ADR-0096、ADR-0100

## 背景

MicroCompact 不改写 canonical transcript，却会把旧 tool result 的 Provider 投影替换为 stub。每次新的
reclaim commit 都会改变主请求的 conversation prefix；若为很小的新增结果频繁推进 commit，会反复打断该层
prompt cache，抵消 token 节省并增加延迟。

## 决策

新的 `context-reclaim-live:v3` 策略把一次投影变更视为一次**缓存世代切换**：

- 第一次 live commit 仍仅在 warning 或更高 pressure（或显式 absolute trigger）后考虑，但必须至少选择 2 个
  完整 eligible block、节省 4096 tokens、且达到原有 5% saving ratio。
- 已有 commit 时，仍按已提交 stub 逐字重建 Provider 投影；只有距上次 commit 至少 10 个 turn、且新增完整
  eligible block 至少 2 个、增量节省至少 8192 tokens 并达到 5% ratio，才可推进下一代 commit。
- `hard_limit` 可以跳过十回合等待，但不能跳过完整 block、provenance、增量 token 或 saving-ratio 资格；不满足时
  保持上一代投影并让后续 Working Set/Summary 路径处理压力。
- `cacheEpochId` 的计算继续包含 reclaim policy identity，并在 replay 已提交 commit 前重新验证它。不同 policy 的
  commit 不得复用为 `applied_commit`。

候选评估本身不改变 Provider payload；commit 仍只可由确实使用该 prepared artifact 的成功 normal primary 的封闭
terminal batch 推进。summary 的 cache-safe fork 与 L3 source 保持不变。

## 替代方案

- 每轮对任一刚满足最低 1024-token 候选立即提交：会造成小幅、连续的 prefix 改写和缓存抖动。
- 永远不再更新已提交的 L1：旧只读结果会无限积累，最终把压力全部交给 L3。
- 用非确定性时间窗口决定切换：重放和缓存身份不可审计。

## 后果

- L1 的首次节省门槛提高，低收益会话可能直接使用 raw、Working Set 或 Summary；这是有意的成本/缓存保护。
- 每次有效 L1 commit 的 token 收益更大，而稳定世代可在后续主请求中持续复用。
- 升级到 V3 时旧 V2 commit 不会被新策略复用；它只会以当前 raw state 重新评估，原始 transcript 不受影响。

## 回滚

关闭 `contextReclaimV1` 或设置 `compaction.reclaimMode=off` 即停止新的 L1 planning/application。没有删除或修改
transcript；旧 commit 只是不再用于 Provider 投影。
