# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
读取时机：修改 `consolidateTools.ts`、`handleEvent.ts`（tool_call/tool_done/text/model_requested）、`ToolSummaryBlock.tsx`、`useStaticContent.ts`（tool_summary）、`types.ts`（ConsolidatedToolEntry/tool_summary）、`agentReducer.ts`（cancelRunningBlocks/settleActiveThought）、`compaction.ts`（折叠引擎）时必读。
验证：`bun test apps/kite-cli/test/tui-reducer.test.ts apps/kite-cli/test/tui-layout.test.tsx apps/kite-service/test/isolated/runtime/agent.integration.test.ts apps/kite-service/test/model-invoke.test.ts apps/kite-service/test/isolated/session-manager.test.ts apps/kite-service/test/runtime/kernel.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle cancel-successor-render`
最后更新：2026-09-04

## 约束

1. **Thought 边界（阶段模型，ADR-0030 / ADR-0167）**：Thought = 一段连续只读探索阶段，跨模型调用、reasoning与exploration工具保持同一owner，直到出现已分类的模型可见正文。`model.requested`不是边界。没有active Thought归属时，`model.text_delta`形成的完整Markdown组件渐进显示，但在`model.responded`调和前保持dynamic；已有active Thought时，完整前缀使用`streaming=true + responsePending=true`留在隐藏ownership buffer，不结算Thought也不进入Static。`model.responded(toolCallCount>0)`删除该未绘制buffer、把过程旁白留在同一Thought并继续吸收匹配工具；`toolCallCount=0`才补齐最终正文、结算Thought并设置`modelTerminal`释放组件。standalone工具、人机交互、重试、失败、取消和Turn/Run terminal仍是强边界。纯空白文本忽略。

2. **探索工具不经 tool_card**：Service在仍拥有可信Runtime分类事实时，为`tool.queued`签发closed
   `presentation=exploration|standalone|hidden`。TUI只消费该值，不解析command、`intent`或工具名前缀。
   `read_file`、`search_content`、`search_files`、`read_mcp_resource`固定投影为exploration；`shell_execute`只有
   Runtime事实同时为`effectClass=read_only + sideEffect=false`时才投影为exploration。exploration调用在实际开始或
   开始前直接失败而物化时进入`tool_summary`，永远不创建独立`tool_card`；standalone Shell始终使用独立卡片。
   `tool.queued`只缓存name/args/presentation，不物化任何块（ADR-0049、ADR-0163）。

3. **非探索工具 = 阶段边界**：所有`presentation=standalone`的`shell_execute`、写入工具、审批、`ask_user`、
   `update_plan`、`task`等非探索工具关闭当前阶段块（关闭原因`tool`/`human_wait`），按原有独立块渲染，其后开启
   新阶段。一个reasoning段的`Thinking Xs`标签由关闭前的块消费，同时清除已消费的request-scoped reasoning缓存；
   同批后续审批、started或terminal边界不得再次物化它。边界后的探索聚合不得复制该标签；它以纯工具
   统计标题开始，直到新的真实`reason`事件到达（ADR-0047）。边界前的未确认旁白脱离为唯一正文并消费
   Thinking元数据，不得作为不可见`pendingCaption`遗留在settled summary。`list_mcp_resources`也使用独立tool card，以
   `Provider · URI`树展示资源目录；真正读取内容的`read_mcp_resource`仍属于探索工具。

4. **跨 thinking 合并**：同一 Thought 内，探索工具之间可以夹着 `reason/thinking`。这些 thinking 不创建新的工具聚合，只更新 `tool_summary.latestActivity`。

5. **运行态单一活动窗口（ADR-0167）**：`reasoning.activity(state=streaming)`只更新request缓存和Thinking题头；`state=completed`才把最新完整reasoning投影到`latestActivity=thinking`，在题头下以有界`└─`窗口原子显示。exploration工具started/progress/terminal把`latestActivity`切换为tool，窗口改为最近工具步骤；后续completed reasoning再覆盖工具窗口。任一时刻只展示最新一种活动，不累计先前reasoning或工具窗口。模型可见正文不属于该活动窗口，始终使用独立text block和request identity完成累计流去重。Thought settle后活动窗口消失，只保留统计摘要。

6. **人机交互停止计时**：进入审批、提问或方案评审等待时，承载该交互前置过程的当前 Thought 必须置为 `active=false` 并冻结 `totalElapsedMs`。工具审批载荷只进入 Footer interrupt，标题内展示待授权命令；审批目标在 `tool.started` 前仍不物化，同批的其他未来调用也不进入渲染树。用户阅读、审批或输入答案的耗时不计入任何 Thought 模型时长。

