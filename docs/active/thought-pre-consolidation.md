# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
读取时机：修改 `consolidateTools.ts`、`handleEvent.ts`（tool_call/tool_done/text/model_requested）、`ToolSummaryBlock.tsx`、`useStaticContent.ts`（tool_summary）、`types.ts`（ConsolidatedToolEntry/tool_summary）、`agentReducer.ts`（cancelRunningBlocks/settleActiveThought）、`compaction.ts`（折叠引擎）时必读。
验证：`bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/runtime/agent.integration.test.ts tests/model-invoke.test.ts tests/session-manager.test.ts tests/runtime/kernel.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle`
最后更新：2026-07-26

## 约束

1. **Thought 边界（阶段模型，ADR-0030）**：Thought 块 = 一段**只读探索阶段**：从首个 `reason` / 探索工具建块起，跨越任意多次模型调用保持活跃（圆点持续闪烁、时长累加、工具并入），直到阶段边界关闭。`reason/thinking` 不打断 Thought，只更新活动预览并累加调用时长；**可见文本也不关闭 Thought**——阶段块活跃时吸收为块顶字幕（确认制，见规则 24）。**阶段边界（关闭 Thought）**：`final` / 流式文本的脱离路径、非探索工具、`need_approval` / `need_input` / `need_plan_review`、生命周期边界（重试 / 错误 / 取消 / 中断 / 轮次结束）。`model.requested` **不是边界**——kernel 收齐工具结果后重新调用模型是实现细节（ADR-0030 取代 ADR-0025 的 settle 条款，见规则 21）。纯空白文本整体忽略。纯思考块（整轮无工具）被文本关闭时并入该文本块题头（ADR-0026，见规则 19）；被非探索工具 / 人机等待关闭时保留裸线。

2. **探索工具不经 tool_card**：`read_file`、`search_content`、`search_files`、`read_mcp_resource` 在 `tool_call` 时直接进入 `tool_summary`，永远不创建独立 `tool_card`。`shell_execute` 仅在 `intent=inspect` 且满足以下一种情况时纳入 Thought 聚合：(a) 命令以搜索前缀（`rg`/`grep`/`ag`/`ack`/`git grep`/`find`）开头；(b) 命令是单一 `ls` 调用（含参数和目标路径）。`ls` 一旦包含管道、重定向、命令串联、换行或命令替换，就按通用 Bash 处理并渲染为独立 tool_card。其他 `shell_execute` 同样不纳入。

3. **非探索工具 = 阶段边界**：所有未满足规则 2 的 `shell_execute`、写入工具、审批、`ask_user`、`update_plan`、`task` 等非探索工具关闭当前阶段块（关闭原因 `tool` / `human_wait`），按原有独立块渲染，其后开启新阶段。**阶段边界不打断思考归属**——被关闭块若 `hasThinking`，记录延续上下文（`thoughtCarryover`，含 `modelMs`），边界后新建的探索聚合继承 `hasThinking` / `modelMs`，标签为 `Thought for Xs · <统计>`（Xs 为同一次模型调用时长，规则 22/23、ADR-0027）。延续上下文的清除只发生在：新的 `reason` 事件、`model.requested`、生命周期边界。`list_mcp_resources` 也使用独立 tool card，以 `Provider · URI` 树展示资源目录；真正读取内容的 `read_mcp_resource` 仍属于探索工具。

4. **跨 thinking 合并**：同一 Thought 内，探索工具之间可以夹着 `reason/thinking`。这些 thinking 不创建新的工具聚合，只更新 `tool_summary.latestActivity`。

