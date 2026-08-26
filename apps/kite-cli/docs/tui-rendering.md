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

- Approval overlay 只消费封闭的 `RuntimeClientInteraction`：可显示有界 `title`/`summary` 和允许的
  `approve_once | same_command`，不得重新读取 raw command、cwd、sandbox scope、grant subject、provider body
  或 Host 内部 payload 来补展示。
- 决定必须同时匹配可见 queue entry 的 `interactionId` 与 generation；旧卡片、重连前 generation 或缺少
  durable identity 的卡片不能授权。TUI 的选项过滤只影响展示，最终 settlement 仍由 Host 对 State 27
  revision/generation/interaction identity fail closed。
- 审批面板只显示“人工审批/自动审查”等用户语义与必要的匹配请求数量，不显示 queue sequence、generation
  或 interaction ID；这些字段仍完整保留在 client state 与 settlement 校验中，隐藏诊断文案不等于删除 authority。
- Live 与 replay 都从同一 client-safe event identity 构造 block；本地提交态不能与 durable
  `user.message` 各自追加一份相同消息。
- `tool.queued` 只缓存 closed category、dynamic display label 与有界 arguments，不创建任何 block；
  `tool.started` 才按 App 投影的 `exploration | standalone | hidden` 分类物化。`read_file`、
  `search_content`、`search_files` 与 `read_mcp_resource` 可在同一只读探索阶段累积，started/terminal
  乱序仍按 call ID 更新同一个 summary。
- 聚合条目保留本地 path/pattern/command/result，运行态步骤显示这些详情；settle 后按 Thought 规则折叠为
  统计摘要，不是因为 Protocol 删除了内容。Shell 只有 queued arguments 明确 `intent=inspect` 且命令通过
  只读 grammar 时才归 exploration；终态缺 queued fact 时不猜测。
- standalone tool 在 started 时结算它之前的 Thought；其 terminal 只能更新自身 card，不能因为完成较晚而
  结算该 tool started 后新建的 exploration summary。若 durable final text 先于 completed reasoning 到达，
  且文本紧邻该 exploration summary，reasoning 仍回填同一 summary。live 与同一 Session 的 `/resume` replay
  都必须把 `searched N ...` 与后续 `Thinking` 组装为一个题头，不能要求创建新会话规避乱序。
- reasoning segment、旁白 caption、探索工具与模型调用跨多个 request 仍进入一个阶段块。streaming delta
  只缓存，completed reasoning 才更新活动窗口；第一条文本使块进入 `awaiting_terminal`，terminal 声明后续
  工具时重新激活并由 started 确认 caption，否则文本脱离为最终回答。同一 request 出现
  `reasoning prefix → visible text → reasoning suffix` 时，prefix 只可在正文前的活动窗口显示；正文首帧必须
  关闭纯 reasoning summary，后到的 reasoning 只能补充回答的隐藏 Thought metadata，不能把答案留作 caption、
  重新显示原始 reasoning 或恢复活动圆点。live 与 history replay 共用该状态机。
- reasoning delta/completed 都是无 State revision 的 ephemeral presentation fact，Server composition 必须按原序
  交给 client sink，不能把 completed 误送 durable revision sink。durable `model.responded(toolCallCount>0)` 可以
  先于同一回复的累计 text delta 抵达；该迟到 narration 仍属于当前活跃阶段，不得关闭 Thought、重复 caption
  或迫使后续探索工具另建 summary。
- `model.text_delta`、`reasoning.activity` 与 `model.responded` 必须携带同一 model `requestId`。TUI 以该 identity
  更新唯一回答槽位，而不依赖“最后一个 block”猜测归属；正文先到、reasoning/terminal 后到，或 durable terminal
  越过 ephemeral delta 时，都只能冻结/补充原文本块。旧 request 的迟到包不得关闭新 Thought 或追加第二份正文。
- reasoning 的可见题头只有一个 owner：阶段内已有探索工具时归 `tool_summary`，纯 reasoning 时并入最终文本；
  两者不得同时显示 `Thinking`。
- 同一阶段内的多个 caption 按事件顺序逐行紧凑排列；Thinking 题头与首个 caption 之间固定保留一行，
  settled Thinking 摘要（无论是否包含工具）与最终回答之间也固定保留一行。不得把该视觉分段扩成第二个
  Thought/回答 block；单条 caption/回答自身的 Markdown 段落间距保持不变。

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
