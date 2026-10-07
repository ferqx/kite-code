# 通用 Agent 新执行边界

状态：active

必要业务义务通过[范围登记与最终 read-set 核对](../../packages/agent/src/storage/sqlite/requirements/README.md)实现。可信 initializer 在首个 Execution 前只创建当前 Run namespace 的不可变 executable 元数据；普通 Tool 追加义务，不得撤回已封存 refs。当前 boundary 和只读关联记录由 Core 提供，派发/完成事务核对准确原 Store、revision 和 related-record CAS，缺实现或未知判定值拒绝。已创建 Job 继续使用原 refs 与原配置 lease。

原结果自动报告也保留这个边界：`applyJobReport` 在实际 source/carrier/afterTurn 应用事务中复制父 requirements 到新 report Run，不重新登记外国 Run refs。默认 Service 只通过实际原 report Command/receipt、source Execution、父 config、已知 result revision、root work 和主体关系读取原 Planning 批准；任意同 Session 新 Run 不获得例外。历史 receipt 的来源 digest 按原实际 Execution/批准 Run 重建，当前 inactive Run 的信息贡献保持 `approval:null`。各 owner 与真实资格见[Service](../../apps/service/README.md)和[Planning](../../packages/agent/src/business/planning/README.md)。

[自动 mutation 验证](../../packages/agent/src/business/planning/README.md)由可信装配明确选择真实版本及 effects，Core 只保留通用 mutation/completion governance 边界。派发前保存潜在验证事实，真实 Execution 结算与事实 revision 在同一短事务落定，文件路径/hash 列表分页读取，不转成每个文件一条不可撤回 RequirementRef。Model 完成候选通过同 Loop 的普通 `validation.auto_check` 与独立获准的真实 Files checker 验证；失败诊断作为低权限结果交给下一 Model 修复，未知或取消不自动继续。后序同 Store/Run、同路径的实际成功 mutation 可以将旧 hash 验证标为 superseded，仍保留旧事实，最后 mutation 必须实查；failed/unknown/cancelled 不因此解除义务。JSONC 不能授予这些 hooks 或隐式补选 checker。

Extension 的业务 Context 贡献只接收 scoped read projections，Core 检查 namespace、有限格式和预算，并强制以 user 数据呈现。公开执行证明仅提供准确 identity、attempt、定义、参数摘要、结果 revision 和原来源 id/digest；信息 receipt 另行核实原 Interaction 的 accepted revision，不替代工具授权。配置文件、正文、展示卡和调用者自报证明不能生成这些权威事实。

读取时机：修改新 Agent 的 Store/执行/模型接口、目标 HTTP schema、跨包依赖或过渡调用者时。

验证：`bun run test:unified-agent`、`bun run check:unified-agent-boundary`，实际运行范围见[实施证据](../plans/unified-agent-refactor-v1-progress.md)。

总体设计按[V1.3](../plans/unified-agent-refactor-v1.md)实施。当前根 formal/default/CI 调度已使用精确八个新 workspace；新链路不包装旧 Host/Kernel/State，不双写旧数据、不自动 fallback。旧源码与历史测试保留作参考，不进入正式产物或默认调度。各能力完整保真、平台与 §35 最终退役仍须实际证据，静态退出不代表总体完成。

[`ai`](../../packages/ai/README.md)拥有中立模型协议与独立 SDK 适配 leaf；[`agent`](../../packages/agent/README.md)拥有单一 Loop、具名 Store 操作、执行意图/派发/回执、精确取消与显式本地中断。普通扩展只得到受范围限制的调用身份、自有记录和有限 operations，不能写 SQL、owner 或 Runtime 完成事实。Store 是宿主边界，不能作为便利对象传入扩展。Action 不虚构模型 Run，Query 不触发模型、工具或恢复。

HTTP Change 的 `objectId` 读取契约与 Store 事件生产者一致：不透明通知标识上界385字符，覆盖128字符扩展 namespace、分隔符和256字符自有 key，包括点号、斜线和 Unicode。它不解释为路径或执行身份，普通 Store/Session/Command ID 约束不变。Service schema、生成 Client validator 与 OpenAPI 同源；[真实回归](../../apps/service/test/isolated/extension-changes.test.ts)核持久事件逐条抵达、ready 不 ACK、最终原水位 ACK、零 reset 与零额外执行。

SQLite Worker 持有唯一所属连接；业务事实和变化通知同事务。profile/Session 协调锁位于可替换 profile 外，取得 OS 锁后更新 owner generation，正常释放先复查并清空持久 owner。无损 64 位游标与消息顺序不使用 JS Number。未知外部效果不自动重放；失败取消请求不能停止未经授权的对象，真实存储故障只允许对本 owner 已核实句柄执行收缩性停止。

正常空闲交接使用原 owner 的有限 dispatch 观察，核 Store、instance/generation、准确 Session 并与 acquire/release 共用组阻塞条件。旧空列表与释放之间新接受的本 Session 工作，没有未结算执行时沿同一 generation 继续；已取消工作有限释放后退出，其他 Session 保持原调度。真实 unknown/cold active 不借 accepted 新命令解除，观察不取得 owner 或恢复权。[Store owner](../../packages/agent/src/storage/README.md)与[确定性交接测试](../../packages/agent/test/isolated/execution/owner-handoff.test.ts)负责准确范围。

根与 child 使用同一个 Loop 与执行器，根执行组拥有一个 OS owner/generation；child 配置只能选择固定宿主绑定及父允许的工具。每 Run 的定义与来源封存，后台 operation 保留该绑定 lease 直到真实监督终止。Skills/MCP 内容不授予权限；默认 MCP 连接须在普通持久派发之后，不能在配置解析时提前启动。

单次 Skill 选择属于原 `run.start/input.follow_up` Command，不属于 daemon 启动状态。HTTP/Client 只传递有限数组并核 `run_skill_selection`；该能力来自 Runtime 的显式 resolver 支持声明。Core 保持请求摘要与幂等，只由 Service 解析当前可信目录。子配置继承真实父 Run 封存的准确配置 ID，名称不重新匹配，缺失父 marker 或目录项拒绝；Runtime 沿同原 Store/Session/rootWork 的有限实际执行链提供最近父 Run，不猜当前活动 Run。Skill 选择不增加工具、可信 root 或权限，冷历史与原回执只读不重新装配。 无祖先 Run 的 Action 在原派发 scope 捕获实际静态宿主绑定；后代仍按这个集合和原权限限制，不能回退到后来每 Run 配置中的更大工具目录。

可信 child fresh resolver 使用 Store 中的实际 Workspace 与父 Step 范围；父子权限为准确调用的交集，Ask 与 Review 同时适用时必须保留两份实际 proof。child 在 actual activation 持久固定 30 分钟期限，Root 无总期限；timer 与 SQL 最后派发核同一依据。attached 取消、已激活独立 child 与 detached Job 的域分别核实，迟到事实不授权新工作。原 operation key 的历史查回不重新装配或恢复执行。

[Task](../../packages/agent/src/extensions/task/README.md) 的目录按真实 carrier/Operation Command 查询有界摘要，固定 Decimal64 上界与每页最多 200 项，不拉取正文、不重新 ensure。精确 interrupt 在最终事务核原 Store、主体、直接 child、carrier 和当前 targetRunId，不能因旧 Run 结束就转向后来新 Run。wait-any 使用持久变化唤醒与真实目标事实，已存在审批或准确 child ancestry 下的卡片也可早醒；普通 operation wait 继续等待终态。

QueueOnly 邮件以原 `agent.message` Command 和 sender Execution scope 的完整私有 Artifact 保存，sender 的实际成功结算与接收资格同事务提交；失败、取消、未知或未确认不形成成功邮件。idle send 零 Run/Model，普通后来人类工作不自动采用。显式 child follow-up 的原 ensure 事务封存邮件 seq 与成功 sender completed cursor 双上界，原 key 重试不能扩大集合；每页 50 封的实际接收最终核目标 Run/selection、carrier、主体、原 Store 和 stop/delete。邮件原未绑定 intent 不改写为新 targetRunId，保存准确 receivedRunId/selection；下一 Model 只按真实 receivedMessage/source proof 完整展开。Rewind 资格属于准确目标 Session selection，根选择变化不伪称 child 选择也改变。after_turn 只使用真实激活时封存的可信 authorizer/lease/route；nested 与 follow-up 汇报保原 funding child deadline，report 不递归授权，冷缺实现明确 needs_review/零 Provider。人类新工作优先与 report/source/receipt 同事务，默认 SDK 与完整 retry/delivery 的适用资格仍按进度验证。

