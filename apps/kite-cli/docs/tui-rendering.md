# TUI 渲染规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖 Static/dynamic 输出、终端 resize、引用稳定、软换行和性能边界。

## 输出与 scrollback

- TUI 使用终端主屏缓冲区，已完成消息进入 `<Static>` 并保留在原生 scrollback。
- `<Static>` 必须位于 OutputArea 的 `Box(height={0} overflow="hidden")` 内，不外置到 App root。
- 活跃 streaming/running/interrupt block 留在 dynamic tree；已提交相邻文本是 append-only 前缀。
- OutputArea 不实现 focused viewport、行数估算或历史裁剪；Overlay 固定高度列表可以使用 VirtualList。
- 并发 Subagent 使用一个聚合卡片和有界步骤尾；聚合只影响展示，不删除 Runtime/TUI state 中的步骤。

## DEC 同步与 resize

- resize、Session 切换和需要整体重绘的路径使用终端 DEC synchronized-output 包围一次完整帧，防止半帧闪烁。
- resize 事件去抖后更新 columns/rows 与 generation；Static key 只在真实布局 generation 变化时重建。
- App root 不使用 `height="100%"` 或 Footer 下方 `flexGrow` spacer；Footer 与 OutputArea 保持固定一行视觉间距。
- 非 TTY 输入或输出不强制 Ink 交互；真实 PTY 即使处于 CI 也必须启用输入和增量渲染。

## 引用稳定与渐进冻结

- `useStaticContent` 使用 ref + block fingerprint，而不是依赖每帧新引用的 `useMemo`。
- fingerprint 只包含影响可见结构的 kind/status/step/text completion 等字段；timer 和 spinner tick 不改变它。
- split 重算后逐元素比较数组引用，未变化 block 继续命中 `React.memo(BlockRenderer)`。
- 新增 OutputBlock variant 必须同时定义 fingerprint 与 settled 条件。
- 并发 group identity 只来自 Runtime 明确的 `concurrencyGroupId`，TUI 不从相邻 block 猜测。

## Client-safe 交互渲染

- Workspace Trust Gate、Provider/model selector、MCP Overlay与Skill status只渲染Service App Control safe projection。
  Trust snapshot含external-read scope时，Gate在Runtime连接前逐项显示canonical只读root，不能由TUI自行解析`.git`；
  mutation使用observed revision与scope digest匹配当前snapshot；scope/revision conflict会刷新snapshot并立即回到可授权
  状态，用户再次确认即可继续，不进入错误死路。只有真实unavailable才显示故障；只有trusted结果才允许
  Native Runtime connect。`trusted/unknown/corrupt/unavailable`是内部控制状态，不以`Trust status: ...`原始枚举渲染；
  普通授权页只显示工作区、external roots与选择，真实故障只显示本地化错误。ModelSelector identity固定为
  `provider + name`，不读取raw config/API key。MCP endpoint只
  显示origin，command只显示executable，TUI不从Service Supervisor或Repository补全被省略字段。
- 动态MCP execution card固定显示closed `mcp:dynamic_tool` lifecycle label；raw
  `mcp__server__tool_hash`不能进入card或scrollback，具体工具名只由独立safe summary拥有。

- Approval overlay 只消费封闭的 `RuntimeClientInteraction`：Shell审批必须优先显示Service投影的有界原始`command`，
  策略`summary`不得替代命令；同时显示允许的`approve_once | same_command`。不得从TUI本地重新读取cwd、sandbox
  scope、grant subject、provider body或Host内部payload来补展示。
- 决定必须同时匹配可见 queue entry 的 `interactionId` 与 generation；旧卡片、重连前 generation 或缺少
  durable identity 的卡片不能授权。TUI 的选项过滤只影响展示，最终 settlement 仍由 Host 对 State 27
  revision/generation/interaction identity fail closed。
- Enter后overlay显示提交中，并在Runtime command receipt accepted前保持原选择；提交失败显示本地化重试提示，
  不移除approval、不标记authorized，也不把一次失败写入永久去重集合。旧React owner的cleanup不能清除当前action sink。
- user route不显示多余的“人工审批”标签；Auto route仍可显示“自动审查”。必要的匹配请求数量可见，但queue
  sequence、generation或interaction ID不显示；这些字段仍完整保留在client state与settlement校验中。
- Live 与 replay 都从同一 client-safe event identity 构造 block；本地提交态不能与 durable
  `user.message` 各自追加一份相同消息。
- Server subscription 的event-free snapshot/gap reset必须进入同一个presentation reducer做显式reconciliation：
  `activeWork.activeTurn.interaction`恢复当前交互表面，缺少active work则只结束本地running projection。snapshot不是
  synthetic Runtime event，不能伪造approved/rejected/cancelled/completed事实；Client缓存更新本身也不能让React继续
  保留旧“执行中”。低于本地command receipt revision的迟到snapshot不得结束当前run。
- `tool.queued` 只缓存 closed category、dynamic display label 与有界 arguments，不创建任何 block；
  `tool.started` 才按 App 投影的 `exploration | standalone | hidden` 分类物化。`read_file`、
  `search_content`、`search_files` 与 `read_mcp_resource` 可在同一只读探索阶段累积，started/terminal
  乱序仍按 call ID 更新同一个 summary。