5. **运行态互斥活动窗口与块顶字幕**：`latestActivity` 决定标题下方的唯一运行态活动视图。最新事件为 reasoning 时，只显示已经形成完整句/行的 reasoning 内容，按终端宽度自然换行并保留最新 5 个视觉行；未完成尾句继续缓冲，不逐 token 刷新。reasoning 首行使用 `└─` 连接实际内容，后续视觉行与首行正文对齐。最新事件为探索工具时，reasoning 视图立即隐藏，只显示最新 5 条工具消息，最后一条工具消息使用 `└─`；后续 reasoning 可再次覆盖工具视图，二者始终互斥。连接符不得指向“运行中”等合成状态行。Thought 一旦 settle，活动窗口立即折叠：reasoning、工具步骤和 footer 全部隐藏，只保留单行 `Thought for Xs · <工具统计>` 摘要；纯思考回答仍按规则 19 并入回答题头。**旁白文本**（可见 assistant 文本）在阶段块活跃时吸收为字幕：待确认 `pendingCaption` 实时渲染于块顶（标题行下、步骤树上），被随后只读工具确认后转入 `captions` 永久保留（多段按时间顺序累积）；阶段结束仍未确认则脱离为独立文本块（规则 24、ADR-0030）。

6. **人机交互停止计时**：进入审批、提问或方案评审等待时，当前 Thought 必须置为 `active=false` 并冻结 `totalElapsedMs`。用户阅读、审批或输入答案的耗时不计入 Thought 时间。

7. **审批焦点优先**：当 Shell 等工具等待用户审批时，OutputArea 只显示到待审批工具卡为止；同一并发批次中后续到达的探索工具或结果块暂时不显示，避免把审批目标挤出视窗。隐藏只发生在渲染层，审批结束后这些块按当前状态重新显示。

8. **保守调度策略**：TUI 只负责按边界截断 Thought，不重排、拆批、取消或强制 settle executor 已发出的 pending 工具。若同一批事件中出现探索工具和 Bash，Bash 关闭 Thought；pending 探索工具继续保留 `running` 状态并等待后续 `tool_done` 更新。

9. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

10. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

11. **事件驱动计时**：`totalElapsedMs` 由 reducer 在每次相关事件中更新，不再依赖前端 `setInterval` 主动轮询。有 `modelMs` 时以其为准（规则 22，elapsed = 阶段内 Σ 模型调用时长，不随工具执行增长）；无 `modelMs`（旧事件日志）时回退 `Date.now() - createdAt`。更新点：(a) `tool_done` 探索工具完成时；(b) `closeCurrentThought` 关闭 Thought 时；(c) `updateCurrentThoughtActivity` 收到 reason / tool_call 时（`modelMs += durationMs`，跨调用累加）；(d) 无 reasoning 的 `model.responded` 经 `addThoughtDuration` 补计该次调用时长。`ToolSummaryBlock` 直接读取 `block.totalElapsedMs`，无 live timer。

12. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

13. **聚合块圆点 = 阶段存活**（ADR-0030 修订）：`active=true`（阶段进行中）→ 暗色闪烁圆点；标题中的 `Thought for Xs` 已表达进行状态与耗时，运行态不再重复渲染 footer「运行中 (Xs)」。即使所有工具已完成，模型调用间隙仍属于阶段内部，圆点持续动画。`active=false`（阶段结束）→ Thought 与非 Thought 工具聚合摘要都移除圆点并保留两个空格列位，折叠为单行摘要，不渲染 footer 或活动明细。独立工具卡仍使用自身的运行及结果状态语义。旧版"工具全完成即 ●"的提前结算已随 model.requested settle 一同废除（规则 21）。reasoning 活动窗口与圆点解耦，可独立展示。

14. **Static 边界**：`tool_summary` 仅在 `active=false` 且 `tools.every(t => t.status !== 'running')` 时进入 Static。

15. **settledStatus 从实际状态推导**：settled 状态下 `ToolSummaryBlock` 的结算状态仍从工具状态推导（`hasError ? 'error' : hasPendingTools ? 'cancelled' : 'done'`），不使用 `block.result`，供状态数据与兼容逻辑使用；聚合摘要完成态不再用它渲染圆点或 footer。工具仍 running 时 `closeCurrentThought` 留空 `block.result`（undefined）；所有工具 settled 后由 `tool_done` 路径重新计算为 `'error'` 或 `'done'`。

