# Ink `<Static>` 与 Header 顺序冲突修复

状态：completed
日期：2026-05-28
范围：

- `src/app/tui/OutputArea.tsx` — `<Static>` 渲染逻辑、Header 注入
- `src/app/tui/App.tsx` — Header 传递方式

关联：

- `ROADMAP.md` — "TUI 输入卡顿：用 Ink `<Static>` 将已完成 block 移出交互渲染树"
- `understanding/2026-05-26-tui-claude-code-parity-design.md` — Header/Body/Footer/Overlay 四层布局

## 问题

commit `035660a` 引入 Ink `<Static>` 优化：将已完成 block 移出交互渲染树，仅保留活跃 streaming block，减少按键时 reconciler + yoga-layout + diff 开销。

但 `<Static>` 组件的行为是：**内容始终渲染在交互树上方**（终端 scrollback 区域）。这导致：

```
实际输出顺序（错误）：
  completed blocks  ← <Static> 输出，在最上方
  Header (猫 ASCII) ← 交互树，在下方
  active blocks     ← 交互树
  Footer            ← 交互树
```

```
期望输出顺序：
  Header (猫 ASCII)
  completed blocks
  active blocks
  Footer
```

Header 出现在 body 内容下方，四层布局顺序被破坏。

## 根因

Ink 渲染管线（`renderer.js`）分两步输出：

1. `staticOutput` — 从 `rootNode.staticNode`（`<Static>` 的 `ink-box`）渲染，写入 stdout
2. `outputToRender` — 交互树输出（跳过 `internal_static` 节点），通过 `logUpdate` 写入

```js
// renderer.js
renderNodeToOutput(node, output, { skipStaticElements: true });  // 交互树，跳过 <Static>
renderNodeToOutput(node.staticNode, staticOutput, { skipStaticElements: false });  // <Static> 单独渲染

// ink.js — renderInteractiveFrame
this.options.stdout.write(staticOutput);   // 先写 static
this.log(outputToRender);                  // 再写 interactive
```

`<Static>` 内容始终在交互树上方，无法改变顺序。Header 在交互树中，必然出现在 `<Static>` 内容下方。

## 解决方案

将 Header 注入 `<Static>` 的 items 中，使其成为 staticOutput 的一部分：

```tsx
// 哨兵值：保证 items 始终 ≥1 项，Header 在无 completed block 时也能渲染
const HEADER_SENTINEL = { __header: true } as const;
const staticItems = [HEADER_SENTINEL, ...completedBlocks];

<Static key={sessionKey} items={staticItems}>
  {(item, index) => {
    if (index === 0) return <Header />;          // index 0 → Header
    return renderBlock(completedBlocks[index - 1]); // index 1+ → blocks
  }}
</Static>
```

终端输出顺序变为：
```
Header (猫 ASCII)     ← <Static> index 0
completed blocks      ← <Static> index 1+
active blocks         ← 交互树
Footer                ← 交互树
```

### 关键设计决策

1. **Header 不实时更新**：Header 作为 `<Static>` item 仅渲染一次，不反映 running/error 状态变化。但 Footer 的 StatusBar 已展示运行状态，Header 的猫表情仅是装饰性。

2. **`sessionKey` 控制 remount**：`<Static key={sessionKey}>` 在会话切换时强制 remount，重新渲染所有 item（含 Header），避免旧会话内容累积。Ink 的 `fullStaticOutput` 跨渲染累积，不清空会导致重复输出。

3. **`HEADER_SENTINEL` 保证非空**：`<Static>` 的 `items` 为空时不渲染任何内容。哨兵值确保 Header 始终存在，即使尚无 completed block。

## 验证

- `bun test tests/tui-reducer.test.ts` — 100 pass
- `bun test tests/tui-layout.test.tsx` — 91 pass
- 手动验证：`bun run tui` 确认 Header 在内容上方、`<Static>` 性能优化生效
