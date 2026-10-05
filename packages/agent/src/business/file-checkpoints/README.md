# Files mutation checkpoint business leaf

`@kite-ai/agent/files` 的 `createFileCheckpointing` 显式选择原 Workspace、有限 `maxBytes`、可信 `protectedPaths` 和三个可信读取 callback，创建 `builtin.files@1` Extension，保留原六个 `files.*` Tool IDs/version。它替换同一装配里的旧 Files Extension，不能重复注册同名 namespace/Tool 或在冷恢复中替换原 manifest 实现。普通 `createFileTools(files)` 未注入 capture 时行为保持。

当前实现包括 Files capture、完整 Artifact、原 namespace records、只读列表/详情/预览、独立 code-only restore Action与跨 Fork 的封存业务时间线。默认 Service 和 Web只读消费者已有实际资格；CLI/TUI/Native 开发路径已有三种范围的持久两步骤 caller 和各自真实窗口；正式入口与完整 Native 发行安装继续按对应 owner 核验。code-only不修改 context selection、不发 Model或Shell，不引入Git broker或整个目录snapshot。

## 注册与可信捕获

显式 factory 持有原 Workspace FD，`close()` 结束其生命周期。`createScopedFileCheckpointing(resolve,{includeTools?})` 是零 I/O 的纯注册 helper，默认仅注册同一 records/Actions/Queries；`includeTools:true` 同时注册原六 Tools。全部 descriptor 复用实际 factory/原 `createFileTools` 的 schema、resources、IDs/version，无 dummy Workspace。每次 Tool execute、Action prepare/execute、query 实际调用可信 resolver 创建原 scope factory，并在 finally 关闭。宿主只注册一次 `builtin.files`；per-Run Assembly 不再重复注册它。resolver 失败封闭拒绝，关闭失败不回退其他 factory。

`readBoundary(actualToolContext,actualPublicExecution)` 返回 `{boundary,modelExecutionId,modelInputHash}`。boundary 保存实际 Store/W/S/Run 和原 Run 的不可变 selection，live 捕获还须与当前 Session selection 相同；`triggerMessageId/triggerSeq` 是本次 Model 实际消费的最后 User 输入，其之前完整恢复边界为 `messageId/messageSeq`，首次输入之前为 null/0。宿主从原 Tool 的真实 Model decisionSource、成功 Model 的完整 sealed input 和准确来源映射取得这些事实。Model input、JSONC、known IDs/hash、有限 view 不替代证明；缺 callback 拒绝 capture，零文件修改。point ID 只哈希 boundary，不含某一次 Model proof，避免同一输入的连续 Model 创建多个首 preimage 窗口。

leaf 再核原 Tool 的 Session/Run/Store、`files.write|files.edit@2`、attempt/inputDigest 与活跃原 Run。dispatching/running 可捕获，planned 不可。每个 first/last/pending Source 保存实际 Tool/Run/definition/version/attempt/inputDigest 和原 Model ID/full input hash。context signal 和 namespace writer 继续核 owner/祖先，不扩大权限。

capture 注入时 write/edit 声明 Workspace serial key `files.mutation`，宿主必须装配现有 public Workspace OS-lock backend；缺失明确 workspace_resource_lock_unavailable。锁覆盖捕获→mutation→封存，不锁任意外部 editor。普通未注入 Tools 不新增资源声明。可信 protectedPaths 使用 Files 原语的闭合相对路径组件 prefix，不由 Model/JSONC/HTTP提供。

宿主另可传 `protectReads:true`，使普通 read/list/search/glob 与所有 mutation 共享准确 protected scope。默认 Service 用 canonical profile/协调路径和真实 loader 选择开启它，纯 metadata 注册不读取 Runtime 或打开 Files FD。可信 scope 每次独立解析当前原 Workspace 并在完成或错误时关闭；不以猜测的 runtime 父目录误封任意 custom bundle 旁的整个项目。

## 原字节和 journal

immutable `checkpoint/<id>/point` 保存原 boundary 与物理 root device/inode；path record `checkpoint/<id>/file/<pathsha>` 保存 confirmed first、confirmed last 和 pending candidate。before 完整检查 baseline，将 existing file 原始 bytes 通过原 Tool execution-scoped publisher 保存为 immutable `application/octet-stream` Artifact；create-only 原 baseline/Artifact 为 null。candidate 持久 pending 后才修改文件，真实发布且 after 封存成功后才提升 first/last。失败首次 attempt 不冒 confirmed preimage，pending/crash/unknown 不冒可恢复。

完整 binary/BOM/CRLF bytes/hash/size 保留，普通 Files Tool 仍按原 UTF-8 修改合同执行。没有截断或用 preview 代替正文。只捕获接入的 Files write/edit；Shell 和外部改动不宣称归档。

mutable head 在 journal 前置 pending，成功 idle，未知保留 unknown/pending。所有写采用原 expectedRevision CAS；readPoint 在完整 path 分页前后核 head revision/value，漂移返回 checkpoint_refresh_required。不是跨记录单事务，任何中间封存失败保不可恢复事实。文件已发布后的 capture/seal/CAS failure 使用 file_publish_outcome_unknown/Tool outcome_unknown，不能说无效果 failed。