7. **队列事实与展示事实分离**：Runtime 会先为同一模型响应中的全部工具发出 `tool.queued`。TUI 只把 callId/name/args 保存在会话级临时 `pendingToolCalls`，不创建 `tool_card` 或 `tool_summary`；该映射必须随会话快照保存并由 event-log replay 重建，避免切换或恢复投影后丢失后续 `tool.started` / 终态事件的名称与参数。只有收到 `tool.started`，或在开始前直接失败且需要展示诊断时才物化。审批请求与待授权命令先显示在Footer；用户拒绝工具审批时，配对`tool.rejected`复用pending metadata物化一张保留原命令/目标的未执行卡片，其他未开始sibling删除临时元数据并保持不可见，整个当前turn转为空闲。已经开始的sibling保留并按cancelled终态收尾。`subagent-tool:*` 是例外：其完整生命周期仍保留在 Runtime/journal，但 TUI 不得把它写入 `pendingToolCalls` 或物化为通用工具卡；可见进度仅由所属 `SubAgentBlock` 的 `subagent.*` 事件更新，避免并发 `Delegating` 仍活动时混入看似父 Agent 后续工作的独立卡片。OutputArea 不再推断执行前沿，也不负责隐藏未来 queued 块（ADR-0049/0170）。

8. **副作用感知调度**：TUI 只负责按事件边界截断 Thought，不重排、拆批或取消 Runtime 工具。Agent Kernel Scheduler 可把同一模型响应内连续、已证明 `read_only + sideEffect=false`、无交互语义且无需审批的兼容内置读取组成并行批次，不设置额外的固定小批次上限；交互、Plan/Skill/Task/Tool Search、动态 MCP、写入、未知或审批调用保持独占并截断批次。批内调用各自收到 `tool.started` 后进入同一活动 Thought，并按各自 `tool_done` 渐进更新。

9. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

10. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

11. **模型调用实时计时**：reducer 用 `liveModelStartedAt` 标记当前模型调用的本地开始墙钟；活动 `ToolSummaryBlock` 在该字段存在时定时重绘，展示 `totalElapsedMs + (now - liveModelStartedAt)`。`model.responded` 到达后以权威 `durationMs` 累加 `modelMs/totalElapsedMs` 并清除 live 起点，因此后续工具执行、审批、提问及其他等待均不增长。无 `durationMs` 的旧事件日志仍回退 `Date.now() - createdAt`。最终冻结值只由事件事实决定，前端 live timer 不写回 reducer 或持久状态。

12. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

13. **聚合块圆点 = 阶段存活**（ADR-0030 修订）：`active=true`（阶段进行中）→ 暗色闪烁圆点；标题中的 `Thinking Xs` 已表达进行状态与耗时，运行态不再重复渲染 footer「运行中 (Xs)」。即使所有工具已完成，模型调用间隙仍属于阶段内部，圆点持续动画。`active=false`（阶段结束）→ Thought 与非 Thought 工具聚合摘要都移除圆点并保留两个空格列位，折叠为单行摘要，不渲染 footer 或活动明细。独立工具卡仍使用自身的运行及结果状态语义。

14. **聚合完成与Static边界（ADR-0167）**：`tool_summary`只有同时满足`active=false`、
    `responsePending!==true`和`result=done|error|cancelled`才算完成，并在位于active turn的连续settled前缀时进入
    `<Static>`。`active`拥有“是否仍可继续聚合后续模型调用/探索工具”的封口事实；`result`只拥有封口后全部已物化工具的
    终态结果。尚未started的exploration sibling仍在`pendingToolCalls`、不在`tools[]`中，因此`tools.every(terminal)`不能
    证明聚合已完成。仅当前工具全terminal但`active=true`、或已软关闭但仍在等待model terminal/工具terminal，都必须
    留在dynamic tree。Static分界不得遍历子工具重新生成第三份完成判断。普通完整text按ADR-0171即时提升，并在需要时先结算
    活动Thought。没有待定Thought归属的普通完整text立即Static；已有active Thought时，完整前缀和结构预览保持隐藏的
    `responsePending` dynamic buffer，等待`model.responded.toolCallCount`分类并设置`modelTerminal`。其他block继续遵守ADR-0167。

