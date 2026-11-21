# Model 完整正文交接

## 工具视觉结果

`files.view_images@1` 复用同一合同，准确版本的单个结果最多10张、每张8MiB、整批16MiB，数组顺序对应原请求；其他工具仍最多4张／16MiB。执行接纳和历史展开共用[视觉引用校验](../tool-images.ts)。所选本地图的 32 MiB 是单帧原 PNG 预算，而不是整个会话的历史上限。普通请求只携尚未确认的完整工具组；单工具多图也可按序位在独立只读 Model Execution 中分组观察，不拆原工具回执，不重复文件调用。成功业务响应或完整、无工具的独立观察才提交覆盖；规划、派发、413、断连和不完整观察均不记成功。重复像素保留各自来源及序位，跨源观察的笔记只有全部来源均可见时才能使用；笔记不是授权或精确识别保证。历史明细可重新选择原归档序位。用户附件、PDF 和浏览器沿各自原合同。[Runtime 与 SQLite 预算回归](../../test/isolated/artifacts/tool-image-budget.test.ts)和[单图探测回归](../../test/isolated/artifacts/image-replan.test.ts)分别覆盖整链交付与自适应边界。

供应商明确 HTTP 413 时仅在同次 Run／路由中有限重排；推算预算不是单图硬限。富业务请求单图被拒时允许单独观察一次，紧凑单图仍被明确拒绝则停止，不裁缩替换原图。网络未确认不作为 413，也不自动对此图像请求重发。所有工具决策、普通消息和成功覆盖仍由原 Store/Execution 保存。热重选、派发前与收据提交前复核主体、选择、路由与原来源；SQLite 能验证的持久控制在成功事务内再验，不承诺撤回已传给远端的内容。根会话当前 Run 已生效且在本次正式请求中仍可见的最新文字更正，与初始任务一起以有界引用交给新建观察；不从角色名猜测授权，不附带邮件、背景结果或摘要，也不改写已封存的观察请求。观察输出的私有段链头只保存在原模型执行上，不创建聊天消息；即使 SDK 返回不透明 continuation，普通输出链与观察回执仍能同时验证。未派发观察的[真实 SIGKILL 回归](../../test/isolated/recovery/image-observer-cold.test.ts)验证同一请求恢复一次且不占业务最终答复。详细取舍见[图片分帧决定](../../../../.agents/notes/implemented/architecture/2026-11-18-image-delivery-windows.md)。

macOS 原生桌面、隔离 Profile 与正式配对 Service，在 2026-11-18 用合成九图（37,201,483 B）、已配置的 OpenAI Responses 模型完成了两种调度。自然顺序读取的单 Run 完成，模型主动复看三次，成功帧共 18 图次、128,592 个成功模型调用所报告的 tokens。另一次自然同轮并行在官方 413 后不重做原工具，四个只读观察按 3+3+2+1 接收九个成功图次；原同一批第三组确实拆为 2+1，另 6 个被拒图次不计确收；72.1 秒、43,071 个成功调用所报告的 tokens。移除合成源路径后，后续问题仅复看原指定序位。两组的模型决策和输入不同，不能把一次费用差异当通用节省比例。首次并行曾因短观察携带供应商 continuation 而在本地结算冲突，HTTP 200 没被算作已见；[私有观察输出链回归](../../test/isolated/artifacts/tool-image-budget.test.ts)与修正后的新 Run 分别验证该问题。以上不是其他供应商、系统或安装包的发布资格，也不是视觉语义准确率承诺。

`ToolResult.modelImages` 只声明本次结果已列入 `artifactRefs` 的有限 PNG 引用，完整合同由 [tool-images](../tool-images.ts)校验。Runtime 只从准确原 succeeded Tool Execution、完成消息及一致 Run／出处展开图片，保留原调用与结果配对；Fork 和恢复按原来源读取。实际完整图像字节进入中立 ModelInput 的 tool 消息，AI 的 Responses／Chat Completions 编码见 [AI owner](../../../ai/README.md)。图片是低信任工具数据，不产生人类消息、命令或审批。PDF 缓存不是历史图片来源；损坏、引用不符或取消会阻止该 Model 请求。Native 预览沿同一原消息／执行读取，不能由 renderer 自报任意 Artifact。