16. **层边界**：`consolidateTools.ts` 中的合并逻辑属于 app 层，不允许导入 core 层模块。

17. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。

18. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

19. **纯思考块持久化与题头并入**：`tools.length === 0` 的 Thought 块（纯问答轮的 `reason → text`，或 `reason → 非探索工具` 产生）。**非流式模型下文本不直接关闭它**——文本先吸收为 `pendingCaption`（规则 24）；`final` 关闭时 pendingCaption 即回答本身 → **并入该文本块题头**（ADR-0026：独立块删除，冻结 elapsed 写为文本块 `thoughtElapsedMs`，渲染为文本块顶部暗色题头行 `Thought for Xs`——两空格缩进、无圆点、与正文固定间隔一行）。流式模型路径（文本事件先关闭思考块）由 `mergePureThoughtHeader` 完成同样的并入。纯空白文本整体忽略、不触发并入。被非探索工具或人机交互边界关闭时**保留**裸线：未确认的 `pendingCaption` 脱离为块后独立文本块（无题头）。`closeCurrentThought`、`settleActiveThought`、`cancelRunningBlocks` 三条路径行为一致，均置 `active=false` 并冻结 `totalElapsedMs`（settle 时按工具状态重算 `result`，规则 15）。settle 后渲染为单行 `Thought for Xs`——**无圆点**（`●` 保留给"有状态"的行），保留两个空格列位使文字起始列与工具块名字列对齐，不显示步骤树与 footer；运行态左侧为暗色闪烁圆点（500ms 切换，隐藏帧两个空格、无行位移），展示互斥活动窗口且不显示运行态 footer。

20. **非思考链聚合（纯统计标签的唯一来源）**：仅当阶段内从未出现 reasoning（所有调用均无思考），且无延续上下文（阶段边界后 carryover 已被 `model.requested` / 新 reason 清除）时，探索聚合使用纯工具统计标签（如 `read 2 files`，`hasThought=false`），不带 `Thought for` 前缀、无 thinking 条目。阶段内任一次调用有 reasoning（或边界 carryover 继承）时，阶段块带 `Thought for Xs · <统计>`（规则 23/24、ADR-0027/0030）。注意：无 reasoning 的调用其 `durationMs` 仍计入阶段 Σ 时长（规则 11），只不影响标签前缀。

21. **model.requested 不关闭 Thought**（ADR-0030 取代 ADR-0025 的 settle 条款）：模型调用为非流式 `generateText`，调用期间不产生任何事件。`model.requested` 在 `await` 模型之前即时发出（ADR-0025 的即时发出机制保留），但 TUI **不再据此关闭 Thought**——模型调用是 kernel 分批喂工具结果的实现细节，不是用户感知的阶段边界：阶段块跨调用保持 `active=true`（圆点持续闪烁、时长累加、后续思考/工具/旁白继续流入，规则 24）。调用间隙块显示"工具全完成 + 圆点闪烁 + 运行中 (Σs)"——这正是"阶段仍在进行"的正确信号（旧版 settle 是为防止"运行中"残留，阶段模型下该残留即语义本身）。收到 `model.requested` 只清除思考延续上下文（新调用 = 新决策，ADR-0027）。回放兼容：旧日志经同一 reducer 回放，同样聚合为阶段块。

22. **标签与计时语义**：思考阶段块（`hasThinking=true`，含规则 23 继承而来的块）标题行为 `Thought for Xs · <工具统计>`——有工具时以 ` · ` 分隔附加 `buildToolSummaryLine` 统计（如 `Thought for 2s · read 3 files`），统计随工具事件实时刷新；无工具的纯思考块保持裸 `Thought for Xs`。统计后缀由渲染层按终端宽度截断（`truncateToFit`），放不下时整体省略后缀、不留孤悬分隔符；工具明细仍在步骤树展示。非思考聚合块（规则 20）标题保持纯工具统计（如 `read 2 files`，对应 CC 的 `⏺ Read N files` 聚合行）。`Thought for Xs` 的时长 = **阶段内 Σ 各次模型调用时长**（`model.responded.durationMs`，含思考+响应生成，不含工具执行；无 reasoning 的调用同样计入，规则 11）：每次 `reason` 事件 / 无思考调用累加 `modelMs`，工具执行期间 elapsed 不增长，settle 时以 `modelMs` 冻结。回退：无 `durationMs` 的旧事件日志（ADR-0025 之前）用创建→settle 墙钟。纯思考块被文本关闭时不产生独立标题行，其时长以文本块题头形式展示（ADR-0026，见规则 19）。最终回答脱离为独立文本块时**不重复出题头**——回答前的思考时长已计入阶段块（ADR-0030）。