15. **整体结果由reducer发布**：`tool_summary.result`是唯一聚合结果权威，使用共享结果投影从非空子工具集合的终态生成
    `done | error | cancelled`；渲染层和Static分界不得再次从工具状态推导另一份完成事实。尚未物化工具的纯Thinking、工具仍
    running或阶段仅软关闭时保持`result=undefined`；阶段在至少一个工具已物化、工具均terminal后关闭，或取消投影完成时才
    发布整体结果。active聚合不得携带result，避免提前进入Static后变成不可更新快照。

16. **层边界**：`consolidateTools.ts`只格式化已签发exploration条目的统计文案，不拥有工具分类或历史块重分类。
    Service projector是唯一presentation owner；TUI不允许导入Kernel、Host或Builtin authority模块来重建该结论。

17. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。`write_file` 例外：其卡片动词由 `writeFileActionName(summary, args)` 从结果动态推导——覆写已有文件（diff 统计摘要）显示 Write，新建显示 Create，运行/排队态无 summary 时用中性 Write；append 已由 ADR-0025 §2 移除，历史会话残留的 "Appended …" summary 归入中性 Write。

18. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

19. **纯思考题头**：尚无工具或其他稳定message owner的纯reasoning正文保存在request-scoped reducer state，同时物化dynamic Thought。streaming期间只显示Thinking题头，completed后在同一有界活动窗口原子显示完整reasoning；同request正文在`model.responded`分类前仍由该Thought拥有，完整前缀只进入隐藏`responsePending` buffer。无工具终态把它发布为最终正文并消费纯Thought；带工具终态删除buffer并让后续exploration工具原位升级该Thought。人机交互或standalone工具仍结算对应Thought摘要；settle后reasoning正文不进入历史，不得留下重复Thinking或scrollback副本。纯空白文本不触发题头。

20. **非思考链聚合（纯统计标签的唯一来源）**：阶段内尚未出现 reasoning 时，探索聚合使用纯工具统计标签（如 `read 2 files`，`hasThought=false`），不带 `Thinking` 前缀、无 thinking 条目。阶段内任一次真实 `reason` 到达后，该活动聚合原位升级为 `Thinking Xs · <统计>`（规则 23/24、ADR-0047/0030）。注意：无 reasoning 的调用其 `durationMs` 仍计入阶段 Σ 时长（规则 11），只不影响标签前缀。

21. **model.requested 不关闭 Thought**（ADR-0030 取代 ADR-0025 的 settle 条款）：模型调用为非流式 `generateText`，调用期间不产生任何事件。`model.requested` 在 `await` 模型之前即时发出（ADR-0025 的即时发出机制保留），但 TUI **不再据此关闭 Thought**——模型调用是 kernel 分批喂工具结果的实现细节，不是用户感知的阶段边界：阶段块跨调用保持 `active=true`（圆点持续闪烁、时长累加、后续思考/工具/旁白继续流入，规则 24）。调用间隙块显示"工具全完成 + 圆点闪烁 + 运行中 (Σs)"——这正是"阶段仍在进行"的正确信号（旧版 settle 是为防止"运行中"残留，阶段模型下该残留即语义本身）。ephemeral reasoning与durable通知分属不同投递通道，下一轮reasoning可能先于其`model.requested`到达；若当前active Thought已有探索工具、工具全部terminal且尚无已确认的新模型请求，reducer必须让该reasoning接管同一owner identity，不得先settle再新建卡片。回放兼容：旧日志经同一 reducer 回放，同样聚合为阶段块。

22. **标签与计时语义**：思考阶段块（`hasThinking=true`，由本阶段真实 `reason` 设置）标题行为 `Thinking Xs · <工具统计>`——有工具时以 ` · ` 分隔附加 `buildToolSummaryLine` 统计（如 `Thinking 2s · read 3 files`），统计随工具事件实时刷新；无工具的纯思考块保持裸 `Thinking Xs`。统计后缀由渲染层按终端宽度截断（`truncateToFit`），放不下时整体省略后缀、不留孤悬分隔符；工具明细仍在步骤树展示。非思考聚合块（规则 20）标题保持纯工具统计（如 `read 2 files`，对应 CC 的 `⏺ Read N files` 聚合行）。`Thinking Xs` 的已完成时长 = **阶段内 Σ 各次模型调用时长**（`model.responded.durationMs`，含思考+响应生成，不含工具执行；无 reasoning 的调用同样计入，规则 11）；当前调用尚未完成时，在该累计值上实时叠加本地墙钟预览，终态再由 `durationMs` 校正并冻结。工具执行期间 elapsed 不增长。回退：无 `durationMs` 的旧事件日志（ADR-0025 之前）用创建→settle 墙钟。纯思考块被文本关闭时不产生独立标题行，其时长以文本块题头形式展示（ADR-0026，见规则 19）。最终回答脱离为独立文本块时**不重复出题头**——回答前的思考时长已计入阶段块（ADR-0030）；settled Thinking 摘要与紧随其后的独立回答保持标准消息块间距，不得在回答内部再制造第二个 Thought 分段。

