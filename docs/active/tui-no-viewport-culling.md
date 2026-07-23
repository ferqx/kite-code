# 当前规则：TUI 输出区域 Static/dynamic 分割渲染

状态：active
最后更新：2026-07-23（依据真实 TTY 能力启用 Ink 交互模式）
最后验证：2026-07-23
范围：

- `src/app/tui/index.tsx` — Ink 终端渲染选项
- `src/app/tui/OutputArea.tsx` — 输出区域组件
- `src/app/tui/App.tsx` — App 布局
- `src/app/tui/reducers/helpers.ts` — block 操作 helper 函数
- `src/app/tui/types.ts` — `Turn` 接口、`TuiState.turns`

读取时机：

- 修改 OutputArea.tsx 的渲染逻辑或 Static/dynamic 分割策略
- 修改 App.tsx 的容器高度或 overflow 属性
- 新增或修改 TUI 布局相关 e2e 场景
- 讨论是否引入视口剔除、虚拟滚动或 block 可见性控制
- 修改 block 组件或 reducer 逻辑
- 新增 block 类型（现在只需在 `handleEvent.ts` 和 `renderBlock` 中添加，无需改 split 逻辑）

相关：

- `execution/completed/2026-05-16-remove-viewport-culling.md`
- `execution/completed/2026-05-28-static-header-ordering-fix.md`
- `understanding/2026-05-12-tui-overhaul-design.md`
- `understanding/2026-06-03-tui-block-turn-model-design.md` — Turn 模型重构设计文档

验证：

- `bun run test:tui:system` — 验证真实 PTY 下输出区仍可交互、不会因视口变化崩溃
- `bun test tests/tui-layout.test.tsx` — 验证 OutputArea 渲染完整性
- `bun test tests/tui-reducer.test.ts` — 验证 reducer 引用稳定性
- `bun run tui` — 手动验证输入无卡顿、无空白区域

## 渲染架构

OutputArea 使用 `<Static>` / dynamic 分割，基于 **Turn 模型**：

1. 所有可以完成的消息 → `<Static>` 渲染一次写入终端 scrollback，从 React 树移除
2. 当前活跃 turn → 保留在 dynamic 树实时更新
3. `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，避免 Ink 布局占位产生空白
4. **分割策略**：`running ? turns.slice(0, -1) : turns`。执行中时最后一个 turn 在 dynamic 区，其余在 Static 区；空闲时全部在 Static 区
5. 分割点天然单调递增（settled turns 只会增多不会减少），无需 monotonic guard

## 为什么不用纯 React.memo 方案

Ink 的 `renderNodeToOutput` 每帧遍历整棵树生成输出字符串，开销与节点数 × 文本内容量成正比。在 Windows ConPTY 上这个开销被放大，导致每次按键的渲染超过帧预算（33ms@30fps）。React.memo 只跳过组件函数执行，但 Ink 的 layout + output 管线仍然遍历所有节点。`<Static>` 将已完成消息从树中移除，是唯一有效的优化。

## 规则

- 已完成的消息必须进入 `<Static>`，不得留在 dynamic 树
- 活跃消息（streaming/running/interrupt）必须留在 dynamic 树，不得进入 `<Static>`
- `<Static>` 容器必须用 `<Box height={0} overflow="hidden">` 包裹
- App 不得在 Footer 下方放置 `flexGrow={1}` 的 spacer（会导致 Footer 被推到终端底部，与 Static 消息之间产生空白）
- TUI 使用终端主屏缓冲区，`<Static>` 输出保留在终端原生 scrollback 中
- Ink 交互模式必须依据 `stdin.isTTY && stdout.isTTY` 显式决定，不得仅依赖 CI
  环境探测；CI 中真实 PTY 仍必须启用输入、增量渲染与终端控制
- 非 TTY 输入或输出不得强制启用 Ink 交互模式

## 不要做

- 不要在 OutputArea 中引入 `visibleStart` / `visibleEnd` 变量
- 不要使用 `blockLineEstimate` 或任何 block 行数估算逻辑
- 不要给 OutputArea 的 Box 设置 `overflow="hidden"`（Static 容器除外）
- 不要给 App 的根 Box 设置 `height="100%"`
- 不要实现基于 focusedIndex 的视口居中计算
- 不要在 `<Static>` 容器上省略 `height={0}`——会导致布局空白

## Overlay 面板的视口裁剪

**OutputArea 不能用视口裁剪，但 overlay 面板可以。** 区别在于：

- OutputArea：消息通过 `<Static>` 保留在终端原生 scrollback 中，不做应用内视口裁剪
- Overlay 面板（SessionSelector、ModelSelector 等）：固定高度、模态弹出、不需要 scrollback

因此 overlay 面板是 `ink-virtual-list` 的理想使用场景。VirtualList 通过 `items.slice(viewportOffset, viewportOffset + visibleCount)` 只渲染可见行，将 Yoga 树从 O(N) 降为 O(visibleCount)。

### SessionSelector 的 VirtualList 使用

```tsx
// 只需渲染视口内的 ~13 行，而非全部 50+ 行
<VirtualList<SessionInfo>
  items={sessions}
  selectedIndex={selected}
  renderItem={renderItem}
  keyExtractor={(s) => s.threadId}
  height={maxContentHeight}
  itemHeight={1}
  showOverflowIndicators={true}
/>
```

**renderItem 性能规则**：
- `stringWidth` / `truncateByDisplayWidth` 等 Unicode 字符串计算应在 renderItem 内做 —— VirtualList 只对可见行调用 renderItem，天然 O(visibleCount)
- 不要用 `useMemo` 预计算全部行的显示数据、然后把 selectedIndex 加入依赖 —— 方向键每帧都触发 O(N) 重算
- 颜色值等不变 props 用 ref 持有，避免 `useCallback` 依赖导致 renderItem 引用不稳定

### React.memo 在 Ink 中的局限性

React.memo 跳过组件函数执行，但 Ink 的 `renderNodeToOutput` 管线仍然遍历 Yoga 树中的所有节点。**减少 Yoga 节点数**（通过 VirtualList 的视口裁剪）是唯一有效的优化手段。这一原则同时适用于 OutputArea（用 `<Static>` 移除已完成节点）和 overlay 面板（用 VirtualList 只渲染可见行）。

## 测试期望

- viewport-culling.ts 中的回归测试验证所有 block 类型（user、tool_card、text）在渲染输出中可见
- tui-layout.test.tsx 中的测试验证 blocks 渲染完整性
- startup.test.ts 在 `CI=true` 的真实 PTY 中验证输入提示符仍可渲染
