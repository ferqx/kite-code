# 本机 Agent Service

Windows daemon 在本进程首次完整准入后，把原 live artifact owner 交给 Service 装配；[同进程借用](src/windows-paired-artifact.ts)只接受 WeakMap 登记的原对象及准确 proof/entry/executable/build，关闭开始、伪造、复制或错根均拒绝，未归还借用时原 owner 不能关闭。每个新进程仍独立取得 SH、原文件 pin、完整库存与全字节 SHA，startup JSON 不传借用权。Runtime verifier 和归档可复用同一原 pin，但每次仍核全部内容与对象，关闭未知保原资源。普通 JS 依赖按[构建声明](bundled-dependencies.ts)内联；原跨进程和恢复合同保持，理由归[闭包成本决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。

`GET /v1/sessions/{id}/inputs` 的有限 response request 联合包括 steer、follow-up 和 Core 已接受的 `result.include`；只读投影保原 selection／execution／result revision／target Run。原 Store reader 同时供 Runtime checkpoint消费，不能过滤掉 result include 来迁就客户端显示；接口 schema 负责正确投影，TUI 只把文本输入显示为队列并正常推进所有 cursor。原写路由、权限与 Core 应用顺序不变，[真实混合页回归](test/isolated/pending-inputs.test.ts)核完整原申请与零重执行。

## 默认装配与业务规则归属

默认装配注册 [Agent 会话命名扩展](../../packages/agent/src/business/session-title/index.ts)，通过通用 Run 生命周期 Action 和已有内部子 Agent 生成标题。Service 只提供当前 Runtime 读取／rename 端口与按原轮选定模型 ID 的当前配置创建的无工具绑定；模型调用继续由 Agent 统一执行。标题规则与 CAS 归扩展，公共 HTTP schema 与客户端执行 DTO 保持。[本机 HTTP 回归](test/isolated/session-title.test.ts)核所选模型、参数、目录名称／消息隔离和读取零额外调用，不代表真实付费 Provider 或安装制品资格。

原完整 TUI 旅程补齐的默认配置包括可信 explore／plan／code／review 子任务角色、前台 Task 的真实结果交付、内建计划完成指导、MCP 发现／资源工具和 Provider 配置向导。业务行为由 Agent 对应模块实现；Service 仅选择当前身份、配置、公共响应和装配。Model 失败／重试响应只公开实际失败前驱的有限字段，不公开完整 decisionSource 或凭据。

已取得准入的 MCP 连接可把准确 Store／Session／Run／connection generation 作为只读 Model 来源；资源列表／读取仍使用原 Tool 和目录收据的严格绑定。Run 内认证通过普通 nested Action 与真实父 Tool 绑定，沿原 Actor、root work、权限及取消收束；没有直接绕过 Core 的 OAuth 执行入口。默认压缩可在同一用户任务的已结算 Tool 边界发生，不要求额外用户轮次；user-role 来源附件仍不冒充用户输入。

[默认配置](src/configuration.ts)读取实际 Profile、Workspace、当前身份和注册定义，装配唯一 Agent Runtime；固定内建能力效果和 Workflow 审批投影由[Agent 权限模块](../../packages/agent/src/permissions/README.md)统一提供。正式 Run、恢复绑定与只读 Skill 目录共用工具版本校验和内建注册集合，各自的来源捕获、选中范围与资源释放时刻仍独立。Service 不维护第二份 Task、Shell、Files、Skills 或 Web 效果规则。

[Web 装配](src/web-fetch-configuration.ts)从准确注册版本取得 Agent 的固定分类，仅组合原可信网络 policy、`off` 硬拒绝、`builtin.web:1` revision 和 snapshot；默认 Tool 登记一次采用该元数据，原后置覆盖 loop 与 Workflow 的 Web 效果特例已删除。同名外部扩展不因此取得内建分类。[Task 装配](src/task-configuration.ts)只提供原 extension、角色／工具 snapshot 和选择校验，无正式消费者的权限 `describe` 副出口已退役；实际权限仍沿 Agent 公共分类，原默认 Task 和独立 carrier 授权保持。

HTTP 身份和 schema 准入、当前持久权限与来源读取、真实 transport 可用性属于宿主。业务执行、权限决定、Workflow 能力投影和 Runtime 准入属于 Agent。Source 编译前后复核、完整文件消费证明和不同持久摘要格式有独立合同，保留原检查；本轮精简理由见[实施决定](../../.agents/notes/implemented/simplification/2026-10-11-service-agent-default-composition.md)。

Run 绑定与配置管理共用纯[模型参数校验](src/model-options.ts)，后者不再反向依赖默认装配；公开 `/configuration` 仍导出原 `parseModelPreset`。Files 默认捕获、Fork、Browser、Native 和离线恢复测试共用同一[本地 Provider](test/fixtures/file-checkpoint-provider.ts)，保持实际 SDK／HTTP、四步工具执行和各场景独立断言；该有限夹具声明自己的模型窗口，自动压缩仍由压缩测试单独验证。同 owner 算法复用与独立证明的取舍见[新架构精简决定](../../.agents/notes/implemented/simplification/2026-10-16-owner-local-algorithm-reuse.md)。

项目来源的专用答案 schema、可信 observer 和有限原决定 Query 已实施；当前证明与历史读取边界见[Source owner](#项目来源决定的有限历史事实)，本片取舍与已完成的有限验收见[Source 决定](../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

Session 管理提供 `POST /v1/sessions/{id}/fork`、`/rename`、`/delete`，输入为有限 closed schema，主体由可信宿主填入。Fork 核原 Store/selection/稳定配对边界，只复制历史与出处；未登记 namespace 规则默认 omit，可信注册可选择 copy/rebuild。有限 `namespaceReport` 与原命令 receipt 一致，`omittedExtensionState` 如实表示省略，HTTP 不接受内部准备计划。重命名和删除按 `ifRevision` 控制 CAS，原 command ID 查回原 Session 快照。删除原子保存整组 tombstone 和停止边界，关闭迟到创建/派发，异步通知真实 owner 收尾；回执不声称资源已停止，准确旧 ID 历史继续可读。历史物理清理和完整恢复资格尚未闭合。

空间批量入口为 `POST /v1/workspaces/{id}/remove`，闭合 body 只含 `expectedStoreId/commandId`，主体由宿主填入；`GET /v1/workspaces/{id}/removals/{commandId}?storeId=...` 只查原受理回执。一次事务核全部根的原创建主体并保存整组 tombstone、停止边界和不可变 receipt，拒绝部分先删后失败。原 receipt 的 Store／subject／Workspace／Command／规范请求 SHA 和计数保持；`stopConfirmed:false` 不代表资源终止。当前目录隐藏与新工作封锁不物理删除历史，Browser 不获得写入入口。实现与真实证据见 [Store owner](../../packages/agent/src/storage/sqlite/session-management/README.md)。

Fork 的 view、history 和 Context 通过 readonly `getMessageOrigin` 核 sealed SQL 出处，公开有限 `originMessage` 原 Store/Session/Message/Run。原 Model output BodyRef/Execution scope 不变，正文从原 Session 的具名 GET 完整读取；未来 Part 保预览并标 `unsupported`，不能猜测解释或自动调用模型。每次 GET 的 `snapshotCursor` 是该次一致读水位，正文/hash/原请求身份保持不可变。[真实 HTTP/SDK 管理](../../tests/isolated/unified-agent/client-session-management.test.ts)和[17MiB Fork](../../tests/isolated/unified-agent/client-fork.test.ts)记录相应资格。

恢复后，[Core sealed SQL](../../packages/agent/src/storage/sqlite/fork-operations.ts)的 `getMessageOrigin` 另返回原 Message 所绑定 Command 或 Run 的固定 `originStoreId`；Service 用它投影普通用户／Model／Tool 的原 `originMessage.storeId`，不以当前准入 Store 替换。原大 Model 的私有 output head 仍可提供原 Store，head 不进入公共 DTO；缺少原 Store 证明的普通记录保预览且不补出处。该只读 SQL 不取来源 Run 后来的状态，不取得控制或重放资格。公开完整 snapshot 仍使用当前 Store，Core 独立核原 Model／Run／Command 及每段 Artifact 出处。[投影回归](test/message-response.test.ts)核当前读取身份与原出处各自保持；[安装版问答恢复](../desktop/test/isolated/native-restored-questionnaire-bundle.test.ts)核源会话和 Fork 的完整已回答记录，准确范围归[Native owner](../desktop/README.md#原轮次阅读聚合与问答回执)。此前[完整正文窗口](../desktop/test/isolated/native-restored-output-bundle.test.ts)及其输入范围归[正文 owner](../desktop/README.md#恢复后封存-model-正文)，本轮原 17MiB HTTP／SDK Fork 复验通过。仅 Core 私有 Store 返回值增加可选出处；HTTP schema 和持久格式保持，其他恢复组合仍按原计划核对。

Session 原始记录导出使用可选 `session_exports` 与四个有限 GET：`/v1/sessions/{id}/export/manifest`、`/records`、`/text`、`/verify`。每次请求核原 Store、宿主主体、root/真实 child 关系和冻结 manifest，Cookie gateway 仅提供这四个明确映射。11 个 section 是目的明确的原始导出投影，排除 owner/锁/宿主配置/凭据；未知 Part、extension JSON 与 Fork provenance 保留原文本，超过 64KiB 的实际文本列通过原行/字段分块，不从 payload hash 生成授权。每页最多 200 行并有局部字节预算，无累计截断；最终短只读事务重新核完整读集。回复保持 no-store/nosniff，读取不发模型、恢复或业务写入。[实际 HTTP/Cookie 导出](../../tests/isolated/unified-agent/session-export.test.ts)2/50 验证 210 条、9MiB 未来原文、17MiB 原 scope 媒体、物理截断、外部提交和冷只读。完成标记仅证明原始记录/文本，媒体仍须具名原 scope reader；它不构成数据库或跨介质备份。

Context 提供 `POST /v1/sessions/{id}/context/compress` 和 `/context/compression/reset`。人工压缩携原 Store、Command、selection 和可选完整 `focus`；说明没有 4096 字符算法门禁，HTTP 仍遵守宿主统一 JSON 传输预算并明确拒绝超限，不能裁剪后提交。重置另携原 `expectedCompressionId`（无活动点为 null）。202 只表示原命令受理，最终结果读取该命令的实际 Run；丢回复只查询原 ID。SelectedContext 的有限 `compression` 记录保留原 Store/Session、实际 Model Execution、覆盖范围、旧点引用及算法快照，原历史和实际模型正文保持可读。

默认装配的 `createSummaryCompressor` 从公开 `/configuration` 导出，纯描述摘要请求；所有实际模型调用与发布仍由同一 Core 执行。宿主可明确选择一个可信 `compressor`，启动时绑定其 `prepare/shouldCompress/validateSummary/validateExpanded`，后来改对象或 JSONC 字段不能替换回调。多个候选冲突明确拒绝。`shouldCompress` 缺省不自动触发；`validateSummary` 可基于宿主准确模型事实拒绝真实输出，`validateExpanded` 必须明确返回 true 才允许清除活动点。默认算法没有准确 tokenizer/window 事实，不把字节量当 token，不宣称目标窗口资格。摘要在后续请求中按带准确 source ID 的低权限用户数据呈现，不获得 Tool 或审批权。

[默认 compatible SDK 压缩](test/isolated/compression-configuration.test.ts)与[自动分支](test/isolated/compression-automatic-configuration.test.ts)两个完整文件在本机 Windows x64/Bun 1.4.2 为 6 项／134 条断言通过，包含五个实际 SDK 场景与一个纯准备资格场景：45KiB 自定义说明完整进入实际请求、真实摘要与覆盖来源、后续 Model 精确采用摘要、可信摘要拒绝后的旧输入继续、两种 reset 预检、压缩/reset 物理丢 202 回复只查原命令且各一次 POST、冷只读零 Provider，以及单任务已结算 Tool 历史可压缩。Profile 由真实 Store 创建私有 ACL，不以 POSIX mkdir mode 代替 Windows 权限。该资格使用临时 profile、固定本地模型与临时凭据 backend，不代替真实模型压缩质量、目标窗口计数、正式调用者或完整平台资格。

默认 Run binding 按原选中模型元数据启用自动压缩。用户模型条目兼容 `contextWindow`，同时提供时优先采用 `contextWindowTokens`；选中模型未声明窗口时，在该 Run 快照封存前明确写入 256K（262144 token）默认值。输入达到总窗口 75% 时触发，默认阈值 196608，1M 窗口阈值 786432。可选 JSONC `compression.thresholdTokens` 为正安全整数，随配置快照冻结并覆盖比例。触发与摘要后验证采用同一阈值；系统／可信来源／实际工具目录本身已超阈值，或缩小后仍达阈值时，以 `compression_insufficient_space` 结束原 Run。自动摘要按相同本地估算验证真实缩小，非缩小返回 `compression_not_reducing`；这两种错误保原历史、终止原执行，不走已知临时摘要失败的降级重试。摘要指令只保真正未完成的用户要求，不将未读参考文件变成义务。自定义可信 compressor 和手动选择保原合同。边界与真实 Core 停机分别见[窗口回归](test/isolated/compression-window.test.ts)、[原 Run 停机](test/isolated/compression-window-runtime.test.ts)；[用户窗口接线](test/isolated/user-window-compression.test.ts)覆盖真实本地 SDK 的 1M 别名、256K 缺省与自定义阈值；[长任务](test/isolated/long-running-compression.test.ts)继续覆盖完整 Files 和临时摘要失败。

公共 `modelRetry` 接受无本地上限的 `maxAttempts:null` 和任意实际正 attempt；旧有限上界仍可读取。Service 不替 Core 决定重试次数，生成 Client/OpenAPI 与 TUI 显示同源更新。主／子 Run 的五次相同工具失败规则由唯一 Loop 负责，来源数量不再由装配层另设 256 门槛。权限、格式、namespace、真实来源 read-set 与未知效果守卫保持。

实际 Model 输入读取入口为 `GET /v1/sessions/{id}/model-inputs?storeId=...` 和 `GET /v1/sessions/{id}/executions/{executionId}/model-input?storeId=...`。主体只由 Service 宿主提供，闭合 query 不接受 path、Artifact ref/hash 或 renderer 主体。目录需要准确 Session，每页最多 200 项的固定上界 keyset 可以取得第 201 次之后的调用；正文使用 Core 的原请求读取，不捕获现在来源、读取现在配置或调用 Model。大正文由 [model-input-response.ts](src/model-input-response.ts) 在原内容核实后分为 64KiB wire chunks，带完整 size/SHA，保留 no-store；Client 成功 EOF 核实后才发布全文，不以便利 JSON 大小静默裁剪。

Gateway 将 `model_inputs` 作为有限只读 capability，固定原 Store 和 Session/Execution，读取前后核实原 admitted identity，再传输同份公开 snapshot；Native token、profile 路径、内部 Artifact 标识和 Provider 授权不进入响应。Web 在用户确认后读取敏感内容；成功回执与未确认的已准备请求分别呈现。每个新请求封存实际 adapter/provider family、模型与已支持 settings、实际扩展/工具版本、来源顺序与摘要，并记录最后派发使用的授权与控制 revision。opaque adapter、未记录或未来格式明确 unavailable，不以当前配置替代。[实际 Core→Native→Gateway→Browser](../../tests/isolated/unified-agent/model-input.test.ts) 1/27 证明超过 17MiB 的原输入、后续 Rewind/新来源后的原历史、错误 scope/Store/query 拒绝与冷重开只读零 Model/来源捕获/重放；[真实默认 SDK 元数据](test/isolated/model-metadata.test.ts) 1/18 证明实际 wire settings、权限修改与后来配置变化不改写原请求。完整 Runtime logs 和正式客户端迁移仍按进度记录。

`model_outputs` 提供 `GET /v1/sessions/{id}/executions/{executionId}/model-output?storeId=...` 及对应 Cookie-only Browser GET。公开消息只携有限 `outputBody` 摘要，不携私有 linked-segment head。Core 按原 Store/Session/主体/Execution 的一致快照展开已持久前缀或完整正文，核实链、字节和 hash；成功结果有完整 Tool calls，未完成前缀永远 `complete=false` 且不派发截断参数。全文以同一 64KiB response writer 传输，Client 核完 EOF、wire/body hash 和目标才发布。纯读取不消费结果、不创建 Model、命令或取消。[实际 17MiB Core/Native/Cookie](../../tests/isolated/unified-agent/model-output.test.ts) 1/39 覆盖下一 Model 的完整正文与原来源、历史 Rewind、冷读取及公共投影不泄私有引用；输入、输出、Client 和 production metadata 组合 12 tests/173 assertions 通过。

公开 Interaction 使用 `GET /v1/sessions/{id}/interactions?storeId=&afterId=&limit=&state=&origin=`、`GET /v1/sessions/{id}/interactions/{interactionId}?storeId=&origin=` 与 `POST /v1/sessions/{id}/interactions/{interactionId}/answer`。`interactions` capability 表示这些路由；列表按 ID keyset 分页，每页最多 100 张卡。root 和 child 视图投影同一持久请求、原 Store/Session/Run/Execution/attempt、展示根与祖先链、定义/参数/策略绑定、必要引用、请求/答案及 revision，不公开主体权威、owner token 或私有决策来源。child 卡只能通过其原展示根回答，主体由宿主填入。闭合答案输入携带原 expected Store、稳定 command ID、expected revision 和有界答案。202 `answer_saved` 回执只确认持久保存，内部接纳决定和派发仍由 Core 负责；没有公开 accept-decision 入口。取消后可将迟到答案保留为 cancelled 历史，不执行工作。

[Interaction 定向测试](../../tests/isolated/unified-agent/client-interactions.test.ts)验证真实 HTTP/SDK 投影、身份/revision 冲突、child 展示/root 回答、先取消后迟到答案、问题 schema，以及实际固定 Model 审批 → Tool 提问 → 回答 → 普通 Loop 完成。OpenAPI 保留二进制 Artifact 路由，并将现有 events 路由标为 `text/event-stream`。这个协议切片不改变默认宿主权限策略。

只读 list／get 可明确选择 `origin=all` 读取实际保存的恢复记录，默认 `current` 保当前原卡观察；`storeId` 仍必须匹配当前 Service 准入，返回原 origin 身份。列表保原分页与 snapshotCursor，来源或 presentation Session 必须准确，不隐式遍历 Fork／Include 祖先。原回答、受理与派发守卫不变，恢复历史不获得执行权；私有主体／source 仍由响应 schema 排除。[真实恢复回归](../../tests/isolated/unified-agent/client-interactions.test.ts)核问题、计划、child 审批、取消和完整附件首次／冷读及旧卡回答拒绝。OpenAPI、生成类型与 validators 同步这项可选 query，不新增路由或 capability。

这个私有应用通过认证 HTTP JSON 和 SSE 暴露公开 Agent Runtime，负责 HTTP schema、投影、loopback 认证、bootstrap 与关闭。执行仍归 `@kite-ai/agent`；handler 不运行第二个 Loop，也不使用旧 carrier。

[`@kite-ai/service/development-web`](src/development-web.ts) 的 `startDevelopmentWeb` 是显式的只读浏览器宿主：接收已准入的 Native Client 与可选固定可信 asset Map，在独立 `127.0.0.1:0` listener 提供页面、短期 HttpOnly/SameSite Cookie 和有限 `/browser/v1` GET。它复制并封存宿主提供的有限 HTML/JS/CSS 资产，并加入本 Service 构建内的 `/openapi.json`、`/api-docs` 静态文档，页面 identity 同时绑定资产完整 SHA-256 与原 instance/build/Store；调用者后来修改原 Map 不会更换原页面。它核对实际 Host/loopback peer/Origin 和页面 identity，转发空间、会话、view、history 与按需诊断；workspace 路径、Run 配置、view 中的 execution result 和 Native bearer 不进入这些投影。未知路径、query、写入、SSE、配置、凭据及任何 Authorization header 在转发前拒绝。

Browser 历史轮次使用固定 `GET /browser/v1/sessions/:sessionId/runs/:runId`。只有原 Service 实际支持 sessions 和 commands 才宣告 `runs`；沿原读取 owner 和 Cookie／页面 identity，先核真实 Session 与当前 Store，再取准确 Run／Session，返回前复核原准入。响应经唯一 `BrowserRunFactsSchema` 仅保与 View 相同的安全 Run 字段，不含配置／token；原恢复 originStoreId 保留。拒绝额外 query、POST 和全局 Run 路径，不取得 Model 正文或执行权。[原真实配对文件](test/isolated/development-web.test.ts)保全部原断言，另核202个真实 Run、有限 View 外原 Run、错 Session 和读取零 Store／Model／Job 效果；正式 Web 整轮 UI 的读取与复制归 Web owner。

Cookie 建立、续期、删除及 gateway close 只改变本浏览器的访问状态，不提交 Store 命令、模型请求或执行取消。关闭时先封住自身入口、清除 Cookie 并中断自身读取，等待已受理 GET 和返回正文流的真实 EOF 或 reader cancel 清理，再停止自身 listener。重复 `close()` 返回首次缓存的同一 completion；读取尚未清理时不能提前完成。它不关闭共享 Native Client 或其 Service。HTTP schema 仍由 [schema owner](src/http/schema/index.ts)定义，BrowserClient 与 [新 Web 调用者](../web/README.md)通过生成 DTO 消费。[真实配对测试](test/isolated/development-web.test.ts)覆盖认证隔离、读投影、零写入及浏览器关闭后原 Model 工作继续。当前最小默认页面不是正式 Web 功能切换；页面与完整观察能力按实施进度验证。

每个有限浏览器 GET 通过共享 Native Client 的只读 `verifyConnection` 核实原身份，身份复核不重置该 Client 或中止其他读取。目录、历史、Context 与 Job 输出可以同时读取；每个请求仍保留自己的取消信号和原 page/instance/build/Store 约束。

诊断 GET 开放 `/browser/v1/sessions/{id}/context`、`/browser/v1/sessions/{id}/executions/{executionId}/output`、`/browser/v1/sessions/{id}/model-inputs` 与 `/browser/v1/sessions/{id}/executions/{executionId}/model-input`。Context query 不接收 Store，绑定原准入后核对准确 Session/selection；output 先核原 Execution 属于该 Session，再按固定高水位分页，发布前复核原 Service 身份。Model input 目录与完整正文使用上文的原请求读取边界，不是当前 Context 或完整 Runtime logs。纯读取不消费结果、重放 Job 或启动 Model。诊断响应可包含其实际允许的正文，有限 view 的省略字段不限制这些具名端口。页面 CSP 禁止动态代码生成，Client 校验规则由唯一 HTTP schema 在构建时静态生成。

`startService` 在 `127.0.0.1` 随机端口监听，返回包含 endpoint、token 和 Service/profile/API 身份的私有 bootstrap。Native 调用者在 Authorization header 传 token，Host 与 Origin 分别核对。写入要求原 `expectedStoreId` 与稳定 `commandId`，主体身份由宿主提供。请求限制在本地生效，HTTP/SSE 取消不取消已接纳工作。

SSE 从单一扫描游标读取持久变更。未来、过期或格式错误的游标在 ready 前拒绝；ready 和 heartbeat 无 ID。过滤后的 checkpoint 只有在其一致页面中此前所有可见变更都已发送后才推进。`Change.objectId` 是有限不透明通知标识，可以是普通对象 ID、带点号的扩展 namespace 与带斜线或 Unicode 的 record key；上界385字符来自 Store 的128字符 namespace、一个分隔符及256字符 key，不作为路径或执行权使用。Store、Session、Command 等普通 ID 保持原约束。唯一 [schema](src/http/schema/index.ts) 与生成 Client 校验器/OpenAPI 同步；[真实扩展事件回归](test/isolated/extension-changes.test.ts)核原 SQLite 事件逐条通过 HTTP/Client、无 reset、完整原 ACK 和零额外执行。订阅缓存有界，超限只关闭该订阅，不改变执行。关闭先结束 stream，再 drain Runtime 和 Store，最后停止 HTTP。

当前接口支持 Workspace/Session 创建与读取、`run.start`、准确 `command.cancel`、通用 `extension.invoke` Action、扩展目录与 Query、Command/Run/Execution 读取、History 和变更 stream。Model Tool 和 Action child operation 使用与直接宿主相同的 Runtime 路径。Action 是 root Job Execution，不创建 Model Run。Query 返回通用 PublicView，使用 Session 范围只读投影，不创建 Execution；可选 JSON `input` 缺省为 `{}`，编码后最多 8192 字符。生产默认装配、完整管理能力和发行资格继续由 V1.3 计划记录。

### 多主子会话流与读取压力

[隔离压力测试](test/isolated/multi-session-stream-load.test.ts)及[进程装配](test/isolated/multi-session-stream-load.fixture.ts)使用真实 Service／SQLite Worker／Runtime、原 Task 扩展和本机 compatible SSE Provider。每个根先真实派发3个 Task，再保持自己的第二次 Model 流；子 Model 同时持续输出超过64KiB的已持久正文。分别核 Provider 增量、实际 Model dispatching 与活动 Run，不能以排队记录或 Provider 控制器个数冒充实际并发。

| 隔离矩阵 | 核对范围 |
| --- | --- |
| 默认4个Model槽 | 4个实际父流、12个排队child；准确根取消后对应排队child没有向Provider派发 |
| 可信Host显式16槽 | 4个实际父流＋12个实际child流，并行正文读取与取消 |
| 可信Host显式32槽 | 8个实际父流＋24个实际child流，追加30秒持续读取压力 |

16／32槽只由可信测试装配提供，生产默认Model并发仍为4，没有新增JSONC、环境变量或HTTP调额入口。HTTP正文／SSE中断只释放读取，测试确认真实Model继续；显式 `command.cancel` 沿原attached子树收束，detached保持独立；准确child停止不停止兄弟或其他根。最终核原Run不再活动、所有carrier成功或预期取消、Provider活动流为零及所属Service正常退出。

原32槽压力曾使正文GET返回503 `artifact_busy`，并使Model发布失败；Native 4主／12子也实际重现子Model失败。[Artifact owner](../../packages/agent/src/artifacts/README.md)现在用原8个活动槽、有界可取消队列和发布保留进展处理竞争，不通过重执行Model隐藏失败。SSE仍沿原有界订阅实现，未建立额外执行流。

2026-10-15在macOS arm64／Bun1.4.2对当时工作树执行上述测试，最终3项／165断言通过。32槽持续阶段30.312秒完成234次完整正文GET，最大正文221724字节，吞吐7.72次／秒；整个32槽阶段共306次完整GET、51次主动取消、7次SSE准入及90665次change回调，意外读取失败为零。GET P50／P95为227.82／1261.68ms，健康GET P95为12.58ms，服务事件循环最大延迟70.88ms；这些是端到端测量，没有拆分Worker排队或SQL时间。16槽阶段正文GET P95为47.15ms；生产默认4槽仍单独核饱和排队。此前同负载一轮GET P95为1118.15ms、事件循环最大21.46ms，保留波动而不以较快一轮代替最终测量。

最终轮次在同一Service进程采集以下分类，MB按1000000字节换算；quiescent之前另用公共View枚举32个Session／32个Run／46个Model，准确终态和全部读取／SSE排空后再静置一秒，无强制GC。

| 阶段 | RSS MB | heapUsed MB | external MB | ArrayBuffer字节 | 数值FD |
| --- | ---: | ---: | ---: | ---: | ---: |
| warmup | 424.97 | 50.30 | 44.58 | 20456016 | 80 |
| 中段 | 598.33 | 212.27 | 170.86 | 112940702 | 62 |
| 尾段 | 600.60 | 64.17 | 38.96 | 5126022 | 62 |
| 排空后 | 660.47 | 40.00 | 15.97 | 194 | 72 |

heap／external／ArrayBuffer明显回落，但RSS仍较高，不能仅据此判定allocator归因或长期无泄漏。最后32个并发公共View验证会建立连接，一秒静置不证明连接池已过idle期限；FD不作为私有Artifact队列的直接计数。完整正文重建与最终结果结算仍有整块分配，wire分块不是请求总内存上限。窗口切换、DOM与renderer heap资格归[Native owner](../desktop/README.md#native-当前会话环境信息与子详情)，本机loopback负载不证明远端模型吞吐或其他平台。

[Shell混合压力](test/isolated/multi-session-shell-load.test.ts)沿[共享脚本与宿主配置](test/isolated/multi-session-shell-load.shared.ts)补充真实外部执行：4根各派发3子，每个根／子经默认 `shell.launch` 创建一个attached Shell，再保持实际Model SSE。每个有限脚本包含256KiB双流突发、每200ms持续stdout／stderr、每tick约10ms有界CPU工作和一个真实 `/bin/sleep` 后代；90秒硬截止及显式finish防止测试无限运行。测试使用实际macOS host coalition监督与guardian资产，分别核公共Execution、原输出覆盖证明、脚本ledger和实际PID；不以Tool文字、受控Job adapter或逻辑终态代替OS退出。

默认Model／process各4时，实际4个Shell与4个Model运行、12个Shell请求排队，准确根停止撤销所属运行／排队效果且不派发已取消工作。可信测试Host各16时，实际16个Model和16个Shell重叠至少30秒，同时反复完整读取Model正文、固定H输出、取消GET和SSE，再准确停止一根子树和另一个child，其余根／兄弟继续。测试专属配额不进入普通配置或启动协议。

该默认4档发现子Model已结束而attached Shell尚未收束时，Task过早提交成功触发原 `child_execution_unsettled`，随后carrier遗留running。修复归[Task owner](../../packages/agent/src/extensions/task/README.md)：原owner／Store／carrier范围内的短只读快照与同事务cursor驱动等待，不等待detached；最终Store完成门禁和持久取消事实保持。旧实现定向超时、新实现自然收束／取消／旧cursor唤醒／close回归及真实默认档均通过，不靠扩大timeout掩盖未结算。

2026-10-15在相同macOS arm64／Bun1.4.2工作树执行真实Shell两档，最终2项／539断言通过。可信16档重叠30.345秒，Shell实际生成9408512字节、累计实际CPU28.563秒；完整UTF-8／字节／SHA核对一致，无丢失区间。性能包含实际输出持久化和进程竞争：

| 可信16档读取 | 次数 | P50 ms | P95 ms |
| --- | ---: | ---: | ---: |
| Model完整正文GET | 176 | 83.06 | 169.57 |
| Job完整固定H输出GET | 368 | 7.25 | 17.80 |
| 健康GET | 88 | — | 7.09 |

另有88次主动GET中断、4次SSE准入和33984次change回调，意外读取失败为零；最终16个Session／16个Run／35个Model均为准确终态、Provider活动流为零，全部Job具监督结束证明，观察到的脚本／后代PID全部消失，所属Service退出码0。停止、自然收束、完整输出核验及一秒quiet合计2.964秒，不单独称为drain耗时。

同一Shell压力Service进程的RSS由warmup 990.17MB至quiet 1057.18MB，heapUsed由中尾段约175–179MB回落至113.18MB，external至86.89MB、ArrayBuffer至34.91MB；数值FD由98经稳态90降至41，事件循环最大延迟71.75ms。此处warmup在实际并发负载已启动后采样，不是空载Service基线；主线程heap／external／ArrayBuffer不是完整进程内存的互斥分项。无强制GC，以上有限窗口不能证明长期无泄漏或把剩余RSS归因于allocator；真实Shell资格限定本机macOS，纯Model的32档证据不能替代32个Shell的实际执行。这是当时独立Service负载的历史实测，不改写为后续优化结果；2026-10-16启动文件分块校验与POSIX Artifact缓冲区优化后的完整角色／同负载前后测量由[Native owner](../desktop/README.md#内存缓冲区优化与完整进程对照)维护，RSS、高水位和联合当前footprint分别报告。

当前认证 Native server identity 返回宿主实际 `subjectId`，Command POST/GET 投影返回实际持久 `subjectId/requestDigest`；不公开请求正文、owner 或内部 lease。摘要仍由 Store 对原闭合请求的 canonical JSON 生成，完整正文和 extensionInputs 保留，不把 command ID/expected Store 加入请求摘要。生成 DTO 的凭证字段为可选，调用者缺字段时必须明确 unknown，不能借旧无凭证 DTO 判断本地记录已受理。[真实完整请求凭证测试](test/isolated/caller-command-proof.test.ts)1 项/51 断言核五种普通申请、实际主体、SDK canonical 摘要和重复原 GET 零新 Run/Provider；实际停止仍独立观察 Execution 终态。

`@kite-ai/service/paired` 提供 `launchPairedService`。调用者启动前通过只读 `@kite-ai/agent/profile` API 选定 profile，并传入选定 entrypoint、instance/build 身份、API major 和必要 capabilities。launcher 发送一行私有 startup JSON（最多 64 KiB），保持 stdin 作为独立父进程存活通道，并读取一行 bootstrap JSON（最多 16 KiB）。凭据和 token 不进入 argv、URL 或继承的模型凭据环境变量。Client 准入将 bootstrap 与认证 HTTP 身份和启动前选择逐项比较，不从响应推导预期 profile；启动失败只清理本次建立的 child。

可信 Native main 可显式提供中立 `spawnChild` port，用 Node 的进程/stream 能力启动已选定的 Bun 制品；省略时保留 Bun 宿主实现。port 不改变 bootstrap、准入、父存活或所属关闭协议，也不增加默认 PATH/源码回退。Electron main 只持有自己启动的 PID 和 handle；[paired 测试](test/isolated/paired.test.ts)及 Native 实际窗口证据分别证明 launcher 与 Node 调用者的边界。

显式 Desktop 开发宿主监听 Service 源码，构建新的独立开发 bundle，并沿同一 paired 关闭／实际退出与新 SHA／build 准入替换进程。第三方依赖随版本打包，workspace 保外部 source 解析及原运行资产；开发版本不成为正式完整制品证明。UI 整页重新 attach 原 Store，不自动重发工作；编译失败保持旧服务，未知关闭和回执阻止继续替换。此行为归[Desktop 开发 owner](../desktop/README.md#开发热更新与服务重载)，Service 公共 API、Core 生命周期和正式 caller 合同保持。

Windows 且明确传入 `runtimeProtection` 时，Bun默认 [paired parent admission](src/windows-paired-artifact.ts)在spawn前取得所有proof roots的SH、manifest与全文件原HANDLE pin，再执行原 `verifyRuntimeProtection`。Native proof包含outer/Terminal inner及outer空目录。Electron Node由可信 `retainWindowsArtifact` 装配端口借用同Main已独立取得的原生owner；不导入Bun FFI，不从startup JSON/配置接收端口，借用未归还阻止Main关闭，原child退出兑现后才归还。实际 [Service 装配](src/process-service.ts)始终另取自己的SH/全文件pin并完整核验，父不能代持子进程。启动只加候选固定 `--no-env-file`、`--no-install`、`--config=<路径>`、`--tsconfig-override=<路径>`；可选config值必须等号绑定，防止Bun误把TOML当入口而返回0。完整内容验证的dev/ino用BigInt保NTFS精确64位身份，Windows canonical逐项用原生realpath，single-link、完整SHA/库存和原对象检查保持。Main借用与Windows实际Node EOF清理取舍归[原对象决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)，平台资格仍归[Native owner](../desktop/docs/native-release.md#windows-managed-native-当前实现)。

2026-10-17实际Windows的[完整paired回归](test/isolated/paired.test.ts)6项/53断言通过，核默认Bun路径的API/能力拒绝、真实Store失败的有界诊断与显式修复后重试、双child网络断连/父EOF区分及原资源释放。损坏Store夹具先新建真实private profile，不用POSIX mode代证Windows ACL；不会修复既有对象权限。这组默认宿主结果与Native装配端口、实际整包及完整平台资格分别核对。

parent pin 与 SH 保持至原 `child.exited` 实际结算；spawn 没有产生 child 时才独立清理。返回的 `exited` 同时反映原退出事实与严格父资源关闭，关闭失败以 `PairedServiceError.code = 'paired_artifact_close_unknown'` 保留错误和未闭 owner，不将 terminate、stdout EOF 或关闭请求当退出／释放证明。文件 pin 先于 lease 关闭，Windows lease 在附件完整关闭后才由原 CloseHandle 释放 region；详细权限与失败重试边界归[平台 owner](../../packages/agent/src/platform/README.md#制品使用权)。POSIX／无 proof 的原配对命令、准入与关闭期限保持。

[Terminal runtime metadata](src/runtime-assets.ts)仅在明确 Windows pin／删除端口调用时加载 artifact-access；paired Windows helper 也在该分支动态加载，纯 Node／Electron POSIX 的 metadata 读取不 eager 导入 `bun:ffi`。这不提供 Windows Node/Electron native 使用权，也不宣称 Windows Native、Daemon、GC、PTY、跨代码切换或全资源退出已完成；源码与 mock 邻接仍须由原生 Windows 完整用户链验收。

`readTerminalRuntimeBundleContent`／`readNativeRuntimeBundleContent` 在 Node/Electron 完整核内容、target、摘要及闭合库存，不授 Windows 使用权；正式 default verifier 保原 native pin／权限及 genuine removal 合同。Main 在父 verifier 已持完整原文件的范围内加载固定 addon，再取得自己的独立权限并完整复核，Service 继续使用 default verifier。`@kite-ai/service/windows-native-bootstrap` 的[私有交接 leaf](src/windows-native-bootstrap.ts)只提供固定 C→Bun／Bun→Main 证书，核原过程 HANDLE、FILETIME、kernel pipe PID；不新增业务 HTTP、第二执行 Loop或授权来源。5秒操作与取消后5秒内原 OVERLAPPED 终止确认分别计，timeout/Cancel不作关闭证明，未知强持原 owner。

[Terminal](src/runtime-assets.ts)与[Native](src/native-runtime-assets.ts)完整制品核验共用同步[文件 SHA leaf](src/asset-file-hash.ts)。普通文件先通过原大小／模式／路径／nlink 检查：不超过 64 KiB 的文件保留原 `readFileSync` 完整 SHA；较大文件逐块读至 EOF，每次完整核验按需分配并复用一个 1 MiB scratch buffer，避免大资产整份分配。manifest 原字节摘要、完整目录／链接／inode、SQLite 及两层身份守卫继续执行。Main 初次、取得使用锁后的复核与 Service 独立准入仍各自核完整内容；没有增加对绕过使用锁的同用户写者的原子读取或绝对内存上限保证。[原完整制品测试](test/isolated/native-runtime-assets.test.ts)在 Bun 和实际 Node 核多块／短尾、两层末字节同大小篡改拒绝和恢复后原 digest；启动耗时与完整默认结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

[process-service.ts](src/process-service.ts) 的 `assembleProcessService(startup, { configure?, beforeResourceClose? })` 只装配显式选定的 profile、配置、原 Store/Artifact、唯一 Runtime 和 HTTP listener，并返回原 Service handle；它不监听父存活、不写 bootstrap、不建立另一执行管理器。传入的 startup 经闭合 schema 和选定 profile identity 校验，首次可信配置与最终资源回调在装配开始时固定。`main.ts` 复用此装配，继续负责原单行私有 startup/bootstrap、父 EOF、HTTP 关闭后父管道退出及未确认清理时保活。`main.ts` 是显式生产进程入口，import 不启动 Service。默认宿主在每个新 Run 解析新范围配置，不隐式选择模型、发现付费凭据或回退 Provider。测试和产品装配可通过 `runServiceProcess` 显式注入。Store 打开失败时，进程仍可提供安全认证 server 诊断并返回 `dataAvailability: unavailable`，业务入口返回 `503 data_unavailable`；不会用空数据替换损坏的 Store。

Worker 构造同步失败时，[公共 SQLite 入口](../../packages/agent/src/sqlite.ts)归还已取得的 Profile 使用锁，装配继续保留上述安全 unavailable 诊断。[共用装配整例](test/isolated/process-service.test.ts)核诊断 HTTP 仍接受读取时，同一 Profile 的公开维护备份实际成功，随后恢复真实 Worker 冷读原 Store／View／cursor且零 Model；失败构造不产生可用于线程退出资格的 Worker。

HTTP/SSE 断连和网络释放不会关闭父进程存活 pipe。父 EOF 或 launch handle 的幂等 close 只 drain 自己的 Service：拒绝新工作，drain 期间保留取消/读取，关闭 SSE，取消并 drain 所属 Runtime，关闭 Worker、释放锁，再停止 HTTP 并退出。优雅退出失败时，有界关闭期限只能强杀本次启动的 child。bootstrap stdout 不承载日志或业务 RPC。生产 stderr 只写公开错误码；launcher 最多保留 16 KiB，只暴露解析后的有界诊断码，丢弃非结构化内容以免转发秘密。

[startup-diagnostic](src/startup-diagnostic.ts)复用原有界前缀／报告格式的闭合投影，当前只从实际 Store 打开失败生成 `data_unavailable/opening_store`。普通 `data_unavailable` stderr 分类保持，另有不含正文的有限诊断帧；私有 launcher 在原16KiB保留上界内只接受320字符以内的准确闭合帧，拒绝未知 code、stage、字段和旧迁移分类，不转发 stderr、原 Error 或 bootstrap。诊断不改变安全 HTTP 的 unavailable 行为、准入或 child 清理；失败后 `PairedServiceError.startupDiagnostic` 与正常 handle 的只读诊断 getter 均重建同一小对象。`@kite-ai/service/paired` 导出类型与报告 formatter，未增加业务 HTTP 或新的公开入口。报告保 `kite.startup-diagnostic.v1` 形状，未知格式号为 null，固定提示只允许解决条件后明确重试。保存路径／对话框／独占新文件写入归[Native owner](../desktop/README.md#原启动诊断保存)。

[诊断 codec](test/startup-diagnostic.test.ts)核未知字段／正文／秘密拒绝与固定报告；原[配对测试](test/isolated/paired.test.ts)增真实默认坏 Store、正式 Native 的 `file_recovery` 准入失败、诊断交接、原文件保持及外部修复后的显式新启动，保原配对／双进程／过大帧／安全 unavailable 断言；原[启动帧](test/isolated/startup-frame.test.ts)与[共用装配](test/isolated/process-service.test.ts)仍分别核帧拒绝与清理所有权。新基线不执行旧数据迁移，不以泛化 Store 错误补造损坏或权限细分类；实际本机结果见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动诊断保存与明确重试)。

验证入口：`bun test apps/service/test/isolated/`、`bun run --cwd apps/service typecheck`。测试绑定真实 loopback listener，通过实际 Worker 打开临时 SQLite profile。HTTP schema 是生成 Client 类型与 OpenAPI 的唯一来源；修改 schema owner 后重新生成，不手改生成文件。

双 Service 测试共享同一 profile 和 Session。受控 Model 或权限 barrier 保持 live owner，另一 Service 接纳工作或取消；外部效果 ledger 核对每个 Tool Execution 只执行一次。切换订阅和延迟消费 replay 将断连与执行分开验证。跨宿主取消必须到达原 live AbortSignal；owner Service 关闭后，已接纳工作应在存活 Service 上推进。

这些测试输出实测 HTTP 接纳往返、Worker/SQL 合并读取往返、gate 释放到观察终态，以及 SSE ready 消费/断连耗时，没有分别测量 Worker 排队、SQL 执行或 commit 延迟。barrier 场景证明等待中的 owner，不证明进程冻结、SIGKILL 恢复、长期吞吐或 T113 性能资格。

paired 测试使用真实 Bun child、固定 Model、显式外部效果 ledger 和文件 barrier，验证兼容拒绝时启动写入与业务写入的区别、HTTP 身份、本地 stdout 边界/日志过滤、断连后的执行、一个 child EOF 时另一个 child 继续自身工作、Session owner 交接及重开零重放。POSIX profile-use 锁释放直接通过原生 flock 探测，不代表 Windows 锁资格。合作 fixture 在效果前报告已知取消；意外 adapter 异常仍遵循 Agent `outcome_unknown` 恢复边界，本生命周期测试不声明任意被中断的外部效果都可安全重跑。

执行输出使用 `GET /v1/executions/:id/output`，只调用公开 Runtime 读取 API。`afterSeq` 缺省 `0`，可选 `upperSeq` 固定快照上界；`limit` 为最多 200 的规范正十进制数。序号参数为规范无符号十进制字符串，受 SQLite 有符号 64-bit 范围约束。未来游标拒绝；保留输出和显式丢失区间保留原序号范围。clipped/coalesced 丢失区间无法取得准确字节数时返回 `droppedBytes: null`。读取不派发工作、不追加变更。

有限 P3 Job fixture 是独立构建的公开 Extension，使用无害外部 start/end ledger 和受控 adapter barrier。定向 HTTP 测试覆盖普通 Tool 创建 Job、无 Model Run 的直接 Action、attached/detached 取消、准确 HTTP Command 取消、活动 Action `operations.cancel(OperationRef)`、本地 Service close、进程槽、真实 Workspace OS 锁、不可用资源后端，以及持久输出 keyset/前缀 gap。adapter 终态事件明确确认监督结束；仅观察 EOF 不能证明真实外部进程已停止。测试共用 UnifiedExecution 和真实 SQLite Worker，没有第二个 Service 执行 Loop 或专用 Job RPC。

定向 Job suite 通过 8 项真实 HTTP 测试、77 条断言。直接启动 Action 到达自己的终态回执时，其 detached Job 仍可运行；原 Service 保持 owner，在已确认 Job 终态和交付收尾后，排队的 peer 工作继续推进。这暴露并验证了存储对普通 child Tool（父成功前须收尾）和独立监督 Job 的区别。原生 Shell 进程组、进程死亡/核实和发行/平台资格不属于这些固定 adapter 证据。

通用命令入口还接纳准确 `run.cancel`、`execution.cancel` 与 `session.cancel`，将显式目标和原 expected Store 传给对应公开 Runtime 方法，由宿主填主体并返回持久控制回执；不会替 Execution 请求选择当前活动 Run。draining 期间四种取消仍可用。跨 Service 测试证明：取消普通 Tool 后其 Run 可继续下一 Model Step，detached sibling 仍运行；明确 Run 取消保留 detached 后台工作；`session.cancel` 的 `includeBackground: true` 停止选中旧工作，并阻止已取消旧 Tool 接纳未来 child。后续明确新用户工作仍可用。拒绝的主体/Store 控制不创建命令或持久变更。


默认装配通过 `@kite-ai/service/configuration` 导出 `createDefaultProcessConfiguration({profile,hostConfiguration?,credentialBackend?,userConfigurationPath?})`。[用户配置源](src/user-configuration.ts)默认只读写 `~/.kite-code/kite-code.jsonc`，完整移除 Profile `config.jsonc` 的运行配置定位、创建和回退。`userConfigurationPath` 仅供可信嵌入宿主和自有测试夹具指定文件，不接受 HTTP、renderer 或 startup JSON 的路径输入。项目 `kite-agent.jsonc` 继续提供工具和扩展；默认 resolver 剔除其 `models/modelId/provider/model`。可信显式 startup 装配和 command 的准确模型选择仍受原验证。坏 JSONC 或不可用凭据仅拒绝相关 Run，bootstrap、History、Query 和取消保持可用；禁用、未知或不支持模型不回退其他 route。宿主追加 Extension 必须保留工厂返回的全局 registrations。

用户配置父目录加入默认 Files 的读写保护、宿主 Shell 和 Workflow verifier 的 protected roots；即使 Workspace 包含用户目录，也不能经普通模型工具读取配置明文或修改配置。用户设置 API 仍按独立读取集与原意图发布。

默认装配只创建一个用户配置适配器，配置管理与 Skills 目录复用该实例。Provider 保存按本批新增名称一次读取原格式和分配稳定路由，不为每个模型重复读取文件；目标字节 ETag、完整 read-set、凭据存储与最终发布检查保持原顺序。用户文件路径只由[纯路径函数](src/user-configuration-path.ts) `userConfigurationPath(home)` 构造，默认用户源明确传入宿主 homedir，测试必须传入自有 HOME。跨 workspace 的 HOME、路径函数和配对子进程环境通过相对导入 Service 所属的[单一测试辅助](test/fixtures/user-configuration-fixture.ts)提供；源码外 Node 窗口 driver 接收调用方已经算好的同一路径，不引入 Service 测试包。测试辅助不进入产品装配或发行构建。直接指定文件的测试仍显式注入 `userConfigurationPath`，避免测试读取开发者的真实用户配置。

用户配置源将现有 `provider.<alias>.models/type/protocol/baseURL/apiKey`、`model`（紧凑或嵌套 default route）、`disabledModels` 投影成 `{id,provider,providerName,protocol?,model,baseURL,credentialRef?,enabled?,options?}`。route ID 由原 alias/name 稳定生成，展示沿用 alias，协议 family 由显式 type 或已知 family 确定；自定义 alias 缺少 type 时使用 compatible。缺文件无内置模型目录。受支持的 provider effort、modelKwargs 的 temperature/topP/maxTokens/maxOutputTokens 与模型 metadata 参与 options；模型设置修改按准确字节 ETag 和完整 read-set CAS 转回原文件格式，保留注释、原模型 metadata、其他字段和未改 key。显式 `protocol` 支持 `chat-completions`／`responses`，缺省沿用 Chat Completions，Responses 仅允许 openai／compatible；模型名称和 URL 不选择协议，失败不跨协议回退。提供商设置读取返回有效协议，保存意图保留协议并通过原 CAS 写回 alias；连接身份区分 Responses 与 Chat Completions，既有 Chat Completions 连接 ID 保持。同一文件也支持可信宿主使用中立 models/modelId 形状，不引入另一配置路径。支持的运行 options 为 temperature（0–2）、topP（0–1）、maxOutputTokens（整数 1–1,000,000）和支持该 wire 的 reasoningEffort 闭集；配置可编码不表示远端模型可用。活动 Run 冻结已选路由与 options，后续 Run 重读。

模型凭据使用惰性 OS 后端 `service:kite-agent/accountNamespace:user-models`，与用户配置同为跨 Profile 用户级。已有 inline apiKey 仅由该私有源解析成瞬时 key，公开 DTO 与 Run snapshot 只含 opaque reference；读取列表不解析 key 或访问 vault。替换 key 时才保存 OS 引用并移除该 provider 的旧明文，不自动重写其他凭据。MCP 保持原 `profile-<profileAccessKey>` namespace。临时后端只可由可信宿主显式注入，不成为生产缺省；真实 OS 后端及平台资格单独验证。

5 项配置集成测试启动真实 paired Bun Service 和本机 fake compatible stream 端点，验证真实 route/options 优先级、跨文件变更的旧 stream 绑定与不可变持久 SQLite 快照、坏/禁用/未知/不支持配置零 fallback、显式临时凭据的隐私与丢失、下一配置无效时取消原 stream，以及真实注册的同名 Tool 按 kind 拒绝。没有调用付费 Provider 或读取旧用户数据。


配置管理与 Run 解析共用上述用户源和模型 vault。认证 `GET /v1/config/user?storeId=...` 与 workspace 通用配置读取返回准确文件 ETag、脱敏归一化 raw/effective、支持配置 snapshot 与有限错误；项目 raw 可保留历史模型字段，但它们不进入 effective 模型。未知字段与不支持 options 显示占位符，坏 JSONC 保留原字节和 invalid_jsonc。Workspace 路径只来自持久 file URI，请求不能提供路径。

`PATCH /v1/config/{user|workspace}` 继续使用原 command/Store/ETag 和有限 set/remove 操作。用户支持 modelId/models/tools/skills/mcp，项目仅支持非模型项；项目模型 patch 返回 model_settings_user_scope_required。项目 repair 同样拒绝 models/modelId/provider/model/disabledModels/modelOptions 字段，并在取得文件锁、创建备份或发布文件前返回该错误；非模型项的显式修复保持可用。用户模型编辑由私有适配器转回同一用户文件，保留无关注释和未知字段。旧 ETag/冲突 ID 返回 409，不隐式重试。坏 JSONC 不能 patch；显式 repair 仍在原短锁内备份准确坏字节、重核 ETag 后原子发布，备份路径与内容不经 HTTP 返回。

`POST /v1/credentials` 接收 `{commandId,expectedStoreId,secret}`，回执只返回 opaque credential reference 与 persistence。`POST /v1/credentials/{opaqueRef}/revoke` 接收 command/Store 身份，阻止 vault 后续解析。原生后端错误局部失败，没有明文配置 fallback；临时引用随显式注入的后端/进程丢失可用性。revoke 不声明能撤回已解析凭据或已派发请求。

每次管理 mutation 使用 Store 的有限 `host_mutation` journal，与 Session 命令和执行权限分开。当前 Store、宿主主体、kind、准确 scope 和 request digest 必须匹配，同 ID 请求才返回原终态回执。pending 重复请求返回 `mutation_incomplete`，不重复效果。digest 为 canonical semantic body 的 HMAC-SHA256，使用协调目录内生成的私有 profile key，并由短 OS 锁、原子发布和 owner/private-file 检查保护。凭据或配置值不进入 Store 审计 API，只有 digest 与闭合安全 metadata。`GET /v1/host-mutations/{id}?storeId=...` 以调用者原 Store 读取宿主主体的回执；重复参数、隐藏主体与路径参数被闭合 query 拒绝。公开投影保留持久原 `originStoreId`、scope/workspaceId/ifMatch，receipt 只含 ETag 或 opaqueRef/persistence/有限错误，不返回 digest、secret 或任意内部 safeRequest。原 origin 不替换为当前 Store。文件/vault 效果与 SQLite journal 完成是不同事务；接纳/效果之后崩溃可能留下 pending 或 unknown，绝不自动重放。本切片不声明跨介质事务发布或自动恢复。

5 项管理集成测试使用真实 paired Service、SQLite/HTTP、临时配置文件、本机 compatible stream 端点和显式临时 vault，覆盖跨进程原回执、ETag/Store 冲突、注释/未知字段保留、明确坏文件 repair、opaque 凭据回执、真实 Run 查找/撤销，以及受控 pending credential barrier 下零重复效果与其他主体零接管。既有 5 项默认装配测试另覆盖旧 Run 不可变和配置失败隔离。Native Client 的有限 `configuration_management` 端口另验证原意图复制、原 Store 查询、物理已提交 PATCH 断线/坏回执后唯一原 GET、冷读取与零任务执行；Browser 不获得管理写权。普通 JSONC patch 可以保存不可路由的期望配置，并在后续 Run 明确拒绝，不能充当 Settings 默认模型业务约束的完整验证。OS 后端发行资格与完整 W12 客户端管理仍未完成。


W09 二进制内容使用 `GET /v1/sessions/{id}/artifacts/{refId}?storeId=&scopeKind=&scopeId=`。宿主填主体，仅通过 `Runtime.readArtifact` 读取；原 Store、Session、引用和准确 session/execution/message scope 始终是访问依据。额外 path/hash/subject query 拒绝，hash 或文件名不授予访问。响应包含已核实完整字节、header 中实际 media type/size/hash、`Content-Disposition: attachment`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。scope 错误、缺引用或 Store 不符局部失败，不关闭 Service；GET 不执行工作、不推进 SSE 游标。

默认进程在打开 SQLite 后明确创建宿主 Artifact store，将中立 port 注入 Runtime；Runtime 在 Store 之前关闭该 port。Windows x64 已有原 HANDLE 的发布及完整读取源码，实际运行资格见[Artifact owner](../../packages/agent/src/artifacts/README.md)；不支持的平台在实际调用时明确 `artifact_platform_unsupported`，其他 Profile 权威失败不吞掉，也不补造 Artifact capability。Query 使用认证宿主主体核实范围引用，不接受 HTTP 自报 subject。

2 项实际集成测试通过 paired child 中的 Core Tool 发布无害字节，验证准确 binary SDK 下载、原 scope、错误 Store/Session/scope、path/hash 注入拒绝、认证、重复读取零效果以及活动 Run/event cursor 不变。另一个真实进行中 GET 在实际 Artifact store 的受控 reader barrier 被取消，原 Model 仍活动；其他 Service 主体拒绝。测试只用临时文件和 SQLite Worker，不读用户内容。维护 GC 和平台发行资格仍未完成。


普通 CLI／TUI／Desktop 的进程宿主以可信 `ordinaryHostTools` 装配日常能力：根 Run 默认选中 `ask_user`、六个 Workspace `files.*` 工具及 `web_fetch`；实际宿主提供 Shell 后端资产时再选中 `shell.execute/launch/read/wait/stop`。缺少后端不会冒充 Shell 可用，也不妨碍仅使用其他能力的对话；显式请求不可用 Shell 仍失败关闭。工具选择不授予权限，实际调用继续检查 Workspace trust、三种权限策略和审批。直接嵌入 `createDefaultProcessConfiguration` 的自定义宿主保持原有限默认，只缺省选入 `ask_user`，自行声明其他工具。

默认全局登记普通 [ask_user leaf](../../packages/agent/src/tools/ask-user/README.md)，根 Run 缺省选择 `ask_user@1`。Run 和只读 Skill catalogue 使用同一 [configuration-defaults.ts](src/configuration-defaults.ts) 及实际宿主默认集合；JSONC 按原 merge-by-id 以 enabled:false 或 remove:true 关闭后续选择，`tools:[]` 不删除默认项。实际 Extension 定义进入版本核对和 selected tool snapshot，未知版本、非空 options 明确拒绝。活动 Run 保留原定义、请求与快照，后来禁用不改绑原卡。[普通进程宿主回归](test/isolated/configuration.test.ts)从只有 Model 的新配置启动，核实际 Provider 工具声明、真实 Workspace 文件内容进入后续请求、无额外审批或项目配置写入，以及后续禁用／移除生效。

该能力只提供信息：准确 builtin.ask-user 的可信 host facts 使用零效果数组与 safeRead，仍核原模式、Workspace trust、allowed identity 和 hardAllowed；请求批准/Auto/Full 都不为提问先发工具审批。Planning 未批准前可提问，Workflow 投影三类外部效果均为 none，答案不产生 permission grant。child 无论继承默认工具或显式角色选择，都从实际 ToolSet 排除 ask_user，实际 capability 同时缺失；compatible SDK 强发该调用在 Model 输出解析时 fail closed，不能冒称 Tool 已执行或曾发 question。[默认实际消费者](test/isolated/ask-user-configuration.test.ts)核三模式、后续真实 Provider 文案、零 grant、禁用与原 Run、版本/options 和两种 child；正常源码外 TUI 资格由 [CLI](../cli/README.md#tui-普通问题步骤)维护，临时 vault 不代 OS 资格。

默认全局登记 `@kite-ai/agent/files` 的 6 个 `files.*` Tool，每 Run 装配针对实际持久 Workspace root 选择这组定义，以及普通 version-1 `skills.load`/`skills.resource`。`effective.tools` 选择准确 ID；禁用项不在目录，未知 ID 拒绝新 Run，明确选择的 builtin version 必须匹配实际注册版本（`files.read@3`）。非空 Tool/Skill `options` 当前不支持，局部失败，不显示为未实际应用的 effective 设置。可信额外 Tool ID 只能经宿主 `knownToolIds` 提供，Runtime 仍核真实注册。配置不能提供 root、权限、Tool 实现或 capability grant。

Skills 是明确 `{id,path,enabled?,digest?}` 位置：相对路径限于选中 Workspace，绝对路径必须位于该 Workspace 或选中 profile 已有的 `skills` root。不发现 home/旧树或遍历任意目录；symlink 越界和重复物理位置局部不可用。可选 digest 固定 Skill 字节。摘要/版本/依赖事实进入 `skills.catalogue`；成功按需 Skill Tool 后全文进入 Model sources，`skills.resource` 后声明的文本资源进入来源。准确 source ID 与实际正文/资源字节 hash 绑定每次真实 Model execution。capture 刷新实际文件，不能用原 mtime/size 隐藏后续相关变更。脚本加载只读文本，不执行脚本；缺 required capability 显示局部不可用，明确请求失败，不补造已安装能力。

默认 Run 的完整来源请求接入 `captureBatch`：项目来源按全部原定义/输入核实际目标，Skill catalogue及已加载正文仅在该检查点复用；下一检查点重新捕获。所选 MCP 来源继续对每个原请求执行现有 scope/read-set 核验，Workflow fork fence仍在捕获前检查。总唯一 source和冲突摘要门禁保持，不能按 Tool 名丢弃不同文件输入。[默认长任务](test/isolated/long-run-sources.test.ts)经正式 paired 装配、公开 Client和 compatible SDK 完成同 Run 的 257 次不同 Files读取，完整原指令进入 18 次实际请求，两次冷历史读取零重放；[公开长历史接续](test/isolated/long-run-resume.test.ts)另核 4096 次原效果后恢复同一 Run。两项证据不替代 installed客户端、真实 Provider或平台资格。

公开 `run.start/input.follow_up.selectedSkills` 是最多 256 个非空名称或配置 ID，每项最多 128 字符。原数组随 Command 保存并进入请求摘要；省略使用该次配置目录，显式 `[]` 选择零项。同 ID 改选择或混用省略与空数组产生冲突。默认装配明确支持 `run_skill_selection`；固定模型或未声明支持的自定义 resolver 不能静默忽略选择。私有 startup 不再接受该字段。每 Run 只由 Service 读取配置，使用同一验证过的 canonical catalogue 唯一匹配，name/ID 命中同项去重，未知或歧义在 vault.resolve/Provider 前以原 Command 持久拒绝。它只缩小实际 Skill catalogue、按需 lookup、source 和保存的配置快照，不发现路径、不新增 Tool、trusted root 或 capability。后续公开 Run 可明确换选择，原配置/来源保持原事实。[assembly 反例](test/isolated/assembly.test.ts)与[实际 CLI argv](../cli/test/isolated/host-skills.test.ts)验证别名、歧义、完整正文、两个 Run 快照和无信任零效果。

根和 child 的 Service 快照在同一顶层保存 `skillSelection:{requested,resolvedIds}`，其中 `requested:null` 表示公开原请求省略，`resolvedIds` 是该轮实际可用目录 ID。child 保留父请求事实，但只按父实际 ID 限制当前可信目录，不重新解释名称；父 marker 损坏或所选项失效时明确失败。Runtime 提供原执行链上最近的真实父 Run，runless Job 也不得退回全目录。确实没有祖先 Run 的可信 Action 调用仍按明确角色和当前配置装配。公开 follow-up 是独立选择；私有 child 续轮及自动 report 保留其原绑定。冷读取原请求、Run 和来源不启动 Provider。 选择身份及备选方案见[单次 Skill 选择决定](../../.agents/notes/implemented/architecture/2026-10-02-per-run-skill-selection.md)。

`createDefaultProcessConfiguration` 接受可信宿主 `permissions`、`knownToolIds` 和 `allowedToolCapabilities`。Skill 依赖核对使用宿主允许能力与选中 Tool ID 的交集，Skill metadata 或 Workspace 配置不能扩大它。非 Run host binding 只描述实际已注册的 Planning/MCP Action 与静态能力，Model 按每 Run 实际身份授权；当前持久模式装配见下文。每个保存的 snapshot 中 `actualCapabilities` 记录实际 Tool/extension 版本、发现的 Skill 版本、宿主依赖能力事实和独立 digest，不替代普通 Tool 授权。

resolver 返回每 Run 的 `extensions`、`sources` 与 `dispose`。项目来源针对实际 File Tool 的可信相对目标，读取从 root 到目标的 `AGENTS.md`/`CLAUDE.md`。Runtime 冻结选中定义，并在关闭 Workspace 文件 handle 前为后台操作保留 binding lease；后续配置不能替换活动 Run 的定义或快照。Files 保留其实际 FD/path/hash 身份、POSIX/no-follow 和外部编辑 CAS 约束；大正文通过原 scope Artifact 和通用 Model 正文交接，范围以 [Files owner](../../packages/agent/src/tools/files/README.md)和[Model 正文 owner](../../packages/agent/src/model-body/README.md)为准，不声明 Windows 资格完成。

默认全局 [Files checkpoint 配置](src/file-checkpoint-configuration.ts) 唯一登记 `builtin.files@1` 和准确六个 Files Tool，Run resolver 只选择这组定义，不重复注册。纯 metadata factory 不解析 Runtime 或打开文件；实际 scope 从当前 Store/Session/Workspace 的可信事实取得 canonical root，每次独立关闭 FD。捕获固定原 Run 已封存的 `contextSelectionId`，逐项核实际 Tool→成功 Model decisionSource、完整 sealed Model input/hash、原 Command/subject 与完整消费 User 的准确 source IDs/正文。nullable Execution delivery selection 不替代原 Run pin，后来 User 不成为旧 Tool trigger。

默认装配把 Agent `filesNativeAssets()` 的加载器及整个 Node-API companion 纳入原 runtime assets，普通读取、外部路径和 checkpoint／restore 共用该保护。它只来自可信 public entry，JSONC／HTTP／Model 不能重标；Full 仍在 adapter 前拒绝。原[真实 Service 验证](test/isolated/files-native-boundary.test.ts)经 compatible SDK 与实际 Runtime 核普通外部文件可读、加载器／manifest／目录内新建拒绝和零写入，不冒称安装版或任意未运行平台资格。

当前selected history按实际selection/upper完整分页；8192 Messages、64MiB累计来源证明、8MiB单页超限明确拒绝。历史capture verification改由私有`readOriginalRunSelection`从actual Run/Command pin读取当时选择，再按原trigger上界读取完整历史；当前point资格另核current selection。同Session保全Messages但换ID不会误拒旧点，排除trigger仍unavailable。已发布compression逐层核完整input/output/origin，前缀仅定位候选，真实User碰撞不被排除。生成摘要指令只按唯一准确 `sourceIds=[compressionId]` 及 user 身份从完整原输入定位；项目／Runtime 尾部来源不冒充该指令，不假设它位于最后，也不移除其他真实 User 或碰撞正文。restore逐项核原Source、Artifact EOF/hash/size及真实postbaseline；v2 journal/effect ledger保实际新inode或确认missing，v1只读不回填。默认full仍独立人类Ask，不继承原Tool/旧Store授权；原ID/cold只读原journal/carrier。

默认scope开启`protectReads:true`，保护canonical Profile/协调目录、`.git`与实际Service/Bun/SQLite/Shell/MCP/parser loader及companion；原六Tools使用准确组件范围。纯loader getters提供实际位置，custom extractor不附默认parser，单文件bundle不封其父项目。此前[默认capture](test/isolated/file-checkpoint-default.test.ts)、[两层compression](test/isolated/file-checkpoint-compression.test.ts)、[资产scope](test/isolated/file-checkpoint-runtime-assets.test.ts)与[真实A→B](test/isolated/file-checkpoint-restored-profile.test.ts)分别保其冻结证据；本轮[默认Fork/selector](test/isolated/file-checkpoint-fork.test.ts)3/316/0核两层aliases/未选B后像、实际codeB新inode后Fork与earlyA恢复、same-S新selector保留或排除原trigger。host head fault probe保持immutable来源、主体与真实CAS；cold原ID/provider8不重派。当前capture18/231、受影响Browser七文件29/570另为独立运行。完整合同归[Files owner](../../packages/agent/src/business/file-checkpoints/README.md)，三范围客户端与平台资格继续独立验证。

私有 startup 可携闭合三字段 `runtimeProtection:{kind:"terminal.candidate",root,manifestSha256}`，仅由 trusted launcher 提供，不进入 HTTP、Model 或 JSONC。独立 [runtime-assets verifier](src/runtime-assets.ts) 与 CLI 共用唯一完整 terminal manifest/tree 校验，核真实 entrypoint、固定 executable 和 `terminal-<manifest digest>`；它证明完整性，不授予发布或业务权限。子 Service 先独立持有 candidate shared 使用锁，再将验证后的整个 root 加入默认 Files 保护；默认 closure 拒绝其内 Worker/CLI code 读写而邻接工作文件可读写。锁在 Runtime、Workspace handles 与 reader/stream cleanup 全部确认后才释放，失败保 listener/lease。实际 [terminal runtime protection](../../tests/isolated/unified-agent/terminal-runtime-protection.test.ts) 1/23 覆盖公开 builder、native paired 与启动 CLI 退出后的 daemon，自有实例停止后才允许 exclusive lock；新的 [single-file actual qualifier](../../tests/isolated/unified-agent/single-file-runtime-protection.test.ts) 保原34条断言并补真实 observer preload 的默认／custom 读写拒绝及两处完整字节检查，当前整文件1/36与原完整默认通过；准确 source/custom loader、parser/hash/Bun 保护、邻接成功、cold 只读、所属进程退出及实际 trusted `afterResourceClose` 失败保持 listener/shared lease继续核实。fixture必须复制真实候选的loader companion，失败保根；准确原red与当前输入归[收束进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13当前完整默认收束与单文件资产交接)。它只证明该失败位置，不概括任意 cleanup 失败。此前完整候选 [terminal bundle](../../tests/isolated/unified-agent/terminal-bundle.test.ts) 1/2521 另核搬迁、CLI/TUI/daemon、archive/install、升级回滚/卸载使用锁。完整平台安装、signed publisher 与正式入口退役仍未资格。

没有完整候选 proof 的标准开发 `main`／`daemon-main`，只在两入口与当前 Service module 同位置且实际为 canonical 普通文件时共同纳入保护资产；缺少伴随或非标准 host 仍绑定原实际入口，不猜完整候选。Agent 将保护根按集合规范化后冻结，合法同制品 paired→shared 冷恢复继续经原严格配置校验。正式 `runtimeProtection` 仍在持锁后验证整个闭包，不使用开发入口发现替代它。实际双入口保护、原审批、一次效果及冷恢复证据归 [CLI Recovery 原整文件](../cli/test/isolated/recovery-host.test.ts)。

完整 Native 的 `native.candidate` proof 由 [Native verifier](src/native-runtime-assets.ts)独立核两层完整资产；只接受已核 inner 清单里的 `service` 或 `daemon`，均固定包内 Bun、Native build 与 outer digest。共享 Daemon 沿同一 assembler 独立持两 root SH，启动 CLI 退出不释放其使用权，实际资源确认关闭后才释放。[校验正反例](test/isolated/native-runtime-assets.test.ts)核两种服务入口及 CLI/错误 runtime/build/proof 拒绝；[实际安装 stdin](../../tests/isolated/unified-agent/native-stdin.test.ts)核 source-free Native Daemon、真实 pipe 问题及 stop/status absent 后卸载。当前证据限本机 macOS arm64，不覆盖 Daemon 冷重启、其他平台或正式发布者身份。

6 项定向测试包含真实独立 discovery 文件及 4 项 paired Service/SQLite/本机 compatible 端点场景：权限 barrier 中指令变化阻止旧文件写入并触发新的实际 Model 决策；Skill 正文/资源按需进入来源且不执行脚本；依赖与未知 Tool 选择局部失败；禁用 File Tool 只影响下一 Run，已准入等待 Run 保持原 binding 和快照。既有配置/vault 测试仍属于 owner 验证。

默认 MCP 有两种可信来源。已有 programmatic `createDefaultProcessConfiguration({mcp})` 固定 Server 与合格 `transportPort` 保持独立；新增 [mcp-source-configuration.ts](src/mcp-source-configuration.ts) 从选定 Profile 的 `mcp.json` 和实际 canonical Workspace 的 `.kite-code/mcp.json` 捕获原始条目，复用唯一全局 `builtin.mcp` lifecycle。原始 URL、command/args/env、认证材料和 unknown 字段只留在 host 私人来源，普通 Run/Job/Model 与 Query 只有安全 ID、名称、来源身份、版本、摘要和准入事实。项目同名 disabled、坏项、pending 或 rejected 仍遮蔽用户项。JSONC `mcp` 只选择 `{id,enabled?,configDigest?,definitionVersion?}`；所有层均省略时选择已准入的有效来源，显式解析为空则选择零项，不能用选择动作批准来源。错误可选源不阻止无关 Files/Model；无合格 transport 的已选择静态 Server 仍在 Provider 前拒绝。

配置位置的专用只读展示由 [mcp-management.ts](src/mcp-management.ts) 的 `mcp.server.locations` v1 Query 提供，输入 `{}`。它复用 `sources()` 与 `readMcpSelection()`，返回同一真实 Store／Session／canonical Workspace 身份和完整 `readSet`，逐项附原 `serverId`／`configDigest` 及固定配置路径：Profile `mcp.json`、Workspace `.kite-code/mcp.json`。只有该路径的 canonical digest 与当前注册来源的 `pathDigest` 相等才返回路径；程序注册或无法核实位置返回 `null`。该有限路径展示不公开 URL、command、args、env、认证材料或文件正文，不读取任意客户端路径，不连接、读取凭据、调用 Model 或创建工作。它不进入选择 Action 的 canonical 输入、CAS 或权限依据。

当前连接状态与已知能力数量由 [Agent MCP lifecycle](../../packages/agent/src/mcp/README.md#普通-server-选择与-live-工具目录刷新) 的只读 `mcp.server.status` Query 负责，Service 只装配现有 Extension。CLI Host 完整分页读取 `mcp.catalogue` 并严格核 scope／游标／重复记录；后续页失败不发布部分 live 集合。详情把真实已核状态、工具数量、配置位置和未读取资源／提示词数量的明确未知分别显示，不为展示自动调用远端 list、OAuth 或连接。实际来源、代次检查归 Agent owner，客户端展示和取消入口归 [TUI 手册](../../docs/handbook/clients/tui/guides/mcp-and-skills.md)。[Service 管理测试](test/isolated/mcp-management.test.ts)保同 scope／readSet、程序注册无物理路径与零额外 I/O；[CLI Host 测试](../cli/test/isolated/tui-mcp-host.test.ts)核完整分页、错误页／错误来源／取消不发布部分集合，以及当前真实来源位置与 foreign scope 拒绝。

Process assembler 把 source factory 绑定到真实 Runtime，macOS／Windows stdio使用已构建的公开 guardian `.js`，Linux使用本包封存的原生 init与canonical Bubblewrap；没有源码 `.ts` 或安装机编译fallback。独立尚未绑定 Runtime 的工厂没有 raw source authority；其 source selection 为明确空项，不能伪造文件观察。冷重建要使用真实原 Store/Session/Workspace；原来源 snapshot 不等时在 Model vault lookup 前拒绝。实际目录根采用 canonical realpath/devino，保留 macOS `/var` 祖先别名兼容，仍拒绝 Workspace 目录本身的 symlink。

同一正式 assembler 现按实际平台选包内 Windows stdio guardian，Source approval、原 SQL Job／parent input／capture digest、最后准入与 wire freshness 不另建路径。Windows executable 只收绝对 `.exe`＋原 argv；当前 `.cmd`／`.bat` 明确拒绝，无 COMSPEC／PATH fallback。原 Job／HANDLE／FILETIME、实际 guardian reap 与 observation close 的 v3 归[Agent MCP owner](../../packages/agent/src/mcp/README.md#windows-stdio-所属-job)，不借 Shell 权限或旧 Host carrier。本机[完整封装默认链](test/isolated/mcp-source-packaged-default.test.ts)核资产进入清单、实际默认来源／Tool／准确取消和 cold 原 Command／Execution／完整输出零 Provider／RPC；Windows 原生分支及 installed 维护／版本链仍待验，不将本机邻接计为资格。

Linux默认Source／SQL Job／SDK Tool现沿同一port接入独立namespace源码，原args／cwd／env、文件／设备与网络保持。明确Linux init／Bubblewrap在装配及每次最后freshness边界重新核完整EOF／字节SHA／原文件身份；原FD关闭unknown保首错与对象、不重试数字，内部Profile门禁接装配cleanup及`beforeResourceClose`，保原Store／Profile／candidate使用权。真正stdin入队前在ready等待后同步复核原binding／source／signal，cleanup不受漂移阻断；完整合同与待验范围归[Linux MCP owner](../../packages/agent/src/mcp/README.md#linux-stdio-所属-namespace)。本机原封装整文件1项60断言通过只证明macOS邻接与新资产图；Linux原生／installed资格仍待重构后Actions。

普通 `mcp.sources.list@1` 提供冻结原 Run 安全目录与完整分页，`builtin.mcp.sources/mcp.sources` Query 读取当前安全目录，二者均不连接或查询 vault。来源批准和凭据绑定分别通过普通 Action、原 question accepted decision 与 HostMutation 保存；它们不替代 Workspace trust 或 Tool grant。`mcp.connect` 创建真实 `mcp.source.connection@1` Job，连接 Tool、Job、远端 Tool 各自授权。Job input 只有原 Store、safe server/config/capture digest、原 parent Execution/input digest、operation key 和 bootstrap ID。源/变量/批准/credential binding 在实际 vault/DNS、HTTP request 或 guardian spawn 前复核；拒绝、取消与无法确认 handle 停止保持准确原事实。HTTP loopback 只在可信测试选项中开放，stdio 资格及公共制品仍按实际日志记录。

HTTP 来源支持 none、由真实原 question 绑定且尚未过期/撤销的 opaque Bearer，以及下文的 owned OAuth。raw 配置的 vaultRef 本身不授读取资格；四个认证 Action、已有材料恢复和续期按[认证边界](../../docs/active/mcp-authentication.md)执行，来源文件不能提供任意 header 或旧 policy 权威。child 的默认 resolver 使用实际父 Execution/Run/Session/Command 与 Workspace 派生有限来源，保留原 raw/transport/metadata/read-set，激活时核实际 carrier、child configuration、root work、主体和祖先链；每个 child connect、source Job 与远端 Tool 继续独立授权，父 grant 不复用。角色包装必须匹配真实 role/version，不能把任意 JSON 当父来源。来源漂移、未连接父 schema 或不能核实原范围时局部拒绝；完整嵌套与冷子任务资格仍在验证。旧全局 home 不属于新来源。

[默认原始来源测试](test/isolated/mcp-source-default-configuration.test.ts)真实通过 safe directory 到 connect Tool/source Job/remote Tool 的三次独立 Ask、remote annotations 不扩权、完整快照/八字段 Job input 脱敏、冷源变化前零 Model 凭据查询及恢复原 snapshot、坏源/显式空选择下普通 Files 工作。[源码树外默认 stdio 制品](test/isolated/mcp-source-packaged-default.test.ts)独立 1/47：无 configure、原 profile/home、实际 guardian/server、一次效果、公开脱敏、准确取消两个所属 PID 与冷查询零 RPC。[派生来源](test/isolated/mcp-source-delegated.test.ts)和[默认 child 实际链](test/isolated/mcp-source-default-child.test.ts)分别核实际原父 scope 与真实直接/嵌套 child、独立审批、原载荷/schema 和来源漂移。最终默认 child 三例 3/117、MCP 二十文件 115/1433/0fail；之前七文件 41/490、十七文件 105/1218 和十九文件资格只属于当时冻结范围。nested 夹具最终采用 30 秒总观察预算，直接/拒绝/漂移/冷读仍 15 秒；原 15 秒失败和独立时间线保留，产品 child 30 分钟、原 permissions 与 required/attached 关系不变，不形成性能承诺。该 child 组合没有证明公开 child 冷 resume、OAuth/renewal、旧 policy、OS vault 或正式三平台资格；当前增量仍按[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)闭合。

[实际冷后显式新连接](test/isolated/mcp-cold-reconnect.test.ts)使用公开 process/default configuration 工厂、源码外 Host 与已验证 candidate，同一 Profile/Store 正常关闭后重开。新 Action 和 connection Job 分别取得新的原 Ask 卡，才发生初始化、目录发现及下一安全 Step 的新 schema Tool；warm/cold 各一次真实效果。冷 bootstrap 后原历史 GET 窗口零 POST/Model/credential/socket/RPC；原 key 和 refresh 局部拒绝，旧 record/operation ref 不附上新目录。批准等待期间仅改变 source 原字节，真实 Job 在 socket 前拒绝，效果保持。当前单例1项65断言、固定10s业务/30s阶段/180s测试通过；stage 超时收束、网络关闭与证据发布的清理控制经源码审查，异常分支未实际注入。资格只覆盖本机 macOS/Bun、auth:none、可信 pinned loopback、fixture 独立 Ask 和正常 paired 关闭；不代表管理 UI 重连、OAuth/vault、SIGKILL/Task reconcile、Linux/Windows 或安装资格。实际原 IDs、冻结 SHA 与全部历史日志见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#冷后显式新-mcp-连接的公共链)。

[configuration.ts](src/configuration.ts) 还导出可信同步 `McpHostFactory({profile,credentialVault})`。`options.mcp` 可以保持原配置对象，也可使用该 factory；默认装配先建立唯一 vault，再调用 factory 一次，MCP broker 与配置/凭据 manager 共用同一 vault。factory 收到冻结的选中 profile，凭据引用在宿主侧解析，不复制凭据后端、不从 JSONC 取得 URL、reference 或 Authorization header 权威。JSONC 仍只选择宿主已登记的 server 与准确 digest/version；这个入口不自动连接 transport，不使配置内容产生权限，也不声明完整 OAuth 流程或 OS 凭据资格完成。

[默认 MCP 凭据测试](test/isolated/default-mcp-credentials.test.ts) 的 2 项测试、35 条断言证明默认 factory 的 profile/vault 交接、共享凭据管理、真实本机 RPC 与下一 Model 的准确 remote 目录、等待批准时零 secret/socket，以及查找期间撤销凭据阻止迟到 remote 请求；受影响的 5 文件组合通过 21 项测试、256 条断言。这些计数来自对应实际回归，不合并成全库或平台资格；没有调用付费 Provider 或用户 keychain。

配置解析与每次 Step reader 不进行网络/进程 I/O。普通 `mcp.connect` Tool/Action 创建持久 detached connection Job，仅已派发 `start` 打开 transport 并发现 tools。下一安全 Model checkpoint 取得已缓存的附加 remote Extension、准确 schema/version、静态选中 Files/Skills/business Tool，以及非秘密 selected-server/config-digest/cache 事实，不复制全局 Extension。Ask 分别授权 connect（`external`）、connection Job（`network` 或 `process`）和各 remote Tool（`unknown`，不能从 annotations 得到 safeRead）。缓存目录 Query 零 Model/RPC，不从历史恢复推断重连。factory 生命周期覆盖进程/已知 Job，不随单 Run Files disposer 结束；准确 Session 后台取消停止其已知连接，另一 Session 保持 live。Core/Job 关闭监督所属 transport 事实，保留 unknown 停止结果。

四个静态 `mcp.resources.list/read`、`mcp.prompts.list/get` Tool/同名 Action 走同一普通持久执行面，metadata/allowed 表按每项准确 kind/ID/version 登记为 external、safeRead=false。Run 派发按原 frozen server/config 选择核准；非 Run Action 从实际 Session/Workspace 读取当前 trusted selection，并独立授权。JSONC 不能提供 URI/name 权限、transport、认证或执行代码。所有调用须绑定原 connectionKey/configDigest/generation；read/get 再绑定真实成功的 list Execution 与 canonical descriptor digest。固定原 live client、完整低信任正文/Artifact 和未知事实保留规则由 [MCP owner](../../packages/agent/src/mcp/README.md)负责。只读 Query `mcp.resources`、`mcp.prompts` 在冷打开时返回原缓存与 live=false，不连接或恢复历史。正常 process 的原 scoped ArtifactStore 支持完整大正文，缺该能力局部报告 unknown。

[资源/提示默认装配测试](test/isolated/mcp-resources-prompts.test.ts)使用真实 fixed compatible SDK、SQLite/ArtifactStore、pinned loopback HTTP 和 owned macOS stdio guardian，验证四项普通 Model Tool、普通 Action、独立 deny/持久 Ask、原目录/参数、scope/version 拒绝、完整 Prompt 低信任来源、冷查询零 I/O 与 wire 前后取消。不是付费 Provider、真实 OAuth、用户 keychain、完整 server 管理或跨平台资格。

[planning-configuration.ts](src/planning-configuration.ts) 验证原 Command 中已知、唯一 version-1 `builtin.planning` / `builtin.skill-workflow` envelopes，单次计划仅接受 `{mode:"plan"}`。Workflow 仅接收自身筛选后的输入，原 Command/body/digest 不改写；坏/重复/未知输入在 vault 与 Provider 前拒绝。单次 Plan 在实际 Run initializer 建立不可变 `plan.required`，从实际 assembly safe-read 定义封存准确版本。当前权限之外叠加计划执行方式上界；所有 hard denial/control read-set 保留，Full 不能绕过未批准计划，Auto 仍取得独立 reviewer，请求批准/撤销 trust 仍独立生效。

批准记录为原 Run-specific immutable proof。子任务/嵌套 runless Job 的 ceiling 核实际 parent chain/root work 和原父 Run；必要条件仍在最终原 record/control CAS 重核。下一 Run 不借用旧批准。源请求公共类型不新增 guessed Run 字段；实际 active approved Run 的贡献只提供信息，不授权限。完整大计划封存为原 review Execution Artifact，原 accepted request/hash/UTF8/plan digest/proof/seal revision 由 [Planning owner](../../packages/agent/src/business/planning/README.md)负责核对；丢失或变化不继续批准。

[per-Run 默认测试](test/isolated/per-run-planning-configuration.test.ts)和[真实 parent/child 测试](test/isolated/per-run-planning-child.test.ts)覆盖实际 Service/SQLite/SDK/固定 Provider、Full 预批准零写/Job/child、只读分析、选定方式与当前权限交集、真实步骤回执/完成、same-Session next Run 拒借及冷策略变化前零 vault；最终 child 派发前仅增原 parent head revision 保 JSON 的外部 SQL 漂移也拒绝零写。Planning leaf/Artifact 与相关业务三文件现为 50 项/454 断言；Task 默认报告与规划相关九文件现为 48 项/747 断言。TUI 文件/Plan 相关十九文件 119/1063 保留四个真实 80×24 单次入口/排队/草稿/约143KB完整计划/回答丢回执窗口；客户端强杀后的普通 Work/Planning intent 和正式旧入口/平台资格继续验证。

真实 parent/child fixture 的自动审核转人工／untrusted 场景中，`task_wait` 可因原 child 等待交互而正常早返回，不能以父 Command 结束证明子写入完成。原父下一 Model 在真实 `planExecution` 后、取得唯一 Model 槽前等待准确原 Run→Task→child Job 的 Command 终态；保持原批准存活，原 child 人工审批和当前 mode／trust 交集继续实际派发。原五例、全部断言、4 秒 Task wait 和整例预算保持，完整文件 5pass／52expects；准确失败和未筛选默认范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。

[mcp-management.ts](src/mcp-management.ts) 提供独立普通扩展 `builtin.mcp.management@1`。默认工厂即使没有注册 Server，也注册闭合空输入 Query `mcp.servers`；它根据实际 Store/Session/Workspace 身份读取安全 registry、当前 selection 和六字段 read-set，零连接/vault/Model。普通 Action `mcp.server.select@1` 只选择可信 registry 已准入的 Server，独立核真实 Execution/Command/主体，沿原 config HostMutation 保存一次，原目标锁内复核两来源、explicit/registry 和 canonical Workspace。注释和 unknown 字段保留；文件已发布但 SQLite 回执未落定时保原 mutation pending/unknown，只查询原 ID，不重做。该 manager 不能注册原始 URL/command/env/auth；原始来源由上文独立 factory 私人读取。

`mcp.catalogue.refresh@1` 是独立普通 Tool/Action，只能刷新准确原 live connection Execution/key/configDigest/generation，不能冷连接或 lazy start。每个 RPC 前复核原 client/scope/signal；原连接记录不可变，刷新事实绑定实际 refresh Execution。新目录在下一安全 Step 生效，旧 capture 失效、历史 Query 保原事实；停止后替换连接不能把新目录写到旧引用。runless refresh 和 resources/prompts 均先核实际 Session 当前 selected-server 范围，再委托显式宽权限。管理/刷新与相邻资源/提示最终 15 文件 76/957 的本机资格见[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)和[管理测试](test/isolated/mcp-management.test.ts)，不证明 OAuth 或默认原始源已完成。

[MCP Task 测试](test/isolated/mcp-tasks.test.ts)和[凭据边界测试](test/isolated/mcp-credentials.test.ts)保留全部业务断言，并对三个无法确认 Job 停止的 fixture 明确验证：`Runtime.close()` 返回 `shutdown_cleanup_unconfirmed`，生命周期为 `drain_failed`，原 Store 仍可读、unknown Execution 不被改写，且不增加 Task 创建、Model 或凭据查找。取消 acknowledgement 和失去远端观察不能变成实际停止证明；可信连接 Job 已进入 `start`、但凭据边界在 socket 前拒绝的事实，也不会替 Core 伪造未知 handle 的退出。只有证明生产保留资源后，测试才显式关闭自己拥有的 loopback HTTP、临时 Store 和临时 vault 资源，不清理真实远端 Task 或用户数据。该两文件独立复验 10 项测试、128 条断言通过。

[MCP 配置测试](test/isolated/mcp-configuration.test.ts)使用实际默认配置、SQLite/Core、本机 compatible/MCP HTTP 端点，验证网络前 Job 派发、下一 Model 的准确 remote schema 与单次 RPC、独立 Ask 卡、缓存 Query 零写入/Model/效果、Session 隔离及无效/不可用选项局部失败。注入 localhost port 仅取得测试资格。独立导出的 [HTTP port](src/mcp-http-port.ts)有本机 socket/DNS candidate/pinning/proxy/redirect 证据；[Agent stdio port](../../packages/agent/src/mcp/README.md)由默认来源固定原 Profile coordination，选择独立 macOS launchd coalition 与打包 broker／guardian 后端，拥有转组／orphan后代的停止证据。两者都要求原 Job 可信准入，不能从 JSONC 取得。真实 TLS、完整 credential broker/OAuth、MCP tasks 和跨平台发行资格仍未完成。resolver 不预连接或启动 raw stdio。

[默认原始来源测试](test/isolated/mcp-source-default-configuration.test.ts)新增真实 macOS stdio 完整失败恢复：首次 initialize 返回原协议失败，SQL 原 Job 保存准确 broker/server reap、guardian absent 与 coalition 全树停止／registration removed；公共原 connection Query 核 frozen config 与原 parent 后返回 failed，零新增 RPC。用户独立新 connect 与 Job Ask 后，正式 snapshot/page/descriptor reader 核完整名称和 schema、hash/EOF，再由下一真实 SDK Model 的独立 Tool Ask 产生一次 `tools/call`。原完整文件4项／80断言、Service types与Biome通过；原HTTP三例、全部原断言与预算保持。fixture 的 ArtifactStore 仅为该 stdio 全文场景沿实际 process 装配提供，close直接等待Service／Runtime，不吞清理错误。这份新测试未新增关闭后逐PID／Job收据资格；取消、正常退出和源码外正式窗口复用仍适用的原证据，完整回归、真实红及平台限制归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-mcp-失败建立与完整连接恢复)。


W08 追加输入使用原命令入口：`input.steer` 显式携带 `content`、`targetRunId`、`contextSelectionId`；`input.follow_up` 显式携带 `content`、`afterRunId`（可为 null）、`contextSelectionId` 和可选 `modelId`。两者要求固定 `expectedStoreId` 与原 `commandId`，只允许 root Session，主体由宿主提供。202 返回原 accepted 命令，应用结果须查原命令的 `input_applied` 回执，不能把接收视为新消息或 Run 已产生。精确取消尚未应用的输入不会产生消息或新 Run；取消原 Run 保留独立 follow-up 意图。Store、目标和上下文不匹配返回有限错误，不重选当前目标。

`GET /v1/sessions/{id}/inputs?storeId=&kind=&targetRunId=&afterSeq=&limit=` 是纯只读、最多 200 条的待应用输入 keyset 页面，包含原内容、目标、context 及命令投影，不执行消费，不公开主体或 owner。`seq`、`nextAfterSeq`、`snapshotCursor` 均保持十进制字符串。消息投影保留 `originCommandId`、`contextSelectionId`、`inputKind` 和 `sourceIds`。输入内容必须非空白且不超过 1 MiB UTF-8；默认命令 HTTP frame 为 8 MiB，以容纳最坏 JSON 转义与固定 envelope，显式宿主 `maxBodyBytes` 仍生效。

[真实 Core/HTTP 输入测试](../../tests/isolated/unified-agent/client-inputs.test.ts) 在 macOS/Bun、临时 SQLite Worker 和固定模型下通过五项测试：12 条 steer 无隐式八条限制、旧模型请求不改写、旧 Tool 零派发且消息配对完整、独立 follow-up 与精准取消、Store/目标/context 拒绝零事实、真实 child 的直接输入拒绝，以及完整 1 MiB 内容的转义 frame。它证明当前公共协议及同 Loop 消费；正式客户端交互展示、后续 context selection 切换和跨平台发布资格另有负责验证，不能由本测试推出。


R10 公共上下文使用 `GET /v1/sessions/{id}/context?storeId=&contextSelectionId=&afterSeq=&upperSeq=&messageLimit=&afterSourceId=&sourceLimit=&byteLimit=`。读取固定 selection/high-water，消息和结果来源分别返回 keyset 游标；每页最多 200 条消息、100 个来源、8 MiB 内容预算。来源只投影原 Store/Session/selection/execution/revision、inclusion 与结果，不公开 owner 或主体权威，不推进 SSE。公共 Execution 可选投影 `originStoreId`；当前 Core 恒提供，缺失的客户端只能显示 unavailable，不能推断为当前 Store。历史消息 GET 不受选择删除影响。

`POST /v1/sessions/{id}/context/select` 精确使用 `{expectedStoreId,commandId,expectedContextSelectionId,boundary:{messageId,seq}|null}` 做 root 空闲 CAS；整组 live/planned/unknown execution 阻止选择，不回滚文件或执行效果。`POST /v1/sessions/{id}/results/{executionId}/include` 使用同一 Store/命令/selection 加准确 `resultRevision`，只把已有结果显式纳入上下文，不启动 Run 或重放 Tool/Job。原 suppressed delivery 不改为 pending；活动 Run 返回 `input_busy`。主体仅由宿主填入，内部 `consumeJobResult` 没有 HTTP 入口。closing 时两种 mutation 均拒绝，纯读取保持独立。

[公共上下文集成测试](../../tests/isolated/unified-agent/client-context.test.ts) 使用真实 Service、SQLite Worker、固定 Model 与普通 Action/Job 证明空闲选择、原回执幂等、分页、历史不删除、活 Job 拒绝选择、终态结果被 rewind 抑制后明确 include，以及错误身份/revision/context 的局部拒绝。实际新模型请求排除 rewind 前旧消息，按准确 source ID 纳入显式结果并保存原 Store/execution/revision/inclusion；held Model 期间新的 include 返回 input_busy，零命令、零 Job 重放。合法 1 MiB 追加输入的最坏转义正文在 8 MiB context 页与实际新 Model 中完整保留，较小显式预算准确报超限。活动 Run 中显式 include 的 steer 整合不在本切片。


Service 的权限职责限于 HTTP 接口与主体/Store/Session 身份校验、当前控制事实读取和可信能力装配。三策略分类、已知 builtin effects（含 Task 与 MCP source/auth 固定分类）、计划权限交集、Workflow 最低审批和明确文件恢复审批规则由 Agent 权限模块实现；Shell 的输入解释、命令摘要、危险拒绝与最终 scope 读取也由同一模块负责。宿主只注入当前模式/trust/revision、真实已注册能力和 transport 可用性、平台资产路径及环境，Core 保留审核/人工接纳及最终派发事务。

默认权限规则位于 [Agent 独立权限模块](../../packages/agent/src/permissions/README.md)，通过 `@kite-ai/agent/permissions` 装配：`createPermissionPolicy({readPolicy,describeCapability,readReviewContext?})` 返回 Core 的 `Permissions`。每次调用读取宿主当前策略 `{mode:accept_edits|auto|full,workspaceTrust,revision,allowed}` 与真实已注册 capability 的 kind/definition/version/revision/effects/hardAllowed/safeRead；Tool 描述或远端文本不是能力依据。策略与能力语义的稳定摘要共同成为 approval policy revision，即使宿主忘记增加显式 revision，实际 trust/模式/allowlist/能力变化也使旧批准失效。构造及 import 不执行 I/O。

Model 必须有准确 kind 的允许项，不给同名 Tool 授权。所有非 Model 操作先核对当前 Workspace trust、准确注册版本、allowlist 与硬可用性，失败不会生成可扩大该边界的人工卡。请求批准允许可信 Workspace 内的 read/edit；正式 Shell 使用 Workspace 可写且无网络的默认范围，外部写入或联网请求分别取得准确单次审批。Full 跳过普通逐项风险审批，但不跳过这些硬约束或取消；不确定 effect 仍由真实宿主执行能力限制。所有审批的最终参数、执行身份和重新校验由现有 Core Interaction/UnifiedExecution 负责。

Auto 分类只返回准确 invocation、effects 及可选只读 task/plan/拒绝理由，不执行 Provider。Core 使用实际 `authorizationReview` 建立持久 child/carrier，经同一 Loop 的唯一无 Tool Model 取得闭合单次决定与准确 proof；失败或 ask_user 返回原调用的真实人工卡，reject 结束原工作。默认每 Run reviewer 使用该 Run 已封存的 SDK route/options 与绑定版本；宿主可显式覆盖，独立无 Run Action 没有默认 SDK reviewer 时仍准确人工回退。大请求由[通用 Model 正文](../../packages/agent/src/model-body/README.md)完整封存和展开，真实 Model input hash 参与最终证明，公开文字不能自报 Execution 或签发永久许可。准确 `same_command` 会话授权与正式客户端的三策略/trust 设置由下文当前授权目录及持久控制入口负责；不借旧会话批准开放新的调用范围。

[真实权限测试](../../packages/agent/test/isolated/permissions/policy.test.ts) 用临时 SQLite Worker、同 Core Loop 和固定 Model 验证：准确单次批准与原命令重复零重放；等待中 trust/allowlist/注册可用性/模式变化后的旧批准零 Tool 效果；可信 read/edit 与 Full 普通风险跳过；同名 Model/Tool 隔离；Full 硬约束和版本拒绝；未装配 Core reviewer 时 Auto 准确人工回退；默认 SDK reviewer 的真实证据见下段。有限无 I/O 校验另验证 capability 数量和取消，不以策略真值表代替派发证据。


`createDefaultProcessConfiguration({profile,permissions?,permissionPolicy?:{readPolicy},...})` 为每个新 Run 返回其实际 `permissions`。显式 `permissions` 始终优先，保持可信测试/宿主装配；否则 programmatic `readPolicy` 每次派发与审批接纳前重读。没有两者时，`permissionManagement(runtime)` 将默认装配绑定到真实 Runtime，默认读取当前 Store 的持久模式与信任。新用户/尚无模式记录的 Session 默认 Auto，Workspace 缺持久确认时未信任；仍允许本 Run 准确 kind/model ID/version 的实际 Model，Tool 不会通过单次审批越过 trust。直接测试宿主尚未绑定 Runtime 时保持 Auto/untrusted 的安全只读默认。权限模式、trust 或 allowlist 不能从 JSONC、MCP 描述或 Skill 元数据生成。

`describeCapability` 由当次真实 assembly 产生：选中的 builtin files read/list/glob/search 和 Skill load/resource 是 safe read；files write/edit 是 Workspace write；真实注册但未识别的其他能力是 unknown，缺实际注册则拒绝。实际 `files.read@3`、`files.write/edit/search/glob@2`、`files.list@1` 来自当次定义，配置不能改写它。Shell 仅在下文可信宿主显式选择的执行资格与真实 guardian 下注册；MCP 仅在上文明确 programmatic lifecycle/port 配置下注册。当前六个 files Tools 没有 mkdir，不因权限分类保留可能的未来 ID 就宣称已提供该工具。

旧 Run 保留原 manifest/definitions 与文件绑定，单纯禁用后续 Tool 配置不等于全局撤权；当前 mode/trust/allowlist 的变化仍会在派发前生效。新 Run 重读配置并封存新目录。默认每次授权允许集合包含实际已选中的静态能力和纯缓存 MCP 动态 Tool/Task Job 目录，不为未注册定义补授权；读取该集合不打开连接。非 Run Action 根据原 Execution/Command 取得准确 Store、Session 与宿主主体，再读取同一控制事实，不采用当前 UI 选择或全局猜测。

[默认权限配置测试](test/isolated/permission-configuration.test.ts) 使用实际默认 resolver、SDK、Service HTTP、SQLite Worker、安全文件 leaf 和本机兼容 Model 端点，证明真实 Auto 的 ask_user 回退后单次批准写入、请求批准的工作区无卡写入、Full/default trust 拒绝、旧 manifest 与当前撤权区别、新 Run 目录变化、显式 Permissions 优先以及错误 builtin version 在 Provider I/O 前拒绝。早期与 default configuration 和 assembly HTTP 的组合记录为 12 项测试、105 条断言通过；当前三策略消费者的原完整回归见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11shell-三策略与旧模式退役)；未调用付费模型、用户 keychain 或旧数据。[默认 Auto 测试](test/isolated/auto-configuration.test.ts)与 policy 组合 11/137 通过：单模型槽、完整 task、新旧 SDK route、单次批准、Provider/闭合输出失败与 ask_user 原卡回退、拒绝以及撤权/取消零文件效果。测试按正式 main 装配真实 ArtifactStore，避免把缺内容能力的人工回退误判为 reviewer 成功。会话 same_command 与原 epoch 清除已接入下述授权目录；正式入口切换仍按完整客户端资格核对。

默认进程装配唯一全局 `@kite-ai/agent/planning` 业务 Extension，其目录、空闲 Action 与只读 Query 不依赖前台 Run。JSONC `tools` 只选择明确注册的 planning/validation Tool ID 和准确支持版本，不能启用 requirements、允许 waiver 或授予权限。只有可信 `createDefaultProcessConfiguration({planning: PlanningOptions})` 提供 `requirePlan`、`requiredValidation`、`allowWaiver`、required receipt definitions 和允许执行模式。选中的业务定义取得真实保守权限描述：`planning.read` 是 safe read；planning write/update/review 与 validation define/check/rebind/waiver 是 `record_write`，`safeRead:false`；显式宿主 Permissions 始终优先。空闲 Action 使用相同 programmatic `readPolicy`，准确身份为 `kind:job`、`builtin.planning/<action>` 和实际 version；默认未信任策略拒绝，可信请求批准产生普通审批，显式 Permissions 仍优先。`record_write` 修改封存治理记录，不等于 Workspace 文件写入或执行结果，Accept Edits 不自动允许它。Auto 使用当前 Run 封存的同一持久 Core reviewer，独立无 Run Action 要求显式可信 reviewer，否则准确人工回退。目录可见不授予权限。每个新 Run 保存工厂 conditions、启用的纯 metadata initializer 和实际非秘密 option/definition snapshot，包括宿主选中的 `fileHashChecker` ID/version 或明确 null；JSONC 不能选择 checker。嵌套 validation checker Execution 保持独立 Tool 授权，权限审批不会回答独立 validation waiver 问题。不启用治理 flag 时，普通会话保持不受这些要求约束。[Planning 默认配置测试](test/isolated/planning-configuration.test.ts)用本机 compatible 端点与 SQLite/Core，验证首次 Provider 请求前初始化、准确用户 plan review、真实私有文件 receipt 完成 progress、无额外 Model/Run 的空闲 Action/Query、错误版本在 Provider I/O 前拒绝，以及保存的 waiver 不能为缺证据的后续 Run 授权。这证明默认装配与便携业务路径，不等于正式 UI、外部 validator 或平台发行资格。


默认 Service 支持可信宿主通过 `createDefaultProcessConfiguration({child:[{id,version,modelId?,toolIds?}]})` 声明有限 child 配置，入口见 [child-configuration.ts](src/child-configuration.ts)。该声明不来自 JSONC，也不是业务 AgentType 或权限模式。静态注册只有闭合 `{content:string,name?:string}` 输入 schema、准确角色 id/version 和不可执行、无 I/O 的占位 Model；只有首次建立新 carrier 时，Core 提供实际原父 Execution/Run/Session/Command、Workspace 和取消信号，再由共享默认 resolver 重读同一根目录用户配置与 Workspace 的非模型配置。显式角色 `modelId` 或原父 Run 封存的 `modelId` 固定路由选择身份，当前用户 `models` 只解析该已知身份的 compatible SDK 配置与凭据引用；坏配置、缺失/禁用模型、未知 Tool 或角色均局部失败，不发现 Profile 配置或回退另一 Provider。

子配置的工具上限来自 Core 提供的冻结 `parentTools`，逐项绑定原父调用当前步骤实际注册的 id、version 与 extension owner；初始 Run 配置不能代替连接后取得的能力。Service 只选择当前已注册且未禁用的准确定义。MCP 子任务仍独立建立连接、取得自己的 schema，再由 Core 比较父子完整定义（含 description、schema 与 resources）；工具名或父连接不能转移执行权限。只读角色仍拒绝未知远端能力。

每个新 carrier 重新封存实际 Workspace 文件工具／Skills的选择、来源与纯 Step 模块，冻结准确 Model route/options、目录版本和非秘密快照。默认assembly复用已经正式注册的Files，只保选择及版本事实，不再打开无人消费的第二Workspace目录owner；不提供externalFiles的standalone装配仍创建并拥有真实Files。显式 `toolIds` 限制当次已启用选择及未来 Step 可见 Tools；Core 进一步核实普通 child Tools/Jobs 的定义版本、schema、namespace 与实际父 Step 集合，并对准确调用形成父子权限交集。角色模型提供准确 `kind:model` 描述；carrier 独立提供 `kind:job agent/<id>@<version>` 元数据，实际默认能力分类由 Agent 提供，custom 角色的未知效果继续保守。它们继续要求当前 programmatic policy 的准确 allowlist、trust 与必要 Ask，不复用 Model 或同名 Tool 的批准，不能从 JSONC 扩大权限。活动 child 保持原 SDK binding，即使后续配置更换 route；来源正文变化仍在下一安全 Model checkpoint 更新，旧等待调用不得硬派发。carrier实际取得的资源disposer由Core binding lease管理，child和父Run完成之后仍有detached Job时继续持有，最后已监督终态后才释放；各实际文件资源owner保持自身清理职责。原 operation key/Command 查回已有持久引用，不重新解析配置、不重建 child 或恢复冷历史执行。

[test/isolated/child-configuration.test.ts](test/isolated/child-configuration.test.ts) 使用实际本机 compatible HTTP 端点、临时 SQLite、单 Model 槽、真实 Workspace 文件与受控许可/Job barrier，验证旧 child route、新 carrier Workspace 配置覆盖、source freshness、准确角色版本、父权限拒绝零文件效果、独立 carrier Job Ask 与 Model-only/trust 拒绝、可选 modelId 继承原父身份、失败前零 child Session/Provider、warm 重试、真实 Store 冷重开查回以及后台 Job 延迟释放绑定。未调用付费模型或用户凭据。此切片只交付可信默认装配，不声明产品 `task` Tool、满容量立即失败、期限、追加邮箱、正式客户端入口或跨平台资格已完成。

默认 Task 装配使用同一可信 `child` 声明创建一个全局 `builtin.task` Extension：角色 id 精确映射相同 child configuration id，描述由宿主生成。默认沿 Agent 的可信 `defaultTaskRoles` 注册 `worker/code/explore/plan/review@1`；worker/code 继承原父 Model 与已选 Tool，explore/plan/review 只取经过 Agent 核实的实际冻结只读定义交集。 父集合先经 Agent 排除准确根问答定义；父阶段自动加入的 Planning 工具只在原冻结 owner／ID／version 与当前注册定义一致且未显式禁用时装配，未知工具仍拒绝。显式 trusted child 数组覆盖，显式空数组关闭 Task，默认三个槽位不因角色数量改变。JSONC 只能选择实际注册的 Task 工具及准确版本，包括前台 `task.execute`，不能定义角色、扩大权限或补造配置。选中缺角色或错误版本在 Provider I/O 前局部拒绝。Task 工具封存原 OperationRef 自有记录；准确未覆写的默认创建由 Agent 分类为内部记录能力，custom 角色及其他 mutation 继续保守。read/wait 为安全 read，cancel 为 unknown 控制效果；carrier 仍独立经过准确 `agent/<role>@version` Job 的当前 trust/allowlist 和必要许可，不复用 Task 或 Model 的批准。普通 child 能力继续受实际父 Step 集合和父权限交集限制。原 Command 重试读取原结果，不启动新 child；新父 Execution 同 key 不能重新绑定旧操作。配置变更与可信角色版本只影响后续 Run，新 snapshot 保存实际选定 Task 定义及角色版本。

[默认 Task 测试](test/isolated/task-configuration.test.ts) 使用本机 compatible SDK 端点、真实 SQLite、Workspace Files 与单 Model 槽，验证普通 Task/wait/read 实际链路、独立 carrier Ask、父策略拒绝零 child Provider、原 Command 重试零效果、JSONC 不能自造角色，以及新 Run 角色版本和 route 变更不覆盖原记录。容量预留、固定期限、私有 steer、follow-up 与默认 required 接纳由[Core/Task owner](../../packages/agent/src/extensions/task/README.md)的独立真实场景验证；QueueOnly/显式 idle 接纳与 root/nested/follow-up after_turn 的 Core 事实分别按 Task owner 证据核对；默认 SDK root/nested/follow-up 汇报已用同一实际 compatible SDK/SQLite 链验证，完整 retry/delivery 继续验证。正式客户端资格仍待完成。取消回执不等于外部工作已监督停止。

可信程序装配可传 `afterTurn:{authorize}`：原函数绑定冻结一次，JSONC 不能登记 authorizer 或启用续轮。真实 carrier 激活封存原 lease/route/authorizer 和适用期限，后来配置变更不改旧汇报。根汇报与嵌套/后续的普通 report Run 都走同一个 Loop/Model 权限；nested 汇报使用原 funding child deadline，report 不递归自授权。父仍活动则等待，人类工作先接纳则持久 `human_start_preferred`，原结果可读且不注入新人类 Run。缺旧 hot binding 冷恢复明确 needs_review，零 Provider，不盲重放。[默认 SDK root](test/isolated/after-turn-configuration.test.ts)与[nested/follow-up](test/isolated/after-turn-nested-configuration.test.ts)最终组合 4/87 核对原 route/authorizer、完整正文/source、原 funding child deadline、只读零请求与原 operation key 查回；已激活独立 child 不再误受旧父 carrier 终态拒绝，Store/generation/root stop/delete 和自身 carrier/期限仍最终复核。[Core 嵌套/后续](../../packages/agent/test/isolated/business/task/nested-after-turn.test.ts)与默认 SDK 的证据只覆盖这些子场景，完整 retry/delivery/冷恢复和正式客户端资格继续验证。

[Agent 默认 after-turn policy](../../packages/agent/src/permissions/after-turn.ts)由 `@kite-ai/agent/permissions` 的 `createDefaultAfterTurnPolicy` 装配，仅允许实际原 Task/follow-up 明确 `after_turn` 的结果报告；required/background 不报告，普通 Shell 不获得该资格。Service 提供当前可信 policy/trust 读取，Agent 在 request/apply 核原 role/source/root work 与取消／删除、生成原 revision/controlReads；不授权 Task、carrier 或 Model。仅 custom permissions 而无可读 current policy 时仍明确拒绝。[默认测试](test/isolated/default-after-turn.test.ts)的 11 例和全部原断言／预算保持，包含两种真实报告时序、control/source/head 漂移和非递归。父先完成的 fixture 显式使用两 Model 槽，生产默认单槽不变；原子任务实际启动后父才完成。单槽场景在真实 SQLite `planExecution` 后、取得 Model 槽前等待父继续，子先完成保 deferred，父完成后准确一次报告；不能在占槽的 Provider 响应中等待子 Model。真实失败和当前验证范围见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

自动报告的新 Run 在原 SQL 事务继承父 `requirements` 引用，不重新登记外 Run refs。[planning-configuration.ts](src/planning-configuration.ts) 的 `readBoundJobReportParent` 从实际 report Command/receipt、原 source Execution、carrier result revision/afterTurn、父 Run/config/root work 和原主体核绑定；权限沿该有限历史关系读取原批准，任意同 Session 新 Run 不获得例外。报告仍受原 refs 的最终 head/proof/CAS，初始化不生成新的 Plan/Workflow 意图。Planning 历史 receipt 按原实际 Execution 的批准 Run 重建来源 digest，inactive Run 的当前信息贡献继续 `approval:null`。当前九文件 48/747 与 Planning 三文件 50/454 资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，源码外默认 Task、完整冷报告/客户端和平台仍待验证。

默认 Planning 装配直接调用 Agent `createPlanningPermissionPolicy`；Service 的 `readPlanningPermissionState` 只提供原 Runtime／Store／Run／Execution／parent／报告绑定核验后的真实状态。原单次转发工厂与重复 options 已删除，没有保留兼容 shim。当前策略先判定、required=false 零 Planning 读取、fresh state 与原 constraint/grant/revision 顺序保持；Core／SQL 的派发和完成最终复核继续独立。

## 只读授权观察

现有 Execution／View 响应的可选 `authorization` 直接来自同一 Store 读取，只含原 reviewer 的有限状态／决定／原因、原人工答案的保存／accepted revision 和原派发事实，不增加路由或写操作。[HTTP schema](src/http/schema/index.ts)与生成 API 保持同形，原因上限8192与原 reviewer 答案一致；私有请求、主体、owner、审查全文和上下文不进入响应。停止后读取原决定与当前执行授权分别处理，准确资格归 [Store owner](../../packages/agent/src/storage/README.md#只读授权观察)。[真实 Client 测试](../../tests/isolated/unified-agent/client-interactions.test.ts)核 pending 与迟到保存／未受理，原审批提交和最终派发门禁保持。

## 默认 Shell 装配

macOS [ProcessService](src/process-service.ts)从实际选定 Terminal/Native runtimeAssets、当前 Bun、固定 `/bin/sh`、Profile/coordination 和宿主 PATH 运行根装配可信 `shell.host`。[Agent Shell 工厂](../../packages/agent/src/permissions/shell.ts)为每个 Run 读取真实 Store Workspace，选择 `createMacosHostShellJob` 的 Seatbelt/launchd coalition 后端。JSONC 仅选择 `shell.launch/read/wait/stop@1`，不能提供 executor、cwd、env、保护路径或执行资格；缺 host、资产、正确版本或平台仍局部拒绝，没有另一进程 fallback。Win/Linux 默认后端尚未取得资格，实际验证依用户选择在重构完成后交给 GitHub Actions。

Linux 正式装配已接 `createLinuxHostShellJob`：同一 ProcessService 定位已构建包内 native init及实际 Bubblewrap，固定解释器／env／原 runtimeAssets与保护根；四份可执行资产及独立解析资产分别封存摘要，在普通派发前重核，最终根／Task父子AND策略按同一真实Job定义求交。缺 Bubblewrap、init或明确 host配置局部拒绝，无旧 group降级；其原 namespace所有权、完整输出和unknown fencing归[Linux Job owner](../../packages/agent/src/jobs/README.md#linux-宿主与严格补偿源码)。[纯正式调用者测试](test/isolated/linux-shell-configuration.test.ts)实际核配置、摘要、scope和Workflow接线，工厂start由spy接收，FFI0，不计Linux运行资格。Windows默认Shell仍缺真实权限ceiling；Linux实机、installed维护／版本链及全部资源门禁继续pending。

可信 programmatic 宿主仍可显式传入 `shell:{platform:'darwin',configurationId,env,supervisorPath,bunExecutable,shellExecutable,graceMs?,maxQueuedBytes?,host?}`；省略 host 的原 options 保留 POSIX group 语义，不取得全树或 Seatbelt 资格。绑定封存 canonical cwd、资产 bytes hash、宿主身份和非秘密 env key 名，完整 env 只留可信 binding。factory/import 不启动进程；Job.start 重核资产、路径及最终范围。

host Job.start 失败仅将固定非秘密适配器码交给原 Core outcome_unknown 合同；私有路径、native 错误正文和 guardian stderr 不进入业务输出。launchd 早期失败诊断留在受保护 control base，读取正文最多8192bytes，不据诊断宣称业务子树已停止。

Shell Extension 属于每 Run 的真实绑定：`shell.launch` 经普通 Tool 派发再 `operations.ensure` 创建准确 `shell.command@1`，Tool 批准不授权 Job，Job 独立复核、持久派发并取得原 supervision。正式 host 的可选 `permissions:{filesystem:'workspace_write'|'full_access',network:'none'|'internet'}` 是准确本次范围请求，省略时为 Workspace/无网络；Tool 原样传 Job，低层 Job 仍只消费 `{command}`。请求批准可直接派发默认范围的不透明 Shell，外部写入/网络由人工审批；Auto 使用原真实 reviewer，Full 普通范围为 Full/Internet，固定危险拒绝先执行。Core `markDispatching` 接受权限/controlReads 后传原 `dispatchAuthorization`；Service 从 `builtin.permissions@1` 的可信 executionScope 逐维求父子交集。旧可信无 scope 叶只保 mode ceiling：Full 为 Full/Internet，其他为 Workspace/无网络，不据人类批准扩大旧调用。空、未知或损坏策略拒绝。原 allowed=false 可表示最终接纳的审批挑战，快照本身不能签发授权。

[Agent Shell 命令分析](../../packages/agent/src/permissions/shell-command-policy.ts) 使用固定官方 `web-tree-sitter`/`tree-sitter-bash` WASM，只接受有限字面量 AST；不透明命令不证明安全。独立扫描原关键系统删除/Git 固定拒绝，语法错误后仍扫描前面的字面量命令，未知参数保原位置；不声称识别全部动态危险程序或 Windows 原生语法。解析资产 canonical path/SHA 进入配置与 command digest，每次授权和真正 Job.start 重核，并加入只读资产。相同命令授权还绑定准确 scope、cwd/env、配置、执行资产和现行控制读集；失败不自动扩大范围重放。原 explicit 无 host 工厂继续原 POSIX 语义，不取得正式范围资格。

read/wait 只读原执行，沿用分页游标、高水位和 gap；wait 超时不停止。stop 只提交原取消，默认 macOS 使用真实 coalition 全树停止证明，显式 POSIX 仍只用原组证明；unknown 不改写成功。原 Command 重试不启动新进程，新父 Execution 不能重绑同 key。后台原 binding 的 Core lease 保持到监督收尾，后续配置/新 Run 不覆盖原快照；cold GET 保持原输出与终态且不启动旧 handle。

[test/isolated/shell-configuration.test.ts](test/isolated/shell-configuration.test.ts)验证实际 SDK/SQLite/guardian、cwd/env、read/wait、真实 Auto 请求人工决定后的独立 Tool/Job 审批、请求批准外部写入/网络独立准入、实际 Auto 拒绝原因、三策略固定危险拒绝与零进程效果、强制 stop、后台原绑定及单槽跨 Session。持久权限另核根及默认 Task 子 Agent 的 Full 外部写、独立批准前零效果、批准后的 Workspace 范围和原 Command 不重放；直接可信 Job 适配器测试核嵌套混合策略取较严格范围，以及缺失或未知叶在进程效果前拒绝。源码树外[默认能力消费者](../../tests/isolated/unified-agent/formal-optional-capabilities.test.ts)和[平台 probe](../../tests/isolated/unified-agent/unified-platform.test.ts)核默认 Provider/Job、完整输出、processTreeStopped、cold 同结果/零重放。实际 fork/setsid、父退出、原身份信号和路径/网络边界归 [Jobs owner](../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)；显式 POSIX 与固定 confined 仍保各自有限证据。默认开放不宣称全部资源、跨平台或 production release 资格。

可信 command digest 固定 Tool/Job kind/definition/version、准确 command、attached/detached、host configuration/范围、canonical cwd、克隆 env、实际 guardian/Bun/Shell bytes hash 及 grace/output queue；只排除新的 operation key。默认值与 Job 一致：200ms、256KiB。Core 不按 Tool 名猜命令或剥字段，非 Shell 仍使用完整 input digest。相同命令只在当前 policy 提供 same_command 且最终权限/epoch/必要义务仍成立时复用，Tool/Job 授权独立；环境、范围或命令改变仍需重新核对。

## 配置准备清理交接

[assembly](src/assembly.ts)和[默认resolver](src/configuration.ts)在已经取得资源后准备失败时，独立尝试自身原disposer；清理再失败使用Agent的 `ConfigurationPreparationCleanupError({originalError,cleanupError,resources})` 交接实际Files／assembly／scope。原错误与清理错误保在非枚举cause，不进入HTTP DTO；普通配置拒绝且清理成功继续按原错误处理。资源保留、五个resolver接收点、恢复lease及shutdown门禁由[Agent生命周期owner](../../packages/agent/src/lifecycle.README.md)负责，Service只作producer装配，不能凭未知关闭交接Profile维护权。

[完整准备回归](test/isolated/preparation-cleanup-ownership.test.ts)从正式Service／Client原Command进入受支持的trusted resolver／standalone assembly，实际打开目录，因必选Skill缺失而准备失败；故障只让该原实例JavaScript close在原native close之前拒绝，目录仍可完整读取，Model／Run／Execution均未开始。关闭失败与维护owner_busy保留，测试自己的child实际退出0及双EOF之后才可公开backup／冷读原完整metadata／View／Command／Message／Execution，零重放。它不依赖已删除的默认重复FD，也不把fixture错误称真实OS API故障；全部资源观测、临时I/O全部失败路径及平台资格仍按进度保留。

[显式恢复准备回归](test/isolated/recovery-preparation-ownership.test.ts)经正式 SDK 分别调用 Run resume、Job report resume 和 Job reconcile，直接核三个 resolver 返回前的同一实际目录清理失败。原 Run、Job、report、审批与完整消息不推进或重放；Run／Job 的新恢复 Command 已受理，report 的新恢复 Command 尚未提交，公共错误均为 `configuration_cleanup_unconfirmed`。Service／Runtime 关闭实际拒绝后，独立 Store 仍不能取得原 Session owner，维护仍拒绝；自己的进程实际退出 0 与双 EOF 后，才允许公开备份和完整原数据冷读。路径使用平台中立接口，本机结果不授 Win/Linux 实机资格。

## 默认 Web Fetch 装配

默认 resolver 通过 [web-fetch-configuration.ts](src/web-fetch-configuration.ts)装配普通 `builtin.web@1` / `web_fetch@1`。`createDefaultProcessConfiguration({webFetch?})` 只接受可信宿主的 network policy/admission 与可选 extractor；缺省开发网络策略为 public，仍逐跳检查全部 DNS 地址、拒绝私有/保留/本机目标并固定真实 socket。显式 off/allowlist 与当前宿主 `admitHop` 继续约束原请求、robots 和每次跳转，普通 Tool 仍独立经过 Core 的当前授权。实际元数据为 `network`/`unknown`、`safeRead:false`，off 为不可用；每个新 Run 封存准确 Tool 版本和非秘密 `snapshot.web`。JSONC 仅选择 Tool 与准确版本，不能提供网络权威、代理 header 或 SSRF 例外。工厂创建不进行 DNS、解析或网络 I/O。

正式 Run resolver选择Agent提供的被动 Web binding，工具目录投影继续使用无I/O元数据；实际 parser scope只在授权派发后取得。Run disposer缓存同一结果，独立收尾原 Files assembly和Web scope；一个失败不跳过另一个，原配置错误与清理错误同时保留。Worker登记、封门、取消、原收尾及共享robots／origin队列由Agent负责，Service仅组合接口。没有 `bind` 的custom extractor仍由宿主管理，不借Run关闭权。原执行中清理未知会保已有Run lease；assembly或resolver准备／清理双失败另用Agent公开ConfigurationPreparationCleanupError移交实际资源，Runtime只接收该准确类型并保原配置清理预约与严格门禁。

[默认 Web Fetch 回归](test/isolated/default-web-fetch.test.ts) 3 项、32 条断言使用真实 Service/Client/Core/SQLite、本机兼容 Model 和无害 HTTP：四次 socket 前均有实际审计，完整约 125 KiB 正文通过原 scope Artifact 读回并进入下一 Provider 请求；off/当前撤权为零 DNS/socket，原 policy 修改不扩范围，坏 JSONC options/版本在 Provider 前拒绝。完整解析 Worker 属于已构建并核 hash 的包内资产，缺失时局部失败。真实 TLS、Linux/Windows 与原生制品资格仍按进度记录。

[permission-management.ts](src/permission-management.ts) 是 Native 宿主的持久用户控制 port：`readMode/readTrust/setMode/setTrust/getMutation` 都要求明确原 `expectedStoreId` 与宿主注入的 `subjectId`；写入还要求稳定 `commandId` 和已观测 revision。模式仅接受 `accept_edits`、`auto`、`full`；请求、持久控制记录和最终 Shell 证明中的旧 `ask` 明确拒绝，不兼容映射。模式记录作用于准确 root Session，child 读取继承根模式但不能以 child Session 修改；`makeDefault` 只更新同一 Store/subject 的后续默认，不写项目 JSONC。信任记录作用于准确 Workspace/subject。控制 journal 与配置/凭据 journal 同库但 kind 独立，双方 getter 不将另一类记录强制转换为自身 mutation。

Trust 两个 hash 来自宿主重读的实际文件身份：Workspace canonical path/dev/ino，以及当前可信额外读取范围。已存在且安全的 profile `skills` 根目录计入外部范围；明确装配的 macOS Native Shell 描述宿主权限允许的广泛读取视图，不能冒充文件系统沙箱。请求中的两个 hash 只是用户已经观察的 CAS 条件，不能提供路径、readScopes 或扩大范围。Git metadata、目录 mtime 或普通文件修改不撤销信任；根目录替换、profile Skill 根身份或额外范围改变显示 `scope_changed` 且 `trusted:false`，需明确重新观察和确认。缺记录默认未信任，未验证旧 Store 的控制事实不成为当前 Store authority。

默认进程 `main` 在 Runtime 创建后调用 `permissionManagement(runtime)` 并交给 Native Service。显式宿主 `permissions` 或 `permissionPolicy.readPolicy` 持续优先，管理 port 拒绝写入其 authority，返回 `permission_authority_external`；它不把程序策略改造成 UI 可授予的策略。普通默认授权每次读取原 Run Session/subject 的 mode、用户默认 mode 和 Workspace trust，同时将三项准确 `controlReads` 交给 Core。最终 `markDispatching` 短 SQL 事务重新核对当前控制 revision，因此在最终授权读取之后撤销 trust 或修改 mode 也不能让旧 proof 派发。操作只修改控制事实，不倒转已执行效果、不停止 Service、不伪造一次性批准；Full 仍受硬能力及 trust 门禁。

[权限控制测试](test/isolated/permission-management.test.ts) 使用真实 SQLite Worker 与同 Loop child 验证 CAS 并发、同 ID 原回执、重开、Store/subject 隔离、默认模式、child/root 读取及禁止 child 写入，以及真实 root 替换、profile Skill 范围变化和 Git metadata 不撤信任。[默认配置测试](test/isolated/permission-configuration.test.ts) 增加实际 SDK/Core 文件效果：持久 Accept Edits 无卡执行、撤销 trust 阻止旧 Ask 卡接纳、显式宿主 authority 禁写，以及最终授权到 SQL 派发之间的撤销得到 `permission_control_changed`、零 dispatch/adapter/文件效果。固定本机响应不调用付费模型或用户凭据。这里交付持久用户模式/trust 与默认装配，same_command/grants clear 的当前事实见下段；正式 CLI/TUI/Desktop 全量入口和平台发行仍按进度验证。

可选 Native `permission_grants` 暴露 `GET /v1/sessions/{id}/permission-grants` 的具名 keyset 页和同路径 `POST` 清除；只接受原 Store、游标/upper/limit 或 `{expectedStoreId,commandId,ifRevision}`。目录属于实际 Session，不继承 root/child 的授权；原 accepted Interaction、决定版本、definition/kind/digest/Execution 保存为只读出处。epoch 来自授权/清除变化事实，新增授权也推进；clear 短事务最终核原主体、准确 Session 和观察 epoch，并写同 HostMutation 原回执。清除不隐式扩散到 descendants，creator 仅能管理已核实自己有权的准确 child。GET/POST 均 no-store/nosniff，Browser gateway 不转发。坏身份/游标、隐藏 authority 和 CAS 冲突拒绝；响应丢失只查询原 mutation。CLI 与实际 Native 目录/clear 消费者已验证，原审批共享组件只有原卡提供时才显示同命令选项；完整正式 TUI、installed 和三平台资格仍 pending。

Native 绑定该 manager 后提供 `permission_controls` capability。读取 mode/trust 必须携带明确原 Store，写入携原命令 ID、已观测 CAS revision 与闭合 body，主体只由宿主注入；Browser gateway 不开放这些写入口。当前有限接口为：

| 方法与路径 | 事实与边界 |
| --- | --- |
| `GET /v1/sessions/{sessionId}/permission-mode` | 准确 Session/root scope、当前模式与该主体用户默认 revision；child 仅继承读取 |
| `POST /v1/sessions/{sessionId}/permission-mode` | 原 root Session 模式 CAS；可明确 `makeDefault`，同时核原默认 revision |
| `GET /v1/workspaces/{workspaceId}/trust` | 宿主实际两 hash、有限读取范围说明与 trusted/untrusted/scope_changed；不推断授权 |
| `POST /v1/workspaces/{workspaceId}/trust` | 核已观察的身份/scope/revision，再将确认或撤销写入原 Store journal |
| `GET /v1/permissions/mutations/{commandId}` | 原权限控制 journal 回执；不重新执行，不改绑 Store，不投影配置或凭据 mutation |

[Native HTTP/SDK 权限测试](test/isolated/permission-http.test.ts) 当前 6 项／63 个断言通过，包含真实默认 Store 冷重开、CAS/身份拒绝、零执行副作用、物理丢失写响应后仅查询原命令 ID，以及闭合请求不接受客户端自造主体或范围。mode/trust 的底层读取与默认授权只读取有限 Session 元数据和控制记录，不依赖大历史/Execution 正文；独立测试将 `Runtime.getView` 明确设为禁止仍完成管理链路。

可信宿主还可显式传入 `planning.automaticValidation`，声明准确 mutation definition/version/effects 与 `fileHashChecker`。当前资格仅为 `files.write/edit@2` 的 `workspace_write` 与 `files.read@3` 完整 baseline；这些实际 Tool 必须由普通配置选择，`validation.auto_check@1` 也是普通已选 Tool，不为验证旁路注册或授予能力。已选 mutation 的版本/effect 与真实宿主元数据不一致，或已选 checker 不是准确 safe-read 定义时，在 Provider 前局部拒绝。JSONC 不能启用此策略、替换 checker 或补造 mutation 权威。

这个开关独立于 `requirePlan`/`requiredValidation`：启用后在首次 Model 派发前封存原 `mutation.required` policy/ref，Run snapshot 保存可信映射及当次实际 selection/effects；后来修改调用方 options 不改变它。缺省关闭时普通对话不增加义务。每次实际 mutation 令旧 head 通过事实失效，停止意图触发普通 auto-check，再由 `operations.ensure` 派发准确 Files read；三者分别经过当前权限与原 Store/Execution/source 校验。只有真实完整 hash 检查和当前 head 的 CAS 事实满足原义务，不以管理 Tool 的 succeeded 回执代替验证。移除后续工厂开关不消除旧 Run 封存要求；缺 checker 或撤 trust 不能标 passed。

[默认自动验证测试](test/isolated/automatic-validation-configuration.test.ts) 使用本机 compatible SDK、临时 SQLite、明确持久 Full 模式与 Workspace trust，覆盖无 plan flags 的实际写入 → auto-check → 原父 Execution 下嵌套 read → completion、第二次 mutation 使旧通过失效、默认关闭且 JSONC 无权启用、缺选中 checker/卸后续工厂仍保原义务、撤 trust 零 checker 效果，以及错误 mutation version/effect 在 Provider 前拒绝。该证据不声明 Shell network-off、MCP 验证、外部检查器或任意非合作写入与 SQL 提交原子化；完整事实与修复规则由 [planning owner](../../packages/agent/src/business/planning/README.md)维护。

## 完整 Workspace/Session 目录

新增 Native GET `/v1/workspace-directory`、`/v1/session-directory` 使用 closed query：`storeId` 必需，`afterSeq/upperSeq` 为规范 Decimal64、`limit` 最多 200；Session 可加 `workspaceId`，过滤在 SQL 分页前完成。响应保留每项分配 seq、固定 upperSeq、highWaterSeq、nextAfterSeq 与当前 snapshotCursor。旧 `/v1/workspaces`、`/v1/sessions` 仅提供原当前页语义，不能证明完整目录。

Cookie Gateway 对应两个 `/browser/v1/*-directory` 只读路径，由原准入身份填 Store，不接受浏览器自报 Store/subject；Workspace 投影继续移除 rootUri。Workspace 按原认证 profile 范围包含空 Workspace；Session 按真实 root 创建 Command 的原 Store/宿主主体隔离，child 不作为顶层目录。封存 upper 不接纳之后新增项目，但跨页不是标题/删除的长期 MVCC 快照。[真实 SQLite/HTTP 目录测试](../../tests/isolated/unified-agent/directory.test.ts) 覆盖超过 200 项、原身份、多主体、固定上界及零 Model/读取写入。


Settings 模型业务端口为 `GET /v1/config/user/models?storeId=...` 和 `POST /v1/config/user/models`，Native Client 对应 getModelSettings/updateModelSettings。workspace 模型 GET/POST 明确返回 model_settings_user_scope_required；user 不接受 workspaceId。观察返回原 Store、user scope、读取集 `{userEtag,workspaceEtag:null,explicitDigest,effectiveDigest}`、默认模型与安全事实。configured 只表示当前 SDK binding 的结构/endpoint/options/reference 合法，不证明 key 或远端模型可用；错误保留 readSet:null，不伪造写资格。

模型业务请求冻结原 command/Store、user scope、expectedReadSet 和单一 enabled/default/effort 操作。服务核完整用户模型候选：默认模型不能直接禁用，默认只能选择启用且 configured 的 route，其他条目/注释/未知字段保持。没有项目模型层；可信宿主覆盖导致操作不能生效时明确拒绝，普通 JSONC 不可路由期望值仍与模型设置业务约束分开。

模型目录为所有配置可用的模型投影六档 `low/medium/high/xhigh/max/ultar` choices、当前 reasoningEffort 和只读原因；不按 Provider family、名称或 `reasoningSupported` 标记过滤。完整请求、配置、快照与 mutation 枚举另保留已有 none/minimal。`compatible_wire` 表示当前统一适配器可编码，远端接受情况由实际请求决定；ultar 不改写为 ultra 或 max。配置不完整和可信宿主 options 覆盖仍保原写入门禁。effort 保存保留其他 options，null 清除该模型的用户级 override；既有 provider effort 可重新成为有效值，结果以重读为准，不涉及项目继承。活动 Run 保持封存值，后续 Run 使用新配置。


目标配置原 ETag 和完整读取集合在真实目标文件短锁内重核，候选通过结构/default 规则后，发布前再核非目标文件与宿主 explicit/effective digest。读取集合竞争返回 `configuration_read_set_conflict`，不会覆盖竞争编辑。锁约束合作宿主对同一目标文件的写入；不同文件或不合作外部编辑在最终核查之后仍有跨文件竞态，文件/vault/SQLite 不是一个事务。没有向 HTTP 开放验证回调或路径。

新模型 mutation 使用 config.user.write journal 与有限安全 modelSettings marker，公开投影为 model_settings.update、原 scope/ifMatch/readSet/operation 与 ETag。历史 workspace marker 仅用于原结果查询，不再接纳项目模型新写。断线或坏回执只沿原 ID/Store GET，不重放。真实 paired HTTP 回归覆盖默认约束、用户文件竞争、冷原回执与物理丢失响应；held Run 保持 A，新 Run 使用 B，保存/读取不制造 Provider 请求。


二进制 Artifact 响应以 `x-artifact-store-id` 返回实际不可变 reference 的原 Store。请求 `storeId` 校验当前已准入 Store，恢复媒体的原引用不重标成当前 Store；准入与原内容授权仍由 Runtime 实际 Session/owner 链完成，HTTP没有按 hash 另开访问路径。

有限生命周期接口使用可选 `service_lifecycle`：认证 Native 的 `GET /v1/lifecycle` 和 `POST /v1/lifecycle/shutdown` 独立于业务 Store 准入，Browser gateway 不映射。接口拒绝任何 Origin（包括空值）、额外 query 和未知主体字段。状态仅公开 `lifecycleVersion:1`、原 profile/instance/build/API major、实际 capabilities、真实数据可用性及 `accepting/draining/closed/drain_failed`、去重 busy reasons，不返回 Store 对象或凭据。Store 故障可读原实例诊断，不能建立替代空 Store。

关闭请求固定原 profile、instance 和 `if_idle/cancel`，不携业务 storeId。`if_idle` 同步重核已接纳 HTTP mutation 与 Runtime 工作后封门，竞争时返回 409 并保持接纳；普通 View/body GET 与 SSE 观察本身不算活动工作，但其资源使用仍延迟 Artifact/Store 关闭。慢请求正文和异步配置写入受 HTTP 接纳与解析后重核约束，不能穿过 drain 产生新修改。前期 drain 保留原读取/准确 cancel；Runtime 本地清理成功、关闭资源之前的唯一可信 callback 先封住最后业务资源入口，再调用装配时固定的宿主 `beforeResourceClose`；宿主可在此关闭 Gateway、abort 并排空其所属读取，随后 Service 等待原 Native HTTP 资源使用清零，最后才释放 Runtime Artifact/Store。先等待 Native HTTP 再关闭依赖它的 Gateway 可能循环等待，因此该顺序由真实 Gateway→Native held GET 的 abort barrier 验证。生命周期诊断仍可达，宿主回调失败进入 `drain_failed`，保留 HTTP、原 Store 和 profile-use 锁；重复关闭不替换或再次执行首次回调。

202 仅表示关闭受理。首次关闭缓存同一 completion，失败进入 `drain_failed` 并保持 cleanup busy、HTTP 诊断和未确认资源；不得在 finally 强制停止 listener 伪装完成。成功关闭后 runner 取消自己的父管道读取并真实退出，即使父管道仍打开；网络断开不代表父进程死亡。丢回复属于原实例未知结果，只能再次观察该实例，不自动重发 shutdown。当前仅有限接口与所属 runner，不代表正式 CLI 停机或 daemon 发现完成。

底层 Store strict-close 未获成功 ACK 时，[原 Store owner](../../packages/agent/src/storage/README.md#store-关闭未确认时的锁归属)保留 Session／恢复／Profile 使用锁，Service 的 `drain_failed` 不能让维护提前接管。[真实共用装配／Client 回归](test/isolated/store-close-ownership.test.ts)保原完成任务和全文，核关闭原错误与同一 completion、存活进程期间维护 `owner_busy`，原 child 实际退出后才允许备份和完整冷读，零新增 Model。该 fixture 的进程退出是测试收尾，不宣称失败关闭已成功或 Worker 线程的完整资格。

[默认Web清理所有权回归](test/isolated/web-fetch-cleanup-ownership.test.ts)使用正式装配、Client、本地固定Provider和实际默认parser；只让所属child的parser JavaScript terminate失败，保原Tool未知及Model恰一次。Service／Runtime均拒绝关闭并保 `drain_failed`、活进程期间维护 `owner_busy`；显式结束该测试child并核实际0及stdout／stderr EOF后，公开备份和只读冷查询保完整原metadata／Command／View／Message／Execution、Model零重放。此可三端运行的源码测试不增加skip，不冒称真实OS API失败；本机结果仍只授macOS实际范围。

[实际 HTTP 与 runner 生命周期测试](test/isolated/lifecycle.test.ts)使用临时 profile/SQLite 和固定本地配置，覆盖闭合身份、空/同源 Origin、Browser 拒绝、慢正文、原配置 mutation 发布、慢纯 GET 排空、真实 Store metadata 故障、父管道仍打开时原 PID 退出与同 profile peer 存活、诊断无 Store 退出，以及未确认清理后原进程/HTTP 保留且维护仍 `owner_busy`。这些测试没有调用 Provider/Tool；失败 fixture 最终由测试的所属子进程清理回收，不把 SIGKILL 作为成功停机证据。

[共用进程装配测试](test/isolated/process-service.test.ts)覆盖原 profile 身份、装配过程中迟到的宿主回调替换、冷 Store 零模型执行和损坏 Store 的只读诊断；[Gateway 测试](test/isolated/development-web.test.ts)覆盖重复关闭同一 completion 与 abort 后真实慢读取排空及完整 17 MiB Model 正文的读取/传输中断，[生命周期测试](test/isolated/lifecycle.test.ts)同时保留配对父 EOF/管道存活验证，并通过真实失败宿主 child 证明诊断、Store 和维护锁保留。此共用装配不代表 daemon main 或正式 CLI 命令已经完成。

本切片的共用装配、Gateway、生命周期、paired 与真实 Model metadata 组合回归为 27 项测试、263 条断言；Service typecheck、文档结构/影响和测试 ownership 检查通过。测试只使用临时 profile、固定 Model 或本机兼容端点；17 MiB 正文生成沿用原 Agent 大正文测试的有限等待，不改变产品关闭期限。

装配失败时，只有原资源清理成功才重抛原错误。Runtime 构造后的 Artifact/Store 清理或 HTTP 装配后的 Runtime 清理失败，均抛出有限 `ProcessServiceCleanupError`，其 `code` 为 `process_service_cleanup_unconfirmed`，`phase` 区分 `runtime_assembly/http_assembly`。非枚举 Error cause 保留原错误和有限资源强引用，JSON 仅投影 code/phase；宿主不得发布或记录内部 cause，应保持所属进程和 owner 保活，不能把尚未返回 Service handle 当作资源已经释放。没有重试或重新打开接口。

装配清理回归使用真实隔离 SQLite/Worker：管理工厂故障后实际 Runtime 最终 hook 失败，原 metadata 仍可读且维护返回 `owner_busy`；清理成功保留原错误对象并允许实际备份取得维护锁。Runtime 构造的重复定义错误也验证原 Artifact/Store 成功释放。构造失败后 Artifact/Store 自身 close 再失败的标记分支已实现，本切片未单独注入该底层失败，也未为它增加生产 FactoryPort。


## 显式 daemon

[daemon-main](src/daemon-main.ts) 与 paired [main](src/main.ts) 共用 [process-service](src/process-service.ts) 的一次 Store/Runtime/HTTP 装配。daemon 的启动 stdin 是有限单帧，EOF 不代表退出；原 profile、canonical Workspace、build 和 native owner 在首次启动固定。[私有 daemon 叶子](src/daemon/README.md)只作发现与准确资源所有权，业务仍走公共 Client。默认 endpoint 与显式 socket 保留各自原 record 路径，不把默认地址重新解释成显式地址。

POSIX reservation 的[原 FD 发布与读取序列化](src/daemon/README.md)保留准确 inode、坏记录拒绝和原 5 秒 bootstrap 总期限，不扩展公共协议或读取权限。

启动前以 [web-assets](src/daemon/web-assets.ts) 校验所选三个 Web 文件及闭合 manifest，不执行宿主提供的 assets 模块；restart 的[预检](../../packages/agent/src/sqlite.ts)在目标子进程只读检查已有 Store，零 Runtime/Model。普通 start 直接进入正常装配，Store 打开失败仍保留安全身份与 HTTP 诊断，不把格式预检变为全局 ready 门槛。有限 preflight 回复经闭合 schema 核对原 profile/instance/build；预检不免除随后正常启动准入。Web Gateway 固定封装本构建的 [API Docs](src/api-docs.ts)与完整 OpenAPI，纳入页面内容身份，不接受外部文档覆盖，也不携带认证信息。

最终关闭先封 HTTP 新准入，再关闭 Gateway、abort 并等待所属请求/正文读取，最后关闭 Runtime/Store 与原 native endpoint。装配与清理双失败通过有限 marker 保留资源；[process-failure](src/process-failure.ts)明确保持原进程存活，daemon 不移除 reservation。该分支没有成功 HTTP handle，不能宣称已有诊断 listener 或成功关闭；它只输出 code/phase，不输出原错误、token或资源。

Windows x64 已接当前SID私有pipe/record和准确kernel process HANDLE到同一正式用户链，原16KiB/64连接/5秒bootstrap及HTTP准入保持。候选Daemon和只读preflight在endpoint/Store前取得自身SH/完整文件pin，正常endpoint收尾后才释放；配套Service仍取得独立使用权。原pipe I/O、record或候选Close未确认时，trusted native marker保活并强持原owner；safe漂移拒绝则完成可确认的原HANDLE关闭并保留未知对象。具体安全策略和测试归[Daemon leaf owner](src/daemon/README.md)，[安装版资格链](../../tests/fixtures/unified-agent/windows-daemon-qualification.ts)必须经原kite.exe完成reuse、current切换、真实共享Model、busy/明确cancel、实际原birth退出、冷历史和最终EX。Windows原生尚未执行，Shell/stdio MCP、Native与TUI PTY仍各自独立未闭。

[真实 daemon](test/isolated/daemon-process.test.ts)在临时目录构建所有公开 manifest entry，再运行编译子进程，验证父 EOF 存活、原身份、Cookie Web/API Docs、busy/cancel真实停止、坏 Web/未来 Store 预检保原服务与数据库字节。[装配失败进程](test/isolated/process-cleanup-retention.test.ts)验证双失败后断开父管道仍保活、原锁busy与reservation保留。CLI 的实际编排证据归 [CLI owner](../cli/README.md)。当前本机 macOS 证据不等于 Linux/Windows 或正式发行资格；设计理由见[私有 bootstrap Note](../../.agents/notes/implemented/architecture/2026-10-02-daemon-private-bootstrap.md)。

## 显式冷报告恢复

专用 `POST /v1/sessions/:id/job-reports/:reportCommandId/resume` 只接受原Store和恢复申请commandId，主体由认证派生，调用Runtime的根Session有限 `resumeJobReport`。返回新的 `job.report.resume` Command，receipt说明原报告、实际Run和恢复/抑制事实；受理不表示模型完成。Browser不获得恢复写权限，读取历史、连接及启动不会触发该入口。

默认宿主用专门 `resolveRecoveryRunConfiguration` 固定原manifest中的modelId与Skill选择，并先比较原配置digest，再读取凭据。根 Run 恢复沿用原根工具选择和 Planning/Workflow 快照；携带持久 Model/Skill 选择不把它改为 child，只有新建 child binding 才排除 `ask_user`。原模型参数/引用或支持配置变化时局部拒绝；普通默认模型变更不能偷换旧绑定。[配置冷恢复测试](test/isolated/configuration.test.ts)验证原模型与 `ask_user` 定义保留、配置变化在凭据及 Provider 前拒绝；[实际 child 测试](test/isolated/ask-user-configuration.test.ts)另核继承和显式角色都缺少问题工具。Core仍核完整注册manifest和当前afterTurn权限，实际派发仍走原权限/来源检查。没有匹配原版本时保留历史，不自动安装或调用当前默认模型。此能力只恢复已有真实报告的安全推进边界，不宣称一般Run恢复或adapter reconcile已实现。


## 显式 Job 核实

`POST /v1/sessions/:id/commands` 的 `kind:"job.reconcile"` 请求只含 `expectedStoreId`、新 `commandId`、原 `executionId` 与 `expectedResultRevision`；主体来自认证，路径固定原根 Session。`job_reconcile` 能力仅由实际 Runtime 方法发布，不能通过 host capabilities 自报。该接口支持查询某个原 Job，不表示每种 adapter 都可核实。

闭合 `JobReconcileCommand` 区分 accepted/receipt:null 与 applied 的核实回执；`verified` 必须同时具有已知业务结果及监督 ended，其他事实为 unresolved。回执标明 adapter_reconcile 来源，不冒充原实时回执，原 Execution 状态/结果/revision保留。新申请可观察已登记的原 proof；同 ID 查询中不再访问外部任务。当前默认 Shell/MCP 无可靠冷核实能力，普通配置不会自动授予核实权限；可信程序宿主显式提供 `authorizeJobReconcile`，必要时提供精确 `resolveRecoveryJobConfiguration`。配对/daemon 装配透传这些可信函数，JSONC 不提供代码或授权。

[真实 HTTP](test/isolated/job-reconcile.test.ts)核冷 SQLite/外部 ledger、物理丢回应后的原 GET、查询在途的同 ID 回执及 CAS拒绝；网络断开不把核实改成 start，不自动重发。Browser 不获得恢复写权限。


## 显式活动 Run 接续

`POST /v1/sessions/:id/commands` 的 `kind:"run.resume"` 只接受 `expectedStoreId`、`commandId`、`runId`，根 Session 来自路径、主体来自认证。closed schema 拒绝客户端 owner/generation/origin；服务端读取真实 Session generation，同 ID 则取原内部申请的 generation 保持幂等，最终仍由 Core/Store 复核原 Store、主体、Session、Run 和摘要。`run_resume` 只由实际 Runtime 方法发布。它接续仍活动且安全检查点完整的原根 Run，不先中断原 Run，不重新开始一个任务。

返回闭合 `ResumeRunResponse`：accepted/null 只表示申请已登记；applied/run_resumed 包含原 Run、原工作 Command 和实际接续边界，仍不表示 Run 完成。默认宿主复用准确 `resolveRecoveryRunConfiguration`，配置、初始化或检查点无法核实时明确拒绝，不改用当前默认绑定。Browser 没有此写权限。物理丢回应只查询原 Command；[真实 HTTP 测试](test/isolated/run-resume.test.ts)使用所属子进程 SIGKILL、固定 Model 和隔离 Store，核对原审批、一次 Tool 效果、同 ID 及其他主体拒绝。完整恢复限制归 [Runtime owner](../../packages/agent/README.md)。


## 显式遗留执行组中断

`POST /v1/sessions/:id/commands` 的 `kind:"session.recover"` 请求只含 `expectedStoreId`、`commandId` 与 `decision:"interrupt"`；路径固定原根 Session，主体来自认证。`session_recovery` 只由实际 Runtime 方法发布。服务读取真实 owner generation，同 ID 使用原持久申请的内部 fence；客户端不能选择或扩大该权威。Core 仍取得原 OS 锁并在原 Store 事务复核主体、摘要和执行组，不向调用者授予普通 owner。

返回 `RecoverSessionResponse` 的 applied/session_interrupted 回执，只投影准确原 ID 集和观察水位，省略内部 previous/current generation 与 lease。可证明未派发的工作取消，可能已经产生效果的调用保持 unknown，partial 和原结果来源保留；中断不证明外部效果停止。查询原 Command 复用相同公开投影，纯读不再进入恢复。物理丢回应仅查询原 ID，不换 ID 重发。[实际强杀测试](test/isolated/session-recovery.test.ts)覆盖原 Tool ledger 与截断 Model、live/frozen OS lock 拒绝、同 ID 回执稳定及跨 Store/主体/Session 拒绝，零新增 Model、授权或工具效果。私有 fence 与公共原意图的取舍见[决定记录](../../.agents/notes/implemented/architecture/2026-10-03-public-session-interruption-projection.md)。

## 宿主只读诊断

[host-status](src/host-status.ts) 由默认配置工厂的真实装配产生，经 process-service 单独传给 HTTP，不进入 Agent Runtime。`GET /v1/diagnostics/host-status` 的闭合 query 只接受已有 `workspaceId/sessionId`，主体由认证派生。响应固定实际 instance/build/API、profileAccessKey、Store 可用性及原 scope；可选 `host_status` 能力只能由实际 source 发布，普通 capabilities 数组不能自报。缺 Store 仍保留安全诊断，权限段明确 unavailable，不制造空业务对象。

默认 source 只读当前主体的默认/Session 模式和真实 Workspace 信任。Shell 检查不创建 Job/进程/模型：macOS 可信 host 报告 `macos_coalition/darwin_host_boundary` 与闭合 `macos_seatbelt/host_scope`，Linux 报告 `linux_pid_namespace/linux_host_boundary_unqualified` 与 `linux_bubblewrap/host_scope_unqualified`，显式旧 macOS options 报告 `posix_group` 与 `none/unqualified`。available 只表示当前资产及配置选择可用，不代表该请求已获准、GET 已实际核验后代或 Linux 原生资格通过。自定义权限权威无法核实时明确 permission_source_unavailable。未绑定发行 manifest 保持 production:null/release_manifest_not_bound；无 exporter 保持 disabled/exporter_not_configured，不从 buildId、JSONC 或工具目录推导生产资格。

诊断不调用普通 Run resolver、凭据后端、Provider、MCP 或 Skill 扫描，不创建 Workspace/Session/Command/Run，也不修改 SSE 游标。公开 DTO 不包含凭据、路径、endpoint、环境变量、正文或内部 owner。CLI 显式信任的独立 mutation 与诊断 GET 分开；实际派发仍使用原权限和来源门禁。

[真实HTTP诊断](test/isolated/host-status.test.ts)核默认装配、当前控制变化、坏配置、不可用Store、零业务写入/Provider/凭据访问与真实Shell资产；Shell共享检查另由[实际Shell回归](test/isolated/shell-configuration.test.ts)核正常派发不变。

[Linux 配置整例](test/isolated/linux-shell-configuration.test.ts)仅运行纯调用者装配，核准确 namespace／Bubblewrap 未获资格投影、零启动／FFI与四资产；[Client 诊断整例](../../packages/client/test/host-status.test.ts)核该闭合响应接受和伪造提升资格拒绝。生成的 HTTP schema／OpenAPI／Client validator 同步有限 Linux 枚举，不改变执行授权或 production 门禁。

## 有条件 Skill Workflow

默认每 Run 装配另读当前 profile 的 `skill-workflow.jsonc`，严格格式为 `{version:1,features:{skillActivation:boolean,skillWorkflow:boolean,verification:boolean}}`。缺文件三项皆 false；前两项同时开启才注册 Workflow，Workspace 或 Skill 文本不能打开这些开关。该配置的备份保原 JSONC 字节，由维护 owner 负责。知识 `selectedSkills` 与 Workflow 激活继续分开。

公开 Native `run.start/input.follow_up` 可携带 `extensionInputs:[{extensionId:"builtin.skill-workflow",definitionVersion:"1",input:{activations:[{key,skillId,input}]}}]`。Service 只在 Runtime 声明并实际有 resolver 时发布 `run_extension_inputs`；未知版本/扩展、重复 envelope/key、结构或输入 schema 错误、不可用原 Skill 和未启用开关在凭据与 Provider 前拒绝。省略与空数组保持原 Command 语义，steer 不接受。通用协议测试见[HTTP](test/isolated/extension-inputs-contract.test.ts)。

[`skill-workflow-configuration.ts`](src/skill-workflow-configuration.ts) 只编译同源可信目录的实际可用位置，编译前后核原 root/body，解析完整原 Workflow 契约；坏项仍局部不可用。实际 Tool/Job 的身份、风险与版本参与依赖封存，不接受 Skill 自报能力。纯 Workflow initializer 与 Planning initializer 顺序组合，在首次 Model 前建立不可变业务义务，普通 Tool/Job 沿用同一 Loop。完整业务记录与结果证明由 [Agent Workflow owner](../../packages/agent/src/business/skill-workflow/README.md) 负责。

fork 从原 parent Execution 和封存 parent Run 选择可信角色与准确版本。`activate_skill`、`repair_skill` 与真实 replan carrier 的 resolver 在回调内通过 Core 只读 scoped records 核原 activation anchor、CAS head、独立 attempt opening 和 fork opening；后两者必须绑定准确新 attempt、原 carrier Execution/input digest、原 Store/Session/Run、Skill revision 与角色版本。replan 另读原 decision 记录，waived head、旧 attempt、错 carrier 或缺原记录拒绝派发。resolver 仅封存读取的事实，不将已关闭的 getter 留给后来权限或来源回调；最终记录读集的事务复核由 Core 负责。实际 child Tool/Job 范围与父能力相交。原 Skill source/依赖在 child resolver、权限检查与 source capture 再核，审批等待中的漂移拒绝后续效果。Skill 最低审批从原 Run 范围的不可变 anchor 定位身份后叠加原可信策略，原硬拒绝不转为可批准；继承最低审批不改变 Model 权限。原 carrier 的特例只限准确角色、原 parent、Session/Store/root work，不放宽其他 Job。

可信 `skillWorkflow.userDecisions` 只由程序化宿主传入，默认 `{version:"1",allowWaiver:true,allowReplan:true,allowCompensation:true}`；宿主启动时深拷贝并冻结，JSONC、Skill 和模型无权替换。Workflow flags 缺省仍全部关闭，compensation 还必须有原声明和实际受限后端。完整 policy 进入原 Workflow snapshot，冷 resolver 在读取凭据前比较，后来修改传入对象不改写原绑定，冷恢复遇到 policy 变化明确拒绝。[隔离 policy 测试](test/isolated/skill-workflow-attempts-configuration.test.ts)核实际冻结与恢复前凭据边界；[真实 fork attempts 测试](test/isolated/skill-workflow-fork-attempts.test.ts)以固定模型、所属监督脚本和普通审批/question 验证 repair/replan 的独立 child、完整原输入与结果、原失败保留及新核验一次成功。完整范围仍按实施进度记录。

脚本核验仅在可信已核准 Shell 装配下注册普通 `skill.workflow.verify@1`。实际资产与非秘密环境摘要封存，模型不能传 command/cwd/env/path；执行前再次核原资产。脚本从原 Skill root 执行，修改该目录内已封存文件会被来源复核拒绝。配置与发现本身不启动进程。核验与 fork 的失败、未知、必要审批和结果始终留在原 Run/Execution；冷 resolver 在读凭据前比较原 Workflow 快照，不偷换现在配置。

macOS／Linux正式verifier均使用原host后端，原Skill cwd与授权Workspace分别捕获，scope核实际`skill.workflow.verify@1`最终policy，不能借`shell.command`的快照。Profile Skill在完整来源复核后只读暴露准确原子树与必要祖先metadata；保原相对资源及忽略目录读取，其余Profile／coordination、来源写入／移动及native exec-map仍受保护。Workspace来源保持原Workspace写范围。默认macOS已从group切到完整coalition；Linux源码接入私有tmpfs祖先链及原目录ro-bind，原生资格继续待验。普通Shell没有此来源例外，模型不能提供投影选项。

[正式来源整例](test/isolated/skill-workflow-profile-host.test.ts)经实际SQLite／Runtime、同一配置工厂、原extensionInputs激活、独立Tool／Job审批和原verifierproof，核Profile／Workspace完整Run及审批期间来源漂移零启动。正常drain后的完整原View／Run／Execution／records在冷只读Store全等，零新Model／Job；macOS已实际通过，同一文件的Linux分支使用真实编译init／Bubblewrap并核v2全部结束事实，尚未运行，不取得installed／HTTP／Linux资格。

声明补偿在实际macOS资产，或明确Linux native init／Bubblewrap资产、trusted policy与Workspace内原声明可用时注册`skill.workflow.compensate@1`。该独立Job始终minimum:user，显式策略硬拒绝仍优先；最低审批不会借原verifier或普通question许可。工厂封存保护整个dataRoot／coordination的受限配置与资产摘要，guard在普通派发前拒绝变更；固定Bun在原Workspace执行完整只读原资产，禁止网络和派生子进程，没有普通Shell fallback。Linux snapshot准确标`linux-bubblewrap-pid-namespace`，实际资格仍未执行；macOS标`macos-seatbelt`。compensated不满足原verification，unknown不豁免。[真实默认Service补偿测试](test/isolated/skill-workflow-compensation.test.ts)使用实际SDK/HTTP/SQLite、超过300KiB的完整审批附件，核一次脚本效果、拒绝零效果、原failed保留、repair attempt2重验和准确waiver；这是本机macOS范围，不是全部平台或正式客户端资格。

[真实默认装配测试](test/isolated/skill-workflow-configuration.test.ts) 使用隔离 profile、固定 loopback 模型与所属 guardian，覆盖原意图/初始指令、schema完成、child能力缩小、审批中来源漂移和脚本核验。CLI/TUI 动态命令与恢复、受限补偿和未完成的正式切换/平台资格分别按[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)记录，不能以本接口替代未切换的客户端行为。

## 同源 Skill 知识目录

[skill-source.ts](src/skill-source.ts) 为目录读取和 Run 装配提供同一真实配置解析。禁用项不读文件；缺文件、路径越界、重复物理位置、digest 变化、不支持 options 与缺能力按配置 ID 标记局部不可用。默认 Run 只绑定实际可用项并保存相同配置子集，显式名称/ID选择基于全部已知条目消歧，不能因坏项而悄悄改选同名可用项。child 继承准确原 ID；原项失效必须拒绝。绑定后的 canonical 文件目标变化同样拒绝，不能静默删掉原选择。单命令 requested 最多256项保持公开契约，默认解析出的 resolvedIds 不套此请求数量限制。

每次发现仍重新读取全部启用位置及内容版本；独立位置的 I/O 每批最多四项并发，结果按原配置顺序汇总后才发布绑定。完成顺序不决定重复物理位置的配置身份，原首项即使 digest 不匹配也保留其 ID，并将双方标为重复不可用。分页不缓存发现结果，后续页仍核当前字节与完整 revision。[目录测试](test/isolated/skill-catalogue.test.ts)覆盖同批别名、跨批重复、禁用项及新版本拒绝旧绑定；[Run 选择测试](test/isolated/skill-selection.test.ts)核准确 root/child 继承。

配置源使用同一[Agent 知识读取作用域](../../packages/agent/src/platform/knowledge-reads.ts)，资源 owner 独立于重建的 metadata Map。Run 的项目指令、Skill 正文／资源与 Workflow 读取沿原 assembly disposer 结算，准备失败沿现有 `ConfigurationPreparationCleanupError` 移交实际资源和两原错误。正文、目录、编译和取消 catch 先透传关闭未知；普通坏文件、缺能力和版本拒绝仍局部处理。Service 只组合原接口与错误，不执行知识文件 I/O 或建立第二份资源策略。

默认装配提供 [skillCatalogue source](src/skill-catalogue.ts)，Service 仅在实际 source 存在时发布 `skill_catalogue`。`GET /v1/workspaces/:id/skills?storeId=&afterId=&revision=&limit=&byteLimit=` 在原 Store、实际 Workspace 和持久信任范围下返回闭合 `SkillCataloguePage`：可用性、revision、metadata/status entries、nextAfterId 与 complete。没有source明确unavailable；坏配置不是空目录。响应没有正文、路径、凭据、任意宿主配置或 Workflow 契约，不构造 Run 或调用 Model/vault/Shell/MCP。

该任务外目录实例保有独立知识作用域；`dispose()` 封新调用，等待本实例已进入的普通／手动 Workflow list，然后结算同一 owner，失败不随后续请求重建而丢失。`startService` 将其接到原 `beforeResourceClose`；HTTP 读取尚在途时也不能先扫描一次失败集合就释放 Store／Profile。目录关闭未确认不会返回普通 unavailable 来表示收尾成功，服务关闭失败与维护锁保留。关闭前的临时 Workflow 装配同时保原工作错误和清理错误。

默认每项另返回有限 `source` 或 null：配置位置在工作区 `.agents/skills`、`.kite-code/skills` 或其他位置分别为 project/.agents、project/.kite-code、project/configured；已准入的 profile Skills 为 user/profile。来源只描述配置位置，不证明安装、物理目标或执行许可，禁用项不会因此读文件。越界、非法或不能确定的位置为 null；旧 producer 可省略新字段，消费者明确显示来源未记录。该信息参与原目录 revision，不增加发现路径或改变实际 Run 的知识选择。

目录按配置ID排序，默认128KiB单页字节预算、可选正安全整数limit与不超过1MiB的byteLimit；预算只分页，不截总目录或单项字段，单项放不下明确413。revision涵盖原主体/Store/Workspace、信任身份与revision、Skill配置、能力及完整目录版本状态；后续页必须携原revision，实际变化（包括配置变坏）409，不将新目录拼进旧页。未见afterId拒绝，不猜下一位置。读取不提供与外部文件写者的原子事务，也不预订未来执行版本。

目录的 `workflow=manual` 查询是独立 opt-in：只有实际 source 声明 `supportsWorkflow:true` 才发布 `skill_workflow_catalogue`，配置中的同名 capability 不能替代实现；不支持时该查询返回404。普通请求保留原闭合知识 shape、revision 与读取路径。显式请求的每项附带闭合 `workflow`：固定扩展身份、实际 compiled Skill ID/name/revision、独立 state/reason、manualAllowed、emptyInputValid 与 contextMode。可用只表示该次读取确认手动空对象输入可以准入，不是执行授权。

目录与 Run 绑定共用 `compileConfiguredWorkflows` 的真实源前后复核，以及 `workflowCapabilitiesFor` 的实际 Tool/Job/role 版本。投影另核 profile flags、完整输入 schema、fork 角色和脚本核验资产；关闭、坏契约、缺依赖或缺实现只改变相应 Workflow 资格。投影不包含指令、路径或完整契约，不选择模型、读取 vault、连接 MCP 或启动 Job；临时装配释放所属文件资源。flags、来源、依赖及宿主绑定参与 manual 分页 revision，变化拒绝续页。无 `workflow` 的旧知识请求不承担这次装配，也不因只改 Workflow flags 而换 revision。

目录不预订提交时的版本；实际 Command 仍由原 Service resolver 编译并封存可信源，后续漂移按原权限与来源检查拒绝。目录和单 Run 知识选择的原契约见前文及[同源目录决定](../../.agents/notes/implemented/architecture/2026-10-02-scoped-skill-catalogue.md)。[实际 HTTP 投影测试](test/isolated/skill-workflow-catalogue.test.ts)覆盖277项完整分页、局部失败、版本变化、零模型/凭据/执行，以及与正常原 Command 绑定的 compiled revision 相等；[旧接口测试](test/isolated/skill-catalogue.test.ts)保留旧消费者与缺实现 capability 边界。当前资格范围见[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[完整关闭未知调用者](test/isolated/knowledge-cleanup-ownership.test.ts)沿正式 Service／Client 验证必选 Skill 准备、实际 Tool 取消、普通目录、manual Workflow 原同步 fd 和在途目录关闭。故障只在实际原资源 close 边界拒绝；活进程公开维护拒绝，自有 child 实际0和双 EOF 后才备份并完整冷读零 Model。原正常项目指令、目录、Workflow、配置、取消与完整包回归保持。具体原红、准确输入及有限平台资格归[知识收尾进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13同源知识读取与正式目录收尾)，不提升为全资源／RSS或阶段退出。

## 默认 Task 的源码外资格

[task-packaged-default](test/isolated/task-packaged-default.test.ts)通过公开 terminal builder 与实际默认 paired Service，在独立 HOME/profile/cwd 和源码树外制品中验证 1/164/0fail。没有 configure、child、afterTurn、permission 或 resolver 注入；JSONC 只选择默认模型与实际 Task tools，原 Task 和独立 carrier 仍各自经过真实 Ask。after_turn 的原父、child、report Model 次数分别为 2/1/1，required 为 3/1/0 且父按真实 child 等待，background 为 2/1/0。完整 108042 UTF-8 字节 child 结果通过原 source 与 bodyHash 进入唯一报告，重复查询零新 Job、报告绑定或 Provider。两端正常关闭后所属 PID 结束，受封存 manifest 校验的制品字节不变。

这个实际默认制品证据补齐了此前仅 SDK/配置夹具的范围，尚不代表完整默认冷报告强杀、丢回执、多层或其他平台。原 requirements/report/history 来源核对由上文与各 Core owner 负责，当前九文件 48/747 和 Planning 三文件 50/454 的资格不自动扩大到这些未验证窗口。

## 只读会话运行日志

默认 process-service 将选定 Store 的 `readSessionLogs` 绑定到独立 trusted `SessionLogsSource`，实际存在时才发布 `session_logs`。`GET /v1/sessions/:id/logs?storeId=&afterCursor=&upperCursor?&limit?` 是认证只读接口；subject 只来自 Service，query 不接受主体、payload、路径或任意 filters。第一页取实际 global 上界，后续显式沿原上界和 last cursor 读取，最多 200 条及 512KiB。严格 Decimal64、原 root creator、Session、Store、保留边界和 scope 由 Core owner 核对；after 小于 replayFloor 返回 410，不能伪造完整的局部页。成功及错误响应保持 no-store/nosniff。

闭合 DTO 仅含事件顺序、写入时的时间/状态、类别、固定摘要和有限关联 details。旧、未来或坏私有 metadata 局部 unavailable；普通 ChangeEvent/SSE 仍只取原 payload。准确 Model 导航由实际原 Model/input/ref/command/root-work 的私有绑定复核，漂移后为 null，不能用摘要或当前状态构造链接。它只打开既有输入确认，不授予读取或执行权限。Gateway 固定原 page/instance/build/Store，Cookie-only GET 前后核实际 admitted identity；Native token、内部 owner、Artifact 描述与原请求不进入日志。

[真实 session-logs](test/isolated/session-logs.test.ts) 3/78/0fail 与最终六文件 22/413/0fail 证明 >200 实际事件、固定上界与并发新事实、认证/subject/Store/query 拒绝、冷只读原页和取消观察零业务写。Decimal64/保留边界 probe 明确使用 SQL fault injection。实际默认 paired main 没有 custom configure，完整 >64KiB 请求、原项目来源和准确 Model 导航经 Native/Cookie/typed reader 验证；原来源改变后冷读取仍保持原 request/metadata，Provider 始终一次，两次所属进程正常结束。首页包含真实 UI 的 optional undefined 参数形状；SDK 不把 undefined 序列化为 query 值。完整 Core foreign-subject 导航证据单独归[日志 owner](../../packages/agent/src/storage/sqlite/session-logs.README.md)。当前为本机 macOS 默认源码 main 资格，不外推源码外制品、原生浏览器或三平台。

原生 in-app Browser 的实际观察另归 [Web owner](../web/README.md#按需-runtime-logs)：真实 API/core 来源、刷新和 narrow keyboard/pointer、原 Model 完整 189 字节正文二次确认、两个实际 Shell Job 观察均已有独立现场证据。该范围不扩大这里的 source-main HTTP 资格，也不冒充 installed launcher、其他浏览器或三平台。

## Browser 文件恢复点只读观察

Cookie gateway只在actual `builtin.files`三个Query@1均可用时提供`file_checkpoints`，固定GET目录`/browser/v1/sessions/:id/file-checkpoints`、`/:pointId`详情和`/:pointId/restores/:restoreId`原状态。宿主从认证当前Store/S/W包裹闭合payload，不接受任意extension/query/action/version或额外/重复参数。point的原boundary保留originalStore/Session/Run/selection/trigger，parent Fork点不重标为当前Session。

目录默认50/max200，以准确point key分页，满页可有next后再读最后空页，没有冻结上界。详情在Service实际只读完整Artifact EOF/hash/size与当前文件baseline，protected/conflict/unavailable保原原因；不是下载/打开文件或批准入口。status分开journal null/blocked/v1/v2与准确carrier id/status/resultRevision，journal不含originStore就不补造。新v2 rootWorkSeq/可空expected/confirmedPost闭合，旧v1不回填。BrowserClient三个具名方法静态校验DTO、Decimal64上界、准确目标、完整bytes和取消；没有Native bearer fallback或媒体路由。

[真实Cookie/默认main](test/isolated/file-checkpoint-browser.test.ts)与SDK负例/邻接当前七文件29/570/0，目录全量/空尾、foreign、未来Query、protected与零Provider/Command/Execution/cursor/文件修改均保留。DOM及当前compiled IAB现场归[Web owner](../web/README.md)，读取会检查文件但不产生文件效果；真实现场不外推三平台、Fork/newStore浏览器或恢复执行UI。

## Native Files 恢复事实只读接口

Native `file_recovery` 仅在实际唯一 `builtin.files` 登记 `files.checkpoints`、`files.checkpoint.detail`、`files.checkpoint.restore-status`、`files.checkpoint.recovery-boundary` 四项 Query `@1` 时提供；调用者传入 capabilities 不能覆盖此技术门禁。固定 Bearer GET 为 `/v1/sessions/:sessionId/file-checkpoints`、`/:pointId`、`/:pointId/restores/:restoreId`、`/:pointId/recovery-boundary`。列表复用默认50/max200的keyset；其余路径不接受query，全部拒绝重复/额外参数、非法ID或调用者指定query/version/subject。当前主体由host固定，四Query实际核当前执行组读取scope，不要求执行组静止，也不授予恢复执行权。

前三响应复用 `FileCheckpointPage`、`FileCheckpointDetail`、`FileRestoreStatus` 的当前观察与原来源分离合同。新的平铺 `FileCheckpointRecoveryBoundary` 保存当前Store/Session/Workspace/contextSelectionId、原checkpoint，以及当前selected历史中的准确boundary/trigger aliases；原checkpoint身份不重标。Native wrapper前后复核实际Store/Session/Workspace，boundary另核同一selector，leaf独立核完整membership及contextRevision。文件postimage冲突不会凭空否定session-only边界，也不把该边界解释为code可恢复或Artifact读取授权。

[实际默认Native资格](test/isolated/file-recovery-native.test.ts)通过普通两Run Files writes、两层Fork、原point与当前别名、完整原媒体scope拒绝、保留/排除trigger的新selector、外部postimage冲突、真实foreign creator Session、冷读取与非法HTTP参数验证接口。[SDK契约资格](../../packages/client/test/isolated/file-recovery.test.ts)另核closedDTO、64位序列、能力拒绝、准确目标、取消及连接代次。这里没有two-leg执行Endpoint；恢复仍经现有普通Action/Fork和独立授权，Native持久三范围消费者另行实施。Browser仍只提供原三个Cookie GET与`file_checkpoints`，不获得新boundary或恢复写入入口。

## HTTP OAuth 与原认证结果

[Source factory](src/mcp-source-configuration.ts)沿默认一个CredentialVault/Broker的owned scope，身份绑定Profile、原Store、Workspace physical identity、Source、Server、raw/transport digest和auth profile。显式oauth可申请Login，省略auth的auto只在当前进程该域观察真实401后可Login；none/manual不升级。401 metadata URL/scopes只供私有协议，目录不公开。

[Session](src/mcp-oauth-session.ts)用低层SDK完成Login-only DCR、state/PKCE、精确127.0.0.1 callback及tokens保存；[network](src/mcp-oauth-network.ts)核HTTPS/DNS全候选、实际pinning/TLS及无redirect/proxy。SDK不能吞掉真实fetch异常后继续fallback，HTTP协议fallback仍沿SDK语义。显式OS [browser helper](src/mcp-oauth-browser.ts)使用固定argv与有限退出监督；callback失效即时结算，有限回复完成后关闭listener，finally等待原helper/network/listener结算。 HTTPS URL 为 IP literal 时不发送 IP-valued SNI，证书仍按原 URL 的主机校验；域名继续发送原 SNI。可信 host 的 `trustedTestCertificate` 仅在显式 `allowLoopbackForTests` 下接纳受限单张 X509 PEM，不关闭证书或 hostname 验证，不从来源/环境读取，也不修改系统证书库。[实际 TLS 测试](test/isolated/mcp-oauth-network.test.ts)分别核缺省不信任、错误域名和缺 IP SAN 的拒绝，以及准确 IP SAN 的实际 OAuth/MCP 通信与停止。

真实connection Job许可后才恢复已有token，临近过期才refresh，无callback/browser/DCR fallback；401有限login/reauth required且零原RPC重试。owned bind timeout取消实际Session/provider并等待其finally，native put开始后保publication unknown，lease不先释放。wire只读原tokenRevision，清理再Login不能给旧holder新Token。

[普通Auth Actions](src/mcp-oauth-actions.ts)四项@1核原C/subject/Store/S与runless E/full input/definition/当前dispatch，锁后重核。bindWorkspaceSerialLocks在Runtime创建前绑定实际同一协调器；直接factory宿主也须绑定并注入同一Runtime，缺失则fail closed。原C/E已是持久申请及回执，没有Auth journal或HostMutation。权限与execution.cancel沿普通通道。status只当前safe policy/backend/presence；mcp.auth.result只原SQL及完整finalization，零当前Source/W/Vault/transport/Model或补写。authenticated只证明保存，连接另行申请。

Remove在准确原scope预检availability/presence、声明发表后local clear；清理失败M仍applied、E unknown，Source result.saved保声明证明，credentialCleanup独立。manual共享refs保留，不默认remote revoke。原 Login 的系统 launcher 由 [browser owner](src/mcp-oauth-browser.ts)沿真实 Bun child 启动／exited 和原清理期限观察。有限 `ownedLauncher` 固定原 Auth 全 binding／owner／PPID／birth、实际退出状态和 reap，范围为 `oauth-launcher-only`、浏览器本体为 external；URL／code／state／PKCE／tokens／argv／env 不进入事实。原 [cold codec](src/mcp-oauth-launcher-evidence.ts)和 `mcp.auth.result` 核完整 finalization digest、旧六字段或严格新字段；公开 Auth Query 九字段 payload 保持，完整 proof 沿原 Execution GET 读取，不重启 launcher 或连接；无 launcher 的 refresh／clear／revoke 没有伪造记录，观察不足不改认证效果。实际协议由[Source集成](test/isolated/mcp-source-oauth-integration.test.ts)、[callback](test/isolated/mcp-oauth-session.test.ts)、[原Actions](test/isolated/mcp-oauth-actions.test.ts)和[owned bind](test/isolated/mcp-http-oauth-ownership.test.ts)分别验证；当前默认图/历史红见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。本机临时backend/AS不证明外部AS、OS浏览器、OAuth PTY或三平台资格。

原Session夹具的自然exit0资格按同一职责顺序：真实Bun launcher只GET既有受控AS元数据，正式helper等待其自然退出后，fixture外部浏览器角色才提交原有效callback；原HTTP200脚本、PPID／birth／reap、DCR／PKCE／冷恢复与所有预算保持。把有效callback放进仍存活launcher会与登录finally的合法local.abort竞争，不能据收到SIGTERM修改原自然退出断言或生产清理。独立“callback后launcher仍存活且kill失败”的unknown场景保持原脚本。准确默认失败与原九整例结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，该准备校准不授外部AS／系统浏览器资格。

## 正式制品、SQLite 与配置路径策略

根八 workspace 的默认 build/typecheck/test 已使用新公开闭包，CLI/TUI/Native 与 Service 以私有 bootstrap 固定配套实例，业务只经 Client HTTP/SSE。旧 carrier、Host/Kernel/State writer 不参与正式/default/CI 调度，历史测试不提供新平台资格。

[Terminal manifest](src/runtime-assets.ts) 与 [Native manifest](src/native-runtime-assets.ts) 分别保存实际 Bun/Node SQLite driver、linkage、version/sourceId；Terminal 另保存 engine manifest SHA。首次公共 Store、readonly/preflight 和 maintenance 打开数据库前选择固定包内引擎，Worker 只复核同一引擎，不重复设置 process-global loader。资产存在但缺少或损坏 selection 时拒绝，完全无资产的开发源码明确 unqualified。已审查来源见 [SQLite release identity](src/sqlite-release-assets.ts)及[Agent 引擎 owner](../../packages/agent/src/sqlite-engine.README.md)。

Windows 的普通 Workspace JSONC/MCP 声明采用不可信 scope 有限读取；明确 Profile 配置、host-mutation key、Skill feature 与 TUI preferences 固定 private。该可信 host 选项不来自 JSONC/HTTP/Model。Profile、Store、WAL/SHM 和协调锁仍要求原生 current SID 私有 ACL；不会修改 Workspace 或既有不安全对象 ACL。原 HANDLE 的有限读取与最终原路径/ETag/活锁复核保持，最后检查与不合作编辑器 rename 的 race 仍不是原子 filesystem CAS。Windows 原生场景已接 CI，本机 macOS 邻接不能证明 win32 qualification。

## 项目来源决定的有限历史事实

[Source factory](src/mcp-source-configuration.ts)只为准确 `builtin.mcp.sources/mcp.source.approve@1` Question提供闭合decision schema与ordered approved/rejected/cancel choices；credential Question保持。普通Action许可不替代Source Question。Source cancel在验证actual answered Question后保存原八字段proof与decision cancel/effectAttempted false，不begin mutation、不写批准文件；旧无proof cancel不补写，保unknown。

[Process host](src/process-service.ts)只解析一次真实subject，同时作为`startService`主体和default factory observer；[configuration](src/configuration.ts)/[bootstrap](src/bootstrap.ts)传同一个冻结可信context，旧单参数configure继续可用。subject不来自startup JSON、JSONC、Query或Question；独立factory没有observer时，原结果Query有限unknown且不猜原Command.subject。

[有限Query](src/mcp-source-result.ts)注册 `builtin.mcp.sources/mcp.source.result@1`，input恰commandId，返回唯一`builtin.mcp.source.result@1` Display；envelope≤16KiB、actions/artifactRefs空。payload恰storeId/sessionId/command/execution/serverId/phase/decision/proof/mutation/recordKey/reason；缺投影null，phase仅pending/saved/failed/cancelled/outcome_unknown。command投原id/Store/S/subject/kind/requestDigest/status/receipt executionId；execution投原id/Store/S/originCommandId/parent/kind/definition/version/inputDigest/status；mutation只投id/Store/subject/kind/scope/requestDigest/state/etag。先核公共readExecutionGroupSafety和实际当前Store，再读取原Command/Execution/Interaction/HostMutation；没有scope()/observe()/当前raw source/physical Workspace/vault/transport或cursor写入。Session只用真实workspaceId，不虚构Session.originStoreId。

原Command须闭合准确Source请求与Core canonical digest；Execution只取原receipt.executionId、准确runless root Job/parent null/Source approve@1/inputDigest及同Store/S/subject。accepted未有Execution可pending；planned/dispatching/running一旦存在mutation即unknown。terminal另核实际receipt.status、非preparingNextAttempt及完整finalizationDigest。saved/cancel都必须闭合原result/details，不把部分succeeded、单mutationId或finish未知当终态证明。

proof恰decisionId/storeId/sessionId/interactionId/acceptedRevision/subjectId/requestDigest/recordedAt：decimal revision最多256位、实际正timestamp、准确原answered Question/accepted revision/Action/version/Execution/request hash与原decision全部一致；历史无新schema的旧request只按原实际hash验，不重写Question。从原Question.user/workspace rootIdentity、immutable profileAccessKey、原Store及Session.workspaceId重建persistentScopeDigest，再核readSet.scopeDigest=hash({persistentScopeDigest,sessionId})。binding恰persistent scope/source identity hash/serverId/rawEntryDigest/transportDigest，recordKey=hash(binding)。value为binding+kind/decision/proof，mutation ID为mcp-source-加原executionId，digest=hash({executionId,inputDigest:hash原own.input,value})；原safeRequest须user scope、原approvalEtag及operationCount1，actual applied mutation/闭合receipt applied/64hex etag和原details.mutation完全匹配。saved还核connectionAttempted与credentialLookup均false。

failed/cancelled仅在准确零effect及没有不明HostMutation时解除冲突。Source cancel须完整原proof/persistent scope；普通Action未进入adapter的failed/cancelled是独立路径：原closed `{outcome,content:code,details:{code,adapterAttempted:false}}`、准确最终receipt/status、实际mutation null，code只接approval_denied/permission_denied/cancelled_before_dispatch/cancel_requested/execution_cancel_requested，cancel另有原Command/Execution durable cancelRequestedAt。reprepare、context_refresh_required、不持久cancel、service_shutdown、bad result或任何mutation继续unknown，不虚构Source Question。

[真实public Service/SQLite Query测试](test/isolated/mcp-source-result.test.ts)最终16项133断言通过、原5s/10s期限；默认Process无configure与自定义冻结subject、三decision、普通许可拒绝/持久取消零adapter、四来源CAS/零发布、缺错observer、原scope/proof/receipt/partial/运行中mutation反例及物理W移走后历史只读分别核证。此前五文件邻接32项391断言早于最终Query收紧；当前第27轮534文件/432唯一主任务完整默认已通过，准确作用域另见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。跨独立读watermark可保守unknown，下一次准确原GET确认，不改为猜saved；物理丢回执与恢复A→B由[CLI Host](../cli/README.md#tui-mcp-项目来源决定与原申请)单独验证。

## 当前来源的强制重连准入

[source configuration](src/mcp-source-configuration.ts)的 `resolveReplacement` 只从可信实际 Runtime读取原 R Execution、Store/Session/subject及完整 closed input。它独立捕获当前完整 Source/read-set与host selection；旧 Run 的 selected-server集合只证明 server被选择，不能把当前 replacement digest强等旧 selected config，也不改写旧 Run snapshot。普通 connect、Tool和Job原配置门禁保持。

replacement captureDigest绑定完整新 snapshot/server及本次完整 R inputDigest。可信 optional snapshotDigest仅比较同来源暖复用；bootstrap/final admission仍核实际父 R、准确新 Job/ref、config/capture/inputDigest与当前 freshness。stop前和新Job最终port.open前都检查原 capture；来源或授权漂移局部失败，历史Query不读当前来源、物理Workspace或vault，也不恢复热 ticket。

[replacement resolver测试](test/isolated/mcp-source-replacement.test.ts)实际13项73断言只证明resolver/full binding与freshness。真实默认Service/Client/SQLite的Action/Job独立Ask、旧停止先于新initialize、重复R及warm B→A链由[Host测试](../cli/test/isolated/tui-mcp-reconnection-host.test.ts)证明；[recovery](../cli/test/isolated/tui-mcp-reconnection-recovery.test.ts)与[restore](../cli/test/isolated/tui-mcp-reconnection-restore.test.ts)分别维护原回执和foreign Store范围。源码外流程、当前完整默认、OAuth/OSvault及三平台按[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)核对。

## 来源条目增删与原文件回执

[Source entry producer](src/mcp-source-entry-mutations.ts)由当前 Source factory 注册普通 `builtin.mcp.sources/mcp.source.add@1` 与 `mcp.source.remove@1`。Add 输入恰 scope/name/entry/expectedReadSet，basic HTTP URL≤8192字、绝对 STDIO command≤4096字；拒控制字、URL raw query/fragment/userinfo 和变量插值。同层已有名称不能覆盖。Remove 输入恰 scope/serverId/expectedRawEntryDigest/expectedReadSet。输入不承接 path、Profile、subject、Store 重标、secret、header、env 或 trust。新增项目仍需原独立来源批准；普通 Action 许可不写批准事实。

执行核真实当前 Store/Session、可信 observer subject、准确原 Command closed request/digest、receipt Execution、原 root-work、runless Job/definition/version/full input 和 live dispatch。begin 后重读原 Session/Command/Execution，publication callback 再核 signal、canonical Workspace/dev/ino、variables与完整Source read-set。目标发布使用[Agent leaf](../../packages/agent/src/config/README.md#private-mcp-sources-and-approval-metadata)，原Execution ID注入创建标记，零Model/transport。Remove先预检准确owned OAuth后端和presence，声明发表后才本地清理；共享手工Bearer保留。声明发布和credentialCleanup分别证明，合同见[认证边界](../../docs/active/mcp-authentication.md)。

HostMutation ID 为 `mcp-entry-` 加原 Execution ID；digest覆盖 version1/executionId/originCommandId/originalStoreId/sessionId/workspaceId/actionId/inputDigest。user 写入用 config.user.write、scope user；project 用 config.workspace.write、scope 为实际 Workspace ID。safeRequest 只含准确 source scope、project workspaceId、原目标 ETag 与 operationCount1。已存在原 mutation 不重新 publication，也不单靠其 applied 合成成功。发布后故障及 finish 丢回执保持 unknown，原文件、原申请和真实 HostMutation 各保自己的事实。

leaf 的 `mcp_source_publication_unknown`只在 rename 后产生，包含 directory sync/read-back 或 release 错误早于 afterPublication callback 的窗口；Service 因此保 effectAttempted:true、原 Mutation/Execution unknown，不返回确定零效果失败或构造保存回执。[真实默认 Service 故障测试](test/isolated/mcp-source-entry-publication-failure.test.ts)只在自有 child 注入准确目录 fsync 和锁关闭后异常，其他实际 FileLock/SQLite/Client/Service 调用保持；实际输出与收尾资格按阶段进度核验。

当前 `mcp.source.entry.preview@1` 核完整 expectedReadSet，只返回安全 target/fallback/readSet 和实际 Store/S/Workspace；没有 URL/command/env/authRef。历史 `mcp.source.mutation.result@1 {commandId}` 返回唯一 `builtin.mcp.source.mutation.result@1` Display，≤16KiB、actions/artifactRefs 空，payload 包含 storeId/sessionId/workspaceId/operation/command/execution/phase/mutation/receipt/reason，可选 credentialCleanup 仅用于 Remove 的本地 owned 清理结果。历史只读原 SQL，Session 只取 workspaceId，可信 Profile key 与原 source root identity 重建 read-set scope；不调用当前 scope/Source/physical Workspace/vault/transport/Model，也不补写 cursor。

saved 要求 Command applied、准确原 Execution 状态、非准备下一 attempt、完整 finalizationDigest、closed result/details/binding、真实 applied HostMutation/safeRequest/receipt、leaf 原/新 ETag、marker-derived Add raw digest 或准确 Remove 原 digest 全部一致。Remove 的 owned 清理失败或未知可使 Execution 为 outcome_unknown；只有完整声明发布证明与闭合 partial cleanup 结果同时匹配时，Source phase 仍为 saved，credentialCleanup 单独报告，不能把该 phase 当作完整认证清理成功。pending、文件当前存在条目、部分 succeeded 或单 applied mutation 均不能代证。普通许可未进 adapter 的明确拒绝/持久取消，以及 producer 完整证明的发布前 failed/cancelled，分别核真实零效果；任何不完整原证明保 outcome_unknown。当前实际局部/统一资格由[阶段进度](../../docs/plans/unified-agent-refactor-v1-progress.md)记录，接口接线本身不证明完整管理或三平台已交付。

## Native Provider 与下一次模型绑定

Provider 设置保留四个明确协议族，连接事实只包含实际声明/模型连接。用户格式以原 provider alias 生成稳定 SHA-256 connection ID，显示名独立存 provider.name；既有模型路由 ID 不变。全新用户实例采用不复用随机 alias，删除后同名重建也不会复活旧路由。Assembly格式第一次编辑时为组内模型保存 connectionId/providerLabel，新增连接使用随机64位十六进制身份，同地址可多实例。空声明仅做内存安全投影，未知/不安全声明可见只读，读取不迁移文件。可选 kind=upsert/remove 与 name 经现有 provider_settings.update 原意图链闭合校验，旧无kind操作仍为保存。删除核完整read-set、准确原连接与默认模型，移除该alias/模型及对应本地元数据，保留无关JSONC字节和Vault秘密；不自动重选默认、不撤销外部凭据。Desktop本机定时引用保护归Desktop owner，Service未读取桌面私有库。

[Provider owner](src/model-providers.ts)声明四类准确协议、默认 endpoint 和必需凭据；OpenAI/DeepSeek 要求 key，compatible/Ollama 允许明确无 key。认证 `GET/POST /v1/config/user/providers` 复用 `configuration_management`，保存只接受原 Store/command/readSet 与闭合 Provider 操作，不接受路径、主体或 Workspace authority。用户范围连接按稳定 alias/connectionId 分组，旧 Assembly 未持久化身份时才沿 protocol/endpoint/credential reference 摘要分组；保留其他连接、模型 options、enabled 和无关注释。既有用户格式的新模型采用稳定 alias/name route ID（显式中立格式保留随机 ID）、默认 disabled；完整候选仍核默认模型有效性。手动名称不访问模型列表，留空只在这次显式保存调用该 endpoint 的 `/models`，严格 EOF/UTF8/结构与 2MiB 响应边界，完整保存超过512模型的目录。

[Responses 完整 wire](test/isolated/responses-loop.test.ts)沿真实 Client/Service/SQLite 验证三轮并行工具、精确 call ID 与输出配对、私有 encrypted reasoning 冷恢复和绑定隔离、人工批准及 unknown 零重放。新增合法名称与原命名空间工具碰撞后，真实 SQLite 冷历史按原 call ID 重新编码，只执行原内部工具，Inspector 仍不公开密文。失败尝试沿 Core 原资格继续，不恢复旧五次上限；六次物理断流后第七次成功、永久断流的明确取消，以及纯文本 length 的封存续接分别核验。截断工具批次和失败 opaque state 不进入下一请求，已有成功工具不会因后继模型重试再次执行。这些都是本机模拟 Provider 证据，不代证真实账户或付费模型。

Service 在任何 vault 效果前核完整原 readSet，发现后和 JSONC 短 CAS 再核。秘密仅供这次热请求并参与私有 HMAC，不进入 Core safeRequest/receipt。vault 与 JSONC 是两个介质：receipt 分别记录 `credentialState` 和 `configurationState`；已存而未发布的凭据向认证 SDK 保留准确 opaque revoke handle，未知不自动回滚或重做。原 Command GET 只核查原 durable HostMutation，不重复发现、vault 写入或配置发布。

`run.start` 与 `input.follow_up` 的可选 `reasoningEffort` 经真实 HTTP 投影进入 Runtime 原请求；普通 steer 不接受它。root resolver 在生成配置快照和 digest 前，将合法临时值投影到本次明确模型的冻结 options；不写 JSONC，冷恢复必须再现同一快照。四类 Provider 默认通过 SDK compatible Chat Completions transport 发送 `reasoning_effort`；OpenAI/compatible 显式 Responses 使用 `reasoning.effort` 与 `forceReasoning`，保留相同原值；用户源的 provider effort 同样不受旧 `reasoning:false` 限制。Kite 仅校验合法参数和绑定配置，不预判远端模型是否支持；远端拒绝如实成为模型执行失败，不回退另一模型或删除参数重发。child 使用自己的角色 preset。实际 SDK 四 family、16次配置/Max/Ultar/none wire、旧能力声明、远端400拒绝、原 Command/ModelInput、快照与恢复见[有限 HTTP 测试](test/isolated/run-model-selection.test.ts)；四 family 的 effort 保存、复合保存和520模型发现见[Provider 测试](test/isolated/provider-settings.test.ts)。默认 OS vault 的 macOS Native 窗口证据见[Desktop owner](../desktop/README.md#native-provider-与下一次模型选择)，不外推生产远端模型或其他平台。

复合发布和原命令选择的取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-06-native-provider-intents-and-next-run-selection.md)。

普通工具的内部 namespace ID、权限和持久执行输入保持不变；[Agent 模型工具表面](../../packages/agent/src/model-tools.README.md)在所有 ModelAdapter 边界统一提供 `read_file` 等公开名称与 snake_case 参数，再将完整调用还原到内部工具。公开 ModelInput 按当时封存的表面重建名称、schema 与历史，内部 assembly/执行仍绑定原 ID/version；[AI adapter](../../packages/ai/README.md)只继续负责通用协议编码。[普通 paired 宿主回归](test/isolated/configuration.test.ts)核真实公开 wire、准确基线编辑、原内部授权与后续历史；[显式真实模型测试](../../tests/e2e/live/model/README.md)另核单一默认模型，不将两类证据混作全部 Provider 资格。


[Native MCP 测试装配](test/native-mcp-process.fixture.ts)仅由 Terminal builder 的固定 `native-mcp-loopback` 选项在构建前写入，网络选项和可选公开测试证书均进入 inventory/digest；普通 main/daemon 不选择它。该候选保默认权限、默认 OS vault 和系统 opener，但 loopback/证书网络不是生产默认资格。实际窗口及人工浏览器资格的入口和限制归 [Desktop owner](../desktop/README.md#native-mcp-完整设置)。

## Session 目录活动摘要

默认 Service 声明 `session_directory_activity`，沿原认证 `GET /v1/session-directory` 返回同事务的 root 身份和有限 activity；主体仍只由宿主提供。活动 Run 优先、否则最新 Run；排队、同主体当前 Store 的待输入数量与最后 Core 事件封存时间分别保留，没有新运行或取消 authority。旧／未知时间保持 null，不读取当前配置或公开事件正文。Store 负责范围与来源，见[目录 owner](../../packages/agent/src/storage/README.md#目录分页)。

Session closed query 新增可选 `snapshotCursor`；续页元数据变化返回409 `directory_changed`。生成响应保持 additive，旧 producer 可省略 activity；SDK 仅在宣告能力时要求它存在并完整扫描。Cookie Gateway 允许该有限只读字段并转交原准入 Store，BrowserInfo 只转发服务实际宣告能力，不增加路径、主体或写入入口。[真实目录测试](../../tests/isolated/unified-agent/directory.test.ts)核超过200项、改名无 Run 的真实更新时间、Native／Browser 一致和冷 readonly 零事件；[SDK 反例](../../packages/client/test/directory.test.ts)核变更前缀丢弃、字段缺席／坏时间和持续变化拒绝。实际 PC 窗口资格归[Native owner](../desktop/README.md#native-项目会话目录)。

## 完整后台执行目录

公开只读 `GET /v1/background-executions` 使用 closed 查询和有限 `BackgroundExecutionPage`：subject 仅由当前宿主准入填入，页面 Store必须匹配当前连接；root所有权、恢复根内旧来源、未删除状态、真实来源／root-work／child-start 与 Workspace/root/Execution过滤由Store在分页前核对。完整 Job目录包含 child/task carrier及其后代，原 originStoreId 不改成新 Store；读取资格不授予历史取消或重放许可。`snapshotCursor`冲突返回409 `directory_changed`，不产生新Command或业务效果。正文和输出沿原接口按需读取；Cookie Gateway 的具名 `GET /browser/v1/background-executions` 沿同一目录公开有限 metadata：当前 Store 由原准入连接注入，closed query 只接受 Workspace/root Session/Execution 和原分页条件，不接受 subject、Store 或任意路径。沿原 `sessions` 能力和宿主主体核真实根范围；没有新增控制能力或业务写入。Browser 的准确 child 导航与 Job output 继续沿原只读 Session/Execution 接口，不改变历史取消或恢复资格。[真实 Cookie 测试](test/isolated/development-web.test.ts)核原 Job/child、输出、authority/重复查询拒绝和观察前后 cursor/Model/Job 效果不变。原身份、父/child Run、取消守卫和分页契约见[Store owner](../../packages/agent/src/storage/README.md#跨会话原-job-目录)，实际协议见[测试](../../tests/isolated/unified-agent/background-directory.test.ts)。

[web-permissions](test/isolated/web-permissions.test.ts)实际验证默认授权入口的人工卡前零 DNS/socket、Auto 原 Model 批准/拒绝与原因、Full 常规 fetch，以及网络关闭/SSRF 不被模式放宽。局部与完整 macOS 证据归[当前切片](../../docs/plans/shell-permission-scopes.md)，Linux/Windows 原生资格与 RSS/完整观测门禁保留。


默认 Workspace assembly 显式装配 Agent 的纯 `agentContractSource`，根和 child 使用同一稳定静态规则／可缓存事实。项目文件内容由 Agent 来源适配器标为历史之后的 user 数据，Planning 动态状态沿实际 Run 的唯一尾部来源；Service 不生成计划状态或权限规则。普通请求、压缩和展开共用 Agent 的来源组装，完整内容／freshness 与原业务门禁继续独立核验，详见[Agent 上下文 owner](../../packages/agent/README.md)。

## 终端展示的新增只读字段

`Execution` 仅对 Tool 投影原 `toolCallId/toolInput`，不公开 Model／Job private intent；SessionView 可携实际 Runtime 的 `compressionProgress`。模型目录的 optional `connectionId`使用既有准确 Provider connection 身份，供首次配置选择原发现模型，不按同名模型猜路由。Files preview 的 `textChange` 和 SessionLog 的准确 immutable point 白名单由同源 schema／响应校验传递。Service 不新增权限分析、运行器或恢复判定，客户端仍核原身份和完整字段；[HTTP Files 回归](test/isolated/file-checkpoint-browser.test.ts)保原字节／权限／归属断言。

`SessionView.session` 可携同一次 Store 视图已有的 `ownerInstanceId`／`ownerGeneration`；普通 Session DTO 保持原范围。字段沿同源 schema／Client decoder 传递，不新增 Store 读取或 owner 存活判定。当前连接可将已认证 Service 实例与原 owner 比较，只用于活动显示的可确认性；不同实例不证明 owner 死亡，不授恢复、取消或派发权。原 [恢复 HTTP](test/isolated/session-recovery.test.ts)核实际 owner 字段与显式中断边界，多 Service 的原锁、执行与观察规则保持。

目录专用的原 `mcp.auth.status` Query 支持可选严格 boolean `onlyLoginEligible`。为 true 时，仅消费已观察 target.loginAllowed；不具资格返回带原 serverId／workspaceId 的有限 eligible:false，未调用 Vault status／resolve，也不补任何凭据状态。省略或 false 保显式 Auth／Remove 的原安全状态读取；原 Command/result Query 不变。此分支只做既有目标资格的接口过滤，不增加权限策略、连接或执行授权。


SQLite 增量恢复证明由 Agent Store 的正常事务维护，公开 HTTP 保持。`sqliteStorageAssets().migrations` 给出完整的包内迁移 URL，默认 Files 的 protectedRoots 逐项保护原 baseline 和增量 SQL；构建与只读格式预检使用同一闭合迁移链，不用源码 fallback。准确升级、来源/身份/unknown 校验及冷读成本归[恢复协议](../../packages/agent/src/storage/sqlite/run-resume.README.md)。

## 上下文统计观察

`GET /v1/sessions/{id}/context/estimate?storeId=...&executionId=...` 复用原 Model 输入的主体／Store／Session 权限，以完整当前所选历史和已保存来源布局返回下一请求预测及本会话累计实际用量。查询不初始化 Provider、不捕获现在来源、不写 Store；Client 验证目标、基线与加总关系。默认压缩沿 Core 当次实际工具与已核实输入基线加新增估算，采用明确窗口或 256K 缺省的总量 75%，显式 `compression.thresholdTokens` 覆盖比例；摘要快照保存数字投影及阈值出处。口径与失效规则见 [Core owner](../../packages/agent/src/context-estimate.README.md)，验证见[完整会话与冷读取](test/isolated/context-token-estimate.test.ts)。
