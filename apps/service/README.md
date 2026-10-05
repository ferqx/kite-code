# 本机 Agent Service

项目来源的专用答案 schema、可信 observer 和有限原决定 Query 已实施；当前证明与历史读取边界见[Source owner](#项目来源决定的有限历史事实)，本片取舍与已完成的有限验收见[Source 决定](../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

Session 管理提供 `POST /v1/sessions/{id}/fork`、`/rename`、`/delete`，输入为有限 closed schema，主体由可信宿主填入。Fork 核原 Store/selection/稳定配对边界，只复制历史与出处；未登记 namespace 规则默认 omit，可信注册可选择 copy/rebuild。有限 `namespaceReport` 与原命令 receipt 一致，`omittedExtensionState` 如实表示省略，HTTP 不接受内部准备计划。重命名和删除按 `ifRevision` 控制 CAS，原 command ID 查回原 Session 快照。删除原子保存整组 tombstone 和停止边界，关闭迟到创建/派发，异步通知真实 owner 收尾；回执不声称资源已停止，准确旧 ID 历史继续可读。物理 GC、Workspace 批量删除和完整恢复维护尚待实施。

Fork 的 view、history 和 Context 通过 readonly `getMessageOrigin` 核 sealed SQL 出处，公开有限 `originMessage` 原 Store/Session/Message/Run。原 Model output BodyRef/Execution scope 不变，正文从原 Session 的具名 GET 完整读取；未来 Part 保预览并标 `unsupported`，不能猜测解释或自动调用模型。每次 GET 的 `snapshotCursor` 是该次一致读水位，正文/hash/原请求身份保持不可变。[真实 HTTP/SDK 管理](../../tests/isolated/unified-agent/client-session-management.test.ts)和[17MiB Fork](../../tests/isolated/unified-agent/client-fork.test.ts)记录相应资格。

Session 原始记录导出使用可选 `session_exports` 与四个有限 GET：`/v1/sessions/{id}/export/manifest`、`/records`、`/text`、`/verify`。每次请求核原 Store、宿主主体、root/真实 child 关系和冻结 manifest，Cookie gateway 仅提供这四个明确映射。11 个 section 是目的明确的原始导出投影，排除 owner/锁/宿主配置/凭据；未知 Part、extension JSON 与 Fork provenance 保留原文本，超过 64KiB 的实际文本列通过原行/字段分块，不从 payload hash 生成授权。每页最多 200 行并有局部字节预算，无累计截断；最终短只读事务重新核完整读集。回复保持 no-store/nosniff，读取不发模型、恢复或业务写入。[实际 HTTP/Cookie 导出](../../tests/isolated/unified-agent/session-export.test.ts)2/50 验证 210 条、9MiB 未来原文、17MiB 原 scope 媒体、物理截断、外部提交和冷只读。完成标记仅证明原始记录/文本，媒体仍须具名原 scope reader；它不构成数据库或跨介质备份。

Context 提供 `POST /v1/sessions/{id}/context/compress` 和 `/context/compression/reset`。人工压缩携原 Store、Command、selection 和可选完整 `focus`；说明没有 4096 字符算法门禁，HTTP 仍遵守宿主统一 JSON 传输预算并明确拒绝超限，不能裁剪后提交。重置另携原 `expectedCompressionId`（无活动点为 null）。202 只表示原命令受理，最终结果读取该命令的实际 Run；丢回复只查询原 ID。SelectedContext 的有限 `compression` 记录保留原 Store/Session、实际 Model Execution、覆盖范围、旧点引用及算法快照，原历史和实际模型正文保持可读。

默认装配的 `createSummaryCompressor` 从公开 `/configuration` 导出，纯描述摘要请求；所有实际模型调用与发布仍由同一 Core 执行。宿主可明确选择一个可信 `compressor`，启动时绑定其 `prepare/shouldCompress/validateSummary/validateExpanded`，后来改对象或 JSONC 字段不能替换回调。多个候选冲突明确拒绝。`shouldCompress` 缺省不自动触发；`validateSummary` 可基于宿主准确模型事实拒绝真实输出，`validateExpanded` 必须明确返回 true 才允许清除活动点。默认算法没有准确 tokenizer/window 事实，不把字节量当 token，不宣称目标窗口资格。摘要在后续请求中按带准确 source ID 的低权限用户数据呈现，不获得 Tool 或审批权。

[默认 compatible SDK 压缩](test/isolated/compression-configuration.test.ts)与[自动分支](test/isolated/compression-automatic-configuration.test.ts)共 5 项／125 条断言通过：45KiB 自定义说明完整进入实际请求、真实摘要与覆盖来源、后续 Model 精确采用摘要、可信摘要拒绝后的旧输入继续、两种 reset 预检、压缩/reset 物理丢 202 回复只查原命令且各一次 POST、冷只读零 Provider。该资格使用临时 profile、固定本地模型与临时凭据 backend；不代替真实模型压缩质量、目标窗口计数、正式调用者或平台验证。

实际 Model 输入读取入口为 `GET /v1/sessions/{id}/model-inputs?storeId=...` 和 `GET /v1/sessions/{id}/executions/{executionId}/model-input?storeId=...`。主体只由 Service 宿主提供，闭合 query 不接受 path、Artifact ref/hash 或 renderer 主体。目录需要准确 Session，每页最多 200 项的固定上界 keyset 可以取得第 201 次之后的调用；正文使用 Core 的原请求读取，不捕获现在来源、读取现在配置或调用 Model。大正文由 [model-input-response.ts](src/model-input-response.ts) 在原内容核实后分为 64KiB wire chunks，带完整 size/SHA，保留 no-store；Client 成功 EOF 核实后才发布全文，不以便利 JSON 大小静默裁剪。

Gateway 将 `model_inputs` 作为有限只读 capability，固定原 Store 和 Session/Execution，读取前后核实原 admitted identity，再传输同份公开 snapshot；Native token、profile 路径、内部 Artifact 标识和 Provider 授权不进入响应。Web 在用户确认后读取敏感内容；成功回执与未确认的已准备请求分别呈现。每个新请求封存实际 adapter/provider family、模型与已支持 settings、实际扩展/工具版本、来源顺序与摘要，并记录最后派发使用的授权与控制 revision。opaque adapter、未记录或未来格式明确 unavailable，不以当前配置替代。[实际 Core→Native→Gateway→Browser](../../tests/isolated/unified-agent/model-input.test.ts) 1/27 证明超过 17MiB 的原输入、后续 Rewind/新来源后的原历史、错误 scope/Store/query 拒绝与冷重开只读零 Model/来源捕获/重放；[真实默认 SDK 元数据](test/isolated/model-metadata.test.ts) 1/18 证明实际 wire settings、权限修改与后来配置变化不改写原请求。完整 Runtime logs 和正式客户端迁移仍按进度记录。

`model_outputs` 提供 `GET /v1/sessions/{id}/executions/{executionId}/model-output?storeId=...` 及对应 Cookie-only Browser GET。公开消息只携有限 `outputBody` 摘要，不携私有 linked-segment head。Core 按原 Store/Session/主体/Execution 的一致快照展开已持久前缀或完整正文，核实链、字节和 hash；成功结果有完整 Tool calls，未完成前缀永远 `complete=false` 且不派发截断参数。全文以同一 64KiB response writer 传输，Client 核完 EOF、wire/body hash 和目标才发布。纯读取不消费结果、不创建 Model、命令或取消。[实际 17MiB Core/Native/Cookie](../../tests/isolated/unified-agent/model-output.test.ts) 1/39 覆盖下一 Model 的完整正文与原来源、历史 Rewind、冷读取及公共投影不泄私有引用；输入、输出、Client 和 production metadata 组合 12 tests/173 assertions 通过。

公开 Interaction 使用 `GET /v1/sessions/{id}/interactions?storeId=&afterId=&limit=&state=`、`GET /v1/sessions/{id}/interactions/{interactionId}?storeId=` 与 `POST /v1/sessions/{id}/interactions/{interactionId}/answer`。`interactions` capability 表示这些路由；列表按 ID keyset 分页，每页最多 100 张卡。root 和 child 视图投影同一持久请求、原 Store/Session/Run/Execution/attempt、展示根与祖先链、定义/参数/策略绑定、必要引用、请求/答案及 revision，不公开主体权威、owner token 或私有决策来源。child 卡只能通过其原展示根回答，主体由宿主填入。闭合答案输入携带原 expected Store、稳定 command ID、expected revision 和有界答案。202 `answer_saved` 回执只确认持久保存，内部接纳决定和派发仍由 Core 负责；没有公开 accept-decision 入口。取消后可将迟到答案保留为 cancelled 历史，不执行工作。

[Interaction 定向测试](../../tests/isolated/unified-agent/client-interactions.test.ts)验证真实 HTTP/SDK 投影、身份/revision 冲突、child 展示/root 回答、先取消后迟到答案、问题 schema，以及实际固定 Model 审批 → Tool 提问 → 回答 → 普通 Loop 完成。OpenAPI 保留二进制 Artifact 路由，并将现有 events 路由标为 `text/event-stream`。这个协议切片不改变默认宿主权限策略。

这个私有应用通过认证 HTTP JSON 和 SSE 暴露公开 Agent Runtime，负责 HTTP schema、投影、loopback 认证、bootstrap 与关闭。执行仍归 `@kite-ai/agent`；handler 不运行第二个 Loop，也不使用旧 carrier。

[`@kite-ai/service/development-web`](src/development-web.ts) 的 `startDevelopmentWeb` 是显式的只读浏览器宿主：接收已准入的 Native Client 与可选固定可信 asset Map，在独立 `127.0.0.1:0` listener 提供页面、短期 HttpOnly/SameSite Cookie 和有限 `/browser/v1` GET。它复制并封存宿主提供的有限 HTML/JS/CSS 资产，并加入本 Service 构建内的 `/openapi.json`、`/api-docs` 静态文档，页面 identity 同时绑定资产完整 SHA-256 与原 instance/build/Store；调用者后来修改原 Map 不会更换原页面。它核对实际 Host/loopback peer/Origin 和页面 identity，转发空间、会话、view、history 与按需诊断；workspace 路径、Run 配置、view 中的 execution result 和 Native bearer 不进入这些投影。未知路径、query、写入、SSE、配置、凭据及任何 Authorization header 在转发前拒绝。

Cookie 建立、续期、删除及 gateway close 只改变本浏览器的访问状态，不提交 Store 命令、模型请求或执行取消。关闭时先封住自身入口、清除 Cookie 并中断自身读取，等待已受理 GET 和返回正文流的真实 EOF 或 reader cancel 清理，再停止自身 listener。重复 `close()` 返回首次缓存的同一 completion；读取尚未清理时不能提前完成。它不关闭共享 Native Client 或其 Service。HTTP schema 仍由 [schema owner](src/http/schema/index.ts)定义，BrowserClient 与 [新 Web 调用者](../web/README.md)通过生成 DTO 消费。[真实配对测试](test/isolated/development-web.test.ts)覆盖认证隔离、读投影、零写入及浏览器关闭后原 Model 工作继续。当前最小默认页面不是正式 Web 功能切换；页面与完整观察能力按实施进度验证。

每个有限浏览器 GET 通过共享 Native Client 的只读 `verifyConnection` 核实原身份，身份复核不重置该 Client 或中止其他读取。目录、历史、Context 与 Job 输出可以同时读取；每个请求仍保留自己的取消信号和原 page/instance/build/Store 约束。

诊断 GET 开放 `/browser/v1/sessions/{id}/context`、`/browser/v1/sessions/{id}/executions/{executionId}/output`、`/browser/v1/sessions/{id}/model-inputs` 与 `/browser/v1/sessions/{id}/executions/{executionId}/model-input`。Context query 不接收 Store，绑定原准入后核对准确 Session/selection；output 先核原 Execution 属于该 Session，再按固定高水位分页，发布前复核原 Service 身份。Model input 目录与完整正文使用上文的原请求读取边界，不是当前 Context 或完整 Runtime logs。纯读取不消费结果、重放 Job 或启动 Model。诊断响应可包含其实际允许的正文，有限 view 的省略字段不限制这些具名端口。页面 CSP 禁止动态代码生成，Client 校验规则由唯一 HTTP schema 在构建时静态生成。

`startService` 在 `127.0.0.1` 随机端口监听，返回包含 endpoint、token 和 Service/profile/API 身份的私有 bootstrap。Native 调用者在 Authorization header 传 token，Host 与 Origin 分别核对。写入要求原 `expectedStoreId` 与稳定 `commandId`，主体身份由宿主提供。请求限制在本地生效，HTTP/SSE 取消不取消已接纳工作。

SSE 从单一扫描游标读取持久变更。未来、过期或格式错误的游标在 ready 前拒绝；ready 和 heartbeat 无 ID。过滤后的 checkpoint 只有在其一致页面中此前所有可见变更都已发送后才推进。`Change.objectId` 是有限不透明通知标识，可以是普通对象 ID、带点号的扩展 namespace 与带斜线或 Unicode 的 record key；上界385字符来自 Store 的128字符 namespace、一个分隔符及256字符 key，不作为路径或执行权使用。Store、Session、Command 等普通 ID 保持原约束。唯一 [schema](src/http/schema/index.ts) 与生成 Client 校验器/OpenAPI 同步；[真实扩展事件回归](test/isolated/extension-changes.test.ts)核原 SQLite 事件逐条通过 HTTP/Client、无 reset、完整原 ACK 和零额外执行。订阅缓存有界，超限只关闭该订阅，不改变执行。关闭先结束 stream，再 drain Runtime 和 Store，最后停止 HTTP。

当前接口支持 Workspace/Session 创建与读取、`run.start`、准确 `command.cancel`、通用 `extension.invoke` Action、扩展目录与 Query、Command/Run/Execution 读取、History 和变更 stream。Model Tool 和 Action child operation 使用与直接宿主相同的 Runtime 路径。Action 是 root Job Execution，不创建 Model Run。Query 返回通用 PublicView，使用 Session 范围只读投影，不创建 Execution；可选 JSON `input` 缺省为 `{}`，编码后最多 8192 字符。生产默认装配、完整管理能力和发行资格继续由 V1.3 计划记录。

当前认证 Native server identity 返回宿主实际 `subjectId`，Command POST/GET 投影返回实际持久 `subjectId/requestDigest`；不公开请求正文、owner 或内部 lease。摘要仍由 Store 对原闭合请求的 canonical JSON 生成，完整正文和 extensionInputs 保留，不把 command ID/expected Store 加入请求摘要。生成 DTO 的凭证字段为可选，调用者缺字段时必须明确 unknown，不能借旧无凭证 DTO 判断本地记录已受理。[真实完整请求凭证测试](test/isolated/caller-command-proof.test.ts)1 项/51 断言核五种普通申请、实际主体、SDK canonical 摘要和重复原 GET 零新 Run/Provider；实际停止仍独立观察 Execution 终态。

`@kite-ai/service/paired` 提供 `launchPairedService`。调用者启动前通过只读 `@kite-ai/agent/profile` API 选定 profile，并传入选定 entrypoint、instance/build 身份、API major 和必要 capabilities。launcher 发送一行私有 startup JSON（最多 64 KiB），保持 stdin 作为独立父进程存活通道，并读取一行 bootstrap JSON（最多 16 KiB）。凭据和 token 不进入 argv、URL 或继承的模型凭据环境变量。Client 准入将 bootstrap 与认证 HTTP 身份和启动前选择逐项比较，不从响应推导预期 profile；启动失败只清理本次建立的 child。

可信 Native main 可显式提供中立 `spawnChild` port，用 Node 的进程/stream 能力启动已选定的 Bun 制品；省略时保留 Bun 宿主实现。port 不改变 bootstrap、准入、父存活或所属关闭协议，也不增加默认 PATH/源码回退。Electron main 只持有自己启动的 PID 和 handle；[paired 测试](test/isolated/paired.test.ts)及 Native 实际窗口证据分别证明 launcher 与 Node 调用者的边界。

[process-service.ts](src/process-service.ts) 的 `assembleProcessService(startup, { configure?, beforeResourceClose? })` 只装配显式选定的 profile、配置、原 Store/Artifact、唯一 Runtime 和 HTTP listener，并返回原 Service handle；它不监听父存活、不写 bootstrap、不建立另一执行管理器。传入的 startup 经闭合 schema 和选定 profile identity 校验，首次可信配置与最终资源回调在装配开始时固定。`main.ts` 复用此装配，继续负责原单行私有 startup/bootstrap、父 EOF、HTTP 关闭后父管道退出及未确认清理时保活。`main.ts` 是显式生产进程入口，import 不启动 Service。默认宿主在每个新 Run 解析新范围配置，不隐式选择模型、发现付费凭据或回退 Provider。测试和产品装配可通过 `runServiceProcess` 显式注入。Store 打开失败时，进程仍可提供安全认证 server 诊断并返回 `dataAvailability: unavailable`，业务入口返回 `503 data_unavailable`；不会用空数据替换损坏的 Store。

HTTP/SSE 断连和网络释放不会关闭父进程存活 pipe。父 EOF 或 launch handle 的幂等 close 只 drain 自己的 Service：拒绝新工作，drain 期间保留取消/读取，关闭 SSE，取消并 drain 所属 Runtime，关闭 Worker、释放锁，再停止 HTTP 并退出。优雅退出失败时，有界关闭期限只能强杀本次启动的 child。bootstrap stdout 不承载日志或业务 RPC。生产 stderr 只写公开错误码；launcher 最多保留 16 KiB，只暴露解析后的有界诊断码，丢弃非结构化内容以免转发秘密。

验证入口：`bun test apps/service/test/isolated/`、`bun run --cwd apps/service typecheck`。测试绑定真实 loopback listener，通过实际 Worker 打开临时 SQLite profile。HTTP schema 是生成 Client 类型与 OpenAPI 的唯一来源；修改 schema owner 后重新生成，不手改生成文件。

双 Service 测试共享同一 profile 和 Session。受控 Model 或权限 barrier 保持 live owner，另一 Service 接纳工作或取消；外部效果 ledger 核对每个 Tool Execution 只执行一次。切换订阅和延迟消费 replay 将断连与执行分开验证。跨宿主取消必须到达原 live AbortSignal；owner Service 关闭后，已接纳工作应在存活 Service 上推进。

这些测试输出实测 HTTP 接纳往返、Worker/SQL 合并读取往返、gate 释放到观察终态，以及 SSE ready 消费/断连耗时，没有分别测量 Worker 排队、SQL 执行或 commit 延迟。barrier 场景证明等待中的 owner，不证明进程冻结、SIGKILL 恢复、长期吞吐或 T113 性能资格。

paired 测试使用真实 Bun child、固定 Model、显式外部效果 ledger 和文件 barrier，验证兼容拒绝时启动写入与业务写入的区别、HTTP 身份、本地 stdout 边界/日志过滤、断连后的执行、一个 child EOF 时另一个 child 继续自身工作、Session owner 交接及重开零重放。POSIX profile-use 锁释放直接通过原生 flock 探测，不代表 Windows 锁资格。合作 fixture 在效果前报告已知取消；意外 adapter 异常仍遵循 Agent `outcome_unknown` 恢复边界，本生命周期测试不声明任意被中断的外部效果都可安全重跑。

执行输出使用 `GET /v1/executions/:id/output`，只调用公开 Runtime 读取 API。`afterSeq` 缺省 `0`，可选 `upperSeq` 固定快照上界；`limit` 为最多 200 的规范正十进制数。序号参数为规范无符号十进制字符串，受 SQLite 有符号 64-bit 范围约束。未来游标拒绝；保留输出和显式丢失区间保留原序号范围。clipped/coalesced 丢失区间无法取得准确字节数时返回 `droppedBytes: null`。读取不派发工作、不追加变更。

有限 P3 Job fixture 是独立构建的公开 Extension，使用无害外部 start/end ledger 和受控 adapter barrier。定向 HTTP 测试覆盖普通 Tool 创建 Job、无 Model Run 的直接 Action、attached/detached 取消、准确 HTTP Command 取消、活动 Action `operations.cancel(OperationRef)`、本地 Service close、进程槽、真实 Workspace OS 锁、不可用资源后端，以及持久输出 keyset/前缀 gap。adapter 终态事件明确确认监督结束；仅观察 EOF 不能证明真实外部进程已停止。测试共用 UnifiedExecution 和真实 SQLite Worker，没有第二个 Service 执行 Loop 或专用 Job RPC。

定向 Job suite 通过 8 项真实 HTTP 测试、77 条断言。直接启动 Action 到达自己的终态回执时，其 detached Job 仍可运行；原 Service 保持 owner，在已确认 Job 终态和交付收尾后，排队的 peer 工作继续推进。这暴露并验证了存储对普通 child Tool（父成功前须收尾）和独立监督 Job 的区别。原生 Shell 进程组、进程死亡/核实和发行/平台资格不属于这些固定 adapter 证据。

通用命令入口还接纳准确 `run.cancel`、`execution.cancel` 与 `session.cancel`，将显式目标和原 expected Store 传给对应公开 Runtime 方法，由宿主填主体并返回持久控制回执；不会替 Execution 请求选择当前活动 Run。draining 期间四种取消仍可用。跨 Service 测试证明：取消普通 Tool 后其 Run 可继续下一 Model Step，detached sibling 仍运行；明确 Run 取消保留 detached 后台工作；`session.cancel` 的 `includeBackground: true` 停止选中旧工作，并阻止已取消旧 Tool 接纳未来 child。后续明确新用户工作仍可用。拒绝的主体/Store 控制不创建命令或持久变更。


有限 W12 默认装配通过 `@kite-ai/service/configuration` 导出 `createDefaultProcessConfiguration({profile,hostConfiguration?,credentialBackend?})`。只读 `<selected profilePath>/config.jsonc` 和明确创建的 Workspace file URI 下的 `kite-agent.jsonc`。defaults、用户文件、Workspace 文件、私有显式 startup `{configuration:{modelId,models,tools,skills,mcp}}`，再加可选 command `modelId/selectedSkills`，决定新 Run。没有旧配置发现/parser。坏 JSONC 或不可用凭据仅拒绝该 Run，bootstrap、History、Query 和准确取消保持可用。未配置模型返回 `model_unavailable`；禁用、未知或不支持的模型不回退其他 route。

模型配置为 `{id,provider:"compatible",model,baseURL,credentialRef?,enabled?,options?}`，endpoint 身份明确。支持的 options 包括 `temperature`（有限数 0–2）、`topP`（有限数 0–1）、`maxOutputTokens`（整数 1–1,000,000）和 compatible transport 的封闭 `reasoningEffort` 值 `none|minimal|low|medium|high|xhigh|max`；其他 options 返回局部不支持错误。effort 可编码不表示已发现远端模型支持，远端拒绝仍是实际请求失败。管理投影只保留该闭集，未知 option 值继续脱敏。这些值冻结进 Run adapter 并传给真实 SDK 请求，不只出现在快照里。Runtime 在模型执行前保存支持的脱敏 effective 配置/digest 和实际注册 Tool ID；活动 Run 保持自己的 route/definitions/options，后续 Run 重读配置。基础授权只允许 `kind:model`，同名 Tool 不取得 Model 权限。

默认凭据查找使用惰性原生 OS 后端，service 为 `kite-agent`，account namespace 为稳定 `profile-<profileAccessKey>`。配置仅存原 opaque credential reference。临时后端只可由宿主显式注入，测试合成凭据不会成为生产缺省。真实 OS 凭据存储资格仍未完成，这些测试不初始化用户 keychain。默认 MCP 装配见下文，正式调用者完整迁移仍是独立集成工作。

5 项配置集成测试启动真实 paired Bun Service 和本机 fake compatible stream 端点，验证真实 route/options 优先级、跨文件变更的旧 stream 绑定与不可变持久 SQLite 快照、坏/禁用/未知/不支持配置零 fallback、显式临时凭据的隐私与丢失、下一配置无效时取消原 stream，以及真实注册的同名 Tool 按 kind 拒绝。没有调用付费 Provider 或读取旧用户数据。


W12 管理与 Run 解析共用默认装配 vault。认证 `GET /v1/config/user?storeId=...` 与 `GET /v1/config/workspace?storeId=...&workspaceId=...` 返回准确字节 ETag、脱敏解析 `raw`、脱敏合并 `effective`、带原支持配置 digest 的脱敏快照投影和有限公开错误码。未知字段值和不支持 options 在视图中显示占位符，原字节留在文件中。坏 JSONC 返回 `raw:null`、ETag 和 `invalid_jsonc`，不替换为空文档。Workspace 路径只来自持久 Workspace file URI，请求不能提供文件系统路径。存在配置 manager 时，诊断模式仍可读用户配置；mutation 要求当前 Store 的持久身份和回执。

`PATCH /v1/config/{user|workspace}` 接收 `{commandId,expectedStoreId,ifMatch,workspaceId?,operations}`，最多 64 个 `set`/`remove` 路径，根限于 `modelId`、`models`、`tools`、`skills`、`mcp`。普通编辑保留无关注释与未知字段；旧 ETag 或冲突 command ID 返回 409，不隐式重试。坏 JSONC 不能 patch；显式 `POST /v1/config/{scope}/repair` 接收相同身份/ETag 和有效对象 `value`。同一稳定短锁内，将完整原字节保存在私有 `.config-repair-backups`（最多 16 项），重核 ETag 后原子发布替换。备份内容和路径不经 HTTP 返回，也不进入回执。

`POST /v1/credentials` 接收 `{commandId,expectedStoreId,secret}`，回执只返回 opaque credential reference 与 persistence。`POST /v1/credentials/{opaqueRef}/revoke` 接收 command/Store 身份，阻止 vault 后续解析。原生后端错误局部失败，没有明文配置 fallback；临时引用随显式注入的后端/进程丢失可用性。revoke 不声明能撤回已解析凭据或已派发请求。

每次管理 mutation 使用 Store 的有限 `host_mutation` journal，与 Session 命令和执行权限分开。当前 Store、宿主主体、kind、准确 scope 和 request digest 必须匹配，同 ID 请求才返回原终态回执。pending 重复请求返回 `mutation_incomplete`，不重复效果。digest 为 canonical semantic body 的 HMAC-SHA256，使用协调目录内生成的私有 profile key，并由短 OS 锁、原子发布和 owner/private-file 检查保护。凭据或配置值不进入 Store 审计 API，只有 digest 与闭合安全 metadata。`GET /v1/host-mutations/{id}?storeId=...` 以调用者原 Store 读取宿主主体的回执；重复参数、隐藏主体与路径参数被闭合 query 拒绝。公开投影保留持久原 `originStoreId`、scope/workspaceId/ifMatch，receipt 只含 ETag 或 opaqueRef/persistence/有限错误，不返回 digest、secret 或任意内部 safeRequest。原 origin 不替换为当前 Store。文件/vault 效果与 SQLite journal 完成是不同事务；接纳/效果之后崩溃可能留下 pending 或 unknown，绝不自动重放。本切片不声明跨介质事务发布或自动恢复。

5 项管理集成测试使用真实 paired Service、SQLite/HTTP、临时配置文件、本机 compatible stream 端点和显式临时 vault，覆盖跨进程原回执、ETag/Store 冲突、注释/未知字段保留、明确坏文件 repair、opaque 凭据回执、真实 Run 查找/撤销，以及受控 pending credential barrier 下零重复效果与其他主体零接管。既有 5 项默认装配测试另覆盖旧 Run 不可变和配置失败隔离。Native Client 的有限 `configuration_management` 端口另验证原意图复制、原 Store 查询、物理已提交 PATCH 断线/坏回执后唯一原 GET、冷读取与零任务执行；Browser 不获得管理写权。普通 JSONC patch 可以保存不可路由的期望配置，并在后续 Run 明确拒绝，不能充当 Settings 默认模型业务约束的完整验证。OS 后端发行资格与完整 W12 客户端管理仍未完成。


W09 二进制内容使用 `GET /v1/sessions/{id}/artifacts/{refId}?storeId=&scopeKind=&scopeId=`。宿主填主体，仅通过 `Runtime.readArtifact` 读取；原 Store、Session、引用和准确 session/execution/message scope 始终是访问依据。额外 path/hash/subject query 拒绝，hash 或文件名不授予访问。响应包含已核实完整字节、header 中实际 media type/size/hash、`Content-Disposition: attachment`、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。scope 错误、缺引用或 Store 不符局部失败，不关闭 Service；GET 不执行工作、不推进 SSE 游标。

默认进程在打开 SQLite 后明确创建宿主 Artifact store，将中立 port 注入 Runtime；Runtime 在 Store 之前关闭该 port。Windows 当前只对这个可选 leaf 报 `artifact_platform_unsupported`，其他 profile 权威失败不吞掉，也不补造 Artifact capability。Query 使用认证宿主主体核实范围引用，不接受 HTTP 自报 subject。

2 项实际集成测试通过 paired child 中的 Core Tool 发布无害字节，验证准确 binary SDK 下载、原 scope、错误 Store/Session/scope、path/hash 注入拒绝、认证、重复读取零效果以及活动 Run/event cursor 不变。另一个真实进行中 GET 在实际 Artifact store 的受控 reader barrier 被取消，原 Model 仍活动；其他 Service 主体拒绝。测试只用临时文件和 SQLite Worker，不读用户内容。维护 GC 和平台发行资格仍未完成。


默认全局登记 `@kite-ai/agent/files` 的 6 个 `files.*` Tool，每 Run 装配针对实际持久 Workspace root 选择这组定义，以及普通 version-1 `skills.load`/`skills.resource`。`effective.tools` 选择准确 ID；禁用项不在目录，未知 ID 拒绝新 Run，明确选择的 builtin version 必须匹配实际注册版本（`files.read@3`）。非空 Tool/Skill `options` 当前不支持，局部失败，不显示为未实际应用的 effective 设置。可信额外 Tool ID 只能经宿主 `knownToolIds` 提供，Runtime 仍核真实注册。配置不能提供 root、权限、Tool 实现或 capability grant。

Skills 是明确 `{id,path,enabled?,digest?}` 位置：相对路径限于选中 Workspace，绝对路径必须位于该 Workspace 或选中 profile 已有的 `skills` root。不发现 home/旧树或遍历任意目录；symlink 越界和重复物理位置局部不可用。可选 digest 固定 Skill 字节。摘要/版本/依赖事实进入 `skills.catalogue`；成功按需 Skill Tool 后全文进入 Model sources，`skills.resource` 后声明的文本资源进入来源。准确 source ID 与实际正文/资源字节 hash 绑定每次真实 Model execution。capture 刷新实际文件，不能用原 mtime/size 隐藏后续相关变更。脚本加载只读文本，不执行脚本；缺 required capability 显示局部不可用，明确请求失败，不补造已安装能力。

公开 `run.start/input.follow_up.selectedSkills` 是最多 256 个非空名称或配置 ID，每项最多 128 字符。原数组随 Command 保存并进入请求摘要；省略使用该次配置目录，显式 `[]` 选择零项。同 ID 改选择或混用省略与空数组产生冲突。默认装配明确支持 `run_skill_selection`；固定模型或未声明支持的自定义 resolver 不能静默忽略选择。私有 startup 不再接受该字段。每 Run 只由 Service 读取配置，使用同一验证过的 canonical catalogue 唯一匹配，name/ID 命中同项去重，未知或歧义在 vault.resolve/Provider 前以原 Command 持久拒绝。它只缩小实际 Skill catalogue、按需 lookup、source 和保存的配置快照，不发现路径、不新增 Tool、trusted root 或 capability。后续公开 Run 可明确换选择，原配置/来源保持原事实。[assembly 反例](test/isolated/assembly.test.ts)与[实际 CLI argv](../cli/test/isolated/host-skills.test.ts)验证别名、歧义、完整正文、两个 Run 快照和无信任零效果。

根和 child 的 Service 快照在同一顶层保存 `skillSelection:{requested,resolvedIds}`，其中 `requested:null` 表示公开原请求省略，`resolvedIds` 是该轮实际可用目录 ID。child 保留父请求事实，但只按父实际 ID 限制当前可信目录，不重新解释名称；父 marker 损坏或所选项失效时明确失败。Runtime 提供原执行链上最近的真实父 Run，runless Job 也不得退回全目录。确实没有祖先 Run 的可信 Action 调用仍按明确角色和当前配置装配。公开 follow-up 是独立选择；私有 child 续轮及自动 report 保留其原绑定。冷读取原请求、Run 和来源不启动 Provider。 选择身份及备选方案见[单次 Skill 选择决定](../../.agents/notes/implemented/architecture/2026-10-02-per-run-skill-selection.md)。

`createDefaultProcessConfiguration` 接受可信宿主 `permissions`、`knownToolIds` 和 `allowedToolCapabilities`。Skill 依赖核对使用宿主允许能力与选中 Tool ID 的交集，Skill metadata 或 Workspace 配置不能扩大它。非 Run host binding 只描述实际已注册的 Planning/MCP Action 与静态能力，Model 按每 Run 实际身份授权；当前持久模式装配见下文。每个保存的 snapshot 中 `actualCapabilities` 记录实际 Tool/extension 版本、发现的 Skill 版本、宿主依赖能力事实和独立 digest，不替代普通 Tool 授权。

resolver 返回每 Run 的 `extensions`、`sources` 与 `dispose`。项目来源针对实际 File Tool 的可信相对目标，读取从 root 到目标的 `AGENTS.md`/`CLAUDE.md`。Runtime 冻结选中定义，并在关闭 Workspace 文件 handle 前为后台操作保留 binding lease；后续配置不能替换活动 Run 的定义或快照。Files 保留其实际 FD/path/hash 身份、POSIX/no-follow 和外部编辑 CAS 约束；大正文通过原 scope Artifact 和通用 Model 正文交接，范围以 [Files owner](../../packages/agent/src/tools/files/README.md)和[Model 正文 owner](../../packages/agent/src/model-body/README.md)为准，不声明 Windows 资格完成。

默认全局 [Files checkpoint 配置](src/file-checkpoint-configuration.ts) 唯一登记 `builtin.files@1` 和准确六个 Files Tool，Run resolver 只选择这组定义，不重复注册。纯 metadata factory 不解析 Runtime 或打开文件；实际 scope 从当前 Store/Session/Workspace 的可信事实取得 canonical root，每次独立关闭 FD。捕获固定原 Run 已封存的 `contextSelectionId`，逐项核实际 Tool→成功 Model decisionSource、完整 sealed Model input/hash、原 Command/subject 与完整消费 User 的准确 source IDs/正文。nullable Execution delivery selection 不替代原 Run pin，后来 User 不成为旧 Tool trigger。

当前selected history按实际selection/upper完整分页；8192 Messages、64MiB累计来源证明、8MiB单页超限明确拒绝。历史capture verification改由私有`readOriginalRunSelection`从actual Run/Command pin读取当时选择，再按原trigger上界读取完整历史；当前point资格另核current selection。同Session保全Messages但换ID不会误拒旧点，排除trigger仍unavailable。已发布compression逐层核完整input/output/origin，前缀仅定位候选，真实User碰撞不被排除。restore逐项核原Source、Artifact EOF/hash/size及真实postbaseline；v2 journal/effect ledger保实际新inode或确认missing，v1只读不回填。默认full仍独立人类Ask，不继承原Tool/旧Store授权；原ID/cold只读原journal/carrier。

默认scope开启`protectReads:true`，保护canonical Profile/协调目录、`.git`与实际Service/Bun/SQLite/Shell/MCP/parser loader及companion；原六Tools使用准确组件范围。纯loader getters提供实际位置，custom extractor不附默认parser，单文件bundle不封其父项目。此前[默认capture](test/isolated/file-checkpoint-default.test.ts)、[两层compression](test/isolated/file-checkpoint-compression.test.ts)、[资产scope](test/isolated/file-checkpoint-runtime-assets.test.ts)与[真实A→B](test/isolated/file-checkpoint-restored-profile.test.ts)分别保其冻结证据；本轮[默认Fork/selector](test/isolated/file-checkpoint-fork.test.ts)3/316/0核两层aliases/未选B后像、实际codeB新inode后Fork与earlyA恢复、same-S新selector保留或排除原trigger。host head fault probe保持immutable来源、主体与真实CAS；cold原ID/provider8不重派。当前capture18/231、受影响Browser七文件29/570另为独立运行。完整合同归[Files owner](../../packages/agent/src/business/file-checkpoints/README.md)，三范围客户端与平台资格继续独立验证。

私有 startup 可携闭合三字段 `runtimeProtection:{kind:"terminal.candidate",root,manifestSha256}`，仅由 trusted launcher 提供，不进入 HTTP、Model 或 JSONC。独立 [runtime-assets verifier](src/runtime-assets.ts) 与 CLI 共用唯一完整 terminal manifest/tree 校验，核真实 entrypoint、固定 executable 和 `terminal-<manifest digest>`；它证明完整性，不授予发布或业务权限。子 Service 先独立持有 candidate shared 使用锁，再将验证后的整个 root 加入默认 Files 保护；默认 closure 拒绝其内 Worker/CLI code 读写而邻接工作文件可读写。锁在 Runtime、Workspace handles 与 reader/stream cleanup 全部确认后才释放，失败保 listener/lease。实际 [terminal runtime protection](../../tests/isolated/unified-agent/terminal-runtime-protection.test.ts) 1/23 覆盖公开 builder、native paired 与启动 CLI 退出后的 daemon，自有实例停止后才允许 exclusive lock；新的 [single-file actual qualifier](../../tests/isolated/unified-agent/single-file-runtime-protection.test.ts) 两次 1/34 核准确 source/custom loader、parser/hash/Bun 保护、邻接成功、cold 只读、所属进程退出及实际 trusted `afterResourceClose` 失败保持 listener/shared lease；它只证明该失败位置，不概括任意 cleanup 失败。当前完整候选 [terminal bundle](../../tests/isolated/unified-agent/terminal-bundle.test.ts) 1/2521 另核搬迁、CLI/TUI/daemon、archive/install、升级回滚/卸载使用锁。完整平台安装、signed publisher 与正式入口退役仍未资格。

6 项定向测试包含真实独立 discovery 文件及 4 项 paired Service/SQLite/本机 compatible 端点场景：权限 barrier 中指令变化阻止旧文件写入并触发新的实际 Model 决策；Skill 正文/资源按需进入来源且不执行脚本；依赖与未知 Tool 选择局部失败；禁用 File Tool 只影响下一 Run，已准入等待 Run 保持原 binding 和快照。既有配置/vault 测试仍属于 owner 验证。

默认 MCP 有两种可信来源。已有 programmatic `createDefaultProcessConfiguration({mcp})` 固定 Server 与合格 `transportPort` 保持独立；新增 [mcp-source-configuration.ts](src/mcp-source-configuration.ts) 从选定 Profile 的 `mcp.json` 和实际 canonical Workspace 的 `.kite-code/mcp.json` 捕获原始条目，复用唯一全局 `builtin.mcp` lifecycle。原始 URL、command/args/env、认证材料和 unknown 字段只留在 host 私人来源，普通 Run/Job/Model 与 Query 只有安全 ID、名称、来源身份、版本、摘要和准入事实。项目同名 disabled、坏项、pending 或 rejected 仍遮蔽用户项。JSONC `mcp` 只选择 `{id,enabled?,configDigest?,definitionVersion?}`；所有层均省略时选择已准入的有效来源，显式解析为空则选择零项，不能用选择动作批准来源。错误可选源不阻止无关 Files/Model；无合格 transport 的已选择静态 Server 仍在 Provider 前拒绝。

Process assembler 把 source factory 绑定到真实 Runtime，stdio 只使用已构建的公开 guardian `.js` 资产，不退回源码 `.ts`。独立尚未绑定 Runtime 的工厂没有 raw source authority；其 source selection 为明确空项，不能伪造文件观察。冷重建要使用真实原 Store/Session/Workspace；原来源 snapshot 不等时在 Model vault lookup 前拒绝。实际目录根采用 canonical realpath/devino，保留 macOS `/var` 祖先别名兼容，仍拒绝 Workspace 目录本身的 symlink。

普通 `mcp.sources.list@1` 提供冻结原 Run 安全目录与完整分页，`builtin.mcp.sources/mcp.sources` Query 读取当前安全目录，二者均不连接或查询 vault。来源批准和凭据绑定分别通过普通 Action、原 question accepted decision 与 HostMutation 保存；它们不替代 Workspace trust 或 Tool grant。`mcp.connect` 创建真实 `mcp.source.connection@1` Job，连接 Tool、Job、远端 Tool 各自授权。Job input 只有原 Store、safe server/config/capture digest、原 parent Execution/input digest、operation key 和 bootstrap ID。源/变量/批准/credential binding 在实际 vault/DNS、HTTP request 或 guardian spawn 前复核；拒绝、取消与无法确认 handle 停止保持准确原事实。HTTP loopback 只在可信测试选项中开放，stdio 资格及公共制品仍按实际日志记录。

认证当前接线为 none 或由真实原 question 绑定、尚未过期/撤销的 opaque Bearer。raw 配置的 vaultRef 本身不授读取资格；headers、OAuth、旧 policy 和续期尚未交付。child 的默认 resolver 使用实际父 Execution/Run/Session/Command 与 Workspace 派生有限来源，保留原 raw/transport/metadata/read-set，激活时核实际 carrier、child configuration、root work、主体和祖先链；每个 child connect、source Job 与远端 Tool 继续独立授权，父 grant 不复用。角色包装必须匹配真实 role/version，不能把任意 JSON 当父来源。来源漂移、未连接父 schema 或不能核实原范围时局部拒绝；完整嵌套与冷子任务资格仍在验证。旧全局 home 不属于新来源。

[默认原始来源测试](test/isolated/mcp-source-default-configuration.test.ts)真实通过 safe directory 到 connect Tool/source Job/remote Tool 的三次独立 Ask、remote annotations 不扩权、完整快照/八字段 Job input 脱敏、冷源变化前零 Model 凭据查询及恢复原 snapshot、坏源/显式空选择下普通 Files 工作。[源码树外默认 stdio 制品](test/isolated/mcp-source-packaged-default.test.ts)独立 1/47：无 configure、原 profile/home、实际 guardian/server、一次效果、公开脱敏、准确取消两个所属 PID 与冷查询零 RPC。[派生来源](test/isolated/mcp-source-delegated.test.ts)和[默认 child 实际链](test/isolated/mcp-source-default-child.test.ts)分别核实际原父 scope 与真实直接/嵌套 child、独立审批、原载荷/schema 和来源漂移。最终默认 child 三例 3/117、MCP 二十文件 115/1433/0fail；之前七文件 41/490、十七文件 105/1218 和十九文件资格只属于当时冻结范围。nested 夹具最终采用 30 秒总观察预算，直接/拒绝/漂移/冷读仍 15 秒；原 15 秒失败和独立时间线保留，产品 child 30 分钟、原 permissions 与 required/attached 关系不变，不形成性能承诺。公开 child 冷 resume、OAuth/renewal、旧 policy、OS vault 与正式三平台资格仍按[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)闭合。

[实际冷后显式新连接](test/isolated/mcp-cold-reconnect.test.ts)使用公开 process/default configuration 工厂、源码外 Host 与已验证 candidate，同一 Profile/Store 正常关闭后重开。新 Action 和 connection Job 分别取得新的原 Ask 卡，才发生初始化、目录发现及下一安全 Step 的新 schema Tool；warm/cold 各一次真实效果。冷 bootstrap 后原历史 GET 窗口零 POST/Model/credential/socket/RPC；原 key 和 refresh 局部拒绝，旧 record/operation ref 不附上新目录。批准等待期间仅改变 source 原字节，真实 Job 在 socket 前拒绝，效果保持。当前单例1项65断言、固定10s业务/30s阶段/180s测试通过；stage 超时收束、网络关闭与证据发布的清理控制经源码审查，异常分支未实际注入。资格只覆盖本机 macOS/Bun、auth:none、可信 pinned loopback、fixture 独立 Ask 和正常 paired 关闭；不代表管理 UI 重连、OAuth/vault、SIGKILL/Task reconcile、Linux/Windows 或安装资格。实际原 IDs、冻结 SHA 与全部历史日志见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#冷后显式新-mcp-连接的公共链)。

[configuration.ts](src/configuration.ts) 还导出可信同步 `McpHostFactory({profile,credentialVault})`。`options.mcp` 可以保持原配置对象，也可使用该 factory；默认装配先建立唯一 vault，再调用 factory 一次，MCP broker 与配置/凭据 manager 共用同一 vault。factory 收到冻结的选中 profile，凭据引用在宿主侧解析，不复制凭据后端、不从 JSONC 取得 URL、reference 或 Authorization header 权威。JSONC 仍只选择宿主已登记的 server 与准确 digest/version；这个入口不自动连接 transport，不使配置内容产生权限，也不声明完整 OAuth 流程或 OS 凭据资格完成。

[默认 MCP 凭据测试](test/isolated/default-mcp-credentials.test.ts) 的 2 项测试、35 条断言证明默认 factory 的 profile/vault 交接、共享凭据管理、真实本机 RPC 与下一 Model 的准确 remote 目录、等待批准时零 secret/socket，以及查找期间撤销凭据阻止迟到 remote 请求；受影响的 5 文件组合通过 21 项测试、256 条断言。这些计数来自对应实际回归，不合并成全库或平台资格；没有调用付费 Provider 或用户 keychain。

配置解析与每次 Step reader 不进行网络/进程 I/O。普通 `mcp.connect` Tool/Action 创建持久 detached connection Job，仅已派发 `start` 打开 transport 并发现 tools。下一安全 Model checkpoint 取得已缓存的附加 remote Extension、准确 schema/version、静态选中 Files/Skills/business Tool，以及非秘密 selected-server/config-digest/cache 事实，不复制全局 Extension。Ask 分别授权 connect（`external`）、connection Job（`network` 或 `process`）和各 remote Tool（`unknown`，不能从 annotations 得到 safeRead）。缓存目录 Query 零 Model/RPC，不从历史恢复推断重连。factory 生命周期覆盖进程/已知 Job，不随单 Run Files disposer 结束；准确 Session 后台取消停止其已知连接，另一 Session 保持 live。Core/Job 关闭监督所属 transport 事实，保留 unknown 停止结果。

四个静态 `mcp.resources.list/read`、`mcp.prompts.list/get` Tool/同名 Action 走同一普通持久执行面，metadata/allowed 表按每项准确 kind/ID/version 登记为 external、safeRead=false。Run 派发按原 frozen server/config 选择核准；非 Run Action 从实际 Session/Workspace 读取当前 trusted selection，并独立授权。JSONC 不能提供 URI/name 权限、transport、认证或执行代码。所有调用须绑定原 connectionKey/configDigest/generation；read/get 再绑定真实成功的 list Execution 与 canonical descriptor digest。固定原 live client、完整低信任正文/Artifact 和未知事实保留规则由 [MCP owner](../../packages/agent/src/mcp/README.md)负责。只读 Query `mcp.resources`、`mcp.prompts` 在冷打开时返回原缓存与 live=false，不连接或恢复历史。正常 process 的原 scoped ArtifactStore 支持完整大正文，缺该能力局部报告 unknown。

[资源/提示默认装配测试](test/isolated/mcp-resources-prompts.test.ts)使用真实 fixed compatible SDK、SQLite/ArtifactStore、pinned loopback HTTP 和 owned macOS stdio guardian，验证四项普通 Model Tool、普通 Action、独立 deny/持久 Ask、原目录/参数、scope/version 拒绝、完整 Prompt 低信任来源、冷查询零 I/O 与 wire 前后取消。不是付费 Provider、真实 OAuth、用户 keychain、完整 server 管理或跨平台资格。

[planning-configuration.ts](src/planning-configuration.ts) 验证原 Command 中已知、唯一 version-1 `builtin.planning` / `builtin.skill-workflow` envelopes，单次计划仅接受 `{mode:"plan"}`。Workflow 仅接收自身筛选后的输入，原 Command/body/digest 不改写；坏/重复/未知输入在 vault 与 Provider 前拒绝。单次 Plan 在实际 Run initializer 建立不可变 `plan.required`，从实际 assembly safe-read 定义封存准确版本。当前权限之外叠加计划执行方式上界；所有 hard denial/control read-set 保留，Full 不能绕过未批准计划，Auto 仍取得独立 reviewer，Ask/撤销 trust 仍独立生效。

批准记录为原 Run-specific immutable proof。子任务/嵌套 runless Job 的 ceiling 核实际 parent chain/root work 和原父 Run；必要条件仍在最终原 record/control CAS 重核。下一 Run 不借用旧批准。源请求公共类型不新增 guessed Run 字段；实际 active approved Run 的贡献只提供信息，不授权限。完整大计划封存为原 review Execution Artifact，原 accepted request/hash/UTF8/plan digest/proof/seal revision 由 [Planning owner](../../packages/agent/src/business/planning/README.md)负责核对；丢失或变化不继续批准。

[per-Run 默认测试](test/isolated/per-run-planning-configuration.test.ts)和[真实 parent/child 测试](test/isolated/per-run-planning-child.test.ts)覆盖实际 Service/SQLite/SDK/固定 Provider、Full 预批准零写/Job/child、只读分析、选定方式与当前权限交集、真实步骤回执/完成、same-Session next Run 拒借及冷策略变化前零 vault；最终 child 派发前仅增原 parent head revision 保 JSON 的外部 SQL 漂移也拒绝零写。Planning leaf/Artifact 与相关业务三文件现为 50 项/454 断言；Task 默认报告与规划相关九文件现为 48 项/747 断言。TUI 文件/Plan 相关十九文件 119/1063 保留四个真实 80×24 单次入口/排队/草稿/约143KB完整计划/回答丢回执窗口；客户端强杀后的普通 Work/Planning intent 和正式旧入口/平台资格继续验证。

[mcp-management.ts](src/mcp-management.ts) 提供独立普通扩展 `builtin.mcp.management@1`。默认工厂即使没有注册 Server，也注册闭合空输入 Query `mcp.servers`；它根据实际 Store/Session/Workspace 身份读取安全 registry、当前 selection 和六字段 read-set，零连接/vault/Model。普通 Action `mcp.server.select@1` 只选择可信 registry 已准入的 Server，独立核真实 Execution/Command/主体，沿原 config HostMutation 保存一次，原目标锁内复核两来源、explicit/registry 和 canonical Workspace。注释和 unknown 字段保留；文件已发布但 SQLite 回执未落定时保原 mutation pending/unknown，只查询原 ID，不重做。该 manager 不能注册原始 URL/command/env/auth；原始来源由上文独立 factory 私人读取。

`mcp.catalogue.refresh@1` 是独立普通 Tool/Action，只能刷新准确原 live connection Execution/key/configDigest/generation，不能冷连接或 lazy start。每个 RPC 前复核原 client/scope/signal；原连接记录不可变，刷新事实绑定实际 refresh Execution。新目录在下一安全 Step 生效，旧 capture 失效、历史 Query 保原事实；停止后替换连接不能把新目录写到旧引用。runless refresh 和 resources/prompts 均先核实际 Session 当前 selected-server 范围，再委托显式宽权限。管理/刷新与相邻资源/提示最终 15 文件 76/957 的本机资格见[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)和[管理测试](test/isolated/mcp-management.test.ts)，不证明 OAuth 或默认原始源已完成。

[MCP Task 测试](test/isolated/mcp-tasks.test.ts)和[凭据边界测试](test/isolated/mcp-credentials.test.ts)保留全部业务断言，并对三个无法确认 Job 停止的 fixture 明确验证：`Runtime.close()` 返回 `shutdown_cleanup_unconfirmed`，生命周期为 `drain_failed`，原 Store 仍可读、unknown Execution 不被改写，且不增加 Task 创建、Model 或凭据查找。取消 acknowledgement 和失去远端观察不能变成实际停止证明；可信连接 Job 已进入 `start`、但凭据边界在 socket 前拒绝的事实，也不会替 Core 伪造未知 handle 的退出。只有证明生产保留资源后，测试才显式关闭自己拥有的 loopback HTTP、临时 Store 和临时 vault 资源，不清理真实远端 Task 或用户数据。该两文件独立复验 10 项测试、128 条断言通过。

[MCP 配置测试](test/isolated/mcp-configuration.test.ts)使用实际默认配置、SQLite/Core、本机 compatible/MCP HTTP 端点，验证网络前 Job 派发、下一 Model 的准确 remote schema 与单次 RPC、独立 Ask 卡、缓存 Query 零写入/Model/效果、Session 隔离及无效/不可用选项局部失败。注入 localhost port 仅取得测试资格。独立导出的 [HTTP port](src/mcp-http-port.ts)有本机 socket/DNS candidate/pinning/proxy/redirect 证据；[Agent stdio port](../../packages/agent/src/mcp/README.md)有明确 macOS 继承进程组与打包 guardian 证据。两者都要求原 Job 可信准入，不能从 JSONC 取得。真实 TLS、完整 credential broker/OAuth、MCP tasks 和跨平台发行资格仍未完成。resolver 不预连接或启动 raw stdio。


W08 追加输入使用原命令入口：`input.steer` 显式携带 `content`、`targetRunId`、`contextSelectionId`；`input.follow_up` 显式携带 `content`、`afterRunId`（可为 null）、`contextSelectionId` 和可选 `modelId`。两者要求固定 `expectedStoreId` 与原 `commandId`，只允许 root Session，主体由宿主提供。202 返回原 accepted 命令，应用结果须查原命令的 `input_applied` 回执，不能把接收视为新消息或 Run 已产生。精确取消尚未应用的输入不会产生消息或新 Run；取消原 Run 保留独立 follow-up 意图。Store、目标和上下文不匹配返回有限错误，不重选当前目标。

`GET /v1/sessions/{id}/inputs?storeId=&kind=&targetRunId=&afterSeq=&limit=` 是纯只读、最多 200 条的待应用输入 keyset 页面，包含原内容、目标、context 及命令投影，不执行消费，不公开主体或 owner。`seq`、`nextAfterSeq`、`snapshotCursor` 均保持十进制字符串。消息投影保留 `originCommandId`、`contextSelectionId`、`inputKind` 和 `sourceIds`。输入内容必须非空白且不超过 1 MiB UTF-8；默认命令 HTTP frame 为 8 MiB，以容纳最坏 JSON 转义与固定 envelope，显式宿主 `maxBodyBytes` 仍生效。

[真实 Core/HTTP 输入测试](../../tests/isolated/unified-agent/client-inputs.test.ts) 在 macOS/Bun、临时 SQLite Worker 和固定模型下通过五项测试：12 条 steer 无隐式八条限制、旧模型请求不改写、旧 Tool 零派发且消息配对完整、独立 follow-up 与精准取消、Store/目标/context 拒绝零事实、真实 child 的直接输入拒绝，以及完整 1 MiB 内容的转义 frame。它证明当前公共协议及同 Loop 消费；正式客户端交互展示、后续 context selection 切换和跨平台发布资格另有负责验证，不能由本测试推出。


R10 公共上下文使用 `GET /v1/sessions/{id}/context?storeId=&contextSelectionId=&afterSeq=&upperSeq=&messageLimit=&afterSourceId=&sourceLimit=&byteLimit=`。读取固定 selection/high-water，消息和结果来源分别返回 keyset 游标；每页最多 200 条消息、100 个来源、8 MiB 内容预算。来源只投影原 Store/Session/selection/execution/revision、inclusion 与结果，不公开 owner 或主体权威，不推进 SSE。公共 Execution 可选投影 `originStoreId`；当前 Core 恒提供，缺失的客户端只能显示 unavailable，不能推断为当前 Store。历史消息 GET 不受选择删除影响。

`POST /v1/sessions/{id}/context/select` 精确使用 `{expectedStoreId,commandId,expectedContextSelectionId,boundary:{messageId,seq}|null}` 做 root 空闲 CAS；整组 live/planned/unknown execution 阻止选择，不回滚文件或执行效果。`POST /v1/sessions/{id}/results/{executionId}/include` 使用同一 Store/命令/selection 加准确 `resultRevision`，只把已有结果显式纳入上下文，不启动 Run 或重放 Tool/Job。原 suppressed delivery 不改为 pending；活动 Run 返回 `input_busy`。主体仅由宿主填入，内部 `consumeJobResult` 没有 HTTP 入口。closing 时两种 mutation 均拒绝，纯读取保持独立。

[公共上下文集成测试](../../tests/isolated/unified-agent/client-context.test.ts) 使用真实 Service、SQLite Worker、固定 Model 与普通 Action/Job 证明空闲选择、原回执幂等、分页、历史不删除、活 Job 拒绝选择、终态结果被 rewind 抑制后明确 include，以及错误身份/revision/context 的局部拒绝。实际新模型请求排除 rewind 前旧消息，按准确 source ID 纳入显式结果并保存原 Store/execution/revision/inclusion；held Model 期间新的 include 返回 input_busy，零命令、零 Job 重放。合法 1 MiB 追加输入的最坏转义正文在 8 MiB context 页与实际新 Model 中完整保留，较小显式预算准确报超限。活动 Run 中显式 include 的 steer 整合不在本切片。


默认权限迁移的独立 leaf 位于 [permissions.ts](src/permissions.ts)：`createPermissionPolicy({readPolicy,describeCapability,readReviewContext?})` 返回 Core 的 `Permissions`。每次调用读取宿主当前策略 `{mode:ask|accept_edits|auto|full,workspaceTrust,revision,allowed}` 与真实已注册 capability 的 kind/definition/version/revision/effects/hardAllowed/safeRead；Tool 描述或远端文本不是能力依据。策略与能力语义的稳定摘要共同成为 approval policy revision，即使宿主忘记增加显式 revision，实际 trust/模式/allowlist/能力变化也使旧批准失效。构造及 import 不执行 I/O。

Model 必须有准确 kind 的允许项，不给同名 Tool 授权。所有非 Model 操作先核对当前 Workspace trust、准确注册版本、allowlist 与硬可用性，失败不会生成可扩大该边界的人工卡。Ask 只直接允许宿主标记 safeRead 的实际纯读取，其他生成精确审批；Accept Edits 允许可信 Workspace 内的 read/edit，其余审批。Full 跳过普通逐项风险审批，但不跳过这些硬约束或取消；不确定 effect 仍由真实宿主执行能力限制。所有审批的最终参数、执行身份和重新校验由现有 Core Interaction/UnifiedExecution 负责。

Auto 分类只返回准确 invocation、effects 及可选只读 task/plan/拒绝理由，不执行 Provider。Core 使用实际 `authorizationReview` 建立持久 child/carrier，经同一 Loop 的唯一无 Tool Model 取得闭合单次决定与准确 proof；失败或 ask_user 返回原调用的真实人工卡，reject 结束原工作。默认每 Run reviewer 使用该 Run 已封存的 SDK route/options 与绑定版本；宿主可显式覆盖，独立无 Run Action 没有默认 SDK reviewer 时仍准确人工回退。大请求由[通用 Model 正文](../../packages/agent/src/model-body/README.md)完整封存和展开，真实 Model input hash 参与最终证明，公开文字不能自报 Execution 或签发永久许可。旧 `same_command` 会话策略及正式客户端模式/trust 设置仍未迁移。

[真实权限测试](test/isolated/permissions.test.ts) 用临时 SQLite Worker、同 Core Loop 和固定 Model 验证：准确单次批准与原命令重复零重放；等待中 trust/allowlist/注册可用性/模式变化后的旧批准零 Tool 效果；可信 read/edit 与 Full 普通风险跳过；同名 Model/Tool 隔离；Full 硬约束和版本拒绝；未装配 Core reviewer 时 Auto 准确人工回退；默认 SDK reviewer 的真实证据见下段。有限无 I/O 校验另验证 capability 数量和取消，不以策略真值表代替派发证据。


`createDefaultProcessConfiguration({profile,permissions?,permissionPolicy?:{readPolicy},...})` 为每个新 Run 返回其实际 `permissions`。显式 `permissions` 始终优先，保持可信测试/宿主装配；否则 programmatic `readPolicy` 每次派发与审批接纳前重读。没有两者时，`permissionManagement(runtime)` 将默认装配绑定到真实 Runtime，默认读取当前 Store 的持久模式与信任。新用户/尚无模式记录的 Session 默认 Auto，Workspace 缺持久确认时未信任；仍允许本 Run 准确 kind/model ID/version 的实际 Model，Tool 不会通过单次审批越过 trust。直接测试宿主尚未绑定 Runtime 时保持 Auto/untrusted 的安全只读默认。权限模式、trust 或 allowlist 不能从 JSONC、MCP 描述或 Skill 元数据生成。

`describeCapability` 由当次真实 assembly 产生：选中的 builtin files read/list/glob/search 和 Skill load/resource 是 safe read；files write/edit 是 Workspace write；真实注册但未识别的其他能力是 unknown，缺实际注册则拒绝。实际 `files.read@3`、`files.write/edit/search/glob@2`、`files.list@1` 来自当次定义，配置不能改写它。Shell 仅在下文可信宿主显式选择的执行资格与真实 guardian 下注册；MCP 仅在上文明确 programmatic lifecycle/port 配置下注册。当前六个 files Tools 没有 mkdir，不因权限分类保留可能的未来 ID 就宣称已提供该工具。

旧 Run 保留原 manifest/definitions 与文件绑定，单纯禁用后续 Tool 配置不等于全局撤权；当前 mode/trust/allowlist 的变化仍会在派发前生效。新 Run 重读配置并封存新目录。默认每次授权允许集合包含实际已选中的静态能力和纯缓存 MCP 动态 Tool/Task Job 目录，不为未注册定义补授权；读取该集合不打开连接。非 Run Action 根据原 Execution/Command 取得准确 Store、Session 与宿主主体，再读取同一控制事实，不采用当前 UI 选择或全局猜测。

[默认权限配置测试](test/isolated/permission-configuration.test.ts) 使用实际默认 resolver、SDK、Service HTTP、SQLite Worker、安全文件 leaf 和本机兼容 Model 端点，证明 Ask 单次批准真实写入、Accept Edits 无卡写入、Full/default trust 拒绝、旧 manifest 与当前撤权区别、新 Run 目录变化、显式 Permissions 优先以及错误 builtin version 在 Provider I/O 前拒绝。与既有 default configuration 和 assembly HTTP 回归合计 12 项测试、105 条断言通过；未调用付费模型、用户 keychain 或旧数据。[默认 Auto 测试](test/isolated/auto-configuration.test.ts)与 policy 组合 11/137 通过：单模型槽、完整 task、新旧 SDK route、单次批准、Provider/闭合输出失败与 ask_user 原卡回退、拒绝以及撤权/取消零文件效果。测试按正式 main 装配真实 ArtifactStore，避免把缺内容能力的人工回退误判为 reviewer 成功。会话 same_command 与原 epoch 清除已接入下述授权目录；正式入口切换仍按完整客户端资格核对。

默认进程装配唯一全局 `@kite-ai/agent/planning` 业务 Extension，其目录、空闲 Action 与只读 Query 不依赖前台 Run。JSONC `tools` 只选择明确注册的 planning/validation Tool ID 和准确支持版本，不能启用 requirements、允许 waiver 或授予权限。只有可信 `createDefaultProcessConfiguration({planning: PlanningOptions})` 提供 `requirePlan`、`requiredValidation`、`allowWaiver`、required receipt definitions 和允许执行模式。选中的业务定义取得真实保守权限描述：`planning.read` 是 safe read；planning write/update/review 与 validation define/check/rebind/waiver 是 `record_write`，`safeRead:false`；显式宿主 Permissions 始终优先。空闲 Action 使用相同 programmatic `readPolicy`，准确身份为 `kind:job`、`builtin.planning/<action>` 和实际 version；默认未信任策略拒绝，可信 Ask 产生普通审批，显式 Permissions 仍优先。`record_write` 修改封存治理记录，不等于 Workspace 文件写入或执行结果，Accept Edits 不自动允许它。Auto 使用当前 Run 封存的同一持久 Core reviewer，独立无 Run Action 要求显式可信 reviewer，否则准确人工回退。目录可见不授予权限。每个新 Run 保存工厂 conditions、启用的纯 metadata initializer 和实际非秘密 option/definition snapshot，包括宿主选中的 `fileHashChecker` ID/version 或明确 null；JSONC 不能选择 checker。嵌套 validation checker Execution 保持独立 Tool 授权，权限审批不会回答独立 validation waiver 问题。不启用治理 flag 时，普通会话保持不受这些要求约束。[Planning 默认配置测试](test/isolated/planning-configuration.test.ts)用本机 compatible 端点与 SQLite/Core，验证首次 Provider 请求前初始化、准确用户 plan review、真实私有文件 receipt 完成 progress、无额外 Model/Run 的空闲 Action/Query、错误版本在 Provider I/O 前拒绝，以及保存的 waiver 不能为缺证据的后续 Run 授权。这证明默认装配与便携业务路径，不等于正式 UI、外部 validator 或平台发行资格。


默认 Service 现支持可信宿主通过 `createDefaultProcessConfiguration({child:[{id,version,modelId?,toolIds?}]})` 声明有限 child 配置，入口见 [child-configuration.ts](src/child-configuration.ts)。该声明不来自 JSONC，也不是业务 AgentType 或权限模式。静态注册只有闭合 `{content:string}` 输入 schema、准确角色 id/version 和不可执行、无 I/O 的占位 Model；只有首次建立新 carrier 时，Core 提供实际原父 Execution/Run/Session/Command、Workspace 和取消信号，再由共享默认 resolver 重读选定新 profile 的 `config.jsonc` 与 Workspace 的 `kite-agent.jsonc`。显式角色 `modelId` 或原父 Run 封存的 `modelId` 固定路由选择身份，当前 JSONC `models` 只解析该已知身份的 compatible SDK 配置与凭据引用；没有模型、坏配置、未知/禁用 Tool 或未知角色均局部失败，不发现旧配置、不调用 Provider fallback。

每个新 carrier 重新建立实际 Workspace Files/Skills、来源与纯 Step 模块，冻结准确 Model route/options、目录版本和非秘密快照。显式 `toolIds` 限制当次已启用选择及未来 Step 可见 Tools；Core 进一步核实普通 child Tools/Jobs 的定义版本、schema、namespace 与实际父 Step 集合，并对准确调用形成父子权限交集。角色模型提供准确 `kind:model` 描述；carrier 独立提供 `kind:job agent/<id>@<version>`、`unknown` 效果与 `safeRead:false` 元数据。它们继续要求当前 programmatic policy 的准确 allowlist、trust 与必要 Ask，不复用 Model 或同名 Tool 的批准，不能从 JSONC 扩大权限。活动 child 保持原 SDK binding，即使后续配置更换 route；来源正文变化仍在下一安全 Model checkpoint 更新，旧等待调用不得硬派发。fresh Files disposer 由 Core binding lease 管理，child 和父 Run 完成之后仍有 detached Job 时继续持有，最后已监督终态后才释放。原 operation key/Command 查回已有持久引用，不重新解析配置、不重建 child 或恢复冷历史执行。

[test/isolated/child-configuration.test.ts](test/isolated/child-configuration.test.ts) 使用实际本机 compatible HTTP 端点、临时 SQLite、单 Model 槽、真实 Workspace 文件与受控许可/Job barrier，验证旧 child route、新 carrier Workspace 配置覆盖、source freshness、准确角色版本、父权限拒绝零文件效果、独立 carrier Job Ask 与 Model-only/trust 拒绝、可选 modelId 继承原父身份、失败前零 child Session/Provider、warm 重试、真实 Store 冷重开查回以及后台 Job 延迟释放绑定。未调用付费模型或用户凭据。此切片只交付可信默认装配，不声明产品 `task` Tool、满容量立即失败、期限、追加邮箱、正式客户端入口或跨平台资格已完成。

默认 Task 装配使用同一可信 `child` 声明创建一个全局 `builtin.task` Extension：角色 id 精确映射相同 child configuration id，描述由宿主生成。默认注册固定 `worker@1`，继承原父 Model 与已选 Tool；显式 trusted child 数组覆盖，显式空数组关闭 Task。JSONC 只能选择实际注册的 `task`、`task_read`、`task_wait`、`task_cancel`、`send_message`、`followup_task` 和准确版本，不能定义角色、扩大权限或补造配置。选中缺角色或错误版本在 Provider I/O 前局部拒绝。Task 工具封存原 OperationRef 自有记录，`task/send_message/followup_task` 元数据为 `unknown` + `record_write`，read/wait 为安全 read，cancel 为 unknown 控制效果；carrier 仍独立经过准确 `agent/<role>@version` Job 的当前 trust/allowlist/Ask，不复用 Task 或 Model 的批准。普通 child 能力继续受实际父 Step 集合和父权限交集限制。原 Command 重试读取原结果，不启动新 child；新父 Execution 同 key 不能重新绑定旧操作。配置变更与可信角色版本只影响后续 Run，新 snapshot 保存实际选定 Task 定义及角色版本。

[默认 Task 测试](test/isolated/task-configuration.test.ts) 使用本机 compatible SDK 端点、真实 SQLite、Workspace Files 与单 Model 槽，验证普通 Task/wait/read 实际链路、独立 carrier Ask、父策略拒绝零 child Provider、原 Command 重试零效果、JSONC 不能自造角色，以及新 Run 角色版本和 route 变更不覆盖原记录。容量预留、固定期限、私有 steer、follow-up 与默认 required 接纳由[Core/Task owner](../../packages/agent/src/extensions/task/README.md)的独立真实场景验证；QueueOnly/显式 idle 接纳与 root/nested/follow-up after_turn 的 Core 事实分别按 Task owner 证据核对；默认 SDK root/nested/follow-up 汇报已用同一实际 compatible SDK/SQLite 链验证，完整 retry/delivery 继续验证。正式客户端资格仍待完成。取消回执不等于外部工作已监督停止。

可信程序装配可传 `afterTurn:{authorize}`：原函数绑定冻结一次，JSONC 不能登记 authorizer 或启用续轮。真实 carrier 激活封存原 lease/route/authorizer 和适用期限，后来配置变更不改旧汇报。根汇报与嵌套/后续的普通 report Run 都走同一个 Loop/Model 权限；nested 汇报使用原 funding child deadline，report 不递归自授权。父仍活动则等待，人类工作先接纳则持久 `human_start_preferred`，原结果可读且不注入新人类 Run。缺旧 hot binding 冷恢复明确 needs_review，零 Provider，不盲重放。[默认 SDK root](test/isolated/after-turn-configuration.test.ts)与[nested/follow-up](test/isolated/after-turn-nested-configuration.test.ts)最终组合 4/87 核对原 route/authorizer、完整正文/source、原 funding child deadline、只读零请求与原 operation key 查回；已激活独立 child 不再误受旧父 carrier 终态拒绝，Store/generation/root stop/delete 和自身 carrier/期限仍最终复核。[Core 嵌套/后续](../../packages/agent/test/isolated/business/task/nested-after-turn.test.ts)与默认 SDK 的证据只覆盖这些子场景，完整 retry/delivery/冷恢复和正式客户端资格继续验证。

[after-turn-configuration.ts](src/after-turn-configuration.ts) 的默认有限 policy 仅允许实际原 Task/follow-up 明确 `after_turn` 的结果报告；required/background 不报告，普通 Shell 不获得该资格。它在 request/apply 读取当前可信 policy/trust 与原 role/source/root work，不授权 Task、carrier 或 Model；仅 custom permissions 而无可读 current policy 时明确拒绝。当前默认测试 11 例包含两种真实报告时序、control/source/head 漂移和非递归。父先完成的 fixture 显式使用两 Model 槽，生产默认单槽保持不变；单槽子先完成保 deferred，父完成后准确一次报告。

自动报告的新 Run 在原 SQL 事务继承父 `requirements` 引用，不重新登记外 Run refs。[planning-configuration.ts](src/planning-configuration.ts) 的 `readBoundJobReportParent` 从实际 report Command/receipt、原 source Execution、carrier result revision/afterTurn、父 Run/config/root work 和原主体核绑定；权限沿该有限历史关系读取原批准，任意同 Session 新 Run 不获得例外。报告仍受原 refs 的最终 head/proof/CAS，初始化不生成新的 Plan/Workflow 意图。Planning 历史 receipt 按原实际 Execution 的批准 Run 重建来源 digest，inactive Run 的当前信息贡献继续 `approval:null`。当前九文件 48/747 与 Planning 三文件 50/454 资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，源码外默认 Task、完整冷报告/客户端和平台仍待验证。

默认 Shell 可由可信宿主显式传入 `shell:{platform:'darwin',configurationId,env,supervisorPath,bunExecutable,shellExecutable,graceMs?,maxQueuedBytes?}`。JSONC 仅选择 `shell.launch/read/wait/stop@1`，不能传 executor、cwd、env 或执行资格；缺 host、未经资格的平台、缺 guardian/执行资产或错误版本均局部拒绝，不启动 Provider/进程 fallback。每个新 Run 从真实 Store Workspace 取得 root，封存 cwd、实际资产 bytes hash、宿主配置身份和 env key 名，完整固定 env 只保留在可信 binding，不进入快照或 Model 请求。实际 Job.start 前重新核对资产 bytes；工厂/import 不启动进程。当前 host opt-in 仅证明 macOS POSIX 进程组监督，不证明文件系统/网络沙箱或任意 setsid 逃逸隔离，Linux/Windows 默认资格仍未覆盖。

Shell Extension 属于每 Run 的实际绑定：`shell.launch` 经过普通 Tool 派发再 `operations.ensure` 创建准确 `shell.command@1` Job，Job 再独立进行 process/unknown 准入、持久派发、槽位与 guardian 启动。launch 保存自有原 OperationRef 并返回接纳事实，不能假报进程完成；Ask/Auto/Full 继续用当前准确 policy，Tool 的批准不授权 Job。read/wait 通过准确引用只读原执行，输出使用统一分页游标、高水位和 gap 事实；wait 超时不停止。stop 只提交原 Job 的取消请求，是否停止取决于 guardian 的真实 group proof，unknown 不改写成功。原 Command 重试不会启动新进程，新父 Execution 不能重绑同 key；后台 Job 的原 binding 由 Core lease 保留到已监督收尾，后续配置和新 Run 路由不覆盖原快照。

[test/isolated/shell-configuration.test.ts](test/isolated/shell-configuration.test.ts) 验证真实 local compatible SDK、SQLite、已构建 guardian、Workspace cwd/固定 env、输出 read/wait、独立 Ask、拒权零进程效果、准确强制 stop、后台父轮结束后持有原绑定、单进程槽跨 Session 前进以及下一 Run 路由和原记录保持。这里只交付普通默认 Tool+Job 装配，现有 Shell Job/paired lifecycle 测试仍负责 EOF、SIGKILL、后代与 unknown 恢复证据；没有增加另一 manager、旧 runtime fallback 或生产安装资格声明。

默认 Shell 的可信 command digest 固定实际 Tool/Job kind/definition/version、准确 command、Tool attached/detached、host configuration、canonical cwd、克隆的完整 env、实际 guardian/Bun/Shell bytes hash 和生效 grace/output queue；只排除新的 operation key。默认值与 Job 一致：200ms、256KiB。通用 Core 不按 Tool 名称猜命令或剥字段，非 Shell 默认仍用完整 input digest。两个新 key 的相同命令只在当前 policy 仍提供 same_command 且最终权限/epoch/必要义务成立时复用授权，Tool/Job 授权相互独立。真实 Shell/CLI/Client 组合 19 tests/180 assertions 通过，含环境/默认语义 hash 反例、命令变更重新审批、撤销后重新审批和 clear 提交后物理断线只查询原回执。

默认 resolver 通过 [web-fetch-configuration.ts](src/web-fetch-configuration.ts)装配普通 `builtin.web@1` / `web_fetch@1`。`createDefaultProcessConfiguration({webFetch?})` 只接受可信宿主的 network policy/admission 与可选 extractor；缺省开发网络策略为 public，仍逐跳检查全部 DNS 地址、拒绝私有/保留/本机目标并固定真实 socket。显式 off/allowlist 与当前宿主 `admitHop` 继续约束原请求、robots 和每次跳转，普通 Tool 仍独立经过 Core 的当前授权。实际元数据为 `network`/`unknown`、`safeRead:false`，off 为不可用；每个新 Run 封存准确 Tool 版本和非秘密 `snapshot.web`。JSONC 仅选择 Tool 与准确版本，不能提供网络权威、代理 header 或 SSRF 例外。工厂创建不进行 DNS、解析或网络 I/O。

[默认 Web Fetch 回归](test/isolated/default-web-fetch.test.ts) 3 项、32 条断言使用真实 Service/Client/Core/SQLite、本机兼容 Model 和无害 HTTP：四次 socket 前均有实际审计，完整约 125 KiB 正文通过原 scope Artifact 读回并进入下一 Provider 请求；off/当前撤权为零 DNS/socket，原 policy 修改不扩范围，坏 JSONC options/版本在 Provider 前拒绝。完整解析 Worker 属于已构建并核 hash 的包内资产，缺失时局部失败。真实 TLS、Linux/Windows 与原生制品资格仍按进度记录。

[permission-management.ts](src/permission-management.ts) 是 Native 宿主的持久用户控制 port：`readMode/readTrust/setMode/setTrust/getMutation` 都要求明确原 `expectedStoreId` 与宿主注入的 `subjectId`；写入还要求稳定 `commandId` 和已观测 revision。模式记录作用于准确 root Session，child 读取继承根模式但不能以 child Session 修改；`makeDefault` 只更新同一 Store/subject 的后续默认，不写项目 JSONC。信任记录作用于准确 Workspace/subject。控制 journal 与配置/凭据 journal 同库但 kind 独立，双方 getter 不将另一类记录强制转换为自身 mutation。

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


Settings 模型业务端口为 `GET /v1/config/{scope}/models?storeId=...&workspaceId=...` 和 `POST /v1/config/{scope}/models`，Native Client 对应 `getModelSettings` / `updateModelSettings`。观察仅返回原 Store/scope/Workspace、读取集合 `{userEtag,workspaceEtag,explicitDigest,effectiveDigest}`、期望默认模型和安全模型事实。`configured` 表示 compatible binding 的结构、endpoint、options 和 opaque reference 合法，不承诺凭据当前可解析、远端发现或模型可用；诊断失败保留 `readSet:null` 和有限错误，不伪造写资格。

业务请求冻结原 command/Store/Workspace、`expectedReadSet` 和单一操作 `{kind:"enabled",modelId,enabled}`、`{kind:"default",modelId}` 或 `{kind:"effort",modelId,reasoningEffort}`（有限枚举或 null）。服务重算完整目标作用域 effective 候选：当前默认模型不能直接禁用，默认只能选择已启用且 configured 的模型，启禁只修改目标模型字段，其他模型和无关注释/未知配置保持。用户作用域不宣称验证所有 Workspace 的覆盖配置。显式宿主覆盖导致操作无法真实生效时拒绝，不能返回假成功。普通 JSONC patch 的不可路由期望配置语义保持独立。

模型目录可投影实际 `reasoningEffort`、有限 `reasoningEffortChoices`、`reasoningEffortSupport` 和 `reasoningEffortReadonlyReason`；字段缺失不表示支持。`compatible_wire` 只说明当前 compatible adapter 能发送这些值，不能证明远端模型接受它们。unsupported、坏配置或宿主 explicit 覆盖会明确拒绝/只读，不初始化模型或读取凭据来猜测支持。effort 写入保留实际其他 options，null 只清目标作用域的 effort：若 options 为空则移除整组，可能恢复上层；若仍有其他项目 options，按既有整组覆盖规则继续遮蔽上层，实际有效值可以是 null。服务重读报告事实，不承诺清除必然继承。活动 Run 保留封存的原参数，后续新 Run 使用新配置。


目标配置原 ETag 和完整读取集合在真实目标文件短锁内重核，候选通过结构/default 规则后，发布前再核非目标文件与宿主 explicit/effective digest。读取集合竞争返回 `configuration_read_set_conflict`，不会覆盖竞争编辑。锁约束合作宿主对同一目标文件的写入；不同文件或不合作外部编辑在最终核查之后仍有跨文件竞态，文件/vault/SQLite 不是一个事务。没有向 HTTP 开放验证回调或路径。

持久 journal 沿用 config.user/workspace.write 的有限安全 `modelSettings` marker，Core 只校验闭合结构和原 ID 语义，不判断模型业务规则。公开原回执投影为 `kind:"model_settings.update"`、原 scope/ifMatch/readSet/operation 与 ETag，不返回内部任意对象。断线或坏 marker 仅原 ID/Store GET，不重放。真实 paired HTTP 测试验证当前默认约束、非目标用户文件竞争、原回执冷读取及一次已提交但物理丢失的响应；held 旧 Run 实际使用模型 A，保存后新 Run 实际使用 B，保存/查询/冷读没有新增 Provider 调用。


二进制 Artifact 响应以 `x-artifact-store-id` 返回实际不可变 reference 的原 Store。请求 `storeId` 校验当前已准入 Store，恢复媒体的原引用不重标成当前 Store；准入与原内容授权仍由 Runtime 实际 Session/owner 链完成，HTTP没有按 hash 另开访问路径。

有限生命周期接口使用可选 `service_lifecycle`：认证 Native 的 `GET /v1/lifecycle` 和 `POST /v1/lifecycle/shutdown` 独立于业务 Store 准入，Browser gateway 不映射。接口拒绝任何 Origin（包括空值）、额外 query 和未知主体字段。状态仅公开 `lifecycleVersion:1`、原 profile/instance/build/API major、实际 capabilities、真实数据可用性及 `accepting/draining/closed/drain_failed`、去重 busy reasons，不返回 Store 对象或凭据。Store 故障可读原实例诊断，不能建立替代空 Store。

关闭请求固定原 profile、instance 和 `if_idle/cancel`，不携业务 storeId。`if_idle` 同步重核已接纳 HTTP mutation 与 Runtime 工作后封门，竞争时返回 409 并保持接纳；普通 View/body GET 与 SSE 观察本身不算活动工作，但其资源使用仍延迟 Artifact/Store 关闭。慢请求正文和异步配置写入受 HTTP 接纳与解析后重核约束，不能穿过 drain 产生新修改。前期 drain 保留原读取/准确 cancel；Runtime 本地清理成功、关闭资源之前的唯一可信 callback 先封住最后业务资源入口，再调用装配时固定的宿主 `beforeResourceClose`；宿主可在此关闭 Gateway、abort 并排空其所属读取，随后 Service 等待原 Native HTTP 资源使用清零，最后才释放 Runtime Artifact/Store。先等待 Native HTTP 再关闭依赖它的 Gateway 可能循环等待，因此该顺序由真实 Gateway→Native held GET 的 abort barrier 验证。生命周期诊断仍可达，宿主回调失败进入 `drain_failed`，保留 HTTP、原 Store 和 profile-use 锁；重复关闭不替换或再次执行首次回调。

202 仅表示关闭受理。首次关闭缓存同一 completion，失败进入 `drain_failed` 并保持 cleanup busy、HTTP 诊断和未确认资源；不得在 finally 强制停止 listener 伪装完成。成功关闭后 runner 取消自己的父管道读取并真实退出，即使父管道仍打开；网络断开不代表父进程死亡。丢回复属于原实例未知结果，只能再次观察该实例，不自动重发 shutdown。当前仅有限接口与所属 runner，不代表正式 CLI 停机或 daemon 发现完成。

[实际 HTTP 与 runner 生命周期测试](test/isolated/lifecycle.test.ts)使用临时 profile/SQLite 和固定本地配置，覆盖闭合身份、空/同源 Origin、Browser 拒绝、慢正文、原配置 mutation 发布、慢纯 GET 排空、真实 Store metadata 故障、父管道仍打开时原 PID 退出与同 profile peer 存活、诊断无 Store 退出，以及未确认清理后原进程/HTTP 保留且维护仍 `owner_busy`。这些测试没有调用 Provider/Tool；失败 fixture 最终由测试的所属子进程清理回收，不把 SIGKILL 作为成功停机证据。

[共用进程装配测试](test/isolated/process-service.test.ts)覆盖原 profile 身份、装配过程中迟到的宿主回调替换、冷 Store 零模型执行和损坏 Store 的只读诊断；[Gateway 测试](test/isolated/development-web.test.ts)覆盖重复关闭同一 completion 与 abort 后真实慢读取排空及完整 17 MiB Model 正文的读取/传输中断，[生命周期测试](test/isolated/lifecycle.test.ts)同时保留配对父 EOF/管道存活验证，并通过真实失败宿主 child 证明诊断、Store 和维护锁保留。此共用装配不代表 daemon main 或正式 CLI 命令已经完成。

本切片的共用装配、Gateway、生命周期、paired 与真实 Model metadata 组合回归为 27 项测试、263 条断言；Service typecheck、文档结构/影响和测试 ownership 检查通过。测试只使用临时 profile、固定 Model 或本机兼容端点；17 MiB 正文生成沿用原 Agent 大正文测试的有限等待，不改变产品关闭期限。

装配失败时，只有原资源清理成功才重抛原错误。Runtime 构造后的 Artifact/Store 清理或 HTTP 装配后的 Runtime 清理失败，均抛出有限 `ProcessServiceCleanupError`，其 `code` 为 `process_service_cleanup_unconfirmed`，`phase` 区分 `runtime_assembly/http_assembly`。非枚举 Error cause 保留原错误和有限资源强引用，JSON 仅投影 code/phase；宿主不得发布或记录内部 cause，应保持所属进程和 owner 保活，不能把尚未返回 Service handle 当作资源已经释放。没有重试或重新打开接口。

装配清理回归使用真实隔离 SQLite/Worker：管理工厂故障后实际 Runtime 最终 hook 失败，原 metadata 仍可读且维护返回 `owner_busy`；清理成功保留原错误对象并允许实际备份取得维护锁。Runtime 构造的重复定义错误也验证原 Artifact/Store 成功释放。构造失败后 Artifact/Store 自身 close 再失败的标记分支已实现，本切片未单独注入该底层失败，也未为它增加生产 FactoryPort。


## 显式开发 daemon

[daemon-main](src/daemon-main.ts) 与 paired [main](src/main.ts) 共用 [process-service](src/process-service.ts) 的一次 Store/Runtime/HTTP 装配。daemon 的启动 stdin 是有限单帧，EOF 不代表退出；原 profile、canonical Workspace、build 和 native owner 在首次启动固定。[私有 daemon 叶子](src/daemon/README.md)只作发现与准确资源所有权，业务仍走公共 Client。默认 endpoint 与显式 socket 保留各自原 record 路径，不把默认地址重新解释成显式地址。

启动前以 [web-assets](src/daemon/web-assets.ts) 校验所选三个 Web 文件及闭合 manifest，不执行宿主提供的 assets 模块；restart 的[预检](../../packages/agent/src/sqlite.ts)在目标子进程只读检查已有 Store，零 Runtime/Model。普通 start 直接进入正常装配，Store 打开失败仍保留安全身份与 HTTP 诊断，不把格式预检变为全局 ready 门槛。有限 preflight 回复经闭合 schema 核对原 profile/instance/build；预检不免除随后正常启动准入。Web Gateway 固定封装本构建的 [API Docs](src/api-docs.ts)与完整 OpenAPI，纳入页面内容身份，不接受外部文档覆盖，也不携带认证信息。

最终关闭先封 HTTP 新准入，再关闭 Gateway、abort 并等待所属请求/正文读取，最后关闭 Runtime/Store 与原 native endpoint。装配与清理双失败通过有限 marker 保留资源；[process-failure](src/process-failure.ts)明确保持原进程存活，daemon 不移除 reservation。该分支没有成功 HTTP handle，不能宣称已有诊断 listener 或成功关闭；它只输出 code/phase，不输出原错误、token或资源。

[真实 daemon](test/isolated/daemon-process.test.ts)在临时目录构建所有公开 manifest entry，再运行编译子进程，验证父 EOF 存活、原身份、Cookie Web/API Docs、busy/cancel真实停止、坏 Web/未来 Store 预检保原服务与数据库字节。[装配失败进程](test/isolated/process-cleanup-retention.test.ts)验证双失败后断开父管道仍保活、原锁busy与reservation保留。CLI 的实际编排证据归 [CLI owner](../cli/README.md)。当前本机 macOS 证据不等于 Linux/Windows 或正式发行资格；设计理由见[私有 bootstrap Note](../../.agents/notes/implemented/architecture/2026-10-02-daemon-private-bootstrap.md)。

## 显式冷报告恢复

专用 `POST /v1/sessions/:id/job-reports/:reportCommandId/resume` 只接受原Store和恢复申请commandId，主体由认证派生，调用Runtime的根Session有限 `resumeJobReport`。返回新的 `job.report.resume` Command，receipt说明原报告、实际Run和恢复/抑制事实；受理不表示模型完成。Browser不获得恢复写权限，读取历史、连接及启动不会触发该入口。

默认宿主用专门 `resolveRecoveryRunConfiguration` 固定原manifest中的modelId与Skill选择，并先比较原配置digest，再读取凭据。原模型参数/引用或支持配置变化时局部拒绝；普通默认模型变更不能偷换旧绑定。Core仍核完整注册manifest和当前afterTurn权限，实际派发仍走原权限/来源检查。没有匹配原版本时保留历史，不自动安装或调用当前默认模型。此能力只恢复已有真实报告的安全推进边界，不宣称一般Run恢复或adapter reconcile已实现。


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

默认 source 只读当前主体的默认/Session 模式和真实 Workspace 信任。Shell 可信资产与平台检查不创建 Job、进程或模型，`posix_group` 监督与 `sandbox:none/unqualified` 分别表达；available 不是某次请求的执行 grant。自定义权限权威无法由默认 source 核实时明确 permission_source_unavailable。当前未绑定发行 manifest 返回 production:null、release_manifest_not_bound；没有遥测 exporter 返回 disabled/exporter_not_configured，均不由 buildId、JSONC 或工具目录推导。没有发行证明或 exporter 的宿主不能据状态 API 的存在获得生产资格。

诊断不调用普通 Run resolver、凭据后端、Provider、MCP 或 Skill 扫描，不创建 Workspace/Session/Command/Run，也不修改 SSE 游标。公开 DTO 不包含凭据、路径、endpoint、环境变量、正文或内部 owner。CLI 显式信任的独立 mutation 与诊断 GET 分开；实际派发仍使用原权限和来源门禁。

[真实HTTP诊断](test/isolated/host-status.test.ts)核默认装配、当前控制变化、坏配置、不可用Store、零业务写入/Provider/凭据访问与真实Shell资产；Shell共享检查另由[实际Shell回归](test/isolated/shell-configuration.test.ts)核正常派发不变。

## 有条件 Skill Workflow

默认每 Run 装配另读当前 profile 的 `skill-workflow.jsonc`，严格格式为 `{version:1,features:{skillActivation:boolean,skillWorkflow:boolean,verification:boolean}}`。缺文件三项皆 false；前两项同时开启才注册 Workflow，Workspace 或 Skill 文本不能打开这些开关。该配置的备份保原 JSONC 字节，由维护 owner 负责。知识 `selectedSkills` 与 Workflow 激活继续分开。

公开 Native `run.start/input.follow_up` 可携带 `extensionInputs:[{extensionId:"builtin.skill-workflow",definitionVersion:"1",input:{activations:[{key,skillId,input}]}}]`。Service 只在 Runtime 声明并实际有 resolver 时发布 `run_extension_inputs`；未知版本/扩展、重复 envelope/key、结构或输入 schema 错误、不可用原 Skill 和未启用开关在凭据与 Provider 前拒绝。省略与空数组保持原 Command 语义，steer 不接受。通用协议测试见[HTTP](test/isolated/extension-inputs-contract.test.ts)。

[`skill-workflow-configuration.ts`](src/skill-workflow-configuration.ts) 只编译同源可信目录的实际可用位置，编译前后核原 root/body，解析完整原 Workflow 契约；坏项仍局部不可用。实际 Tool/Job 的身份、风险与版本参与依赖封存，不接受 Skill 自报能力。纯 Workflow initializer 与 Planning initializer 顺序组合，在首次 Model 前建立不可变业务义务，普通 Tool/Job 沿用同一 Loop。完整业务记录与结果证明由 [Agent Workflow owner](../../packages/agent/src/business/skill-workflow/README.md) 负责。

fork 从原 parent Execution 和封存 parent Run 选择可信角色与准确版本。`activate_skill`、`repair_skill` 与真实 replan carrier 的 resolver 在回调内通过 Core 只读 scoped records 核原 activation anchor、CAS head、独立 attempt opening 和 fork opening；后两者必须绑定准确新 attempt、原 carrier Execution/input digest、原 Store/Session/Run、Skill revision 与角色版本。replan 另读原 decision 记录，waived head、旧 attempt、错 carrier 或缺原记录拒绝派发。resolver 仅封存读取的事实，不将已关闭的 getter 留给后来权限或来源回调；最终记录读集的事务复核由 Core 负责。实际 child Tool/Job 范围与父能力相交。原 Skill source/依赖在 child resolver、权限检查与 source capture 再核，审批等待中的漂移拒绝后续效果。Skill 最低审批从原 Run 范围的不可变 anchor 定位身份后叠加原可信策略，原硬拒绝不转为可批准；继承最低审批不改变 Model 权限。原 carrier 的特例只限准确角色、原 parent、Session/Store/root work，不放宽其他 Job。

可信 `skillWorkflow.userDecisions` 只由程序化宿主传入，默认 `{version:"1",allowWaiver:true,allowReplan:true,allowCompensation:true}`；宿主启动时深拷贝并冻结，JSONC、Skill 和模型无权替换。Workflow flags 缺省仍全部关闭，compensation 还必须有原声明和实际受限后端。完整 policy 进入原 Workflow snapshot，冷 resolver 在读取凭据前比较，后来修改传入对象不改写原绑定，冷恢复遇到 policy 变化明确拒绝。[隔离 policy 测试](test/isolated/skill-workflow-attempts-configuration.test.ts)核实际冻结与恢复前凭据边界；[真实 fork attempts 测试](test/isolated/skill-workflow-fork-attempts.test.ts)以固定模型、所属监督脚本和普通审批/question 验证 repair/replan 的独立 child、完整原输入与结果、原失败保留及新核验一次成功。完整范围仍按实施进度记录。

脚本核验仅在可信已核准 Shell 装配下注册普通 `skill.workflow.verify@1`。实际资产与非秘密环境摘要封存，模型不能传 command/cwd/env/path；执行前再次核原资产。脚本从原 Skill root 执行，修改该目录内已封存文件会被来源复核拒绝。配置与发现本身不启动进程。核验与 fork 的失败、未知、必要审批和结果始终留在原 Run/Execution；冷 resolver 在读凭据前比较原 Workflow 快照，不偷换现在配置。

声明补偿只在实际 macOS 合格 Shell 资产、trusted policy 与 Workspace 内原声明均可用时注册 `skill.workflow.compensate@1`。该独立 Job 始终 minimum:user，显式策略硬拒绝仍优先；最低审批不会借原 verifier 或普通 question 许可。工厂封存保护 Profile/coordination 的受限配置与资产摘要，guard 在普通派发前拒绝变更；固定 Bun 在原 Workspace 执行完整只读原资产，禁止网络和派生子进程，无跨平台或普通 Shell fallback。compensated 不满足原 verification，unknown 不豁免。 [真实默认 Service 补偿测试](test/isolated/skill-workflow-compensation.test.ts)使用实际 SDK/HTTP/SQLite、超过 300 KiB 的完整审批附件，核一次脚本效果、拒绝零效果、原 failed 保留、repair attempt 2 重验和准确 waiver；这不是全部平台或正式客户端资格。

[真实默认装配测试](test/isolated/skill-workflow-configuration.test.ts) 使用隔离 profile、固定 loopback 模型与所属 guardian，覆盖原意图/初始指令、schema完成、child能力缩小、审批中来源漂移和脚本核验。CLI/TUI 动态命令与恢复、受限补偿和未完成的正式切换/平台资格分别按[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)记录，不能以本接口替代未切换的客户端行为。

## 同源 Skill 知识目录

[skill-source.ts](src/skill-source.ts) 为目录读取和 Run 装配提供同一真实配置解析。禁用项不读文件；缺文件、路径越界、重复物理位置、digest 变化、不支持 options 与缺能力按配置 ID 标记局部不可用。默认 Run 只绑定实际可用项并保存相同配置子集，显式名称/ID选择基于全部已知条目消歧，不能因坏项而悄悄改选同名可用项。child 继承准确原 ID；原项失效必须拒绝。绑定后的 canonical 文件目标变化同样拒绝，不能静默删掉原选择。单命令 requested 最多256项保持公开契约，默认解析出的 resolvedIds 不套此请求数量限制。

默认装配提供 [skillCatalogue source](src/skill-catalogue.ts)，Service 仅在实际 source 存在时发布 `skill_catalogue`。`GET /v1/workspaces/:id/skills?storeId=&afterId=&revision=&limit=&byteLimit=` 在原 Store、实际 Workspace 和持久信任范围下返回闭合 `SkillCataloguePage`：可用性、revision、metadata/status entries、nextAfterId 与 complete。没有source明确unavailable；坏配置不是空目录。响应没有正文、路径、凭据、任意宿主配置或 Workflow 契约，不构造 Run 或调用 Model/vault/Shell/MCP。

目录按配置ID排序，默认128KiB单页字节预算、可选正安全整数limit与不超过1MiB的byteLimit；预算只分页，不截总目录或单项字段，单项放不下明确413。revision涵盖原主体/Store/Workspace、信任身份与revision、Skill配置、能力及完整目录版本状态；后续页必须携原revision，实际变化（包括配置变坏）409，不将新目录拼进旧页。未见afterId拒绝，不猜下一位置。读取不提供与外部文件写者的原子事务，也不预订未来执行版本。

目录的 `workflow=manual` 查询是独立 opt-in：只有实际 source 声明 `supportsWorkflow:true` 才发布 `skill_workflow_catalogue`，配置中的同名 capability 不能替代实现；不支持时该查询返回404。普通请求保留原闭合知识 shape、revision 与读取路径。显式请求的每项附带闭合 `workflow`：固定扩展身份、实际 compiled Skill ID/name/revision、独立 state/reason、manualAllowed、emptyInputValid 与 contextMode。可用只表示该次读取确认手动空对象输入可以准入，不是执行授权。

目录与 Run 绑定共用 `compileConfiguredWorkflows` 的真实源前后复核，以及 `workflowCapabilitiesFor` 的实际 Tool/Job/role 版本。投影另核 profile flags、完整输入 schema、fork 角色和脚本核验资产；关闭、坏契约、缺依赖或缺实现只改变相应 Workflow 资格。投影不包含指令、路径或完整契约，不选择模型、读取 vault、连接 MCP 或启动 Job；临时装配释放所属文件资源。flags、来源、依赖及宿主绑定参与 manual 分页 revision，变化拒绝续页。无 `workflow` 的旧知识请求不承担这次装配，也不因只改 Workflow flags 而换 revision。

目录不预订提交时的版本；实际 Command 仍由原 Service resolver 编译并封存可信源，后续漂移按原权限与来源检查拒绝。目录和单 Run 知识选择的原契约见前文及[同源目录决定](../../.agents/notes/implemented/architecture/2026-10-02-scoped-skill-catalogue.md)。[实际 HTTP 投影测试](test/isolated/skill-workflow-catalogue.test.ts)覆盖277项完整分页、局部失败、版本变化、零模型/凭据/执行，以及与正常原 Command 绑定的 compiled revision 相等；[旧接口测试](test/isolated/skill-catalogue.test.ts)保留旧消费者与缺实现 capability 边界。当前资格范围见[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

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
