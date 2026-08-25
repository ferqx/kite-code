# TUI 终端缩放刷新方案

状态：active

读取时机：修改 Footer、高度测量、窗口 resize、InputLine 或 overlay 布局，或怀疑缩放行为异常时。

验证：`bun test tests/tui-layout.test.tsx tests/tui-extra-space.test.tsx tests/tui-system/scenarios/resize.test.ts`。
范围：`apps/kite/src/tui/index.tsx`、`apps/kite/src/tui/components/InputLine.tsx`、`apps/kite/src/tui/components/OverlayFrame.tsx`、`apps/kite/src/tui/components/OverlayChoiceList.tsx`、`apps/kite/src/tui/components/OverlaySearchInput.tsx`、`apps/kite/src/tui/components/ApprovalBlock.tsx`、`apps/kite/src/tui/components/InputBlock.tsx`、`apps/kite/src/tui/components/PlanReviewBlock.tsx`、`apps/kite/src/tui/hooks/useOverlayHeight.ts`、`apps/kite/src/tui/hooks/useSlashSuggestions.ts`、`apps/kite/src/tui/render/useStaticContent.tsx`

## 最终方案（2026-06-15）

### 原理

终端缩放时 Ink 产生重复输出的根因：拖拽过程中终端发送 N 次 `SIGWINCH`，Ink 内部 `resized` handler 每次都触发 `onRender()`，但只在宽度变窄时调用 `this.log.clear()`。宽度变宽时旧帧叠加，且 `log-update` 的坐标跟踪在终端 resize 后错位。

**当前方案不跟 Ink 内部打，而是在终端宽度收窄时做全量 rebuild：**

1. 监听 `process.stdout.on("resize")`，仅当 `process.stdout.columns` 比前一次更小时才触发
2. 仅高度变化和宽度变宽都不触发：`<Flex>` 自动适应高度，已有内容在更宽终端内仍能容纳
3. `setResizeKey(n+1)` 触发 `<App key={\`${resizeKey}:${overlaySurfaceKey(state)}\`}>` 强制 React 卸载重建整个 App 组件树
4. React 自动将同一帧内的多次 `setResizeKey` 合并为一次渲染 — 快速拖拽时只在最终宽度刷新一次布局
5. 输入文字通过 `initialValue` prop + `onValueChange` 回调保留在 `inputValueRef` 中，remount 时恢复
6. 清屏 + 缓冲渲染由 `useStaticContent` 内的 DEC 同步输出（`\x1B[?2026h/l`）处理，详见 `tui-dec-synchronized-output.md`

### 执行流程

```
resize 事件
  → process.stdout.columns < prevCols?   // 仅宽度收窄才执行
  → setResizeKey(n+1)                       // 入队 React state 更新
  → TuiBootstrap 重渲染                      // React 合并同一帧内多次 setState
    → 读 inputValueRef.current（最新输入文字）
    → <App key={`${resizeKey}:${overlaySurfaceKey(state)}`}> remount
      → useStaticContent needsClear:
        → \x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J  // 置底 + 开启缓冲 + 清屏
        → 全量渲染 Static + dynamic tree              // 全部被缓冲
        → useEffect → \x1B[?2026l                    // 关闭缓冲，原子显示
      → InputLine: useState(initialValue) 恢复文字
```

### 关键决策

| 决策 | 理由 |
|------|------|
| 仅宽度收窄时触发 | 高度变化由 `<Flex>` 自动处理，宽度变宽时已有内容仍能容纳，二者都无需 remount |
| 收窄事件立即触发（不 debounce） | 快速持续收窄时 debounce 可能迟迟不运行，导致中间帧累积 |
| `\x1b[3J` 清 scrollback | `<Static>` 在 remount 时重新渲染，不清会导致双份 |
| key 在 TuiBootstrap 层（不是 App 内） | TuiBootstrap 重渲染才能读到最新的 `inputValueRef.current` |
| `process.stdout.on("resize")` 而非 polling | resize 事件在 macOS/Bun 下正常发射，polling 浪费 CPU |
| 依赖 React 自动批处理合并 render | 同一帧多次 setState 只触发一次渲染，避免 layout 震荡 |
| 清屏 + 缓冲委托给 useStaticContent | resize handler 不再自行操作终端，由 useStaticContent 统一管理 DEC 同步输出缓冲（见 `tui-dec-synchronized-output.md`） |

