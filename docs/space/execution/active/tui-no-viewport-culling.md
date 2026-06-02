# 当前规则：TUI 输出区域永不裁剪

状态：active
最后更新：2026-06-02（移除 `<Static>`，改为 React.memo 方案）
最后验证：2026-06-02
范围：

- `src/app/tui/OutputArea.tsx` — 输出区域组件
- `src/app/tui/App.tsx` — App 布局（容器高度约束）

读取时机：

- 修改 OutputArea.tsx 的渲染逻辑或 block 过滤行为
- 修改 App.tsx 的容器高度或 overflow 属性
- 新增或修改 TUI 布局相关 e2e 场景
- 讨论是否引入视口剔除、虚拟滚动或 block 可见性控制
- 修改 block 组件 memo 策略或 reducer 引用稳定性逻辑

相关：

- `execution/completed/2026-05-16-remove-viewport-culling.md`
- `execution/completed/2026-05-28-static-header-ordering-fix.md`（superseded）
- `understanding/2026-05-12-tui-overhaul-design.md`
- `docs/superpowers/plans/2025-06-02-remove-static-perf.md`

验证：

- `bun test tests/e2e/scenarios/viewport-culling.ts` — 验证所有 block 始终可见
- `bun test tests/tui-layout.test.tsx` — 验证 OutputArea 渲染完整性
- `bun test tests/tui-reducer.test.ts` — 验证 reducer 引用稳定性

## 规则

- OutputArea 必须始终渲染 `blocks` 数组中的所有 block，不得遗漏
- 性能优化通过 React.memo block 组件 + reducer 引用稳定性实现：未变化的 block 不重新渲染，等价于 `<Static>` 的优化效果
- App 容器不得设置 `overflow="hidden"`，允许内容自然溢出到终端缓冲区
- 终端原生 scrollback 是唯一的滚动机制；不得在 Ink 层面实现虚拟滚动或视口剔除
- ↑ ↓ 键仅用于移动 `focusedIndex`（控制 ❯ 视觉指示器），不改变可见范围
- Enter 键保留用于展开/折叠 reason block
- App 根 Box 采用 compact 布局（无 flexGrow wrapper），Footer + spacer 确保终端高度稳定

## 不要做

- 不要在 OutputArea 中引入 `visibleStart` / `visibleEnd` 变量
- 不要使用 `blockLineEstimate` 或任何 block 行数估算逻辑
- 不要给 OutputArea 的 Box 设置 `overflow="hidden"`
- 不要给 App 的根 Box 设置 `height="100%"`
- 不要实现基于 focusedIndex 的视口居中计算
- 不要重新引入 `<Static>` 组件——React.memo + 引用稳定 reducer 已提供等效性能

## 测试期望

- viewport-culling.ts 中的回归测试验证所有 block 类型（user、tool_card、text）在渲染输出中可见
- tui-layout.test.tsx 中的测试验证 blocks.map 渲染所有 block，不做过滤
