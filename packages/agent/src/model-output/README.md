# Model 完整输出

[中立输出链](../model-output.ts)保存实际 Model 的 text、reasoning 和原 ToolCall JSON。普通小响应继续使用 inline 字段；超过 64 KiB 时转为原 Model Execution scope 的不可变 Artifact linked segments。这个阈值只决定存储形态，不拒绝、截断或累计限制响应。每段文本最多 32 KiB JavaScript code units，JSON 精确保留跨段／跨事件的 surrogate；完整 UTF-8 字节计数按拼接后的实际文本计算，不把跨事件 emoji 算成两个替换字符。内容不作为新的权限来源。

Adapter 可在成功 `finish` 携带中立 `continuation: Json`。Core 不解释其中的 Provider 项、加密 reasoning 或调用 ID，不把它变成显示 reasoning、Tool 参数或授权来源；完整成功流才写入同一私有链的分块 continuation，保持 JSON 值。即使可见文本很短，也启用 Artifact 链，因此返回 continuation 的自定义 Runtime 必须提供 Artifact 端口；缺少能力会明确失败，不能静默丢弃状态。取消、流异常、重复调用 ID、截断工具批次及未完成压缩不建立可重放的 continuation。非空纯文本 length 按正常长任务续接保留成功的文本段与其 opaque continuation，下一次请求由新 Model Execution 发起。完整历史按原 Model scope 验证后恢复该字段，跨工具轮次和冷重开继续交给 Adapter；匹配 Provider/模型及 wire 协议由 AI owner 校验。公开输入/输出 Inspector 与 Message 不返回 opaque 内容；公共 Artifact 下载入口拒绝私有 model-body/model-output 引用，即使调用者从回执 hash 推导其 ID，内部完整读取不受影响；输入 bodyHash/bodyBytes 标识去除该私有字段后的公开 request 投影；公开客户端可独立核实该投影，原完整请求及其回执 hash 在私有展开路径验证。显式恢复使用私有完整请求，不从公开 Inspector 投影重放。

只有一个 producer；每次段发布和有限 Store 检查点都被 await，没有无限正文队列。Artifact 使用固定 MIME、完整 hash/size 和准确 Store/Session/subject/Execution scope。新节点封存上一准确 reference 与连续 seq；Worker 收到有限 head、计数和明确不完整的 preview，不反复收到增长全文，也不改变原 Worker 控制／正文容量。完整便利读取受真实内存与平台表示能力限制，不另造 token 或总输出预算。

`ModelOutputReference` 是私有 Store／Core descriptor，不是公共 ArtifactRef。`Store.getModelOutputSnapshot` 在一致读里核原 Model、Run、Command、root work、subject 和 child ancestry，再封存当时准确 head。成功的原 partial Message 保留原 id/seq，原位结算为 complete；没有 partial 时才新建消息，避免已成功后仍留下另一张 incomplete 卡。result 与 Message 指向同一 head，不在 SQL 多列复制全文。最终 SQL 核实际登记 metadata 和已确认的当前检查点；正文文件读取／JSON 解析不进入派发或终态事务。

取消、远端失败或没有完整 finish 时保留已接收、成功发布的 prefix，`complete:false`；不伪造总正文，也不把完整外观的 ToolCall 当成工具授权。ToolCall JSON 可分段，但只有真实成功完整终态和全文校验后才能成为 Loop 的完整调用。尚未确认的持久前缀不自动重放 Model 或工具。Artifact 发布／确认丢失仍按真实未知处理，不把无法登记的内容冒充持久成功。

完整读取按实际原 Execution 派生 authority，逐段核 scope、连续 seq、无循环、hash/size/MIME、严格 UTF-8/闭合 JSON 与内容计数；损坏、错误 scope 或取消不返回成功前缀。历史和下一次 Model 的完整展开由 [Runtime](../runtime.ts)完成，保持原 source ID，不用当前配置、当前模型结果或摘要替代原文。HTTP/Client 的完整正文读取与便携 UI 按需展示由各自 owner 验证；私有 head 不进入公共 DTO，也不把 preview 冒充已加载全文。

