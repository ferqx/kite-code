# TUI 渲染规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖 Static/dynamic 输出、终端 resize、引用稳定、软换行和性能边界。

## 输出与 scrollback

- TUI 使用终端主屏缓冲区；不可变 history 在安全物理边界进入 `<Static>` 并保留在原生 scrollback。
- `<Static>` 必须位于 OutputArea 的 `Box(height={0} overflow="hidden")` 内，不外置到 App root。
- 活跃 streaming/running/interrupt block 留在 dynamic tree。没有active Thought归属时，普通Markdown段落、完整列表项和已闭合结构组件一旦提交就作为连续settled前缀立即进入`<Static>`。已有active Thought时，待分类正文只保存在有界`RequestAssembly`，不创建隐藏Timeline/OutputBlock；`model.responded(toolCallCount=0)`补齐正文、结算Thought并发布组件，`toolCallCount>0`丢弃待分类正文并让过程旁白、匹配工具与后续模型调用继续同一Thought。`tool_summary`仅在聚合封口且reducer已发布整体`result`后进入`<Static>`（ADR-0168/0171/0173）。
- standalone `tool_card`在done/error/rejected/cancelled/timeout/exhausted终态进入Static；resolved interaction与不再变化的presentation-only block同样不得阻塞后续正文。单个Subagent终态即可Static；带`concurrencyGroupId`的并发siblings必须等全组终态后一起提升，使一张`Delegated`摘要和后续最终组件只写入scrollback一次（ADR-0172）。
- presentation-only slash echo通过`LOCAL_COMMAND`追加到当前dynamic tail，不创建新的user turn。它不能改变仍活动的结构组件或
  `tool_summary`的完成状态；此前已经完成的普通正文组件本来就属于Static，无需由本地命令再次提升。
- DEC FocusOut/FocusIn只由共享focus store消费，不得投影为Escape、普通按键或改变InputLine合成光标帧。拖动原生终端滚动条
  可能产生这两个报告；完成后的主界面在报告前后必须保持零stdout，避免真实终端重新跟随底部live cursor。
- OutputArea 不实现 focused viewport、行数估算或历史裁剪；Overlay 固定高度列表可以使用 VirtualList。
- 并发 Subagent 使用一个聚合卡片和有界步骤尾；聚合只影响展示，不删除 Runtime/TUI state 中的步骤。
- Subagent启动时由TUI记录本地`startedAt`驱动活动计时；完成事件使用Runtime投影的`durationMs/toolCallCount`冻结终态，失败事件还可携带去除model invocation correlation后的`code/stage`诊断。

## DEC 同步与 resize

- resize、Session 切换和需要整体重绘的路径使用终端 DEC synchronized-output 包围一次完整帧，防止半帧闪烁。
- resize 事件去抖后更新 columns/rows 与 generation；Static key 只在真实布局 generation 变化时重建。
- App root 不使用 `height="100%"` 或 Footer 下方 `flexGrow` spacer；Footer 与 OutputArea 保持固定一行视觉间距。
- queued-prompt由稳定Footer owner持有，Footer与独立StatusBar使用稳定key；queue增减不能改变其他presentation item的React identity。
  活动Session按FIFO完整展示每个候选，每条使用浅色背景的单行`↵ 消息内容`；普通队列与当前Run状态同时可见，不隐藏`Working`或`Cancelling`，首项前与相邻队列行之间各留一行。
  Approval/Input/Plan interaction拥有Footer时同样隐藏Run状态行；审批弹窗的生命周期由interaction projection表达，不额外保留`Working`。
  OutputArea使用浅比较隔离queue-only render，queued state不得重算、重挂载或拆分当前Thought，也不得改变Tool或Delegating的折叠形态。
  queued chrome不参与消息区动态高度预算；它只在Footer中增加自身行，不把队列数量提升为Subagent可见步骤的第二权威。
- active `Delegating`与其他mutable sibling同时存在时仍按终端剩余行预算展示child identity，不能因dynamic tail包含多个item就把
  `maxVisibleChildren`强制为零；24/40行常规视口应保留全部可容纳的child，极小视口才退化为有界折叠摘要。