Core 的 `ToolResult.modelContent` 是 `{kind:'artifact',reference,encoding:'utf-8'}`。公开 reference 只表示准确原 scope 的产物，不授予 hash/path 读取权。Tool、Action、Job 返回时都核对真实引用；读取选中 Tool 历史或纳入的后台结果时，Runtime 从原 Execution/Command 派生 Store、Session 与 subject，核对 metadata，再完整读取、严格 UTF-8 解码与核 hash。Provider 同时收到原结果 metadata/summary 与完整正文，Files baseline/selection 不因展开正文丢失；不把摘要或引用当成已读内容。来源 ID、选定上下文和原调用关系保持。背景正文仍明确作为低信任 user 数据，不增加权限。传输、短事务与实际审核 proof 的取舍见[完整正文决定](../../../../.agents/notes/implemented/architecture/2026-10-01-immutable-model-body-and-review-proof.md)。

完整正文读取优先使用[Artifact owner](../artifacts/README.md)的可选 `readReference` 端口，一次实时 scope 查询同时核完整原引用并完整验证文件。Runtime 仍独立复核 bytes 的 size/hash 和读取前后取消；[完整语义摘要](digest.ts)同样逐64KiB处理，在8ms或64块后让出真实事件循环，避免文件读取完成后的二次整块hash再阻塞宿主。取消沿同一原signal检查，完整摘要和原metadata相等后才展开；没有新入口的自定义端口保留原 metadata 查询及 `read` 回退。逐段引用、恢复后的原出处与当前连接准入保持，不跨调用缓存验证结果。

大 Model 请求、决策来源与 Auto 请求使用版本 1 的中立 `ModelBodyReference`。64 KiB 是转为不可变 Artifact 的传输阈值，不是拒绝、截断或累计预算；完整 canonical JSON 保存在原 Session scope，新 ref ID 由原 Store／Session／subject／scope 和完整正文 hash 共同派生；同 scope 同字节保持幂等，不同 scope 共享 Blob 但不共用引用。私有与公开前缀保留，引用自身保存完整 hash，旧 ref 不重命名且仍按原 scope 读取。Model requestId/modelId 和实际 tools identity 留在有限持久 header。原始完整 sources/sourceIds 位于正文，header 保留必要来源 id/digest 与工具装配身份。每次实际 Provider I/O 前完整核 scope、metadata、字节大小、SHA256、严格 UTF-8、请求身份和工具身份并展开；读取取消、缺失能力、损坏或错误 scope 会阻止 Provider。成功 Model 回执另存实际 `result.modelInputBodyHash`，冷重开准确读取原 scope，不重新标 Store 或重放旧意图。

Worker 的控制/正文队列仍为原有限容量，没有移除或提高额度。`storage/sqlite/model-body.ts` 在短事务里只核已登记 blob_ref/hash/size/MIME/原主体与 scope；不进行正文文件读取或 JSON 语义解析。完整验证在 Core 的 Artifact I/O 端口进行。Artifact 登记的完整字节验证在登记事务之前按原请求分片回队，正文／查询类别可在完整校验间继续，最终事务再核原 Store/scope 与 metadata；原类别FIFO、容量和close barrier保持，不能据此承诺控制请求跨过先前登记。具体完整证明与等待后文件守卫归[Artifact owner](../artifacts/README.md)。便利 JSON/字符串展开受真实内存与平台表示能力影响。

