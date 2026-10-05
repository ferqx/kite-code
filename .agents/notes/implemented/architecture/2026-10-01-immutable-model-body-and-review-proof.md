# Agent Note: 不可变完整 Model 正文与实际审核输入证据

Status: implemented

## Problem

通用 Agent 的文件、来源和自动审核必须保留有效完整内容。直接把大正文放进有限 Worker 帧，会在真实 Model 调用前把合法输入拒绝；只传摘要或公开 Artifact 引用，又不能证明 Provider 实际读过原内容。自动审核若依赖 Model 自报的输入 hash 或 child 成功文本，还可能把错误来源、损坏附件或未完成的实际调用误当成许可。

这项决定适用于新 `packages/agent` 的正文交接与 Auto 审核，不表示正式客户端、旧业务 carrier 和三平台发行已经完成切换。产品目标与边界来自[统一方案](../../../../docs/plans/unified-agent-refactor-v1.md)及[当前执行边界](../../../../docs/active/unified-agent-boundary.md)。

## Decision

Tool 的完整 Model 内容使用中立 `ToolResult.modelContent` Artifact 引用。Core 根据真实原 Execution/Command 推导 Store、Session、subject 和 scope，核对 metadata、完整大小、SHA256 和严格 UTF-8，再把原 summary/metadata 与完整正文一起交给 Provider；公开引用本身不授予读取权。

大 Model 请求、决策来源与 Auto 请求以版本 1 的 `ModelBodyReference` 指向准确原 Session scope 的不可变完整 canonical JSON。64 KiB 只决定传输路径，不是内容拒绝、裁剪或累计 Run 额度。实际 requestId/modelId、来源摘要和工具身份保存在有限 header，完整 sources 与请求保存在正文。Provider I/O 前重新完整展开并核对身份，实际成功 Model 回执保存 `inputBodyHash`。冷查询保持原 scope，不重新标 Store 或重跑旧 carrier。

SQLite 的 Model body 校验只在短事务中核已登记的 ref/hash/size/MIME、原主体与 scope，不在业务事务中读取完整文件或解析完整 JSON。Artifact 登记的字节核验先于登记事务，事务再核身份及 metadata。当前登记仍由 Worker 同步读取字节；它不构成大文件控制延迟资格。

Auto 继续使用唯一 Loop、共享 Model 槽、无 Tool/额外来源的专用 child，并限制为一个实际 Model 调用。审核原文从真实原命令、根工作、目标输入/来源及同组成功 Model 派生；Core 封存 carrier 的审核绑定 digest。最终 SQL 许可核对这个绑定、实际输入 hash、唯一成功 Model、completed child、succeeded carrier 与闭合输出。公开请求不能声明审核 proof，也不能开放 planned 父执行的通用绕过入口。

大请求的人工回退卡保存完整原请求的真实公共 Artifact 附件引用，并继续绑定原 Execution/attempt、定义、输入 digest、来源与 policy revision。引用不替代完整内容阅读；客户端完整加载和审批资格由对应 UI owner 验证。

同一机制也用于实际人工 minimum:user 审批：当完整 input/policy 超出有限卡预算，可信 Core sealer 将整个原展示请求发布到准确 Execution scope Artifact，卡复用policy.review完整附件协议。接受及最终授权重新核原注册/hash/size/scope、严格UTF-8/JSON和当前准确input/definition/policy；same revision替换policy也不允许。ref ID包含原Execution摘要，相同正文hash的两次请求不会冲突或共用旧许可。原卡32KiB/2048节点/16层边界保持，原Execution.input完整保存。

每个新 Model 请求封存实际 adapter/provider family、支持的 settings、实际 capabilities/version/digest、原来源顺序与摘要。最终授权和 controlReads 来自实际 dispatch 守卫；opaque、未记录和未来 metadata 保持明确不可用，不用现在配置填历史。超过 64KiB 的 metadata 使用相同原 scope 完整正文，不扩大 SQL/Worker 帧。

大 Model 输出使用准确原 Execution scope 的版本化不可变 linked segments，固定单段正文量；追加只写新 segment 和有限 head，不重复写越来越大的全部 prefix。text/reasoning/Tool arguments 都保留完整原数据，读者核全部链、序号、UTF-8、大小与 hash。实际成功把原 partial Message 提升为完整消息，失败/取消保留不完整前缀，不从截断 Tool 参数派发。下一 Model 必须读到完整成功输出，公开消息只携 outputBody 摘要；具名 readonly getter 展开原 head 后提供完整 snapshot，不把私有引用交给 renderer。

