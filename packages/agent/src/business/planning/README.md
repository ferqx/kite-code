# Plan 与确定性验证业务叶子

`createPlanningValidation` 显式装配 ordinary Tools、用户 Actions、只读 Query、必要条件 evaluator 与 Run initializer。import 不读文件、不启动 Model/进程。默认未启用计划或 required 验证，普通对话可以直接完成；默认 Service 装配由 Service owner 接入，本叶子的存在不代表正式 UI/默认入口已迁移。

实现使用[公共扩展端口](../../extensions/index.ts)，没有 SQL、Provider、旧 Runtime 或第二 Loop。`requirePlan` 登记 dispatch/completion 义务；`requiredValidation` 登记 completion 义务。`initializeRequirements(input, policy?)` 由可信宿主调用：`policy.requirePlan=true` 仅对原 Run 单调加强，false 不削弱工厂已有要求；`readOnlyDefinitions` 仅接受宿主实际装配并确认只读的 `{kind:'tool',definitionId,definitionVersion}`，封存为准确 Run 的不可变集合，模型输入/JSONC/远端 annotation 不取得此接口。未批准时只允许 Model、原管理 Tools 与准确封存的只读 Tool 派发；只读父 Tool 的普通 Job/child 仍独立受计划门禁，Full 不能绕过。initializer 在首次执行前创建 `run/<actualRunId>/...` 不可变 executable 记录，再由 Core 封存准确 Session/Run/原 Store。关闭后续配置或缺少 evaluator 不能删除已登记要求。

## 计划与真实来源

`planning.write@1` 保存不可变正文版本及 CAS `plan.current`；`planning.read@1` 读取；`planning.review@1` 审阅准确 ID/version/digest，保存真实 accepted informational receipt 与 `auto`/`accept_edits` 执行方式。写入与审阅是两次独立调用。批准保存 `run/<actualRunId>/approval/<planId>/<version>` 不可变记录，核对原 accepted Interaction、批准 Execution 的实际 Run/Session/Store 与当前完整 plan digest；同 Session 后继 Run、旧版计划、旧答案或 runless 用户 Action 不能取得后继 Run 批准。旧 `approval/<planId>/<version>` 历史保持只读，新的 `approval.current/...` 仅用于上下文投影，不是派发 grant。批准不授予 Tool 权限，所有调用继续经过宿主 Permissions。正文、标题须非空、step IDs 唯一，不添加旧的 30,000 字/12 步/replan reason 长度产品限制；持久记录及公共 frame 的现有有限传输边界仍适用。

扩展的纯 `context.capture` 自动贡献当前计划与批准凭据的 canonical 数据，来源 ID 为 `builtin.planning:<session>:<plan>:<version>`，摘要覆盖完整当前计划和批准身份。公共 SourceRequest 当前没有 Run 字段；贡献仅在记录指向的实际批准 Run 仍 active、同 Session、Run 专属证明与 accepted Interaction 全等时显示批准，否则 approval=null，不从 input 或模型猜目标。Core 把业务贡献放在 user 数据位置，不把内容当 system 权限。`sourcesFor` 是需要显式宿主组合时的同一贡献实现，不应再重复装配同一来源。

历史 receipt 校验独立于当前信息贡献：`matchesPlanSource` 从实际 Execution 的原 Session/Store/Run（runless Job 沿既有限父链）读取当前完整计划与该原 Run 不可变 accepted 审批，复用同一纯 canonical payload 重建执行时来源 digest。原 Run 已完成不会让准确原 receipt 失效，但不会恢复 inactive Run 的普通批准贡献；新 Run 不沿用旧审批，plan/head/accepted proof 或封存执行来源变化仍拒绝。同 Session 派生报告继承原 plan.required ref 后不能借原 Run 的待审批 Model 管理豁免，最后 completion 重读完整原计划、审批、progress 和原 receipt；这些 record 继续进入最终事务 read-set CAS。

审阅 request 保留公共面板的 string version、准确 plan digest 与允许的 `allowedModes`。实际 canonical request 不超过现有 Interaction 32 KiB metadata 预算时继续 inline 完整 `content`；超过时只改变传输方式：完整 canonical plan 由公共 ArtifactWriter 发布到原 review Execution scope，request 的 `content` 明示正文在完整附件，`policy.review={kind:'artifact',complete:true,reference,...}` 保存准确原 scope ref、完整 size/hash/contentVersion、原 Store/Session/Run/Execution、plan digest 与 plan record revision，不截断或把字数变成业务上限。