23. **思考延续（阶段边界，ADR-0027 / ADR-0030）**：Thought 块被非探索工具（关闭原因 `tool`）、人机交互等待（`human_wait`：审批 / 提问 / 方案评审）或流式路径的文本关闭（`text`）时，若块 `hasThinking`，记录延续上下文 `thoughtCarryover`（含 `modelMs`）；边界之后新建的探索工具聚合块继承 `hasThinking=true` / `hasThought=true` / `modelMs`，`totalElapsedMs` 冻结于同一 `modelMs`（规则 22 语义不变，不引入新标签形态）。清除条件：`model.requested`（新调用 = 新决策）、`model_retry` / `error` / 取消 / 中断（生命周期边界，`cancelRunningBlocks` / `settleActiveThought` 一并清除）、新的 `reason` 事件（新思考替代）。无活跃块的空关闭不触碰 carryover。物理约束不变：非探索工具需要独立富渲染块，Thought 树不能跨越它们，阶段块必须切分，只延续标签归属（如 `Thought for 3s · searched 1 file pattern` → 子代理块 → `Thought for 3s · read 2 files`）。

24. **探索阶段块与旁白字幕（ADR-0030）**：一段只读探索阶段 = 单个 `tool_summary` 块，跨模型调用存活：`model.requested` 不关闭（规则 21），`reason` 累加时长并更新预览（规则 4/11），探索 `tool_call` 并入同块（统计标签实时刷新）。圆点整个阶段持续闪烁，运行态不显示 footer（规则 13）；阶段边界（规则 1/3）关闭后 Thought 移除圆点并折叠为单行摘要。**旁白文本吸收**：阶段块活跃时，可见文本（非流式一次完整到达）不建独立块，写入 `pendingCaption`，渲染于标题行下、步骤树之上（Markdown 原样，缩进与标题文字列对齐）；随后到来只读工具将其确认为 `captions`（永久留在块内，多段按 `\n\n` 时序累积）；阶段结束时仍未确认的 `pendingCaption` 脱离为块后独立文本块（最终回答 / 写入前旁白）；纯思考块的 pendingCaption 被文本路径关闭时并入题头（规则 19）。流式增量文本（事件携带累积全文）以 `startsWith` 识别替换，避免重复。**纯空白文本整体忽略**（不关闭、不建块）。折叠阈值（`MAX_VISIBLE_STEPS=5`）作用于阶段块的合并步骤总数。

25. **模型流式增量（ADR-0031 / ADR-0035 / ADR-0036）**：支持流式的模型在调用期间发出累计全文语义的 `model.text_delta` / `model.reasoning_delta`。首个 reasoning delta 在没有活跃阶段时立即建立实时纯 Thought；运行态展示只提交截至最近换行或句末标点的完整 reasoning 单元，未完成尾句不逐 token 渲染，完整原文仍保留供终态结算。首个 text delta 必须先冻结当前 Thought，再作为同级 text block 渲染；后续累计值只更新该块，任何工具排在文本之后，不得把流式文本写入或回收进 Thought 的 `pendingCaption`。兼容 Provider 若跨帧先发 text、后发 reasoning，仍在变化的尾部文本迁入新 Thought 后再按 Thought → text 结算；终态 `model.responded` 只补齐最后一条 thinking 内容、duration 和权威文本，不重复 timeline/全文。TUI live 派发按 50ms 合帧，并固定 reasoning 先于 text flush，仅保留各类型最新累计值；任何非 delta 事件到达前同步 flush，确保 `model.responded`、工具事件和 settle 不越序。delta 不进入 Runtime store、events.jsonl 或回放；取消、清空和会话切换必须 flush 或清理定时器。

