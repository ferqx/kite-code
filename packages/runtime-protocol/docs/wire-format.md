# 协议编码、版本与传输边界

入口：[codecs](../src/codecs.ts)、[mappers](../src/mappers.ts)、[limits](../src/limits.ts)、[generation](../src/generation.ts)。本包将 Runtime contract 编成严格、browser-safe、framing-neutral wire，不执行命令。用户输入交互保留可选的有序 `questions`，每题携带稳定 ID；批量回答通过 text response 的可选 `answers` 映射原子提交，映射键必须回指投影中的题目 ID。

请求、回执、通知和查询结果必须通过对应 codec。exact version、允许字段、大小限制和错误形状由该包决定；不能让未知字段进入 raw Runtime event。Service carrier 处理实际 framing 与传输，Protocol 不创建 socket 或进程。

连接 request identity 用于关联 wire response；业务 command identity 和 Session revision 用于幂等及状态校验，二者不能混用。连接重建不允许自动重放未知副作用命令。

修改 contract 后同时核对 mapper、codec、producer 和 consumer。只有输出字段的投影允许时才能新增客户端信息；生成参考不替代运行 codec。与 Public Agent API 的关系见[整体依赖](../../../docs/development/architecture/dependencies.md)。

验证：[Protocol tests](../test/)、[Server tests](../../runtime-server/test/runtime-server.test.ts)、[Client tests](../../runtime-client/test/runtime-client.test.ts)。

`history/load_session` 的可选 `page` 参数携带 `afterSequence` 与 `throughSequence`。分页响应为闭集 `history_session_page`，只传 source-sequence records，不重复传 flattened events；客户端合并后还原完整 transcript。单帧仍受 1 MiB 限制，不分页的显式读取保留完整响应语义。

内部子 Session 只通过显式父树读取：`runtime/query` 的 `list_child_sessions` 和 `get_child_session_projection` 均以 `sessionId` 指明已授权的父 Session；`history/load_child_session` 同时传 `parentSessionId`、`childSessionId`，沿用同一分页响应。`runtime/subscribe` 的 `child_session` 选择器也同时携带父、子 ID，并支持源 revision 水位和 ephemeral 通知；Service 在订阅准入时核验准确父子血缘，Server 将已授权选择器映射到该子 Session 的现有事件流。普通根会话列表、直接 `get_session_projection(childId)`、`history/load_session(childId)` 和普通 `session` 订阅不因此开放。子 History 方法只在组合了受限读取端口时宣告，响应仍经过安全投影，不传原始 Store 事件。

按需恢复的 command/query、codec、双向 mapper 和生成类型在同一配套版本更新：`recover_session` 绑定 expectedRevision/expectedAuthorityRevision，`get_session_recovery` 只读既有事实，`get_command_receipt` 查询原命令回执。原命令作为查询数据绝不进入 dispatch；Host 仍校验 scope 和 digest。create_session 允许显式请求目标 workspace，但准入规范化与信任校验后的上下文才是最终执行身份。无未发布格式的兼容分支。

后台执行query结果把`sessionRevision`、列表`aggregateGeneration`、item `ownerGeneration`与item `revision`
编码为四个独立必填字段。前者是Session mutation CAS；其余字段分别限定组合目录、原生执行owner和单项状态水位，
不得互相代用。`stop_background_execution.expectedRevision`只来自同次读取的`sessionRevision`。

Session 当前 Run 的可选 `waitingReason` 经过严格 codec 编码为
`{ kind: "required_background", taskIds: string[] }`，且只允许与 `status="waiting"` 同时出现；task ID 非空、唯一并受数量限制。
该字段是等待原因投影，不承载 child lifecycle、Artifact 或 completion authority。live notification、history/query mapper 与生成类型使用同一闭集字段，未知 reason 不能透传。
