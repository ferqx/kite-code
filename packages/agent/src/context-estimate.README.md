# 上下文统计与预算

本页负责 Core 的统计口径、基线验证与只读预测。产品承诺见[模型与配置](../../../docs/handbook/features/models-and-configuration.md)，TUI 操作见[上下文指南](../../../docs/handbook/clients/tui/guides/context-and-compaction.md)。

## 三种数值

- 累计实际用量：`Store.getSessionTokenUsage` 汇总准确当前 Store、Session 的原 Model 终态记录，包括摘要、失败、取消和未知结果中已收到的统计。输入已包含缓存，不能再次相加；每个原 Execution 只计一次。SQL 只读 usage 叶子，不受当前 View 的最近 200 项限制，不纳入继承／其他 Session 的消费。只求和合法已报告值，缺失以 `missingInputCount/missingOutputCount` 表达；全缺失或安全整数求和溢出时数量不可用，零仍有效。缓存完整且输入完整时才提供累计缓存分子。
- 最近请求实际输入：原 Execution 的 `usage.inputTokens`；本地数量不回填此字段，也不从输出、推理或累计数反推。失败和取消保留已收统计。原请求的完整本地估算单独保留。
- 下一请求上下文估算：`projectModelContext` 使用同一路由的已测量原输入，加上当前请求中新出现的消息、调用和工具结果的通用估算。原输入、工具声明和顺序必须能核实；来源尾块前的新增消息也可识别。删除、改写、重排、工具变化或模型不一致时，全量本地重估。输出／推理的报告数不直接相加，因为隐藏推理或未采用的输出不一定成为后续输入。

所有提供商共享这些接口。模型名不选择分词器；未知、自定义与 opaque 模型保留原有分块 cl100k 回退。估算包含消息 framing，不能作为账单、精确窗口证明或派发许可。

## 基线与只读观察

Runtime 在普通 Loop 安全边界由最近已完成的 assistant 原 Execution 读取完整原输入，核 Store、Session、模型及原结果；跨 Run 还要求冻结模型配置一致。Core 向可信 `CompressionInput` 传 `modelId/tools/tokenBaseline`，默认 Service 直接使用此时实际工具声明。窗口缺省为 256K（262144 token），模型明确声明优先；默认阈值为总窗口 75%，配置 `compression.thresholdTokens` 时采用该准确 token 数覆盖比例。默认值由 Service 在实际选中模型的 Run 配置中冻结，Core 统计叶子仍不猜 Provider 容量。压缩后旧历史不再匹配时重新估算，新请求返回统计后形成新基线。摘要快照记录 `tokenAccounting/tokenProjection` 和 `automaticPolicy`，仅保存计数、阈值和出处，不复制基线正文。

`AgentRuntime.readContextEstimate` 是有资源生命周期的只读观察：按原 Model 输入权限展开完整所选历史，保留固定 selection/upper，复核压缩点和选择未变化；不捕获新项目指令、不解析现在配置、不初始化 Provider、不写 Store。来源布局沿最近已保存请求，因此只是基于已保存来源和历史的预测，随后配置、工具、来源或尚未提交输入仍可能使实际请求不同。冷恢复可重建，不保存估算为消费事实。工具呈现校验只约束实际进入历史的工具结果；未使用工具的注册定义在 Run 结束后释放，不使普通回复的估算失效。真正使用的工具仍须核原执行身份、结果与封存正文，不为预测重新装配动态能力。Core复用原模型请求中已经封存的工具正文，并核对既有Store／Session／Run、调用、消息来源及不可变终态结果；不新增metadata字段，不改变统计数据结构，不重新执行工具或调用现在的格式器。主／子Agent及Run／step工具共用该通用路径，新增工具无需登记。相同事实在运行中、结束后和重启后保持同一统计口径；确实缺少原请求或来源冲突时才不可估算。取舍见[封存输入与事实一致性](../../../.agents/notes/implemented/bug-fix/2026-11-09-context-estimate-sealed-input-consistency.md)。

轨迹中的压缩对比另由可信算法在原冻结输入／真实摘要验证时提供并在发布事务封存，详见[压缩 owner](storage/sqlite/context/compression.README.md)。`triggerBasis:'reported_baseline'` 是原基线与新增估算之和；`accounting.basis:'local-context-estimate-v1'` 的前后值使用相同本地算法，after 包括替换后完整固定来源／工具／保留输入及摘要。它们均不与压缩 Model 的 usage 混用，也不调用当前 `readContextEstimate` 回补历史缺值。

公开查询为 `GET /v1/sessions/{id}/context/estimate?storeId=...&executionId=...`，主体来自宿主，闭合 query 不接受文件路径或回调。响应保留原请求、模型、selection、upper 和 cursor，分别提供测量／新增／总预测及累计覆盖情况。Client 核目标与计数关系；错误或不同 scope 不发布结果。UI 动态预测随观察更新，不同模型的下一次选择不能继承原比例。没有新增 SQL migration，也未替换原实际输入 API。

## 验证

[通用工具结果冷读](../test/isolated/context/result-presentation-estimate.test.ts)覆盖任意Run／step工具无注册器冷读、当前格式器变化不重解释原正文、原结果正文／终态／来源冲突拒绝，以及metadata字段不变和冷读前后计数相等；[子Loop](../../../apps/service/test/isolated/child-configuration.test.ts)核每步使用子会话实际工具与预算，完成后只读估算不增加Provider调用。

[纯投影与累计反例](../test/context/context-projection.test.ts)核插入、来源／历史／工具／模型失效、零、缺失和溢出；[真实 Core、SQLite、HTTP 与冷只读](../../../apps/service/test/isolated/context-token-estimate.test.ts)核实测改变压缩决策、零防止旧全量估算误触发、未知模型、缺失统计、三种数值及 205 次真实本地模型调用超过有限 View 后的完整累计。付费 Provider 与其他平台资格不由这些夹具推导。