26. **流式断线重连（ADR-0032 / ADR-0033）**：`model.retry` 冻结断线前的 Thought 和流式文本，旧内容永久保留；重连后的文本必须新开一段。新流重放相同前缀时仅派发新增后缀，发生分歧时完整的新生成进入新段，不得原位替换旧段。恢复 delta / `model.responded` 清除 retry 状态。partial tool call 不创建卡片或 summary，只有完整成功流的终态工具调用进入 Runtime。

27. **流式 Markdown 组件层级（ADR-0037 / ADR-0038）**：同一次连接的累计 `model.text_delta` 始终更新同一个 streaming text block，不按换行拆成消息块。`MarkdownBlock` 在该文档内按逻辑段落、单行结构、围栏代码和表格建立块级组件，以 Markdown 源起始行作为稳定身份，并按内容签名 memoize。连续普通文本行归入同一个 paragraph；空行、标题、水平线、列表项、引用、代码和表格封闭段落。累计全文追加时，解析缓存保留全部已完成前缀组件及其签名，只重新解析最后一个可能继续增长或发生类型提升的组件（例如 pipe 行升级为表格）；非追加更新才重建全文解析结果。已完成前缀不重建、不重复计算内容签名。断线后的新段仍是独立 Markdown 文档。

28. **结构块内部增量（ADR-0039）**：表格、围栏代码、连续列表和连续引用不仅保持外层身份，内部也按稳定子行 memoize。表格保持单一父级 `Text` 以维持连续边框；新增数据行且列宽未变时复用已有行，新单元格扩大列宽时允许全部行重新布局。代码、列表和引用追加尾行时只创建新子行，不重新渲染既有子行。

## 设计文档

- `docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md` — Thought 预整合设计详情
- `docs/adr/0025-model-requested-live-emission.md` — model.requested 即时发出（settle 条款已被 ADR-0030 取代，规则 21）
- `docs/adr/0026-thought-text-header-merge.md` — 纯思考块并入文本题头（文本关闭 Thought 条款已被 ADR-0030 取代，规则 19）
- `docs/adr/0027-thought-carryover-non-text-boundary.md` — 思考延续跨过阶段边界、边界后继承（规则 3/20/23）
- `docs/adr/0030-exploration-phase-block.md` — 只读探索阶段 = 单一存活块、文本吸收为块顶字幕（规则 1/13/21/22/24）
- `docs/adr/0041-inspect-ls-thought-aggregation.md` — 单一只读 `ls` 纳入 Thought，复合 shell 语法保持独立工具卡（规则 2/3）
- `docs/space/plans/2026-06-28-context-compaction.md` — M0/M1/M2 三层压缩方案

## 修改时必读

修改以下文件时，必须先阅读上述设计文档：
- `src/app/tui/reducers/consolidateTools.ts` — 工具判断 + 合并逻辑
- `src/app/tui/reducers/handleEvent.ts` — tool_call/tool_done 事件处理
- `src/app/tui/components/ToolSummaryBlock.tsx` — Thought 块渲染
- `src/app/tui/components/BlockRenderer.tsx` — tool_summary case
- `src/app/tui/components/render-utils.ts` — actionName/getToolPreview/getToolDetail
- `src/app/tui/types.ts` — ConsolidatedToolEntry / tool_summary / text 块 `thoughtElapsedMs` 类型
- `src/app/tui/render/useStaticContent.tsx` — isSettled / blockFingerprint for tool_summary
- `src/app/tui/App.tsx` — explorationSummaryIds 初始状态
- `src/app/tui/reducers/agentReducer.ts` — cancelRunningBlocks 处理 tool_summary
- `tests/tui-reducer.test.ts` — 预整合测试
- `tests/context.test.ts` — 折叠测试
