# Session namespace Fork 生命周期

宿主可在选中的 `Extension.records` 上显式登记 `RecordDefinition.fork`，闭合为 omit、copy 或带纯 `prepare` 的 rebuild。默认 omit；没有安装/登记精确 contentType/contentVersion 的实现不会运行 rebuild。版本、schema 与函数在 Runtime 构造时捕获并冻结；JSONC、renderer 和普通 Fork 请求不能提交规则、schema 或内部 namespacePlan。实际 Fork 后同 commandId 重试返回原回执，不重新运行当前版本的 prepare。

copy 的语义是受理时已提交的 Session 业务快照，不承诺任意旧消息边界对应的旧业务版本。copy 保原 JSON 文本、content type/version、originStoreId 与合法原引用，不复制 blob 授权或 remap scope。需要按上下文边界选择的业务状态使用 rebuild：输入仅有实际原 Session/目标 Session/selection/upperSeq、当前已提交记录与准确 selected message identities/source IDs；没有 Store、Provider、Tool 或文件端口。输出只能是自有 namespace、当前登记 schema 支持的 key/type/version/value，以及可信规则显式开启的有限只读来源声明。纯函数返回新的派生记录，原记录不改写。

[准备实现](../fork-preparation.ts)在写事务外读取具名有界页、校验当前可信 schema 并运行纯规则。每个读页及最终事务核业务 cursor、同 SQLite 连接可观察的数据版本；最终核全部源 key 集合、revision、raw hash、原 origin/provenance 与准确选择读集。输出 schema 在进入写事务前编译/验证。new Session、复制历史、命令回执和所有业务记录同事务；源/CAS/选择变化、重复输出 key、未知输出 schema 或触发器失败均回滚，不留下半 copy。

回执 `namespaceReport` 列出 namespace/content版本、模式、ruleVersion 和 copied/rebuilt/omitted 数量；`omittedExtensionState` 是布尔值，存在省略时明确 true。没有生命周期规则的旧调用保持默认省略说明。未知/无效记录由规则选择 omit（默认）或 reject；原 raw 内容保留供只读导出。准备页和最终内部计划使用明确 1MiB 安全边界，超过可读取/处理范围不得截断成完整 copy；无法处理的单条原内容按 unsupported 处置，完整原数据仍可通过导出分块读取。此项不宣称无限大小 namespace rebuild 资格。

[SQL 实现](../../storage/sqlite/fork-namespaces.ts)仅新增 extension_record 的 `fork_provenance_json`，不存在另一份执行资格状态。所有 copy/rebuild 记录均带封存的 Fork 命令、边界、规则/当前扩展版本与原记录关联；copy 保旧 origin，rebuild 的 origin 为 null。普通 CAS 只改业务内容/版本，不能清 provenance。计划 operation/child ensure、required 登记、最终 required/read-set/信息接受核实拒绝将这些派生历史用作原可执行义务资格；需要执行的新工作须通过新命令、新 key 创建新实例，不复制 owner、Run/Execution、审批或 grant。

原媒体仍由真实 SQL origin 与现有原 scope reader 独立读取；知道 payload hash/旧 OperationRef 不授新分支权威。读取/Fork/cold 查询不重放 Provider、Tool 或旧业务操作。Rewind 的 pending delivery 与自动续轮隔离不被 lifecycle 规则覆盖；Workspace/profile 外部事实不复制成新 Session 执行。这里不实现 cache GC、恢复、网络安装或另一个循环。

[实际测试](../../../test/isolated/extensions/fork-lifecycle.test.ts)覆盖同 Loop 的源记录、按准确 user 边界 rebuild、copy 原 origin 与不可执行资格、普通 CAS 保 provenance、原 command 重试零 prepare、caller 改注册/schema 仍使用捕获版本、晚源变化/触发器整体 rollback、未来 raw 保留/omit/reject、17MiB 原媒体 scope 与冷只读零 Provider。具体业务扩展是否登记和如何重建仍由该扩展 owner 显式验证，不据此声称全部 namespace 已有生命周期规则。