- OutputArea的Enter展开监听必须先查询当前prompt是否为空；非空prompt的提交Enter由InputLine唯一拥有，不能同时翻转最后一个
  Subagent的`expanded`并改变整张并发聚合卡。该查询通过稳定ref完成，不把每次输入变化提升为App整树重渲染。
- 非 TTY 输入或输出不强制 Ink 交互；真实 PTY 即使处于 CI 也必须启用输入和增量渲染。

## 引用稳定与渐进冻结

- `useStaticContent` 使用 ref + block fingerprint，而不是依赖每帧新引用的 `useMemo`。
- `blockRenderCacheKey`委托有限的renderer-visible投影与canonical serialization生成`visualDigest`；正文、状态、可见工具参数、
  Subagent聚合/展开状态等实际像素输入参与摘要，Runtime identity、lifecycle fence与内部bookkeeping不参与。`presentationState`
  单独进入cache key以触发Live→Sealed提升；只要进入Static，digest在同一RenderEpoch内不可变。
- split 重算后逐元素比较数组引用，未变化 block 继续命中 `React.memo(BlockRenderer)`。
- 新增 OutputBlock render adapter 必须定义 canonical render model 与 projector-owned `presentationState`；renderer 不得为新 variant 增加第二套 settled 判断。
- 并发 group identity 只来自 Runtime 明确的 `concurrencyGroupId`，TUI 不从相邻 block 猜测。
- Timeline projector是Live→Sealed的唯一生命周期入口；OutputArea只消费其render model，不能从Tool/Subagent/Thought/Interaction字段再次推导terminal。
- session、`/clear`、theme/language、model header与双向resize均递增独立RenderEpoch；epoch包含在Static与动态React identity中，本地block id自身也保持单调且不因`/clear`归零，因此不会撞上Ink ledger。清屏与DEC synchronized-output只在commit/layout effect中执行，React render阶段不写stdout。
- Overlay只挂载自身子树，不作为App根key；不同Preference selector使用各自子树key，不能继承另一overlay的选中索引。
  模型选择请求完成前selector保持提交中。活跃Run固定使用admission时的model snapshot，选择的新model记录为下一Run配置；
  主题和语言在当前viewport一次性重绘，不重发Run或追加第二份scrollback。

## Client-safe 交互渲染

- Workspace Trust Gate、Provider/model selector、MCP Overlay与Skill status只渲染Service App Control safe projection。
  Trust snapshot含external-read scope时，Gate在Runtime连接前逐项显示canonical只读root，不能由TUI自行解析`.git`；
  mutation使用observed revision与scope digest匹配当前snapshot；scope/revision conflict会刷新snapshot并立即回到可授权
  状态，用户再次确认即可继续，不进入错误死路。只有真实unavailable才显示故障；只有trusted结果才允许
  Native Runtime connect。`trusted/unknown/corrupt/unavailable`是内部控制状态，不以`Trust status: ...`原始枚举渲染；
  普通授权页只显示工作区、external roots与选择，真实故障只显示本地化错误。ModelSelector identity固定为
  `provider + name`，不读取raw config/API key。MCP endpoint只
  显示origin，command只显示executable，TUI不从Service Supervisor或Repository补全被省略字段。
- 动态MCP execution card固定使用closed `mcp_tool` category，并在没有 descriptor label 时回退为
  `mcp:dynamic_tool`；admission 已携带的 bounded `displayLabel` 可展示具体工具名。raw
  `mcp__server__tool_hash`不能进入card或scrollback，TUI不得从 hashed name 反解或自行推断标签。

- Approval overlay 只消费封闭的 `RuntimeClientInteraction`：Shell审批必须优先显示Service投影的有界原始`command`，
  策略`summary`不得替代命令；同时显示允许的`approve_once | same_command`。不得从TUI本地重新读取cwd、sandbox
  scope、grant subject、provider body或Host内部payload来补展示。
