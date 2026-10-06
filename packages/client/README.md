# Client

## 完整已保存 Job 输出覆盖

公开纯 [ExecutionOutputPages](src/execution-output.ts)由 Native 与 Web 的按需完整 reader 共用。输入私有克隆并沿生成的可扩展 ExecutionOutputPage schema 验证，保未来字段；首 highWaterSeq 固定 H（Native 缩小过大首页时可显式提供原 H），后页 current highWater 可增长。after 从 0 开始，以所有 throughSeq 的最大值推进，严格 Decimal64 不转 Number；原 Job、连续覆盖、普通 seq 唯一及同 stream 不重叠分别核对。coalesced gap 可跨越另一个 stream 的保存内容或与其 gap 重叠，原记录全保留；droppedBytes=null 不补零。完整只表示已覆盖 H 的全部保存内容与缺口，提前空页、不推进、错误区间不能完成前缀。该 leaf 无网络、Store、Session authority 或执行操作；实际作用域、原连接及读取释放由调用者核对，[有限合同](test/execution-output.test.ts)与[Native owner](../../apps/desktop/README.md#native-job-完整已保存输出)记录证据。

[MCP 管理协议 leaf](src/mcp-management.ts)公开正式 Native 设置/来源/连接/认证消费者所需的纯 DTO 与闭合 decoder：`mcp.servers`、分页 `mcp.sources`、原 connection/reconnection、source approve、source mutation、auth status/result。完整 Display envelope 有界（management 512KiB、sources 64KiB、其他 16KiB），固定 namespace/version、空 actions/artifactRefs、字段类型及原 Store/Session/Command/Execution 关系严格核验，不裁剪或接受额外秘密字段。来源六字段 `McpSourceReadSet` 与配置选择 `McpSelectionReadSet` 分离；Source/Auth 原结果不重绑跨 Store。

`McpCommandRequest`、`validateMcpCommandRequest` 与 `canonicalMcpCommandRequest` 只接受固定 select/connect/catalogue.refresh/reconnect/source.approve/credential.bind/source.add/remove 和四类 Auth Action。canonical 仅去除 expectedStoreId/commandId，复用 `canonicalModelBody`；manual bind 只有 serverId、expectedReadSet、expiresAt，不接受秘密正文。解码与规范化只证明协议事实，不授予 POST、凭据、连接或 Tool 权限；没有另造 binding Query，也不递归保存此前 reconnect intent。既有 `canonicalCallerCommandRequest` 与 TUI 消费者保持独立。[纯契约测试](test/mcp-management.test.ts)核固定申请、有限真实 DTO、原身份和秘密字段反例；实际 Main/IPC、HTTP、持久恢复与 Native 入口由其 owner 验证。


MCP 原工具 metadata 的 [公共 decoder/reader](src/mcp-tools.ts)使用既有 `readArtifact`，不引入 Agent/SDK 依赖或新的 HTTP schema。`decodeMcpToolsSnapshots(QueryResponse)` 与 `decodeMcpToolsPage(QueryResponse)` 闭合两种version1 DTO及完整32KiB envelope：Session/原origin、固定scope/MIME/hash/Decimal64、连续index/nextIndex/complete互相一致，actions/artifactRefs为空。Server过滤的空页可以向前；跨请求的cursor必须由Host/消费者与原afterKey核对。

`readMcpToolDescriptor({currentStoreId,sessionId,binding,entry,signal?,readArtifact})` 接公共 Client 方法的绑定 callback，当前Store只用于admission，原originStore用于expectedReference核实际元数据。manifest≤256KiB且只读取一次，绑定原publisher/connection/generation/definition/index；按原refs顺序读所有64KiB chunks，核逐块及全文EOF/size/SHA、fatal UTF-8和JSON/schema sanity后才返回完整 `McpToolMetadata`。已接受的SDK Tool字段及原省略保留，有限label不是全文。关闭所属signal不提交业务取消或推进SSE cursor。

[真实本地HTTP测试](test/mcp-tools.test.ts)当前40/128/0，公共Artifact链完整1,115,912 bytes/18chunks，Unicode在65535 byte跨块、完整tail/optional metadata、current/origin Store分离、manifest1GET。闭合DTO、inner binding、header和真实body/EOF、repeat/skip/swap/missing/UTF-8/budget/abort反例保持零POST、cursor不变。原Artifact/CSP/extension邻接5/27/0；Agent publication与TUI实际链分别归[MCP](../agent/src/mcp/README.md)和[TUI](../ui/src/tui/README.md)，不是此受控HTTP协议fixture的证明范围。

`run.start/input.follow_up` 可携带通用 `extensionInputs:[{extensionId,definitionVersion,input}]`，即使显式空数组也必须已有 `run_extension_inputs` capability。SDK 在发送前克隆原意图并使用生成 closed schema；顺序、重复项、payload 和省略/空数组原样参与 Command 摘要，SDK 不解析 Skill 或修改版本。`input.steer` 不接受它，BrowserClient 保持只读。物理丢回复仍只查原 command ID，不重新 POST；[实际断线测试](test/isolated/extension-inputs.test.ts)验证该边界。

`forkSession(sourceSessionId,{expectedStoreId,commandId,expectedContextSelectionId,boundary?,newSessionId,title})` 要求 `context` 与 `sessions` 能力。省略边界使用当前选择的稳定完整上界，显式 `null` 选择空历史；消息 ID/seq 必须形成完整 Model/Tool 配对。回执核原 source Session/selection、新 root Session、原命令及有限 `namespaceReport`，未登记规则默认 omit；`omittedExtensionState` 如实表示是否有省略。规则只来自可信宿主注册的 copy/rebuild，不从请求取得。复制不创建原 Run/Execution、授权或外部效果。`Message.originMessage` 来自 sealed Store 出处；Fork 的输出仍从原 Session/Execution 读取和验证，不改绑原 Run/hash。[SDK 反例](test/isolated/fork.test.ts)、[真实 namespace Fork](../../tests/isolated/unified-agent/client-fork-namespaces.test.ts)与[实际 HTTP/Native/Cookie](../../tests/isolated/unified-agent/client-fork.test.ts)覆盖回执报告不一致、原 provenance、>17MiB 原正文、冷只读零 Provider、新工作零旧效果重放。

`renameSession(sessionId,{expectedStoreId,commandId,ifRevision,title})` 和 `deleteSession(sessionId,{expectedStoreId,commandId,ifRevision})` 是原 root Session 的 Decimal64 控制 CAS。同 ID 重试返回原提交快照，后来标题变化不覆盖旧回执。发送前克隆原意图并核 Store，响应核原 Command、Session、修订和回执快照。删除保存执行组 tombstone，`delete_requested/stopConfirmed:false` 仅为受理，旧历史仍可准确读取。断线或不可信提交回执只查询原 command ID，不自动再 POST。[实际丢回复/篡改/CAS 测试](../../tests/isolated/unified-agent/client-session-management.test.ts)另核冷只读事实。

Interaction SDK 使用生成的 `Interaction`、`InteractionPage`、`InteractionListQuery` 与 `AnswerInteractionRequest`：`listInteractions(sessionId,{storeId,afterId?,limit?,state?})`、`getInteraction(sessionId,interactionId,{storeId})` 和 `answerInteraction(presentationSessionId,interactionId,input)` 都要求准入及 `interactions` capability，列表每页最多 100 条。child 展示保留原卡绑定，回答必须选原 presentation root。写入使用调用者固定的 expected Store、command ID 和 revision，不重绑或自动重试；回执 `answer_saved` 仅代表答案已保存，不能视为原执行获准或完成。revision 按十进制字符串保留并校验 SQLite 64 位范围；未来响应字段保留，答案请求继续 closed，主体由 Service 宿主提供。真实配对与准入零业务请求证据位于 `tests/isolated/unified-agent/client-interactions.test.ts` 和 [SDK Interaction 测试](test/interactions.test.ts)。

`@kite-ai/client` 是可在浏览器与 Bun 使用的 HTTP/SSE SDK。业务类型与验证规则来自 Service 的唯一 schema 生成产物：[api.ts](src/generated/api.ts)、[schema.json](src/generated/schema.json) 与[静态校验函数](src/generated/validators.js)。生成器在构建时编译并封装校验函数，Client 运行时不加载 AJV 编译器、不使用 `eval` 或 `Function`，可在禁止动态代码生成的 CSP 中运行。响应仍递归保留新增字段，请求仍按 closed schema 验证；[真实 V8 回归](test/isolated/csp.test.ts)使用公共浏览器 bundle 和禁用字符串代码生成的 Node VM 核对该边界。Client 不导入 Service、Agent、AI 或本机存储实现。

调用 `createClient({ endpoint, token, expected, bootstrap? })` 时，`expected` 必须来自启动前已经选择的 profile、API 版本、必需 capabilities 与可选 instance/build 身份。`await client.connect()` 只请求 `/v1/server`，核对身份和 bootstrap。准入成功前，业务读写和观察均被拒绝。`dataAvailability=available` 必须带有有效 Store 身份，缺失时 bootstrap/HTTP 均拒绝准入，业务读写与 SSE 不会启动。数据不可用时仍可读取已验证的服务器身份；缺少可选 capability 只限制相应调用。

`verifyConnection({signal?})` 对已经准入的原目标执行一次只读身份复核。它保留现有并发请求、观察流和已应用游标，不重新绑定身份；profile、instance、build、API 或 Store 改变均拒绝该读取。共享 Gateway 使用这个入口逐请求复核，避免重新 `connect` 中断另一个浏览器读取。显式重新 `connect` 仍释放原连接的网络请求并重新准入。

Native 权限管理使用可选 `permission_controls`：`getPermissionMode(sessionId,{storeId})` 读取根 Session 生效模式、当前 revision 和用户默认值；`getWorkspaceTrust(workspaceId,{storeId})` 读取宿主实际目录身份、额外读取范围摘要与当前信任事实。child 读继承准确根范围，模式写只能从根发起。`setPermissionMode` 与 `setWorkspaceTrust` 接收生成的 closed request，明确携带原 Store、command ID、观察到的 revision 和用户选择；工作区两项摘要来自前一次宿主读取，不能传入路径扩大读取范围。客户端在读取或写入前后复核原连接，保持 Decimal64 精度，核实响应目标、终态回执及提交选择，不推进 SSE 游标。

权限写入只发送一次。未收到有效回执时报告 `network_outcome_unknown`，使用 `getPermissionMutation(commandId,{storeId})` 查询原选择；SDK 不以新身份重发。CAS 冲突保留原选择，由调用者重新读取当前事实后让用户决定。未来响应字段保留，伪造 authority 字段在发送前拒绝。[真实 Client 反例](test/isolated/permission-controls.test.ts)覆盖物理断线、身份变化、错误范围、终态和超过 Number 精度的 revision；[默认宿主 SQL/HTTP 测试](../../apps/service/test/isolated/permission-http.test.ts)另验证重启后原事实、事务回执、目录替换与零执行效果。该接口尚未代替正式 TUI/Electron 入口，只读 BrowserClient 保持既有 GET 范围。

可选 Native `permission_grants` 提供 `listPermissionGrants(sessionId,{storeId,afterSeq?,upperSeq?,limit?})` 和 `listAllPermissionGrants(sessionId,{storeId},{signal?})`。目录属于实际来源 Session，child 不借用 root 的授权；每页最多 200 项，完整读取固定 upper 与原 epoch，只在全部成功后返回。原 Interaction、decision revision、definition/version、input/command digest 与执行身份保持公开只读，不包含原命令或秘密环境正文。`clearPermissionGrants(sessionId,{expectedStoreId,commandId,ifRevision})` 按原 epoch 仅清除该 Session；未知仍只调用 `getPermissionMutation`，不重发。成功回执明确原 Session 与新 epoch，授权新增也推进 epoch，不以目录条数推导版本。[SDK 反例](test/isolated/permission-grants.test.ts)验证 202 项两页、晚新增隔离、epoch 漂移不返回前缀、坏范围与游标、提交后坏回执及原查询唯一 POST；[真实默认 Shell](../../apps/service/test/isolated/shell-configuration.test.ts)核对独立 Tool/Job 授权、两次新 key 的真实效果和物理丢失 clear 响应。BrowserClient 不提供授权目录或写入。

SDK 提供 workspace/session 创建及列表、`startRun`、`cancelCommand`、`cancelRun`、`cancelExecution`、`cancelSession`、`listExecutionOutput`、`getView`、`getCommand`、`getRun`、`getExecution`、`listMessages` 和 `observe`；`listExtensions`、`queryExtension`、`invokeExtension` 使用通用扩展目录、只读查询与动作命令。查询输入按生成的 JSON 定义验证并限制 encoded JSON 为 8192 字节，扩展能力缺失时在本地准确拒绝对应调用。写入参数直接采用生成 request 类型：调用者为明确的新意图创建 command ID，并固定 `expectedStoreId`。SDK 不自动重试 mutation、生成新 ID 或重新绑定 Store；网络结果不明时应使用原 command ID 查询。响应允许保留未来新增字段，请求继续按生成的 closed schema 校验。取消域由调用者显式给出 run ID、execution ID 或 session 的 `includeBackground`，SDK 不猜当前 Run。取消命令回执仅代表请求已接收，实际停止须继续读取 Run/Execution 状态。`listExecutionOutput` 使用严格 Decimal64 的 `afterSeq`/`upperSeq` 和最多 200 条的分页；区间 `seq`/`throughSeq`、`droppedBytes` 字符串及裁剪区间的 null 原样保留，读取不推进 SSE 游标。Token 仅通过 Authorization header 发送。

[command-request.ts](src/command-request.ts) 的纯 `canonicalCallerCommandRequest` 验证原五类 `run.start/input.steer/input.follow_up/command.cancel/execution.cancel` 和固定 `builtin.mcp.sources` 的四种 `mcp.auth.login/refresh/clear/revoke@1` invoke，生成与 Store 一致的 canonical JSON。Auth input恰serverId与完整expectedReadSet，不接任意扩展动作。导出的 `CallerCommandRequest` 五类union保持供原Desktop consumer使用，实际需要Auth的caller沿该函数入参类型；仅排除另行绑定的 `expectedStoreId/commandId`，保留完整正文、extensionInputs、数组顺序与 Unicode。调用者可对其 UTF-8 计算 SHA-256，与当前 Service 实际 Command 的 `requestDigest` 核对；`serverInfo.subjectId` 和 Command 的 `subjectId` 来自宿主实际主体。生成 DTO 将新增凭证标为可选，但强恢复调用者在缺少凭证时必须保持 unknown，不能用本地摘要推导已受理。摘要不是许可，也不提供重发资格。[真实 Service/SDK 测试](../../apps/service/test/isolated/caller-command-proof.test.ts)以完整多字节正文验证原五类申请、原 ID GET、原 scope/主体/摘要及只读零新 Run/Model。四类Auth的闭合摘要、错误作用域零HTTP和实际恢复由[Caller合同](../../apps/cli/test/isolated/caller-auth-contract.test.ts)及[维护合同](../../packages/agent/test/isolated/maintenance/caller-intents.test.ts)独立核验；Auth Command applied只证明原命令，成功还须原有限认证result，不提供自动重试或连接许可。

每个 Client 默认仅允许一条观察流。`observe({ onChange, cursor?, startAfter?, onReady?, sessionIds? })` 在变化应用回调完成之后才推进 `lastAppliedCursor`；ready、heartbeat 和 HTTP snapshot 不推进。`cursor` 为应用游标；reset 后先在原 Store 读取全局集合基线，再完整重读所需事实，以互斥的 `startAfter` 请求该边界之后的流。它只设置 scan 起点，保留原 ACK，未达到该起点的 ACK 不能替代下一次 EOF 重开的起点。`onReady` 在 Store、replayFloor 和全局高水位验证后等待调用者完成，可确认订阅准入，但不 ACK；失败或取消不交付后续变化。过滤 scope 的有序 checkpoint 可推进游标；更改 scope 时必须提供该 scope 自己的 checkpoint/重读基线。序列通过十进制字符串与 BigInt 保留 SQLite 64 位精度。连接重试再次核对原目标；Store 改变、游标过期或 reset 需要调用者重新读取 snapshot，不重放写入。回调失败保留此前已应用游标并结束本次观察。[实际 SDK 反例](test/client.test.ts)涵盖 >2^53 起点、无 ACK 的 ready、异步 ready 顺序、非法范围、应用失败和取消。

`Change.objectId` 按 Service 唯一 schema 保留有限不透明标识：合法扩展 namespace 的点号、record key 的斜线与 Unicode 原样通过，上界385字符；它不是路径或授权。其他 Store/Session/Command 身份校验仍用原规则。[真实 Store/Service/Client 回归](../../apps/service/test/isolated/extension-changes.test.ts)覆盖最大合法组合、非法标识和 ordinary Session 拒绝，核完整 durable events 与原 ACK、零 reset、零额外执行；生成校验器保持静态编译与 CSP 边界。

可选 `session_exports` 提供 Native 和 Cookie Browser 的四个只读阶段：`beginSessionExport`、`readSessionExportPage`、`readSessionExportText`、`verifySessionExport`。Native 显式传原 Store；Browser 使用已准入的原 page/Store，不能自报主体。manifest 封存 11 个业务 section 的 Decimal64 高水位、计数与同 Worker 读身份；页、原文本分块和最终核验必须使用这个原 manifest。新 Worker、可观察提交、缺行、范围或游标不一致均失败，不能返回成功前缀。

`exportSession(sessionId,query?,{signal?})` 按消费者拉取输出 `SessionExportFrame`，完整遍历有限页面，不设累计记录或字节截断。未知 JSON 原文本和 `fork_provenance_json` 保留，超过 64KiB 的实际 SQL 文本列通过准确字段 descriptor 原字节读取；SDK 核全文 EOF/SHA256 后才发送 `text_complete`。最终 Core 核验成功才发送 `complete`，其 `rawTextVerified:true / media:original-scope-references` 仅证明原始记录和文本，媒体保持原 scope 引用。提前关闭、网络释放、截断、错误 hash 或最终 proof 替换不会产生完成标记。该协议排除私有配置、凭据与执行权威，不是活动数据库备份，也不代替 TUI 已加载对话 Markdown 导出。[SDK 测试](test/isolated/session-export.test.ts)与[实际 HTTP/Cookie](../../tests/isolated/unified-agent/session-export.test.ts)覆盖 210 个记录、9MiB 未来原文、17MiB 原媒体、物理断线及冷只读零 Provider。

`disposeNetwork()` 中断网络读写和 SSE，保留此前确认的身份与应用游标，不发送 execution 取消命令；重新连接仍核对原 `expected`。

验证：`bun run --cwd packages/client typecheck`、`bun run --cwd packages/client build`、`bun test packages/client/test`。测试使用本机回环 HTTP 服务器与真实 fetch/SSE，覆盖身份拒绝后的零业务请求、生成 schema、写入身份、读投影、scope checkpoint、通用扩展 envelope/查询/动作、64 位游标、网络释放、Store 改变及重连拒绝；不调用真实模型或工具。


`readArtifact(sessionId,{expectedStoreId,refId,scope},{signal?})` returns `{reference:{id,mediaType,size,hash,scope},content:Uint8Array}` from authenticated binary HTTP. The exact scope and original Store are caller-selected; paths, hashes and caller subjects are never authority inputs. The browser-safe SDK checks reply identity, attachment/no-store headers, bounded full byte length and SHA-256 integrity using WebCrypto. Without explicit public-reference admission, the existing `maxResponseBytes` limit also applies to downloads (default 8 MiB). With `expectedReference:{size,mediaType,hash?}`, complete downloads use the frozen reference’s exact size rather than the JSON response budget; metadata mismatch, excess or truncated bytes, and full SHA-256 mismatch fail locally. HTTP failures retain public Problem codes. Aborting or disposing a download only releases network resources, never submits Run cancellation or advances `lastAppliedCursor`. Real paired Service tests cover Core Tool publication and exact bytes; a separate local endpoint test verifies corrupted hash, truncated size, response budget and private header transport without model calls.


`steer(sessionId,input)` 与 `followUp(sessionId,input)` 分别采用生成的 `SteerCommandRequest` 和 `FollowUpCommandRequest`，要求已准入的 `commands`、`inputs` capabilities。调用者显式保存原目标 Run/前序 Run、context selection、Store 与 command ID；SDK 不猜当前 Run，不重绑旧意图，不自动重试。非空白内容按 UTF-8 校验最多 1 MiB，请求保持 closed。202 的 accepted 不是应用完成；后续查询原 command 的回执判断应用事实。

`startRun` 与 `followUp` 可携 `selectedSkills`，最多 256 个非空名称或配置 ID、每项最多 128 字符。字段存在时（包括 `[]`）要求原 Service 的 `run_skill_selection` 能力；缺能力在业务 POST 前拒绝。省略使用该次 Service 配置目录，空数组选择零项。SDK 在异步请求前私有复制原数组，不排序、不去重、不解析 Skill 或读取本机文件；同 ID 请求冲突由 Service/Core 核对。选择不适用于活动 Run 的 steer，也不改变权限、信任或 daemon 默认配置。

`listPendingInputs(sessionId,{storeId,kind?,targetRunId?,afterSeq?,limit?})` 要求 `inputs` capability，按生成 query 校验，最多 200 条。`afterSeq` 严格校验 Decimal64 范围，待输入的原 request 与未来响应字段保留，纯读取不推进 SSE 游标。公开消息的原命令、context、input kind 与 source IDs 用于追溯应用来源。child 可展示历史，但追加输入只能从原 root 发起。

[SDK 准入测试](test/inputs.test.ts) 验证未准入、缺可选能力、非法 authority/content/cursor 的零业务请求以及旧 Store/目标不重绑。[真实输入集成测试](../../tests/isolated/unified-agent/client-inputs.test.ts) 用实际 Service、SQLite Worker 和固定 Model 验证接收、同 Loop 应用、精准取消、独立后续 Run、child 权限及完整输入 frame；本次两文件合计六项、158 条断言通过，无付费模型调用。


R10 SDK 提供 `getContext(sessionId,ContextQuery)`、`rewind(sessionId,SelectContextRequest)`、`includeResult(sessionId,executionId,IncludeResultRequest)`，均要求准入及可选 `context` capability。`rewind` 调用唯一 `/context/select` 入口，显式携带原 selection 和准确消息边界；include 固定原 execution/revision，不猜当前结果。请求使用生成的 closed schema，序列和 revision 保持 Decimal64，不自动重试、不重绑 Store/selection/命令。读取保留两个独立游标和未来来源字段，不推进全局 SSE cursor。

`compressContext(sessionId,{expectedStoreId,commandId,expectedContextSelectionId,focus?})` 与 `resetCompressionContext(sessionId,{expectedStoreId,commandId,expectedContextSelectionId,expectedCompressionId})` 使用同一 `context/commands` 准入和原连接身份，发送前私有克隆并验证 closed 请求。完整说明不按字符数裁剪。响应仅返回原 Command 的受理事实；实际 Run 终态、摘要记录和 reset 结果由后续准确查询核实。不可信或丢失回复显示 unknown，只查原 commandId，不自动换选择或再 POST。[默认 SDK/真实 HTTP 场景](../../apps/service/test/isolated/compression-configuration.test.ts)包含物理丢回复与完整说明，自动分支由可信宿主选择而不是 Client 配置。

公开纯 `validateRequest(name,value)` 复用构建生成的有限 closed schema，供薄入口在读取制品或创建 profile 前核对 JSON。它不联网、不赋予权限，也不能代替 Service 最终 Store、主体、CAS 或执行边界检查。

[SDK 上下文测试](test/context.test.ts) 覆盖准入/可选能力的零业务请求、closed authority、分页预算、精确序列与原意图；[真实上下文 HTTP 测试](../../tests/isolated/unified-agent/client-context.test.ts) 验证当前空闲选择和显式结果纳入。idle include applied 只表示来源保存，不表示新 Run 或外部效果重放。active include 必须携准确 `targetRunId` 与原 selection：accepted/result_queued 只代表等待原安全 checkpoint，原 Command applied 才表示已纳入；公开 Message 保留 `inputKind:result.include`。旧或缺少目标明确拒绝，不转向当前新 Run。[真实 CLI/便携 Desktop](../../apps/cli/test/context-active.test.ts)与[原意图反例](../../apps/cli/test/context-intent.test.ts)验证来源、未知只查原命令和零历史效果重放。


`readInteractionAttachment(interaction,{signal?})` 只识别实际 `request.policy.review.kind=artifact`、`complete=true` 的公开 reference，固定原 Store、来源 Session、Interaction/revision、execution/attempt 和 reference 原 scope；不从正文、路径或 hash 猜授权。认证 HTTP 元数据核对后必须读到 EOF 并校验完整 SHA-256，再严格 UTF-8 解码。失败不生成回答，不推进 SSE cursor，不停止 Run。普通 JSON 响应预算不截断经明确 reference 准入的大正文；物理 TypedArray、字符串和可用内存限制仍存在。当前返回整份 Uint8Array，并在读取阶段保留 chunks、随后分配完整 body；不是固定内存流式展示。

[test/large-attachments.test.ts](test/large-attachments.test.ts) 使用实际 Core Auto ask_user、SQLite Worker、ArtifactStore 和 loopback Service 验证超过 17 MiB 的完整正文、scope/Session 拒绝、metadata/hash 与真实内容损坏检测，以及零 GET 执行效果。测试不会调用付费 Provider。

`@kite-ai/client/browser` 提供独立的只读 `BrowserClient`。宿主从配套页面取得 `pageIdentity`，连接同源 `/browser/v1/server`，随后读取空间、会话、view、固定上界历史和按需诊断；浏览器使用 HttpOnly Cookie，不持有 Native token。每个响应的 page header、instance/build/Store 必须与原准入一致，身份变化不重新绑定。401 续 Cookie 为 single-flight，同一过期代次只续一次，每个原 GET 最多重试一次；其他失败不重试。closed query、Decimal64 cursor、生成 schema、严格 UTF-8 和完整响应预算仍适用。

`getContext(sessionId,BrowserContextQuery,{signal?})` 使用当前选定上下文的双游标和固定上界，原 Store 由 gateway 绑定；请求不能声明 Store 或主体。`listExecutionOutput(sessionId,executionId,{afterSeq?,upperSeq?,limit?,signal?})` 只读取属于原 Session 的准确 Job，保留三种 stream、区间、字节量及 null。消费跨 stream 的 coalesced gap 时必须保留重叠区间并以本页最大 `throughSeq` 推进。两个入口分别要求 `context`、`execution_output` capability，页面切换或取消读取只释放所属网络；当前 Context 投影与 Job 输出不等于一次 Model 的实际请求或完整 Runtime event log。

`disposeNetwork()` 仅中断所属 GET/续 Cookie；`closeBrowserSession()` 先停止这些请求，再删除浏览器 Cookie 会话，均不取消 Run 或关闭 Service。网络读取和续期不推进 SSE 水位。该入口没有 mutation、SSE、配置或凭据方法。[BrowserClient 测试](test/browser.test.ts)覆盖真实 loopback HTTP 的身份、并发晚到 401、local 拒绝、预算及关闭；[实际配对](../../apps/service/test/isolated/development-web.test.ts)另核实 Core/SQLite 工作继续。

`listModelInputs(sessionId,{afterSeq?,upperSeq?,limit?,signal?})` 与 `getModelInput(sessionId,executionId,{signal?})` 需要 `model_inputs`。Native 还可显式固定 `expectedStoreId`，Browser 只使用准入的原 Store。目录逐页核准确 Store/Session、严格递增 seq、固定 upper、正常终态确认与 next cursor；`snapshotCursor` 是读时观察水位，可随活动变化。读取一个目标不能重新绑定另一调用。

完整请求入口使用 [model-input.ts](src/model-input.ts) 接收有限 stream chunks，直到成功 EOF 后核实 wire size/SHA、严格 UTF-8/JSON、静态生成 schema、原 request canonical size/SHA、requestId 与 executionId。正文不走普通 8MiB JSON 预算，取消、前缀、坏 hash 或身份都不返回成功 DTO。便利完整读取仍保留 chunks 并分配完整 bytes/字符串，受真实内存和平台表示能力限制。确认状态来自原成功回执，prepared/失败/取消不等于 Provider 接收证明；元数据保留原 adapter/settings、实际能力与来源、最终 dispatch authorization，opaque/未来/未记录事实明确 unavailable，不读取现在配置补造缺失字段。[真实 HTTP 反例](test/isolated/model-input.test.ts) 6/58 和 [实际 Core/Gateway 交接](../../tests/isolated/unified-agent/model-input.test.ts) 1/27 验证超过 17MiB 的完整消息与 schema、非法 metadata 必须取消未消费流、首块之后 producer 停住时取消/disposal 及时拒绝、历史 Rewind 后保持原请求、冷只读无 Provider/捕获/重放。

公开 `verifyModelInputSnapshot(value,signal?)` 和 `verifyModelOutputSnapshot(value,signal?)` 可供有限 IPC 的正文交接使用：先克隆原对象，静态校验 DTO、Decimal64 root work/cursor、canonical bytes/hash 和完整身份，再检查取消；调用者在 hash 等待期间修改原 alias 不能改写返回值。流读取也调用同一 verifier，不产生 renderer 专用宽松验证或 Runtime 权威。共享 [ModelInputs](../../packages/ui/src/model-input.tsx)只依赖这个公共 port，Native/Browser 均先确认敏感正文再读取。

`getModelOutput(sessionId,executionId,{expectedStoreId?,signal?})` 在 Native 与 Browser 需要 `model_outputs`；Browser 只使用原准入 Store。公开 `Message.outputBody` 标明完整或不完整预览与实际字节量，全文返回原目标的 `ModelOutputSnapshot`，不会暴露内部 Artifact head。reader 复用完整 wire 验证，并通过 [model-output.ts](src/model-output.ts) 的公开 `verifyModelOutputSnapshot` 核实 canonical output hash/size、content/reasoning UTF-8 字节、状态与完整性；完整 Tool calls 只出现在成功输出，不完整前缀保持 `complete=false`。Node main/preload 可有限分块传输同一公开 snapshot，再由 renderer 用同一 verifier 完整核验，不能靠 IPC chunk 自报成功。

局部取消、dispose 与关闭展示只释放所属 GET，不提交业务取消或推进 SSE cursor。[输出 Client 测试](test/isolated/model-output.test.ts) 3/31 覆盖完整正文、reasoning/calls、错误 EOF/hash/byte accounting/身份、停住的 producer 释放与零 POST；[实际 Core/Native/Cookie](../../tests/isolated/unified-agent/model-output.test.ts) 1/39 证明 17MiB 原文与冷历史只读。输入、输出和实际 settings/controls HTTP 组合 12/173 通过；这些证据不代替正式客户端与平台资格。

## 完整目录读取

Native `listWorkspaceDirectory({storeId,afterSeq?,upperSeq?,limit?},{signal?})` 与 `listSessionDirectory({storeId,workspaceId?,afterSeq?,upperSeq?,limit?},{signal?})` 返回具名页。Browser 同名方法不接受 Store，使用原文档准入身份。每页最多 200 项，序列保留 Decimal64；每次响应核 Store、冻结 upper、递增且不越界的 seq 和下一游标。snapshotCursor 是读取时观察水位，可变化，不冒充整个目录的跨页内容快照。

`listAllWorkspaces({signal?})`、`listAllSessions({workspaceId?,signal?})` 明确穷尽固定 upper 的所有页，没有任意总项目截断。只有完整成功才返回集合；重复 ID、范围/身份改变、游标冲突或 dispose/迟到页均失败，不发布前缀、不重绑定旧读取。原 `listWorkspaces/listSessions` 保留当前页兼容入口，不能用于完整目录或退出检查。Web 完整目录与 Native 完整退出检查应使用 listAll 方法。目录读取不执行模型、工具、恢复或 mutation，不推进 SSE 游标。

[SDK 目录反例](test/directory.test.ts) 核对高于 Number 精度的固定上界、闭合输入、未来字段、错误身份/重复项、dispose 后迟到页；[真实目录链路](../../tests/isolated/unified-agent/directory.test.ts) 另用实际创建的超过 200 项验证 Native/Browser 的完整身份、workspace SQL 过滤与冷 readonly 读取。


Native 配置管理以可选 `configuration_management` 能力开放 `getConfiguration`、`patchConfiguration`、`repairConfiguration`、`putCredential`、`revokeCredential` 和 `getHostMutation`。可用数据读写固定原 Store 与 connection generation；只在数据不可用的诊断连接中，用户配置读允许省略 Store，坏 JSONC 保留 `raw/effective/snapshot:null` 和准确 ETag/错误。Workspace 请求只含已有 Workspace ID，没有文件路径。

写方法先私有复制并验证闭合生成输入，保原 command ID、Store 和 ETag，仅发送一次 PATCH/POST。无有效回执、物理断线、派发后取消或回执身份漂移都返回 `network_outcome_unknown`；调用者只能以原 ID 与原 Store 调用 `getHostMutation`，SDK不自动重试或覆盖 CAS。公开 HostMutation 保留 durable `originStoreId`、安全 scope/workspaceId/ifMatch；receipt 仅公开 ETag 或 opaque credential reference/persistence、有限失败码，不返回 secret、digest 或内部 safeRequest。普通 JSONC 编辑仍可保存不可路由的期望配置，后续 Run 按实际装配拒绝；Settings 默认模型业务约束另有验证契约。Browser Client 不获得配置或凭据管理方法。

[配置 SDK 测试](test/isolated/configuration.test.ts) 验证诊断/能力门禁、原 lookup、scope/CAS/kind/receipt 漂移、隐藏权威及 unsafe property path、本地零额外写入。[真实管理 HTTP 测试](../../apps/service/test/isolated/configuration-management.test.ts) 覆盖私有原意图、跨进程回执、原 Store 查询、两种已提交但无有效回执的请求、comments/unknown 保留、显式 repair 和临时凭据；[Browser 回归](../../apps/service/test/isolated/development-web.test.ts) 保持 cookie-only 只读范围。


Settings 模型操作使用 `getModelSettings(scope,{storeId,workspaceId?})` 与 `updateModelSettings(scope,{expectedStoreId,commandId,workspaceId?,expectedReadSet,operation})`。原安全观察的 readSet 不是权限；服务重算并核 CAS。`configured` 仅是 binding 配置合法性，不能当远端可用事实。readSet 为 null 时没有 Settings 写资格。SDK冻结原读取集合与单一操作，回执 `model_settings.update` 必须匹配原安全 marker；坏 marker/丢响应为 unknown，唯一后续是原 `getHostMutation`。公开读取不提供文件路径/URL/opaque credentials；Browser 仍没有模型设置写入。`operation.kind:"effort"` 接受有限 `reasoningEffort` 或 null（清当前作用域），同样冻结原读取集合并核原 marker。目录的 `reasoningEffortSupport:"compatible_wire"` 只表示 adapter 可发送的词汇；缺元数据或 readonly reason 不得推导成可写，远端接受情况仍由实际执行决定。


二进制 Artifact GET 的准入 Store 与原不可变引用 Store 分别校验。Service 的 `x-artifact-store-id` 来自 Runtime 实际 reference，SDK 返回 `reference.storeId` 并可通过 `expectedReference.storeId` 核原引用；恢复后的当前 Store B 读取原 A 引用时，不把 reference 重标为 B。完整 size/hash/scope 与 cursor 不推进约束保持，读取权限仍由当前宿主/Core 原链验证，不凭 hash 绕过作用域。

`createServiceLifecycleClient({endpoint,token,expected:{profile,instanceId}})` 提供独立于业务 API major/capability 与 Store 可用性的有限本机生命周期读取和关闭。目标必须在连接前选定；只接受当前 Service 的规范 127.0.0.1 HTTP 地址，不接受重定向、Cookie 或 URL 凭据。`getStatus()` 核 lifecycleVersion 和原 profile/instance，业务 major 不兼容仍可诊断；不会建立业务 Client 或创建任务。

`shutdown('if_idle'|'cancel')` 先读取并核原目标，再发送一次闭合请求。202 仅代表关闭已受理，进程退出和资源关闭由宿主另行核实；if_idle busy 保持原实例接纳。坏回执、物理丢响应或派发后取消返回 `network_outcome_unknown`，仅通过原 Client 的 `getStatus()` 核实，不自动重发、不改绑新实例。`disposeNetwork()` 只释放本 Client 网络，准入读取被释放后不能接着 POST。生命周期响应限制 64 KiB 并校验完整 UTF-8/JSON；BrowserClient 不导出该管理面。

[生命周期 SDK 隔离 HTTP 测试](test/isolated/lifecycle.test.ts)覆盖业务 major 2/数据不可用的原目标读取、错误身份/版本零 POST、busy 原错误、物理 socket 丢回复一次 POST、替换实例拒绝，以及准入期间 dispose 和超大响应。正式 daemon 目标发现、启动/重启和三平台制品仍由宿主集成负责。

`resumeJobReport(sessionId,reportCommandId,{expectedStoreId,commandId})` 是显式根Session冷报告恢复，要求独立 `job_report_resume` 能力。调用者先保存原报告及新申请身份；方法核对返回Command的Store、Session、commandId、kind和receipt原reportCommandId。网络丢回应或回执不可信只保留未知，后续使用 `getCommand` 原ID核实，不换ID自动重发。它不等同于继续对话的新run.start，也不恢复任意旧Execution或代替外部adapter核实。


`reconcileJob(sessionId, ReconcileJobRequest, {signal?})` 只向具备 `job_reconcile` 的原 Service 提交一次显式核实。请求固定原 Store、根 Session、executionId/resultRevision 与新 commandId，不接受 adapter/reference/input/owner 或用户自报结果。`decodeJobReconcileCommand` 是纯闭合回执校验器，可用于原 `getCommand` 返回值；调用者还必须匹配自己的原意图。accepted/null 不表示核实完成；verified 要求已知业务结果与 ended 监督，unresolved 不意味着未执行。坏回执和物理丢回应保持未知，只查原命令。见[协议反例](test/isolated/job-reconcile.test.ts)。


`resumeRun(sessionId,ResumeRunRequest,{signal?})` 要求实际 `run_resume` 能力。请求只含 `kind:"run.resume"/expectedStoreId/commandId/runId`，SDK 在异步准入前克隆原意图，使用 closed schema 验证并发送一次 POST；owner generation 是服务端内部边界，不属于公开请求。回执必须匹配原 Store、Session、Command 与 Run，accepted/null 不代表恢复完成。坏身份、坏回执或物理丢回复返回 `network_outcome_unknown`，只以原 ID `getCommand` 核实；`decodeRunResumeCommand` 提供纯闭合回执校验，调用者还须核自己的原身份，不自动重试或创建新 Run。[真实回环反例](test/isolated/run-resume.test.ts)核缺能力与错误身份零 POST、调用者修改 alias、closed authority、有限回执和物理断线。

`recoverSession(sessionId,{kind:"session.recover",expectedStoreId,commandId,decision:"interrupt"},{signal?})` 要求实际 `session_recovery` 能力，显式中断原根执行组的遗留工作。SDK 私有复制原意图，闭合请求不接受 owner、generation 或主体。回执只公开原 Store/Session、准确中断/结算/未知/取消/partial ID 集与 Decimal64 观察水位，核原 Command 和连接代次；私有 owner fence 不属于公共回执。物理丢回复、坏回执或错误身份仍为 `network_outcome_unknown`，不自动重发或转向新 Session。

`decodeSessionRecoveryCommand` 与 `decodeJobReportResumeCommand` 提供原 `getCommand` 的纯回执校验；调用者仍须核自己保存的原 ID/Store/Session 及报告目标。GET 不取得恢复所有权、不执行模型或工具。Session 中断不证明未知外部效果已经停止，也不解除它对新执行的阻挡。[SDK 协议反例](test/isolated/session-recovery.test.ts)核十类丢失/坏回执与原意图 alias；[真实 Service 强杀与物理丢回执](../../apps/service/test/isolated/session-recovery.test.ts)核原效果 ledger、partial、同 ID 幂等及零重放。


`getHostStatus({workspaceId?,sessionId?,signal?})` 通过可选 `host_status` 能力读取实际宿主诊断。原连接在 dataAvailability:unavailable 时仍能读取安全身份和宿主事实；不通过重连改变预期，也不把缺 Store 当空目录。query 使用闭合生成 schema，省略未定义 scope；返回值核原 instance/build/API/profileAccessKey、数据可用性/Store 与准确 scope，连接代次改变或身份不符局部拒绝。GET 不提交任务、改配置、建立 SSE 或推进观察游标。权限注册、Shell监督与发行/遥测事实均保持服务器定义，SDK不提升为执行许可。

[诊断Client测试](test/host-status.test.ts)核冻结query、显式undefined省略、原identity/Store/scope与局部取消，保持已有SSE/ACK。HostStatus采用有限闭合响应校验，额外字段或当前未定义资格只使本查询失败，不升级成其他业务失败，也不改变其他响应的既有可扩展读取策略。

`listSkills(workspaceId,{storeId,workflow?,afterId?,revision?,limit?,byteLimit?,signal?})` 读取实际 `skill_catalogue` metadata；`listAllSkills(workspaceId,{storeId,workflow?,signal?})` 在第一份revision下穷尽全部页，返回同一完整page形状（complete=true/nextAfterId=null）。SDK私有复制参数，核原Store/Workspace、state一致性、严格升序和末cursor、revision及原连接代次；失败/变更不重试或重新开始目录，更不创建任务。取消和迟到读取仅影响本调用，SSE和lastAppliedCursor保持。

`SkillCataloguePage` 与HostStatus一样使用专门闭合响应schema，拒绝附加正文/路径/凭据字段；其他公共response的可扩展策略不变。available仅说明当前知识发现，不是Workflow activation、工具权限或未来版本预订；unavailable与有效空目录分别表达。单页字节预算不限制listAll的总条目数。

[verifySkillCataloguePage](src/skill-catalogue.ts) 公开同一纯校验入口，私有克隆输入后使用生成的闭合 schema，核指定 Store/Workspace/revision、升序与页尾游标、state/availability 及 opt-in Workflow 资格；`listSkills` 在原连接前后复核之间复用它。Native 的有限 IPC 页使用同一规则，不建立 renderer 专用宽松 decoder。可选 nullable `source` 仅携 project/user 与 .agents/.kite-code/profile/configured 分类，拒绝附加路径；旧响应省略来源仍可消费，调用者不能补造它。该字段不改变知识选择、权限或目录的总条目范围。

显式 `workflow:'manual'` 要求原 Service 同时提供 `skill_workflow_catalogue`，字段在所有页保持冻结。仅 opt-in 接受并要求每项闭合 Workflow 投影；普通知识查询拒绝额外投影。SDK核对独立 available 状态与知识可用、manual/空输入资格、准确 `skill:<name>`、compiled revision 和 contextMode，拒绝缺字段、自相矛盾或附加敏感内容。缺能力在目录 GET 前失败，不修改原连接或 SSE 水位；是否提交激活由调用者决定。新增闭合响应不放宽其他 DTO 的校验策略。

每页读取前后通过 `verifyConnection` 核原profile/build/instance与Store；同endpoint被同Store的新实例替换也拒绝，不用原token可用性或未变化的本地generation冒充身份。调用开始即固定Store/参数，取消、身份变化或中途变更只丢本次目录，不替调用者自动重连。[Skill目录Client测试](test/skill-catalogue.test.ts)覆盖严格metadata、完整多页、scope/revision/cursor反例及替换实例零目录GET。

## 固定上界的会话日志读取

Native 与 Browser `listSessionLogs(sessionId,{afterCursor,upperCursor?,limit?,signal?})` 使用生成的闭合 `SessionLogPage/Entry`，只有实际 `session_logs` capability 才可调用。Native 固定已准入 Store，Browser 只使用所属 page 的 Store 与 Cookie；query 不接受主体。optional undefined 字段省略，Decimal64、倒置边界、非法目标与 limit 在网络前拒绝；响应逐条核 scope、严格 cursor 推进、原 upper、floor/snapshot、complete 与 nextAfterCursor 一致性，以及准确 Model/execution 关联。单页流式收取不超过 512KiB，调用者仍可声明更小的通用预算；不足即报错，不发布 partial ready。

该方法不推进 SSE ACK、不自动提交/恢复业务、不把日志链接变为原 Model reader 的授权。下一页由调用者显式请求；观察取消只关闭 GET。公共纯/loopback [SDK 资格](test/isolated/session-logs.test.ts) 2/76 验证私有字段拒绝、BigInt 顺序、坏 scope/分页/Model 关联、原 query、optional undefined、流预算与 abort；真实 Store→Service→Native→Cookie→Browser 及冷默认 main 的资格归[Service owner](../../apps/service/README.md#只读会话运行日志)。


## Browser Files checkpoint 只读观察

Cookie-only Browser Client 的 `file_checkpoints` 能力由 Gateway 核对实际 `builtin.files` 的三个 version `1` Query 注册后提供。`listFileCheckpoints(sessionId,{afterKey?,limit?,signal?})`、`getFileCheckpoint(sessionId,pointId,{signal?})`、`getFileRestoreStatus(sessionId,pointId,restoreId,{signal?})` 只有 GET，没有任意 extension/action、原文件下载或恢复写入端口。参数不接受 Store/Workspace/subject；SDK绑定已准入 page 的 Store 与准确 Session，调用者仍须核选中的 Workspace。取消、页面释放与迟到响应只影响本读取。

`FileCheckpointPage`、`FileCheckpointDetail`、`FileRestoreStatus` 是闭合 DTO：外层 Store/Session/Workspace 表示当前观察，payload 中 checkpoint boundary 保存原 Store/Session/Workspace/Run/selection/trigger；Fork 的原来源不重标为当前观察。目录默认 50、最大 200，按原 keyset 严格升序；没有 frozen upper 或全目录 snapshot，满页的 nextAfterKey 可以导向末尾空页。详情包含精确路径、record revision、Artifact 引用元数据、baseline 与五种 preview status；Service 会完整校验 Artifact EOF/hash，并读取当前文件 postimage，因此读操作可能访问文件或返回 conflict/unavailable，不代表零文件读取。

恢复 status 分开保存 journal phase 与实际 carrier status。旧 v1 journal 严格保留原字段，新 v2 有必需 rootWorkSeq、nullable expected 与 confirmedPost wrapper；SDK不补 originStore、confirmedPost 或历史版本。Artifact 引用元数据没有带来媒体读取或执行授权。每个响应按通用流式字节预算完整解析，超预算拒绝，不发布截断结果。

[SDK闭合与loopback测试](test/isolated/file-checkpoints.test.ts)覆盖原来源、keyset、v1/v2/null journal、phase/carrier区别、额外私有字段、错 scope/ID、optional undefined、取消与字节预算；[真实默认 paired Service 资格](../../apps/service/test/isolated/file-checkpoint-browser.test.ts)覆盖实际两 Run checkpoint、Cookie Gateway、完整 preview、独立 Ask 后 journal、冷同 ID 查询、受保护路径/conflict/unavailable、未来 Query version 和非法 route。读取前后核 Provider、Command/Execution、change cursor 与物理 bytes，不借 mock page 代替业务资格。

## Native Files 恢复事实读取

Bearer `AgentClient` 的 `file_recovery` 能力提供四个有限方法：`listFileCheckpoints(sessionId,{afterKey?,limit?,signal?})`、`getFileCheckpoint(sessionId,pointId,{signal?})`、`getFileRestoreStatus(sessionId,pointId,restoreId,{signal?})`、`getFileCheckpointRecoveryBoundary(sessionId,pointId,{signal?})`。方法固定实际已准入Store与准确Session、完整closedDTO/Decimal64和连接代次，取消只结束读取；参数不开放任意Query/version/subject，optional undefined不发送。缺能力本地拒绝且零业务GET。

`FileCheckpointRecoveryBoundary` 是平铺current观察与selected aliases，`checkpoint`保原Store/S/W/Run/selection/trigger身份。当前boundary/trigger序列分别完整解析，先后关系严格，不能把原source seq当current alias。其存在不证明文件可恢复，不授媒体访问或Action许可。三个其他响应保原Browser共享DTO语义，journal/carrier状态不合并。[有限SDK测试](test/isolated/file-recovery.test.ts)与[实际默认Service两层Fork](../../apps/service/test/isolated/file-recovery-native.test.ts)分别提供协议和业务来源证据。普通restore Action、Fork和原Command GET保持既有接口，本片不创建持久two-leg intent或自动续发。

## 文件恢复的持久身份与显式两步

独立公开 leaf `@kite-ai/client/file-recovery-intent` 不导入 Node 或客户端宿主。`planFileRecoveryIntent`/`parseFileRecoveryIntent` 通过 WebCrypto 异步核 closed v1 metadata，冻结原 point、current Store/S/W/subject/selector、后端证明的 cut/trigger、适用的两条请求/Command/restore/newSession IDs 与准确 canonical Core SHA。两 leg phase 是唯一可变部分；raw Code 使用实际 `extension.invoke.actionId`，raw Fork 使用 `session.create.fork`，不能从 HTTP request 只删除外层 IDs 计算。metadata 解析不产生 POST 许可，SDK 不负责私有存储 I/O。

`prepareFileRecoveryLeg` 只接受明确继续、已解析原 intent 与当前实际身份/selector；其进程内 WeakMap hot permit 一次使用、不能序列化。`submitFileRecoveryLeg` 先收到持久 submitting 确认，再重新核真实 currentScope，最后最多一次原 POST；持久失败或 scope 漂移不发送请求。调用者必须在首 POST 前一次持久全部适用 IDs/digests，并提供实际 private journal 与 current GET；重新打开、关闭面板、POST/GET 丢回复和旧 Store 都不会自动 mint 新 permit 或替换 ID。

Code 的成功需原 Command 身份/subject/raw SHA/receipt 与原 v2 journal、实际 succeeded runless carrier、rootWorkSeq 和逐文件 confirmedPost 一致。Fork 的成功需原 Command、新 Session、原 selection/cut 和 closed 八字段 namespaceReport 一致，`omittedExtensionState:false` 是合法值；报告 mode 仅 copy/rebuild/omit。冷 `lookupFileRecoveryLeg` 只调用原 Command/status GET，缺失、malformed 或 foreign 保 unknown/read-only，不自动 POST，也不把已知终态降级。

both 的 Fork 还要求当前 `codeProof` 与实际新读 `currentDetail`：closed outer current Store/S/W、完整原 checkpoint canonical 一致、全部文件 unchanged，路径唯一且覆盖原 succeeded Code journal 的每个路径。允许真实 empty journal/detail 和额外 unchanged 路径，不增加 quota 或要求等长。原 Code 历史成功不足以证明当前磁盘；外部编辑或后来 completed Run 仍可使第二步不可继续。该纯输入校验补结构与已知路径完整性，不对注入数据来源作密码学证明；实际 CLI/Native driver 使用原有限 GET，并核前后 scope/selector。最后读取至 Fork 的变化、跨文件/跨 leg 原子均不由 SDK 保证。

[纯合同测试](test/isolated/file-recovery-intent.test.ts)当前 13 项 180 条断言；[真实 packaged default](test/isolated/file-recovery-intent-default.test.ts)当前 1 项 165 条断言，2026-10-04 组合 14/345/0。actual source candidate `terminal-d2889750326d67556f4f4c0034e9f0d7e99cba0a3a52780c5377fc2e00fd3003` 核三范围、独立 Ask、两次物理 POST 丢回执、一次 GET 正文丢失、冷原 GET-only、完整 364003 字节 BOM/CRLF 与真实新 inode；后续同 S distinct completed Run/selector 未变及外部编辑均阻止 Fork，零新恢复 POST、保 Code succeeded/Fork not_started。Provider 36、五个恢复 POST 各原 ID 一次、冷 cursor 512 不变；仅固定本机 loopback Provider，不代替实际 CLI/TUI/Native 窗口、独立安装或全 §35。


Provider Settings 的 `getProviderSettings({storeId})` 与 `updateProviderSettings({expectedStoreId,commandId,expectedReadSet,operation,secret?})` 属于同一可选管理能力。SDK 保留并核原 provider marker、operation/readSet 和两个介质的 receipt；只发送一次 POST，未知只允许原 `getHostMutation`。公开 receipt 的 `opaqueRef` 仅在凭据已存时出现，可用于准确 revoke；Native renderer 投影不取得它。`canonicalConfigurationRequest(kind,input)` 是非秘密本地原意图 codec，不提供权限或网络操作，Provider journal 禁止 secret。

`startRun/followUp` 的可选 `reasoningEffort` 使用生成的七值闭集；它是本次原命令语义并参与 canonical 摘要。`steer` 仍拒绝模型或 effort 字段，SDK 不代客户端选择路由。远端支持由 Service 投影和实际模型请求确认。

## 完整后台执行目录

`listBackgroundExecutions({storeId,workspaceId?,rootSessionId?,executionId?,afterSeq?,upperSeq?,snapshotCursor?,limit?})` 读取公开 `/v1/background-executions` 的原 Job 目录。`listAllBackgroundExecutions({workspaceId?,rootSessionId?,signal?})` 冻结原连接 generation/Store，读取所有固定 Decimal64 upper 页面，并沿同一 snapshotCursor 核对；`directory_changed` 时丢弃整个前缀重新扫描，AbortSignal 可结束读取，无累计页数上限。返回 `BackgroundExecutionItem[]`，核当前 Store 的原来源、实际 Session/root/Workspace、父 Run 与精确 child-start Run；重复身份、错序、作用域和绑定冲突均拒绝完整结果。目录不包含 input/result/config/reference 正文，读取不发送 POST或推进ACK。[有限 Client 测试](test/background-directory.test.ts)覆盖重扫与完整身份反例；[真实 HTTP/Store](../../tests/isolated/unified-agent/background-directory.test.ts)覆盖超200原 Job与后代。
