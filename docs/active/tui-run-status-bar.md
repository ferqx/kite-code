# TUI Run Status Bar — 3 阶段单向状态行

状态：active
范围：`src/app/tui/run-status.ts`、`src/app/tui/StatusBar.tsx`、`src/app/tui/App.tsx`、`src/app/tui/Footer.tsx`、`src/app/tui/reducers/handleEvent.ts`、`tests/run-status.test.ts`、`tests/tui-mock-render.test.tsx`、`tests/runtime/failure-taxonomy.test.ts`
读取时机：修改 StatusBar 渲染、run-status 推导逻辑、状态行动画、阶段切换规则时必读。
验证：`bun test tests/run-status.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx tests/tui-slash-command.test.ts tests/runtime/failure-taxonomy.test.ts tests/tui.test.ts tests/session-manager.test.ts`、`bun run scripts/run-tui-system-tests.ts cancel-successor-render compaction-status-input session-switch session-persistence`

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
- Subagent 审批暂停：block 状态切换为 `suspended`，并以 `approvalState` 区分 deferred queue、正在自动审查和等待用户；状态行分别显示 `Review queued`、`Auto-reviewing` 与 `Awaiting approval`，只有最后一种使用 warning 色并表示需要用户动作。自动或人工批准以及 replay 恢复后回到 `running`，取消同时覆盖 `running` 与 `suspended`。
- Input 等待: `Asking` + warning 色
- Context compaction: `preparing → summarizing → validating`，由 App-only progress action 驱动，不额外写 RuntimeEvent；所有终态和 stale 路径都在 `finally` 清除。手动与自动压缩都在消息区使用同一个内联动画；该动画不覆盖当前 Agent run 动词。
- Idle plan mode: `Shift+Tab to exit - describe your task` + muted 色

**阶段不变性规则**：一旦进入 Working，永不回退 Thinking；一旦进入 Finishing，永不回退 Working。

手动 `/compact` 不属于普通 Agent run，因此 `compactionProgress.source=manual` 时 `StatusBar` 隐藏。自动压缩发生在活跃用户 turn 内：持久化的 `context.compaction_requested(reason=auto)` 在消息列表投影为 `/auto-compact`，但该语义命令不注册到 slash-command parser，用户不能主动调用；`compactionProgress.source=automatic` 以内联动画补充当前 Agent run，不能替换或隐藏其 `StatusBar`。两种压缩都不得禁用 InputLine，压缩期间提交的提示词继续由 Runtime 单飞 barrier 串行。`compactionProgress` 只是当前展示会话的瞬时状态，不进入 session snapshot；加载、创建或切换会话时必须清除，不能让上一会话的残留 progress 影响恢复后的输入面。已接受的 `/compact` 与 `/auto-compact` 消息仍可从 RuntimeEvent 回放；预检拒绝的 `/compact` 仍在当前界面显示，但不会随会话重放。

## 状态推导

`deriveRunStatusSnapshot(state, now)` 按优先级从 TuiState 推导：

1. 计算 `elapsedMs`（从 `runStartTime`）和 `runTokenDelta`（从 `runTokenBaseline`）
2. 如有 retryState → 返回 Retrying
3. 如有 interrupt → 返回 Waiting/Asking；没有用户 interrupt 时，Subagent 的 `awaiting_user → auto_reviewing → queued` 按该优先级覆盖 Working 动词
4. `derivePhase()`：finishing（兼容路径仍有 streaming text）→ working（有 tool 活动）→ thinking。Runtime `model.text_delta` 的未闭合 Markdown 尾部不进入 block 树；完整块一旦提交即由 `shouldShowRunStatus` 按可见正常文本隐藏状态行。
5. 在 phase 内用 `currentVerb()` 推导具体动词
6. `formatRunStatusLine(snapshot, columns)` 做宽度自适配格式化

