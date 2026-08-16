# TUI useStaticContent 引用稳定性

状态：active
范围：`src/app/tui/render/useStaticContent.tsx`、`src/app/tui/App.tsx`、`src/app/tui/OutputArea.tsx`、`src/app/tui/components/BlockRenderer.tsx`、`src/app/tui/components/SubAgentBlock.tsx`、`src/app/tui/components/ConcurrentSubAgentBlock.tsx`
读取时机：修改 `useStaticContent` 缓存逻辑、新增 OutputBlock 类型、怀疑重复渲染/性能问题时必读。
验证：`bun test tests/tui-layout.test.tsx tests/tui-static-promote.test.tsx tests/tui-static-content.test.tsx`（验证 Static/Dynamic 分界、长回答渐进冻结、并发子 Agent 动态高度和重复渲染防重）

## 问题

### 根因

Reducer 每次 dispatch 都产生新的 `turns` 数组引用。无论内容是否变化，以下计算都在**每一帧**产生新引用：

```
turns (新引用, 每帧)
  → settledTurns = turns.slice(0,-1)  (新引用, 每帧)
  → activeTurn = turns.at(-1)         (新引用, 每帧)
    → useMemo([activeTurn])           (重新计算, 每帧)
      → activeSettledBlocks           (新数组, 每帧)
      → activeDynamicBlocks           (新数组, 每帧)
        → mergedStaticBlocks          (新数组, 每帧)
          → staticItems               (新数组, 每帧)
```

任何高频重渲染源（subagent 200ms timer、tool 80ms spinner、streaming text 更新）都会触发整条引用级联，导致：

1. `React.memo(BlockRenderer)` 被 `prevBlock` 新引用打败，永不命中
2. `<Static items={newArray}>` 每帧看到新引用，Ink 反复 diff 相同内容
3. Ink 的 `log-update` cursor 追踪在持续高频刷新下错位 → **重复行**

### 历史演进

| 提交 | 修了什么 | 为什么不够 |
|------|---------|-----------|
| `b244677` Static 提到 root 层 | 解决 Box(height=0) 内 Static 的 Yoga 追踪问题 | 换了位置，引用级联仍在；Static 外置后 terminal resize 时静态文本 width={columns} 锁定在渲染时刻，无法随容器自适应 |
| `a0075d5` 回退 b244677 | Static 退回 OutputArea 内 Box(height=0) | 恢复内嵌架构，解决 resize 自适应问题；引用级联由后续 fingerprint 缓存彻底修复 |
| `ce68456` DEC 同步输出 | 屏切换时原子显示 | 只覆盖 resize/会话切换路径 |
| `9078822` resizeGen + staticKey | resize 时重挂载 Static | 只覆盖 resize 路径 |
| `5ac73bb` Footer 高度跳变修复 | 修复特定布局变化路径 | 换一个 block 类型（subagent）又触发 |
| `ea03f80` 统一 block 间距 | 修复 block gap 不生效 | 无关，误归类 |

本质原因：每次修复都在打补丁——找到一个触发路径堵一个，但引用级联是全局的，任何新功能引入高频渲染都会重新暴露问题。

### `<Static>` 定位约束

`<Static>` 必须内嵌在 OutputArea 的 `Box(height=0)` 内，**禁止**外置到 App root 层。原因：

- `<Static>` 渲染的 block 使用 `width={columns}` 控制背景宽度
- `columns` 来自 `useWindowSize()`，终端 resize 时更新
- 若 `<Static>` 在 root 层，resize 触发 App remount → `<Static>` 重新输出 block 时 `columns` 可能尚未更新（`useWindowSize` state 与 `resizeKey` 更新不在同一微任务），导致静态文本宽度锁定在 resize 前的值
- 内嵌在 `Box(height=0)` 时，`<Static>` 随 OutputArea 生命周期受 Ink Yoga layout 管理

## 方案

### 核心思路

**放弃 useMemo 的依赖比较（`Object.is`），改用 ref + fingerprint 手动管理缓存生命周期。**

useMemo 的问题是它用 `Object.is` 比依赖——reducer 每帧产新引用，useMemo 永远认为依赖变了。ref 不受渲染周期控制，只在明确判定"内容变了"时才更新。

### 两级缓存

**1. Settled turn blocks — 按 Turn 身份和 fingerprint 缓存**

```
settledTurns.map(t => t.blocks.map(blockFingerprint).join(",")).join("|")
```

`turns.slice(0, -1)` 每次都会产生新数组，但未变的历史 `Turn` 保持引用身份。实现必须先逐项比较 Turn 引用；只有历史发生变化时才计算 fingerprint，并用 `WeakMap<Turn, string>` 缓存每个不可变 Turn 的 block walk。这样输入、状态栏和局部动画更新不会重新扫描整段历史的大文本、工具输出或 Thought caption。

最新 turn 在 run 结束时仍保留为 live tail，直到下一条用户消息建立新 turn；会话重挂载且空闲时才一次性把完整历史纳入 settled turns。live tail 内的不可变连续前缀仍逐块进入 Static。若尚未冻结的 block 之后发生状态变更（如取消投影将 subagent/running→error），fingerprint 变化 → ref 更新 → dynamic 投影正确重渲染。

原来用 turn count 作为缓存键，bug 是在取消场景下 block 状态变化但 count 不变，导致 `<Static>` 冻结 stale 数据。