同 Loop child 的大最终正文通过原父 carrier Job 的 execution-scope Artifact 返回。Runtime 核真实 carrier/child、父 Execution、原 Operation Command 主体与 root work，再发布完整 UTF-8；Job 结果只保存有限说明和中立 `modelContent` 引用。父 Model 的结果 source 仍为原 carrier/resultRevision，以低权限结果展开全文，不复制 child 历史到父 Session，也不从父 Tool Command 猜 carrier Command。这个读取／发布不创建新 child 或模型调用。[实际父子回归](../../test/isolated/model-output/child.test.ts)核 17MiB、原 carrier scope、完整 tail 与下一父请求的原 source ID；普通结果只读不会消耗第二次调用。

私有 `authorization.review` child 的大输出使用同一次 `getModelOutputSnapshot` 捕获的完整 descriptor，在 Core 沿准确原 Model scope 验到 EOF 后严格解析有限 `decision/reason`。原正文 hash、完整 descriptor 摘要、Model ID 与答案组成[六字段凭据](../authorization-review-output.ts)，发布为原 reviewer Model execution scope 的不可变 Artifact；carrier details 只保存该有限凭据，不暴露私有 head、subject 或 reference。最终 SQL 核原唯一 Run/Model、reviewer/policy/target binding、空 tools、完整当前 descriptor 摘要与凭据登记 hash/size；inline carrier 全文再次解析，或核原 carrier 大正文 Artifact 的准确 scope/hash/bytes/MIME。合法原 JSON whitespace 不需与 canonical answer 字节相等，也不能让后来单独改写的答案获得原全文证明。冷 proof 只核已登记 metadata，不重读 graph、调用 Provider或再发布；实际完整 reader 的 EOF 与文件健康仍是独立检查。凭据注册失败、取消或 descriptor 漂移不建立批准。[实际完整审阅回归](../../test/isolated/execution/authorization-review-complete-output.test.ts)核合法大正文、独立 Ask、一次效果及有限凭据／原描述符／登记元数据故障。

[实际输出回归](../../test/isolated/model-output/output.test.ts)使用临时 SQLite Worker／Artifacts、固定 Model 和本地无害 Tool，验证至少 17 MiB、544 个分块进入下一次实际请求、原 source ID、唯一完整 Message、cold readonly、Unicode 与 ToolCall 参数、取消／失败 prefix、错误 scope／损坏零后续 Provider；测量真实 Store 请求参数，检查单帧有限、部分输出提交总字节不随全文平方增长。本机证据为 macOS，不建立外部付费 Provider 能力、其他平台或发行安装资格；大 child 输出 carrier 由 Runtime owner 另作实际回归。

恢复后，当前连接 Store 与原输出链出处独立校验：公开 snapshot 仍标当前 Store，私有 Store snapshot 从真实 Model/Run/Command 链封存原 `originStoreId`，每段 Artifact 仍核原出处与完整内容。读取旧历史和随后显式新 Run 的展开都通过相同完整链验证；不改写 origin，也不消费旧 planned/unknown 工作。[真实恢复回归](../../test/isolated/restored-media/read.test.ts)覆盖原大输出、大输入、Tool 正文和新 Run；[同 Loop child 回归](../../test/isolated/model-output/child.test.ts)同时核恢复后原 child/body/carrier 来源与新父 Run。

[同一输出回归](../../test/isolated/model-output/output.test.ts)另核超过单段的 opaque continuation、工具调用 ID、关闭重开后的下一用户轮、输入/输出 Inspector 不泄漏，以及不完整 finish 零工具派发和无 continuation。测试使用固定 Adapter 与本地 SQLite/Artifact，不调用付费 Provider。
