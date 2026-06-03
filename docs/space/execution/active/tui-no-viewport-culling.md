# 当前规则：TUI 输出区域 Static/dynamic 分割渲染

状态：active
最后更新：2026-06-03（恢复 Static 方案，用 height=0 消除布局空白）
最后验证：2026-06-03
范围：

- `src/app/tui/OutputArea.tsx` — 输出区域组件
- `src/app/tui/App.tsx` — App 布局

读取时机：

- 修改 OutputArea.tsx 的渲染逻辑或 Static/dynamic 分割策略
- 修改 App.tsx 的容器高度或 overflow 属性
- 新增或修改 TUI 布局相关 e2e 场景
- 讨论是否引入视口剔除、虚拟滚动或 block 可见性控制
- 修改 block 组件或 reducer 逻辑

相关：

- `execution/completed/2026-05-16-remove-viewport-culling.md`
- `execution/completed/2026-05-28-static-header-ordering-fix.md`
- `understanding/2026-05-12-tui-overhaul-design.md`

验证：

- `bun test tests/e2e/scenarios/viewport-culling.ts` — 验证所有 block 始终可见
- `bun test tests/tui-layout.test.tsx` — 验证 OutputArea 渲染完整性
- `bun test tests/tui-reducer.test.ts` — 验证 reducer 引用稳定性
- `bun run tui` — 手动验证输入无卡顿、无空白区域

## 渲染架构

OutputArea 使用 `<Static>` / dynamic 分割：

1. **已完成的消息** → `<Static>` 渲染一次写入终端 scrollback，从 React 树移除
2. **活跃消息**（streaming text、running tool/subagent、pending approval/question）→ 保留在 dynamic 树实时更新
3. `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，避免 Ink 布局占位产生空白
4. 分割点由当前 turn 中最早的活跃 block 决定（单调递增，防止 block 在 Static/dynamic 之间振荡）
5. Agent 空闲时整个 turn 原子性地 flush 到 Static

## 为什么不用纯 React.memo 方案

Ink 的 `renderNodeToOutput` 每帧遍历整棵树生成输出字符串，开销与节点数 × 文本内容量成正比。在 Windows ConPTY 上这个开销被放大，导致每次按键的渲染超过帧预算（33ms@30fps）。React.memo 只跳过组件函数执行，但 Ink 的 layout + output 管线仍然遍历所有节点。`<Static>` 将已完成消息从树中移除，是唯一有效的优化。

## 规则

- 已完成的消息必须进入 `<Static>`，不得留在 dynamic 树
- 活跃消息（streaming/running/interrupt）必须留在 dynamic 树，不得进入 `<Static>`
- `<Static>` 容器必须用 `<Box height={0} overflow="hidden">` 包裹
- App 不得在 Footer 下方放置 `flexGrow={1}` 的 spacer（会导致 Footer 被推到终端底部，与 Static 消息之间产生空白）
- 终端原生 scrollback 是唯一的滚动机制

## 不要做

- 不要在 OutputArea 中引入 `visibleStart` / `visibleEnd` 变量
- 不要使用 `blockLineEstimate` 或任何 block 行数估算逻辑
- 不要给 OutputArea 的 Box 设置 `overflow="hidden"`（Static 容器除外）
- 不要给 App 的根 Box 设置 `height="100%"`
- 不要实现基于 focusedIndex 的视口居中计算
- 不要在 `<Static>` 容器上省略 `height={0}`——会导致布局空白

## 测试期望

- viewport-culling.ts 中的回归测试验证所有 block 类型（user、tool_card、text）在渲染输出中可见
- tui-layout.test.tsx 中的测试验证 blocks 渲染完整性
