# TUI useStaticContent 引用稳定性

状态：active
范围：`src/app/tui/render/useStaticContent.tsx`、`src/app/tui/App.tsx`、`src/app/tui/OutputArea.tsx`、`src/app/tui/components/BlockRenderer.tsx`
读取时机：修改 `useStaticContent` 缓存逻辑、新增 OutputBlock 类型、怀疑重复渲染/性能问题时必读。

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
| `b244677` Static 提到 root 层 | 解决 Box(height=0) 内 Static 的 Yoga 追踪问题 | 换了位置，引用级联仍在 |
| `ce68456` DEC 同步输出 | 屏切换时原子显示 | 只覆盖 resize/会话切换路径 |
| `9078822` resizeGen + staticKey | resize 时重挂载 Static | 只覆盖 resize 路径 |
| `5ac73bb` Footer 高度跳变修复 | 修复特定布局变化路径 | 换一个 block 类型（subagent）又触发 |
| `ea03f80` 统一 block 间距 | 修复 block gap 不生效 | 无关，误归类 |

本质原因：每次修复都在打补丁——找到一个触发路径堵一个，但引用级联是全局的，任何新功能引入高频渲染都会重新暴露问题。

## 方案

### 核心思路

**放弃 useMemo 的依赖比较（`Object.is`），改用 ref + fingerprint 手动管理缓存生命周期。**

useMemo 的问题是它用 `Object.is` 比依赖——reducer 每帧产新引用，useMemo 永远认为依赖变了。ref 不受渲染周期控制，只在明确判定"内容变了"时才更新。

### 两级缓存

**1. Settled turn blocks — 按 fingerprint 缓存**

```
settledTurns.map(t => t.blocks.map(blockFingerprint).join(",")).join("|")
```

当 `running` 从 true 翻转为 false 时，active turn 移入 settled turns。若其中 block 之后发生状态变更（如 `cancelRunningBlocks` 将 subagent/running→error），turn count 不变但 fingerprint 变化 → ref 更新 → `<Static>` 正确重渲染。

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
| tool spinner tick (80ms) | 命中 | — | — | 仅 ToolCardBlock 内 Text 更新 |
| C running→done, A/B running | 不命中 → split 重算 | 命中（settled 组相同） | C block 引用变 → 渲染；A/B 引用不变 → 跳过 | 仅 C 重渲染 |
| 新 block 追加 | 不命中 → split 重算 | 不命中 | 新 block 渲染 | 新 block 渲染 |

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

- [[tui-dec-synchronized-output]] — DEC 同步输出缓冲，覆盖 resize/会话切换的帧刷新
- [[tui-footer-resize-stability]] — 终端缩放刷新方案（resize 事件 + key remount）