可信 `readStepCapabilities` 在安全 Step 只选择缓存定义，Model 的实际工具版本与非秘密目录事实独立保存。旧未派发调用在目录变化后失效，下一模型请求同时更新 schema；已派发任务保留原 scope 和 lease。新版本 Tool 的自有 namespace 从准确成功 Model 的实际请求/绑定与原工作身份核实，不能靠调用者声明或替换旧 Run manifest 获得；真正执行仍走独立权限和最终派发事务。

MCP 的 resources/prompts、live-only `mcp.catalogue.refresh` 均是普通 Tool/Action，绑定准确原 connection Job/key/configDigest/generation，read/get 再核成功目录 Execution 与 descriptor digest。刷新不冷连接、不变更原 connection 记录；新 schema 在下一安全 Step 生效。runless 调用从真实 Session/Workspace 核当前 selected-server 后才委托外部权限，宽权限不能跳过来源范围。独立 `builtin.mcp.management` 的 `mcp.servers` Query 与 `mcp.server.select` Action 只管理 trusted programmatic registry 的选择；真实六字段 read-set/Workspace identity 与 HostMutation 保原未知回执。默认原始来源、项目批准与认证绑定按[来源提案](../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)继续实施，OAuth原认证合同归[认证边界](mcp-authentication.md)，Native完整设置由[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)维护；完整浏览器/vault和平台资格仍按实际验收核对。

公开 HTTP DTO 的来源为[Service schema](../../apps/service/src/http/schema/index.ts)，生成到 Client 目录与 OpenAPI；领域/SQL记录通过明确投影连接，不能直接成为 renderer 契约。正式客户端切换完成前，HTTP/Client 的交付只覆盖证据记录的切片。新的连接必须核对启动前选择的目标与必需接口，Store 写身份仍在各自事务内核对。

完整后台目录沿公开 `BackgroundExecutionPage` 投影原主体根会话树与准确来源 Command；当前 Store 用于准入与快照，Execution／Command／Run 保持原 origin。旧来源只在原 root creator 已证明恢复的根内接纳，真实 source／root-work 与不可变 child-start／carrier／Workspace 血缘在分页前核实；多次恢复保期间各原 Store。私有 input/result/configuration 不进入 DTO。固定 Execution 分配上界与同一 Store change cursor，跨页变化整份重读，有限 `getView` 不承担完整目录。原父 Run 从实际执行父链定位，准确 child Run 从原 child-start Command 定位，不能改投当前 active Run。