`rebuild.sourceScope: 'namespace'` 是可信注册的显式选项；默认仍仅传当前 content type/version 组的 `records`。选项开启时额外传入 `namespaceRecords`：由宿主按当前已登记 schema 校验的同 extension 全记录，原 `records` 继续区分正在重建的组。输入递归冻结，没有外 namespace 或 I/O；输出 provenance 的 sourceKeys 固定为这份同 namespace 集合。unknown/invalid 的 omit/reject 沿该规则决定；需要完整快照的规则使用 reject。namespace 输入最多 64 条并沿用 1MiB Fork 准备预算，不能截断成完整快照；此限制只约束显式观察/重建，不是累计 Session 历史配额。

`ReadContext.readForkRecordSources(localKey)` 是当前 Session、当前 extension 的只读观察。宿主只从真实 local record 的封存 provenance、实际 applied Fork command/request/receipt 和同 subject/Workspace 的有限祖先链推导原 keys；不接受 foreign Session、Store、namespace 或任意原 key 参数。返回 binding 固定为 version/localKey/digest，以及真实当前 anchor/祖先记录（含原 Session/origin）；不存在按旧 revision 猜记录的能力。原 source revision/raw hash 漂移立即 unavailable，业务历史快照须由自己的纯 rebuild 保存。当前 selected 完整 Message、原 origin/parts、每层 Fork selection/upper 同时参与 binding，既不以 seq 单独证明分支，也不把 Action/Ask 的非 Message 水位当漂移。null Fork boundary 是真实空历史，upper 为 0。

Host 在自己拥有的 Action prepare/execute、Query 与 context capture callback 完成后关闭这个 observer；准备期观察自动加入私有读集。Model Tool context 不开放该 observer。记录按 extensionId/Session/key 去重，与普通记录共享最多 64 条、32KiB stamp/binding 总预算；单次祖先图、证明及 Message 内容观察共享 1MiB，最多 64 层，Message/part 各最多 8192 项，循环、超限和无法核实均拒绝。只读端口不授予原 Run/Execution/Artifact 全 Session 阅读资格，更不授执行/审批权。

最终 dispatch SQL 根据 original Action decision 中的 binding 独立重建真实 Fork 来源，核 current expected Store、原 subject、当前 anchor、原记录及 Message 证明；遗漏 stamp、来源/provenance/选择/parts 漂移均在 adapter 前拒绝。普通同 Session record/list 语义保持；不开放 foreign namespace 列表。原写入和新 Action 授权仍属于当前 Session。媒体、原执行回执与业务历史快照需要另行精确资格，不能据此宣称整个 checkpoint/Fork 恢复已完成。

[祖先观察实际测试](../../../test/isolated/storage/fork-record-sources.test.ts)覆盖两层与有限深层 Fork、null/0 边界、同 namespace 跨类型重建、foreign subject/namespace、伪 anchor/循环/Workspace/预算否定、prepare 与 query/execute reader 关闭、审批期间来源漂移零效果和最终事务 record/provenance/receipt/Message/selection 漂移。旧 copy/group rebuild 和不可执行派生义务测试继续适用。

完整业务 snapshot/confirmed restore baseline 与开发客户端三种恢复范围已由业务/客户端 owner 接线并取得各自实际窗口资格，边界见[恢复决定](../../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)。该决定补充现有 records 观察，不放宽普通 Session/Execution/Artifact reader，也不继承原 grant；正式发行安装与全 V1.3 资格独立维护。


`rebuild.sourceReads: 'declared'` 显式允许纯输出 `readonlySources`。direct 声明只有 executionId、executionKind 与 artifactRefIds，限定当时实际原 Session 的已知终态 Model/Tool/Job；inherited 声明只有当前同 namespace 的 anchorKey、原 executionId 与封存 ref 的子集。没有 foreign Session/Store/namespace 参数，没有写/执行/审批继承。Model Tool 自动闭包实际 model_decision 的原成功 Model，同 Session/Run/origin/rootWork 必须一致；宿主以现有 typed reader 完整读取实际 Model input/output、校验 Tool call id/name/arguments 与实际 Tool input，再验证每个声明媒体完整 bytes/hash/EOF。声明不能携带 proof/hash 替代实际读取。