## 选定分支与只读接口

`readSelectedLineage(ReadContext,point)` 返回实际固定 selection/upper 的完整当前 selected Message `{id,seq}` 集合和当前观察 Store/W/S；当前 Store 必须匹配实际 execution-group observation。宿主负责完整双分页，不从 seq 或 previousSelectionId 猜分支。每个 checkpoint、Tool、Model、Command 和 Artifact 保留各自原 Store，不因 profile restore 重标；当前 Store 的合法 reader 可核原来源，新恢复仍是当前 Store 的独立 Action。`verifyCaptureSource(ReadContext,point,source)` 核原 Tool/Model 绑定、sealed body hash、完整原 trigger/source 和 point scope。缺任一 callback 或 actual group observer，preview unavailable，恢复拒绝。

目标 point 的 trigger/before必须准确映射为当前完整 selected Messages；跨 Fork由当前实际anchor的所有祖先aliases映射，不凭相同seq或最深origin猜身份。恢复证据另保留目标之后的完整capture/restore事件，包括未选中后序Tool的真实postimage，不能把证据可读当成该point可选。同路径按原first/last及实际confirmed restore postbaseline严格衔接，物理root、原Run/Session/Store/definition/Model输入与准确Artifact均独立核验。完整scoped records.list/get和projection自动登记最终SQL读集。

[纯 Files rebuild](fork.ts)保存有限原point/head/file与恢复journal/effect metadata，并声明准确原Tool/自动Model及恢复Job媒体。当前namespace wrapper不重标嵌入的原point身份；inherited只转交已封存subset。`openForkSourceProjection`读取原来源，普通foreign Execution/Artifact reader保持拒绝。原source head后变不会污染历史snapshot，未声明future refs/effects不进入当前权限。规则、预算和通用封存见[Fork owner](../../extensions/fork/README.md)。

factory helper 均要求 actual scoped ReadContext：

- `listPoints(context,{afterKey?,limit?})`：默认50/max200 keyset 元数据分页。
- `readPoint(context,id)`：完整 point/head/path 与原 revisions。
- `preview(context,id)`：逐 path restore/remove/unchanged/conflict/unavailable，原 preimage Artifact、first/last baselines；只读零 Model/文件效果。
- `readRestoreIntent(context,checkpointId,restoreId)`：原 journal lookup，零物理重写。
- `recordRestoreIntent` 保留旧 blocked 意图 helper，不能执行恢复或授予资格。

公共 Queries 是 `files.checkpoints`、`files.checkpoint.detail`、`files.checkpoint.restore-status` 和 `files.checkpoint.recovery-boundary@1`。四个入口都核实际 execution-group scope/subject 与当前 Store，缺可信 observer 拒绝；读取不要求 group 静止。status 返回 `{journal,execution}`，execution 只来自准确原 runless Job/namespace/版本/Store/Session，含 ID/status/resultRevision；不能把 journal.phase=restored 当作原 Core carrier 已知成功。

recovery-boundary 只接收准确 pointId，返回当前 Store/Session/Workspace/contextSelectionId、完整原 checkpoint 和当前 selected `boundary/trigger` Message IDs/Decimal64。它复用恢复的完整 selected lineage 与所有 sealed aliases，核原 trigger/before 真正位于当前固定选择，并在读后复核实际 group 的 Store/Session/contextRevision；不按相同 seq 猜当前消息、不重标父 point 身份。此 Query 不读取当前文件、Artifact 正文或产生效果，物理 conflict 时仍可能取得合法 session-only 边界；both 第二步还须由调用者独立新读原 point detail。Native 只读 API/SDK 接线由 Service/Client owner 负责，取舍见[原边界与独立意图资产](../../../../../.agents/notes/implemented/architecture/2026-10-04-file-recovery-boundary-and-intent-assets.md)。

## 显式 code-only restore

`files.checkpoint.restore@1` input 只有 `{checkpointId,restoreId}`。Core 原授权 adapter 是 `builtin.files/files.checkpoint.restore`；独立普通 Action 审批由宿主权限控制，leaf 不回答或复用人类答案。资源仍为 `files.mutation`。

prepare 重建完整 preview、读原 records/list，并调用 scoped `requireExecutionGroupQuiescent()` 登记通用 guard。Core 最后 dispatch SQL 同事务复核原完整 root group 静止、原 records/list 与 prepare 时固定 contextRevision，持久 carrier fence 在 dispatching/running/unknown 持续封闭新效果。contextRevision 包含原 root 与 descendants 的 selections/完整 Messages/parts，而非 next_seq 分配水位；Action/Ask 自身不会假装 Message 漂移。execute 前再次重建 planDigest 是额外检查，不能冒充 final SQL CAS。getView、单 Run bool、numeric seq、自报 root/exclusion 都不作许可。

