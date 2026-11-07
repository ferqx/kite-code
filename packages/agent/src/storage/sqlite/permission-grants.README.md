# 会话内结构化范围授权

新版统一使用 [GrantCandidate/GrantOffer/ApprovalOption](../../permission-grants.ts)。Shell 同命令、Files 精确位置 edit/write 和 Worktree action 范围由各工具 owner 计算，可信宿主登记实际定义对象与准确 kind/id/version；通用 Interaction 和 SQL 不解析命令、文件路径或 Git 领域规则。无可信规则时只提供单次。公开请求为 `options`，批准答案只交原卡 `optionId`，拒绝只交 deny，不读取旧 `grants/grant` 答案或旧授权记录。

原卡完整冻结候选、展示、capability bindings、各消费能力的稳定 policyBindings、原 Execution/attempt/inputDigest、完整 policyRevision 和控制读集。客户端不能提交 scope、bindings 或有效期。`answerInteraction` 仅保存答案；实际 owner 的 `acceptInteractionDecision` 在原事务核原卡与选项成员、来源、当前完整 revision、必要条件和 freshness，保存 accepted revision、grant、Session epoch 和事件。接纳失败整体回滚，已保存答案仍可查询。`kind:once`、deny、question、plan_review、Auto 模型批准和 Full 不创建 grant。

owner 的单次执行确认复用原 approval Interaction 的 `once` 答案，不产生 grant。其 `executionConfirmation` 证明由真实 owner 预声明，最终事务分别核当前调用或同父调用的准确内部步骤；不能借 Session 授权目录、普通 question/plan_review 回执或其他 Run 转换取得。原历史请求和答案保持只读字节，新计划答案不接受 mode；细节归[Interaction owner](interactions/README.md)。

`permission_grant` 保留原 Store/subject/真实 Session/Workspace、来源 kind/definition/version、原完整 inputDigest、Interaction/accepted revision/Execution、seq 和撤销状态，新增 `scope_digest/payload_json` 保存规范范围及原冻结选项。来源定义不改成消费定义。payload 必须与原卡被选范围完整相等；当前实际能力必须是 frozen bindings 的成员，不允许把多个 grant 拼成一次调用。能力与策略集合放在同一小型 payload，不增加规则注册表、第二套授权状态机或使用表。

`scopeDigest` 覆盖 rule/contract、规范 scope 和完整排序 bindings。路径段与 argv 等有意义数组保序；展示文字不充当等价键，但随批准来源保真保存。稳定 `reuseRevision` 由真实策略快照、Session、mode/trust/control revision、能力与效果上限、rule/contract/scope 和工具行为配置生成，正文、baseline、单次 inputDigest 与单次完整 decision revision 不进入该稳定结构。edit/write 的两个真实定义各有绑定：从 edit 签发，write 只比较 write 的当前稳定绑定，同时仍保存 write 本次完整 revision。文件内容与 baseline 变化不自动撤销位置授权，当前冲突仍由原文件适配器以零发布拒绝。

[普通 Host/父子/Planning 合成](../../permissions/README.md)要求所有真实参与方提供稳定复用能力，包括 already allowed 一方；双方待批候选精确相交 rule/contract/scope/bindings。任一方只允许单次、硬拒绝或无法描述未来能力上限时不提供联合范围。`satisfiesCheck:true` 是明确覆盖本方默认审核的许可；缺省不替代 checker。独立 checker 及其明确人工要求继续执行，审核批准、拒绝与技术失败各保原合同。隐藏展示选项不会撤销同一可信范围当前仍允许消费的 grant。

消费时 `getPermissionGrant` 按真实 Session 与 scopeDigest 查询，核原卡、原 accepted revision、原 payload、当前消费能力及其稳定 revision。返回的私有 `GrantUse` 含原 grant/accepted revision、完整原 offer、本次 binding/reuseRevision 和观察 epoch；本次 Execution/attempt/inputDigest、完整 decision revision、control/必要条件和仍必要的 checker/policy evidence 沿原 DispatchInput 传递。它不是公开 JSON token 或新的执行接口。取得资源并重核当前策略与真实领域事实后，`markDispatching` 在原 SQL 事务复核 owner、原批准、范围、消费 binding、稳定绑定、epoch、控制与原必要读集，再同事务保存使用依据并标记派发。SQL 不运行领域 I/O，也不能锁住外部文件系统。