Fork 最终 SQL 在原实际 source group 已静止且没有 accepted work 时，独立核原 Execution/Run/Command/assistant Message、Model body metadata、声明 refs 和原 stamps，连同新 Session/记录/回执同事务封存 versioned private proof。不扫描未来 Execution/ref，也不要求 mutable 原 namespace/head 之后仍未变化；inherited 输出不扩已封存范围。若 Fork 等待期间来源变化、unknown/活动工作出现，拒绝整个 Fork。copy 和未 opt-in rebuild 不获得媒体/执行来源观察。

`ReadContext.openForkSourceProjection(localKey)` 仅由当前实际 Session/namespace anchor 开放精确集合。projection 的 storeId 是当前观察 Store，sources 保各自原 Session/originStore/Run/Execution，Tool 的 modelExecutionId 为实际自动绑定。getExecution/getRun 只读精确声明集合；readModelInput/output 沿原 full reader，完整 bodyHash 与封存 proof 一致；artifacts.read 只允许精确已声明 refs，读取结束后再核原 anchor/来源并校验完整 bytes/hash。普通 getExecution/getRun/artifacts 范围保持。Query 返回这些准确 refs 时 Host 再核原 projection proof，不能把任意 foreign ref 混入。

aliases 按当前完整 selected Message 与每层真实 applied Fork receipt/selection/upper 重建，列出当前及所有真实中间祖先 ID/seq，不以 sourceIds 或 seq 单独推来源。getMessage(messageId) 只返回这些 exact alias 的原完整 Message 与新增有限 ordered parts（ordinal/kind/contentVersion/revision/value）；不是 foreign Session 列表。parts 上限 8192、完整返回 1MiB；无法完整返回则拒绝。全部原 Message/parts 摘要进入 binding。合法 User commandId 可与 Model executionId 相同，只有 actual assistant+Model 关系形成 Model 证明。未选中 Tool 的 readonly 后像证据不使它的 trigger 变为可选节点。

当前namespace仍须为未删除root。准确历史祖先允许已tombstone但未清理的root，仍核原creator／subject／Workspace／receipt／selection和全部sealed stamps；来源删除不扩大一般reader或执行许可，来源已清理则拒绝。离线GC保留存活Fork依赖的整条来源链，合同见[维护owner](../../maintenance/README.md#显式无引用附件-gc)。

projection 与 live observer 同 callback lifetime；闭合后及 inflight 晚回都不能交付来源值。Action prepare 自动收集三字段 forkSourceBindings，与旧 observer 共用最多 64 bindings、32KiB record/stamp/binding 预算；原 records 独立保最多 64。final owned dispatch SQL 重建 current anchor、完整 aliases 与 sealed immutable source proof，Ask 不刷新旧摘要。该 proof 不把信息阅读变为文件写、恢复、grant 或原义务的执行资格。1MiB graph/proof、最多 64 sources/refs 声明、8192 stamps 与 64 层祖先保持 failclosed，不截断。

[sealed source 实际测试](../../../test/isolated/storage/fork-readonly-sources.test.ts)验证两层 Fork、null/0 后像 evidence、Tool 自动 Model/full reader、原 head 后变不扩大读取、精确媒体子集/EOF、subject/namespace/伪 anchor、legal User ID 碰撞、callback/inflight 关闭、真实 Ask 正例与 drift、最终 SQL 的 Execution/Model/ref/anchor 变化零效果，以及 accepted/unknown group 与声明预算拒绝、sealed inherited 来源和当前新 Model 的混合封存。它证明通用只读来源合同，完整 Files checkpoint/Fork 产品链不在此测试范围。
