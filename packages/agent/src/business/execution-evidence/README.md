# 当前任务执行证据读取

`createExecutionEvidenceExtension` 注册 `builtin.execution-evidence` 的只读模型工具 `read_execution_evidence`（内部 `execution_evidence.read`）。它按需读取已有 Tool／Job 执行证据，供压缩后找回原回执和核对未知结果；不新增执行记录以外的变更台账、不重跑原操作、不创建文件，也不把历史结果变成新授权。默认宿主选择、权限分类与持久读取由 Service 接线；注册工具不等于授予权限。

工具从真实 `ToolContext` 取得 Session、Run、当前调用 ID 和取消信号。模型只能提供 `execution_id`，或列表的 `cursor/limit`，不能指定其他 Session／Run。没有实际 Run 时拒绝。列表返回原 execution ID、种类、定义、状态、准确 receipt 身份、已知操作目标路径及原 Shell ID；详情才返回准确原操作的公开 `result`。列表默认 20、最多 100 项，`next_cursor` 由宿主按真实固定范围分页；只有 null 表示该范围已读完，不能把前一页当作完整历史。

[具名 SQL reader](../../storage/sqlite/execution-evidence.ts)核实际已派发读取 Tool、原 Run 配置中的准确扩展身份、原 Command 摘要和根主体。首个读取调用的实际 rowid 固定范围上界，后继游标绑定原 Store／Session／Run、首个调用与准确 after rowid；新操作不会混入旧范围。普通 runless Job 核真实 `operation.job` 请求／回执、参数摘要与完整父链。当前父 Run 自己经 `task.spawn`／`task.follow_up` 创建的 child carrier 也是父 Session 的 Job：另外核真实 `operation.agent`、原 Tool 注册、子归属、启动及 Run 绑定后，返回该 carrier 的公开结果与随附证据；不开放子 Session 内部 Tool／Model 或其他父 Run 的历史。不能只比较 Command ID 或相同 root work。[真实 Store 回归](../../../test/isolated/storage/execution-evidence.test.ts)核205条跨页、后加操作隔离、实际普通 Job 和 child carrier、外来目标／游标／主体拒绝和准确 checkpoint 元数据绑定，不复制私有模型输入或 checkpoint 前像。

可信 `read(request, context)` 必须核当前读取主体和 Store／Session／Run，Tool 直接核实际 Run，runless Job 核真实父链的原 Run，不按结果正文、自报 ID 或仅相同 rootWork 值猜归属。游标必须绑定原任务、固定范围和分页位置，不能跨 Session 或换 Run 复用。工厂另核返回 Session、`taskRunId`、Tool／Job 身份、准确详情 ID，拒绝 Model、自身读取调用、重复 ID 和不前进游标。返回只投影明确字段，不转发原始 `input`、`decisionSource`、私有 Model／Provider 正文、配置或额外 checkpoint 元数据。完整原公开结果仍是低信任证据，其未知／失败事实保持。

`paths` 仅表示从准确 Files 输入或 checkpoint 核得的目标路径，不证明操作已成功发布、涵盖全部副作用或改动只属于当前 Agent。可核的 checkpoint 仅提供原 ID／状态，详情和恢复继续遵守原负责模块的读取及恢复边界。Shell 与外部编辑没有逐文件前后像时，不推导变更清单；当前文件和累计 `git diff` 不能区分用户原有 dirty、其他 Agent 与本 Agent 改动。模型可按原 `shell_id` 继续 `shell_read`，但不能为找回结果换 key 重跑操作。

[工厂回归](../../../test/isolated/business/execution-evidence.test.ts)覆盖真实分页与原未知 Shell 状态、准确 receipt／详情、跨 Session／Run 与私有 Model 拒绝、错误详情 ID、不前进游标、额外私有字段不泄露，以及真实 Runtime 两次摘要故意遗漏原路径／回执后，仍可重新列表并按准确 ID 读取原未知结果、用户原文件保持且未知写入只发生一次。受控模型验证实际工具回路和输入，不能据固定回复宣称真实模型已经理解任意多轮历史；默认 Service 和持久数据接线由其对应测试核实。