child 的完整大结果以原父 carrier Execution scope 的不可变 Artifact 返回；原 Operation Command 与 parent Tool/root Run Command 的身份各按其实际血缘核验，不假定 ID 相同。父下一 Model 仍保留原 carrier source ID 和完整低信任正文，不复制 child 历史或另建结果 manager。Native main/preload 复用公共 SDK，用有限 IPC chunks 传同一 snapshot，renderer 再用 Client verifier 核完整 EOF/hash/身份；视图关闭只取消自己的读取。


## Alternatives considered

- 提高或移除 Worker 帧预算：未采用。它不能解决无限正文，也会让控制与正文争用解析、排队和内存；保留有限通信并交接不可变正文能维持准确内容。
- 只让 Model 看到摘要或 Artifact ref：未采用。它会丢失有效约束、文件 baseline 和实际审核任务，不能证明完整内容进入真实调用。
- 在 SQL 派发事务中读文件、核完整 hash 并解析 JSON：实施核对时移出。长正文 I/O 会扩大唯一写事务和控制等待；SQL 保留最终身份与 metadata 守卫，Core I/O 保留完整语义校验。
- 让 reviewer 文本自报 proof，或由权限模块直接调用 Model：未采用。文本不能证明实际输入与持久血缘；直接调用会绕过统一执行、记录、取消和 Model 槽。当前 proof 来自实际 carrier、child 和成功 Model 记录。

## Consequences

17 MiB 级 Tool 正文、来源和 Auto 请求可完整进入固定 Provider，有限 Worker 队列不因此提高或裁剪内容。损坏、错 scope、取消和缺失能力在真实 Provider 前局部失败。Files summary 与展开正文同时保留，调用者仍可取得实际 baseline。人工回退仍是准确原调用的等待，而不是摘要批准。

这项决定延续[累计额度移除](2026-09-30-run-cumulative-limits-removed.md)中完整内容不受任意本地门槛裁剪的目标，但不复用旧 Kernel/Host ledger、旧格式升级或临时 spool authority。旧 Note 的已实施路径仍仅描述旧执行线；本 Note 不宣称已将其全面替代或退役。

验证入口为[完整正文回归](../../../../packages/agent/test/isolated/model-body/model-body.test.ts)、[Auto 审核回归](../../../../packages/agent/test/isolated/execution/authorization-review.test.ts)、[Files 大正文](../../../../packages/agent/test/isolated/files/large.test.ts)和[默认审核装配](../../../../apps/service/test/isolated/auto-configuration.test.ts)。本机 macOS 的 Body/Artifact/Auto/Files 组合 29 tests、209 assertions 与默认 Auto/permissions 11 tests、137 assertions 通过；完整机制由[正文 owner](../../../../packages/agent/src/model-body/README.md)维护。

完整 JSON/字符串便利 API 仍受真实内存和平台表示能力约束，外部 Provider 的真实窗口仍生效。Worker 登记的大文件调度延迟、其他平台和独立安装资格没有由上述本地固定 Provider 回归证明。后续 [输出 owner](../../../../packages/agent/src/model-output/README.md)的 Core/Body/Inspector/metadata 组合 24/218、实际 17MiB HTTP 1/39、Client 3/31、实际 child carrier/Runtime 9/110、UI/Web DOM 12/100，以及真实 macOS Electron 18MiB 末尾与单次 Provider 证明各自范围。完整附件的实际 DOM 与 paired 输入也已有独立证据，但它们不代替正式 TUI/所有 Native 管理页面或完整发行资格。当前 wire/IPC 有限分块，main、Core、Client 与 renderer 的便利 API 仍可能保留完整 bytes/字符串。

后续完整人工请求的[真实回归](../../../../packages/agent/test/isolated/execution/approval-body.test.ts)以超过240KiB input和70KiB policy证明完整尾部、两次独立scope、实际接受、同revision policy变化及附件字节损坏零效果；相关9file63/536、model-body8/53通过。新CLI/TUI Workflow question与独立审批已有各自资格，完整附件consumer的支持范围仍以实际客户端证据为准；不外推其他平台或整轮V1.3。