- 决定必须同时匹配可见 queue entry 的 `interactionId` 与 generation；旧卡片、重连前 generation 或缺少
  durable identity 的卡片不能授权。TUI 的选项过滤只影响展示，最终 settlement 仍由 Host 对 State 27
  revision/generation/interaction identity fail closed。
- Approval、Input与Plan overlay的Enter/Esc动作都先显示提交中，并在Runtime command receipt accepted前保持原交互；
  Approval、Input与Plan提交失败显示本地化的connection/expired/state-changed/unknown诊断，不暴露raw错误。
  失败不移除interaction、不标记authorized/answered/cancelled，也不把一次失败写入永久去重
  集合。旧React owner的cleanup不能清除当前action sink；不存在同步submit或interrupt-clear后补发cancel的展示旁路。
- Approval Esc提交失败只在当前Footer显示可重试诊断，不写入永久`LOCAL_TEXT`。用户拒绝成功后，durable
  `approval.rejected`只关闭interaction；配对的pre-dispatch `tool.rejected`复用queued时的安全工具名称与参数，物化一张保留原命令或
  目标的rejected工具卡并明确未执行。当前turn其余未终结sibling只投影取消事实，未started的调用不显示未来卡片。
- user route不显示多余的“人工审批”标签；Auto route仍可显示“自动审查”。必要的匹配请求数量可见，但queue
  sequence、generation或interaction ID不显示；这些字段仍完整保留在client state与settlement校验中。
- Live 与 replay 都从同一 client-safe event identity 构造 block；本地提交态不能与 durable
  `user.message` 各自追加一份相同消息。
- Server subscription 的event-free snapshot/gap reset必须进入同一个presentation reducer做显式reconciliation：
  Session携带同revision的完整`interactionQueue`、有序pending identities与唯一active identity；Native adapter和TUI
  必须用它替换本地Map/approval queue，而不是与旧event state做并集。active但空queue会清除旧interrupt；切换focus会
  删除queue中已不存在的旧项；idle snapshot即使本地`running=false/interrupt=null`也必须清空残留pending approvals。
  snapshot不是synthetic Runtime event，不能伪造approved/rejected/cancelled/completed事实；低于本地command receipt
  revision的迟到snapshot不得结束当前run。
- `runTask`的本地Promise收尾不向reducer发送伪idle动作。运行与交互状态只由live Runtime事件或同等权威的
  Session projection query收敛；query fallback必须先投影完整snapshot，再释放本地run waiter。
- 审批已接受而`tool.started`尚未展示的窗口中，queued/running Tool及其metadata必须保持原状态；只有
  durable `tool.cancelled`或明确的用户取消terminal才能显示“已取消”。渲染层不得用空summary或缺少answer推断取消。
- 对相同active interaction identity重复收到snapshot时，input、plan review、provider action与verification复用已存在的
  Footer/block，不追加第二个question或notice；只有active identity切换才重新物化presentation。queue revision可前进，
  但这不会把同一稳定interaction误判为新的UI组件。
- `tool.queued` 只缓存 closed category、dynamic display label 与有界 arguments，不创建任何 block；
  `tool.started` 才按 App 投影的 `exploration | standalone | hidden` 分类物化。`read_file`、
  `search_content`、`search_files` 与 `read_mcp_resource` 可在同一只读探索阶段累积，started/terminal
  乱序仍按 call ID 更新同一个 summary。存在queued metadata时，未started的`tool.rejected`保留为error终态诊断，
  明确表示执行前拒绝；因为策略拒绝可能没有独立interaction notice，不能把它静默删除。subscription gap连queued
  metadata也缺失时仍不得凭terminal创建匿名`Tool`执行卡。人工approval拒绝使用仍在pending map中的queued metadata展示exact目标，
  不再生成独立notice；终态卡片物化后删除queued payload。