23. **思考标签单次消费（ADR-0047/0167，覆盖 ADR-0027）**：Thought 块被非探索工具、人机交互等待或已由`model.responded(toolCallCount=0)`确认的模型可见正文关闭后，其reasoning内容与`Thinking Xs`标签均已完成展示，不向后续块延续。分类前的`responsePending`正文不是边界；带工具终态必须删除它并继续原owner。真正边界后的探索工具仍按执行顺序建立新聚合，初始使用纯工具统计标题；若该聚合仍活跃时收到新的真实reason，原位升级为`Thinking Xs · ...`，不得另建独立Thought。非探索工具继续使用独立富渲染块，Thought树不跨越它们。

24. **探索响应正文归属（ADR-0030 / ADR-0167）**：`model.text_delta`按request identity累计。没有active Thought时，完整Markdown组件可见但保持dynamic；已有active Thought时，完整前缀只进入隐藏、可删除的`responsePending` buffer。`model.responded(toolCallCount>0)`删除该buffer，把终态过程旁白存入同一owner但不渲染，匹配`presentationGroupId`的exploration工具started继续该活动块；`toolCallCount=0`才补齐并发布最终正文、设置`modelTerminal`。缺失或不匹配的工具identity仍只能形成detached neutral summary，不能跨请求合并。

25. **模型流式增量与重复思考段（ADR-0045 / ADR-0167）**：Runtime继续按`requestId + segmentId`发送累计reasoning/text与completed边界。reasoning delta保持request-scoped，completed后才进入当前Thought的有界活动窗口。无Thought归属歧义时，普通完整段落、列表项或闭合结构组件渐进显示但保持dynamic；已有active Thought时，完整前缀保持隐藏`responsePending`，活动表格/围栏代码也不得取得Static owner。模型终态按toolCallCount原子发布最终正文或撤去过程旁白并设置`modelTerminal`；终态后的迟到reasoning不再修改可见block，已有工具Thought跨相邻`model.requested`继续存活；模型时长累加但工具执行和人机等待不计时。

26. **流式断线重连（ADR-0032 / ADR-0033）**：`model.retry` 冻结断线前已经提交的完整 Markdown 块；尚未闭合的文本尾部和 reasoning delta 从未进入渲染树，因此断线时仍保持隐藏。重连后的累计文本按新的提交边界继续处理；终态 `model.responded` 以权威全文补齐或在分歧时替换当前请求的文本块，并清除 retry 状态。partial tool call 不创建卡片或 summary，只有完整成功流的终态工具调用进入 Runtime。

27. **流式 Markdown 组件层级（ADR-0037 / ADR-0038 / ADR-0046 / ADR-0167）**：空行是普通段落和引用的顶层提交边界；列表采用item级边界，下一个同级marker提交前一个完整item，缩进子列表与续行仍归属父item。围栏代码在完整起始围栏到达后建立Dynamic组件，表格在完整表头与分隔行到达后建立Dynamic组件；两者只追加已换行完成的内部行。无active Thought时，普通完成组件和闭合结构按既有边界渐进显示并等待模型终态后Static；已有active Thought时，相同splitter结果只进入隐藏`responsePending` buffer，等模型终态分类后整体发布或删除。断线后的新段仍是独立Markdown文档。

28. **结构块子行渲染（ADR-0039 / ADR-0046）**：已识别的表格与围栏代码由 `MarkdownBlock` 使用稳定父级和子行增量渲染，只把完整内部行交给可见组件；表格保持单一父级 `Text` 以维持连续边框，按容器真实宽度和 Unicode grapheme 显示宽度换行，并保留单元格内的强调、代码、链接与 Markdown 转义语义。转义或代码区间内的管道符不得拆分成新列。尚未识别的结构、当前未完成行以及普通段落尾部保持隐藏。

