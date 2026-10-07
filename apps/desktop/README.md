# Desktop 与 Native 制品

## Native 跨会话后台总览

正式 renderer 的[后台总览](src/native-background-panel.tsx)是独立于选中会话的主动入口。它读取原主体根会话树内全部当前来源 Job，以及准确恢复根中的旧来源历史，包含 child/task carrier 与子会话中的 Job；超过200项仍穷尽全部页，不从有限 `selection.executions` 猜完整集合。每项分别显示原 Store、原父 Run、准确 `child-start-${executionId}` 子 Run、required 等待与 delivery；较新的子 Run 不替换原载体。公共来源与快照合同由[Store](../../packages/agent/src/storage/README.md#跨会话原-job-目录)、[Service](../service/README.md#完整后台执行目录)和[Client](../../packages/client/README.md#完整后台执行目录)维护。

[Main](electron/background.ts)固定 attach generation、Store、subject，先完整核公开目录再登记 immutable lineage 的 observation。512KiB/最多200项的有限 [IPC](electron/native-ipc.ts)只接 read ID、已观察 execution ID、observation ID 与准确停止 command ID；renderer 无法提供 Session、Workspace、路径、游标或 Runtime authority。[完整目录 reader](src/native-background.ts)只有穷尽同一观察才发布；新读取失败保留同 scope 上次完整显示，但新观察使旧停止 authority 失效。选择变化不清后台观察；断线、观察 reset、attach 替换和释放清所属读取及停止资格。

非选中原输出复用[固定 H reader](electron/job-output-reads.ts)与公共覆盖证明；原目录刷新不重开已经完整的输出。Main 固定当前准入 Store 与原 Execution originStoreId，原输出不改出处。子日志逐页读原子会话固定消息上界，核原载体／父链与根血缘，并以当前 Store 读取完整原 ModelOutput；带 originMessage 的正文另核原 Model 的 Session／Run／originStoreId。64KiB传输核完整EOF、SHA和fatal UTF-8，原载体的子 Run 与日志中后来轮次保持各自身份。关闭详情或总览只 abort 所属 GET，零取消或恢复。这里的完整子日志指子消息与完整 ModelOutput；诊断 SessionLog 的 restore replayFloor 合同保持。

旧来源项显示恢复历史只读；Main 在准备停止前要求原 Execution 来源等于当前 Store，底层取消还在首写前核整个效果范围的当前来源。新 Store 内明确创建的工作仍可准确停止。Main 重新核原身份、活动状态、attempt/owner generation/result revision 后，经[原 caller journal](electron/caller-journal.ts)保存准确实际 Session/Workspace 的 `execution.cancel`。内部后台 prepare 只接已观察对象并另核根与原主体来源；普通选中根 caller 门禁保持。既有／冷原意图仍只 GET，受理不冒充实际停止。

[Main/IPC 与原 journal 测试](test/native-background.test.ts)、[实际 DOM](test/native-background-panel.test.tsx)、[公共分页测试](../../packages/client/test/background-directory.test.ts)与[真实 Store/Runtime/HTTP](../../tests/isolated/unified-agent/background-directory.test.ts)核完整目录、原轮次、完整原输出／子日志、精确停止和迟到释放。[源码外默认窗口](test/isolated/native-background-bundle.test.ts)与[Electron driver](test/native-background-electron.fixture.ts)核真实默认 task、同父 required 等待、非选中日志、单目标停止及冷 GET。实际结果与剩余资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)；当前恢复历史资格不外推默认可信 Shell、旧用户数据库转换或全部平台，持久取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-07-native-background-overview.md)。

## Native Job 完整已保存输出

正式 Native 的 Runtime logs「已保存执行」中，准确 kind=job 的详情提供主动读取、显式刷新和关闭。[页面](src/native-job-output-panel.tsx)保留全部已保存 stdout/stderr/progress、原序号区间与准确 droppedBytes；null 表示该剪裁区间的丢失字节数无法确定。完整是截至首次固定 H 的全部保存内容与缺口事实，不恢复已丢字节，也不表示 Job 成功或实际停止。新输出只在显式刷新后进入新的观察。

[Main reader](electron/job-output-reads.ts)在 GET 前同步核实际选择并登记独立 read ID，绑定 attach generation、viewSelection、historyEpoch、当前 Store、原 originStoreId、Session、Workspace 和原 Job；恢复历史仍沿当前连接读取，fresh Execution 独立核原 id/session/originStore/kind，每页前后复核原 Service 身份。有限 open/next/close [IPC](electron/native-ipc.ts)不接 renderer 提供的 Store、Session、Workspace、游标、路径或执行 authority。单页 512 KiB；公共接口只限 normal rows，过大页先核原身份与完整覆盖语义，再在相同 after/H 下减小 limit，首个响应即使过大也不更换 H；非法页不能借缩小重试被隐藏。合法单条 32 KiB 保存 chunk 的 JSON 编码可通过该预算，不从累计字节或页数裁剪保存内容。

[renderer reader](src/native-job-output.ts)复用公共 [ExecutionOutputPages](../../packages/client/src/execution-output.ts)，严格 Decimal64、max(throughSeq) 与 per-stream 区间核覆盖至 H，跨 stream 重叠 gap 与普通 chunk 全保留；全部成功才发布。错误页、提前 EOF、旧作用域或迟到值不发布前缀。同作用域刷新失败保上次完整事实并标未更新；H=0 为空输出。关闭输出、折叠原详情、切换选择、观察 reset 和释放只 abort 所属 GET，零业务取消或重新执行；普通 controller viewGeneration 更新不重新读取。精确停止仍沿已有原 caller journal，冷读不重建 JobHandle。