### 变更文件

| 文件 | 变更 |
|------|------|
| `apps/kite/src/tui/index.tsx` | `inputValueRef` + `resizeKey` state + 仅宽度收窄时递增的 resize 事件监听 + `<App key={\`${resizeKey}:${overlaySurfaceKey(state)}\`} resizeGeneration={resizeKey}>` |
| `apps/kite/src/tui/render/useStaticContent.tsx` | `resizeGeneration` prop → `\x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J` 清屏 + 缓冲；`useEffect` → `\x1B[?2026l` 关闭缓冲；移除两阶段 showContent 状态机 |
| `apps/kite/src/tui/App.tsx` | 新增 `resizeGeneration?: number` prop，透传到 `useStaticContent` |
| `apps/kite/src/tui/components/InputLine.tsx` | `initialValue`/`onValueChange` props，`useEffect` 同步值到父组件 |
| `apps/kite/src/tui/hooks/useOverlayHeight.ts` | 移除手动 resize 监听，直接读 `stdout.rows` |
| `apps/kite/src/tui/hooks/useResizeCleanup.ts` | 删除（dead code） |
| `apps/kite/src/tui/App.tsx` | 移除 `useResizeCleanup` 导入和调用 |

### 验证

```bash
bun run typecheck
bun test ./tests/tui-soft-wrap.test.tsx ./tests/tui-cursor-nav.test.tsx ./tests/tui-edge-cases.test.tsx
```

### 关联文档

- [TUI useStaticContent 引用稳定性](tui-reference-stability.md) — useStaticContent 引用稳定性重构，解决高频渲染下的重复行问题

## 底部 Overlay 视觉契约（2026-07-30）

斜杠命令、文件搜索、帮助、模型、会话、检查点和 MCP 管理面板统一使用
`OverlayFrame`。面板必须占满可用终端宽度（`width="100%"`），不得设置固定或最大面板宽度；
宽度收窄由 App remount 与 Ink 布局重算处理；高度变化和宽度变宽仅由 Ink 正常布局处理。普通底部浮层不得使用四周边框，而应由占满
宽度的顶部分隔线显示 `── <标题> ──`，不重复展示 `◆ Kite Code`；可选的当前位置/总数位于分隔线
右侧。底部操作使用统一的品牌色键名与弱化说明。删除确认等危险状态可使用独立强调，
不得让常驻边框重新包围整个底部面板。
命令匹配面板的标题固定为“命令匹配”，不在标题右侧重复已由选中行展示的 `/command` 或当前命令前缀；位置/总数计数仍保留在右侧。
会话删除进入确认态后必须暂时隐藏搜索与列表，只显示删除对象和影响说明；
删除确认状态由标题栏右侧的 `删除确认` 标识，正文不得重复显示“删除会话”；会话名称和安全
选择应分层展示，确认区保留左右内边距和层级间距。确认选项统一复用
`OverlayChoiceList`，默认选择 `保留会话`；用户必须主动选择危险色的 `永久删除` 后按 Enter
才可执行删除。底部操作同步切换为 `↑↓ 选择`、`Enter 确认` 与 `Esc 返回`，不得在正文中
重复快捷键。搜索和删除确认等会话面板子状态必须通过分层 Esc ref 消费第一次 Esc，避免
全局处理器在同一次按键中继续关闭整个会话面板。
删除确认不得使用整行背景高亮，焦点仅由 `❯`、品牌色和字重表达；会话名称及其引号必须
作为一个整体截断，不得用伸缩布局把闭引号推到终端右侧。