这里的 `policy.review` 名称沿用既有 generic complete-Interaction attachment 消费协议，只是信息附件，不是授权 policy/grant。SDK `interactionAttachment/readInteractionAttachment`、CLI stdio、TUI、Desktop 与通用 UI 已有完整读取/hash/EOF 与未读取不得提交的公共接点；本叶子不修改客户端或另建 HTTP 路径。小计划 request 与回答保持原格式。

叶子在 `review.body/<actualExecutionId>` 保存不可变封存记录。request 前与接受答案后均通过原 scope 公共 reader 读取到完整 EOF，核 size、SHA-256、fatal UTF-8 与完整 canonical plan 全等；不能把 ref/hash 当已经阅读或当权限。原 accepted proof 仍须绑定同一精确 request 与实际 Run 批准 Execution。最后条件/`readPlanningState` 不取得物理文件或 SQL：重读完整原 plan 和 seal、核原记录 revision、原 scope、完整 hash/size、accepted Interaction 与 Run proof，收集最终 record read-set CAS。已接受的人类阅读事实不把外部文件修改与 SQL commit 冒称原子；物理正文损坏在实际读取边界拒绝，封存记录或 plan 在最后读后漂移则在 SQL 派发/完成事务拒绝。

完整 plan 仍保存在既有 record；当前没有单 record 业务正文限额，但 SQLite Worker 保留既有 queuedBytes/pending 资源准入（普通队列 14 MiB/224、关键队列 16 MiB/256），不因本叶子扩大。真实资格覆盖超过 300 KiB 的 UTF-8 与 JSON escaped 大正文写入、原 Artifact 完整审阅、批准状态和真实 step receipt 完成；不宣称超过既有队列/平台容量的无界传输。贡献中的批准摘要仍只保留 decision identity/answer，不再次复制审阅附件正文。

`planning.update@1` 要求准确当前 ID/version/digest、Run、step 与 progress revision。完成步骤必须引用该 Run 真实成功 Tool/Job 的原 Store、attempt、定义版本、input digest、result revision，并匹配该执行真正捕获的当前计划来源 ID/digest。Model 文本、计划/验证管理 Tool、旧 Run 或旧计划成功回执不能替代。完成候选需要全部 step 完成、当前批准和独立 required 验证/准确 waiver；Core 最终仍重新读取相关记录并事务复核。compensated 保存原 receipt 与补偿 receipt，不成为 passed 或完整计划完成。用户 `planning.write/review/update` Actions 共用业务函数但有独立 Command 身份；活跃 Run 的同 Session Action 按当前串行队列等待，不能假装它已并发修改当前工作。

`planning.review` 的实际 ToolResult 保留 `status`，并把合法原 `approve/revise/deny` 的 `decision` 与存在时的完整原 `feedback` 交给下一次 Model 请求；批准另带原执行方式。修改或拒绝仍为 `not_approved`，不保存批准、不自动增加版本或取消原 Run。Model 根据原修改要求另调用 `planning.write`，新版本仍须独立准确审核，旧批准不随之移动。[实际 SQLite/Model 回归](../../../test/isolated/business/planning.test.ts)核原反馈驱动 v2、两版本批准前零写入、deny/空 revise 原值、非法 mode 不授予批准，以及原 Run 证明和最终 CAS。已派发适配器在取消后没有可核结果时继续遵守 Core 的 `outcome_unknown` 合同，不因这条信息反馈路径改报 cancelled。

## 确定性验证与 waiver

`validation.define@1` 在准确当前 Run 保存不可变检查 spec。`requiredReceiptDefinitions` 是可信宿主选定的定义 ID/version 集合，封存在 Run 义务中；模型可以增加检查，不能删掉或改成其他定义。receipt check 只证明准确调用已有成功回执，不证明代码、文件或任务语义正确。在 plan 工作中，检查目标还须匹配当前计划真实来源。`validation.check@1` 保存不可变 attempt 及 CAS current pointer；最后条件再次核对实际 Execution，拒绝 missing、failed、inconclusive、unknown、范围/attempt/定义/input digest/result revision 不符。

`file_hash` 固定相对路径与完整 SHA-256 期待值，宿主必须显式配置 `fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' }`，并在实际 Run manifest 装配该可信定义。检查由 `operations.ensure` 派发普通 Tool；传入首行分页以限制正文，但比较实际 v3 baseline 的完整全字节 hash，不把首行当全文。每次真实检查的 operation key 包含原 checker execution identity，重试保留身份，新重验不会重绑定旧 parent。缺 checker、读取失败、超大小或无完整 baseline 返回 `inconclusive`。没有自动默认 Files I/O，也不在业务叶子直接读文件。

