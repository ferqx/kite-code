# TUI Run Status Bar — 3 阶段单向状态行

状态：active
范围：`src/app/tui/run-status.ts`、`src/app/tui/StatusBar.tsx`、`src/app/tui/App.tsx`、`src/app/tui/Footer.tsx`、`src/app/tui/reducers/handleEvent.ts`、`tests/run-status.test.ts`、`tests/tui-mock-render.test.tsx`、`tests/runtime/failure-taxonomy.test.ts`
读取时机：修改 StatusBar 渲染、run-status 推导逻辑、状态行动画、阶段切换规则时必读。
验证：`bun test tests/run-status.test.ts tests/tui-mock-render.test.tsx tests/runtime/failure-taxonomy.test.ts`

## 设计原则

**阶段单向推进（只进不退）：**

```
Thinking → Working → Finishing
```

agent 天然是 think → act → think → act 循环，若直接用当前动作做动词展示会导致状态行在 "Locating → Synthesizing → Running → Synthesizing" 之间反复横跳。改为 3 个大阶段后，阶段名只进不退，阶段内可变动词变化柔和。

## 阶段划分

| 阶段 | 触发条件 | 可见动词 | 主题色 |
|------|---------|---------|--------|
| Thinking | 启动后尚未调用任何工具 | Thinking / Planning | primary（蓝）静态 |
| Working | 第一个 tool_card / tool_summary / subagent / file_change 出现 | Working · Inspecting / Locating / Running / Changing / Delegating / Asking | 渐变动画（蓝→青→绿→金，5s 一轮） |
| Finishing | 兼容路径的 streaming text block 出现 | Finishing | success（绿）静态 |

**叠加态（覆盖阶段动词，但不改变阶段本身）：**
- Retry: `Retrying` + warning 色
- Approval 等待: `Waiting` + muted 色
- Input 等待: `Asking` + warning 色
- Context compaction: `preparing → summarizing → validating`，由 App-only action 驱动，不写 RuntimeEvent；所有终态和 stale 路径都在 `finally` 清除。手动 `/compact` 的动画紧跟命令以内联输出展示，不占用通用会话 StatusBar；自动压缩仍使用 StatusBar。
- Idle plan mode: `Shift+Tab to exit - describe your task` + muted 色

**阶段不变性规则**：一旦进入 Working，永不回退 Thinking；一旦进入 Finishing，永不回退 Working。

手动 `/compact` 不属于普通 Agent run。其 `compactionProgress.placement=inline` 时，`OutputArea` 在命令下方显示专用动画，`StatusBar` 保持隐藏；progress 清除后动画立即消失。自动压缩使用 `placement=status`，继续复用 StatusBar。

## 状态推导

`deriveRunStatusSnapshot(state, now)` 按优先级从 TuiState 推导：

1. 计算 `elapsedMs`（从 `runStartTime`）和 `runTokenDelta`（从 `runTokenBaseline`）
2. 如有 retryState → 返回 Retrying
3. 如有 interrupt → 返回 Waiting/Asking
4. `derivePhase()`：finishing（兼容路径仍有 streaming text）→ working（有 tool 活动）→ thinking。Runtime `model.text_delta` 的未闭合 Markdown 尾部不进入 block 树；完整块一旦提交即由 `shouldShowRunStatus` 按可见正常文本隐藏状态行。
5. 在 phase 内用 `currentVerb()` 推导具体动词
6. `formatRunStatusLine(snapshot, columns)` 做宽度自适配格式化

## Timer 性能架构

**禁止** `useEffect` 依赖 `runStatus?.elapsedMs`——工具输出会导致 App 重渲染，elapsedMs 每次变化，timer 被反复拆建导致动画卡顿。

正确做法：

```
| 职责 | 机制 | 触发条件 |
|------|------|---------|
| elapsed 基线同步 | useRef (startedAtRef) | 每次 App 渲染，仅写 ref |
| elapsed 推进 | setInterval @ 200ms | 仅依赖 [running] |
| spinner 推进 | recursive setTimeout | 每帧独立时长 |

// elapsed 同步——不触发重渲染，不影响 timer
useEffect(() => {
  if (running && runStatus?.elapsedMs != null) {
    startedAtRef.current = Date.now() - runStatus.elapsedMs;
  }
});

// elapsed timer——只跟 running 走
const elapsedTimer = setInterval(() => {
  setLiveElapsedMs(Date.now() - startedAtRef.current);
}, 200);

// spinner——每帧独立时长的 recursive setTimeout
const scheduleNext = (idx) => {
  const [, ms] = SPINNER[idx];
  spinnerTimer = setTimeout(() => {
    setSpinnerIdx((idx + 1) % SPINNER.length);
    scheduleNext((idx + 1) % SPINNER.length);
  }, ms);
};
```