浏览型选择列表（命令、模型、会话、文件与检查点）统一使用主题背景高亮当前行，并以 `❯` 作为唯一焦点标识。主文本紧跟焦点列；
当前生效项在独立的右侧状态列显示 `当前`，时间、`default` 等信息进入更右侧的元数据列。
列表的 `maxHeight` 只用于限制长列表并允许其滚动；内容不足该上限时，列表容器不得使用
`flexGrow` 撑满剩余终端行，浮层的快捷键栏必须紧跟最后一项，避免底部出现无意义空白。
进入或退出二级浮层时，App 必须以独立的 presentation key 重挂载并全屏重绘；这会清除一级命令匹配或旧浮层
留下的终端行，再按当前内容高度投影；不得为浮层人为填充终端剩余高度。
状态列与元数据列之间至少保留两个终端列；会话和检查点时间固定使用本地时区
`YYYY-MM-DD HH:mm:ss`，不得依赖 locale 格式。不得在主文本前预留状态列，也不得增加重复的圆点或竖线选中标记。命令、参数和说明等结构化内容必须按终端显示宽度
使用显式列布局，并在窄终端中截断或隐藏低优先级说明，不得撑破全宽外框。
`/rewind` 使用两阶段底部浮层。第一层只回答“回到哪里”：恢复点以其后的第一条用户消息
描述“发送这条消息之前”的边界，主列显示最多两行的消息摘要，次行显示
`YYYY-MM-DD HH:mm:ss` 和已记录的受影响文件数；当前最新、没有后续消息或文件影响的
无操作恢复点不进入可选列表。不得展示事件位置、Snapshot ID、无数字快捷键的行号或
`N more` 文案。Enter 只进入确认层，不能在列表层直接执行回退。

第二层回答“恢复什么”：固定提供“恢复代码和会话”“仅恢复会话”和“仅恢复代码”，默认
焦点为“恢复代码和会话”。确认层 Esc 直接返回检查点列表，列表层 Esc 才关闭浮层。涉及会话的
选项从恢复点创建并切换到新会话，原会话保留。确认层不重复展示“恢复到这条消息发送之前”正文标题，
而是在浮层标题中固定写作“回退 · 恢复到此消息之前”，正文直接显示已选消息摘要。选中代码恢复范围后，仅在存在可安全恢复或跳过
路径时以无标题的紧凑文案显示 `+新增行 −删除行`、影响最多的文件和其余文件数；不显示会话范围
说明。超出行级 diff 预览上限时只显示文件范围。手动或 Bash 后续修改、缺少后像指纹的路径在预览中计为跳过，执行时仍必须再次校验，不能以
预览替代并发安全检查。无实际变更的“仅恢复代码”不显示空结果。预览与检查点内容左边界对齐，
不展示固定的恢复限制警告。检查点摘要、可选预览和恢复选项之间各保留一行垂直间距。实际恢复
选项提交后必须立即锁定当前确认，组件卸载前的重复 Enter 不得再次派发；执行 handler 还必须用
独立 in-flight 锁防止程序化重复调用。
所有恢复范围执行前都要验证命名恢复点与可解析快照同时存在，失效的“仅恢复代码”不能
误报为“没有需要恢复的文件”。
会话虚拟列表不显示上下溢出提示；方向键导航继续自动滚动到选中项。不得暴露
`ink-virtual-list` 默认的英文 `N more` 文案。
搜索是会话列表顶部的可选行，非选中态显示 `搜索: —`；用户用方向键选中该行后才挂载共享的
`OverlaySearchInput` 文本输入并接收搜索文字。所有带搜索能力的底部选择浮层应复用该组件，
以统一选中态、提示符、空值占位和光标行为。面板挂载只执行一次初始会话加载，空搜索不得额外启动 debounce；
查询结果变化只在当前索引越界时修正选择，不得无条件跳回首个会话。

## 运行中操作交互契约（2026-07-30）

工具授权、用户提问和方案审核虽然属于 Footer interrupt，而不是可随时打开的选择面板，但与
底部浮层共享同一套视觉原语：使用 `OverlayFrame` 的全宽标题分隔线、使用
`OverlayChoiceList` 的 `❯` 焦点列与统一间距（需弱化的确认面板可关闭背景高亮），并通过 `OverlayShortcutBar` 渲染唯一一处
底部快捷键。不得为这三类交互重新增加圆角四边框、`▶`/`›` 等第二套焦点符号，或在正文中
重复快捷键。

授权标题使用“工具类型 · 工具授权”：Shell 命令显示 `Shell · 工具授权`，文件写入显示
`文件编辑 · 工具授权`，MCP 和 Subagent 使用对应类型；未知工具显示清理后的工具名。
命令授权不得把命令正文压进“授权执行命令（…）”单行句式，也不得在工具授权标题后
重复“执行命令”或“调用工具”等无信息标签。正文按左侧引用线对象块、决策列表和快捷键栏
三层排列；层与层之间保留一个空行。三个决策均使用
“主标签 + 一行影响说明”，选项之间保持一致间距；不得只在“拒绝”前额外留白。授权确认
不使用整行背景高亮，焦点由 `❯`、品牌色和字重表达。“拒绝”是安全退出当前授权，不是
破坏性操作，必须使用普通选项颜色，不得复用永久删除等操作的危险色。
批准选项必须是 `approval.grantOptions` 的子集：非 Shell 工具通常只显示“允许一次”，不得
展示或提交 payload 未声明的 `same_command`；“拒绝”始终作为本地安全退出项保留。

