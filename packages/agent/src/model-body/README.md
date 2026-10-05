# Model 完整正文交接

Core 的 `ToolResult.modelContent` 是 `{kind:'artifact',reference,encoding:'utf-8'}`。公开 reference 只表示准确原 scope 的产物，不授予 hash/path 读取权。Tool、Action、Job 返回时都核对真实引用；读取选中 Tool 历史或纳入的后台结果时，Runtime 从原 Execution/Command 派生 Store、Session 与 subject，核对 metadata，再完整读取、严格 UTF-8 解码与核 hash。Provider 同时收到原结果 metadata/summary 与完整正文，Files baseline/selection 不因展开正文丢失；不把摘要或引用当成已读内容。来源 ID、选定上下文和原调用关系保持。背景正文仍明确作为低信任 user 数据，不增加权限。传输、短事务与实际审核 proof 的取舍见[完整正文决定](../../../../.agents/notes/implemented/architecture/2026-10-01-immutable-model-body-and-review-proof.md)。

大 Model 请求、决策来源与 Auto 请求使用版本 1 的中立 `ModelBodyReference`。64 KiB 是转为不可变 Artifact 的传输阈值，不是拒绝、截断或累计预算；完整 canonical JSON 保存在原 Session scope，ref ID 包含完整 hash，Model requestId/modelId 和实际 tools identity 留在有限持久 header。原始完整 sources/sourceIds 位于正文，header 保留必要来源 id/digest 与工具装配身份。每次实际 Provider I/O 前完整核 scope、metadata、字节大小、SHA256、严格 UTF-8、请求身份和工具身份并展开；读取取消、缺失能力、损坏或错误 scope 会阻止 Provider。成功 Model 回执另存实际 `result.modelInputBodyHash`，冷重开准确读取原 scope，不重新标 Store 或重放旧意图。

Worker 的控制/正文队列仍为原有限容量，没有移除或提高额度。`storage/sqlite/model-body.ts` 在短事务里只核已登记 blob_ref/hash/size/MIME/原主体与 scope；不进行正文文件读取或 JSON 语义解析。完整验证在 Core 的 Artifact I/O 端口进行。Artifact 登记的完整字节验证在登记事务之前，事务再核原 Store/scope 与 metadata；这段已有 Worker 同步验证仍可能推迟控制调度，本切片不宣称大文件时的控制延迟资格。便利 JSON/字符串展开受真实内存与平台表示能力影响。

Auto 专用 child 仍复用唯一 Loop、共享 Model 槽，工具和额外来源为空，最多一个实际 Model 调用。审核正文从实际原命令、根工作、目标输入/来源和同组成功 Model 的完整请求派生；这些大字段经准确 scope Artifact 交接，不再使用旧 900 KiB 拒绝。Core 从实际 carrier 封存审核绑定 digest，完整展开后才保存 reviewer 的 Model body 并调用 Provider；SQL 最终核对该绑定、实际输入 hash、唯一成功 Model、completed child、succeeded carrier 和闭合输出，Model 文本不能自报 proof。policy/review request/source 的变化与冷 carrier 不重跑规则保持。

大 Auto 请求需人工回退时，真实卡片在有限 request 中保存完整原请求的公共 Artifact 附件引用；不公开 subject/owner。它不是摘要批准，也不声称所有客户端已经提供完整附件展示；UI 的正文加载资格由对应 owner 单独验证。引用只携带完整请求，最终许可仍绑定准确 Execution/attempt/定义/input digest/来源/policy revision。

[真实 Core 回归](../../test/isolated/model-body/model-body.test.ts)验证至少 17 MiB 的 Tool 正文、来源与 Auto 请求完整到达固定 Model、单槽/单子任务限制不死锁、持久小引用与冷重开、损坏/跨 scope/取消零后续 Provider，以及真实人工卡片回退。[Files 大正文](../../test/isolated/files/large.test.ts)验证普通 Files Artifact 进入下一实际 Model 请求。本地证据为 macOS；外部付费 Provider 窗口、客户端附件展示与其他平台资格不由这些测试证明；巨量 Model 输出持久化由[完整输出链](../model-output/README.md)及其独立实际回归负责。

## 原调用输入只读 Inspector

`Runtime.readModelInput` 绑定 expectedStoreId、sessionId、executionId 与宿主主体。Store 在一致读事务核对准确 Model/Run/原 Command/rootWork/root group；child 请求必须属于原 child Session 和实际 carrier，不使用当前 selection 或 renderer 提交的 hash/ref/path。Runtime 从已保存 input 展开原请求，完整核 Artifact metadata、全文 size/hash、严格 UTF-8/JSON 与 modelId/requestId/tools 身份，成功的大正文还复核原 modelInputBodyHash。公开 Snapshot 保留准确调用身份、完整 request 和正文 digest/Decimal64 bytes；不公开 owner、主体、私有 Artifact 引用、Provider endpoint 或原始响应。未记录的请求设置不可从当前配置补齐。