Auto 由权限系统的 `authorization.check` 直接执行一次无工具 Model，共享 Model 槽，原 Session 内保存无 Run Execution，不创建 child Session、Run、carrier 或聊天消息。检查正文仍从实际原命令、根工作、目标输入/来源和同组成功 Model 的完整请求派生；`decisionContext.messages` 只保留中立语义字段。原内联或 Artifact 请求完整验证，语义投影不改写原载体、hash 或绑定证明。Core 完整展开请求，SQL 保存原 payload binding 和准确 prepared-input digest，Provider 前再次核实际输入与封存请求 hash；实际 input body hash、完成结果独立 digest、空工具和完整输出共同参与最终授权。准备失败也结算原检查，不留 planned 孤儿。policy/check request/source 变化及旧冷记录不重跑保持。

通用 policy check 的大请求沿既有 `requestBody` Artifact 封存与读取，建立检查和后续原引用核验不再内联巨正文跨 Store RPC；审核器仍收到完整原请求。批准复用预查询只投影其实际需要的判别材料：Shell 风险请求保留原值，其他请求正文留给原检查，不随缓存查询重复发送。原 operationKey、snapshot、来源、checker、权限与控制证明继续完整核对，准备仍消耗原审核期限；不扩大队列、不截断正文，也不以缓存查询代替审核。

大 Auto 请求回退人工时，真实卡片以 `policy.check` 保存完整原请求的公共 Artifact 引用；新引用使用 `authorization-check-request-`，与私有 `model-body-` 分开。原请求、Execution/attempt/input/source/policy 绑定与真实人工答案仍独立复核，不公开 owner、subject 或私有 Model head。不读取旧 child 审核回执或旧 `policy.review` 授权映射；只有当前检查的准确原 Interaction 与完整 proof 可以开放原公开请求附件。猜 hash、改卡引用或重算卡摘要不能读取私有输入。完整附件读取资格仍按对应客户端实际验证。

[真实 Core 回归](../../test/isolated/model-body/model-body.test.ts)验证至少 17 MiB 的 Tool 正文、来源与 Auto 请求完整到达固定 Model、单槽/单子任务限制不死锁、持久小引用与冷重开、损坏/跨 scope/取消零后续 Provider，以及真实人工卡片回退。[Files 大正文](../../test/isolated/files/large.test.ts)验证普通 Files Artifact 进入下一实际 Model 请求。本地证据为 macOS；外部付费 Provider 窗口、客户端附件展示与其他平台资格不由这些测试证明；巨量 Model 输出持久化由[完整输出链](../model-output/README.md)及其独立实际回归负责。

## 原调用输入只读 Inspector

`Runtime.readModelInput` 绑定 expectedStoreId、sessionId、executionId 与宿主主体。Store 在一致读事务核对准确 Model／原 Command／rootWork／root group；普通调用继续核原 Run，child 请求必须属于原 child Session 和实际 carrier。`authorization.check` 与 `session.title` 仅凭准确用途、真实父目标和封存输入证明允许 `runId:null`，不为任意 runless Model 开放读取，也不补造 Run 或 Message；读取不使用当前 selection 或 renderer 提交的 hash/ref/path。Runtime 从已保存 input 展开原请求，完整核 Artifact metadata、全文 size/hash、严格 UTF-8/JSON 与 modelId/requestId/tools 身份，成功的大正文还复核原 modelInputBodyHash。公开 Snapshot 保留准确调用身份、可见 request 和该公开正文的 digest/Decimal64 bytes；Adapter 的 opaque continuation 仅供私有历史和恢复重放，公开 request 明确省略该字段并重新计算 digest/bytes，原完整请求的回执校验仍在私有展开路径完成。新检查没有 Message／Run，其公开 Model input 只按已认证的 `authorizationCheck` 用途和准确 sourceIds 投影；普通用户同形 JSON 不被改写，内部标记不进入公共 DTO。旧 child 审核 Message／Run 不再具有特殊识别、语义投影或 proof 读取路径。原 modelInput Artifact 描述不授予下载权，真实 HTTP 对父/审核 Session 请求均拒绝 scope 不符的私有正文。不公开 owner、主体、私有 Artifact 引用、Provider endpoint 或原始响应。未记录的请求设置不可从当前配置补齐。