`OverlaySearchInput` 只负责“未激活时是可选列表行、激活后挂载输入框”的搜索语义。提问的
自由文本和方案反馈是始终可编辑的回答输入，不得为了表面复用而套用搜索组件。选择与输入
之间的 Tab 提示必须与行为一致：存在预设选项时，Tab 可双向切换；没有预设选项时，不显示
也不消费无意义的 Tab 切换。方案反馈的 Enter 只由文本输入提交一次，外层按键处理器不得
重复提交。

所有底部浮层和运行中操作条的标准快捷键说明使用中文动词：`选择`、`导航`、`确认`、
`提交`、`返回`、`取消`、`关闭`。MCP 专有名词和 Server/Tool 内容可以保留英文，但通用
键盘动作不得另起一套英文文案。

已接受斜杠命令的持久化 `user.command_invoked` 是命令行的唯一展示来源，不得再用乐观 `USER_MESSAGE`
重复插入；本地预检拒绝的控制命令只在当前会话即时显示，且不得持久化。命令结果可紧贴命令显示；但连续两条用户命令必须保留普通块间距。已显示最终回复而
后台 Runtime 尚在 finally 清理时，`/compact` 必须先等待该 cleanup，再从独立 Kernel 执行。
独立 Kernel 已处于终态时，只要存在 manual pending compaction 就必须直接调度 `compact_context`；
不得向即将停止或已停止的执行循环留下 pending compaction。若旧版本已经留下该类 durable pending，
下一条 `/compact` 必须接管并完成它；同一 checkpoint 同时只能有一个 compaction effect 在执行。
这个唯一性由 RuntimeStore 的跨连接 effect lease 保证，不能只依赖单个 `SessionRuntime` 的 Promise。
删除 session 前必须关闭 manual compaction 队列、取消 active summary 并等待全部 writer；排队命令不得在
删除完成后重新启动，晚到 snapshot 还必须由 revision CAS 拒绝。
手动压缩至少需要两个完整 settled turn；一轮问答必须直接显示“消息不足”，不得调用摘要模型、
制造可恢复错误或留下 pending 请求。

工具授权、用户提问和方案审核是阻塞式 Footer 交互。任一 interrupt 可见时，Footer 必须
隐藏全局 `StatusBar` 与 `StatsLine`，包括模型、思考级别、cache、context/token 和权限模式；
只保留当前交互及其 `OverlayShortcutBar`。该隐藏只影响展示，不清空统计状态；interrupt
解决或取消后，全局状态行按最新状态自动恢复。

## 斜杠命令展示契约（2026-07-30）

`SLASH_COMMAND_DEFS` 是内置斜杠命令的展示元数据单一来源，命令补全、精确命令识别和帮助
面板不得各自维护不同清单。所有 `parseSlashCommand` 可执行的静态内置命令都必须进入该
定义；动态 MCP Prompt 与 Skill 命令除外。当前静态清单包含 `effort`、`model`、`theme`、
`language`、`resume`、`new`、`plan`、`compact`、`permissions`、`release`、`telemetry`、
`mcp`、`rewind`、`export`、`context`、`clear`、`help` 和 `exit`。命令名匹配与执行均不区分大小写。

参数提示必须使用实际可接受的值；权限模式显示 `accept_edits|auto|full`，不得再显示无法
解析的旧名称 `ask`。帮助面板从同一元数据生成命令列表，确保新增可执行命令不会只出现在
帮助或只出现在补全中。

## 验证：

```bash
bun test tests/tui-soft-wrap.test.tsx tests/tui-cursor-nav.test.tsx tests/tui-edge-cases.test.tsx tests/slash-suggestions.test.ts tests/tui-slash-command.test.ts tests/tui-slash-suggestion-overlay.test.tsx tests/tui-overlay-choice-list.test.tsx tests/tui-checkpoint-selector.test.tsx tests/tui-layout.test.tsx tests/mcp-panel.test.tsx
```