- 聚合条目保留本地 path/pattern/command/result，运行态步骤显示这些详情；settle 后按 Thought 规则折叠为
  统计摘要，不是因为 Protocol 删除了内容。Shell 只有 queued event 已由 Runtime 分类为
  `effectClass=read_only` 且 `sideEffect=false` 时才归 exploration；TUI 不读取命令文本重新分类。
  `ask_user`等Server已分类为standalone的interaction工具先封口当前Thought，再由独立tool card与Footer问题展示；不得计入
  Thinking的工具数量或摘要。
  同一 Thought 中的只读 Shell 按 `ran N shell command(s)` 计入题头，例如
  `Thinking 1s · read 2 files, ran 1 shell command`。当前模型调用进行时，标题耗时按本地墙钟持续刷新；
  `model.responded.durationMs` 到达后校正并冻结最终模型耗时，工具与人机等待不计入。terminal event 即使没有重复分类事实也按 call ID
  更新 queued 时创建的同一条目；缺少 queued fact 时不猜测、不聚合。
- Block完成语义与Static物理所有权通常按ADR-0167分离；`tool_summary`与已完成的普通text组件是明确例外
  （ADR-0168/0171）。`tool_summary`的
  `active=false + result=done|error|cancelled`共同构成完成条件。`active`表示该Thought已封口、不能再
  聚合后续模型调用或探索工具；`result`表示封口后的工具整体结果。尚无已物化工具的纯Thinking不能用空集合推导`done`；
  `active=true`时即使当前工具全terminal或残留旧result也必须留在dynamic tree。渲染层不得遍历子工具生成第三套完成判断。
  条件成立且该块位于active turn的连续settled前缀时立即提升。无active Thought时，普通text形成完整Markdown组件后直接提升；
  有active Thought时，完整前缀和结构预览只进入`RequestAssembly`，直到`model.responded.toolCallCount`分类后发布或丢弃。
  standalone block继续按ADR-0167等待安全物理边界。
- 尚无工具或其他稳定消息owner的纯reasoning在request-scoped state保留内容并物化dynamic Thought；streaming期间只显示
  `● Thinking Ns`题头，completed后在有界`└─`活动窗口原子显示完整reasoning。首个完整正文组件出现时，该动态owner并入正文
  题头；工具响应或人机交互边界则将其结算为对应Thought，活动reasoning不进入settled历史。
- 已物化的`tool_card`必然来自`presentation=standalone`；达到终态后按ADR-0172立即冻结并取得Static owner。
  TUI不得再检查其command、`intent`或工具名前缀来推导完成，也不保留离线扫描历史block并重新合并的第二条分类路径。
- standalone Shell运行时持续tail-follow最近5行`tool.progress`；成功终态有stdout/stderr时默认显示Service投影的
  有界完整结果并保留`exit: 0`尾行。短命令即使started/progress/finished落在一个Ink frame内也不能只剩exit状态；
  只有用户主动折叠后才隐藏正文。
- standalone tool 在 started 时结算它之前的 Thought；其 terminal 只能更新自身 card，不能因为完成较晚而
  结算该 tool started 后新建的 exploration summary。若 durable final text 先于 completed reasoning 到达，
  reducer仍按当前可见阶段归属回填；只读探索后紧邻的下一次model reasoning继续进入同一Thought。
  live 与同一 Session 的 `/resume` replay使用相同阶段判断。standalone tool或人机交互边界一旦结算前置
  reasoning，就同时消费其request-scoped缓存；同批后续的审批、started或terminal边界不得再次物化同一Thinking。
  若边界前还有未确认旁白，则旁白在边界前脱离为唯一正文并消费Thinking元数据，不得隐藏在settled summary中。
- 工具的model/presentation identity缺失或与当前Thought不匹配时只形成detached neutral summary；不得同时留下两个
  `active` tool summary。任一时刻只有current Thought可为active，旧/mismatched组不能成为失去owner的dynamic block。