29. **文件与独立工具卡渲染**：`renderFileSummary` 自动区分 diff 格式（删除行红底 `diffRemovedBg`、新增行绿底 `diffAddedBg`、上下文行无背景）和纯内容格式。write_file 新建/追加时所有内容行视为新增全绿底，内容未变覆写保持 dim。文件内容行自动语法高亮：行号前缀（`LINE_RE`）走普通 `<Text>`，代码正文走 `<SyntaxHighlight code=... language=.../>`，语言由 `detectLanguage(path)` 从扩展名推断。`...` 分隔符不做高亮。独立工具卡展开长输出时不追加 `Enter 折叠` 尾部提示；既有 Enter 展开/折叠交互保持不变。

30. **取消时只统计实际开始的探索项**：TUI 取消收尾时，仍为 `queued`、从未收到 `tool.started` 的探索项从聚合投影移除，不得转成看似已完成的 `read N files` 等统计；纯工具聚合因此为空时整块移除。活动reasoning窗口随settle消失；已经发布的模型可见正文保持独立text历史，request buffer中尚未提交的尾段也必须在取消边界脱离为可见text，不得因工具归属而删除。已进入 `running` 的探索项保留并标记为 cancelled。独立工具卡取消时必须从原始参数补齐终态 `detail`，Bash 卡片不得丢失原执行指令，也不得把取消误渲染为 `exit: 0`；纯取消摘要不重复充当命令输出。运行卡片通常显式携带 `expanded=false`，本地 Ctrl+C/Esc 收尾必须把取消终态强制设为 `expanded=true`，使 `⎿ cancelled` 在当前会话立即可见，并与 durable `tool.cancelled` 重放结果一致。带 `cause=user` 的 `turn.aborted` 必须复用同一清理投影、清空 interrupt 并把 TUI 切到 idle，不追加独立的整轮取消提示，保证实时界面与事件重放一致。


## 设计文档

- `docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md` — Thought 预整合设计详情
- `docs/adr/0025-model-requested-live-emission.md` — model.requested 即时发出（settle 条款已被 ADR-0030 取代，规则 21）
- `docs/adr/0026-thought-text-header-merge.md` — 纯思考块并入文本题头（文本关闭 Thought 条款已被 ADR-0030 取代，规则 19）
- `docs/adr/0027-thought-carryover-non-text-boundary.md` — 历史方案：跨边界继承 Thought 标签（已被 ADR-0047 覆盖）
- `docs/adr/0047-thought-label-single-consumption.md` — Thought 标签单次消费，边界后不重复继承（规则 3/23）
- `docs/adr/0030-exploration-phase-block.md` — 只读探索阶段 = 单一存活块、文本吸收为块顶字幕（规则 1/13/21/22/24）
- `docs/adr/0041-inspect-ls-thought-aggregation.md` — 历史TUI命令grammar，已由ADR-0163取代
- `docs/adr/0045-streaming-render-complete-block-commit.md` — Thought 终态展示与完整 Markdown 块提交（规则 25/27/28）
- `docs/adr/0046-atomic-streaming-component-progress.md` — 结构组件闭合外壳后的内部完整行渐进渲染（规则 27）
- `docs/adr/0167-separate-block-completion-from-terminal-static-ownership.md` — 模型终态调和、Thought活动窗口与append-only Static边界（规则1/14/19/24/25/27）
- `docs/space/plans/2026-06-28-context-compaction.md` — M0/M1/M2 三层压缩方案

## 修改时必读

修改以下文件时，必须先阅读上述设计文档：
- `apps/kite-cli/src/tui/components/ToolCardBlock.tsx` — 文件工具卡片渲染（diff 染色、语法高亮）
- `apps/kite-cli/src/tui/reducers/consolidateTools.ts` — 已签发探索条目的统计文案
- `apps/kite-cli/src/tui/reducers/handleEvent.ts` — tool_call/tool_done 事件处理
- `apps/kite-cli/src/tui/components/ToolSummaryBlock.tsx` — Thought 块渲染
- `apps/kite-cli/src/tui/components/BlockRenderer.tsx` — tool_summary case
- `apps/kite-cli/src/tui/components/render-utils.ts` — actionName/getToolPreview/getToolDetail
- `apps/kite-cli/src/tui/types.ts` — ConsolidatedToolEntry / tool_summary / text 块 `thoughtElapsedMs` 类型
- `apps/kite-cli/src/tui/render/useStaticContent.tsx` — isSettled / blockFingerprint for tool_summary
- `apps/kite-cli/src/tui/App.tsx` — explorationSummaryIds 初始状态
- `apps/kite-cli/src/tui/reducers/agentReducer.ts` — cancelRunningBlocks 处理 tool_summary
- `apps/kite-cli/test/tui-reducer.test.ts` — 预整合测试
- `tests/integration/builtin-runtime/context.test.ts` — 折叠测试