Native [后台 Main](../../apps/desktop/electron/background.ts)登记完整公开观察，独立于选中会话；有限 IPC 只指定已观察原执行。停止前 fresh 核同原身份／代次／状态，内部 [caller prepare](../../apps/desktop/electron/caller-journal.ts)只为准确 `execution.cancel` 保存实际后代 Session、根、原主体和 Workspace，普通选中根门禁及冷 GET-only 合同保持。完整原输出复用固定 H，子日志核原载体和固定消息上界／完整 ModelOutput。close/reset只释放 GET，原 Task/Run/Job 的业务状态由 Service/Core 决定；当前源 Store与恢复为新Store的兼容范围分别按[owner](../../apps/desktop/README.md#native-跨会话后台总览)和[实施进度](../plans/unified-agent-refactor-v1-progress.md)核验。

Native Skills 目录只经 [Main 的有限 reader](../../apps/desktop/electron/skill-catalogue-reads.ts)和公开 `SkillCataloguePage`。Main 从实际选中 Session 固定 Workspace/Store 与视图代次，open 核原选择/观察代次后立即登记所属取消域，不排在另一个刷新之后；原 read ID 的 close/next 不能重绑或关闭后复活读取。Main 保留原 revision/cursor，每页 128KiB，renderer 复用公共闭合 verifier 并在穷尽全部页后发布，没有累计条目截断。有限 source 仅为配置位置分类，禁用项不因此读取文件，不传路径、正文或授权；目录和页面关闭不创建 Run、改变 SSE 水位或提交业务取消。实际交付与平台证据归 [Desktop owner](../../apps/desktop/README.md#native-skills-目录迁移)。

[本实例生命周期](../../packages/agent/src/lifecycle.README.md)以同步真实 busy 检查与封门实现 if_idle；status 采样不授权稍后的关闭。已受理准备、owner 接管、后台 operation 和未完成 cleanup 参与同一边界，重复关闭共用完成 Promise。只收束本实例真实拥有的工作，不因保存 command ID 就取消另一 Service 已接管的命令。普通 GET 不算执行 busy，但最终 Store 关闭等待原读取资源排空；Service 的窄 beforeResourceClose 回调先封最后业务资源入口再排空。未确认停止或清理失败保留原资源、profile 锁及诊断 HTTP，状态为 drain_failed，不伪造 completed。

独立 Native `/v1/lifecycle` 与 `/v1/lifecycle/shutdown` 用 lifecycleVersion 和原 profile/instance 核对目标，业务 API 不兼容或 Store 不可用不阻断有限诊断。无 Origin 的 bearer 请求才可进入，Browser gateway 不暴露；202 仅为受理，成功资源关闭及所属进程退出另行确认。公共 Lifecycle Client 丢回复后只查询原实例，不自动重发或改绑。成功 HTTP 关闭明确结束 runner 自己的父管道读取；普通网络退出仍不等于父死亡。理由见[原子关闭决定](../../.agents/notes/implemented/architecture/2026-10-02-atomic-service-shutdown.md)；正式 daemon 目标发现与 CLI 切换尚未由此完成。

[`client`](../../packages/client/README.md)只依赖生成 schema 和网络能力；[`ui`](../../packages/ui/README.md)只依赖公开投影与 React，不知道参考扩展业务。SSE 的 ready/heartbeat 不推进 cursor；变化应用成功后确认，过滤范围的 checkpoint 只来自一致页。快照页不代表全局事件应用成功，切换 scope 需要相应水位。reset 后先冻结原 Store 的全局集合基线，再完整重读所需事实；SDK `startAfter` 仅设置重开 scan 起点，保留原 ACK，不将单对象 snapshotCursor 冒充全局应用。validated `onReady` 可确认流准入并等待应用准备，仍不 ACK；正常 EOF 且 ACK 尚未到达重读基线时沿原起点重开。原 Store 改变、读取失败或未完成时不解除对应写门禁，也不重发业务意图。

只读浏览器通过 [Service gateway](../../apps/service/src/development-web.ts)、独立 Cookie [BrowserClient](../../packages/client/src/browser.ts)与[Web](../../apps/web/README.md)连接。Native token、配置和文件路径停留在可信宿主；browser finite GET 不获得执行权限。page 还封存有限资产的完整 hash；page/instance/build/Store 变化拒绝原读取，Cookie 续期/关闭不改变 Runtime 生命周期。逐请求 `verifyConnection` 只核实原身份，不重置共享 Native 读取或 SSE。校验函数从唯一 HTTP schema 在构建时生成，浏览器保留禁止动态代码生成的 CSP。Web 当前按固定上界穷尽历史后核对一致 view，仅可见且实际 isActive 的选择会话轮询；最后快照与错误/过期状态分开，跨选择迟到响应不发布。按需 Context/output 使用原 selection 或准确 Session/Job 范围，不等于实际 Model 请求和完整 Runtime events。根开发 `web:dev` 已使用独立新 profile 与配对子进程；正式入口和完整 Web 页面资格仍按进度记录。

Native 的已保存 Job 读取只从当前实际 kind=job 详情进入；Main 在 GET 前核原观察并同步登记 read ID，fresh Execution 与每页前后 Service 身份分别复核。只读 lease 绑定原 Store/Session/Workspace/Execution、attach/viewSelection/historyEpoch，有限 IPC 页与自适应缩页仍保首次 H；公共 Client 纯覆盖规则由 Native/Web 共用，保持跨 stream gap 与普通内容全部可见，只有覆盖 H 才发布完整保存事实。关闭、折叠、切换、reset 和冷读不取得取消、恢复或重执行 authority。默认 macOS producer 已核真实普通 Job/全树停止及 cold 原输出零重放；这些消费者资格不外推其他平台或全局发布，实际负责与验证归 [Native owner](../../apps/desktop/README.md#native-job-完整已保存输出)。

[Model 输入检查器](../../packages/agent/src/model-body/README.md)按准确 Session/Execution 读取持久请求，目录为固定上界的 Decimal64 keyset，每页最多 200 项。Core 在一致读快照核对原 Store、Command/subject、Run、rootWork 与 child carrier；全文只从原 sealed input 或原 scope Artifact 展开，不取当前 Context、Tool catalogue 或 Provider 配置。每个新请求还封存 actual adapter/provider family、支持的 settings、实际 capability/version/digest 和来源顺序；最后派发的 authorization/controlReads 独立持久保存。兼容适配器的有限 reasoningEffort 传入实际 SDK Provider options，并以相同冻结值记录原 settings；未知值或不透明绑定在 I/O 前拒绝，远端支持资格仍独立验证。opaque、未记录或未来 metadata 明确 unavailable，不用现在配置补齐。Service/Browser 通过完整流传输，Client 核实 EOF、wire size/hash、原请求 canonical size/hash 和准确目标后才发布；大正文不受普通 JSON 便利预算裁剪。共享 UI ModelInputs 经公共 port 供 Web/Native 使用，用户确认后才读正文；日志导航只打开原 Execution 的确认，不隐式 GET。隐藏、关闭、未卸载的 Store/Session 选择变化均取消所属读取并清除正文。只有成功终态标记成功确认，其余持久请求不冒充 Provider 已接收。

[完整 Model 输出](../../packages/agent/src/model-output/README.md)以原 Execution scope 的不可变 linked segments 保存，单段有限且不反复写全部 growing prefix。成功提升原 partial Message 为完整消息；失败/取消保留不完整前缀，截断 Tool arguments 不成为实际调用。下一 Model 核原成功 Execution/Message 和完整链后取得全文；child 大结果由原父 carrier scope 的完整 Artifact 与原 source ID 返回，父不导入 child 历史。公开 `outputBody` 仅为有限摘要；Native/Browser 具名 readonly GET 提供原 snapshot，Client 完整核 EOF、wire/body hash、字节量、状态和身份。UI/Web 显式全文读取只在当前视图保留，关闭/隐藏/切换取消所属 GET。普通 Web 对话按手册不展示 raw reasoning。

公共 `getView` 的 Run/Execution 显示投影使用同 Session 最近200个身份与全部未结束／原unknown身份的并集，去重并保原顺序；不以 lifetime前200项隐藏当前工作。它仍是有限历史与当前事实的投影，不充当完整历史目录，读取不会推进业务或恢复authority。完整Message与输出继续分别分页，当前类型和执行权没有新owner。负责合同与实际长会话证据见[Store owner](../../packages/agent/src/storage/README.md#当前会话视图)。

[Native Desktop](../../apps/desktop/README.md)的 Node main 持有预选 profile、配套 Service、公共 Native Client 与原意图，renderer 只有封闭有限 IPC。原 window/webContents/mainFrame/actual document、generation、CSP/sandbox 与请求预算本地核实。main 的 Model input/output GET 共用最多一个当前 body lease，通过不超过 64KiB IPC chunks 传同一公共 snapshot；renderer 使用公共 Client verifier 核完整结果。视图 detach、refresh 或读取取消不提交业务 cancel，不关闭所属 Service。私有草稿与未知创建 intent 在明确选定的 profile 下保存，发布前核原 Store/CAS/路径，冷重开只查询原创建回执，不第二 POST；损坏和硬链接保留原字节并拒绝。完整目录穷尽固定 upper，超过 200 项仍核每页身份。完整历史同样固定原 Store/Session/selection 与顺序上界，累计数量和字节不构成截断门槛；单 IPC 预算不足时缩小同一 cursor 页面。切换取消所属 GET，迟到页不发布；读取失败保留已有历史并撤销写操作资格。SSE reset 先保存原 Store 全局目录基线，再重读 view/history；startAfter 只定扫描起点，onReady 确认连接，二者都不推进 ACK。模式/trust 与授权目录清除已用真实窗口键盘、丢响应原查询和实际 CAS 核对；旧入口切换、其余完整管理、安装与平台资格仍按证据判断。

Native 的[单次 Plan 入口与审核](../../apps/desktop/README.md#native-计划入口与完整审核)只传原 Run 的闭合意图与准确 Interaction 回答；完整正文由原 card/Artifact identity、EOF/hash/UTF-8 和 Main 当前视图传输证明共同约束。普通同范围刷新仅保仍 actual offered 的已完成 key，真实重选或观察 epoch reset 同时撤销 Main/renderer 正文资格；原模式与反馈草稿另按原身份保留。Planning 的实际 ToolResult 传递原 revise/deny/approve 与反馈，信息回执不授予 Tool 权限、不替新版本审核。已派发 review 取消后的真实 unknown 保留，原 Run cancelled 不冒充该调用已知 cancelled；正常退出仍核未知提示与所属进程清理。实际 OS dialog、其余管理、平台与整体 P5 资格各自核对，不从组件或单窗推导。

显式 run/report/interrupt 的 caller journal 在首次 POST 前持久保存原请求：CLI/TUI 是私人有限 `ui/recovery.json@1`，Native 的 `recovery_intents` 保留原 v2 合同，当前私人 SQLite v3 另承载完整普通 caller intents。坏文件、满槽、坏身份或无 profile-use 时零 POST；冷 submitting/accepted 只查询原命令，不换 Store/Session、不自动驱逐或重发。UI/renderer 没有文件或执行权，关闭/切换仅释放读取。维护 closed manifest v5 白名单保存上述恢复 journal、准确 Desktop v1/v2/v3 一致副本及完整普通申请 callerIntents.v1；原 closed v2/v3/v4 reader 的字段和物理路径白名单各自保持，不能将 DB3 标为旧 schema；恢复新 Store 不重标旧申请。理由与实测限制见[持久恢复申请记录](../../.agents/notes/implemented/architecture/2026-10-03-durable-caller-recovery-intents.md)。原 Session 中断事务已用准确 private proof/full ModelOutput reader关闭未派发取消 Tool 的原历史；attempted/跨Store unknown仍保阻挡，同ID原receipt零重读/写入。真实同Session SDK/PTY与sealed/CAS/unknown关联107/1307通过，取舍见[修复记录](../../.agents/notes/implemented/bug-fix/2026-10-03-interruption-settles-original-tool-history.md)。

共享 TUI 的[恢复面板](../../packages/ui/src/tui/README.md)区分原生 Ctrl+C/Ctrl+L 批次与 literal bracketed paste；前者只取消所属读取并查原申请，后者不能触发恢复或查询。原 GET 取消后的迟到结果不发布；原 POST 结果仍按原身份保存，取消读取不撤销业务效果。不新增 HTTP、执行权限或 journal 结构，输入边界与有限 macOS 资格见[恢复输入决定](../../.agents/notes/implemented/bug-fix/2026-10-06-recovery-native-controls-and-literal-paste.md)。

来源新鲜度由宿主采集真实决策输入。模型路径刷新后重新决定；Action 保留旧 attempt 后重新准备与重新授权。批准、资源许可与来源检查都不能代替最终具名事务中的取消、owner、版本和业务条件复核；FS 与 SQLite 的非原子边界不被描述为全局原子保证。

默认宿主的模式与工作区信任来自原 Store、用户主体及准确根 Session/Workspace 的持久控制事实。Native 管理接口只保存用户明确选择，按已观察 revision 执行 CAS；工作区目录与额外读取范围的身份由宿主重新计算，不能由 JSONC、Git 元数据或客户端路径替代。Session 当前模式和用户默认值分别保存；恢复后旧 Store 的控制行不获得当前派发权。原 `getSession` 只读取有限 Session 元数据，权限读取不拉取历史正文。默认每次授权携准确 mode/default/trust revision，派发事务用原 Command 主体复核；人类审批仍保留该读集，父子 AND 合并相同 kind/scope/revision，冲突读集拒绝派发，已提交的撤销不能在授权与 SQL 派发之间被忽略。在途效果按实际取消能力处理，撤销不改写此前成功事实。便携 Desktop/UI 与 CLI 控制回执保留用户原选择，未知只查原命令、不重发；组件释放不停止 Service。same_command 授权保存真实来源 Session/subject/Store/Workspace、definition/version、原 Interaction/决定版本与完整 input 或可信 command digest；当前 policy 必须继续提供该范围，最终 markDispatching 复核 grant epoch 与 mode/trust/必要条件读集。清除仅作用准确 Session，并保存原 mutation 回执；新授权也推进 epoch。默认 Shell digest 来自实际宿主环境/资产与命令，不由 Model/JSONC 提供。正式入口和平台资格仍按进度单独登记。

Interaction 只有实际发起 Session 的权威请求，父展示与回答引用同一 ID。展示根与 ancestry 来自 Store，HTTP 不接收内部接纳或自报主体。答案保存后仍须原 owner 接纳并在派发事务核对绑定；`requestInput` 的 question 只提供信息。有限原 schema 的 oneOf/anyOf 分支及准确非空白 pattern `\\S` 沿同一节点、深度与关键字预算，由 Core 校验实际 JSON 自身字段，其他正则仍拒绝；DOM/TUI 共用中立的有限原 schema 解析，无法完整保留约束时明确回退 JSON。默认问卷的闭合 object 与 const:null 只构成普通信息答案：null 由 leaf 返回取消信息，同一 Run 继续，不调用业务取消。Native 页面草稿按完整原身份保留，pending 页缺席不清理，仅准确 accepted 回执或观察到替代／终态清原键；所选 pending question 隐藏主输入并保留原主草稿，具体页面合同归[Native owner](../../apps/desktop/README.md#native-普通问题与页面草稿)。默认普通 [ask_user](../../packages/agent/src/tools/ask-user/README.md)由 leaf 解释原 ID／闭合自由对象为文案，Service 的根选择、child 排除和可信零效果事实不提供其他 Tool grant。选项标题不替代内部值，自定义输入不扩大 schema 或权限，完整答案仍沿原 interaction.answer；边界归[Interaction owner](../../packages/agent/src/storage/sqlite/interactions/README.md)。Artifact 的 Core 端口保持中立，实际内容授权、不可变发布和二进制交付分别由 leaf 与 Service/Client 负责；知道 hash 或 renderer 路径不能代替原 scope。

[完整 Model 正文](../../packages/agent/src/model-body/README.md)把 Tool summary 和原 Artifact 全文一起交给实际 Model；大请求、来源与 Auto 审核使用准确原 scope 的不可变正文和有限持久 header。Provider 前完整核实并展开，成功 Model 保存实际 inputBodyHash。最终 SQL 事务仅核 metadata/原绑定与真实执行 proof，不读取正文或调用 Provider。64KiB 路由阈值不裁剪任务或来源；Worker 有限队列和控制预留保持。Auto 专用 carrier 的 planned-parent 准入只能由具名 Store 方法提供，公开 snapshot 不生成豁免；审查是同 Loop 的一个无 Tool Model，文本自报引用不授予权限。大请求的人工回退附件需要客户端实际完整加载资格，不能把引用展示当作已经审阅全文。

steer 定位原活动 Run 的安全检查点，follow-up 保留独立命令及原前驱；已派发调用不会因新输入而改写原决策。模型输入取当前上下文选择，分别穷尽消息与结果引用的固定上界分页。合法 pending delivery 仅由原执行 owner 在准备模型请求时消费，完成游标保存在执行事实中，不依赖可裁剪通知。idle 或只读查询不创建模型请求。Rewind 核实整个执行组，原子隔离旧 pending 并保留历史；显式 include 只增加准确原来源，不重跑、不恢复旧交付。子内部结果与父 carrier 结果保持各自 Session 范围，实际模型请求记录准确 source IDs。


活动结果 include 固定原 Store/selection/targetRunId/Execution/resultRevision，accepted/result_queued 只表示等待原 checkpoint。checkpoint 与 steer 同序原子保存完整 source/message/receipt，新 publication seq 使原冻结 upper 不获得后来隐藏来源；旧已派发 Model 不改写，未派发旧计划/审批失效，取消保持零纳入。任务 wait-any可因新输入早醒，普通 operation wait仍等终态；只读目录与来源不触发执行。

Fork的新`session.create`保存原selection/upper，历史不继承Run/Execution/owner/grant。SQL出处链核creator/subject/role/status/source/parts；公开originMessage和正文原scope保持。可信omit/copy/rebuild在构造时封存，最终同事务核namespace键集/revision/raw/origin/selection并发布Session/消息/回执。`readForkRecordSources`仍是要求live source stamps的records观察，不开放一般祖先Execution/Artifact。

显式`sourceReads:'declared'`可由纯rebuild规则声明有限actual execution/ref或已封存subset，Host自动核Tool实际Model闭包、全文/媒体EOF，Fork finalSQL核原完整group静止及metadata/ref proof。当前anchor的`openForkSourceProjection`只在callback生命周期内读精确原Execution/Run/Model/媒体与完整selected aliases，不依赖后来mutable source head，也不扩普通reader或授权。Action bindings由最终SQL自动复核，Ask后drift零adapter；业务完整snapshot与point资格归各leaf。预算和实际资格见[Fork owner](../../packages/agent/src/extensions/fork/README.md)及[实施取舍](../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources.md)。派生provenance普通CAS不能清除，不能取得原计划/义务/operation执行权；原Command GET不重跑规则。

Session rename/delete 为原 root creator 的 Decimal64 控制 CAS。原命令返回保存的提交快照，不用当前标题替换旧回执。删除同事务保存整组 tombstone、真实 deletedAt、停止边界，Runtime 只通知其实际拥有对象停止。`delete_requested/stopConfirmed:false` 保留未确认与 unknown，目录隐藏不等于物理清理或撤回外部效果。第二 Runtime 删除及 HTTP 丢回复见 Agent/Client 证据；GC、Workspace 批量和完整恢复待实施。

[原始 Session 导出](../../packages/agent/src/storage/sqlite/export/README.md)通过 begin/page/text/final verify 冻结同 Worker 的 root/主体/Store、全局 cursor、data_version 与 11 个 section 完整高水位/计数。每个短只读事务复核原 manifest；可观察提交、换 Worker、缺行、范围错误或取消均不发布完成标记，不持跨请求生产事务。未知内容与 provenance 保原文本；仅实际文本列 descriptor 提供准确 byte-range，不扫描 payload 推授权。SDK 核每页完整性与全文 EOF/hash，最后 Core proof 成功才发布 records/text completion；Artifact 仅保原 scope 引用，媒体核验、数据库备份和文件原子发布另由各自 owner 负责。

Context 压缩为单选可信算法 slot，通过同一 Loop 的记录 Model Execution 保存完整输入、覆盖范围与摘要出处；提交前原上下文仍有效。后续输入使用带原 source ID 的低权限摘要，原历史、Model/Artifact 引用和 contextSelectionId 不因压缩改标。人工完成与摘要 publication 同一最终事务；自动失败保留旧选择，未变化的输入不立即无限重试。重置须由原 slot 对完整展开输入明确预检，缺少或拒绝预检保留活动点并且零 Provider。slot 的实际摘要校验、目录 fingerprint、来源新鲜度、取消与必要条件仍在发布前核对，不把结构完整当作已知模型窗口安全。HTTP/Client 只保存原受理意图，真实终态查原 Run；未知回执不重发。默认 pure 算法和实际 SDK 子场景见[Service owner](../../apps/service/README.md)。

TUI 未提交文本由可信 CLI 宿主保存到所选 profile 的 `ui/tui.json`，共享 UI 仅通过有限 draft port 读写原身份文本。独立宿主 profile-use lease 持续至最后保存与UI关闭，Service死亡不释放；短写锁由 Agent/profile-access 固定用途提供。成功受理仅清除原编辑版本，CAS冲突/格式损坏保原磁盘与本地输入，正常退出保存失败保持编辑器。`/drafts`与`/draft <id>`只读原已保存记录，恢复后的旧Store草稿不重绑、不自动发送。

[TUI 已加载文本导出](../../packages/ui/src/tui/export.ts)冻结当前原 Store/Session 与展示正文；完整正文只使用已经验证加载的内容，未读正文保预览并标明不完整，不额外读取或执行。可信 CLI 宿主从已选择 profile 推导配置目录，以0600独占创建唯一 Markdown 文件，UI 不提供路径；迟到结果不发布到新会话。

共享 TUI 主 Composer 对普通文字加一个尾 CR 的合并 native 输入，先保存原草稿再沿原 Return 处理；候选按更新后的 token 核对，待完成文件引用不发送，第一次补全后仍需另一次提交。literal bracketed paste 独立保原 CRLF/Ctrl，不触发该提交；准确目标、stale/unknown 与持久申请仍由原 controller/host 门禁拥有。实现与有限实际 Ink/导出 PTY 范围由 [TUI owner](../../packages/ui/src/tui/README.md)维护。

[显式离线备份](../../packages/agent/src/maintenance/README.md)单独取得数据单元外稳定 profile-use 排他锁。Core与Desktop原DB/实际WAL完整配对复制至本次私有scratch，SQL只打开副本；每次复制及SQL前后核原配对presence、完整proof和实体，缺失副文件保持缺失，scratch不进入发布树。SQLite候选与引用媒体完整核验后才发布ready；v2另按独立时间采集原config字节和经闭合格式验证的Desktop UI一致副本，保原草稿/创建身份，不承诺跨介质同一瞬间原子。独立凭据vault、未采集宿主私有资产和协调锁不包含，配置原文自身可能含敏感内容，保持私有权限；TUI真实未提交文本亦按v1闭合JSON采集，保原Store/Workspace/Session、Decimal64和完整文本，不重绑旧草稿。源码/leaf与完整包备份已验证；Worker在释放profile使用锁前必须严格关闭SQLite及其缓存语句，普通close不足以证明数据库文件不再变化。私有副本不放宽关闭/排他边界，也不证明非合作外部writer被阻止；恢复与平台资格仍按实施进度记录。

Native 的 `configuration_management` 通过公共 Client 固定原 Store/generation、命令与 CAS，只发一次 mutation；丢回应和无效回执只按原 ID 查询。持久 HostMutation 仅投影安全 scope/workspace/ifMatch/opaque结果，不返回秘密或内部 request digest。无 Runtime 的诊断连接只允许用户配置读取并保留错误；Browser 不增加管理权。Native 模型面板由 main 冻结观察并派生项目范围，renderer 只有安全模型事实，专门模型设置 API 服务端验证启禁/default、有效配置及原读取集，普通 JSONC 保存仍允许暂时不可路由的期望配置。Native 写入消费者已在真实两模型窗口验证旧轮次A/下一轮次B、物理回执丢失一次POST/原GET、原读取集冲突与冷读零额外Model；main固定原scope/readSet，renderer不取得内部配置权威。后续完整 Native Provider/下一次模型能力已接公共四family设置与显式空名称发现，见[Native owner](../../apps/desktop/README.md#native-provider-与下一次模型选择)。发现只证明目标列表响应，不代表远端可执行资格。

显式恢复生成新 Store，旧origin与已完成receipt保留，备份中的未完成工作不得自动执行。切换全程持同一外部排他锁，先保存原目录再发布候选；未完成journal阻止普通入口建库。核实完成/回退必须匹配观察restoreId/digest及准确目录内容/Store，不能靠路径存在猜测。已交付publication和七个强杀窗口；新 Store 准入和封存原来源现分别校验，原 Model/Artifact/压缩/child/Fork/导出完整读取及新明确 Run 已经真实恢复复验；旧来源执行和新引用发布守卫保持。离线 CLI 直接调用维护 leaf，准确 Store 和明确数据回退确认不可省略，journal 核实另需原 ID/digest/decision；不启动 Service/Provider。配置/Desktop UI采集已由真实owner及携资产的强杀窗口验证；Node独立使用锁的真实窗口已核Service强杀后仍busy、所属UI退出/Node强杀后释放、其他profile不受影响；TUI原文资产及七个强杀窗口已纳入验证；GC、引擎和平台资格继续闭合，不能据目录切换成功宣称完整恢复。[维护owner](../../packages/agent/src/maintenance/README.md)维护准确范围。

[私有UI使用锁](../../.agents/notes/implemented/architecture/2026-10-02-private-ui-profile-use-lock.md)由Node原fd持有，私有产物中的一次性Bun helper仅对继承fd取得shared flock并关闭自己的副本，不UNLOCK；不依赖Service生命周期。SQLiteclose成功后才释放，失败留锁；维护/journal拒绝不建空UI。当前macOS实际Node/Electron已验证，Linux未资格、Windows inherited-fd明确拒绝。


显式开发daemon通过Service私有有限socket交换bootstrap，业务与关闭仍用公共HTTP Client；不把native发现协议暴露为公共业务carrier。paired/daemon共用一次Store/Runtime装配，父EOF策略分别保持；目标子进程只读SQLite预检在旧实例停止前执行。实际边界、保活失败语义与平台范围归[Service owner](../../apps/service/README.md)，开发CLI惰性资产与原实例一次关闭归[CLI owner](../../apps/cli/README.md)。开发CLI run/resume与TUI的显式`--server`经私有宿主发现后固定原实例、profile与Workspace，连接失败不启动替代；共享close仅disposeNetwork，TUI独立草稿lease保持至UI退出。公共Client/UI不引入native发现依赖，正式release与全部调用者迁移仍未完成；设计依据见[私有bootstrap Note](../../.agents/notes/implemented/architecture/2026-10-02-daemon-private-bootstrap.md)。

原shutdown后的PID/start暂时uncertain仅延续既有有界只读观察，成功仍需真实dead证明；持续不明、drain_failed及超时不授替代启动、强杀或endpoint清理权。最初发现、reservation与kernel身份分类保持，公共Lifecycle Client仍只一次POST；检查窗口含末次HTTP等待而非硬实时期限。真实Job消费者及受控观察反例归[CLI owner](../../apps/cli/README.md)与上述Note。


开发 TUI 模型设置同样通过专门公共 API，固定实际 Workspace 和原读取集；UI 只得到有限 default/enabled/effort 操作及安全模型 metadata，不取得配置索引或凭据。effort 的有限 enum/null 纳入原 HostMutation marker 和幂等冲突校验；支持字段表示 compatible 适配器 wire 能力，不能推导远端模型支持。清除只影响所选 scope，保留配置 options 的既有整组覆盖语义；原 Run 冻结值不变。Native 当前有限启禁/default IPC 未因 HTTP 契约扩展而扩大。

已有根Session `job.report` 的显式冷恢复使用专门 `resumeJobReport` 和 `job.report.resume` 申请；不把读取、普通新Run resolver或adapter reconcile当作恢复。原父manifest、真实source/result、Store/subject/selection/取消与当前afterTurn授权在原子应用前复核。公开HTTP只传原report ID和新command ID，完整配置来自持久父Run及可信恢复resolver。`applyJobReport.started` 分辨本次新建与历史Run查回，只有前者进入唯一Loop；绑定资源通过实际Run及后代lease最终释放。外部Job reconcile使用下述独立受限恢复所有权与监督证据，不能通过此报告入口解除unknown执行限制。原绑定、幂等与资源释放取舍见[冷报告恢复Note](../../.agents/notes/implemented/architecture/2026-10-02-explicit-cold-job-report-recovery.md)。


显式 `job.reconcile` 在派发前封存的恢复manifest和原reference之上取得独立purpose的root OS lease；该lease不能用于普通owner写入。可信新核实授权与当前控制读集在查询前/归档时复核，原扩展/adapter/配置必须精确重建，缺失时局部拒绝。查询只追加带adapter_reconcile来源的Command证明，不改原Execution/resultRevision/旧Context引用，不调用start/observe或旧Run；pending旧delivery抑制以阻断日后隐式消费。只有准确原Job、Store、root和revision的已知结果+ended证明能解除该Job对普通owner的阻挡，其他unknown及独立Fork/Rewind门禁保持。原关联/恢复配置保留私有，公开请求和原始导出中的Command只含身份摘要；结果与证据仍按明确原作用域校验。[存储owner](../../packages/agent/src/storage/README.md)与[Runtime owner](../../packages/agent/README.md)维护实现和验证范围。

上述追加证明与历史引用取舍见[Job核实Note](../../.agents/notes/implemented/architecture/2026-10-02-append-only-job-reconciliation.md)；它与原报告冷恢复具有不同目的，不替代原报告绑定要求。


同 Store 活动根 Run 的显式 `run.resume` 使用独立目的的准备 lease 和原持久检查点，准确重建原配置后复核 generation、选择、取消与原执行集合，再转普通 owner 进入唯一 Loop。公开 HTTP 只接受原 Store/Session/Run 与申请 ID；owner generation 由服务端读取，同 ID 重用原内部 fence，主体与摘要仍在 Store 校验。已完成初始化不重放，半完成闭包拒绝；原完整 Model 输入/输出、Tool 执行和 Interaction 身份保持，终态 Run 不重开。该受限根恢复不扩大 child/runless 或未知效果的恢复资格，也不改变 Job reconcile 的追加证明边界。实现和证据归 [Runtime](../../packages/agent/README.md)、[Store](../../packages/agent/src/storage/README.md)、[Service](../../apps/service/README.md)与 [Client](../../packages/client/README.md)。

持久检查点与初始化三态的取舍见[原 Run 接续 Note](../../.agents/notes/implemented/architecture/2026-10-02-durable-run-resume-checkpoints.md)；其implemented范围限上述安全根检查点，不扩展到一般闭包或全部恢复。

原根执行组的显式 `session.recover(decision:"interrupt")` 也只接受原 Store/Session、申请 ID 与认证主体。Service 读取当前或同 ID 原持久请求的内部 generation，Core 的原 OS 锁及 Store fencing 保持唯一权威；HTTP/SDK 不接收或返回 owner lease/generation。公开 Command 查询投影与写回执一致，只保留准确原 ID 集、partial 和 Decimal64 水位。可能产生效果的调用保持 unknown，不因 applied 回执获得重放或普通 owner 资格；GET 只读。真实 Tool/Model 强杀、原 ledger、同 ID 与物理丢回执证据归[Service](../../apps/service/README.md#显式遗留执行组中断)与[Client](../../packages/client/README.md)。


宿主诊断由Service实际默认配置装配提供独立readonly source，process-service从Runtime参数拆出，通过闭合HostStatus HTTP/Client传递；不重建旧App Control/carrier。source与实际Shell资产检查共用真实校验；默认macOS可信host选择coalition/Seatbelt闭合tuple，显式POSIX仍报告group/none。诊断选择不冒称GET已执行全树验证，API注册不授授权。数据不可用仍可读安全身份，权限/信任只读当前主体的准确scope，缺权威局部unavailable。未绑定发行manifest保持production:null，未配置exporter保持禁用，不从buildId/JSONC推导。CLI状态保原Workspace信任检查，只有显式trust才独立mutation，诊断GET零业务写入；TUI保持HTTP与SSE独立状态和切换读取代次。当前scope归[Service](../../apps/service/README.md)、[Client](../../packages/client/README.md)、[CLI](../../apps/cli/README.md)与[TUI](../../packages/ui/src/tui/README.md)；正式制品资格仍由实际发布验证证明。

有限诊断与执行授权分离的理由、接口闭合成本和当前资格见[宿主诊断Note](../../.agents/notes/implemented/architecture/2026-10-02-host-diagnostics-from-assembly.md)。

Skill知识目录属于Service宿主：公共只读目录和实际Run装配共用配置ID、canonical目标、正文version/digest及能力检查。单条坏项不阻未选择它的任务，显式选择和父原继承失效必须局部拒绝，不能静默换成同名项或扩大目录。目录metadata闭合，不外泄路径/正文/凭据；完整分页按原Store/Workspace/主体/信任与完整内容revision，变更后拒绝续页而不拼混。读取不启动Provider、Run、MCP或脚本；TUI面板的读取成功不能清SSEunknown。知识目录和单Run selectedSkills不替代旧Workflow activation/inline/fork/output/verification，后者迁移状态继续按完整方案记录。

终端显示偏好由 CLI host 持有当前 profile 的 `ui/preferences.jsonc`，共享 UI 仅接收有限已确认值和单字段 CAS 保存 port。`/theme`、`/language` 不写 Service 配置、不提交业务 Command，不依赖 SSE freshness；更新呈现 context 保原 Session、草稿、审批和完整输出。原 profile shared authority 必须在读写发布时仍有效，文件由现有 configuration leaf 提供锁与原子发布；偏好原字节纳入维护备份。具体实现与失败行为由 [CLI owner](../../apps/cli/README.md#开发-tui-显示偏好) 负责。

## Skill Workflow 的执行边界

已有有条件 Workflow 使用 Agent 的[显式业务扩展](../../packages/agent/src/business/skill-workflow/README.md)。Core 只保存通用具版本 `extensionInputs` 原意图与 Command 摘要；Service 先验证支持、可信实际源、flags 与 payload，再读取凭据。初始化记录先于首次 Model；动态必要条件绑定对应 Extension 判定器，不能由全局业务 provider 错接或忽略。知识目录和 selectedSkills 不触发 activation。

完整指令和输入不塞进初始化 metadata record，activation 以原摘要绑定可信契约和原 Command。宿主冷重建后必须核同一输入，缺失或变化不能借进程内缓存获得资格。可信完整 Run 配置在 start、follow-up 和 child 路径一致保存，不为含来源正文的 child/follow-up 配置另加 1 MiB 上限；原消息、HTTP/IPC、metadata 与 Worker 队列限制分别保持。大配置仍参与完整 operation 摘要、子激活全等和冷恢复核对，没有 Skill 专用 SQL 分支。

不可变 anchor、CAS head 与 append-only attempts 由扩展 records 持有，fork 和脚本核验使用普通 operation/Execution。内部状态变化不改写原 Model sources；required 失败后的 repair 仍保留原 ceiling、最低审批与 source freshness。新尝试只能由准确原 failed proof 和实际 repair/replan carrier 创建，旧 complete/verify 的缺省始终指 attempt 1，不能指向新 head。child 的实际工具、Job 与原来源范围由可信父快照和原 opening Execution 限制，resolver 只读父 namespace 的完整投影自动进入最终 carrier/activation 事务 CAS；prompt 不提供权限。完整输出、原 result revision 与 configured verifier proof 均在最终完成条件中核对；失败/未知不自动重跑，Session fork 不复制旧 activation 权利。最低审批不能扩大原策略硬拒绝。

可信 Service 封存 versioned replan/waiver/compensation policy，JSONC/Skill/Model 不提供决定权。真实普通 question 的 request/accepted receipt 绑定原 Store、主体、Session/Run、anchor、requirement/Skill revision、head/attempt、完整 output digest 与原 verifier proof。waiver 另存 waived，原 verification 仍 failed；replan 另建 attempt。信息问题前后核实际 bound permissions/control reads，最终条件连同原决定记录一起核验。通用执行安全读取从原 Run 的持久 parent/child 闭包形成完整 revision、boolean 与准确 unconfirmed IDs；Host 只固定自身 Tool 排除项且遍历其后代，Job 不排除。实际 planned Job 的 satisfied dispatch/approval 可核自身与准确父工作，最终事务复算同一闭包；completion/waiver 与信息接纳仍要求无未清效果。普通无约束对话不因此新增全局义务。

完整人工审批 request 超过有限卡预算时，以准确原 Execution scope Artifact 交接原 input/policy/grants；卡复用既有完整附件协议。接受与最终授权核 hash、scope、完整原文和当前准确 policy，主体与原审批 binding 保持；相同正文的两次审批仍有独立 Execution 引用，不互借许可。CLI 原 work 的 runless verifier 卡从准确持久 parent Execution 闭包定位，不用当前 active Run 猜测。CLI/TUI 未知 answer 保留原答复 Command，恢复只 GET 原 ID，不能重复 POST 或改绑新会话。

手动调用目录以 `workflow=manual` 和实际 source 的 `skill_workflow_catalogue` 显式启用；原闭合知识 DTO 与 revision 保持原路径。投影与运行共用可信源编译和实际 Tool/Job/role facts，额外元数据不含指令、路径或凭据。读取不调用 Model、vault、MCP 或 Job，资格只说明当前手动空输入可用，不预订未来执行版本。Service 在提交时重新绑定实际源，不由客户端目录扩大权限。

终端把知识 `--skill` 与执行 `--activate-skill` 分开，TUI 动态名称仅从真实 compiled metadata 唯一匹配，固定命令优先。完整 `extensionInputs` 属于原 Command；idle 使用 start，active 显式激活使用原 afterRunId/contextSelection 的 follow-up。未知回执只按原 ID 查询，不重复 POST；目录、迟到回执与草稿清理始终绑定原 scope/version。具体目录与调用边界由 [Service](../../apps/service/README.md#同源-skill-知识目录)、[Client](../../packages/client/README.md)、[CLI](../../apps/cli/README.md)和 [TUI](../../packages/ui/src/tui/README.md)负责。

专用 profile `skill-workflow.jsonc` 默认关闭三项特性，纳入[维护原字节资产](../../packages/agent/src/maintenance/README.md)，不因恢复或缺文件自动启用。原 operation 等待超过有限观测窗口仍只查询原工作；没有隐藏重启器。声明补偿在原 Workspace 内契约、可信 policy 与实际 macOS confined 后端齐备时，使用独立 ordinary `skill.workflow.compensate@1`、原 accepted decision、一次 opening/operation 与 minimum:user 审批。完整原字节含二进制被封入只读副本，固定 Bun 在原 Workspace 执行，实际网络/fork/保护写拒绝；guardian 未确认仍保 unknown 和资产。compensated 不改 failed，也不替代新验证或准确 waiver。当前仅禁止子进程模式，完整恢复、正式入口和平台范围继续按[实施进度](../plans/unified-agent-refactor-v1-progress.md)闭合；取舍见[补偿记录](../../.agents/notes/implemented/architecture/2026-10-03-declared-workflow-compensation.md)。

macOS 默认宿主、显式普通 POSIX 与严格 confined 沿用原 guardian/held-root 的唯一 closing和准确 reap。默认 ProcessService 已装配宿主后端，以原 resource coalition/内核 task count/pidversion 信号另核完整 setsid/orphan 后代；普通 POSIX 只证明原组，confined 仍固定 deny-fork。最终已接受的 dispatchAuthorization 快照在原 Store 派发事务之后交给 Job.start，只供可信宿主选择执行范围，不代替 grant、控制读集或取消。完整合同与当前 arm64 实测归 [Jobs owner](../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)和[Service](../../apps/service/README.md#默认-shell-装配)。冷读取/unknown不取得旧执行能力。

## 新终端候选边界

`release:terminal` 将六个新 workspace、实际 npm 图、固定 Bun 和全部宿主资产封存在独立候选，完整 manifest 身份交给 CLIServiceArtifact 与客户端准入。安装发布 current/previous 指针，已经运行的 CLI/TUI/Service 固定原 candidate；独立 daemon 的 artifact lease 不依赖启动 CLI 存活。归档、目录持久化、卸载白名单与平台限制由[终端 owner](../../apps/cli/docs/terminal-release.md)完整维护。制品锁不取得 Profile 或业务权限；unsigned SHA 只证明完整性，真实沙箱、发布者身份及旧正式入口退役仍须原有资格。

Service 与 CLI 现在共用 [runtime-assets](../../apps/service/src/runtime-assets.ts) 的唯一完整 tree verifier。trusted launcher 的私有 pipe 只传闭合 candidate root/manifest SHA/kind；实际 Service 独立取得 shared lease、核 build/entrypoint/executable 后才将全 closure 作为默认 Files 的保护范围，Model/JSONC/HTTP 不能提供该证明。Runtime、Workspace FD、readers/stream 全部确认关闭才释放，失败保持原资源与 listener。实际 public builder→default native paired/daemon、CLI 父退出后 live busy/stop 后 free 的 1/23 资格归 [Service owner](../../apps/service/README.md)；不能只从 parent wrapper 正常存活推定 child 已保护完整资产。

## 完整申请与事件观察

普通 CLI/TUI 的原五类 Work/精确取消先在 host 的 `ui/caller-intents.json@1`，Native 则在 Node 私人 SQLite v3 中封存完整闭合请求、原 Store/Workspace/Session/subject、精确目标、规范摘要与独立草稿版本。各自 128 槽/16MiB，完整 Plan/Workflow/UTF-8/CRLF body 不裁剪、不以 draft 或 hash 替代；首次 POST 权利仅属于成功 durable prepare 的当前进程 hot intent，任何既有或冷记录都只按原 Command GET 核实，不能重授该内存权利。缺元数据、错完整 intent、坏文件或容量不足不获得补发权。applied/cancel_requested 分别表示命令受理或取消请求，不能冒充 Run/Job 完成。维护 v5 只验证结构与实际文件 proof，不代替 Service 回执、不重算业务权威或重标恢复后的原 scope。CLI 实际独立 argv/main/shared、TUI PTY 和 Native Node/Electron/main+Service 强杀/丢回复的证据各自归 [caller 决定](../../.agents/notes/implemented/architecture/2026-10-03-complete-caller-command-intents.md)，一种客户端的通过不替代另一种。

当前CLI/TUI的同一Caller文件另接四种固定普通Auth invoke，原完整身份、durable prepare、冷GET与容量合同继续适用；Native五类DTO和DB不扩展。实际Caller资产含Auth时选择closed维护v13，旧v2–v12请求grammar及物理白名单保持。认证复用既有CredentialVault/Broker与实际WorkspaceSerialLocks，效果不进新journal；当前Source/read-set用于新申请，历史只核原C/E与finalization。完整边界归[MCP认证](mcp-authentication.md)及[维护owner](../../packages/agent/src/maintenance/README.md)，此处不把Auth saved、connection ready和Tool许可合成一个结果。

原五类Native caller的DB3合同继续保留在当前DB5中；人类答案使用独立 `answer_intents`，不扩展五类DTO。首次POST前FULL提交完整原scope/subject/Interaction/请求与canonical SHA，冷Main只有原GET；accurate interaction.answer applied/answer_saved、原target/decision revision+1/subject/requestSHA才能确认。旧附件证明和授权不随journal恢复。维护closed v7只接准确DB5的整份一致SQLite，独立行验证和新Store恢复保旧字节/身份，旧v2–v6白名单不扩大，coverage.profileComplete:false/vault排除保持。实现、实际双Main与离线资产证据归[原答案决定](../../.agents/notes/implemented/architecture/2026-10-04-original-human-answer-intent-assets.md)、[Desktop](../../apps/desktop/README.md)和[维护owner](../../packages/agent/src/maintenance/README.md#原人类答案请求的独立离线资产)。

MCP 选择另用 CLI host 私有 `ui/mcp-selection-intents.json@1`，普通五类 caller/答案/Files 格式不扩展。首次 POST 仅由短锁内冲突/容量/完整身份核验和原子发布后的 hot prepare 授权；保存或冷列表均只恢复未知意图。原 GET 核 subject、Store、Command/request、准确 Execution 与原 HostMutation，不依赖当前目录或物理 Workspace；fresh 写入仍核当前 scope/read-set。维护 closed v8 仅为实际存在的新文件扩展准确资产字段与物理白名单，旧 v2–v7 原合同保留；独立 Agent codec 验完整字节和内部身份，不恢复热权利或重绑恢复后的新 Store。真实冷 Host、键盘与 PTY、离线字节/cold Node 的证据分别归[CLI owner](../../apps/cli/README.md#tui-mcp-目录与配置选择)和[维护 owner](../../packages/agent/src/maintenance/README.md#mcp-选择意图的独立离线资产)，不相互替代平台或完整管理资格。

会话日志由 Store 的原 mutation transaction 写入有限私有 metadata；status/time 属于发生时，cursor 决定顺序。既有 ChangeEvent payload/public SSE shape 保持，未来或坏 envelope 不泄露私有 wrapper。只读页固定 actual upper，精确 root creator/Session/Store 与 Decimal64 保留边界，最多 200/512KiB；无 payload、配置、凭据或 owner。Service 绑定 trusted source，Native/Browser 各核原身份，Web 仅按需读并保 stale。Model 导航只核实际原 input/ref 的绑定，仍需原 typed reader 独立确认，不产生 grant。实现与分层真实证据归[Core 日志](../../packages/agent/src/storage/sqlite/session-logs.README.md)、[Service](../../apps/service/README.md#只读会话运行日志)、[Client](../../packages/client/README.md#固定上界的会话日志读取)和[Web](../../apps/web/README.md#按需-runtime-logs)。

Files完整原字节原语由独立[checkpoint leaf](../../packages/agent/src/business/file-checkpoints/README.md)捕获原Tool/Model/Run选择、完整preimage和实际postimage，当前Store观察与原Source保持各自身份。Files rebuild封存完整业务时间线与有限来源，selected aliases决定目标资格，未selected后像只作连续性证明；v2 restore/effect ledger记录真实新inode或confirmed missing，旧v1只读不回填。准确failed Job与完整空ledger共同证明的零效果失败保为no-op证据，pending/partial/unknown继续拒绝；任何一次性批准都不复制。默认两层Fork、code恢复后更早点、A→B、same-S selector及Web闭合只读都有实际资格。独立Action的人类Ask与通用[group/context/record/projection最终SQL](../../packages/agent/src/storage/README.md)不承诺跨文件/两leg原子；CLI/TUI/Native三种范围与组合unknown持久caller仍按已确认设计实施。

通用 Action 的 prepare 固定原完整 contextRevision 与 scoped records/missing/list；用户 Ask 后只能重新核当前 quiescence，不替换原上下文和读集。final dispatch SQL 先核实际 root/descendants safety 再核原 context，carrier 在 dispatching/running/unknown 持续封闭新效果。adapter 的合法写入消耗原 absence 后不再将其当最终提交前条件，child 则独立核当前权限/来源/必要条件。真实竞态及独立 unseen extension 证明分别归 [Store owner](../../packages/agent/src/storage/README.md)和[取舍](../../.agents/notes/implemented/architecture/2026-10-03-guarded-actions-pin-original-context-and-group.md)，不推导所有外部 IO 可原子化。

runless 后代只沿有限真实 Execution/Command 链继承原 provenance；准确封存的 reviewer 可观察其 planned target，但没有原 Action collector/guard 或 target 派发权。guarded 原 pin 只排除本 Action 已完成且无额外工作的纯用途 reviewer 私有上下文；完整组安全与最后审批证明仍核全部实际工作。新增或漂移的 reviewer 工作使排除失效，不能以后来静止状态洗掉原上下文。完整条件与实际负例由上述 Store owner 维护。

大 reviewer 输出的批准事实来自原完整 ModelOutput，Core 在同一 captured descriptor 验 EOF 后发布原 Model scope 的有限不可变答案凭据；final SQL 只核完整 descriptor 摘要、该凭据登记及原正文／carrier scope 的有限 metadata。私有 head 不进入公共 DTO，preview 不作为全文答案；冷只读证明不重新读 graph 或启动 reviewer。原 purpose/身份/空 tools/独立 Ask 与额外工作闭包仍核，跨包边界与实际负例归[输出 owner](../../packages/agent/src/model-output/README.md)及[Store owner](../../packages/agent/src/storage/README.md)。

## MCP 原 metadata 的跨包读取

MCP adapter 同步 frozen metadata getter与原可执行 catalogue共享同一代次。真实connect/refresh Tool或Action保存准确原SDK Tool到自身publisher scope immutable chunks/manifest/pages/root，Worker只保有限pointer；Query封存原record/generation/indexDigest，不连接、发现、读vault或派发。publisher已保存结果与source value全等，原connection command/parent/inputDigest和新source key分别绑定，Artifact再核原scope/hash/size。不是以sourceRecordKey单独证明writer，也不重构私有bootstrap Job正文。

公共Client闭合32KiB Query并一次manifest后逐块核完整EOF/size/SHA、fatal UTF-8/JSON/schema，完整SDK字段及省略保留；currentStore负责admission，旧originStore负责Artifactmetadata，恢复不重标来源或恢复grant。TUI/CLI只接该公共Query/reader，以原Session/Workspace/read generation+ownAbort隔离迟到，页面/长字段不裁成complete前缀，metadata查看零业务POST/cancel。当前两Query使用现有整组安全观察器作主体准入，其8192记录上限保留；不承诺任意长执行组均可读取。owner与有限实际证据见[MCP](../../packages/agent/src/mcp/README.md)、[Client](../../packages/client/README.md)、[TUI](../../packages/ui/src/tui/README.md)和[CLI](../../apps/cli/README.md#tui-mcp-目录与配置选择)。

## MCP 原连接申请与当前 live

显式连接仍是普通 `builtin.mcp/mcp.connect@1` 与实际独立connection Job，不因配置available、Command accepted或历史ready获得执行许可。有限 `mcp.connection@1` 沿当前Store/Session/subject的整组安全准入，只核准确原Action、operation Job与parent；原8192 records和Worker/result上限保持。Action kind=job、namespaced definition与实际bare Job definition分别核版本、inputDigest、origin/ref/root-work。16KiB Display只投有限身份、phase、原ready和当前live/currentGeneration/created，warm复用保原Job，holder unavailable投null generation而保原ready，detached失败不宣称零效果。

UI只持可选connection port和原读取代次；Host用公开完整Workspace目录、实际canonical identity和原完整observed核新申请。独立 `ui/mcp-connection-intents.json@1` 只在durable prepare成功的热调用允许首次POST；冷或既有intent只原GET，Store+Session+Server未知冲突不借新key绕过。subject/Store不等在HTTP前拒绝，关闭/切scope只abort所属reader，晚到结果归原intent但不覆盖后来选择。maintenance v9保原资产bytes/身份/phase，旧v8闭合格式不扩，不恢复热权限。实际Query、Host、A→B原GET前拒绝、普通审批与源码外TUI范围见[Agent](../../packages/agent/src/mcp/README.md#原连接申请的有限事实)、[CLI](../../apps/cli/README.md#tui-mcp-显式连接与原申请)、[UI](../../packages/ui/src/tui/README.md#mcp-显式连接与原申请)和[maintenance](../../packages/agent/src/maintenance/README.md#mcp-连接申请的独立离线资产)。

## 未提交普通 Action 与同 owner 重调度

准确原Action的最终结果提交失败时，Command.applied只保原受理事实。Runtime每个accepted普通Command前由Store短事务观察原receipt主Execution仍planned/dispatching/running的真实身份，停止本Session普通派发并保accepted请求；重复同instance owner与后台onActivity不绕过。该观察不恢复owner、补result或重派原effect，不把合法detached Job当未提交Action，也不改变已持久terminal outcome_unknown的原恢复边界。原GET和owned关闭继续，合同与[真实故障测试](../../packages/agent/test/isolated/execution/action-result-boundary.test.ts)由[Store owner](../../packages/agent/src/storage/README.md#未提交普通-action-的串行边界)维护。

已登记根 Session 的合法 hot detached operation 持有原 owner 时，空命令列表继续保留有限 intake轮询；peer新接纳的同根Session Action仍由原 pump核上述守卫，再返回实际子操作引用。资源等待只延迟 Job启动，不借 intake推进放宽permit、generation或cold恢复。实现、确定性空轮询/peer顺序与本机实际Shell资格由[Runtime owner](../../packages/agent/README.md)维护，跨 child Session未据此取得新资格。

第八/九/十一轮与首次有限诊断曾在原30s用例期限内超时，需精确监督本次owned child退出。两条真实fixture改为直接await同一个原五秒waiter、再断言实际wait_timeout后通过，正常SQLite回复与owned close均确认；Runtime/SQLite生产、业务断言和期限保持。这个对照限定在两条fixture的pending Promise匹配入口，纯timer和Worker对照未复现，底层原因仍未知。真实失败、监督清理边界和复验保在总体进度。

## 当前发布与资格工具

根 `agent/tui/prod:tui` 固定完整新 Terminal，`desktop` 固定完整 Native，`server` 显式复用新默认 daemon/Web。八 workspace 的 build/typecheck 与统一默认计划共用同一发现源；root 仅有限脚本安全测试及新公开制品场景。静态守卫检查 root/workspace scripts、递归 aliases、CI run 与实际 import 闭包，包含四个标准/Native CLI/TUI entry；计算模块的 fixture 仍记 pending，不把静态检查当运行资格。

Terminal 与 Native 分别固定真实 Bun/Node SQLite，包内 selection 在 Store/maintenance/Worker 开库前生效；损坏选定资产不回退开发库。Windows ordinary Workspace 配置与 private Profile/协调/数据库角色分开，既有 ACL 不自动修复；实际 native Windows 仍待 CI 证据。三平台 workflow 保原检查名称、固定 Bun/action、源 head 与 clean-source 约束。平台诊断、bounded soak 和源码外制品通过均不等于完整 Shell/confinement、正式 soak 或发布者认证；formal verifier 保持拒绝缺资格。当前边界见[release control](release-control.md)、[Terminal owner](../../apps/cli/docs/terminal-release.md)与[Native owner](../../apps/desktop/docs/native-release.md)。


Native Provider/Model 的完整设置消费者由 Main 冻结原观察，热秘密只传一次公共 Provider POST；原非秘密申请先落 Desktop DB6，再允许本次提交，冷记录只显式原 GET。Service/Core composite marker 固定原 readSet/operation/身份，vault保存与JSONC发布分别保留已知/未知结果；stored-unpublished 的原 revoke handle 只向认证SDK开放，renderer不获该authority。新模型disabled，其他连接保留，完整目录不按512项裁切。输入区每Session的下一次model/页面临时effort经真实HTTP原命令进入冻结root快照和实际wire，active steer保持文本语义、child自选preset。Profile无三项raw MCP文件时DB6离线资产用专属manifest14，旧版本grammar不扩大，详见[Service owner](../../apps/service/README.md#native-provider-与下一次模型绑定)、[维护 owner](../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。macOS默认OSvault/受控loopback真实Native窗口已验，尚不外推生产远端、MCP窗口或其他平台。


Native MCP 的 renderer通过固定IPC提交有限参数，Main固定真实观察、完整Source read-set和原Store/subject/Session/Workspace身份。来源、认证、连接与Tool授权分别核实；原非秘密申请在第一次POST前FULL保存，冷/foreign只读不重发，迟到GET不能把已确认终态降级。Profile无三项raw MCP文件时DB7使用manifest15，独立codec和原字节上界归[maintenance](../../packages/agent/src/maintenance/README.md#desktop-db7-与-manifest-v15)；实际任一raw文件存在则优先使用[manifest16](../../packages/agent/src/maintenance/README.md#profile-mcp-配置资产与-manifest-v16)，保原声明、决定、引用与UI资产，恢复后的来源准入仍核当前Store和物理scope。UI保存的意图不成为Core或Host权威。可信loopback/公开证书测试装配须在制品构建前固定并入摘要，不进入普通配置/环境，不放宽默认浏览器、Vault或权限。
