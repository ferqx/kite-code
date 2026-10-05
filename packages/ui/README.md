# UI

`@kite-ai/ui` 是新 Client 的基础共享展示库，依赖 React 与 `@kite-ai/client`；不拥有执行、连接准入、存储或服务器实现。当前正式 Web/TUI 入口尚未切换到这个包，现有客户端能力与权限保持其手册定义。

[PublicViewCard](src/index.tsx) 消费生成的 PublicView，展示摘要、content type/version、完整 JSON payload、附件引用和宿主显式提供的动作回调。未知内容与版本仍保留原始公开对象，缺少专用 renderer 不隐藏结果；没有回调时动作禁用。连接状态由宿主提供，组件不从没有更新推导执行终态。

[ActionInputForm](src/index.tsx) 只维护当前草稿，提交给宿主提供的回调。不允许额外字段的简单 object schema 支持 string、number、integer、boolean 与字符串 enum；嵌套、引用、复杂组合或未知约束明确使用原始 JSON。UI 不替代 Service 的完整 schema 校验和授权。命令 ID、目标 Store 和重试由宿主与 Client 契约决定，不由表单自动生成。

验证：`bun run --cwd packages/ui typecheck`、`build`、`test`。测试核对纯输入投影、数值精度、复杂 schema 退化与未知内容保留；完整 Web/Desktop 产品入口、浏览器交互和原生制品验收仍由对应阶段核对。

P3 的 `InteractionCard` 直接消费生成的 Interaction：真实来源 Session、根回答 Session、祖先关系、Run/Execution、定义版本、输入摘要、策略版本、requiredRefs、准确原请求和决定版本分别保留。审批缺省发送 `grant:approve_once`；只有原 `request.grants` 实际包含 `same_command` 时才提供“本 Session 相同命令”独立选项，发送 `grant:same_command`。所选范围作用于真实来源 Session，展示根不改写批准 scope。deny 不携带 grant；question 按实际 `request.schema` 使用基础字段/内部 enum ID，复杂或未提供 schema 明确退化为原始 JSON。没有回答回调时只读；plan_review 展示已有实际记录，有限信息答复按下文契约处理，不提供虚构计划执行或完成状态。回答面板分别显示 saved/submitting/command accepted/unknown/failed，command accepted 不等于 Core 已接受 decision 或执行已成功。

表单同步阻止同一 render 中重复提交，失败保留草稿和请求。验证包括纯 React element 投影（不是浏览器 DOM/键盘验收）、schema 函数和配套薄客户端真实 HTTP 链路；正式 Web/Electron/TUI 入口和可访问性端到端资格尚未由这些测试建立。

便携 Context 切片提供 `ContextPanel`：显示准确 selection、范围、消息及两个独立分页游标、结果 source ID、原 Execution/revision/Store 与 automatic/explicit 来源。历史 Job 的 `suppressed/context_rewound` 明确表示被当前选择隔离，原执行效果仍保留；缺少原 Store 字段时显示出处 unavailable，不补当前 Store。Rewind 提交精确消息 ID/seq 或显式空边界，最终完整消息/Tool 配对边界由 Service 校验；Include 保存原结果来源，不重放执行或自行开始 Run。没有写入回调时没有操作入口；Rewind 在活动/未核实执行时禁用。Include 可在准确 active Run 上显示目标并封存原 Store/Session/selection/Run envelope；缺出处、revision 或准确 Run 时禁用，idle include 不带目标 Run。读取固定选择与上界的下一页是独立只读回调。

`ContextSubmissionNotice` 显示原 command 与 saved/submitting/queued/applied/unknown/failed 事实；保存来源不等于模型已读取或执行成功。queued 明确等待原 checkpoint，尚未纳入；applied 仍不证明模型正确使用。Context UI 同时包含纯投影与 [test/context-active-dom.test.tsx](test/context-active-dom.test.tsx) 的实际 JSdom 点击、目标准确性和缺目标禁用验证；不声称原生浏览器或正式客户端迁移完成。


有限 `plan_review` 答复只在请求提供 planId/version/digest/content 与非空、无陌生值的 allowedModes 时开启。支持模式仅 `auto`、`accept_edits`（严格取请求提供的子集），批准要求用户显式选择；Full 不在选项中。缺失/陌生 metadata 或 modes 保只读说明，并仍显示完整原 request；未知身份字段明确 unknown。反馈最多 8192 字符，deny/revise 不携带 mode。信息回答不改变默认权限，不证明计划已满足业务 required evaluator，也不证明执行或完成。实际 DOM/键盘资格仍未由纯投影/serialization 测试建立。