`artifact_schema` 固定对象根 JSON Schema 期待值，读取准确成功工作 Execution 返回的 ArtifactRef；字符串 ID、模型自报 literal、错 scope 或不存在的引用不能通过。实际 reader 继续核对宿主原 Session/Store/subject/scope。纯检查器允许有限 type/properties/required/items/enum/const/数值与长度边界，不支持远程 `$ref`、pattern、组合或自定义关键字；schema 最大 32 KiB、512 节点/16 层，Artifact 最大 1 MiB、10,000 值/32 层。schema 不满足为 `failed`，缺 reader/引用/schema 能力或超预算为 `inconclusive`，不启动模型或网络。

同 Run repair/reverify 保留原 immutable spec 与 required。`validation.rebind@1` 只追加真实成功修复 Execution 的新绑定：定义 ID/version 必须等于原逻辑检查，仍核对准确 Run/Store/attempt/input digest/result revision 与当前计划来源；不能改 hash/schema、删检查或换定义消除义务。绑定和 attempt 追加为不可变记录，current 以原 revision CAS 更新，晚到结果不能覆盖新绑定或新 head。Files 在同一路径重新检查；Artifact/receipt 可以引用相同定义产生的新真实结果。业务可判定预检或 CAS 失败返回已知 failed，普通 Loop 可以继续修复；嵌套执行的 unknown 仍保存 unknown，不能以 waiver 伪造已知完成。最终门禁核对当前 binding revision、实际 checker 成功结果和嵌套文件检查的 parent/定义/input/hash 身份。原失败事实不删除，没有历史累计 repair 次数上限。

普通 Job 的 `runId=null` 不被猜成当前 Run：有限 actual parentExecutionId 链须到达该 Run 的真实 Tool，沿途核对同 Session、原 Store 与 root work 身份。Run 级 completion 条件仅在原 Run 结束时强制；Job/carrier/继承义务的子 Run 先报告真实结果，不能让尚未保存的 Job 成功回执反过来成为该 Job 自己报告成功的前提。义务仍保留，由原 Run 的最后条件提交核对。

`validation.request_waiver@1` 仅请求真实用户 question；`validation.waive@1` 是空闲时的用户 Action。两者都不能接受调用者自报 actor、time 或 approved。只有宿主持久用户答案被原 execution 接纳后，才能保存准确 requirement/revision/Run/spec revision/plan 范围及理由、receipt。`savedAt` 是业务保存已接纳凭据的时间，不冒充数据库用户提交时刻。最终评估保存 `waived`，不制造 `passed`。其他 Run、换版/spec 变化不能沿用旧 waiver；未知副作用不能被 waiver 解除。waiver 也不绕过底层 Permissions。

`readPlanningState(read: ConditionReadContext, {runId,originStoreId})` 是有限可信宿主只读投影，返回 disabled/pending 或已核 approved 的 auto/accept_edits、原计划 ID/version/digest；它复用同一 proofValid，并读取准确 obligation/current/document/Run approval/Interaction/Execution。模式只是当前 Permissions 之外的上界，不授予能力、不能解除硬拒绝/trust/独立 Job 最低审批。Service 必须提供实际原 Store/Session/Run 的 scoped reader，不能直接把 raw record 或模式摘要作为 grant；最终 condition 仍收集实际读集并由 SQLite CAS，等待后 plan head 或 sealed obligation 漂移拒绝。

`planning.status` 与 `validation.status` 只读公开 envelope；未知字段保留，未知 contentVersion 可公开原记录、写入与执行判定明确拒绝，不降级解释。扩展 records 使用已知 kind/字段 schema 并保留兼容未来字段。

## 当前证据与未闭合范围

计划写入和 progress 更新的最终 CAS 保留最初读取的实际 revision；保存正文、候选检查或 attempt 的等待不会借用后来出现的新 revision。真实同 namespace 嵌套 Tool 在这些等待期间更新 head/progress 后，旧 writer 明确 failed 且零覆盖，原不可变候选仍保留。

