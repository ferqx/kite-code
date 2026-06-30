# TUI Run Status Bar — 3 阶段单向状态行

状态：active
范围：`src/app/tui/run-status.ts`、`src/app/tui/StatusBar.tsx`、`src/app/tui/App.tsx`、`src/app/tui/Footer.tsx`、`tests/run-status.test.ts`、`tests/tui-mock-render.test.tsx`
读取时机：修改 StatusBar 渲染、run-status 推导逻辑、状态行动画、阶段切换规则时必读。

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
| Finishing | 流式文本 block 出现 | Finishing | success（绿）静态 |

**叠加态（覆盖阶段动词，但不改变阶段本身）：**
- Retry: `Retrying` + warning 色
- Approval 等待: `Waiting` + muted 色
- Input 等待: `Asking` + warning 色
- Idle plan mode: `Shift+Tab to exit - describe your task` + muted 色

**阶段不变性规则**：一旦进入 Working，永不回退 Thinking；一旦进入 Finishing，永不回退 Working。

## 状态推导

`deriveRunStatusSnapshot(state, now)` 按优先级从 TuiState 推导：

1. 计算 `elapsedMs`（从 `runStartTime`）和 `runTokenDelta`（从 `runTokenBaseline`）
2. 如有 retryState → 返回 Retrying
3. 如有 interrupt → 返回 Waiting/Asking
4. `derivePhase()`：finishing（有 streaming text）→ working（有 tool 活动）→ thinking
5. 在 phase 内用 `currentVerb()` 推导具体动词
6. `formatRunStatusLine(snapshot, columns)` 做宽度自适配格式化

## Timer 性能架构

**禁止** `useEffect` 依赖 `runStatus?.elapsedMs`——工具输出会导致 App 重渲染，elapsedMs 每次变化，timer 被反复拆建导致动画卡顿。

正确做法：

```
| 职责 | 机制 | 触发条件 |
|------|------|---------|
| elapsed 基线同步 | useRef (startedAtRef) | 每次 App 渲染，仅写 ref |
| 动画推进 | 单一 setInterval @ 100ms | 仅依赖 [running] |

// elapsed 同步——不触发重渲染，不影响 timer
useEffect(() => {
  if (running && runStatus?.elapsedMs != null) {
    startedAtRef.current = Date.now() - runStatus.elapsedMs;
  }
});

// 动画 timer——只跟 running 走
useEffect(() => {
  timer = setInterval(/* 驱动 spinner + elapsed + color */, 100);
  return () => clearInterval(timer);
}, [running]);
```

React 18 批处理将同一次 callback 中的多个 setState 合并为单次渲染。每 100ms 仅产生 1 次渲染。

## Spinner 设计

弧线旋转 `◜ ◝ ◞ ◟`（4 帧，100ms/frame，400ms 一圈）。

- 与 shell/subagent 的 Braille 点阵（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，10 帧，80ms/frame）完全区分——弧线 vs 点阵、4 帧 vs 10 帧、400ms vs 800ms 周期。
- Unicode 仅定义了这 4 个象限弧线字符（U+25DC–U+25DF），无法增加中间帧。

## 渐变动画

Working 阶段通过 `WORKING_GRADIENT` hex 色值在蓝→青→绿→金之间平滑插值（5s 一轮）。插值使用 `interpolateHex()` 做逐通道 RGB 线性混合。

首尾色值相同（`#569CD6`），保证循环无缝。

## App 可见性控制

`shouldShowRunStatus(state)` 决定状态行是否可见：
- 非 running 或中断 → 隐藏
- 最新可见 block 为正常文本 → 隐藏（文本已有，状态行冗余）
- retry 中 → 始终显示

`shouldShowRunStatus` 在渲染前调用，为 false 时跳过 `deriveRunStatusSnapshot()`。
