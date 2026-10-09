# MCP leaf

原目录工具描述查看已完成 connect/refresh、[公共 Client](../../../client/README.md)与[暖/冷 TUI](../../../ui/src/tui/README.md)的有限实际链路，普通 Model Tool refresh 与公共备份恢复 A→B 后的原 metadata 读取均已实际验证；整体 V1.3 继续实施。查看不授予执行能力或完整管理中心资格。

强制暖连接重连已实施：[共享输入类型](reconnection-types.ts)闭合独立Action的准确原carrier/Job/ref与当前Source/static replacement，[实施决定](../../../../.agents/notes/implemented/architecture/2026-10-05-forced-mcp-reconnection-and-original-outcomes.md)保存非原子停止/建立、持久发布和原申请的取舍。此前23个目标主任务、源码外80×24整例及545文件/441主任务完整默认分别通过；最新建立失败的持久收尾修复及13项受影响任务见下文。真实冻结输入、当前完整默认失败、历史红与未覆盖范围见[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。普通connect继续暖复用；当前 OAuth/续期与来源增删边界见下文。持续 Soak、真实系统浏览器、OAuth PTY、三平台和完整 V1.3 继续分别验收。

[createMcpAdapter](index.ts) 是显式可选协议适配器，没有第二 Runtime。import/factory 不 spawn、连接或读取旧配置；配置选择一个稳定 server ID 和 stdio（绝对 command/cwd、明确 args/env）或 HTTP URL/headers。凭据由宿主显式注入，adapter 不发现全局凭据、打开认证浏览器或打印远端错误正文。

`scope(scopeId)` 只建立引用。`snapshotTools()` 才按需连接并读取有界目录，返回冻结的 `ToolDefinition[]`，由宿主在下一安全装配边界注册进相同 UnifiedExecution。定义 ID 绑定 server/远端名称；版本摘要绑定配置与完整 descriptor。再次 snapshot 产生新版本，不修改旧定义或自动热替换 Runtime。旧定义保留原 input/output schema 和连接以便历史说明；目录版本变化或失效后，旧定义调用在 wire 前以 `mcp_catalogue_stale` 明确拒绝，不切换到新实现。工具移除不销毁旧快照或历史。

工具执行不重试，不替调用者重新绑定远端连接。取消只让本地请求停止等待；MCP cancellation notification、断连、HTTP 失败和超时都不是远端已停止的证据，可能已派发的无确认结果返回 `outcome_unknown` 与 `remoteStopConfirmed:false`。有效 MCP `isError` 作为远端失败事实保存。输出 schema 由原快照验证；异常输出也不冒充已知零效果。普通宿主权限、输入验证与持久派发仍属于 UnifiedExecution，外部描述不扩权。

多个 scope 共享一条连接。`release()` 幂等，只废弃本 scope 的后续调用；其他 scope 继续使用。最后一个 scope 等有界在途请求结束后关闭连接。`close()` 是明确宿主关闭整个 adapter 的动作，不能把一个页面卸载当全局 close。失联后，只有下一次显式目录/读取操作可建立新连接；既有工具调用不会自动重连重发。

具名只读接口为 `listResources`、`readResource(uri)`、`listPrompts` 和 `getPrompt(name,args)`。结果是远端来源数据，不自动成为 system instruction 或 executable Action。调用与认证失败局部返回；错误 server 不影响历史读取或无 MCP 的普通 Agent。

默认单消息/HTTP response body 1 MiB（可配置至 64 MiB）、目录最多 1024 项/32 页、在途请求 16、每请求 10 秒；scope 与 stdio 排队写入也有上限。重复分页 cursor、超限和无效帧准确拒绝，不静默裁剪有效目录。HTTP 长 SSE response 达到总 body 上限会终止该连接，不能据此确认远端 effect。stdlib [bounded transport](transport.ts) 不使用 SDK 的无界 stdio ReadBuffer；后台排空 stderr，不转发未处理日志或秘密。stdio close 清本 adapter 拥有的直接客户端进程，不宣称取消远端工作或 POSIX 后代监督资格。

[stdio/HTTP 真实本机测试](../../test/isolated/mcp/mcp.test.ts)覆盖按需连接、scope 共享/释放、目录更新/移除的快照版本、资源/Prompt、取消/失联未知事实、有界 frame/目录/请求，以及实际 UnifiedExecution 的权限与持久 provenance。全部模型为固定本机 fixture。完整 OAuth/credential UI、远端 tasks/reconcile、默认配置装配和发行资格仍由相应 owner/计划处理；直接 adapter 默认对 required tasks 返回明确不支持；普通 lifecycle 的 live Task Job 适配见下文，不伪造完整 task 平台。

[完整包制品回归](../../../../tests/isolated/unified-agent/built-package.test.ts)按 Agent manifest 全部入口在同一次 build 构建，生成 Worker/guardian 资产后，从源码树外逐一导入并实际执行 SQLite、Shell、Skills 与 MCP。AI 也独立构建，不链接 workspace source alias；外部 npm 依赖复用已安装模块。该证据验证当前制品布局与执行定位，不代替独立安装、签名或跨平台发行资格。


## 当前 HTTP OAuth 与原申请

[OAuth provider](oauth-provider.ts) 复用 host 的一个 CredentialVault owned scope，持久 tokens/client information/discovery state 及新 tokenRevision；PKCE/state 仅在当前 flow。保存与冷读取沿 SDK schema 验证，并限定可消费的 Bearer ASCII grammar/8000字符；原生保存开始后的取消/失败保 publication unknown。现有 [Broker](credentials.ts) 的 `issueOwned` 仅接可信 private resolver，实际 header 前复核原连接全部 identity 与 tokenRevision；旧 handle 不因新登录而取得新材料。

显式 Login/Refresh/Clear/Revoke、callback、真实网络策略和 OS opener 归 [Service owner](../../../../apps/service/README.md)与[认证 active](../../../../docs/active/mcp-authentication.md)。Adapter 不获得 SDK authProvider/finishAuth 或自动401重试；恢复已有凭据与临近过期 refresh 不打开浏览器或注册，认证成功与新连接独立申请，旧 Tool/Task 不重放。Source Remove 保声明发布与准确 owned cleanup 两个结果，manual共享引用不删除。

普通失败 connect 的 quarantine 仅在原 parent/Job 完整身份、严格 stopped/unopened 终态和同一 Entry ended 后可解除，await后再核原 ticket/epoch/ref/digest；stop未知、迟到handle、reconnection持久化及发布隔离保持。[lifecycle](../../test/isolated/mcp/lifecycle.test.ts)新增真实 child terminal 提交屏障、stop unknown、坏 parent 和另一 Session 隔离；[reconnection](../../test/isolated/mcp/reconnection.test.ts)继续核 stop/late-handle/CAS/final-publication fence。完整默认与平台证明按[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不从旧测试的不覆盖范围推导当前缺失或资格。

## 纯缓存与最终准入

`scope.getCachedTools()` 同步读取已发布的冻结定义，空缓存返回空数组；它不连接、不发现目录、不调用工具。`adapter.getCatalogue()` 同步投影 `{serverId, configDigest, generation, available, definitions:[{id,version}]}`，不含 transport 正文。scope 的缓存定义仍绑定自身 lease，释放一个 scope 不使其他 scope 的当前定义失效。adapter 没有脱离 scope 的可执行定义入口。

`adapter.getToolsMetadata()` 同步返回同一个已验证 frozen cache 的 `{serverId,configDigest,generation,available,tools:[{definitionId,definitionVersion,descriptor}]}`。descriptor 是完整原 SDK Tool，保留已接受字段和省略语义；getter 零 I/O，没有可执行 handle。`getCatalogue()` 从这个同代快照投影 IDs/versions，refresh capture 在执行成功尾部同步封存，避免 await 返回后换代。

## 原工具 metadata 的不可变保存与查看

[tools-metadata.ts](tools-metadata.ts) 只在实际 connect/refresh Tool 或 Action 封存原 descriptor，按自己的 publisher Execution scope 发布 64 KiB chunks、manifest、32项 index pages 和 root。非执行 snapshot record 只保存有限 origin/pointer/availability，单独 content type 不污染原连接目录；全文不进入普通 ToolResult 或 Worker record。发布失败保原真实连接/刷新事实并保存 unavailable；record 回执未确认时返回原不确定，Query 不补发布。相同原 key 的已有事实不按当前 cache 或新 publisher 重新发布。

`mcp.tools.snapshots@1` 和 `mcp.tools@1` 都是同 builtin.mcp namespace 的只读 Query，完整 display envelope≤32 KiB、每页≤32项。明确选择原 record/generation，续页固定原 indexDigest；不连接、不查凭据、不调用远端、不授 Tool grant。只实读原 index，缺失/损坏/scope/hash/size不等则 unavailable 或有限失败。当前 live/generation 单独投影，旧 snapshot 不改标。

`sourceRecordKey` 不单独证明 writer。读取核实际 publisher 已保存 result（去 metadata pointer 后与完整 source value 全等）、原输入 digest/版本/Session/Store，以及真实 connection command/parent/root-work；原 operation key A 与合法复用时的新 source key B 分别绑定，不依赖可变 A head。Artifact 再核实际 publisher scope。私有 bootstrap 的 Job 全文不由公共 Execution 投影重建。直接 Query 使用已有只读 `readExecutionGroupSafety` 核当前 Store/Session/subject，保留其8192记录上限，超限仍有限失败。取舍及代价见[原 metadata 决定](../../../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-tool-metadata-artifacts.md)。

[实际 metadata 测试](../../test/isolated/mcp/tools-metadata.test.ts) 当前13/952/0：真实 SQLite/Artifact/local SDK peer，65工具、3,660,270 bytes/56chunks全文等价、两代刷新与冷 removed-server，普通 Model Tool connect/refresh、自身 publisher scope、fork/foreign、物理缺失/损坏/256KiB node、缺 Artifact host、发布失败、SQL commit 后丢回执、非法预览及 warm B复用A。公共 maintenance 实际 create/inspect/restore 生成新 Store B，当前 B 准入仍核原 A snapshot/index/descriptor，旧 expected A 与 foreign subject 拒绝；冷读取零新增 RPC/Model/publish/cursor，历史不产生 Tool grant。当前原六邻接28/301/0；完整 Client与真实80×24消费者分别归对应 owner，不由本片推导三平台/全部累计阈值资格。

### Query、节点与工程上限

两 Query 的 version 1 输入及 display payload 闭合，actions/artifactRefs 为空。`mcp.tools.snapshots@1` 输入 `{serverId?,afterKey?,limit?:1..32}`；原 `recordKey` 排序前进，Server 筛选可以产生带下一 key 的空页，Host 核跨请求严格前进。`mcp.tools@1` 输入 `{recordKey,generation,indexDigest?,afterIndex?:0..16384,limit?:1..32}`，第一页可省略 digest，后页固定原 digest；连续 entries/nextIndex 必须推进到原 toolCount，只有原尾部 complete。按完整 envelope 的 UTF-8 字节自适应减行，单条不能装入时有限失败。

`Origin={originStoreId,sessionId,serverId,configDigest,connectionExecutionId,publisherExecutionId,generation}` 保历史原 Store；当前 Store 仅用于读取准入。`ContentRef={id,scope:{kind:'execution',id:publisherExecutionId},mediaType,size,hash}` 使用实际 ArtifactWriter ID，size 为 Decimal64，hash 为小写 SHA-256。JSON MIME 为 `application/json; charset=utf-8`，正文块为 `application/octet-stream`。snapshot key 为 `tools/<SHA256(publisherExecutionId)>`，content type 为 `builtin.mcp.tools.snapshot@1`；available 保存完整 root，unavailable 只有有限 reason、index=null。完整公开 DTO 与原 descriptor reader 归[Client](../../../client/README.md)。

树节点采用 canonical UTF-8 JSON；`InternalRef={id,size,hash}`，各节点保原 origin，父 ref 核真实子 bytes：

```text
root = {kind:'mcp_tools_index',version:1,origin,sourceRecordKey,
        toolCount,itemsPerPage:32,pages:InternalRef[]}
page = {kind:'mcp_tools_index_page',version:1,origin,startIndex,
        toolCount,entries:Entry[]}
manifest = {kind:'mcp_tool_descriptor',version:1,origin,toolIndex,
            definitionId,definitionVersion,descriptorHash,descriptorBytes,
            chunks:InternalRef[]}
```

root 原字节 SHA 即 indexDigest，节点不含自身 digest。Entry 的 label 最多120个 JS code units、必须完整 UTF-16并标明是否截短；name 全文保在原 descriptor。manifest 只读一次，chunks 除最后一块外恰64 KiB、最后1–64 KiB，允许 UTF-8跨块；完整 EOF/size/hash/fatal UTF-8/JSON/schema核验后才返回完整 SDK Tool，保原 accepted 字段及省略。

| 范围 | 上限与超限行为 |
| --- | --- |
| 原工具数量 | adapter 准入最多16384项 |
| 单 descriptor | 最多2048个64 KiB chunks |
| 整树 Artifact | chunks/manifests/pages/root合计65536个 |
| JSON 节点 | 每个256 KiB；全部 index/manifest JSON合计64 MiB |
| snapshot record | 8 KiB，不携全文 |
| Query | 完整32 KiB envelope，每页最多32项 |

超限使整份 metadata unavailable，不截断为 complete。顺序发布与读取不扩大 Worker pending/ordinary/control 预算；部分 Artifact 未形成完整 root 不构成可用快照。上述累计极限、8192记录大组及恢复失败/异常清理窗口没有因有限成功例取得全部资格。

显式生命周期 owner 调用 `invalidateCatalogue()` 立即提升代次并清缓存，零 I/O；随后只能通过显式 `scope.snapshotTools()` 连接/刷新。完整 descriptor 内容变化发布新代次；未变化的同连接刷新保留代次。刷新期间发生失效/断连会拒绝该旧刷新，不能恢复已失效目录。低层 adapter 本身不订阅通知自动连接；下文的显式 lifecycle 将其已发现目录投影给 Runtime 的下一安全 Step。

每次 Tool 调用先克隆并冻结准确参数。输入 schema、字节检查与实际 RPC 使用同一个快照；调用者在 wire 准入等待期间修改原对象，不改变已绑定调用。新调用的非法 schema 或超界输入在发送前局部失败。

可选 `admitToolCall(binding,{signal})` 是可信宿主最后准入回调，收到冻结的 server/scope/configDigest/catalogueGeneration/definitionId/definitionVersion。leaf 在等待回调之前与之后复核 lease、连接和目录，最终检查与实际 `tools/call` 之间没有额外 await；旧等待调用拒绝时保存 `adapterAttempted:false`。宿主拒绝的任意错误正文不会透传。该回调不替代 UnifiedExecution 的持久批准，也不使当前直接 child stdio 或默认 fetch 取得合格 process/network/DNS/proxy 边界资格。配置摘要固定于 factory；配置改变应由宿主失效/释放旧 adapter 并新建，不能原地改 transport。

本机回归新增纯缓存零启动/零调用、宿主准入等待期间目录变化零旧 RPC、显式刷新新版本、共享 scope 释放隔离。默认配置装配、可信 transport ports、OAuth 与 tasks 仍未由本切片实现。

## 持久连接 Job 与下一 Step 目录

`createMcpLifecycle({servers, transportPort?, readyTimeoutMs?})` 返回 `extension`、`readStepCapabilities(input)` 和 `close()`。bootstrap Extension ID 为 `builtin.mcp`，提供普通 Tool/Action `mcp.connect`（输入 `{serverId,key}`）、只读 Query `mcp.catalogue` 和每个 server 的连接 Job。factory、Query 与 Step 缓存读取均不连接；只有已持久派发的 Job `start` 能调用显式注入的 `transportPort.open` 并发现目录。缺少可信 port 时连接请求局部返回 `mcp_transport_unavailable`，不启动 Job，也不降级到直接 stdio/fetch。

连接按原 Store、Session、server 隔离，Job version 绑定固定配置摘要。Job.start 还复核 factory 私有 bootstrap staging，不能从任意 Job input 自报 Store scope 获得连接；这个保护不替代 Core 权限。`mcp.connect` 使用普通 `operations.ensure` 创建 detached Job，并等待真实 ready 通知；ready 后由普通 execution 的 `records.write` 保存有限非秘密目录、原 Store 与实际 operation ref。相同原 key/当前 live ref 重试返回原事实，不重新连接；冷启动或只读历史没有 live handle，同 key 明确不可恢复，不依据 record 自动重连。不同 parent 的 warm reuse也保留原 operation ref，不制造新的 ensure 关系。Query 返回 `{items,nextAfterKey}`，按 record key 分页（每页最多 100）；历史目录与当前 `live` 状态分别呈现。

`readStepCapabilities({command:{originStoreId},session:{id}})` 只投影本 factory 实际 live scope 的缓存，返回 `{extensions,toolIds,snapshot}`。这些是 additional definitions：远端 Extension ID 为 `builtin.mcp.remote.<serverId>`，版本绑定目录 generation，Tool ID/完整 schema/版本保持原 adapter 快照。宿主在下一安全 Model checkpoint 合入其原有 Tool IDs，不应把 bootstrap/global Extension 重复注册。等待中的旧目录调用仍由 adapter 在 wire 前复核固定 generation/configDigest/definitionVersion，失效后零旧 RPC；目录变化不改历史 Model 或已派发事实。

`transportPort.open(binding,{signal})` 收到真实 Job execution、原 Store、Session、配置摘要和固定 transport configuration，返回 SDK transport、`stop()` 与 `stopped` supervision 通知；可选 `readProcessEvidence()` 只交接所属进程的有限事实。宿主负责 process/network/credential 准入；配置与凭据应在可信边界选定，秘密不进入目录记录或 Step snapshot。未知停止会立即废弃缓存，但 Job 保持待确认，不冒充释放资源或远端 Tool 已停止；`stopped: ended` 只证明本 transport 生命周期结束。ready 等待超时只使本连接请求失败，不伪造 Job 已停止。关闭请求在 open 尚未返回时保留；迟到 owned handle 必须先停止，不能重新连接或发布目录，停止未确认仍保留原 Job 待核实。取消/关闭仅作用于已知 owned handle，另一 Session 连接保持隔离。工厂最多 32 个 server、512 个连接/启动记录，ready 等待有界至 60 秒。

[真实 Core 生命周期测试](../../test/isolated/mcp/lifecycle.test.ts)与[adapter 回归](../../test/isolated/mcp/mcp.test.ts)组合 17 pass / 192 assertions，覆盖 SQLite Job/receipt 先于本机 HTTP 网络、实际 compatible Model 下一 Step 看见远端 Tool、纯 Query/cache 零 I/O、精确 Session 取消、冷历史不恢复、迟到 open 的已确认/未知停止、参数快照和 idle Action/warm 重试零额外 Model/连接。[默认 Service 装配](../../../../apps/service/src/mcp-configuration.ts)已接入可信 server 选择与纯缓存 Step 投影。此组合中的注入 port 只有本机 fixture 资格；下文独立 port 的实际证据分别记录。低层 adapter 的显式独立连接能力不等于 lifecycle 的生产准入。

[Service 冷后显式新连接](../../../../apps/service/test/isolated/mcp-cold-reconnect.test.ts)补充真实两次 process 生命周期：冷 bootstrap 后历史 GET 零额外 I/O，旧 key/refresh 拒绝；新 key 经新 Action/connection Job 两次原 Ask 后使用新目录，真实新 Tool 效果一次，来源漂移在新批准等待中阻止连接。当前1项65断言通过，原 connection record、operation ref 与旧 Tool 保留；同 Profile/Store 不授自动重连或旧批准。它使用公开默认工厂和源码外 Host、auth:none 与 pinned loopback，正常关闭及具体限制归[Service owner](../../../../apps/service/README.md)和[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#冷后显式新-mcp-连接的公共链)，不扩大为完整冷恢复或三平台资格。

## 原连接申请的有限事实

`builtin.mcp` 的只读 `mcp.connection@1` Query 由 [connection-query.ts](connection-query.ts) 实现，输入闭合为 `{executionId,serverId,key}`。它沿现有 `readExecutionGroupSafety` 核当前 Store、Session 与主体，保留8192 records准入上限；读取准确原 Action、其准确 operation Job 及原 parent，不读取整组 Execution 正文或完整 catalogue Query 再裁剪。既有 `getExecution` 会加载准确原 Action result，仍受原 Worker/result 上限；当前 live callback 读取既有缓存 projection，不声称内部完全没有 definitions 处理。

完整 `builtin.mcp.connection@1` DisplayContent envelope≤16KiB，actions/artifactRefs为空。有限 payload 保存当前准入 Store、原 Session、Action 与 Job 身份、phase、准确六字段 operationRef、原 ready、当前 live/currentGeneration、created 和有限 reason。本 Runtime 的无模型 Action 保存为 kind=job，definition 为 `builtin.mcp/mcp.connect@1`；connection Job 的 definition 是 `mcp.source.connection@1`，或准确 static `mcp.connection.<serverId>` 及原 configDigest。原 inputDigest、origin Store/Command、真实 parent、root-work和版本均核对，不以 record key 单独证明关系。

原成功结果的完整 definitions 数量只投为 toolCount，不输出定义正文；真实 ready 与长寿命 Job running 可以同时成立。created=true 要求完整 operation key `connection/<serverId>/<rawKey>` 和 connection.parentExecutionId 同时归当前 Action，warm复用保留原Job/ref并显示created=false。当前 holder unavailable、停止等待或停止unknown时，live=false、currentGeneration=null，原ready事实保持。planned/dispatching/running为pending；失败且明确adapterAttempted=false、无operationRef才可分类零连接失败，有detached operation的failed/cancelled仍unknown。Query不发布记录、不修补目录、不连接、不读vault或调用Model。

[实际 Query 测试](../../test/isolated/mcp/connection-query.test.ts)当前3项106断言通过，含真实SQLite/local MCP的新建、warm复用、冷removed-source、400工具长schema、错input/ref/版本、detached失败和受控stop barrier/unknown。停止原红例live=false但generation仍2保留，修后两窗口均原ready不变且generation=null、零额外RPC/cursor。普通请求的公共Host原Command核验和实际键盘资格归[CLI](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)，读取事实不恢复执行许可。

## 显式 stdio guardian port

公共 MCP leaf 导出 [createMcpStdioTransportPort](stdio-port.ts)、`McpStdioPortOptions`、`McpStdioPortError` 和 `mcpStdioGuardianAsset()`。宿主固定完整 server 配置、绝对 Bun/command/cwd、env 名单与必要的 `admit(binding,{signal})`；import/factory 不读取文件或 spawn。`open` 在真实 Job 派发后核实原 Store/Session/execution/configDigest/scope，并调用可信最后准入，之后才启动私有 [guardian](stdio-guardian.ts)。该 port 不自动发现用户凭据或继承环境；秘密、proxy、loader 和 runtime 注入 env 名称被拒绝。准入回调仍须核实实际 SQL Job identity、当前授权及宿主执行资格。

guardian 使用有界 JSON-RPC frame、控制队列、排队写和 stderr 排空。父 EOF、取消、leader 退出或协议断开都会请求收缩性停止；只有继承 POSIX process group 已消失且 guardian 真实关闭才能给出本 transport `ended`。不能确认时保持 `unknown`，不据此宣称远端 Tool 效果已停止。实际 stdio 后代不得仅因 leader/pipe/SDK 已关闭而释放 supervision。

[stdio-process-evidence.ts](stdio-process-evidence.ts) 的 closed v1 `McpStdioProcessEvidence` 仅覆盖 `guardian-and-server-only`：绑定原 Store／Session／execution／server／scope／configDigest 和真实 owner PID，保存两进程的原 PID／PPID、Darwin libproc BSD 出生 sec/usec、各自实际 ChildProcess exit 的 code/signal/reaped，以及 `alive/absent/reused/unavailable` kernel 状态。证据沿原 nonce／sequence 私有控制帧交接；terminal 不能替换 ready 的 server PID／birth。port 的同步 getter 返回复制并递归冻结的数据；[lifecycle](lifecycle.ts) 在原 Job progress 和 terminal details 写入前重核全部绑定与 owner。没有 getter 时保原字段；getter 抛错或非法证据只记有限 `ownedProcessesUnavailable`，不改变原 supervision。未生成出生或 exit 事实时保 null／unavailable，error／pipe EOF 不充作 reap；原生读取失败仅在 kill0 返回 ESRCH 时确认 absent，Node parent 无 Bun FFI 时也保持这一限制。解码拒绝额外字段、外域身份和 reap 后仍 alive 的矛盾组合；配置、command、args、env、nonce 与秘密不进入收据。

该 port 当前仅开放已验证的 macOS inherited process-group 路径；Linux/Windows 返回 `mcp_stdio_platform_unsupported`。它不承诺阻止 `setsid` 逃逸、网络访问或任意外部 daemon。[stdio 真实测试](../../test/isolated/mcp/stdio-port.test.ts)当前 7 pass／73 assertions，保原后代、忽略 TERM、超界帧/stderr、实际 Core Job、Session 隔离、准入等待取消零 spawn，以及真实父 EOF/SIGKILL 和无关进程保留；原调用与预算保持，补核出生、原 exit 和 strict codec。跨平台执行边界及整体 MCP 资格继续按总体方案实施。

Agent manifest 的第三资产构建脚本 [build-assets.ts](build-assets.ts)生成 `dist/mcp/stdio-guardian.js`。构建后的 `mcpStdioGuardianAsset()` 仅定位同包这个 `.js`，缺资产局部失败；源码调用者必须显式选择已构建 guardian，不能回退 `.ts`。[源码树外包回归](../../../../tests/isolated/unified-agent/built-package.test.ts)实际导入该公共 leaf，通过 SQLite connection Job、真实 packaged guardian 和 Model／SDK 执行一次 Tool，再核原 progress 出生身份、取消终态与两进程退出；公共维护 A→B 后只读原结果／输出且零重放。[installed 默认 Service 恢复链](../../../../tests/isolated/unified-agent/profile-mcp-restore.test.ts)沿原新 Store 明确连接、Session 取消、Service 正常退出与冷 GET，独立 libproc 核出生身份，保原 Job 绑定、terminal／progress／cursor及Model0。该两文件保全部原断言与期限，具体执行和失败范围见[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-连接的进程身份与冷退出证据)。这些证据不取得全部后代、签名或其他平台资格。

[Service HTTP port](../../../../apps/service/src/mcp-http-port.ts)提供另一显式 trusted transport：完整 DNS 候选核验、socket 地址 pinning、原 Host/TLS servername、禁止 redirect/proxy 继承和有界取消/关闭。秘密 headers 由宿主注入，不进入 lifecycle 固定配置或目录；仍必须提供真实 Job 准入。它与 stdio port 的资格分别验证，不能由低层 adapter 的默认 fetch 推导。

## 连接 transport 凭据 broker

[createMcpCredentialBroker](credentials.ts) 使用明确注入的 `vault.resolve(credentialRef)`，factory 和 `issue` 不读 vault、不联网。`issue` 只供可信宿主签发 process-local opaque `McpCredentialRef`：私有 registry 绑定 profile、原 Store、canonical Workspace、Session、原 connection Job、配置 source/revision、server/configDigest、auth profile/policy revision，以及 purpose、expiry 和 revocation revision。已知字段封闭且有界；复制任意 DTO 或未知 ref 不能建立 registry 绑定。当前 closed purpose 仅为 `mcp.http`，含义是连接 transport 的 Bearer 认证，不是远端 Tool/Task 的逐操作授权，也不是 OAuth flow。最多 512 个 handle（宿主可明确调整至 4096），过期/撤销条目在显式签发时回收；新 broker/process 不能恢复旧 handle。

`withHeaders(ref,use,callback)` 冻结本次准确 ref/identity，在 vault lookup 前后及 callback 使用点复核范围、期限、撤销和 signal。lookup 等待可由取消及时结束；迟到 backend 返回不再调用 callback。只有可信 callback 临时接收 Authorization header，秘密不进入配置、目录摘要、Store、snapshot、result、诊断或日志。非法 header material 和 backend/callback 异常只返回有限错误码。JavaScript 字符串与已交给 HTTP 实现的副本无法保证清零，不能宣称固定 secret 驻留时长。

`revoke(ref)` 立即阻断这个 handle 的新解析和挂起解析，不会收回已有 header 或已发送请求，也不自动关闭另一 Session 的连接。撤销 broker handle 与删除底层 vault credential 的范围不同；显式删除共享底层 credential 会影响所有依赖它的未来解析。底层可靠持久化/跨进程撤销仍是注入 backend 的契约，本次只使用临时 vault，未验证 OS keychain。

[Service HTTP port](../../../../apps/service/src/mcp-http-port.ts) 的可信 `servers[].credential={broker,bind}` 在原持久 connection Job 准入后，从实际 SQL Job/Session/Workspace 和可信 source 固定 ref/identity。port 再核对 Store、Session、Job、server/configDigest，拒绝同时提供 raw Authorization/Cookie 的歧义配置；每次真实 pinned socket 前重新物化凭据。请求 signal、本 owned transport 关闭和有限 timeout 共同约束等待，关闭后迟到解析不会创建 socket。旧式可信 host headers 路径仍存在，它不能被本 broker 的资格自动覆盖。该接入不代替普通 Core permission、不允许 JSONC 自报 Workspace/source/purpose，也未接默认配置共享 vault；OAuth 和远端 tasks/reconcile 不由凭据接入本身完成。

[broker 测试](../../test/isolated/mcp/credentials.test.ts)与[真实 SQLite/HTTP 测试](../../../../apps/service/test/isolated/mcp-credentials.test.ts)核实签发零 lookup、每项 identity/purpose/expiry/revision 拒绝、挂起撤销/取消零迟到使用、真实持久 approval card 未批准与失效凭据零请求、两 Session 隔离、已收到请求保留真实成功事实，以及准确 Session 取消关闭 transport 后零迟到 RPC。与原 [HTTP port 测试](../../../../apps/service/test/isolated/mcp-http-port.test.ts)组合在 macOS/Bun 1.4.2 实际执行通过：11 pass、112 assertions。使用固定模型、临时 SQLite/vault 和本机假协议端点，不涉及用户凭据、真实 OAuth 登录、付费接口或新的 TLS/三平台资格。

默认宿主装配接受原 `McpLifecycleOptions` 对象或可信同步 `McpHostFactory({profile,credentialVault})`。`createDefaultProcessConfiguration` 先创建一个 vault，再将同一实例交给 factory 和 configuration management；factory 收到冻结的选定 profile，只构造生命周期与可信 port，不应在批准/持久 Job 派发前读取秘密或联网。JSONC 仍只能选择宿主白名单 server ID/版本，不能提供 factory、credential binding、URL/header/env 或权限。factory 可通过可信已打开 Store 的闭包查询原 Job/Session/canonical Workspace/source 并签发 handle，不需要额外 Runtime 管理协议。未配置该可信 factory 的默认 main 不发现 MCP 或认证环境。

[默认共享 vault 回归](../../../../apps/service/test/isolated/default-mcp-credentials.test.ts)在 macOS/Bun 1.4.2 实际通过（2 pass、35 assertions）：真实默认 compatible SDK Model 提出普通 `mcp.connect`、connection Job 派发后连接，下一 Step 读取真实远端 schema 并完成 RPC；配置管理 put/revoke 与 broker 共用临时 backend，A 凭据撤销阻止 A 未来请求，独立 B 凭据仍可完成新 RPC；已成功记录不改标。持久 Ask card 等待时凭据读取/MCP socket 为零，manager 在挂起 lookup 中撤销阻止迟到 RPC，views/管理回执不含秘密。该证据没有接真实 OS keychain、OAuth、远端 tasks 或通用逐操作权限服务。


## Resources / Prompts 的普通持久执行面

`builtin.mcp` 提供 `mcp.resources.list`、`mcp.resources.read`、`mcp.prompts.list`、`mcp.prompts.get` 四个普通 Tool 和同名 Action，版本均为 `1`。它们与 connect、remote Tool、Task 分别授权，默认 metadata 为 `effects:['external']`、`safeRead:false`；远端 readOnlyHint、连接审批或目录结果不能授予其他操作权限。Action 复用普通 Extension invoke/Job 记录，Query 复用现有 public Extension 通道，没有新增 SDK 私有端口。

四项公共输入固定 `{serverId,connectionKey,configDigest,generation}`。`connectionKey` 来自原 connect 输入，digest/generation 来自实际连接目录。read 另需 `{catalogueExecutionId,descriptorDigest,uri}`；get 另需 `{catalogueExecutionId,descriptorDigest,name,arguments}`，arguments 为有限字符串 map。Store、Session、Run、请求 Execution 与连接 operation identity 从原 Context/SQL 事实取得，不能由输入自报。lifecycle 核实实际原 connection record、live entry、原 connection Execution/version 和完整 operation ref；无原连接、跨 Session/Store、fork/import provenance 或旧版本在 wire 前拒绝，不以历史重连。

list 保存原目录 Execution 对应的不可变 data record，目标 descriptor 的 SHA-256 使用 canonical JSON，避免 SQL projection 重排对象键改变摘要。read/get 核实同 scope 下真实成功的原 list Execution、Run/input digest、配置/generation、目录与 descriptor；URI/name 变化、错误目录引用、缺 required 参数或未声明参数拒绝调用。原输入克隆冻结；审批等待期间调用者修改原对象不改变持久请求或 wire。资源 response 的 contents URI 必须仍是原请求 URI，矛盾结果保留 unknown。目录版本只保证捕获的本地 generation；没有资源/提示通知刷新或未通知的远端变化探测，新 list 是新的普通执行。

leaf 的 `scope.captureRead(expectedGeneration).execute(request,{signal})` 只捕获已有 client 与 connection/catalogue generation；它不调用 lazy `connection()`。每个分页 RPC 和 read/get RPC 前作最后 freshness/signal 检查，无 await 后切换 client。wire 前失败/取消明确没有 adapter attempt；wire 后断线、超时、取消、schema/预算问题保留原 Execution 的 unknown，不重发、不伪造远端停止。原 frame/body、item/page、并发和 timeout 上限继续适用；聚合目录也受整体 body 上限约束。

成功结果保存原 binding、请求、目录或完整结果/原 artifact 引用，Query `mcp.resources`、`mcp.prompts` 输入 `{serverId?,afterKey?,limit?}`，按原 record key 返回有限窗口及 `nextAfterKey`。列表记录同时提供 raw descriptors 与对应 canonical digests。Query 只读持久数据与本进程 live availability，冷启动为 `live:false`，零连接、Model、凭据或 RPC；未知执行不会制造成功缓存。记录写入的 `executable:true` 仅要求 Core 核验原 namespace/Store 写入资格，远端正文仍是 data，Query 不生成 executable Action。

完整正文封装为 `source:'external_mcp_data'` 的普通 Tool 消息。Prompt 的 description、多条 messages、原 role 和全部 content 保留为远端低信任数据；不会成为 system instruction、自动注入提示或赋予权限。超过 8192 bytes 的完整 JSON body 经原 Execution scope artifact 发布，并通过 `modelContent` 完整 EOF/hash 验证进入 Model；缺 ArtifactWriter 时明确 unknown，不用摘要冒充完整正文。Resource text/blob、URI 与 MIME 同样保留为数据，不按远端 URI 打开额外文件或 fetch。ArtifactStore 由正常 Service process 装配提供。

[leaf 回归](../../test/isolated/mcp/reads.test.ts)覆盖无 live capture 零连接、原 generation 失效、捕获参数、不重连、取消前零 wire，以及实际返回 body/item 预算拒绝。[默认 Service 回归](../../../../apps/service/test/isolated/mcp-resources-prompts.test.ts)使用固定 compatible SDK、临时 SQLite/ArtifactStore、真实 pinned HTTP 与 macOS owned stdio guardian，覆盖四项普通 Tool 的完整 Model 流程、独立 Action deny/Ask、原目录与参数绑定、跨 scope/旧版本拒绝、cold Query 零 I/O、wire 前后取消和完整低信任 Prompt。它不资格化 OAuth、用户 server 管理、资源模板、sampling/elicitation 或三平台 stdio 发行。

## Live 远端 Task 与普通 Job

[live Task adapter](tasks.ts) 将已连接目录中的 `execution.taskSupport=required` 工具登记为普通 Tool 与对应 `<toolId>.task` Job；直接 adapter 默认仍拒绝此模式，lifecycle 明确启用并通过 `getCachedJobs()` 纯缓存投影提供额外 Job 定义。版本封存真实 transport 配置摘要、原 descriptor、Task adapter 版本 `1` 与服务器公布的 Task capabilities；旧目录版本不能在准入等待后换成新定义。普通 Tool 权限与普通 Job 权限分别执行，连接认证、远端 annotation 和目录发现不产生授权。

Tool 通过原范围 `operations.ensure` 创建 detached Job，只返回原 OperationRef 和已调度事实。Job 输入包含实际 arguments 与固定 binding，供独立授权核对；私有票据还绑定原 Session/Store 与捕获参数，最多保留 512 项待启动票据。仅在真实 Job dispatch 之后，`start` 才再次执行准入/版本复核并发出一次 task-form `tools/call`。真实 taskId 连同原 Store、Session、Job execution、server/config/catalogue/definition 及协议 capabilities 保存为普通 Job reference。响应丢失不重发启动，获得 taskId 不表示任务成功。

唯一普通 Job observer 使用官方 SDK 协议 schema 查询 `tasks/get` 与 `tasks/result`；可取消等待将远端 poll hint 限定为最多 250ms，避免 SDK 默认不可取消的长 timer。completed 之后还须核实真实结果及固定 outputSchema；failed/cancelled 使用真实 Task 状态。`input_required` 不触发 sampling/elicitation 或自造回答，明确保留未知事实；失联、错误结果及未知 Task 不成为成功。取消只发送原 taskId，`cancelled` 才确认 stopped，working 回执仅 requested，断连接不代表远端停止。已结束或已确认停止的 Task 释放 connection lease；未确认停止的关联保留到明确关闭 adapter，不从未知状态推导释放。

[协议反例测试](../../test/isolated/mcp/tasks.test.ts)使用官方 SDK 内存 transport，验证缓存零 I/O、等待准入时目录变化拒绝旧 RPC、Tool/Job 精确版本、参数捕获、scope 释放后的原 Task lease 和丢失 handle 不重发。这是协议证据，不是网络/进程资格。[真实 HTTP/Core 测试](../../../../apps/service/test/isolated/mcp-tasks.test.ts)使用临时 SQLite、固定 Model 与受控本机 pinned HTTP，验证 durable dispatch 先于 task 创建、独立 Task Job 持久审批卡未批准/取消零创建 RPC、父 Run 结束后继续、另 Session 停止不关闭原 Task、真实结果/错误结果、取消/未知和只读重开零网络。新增协议 2 pass / 22 assertions 与真实 HTTP/Core 6 pass / 51 assertions；包含既有目录、生命周期、凭据和 pinned HTTP 的受影响组合为 38 pass / 412 assertions。

此适配只覆盖 live 非交互远端 Task，未实现 OAuth 自动登录、sampling/elicitation、冷启动 reconcile 或任务接管。缺 live handle 明确 unavailable，不从持久 reference 自动 reconnect/restart；显式冷恢复仍需 Core 的合法 owner 入口。HTTP connection transport 的凭据 purpose 仍为 `mcp.http`，不声称远端 Tool/Task 逐操作认证。已有 transport/frame/目录预算、完整大内容链路及跨平台资格边界继续分别按对应 owner 记录。


[默认 Service Task 装配测试](../../../../apps/service/test/isolated/default-mcp-tasks.test.ts)通过正式 compatible SDK、本机 pinned HTTP 和临时 SQLite 验证同一 Run 首轮 connect、下一 Model 获取固定 Task schema、普通 Task Job 的真实 reference/终态，以及父 Run completed 后仍继续。独立 Task Job 在 Ask 下产生持久审批卡：connection 与 Tool 的 Full 授权不代替它，未批准/原卡取消均零 task 创建 RPC。新的 Run 移除 server 选择后零新 Task RPC；未知 server 在 Provider 前拒绝，原 Task 历史不重放。纯 catalogue Query 不调用 Model 或 socket。这里的 mode/trust 来自显式可信宿主 `readPolicy` fixture，不冒称新的权限管理 UI 已由本测试资格化。

[Service MCP configuration](../../../../apps/service/src/mcp-configuration.ts)同时登记 captured Task Job 与远端 Tool 的 kind-specific metadata：同实际版本、`effects:['unknown']`、`safeRead:false`，不从 annotations 自授权。`select.listCapabilities()` 仅返回当前选择的实际 bootstrap/connection 与缓存动态定义；顶层 `listCapabilities()` 仅返回实际静态注册，二者均不连接或更新目录。额外 Task Job input 的 server/configDigest 必须匹配当前 Run 的固定选择；未知或旧版本 remote 定义局部拒绝。新 Run 的选择变化不重写已经派发 Task 的原关联。这些纯列表供默认权限 owner 构造实际 allowed 集合，Model 授权不代替 Tool/Job 授权。新增默认测试 4 pass / 34 assertions；与原默认 MCP、权限和共享凭据装配组合为 14 pass / 164 assertions。

## 普通 Server 选择与 live 工具目录刷新

Service 的显式 host 工厂 [createMcpManagement](../../../../apps/service/src/mcp-management.ts) 返回普通 Extension `builtin.mcp.management`、可信 capability 描述及 allowed 表项目。`runtime: () => runtime` 在实际 Action/Query 时晚绑定，factory 不读取 Store、配置、凭据或连接。宿主提供准确原 Store/Session/canonical Workspace 范围的同步 registry supplier，有限 registry 只含稳定 ID、config digest、transport kind、source kind/ID/revision 和独立 `admitted` 事实；外部宽权限不能代替 source 准入。此目录不接受或注册用户 URL/command/env/auth，不实现 OAuth，也不替代正式客户端管理面。

只读 Query `mcp.servers`（输入 `{}`）返回当前可信注册项、selected 状态、范围和六字段 `readSet`：`userEtag`、`workspaceEtag`、`explicitDigest`、`registryDigest`、`registryRevision`、`scopeDigest`。它读真实配置和 host facts，零连接、credential lookup 与 Model。`scopeDigest` 绑定原 Store/Session/Workspace 路径和 dev/ino；另一个 Session 即使文件 ETag 相同也不能重用来源快照。

普通 Action `mcp.server.select` v1 输入 `{serverId,enabled,scope:'user'|'workspace',expectedReadSet}`。实际身份来自原 Execution/Command/Session/Workspace，不来自输入。新 [配置选择 leaf](../config/mcp-selection.ts) 复用原 JSONC 文件锁、ETag CAS 与 publication 校验，在锁内再次读取完整 source/explicit/registry，保留 comments 与未知字段。更高优先级来源已声明同项时拒绝低优先级选择。动作有独立写权限；deny、Ask 等待期间任何准确 source 漂移均零写入。内部 HostMutation ID 固定为 `mcp-select-<actualExecutionId>`，主体及 Store 保持实际事实，复用原 `config.user.write`/`config.workspace.write` journal；Action 结果保留 mutation 回执与原执行绑定。文件发布与 SQLite journal 不是同一事务，发布后回执失败返回原 ID 的 unknown/pending，仅查原事实，不自动重试、清除未知或宣称 applied。选择不修改当前 Run manifest 或原连接。

普通 Tool/Action `mcp.catalogue.refresh` v1 输入 `{serverId,connectionKey,connectionExecutionId,configDigest,generation}`，复核原 connection record、operation ref、实际原 Job 身份和当前 live Entry。`scope.captureRefresh(generation)` 只捕获已存在 client/cache，每一实际 `tools/list` RPC 前最后复核准确连接、scope、catalogue generation 和 signal，不调用 lazy `snapshotTools()` 或自动恢复。目录有界完整读取并通过原 schema/definition 校验后才发布；变化提高代次，未变化保留代次。下一安全 Step 披露实际新 schema，旧 Tool/read/refresh 捕获在 wire 前准确拒绝；移除工具不删除旧执行历史。另一 Session 的原连接和目录保持。

取消在 wire 前返回已知 cancelled，派发后的取消、超时或异常保持 unknown，零重试、无成功刷新记录。成功刷新单独保存 `refresh/<actualExecutionId>`，绑定原 input digest、原 Store/Session/Run、connection operation ref、原 connection record revision、前后 generation 和有限定义 projection；原 connection record 不覆盖。持久记录失败使本目录失效并保持 unknown。`mcp.catalogue` 的原历史 projection 与可选 `currentCatalogue` 分别展示，冷读取没有 current live catalogue，也不依据历史自动连接；同 Session/server 后来的新连接只附着其自身 operation ref，不把新目录投影到旧连接 record。

[Service 实际管理资格](../../../../apps/service/test/isolated/mcp-management.test.ts)通过公共 Client Query/Action HTTP 通道、真实 SQLite/JSONC、临时 Bearer vault、固定 compatible SDK、本机 pinned HTTP 和 owned stdio，核对完整来源 CAS、独立 deny/Ask、错误原连接 ID、Model Tool 与普通 Action 刷新、新下一 Step schema、其他 Session 保持、取消前后、原 pending mutation unknown 和冷历史零 IO。[选择锁内 race](../../test/isolated/mcp/selection.test.ts)及[旧 capture 拒绝](../../test/isolated/mcp/reads.test.ts)分别验证文件 publication 与 adapter 最后 wire 边界。默认 Service 已由 owner 接线本管理 Extension 与可信 host registry，真实默认 registered/empty 两分支经 Client 验证；默认 process 的原始来源装配由 Service source owner 接线；当前 OAuth/续期和正式 TUI 管理入口由各 owner 实施并独立验收；这组较早管理测试不证明它们，真实系统浏览器、OAuth PTY 与跨平台资格仍待取得。


## Scoped raw source connections

[私有来源 leaf](../config/mcp-sources.ts)读取选定 Profile 的 `mcp.json` 和实际 canonical Workspace 的 `.kite-code/mcp.json`；[配置 owner](../config/README.md)定义完整 ETag、项目遮蔽、可信变量、approval/auth binding metadata 与锁内 CAS。MCP Runtime 不读旧 home，不使用 ambient env，不接受 raw 配置中的自报授权。raw、归一化 transport 和安全 registry 摘要独立保存；`source.admitted` 只表示来源装配资格。

[Service source factory](../../../../apps/service/src/mcp-source-configuration.ts)构造时零 IO，以晚绑定的实际 Runtime 读取 Store/Session/Workspace/Execution。Host 的一般 JSONC 命名选择只收窄已 admitted 来源；字段 absent 默认选 raw enabled 来源，显式空集合选择零项。静态 programmatic registration 保持原 Job；动态来源统一使用 `mcp.source.connection@1`，避免与合法 programmatic ID `source` 对应的 `mcp.connection.source` 冲突。持久 Job input 只含 safe server/config/capture digest、原 Store、key、bootstrap ID、实际父 Execution ID/input digest，不含 URL、command/env、Bearer ref 或 private source。

`builtin.mcp.sources` 注册一次。普通 `mcp.sources.list` Tool 和只读 `mcp.sources` Query 公开分页 safe ID/name/transport/摘要及局部 unavailable code，不连接、不取凭据；目录不是 grant。Host 可将原 Run 冻结 selected metadata 作为低信任 user ContextSources 贡献，首次 Model 可见 safe ID，而实际 list/connect/Job/wire 仍独立检查原 capture。未 bind Runtime 的 standalone 装配使用纯 `unboundSelection`：原实际 command/session/workspace 形成零 selected、`readSet:null`，不读文件、不猜原 source 或 granted 权限。坏 source、热漂移或 unavailable Query 不启动恢复；无 selected source 的普通 Model 没有 raw MCP 文件恢复依赖。

普通 Actions `mcp.source.approve` 与 `mcp.credential.bind` 要求原 server/readSet（bind 另含有限 expiry），始终产生实际独立 Question，并核 Store 中原 answered Interaction、accepted revision、subject、原 request 和原 Execution。宽 policy 不代替用户决定。准确 source/approval/binding locks 内 CAS 后，通过独立内部 HostMutation ID 保存原 receipt；文件/SQLite publication 非原子，unknown 只保原 ID，不自动重做。长期来源批准和 credential binding 绑定 Profile+Store+canonical Workspace/source/server/auth-profile/purpose，允许同 Workspace 后续 Session 重用来源事实；每次 Tool/Job 的 Session/Run/Execution 权限仍独立核验。保存 proof 的原 Session 不重标，恢复至新 Store 不自动重绑。

source resolver 冻结私有 server/port，来源变化使旧 Run/连接/捕获局部失败，下一 Run 才捕获新来源。实际普通 source Job 存在并获得独立许可后，才可解析 Broker/vault 或 opening port。HTTP 在 vault 前、异步 DNS 后及真实 socket 前，stdio 在异步 admission 后 guardian spawn 前、start request 与 RPC stdin.write 前同步复查 source read-set/signal；清理写入不受 stale hook 阻断。adapter cached capabilities 在来源失效时撤下，不能阻断无关普通 Tool/Model，也不能 lazy reconnect。文件复查与不合作编辑器后的 rename/socket/spawn 不宣称 OS 原子。

[Service source 资格](../../../../apps/service/test/isolated/mcp-source-configuration.test.ts)覆盖实际公共 Client/HTTP、SQLite、临时 vault、固定 compatible SDK、owned stdio：安全目录/首 Model、项目遮蔽、实际批准/绑定与伪 proof 拒绝、独立 Job deny/Ask、原 Run 漂移和下一 Run、完整低信任 Prompt artifact、DNS/vault barrier 零 wire、cold metadata 和 unknown 原事实保持。[stdio admission barrier](../../test/isolated/mcp/stdio-port.test.ts)核实际 SQLite Job 与 source 变更后零 guardian startup ledger，原未知 Job及 drain refusal 保留。此资格不声明 OAuth、完整 raw 编辑界面或跨平台 stdio。

Service source factory 的 `deriveChildSelection` 在 resolver 阶段封存父原选择与完整来源 read-set、安全 parent Run/Execution/root-work 身份；当时不产生 child ID。实际 child 激活后，可信 host observer 核实际 Session/Run/Command/carrier、完整 child configuration 与父原 snapshot，才独立派生 child 内存 binding。父 snapshot 和 Session digest 不重标；同 Workspace 的长期来源批准可复用，但 child connect Tool 和 source Job 仍各自核独立权限，Core 继续按父子 policy AND。最后 transport hook 同时保原 parent/child 来源和批准/auth/root 字节检查。[delegated source 资格](../../../../apps/service/test/isolated/mcp-source-delegated.test.ts)核真实独立连接/效果、两次原用户 Ask、独立 denial、捕获后漂移零额外连接、错误 scope/template 与真实双 Workspace 派生拒绝。父原 catalogue 尚未包含远端 schema 时，child 引入新 Tool 仍由 Core 动态上界准确拒绝。默认 worker 的固定 role wrapper 只从 `snapshot.configuration.mcp.sources` 读取原封存选择，普通 root 从 `snapshot.mcp.sources` 读取；不展开任意层次。真实 carrier 从持久 `child.start` Command 的原 `parentExecutionId` 精确读取，再核全部 activation/配置关系。[默认 child 资格](../../../../apps/service/test/isolated/mcp-source-default-child.test.ts)的一层正向与 deny/source drift/cold-parent schema 场景通过真实默认策略、SDK 持久 Ask、SQLite 和 owned HTTP，核 child Tool/Job 分别批准、效果一次及父原完整 read-set 不变。祖先权限验证实际更深 lineage，仍核每一真实 carrier 和来源。完整三层 required-task 资格核 root/child/grandchild Run 完成、两层原 carrier 成功并 consumed、原结果接纳/Command/ref、完整原 source/read-set、11 个独立审批和远端效果一次。该三层 fixture 采用 30 秒观测预算，其余直接/deny/drift/cold 场景仍为 15 秒；生产 child deadline 保持 30 分钟，root 无总 deadline，Task 保持 required/attached。早期 15 秒三层 fixture 失败保留；两次独立完整诊断为 16.15/16.513 秒，正式单文件三层观测为 13.944 秒，这些是本机运行测量而非性能 SLA。公共 child cold recovery 的支持范围未因该热执行资格扩大。

## 强制重连、持久发布与原事实

[lifecycle](lifecycle.ts)的普通 `builtin.mcp/mcp.reconnect@1` Action 接收[完整 closed input](reconnection-types.ts)。target 绑定准确 carrier Execution/key、六字段原 operation ref、真实 connection Job、config digest 和观察 generation；carrier 可为 warm B 引用 Job A，也可为准确上一 R，不序列化递归历史。replacement 独立选择当前 Source capture 或 factory 固定 static config，不能互换或从旧 Run snapshot 推导新配置。

同 factory 的 Store+Session+Server 私有 ticket 绑定实际 holder、epoch/ref、原 R inputDigest 和 Job bootstrap。stop 前的拒绝保旧连接；实际 owned stop 与旧 Job 的持久 transportStopped 证明之后才 ensure 新 Job。新 Job 与 R 的普通许可独立，process slot=1仍可前进。held/unknown stop、未确认阶段 CAS、迟到 open 或缺原证明保持 fence，不从 Action 返回、目录 ready 或 finally 推导热可用。

新建立或私有preflight失败时，ready拒绝可能早于真实Job终态提交。父R沿准确原 `newOperationRef`、原signal和既有timeout执行普通 `operations.wait`，再用原完整parent/ref/input/Store/root-work及严格stopped/unopened证明分类；局部failure/ended状态只限定等待路径，不证明停止。新holder仍live但ready阶段或发布持久化失败时保持unknown和quarantine，不等待它将来停止。等待失败或超时仍unknown；新Job后来结算也不追改原R终态。

新目录 staged ready 后仍保 publishing ticket。Step、最终 Tool/Task wire、warm connect、后续重连、refresh 和 Resource/Prompt 准入都从原 R 实际 succeeded result、完整 catalogue/ref、inputDigest、Store/Session/root-work 与新 Job parent 证明确认发布。Query 先核完整成功事实，再 await 准确 holder 的发布证明；它不凭公共 phase 清票，冷 ready/live=false仍合法。callback保留在 holder 上，后续证明漂移继续拒绝。

ensure已保存原 Job、但 `new_planned` CAS 或 preflight失败且 owned port 尚未打开时，只可由私有 ensure ticket和真实 Job/ref/input/parent 身份返回 unopened supervision handle。observe保存准确 ended/failed及transportStopped，不能把自报 bootstrap、已打开或迟到 handle当作零 port；缺私有绑定保持原拒绝。该 leaf收尾不修改通用 Execution 终态规则。

[reconnection-proof](reconnection-proof.ts)与[query](reconnection-query.ts)把 stage视为索引，独立核实际旧停止、新 Job与完整原结果。`mcp.reconnection@1` input恰 `{executionId}`，closed envelope≤16KiB，actions/artifactRefs为空；oldStop.confirmed、ready、live/currentGeneration独立。历史读取零 Source、Workspace文件、vault、transport、Model、补record或cursor推进。已有 connection Query与metadata publisher只新增准确 R parent/catalogue 分支，普通 C证明不放宽。

[真实 Core 及故障用例](../../test/isolated/mcp/reconnection.test.ts)、[纯协议反例](../../test/isolated/mcp/reconnection-proof.test.ts)、[真实 HTTP Host](../../../../apps/cli/test/isolated/tui-mcp-reconnection-host.test.ts)与[物理丢回执](../../../../apps/cli/test/isolated/tui-mcp-reconnection-recovery.test.ts)分别验证其断言。当前13项受影响原任务并发4全部通过，73例2120断言，3979个regular输入及Git前后保持；真实新Job终态提交屏障先复现父R过早unknown，修后屏障内pending、提交后failed且零新initialize。受控两秒等待超时保原unknown，迟到真实failed不改原R；原ready阶段/最终结果提交故障继续核live与发布隔离。此前545文件/441主任务完整默认属于当时冻结输入，最新第十九轮完整默认仍失败；有限组、源码外整例与whole各有独立范围，准确SHA见总体进度。未提交 Action 的串行门禁故障、直接await原waiter的匹配入口对照、正常关闭和历史红保在总体进度，底层停滞原因未知。上述本机资格不证明持续 Soak、远端停止或三平台。