## Spinner 设计

StatusBar 和工具卡片统一使用 `● ` 闪烁（1s 显、1s 隐，周期 2s），通过 `useBlinkDot` hook 集中管理。

StatusBar 额外使用宇宙符号呼吸动画（`· ⋆ ✦ ✧ ★ ✧ ✦ ⋆`，每帧变速，★ 处最慢 240ms，边缘最快 120ms，一圈约 1.5s），通过 recursive setTimeout 实现。

工具卡片（ToolCardBlock、SubAgentBlock、CompactionProgress、ToolSummaryBlock 的 BlinkDot）统一使用 `useBlinkDot` hook，不再各自维护 timer。

## 渐变动画

Working 阶段通过 `WORKING_GRADIENT` hex 色值在蓝→青→绿→金之间平滑插值（5s 一轮）。插值使用 `interpolateHex()` 做逐通道 RGB 线性混合。

首尾色值相同（`#569CD6`），保证循环无缝。

## App 可见性控制

`shouldShowRunStatus(state)` 决定状态行是否可见：
- 非 running 或中断 → 隐藏
- 手动 `/compact` 的 inline progress → 隐藏（动画由 `OutputArea` 展示）
- 最新可见 block 为正常文本 → 隐藏（文本已有，状态行冗余）
- retry 中 → 始终显示

`shouldShowRunStatus` 在渲染前调用，为 false 时跳过 `deriveRunStatusSnapshot()`。

## Context Footer 与终态提示

Runtime v19 的新终态通过共享 `projectTerminalOutcomeV1` 投影。TUI 只在
`outcome.status=completed` 时进入完成展示；`unknown`、`blocked`、`budget_exhausted` 和
`resource_saturated` 保持错误/警告终态，并使用结构化 `safeRetry`，不得从本地化 message
反推。没有 outcome 的历史事件继续按原 `recoverable` 字段回放。Headless CLI 对带 outcome 的
同一事件调用同一 mapper，并在 JSON 行中附加 `terminalPresentation`。

`StatsLine` 只读取 Core `ContextStatusSnapshot` 的 utilization；模型名称和累计 usage 不能推导 context 百分比。没有可信窗口但已有 snapshot 时，绝对 token 数必须显示同一 snapshot 的 `estimate.totalInputTokens`，与 `/context` 和压缩前后估算保持同一口径；仅在尚无 snapshot 时才兼容回退到累计 usage。`context.compaction_completed` 到达 App 后必须立即用 checkpoint 的 `inputTokensAfter` 刷新 snapshot 总量，并在窗口可信时重算 utilization，不能保留压缩前的 Footer 数字等待下一次模型调用。状态栏不持久展示历史压缩率（例如 `91% compacted`）；压缩收益只在一次性终态提示和诊断数据中保留。Completed、failed、cancelled 统一通过 Core 脱敏映射生成提示；TUI 以 `compactionId` 去重，每个压缩恰好显示一个不进入 transcript 的终态提示。Summary Provider 失败提示用户检查所选模型的 `contextWindowTokens` 或执行 `/clear`，不得展示 Provider 原始错误正文。

工具授权、用户提问或方案审核 interrupt 可见时，Footer 同时隐藏 `StatusBar` 与 `StatsLine`，
避免全局运行/模型状态和当前阻塞决策形成两条竞争底栏。统计数据继续保存在 State 中，
interrupt 结束后恢复展示，不得因临时隐藏而重置 cache、context 或 token 数。

进入或切换已有真实用户对话的历史会话时，App 必须从恢复后的 RuntimeState、active checkpoint 和当前 projection environment 本地重建一次 `ContextStatusSnapshot`；该过程不得调用 Provider。只包含 slash command 或没有 `user.message_appended` 的空会话不生成快照，避免把 system prompt 和工具目录估算显示成已有上下文。重建只替换 Footer 的 context snapshot，不重置或改写持久化的累计 cache hit/miss 与 usage 统计。若工具、MCP 或 Skill 环境随后变化，下一次标准 `model.context_metrics` 继续以 fresh projection 覆盖该快照。
