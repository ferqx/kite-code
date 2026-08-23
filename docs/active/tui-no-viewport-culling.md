# 当前规则：TUI 输出区域 Static/dynamic 分割渲染

状态：active
最后更新：2026-08-15（并发子 Agent 在折叠聚合卡中显示当前工具、单独耗时和单分支层级）
最后验证：2026-08-15
范围：

- `apps/kite/src/tui/index.tsx` — Ink 终端渲染选项
- `apps/kite/src/tui/OutputArea.tsx` — 输出区域组件
- `apps/kite/src/tui/components/ConcurrentSubAgentBlock.tsx` — 并发 child 聚合卡
- `apps/kite/src/tui/App.tsx` — App 布局
- `apps/kite/src/tui/reducers/handleEvent.ts` — 并发组事件投影
- `apps/kite/src/tui/render/useStaticContent.tsx` — 并发组的原子 Static 提升
- `apps/kite/src/tui/reducers/helpers.ts` — block 操作 helper 函数
- `apps/kite/src/tui/types.ts` — `Turn` 接口、`TuiState.turns`
- `apps/kite/src/runtime/tool-execution/router.ts`、`packages/agent-kernel/src/events.ts` — Runtime 并发派发身份

读取时机：

- 修改 OutputArea.tsx 的渲染逻辑或 Static/dynamic 分割策略
- 修改 App.tsx 的容器高度或 overflow 属性
- 新增或修改 TUI 布局相关 e2e 场景
- 讨论是否引入视口剔除、虚拟滚动或 block 可见性控制
- 修改 block 组件或 reducer 逻辑
- 新增 block 类型（现在只需在 `handleEvent.ts` 和 `renderBlock` 中添加，无需改 split 逻辑）

相关：

- `../adr/0040-streaming-markdown-progressive-static-freeze.md`
- `../space/execution/completed/2026-05-16-remove-viewport-culling.md`
- `../space/execution/completed/2026-05-28-static-header-ordering-fix.md`
- `../space/understanding/2026-05-12-tui-overhaul-design.md`
- `../space/understanding/2026-06-03-tui-block-turn-model-design.md` — Turn 模型重构设计文档

验证：

- `bun run test:tui:system` — 验证真实 PTY 下输出区仍可交互、不会因视口变化崩溃
- `bun run scripts/run-tui-system-tests.ts interrupt` — 验证可见 Thought 取消后用户提示词在 scrollback 中只出现一次
- `bun test tests/tui-layout.test.tsx` — 验证 OutputArea 渲染完整性
- `bun test tests/tui-reducer.test.ts` — 验证 reducer 引用稳定性
- `bun test tests/tui-layout.test.tsx tests/tui-static-promote.test.tsx tests/tui-static-content.test.tsx` — 验证长回答只保留可变尾部、并发子 Agent 动态帧保持低于 Ink 全屏清除阈值
- `bun test tests/tui-tool-progress.test.ts tests/session-manager.test.ts tests/stream-output.test.ts` — 验证高输出工具只按帧投影有界 tail、后台不丢终态且执行期 capture 有硬上限
- `bun run tui` — 手动验证输入无卡顿、无空白区域

## 渲染架构

OutputArea 使用 `<Static>` / dynamic 分割，基于 **Turn 模型**：

