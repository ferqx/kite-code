# 独立终端消费者

安全项目来源目录、独立 Review、明确 Source Question 选择与原申请读取已接入；共享接口与当前交互见[Source owner](#mcp-项目来源与原决定申请)，已完成的源码外键盘和当前完整默认验收及取舍见[Source 决定](../../../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

`@kite-ai/ui/tui` 提供 Ink 的 `TuiSession`、`TuiController` 和中立 `TuiPort`。终端没有复用 DOM renderer，也不导入旧 State、Runtime、SQL 或服务器。宿主先完成 Client identity 准入，再注入固定 Store 的 port；宿主负责连接、观察和配套 Service 生命周期，组件卸载或 controller.dispose 只释放视图读取。

`readSession` 必须返回固定上界穷尽后的完整历史与准确当前 view、原 interaction；不能把 getView 或目录首页当成完整历史。会话选择 Ctrl+R，上下与 Enter 只切换视图；Ctrl+L 先核实未知原 Command，再在选择未变时显式刷新并清理本地展示。迟到历史不能覆盖后来选择，读取失败保留同目标最后 snapshot 并标 stale；不同目标不展示旧正文。草稿按宿主固定 Store、实际 Workspace 与 Session 保存。快照不自动重新派发旧工作。

`/clear` 只记录当前显示基线，隐藏未改变的正文与已结束执行结果；原完整 snapshot、全文 reader、导出输入、草稿和已保存意图均保留。待决审批、活动执行、未知效果与诊断继续可见；新的正文、完整 reader 结果或执行版本变化会重新显示。相同会话刷新不清除基线，切换到其他会话后基线重置。此操作不读网络、不创建 Command、不取消工作，也不触碰文件；Ctrl+L 的原命令查询仍在清屏之前执行。[controller 测试](../../test/tui/controller.test.tsx)核本地显示、原历史和未知回执键盘顺序，当前 controller/management/export 三文件 39 tests / 305 assertions 通过，UI 类型与 owned 四源码 Biome 通过；真实 PTY 和全平台资格仍按整体进度核对。

普通文本在真实可引导 active Run 上封存原 Store、Session、contextSelection 与 targetRunId 后调用 steer；idle 才创建新 Run。维护压缩/reset Run 由宿主提供真实 activeCommand 后使用原 Run/context selection 的 follow-up，不 steer 维护执行。收尾 Run 不发送。原 commandId 在提交前由宿主生成；响应不可核实时显示 unknown，lookup 只 GET 原 ID，不重发。晚回执显示其原 Session，而不是新选中目标。Ctrl+C 取消准确原 Run 的 originCommandId；尚未观测 Run 的新 start 仍使用已封存原 commandId，重复取消去重。回执 accepted/applied 不证明实际停止，只有新投影可显示 Cancelling/终态。

审批输入 `approve` 缺省一次；只有原卡 request.grants 提供时可输入 `approve same_command`。Esc 只拒绝审批，Ctrl+C 是原 work 取消；普通 question 使用下述原 schema 步骤面板，复杂输入仍明确使用原 JSON，内部 choice ID 保留，服务端仍完整校验；计划批准只接受原 offered auto/accept_edits，不创建工具授权。空答案、EOF 和关闭没有默认批准。原卡附件必须经宿主公共完整 hash/UTF-8 reader 读取后才可答复，Ctrl+A 显式读取；未知回答只允许核实原 Command。保存答案并不代表 Core 已接纳或工具派发成功。

[questionForm](question.ts)只将完整可表达的标量 string、enum/const、互不重叠的 oneOf 选择及明确 anyOf 自定义分支转为单题或浅 object 步骤。Custom 可保原 string，或保一个 required 字符串属性且 additionalProperties:false 的闭合原对象；后者用于默认 ask_user，使同字自由文本与选项 ID 不混淆。[QuestionPanel](question-panel.tsx)展示原 title/description；选择提交原值，字段键不重命名。封闭 enum 不添加 Custom；其他复杂、嵌套、重叠或无法完整保留约束的 schema 回退显式 JSON。required 核实际自身 properties，当前 Core 不支持的 `__proto__` 属性/必填键也不生成表单。字符串 min/maxLength 按 Unicode codepoint 核对，仅准确 pattern `\\S` 表达非空白；其他正则仍回退。编辑沿 ComposerBuffer 字符簇、光标和多行 paste，不 trim 或截断原文。问题/选项正文与原答案不翻译，自有提示沿当前终端语言呈现。

步骤草稿按完整 interactionKey 的 Store/source Session/presentation Session/id/revision 保留，Esc 返回上题并保留后题内容；卡版本变化清旧草稿。首选项未选、空白自由答案、尚无答案且未明确跳过的 optional 字段均不推进。最后一步才调用原 controller.answer；附件未读完、stale/loading、原答案 pending/unknown 或已经保存时不增加 Answer。后继卡或切会话不能重绑原未知回执。局部键盘覆盖见[questions.test.tsx](../../test/tui/questions.test.tsx)，当前真实多题、逐项标题/原 ID、自定义原文与正常退出资格由[CLI owner](../../../../apps/cli/README.md#tui-普通问题步骤)维护。

所有 Model、Tool、标题和诊断正文的控制字符转为可读 `\\uXXXX`，保留完整字符而不执行 ANSI/OSC 或方向控制。`TerminalMarkdown` 使用实际 remark AST 展示段落、标题、列表、代码、引用和表格，图片/链接/HTML为文字。未知节点保留对应原文，不按字符数裁剪。Model output 只有 preview 时明确标记，Ctrl+O 调宿主已验证的完整 reader，复核原 Store/Session/Run/Execution 后显示完整 content；未完整前缀不伪造完整 Tool calls，reasoning 不默认显示。

当前正式 Terminal 已消费本终端入口。[TuiHistory](index.tsx) 将当前所有消息、非 Model 执行和原卡材料按原展示顺序交给 Ink `Static`，每项固定该次实际正文、全文及原版本，不假定活动消息的公开投影永远只追加。它保持在各面板共同布局的首项；状态、选择和编辑保留同一 Static 实例，不重发原材料，resize 使用 Ink 自有重排。原 Store/Workspace/Session、语言/主题，或正文、全文、执行结果、原卡/题目步骤/附件改变时，替换展示代次并清理旧原生历史；`/clear` 沿已有显示基线隐藏原项。清理使用 Ink 自有 stdout writer，恢复当前输入栏和光标，不建立第二份历史缓存、公共 DTO 或执行权威。取舍见[当前材料的原生滚动决定](../../../../.agents/notes/implemented/bug-fix/2026-10-06-current-tui-materials-scrollback.md)，原清理 writer 与完整 snapshot 的理由仍见[完成正文决定](../../../../.agents/notes/implemented/bug-fix/2026-10-06-completed-tui-scrollback.md)。

[QuestionMaterial](question-panel.tsx)完整显示原题目、选项文案/描述及稳定序号；底部 QuestionPanel 只显示当前题号、所选序号/Custom。[TuiAnswerInput](question-panel.tsx)由普通自由输入及复杂 question 的原 JSON 输入共同消费，只显示光标附近最多五个 ComposerBuffer 行，前后仍有内容时给出提示。复杂问题草稿也沿完整 interactionKey 保留；原 revision 变化清理原草稿，其他卡/会话保留各自输入。ComposerBuffer 保留完整原文及既有折叠 paste；可见窗口不截断答案。显示和 Home/End/上下移动共用当前终端列宽与本地化 Answer 前缀，软换行边界只显示当前可见行的一个光标。JSON 支持字符簇编辑、Shift+Enter 换行及完整多行 paste，Enter 仍沿原 controller 解析并提交原 JSON 值，附件及未知回执门禁保持；审批、Source Question 与方案的原选择/文本提交规则保持。

[scrollback Ink 测试](../../test/tui/scrollback.test.tsx)核原顺序、当前活动/待决材料、替换、清屏及保留输入栏；[实际80×24 PTY](../../../../apps/cli/test/isolated/tui-scrollback-pty.test.ts)核90个完成正文、40个活动正文、35行问题及60行选项描述，另核30项Unicode原 JSON paste及显式12行JSON输入。各场景从底部上滚100行后状态/编辑/改选零材料重发、resize、正文替换与单光标同时核对。[questions 键盘测试](../../test/tui/questions.test.tsx)另核完整原 JSON 值、唯一原身份提交、换行/字符簇编辑与卡/revision草稿隔离。该 PTY 使用有限公共 UI port 和实际 headless VT，未经过 Service/Provider；源码外默认问题及9MiB全文/导出另由[CLI owner](../../../../apps/cli/README.md#tui-原生滚动与清屏)维护。真实正文继续变化时仍会替换展示代次；任意长诊断、notice/回执、审批/方案文本和其他管理面板的动态高度尚未全面闭合，不据此承诺所有80×24帧均不溢出。GUI终端、Linux/Windows、完整持续负载和全部客户端能力仍按整体进度核验。大 Tool/Job 附件需要宿主专门 reader，完整目录/history分页由实际 port 与 Client 保证；局部 Ink 或 POSIX PTY 通过不建立其他范围资格。

验证：`bun test packages/ui/test/tui/controller.test.tsx`；实际配对与自有子进程 fixture 为 `packages/ui/test/isolated/tui/paired.test.ts`，需要本机 HTTP/PTY 权限。`bun run --cwd packages/ui typecheck` 与 build 同时产出独立 `dist/tui/index.js`，DOM产物不携带 Ink 入口。

本轮验证：Ink/port 7 项、49 个断言；macOS 实际 POSIX PTY + Service/SQLite 3 项、19 个断言。完成例通过原 approval、question 和超过 inline 阈值的 Model 全文末尾；取消例两次 Ctrl+C 仅一条准确原取消且 effects=0；输入 master 真实关闭后，原 Run 仍 waiting_interaction、effects=0，随后由 fixture 宿主显式 SIGTERM 清理。临时目录由外部测试 finally 管理，生产组件不拥有关闭服务器的接口。Fork 全文依照 observed originMessage 原 Store/Session/Run 读取，unsupported 格式不发起猜测读取；本地 201 条 history 与 17 MiB 数据是 port/Ink 资格，不冒称原生终端大正文压力或全平台资格。


[TuiManagementPort](management.ts) 只接收公共有限 DTO，提供完整当前 Context、原管理意图提交/查询、新 Session 和明确退出 callback；没有网络、SQL 或运行权限引擎。slash 路由见 [commands.ts](commands.ts)：`/new`、`/resume`、`/context`、`/rewind`、`/compact [focus]`、`/compact reset`、`/status`、`/clear`、`/mcp`、`/exit`/`/quit`/`/q`，以及开发 `/session rename <title>`、`/session delete confirm`、`/session fork <title>`。未知/不支持命令保留草稿、局部失败，零 Model 提交。管理意图封存点击时实际 Store/Session/workspace/selection/control revision，最多 128 个且未知不淘汰；晚返回显示原意图，不覆盖新选中目标。未知和 accepted/queued 仅查询原 Command，不重发。

Context 有独立读取取消域、固定选择与双游标，明确是当前投影而非历史 Model 输入。面板关闭只 abort 读取；实际 Fork 选择真实消息 ID/seq 或 `0` 空边界，`/rewind` 三范围 Files 端口与操作见下文，Include 仅引用已观测原 Execution/result revision，活动时封存准确 Run ID。压缩 Command 受理不等于完成，reset 前读取原 compression ID；缺可信 preflight 失败不改旧点。delete_requested 说明 stop 未确认，成功 Fork 明示 omitted extension state；未确认创建/失败不猜新 Session。普通维护期间输入保存为准确原 afterRunId 的 follow-up。实际效果和终态仍由宿主公共 Client/Core 决定。

[management.test.tsx](../../test/tui/management.test.tsx) 核对原版本/active include、late Fork、关闭读取、未知容量与维护 follow-up；实际开发 PTY 由 [CLI owner](../../../../apps/cli/README.md) 记录。新增有限 Context/Session slash 不改变正文控制字符转义、完整原输出 reader、EOF/审批或 observer 生命周期边界。


`/permissions` 不带参数，使用独立 [TuiPermissionPort](permissions.ts) 当场读取原 Session 模式、实际 Workspace 信任范围和完整固定上界授权目录；Model 等待期间也可读取。面板上下选择模式、D 明确选择以后 Session 默认值、T/U 核对信任/撤销、C 核对清除当前准确 Session 的授权；首次 Enter 只打开原观察确认，第二次 Enter 才提交，Esc 不改变事实。原 child 模式继承根事实且不能写，清除只选中 Session、不借根清除 child。读取、刷新、关闭或 EOF 都不提交授权。

写入封存确认时原 Store、Session/Workspace、两份模式 revision 或信任范围 hashes 与 revision；最多保留 128 个未决意图且不淘汰未知。重复/未知只 K 查询原 mutation，不再次 POST；CAS 失败不采纳新 revision 重试。只在原顶层 request.grants 提供时，原 approval 上下选项才包含 same_command；没有选择时 Enter 零回答，新卡/决定版本不能沿用旧选项。plan/question 与 Model 批准不制造 Tool/Job grant。保存控制或答案只显示原回执，不声称已派发或停止。

[权限 controller 测试](../../test/tui/permissions.test.tsx) 验证原 CAS、迟到、关闭、child 继承与未知原查询；实际 macOS PTY 的 [child 卡测试](../../test/isolated/tui/child-permissions.test.ts) 两项保留原 child/presentation 根关系，完成例批准与问题均通过原卡，EOF 例 child 等待、父 Tool 实际等待 child、零回答/效果。实际默认 Shell 同命令 grant 保存/清除与 mode/trust 的配对证据由 [CLI owner](../../../../apps/cli/README.md) 维护。这些 child 与权限断言未建立三平台终端或完整设置资格。


`/export` 仅冻结当前已加载会话的 user/assistant 文本与已验证 loaded reasoning，调用 [纯 Markdown serializer](export.ts) 和宿主有限 `TuiExportPort`。组件不接受目标路径，不读取历史/全文，不创建执行；未读 Model output 保留当前真实 preview 并明确注明，不将 metadata 或 Artifact 引用当正文。Ctrl+O 完整校验成功后，视图同时保留 content/reasoning 供导出；普通屏仍不默认展示 reasoning。已加载 Markdown 按不可变正文复用解析和渲染节点，输入草稿与导出 notice 更新不会反复解析整份大正文。运行中仅反映点击时加载的前缀，Tool、审批、诊断不是此 Markdown 导出内容。会话切换/卸载 abort 本视图写入等待，迟到成功不写入新会话提示；写失败保留 `Export failed`。

[export.test.ts](../../test/tui/export.test.ts) 验证正文/reason 尾部、未加载零 reader、原身份冻结、Tool 排除、late 与失败。原始 Session 数据导出是另一公共 API，不由这个已加载文本命令代替。

[TuiDraftPort](drafts.ts) 是有限私有文本接缝：UI不接收profile、文件路径或OS锁。宿主读取原scope后才hydrate；编辑自动通知host，切换先flush。accepted/applied只清当时原编辑revision，迟到与ABA编辑保新文；unknown/failed保原文，查询原Command不会重发。`/drafts`显示已落盘目录，`/draft <id>`只读原全文/current或unavailable，不插入composer或绑定新Store。存储失败保当前可编辑文本并明确错误，正常退出保存失败由host阻止；目录不声称包含未落盘的内存冲突。没有新增无真实产品owner的偏好或持久队列。[drafts.test.ts](../../test/tui/drafts.test.ts) 验证此接缝；实际文件/PTY与独立lease由 [CLI owner](../../../../apps/cli/README.md#开发-tui-持久草稿) 负责。


持续观察与单次快照分别记录：原 SSE 不可用时，即使随后 HTTP 快照读取成功或用户切换 Session，controller 仍保留 observation 错误并显示 stale，草稿和已确认事实不丢弃。单次读取成功只能恢复快照可用性；只有宿主传入公共 Client 已验证的原 Store SSE ready 才恢复持续观察状态。ready 不能掩盖失败的快照读取，错误 Store 也不能恢复。合法 reset 先固定读取基线、完整重读原事实，再等待新流 ready；业务写入仍要求当前视图可用，不把原 snapshot 成功当成已恢复持续观察。


`/model` 与 `/effort` 通过独立 [TuiModelPort](models.ts) 读取专门模型设置事实，[model-panel.tsx](model-panel.tsx) 仅提交有限 default、enabled、effort 操作。项目设置作用于同 Workspace 的后续执行，活动 Run 继续使用原冻结配置。模型按 Provider 和准确 ID 排序；Enter 先核对默认模型修改，E 先核对启禁，再按 Enter 保存。推理深度只显示 API 明确提供的 compatible wire 选项及清除项目 effort；只读原因可见，缺元数据不推导支持，清除后的有效值必须重读，不能承诺必然继承用户层。

R 重新读取、K 查询原 mutation、Esc 放弃确认或关闭。提交封存原 Store、Workspace、Session、read-set 和 operation；最多保留 128 个意图，未知不淘汰、不重发、不换 CAS。确定的 4xx 拒绝显示保存失败，mutation_incomplete 保持未知；保存失败可以在明确重读后重新选择；丢回执保留 unknown，原查询核对完整安全 marker。持续观察 stale 时只读、零写；面板关闭只取消读取，迟到结果不覆盖后来会话。controller 证据见 [models.test.tsx](../../test/tui/models.test.tsx)，真实终端证据由 [CLI owner](../../../../apps/cli/README.md) 维护。


`/status` 使用 [status port](status.ts) 与 [status panel](status-panel.tsx) 展示实际宿主身份、profile名、paired/shared来源、当前连接和独立观察状态，以及有限执行/发行/遥测事实。R重读，Esc或Ctrl+C仅释放所属诊断。controller固定当前Session/Workspace和读取代次，切换或关闭后的迟到页不发布；GET失败保同scope最后确认值并标当前unknown。GET成功不能清除SSE失联或快照错误，不产生mutation。宿主负责HTTP原身份核验与实际装配，UI不接收token/URL/路径，不把注册或监督状态解释为授权。

[状态controller与Ink测试](../../test/tui/status.test.tsx)验证闭面/切换/dispose的读取隔离、GET健康不清SSE未知与显示字段限制；真实PTY由CLI owner维护。

`/skills` 使用 [TuiSkillsPort](skills.ts) 读取同一 revision 的完整知识目录；host 负责公共 Client 分页，controller 核原 Store/Workspace、complete 与无后续 cursor。[面板](skills-panel.tsx)只用五行视窗浏览全部条目，详情按页保留完整名称、ID、版本、状态/原因、依赖/缺能力和描述，不以列表 preview 冒充全文。R 重读、Esc/Ctrl+C 只取消读取，切换/关闭/dispose 后迟到值丢弃；失败或 source unavailable 保留同范围最后事实并标当前 unknown，成功 GET 不清 SSE stale。宿主确认 `workflowActivation` 时，独立投影显示 Workflow 资格与唯一合格的动态命令；查看面板不产生激活。

动态 `/<compiled-name> [task]` 在固定命令和别名之后匹配，重新读取完整 manual 目录后只接纳唯一、允许手动调用且 `{}` 合法的 Workflow。知识名字只用于不可用原因，不能授权。原草稿 revision、Store/Workspace/Session、读取代次和 active Run/selection 在提交前复核；目录等待期间的新写入、未知意图、编辑、切换或取消不能由迟到目录再发新工作。任务只进入 content，省略保留旧默认任务文字，`extensionInputs` 原空对象和 command ID 在提交前冻结。idle 发 `run.start`，active 发准确 `input.follow_up`，不用 steer 改写活动契约。

提交和查回复用原 port，核 Store/Session/command kind；unknown 只 GET 原 ID。accepted/applied 只以原草稿编辑版本及存储 revision 清理，迟到或 ABA 编辑保留新文。目录 revision 仅约束该次读取，实际执行的源码版本由 Service 开始时核实，不新增未来版本预订。

[Skills controller/Ink 测试](../../test/tui/skills.test.tsx)覆盖303条完整目录导航、详情全文、不可用与空目录区分、错误scope/未完成分页、读取隔离、动态输入/固定名/重名拒绝、start/follow-up、丢回执原查询及实际 Ctrl+L 按键。真实配对/共享终端证据归 CLI owner。

实际配对全文fixture从当前controller快照核原Store/Session/Command对应Run已completed、同Run已成功Model与完整outputBody后，才让PTY按Ctrl+O。预览出现不是完成证据，任意缓存全文也不停止后续快照刷新；原8秒等待、完整正文末尾与实际审批/问题效果断言保持。该同步只用于测试资格，不放宽生产reader的原输出身份校验。

`/theme`、`/language` 使用 [preferences port](preferences.ts) 与 [选择器](preference-panel.tsx)。有限快照包含文件 revision、language、实际 resolvedLanguage、colorPreset 和基础 theme；组件不接收文件路径、profile 使用权或任意配置编辑。启动读取已确认值，Enter 只按原 revision 保存明确单字段；保存失败保旧显示、R 重读，冲突不换 revision 自动提交。偏好独立于 Session 与观察状态，更新 [呈现 context](presentation.tsx) 保原 controller、草稿、审批卡、已读全文与管理意图。选择器内 Esc/Ctrl+C 仅关闭，保存中的重复 Enter 不重复调用。

呈现层只翻译显式自有文案，原用户/Model/Tool 正文、路径、命令和机器码保留；语义色提供五种配色与 dark/light 基础主题。关闭面板后的同 profile 保存结果可更新全局显示，但不重开选择器；dispose 后迟到结果不发布。文件持久化和维护资产资格由 [CLI owner](../../../../apps/cli/README.md#开发-tui-显示偏好) 维护。


原答案提交独立封存 presentation Session、Interaction ID、原决定 revision 和完整 Answer request；成功只接纳准确 `interaction.answer`、原 Store/Session/Command 与 `applied/answer_saved` 回执，并核对决定 revision 为原版本加一。身份错误、仅 accepted 或丢回执保持 unknown，未知时仅 GET 原 Command，零重复 POST；同一原卡版本已保存后不再次答复。取消回执不会覆盖未知原答案的恢复意图，其他未知命令仍保留各自查询身份。Ctrl+L 先核实未知原答案，即使原 work 已结束或视图已切到其他 Session，再在选择未变时刷新当前快照。它不从 saved 推导 Core 已接受决定或工具已派发。

[controller 测试](../../test/tui/controller.test.tsx)补充 kind、Store、Session、Command、Interaction、决定 revision、outcome 和仅 accepted 八类反例，核对原请求冻结、取消去重与准确原 work、切会话/终态后的原 GET、实际 Ink Ctrl+L 查询与刷新顺序。当前组合回归为 9 文件、63 测试、528 条断言；这是 controller/Ink 资格，不替代真实 Workflow 问题的 HTTP/PTY 或全平台资格。

`/recovery` 打开独立的显式冷恢复面板；输入 `run <original Run ID>`、`report <original report Command ID>`，或 `interrupt confirm` 明确确认原根 Session orphan 执行组。组件只消费 [TuiRecoveryPort](recovery.ts) 的有限公共 DTO，不获得 profile、SQL、token 或运行权限。原 ID 必须明确输入，不从当前 active Run、有限 view 或 pending input 猜报告。port 缺失、child 身份、stale 观察、未明确确认或已有 submitting/accepted/unknown 原申请时局部拒绝提交。

controller 在提交前保存原 Store、Session、commandId 与目标请求，最多 128 个申请；submitting、accepted、resumed、interrupted、suppressed、failed 和 unknown 分别显示。回执和实际 Run 通过公共专用 decoder 与原 command/目标/来源绑定，applied 不代替完成。切换会话后保留原申请，Ctrl+L 仍先核实原未知 work/answer，随后只查原恢复 command；Ctrl+C 和 Esc 只释放面板所属读取，未知恢复意图不会变成当前选中 Run 的取消。普通输入在原申请未核实时保持阻断，原回答恢复规则不变。

[恢复面板](recovery-panel.tsx)沿 Ink 的独立 paste 通道保留粘贴文字，粘贴的 Enter/Ctrl 字节不能发起恢复或原查询。原生 Ctrl+C/Ctrl+L 在同一输入块中仍逐项先取消所属读取、再查询原申请；只处理这两种控制字节组成的批次，不引入通用键盘路由。已取消原 GET 的晚回复或异常不覆盖后续查询；原 POST 的已发生结果继续按原身份保存，读取取消不撤销写入。当前控制批次、literal paste 和迟到回复反例由 [recovery.test.tsx](../../test/tui/recovery.test.tsx)核对，业务窗口由 CLI owner 负责。

[recovery.test.tsx](../../test/tui/recovery.test.tsx) 核对 scope/kind/目标/来源的稳定反例、重复提交抑制、独立读取取消与跨 Session 原意图；这些有限 port 反例不是业务成功资格。真实默认 Service/SDK、SIGKILL、单 POST/首 GET 丢回执和 80×24 PTY 原 Run/interrupt 的结果见 [CLI owner](../../../../apps/cli/README.md#显式冷恢复消费者)。controller 的 restore 接缝只接纳 host 持久目录中的闭合原意图；冷 submitting/accepted 保持 unknown，首次 POST 前的持久化由 CLI host 完成，UI 不打开文件。恢复目录读取失败阻断新申请，旧 Store/Session 不重标，满 128 槽不驱逐 unknown。真实 TUI 宿主 SIGKILL、配对 Service 重启、原 GET 和 configured-host report 资格见 CLI owner；公共完整目标目录、默认后台汇报开启、全部崩溃窗口、正式旧入口和其他平台仍未由此切片验证。

主输入由 [composer](composer.ts) 与 [Ink 接缝](composer-input.tsx) 管理。真实正文仍通过 controller/host 草稿端口保存，光标、固定命令候选和最近 100 条输入历史仅保留在当前 UI、按原 Store/Workspace/Session 隔离。左右与删除按 grapheme，Home/End 按当前视觉行，跨多行上下在输入边界才进入历史；显示只取光标附近五行，完整正文不截断。使用已声明的 string-width 计算终端 cell，不从 UTF-16 长度猜中文/emoji宽度。

Ink usePaste 独立消费真正 bracketed paste，原换行不会成为 Enter；长或多行粘贴以一个可整体删除的显示块保存，但草稿、提交和历史保留完整原 UTF-8。固定 slash 候选只包含现已实现的命令；上下选择，Tab 只补全，Esc 关闭，后续编辑可重开。文件候选由 [有限只读端口](file-candidates.ts) 提供原 Workspace 相对名称，UI 不接收根目录或打开 FS；host 每次核原 Store/Session/Workspace。完整分页后上下选择所有匹配项，显示窗口不等于目录裁剪。Tab/第一次 Enter 只替换光标所在完整 `@` token，空格、引号和反斜杠采用闭合 JSON 引号文本，中文保持原字符；不自动读附件或扩大权限。Esc 或候选焦点下 Ctrl+C 只关闭、取消 reader，后续编辑可重开；等待/失败时 Enter 不发送，Esc 回普通输入。原 scope、草稿版本、token 和 snapshot 固定，切会话或迟到页不改新草稿；粘贴块不会拆开用于补全。编辑不授权发送，stale/原 unknown 的 controller guard 保持；其他面板和原审批取得焦点时主 composer 不消费按键。

`/background` 使用 [有限 execution port](executions.ts) 与 [独立 Job/child 面板](execution-panel.tsx)。列表只展示原 Store/Session 的实际 Job；O 读取完整保留输出，C 读取实际 child 历史，S 后 Enter 对明确原 Job 发起一次停止。提交前重新 GET 原 Execution 核 ID、Store、Session、kind、当前状态和取消标记；停止独立于父 Run，不借用父取消权。回执核原 execution.cancel Command 和准确 Job ID，applied 仅表示已请求取消，终态仍由实际 Job 状态确认。响应丢失保留原请求，Ctrl+L 只 GET 原 Command；切会话或关闭面板不重投。CLI host 提供 caller port 时，原 execution.cancel 在首次 POST 前持久保存到所属 caller journal；宿主强杀后从 `/recovery` 显式查原 Command，不重发停止。未提供 caller port 的有限组件宿主只保留 controller 内存意图，不具有这项冷查回资格。

输出按首个 highWaterSeq 冻结，穷尽每页并保留各 stream 的 seq/throughSeq、明确 droppedBytes gap 和全部原 UTF-8；不把 gap 补成正文，不累计截断。child 阅读先用准确 getExecution 遍历原 parent chain，再核 child 的 Store、父 Session、根 Session 与 Workspace；冻结 contextSelectionId/历史上界，穷尽原消息页，并用具名 Model reader 核完整输出的原 Store/Session/Run/Execution 与字节元数据。结束前重新核 carrier/parent 绑定和 child selection，缺关系或绑定变更失败。完整消息页与完整原 Model 输出分别展示，child ID 只授权阅读。Esc/Ctrl+C 及 Session 切换只停止读取，迟到页不会发布到新 scope。

[真实 80×24 Job/child PTY](../../test/isolated/tui/executions.test.ts) 使用 owned Core/Service SQLite 和显式无害 host policy：两条独立 ordinary Job 各保留 223 条跨 stream 输出与真实 gap，只有明确选中的 Job 被停止；另一个继续成功。父 Run 完成后 child 的两批实际工具产生超过 200 条消息、200 次效果和三次 Model 调用，最终唯一外置 Model 正文经公共 reader 完整核验。实际取消读取/切 Session、SSE 断开时拒绝新停止、停止 POST/首原 GET 丢回应后仅第二原 GET 复原都有线端与持久状态断言。它不证明应用强杀后的意图持久化；该范围由 [CLI caller Job stop PTY](../../../../apps/cli/test/isolated/tui-caller-job-stop.test.ts)另验。两项都不授予默认 ProcessService Shell、正式制品、其他平台或文件/网络隔离资格。

`/plan` 和主 composer 的 Shift+Tab 只切换下一次 Planning 草稿意图，按原 Store/Workspace/Session 的本地版本保存；不修改 Session 权限、Full 设置或其他会话草稿。`/plan <任务>` 明确提交一次规划任务。提交用现有 extensionInputs 的闭合 builtin.planning/1/mode:plan envelope；无活动 Run 时 run.start，有活动 Run 时准确 afterRunId/contextSelectionId 的 input.follow_up，不把新 Planning 意图 steer 到旧 Run。原请求深冻结，结果未知只查原 Command，保留原文字；原受理回执只消费其 Planning 版本，新编辑、再次 toggle 或另一 Session 不被迟到结果清除。模式不持久化为 profile 默认，工具权限及选定 auto/accept_edits 上界由 Service/Core 按当前权限共同判断。

[Planning 协议反例](../../test/tui/planning.test.tsx) 核对 Shift+Tab/空 slash 零提交、原作用域、深冻结、active Run 原 follow-up、unknown 仅原 GET、迟到版本与 stale 零 POST。CLI 的 [真实 Plan PTY](../../../../apps/cli/test/isolated/tui-planning-host.test.ts) 独立验证 slash-task、bare /plan/Shift+Tab/plaintext、active queued 和跨 Session 草稿四个 80×24 窗口：实际默认 Service 在原 Full 下拒绝计划批准前的写入，原大 Plan Artifact 通过公共完整 reader/hash/scope/UTF-8 后才能回答；approve accept_edits 的原决定保存后实际写入一次、进度引用真实效果且原 Run completed。POST/首 GET 丢回应只查询原 answer Command，不借父批准或把模型自述当完成。实际 queued 窗口持有原 Model 时只受理准确原 Run 的 follow-up，原 Run 完成后才生成唯一新 Planning Run；跨 Session 窗口保留另一原草稿模式和完整文字、零另 Session Run。申请本身在客户端强杀后的原意图查回、其他平台和正式旧入口尚未由该 fixture 验证。

[实际文件候选 PTY](../../../../apps/cli/test/isolated/tui-file-candidates-host.test.ts) 使用 compiled owned Service、真实 SDK/SQLite 与 80×24 Ink：605 个文件完整分页，中文空格及转义路径精确草稿，Tab/Esc 后编辑/Ctrl+C 网络零 POST、零新 Run。实际跨 Workspace 延迟原页只被丢弃；有限端口反例另核错 scope/编辑版本/取消。常见忽略目录及隐藏项保持，受限 .gitignore 使用准确注释/否定/嵌套作用域；坏 UTF-8、硬链配置、外部符号链接等子树显示 incomplete，健康候选仍可补全。该只读目录资格限当前 macOS；其他平台、正式入口切换仍由整体交付负责。

普通 Work 与准确取消另外消费 [TuiCallerPort](caller.ts)：原 Store/Workspace/Session/subject/Command/request/digest/target 和独立原 draft proof 由 host 冻结并在 POST 前持久发布。UI 的 caller map 与答案、显式 Run/report/interrupt、管理意图分开；冷 unknown 阻断新 Work/Job Stop，原 GET 不依赖有限 view 猜目录。提交及查回的完整 intent 必须保持同一冻结身份，missing/mismatch 不发布成功。只有 host 能授一次新 POST；同 ID 的 prepared/submitting 也只读。

`/recovery` 支持只提供 caller port 的有限宿主，所有保存记录可选择，Ctrl+L 原 GET、Ctrl+V 完整请求、Ctrl+D 只清已核实终态。Ctrl+C/close 只停读取；accepted/applied Work 与实际 Run 状态分离，execution.cancel 显示 cancel requested 而非 Job 已清理。冷查回不清新 draft/Plan toggle，原 Work/steer/follow_up envelope 与 Job target 不漂移；局部 prepare 失败零 POST、保原文并明确拒绝，不假造 unknown 回执。CLI host 负责 version 1、128 槽/16 MiB、私有 profile-use/锁、fsync/CAS 的 `ui/caller-intents.json`，维护只归档原字节，实际含固定 Auth 请求时使用 v13，旧 v4–v12 请求文法保持；组件没有 FS、profile/token 或私有 lease。

[CLI owner](../../../../apps/cli/README.md#tui-普通-caller-的持久原意图) 给出真实 80×24 强杀、原 POST/首 GET 物理丢回执、五种 caller、公有 identity/digest 缺失反例、大正文与容量/坏文件范围。普通 Work PTY、配置 Shell Job 窗口、三种 compiled paired 原请求分别验证各自断言；不将这些切片替代 §35 完整 TUI、正式旧入口或其他平台资格。


`/rewind` 消费 [management.ts](management.ts) 的 `TuiFileRecoveryPort`，展示完整分页恢复点、实际预览、三范围选择和原两 leg。上下选择、Enter 预览，1/2/3 选择 session/code/both，再 Enter 明确申请；L 查保存的原 intent，R 只查原 receipt 或重读目录，C 明确继续尚未开始的第二 leg，A 关闭恢复面板以回答原独立审批。Esc/Ctrl+C 只关闭所属读取；切 Session、编辑或 selector 变化停止迟到读取，不取消 Run/Job。只读目录入口不借 SSE stale 作为执行许可，begin/continue 在实际 host 重核 scope 与 Core 最终门禁。

controller 在首 await 前发布 submitting，重复确认不产生第二 intent；scope/point 改变清旧预览和未提交选择。code-only 保原会话，Fork 成功只切准确原 newSession 回执，unknown 原 GET 不补发。UI 不持热 permit、profile/FS 或 token；完整 intent 与 fsync/两 leg 证明由 [CLI host](../../../../apps/cli/host/file-recovery.ts)负责。[有限端口测试](../../test/tui/file-recovery.test.tsx) 核重复确认与关闭/换会话晚回；真实编译 PTY/SIGKILL 证据由 [CLI owner](../../../../apps/cli/README.md#files-三范围恢复-caller)列明，不扩称 DOM、Native 或全平台资格。

## MCP 安全目录与原选择意图

列表与Server详情提供独立“Saved tool snapshots”，冷或removed Server的历史不依赖当前目录成功。[tools state](mcp-tools.ts)及[panel](mcp-tools-panel.tsx)按原snapshot/generation/indexDigest逐页选择工具；名称预览标示未完整，description/inputSchema/outputSchema及其他原字段在公共reader完整EOF/hash后展示，有限10行viewport仍可Home/End、上下/左右到尾部。长Server ID的snapshot行先显示原generation，选择身份仍为完整record key。

controller固定原Session/Workspace/read generation及独立Abort；返回/关闭/切scope/迟到只释放所属reader，零业务Command/Model/cancel。分页非null next必须严格超过原afterKey，合法filtered空页仍可前进；失败或错binding没有complete。Port的三个metadata方法可选，旧consumer维持原能力；实际CLI Host全部实现。[新Ink/viewport反例](../../test/tui/mcp-tools.test.tsx)与原15MCP及Host组合25/550/0，核后页工具、Unicode长尾、长Server ID、错generation、闭合cursor、取消/迟回零business；真实HTTP/Artifact及源码外PTY由相应owner证明。

`/mcp` 保留固定命令优先级、无参数文法与可见 Select。独立 [MCP port](mcp.ts)只接固定安全 Query、Server选择提交及原结果lookup；[panel](mcp-panel.tsx)完整浏览32项有界目录，上下/Enter打开详情、选择用户或项目启停，再独立Enter确认。刷新和原结果查询来自可见选项，不恢复字母业务键；Esc/Ctrl+C只停止所属读取，原Run/审批不取消。有限源ID和状态可见，raw command/URL/env/header/credential/read-set hash不渲染。

controller固定读取代次及原Store/Session/Workspace/identity/read-set，过期/只读/未准入时零提交。最多128个intent，不驱逐unknown；未知user写入阻止跨Workspace冲突、当前Workspace未知阻止本scope新写，CAS失败不换版本重投。host 私有 journal 恢复的意图先按未知显示，不恢复 readproof 或 POST 权利。列表与详情都提供同 Session 的保存原 ID，不依赖目录成功或 Server 存在；上下/Enter 仅选择，再显式选择原结果查询才 GET。accepted只等待，unknown只查原命令；关闭或换Session的迟到结果保原Map，不污染当前显示。严格decoder拒未来字段、错数组/长度/hash/enum；同scope读取失败保最后事实标unknown，GET成功不清SSE stale。

[Ink/controller测试](../../test/tui/mcp.test.tsx)当前15项501断言通过，包含空目录和失败目录中真实上下键选择第二个保存原 ID、再显式原查询且零 submit；较早数组 enum coercion 的严格字符串反例保留。普通Action/HostMutation效果、durable prepare 与冷 GET 由[CLI host](../../../../apps/cli/README.md#tui-mcp-目录与配置选择)负责；当前源码的实际 PTY 1项21断言另核 active Run/审批/草稿不被管理面板取消。[冷重开真实 TUI](../../../../apps/cli/test/isolated/tui-mcp-cold-pty.test.ts)另以真实80×24键盘在空目录选择第二原 ID，明确原查询后核原回执、冷轮零 POST，当前1项44断言只证明 macOS paired 正常退出后的重新打开；不混称独立 SIGKILL/物理丢响应资格。完整认证、重连、增删和三平台/安装资格仍按整体进度核对，不将有限启停当完整MCP中心。持久取舍及原Select理由见[scoped MCP提案](../../../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md#当前-tui-的有限-server-选择)。

## MCP 项目来源与原决定申请

[Source DTO](mcp-source.ts)通过可选 `TuiMcpPort.source` 独立提供完整安全快照、原intent及有限fact，不导入Runtime、SQL或FS。[Source panel](mcp-source-panel.tsx)从空或失败的管理目录仍可进入，25项本地分页和原ID列表不借管理32项上限。有效workspace source binding/transport可Review，未准入、已拒绝、禁用及已准入均可申请，用户/程序源不获项目审批入口；独立确认只submit原申请后返回待决卡，不预答Question、不连接或授Tool权限。

[专用Question识别](mcp-source-question.ts)只接准确Source Action@1、pending question、原Execution/Store/S及request.kind。schema须闭合object/additionalProperties:false/required decision enum三值，choices同顺序string。[输入层](index.tsx)沿完整interactionKey隔离原Store/source/presentation/id/revision，初始unset；上下显式approved/rejected/cancel，空Enter零Answer。revision/scope清旧选择；该Question的Esc仅清选择/草稿，Ctrl+C再closePanel，均不业务取消；其他Question和credential分支保持。

controller的SourceReader沿Abort、generation、原S/W、panel及原Command ID阻止迟到覆盖。原ID按同Workspace可跨Session或显示foreign Store，选择零GET、明确Check原S/Command才lookup；关闭/返回/切scope只结束所属读取。新申请冲突只核当前Store+Workspace+Server，unknown/pending不因换S解除。迟到submit结果更新原记录，不能覆盖后来选中的ID。cold journal终态只显示unknown；saved/failed/cancelled文案还要求有限fact匹配准确Store/S/Command/server/phase，pending只表示等待。

[Source controller/Ink](../../test/tui/mcp-source.test.tsx)当前24项132断言通过，原四controller/MCP/connection/Tools邻接63项873断言通过；固定文案沿[presentation](presentation.tsx)翻译，原Server metadata不翻译。当前证据涵盖明确选择/空Enter、schema/revision/presentation反例、同W跨S/foreign记录、removed/failed目录、迟到及关闭读取，不新增真实HTTP、PTY或异常清理资格；真实Host与源码外keyboard由[CLI owner](../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)分别维护。

## MCP 显式连接与原申请

[独立 connection 类型](mcp-connection.ts)经可选 `TuiMcpPort.connection` 接线；UI只持确认、原意图与有限事实，不导入Agent runtime、SQL或宿主私有配置。当前有效目录中已admitted/selected/available的Server才有“Request connection”，先选操作再独立Enter核准确Server/source/transport/Session。controller把准确observed snapshot传给host，原Command和key各生成一次；列表/选择/确认第一步均不提交。普通Action和实际connection Job许可分别由Service决定。

独立Map、读取代次与Abort区分当前选中申请和所有保存申请。空/failed/removed目录仍提供同Session原ID；上下/Enter仅选择，独立“Check original connection”才GET。热提交晚到结果保存原Map，但不能覆盖后选ID、关闭面板或后来会话；lookup切换/关闭只abort所属reader。pending/unknown阻止同Store+Session+Server的新冲突，冷list按unknown恢复而不恢复热POST权或当前live证明，未知不删除。

显示原catalogue ready、当前live/currentGeneration与created/reused各自事实。accepted不显示ready，warm复用不称新建，冷ready不称当前live；错误或无法核验保持unknown。原Select和Tools菜单位置保留，新选项在同一五行viewport完整导航，无字母业务快捷键。关闭/Esc/Ctrl+C不取消已提交工作、原Run或审批。

[新connection controller/Ink](../../test/tui/mcp-connection.test.tsx)、原15Select、7Tools与7preferences组合当前38项699断言通过，覆盖确认、原ID零GET、明确查回、空失败目录、迟到及读取隔离。MCP与Tools固定提示沿[presentation catalog](presentation.tsx)翻译；Server ID、availability/reason、工具名称、描述及完整Schema JSON保持原文。[Tools中文键盘测试](../../test/tui/mcp-tools.test.tsx)实际切换语言、跨工具页及End至Unicode尾部，保持原metadata字节与已发布对象，切语言无新增reader或业务调用；英文源码外PTY不作为中文现场证明。真实普通审批、journal及源码外80×24暖/冷/共享detach资格归[CLI](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)。此切片提供显式新申请与warm复用，认证、强制重连、完整增删和三平台仍按整体进度核对。

## MCP HTTP 认证与原申请

[Auth DTO](mcp-auth.ts)与[panel](mcp-auth-panel.tsx)通过可选TuiPort.mcpAuth接当前HTTP Source和原Caller。完整fresh Source/read-set只用于新Review/独立Enter确认，Login/Refresh/Clear/Revoke均普通申请；UI不持Vault、网络、callback或热POST权。仅显示safe backend/presence/有限状态及原IDs，authenticated提示另行重连，不将Command.applied显示成功。

复用原Caller map/journal和execution.cancel。冷原ID/选择零GET，明确Check才caller.lookup+原结果Query；空/failed/removed Source仍保历史。unknown阻同scope冲突，不淘汰记录。Abort/generation/原Store/S/W/selected ID隔离Reader，迟到提交只保存原记录；关闭/Ctrl+C/切S不取消业务，取消需核准确原Execution再独立确认。

[Auth Ink](../../test/tui/mcp-auth.test.tsx)实际英文/中文Review/Confirm、冷第二ID→Check、语言切换零新增prepare/submit及原机器ID保真。[源码外80×24 Auth PTY](../../../../apps/cli/test/isolated/tui-mcp-auth-pty.test.ts)另核五次真实键盘Review/Confirm及Source/physical Workspace移除后的冷第二原ID→明确Check；普通Ask由observer SDK回答。Host、实际wire与资格范围归[CLI](../../../../apps/cli/README.md#tui-mcp-http-认证与原申请)，准确结果见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。Ink和受控PTY不代替真实浏览器或OS Vault资格。

## MCP 强制重连与原申请

[独立 DTO](mcp-reconnection.ts)、[state](mcp-reconnection-state.ts)与[panel](mcp-reconnection-panel.tsx)通过可选 `TuiMcpPort.reconnection`接线。准确原 connection/R有限fact确认live后，Review调用host重新观察完整target和当前replacement；确认页独立Enter才产生本次原Command/key。UI不持Core ticket、transport、文件、vault或热POST权，原Action和新Job仍分别使用普通审批。

controller按原scope、selected ID、Abort和generation隔离读取，热submit迟到只更新原Map，不覆盖后选ID或后来Session。同Session原ID列表在空、失败、removed目录仍可进入；只选择零GET，明确Check才lookup。冷记录保持unknown；事实匹配原Store/S/Command/inputDigest及closed protocol后才显示ready/failed，旧停止、原ready代次和当前live/currentGeneration独立，合法当前代次可以高于原ready代次。

实际CLI事件刷新用 `select(sessionId, { preserveReconnectionReview: true })`，仅健康的同Session历史刷新保留准确原Review对象，不重观察或提交。显式选择、Session/Workspace变化、observation unavailable和失败历史快照仍使旧Review失效；失效时Abort既有在途Review/原查回Reader，迟到回复即使忽略Abort也不发布旧确认；随后恢复ready不复活它。健康后台刷新保留在途读取状态。独立Confirm继续核当前carrier及Host的完整fresh target/source/read-set，Scope关闭只释放Reader。[回归](../../test/tui/mcp-reconnection.test.tsx)实际27项165断言；当前全TUI24文件234项1968断言，均限对应测试范围。

未知原申请阻同Store+S+Server冲突，不淘汰128条或换key绕过。Esc/Ctrl+C关闭重连子面板后返回父MCP，再关闭父面板回Main；待决卡继续，完成普通回答前不要求New Run composer出现。physical Workspace移除后父面板标题为unavailable，原结果读取仍可用。Scope关闭不取消R/Run/Job或原审批，固定文案沿presentation三locale，metadata和原身份保持。

[Ink/controller测试](../../test/tui/mcp-reconnection.test.tsx)覆盖独立确认、select零GET、冷/foreign/scope/late/unknown、ready/currentGeneration反例和上述后台刷新边界。真实Host、journal、源码外80×24和收尾资格分别归[CLI owner](../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)及[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不由UI fixture推导HTTP、完整默认或三平台。

## MCP 来源条目增删与原申请

[独立 DTO/port](mcp-source-mutation.ts)与[panel](mcp-source-mutation-panel.tsx)通过 `TuiMcpPort.sourceMutation`接固定 Source 操作。父面板“Source entry changes”在空目录或目录失败时仍可进入。Add 逐步编辑自己的 name/value buffer，选择 HTTP/STDIO 与 user/workspace；不调用 Composer、Workflow、模型或通用 raw patch。空 Enter、非法 URL/command 保原 draft；Review 可上下/Home/End 滚动，Enter 进入独立 Confirm，第二个 Enter 才 submit。普通 Action 审批和 project Source 批准仍分别走原交互。

Remove 先让Host以原scope/serverId/raw digest/read-set读取安全preview，Review/Confirm显示user fallback或无fallback。确认变更准确声明；自有OAuth本地清理、共享凭据保留和原连接未停止分别提示。UI不持文件、Vault、token、OS锁、Mutation authority或热POST权；saved只证明声明发布，可选credentialCleanup单独显示not-needed/completed/failed/unknown。

controller 隔离原 scope/generation/Abort/selected Command。来源目录与 preview/原申请查回使用各自有界 Reader；选择或查回原 ID 不取消目录读取，各自的 Reading 状态直到所属读取结束。同 Session 历史刷新保留这两种在途状态；关闭、切 Session/Workspace 取消两者，刷新目录只取消旧目录 Reader，忽略其迟到事实。原 ID 列表包含跨 Session 的相关 user/project来源意图；选择只切本地记录，明确 Check 才 lookup。cold/foreign 和不完整原事实保持 outcome_unknown；late submit 只回原 Map，不覆盖后来 Session 或所选原 ID。Esc 回表单步骤或父面板，Ctrl+C 只结束所属读取，已提交工作与普通审批继续。原 phase、ID、reason、来源 JSON、URL 和 command 保持原文；固定自有提示沿 [presentation catalog](presentation.tsx)提供三 locale。

[真实 Ink/controller 测试](../../test/tui/mcp-source-mutation.test.tsx)覆盖逐键编辑、空值零 submit、独立 Review/Confirm、fallback、原选择零 lookup、late/scope 和已关闭读取；HTTP、持久 journal、物理丢回复、源码外 PTY 与正常资源关闭分别由[CLI owner](../../../../apps/cli/README.md#tui-mcp-来源条目增删与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)提供实际证据。本地 UI 断言不代替 Service publication、OS vault、异常 cleanup、完整管理或三平台资格。