[Main/IPC](test/native-job-output-reads.test.ts)、[实际 DOM](test/native-job-output-panel.test.tsx)与[公共覆盖校验](../../packages/client/test/execution-output.test.ts)核完整分页、首 H、大页缩小、合法重叠缺口、原身份与迟到读取。[完整 Native 窗口](test/isolated/native-job-output-bundle.test.ts)和[driver](test/native-job-output-electron.fixture.ts)用公开 Runtime 与显式 Full Shell 产生真实持久输出，再由搬迁、删除构建源的默认 Native/Service 冷读；准确资格与原失败见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-job-完整已保存输出)。默认可信 Shell 仍未合格，cold consumer 不给默认新 Job producer 或其他平台提供资格，剩余依赖见 [P5 当前范围](../../docs/plans/unified-agent-refactor-v1.md#3022-当前-native-job-完整已保存输出消费者)。

## Native Skills 只读目录

正式 Native 左侧的 Skills 分类展示所选 Session 工作区当前可信配置目录的名称、摘要、来源与可用／禁用／不可用状态。[Main reader](electron/skill-catalogue-reads.ts) 从实际选择封存 attach generation、viewSelection、historyEpoch、Store、Session 与 Workspace；open 在任何 GET 前同步核对原选择并登记 read ID，open/next/close 不排队在 controller refresh 后。Main 保存原 revision/cursor，每页限 128 KiB，关闭和作用域变化只中止所属读取。[IPC](electron/native-ipc.ts) 不接收 renderer 提供的 Workspace、路径或执行 authority。

[完整读取](src/native-skills.ts)复用公共 Client 的闭合页 verifier，穷尽同 revision 后才发布，无总目录截断。[页面](src/native-skills-settings.tsx)区分可用空目录与不可用，刷新失败保留同作用域上次完整事实并说明未更新；实际选择、attach 或观察 epoch 改变时清理旧读取，普通 controller viewGeneration 更新不反复重开目录。来源只说明已准入的配置位置，缺字段说明未记录；页面不读正文、安装或激活 Workflow，发现与执行仍由默认 Service 负责，不恢复旧 home 隐式扫描。

[Main/IPC 测试](test/native-skills-reads.test.ts)与[实际 DOM](test/native-skills-settings.test.tsx)验证完整分页、关闭、迟到响应、刷新失败和作用域隔离。[默认 Native 候选](test/isolated/native-skills-bundle.test.ts)与[Electron driver](test/native-skills-electron.fixture.ts)已在本机 macOS 核搬迁、删除构建源后的默认 Service／网络装配：306 项经 16 个真实同 revision 页完整展示，文件与配置刷新、两个 Workspace、分类关闭重开、冷启动与普通所属 Service 退出均完成；退出后独立公共冷 Store 无 Run/Execution 增长。准确运行证据、原失败和完整默认范围见[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-只读-skills-目录与阶段收束)，取舍见[目录决定](../../.agents/notes/implemented/architecture/2026-10-07-native-readonly-skill-catalogue.md)。这项资格只覆盖当前 Native 公开目录消费者，完整 Skills/Workflow 与其他平台仍按 [P5](../../docs/plans/unified-agent-refactor-v1.md#3021-当前-native-skills-消费者迁移)核对。

## Native 普通问题与页面草稿

根 `desktop` 选择的 [Native renderer](src/native.tsx)实际消费共享 Questionnaire；默认 ask_user 的多题选择、自由输入、先浏览后一次提交和显式取消问卷均沿公共原 `interaction.answer`。取消只提交原 schema 的 null，后续 Model 在同一 Run 收到取消信息；所选会话存在 pending question 时，隐藏主输入表单及原命令、原申请或 active Job 的任务停止按钮。主输入草稿仍由页面原状态保留，回答或取消后的交互终态恢复原文；跨会话的主草稿仍沿既有明确保存入口。未知／失败回答保留原意图，只查询原 Command，不再次 POST。

renderer 的页面 Map 分别保存步骤与 JSON fallback 草稿，身份固定 Store/source/presentation Session/id/revision/inputDigest。切换会话、新建会话及待决后页替换不会搬移或清理原草稿；读取失败和卡片未出现在 bounded pending 页也不证明终态。Main 已核准确 accepted answer_saved 回执时只清原键，观察到同原卡的新 revision/inputDigest 或非 pending 状态时才清理对应旧键。关闭页面进程不保证未提交问卷草稿恢复，持久原 Answer journal 仍负责未知回执。

[页面 DOM](test/native-questionnaire-dom.test.tsx)核会话隔离、遗漏页／读取失败、未知一次答复、准确回执只清原草稿，以及 question 隐藏主输入并在终态恢复原文；[实际完整 Native 候选](test/isolated/native-questionnaire-bundle.test.ts)与 [Electron driver](test/native-questionnaire-electron.fixture.ts)核搬迁、删除构建源后的默认 Service／compatible Provider 窗口流程，末页主动提交前零 HTTP Answer、原 ID／文案和自由原文、问卷取消后原 Run 继续，以及所属 Service 真正退出后的冷 Store。该 fixture 仅暂存各原 Run 的首个 Provider 响应，沿既有“保留草稿”准备并读取准确主草稿后释放；实测答复／取消均隐藏主输入再恢复原文，没有新增 Model 或重答。首次发送等待实际 Renderer 权限与历史就绪，并核一次真实 form submit；[原 Native bundle driver](test/native-bundle-electron.fixture.ts)复用这项界面观察，原制品、独立审批与退出断言保持。实际运行结果与限制归 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不由组件或单个窗口测试推导全部 P5、三平台或签名发行资格。

## Native 计划入口与完整审核

根 `desktop` 的主输入以“先审核计划”明确选择本次任务，选择本身零业务 POST。idle 保存原 `run.start`，活动任务保存准确 `afterRunId/contextSelectionId` 的 `input.follow_up`；两者只带闭合 `builtin.planning@1 {mode:'plan'}`，不改变当前原 Run。选择按原 Store/Workspace/Session 隔离，已知正回执后复位，失败或未知保留。默认 Service 负责装配原 Run 计划义务与必要条件，调用者不自报只读定义或批准权。

共享 Plan 面板显示准确当前版本的完整正文、步骤和原材料，Auto/Accept Edits 只取实际 offered modes 且不默认选择。修改要求作为原反馈由真实 `planning.review` ToolResult 交给下一 Model，新版继续独立审核。拒绝本版不是取消原任务；明确原申请取消仍走原 Command。所选会话出现 pending approval/question/plan_review 时隐藏主输入，终态恢复原主草稿；Plan/approval 保留原任务停止入口。取消原 Run 不撤销已有事实，已派发 review 的未知结果及退出提示继续保留。

页面 Plan Map 保存 Store/source/presentation Session/id/revision/inputDigest 的模式和反馈，与 Question、主草稿各自独立。准确 Main accepted answer_saved、实际同原卡替换或非 pending、以及精确原 Run 已观察 cancelled 才清对应原键；遗漏 bounded pending 页、读取失败、Promise resolve 不清草稿。完整页面刷新或退出不保证未提交 Plan 草稿恢复。

[Main 原附件 reader](electron/interaction-attachment-reads.ts)只打开当前视图实际 offered card 的公开原身份，复用 controller 与 SDK 的完整 Artifact/hash/UTF-8 证明。renderer 经 [64KiB reader](src/native-interaction-attachment.ts)核 scope、原 size、完整 EOF、SHA 和 fatal UTF-8；Main 在原视图完整传输至 EOF 前另拒绝回答。close 只释放读取，当前完整证明保留；选择或网络释放清证明，迟到正文不改绑。Native `viewSelection` 区分同 Session 重选，`historyEpoch` 隔离观察流 reset，renderer 同时撤销旧正文资格。普通同作用域刷新中止旧在途读取，保留已经完成且仍实际 offered 的准确 key；失败期间拒绝操作，恢复后重新核原卡，不清反馈草稿。无任意 Artifact、路径或 Runtime 端口。

[页面 DOM](test/native-plan-review-dom.test.tsx)、[读取边界](test/native-interaction-attachment.test.ts)与 [显式输入](test/native-input.test.ts)核草稿、主输入独占、原取消清理、未读取/部分读取不得回答和闭合 Plan 意图。[实际候选](test/isolated/native-plan-review-bundle.test.ts)与 [Electron driver](test/native-plan-review-electron.fixture.ts)已在本机 macOS 核搬迁并删除构建源的默认 Service/compatible Provider、真实两种执行方式、原反馈 v2、独立管理/File 许可、拒绝/取消、正常所属 PID 退出与冷 Store。普通 Plan Model 保 Planning 目录；Auto 专用 reviewer 按实际 `authorization_review` 用途及原 Store/Run/Files Execution 核空工具目录，不借计划批准跳过独立人工审批。实际结果与原失败保留见 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。退出 unknown 提示的明确选择由严格一次性的测试 dialog 端口返回，不代表 macOS 原生 modal 点击资格，生产 guard 不被替换。该窗口不推导全部视觉、设置、平台或 P5 退出。

公共入口同时导出 [DesktopInput](src/input.README.md)：调用者在发起意图时固定准确 Session/Store/Run/context/command，start、steer、follow-up 和精确取消不随选择视图漂移；未知回执只查原命令。所属 observer 的释放只停止查询与 callback，已有执行继续。意图单元测试与实际配对子 Service 合计 7 项、57 条断言通过；Native Plan 上述入口另核实际窗口，完整 controller 输入与其余窗口范围继续按阶段验收。

可移植公共入口只依赖 Client、UI 与 React；新增显式原生入口在 main 侧使用 Agent profile 与 Service paired。根 `desktop` 已选择新完整 Native 候选，旧 kite-desktop 不参与正式/default/CI 调度。完整视觉保真、跨平台与发布资格仍按实际证据核对。

[controller](src/controller.ts) 接受主进程适配器提供的 admittedClient，选定 Session 后读取真实 snapshot 与通用 Query 视图。每次选择创建 viewGeneration；迟到旧响应可进入按数量及字节约束的对象缓存，不能覆盖新选择，旧请求错误也不能停止 Service。单条 SSE 与页面选择独立；切换视图不取消执行。

通用动作来自当前视图的原 public envelope。调用者可用 UI schema 表单明确修改输入；controller 固定该次 intent 的 Session/Store/definition/commandId，通过 Client 和 Service 校验，不随视图切换重绑定。`lastActionIntent` 保留最近一次明确动作的原 Session/Store/command 身份；回执未知时可查询原 command，不自动重发。`DesktopPublicViews` 只消费公开视图与宿主回调，没有扩展业务类别特例。

`disposeNetwork()` 中断客户端网络并使旧 generation 失效，保留已确认 snapshot；不调用配套服务停止。`stopPairedService()` 是显式 main 生命周期操作，通过独立注入回调实现，不在组件卸载或旧请求失败时触发。

验证：`bun run --cwd apps/desktop typecheck`、`build`、`test` 与根 [thin-clients](../../tests/isolated/unified-agent/thin-clients.test.ts) 真 HTTP/SSE 测试。P5 的完整 Electron sender/preload 隔离、真实窗口、平台权限和旧 UI 迁移继续由该阶段负责。

P3 `DesktopSnapshot.interactions` 读取根 Session 的实际 pending 页（最多 20，`interactionsAfterId` 显式保留后页指针）。`answerInteraction` 在点击时封存 Interaction 原 Store、presentationSessionId、ID、revision、answer 与新 commandId；重复调用共享同一在途 Promise，视图切换不能改绑。一次回答最多发送一次，错误保留原 pending 请求与已保存意图，未知回执用 `lookupInteractionAnswer` 查询原 command，不自动重放。当前 controller 最多保留 128 个回答 intent，超过范围明确拒绝，而不丢弃未决身份。

`interactionSubmissions` 与 `DesktopAnswerSubmissions` 可在选择区外保留回答面板；宿主应在视图切换时仍渲染该面板。接受命令与 `acceptedDecisionRevision`/实际执行结果分别显示。`DesktopInteractions` 的 callback 缺席时只读，不向 UI 传 token、Owner 或 server 类型。真实 SQLite/HTTP 测试位于 [CLI Interaction integration](../cli/test/interactions.test.ts)，覆盖 opt-in 批准与 question、非交互等待、重复提交和切换视图；controller 测试另覆盖丢失回答回执只查原 command。上述便携 HTTP 证据不单独建立 Native 窗口或完整 P5 资格；本页问卷与计划专题分别记录已交付的实际 Native 消费范围。

便携 Context controller 在 capability 可用时读取第一页 `snapshot.context`，`loadContextPage()` 固定原 selection、highWaterSeq 并独立推进消息与来源两个 cursor；一个流结束后不会从头重复，消息结束固定 afterSeq=highWaterSeq。`rewindContext(boundary)` 只接受本代次已读取有界页中的实际 complete 消息的精确 ID/seq 或 null，Service 最终核对完整 Tool 配对。`includeHistoricalResult(execution, scope?)` 绑定当前实际历史 Job 的原 ID/resultRevision；活动 include 必须提供点击时封存的 Store/Session/selection/targetRunId envelope，缺准确原 Run、出处或 revision 时本地拒绝；这两项保存原 Session/Store/selection/commandId，不自动创建 Run。Rewind 的活动或 outcome_unknown 执行仍在本地明确 input_busy；include 在准确活动 Run 上只排队，原 accepted/result_queued 显示 queued，checkpoint 后原 Command applied 才显示已纳入。最终 Store 仍核原目标，视图切换和未知恢复不改绑。

同一 intent 的重复提交共享在途 Promise，最多保留 128 个原 intent；失败和未知不重发，`lookupContextIntent(commandId)` 只读核对原命令。`contextSubmissions` 可独立于选中视图保留；`DesktopContext` 将这些状态和原出处展示，未知提交保持写入操作禁用。回执已 applied 只证明 selection/source 事务落定。正式 Electron/DOM/P5 资格不在此切片范围。

控制器最多保存当前选择 4096 个已读 complete 消息边界身份；超过时局部拒绝 context_boundary_limit，不把截断页声称为全部历史。


plan_review 复用原 Interaction 的封存回答意图；controller 在保存前验证实际已显示请求 metadata、请求明确提供的模式与反馈长度。不会从调用者替换的描述、自报 Full 或未知字段推导授权。纯校验失败不创建 intent、不发写入请求。答复 accepted 只是原回答命令已保存，Core 决定接纳与后续 Tool 权限另核对；迟到且已保存取消标记的历史答复不能复活原 work。实际 HTTP 测试保留同一已派发 Tool 的 execution/attempt 与原独立审批，重复回答只提交一次。


大人工审批附件由 `DesktopInteractions.onReadAttachment` 接宿主 reader；`controller.readInteractionAttachment(intent,{signal})` 固定原 Store、来源 Session、scope、Interaction/revision 并读取完整核实正文。回答前必须有同一当前卡身份的读取证明；验证集合只保存当前卡身份，不保存正文。视图切换/网络释放中止读取并清除证明，迟到加载不能应用到新视图。保存回答仍走原封存 intent/commandId，未知回执只查原 Command。

[test/large-attachments.test.ts](test/large-attachments.test.ts) 用实际大 Auto 附件、SQLite/loopback HTTP 验证迟到加载跨 Session 切换不能批准、重新完整读取后原回答只派发一次。共享 UI 另有实际 DOM/键盘测试；本便携控制器不建立正式 Electron sender/preload、窗口或 P5 资格。

便携权限入口由 `DesktopPermissions` 与 controller 提供。capability `permission_controls` 缺失时局部只读；子会话只显示根权限。模式四选及 `makeDefault` 是明确用户选择，信任确认展示实际读取范围、工作区与范围摘要；信任不批准任意操作。读取结果固定观察身份，保存时封存原 Store、Session/root、Workspace、CAS 版本与摘要。同观察只允许一个选择；同在途选择返回同一 Promise，切换后的旧 callback 不会改绑。最多保留 128 个 intent，冲突保留原选择，显式重新读取后才可再次选择；未知结果只用 `lookupPermissionMutation` 查原 command，不重发。网络释放仅停止客户端网络，不停止 Service 或 Run。

[test/permissions.test.ts](test/permissions.test.ts) 使用真实默认宿主、SQLite 与 loopback HTTP，验证四种模式/default、信任/撤销、竞争 CAS、未知回执及跨会话重复抑制，业务执行数量保持零。另有局部 capability/child 投影测试；共享 UI 的 [实际 DOM 测试](../../packages/ui/test/permissions-dom.test.tsx) 覆盖键盘与迟到卡片切换。这些证据属于便携调用者，不代表正式 Electron 或 TUI 制品已完成。

新的显式原生入口位于 [electron/main.ts](electron/main.ts)、[preload.ts](electron/preload.ts) 与 [native renderer](src/native.tsx)。这是现有 portable controller 的实际 Electron 宿主；根 `desktop` 已选择此新 Native 入口；旧源码仍保留，完整 UI 能力及发布资格尚未退出，无旧协议 fallback。main 独占公共 NativeClient、配对 Service、预选 profile、观察流和意图；renderer 只有封闭的 `kiteNative.request/watch`，不接收 token、profilePath、Runtime 或任意 HTTP/IPC 通道。窗口 sender 必须是原 webContents/mainFrame 与实际制品文档，子窗口与旧 frame 不能提交。单 IPC 请求最多 1MiB、响应最多 4MiB，消息页最多 200，renderer 当前消息视图最多 4096 条/8MiB；超界只拒绝该次读写，不关闭服务。

[build-native.ts](scripts/build-native.ts) 的开发入口仍为 `bun run --cwd apps/desktop build:native --assets /absolute/trusted-assets.json --outdir /absolute/distribution`。`buildNativeDesktop` 把显式 Service JS、Bun executable、实际 SHA/build/API/capabilities 和可选 disposable profile 标为 development；这条兼容 API 不代表完整发行闭包。main/preload 是 Node CJS，renderer 是浏览器 ESM；实际 HTML/preload 从 `app.getAppPath()` 读取，不能使用构建器固化的源码 `__dirname`。

完整候选使用同文件的 `buildNativeCandidate({terminalRoot,electronDist,outdir})`，输入是已核实的新 terminal bundle 与实际安装 Electron dist，输出目录必须全新且不在输入源内。`terminal/` 原完整 Service/Bun/npm/Worker/监督/baseline/Web closure 独立验证；`app/` 固定 main/preload/renderer/html/package 与两个可信 helper，`electron/` 保存实际 executable、Frameworks 和 resources。公共 [Native verifier](../service/src/native-runtime-assets.ts) 固定 platform/arch/Electron version、inner manifest SHA、完整 file size/SHA/mode 与有限内部 Electron links。原 Electron 空 locale 目录通过必带 `directories` 精确声明，缺失、移位、新内容和未声明空目录都拒绝；builder 不删除原安装内容。`.use-terminal.lock` 在发布前建为空 0600、nlink1，单独列入闭合 inventory，不忽略任意 dotfiles。manifest 与 SHA 是未签名完整性证明，不证明发布者身份。

candidate Main 只接受固定 `{kind:'candidate'}`，从实际 appPath 推导原 root 一次，核实际 executable 就是内嵌 Electron 且运行版本相等，不退回开发绝对路径或 PATH。Electron 会把 `.asar` 展开为虚拟目录，因此只在同步完整物理验证期间暂设 `process.noAsar`，finally 恢复原值；不把 archive 内虚拟目录当发行资产。无显式开发 Profile 时，source 与 installed Main 都选择 `~/.kite-code/unified-agent` 的 `default`，与新 terminal 一致，不发现、转换或接入旧 Electron userData/旧配置/数据库。

[POSIX Node artifact lease](electron/artifact-access.ts)通过原 FD 与 [one-shot Bun helper](electron/artifact-access-helper.ts)消费公共 inherited-artifact 端口。Main 保留 outer 与 inner 的两份 shared lease；helper 只关闭自身继承副本，不 LOCK_UN，不授 Profile 或执行权。准确 `native.candidate` proof 通过现有 paired stdin 交 Service，Service 自持全部 roots 的 lease 并将完整 roots 交默认保护。退出先关闭 caller、私有数据库/Profile lease、所属 child，最后才释放 Main artifact FD；Main 强杀后 child 仍持两 root，child 已终止才可独占。安装/归档/升级工具负责先取得全部 exclusive lease，再操作不可变候选；这些工具的资格由其 owner 单独记录。

Windows 的[有限 Node-API 后端](native/windows-access/README.md)由 Main 和 Service 各自取得 LockFileEx SH，不借继承 HANDLE 授权。私有 UI prepare 保原 Profile/UI 目录与主 DB HANDLE、volume/FileID，SQLite关闭后再释放，sidecar不永久钉名称。但 hash `.node` 到 require 仍缺加载前原对象/发布者根证明，正式 candidate Main 在应用 addon/SQLite/factory/child 前拒绝 `native_windows_bootstrap_unqualified`，不提供formal bypass。本机负例3项21断言核这些加载/启动计数全零；5个Windows强制案例、MSVC/Electron ABI及完整Native资格尚未执行，不能由类型或POSIX邻接放行。

[实际内嵌 Electron 候选](test/isolated/native-bundle.test.ts)使用真正 terminal builder 和本机安装 Electron dist，搬迁后删除原构建输出、独立 HOME/PATH、无 Service 源码或 npm 回退；原默认 Profile 的 Files.write 经实际 approve_once 一次完成，Provider 为 2。正常退出所属 child PID 消失，两 root 可独占；冷重开只读不增 Provider。第二窗口用精确所属 child SIGSTOP 固定有限观测，再 SIGKILL Main，实际 Service 仍持 outer/inner 两锁，SIGKILL child 后才释放；这不是生产暂停、自动恢复或所有进程树场景的证明。[公共 Node verifier](../service/test/isolated/native-runtime-assets.test.ts)另核原 SHA、完整内层、空锁、闭合 schema、模式/字节/硬链接/逃逸链接与空目录负例。最终候选及原 Files/Session Electron 邻接为 4 文件、6 项、55 条 Bun 断言全通过（68.65 秒，2026-10-04），包含真实 driver 独立断言；Desktop/Service types 与 Service build 通过。

首实际构建因原 Electron 空 locale 未声明而拒绝；第二轮定位 Electron ASAR 虚拟目录差异，第三/四轮有限 driver 的失败清理等待退出确认，第五轮卡已经可见但 main 新投影暂空。保留所有失败日志；最终 observer 在原 10 秒内等待准确 pending card，失败清理只限所属进程，没有放宽权限、执行 deadline 或伪造成功。这些资格只覆盖 macOS arm64、Electron 44.3.0、Bun 1.4.2 的隔离候选；旧正式 launcher 切换、安装器、签名/公证、Linux/Windows 及完整 §35 由各 owner 单独闭合。

main 的私有草稿由 [private-data.ts](electron/private-data.ts) 使用实际 Node `node:sqlite` 保存，固定在启动前预选 profile 的 `desktop-private/data.sqlite`，renderer 不能提供文件路径。目录要求所属用户与 0700、文件 0600，拒绝符号链接和文件硬链接；格式与 application ID 未知、损坏或打开失败时只报局部 `draft_storage_unavailable`，保留原字节，不以空库覆盖。正文 JSON 编码保留 NUL 和原 UTF-16 文本。显式保存按原 Store/Workspace/根 Session 与修订进行 `BEGIN IMMEDIATE` CAS，SQLite 私有事务锁等待有界，FULL 同步与原子提交由 Node SQLite 完成，不依赖 Bun main 或业务 Store。

草稿每份最多 1MiB，包含 envelope 的 IPC 请求仍受原 1MiB 限额；没有按总数量或总字节静默淘汰用户草稿。列表每页只读取最多 100 份元数据，正文另按原 opaque ID 读取。冷应用重启后恢复已保存原文与修订；Store 替换或 Session 删除后保留原文本，在“读取已保存草稿”中说明原关联不可用，不将其放入同 ID 新会话。本文仍需用户明确保存，尚未保存的编辑器文本不声称跨冷进程恢复；没有隐式发送或重新绑定。

会话创建在私有库先保存原 commandId/sessionId/Store/Workspace/title 意图，再仅发一次公开 `createSession`。同 ID 同输入共享在途请求；冲突拒绝，pending/unknown 冷恢复仍只核实原 `getCommand`，核对其原身份、实际 applied 与 Session 事实后才显示已确认，不重发 POST。结果错误或未知保留既有草稿；新建空会话不搬移或删除其他会话文本，私有意图不是核心命令权威。发送、回答和权限选择继续复用原封存 intent。刷新、卸载和网络释放仅使 renderer generation 失效，所属 Service 与执行继续。

窗口关闭隐藏；明确退出由 main 读取实际活动事实后确认，先释放 caller 网络、私有 UI 数据库与 Profile lease，再关闭所属 paired Service，最后释放制品 lease。目录和退出检查使用 SDK `listAllWorkspaces/listAllSessions` 穷尽原 Store 的固定上界分页；晚新增由下一次完整读取覆盖，读取失败保持无法核实，不猜空闲。IPC 4MiB 响应预算没有提高，超大目录仍局部拒绝，未声称已经建立原生目录页面分页。

[test/native-caller.test.ts](test/native-caller.test.ts) 证明封闭 sender/输入预算、私有草稿 CAS、旧 generation 拒绝以及网络释放不等于所属 Service 关闭；这些是单元证据。[test/isolated/native-process.test.ts](test/isolated/native-process.test.ts) 用真实 Node→显式 Bun→公开 paired launcher 与新临时 profile 验证私有 bootstrap、身份与 EOF 后所属 PID 退出，制品构建不把宿主资源路径写进 renderer。[test/isolated/native-electron.test.ts](test/isolated/native-electron.test.ts) 使用 Node Playwright driver、真实 macOS Electron、自有窗口/profile 和本机假兼容模型端点，检查实际 main/preload/renderer、刷新执行/草稿、外来窗口拒绝及所属 PID 退出；必须以实际运行结果计资格，不能以 fake port 或启动进程替代。

本入口当前提供完整目录读取、根会话创建、Fork/rename/delete、消息页、新轮次/原命令核实与停止、普通 Interaction、模式与信任及授权目录控制、Model 输入/输出 Inspector、Context Rewind/Include。完整设置、附件 reader、Context 导出、发行安装、Linux/Windows 和旧视觉迁移仍未接入本实际窗口；有大附件但缺 reader 的审批继续只读。Node fixture 绑定已构建 Service；实际 Electron fixture 在私有临时目录构建当前 Service JS，按实际 SHA 与明确 Bun executable 接入。这两者均使用 workspace 公共依赖，不宣称完整 source-free installed Desktop 制品。限定新测试组合当前为 5 项、35 条 Bun 断言通过；实际 Electron 场景另含 14 条 Node 断言与实际 DOM 操作，类型、局部 Biome 与文档结构检查通过。

原生大 Model 输出通过 [main view-read lease](electron/model-output-reads.ts) 与 [renderer reader](src/native-model-output.ts) 接入共享 `ModelOutputMessage`。有 `model_outputs` capability 时才提供显式完整读取；缺能力保持标明的 preview。open 仅调用公共 `Client.getModelOutput`，固定当前 Store、Session、Execution、窗口 generation 与选择身份；main 最多一个在途读取/正文 lease，不恢复丢失句柄，不创建执行或 spool 权威。跨 IPC 每块最多 64KiB（二进制用 base64），请求必须按准确下一 offset 推进，原 1MiB/4MiB IPC 预算没有提高。close、切换、刷新、网络释放只 abort 本读取和清除正文，不提交 Command 或取消 Model/Run。

renderer 按已核实有限 wire size 接收完整 EOF，严格 UTF-8/JSON 后调用公共 `verifyModelOutputSnapshot` 的生成 schema、canonical body SHA、字节数及 completion 核验，再检查原 Store/Session/Execution/hash，只有当前视图可显示。普通会话不启用 reasoning 展示；正文不进入持久缓存。main 的 SDK 快照与 renderer 的完整正文仍可能各占一份整块内存，不能把有限 IPC chunk 声称为固定内存 streaming。[test/native-model-output.test.ts](test/native-model-output.test.ts) 的有限 port 测试覆盖 >17MiB、offset、hash/UTF-8 损坏、迟到 SDK 返回/取消与旧选择；[实际 Electron 测试](test/isolated/native-model-output-electron.test.ts) 使用私有构建 Service、真实 SQLite/本机兼容 SDK 输出，检查完整 >17MiB DOM 尾、显式关闭、跨窗口/旧 generation 拒绝、刷新只保 preview、模型计数不变与退出原 PID 清理。正文采用完整多段；不将单个巨大 glyph raster 的 GPU 平台上界误作本文传输裁剪许可。

本次受影响 Native 组合实测 9 项、71 条 Bun 断言通过；大输出最终 fixture 独立复跑约 36 秒通过，另含 24 条 Node 断言，原基础窗口场景另含 14 条 Node 断言。这是 macOS 开发 fixture 的真实窗口/协议证据，仍不代替完整安装制品或其他平台资格。Desktop 类型、局部 Biome、portable build 与文档结构检查均通过。

[private-data.test.ts](test/isolated/private-data.test.ts) 以实际 Node 子进程验证冷打开、两进程同修订竞争、133 份草稿分页而非淘汰，以及未知格式、损坏行/文件和硬链接局部失败保原字节。[native-drafts-electron.test.ts](test/isolated/native-drafts-electron.test.ts) 使用私有实际 Service 制品、真实 SQLite 与 Node Playwright/Electron：草稿与未知创建意图跨冷应用进程恢复，键盘发起的创建响应在服务提交后被真实 TCP socket 断开，刷新/重启后只核实原命令，该未知原意图的实际 POST 为 1，没有新增 Model 请求。另验证真实 command 冲突的明确业务拒绝保留原草稿，把已停止的临时业务 Store 整份保留再创建新 Store，验证同 ID 新会话输入仍空、原草稿可读且明确关联失效，并逐次核实所属服务 PID 已退出。[实际 React DOM 测试](test/native-drafts-dom.test.tsx) 另证明晚创建回执不能抢回已切换的阅读视图或移动草稿。受影响 8 文件完整组合为 16 项、112 条 Bun 断言通过；最终业务拒绝及新增边界定向 4 文件复验为 10 项、66 条断言。新私有文件 fixture 另含 23 条实际 Node 断言，新冷启动窗口 fixture 另含 26 条实际 Node 断言。Desktop 类型与局部 Biome、文档结构检查通过；这是 macOS 开发制品的限定资格，未声称完整安装、布局持久化、未保存文本自动恢复或其他平台资格。

原生窗口权限控制由 main 调用公共 Client 的五个有限读写/回执方法，renderer 只提交封闭选择。权限面板展示实际根 Session、工作区读取范围和摘要；模式四选、是否设为默认、信任及撤销均须明确选择，子会话只读。main 在点击时固定原 Store、Session/root、Workspace、观察修订与摘要，同在途选择仅提交一次。未知结果保留原 commandId 与范围，在切换后也只核实原 mutation；CAS 冲突不自动重试，必须重新读取并再次选择。计划审阅答复不授予这些权限。

当前权限事实读取失败或观察流重置/失联时，main 不再向窗口提供旧的可写权限事实；窗口说明暂不可核实并提供显式重新读取入口。迟到的旧视图读取失败不能禁用或改绑新视图。网络释放与刷新只影响调用者网络，不停止所属 Service/Run；原权限意图在视图外显示。现有能力缺席时保持只读；实际授权目录管理边界见下方独立说明。

[test/native-permissions.test.ts](test/native-permissions.test.ts) 的有限 SDK port 证据覆盖重复在途选择、未知原命令、切换及迟到读取、缺 capability 与子会话只读。[test/isolated/native-permissions-electron.test.ts](test/isolated/native-permissions-electron.test.ts) 则使用真实 macOS Electron main/preload/React 窗口、私有构建 Service、SQLite 和本机兼容模型计数端点，实际键盘保存模式/default、信任/撤销，提交后真实 HTTP socket 丢失只查询原命令，以及竞争修改产生真实 `host_control_conflict`。显式失联读取使写入口不可用，重新核实恢复实际事实；两个原 Session 的 Run 均为零，Provider 请求为零，退出清理所属实际 PID。这是当前开发制品的限定窗口证据，不代表旧正式入口已切换、完整安装制品或其他平台通过。

原生输入检查器复用公共 UI `ModelInputs`，由 [Native Model Input adapter](src/native-model-input.ts) 连接 main 的公开 `listModelInputs/getModelInput`。Model calls 目录按所选原 Session 和固定 upperSeq 逐页读取，每页不超过 200；不会把第 200 条当作全部记录。Runtime logs 中的原 Model 执行可跳到准确 Execution 的敏感内容确认页，跳转本身不请求正文。这组 logs 只展示当前已保存执行的有限投影，不声称已经迁入完整 Runtime 事件日志。

输入与输出复用同一有限正文读取实现，main 每次只保留一种当前正文 lease；打开另一种读取先释放旧 main lease。每块仍最多 64KiB，原 IPC 1MiB 请求与 4MiB 回应预算不变。renderer 完整收齐 EOF，校验 scope、字节数、hash、严格 UTF-8/JSON，并调用公共 `verifyModelInputSnapshot` 才显示原 System、Messages、Tools、来源与实际 adapter/provider/settings、封存装配和最后派发事实。未确认成功的请求保持 unconfirmed，不证明 Provider 接收；没有可取记录时不以当前设置补造。main 与当前视图仍可能各保留整份正文，不宣称固定内存 streaming 或持久正文缓存。

关闭、切换、刷新及隐藏只 abort 本目录/正文读取并释放视图，迟到响应不进入新 Session，不取消 Run 或重发模型。[native-model-input.test.ts](test/native-model-input.test.ts) 覆盖 >17MiB 完整原输入、64KiB chunk、错误 offset/hash、原身份与取消；另用真实 SQLite/Core 的 205 次固定 Adapter 调用，经公开 Native SDK 和窗口 adapter 读完两页并核对最后一次原请求，读取 cursor 与调用数量均不变。这是 205 份实际持久记录的分页证据，不是 205 次远端 Provider 验收。[native-model-input-electron.test.ts](test/isolated/native-model-input-electron.test.ts) 用真实 macOS 窗口和私有 Service 制品，验证键盘从原执行进入确认页、完整输入及实际 metadata、关闭后清除正文、真实 HTTP 响应 barrier 期间切换 Session 后拒绝迟到输入、刷新无新增 Provider，以及退出原 PID 清理。仍不代表旧入口切换、完整安装制品、全部 Runtime logs 或其他平台已完成。

本输入切片最终受影响 Native 组合实测 12 文件、24 项、170 条 Bun 断言通过（约 64 秒）；新原输入真实窗口 fixture 另含 29 条 Node 断言。Desktop 类型、10 个归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生授权目录由 [main 原观察与意图控制器](electron/permission-grants.ts) 调用公开 `listPermissionGrants/clearPermissionGrants/getPermissionMutation`，通过封闭 IPC 提供实际所选 Session 的页面。分页固定原 upperSeq 和 epoch；下一页 epoch 漂移拒绝，不能将 root 模式事实当作 child 授权。renderer 展示原 Store/Session/Workspace、definition/kind、审批与执行来源和 hash，不显示原命令正文或 bearer。当前主机公共授权规则决定是否允许管理子会话；UI 自身不授予管理权限。

用户明确核对观察到的 Session/epoch 后，main 固定原 commandId/Store/范围与 CAS；同一在途观察只提交一次。未知结果保持原意图，切换后也仅查询原 mutation，不更换 ID 或重发 POST；其他 Session 仍可只读查询。冲突需要重新读取后再次明确选择。读取失败或观察流失效会去掉旧可写目录，迟到响应不进入另一视图。清除不启动 Run/Model、不撤回已执行效果，组件卸载及网络释放也不停止所属 Service。[main 范围测试](test/native-grants.test.ts) 和 [共享实际 DOM 键盘测试](../../packages/ui/test/permission-grants-dom.test.tsx)覆盖精确原 child 范围、观察漂移、缺 capability、重复提交与 late 结果。

[实际 Electron 授权目录测试](test/isolated/native-grants-electron.test.ts) 从真实临时 SQLite/Core 已接受的两份 `same_command` 授权启动私有构建 Service 与窗口。实际键盘清除后断开真实 HTTP 回应 socket，切换会话查询原 ID，原清除 POST 仅一次，另一会话原授权仍在；另一真实 host Command 造成 epoch 冲突时拒绝且不重试。失败 GET 使清除只读，退出核实所属实际 Service PID 消失，随后 readonly 重开确认两 Session 的原 Run/Model 执行数量没有增加。该窗口 fixture 含 13 条实际 Node 断言；它是 macOS 开发制品证据，尚不代表完整安装、旧正式入口切换、child 窗口清除或 Linux/Windows 资格。

此前恢复后的输入/输出、私有冷草稿、创建未知意图、模式/信任与完整目录基线仍为 12 文件、24 项、170 条 Bun 断言。原输入窗口另含 29 条 Node 断言，大输出窗口 24 条，基础窗口 14 条，冷草稿窗口 26 条；这些分别核实所属实际 PID 清理。共享 `ModelInputs/ModelInputPort` 保留 Web 原确认/metadata 语义，Runtime logs 的 `initialExecutionId` 跳转不自动 body GET；scope 改变不依赖 remount key，清正文并 abort，Native 输入和输出共享单 main lease。

授权目录合入后的最终完整 Native/共享权限组合实测 16 文件、30 项、224 条 Bun 断言通过（约 63 秒）；新授权窗口的 13 条 Node 断言和所属 PID 清理包含在其中。Desktop/UI 类型、10 个本切片归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生窗口现通过 [main Context 观察与意图控制器](electron/context.ts) 和 [视图消费者](src/native-context.tsx) 读取公开所选上下文。消息与来源独立分页，固定原 selection/highWaterSeq；消息结束后保留 afterSeq=highWaterSeq，来源结束后保留实际末尾来源 ID，不重复第一页。该 Native 控制器不设历史总页数或 complete 边界总数量截断。页面超过原 4MiB IPC 回应预算时，仅以相同 selection、高水位和两个原游标缩小 GET 页；单项目仍无法传输时明确局部不可用，完整单条大正文传输不属于此入口的资格。

显式 Rewind 只接收已读取的 complete 消息原 ID/seq 或空边界，完整 Tool 配对由 Core 核对。历史 suppressed Job 的 Include 原样传递共享面板点击时封存的 Store/Session/selection/targetRunId envelope；main 再读实际 view，核原 Workspace、当前 selection、准确活动 Run、Execution/resultRevision 与原 Store。缺准确目标或活动 Rewind 明确拒绝。accepted/result_queued 仅显示排队，原 Command 到 checkpoint 后 applied 才表示来源纳入；这两种操作都不创建新 Run 或重放 Job。

每项写入保存原 commandId 和身份，重复在途调用共享 Promise；最多 128 项原意图，超过时局部拒绝而不丢弃未知命令。未知回执只查询原 Command，不重发 POST。视图切换、刷新失败或观察流失效清除旧可写事实；旧读取不能覆盖新 Session。组件关闭只中止自己的 GET，不停止 Run 或所属 Service。SSE 刷新暂时清除 portable snapshot 时，读 scope 使用此前成功选定、按原 Session/选择代次封存的可信 Workspace 身份；写入仍须实际 view 复核，不靠该身份缓存批准。

[main 回归](test/native-context.test.ts) 验证消息与来源交替结束、超过 200 条消息、固定高水位缩页、单项目拒绝、原命令未知查询、精确活动 Include、取消自身 GET 与封闭 IPC 的 scope/Decimal64；[DOM 回归](test/native-context-dom.test.tsx) 验证换视图迟到正文不覆盖，以及共享 Include 第二参数原样透传。[实际 Electron 回归](test/isolated/native-context-electron.test.ts) 在临时 SQLite、固定 Adapter、私有 Service 制品和真实窗口中，完成 idle Job→键盘 Rewind→suppressed 历史→活动 Include queued→下一 Model 完整结果和 exact sourceID；Rewind 已提交后物理 HTTP 回应 socket 丢失，只查询原 Command，POST 仅一次。外置效果账本始终一行，刷新不新增模型调用，退出核实原 Service PID 消失。该窗口含 15 条 Node 断言，证明 macOS 开发制品当前 Context 切片；不代表 Fork/压缩、完整安装、旧正式入口切换或 Linux/Windows 资格。

本 Context 与既有 Native/共享权限联合回归实测 19 文件、38 项、270 条 Bun 断言通过（约 70 秒）；实际 Context 窗口的 15 条 Node 断言包含在该回归中。Desktop 类型、11 个归属代码文件 Biome 和文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生会话管理由 [main 控制器](electron/session-management.ts) 与 [窗口面板](src/native-sessions.tsx) 消费公开 Fork、rename、delete API。用户先读取当前根 Session 的原 Store、selection 和控制修订，再明确选择操作；main 保存原 commandId、源 Session、修订和新分叉 ID，写前重新核对实际 view。child、删除状态、观察失败或 scope 已变只读。同一意图在途共享请求；最多 128 项窗口意图，超界明确拒绝，不静默丢弃未知命令。未知结果只查询原 commandId，不以新 ID 重发，也不让迟到回执切回原视图。该窗口意图本身不声称跨冷应用重启持久化；会话创建与用户草稿仍使用前述私有数据库。

分叉明确显示扩展状态未复制。复制的消息保留服务封存的 `originMessage`；main 只从已读取、按当前视图封存的 Message 推导原 Session/Run，renderer 不能提交源身份作为权威。原正文仍用原 Execution 和原 Store 读取，保持原 BodyRef，不复制或重标 blob。删除确认只表示 `delete_requested`、`stopConfirmed:false`：目录隐藏之后，原 ID 的历史与执行事实仍由服务保留，窗口不会声称资源已经停止。rename 的 CAS 冲突保留原意图并要求重新读取、重新明确选择。

Native 有独立分页 Context reader，因此仅此宿主以 `readContextOnSelect:false` 禁用 portable controller 的重复 Context 预取；便携调用者默认仍读取。main 保留同一已选 Session 的成功视图用于刷新期间的阅读，临时 snapshot 不可用时明确只读，不把加载中当成用户切换。真正 scope/selection 改变仍清除旧视图。持久通知只提示重新读取：一个在途 view GET 加 dirty 标记合并积压通知，Client 仍消费全部事件 cursor；写前仍重新验证原实际 view，没有使用缓存批准操作。同 Session 成功 SSE 更新不会仅因 loading 清除已核实全文。

[管理 main 测试](test/native-sessions.test.ts)、[原 scope 输出测试](test/native-sessions-output.test.ts) 和 [实际 DOM 测试](test/native-sessions-dom.test.tsx) 覆盖原身份、CAS、未知查询、重复与迟到视图；[刷新回归](test/native-refresh.test.ts) 覆盖通知积压的单在途读取和加载期间撤除写资格。[真实隔离窗口](test/isolated/native-sessions-electron.test.ts) 使用本机假兼容模型、临时 SQLite 与私有 Service 制品：原 Fork POST 提交后物理回应丢失，只查询原命令；分叉后读取 >17MiB 原作用域正文，在同 Fork 的管理读取、真实竞争 rename 和成功 rename/SSE 更新后仍显示完整尾部；冲突不重试，未知 delete 只查原 ID，Provider 始终一次，退出核实所属 PID 消失。该场景独立通过 18 条实际 Node 断言，仍属于 macOS 开发窗口资格，不代表正式旧入口切换、完整安装或 Linux/Windows。

真实子进程、Electron 与私有文件测试统一位于 [test/isolated](test/isolated)；fixture 留在 `test/`，迁位后修正实际入口相对路径，原断言保留。未以 checker 例外替代进程隔离归属。

本次管理、刷新与迁位后的完整 Native/共享权限组合实测 24 文件、45 项、308 条 Bun 断言全通过（约 70 秒）；新管理窗口的 18 条 Node 断言、一次 Provider 和所属 PID 消失包括在其中。Desktop 类型、局部 Biome、文档结构与测试归属检查通过；未运行共享 dist 或全 workspace 构建。相同窗口的暂时加载仅保留只读观察，真实刷新失败仍清除可写事实；此区分同时覆盖原授权目录和 Context 消费者。

原生手动压缩和重置由 [main 压缩意图控制器](electron/compression.ts) 调用公开 Service API；[Context 面板](src/native-context.tsx) 只提交当前 observation ID 与完整重点，不能提供 Store、selection 或旧 compression ID 作为权威。main 写前独立读取实际 view 与 Context，核对原 Store、根会话、空闲、selection 和 compression ID；重点按原 UTF-8 全文提交。最多 128 项原意图，未知和 accepted 不丢弃、不重发；原 Command 的 accepted/applied 与原 Run 的 completed/failed 分别展示。历史压缩原 Store/Session、覆盖序号、原 ModelExecution 与触发来源原样读取，没有重标 BodyRef。

[Native 输入选择](src/native-input.ts) 使用点击时已核实的 active Command 和 Run：手动压缩或重置期间普通文本封存原 afterRunId/contextSelectionId 为 follow-up，普通活动工作封存 targetRunId 为 steer，空闲才创建新轮次。Native 显式启用 portable controller 的 active Command 读取，其他 portable 宿主默认行为不变。持久通知刷新每个 Promise 只执行一次实际 GET；dirty 的后继读取在下一事件循环启动，明确用户请求只等待已捕获的读取，再做自身核对，不等待全部通知或 Model 完成。授权目录只读 GET 同 Context 一样使用此前成功选择的原 Workspace，避免后继通知暂时清空 snapshot 时误当切换；清除授权仍要求当前 fresh snapshot，临时加载不能扩大写资格。

[压缩范围测试](test/native-compression.test.ts)、[输入选择测试](test/native-input.test.ts)、[真实窗口](test/isolated/native-compression-electron.test.ts)与[实际活动 Model 刷新 barrier](test/isolated/native-refresh-active.test.ts)核对完整重点、真实摘要与经公开校验的下一持久 ModelInput、旧可见历史、物理回执丢失只查原命令、unsafe reset 保留原点、无点 reset 和冷启动只读零额外 Provider、维护输入原 follow-up 以及不受后继 GET 阻塞的准确 steer。窗口含 33 条 Node 断言并核实两次原 Service PID 已退出；Provider 仅为自有本机固定兼容 SDK，不涉及远端服务。

压缩与通知刷新最终完整 Native/共享权限组合实测 28 文件、51 项、348 条 Bun 断言全通过（约 75 秒）；随后新增确定性授权目录 GET/dirty 后继 barrier 的刷新文件复验为 2 项、7 条断言。新压缩窗口另有 33 条实际 Node 断言、四次自有兼容 SDK 调用及两次所属 PID 清理；原管理窗口 18 条 Node 断言和其他已有窗口证据仍保留。Desktop 类型、portable build、15 个本切片归属代码文件 Biome、文档结构和测试归属检查通过；未运行共享 dist 或全 workspace 构建。这是 macOS 私有开发制品资格，不代表正式旧入口切换、完整安装、Linux/Windows 或付费 Provider 验收。

原生历史由 [NativeHistory](src/native-history.ts) 渐进读取全部公开分页，固定原 Store、Session、选择代次与 highWaterSeq。当前选定会话不设累计记录数或字节截断，另外最多保留八个已读会话缓存；首尾原文不会被截断替代。每页仍受 4MiB IPC 预算约束，公开回应或 IPC 页过大时只在原游标和高水位缩小 GET 页；单项目无法传输时明确未完成。读取失败保留已知正文并撤除操作资格，切换只关闭自己的读取，迟到旧页不能进入新会话，也不取消业务执行。

观察流缺口使旧操作事实失效。main 在原 Store 先读取全局目录基线，再重读目录、当前 view 与完整历史，随后用公开 `startAfter` 重开观察；该起点不成为已应用游标。经公开 Client 校验的 `onReady` 仅确认观察就绪，历史完成与当前事实共同恢复操作资格，不要求产生额外业务事件。历史暂时 loading 保留只读 Context/授权事实；实际失败才清除相应事实。

[历史 reader](test/native-history.test.ts)、[main 原游标缩页](test/native-caller.test.ts)、[ready-only 恢复](test/native-refresh.test.ts)当前组合为 13 项、81 条断言；[实际长历史窗口](test/isolated/native-history-electron.test.ts)读取 5001 条显式隔离库历史记录和额外超过 8MiB 的多消息正文，验证完整尾部、失败保正文与禁用发送、重新读取及迟到切换，Model 调用为零，另有 13 条 Node 断言与所属 PID 清理。记录通过 fixture 直接存入隔离库，未伪造 5001 次 Provider 执行。当前 Context 窗口复验保留全部 15 条 Node 断言；压缩窗口在真实可操作门禁就绪后继续键盘 Enter，保留全部 33 条 Node 断言与四次兼容 SDK 调用，两个所属 Service PID 已停止。这些证据仍是 macOS 开发窗口切片。

2026-10-02 在 macOS/Bun 1.4.2 当前工作树执行 `bun test apps/desktop/test packages/ui/test/permissions-dom.test.tsx`，最终完整组合为 34 文件、76 项、509 条 Bun 断言，全部通过（约 111 秒）。包括 >17MiB 原作用域输入/输出、Context、授权、私有冷草稿、管理、压缩、活动刷新和新增长历史窗口；各真实窗口仍独立核对所属 Service 退出。首轮组合曾失败于暂时历史加载清除 Context 事实，以及 fixture 在 disabled 按钮直接发送 Enter；前者已修复为 loading 保留只读事实，后者等待原 actionability 后继续原键盘动作，原断言和期限保持。Desktop typecheck/build、11 个归属代码文件 Biome、文档结构/影响及测试归属/统一边界检查通过。该结果不改变正式入口和跨平台资格的未完成状态。

当前输入模型选择要求实际 enabled/configured 目录。[原 Context Service 夹具](test/native-context-service.fixture.ts)为其固定 adapter 提供准确 Store/Workspace 的只读 `fixed` 目录，配置修改入口明确拒绝；[窗口 driver](test/native-context-electron.fixture.ts)两次新轮次等待按钮实际可点击。原四请求、一次 ledger 效果、idle Rewind、active Include 与下一 Model checkpoint 的准确来源、无 Job 重放、页面刷新零新增请求和所属 PID 退出断言保持。该夹具适配不改变生产模型就绪门禁；有限窗口1项4条Bun断言及15条Node断言通过，当前完整默认结果另见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[后页 child](test/interaction-pages-child.fixture.ts)和[持久答复 child](test/answer-journal-child.fixture.ts)按同一原 Store/Workspace 的只读目录装配，两个原 driver 的首次发送等待实际按钮可点击；模型事件、权限与所有原期限保持。原后页窗口复验仍完成40个原 Job、40次效果和零取消，原持久答复窗口仍核原全文/身份/digest、POST前SQLite提交、丢原回执、两个Main生命周期、冷原GET两次/POST零次与effect once。源码与新回归符合当前目录合同；第六轮后页现场曾显示run admitted，不能将有限复验通过追认为旧0卡的完整因果，详细范围见进度。

模型设置的安全读取由 [main 配置观察](electron/configuration.ts) 与 [模型面板](src/native-model-settings.tsx) 直接消费公开 NativeClient `getModelSettings`。封闭 IPC 只允许用户或当前项目两种作用域；项目 Workspace 由 main 对当前 Session 的实际 view 推导，renderer 不能提供路径或 Workspace 权威。main 冻结原 Store、选择代次和配置观察，关闭或切换只中止自身 GET，迟到原读取不能进入新选择。renderer 仅收到模型标识、Provider、模型名称、期望启禁、期望默认模型和安全诊断；配置中的 URL、credentialRef、原 snapshot 与 MCP 字段不进入这个面板，配置列表不代表 live 模型发现或 MCP inventory。

模型启禁与默认选择通过专门 `updateModelSettings` 服务业务端口提交；默认模型不能直接禁用，默认选择必须来自已启用且配置可用的模型。main 保存原 Store、作用域、完整读取集和 commandId，最多保留128项原意图；重复在途共享请求，同作用域存在结果未知则阻止新保存。关闭或切换只取消读取，不取消已保存意图；未知回执仅原 commandId/Store 查询，不自动重发。回执需匹配原 scope/readSet/operation，应用成功才重读原面板，迟到旧结果不覆盖新选择。renderer 显示原提交及其 applied/failed/unknown，冲突后须重新读取。一般 JSONC 仍允许暂时不可路由的期望值，不能代替模型设置服务规则；configured 仅是结构/解析事实，不表示远端发现或凭据可用。推理强度已由AI兼容SDK实际传输并保存metadata，当前面板尚不提供该项。[main/IPC 测试](test/native-configuration.test.ts)覆盖脱敏投影、坏配置诊断、原项目推导、拒绝注入 authority 与迟到关闭；[实际基础窗口](test/isolated/native-electron.test.ts)新增六条 Node 断言，实际读取用户和项目配置，Provider 调用为零，再继续原基础执行与所属 Service 退出检查。

当前 Native 模型设置 main/IPC 与实际 DOM 新增回归5项、51断言通过，覆盖原意图重复、坏回执/未知只原查询、选择切换迟到隔离、默认模型禁用门禁、待决作用域写禁用及原读取集。Desktop types/build通过。[真实两模型窗口](test/isolated/native-model-settings-electron.test.ts)通过27条Node断言：held A在保存B后仍使用A，下一显式Run使用B；物理丢回执仅一次POST、零自动GET，跨作用域和Session后原GET一次；读取集冲突保留外部注释和原启用值，冷读Provider总次数仍为2，两次所属Service PID均退出。该结果是macOS开发窗口切片，不代表完整发现、输入区effort、安装与跨平台资格。

模型设置接入、profile 生命周期锁修改之前的完整 Native 基线实测为 37 文件、82 项、564 条 Bun 断言，全通过（119.85 秒，2026-10-02）。包含两模型窗口的27条Node断言与两个所属Service PID退出，以及原长历史、完整正文、Context、授权和压缩等既有断言；Desktop types/build通过。这是锁接入之前的证据，不代表下面的生命周期回归已经包含在该计数中。

Desktop 私有 SQLite 使用与 Core/维护相同的 profile 共享锁。[Node profile access](electron/profile-access.ts)只打开 Service 已初始化的原 `profile-use.lock`，不创建新的命名空间或替代锁；[一次性 Bun helper](electron/profile-access-helper.ts)通过公开 `@kite-ai/agent/profile-access` 校验继承 fd、原路径与恢复 journal，再取得 POSIX shared flock。helper关闭自己的描述符并退出后，Node仍持有原打开文件描述的锁；没有常驻 Service 或源码/PATH 回退。[私有构建](scripts/build-native.ts)打包固定相对 helper 与 SHA，main同时验证 helper 与固定 Bun 身份。该继承 fd 实现限定 macOS/Linux POSIX，本轮实测为 macOS；Windows失败关闭，不宣称 Windows 生命周期资格。

[私有库](electron/private-data.ts)要求本模块实际取得的有效生命周期句柄；伪造、已关闭、重复附着或不同 profile 的句柄拒绝打开。SQLite成功关闭之后才关闭 Node 原 fd；关闭失败保留句柄与锁并报告失败。初始化检查失败关闭已打开数据库与句柄，未知格式、损坏原文和不安全文件仍不建空库替代。main退出先停止自己的调用者，再关闭私有库，最后清理所属 Service；Service意外退出不释放Node私有库的共享权限。renderer attach或Service失败仍可显示只读诊断，不能扩大为私有库创建权限。

[真实 Node 私有库测试](test/isolated/private-data.test.ts)保留冷读、双进程CAS、分页草稿与坏文件原字节断言，并增加真实 helper 对维护 busy/未完成 journal 的拒绝且不建UI库、有效句柄资格、SQLite关闭失败保锁与关闭顺序验证。[实际 Electron 锁窗口](test/isolated/native-profile-access-electron.test.ts)核对真实 Service SIGKILL后UI仍活且维护立即busy、另一profile可备份、UI正常退出与Node SIGKILL后原profile可维护，以及维护持锁/未完成journal的启动诊断不创建空UI库；窗口16条Node断言，Provider为零。所有构建、profile与进程仅属于隔离临时fixture，不使用共享dist。

profile 生命周期锁接入后的最终完整 Native/共享权限组合实测为38文件、83项、574条Bun断言，全通过（127.46秒，2026-10-02）。新profile锁窗口保留16条Node断言，模型设置窗口保留27条；完整历史、超过17MiB正文、Context、授权和压缩原断言均保留。前一轮唯一失败是压缩fixture末次无点reset只读查询时合法返回accepted、Run尚未可见，却只等待completed；fixture现在在原10秒期限内仅按同一commandId/Session继续GET核实，不再次POST或更换意图，压缩窗口最终35条Node断言通过。Desktop类型、私有构建及本切片格式、文档结构/影响、统一边界和测试归属检查通过；该结果仍为macOS隔离开发制品资格。

[实际长历史窗口](test/isolated/native-history-electron.test.ts)进一步通过真实SSE断开与HTTP410重连验证缺口恢复：fixture暂停所属网络重连并推进隔离库replay_floor，真实Client完成reset、原Store完整分页重读与新ready。两次缺口覆盖5051条/超过8MiB正文、重读期间正文保留且禁写、切换隔离与迟到页拒绝、恢复后实际rename/SSE标题更新；新增三次HTTP写各一次，Model/Provider零调用、原Run不增。当前45条Node及6条Bun断言保留原13条窗口断言，所属Service退出已核实；仅证明macOS开发制品中的实际恢复链，自动retention调度和其他平台资格另计。

Native 显式恢复由 [main owner](electron/recovery.ts) 与 [renderer 面板](src/native-recovery.tsx) 实施有限 `prepare/submit/lookup/close` IPC。用户明确输入原 Run 或原 `job.report` Command ID；interrupt 必须明确勾选确认。main 读取实际根 Session、Store 与原记录，冻结原 ID 和原 Run 的 `originCommandId`，生成恢复 Command ID，并调用公开 SDK 的 `resumeRun`、`resumeJobReport` 或 `recoverSession`。renderer 只有 DTO 与不透明 observation/read ID；它不拥有 profile、token、Runtime 或 execution owner generation，也不从窗口中的有限 Run 列表推断恢复目标。纯 decoder 与原结果 Run 的 Store/Session/origin 核对共同验证回执；`resumed` 表示已核实恢复受理与原绑定，Run 完成仍须读取实际状态。

[私有 UI 数据库](electron/private-data.ts) schema 2 增加有限 [恢复意图 journal](electron/recovery-journal.ts)，在现有真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与 `BEGIN IMMEDIATE` 边界内先保存原 Store/Session/target/original Command 及 main 生成的恢复 Command，再发 POST。schema 1 自动迁移保留原草稿与会话创建意图；未知 schema、损坏文件或坏意图不回退空库。journal 是 UI 请求身份记录，不是 Service receipt 或执行权限。最多 128 项未决恢复；当前进程最多 128 项意图，超界拒绝且不丢弃 unknown。同一 observation 共享原 Promise/Command，一次 POST；丢失或坏回执保留 `outcome_unknown`，不自动重发或自动查询。独立 unknown/accepted 阻止同一实际 Store/Session 的新恢复提交，其他 Session 的意图保持独立。

Native 重开或 main SIGKILL 后，持久 `submitting` 转为 unknown，未决原 ID 只通过显式 `lookup` 做原 Command GET。关闭读取、切换或迟到回应只释放该读租约；不会取消 Run、重发恢复或覆盖独立 unknown。查询已 applied receipt 不重新安装另一次进程崩溃丢失的热绑定；若又发生真实 orphan 边界，必须先核实原意图，再由用户 prepare/submit 新的明确恢复。已知终态不能被迟到读取降回 unknown；未知副作用仍由 Service 原闭包保护，interrupt 回执里的 unknown Execution 不被宣称完成。

[owner 反例](test/native-recovery.test.ts)、[实际 Node 私有数据库](test/isolated/private-data.test.ts)与[真实 Electron 恢复窗口](test/isolated/native-recovery-electron.test.ts)覆盖原 Run/report 身份、明确 interrupt、重复提交、晚回读取消、unknown 封闭、冷 journal、原回执查询以及原 Ask 卡继续。窗口使用显式 SHA 核验的 Bun/Service 制品、所属 profile、真正 Node Playwright main/preload/renderer；实际物理回应断 socket、坏回执与 main/所属 Service SIGKILL 分别保留原命令。report fixture 读取原 Task/child carrier/report，原模型完成不重复，恢复生成 Run 的 `originCommandId` 是原 report Command。此资格仍是 macOS 本机隔离开发窗口，不代表正式安装或 Linux/Windows Electron 资格。

Native 普通 Work 与准确单 Job 停止现在通过 [main caller journal](electron/caller-journal.ts) 和现有 [输入 owner](src/input.ts) 保存完整的五类公共请求：`run.start`、`input.steer`、`input.follow_up`、`command.cancel`、`execution.cancel`。[私有库](electron/private-data.ts) schema 3 在事务中迁移 schema 1/2，保留原草稿、创建与恢复记录，新增 `caller_intents(command_id,state)`。每行闭合保存原 Store/Workspace/Session、认证 subject、完整请求与准确目标、本地完整正文 SHA 和公开 canonical request SHA，可独立附加原草稿 identity/revision/text SHA；不保存 token、lease 或执行 authority。合法 `afterRunId:null` 保留原值，steer/follow_up 都核实当前 contextSelectionId，不能借当前 Run 改写原目标。

私有 caller journal 最多 128 行，原 UTF8 state 文本聚合最多 16MiB；这是本地 UI 私有容量，不能裁正文、驱逐 unknown 或变成服务端 task quota。真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与事务提交在首次 POST 之前完成。只有本次新 prepare 得到的完整冻结热意图可发送一次；已存在或冷 `submitting` 行只能查原 Command GET。坏文件、容量、缺本地意图及错误 Store/Workspace/subject/body/target 全部失败关闭；known 不能被晚到失败降级。查询和关闭不会补 POST，取消输入保存准确原 Command 的独立 cancel 请求；停止 Job 先读新鲜实际 Execution，不从父 Run 或另一个 Job 猜目标。

[renderer 原申请面板](src/native-caller.tsx) 只接收有限 metadata 和具名 prepare/submit/original lookup/list/known clear/full-body reader。NativeState 不带累计完整请求。普通 IPC 保留 1MiB 请求与 4MiB 回应预算，只有完整 caller prepare/submit 请求采用独立 16MiB 上界；正文 reader 固定原 Command/read ID、SHA 和连续游标，按页传输，核实完整 EOF/UTF8 字节数后展示。读取关闭、切换和迟到页不能改另一意图。`applied` 仅是原申请回执事实，`cancel_requested` 不是 Job 终态，原业务 controller 继续观察实际 Run/Execution。回执或冷 lookup 不清后来编辑的草稿，也不修改单次 Plan/Workflow envelope。

[实际 Node caller](test/isolated/native-caller-journal-host.test.ts)使用真实默认 Service、SDK、Node SQLite、物理 POST/首 GET socket 丢失和 producer SIGKILL，核对五类原请求只有一次 POST、冷只查原 ID、Core Command 仅一条；另核 prepared 零 POST、空 afterRun 的 stale selection、hot body drift、原 subject/body/Workspace drift、128 槽满与损坏行 before-POST 拒绝。[真实 Electron 窗口](test/isolated/native-caller-electron.test.ts)通过 main/preload/renderer 与实际 owned Service/main SIGKILL，读回超过 1MiB 的合法完整 Workflow envelope，并保留 CRLF/中文/emoji/combining、单次 Plan、后改草稿和原 SHA/EOF。大 Workflow 输入中的未配置 skill 按实际 Service 拒绝，不能称业务 Workflow 完成。双 Job 窗口使用明确配置的 `shell.launch`/`shell.command` host policy，原父 Run completed 后只取消准确一项，另一项仍 running 且零取消；不是默认任意 Shell 授权或 Workflow verifier 资格。维护 manifest v5 的严格 Desktop DB3 备份/恢复由 Core owner 单独验证；旧 manifest 不扩展接纳新 DB。

这些新增资格仅覆盖 macOS 隔离开发制品与上述断言。正式安装、Linux/Windows Electron、整个 §35 管理能力或所有业务结果不能由 caller 回执资格推导。完整请求、wire、Core SQLite 与私有 journal 字节由 fixture 保留在 `/private/tmp`；失败日志保留，原窗口期限与 SDK 校验没有放宽。

本片最终输入/恢复/profile/模型设置/压缩邻接组合为 11 文件、37 项、296 条 Bun 断言全通过（108.97 秒，2026-10-03）；其中五种实际 Electron 普通 caller 窗口全部通过，模型设置窗口另保留 35 条 Node 断言、压缩 40 条、profile 锁 16 条。Desktop types、portable build、21 个归属代码文件 Biome、统一边界、测试归属和文档检查通过。首组合复制 driver 时漏带具名 reader helper，迁移新增断言一度误读只列未决的 creation 目录；两项修复只同步 fixture 实际制品与原持久回执检查，保留失败日志及原期限，没有改为 stub。

最终组合之后新增的五种实际 Electron 窗口增量为 5 项、20 条 Bun 断言全通过（40.60 秒），另在实际 Node driver 核对强杀前后 Core 原 Run/Execution ID 集合完全相同，冷原 GET 不新增执行。该增量独立保留，不替代上述 11 文件邻接结果或将受理回执称为业务完成。

## Native Files 检查点恢复

[Main caller](electron/file-recovery.ts)通过有限的 `fileRecovery.*` 桥读取真实 checkpoint 目录、完整 preview 与恢复状态，观察绑定当前连接 generation、选择、Store/Session/Workspace/contextSelectionId 和输入 revision。Renderer 不能提交任意 Action、请求、Command ID、授权、Profile 或 token。仅会话、仅代码、代码与会话分别使用公共 SDK 的原意图；所有适用 Command/restore/newSession IDs 在第一次 POST 前一次性保存。代码恢复仍经原普通 Action 和独立的人类审批，保存成功回执不代表其他工具已获授权。

Files journal 在 [PrivateData](electron/private-data.ts) 的 DB4 引入准确的 `file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)`；当前 DB7 保留此表，旧版本 0–6 沿各次闭合迁移升级，原四表与 Files 记录保持。整行是完整 `FileRecoveryIntent@1`，主键取首腿 Command ID。异步闭合解析与 SHA 校验不持有同步事务；事务重新核实际已附着 Profile 的 live 数据库、原不可变 canonical 身份、两腿 phase CAS 和单调转换。全部适用 code/Fork Command IDs 跨行唯一；原 UTF-8 损坏、错误 digest/主键/表结构、冲突与容量不足均拒绝，原坏行不删除。目录最多保留 128 行、16MiB 原 UTF-8，不驱逐 unknown。它保存用户申请和核对状态，不保存执行授权。

prepared/submitting/pending/unknown 重开后只能查询原 Command 和准确原 restore ID，不取得热许可、不重新 POST，也不自动继续第二腿。代码成功与 Fork 尚未完成分别显示，关闭、编辑或切换观察不会撤回原申请；迟到结果只更新原保存意图，不能切换新视图。恢复到不同 Store 的旧意图保留原 Store 身份，只读展示，不重新绑定或获得热许可。both 必须明确继续，重读原 Command/status 与原 point 的完整当前 preview，核当前作用域、selector、原 checkpoint 身份和每个文件均为 unchanged。外部编辑或后续合法 Files Run 使它拒绝继续，保留 code succeeded/fork not_started，不重写代码或更换 ID。这里没有全局工作区锁，也不声称消除最后读取与 Fork 之间不合作编辑器的竞态。

[真实 default paired/Node](test/isolated/native-file-recovery-paired.test.ts)覆盖三个 scope、原 Code/Fork HTTP 回应丢失、两份独立 Ask、完整 BOM/CRLF preimage、新 inode、原 ID 冷 GET 零 POST，以及外部编辑和后续实际完成 Run 的继续拒绝。另在完整两腿 intent 已提交 SQLite、首 POST 尚未调用的实际 Node 窗口 SIGKILL，冷重开保原 IDs/unknown、零效果重做。[实际 Electron](test/isolated/native-file-recovery-electron.test.ts)经 Main/preload/renderer/default Service 验证原卡合法 approve_once、代码和 Fork 丢回复、owned Main/Service SIGKILL、冷查原 ID 零 POST与正常退出 owned PID 消失。只读测试观察曾被实际 AbortError 取消；有限 fixture observer 仅在确认真实 abort 后重新 GET，产品没有轮询或自动重试效果。首次 Native 审批解码遗漏 grant 已按有限枚举修复，原失败日志保留。

[真实 Node 私有库](test/isolated/file-recovery-private.test.ts)检查三 scope 持久字节、digest/UTF-8/主键/全局第二腿冲突、容量、单调 CAS、冷 unknown 和旧 DB3 迁移；[DOM](test/native-file-recovery-dom.test.tsx)与[有限 IPC/最终提交 scope](test/native-file-recovery.test.ts)覆盖 edit/hide/scope 变化、迟到观察与持久 submitting 后新选择零 POST。这是 macOS 隔离开发制品与固定本机 Provider 的资格，尚不证明正式安装、旧入口切换、Linux/Windows 或全部 Files/Native 功能。

当前 Native Files 与原 caller/recovery/Session/private-data 邻接为 11 文件、30 项、249 条 Bun 断言全通过（62.99 秒，2026-10-04）；真实 Node 与 Electron driver 的独立断言保留在对应 fixture。Desktop types、portable build、21 个归属代码文件格式及文档/边界/测试归属检查通过。首轮组合的两个失败分别是测试在实际审批卡投影前读取卡，以及旧 Session fixture 固定期待 omitted=true 文案；最终测试等待真实卡、核非法 grant 零 POST 后合法 approve_once，并按实际 applied/omitted 布尔/newSession 回执读取确认分叉。原失败日志保留，生产期限、权限和 scope 校验没有放宽。

## 完整 Native 发行边界

根 `release:build --product native` / `release:native` 使用[Native 构建器](scripts/build-native.ts)，物化实际 Electron、完整新 Terminal、main/preload/renderer 与准确目录/框架链接。主进程同时持 outer 和 inner 两个 artifact SH；一次性 Bun helper 只关闭继承的 descriptor 副本，不解锁 Node 原 owner。Service 独立持这两个 root 的使用权，不能由窗口关闭推导已释放。

归档、双 root 卸载、独立 CLI 注册和 shell cache 的当前产品边界见[Native 制品 owner](docs/native-release.md)。Node 私有 UI 数据库在选 Profile 前测量并核对 manifest 的实际 `node:sqlite`；它与 Bun Worker 是独立引擎。当前本机 Electron 44.3.0 / Node 24.20.0 使用 SQLite 3.53.4，Bun Terminal 使用包内 3.51.3；版本与 sourceId 分别固定。类型、纯版本 smoke 与窗口生命周期是不同证据，正式签名及 Linux/Windows Native 安装仍未交付资格。

Native 提供“下一页待决请求（替换当前窗口）”与“停止读取待决后页”。闭合 IPC 只接受 generation、viewGeneration 与实际 afterId，不授予 renderer 注入 Store/Session/工作区或取消 Run 的权限。后页替换最多 20 卡，原实例、Store、Session、工作区、context selection、snapshotCursor 的观察变化使旧页读取失效；它不是 SQLite 跨页快照。显式选择与关闭会 abort 原查询，迟到页不能发布。自动事件 refresh 对同一作用域重新读取当前窗口的起点并发布新 generation/revision；作用域变动回到首页，旧卡 revision 不能作为新回答证据。完整附件 gate、原答案 commandId 与只 GET 查回保留。

[页守卫与 Main refresh 回归](test/interaction-pages.test.ts)、[真实 Electron 后页窗口](test/isolated/interaction-pages-electron.test.ts)与[专属 driver](test/interaction-pages-electron.fixture.ts)核对 40 个真实原 Job 卡、真实 renderer 下一页、后页原卡的物理 POST 响应丢失、切换后只查原命令、next close/switch abort、40 原 Job 的 succeeded/一次物理效果和零执行取消。该后页测试核对 Controller 生命周期内原答案查回；跨 Main 冷答案资格由下述专属 journal 与双 Main 测试证明。当前后页证据仍是 macOS 私有开发制品。

原生答案由 [answer-journal.ts](electron/answer-journal.ts) 沿既有私有 UI SQLite 的 DB5 `answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)` 保存；旧版本 0–4 原位迁移，未知 future version 失败关闭。单行最多 4MiB，全部 128 行与 16MiB 容量是私有资产的局部边界，满时在首次 POST 前拒绝，不删除未决记录或裁原答案。保存完整原 Store、presentation Session/Workspace、subject、Interaction/Execution/Run、revision、answer、commandId 和 canonical body/request SHA；FULL 提交成功后才允许本次热意图一次 POST，保存失败零 POST。它与业务 Core 是独立 SQLite 资产；维护备份/恢复须保留整份原私有文件字节，不能把本地行解释为 Core 命令权威或审批许可。

冷 Main 将 `submitting` 显示为 unknown，仅展示原身份、摘要与“只查原答复”；没有冷 POST 方法，也不为同一原卡/revision 换 commandId。显式查回先核 admitted Store/subject，再读原 presentation Session 与 Workspace，最后只 GET 原 Command。只有准确 `interaction.answer` 的 applied/`answer_saved`、原目标、decision revision +1、subject 与 request SHA 都匹配才确认；accepted 或错误 kind/target/revision/outcome 仍 unknown。不同 Store/selection 保留原关联 unavailable，查回不切换阅读视图。持久行不恢复旧卡观察、完整附件 EOF/hash 读取证明或授权；新的审批仍须当前有界页、新鲜观察与完整附件 gate。

[有限原意图回归](test/answer-journal.test.ts)核对保存失败零 POST、热提交与冷 GET 的错误回执、subject/Store drift、冷旧卡不能换 ID，以及不恢复附件证明。[实际 Node 私有资产](test/isolated/private-data.test.ts)核对完整 Unicode/CRLF 原答案与大整数 revision 冷开、重复目标/command、容量不淘汰与 DB5 迁移。[实际双 Main](test/isolated/answer-journal-electron.test.ts)使用 macOS 私有开发制品、owned Service/Core、Main SIGKILL 和 Node SQLite 观察，核 POST 前已提交完整原行、提交丢响应后冷 GET 丢一次再查原 ID、cold POST 零、其他 selection 不 rebind、原 Run completed 与原 execution 效果账本一行。此证据不声称正式安装或 Linux/Windows Electron 资格。

原答案随整份一致私有 SQLite 由[维护 v7](../../packages/agent/src/maintenance/README.md#原人类答案请求的独立离线资产)保存、inspect与恢复；新Core Store保旧UI身份，不升级为热权利。纯/实际Node组合13项164断言、相邻8文件38项358断言和真实后页/双Main2项6条Bun断言是各自独立范围，冷Main专项1项3条Bun断言另有真实driver内部断言。丢回执hook转发实际SDK后丢响应，不能冒称物理socket破坏。独立资产的持久理由见[原答案决定](../../.agents/notes/implemented/architecture/2026-10-04-original-human-answer-intent-assets.md)。


## Native Provider 与下一次模型选择

[Provider 面板](src/native-provider-settings.tsx)和[模型选择器](src/native-model-picker.tsx)是正式 Native renderer 消费者；Main 的[Provider manager](electron/provider-settings.ts)沿公共 Client/Service 管理接口固定原 Store/generation、用户观察 readSet 和五字段操作。renderer 只持安全连接/模型事实，不取得路径、credentialRef 或 opaque revoke authority。四类明确 family，手动名称直接保存、留空才显式发现；切换/关闭清未保存密钥与字段，局部必填/URL 错误聚焦，提交后密钥清空，等待/未知跨关闭保留。凭据与配置结果分别显示；已发布后的刷新失败保原结果，原 GET 的 applied 刷新输入选择器，不重绑定迟到面板。新模型 disabled，默认禁用门禁和开关失败恢复保留。

[配置原意图](electron/configuration-journal.ts)在首次热 POST 前 FULL 保存非秘密原 input 与 safe state。[PrivateData](electron/private-data.ts) 的 DB6 从 DB0–5 保留原六表，新增准确 configuration_intents(command_id,state) 与 model_routes(store_id,session_id,model_id)；当前 DB7 保留这八表并增加下文独立 MCP 记录；前者最多128行/16MiB、原 input 不可替换、终结才删除，坏行保字节并拒绝写。Provider 与模型设置共用原 Store 未决门禁。冷行只允许显式原 ID GET，不持有 secret、不自动 GET/POST。已存未发布的 opaque reference 只留 Service/认证 SDK，Main 不投影它到 renderer。

模型选择按 Store/Session 保存，首条原 start/follow-up intent FULL 保存后才记本次模型 ID；打开新 Session 或读设置本身不绑定 route。输入只从 enabled/configured 的完整目录选择；缺失原显式 route 不回退全局默认。临时 effort 只在当前页面会话状态中，换模型/刷新后清除，不进入 model_routes 或配置 journal。[主输入](src/native-input.ts)冻结实际下一次 model/effort 到 start 与 active follow-up；普通 active steer 保原文本/target，不改活动 Run。ModelInput 和实际 wire 使用同一原设置。

[实际默认 Native 候选](test/isolated/native-provider-bundle.test.ts)与[Electron driver](test/native-provider-electron.fixture.ts)在 macOS、源码外搬迁制品、自有 HOME、OS PATH、固定 SQLite 与默认 OS vault 下通过1项/190条Bun断言：四类表单、一次真实发现、7根Run/8次SDK请求、原 effort、活动冻结与下一次切换、新 Session 首次绑定、物理保存丢回执后冷原GET一次/POST零。两个所属 Service PID 正常结束；实际两枚测试凭据由 Service 准确 revoke，profile exclusive lease 可重新取得。endpoint 是受控 loopback，退出 warning 用明确 dialog 端口回答；不证明付费远端、系统 modal 点击、签名安装或其他平台。有限 Main/DOM/输入15项137断言、真实 HTTP8项93断言支持对应局部边界。

本轮当前原完整默认589文件/471原任务全部通过，runner exit0/drain815.977s，4009regular输入与Git前后相同；其中上述实际Provider窗口45573ms及原Model、安装、CLI/TUI、Context/后页/持久答复消费者均通过。原红、嵌套同名fixture、制品摘要和权限环境范围见[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-06native-provider-设置与下一次真实模型选择)；完整默认通过不代表完整V1.3、MCP设置或三平台资格。

Profile 无三项 raw MCP 文件时，DB6 离线备份使用专属 manifest v14；任一实际存在则优先使用下文 v16。原设置 input、Session route 和完整含 effort 的原 caller 请求在新 Core Store 下保旧身份；冷读不发送请求。旧 v2–v13/DB1–5 仍按各自闭合格式，维护 codec 不依赖 Desktop/Client，见[维护 owner](../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。

原意图、两个介质结果和临时选择的长期取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-06-native-provider-intents-and-next-run-selection.md)。

## Native MCP 完整设置

已确认设计，实施中：[设置页](src/native-mcp-settings.tsx)、[Main manager](electron/mcp-settings.ts)、闭合 Source Review 与 DB7 原申请已集成。真实 Service/HTTP 联调与 macOS 源码外正式窗口已核来源、连接、工具全文、下一 Model schema 和一次效果；本轮原完整默认595文件/474任务通过，四个 Auth Action 的实际系统浏览器/default OS vault 组合资格仍待人工验收。[实施方案](../../docs/plans/unified-agent-native-mcp-settings.md)负责安全目录/来源操作/四项认证/连接与重连/原工具详情的完整用户旅程和验收；自动回归通过不能代替实际浏览器组合或完整客户端资格。

Main 冻结真实 Store/subject/Session/Workspace identity、read-set 和观察代次；renderer 仅提交来源 ID、有限操作与显式范围。换 scope/关闭释放自己的 Reader，不取消业务 Execution。工具页固定原 snapshot，Main 最多两份在途 descriptor、每次至多64KiB chunk；完整 EOF/size/hash 和严格 UTF-8 核验后才显示全文，读取零额外连接或远端 RPC。来源批准/既有 Ref binding 由独立 Source Review 答复，普通父 Action、连接 Job 和远端 Tool 的 Ask 各自保留。

[私有 MCP codec](electron/mcp-journal.ts)在 DB7 的 `mcp_intents(command_id,state)` FULL 保存完整非秘密原申请，独立128行/16MiB原字节上界，坏行保字节并拒绝写，未知不淘汰。首次提交前保存，冷/foreign 行不获得热 POST 许可；明确 Check 只查询原 ID，取消需准确原 Execution 的普通持久 caller 申请。已确认终态不被后来 pending/unknown GET 降级。来源发表成功但独立凭据清理失败/未知时保声明已保存与总体未确认，不能清除为成功。[DB7/manifest15 维护](../../packages/agent/src/maintenance/README.md#desktop-db7-与-manifest-v15)保独立 codec、历史 DB/manifest 白名单及原 Store 身份，恢复不自动 GET/POST。

Profile 无三项 raw MCP 文件时 DB7 创建 v15；`mcp.json`、`mcp-approvals.json`、`mcp-auth-bindings.json` 任一实际存在则创建 [v16](../../packages/agent/src/maintenance/README.md#profile-mcp-配置资产与-manifest-v16)，同时保留上述完整 UI 资产和三项原字节／absence／proof。恢复不读 Vault，项目配置仍在 Workspace；当前 source consumer 核新 Store 与物理 scope，旧项目批准和 credential binding 不获得新执行权，普通当前 Action／Question 才可新增决定。Native codec、冷读和原请求 grammar 保持。

[真实 Main/HTTP](test/isolated/native-mcp-main.test.ts)当前1项61断言；[源码外 Native 窗口](test/isolated/native-mcp-bundle.test.ts)1项18条Bun断言，driver另核实际UI与协议：两范围 Add/Remove/Select、项目批准、真实默认OS引用的bind/revoke、stdio/HTTP独立审批与ready、248180字节Unicode descriptor及零新增RPC、refresh、reconnect oldStop、下一Model schema/独立Tool Ask/一次效果、DB7冷原GET一次/POST零。两个Service PID正常退出，准确测试凭据fresh backend absence及所属进程无残留均核实。候选使用构建前固定的测试loopback网络，不冒充生产网络、OAuth、外部账号或三平台资格。

窗口Host只在已验证候选的shared lease内，使用packaged runtime/config的默认OS backend准备准确自有引用；helper沿正式paired Service的有限PATH/LANG环境，父测试与Native driver仍保隔离HOME。引用ID在put前保存，失败也可准确remove；独立新helper/backend核absence后才释放shared lease并复核exclusive权。不发现用户Kite配置、枚举其他Ref或修改系统keychain设置。

[人工浏览器资格](scripts/qualify-native-mcp-browser.ts)用独立临时Profile、自有HTTPS AS/MCP和构建前固定的公开证书，保持实际默认Chrome、默认OS backend与普通Ask。先让用户处理浏览器生成的证书提示，再启动原120秒OAuth callback期限；脚本不绕过提示或修改系统信任。四项Auth、原cancel、真实document导航/PKCE、fresh Service复用与清理后absence必须全部通过最终 `qualification.json` 才成立；`candidate_ready`只描述装配，尚未完成的窗口不能作资格。这个显式人工入口不放入自动默认调度。
