# ADR-0024：上下文压缩只保留 manual 与 auto，不以 token 比例阻断会话

状态：accepted
日期：2026-07-22
补充：ADR-0021、ADR-0022、ADR-0023
接受后替代：上述 ADR 中关于 `auto_soft`、`auto_hard`、本地 hard ratio 触发持久阻断以及可信窗口可证明 Provider admission 的决定
关联：`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`

## 术语

- `context window` 术语（Provider 实际接受的总上下文容量）。
- `trigger ratio` 术语（仅用于决定何时尝试自动压缩的本地估算比例）。
- `hard block` 术语（Runtime 持久化并阻止普通模型调用的状态）。
- `Provider admission` 术语（Provider 是否接受某次真实请求）。
- `Runtime correctness failure` 术语（Runtime 无法安全构造或恢复状态的内部正确性故障）。

## 背景

ADR-0021 至 ADR-0023 将自动压缩区分为 `auto_soft` 与 `auto_hard`，并允许可信 `contextWindow` 下的本地 hard ratio 触发 `ContextHardBlock`。该设计隐含三个前提：

1. Kite 知道当前 endpoint、route 和模型 alias 后面的真实窗口；
2. 本地 token estimate 足够准确；
3. 达到本地 hard ratio 等价于 Provider 一定拒绝请求。

这些前提在多 Provider 产品中不成立。供应商可以动态修改窗口，模型 alias 可以切换到不同后端，用户也不被要求配置真实窗口。Kite 已决定不解析通用 HTTP 400，因此客户端既不能从静态配置证明真实窗口，也不能从任意请求失败可靠反推窗口。

本地 hard ratio 会同时产生两类错误：

```text
本地假设 128K，Provider 实际 256K
→ 本地过早进入 auto_hard
→ 压缩失败后错误阻断本可继续的会话

本地假设 256K，Provider 实际 125K
→ 本地尚未达到 auto_hard
→ Provider 已经拒绝请求
```

因此，token ratio 只能作为提前尝试压缩的启发式，不能作为持久阻断的证明。

## 决策

### 1. 压缩原因只保留 manual 与 auto

持久事件、pending state、checkpoint、指标和测试统一使用：

```ts
type ContextCompactionReason = "manual" | "auto";
```

删除 `auto_soft`、`auto_hard`、`manual_recovery` 和 `overflow_recovery`。Manual 与 auto 只在触发来源和可选的用户侧重点数据上不同；safe boundary、M1 folding、summary request、candidate validation、event/effect 和 checkpoint activation 完全共用。

### 2. 自动阈值只决定是否尝试

自动策略收敛为：

```ts
interface AutoCompactionPolicy {
  enabled: boolean;
  triggerRatio?: number;
  triggerTokens?: number;
}
```

`triggerRatio` 只在存在显式配置或实际 adapter runtime metadata 时计算。`triggerTokens` 是用户选择的绝对本地阈值。两者都只回答“何时提前尝试一次压缩”，不回答 Provider 是否会接受下一次请求。

达到任一已启用阈值时：

```text
reason=auto
→ 尝试统一压缩管线
→ 成功：激活 checkpoint
→ 失败：记录 context.compaction_failed
→ 保留原上下文并继续交互
```

自动失败可以更新 cooldown 或 thrash breaker，但不得创建、保持或刷新 `ContextHardBlock`。

### 3. 删除 token hard gate

本地 `warningRatio`、`compactRatio` 或类似诊断可以继续用于 UI、遥测和 trigger policy，但不得：

- 生成 `auto_hard`；
- 阻止普通模型请求；
- 创建 durable hard block；
- 声称 Provider 一定会拒绝请求；
- 作为解除或保留 hard block 的条件。

普通调用是否被接受由真实 Provider 请求决定。即使本地 estimate 高于配置窗口，只要 Runtime 能安全构造请求，也允许发送。

### 4. Provider 错误不触发自动压缩或阻断

普通模型调用返回 HTTP 400 或其他 Provider failure 时：

```text
展示脱敏错误
→ session 保持可交互
→ 不推断 context overflow
→ 不自动压缩
→ 不创建 hard block
```

用户可以执行 `/compact`、切换模型、修改配置、rewind 或 clear。即使 adapter 未来提供结构化 overflow signal，也需要新 ADR 才能改变本决定。

### 5. Hard block 只保护 Runtime 正确性

`ContextHardBlock` 可以保留，但只能由 Kite 能确定证明的内部不变量故障产生，例如：

- canonical frame 无法保持 tool pairing；
- RuntimeState 与 event tail 被验证为 corrupted；
- snapshot/checkpoint 损坏且无法从原 transcript 安全恢复；
- 当前投影在任何允许的降级路径下都无法安全构造；
- reducer、lease 或状态机出现不可恢复的一致性违规。