waiver 使用不可变 `waiver.attempt/<actualExecutionId>` 和准确 CAS `waiver.current`。合法 rebind 后可请求新的真实用户决定，不覆盖历史，也不沿用旧 binding 的批准；最终门禁的 read-set 同时核对 current 与对应 accepted proof。所有规划 Tool/Action 共用有限 known-preflight 分类，版本、身份、证据前置失败和 CAS 冲突为已知 failed；其他适配器或传输错误继续由 Core 保留 unknown，不按宽泛错误前缀吞掉。

[真实 Core/SQLite 测试](../../../test/isolated/business/planning.test.ts)使用本机固定 Model，无付费 Provider：v1 批准后 v2 拒绝旧批准/旧计划成功回执，准确新批准和新执行可完成；required receipt 的失败、缺失、未知和精确身份负例；宿主 required 定义不能被模型替换；用户 waiver 不影响新 Run；补偿保留原事实但不完成；缺 evaluator 拒绝、未启用普通对话完成。

新增真实 SQLite 固定 Model 回归还覆盖完整大计划原 Artifact 审阅、hash/ref/foreign scope/seal 与 document revision 篡改、原物理文件 incomplete、实际 invalid UTF-8、原 accepted seal 读后提交漂移导致最终 dispatch CAS 拒绝；均不制造批准/效果。业务资格使用真实 public Runtime Artifact reader与 SDK envelope 识别，不将客户端已有附件接点的源码核对冒称新增真实客户端窗口资格。

新增真实 SQLite 固定 Model 回归覆盖单次 host requirePlan、false 不削弱、只读定义准确 version、只读父 Tool 不授权 Job、同 Session 后继 Run 不复用批准、runless Action 批准无 grant、已完成旧 Run 的 context approval=null，以及 evaluator 读后并发 head revision 提交使最后 CAS 拒绝且零效果。未要求计划的普通对话仍由原用例资格。

真实回归还覆盖坏文件在同一 Run 经 13 次仍失败的实际修复后，第 14 次修复及全文 hash 重验通过；原 required/spec/失败记录不变。Artifact schema 失败后新发布结果经同定义追加绑定通过；缺 checker、错 Artifact scope/literal、unsupported schema 不通过；换定义、替换 spec、stale revision 拒绝；实际 checker 执行期间推进 head 后旧 callback 不覆盖，新重验仍可收敛。

description-only 的 command/MCP check 仍明确 `inconclusive`；不会把旧描述解析成命令或 capability。实际有限 checker 接点与证据见下段。Shell 网络隔离、MCP 生产环境可信只读资格/外部原子快照、未由宿主声明的 mutation 仍不自动提升义务；本机正式 Files 的可选自动台账与 completion continuation 见下段，也不承诺将外部文件状态与最终 SQL commit 原子绑定。新 Run／逻辑期待值变化或重规划继续需要准确用户决定，不能替换失败 spec 降低已登记要求。这些范围与[验证治理](../../../../../docs/active/verification-governance.md)的完整承诺仍有差距，本文件不以当前显式检查覆盖该承诺。


## 有限 command/MCP 语义 checker

可信宿主可显式提供 `commandChecker:{definitionId,definitionVersion}`，以及 `mcpCheckers:[{id,definitionId,definitionVersion,sourceDefinitionId,sourceDefinitionVersion}]`。MCP 的只读资格和允许的写入来源定义由宿主声明，不能从 JSONC、远端 annotations 或模型描述推出；定义 ID/version 是实际装配的完整身份，远端 catalogue/config/generation 改变形成的版本不可换名复用。没有 checker 或版本不可用时本检查局部 inconclusive，不直接 spawn、连接或 RPC。

`validation.define` 的 command 检查接受 `{kind:'command',input,expectedExitCode}`，通过 `Operations.ensure(kind:'job')` 派发普通 Job，再等待真实终态；只比较实际 result.details.exitCode，且必须有 groupStopped=true。已知非零退出码可匹配明确预期，unknown、未证实停止或只含成功文本不能通过。Job 许可、资源、取消和监督与父 validation Tool 独立，父 Tool 允许不授予 Job 权限。

MCP 检查接受 `{kind:'mcp',checkerId,input,target,schema}`。target 必须是宿主限定来源定义的准确成功 Execution/Run/Store/attempt/input digest/result revision，并继续匹配当前计划来源；读取走普通 `Operations.ensure(kind:'tool')`，只检查真实 ToolResult.details.structuredContent 的有限对象 schema。缺 structuredContent、isError、unknown 或不满足期待分别保持 inconclusive/failed/unknown，不拿 content 中的 success 当证据。纯 schema 的节点/深度、关键字和 1 MiB 结果预算沿本叶子的有限验证规则，超界不制造 passed。

