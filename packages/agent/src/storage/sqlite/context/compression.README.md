# Context 压缩 owner

[Core slot](../../../context.ts) 由宿主或一个选中的 Extension 提供 `ContextCompressor`；同时出现多个候选会明确失败。算法只返回纯请求描述与有限非秘密 snapshot，不调用 Provider。没有 `shouldCompress` 时自动触发关闭；它和 `validateExpanded` 都必须明确返回 true。可选 `validateSummary` 在实际完整回复后验证摘要，存在时也必须明确返回 true；未提供时仅证明结构完整，不能据此宣称模型窗口资格。Core 不按字符或字节猜测模型 token 窗口，不内置摘要算法，也不截断自定义 focus 或算法说明，不设置 4096 字符、固定 token、最小节省或冷却门禁。

`Runtime.compressContext` 受理原 Store、主体、root Session、selection 和 commandId。它创建普通有来源的 Run，在原 `defaultLoop`/`UnifiedExecution` 内调用实际记录的 Model，工具目录为空；完整请求、结果 Artifact 和独立 usage 沿已有 Model ledger 保存。自动触发在原 Run 的下一 Model 安全边界调用同一实现；不创建第二 Loop 或收费调度器。可信 Context 贡献先捕获，压缩后以低信任 `user` 摘要供原 Loop 使用，必要完成策略仍在普通候选完成边界生效。

[具名 SQL](../compression-operations.ts) 在原 `context_snapshot` 保存 pending 描述、已发布压缩点和 reset marker。压缩记录引用原 Store/Session、准确 Model Execution/Run、selection、覆盖序列上界和前一个压缩点；该 selection 的不可变范围确定实际被覆盖历史。原消息、配对 Tool 结果及原 Artifact 都保留。仅真实 assistant 消息且其 source 指向压缩 Model Execution 时属于压缩历史；合法 User 的 sourceId/commandId 与 Model UUID 相同不能据字符串碰撞排除。pending/失败/取消压缩结果不能混入 selected 请求。没有新增所选消息或来源时拒绝再次收费，focus 不能绕过这个检查。未知 Part kind/version 保留历史，但压缩不能解释它。

最终提交重新核对 owner/generation、原命令取消、group stop/delete、准确 selection、实际成功 Model/完整无 Tool 调用输出、原压缩点和实际 Message/result_ref 读集。共享 Session 序号也用于 Command 受理，准确排队且尚未应用的 follow-up 不改变原压缩输入，不能仅因其分配序号拒绝发布。覆盖上界之后除准确同 Session/Run、assistant、原 Model 来源的完整摘要外，任何新增 Message 或已纳入 result_ref 仍导致冲突；pending input 不冒充已纳入来源。手动摘要发布与 Run completion（包括必要义务/read-set 最终复核）同事务；任一触发器失败完整回滚。自动成功压缩后的普通工作仍可独立失败，不能把后一业务失败改写为压缩未发生。压缩不增加 `contextSelectionId`。

自动压缩的已知 Provider 或纯算法失败，在原 Model 的 Store/Session/Run/generation、压缩身份与成功或失败终态可核实时保留旧上下文并继续原工作。SQL 写入失败、无法核实的 dispatch/unknown、取消和未知 Part 不走这个降级。仅保存最近一次失败的完整输入指纹，避免未变化上下文立即重复收费；新增输入或显式手动操作仍可重试，这不是累计预算或冷却配额。`getModelContext` 和 `getExpandedContext` 在只读快照内核支持的 Part 格式；普通历史查询仍保留未知原事实。压缩 Model 的历史消息不能成为普通配对边界或 Fork 的可执行来源。

`Runtime.resetCompressionContext` 封原 selection 与 `expectedCompressionId`（无活动点为 null）。存在活动点时，可信 slot 必须对完整展开历史与 Context 贡献执行 `validateExpanded` 窗口预检；没有实现、拒绝、取消或并发输入均保原点。清点与管理 Run 完成在同事务核准确高水位/CAS，保全部历史与 selection，零 Provider；无活动点是明确 noop。新工作在随后正常安全边界读取恢复的所选历史，不读取压缩 Model 的历史消息。

Fork 可复制当前活动压缩点的 SQL 来源引用，保持原 `originSessionId/originCompressionId`、Model/Run/Artifact scope，不复制 blob 授权或原执行资格。`getCompressionOrigin` 根据真实创建命令/主体及 SQL 原记录验证链接；Model 输入从原 Model 的完整结果读取正文，调用者知道 hash 或伪造 JSON 不授予读取权。Rewind 的新 selection 不暗继承原活动点。readonly 查询不会压缩、reset、获取 owner、重新 capture 来源或调用 Provider。

[真实测试](../../../../test/isolated/context/compression.test.ts) 使用私有临时 SQLite、固定 Model、实际 Artifact 和 SQL 触发器：手动/自动记录与来源顺序、slot 冲突、原权限拒绝、完整 ≥17MiB 摘要/Fork/cold readonly、损坏正文零下一 Provider、失败/取消/新输入、最终 Run rollback、无新消息和安全/不安全 reset。另有完整大 focus/算法说明、可信摘要拒绝、自动失败保旧输入及相同输入去重、新输入重试、SQL 失败不降级和未知 Part 零下一 Provider 的断言。默认算法、具体模型窗口策略和 HTTP/CLI/TUI 装配由上层独立验证，不能据这些 Core 测试宣称所有模型窗口策略均已实现。

恢复后的压缩读取核当前 Store 准入，并独立核原压缩记录、真实成功 Model Execution/Run、原 Command/rootWork/child 来源链；原 `originStoreId` 不改成当前连接。恢复后显式新 Run 使用原完整摘要，冷读取不会压缩或重放。实际备份/恢复和新请求证据见[恢复正文回归](../../../../test/isolated/restored-media/read.test.ts)。发布/reset/commit 的当前 Store 与 owner/CAS 条件保持。

原 `RunRecord.contextSelectionId` 读取具名 Run 创建事务保存的不可变 selection，后续 Session 切换不重标旧 Run。普通 Model/Tool Execution 的 `contextSelectionId` 是结果交付字段，可为 null，不能将它当成原 Model 请求的 selection。实际[typed 来源碰撞测试](../../../../test/isolated/storage/context-compression-history-source.test.ts)先重现 User 被错误排除，再通过原 selected context、完整 sealed Model input、实际 Provider 请求与 Fork 内再次压缩核实修复；它与 compression/fork/lifecycle/restored-media 的五文件 31/429 邻接保持真实 ≥17MiB 原媒体资格。此证据不替代默认 Service 的 checkpoint 摘要递归证明。

排队 Command 与实际输入的最终事务边界由稳定 commit barrier 验证：摘要完整后仅受理 follow-up，Messages 不变时压缩与后继 Run 都完成，后继 Provider 实际收到完整摘要；两个独立 SQL writer 对照分别添加真实 Message/result_ref，均拒绝发布、保原上下文且零下一 Provider。compression/source collision/restored-media 三文件本机 24 tests/298 assertions；实际 TUI 与其他平台仍需对应消费者证据。