1. 所有可以完成的消息 → `<Static>` 渲染一次写入终端 scrollback，从 React 树移除
2. 当前活跃 turn → 保留在 dynamic 树实时更新
3. `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，避免 Ink 布局占位产生空白
4. **分割策略**：比最新 live tail 更早的 turn 全部进入 Static；最新 turn 在运行结束后仍保持 live tail，直到下一条用户消息建立新 turn，避免 Windows 主屏在终态同帧 Static/dynamic 交接时留下重复帧。会话重挂载且空闲时，完整历史可一次性进入 Static。
5. live tail 在 run 仍为 running 时按连续不可变前缀渐进分割；分割点只能向后移动，已经提交的完整 Markdown text block 和已经结算的 Thought/tool summary 必须立即进入 Static，不得因后续还有相邻 text block 而留在 dynamic。run 因完成或取消进入 idle 的终止帧不得继续推进分割点：已经提交的 Static 前缀保持不变，新结算的 Thought/工具/文本后缀继续留在 dynamic，直到 successor turn 或会话 remount 接管历史提升。尤其取消纯思考阶段时，不得把刚结算的 Thought 连同已显示的用户提示词再次写入 append-only Static。
6. 长流式 Markdown 不得始终作为一个不断增高的 dynamic block：已经出现后继内容的完整顶层组件，在 fenced code 之外的空行边界冻结为 settled text block 并进入 `<Static>`；只有当前仍可能变形的 Markdown 组件留在 dynamic tree。这样表格、列表、代码块不会从中间拆开，同时避免 dynamic 输出超过终端高度后 Ink 每帧整屏清除并重置用户的原生滚动位置。
7. Scheduler/Executor 只为同一次实际获准的并发 `task` 批次在 `subagent.started` 上写入同一 `concurrencyGroupId`；串行、审批后单独恢复或不同 wave 不得由 TUI 猜测成一组。TUI reducer 只透传该身份，`OutputArea` 把组渲染为一张 Thought-like `Delegating · N agents` 卡片：折叠态为每个 child 固定保留两行，第一行展示角色、任务摘要和当前状态（`进行中 (Xs)` 使用该 child 的实际开始时间），第二行展示当前未结算工具；无活跃工具时显示等待第一个工具调用或下一步。组入口只在首个 child 前使用 `└─`，其余 child 标题对齐；每个 child 的明细行使用自己的 `└─`，不得使用 `├─` 或竖线。Enter 展开后才渲染原始工具步骤尾。组内先结束的 child 必须留在 dynamic suffix，直到所有 sibling 进入终态后以一条 `Delegated` 摘要进入 append-only Static；摘要必须把成功明确写为 `succeeded`，并单列 `failed`/`cancelled`，不得把“已结束”或失败 child 表述为完成。终态圆点保留自身状态色；`Delegated` 汇总标题使用与普通已结算工具相同的弱化文本色，不以成功色或主题主色高亮。展开态按 `useWindowSize().rows` 共享步骤行预算，并把 Static→dynamic 的顶部间距计入固定高度；折叠态的 child 可见数也必须按每 child 两行预算。若终端连 child 标题/折叠计数/终态行的固定结构都容纳不下，展开请求保持紧凑态，并按可用行数折叠 child 摘要。组标题、child 摘要、折叠提示和展开步骤整行都必须按真实终端列数截断；不得使用虚拟最小宽度或让长工具名自动换行。可变尾部混有任意文本/工具 block 时，child 步骤和摘要预算保守降为 0。折叠、聚合和小终端降级只影响展示，不得删除 reducer/Runtime 中的完整步骤。

## 为什么不用纯 React.memo 方案

Ink 的 `renderNodeToOutput` 每帧遍历整棵树生成输出字符串，开销与节点数 × 文本内容量成正比。在 Windows ConPTY 上这个开销被放大，导致每次按键的渲染超过帧预算（33ms@30fps）。React.memo 只跳过组件函数执行，但 Ink 的 layout + output 管线仍然遍历所有节点。`<Static>` 将已完成消息从树中移除，是唯一有效的优化。

## 规则

- 已完成的消息必须进入 `<Static>`，不得留在 dynamic 树
- 用户消息在发送后保留首尾上下文：按终端视觉宽度换行后最多显示 30 行实际内容，超过时保留前后各 15 行，并在中间以弱化文本色提示 `【已省略 N 行】`；提示不计入 30 行，也不保留额外空行。完整内容仍保留在 Runtime 请求与会话持久化中；单条消息最多创建 31 个行节点。
- 新提交且尚无后续 block 的用户消息暂留 dynamic 区；首个后续 block 到达后才进入 Static，避免长消息提交时 Static/dynamic 交接导致终端整屏短暂清空。
- 活跃消息（streaming/running/interrupt）必须留在 dynamic 树，不得进入 `<Static>`
- 并发子 Agent 默认必须使用单个 Thought-like 聚合卡；卡片与 Footer/Working 状态之间保留一个空白行，展开时步骤尾上限随终端行数自适应，折叠与聚合只影响展示，不得删除 reducer/Runtime 中的步骤
- 已提交的相邻 text blocks 是 append-only 前缀；不得把“相邻文本可能合并”作为阻止渐进冻结的理由
- 正常长回答的 dynamic 后缀必须只包含仍可变化的当前组件，不能随已提交段落数线性增长
- 流式文本只允许冻结 fenced code 之外、已有后继内容的空行边界；不得在未闭合代码块内部拆分，也不得冻结仍处于尾部的 Markdown 组件
- `<Static>` 容器必须用 `<Box height={0} overflow="hidden">` 包裹
- App 不得在 Footer 下方放置 `flexGrow={1}` 的 spacer（会导致 Footer 被推到终端底部，与 Static 消息之间产生空白）
- TUI 使用终端主屏缓冲区，`<Static>` 输出保留在终端原生 scrollback 中
- Ink 交互模式必须依据 `stdin.isTTY && stdout.isTTY` 显式决定，不得仅依赖 CI
  环境探测；CI 中真实 PTY 仍必须启用输入、增量渲染与终端控制
- 非 TTY 输入或输出不得强制启用 Ink 交互模式

## 不要做

- 不要在 OutputArea 中引入 `visibleStart` / `visibleEnd` 变量
- 不要为任意 OutputBlock 使用 `blockLineEstimate` 或其他启发式行数估算；并发 Subagent 预算只可使用卡片自身的固定结构行
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
  showOverflowIndicators={false}
/>
```

会话面板自己在标题栏显示当前位置/总数，方向键导航会自动调整虚拟列表窗口，因此不得再展示
`ink-virtual-list` 的 `N more` 默认溢出行。默认文案会挤占内容高度、与标题栏计数重复，并造成
中英文视觉不一致；隐藏文案不改变虚拟滚动和 O(visibleCount) 的性能边界。

**renderItem 性能规则**：
- `stringWidth` / `truncateByDisplayWidth` 等 Unicode 字符串计算应在 renderItem 内做 —— VirtualList 只对可见行调用 renderItem，天然 O(visibleCount)
- 不要用 `useMemo` 预计算全部行的显示数据、然后把 selectedIndex 加入依赖 —— 方向键每帧都触发 O(N) 重算
- 颜色值等不变 props 用 ref 持有，避免 `useCallback` 依赖导致 renderItem 引用不稳定

### React.memo 在 Ink 中的局限性

React.memo 跳过组件函数执行，但 Ink 的 `renderNodeToOutput` 管线仍然遍历 Yoga 树中的所有节点。**减少 Yoga 节点数**（通过 VirtualList 的视口裁剪）是唯一有效的优化手段。这一原则同时适用于 OutputArea（用 `<Static>` 移除已完成节点）和 overlay 面板（用 VirtualList 只渲染可见行）。

## 测试期望

- `tui-static-promote.test.tsx` 和 `tui-static-content.test.tsx` 验证 Static/dynamic 分界与历史内容完整性
- `tui-layout.test.tsx` 验证 blocks 渲染完整性及并发子 Agent 的动态高度预算
- startup.test.ts 在 `CI=true` 的真实 PTY 中验证输入提示符仍可渲染