`confirmation=succeeded` 只表示真实成功 Model 回执；其他状态为 unconfirmed，planned/dispatching 并不证明 Provider 已看到请求。Inspector 可解释已封存的持久准备请求，不把它们标作已确认的实际调用；尚未封存的权限检查只列 planned／unconfirmed 目录身份，正文读取拒绝。读取不 capture sources、不初始化 Provider、不取得 owner、不写入或恢复执行；readonly/cold Store 可查原历史。便利全文读取没有 8 MiB 或新的总正文限额，受真实内存/平台表示能力影响；损坏、缺失、格式变化或取消均不返回成功 Snapshot，也不拿前缀/当前 context 代替全文。

`Runtime.listModelInputs` 返回 max 200 的有限目录，不内联请求/Artifact 引用。目录以正 execution rowid 的 Decimal64 seq 排序，首次上界固定到 highWaterSeq；后续页面使用同 upperSeq 与 nextAfterSeq。highWaterSeq/snapshotCursor 表示该次读取观察水位，后续新调用不会进入既有固定范围。未封存检查也保留其原 seq，不能因暂不具备正文而过滤并跳过分页水位；prepare 后沿同一 upperSeq 仍能读到原项，见[准备窗口回归](../../test/isolated/model-input/authorization-check-window.test.ts)。目录不是 owner 或自动执行入口；状态可以变化，原请求身份不可重绑定。明确的[只读 Store 边界](../storage/sqlite/model-input/README.md)与[回归证据](../../test/isolated/model-input/README.md)覆盖原输入不随 steer/来源变化、完整大正文、权限和分页。


## 每次调用的封存元数据

[Model 元数据](../model-snapshot.ts)在该次 Model Execution 规划前捕获实际 Adapter 的纯描述、准确 Extension/Tool 版本和 namespace、装配摘要与来源 ID/digest。消息、来源顺序和完整 Schema 引用这次不可变原请求，不重复拷贝正文。超过 64 KiB 的静态元数据使用同原 scope 的完整 Artifact，SQL 保存有限 header；这不是拒绝或截断阈值。读取在事务外完整核 scope/hash/size/UTF-8/JSON，冷只读展开原数据，不 capture 新来源或启动 Provider。

原请求已转为 Artifact 时，小静态 metadata 也沿同一版本 1 `body` 外壳保存；Core 在转引用前从原实际请求／Adapter 描述生成可选闭合 `display`，仅保存有界实际模型名、固定操作／标题及 system／对话／工具目录计数。SQLite 的第一方轨迹索引复用这个有限摘要，不预读正文、不复制提示词或 Schema。metadata 大正文和请求正文仍各自完整验证；typed reader 丢弃外壳摘要并返回原公开材料，旧无 `display` 外壳保持可读，新增自由字段明确拒绝。没有协议版本或权限变更，第三方 Trace 不外发该第一方摘要。具体字段与[真实大正文 writer 证据](../../test/isolated/storage/trajectory-display-flow.test.ts)归[轨迹 owner](../trajectory/README.md)。

实际 settings 还可保存有限 `reasoningEffort`，由 AI 中立类型和 Core 闭合校验共同核实；它来自原绑定，不能从现在配置推断，传输编码范围不等于远端模型支持事实。

最终派发事务另封存实际 authorization revision、definitionVersion、inputDigest 与 controlReads。可选 policy 解释是中立 `{namespace,version,data}`，默认 Service 只给闭合非秘密的 mode/trust/该次真实 capability；它不替代权限判定，也不是凭据或完整 Run 配置。外部 opaque policy 解释不可用，但实际派发事实仍保留。未派发显示 `not_dispatched`；未记录或未来版本静态 metadata 显示不可用，不能用当前配置回填。planned metadata 仅证明已准备，不证明 Provider 已接收。