取消后的 successor 可在旧 run cleanup 期间先乐观进入 `running=true`。旧 run 的 generator 若在 AbortSignal 后无事件地正常关闭，仍不得派发 `SET_EXITED`；只有未取消、前台且正常完成的本轮 run 可以投影该终态。否则 successor 的 Bash/tool card 虽继续运行，StatusBar 会因 `running=false` 消失。PTY 回归要求 successor Shell 输出首帧出现时同时可见 Working · Running。

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
- 手动 `/compact` progress → 隐藏（动画由 `OutputArea` 展示）
- 自动 `/auto-compact` progress → 按普通 running 规则保留 Agent run 状态（压缩动画同时在 `OutputArea` 展示）
- 最新可见 block 为正常文本 → 隐藏（文本已有，状态行冗余）
- retry 中 → 始终显示

`shouldShowRunStatus` 在渲染前调用，为 false 时跳过 `deriveRunStatusSnapshot()`。

## Context Footer 与终态提示

Runtime v19 的新终态通过共享 `projectTerminalOutcomeV1` 投影。TUI 只在
`outcome.status=completed` 时进入完成展示；`unknown`、`blocked`、`budget_exhausted` 和
`resource_saturated` 保持错误/警告终态，并使用结构化 `safeRetry`，不得从本地化 message
反推。没有 outcome 的历史事件继续按原 `recoverable` 字段回放。Headless CLI 对带 outcome 的
同一事件调用同一 mapper，并在 JSON 行中附加 `terminalPresentation`。

`StatsLine` 只读取 Core `ContextStatusSnapshot` 的 utilization；模型名称和累计 usage 不能推导 context 百分比。没有可信窗口但已有 snapshot 时，绝对 token 数必须显示同一 snapshot 的 `estimate.totalInputTokens`，与 `/context` 和压缩前后估算保持同一口径；仅在尚无 snapshot 时才兼容回退到累计 usage。`context.compaction_completed` 到达 App 后必须立即用 checkpoint 的 `inputTokensAfter` 刷新 snapshot 总量，并在窗口可信时重算 utilization，不能保留压缩前的 Footer 数字等待下一次模型调用。状态栏不持久展示历史压缩率（例如 `91% compacted`）；压缩收益只在一次性终态提示和诊断数据中保留。Completed、failed、cancelled 统一通过 Core 脱敏映射生成提示；TUI 以 `compactionId` 去重，每个压缩恰好显示一个不进入 transcript 的终态提示。低收益 manual rejection 作为普通提示，不渲染为通用 `Recoverable error`；stale、输入过大、输出不可用、checkpoint validation 和 Provider 请求失败使用各自的脱敏建议。Provider 请求失败不得展示原始错误正文，也不得只假设 `contextWindowTokens` 是唯一原因。

缓存命中率的数值和 `cache` 单位标签必须使用同一随命中率变化的颜色，作为一个完整指标；二者之间不得因颜色不同产生视觉断裂。

除非所选模型配置显式设定 `reasoning: false`，否则只要 `status.thinkingMode` 已设置，`StatsLine` 必须在宽度允许时紧跟模型名显示该强度；不得以 provider 标识（例如 `deepseek`）作为显示条件，因为兼容端点或自定义路由也可以承载同一模型和推理强度。

方案审核通过后，`StatsLine` 的模式标签必须立即采用持久化 `plan.approved.executionMode`：选择 Auto 显示“自动审批”，选择 accept_edits 显示“接受编辑”。同一投影必须进入会话快照和历史回放，避免切换会话或重启后恢复旧标签。

工具授权、用户提问或方案审核 interrupt 可见时，Footer 同时隐藏 `StatusBar` 与 `StatsLine`，
避免全局运行/模型状态和当前阻塞决策形成两条竞争底栏。统计数据继续保存在 State 中，
interrupt 结束后恢复展示，不得因临时隐藏而重置 cache、context 或 token 数。

进入或切换已有真实用户对话的历史会话时，App 必须从恢复后的 RuntimeState、active checkpoint 和当前 projection environment 本地重建一次 `ContextStatusSnapshot`；该过程不得调用 Provider。只包含 slash command 或没有 `user.message_appended` 的空会话不生成快照，避免把 system prompt 和工具目录估算显示成已有上下文。重建只替换 Footer 的 context snapshot，不重置或改写持久化的累计 cache hit/miss 与 usage 统计。若工具、MCP 或 Skill 环境随后变化，下一次标准 `model.context_metrics` 继续以 fresh projection 覆盖该快照。