**2. Active turn Static/Dynamic split — 按 block fingerprint 缓存**

```typescript
function blockFingerprint(b: OutputBlock): string {
  // "3:subagent:running:5"  (id:kind:status:stepCount)
  // "7:tool_card:done"
  // "1:text:f"              (流式完成)
  // "2:text:s:142"          (流式中, 142字符)
}
```

所有 block 的 fingerprint 拼成字符串 `"1:user:f,2:text:f,3:subagent:running:5,4:subagent:running:3"`。这个字符串只在 block 增删、状态迁移、step 增加时变化。timer tick、spinner 帧切换不改变它。

### 元素级引用比较

fingerprint 变化时重新计算 split 边界（leftmostUnsettled），但只在结果数组**逐元素引用不同**时才更新 ref：

```typescript
if (!blocksIdentical(activeSettledRef.current, nextSettled)) {
  activeSettledRef.current = nextSettled;
}
if (!blocksIdentical(activeDynamicRef.current, nextDynamic)) {
  activeDynamicRef.current = nextDynamic;
}
```

这保证了一个 block 状态变化（如 C: running→done）不会让 A、B 所在的数组引用不稳定。

### 三级防御

```
L1: fingerprint 字符串比较      → 拦截 timer/spinner 引起的无效计算
L2: blocksIdentical 逐元素比较  → 拦截 split 边界不变时的数组引用更新
L3: React.memo(BlockRenderer)  → 拦截未变化 block 的 React 子树渲染
```

| 场景 | L1 | L2 | L3 | 结果 |
|------|:--|:--|:--|------|
| subagent timer tick (200ms) | 命中（fingerprint 不变） | — | — | 仅 SubAgentBlock 内 Text 更新 |
| tool spinner / elapsed tick | 命中 | — | — | 仅 memo 的运行态 ToolCard 标题更新 |
| C running→done, A/B running | 不命中 → split 重算 | 命中（settled 组相同） | C block 引用变 → 渲染；A/B 引用不变 → 跳过 | 仅 C 重渲染 |
| 新 block 追加 | 不命中 → split 重算 | 不命中 | 新 block 渲染 | 新 block 渲染 |

### 并发子 Agent 的聚合与动态高度预算

引用稳定只能避免无意义的父树 diff；并发 child 的计时器和步骤更新仍会产生合法帧。Ink 7 在动态帧高度达到终端行数时会进入全屏清除路径，这会重置用户正在查看的原生 scrollback 位置。Runtime Executor 只为实际同批并发派发的 `task` sibling 在 `subagent.started` 上写入同一 `concurrencyGroupId`；TUI 不再从相邻 block 或 suspended 状态猜测并发。`OutputArea` 将该身份组投影为一个 memoized `ConcurrentSubAgentBlock`：折叠态保留组标题，并为每个 child 给出两行稳定活动摘要：角色/任务/状态（运行中含 child 自身的实时执行时长）以及当前未结算工具；没有活跃工具时该行明确显示正在等待第一个工具调用或下一步。组入口只在首个 child 前使用 `└─`，其余 child 标题与首条文字列对齐；每个 child 的第二行是该 child 唯一的 `└─` 明细，绝不画 `├─` 或竖线。Enter 展开时才渲染原 `SubAgentBlock` 步骤尾。`visibleDynamicBlocks` 与聚合后的 render items 必须按输入引用 memoize，避免 App 的无关更新重建整个活动组。组内先完成的 block 不单独进入 append-only Static，必须等待全组终态后作为单个摘要提升，防止已输出的 sibling 无法再聚合。`approvalState` 属于 Subagent fingerprint，保证 queued → auto-reviewing → awaiting-user 的卡片文案不被缓存为旧值。

展开态仍由 `App` 把 `useWindowSize().rows` 传给 `OutputArea`，多个 child 共享扣除 Footer、卡片固定行、Static→dynamic 顶部间距、OutputArea→Footer 的一行视觉间距和 block 间距后的步骤行预算，并额外保留一行 Ink 全屏阈值安全余量。小终端若无法容纳展开后的固定 child 结构，保持紧凑态并继续按行预算折叠 child 摘要；标题、摘要、折叠提示和完整步骤行用真实列数截断。任意文本/工具 block 不参与启发式估高；混合可变尾部对 child 步骤和摘要采用 0 行保守预算。折叠、聚合与预算只影响展示，完整步骤仍留在 TUI state 和 Runtime 事实中。

该策略只约束并发运行态的可变尾部，不引入 OutputArea 历史视口裁剪，不清除终端 scrollback。回归测试必须同时断言单 child 仍显示 5 步、并发组默认只显示 child 活动摘要、展开后各 child 仅显示预算内最新步骤、全组终态后只输出一条 Static 聚合摘要，且常规折叠帧低于终端高度。

## 新增 block 类型 Checklist

在 `OutputBlock` 联合类型中新增 variant 时，需要修改两处：

1. `blockFingerprint()` — 添加该类型的 fingerprint 逻辑（status/step 等可变字段）
2. `isSettled()` — 定义该类型何时不可变

## 验证

```bash
bun run typecheck
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx
# 手动验证 subagent 并发场景无重复渲染
bun run tui
```

## 关联文档

- [TUI DEC 同步输出](tui-dec-synchronized-output.md) — 覆盖 resize/会话切换的帧刷新
- [TUI 终端缩放刷新](tui-footer-resize-stability.md) — resize 事件与 key remount