- `model.requested(requestId)`不是presentation step边界；它只更新当前active Thought的model identity。模型读取工具结果后
  发起下一次调用属于同一只读探索阶段，所以相邻的工具统计与后续reasoning必须合并，例如
  `Thinking 12s · read 2 files, ran 1 shell command`。standalone tool、人机交互或Turn终态必然结算阶段。
  ephemeral reasoning可能先于另一投递通道中的durable `model.requested`到达；当前Thought已有探索工具、工具全部terminal且
  尚无已确认的新模型请求时，该reasoning直接接管同一owner的request identity，不得结算旧卡再新建相邻Thought。
  reasoning/text delta都按request identity累计。已有工具Thought时，completed reasoning更新`latestActivity=thinking`并在
  题头下显示最新完整内容；exploration工具started/progress/terminal将同一窗口切回工具步骤，后续completed reasoning
  再覆盖工具窗口。活动Thought下的完整正文前缀只进入`RequestAssembly`，不结算该owner；
  `model.responded(toolCallCount>0)`删除buffer并让后续exploration工具继续原活动块，`toolCallCount=0`才发布最终正文。
  terminal不得制造第二个Thinking owner。
- reasoning delta/completed都是无State revision的ephemeral presentation fact，Server按原序交给client sink。delta只缓存，
  completed才更新有界活动窗口；settle后reasoning正文消失。durable
  `model.responded(toolCallCount>0)`无论先于或晚于累计text delta，TUI都把文本保留为当前Thought的待确认旁白；只有匹配
  工具started才能确认其探索归属，但旁白仍不显示。缺失或不匹配的identity只能形成detached neutral summary，不能跨请求吸收。
- TUI reducer只消费canonical framed client events，不按InProcess、Native Service或carrier分支渲染。Service在投影前
  以同一个50ms frame合并累计reasoning/text（每类保留最新值且reasoning先于text），并按tool/stream合并progress；
  durable边界与Turn结束前先flush。数据源切换不得改变文本的既有 Markdown 提交语义：普通文本按完整段落、
  列表按完整 item、已识别代码/表格组件按完整内部行推进；不得把普通文本拆成逐行消息块，也不得把同一阶段的
  Thinking移到独立dynamic区域。前台Native client dispatch completed reasoning后先等待Ink presentation flush，再消费下一条text、
  terminal或interaction事件；整轮完成后的flush不能替代这个事件间屏障。两处等待都以1秒为上限：正常路径等待真实commit，
  但迟到/失败的UI promise不能停止canonical event消费或prompt FIFO；deadline不是用固定延迟猜测正常渲染时序。
- 不完整的普通paragraph继续只存在于request-scoped cumulative text buffer。无active Thought时，普通回答一旦形成完整Markdown
  组件，就按既有提交器成为不可变text并立即进入连续Static前缀。已有active Thought时，完整前缀只形成隐藏、可删除的
  `RequestAssembly`；无工具模型终态补齐并发布，带工具终态丢弃待分类正文并继续原Thought，同时校准耗时；
  `model.responded.summary`是optional，缺失时使用同request最后一条已接受delta收口尾段。
- `model.text_delta`、`reasoning.activity` 与 `model.responded` 必须携带同一 model `requestId`。TUI 以该 identity
  更新唯一回答槽位，而不依赖“最后一个 block”猜测归属；正文先到、reasoning/terminal 后到，或 durable terminal
  越过 ephemeral delta 时，都只能冻结/补充原文本块。旧 request 的迟到包不得关闭新 Thought 或追加第二份正文。
- 新tool queue event用`presentationGroupId == model.responded.messageId`把closed tool batch解析到对应`requestId`；
  reducer只有精确匹配才写入summary的model request identity，不能按相邻文本或当前block猜测。旧History缺少该可选
  identity或identity不匹配时只能进入独立neutral tool summary，绝不能并入当前或后续Thought；新live/replay
  projector必须提供并验证该identity。同一live Thought在前一group的全部工具terminal后接管下一次`model.requested`时，
  必须清除上一request的`modelTerminal`标记；随后精确绑定的新presentation group复用同一summary，并保留旧group→summary
  映射供迟到terminal幂等结算。前一group仍有活动工具、缺少新request绑定、standalone/mutation或interaction boundary时不得跨group聚合。
- reasoning 的可见题头只有一个 owner：阶段内已有探索工具时归 `tool_summary`，纯 reasoning 时并入最终文本；
  两者不得同时显示 `Thinking`。