`InteractionCard` 的 `onReadAttachment` 是可选宿主回调，只接受原公开 reference 的准确 Store、Session、scope 和元数据。大审批附件在完整读取、SHA-256 与严格 UTF-8 校验成功后展示全文；缺 reader、加载中或失败时保留原卡并禁用回答。取消读取、替换卡片、切换身份或卸载只释放视图等待，迟到正文不能成为另一卡的已读证明。组件仅在当前视图保存正文，重复键盘/点击同步抑制，不把正文存入控制器验证集合。无附件的原审批行为保持不变。

[test/attachments-dom.test.tsx](test/attachments-dom.test.tsx) 使用实际 ReactDOM/createRoot 和 JSDOM KeyboardEvent 验证 Enter 提交、重复抑制、缺 reader/错误正文、迟到身份响应；另以真实 Service/SQLite/ArtifactStore 的超过 17 MiB Auto 人工附件核对完整 DOM 正文再提交原审批。该测试建立便携组件的 DOM/键盘证据，不代表正式 Electron/TUI、真实浏览器布局或完整可访问性资格。


`SafeMessageMarkdown` 使用 react-markdown 与 GFM 渲染完整原正文的标题、段落、列表、代码、引用与表格。原 HTML 转义为文字；图片只显示 alt，不请求资源；相对文件与不安全 scheme 链接只显示文本。HTTP(S) 链接需用户主动打开并隔离 opener。组件只接受正文，不拥有网络、Token、编辑器或阅读缓存，正文宽度由宿主消息列决定。

[test/markdown.test.tsx](test/markdown.test.tsx) 验证上述安全边界、标准结构与完整长正文。Web 的 DOM 阅读测试另覆盖会话选择范围与位置恢复；这些不构成原生浏览器布局、选区或滚动资格。

`PermissionPanel` 只消费公开 mode/trust 事实，模式四选与以后会话默认值分别确认；信任前展示 actual readScopes 和原范围摘要，用户须明确核对。子会话或无 callback 时只读，未决/未知提交禁写；一份观察只提交一次，失败保留选项，不显示已应用。`PermissionSubmissionStatus` 将原 command 的已保存、提交中、已应用、未知和失败分别显示。新身份卸载旧面板，旧异步结果不能覆盖新卡；组件不持有凭据、服务器、文件或执行控制。

[test/permissions-dom.test.tsx](test/permissions-dom.test.tsx) 使用实际 ReactDOM/JSDOM，验证 Enter/空格键选择、重复键盘/点击抑制、模式/default、未确认 trust 禁用、原读取范围、子会话只读、失败草稿及迟到身份响应；正式 Electron/TUI 与真实浏览器布局仍未由本证据建立。

`ModelOutputMessage` 消费公开 `Message.outputBody`，默认明确显示有限预览，不把预览声称为完整输出。宿主可提供 `onRead({sessionId,executionId,signal})`；该 reader 必须先通过公共 Client 的完整 EOF、SHA、UTF-8 与正文验证，再返回 `ModelOutputSnapshot`。组件复核原 Store、Session、Run、Execution、完整性与正文长度；只在当前视图保存已读全文。显式关闭、隐藏、身份/预览更新或卸载会 abort 所属读取并清除全文，迟到结果不能显示。缺 reader 时预览仍可读，全文按钮禁用；失败不展示半正文。原完整 Tool calls 需用户展开，不完整前缀不显示完整调用。原 reasoning 缺省不展示；只有明确诊断宿主设置 `showReasoning` 才提供展开入口，普通会话阅读不启用。

`onContent` 只通知当前已显示的完整正文，回到预览时通知 `undefined`，供宿主准确复制；组件不拥有网络关闭或 Runtime 取消。[Model output DOM 测试](test/model-output.test.tsx) 验证超过 17 MiB 的完整尾部、显式读取、single flight、关闭/身份变化/隐藏的 abort 与 late 隔离、缺 reader、身份冲突和不完整前缀。它建立 React/JSDOM 证据，不代表真实浏览器、Electron 或 TUI 资格。

[test/interaction-grants-dom.test.tsx](test/interaction-grants-dom.test.tsx) 使用真实 ReactDOM/JSDOM 验证一次默认值、显式同命令按钮/键盘、原 child/卡片版本保留、未知原回答意图禁用、只读以及 plan/question 不提供该授权。组件只提交原答案字段，不保存本地授权缓存、不将 accepted 回执当成派发成功；持久授权与 clear 最终核对由 Service/Core 负责。DOM 证据不等于正式 Electron/TUI 或原生浏览器资格。