clear 先提交时，旧 epoch 在最终事务被 `permission_grant_changed` 拒绝，零 adapter 派发；dispatch 先提交则原效果可能继续，撤销只阻止以后派发。已派发失败、取消、owner 丢失与 unknown 沿原恢复合同，不能用 grant 重放效果。未派发完成决定因 steer 退休时，取消原卡、撤销该卡派生 grant 与推进原 Session epoch 共用原输入事务；其他卡授权和原批准历史保留。

规则按静态可信装配启用，没有 registry generation 或激活控制面。规则缺失或合同不兼容期间不消费；恢复相同兼容规则时，尚未 clear 且满足当前策略的原授权可以再用。规则暂时切换不是用户撤销；clear 的单调 epoch 和 revoked_seq 使已经撤销的授权永不复活。语义不兼容的规则必须更换已确认合同身份，不猜测兼容。

默认 Shell 的 commandDigest 只是 Shell scope 中的领域事实，仍绑定完整命令、cwd/env、runner/资产、范围、timeout 与定义，不做前缀或模糊等价。准确 Tool → 自身 Job 的 [policy evidence](authorization-policy-evidence.ts) 引用同一结构化 grant，并核真实父链、owner、Run、命令/范围证明、当前 epoch 和稳定许可。只有明确允许 grant 满足默认审核的 binding 才沿该桥继续；不伪造当前脚本材料已经审核，不传播到独立 Job 或其他 Session。Worktree 的原 prepare/mutation 桥独立核完整计划与冻结范围，create 的固定 base commit/父目录身份失配时零 mutation；普通单次和 Auto 免审不新增范围取证。

`listPermissionGrants` 是纯查询，固定原 Store/subject/Session，以持久 change seq 固定 upper 做每页最多200项的 keyset 分页，不按总量淘汰。目录投影提供 rule/contract/scope、消费工具 bindings、展示与原批准出处，不暴露私有主体或完整 policyBindings。期间 clear 可移除撤销项，客户端须核当前 revision。`clearPermissionGrants` 使用观察 revision 做 CAS、原 commandId 幂等，HostMutation 与撤销在同一事务提交；响应未知只查原 command。关闭客户端不清除已保存授权。新版库与审核格式不读取、转换、清空或改写旧用户库，格式检查在只读 preflight 拒绝不支持的格式。

实现入口为 [grant SQL](permission-grants.ts)、[Interaction Gate](../../execution/interactions.ts)、[接纳事务](interaction-operations.ts) 与 [最终派发](operations.ts)。2026-11-06，macOS／Bun1.4.4 当前工作树：以 `bun test --parallel=1 --max-concurrency=1` 完整执行 [Execution grant](../../../test/isolated/execution/permission-grants.test.ts)、[Store grant](../../../test/isolated/storage/permission-grants.test.ts)、[策略](../../../test/isolated/permissions/policy.test.ts)、[稳定绑定/AND](../../../test/isolated/permissions/grant-policy.test.ts)、[检查选项](../../../test/isolated/permissions/auto-check.test.ts)、[Planning约束](../../../test/isolated/permissions/constraints.test.ts)、[输入事务](../../../test/isolated/storage/inputs.test.ts)、[完成边界](../../../test/isolated/execution/completion-refresh.test.ts)和[父子绑定](../../../test/isolated/child/bindings.test.ts)，114项／1582断言通过。覆盖跨定义不同正文和完整 revision、第三工具拒绝、真实独立 checker 的批准／拒绝与必须人工、所有 AND 参与方、clear 派发竞争、201条以上授权分页、冷只读零重放及实际事务故障回滚。全仓 typecheck、文档结构检查通过；本机固定模型与 SQLite 证据不代替真实模型性能、客户端全过程或其他平台资格。