checker 配置、期待值与 schema 封存在 immutable spec；attempt 保存原 OperationRef、实际 checker target、spec/binding revision 和判定。Tool accepted ref 的 executionId 可以暂为 null，后续真实 Execution 必须匹配原 command、父 validation.check、namespace、Session/Store 和精确 operation key；不改写接收时事实。最终 evaluator 再读这些实际执行和来源，形成 Core 最后事务的 read-set，并重新判定语义；不能只信 attempt 中的 passed。MCP repair 仅追加同来源定义的新真实绑定，不换 schema/期待、删旧失败或重用旧 checker。已有 waiver 身份、unknown 拒绝及已登记义务规则保持不变。

[semantic-verification.test.ts](../../../test/isolated/business/semantic-verification.test.ts) 使用真实 SQLite/Core、固定模型、已构建 guardian 的无害 Shell 和真实本机 HTTP MCP SDK：退出码匹配/不匹配、独立 Job 拒权零 spawn、MCP schema 失败后同 spec 修复、新版本零 RPC、纯文本成功不能通过。连接仍先经普通 connection Action/Job 的持久派发，再 discovery；每个未来 Model Step 只读已缓存目录。该本机测试 transport 是明确测试资格，未证明生产 DNS/TLS/proxy/只读远端语义，也不把远端状态与 SQLite commit 视为原子快照。当前 Shell/MCP 仍只装配显式宿主 checker，不将它们视为自动 mutation checker 的生产资格。


可选 `automaticValidation` 由可信宿主声明实际 mutation definition/version/effects 与完整基线 checker；缺省关闭。当前资格限定于正式 Files 的 `files.write@2`、`files.edit@2` 和 `files.read@3`。`initializeRequirements` 在首个 Execution 前创建不可替换的 `agent.mutation-policy@1` metadata，并登记一个 Run 级 `mutation.required` completion requirement。每次受治理 Tool 在真实派发前登记准确 intent，实际结果结算与台账更新同一 SQLite 事务提交；单个 requirement 配合 keyset 事实页和 CAS head，不将 64 refs 上限变成累计 mutation 次数上限。普通已登记计划、批准、显式 validation/waiver 的权威和原证据路径保持独立。

Model 提出完成时，Runtime 在原 Loop 内检查必要条件：可确认的 mutation 由普通 `validation.auto_check@1` Tool 调用已封存的真实 Files checker，沿普通权限、来源、资源与派发门禁执行。期待 hash 来自原 mutation 的真实完整 baseline，不能由 Model 替换；精确 head 改动使迟到 checker 失效。同原 Run/Store/namespace、相同 Files descriptor 与真实 receipt 路径的后序已知成功 mutation，可使旧成功事实标为 `superseded` 并指向准确新 Execution/seq/hash；旧 hash 不冒充 passed，最新 hash 仍必须真实检查。未知、失败、取消或未结算的事实不能借后序写入擦除；显式 immutable spec 的原期待保持。失败或 inconclusive 生成一次具名低信任诊断并允许同一 Loop 通过正常权限 repair，再检查；未变化的诊断 key 去重，不能无限 Model polling。unknown、取消、删除、外部 Store 或缺失事实不能触发自动继续，child 的原 activation deadline 不续签。最终 requirement 还读取准确 checker terminal，因此提前保存的 check 事实本身不能完成 Run。

[automatic-validation.test.ts](../../../test/isolated/business/automatic-validation.test.ts) 使用真实 SQLite、正式临时 Files 与固定 Model：立即完成候选会真实检查，外部文件变化产生诊断后正常 repair，passed 后新 mutation 重新检查，审批拒绝和 checker 拒权没有冒充满足，真实发布后未确认的 mutation 保留 unknown 且零自动 checker/repair，派发前登记故障零文件效果，结果登记故障使 terminal/事件整体回滚且不重放，迟到 checker 的 CAS 被拒，取消历史 readonly 重开与 Rewind 后新 Run 不自动重做。同 path 两次真实 write 能完成最新检查，latest hash 被外部修改仍失败；65 次真实 mutation 仍只保留一个 immutable requirement，并按 32/32/1 页读取全部事实。此切片未证明所有 Shell/MCP/任意后台外部 mutation 的生产 checker 资格，也不将最终 SQL commit 与非合作外部文件修改窗口视为原子快照；旧显式 spec/waiver 不会被此自动策略降级。
