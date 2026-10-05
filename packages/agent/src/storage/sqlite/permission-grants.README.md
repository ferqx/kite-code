# 会话内精确命令授权

`same_command` 只能来自原 approval 卡提供的选项及用户明确答案。`approve_once` 或未指定 grant 仅批准原调用；`question`、`plan_review`、Auto 模型批准与 Full 模式不创建会话授权。实际 owner 在 `acceptInteractionDecision` 的同一事务核对原卡、执行、attempt、来源、策略和必要条件后保存授权。保存答案本身尚未创建 grant，客户端不能直接提交任意授权记录。

授权绑定原 Store、用户、实际 Session、Workspace、执行 kind、定义 ID/版本。父会话与 child 分别保存，不能借展示根的授权；clear 也只清除用户精确选择的实际 Session，不隐式覆盖后代。完整原 inputDigest、Interaction ID/accepted revision、Execution ID 继续保存为批准证明。没有可信 commandDigest 时，后续调用必须匹配完整 inputDigest。

可信宿主可在 `PermissionDecision.approval.commandDigest` 提供 64 位小写十六进制摘要，表达完整命令、cwd、env、runner 身份及定义等执行语义。只有宿主知道哪些字段仅是新操作的逻辑 ID；Core 不按工具名称丢弃参数，也不接受 Model 参数自报授权身份。摘要路径允许逻辑操作 key 改变但语义保持相同，仍核对全部原 scope 和实际批准证明。默认 Shell 的摘要计算与真实 Shell 消费资格由 Service 装配负责；通用 Tool 测试不代替这项资格。

后续授权仍要求当前硬权限允许用户决定，并明确提供 same_command 选项。已有 grant 不覆写 workspace trust、能力门禁、当前权限控制读集、取消、owner、来源 freshness 或必要条件。最终 `markDispatching` 短事务再次核原证明和本 Session 单调 epoch；clear 已提交则旧 proof 被 `permission_grant_changed` 拒绝，零 adapter 派发。撤销不回滚已执行效果。

`listPermissionGrants` 是纯查询，明确原 Store/subject/Session，以持久 change seq 固定 upper 做 keyset 分页，每页最多 200，无总量淘汰；返回 scope revision、原批准身份和摘要，不复制命令正文或用户 authority。分页冻结新增上界，不提供跨页 MVCC：期间 clear 可移除已撤销项，调用者须核当前 revision。原正文可由原 Interaction 核对。`clearPermissionGrants` 对观察 revision 做 CAS，原 commandId 幂等，持久 `permission.grants.clear` HostMutation 与全部目标 Session grant 的撤销在同一事务提交；不同 Store/主体不能查回或改写旧意图。普通冷只读打开只读事实，不启动模型或回放工具。

实现位于 [permission-grants.ts](permission-grants.ts)、[Interaction Gate](../../execution/interactions.ts) 与 [Interaction SQL](interaction-operations.ts)。实际 Core/SQLite 测试位于 [execution/permission-grants.test.ts](../../../test/isolated/execution/permission-grants.test.ts) 与 [storage/permission-grants.test.ts](../../../test/isolated/storage/permission-grants.test.ts)。新增 5 项、43 个断言覆盖精确调用/语义摘要、不同 Session、当前硬拒绝、单次批准、clear 派发竞争、202 项真实接受记录的分页与冷只读零变更；与既有 Core Interaction 6 项合计 11 项、103 个断言通过。HTTP/客户端、默认 Shell 和正式调用者资格分别按其真实联验维护，此叶子不宣称正式 TUI/Electron 三平台已迁移。