[真实元数据回归](../../test/isolated/model-snapshot/metadata.test.ts)使用 SQLite Worker、实际 SDK Adapter 和注入固定传输，核对 17 MiB 请求完整到达、同 Run 两次实际调用各自 policy/settings、实际 namespace/source、child 的 parent/child 原策略交集、冷 readonly、大元数据完整展开与损坏/取消拒绝；不连接外部付费 Provider，不证明巨量 Model 输出持久化资格。

2026-11-09，macOS arm64／Bun 1.4.4，`e8a483d65` 加当前工作树：上述元数据整文件与原[检查准备窗口](../../test/isolated/model-input/authorization-check-window.test.ts)合跑 6 项／56 断言通过。17 MiB 请求的小 metadata 已沿新有限外壳保存，测试从实际 Runtime typed reader 展开后继续核原 SDK settings、policy 与私有字段过滤，不把持久引用外壳直接交给内联 metadata 解析器。展示外壳与原 Inspector 的另外 13 项／176 断言记录在[轨迹 owner](../trajectory/README.md)。


Model 输出以[原 Execution scope 的不可变段链](../model-output/README.md)保存完整 text/reasoning/ToolCall；普通会话消息保留稳定身份并只在真实完整终态原位结算。内部检查与标题 Model 不写聊天 Message，改由准确用途、封存输入和完成结果 digest 核其完整传输；小内联原正文与大输出 descriptor 的 scope／登记／完整性证明分别保留，决定是否有效不妨碍只读观察真实原输出。它与 Model 输入 Body 的来源、完整 EOF/hash 验证一致，不把 preview 或 descriptor 当成完整正文。

恢复生成新 Store 后，历史读取使用当前连接准入，正文 metadata 和原 Execution/Command 链仍使用封存出处；原引用不会被重新标为当前 Store。新 Run 只从明确选定的原历史/Fork/压缩点完整展开正文，不重新执行旧 Model 或工具。[实际恢复测试](../../test/isolated/restored-media/read.test.ts)核全文、原引用、冷 readonly、拼接出处拒绝与新 Run 实际输入。执行和发布仍必须属于当前 Store。

普通人工审批也使用[Interaction owner 的完整正文路径](../storage/sqlite/interactions/README.md)：可信 sealer 将超出有限卡预算的原展示请求完整发布在准确 Execution scope，原卡只保存公开完整附件和正文摘要。private verifier 在接纳与最终授权前复核原登记、完整 hash/size/严格 UTF-8/JSON、实际 input/定义及当前人工 policy；它不把附件读取或人类答案当作 Tool 授权。原 Execution 输入仍完整保存，卡和 Worker 的有限传输预算保持。客户端沿已有完整附件协议读取，不从 renderer 的预览重建原请求；[实际大人工卡回归](../../test/isolated/execution/approval-body.test.ts)分别证明全文与零效果拒绝路径。

[审核私有状态回归](../../test/isolated/execution/authorization-check-continuation.test.ts)覆盖内联与 Artifact 原输入、投影后大小跨阈值、连续两次审核、原绑定篡改拒绝及冷 Inspector 的私有数据过滤；[Service 历史回归](../../../../apps/service/test/isolated/authorization-review-history.test.ts)实查新版原会话 messages/view/context/Inspector、后台目录、Auto 完整附件的真实 HTTP 下载与私有 Artifact scope 门禁。原格式 1 producer 的 pending 卡与私有绑定保存在真实 SIGKILL 后捕获的冻结 profile，现仅用于核只读／读写打开和 preflight 均明确拒绝且全部原文件字节不变，不恢复旧 reader 或执行路径。测试使用真实 Runtime／SQLite／Artifact 和固定适配器，不代表跨账户真实远端请求已验。

[跨会话正文回归](../../test/isolated/model-body/body-scope.test.ts)以真实 Runtime／SQLite 核相同小审核元数据及大公开请求在同会话重复、跨会话串行和并发时独立封存；旧引用可读、跨 scope 读取仍拒绝、同引用改字节仍冲突。修复只隔离引用身份，不改变 Blob 去重、审批、取消、派发或历史恢复资格。