新恢复写闭合v2 journal，保实际runless carrier的rootWorkSeq、可空expected baseline与confirmedPost：null为未确认，`{baseline:null}`为实际确认缺失。旧v1仅按原结构读取，不补造字段。每个文件先持久完整job-scoped before-image和pending effect ledger，再执行restore/remove或只读unchanged，核真实返回的path/fullbytes/hash/size/inode，CAS封存confirmed effect与journal。实际新inode成为后续更早恢复和新Run的基线。逐项保存成功、失败、未开始；postpublish、结果确认或CAS/seal无法核实保unknown/pending，Core fence保持，不承诺整批原子。

只有v2 failed、首文件failed/其余not_started、所有confirmedPost为空且完整ledger为空，才能保为有限no-op事件。消费前必须核原known failed Job、同Session/Store/runless/definition/version/rootWorkSeq/inputDigest及完整result journal；保留事件和readonly来源，不直接丢弃失败记录。pending ledger提交后丢回复、partial/unknown以及媒体、scope、protected path、外部基线漂移、active/accepted work都继续拒绝。取舍见[封存时间线](../../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-file-checkpoint-timeline.md)。

相同 restoreId/point 任何 cold/pending/unknown 只返回原 journal，不第二写；不同 point 冲突。重放 restored journal 仍核原真实 carrier、inputDigest 和 succeeded，不能以本地 phase 掩盖关闭/最终提交未知。code-only 不改对话；combined 由上层显式停止并另行 fork。Files anchored FD/hash/inode/check/publish 继承原原语限制：非合作外部 writer 的 rename/unlink 竞态不能由目录 FD 宣称完全原子锁住。

## 实际资格

[Capture/restore tests](../../../test/isolated/file-checkpoints/capture.test.ts)在本机Bun1.4.2使用真实临时SQLite、OS Workspace locks、ArtifactStore和固定Model。当前18/231/0保留旧捕获、Ask、原Model/媒体、finalSQL漂移、发布后unknown与关闭失败边界，并新增later→earlier→新Run实际新inode链、原known failed且空ledger的零效果恢复/Fork，以及pending ledger丢回复后unavailable/拒绝Fork/原ID零重写。原失败日志保留；定向资格不替代客户端流程。

2026-10-04 新增 recovery-boundary 后定向捕获为 19 项 251 条断言；四个 Query 的 subject/group guard 接入后，捕获与默认 Fork、压缩、A→B、原媒体五文件当前组合实际 24 项 602 条断言、零失败。新窗口核完整 current aliases、相同 selected 内容而不同 selector、被排除 trigger 拒绝及实际 lastChangeCursor/执行/文件无变化；原 18/231 属于此前时间线冻结资格。Native 四类有限 GET 与 SDK 的六文件 13/629 是另一实际运行，不能相加充当单次全套验证。

[真实默认 Fork/selector](../../../../../apps/service/test/isolated/file-checkpoint-fork.test.ts)当前3/316/0分别核两层session-only留下未选B后像、codeB已知恢复后Fork并独立恢复earlyA、同Session保全Messages但换selector后的旧点恢复与排除trigger拒绝。原head仅以准确owner/Command/CAS的host metadata fault probe改变，immutable来源不改；generic Artifact reader没有继承foreign grant。Provider各8，cold原Command/restoreID零重复效果。受影响Browser API/SDK七文件29/570/0是另一实际运行。

[Web真实Browser fixture](../../../../../tests/fixtures/unified-agent/web-file-checkpoints-preview.ts)以fresh public builder的packaged child、固定loopback Provider与可信compiled assets运行IAB。当次候选`terminal-740167cc1d7bf19d175e99ae8ce39f30c553315bd5791889b9cfd7a33de8bcad`两次freshbuild，目录/detail/原status、v2 journal/carrier、两个真实取消均核实；读取前后12类完整事实相等，Provider8/cursor124/16Messages/2Runs/15Executions/4write effects与文件hash不变，最后自动exit0。仅本机IAB/同Store准确S/W，不外推Fork/newStore浏览器现场、恢复按钮或其他平台。

[真实默认 A→B](../../../../../apps/service/test/isolated/file-checkpoint-restored-profile.test.ts)用公开offline backup/inspect/restore，原point/Model/Tool/Command/Artifact保A，当前B独立mode/trust CAS后形成新B ordinary Run。A last与B first精确衔接，早A经B独立Ask恢复完整184003字节原像并移除两轮创建文件；cold原ID保持Provider8且零重写。此前单例1/83与五文件19/506是当时冻结的资格，当前时间线更新后的邻接另按实际运行记录。取舍见[原来源与当前授权](../../../../../.agents/notes/implemented/architecture/2026-10-03-file-checkpoint-original-source-and-current-restore.md)。

[完整设计](../../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)已交付通用 sealed 来源、Files 完整 snapshot/confirmed baseline、Web 只读观察与 CLI/TUI/Native 开发路径的三种范围、持久两步骤及原 ID 冷查询。Client 的 fresh detail 必须完整覆盖原 Code journal 路径，全部 unchanged；外部编辑或后来已完成 Run 即使未改 selector 也会阻止第二步，保留 Code 成功/Fork 未开始。正式入口与完整 Native 发行安装资格独立维护。原Run历史选择观察由[私有reader](../../storage/sqlite/context/README.md)按actual Run pin取得，当前selected资格独立核验；观察本身不是派发授权。