`ModelInputs` 已从 Web 调用者抽到 [共享输入检查器](src/model-input.tsx)，公开 `ModelInputPort` 仅包含原 Store/capability 身份、有限目录页与准确原 Execution 读取。`initialExecutionId` 从 Runtime logs 定位原记录时只打开敏感内容确认页，不自动读取正文。调用者或 scope 改变即使不重新挂载组件，也清除已读正文并 abort 本视图读取，迟到结果不重绑新身份；原数据确认和 actual metadata 行为保留。Web 实际 DOM 组合为 8 项、73 条断言，公共 Client 输入/输出 verifier 组合为 11 项、99 条断言；Native 输入/输出共用 main 单正文 lease。上述证据没有授予 UI 运行或网络关闭权限。

`PermissionGrantsPanel` 只显示公开授权目录的实际 Session、原 Store、epoch、definition/kind、Interaction 决策版本、原 Execution 与输入/命令摘要，不展示原命令正文、不缓存执行许可。清除前必须明确核对观察到的 Session/epoch，callback 固定原 observation；未知/在途意图禁止另一次写入，但其他会话仍可只读查询。无 callback 或无法核实目录时只读，子会话目录不从根会话模式推造。并发 epoch 变化由真实 Core CAS 拒绝，不静默重试。[授权目录 DOM 测试](test/permission-grants-dom.test.tsx) 使用实际 ReactDOM/JSDOM 键盘验证一次提交、重复抑制、只读与旧结果不覆盖替换身份；真实窗口/HTTP 清除证据由 [Desktop owner](../../apps/desktop/README.md)负责。

独立 [终端消费者](src/tui/README.md) 从 `@kite-ai/ui/tui` 导出 Ink 组件与固定原身份的 port/controller，终端正文与 DOM 分开渲染。当前正式 Terminal 已消费此入口，提供会话选择、原 active Run 输入、原卡回答、精确取消及 MCP 目录/启停、来源决定、连接/强制重连、条目增删与HTTP认证的独立原申请；完整主屏、全部手册面板与跨平台资格仍按实际证据核对。

共享 `ModelOutputMessage` 的 Fork 正文读取使用公开 sealed `Message.originMessage` 原 Session/Run，复核准确 Store/Execution；foreign Store 不发正文 GET，未来 `contentFormat` 或 `outputBody.readAvailability:unsupported` 保留预览并禁用完整读取。该新增作用域路径由共享 DOM 5 项、31 个断言以及实际 HTTP Fork 17 MiB 1 项、38 个断言验证，不据此声明全量 Fork/平台产品已收束。独立 TUI 也按同一公开来源绑定，不把 Fork 的新 Session/Run 冒充原输出身份。

通用 TUI `Ctrl+B` 使用宿主完整分页的 pending 目录选择独立卡，打开时冻结原 Store/来源 Session/展示 Session/cardId/revision，刷新变更不把原行指向后来卡。每卡分别保留答案草稿与明确 grant 选择，revision 变化清旧草稿；已完整读取的附件按相同身份保留，提交另核公共完整 review reference 的原 identity，不能借用另一张卡或旧正文。Session 切换与未知答复仍走原 controller 查询，不重发。选择器不提供父批准替代 child/Job 许可。

[真实四卡 PTY](test/isolated/tui/pending-cards.test.ts) 在 owned Core/Service SQLite、80×24 中同时保持两个 sibling Ask Tool、root question 和独立 `required-verifier` ordinary Job，按 root-first/job-first 顺序分别批准。真实 parent/child intersection 70KB policy 的完整 artifact 由公共 SDK reader 核 hash/原 scope，缓存切换不重复读取；首 POST 与首原 GET 回应物理丢失后只查原 answer Command，实际两 child 效果与 Job 各一次。该 configured ordinary Job 不是 `skill.workflow.verify`；Workflow verifier 的真实审批另由 CLI Workflow question/compensation fixtures 验证。revision 清理和迟到选择由 Ink 反例核对，不代表同四卡窗口内实际改变后端 policy 的资格。


开发 TUI 的 `/rewind` 现在通过有限 `TuiFileRecoveryPort` 读取实际 Files 恢复点、预览与原两 leg，支持仅会话/仅代码/两者；它不持 profile、文件或热 POST permit。普通审批、已确认 Code 后的明确 Fork 继续、unknown 原 GET 与关闭/切会话的迟到隔离见 [TUI owner](src/tui/README.md)。实际编译 PTY、强杀与丢回执证据归 [CLI host owner](../../apps/cli/README.md#files-三范围恢复-caller)，不据此宣称正式旧入口、Native 或所有平台已完成切换。