- 聚合条目保留本地 path/pattern/command/result，运行态步骤显示这些详情；settle 后按 Thought 规则折叠为
  统计摘要，不是因为 Protocol 删除了内容。Shell 只有 queued arguments 明确 `intent=inspect` 且命令通过
  只读 grammar 时才归 exploration；终态缺 queued fact 时不猜测。
- standalone Shell运行时持续tail-follow最近5行`tool.progress`；成功终态有stdout/stderr时默认显示Service投影的
  有界完整结果并保留`exit: 0`尾行。短命令即使started/progress/finished落在一个Ink frame内也不能只剩exit状态；
  只有用户主动折叠后才隐藏正文。
- standalone tool 在 started 时结算它之前的 Thought；其 terminal 只能更新自身 card，不能因为完成较晚而
  结算该 tool started 后新建的 exploration summary。若 durable final text 先于 completed reasoning 到达，
  且文本紧邻该 exploration summary，reasoning 仍回填同一 summary。live 与同一 Session 的 `/resume` replay
  都必须把 `searched N ...` 与后续 `Thinking` 组装为一个题头，不能要求创建新会话规避乱序。
- reasoning segment、非流式旁白 caption、探索工具与模型调用跨多个 request 仍可进入一个阶段块。reasoning
  streaming delta 只缓存，completed reasoning 才把完整内容一次性放入 `└─` 活动窗口；后续 read/search 等
  工具活动在同一窗口覆盖 reasoning，下一段 completed reasoning 又可覆盖工具活动。第一条流式文本使块进入
  `awaiting_terminal`，并始终作为 Thought 后的独立 sibling 文本块；terminal 即使声明后续工具，也不得把该文本
  回收成 caption。后续 started 工具在文本之后建立新的探索活动块。同一 request 出现
  `reasoning prefix → visible text → reasoning suffix` 时，prefix 只可在正文前的活动窗口显示；正文首帧必须
  关闭纯 reasoning summary，后到的 reasoning 只能补充回答的隐藏 Thought metadata，不能把答案留作 caption、
  重新显示原始 reasoning 或恢复活动圆点。live 与 history replay 共用该状态机。
- reasoning delta/completed 都是无 State revision 的 ephemeral presentation fact，Server composition 必须按原序
  交给 client sink，不能把 completed 误送 durable revision sink。durable `model.responded(toolCallCount>0)` 可以
  先于同一回复的累计 text delta 抵达；TUI 仍按 request identity 去重，但迟到的流式 narration 必须保持普通文本
  sibling，不能因到达顺序被吸收进 Thought caption。
- TUI reducer只消费canonical framed client events，不按InProcess、Native Service或carrier分支渲染。Service在投影前
  以同一个50ms frame合并累计reasoning/text（每类保留最新值且reasoning先于text），并按tool/stream合并progress；
  durable边界与Turn结束前先flush。数据源切换不得改变文本的既有 Markdown 提交语义：普通文本按完整段落、
  列表按完整 item、已识别代码/表格组件按完整内部行推进；不得把普通文本拆成逐行消息块，也不得把同一阶段的
  Thinking移到独立dynamic区域。前台Native client dispatch completed reasoning后必须等待Ink presentation flush，再消费下一条text、
  terminal或interaction事件；整轮完成后的单次flush不能替代这个事件间屏障。
- `model.text_delta`、`reasoning.activity` 与 `model.responded` 必须携带同一 model `requestId`。TUI 以该 identity
  更新唯一回答槽位，而不依赖“最后一个 block”猜测归属；正文先到、reasoning/terminal 后到，或 durable terminal
  越过 ephemeral delta 时，都只能冻结/补充原文本块。旧 request 的迟到包不得关闭新 Thought 或追加第二份正文。
- reasoning 的可见题头只有一个 owner：阶段内已有探索工具时归 `tool_summary`，纯 reasoning 时并入最终文本；
  两者不得同时显示 `Thinking`。
- 非流式兼容路径的多个 caption 继续按既有 Markdown 渲染与间距规则显示；流式 `model.text_delta` 不进入该路径。
  settled Thinking 摘要（无论是否包含工具）与独立回答保持正常消息块间距；文本内部仍使用既有 Markdown
  段落/组件提交器，不由 Thought 聚合器重新分段。已提交的段落、item 或完整结构组件是 append-only 前缀，
  立即进入 Static；只有尚未闭合的代码/表格结构组件留在 dynamic。

## 软换行与光标

- `CtrlSafeTextInput` 使用 `string-width` 计算终端列；CJK/全角通常占两列。
- 显示 inverse 空格光标且无 trailing text 时，为光标预留一列。
- 断行优先级为显式换行、ASCII 单词空白、脚本边界、最后可容纳字符；CJK/数字相邻空格不强制断行。
- 换行边界光标归下一视觉行开头；上下移动保持目标列并 clamp，Home/End 作用于当前视觉行。
- IME 自动前导空格只在单次输入事件满足确定条件时清理，用户主动输入的空格保留。

## 性能边界

- 减少 Yoga 节点数优先于仅使用 React.memo。
- Overlay VirtualList 只渲染 visible items，禁止因 selectedIndex 变化预计算全部行。
- timer lifecycle 只依赖真实 running/focus 状态，不依赖每帧 elapsed 值。
- dynamic 帧高度必须保留 Ink 全屏阈值安全余量，不能为速度删除内容或 Runtime 事实。

## 验证

`bun test apps/kite-cli/test`、`bun run test:e2e`、相关 resize/streaming/scrollback PTY scenarios。