- 带工具响应在active Thought下属于待分类过程旁白：完整前缀与未完成尾段都留在request-scoped assembly；
  `model.responded(toolCallCount>0)`删除text buffer并把终态全文转入不渲染的`pendingCaption/captions`，后续匹配工具继续同一
  Thought。没有active Thought或终态确认无工具的正文仍走普通Markdown消息路径。request identity负责累计流去重；活动区只在
  最新completed reasoning与exploration工具步骤之间交替。
  settled Thinking 摘要（无论是否包含工具）与独立回答保持正常消息块间距；文本内部仍使用既有 Markdown
  段落/组件提交器，不由 Thought 聚合器重新分段。已确认的段落、item 或完整结构组件立即成为不可变语义与Static前缀；
  尚未达到提交边界的普通尾段保持buffer，活动结构容器继续由dynamic拥有。

## 软换行与光标

- `CtrlSafeTextInput` 使用 `string-width` 计算终端列；CJK/全角通常占两列。
- 显示 inverse 空格光标且无 trailing text 时，为光标预留一列。
- 断行优先级为显式换行、ASCII 单词空白、脚本边界、最后可容纳字符；CJK/数字相邻空格不强制断行。
- 换行边界光标归下一视觉行开头；上下移动保持目标列并 clamp，Home/End 作用于当前视觉行。
- IME 自动前导空格只在单次输入事件满足确定条件时清理，用户主动输入的空格保留。

## 性能边界

- prompt echo由accepted receipt的canonical messageId绑定；message-first只消费本Session FIFO submission，不按正文匹配。
  RequestAssembly按requestId保存尚未分类的text/reasoning，单request最多1 MiB、同时最多64项；超限或stream gap保持
  presentation_incomplete，model terminal不得把截断内容seal。物化为OutputBlock兼容DTO后立即删除assembly。
- Message Projector显式写入每个OutputBlock adapter的`presentationState`，组合 reducer 在每次 presentation action 后推进保存在 `TuiState` 中的规范化 Timeline，并把它单向映射为
  `LiveItem | SealedItem`；缺少marker时fail closed为live。生产 renderer 只消费该 reducer-owned Timeline 的 state、digest 与 render model，不在 React hook 中重新投影，也不再从
  Tool/Thought/Subagent/Interaction子字段自行决定业务terminal，也不保留per-kind compatibility推导。

- 减少 Yoga 节点数优先于仅使用 React.memo。
- Overlay VirtualList 只渲染 visible items，禁止因 selectedIndex 变化预计算全部行。
- timer lifecycle 只依赖真实 running/focus 状态，不依赖每帧 elapsed 值。
- 新Run的本地reservation建立presentation-only Start command时间窗，立即渲染带显式pending标记的prompt并显示`Working`；它不得被旧的settled `currentRun`压住，也不等待Session ready、前序cleanup、receipt或权威`user.message`。durable prompt到达后只原位补齐identity，不追加第二条消息；提交失败则同时撤销pending prompt与本地状态。Server Run identity与终态仍完全由Runtime投影拥有。
- 首个完整回答组件发布后，只要canonical `currentRun`仍为active，Footer继续显示animated run status；
  普通执行文案为不参与本地化的英文`Working`。当最后一个可见块是已完成的model-owned正文、当前模型请求已结束且不存在待续工具批次时，内部阶段仍进入`finishing`，但Footer继续显示`Working`直到权威终态到达；`run.terminal`的completed/failed/cancelled都清除Run selector，不得残留`Working`。该状态不展示工具详情或耗时。interrupt、审批/问答/方案
  Footer中的审批/问答/方案interaction取得焦点时隐藏该状态行，避免与`Working`竞争；slash modal只覆盖输入或统计区域。普通完成组件必须逐个离开
  dynamic tree，避免Footer或焦点重绘反复处理整篇长回答并触发Ink全屏清除、重置原生scroll位置。
- dynamic 帧高度必须保留 Ink 全屏阈值安全余量，不能为速度删除内容或 Runtime 事实。

## 验证

`bun test apps/kite-cli/test`、`bun run test:e2e`、相关 resize/streaming/scrollback PTY scenarios。