`confirmation=succeeded` 只表示真实成功 Model 回执；其他状态为 unconfirmed，planned/dispatching 并不证明 Provider 已看到请求。Inspector 仍可解释这些持久准备请求，不把它们标作已确认的实际调用。读取不 capture sources、不初始化 Provider、不取得 owner、不写入或恢复执行；readonly/cold Store 可查原历史。便利全文读取没有 8 MiB 或新的总正文限额，受真实内存/平台表示能力影响；损坏、缺失、格式变化或取消均不返回成功 Snapshot，也不拿前缀/当前 context 代替全文。

`Runtime.listModelInputs` 返回 max 200 的有限目录，不内联请求/Artifact 引用。目录以正 execution rowid 的 Decimal64 seq 排序，首次上界固定到 highWaterSeq；后续页面使用同 upperSeq 与 nextAfterSeq。highWaterSeq/snapshotCursor 表示该次读取观察水位，后续新调用不会进入既有固定范围。目录不是 owner 或自动执行入口；状态可以变化，原请求身份不可重绑定。明确的[只读 Store 边界](../storage/sqlite/model-input/README.md)与[回归证据](../../test/isolated/model-input/README.md)覆盖原输入不随 steer/来源变化、完整大正文、权限和分页。


## 每次调用的封存元数据

[Model 元数据](../model-snapshot.ts)在该次 Model Execution 规划前捕获实际 Adapter 的纯描述、准确 Extension/Tool 版本和 namespace、装配摘要与来源 ID/digest。消息、来源顺序和完整 Schema 引用这次不可变原请求，不重复拷贝正文。超过 64 KiB 的静态元数据使用同原 scope 的完整 Artifact，SQL 保存有限 header；这不是拒绝或截断阈值。读取在事务外完整核 scope/hash/size/UTF-8/JSON，冷只读展开原数据，不 capture 新来源或启动 Provider。

实际 settings 还可保存有限 `reasoningEffort`，由 AI 中立类型和 Core 闭合校验共同核实；它来自原绑定，不能从现在配置推断，传输编码范围不等于远端模型支持事实。

最终派发事务另封存实际 authorization revision、definitionVersion、inputDigest 与 controlReads。可选 policy 解释是中立 `{namespace,version,data}`，默认 Service 只给闭合非秘密的 mode/trust/该次真实 capability；它不替代权限判定，也不是凭据或完整 Run 配置。外部 opaque policy 解释不可用，但实际派发事实仍保留。未派发显示 `not_dispatched`；未记录或未来版本静态 metadata 显示不可用，不能用当前配置回填。planned metadata 仅证明已准备，不证明 Provider 已接收。

[真实元数据回归](../../test/isolated/model-snapshot/metadata.test.ts)使用 SQLite Worker、实际 SDK Adapter 和注入固定传输，核对 17 MiB 请求完整到达、同 Run 两次实际调用各自 policy/settings、实际 namespace/source、child 的 parent/child 原策略交集、冷 readonly、大元数据完整展开与损坏/取消拒绝；不连接外部付费 Provider，不证明巨量 Model 输出持久化资格。


Model 输出以[原 Execution scope 的不可变段链](../model-output/README.md)保存完整 text/reasoning/ToolCall；消息保留稳定身份并只在真实完整终态原位结算。它与 Model 输入 Body 的来源、完整 EOF/hash 验证一致，不把 preview 或 descriptor 当成完整正文。

恢复生成新 Store 后，历史读取使用当前连接准入，正文 metadata 和原 Execution/Command 链仍使用封存出处；原引用不会被重新标为当前 Store。新 Run 只从明确选定的原历史/Fork/压缩点完整展开正文，不重新执行旧 Model 或工具。[实际恢复测试](../../test/isolated/restored-media/read.test.ts)核全文、原引用、冷 readonly、拼接出处拒绝与新 Run 实际输入。执行和发布仍必须属于当前 Store。

普通人工审批也使用[Interaction owner 的完整正文路径](../storage/sqlite/interactions/README.md)：可信 sealer 将超出有限卡预算的原展示请求完整发布在准确 Execution scope，原卡只保存公开完整附件和正文摘要。private verifier 在接纳与最终授权前复核原登记、完整 hash/size/严格 UTF-8/JSON、实际 input/定义及当前人工 policy；它不把附件读取或人类答案当作 Tool 授权。原 Execution 输入仍完整保存，卡和 Worker 的有限传输预算保持。客户端沿已有完整附件协议读取，不从 renderer 的预览重建原请求；[实际大人工卡回归](../../test/isolated/execution/approval-body.test.ts)分别证明全文与零效果拒绝路径。