这些原因必须表示 `Runtime correctness failure`，不能表示“上下文可能过大”。单次 stale result 只应丢弃，不能升级为 hard block；只有 Runtime 本身无法安全继续时才持久阻断。

建议的原因类型为：

```ts
type ContextHardBlockReason =
  | "unsafe_context_projection"
  | "corrupted_runtime_state"
  | "corrupted_event_tail"
  | "unrecoverable_checkpoint"
  | "runtime_invariant_violation";
```

具体集合可以在实现时收敛，但不得重新加入 token、ratio、Provider 400 或 compaction failure 原因。

### 6. Candidate 验证只判断压缩产物是否有效

Manual 与 auto 使用相同验收：

- source boundary、digest 和 lease 有效；
- summary 合格；
- tool pairing 完整；
- candidate 可以稳定序列化和 replay；
- 同一 estimator 下 `inputTokensAfter < inputTokensBefore`；
- 达到统一的最小绝对缩减。

Candidate 是否低于本地 target ratio 或 hard ratio 不影响 checkpoint activation，也不产生阻断。压缩后下一次普通请求仍由 Provider 实际决定是否接受。

### 7. 灰度不再区分 soft 与 hard

自动灰度模式只保留：

```ts
type ContextCompactionAutoMode = "off" | "shadow" | "live";
```

- `off`：不执行自动判断或自动压缩；
- `shadow`：只计算 trigger eligibility，不调用模型、不写 checkpoint；
- `live`：命中阈值后以 `reason=auto` 调用统一管线。

百分比分桶、allowlist 和 feature flag 继续用于受控发布，但不再存在 `soft_hard` 阶段或 hard cohort。

### 8. 开发期 schema 直接收敛

当前 agent 尚未正式上线，不为开发期 `auto_soft/auto_hard` snapshot 保留长期兼容 union。实现 PR 直接更新 fixture、snapshot 和测试；若需要读取开发数据，可将两个旧值确定性映射为 `auto`，但新代码和新持久数据不得继续生成旧值。

## 状态机

```text
正常运行
  │
  ├─ 本地启发式达到阈值
  │    → reason=auto
  │    → 成功：激活 checkpoint
  │    → 失败：记录失败，继续交互
  │
  ├─ 用户执行 /compact
  │    → reason=manual
  │    → 成功：激活 checkpoint
  │    → 失败：展示错误，继续交互
  │
  └─ Provider 返回任意错误
       → 展示错误
       → 不推断溢出
       → 不自动压缩
       → 不创建 hard block
```

Runtime correctness failure 使用独立的 invariant 检查和 hard-block event，不属于上述压缩原因状态机。

## 后果

### 正面后果

- 不会因为错误窗口或估算误差提前阻断会话；
- `ContextCompactionReason`、reducer、metrics、breaker 和测试矩阵显著简化；
- manual 与 auto 的算法和失败语义真正一致；
- Provider-neutral Core 不再把启发式估算提升为 admission 事实；
- 用户始终保留 `/compact`、切换模型、rewind 和 clear 等恢复路径。

### 负面后果

- 本地估算无法在 Provider 调用前保证请求一定成功；
- 供应商缩小窗口时，用户可能先看到一次 Provider 错误；
- 已知明显偏大的请求仍可能被发送并产生费用或延迟；
- hard block 不再承担容量保护，需要依赖自动提前压缩和清晰错误提示改善体验。

### 风险控制

- auto 默认关闭并分阶段灰度；
- 保留 trigger threshold、cooldown 和 thrash breaker；
- summary request 继续使用 bounded safe prefix 和应用级输入上限；
- Provider failure 后 session 必须保持可交互；
- 真实 Provider canary 观察失败率、3-turn refill 和重复压缩；
- Runtime correctness hard block 使用独立原因、独立测试和明确恢复动作。

## 实施门禁

1. 本 ADR accepted。
2. `ContextCompactionReason` 收敛为 `manual | auto`。
3. 删除 `auto_soft`、`auto_hard` 和所有 ratio-driven hard block 分支。
4. `ContextHardBlock` 原因收敛为 Runtime correctness failure。
5. 更新 ADR-0022/0023 的后续关系、active 文档、book、配置和计划。
6. 更新 Runtime round-trip、reducer、scheduler、metrics、TUI 和 E2E 测试。
7. 运行文档、类型、单元、Runtime E2E 和 TUI system 门禁。

## 回滚

关闭 `contextCompactionAutoV1` 可立即停止新的 auto 请求。回滚不得恢复 `auto_hard` 或 ratio-driven hard block；如果需要重新引入容量阻断，必须提供能够证明 Provider admission 的新证据并新增 ADR。
