# Ordinary Shell Tools

模型侧提供 `shell_execute/shell_read/shell_wait/shell_stop`。启动统一为 `shell_execute({command, description?, background?, execution_timeout_ms?, filesystem?, network?})`：默认前台等待原 Job 终态，`background:true` 返回同一 Job 的真实 `shell_id`、引用与受理状态，受理不证明启动成功或完成。描述仅供展示，省略沿用命令预览；真实命令、审批、权限与完整原调用继续保留。

新模型不填写 `key` 或 `cancellation`。内部 key 从已持久化的 Tool execution ID 稳定派生；同一逻辑 Tool 重入仍走原 `operations.ensure`，新 Tool 即使命令相同也有独立 Job。返回的 `shell_id` 用于原操作的读取、等待和停止；结果未知时先核原执行，不能通过新调用找回结果。普通模型前后台均使用 attached 取消关系，原父 Command 取消传播保持。旧 `shell.launch` 内部注册、显式 key、nested permissions、timeoutMs 和 detached 契约保留，新模型目录隐藏这些旧参数；历史模型参数的投影使用原封存 descriptor，不按今日目录重写。恢复仍核原配置与执行来源，不为兼容重新派发未知效果。

前台期限 `execution_timeout_ms` 单位毫秒、范围1～3600000；省略不设期限。`background:true` 与期限同时填写在模型 Schema 和执行前参数校验中都失败，不创建 Job。`shell_wait` 的 `wait_timeout_ms` 保持0～30000、默认30000，超时不停止 Job。

`filesystem` 和 `network` 是独立的顶层申请，省略分别为 `workspace_write`、`none`；只填一个不会开放另一个。`network:internet` 包括 localhost、127.0.0.1、::1、局域网和互联网；风险通过不为 `network:none` 申请增加联网能力。`filesystem:full_access` 申请外部写入，不切换 Full 审批模式，也不解除受保护路径。原权限模块统一解析新申请与旧 Job 输入，执行器仍只使用最终接纳的授权证明。description 不进入风险模型输入、命令语义指纹或 Job input；原调用参数和完整性绑定仍保真。

前台期限省略时不设置执行截止时限。显式 `execution_timeout_ms` 从首次观察原 Job 进入 `dispatching/running` 起计算，审批和资源排队的 `planned` 等待不消耗执行预算；主／子 Agent 使用同一前台完成路径。观察派发使用短段等待，会有轮询与宿主调度延迟，不承诺从原生进程实际启动瞬间精确计时或毫秒级硬实时保证。时钟启动后不因后续等待或状态观察而重置；期限到达仍只取消同一原 Job，并继续等待其真实停止证据。未派发就终态拒绝或取消的 Job 直接保留原结果，不误标执行超时。用户取消仍在等待期间生效，不因尚未派发而失去响应。[前台回归](../../test/isolated/tools/shell/foreground.test.ts)使用真实 Runtime／SQLite／POSIX Shell，核人工等待超过执行预算后批准仍只执行一次，以及派发后超预算仍取消并确认原进程组停止；该 POSIX 证据不代替其他平台或完整原生进程树资格。

支持范围请求的宿主为前台／后台入口提供相同指引：默认请求工作区写入／无网络，外部写入或联网须显式申请；审批不扩张申请范围，失败不自动扩权重跑。普通 Full 的有效范围仍由现行模式及硬上限决定。

新默认 Auto 的调用事实、直接脚本读取、风险分类、批准复用和启动前材料复核归[权限 owner](../permissions/README.md)。Shell Tool 本身不解析风险或扩大授权；模型风险通过、人工批准、timeout 继续与实际执行成功分别保存。默认范围、手动／Full 和未知效果沿原合同。

`createShellExtension({job})` is a pure factory containing five ordinary Tools and one trusted `shell.command` Job. `shell.execute` 的前后台及内部旧 `shell.launch` 共用普通 `operations.ensure` 和不可变 own-record OperationRef，不嵌套调用另一个 Tool。 Only the registered Job's `start` may start a process. Import/factory/read/wait never create another manager or restart a cold reference. JSON input contains no cwd, environment, executable or guardian authority.

`shell.read` reads the exact own-record ref through generic scoped `operations.readOutput`; pages have fixed 64-bit output cursors/high water and preserve explicit gaps. `shell.wait` timeout leaves the original Job alive. `shell.stop` saves only a cancel-request receipt and the current durable execution fact; it cannot synthesize stopped from acceptance, leader exit or EOF. Actual supervisor `ended`/`unknown` qualification remains in the Job leaf. Original Command retry is an original operation; a new parent execution cannot rebind the same operation key.

默认宿主装配由 Service 显式选择 macOS host Shell：真实最终权限、固定 Seatbelt 与独占 launchd coalition 覆盖允许 fork／setsid／orphan 的本次子树。原 Job 终态还须完成准确原根 reap、注册清理和 broker 实际 exit/close；完整当前边界及有限历史 evidence 归 [Jobs owner](../jobs/README.md#默认-macos-宿主-shell)。普通 POSIX 工厂的 groupStopped 继续只证明原组，固定 confined 工厂继续 deny-fork。Linux／Windows 当前运行资格按重构计划延后，不从 macOS 结果推定。[Shell 工具测试](../../test/isolated/tools/shell/README.md)分别证明工厂语义与真实 Runtime/SQLite 的引用失败；实际 SDK／guardian 装配证据归 Service 的 `shell-configuration.test.ts`。

本地 `shell/<shell_id>` 记录明确不存在，或记录类型／版本不匹配时，`shell.read/wait/stop` 返回 `failed/shell_reference_not_found`，提示使用原启动回执中的真实 ID。该预查没有启动或取消 Job，普通 Loop 可将失败和同批其他真实结果交给下一次模型纠正。它不重试原命令、不改写目标 Job，也不从反馈字段取得权限。记录读取本身失败、取得原引用后无法核实执行、输出读取或取消异常仍按原未知／失败边界处理，不因错误名称相似而降级。

每次新执行由运行时从原 Tool 身份派生新内部 key，恢复旧输出使用返回的原 `shell_id` 读取；旧可信调用的显式 key 合同保持。`operations.ensure` 确认该 key 已属于其他请求、并在建立新 Command／Job 前返回 `operation_conflict` 时，前台／后台入口均返回准确 `failed`，说明本次没有启动新 Job，并提示先读取原操作。只在这一步捕获这一已知冲突；取得引用后的存储、等待与监督异常，以及实际效果未知，仍按原边界处理。[引用回归](../../test/isolated/tools/shell/reference-runtime.test.ts)核同批正常工具继续、原 Job 不重放、新授权操作可用新 key 执行，以及真实未知不降级。
