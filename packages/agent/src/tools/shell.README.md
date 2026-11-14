# Ordinary Shell Tools

模型侧提供 `shell_execute/shell_read/shell_wait/shell_stop`。启动统一为 `shell_execute({command, description?, background?, execution_timeout_ms?, workdir?, filesystem?, network?})`：默认前台等待原 Job 终态，`background:true` 返回同一 Job 的真实 `shell_id`、引用与受理状态，受理不证明启动成功或完成。描述仅供展示，省略沿用命令预览；真实命令、审批、权限与完整原调用继续保留。

新模型不填写 `key` 或 `cancellation`。内部 key 从已持久化的 Tool execution ID 无损派生为 `sh_` 短句柄，当前 UUID 对应26字符，不建别名表或旧摘要读取分支；同一逻辑 Tool 重入仍走原 `operations.ensure`，新 Tool 即使命令相同也有独立 Job。返回的 `shell_id` 用于原操作的读取、等待和停止；`execution_id` 是原启动 Tool 的执行记录 ID，用于查询执行证据或引用计划进度，后台受理不因此证明执行成功。模型要等待已受理的后台命令时沿原 `shell_id` 调用 `shell_wait/read`；即使首次选择后台不符合任务要求，也不能为了改成前台再执行原命令。前台、后台和内部 `shell.launch` 一致提供两种身份；后续 read/wait/stop 的可信模型反馈仍显示原启动 Tool 的 `execution_id`，不把查询 Tool 或内部 Job 身份冒充原调用。模型呈现先核原 owner、引用和身份，不改写 stdout／stderr。结果未知时先核原执行，不能通过新调用找回结果。普通模型前后台均使用 attached 取消关系，原父 Command 取消传播保持。旧 `shell.launch` 内部注册、显式 key、nested permissions、timeoutMs 和 detached 契约保留，新模型目录隐藏这些旧参数；历史模型参数的投影使用原封存 descriptor，不按今日目录重写。恢复仍核原配置与执行来源，不为兼容重新派发未知效果。

`workdir` 只改变本次命令的真实工作目录，省略使用固定 Session cwd。相对值以该 cwd 解析；目录必须真实存在。风险材料、目录身份、命令语义指纹、父 Tool→Job 证明及最终原生执行均绑定该目录；后续调用和 Files 路径不会因此改变。每个动态目录 Job 的 handle 仍交回创建它的原执行器观察、停止和释放。 会话命令 grant 绑定解析后的目录路径与设备/inode 身份；Tool→Job 父授权继承还比较包含目录身份的语义 review key；Job 启动前将当前身份对应的命令摘要与最终 Store 授权快照逐叶核对，已变化则拒绝启动。此核对不持有 OS 目录句柄，不保证最后一次核对到原生进程打开 cwd 之间的原子性。

模型结果中的 `execution_id/cancellation_execution_id` 使用原 ID 的无损短表示，计划进度与执行证据入口准确解码。原 Store 回执仍保存原 ID；不做前缀搜索、近似纠错或选择最近调用，也不改变 Shell 身份与派发次数。

`shell_execute` 指导模型优先使用 `rg` 和 `rg --files`。普通 Shell 的 [输出采集](shell-output.ts) 共用 Store 的 1 MiB JSON／记录预算，在运行中发布稳定前缀，随后有界保留最近输出，在原终态前按顺序发布省略量和尾部。标准输出和错误输出共用预算；两个流的省略字节分别保存。Git 工作树的受信 worker 继续使用完整帧读取。Store 和旧记录合同见 [Jobs owner](../jobs/README.md)。

`shell_execute` 和 `shell_read` 接受可选 `max_output_tokens`，它仅影响送入模型的输出预览，不进入 Shell Job 参数、命令授权摘要或运行时输出采集。默认 10,000，按每 token 4 个 UTF-8 字节估算，并与已知的所选模型输入容量取小。原回执、退出状态、Shell 引用、分页位置和采集省略量继续可读。已截断的读取页可用同一输入游标减小 `limit` 重新读取，读取操作不启动命令。验证见 [Shell 回归](../../test/isolated/tools/shell/unified-entry.test.ts)。

`shell_read({shell_id,cursor?,limit?})` 的 cursor 绑定原 Job 和流位置；`caught_up` 只表示读到当前水位，`terminal` 才表示原执行终态，暂时无输出不表示完成。`shell_stop({shell_id})` 由宿主按原取消 Tool 稳定派生 command 身份，结果同时保原启动 `execution_id` 和独立 `cancellation_execution_id`；请求取消不冒充进程已停止，也不重放命令。`shell_wait({shell_id,wait_ms?})` 仅观察，期限到达不取消业务。

前台期限 `execution_timeout_ms` 单位毫秒、范围1～3600000；省略不设期限。`background:true` 与期限同时填写在模型 Schema 和执行前参数校验中都失败，不创建 Job。`shell_wait` 的 `wait_ms` 保持0～30000、默认30000，超时不停止 Job。

`filesystem` 和 `network` 是独立的顶层申请，省略分别为 `workspace_write`、`none`；只填一个不会开放另一个。`network:internet` 包括 localhost、127.0.0.1、::1、局域网和互联网；风险通过不为 `network:none` 申请增加联网能力。`filesystem:full_access` 申请外部写入，不切换 Full 审批模式，也不自动扩大实际执行范围。默认普通宿主不再额外遮挡 Profile、配置、认证、controlBase 或整目录运行资产；自定义显式保护及 confined 宿主仍沿其原约束。原权限模块统一解析新申请与旧 Job 输入，执行器仍只使用最终接纳的授权证明。description 不进入风险模型输入、命令语义指纹或 Job input；原调用参数和完整性绑定仍保真。

前台期限省略时不设置执行截止时限。显式 `execution_timeout_ms` 从首次观察原 Job 进入 `dispatching/running` 起计算，审批和资源排队的 `planned` 等待不消耗执行预算；主／子 Agent 使用同一前台完成路径。观察派发使用短段等待，会有轮询与宿主调度延迟，不承诺从原生进程实际启动瞬间精确计时或毫秒级硬实时保证。时钟启动后不因后续等待或状态观察而重置；期限到达仍只取消同一原 Job，并继续等待其真实停止证据。未派发就终态拒绝或取消的 Job 直接保留原结果，不误标执行超时。用户取消仍在等待期间生效，不因尚未派发而失去响应。[前台回归](../../test/isolated/tools/shell/foreground.test.ts)使用真实 Runtime／SQLite／POSIX Shell，核人工等待超过执行预算后批准仍只执行一次，以及派发后超预算仍取消并确认原进程组停止；该 POSIX 证据不代替其他平台或完整原生进程树资格。

支持范围请求的宿主为前台／后台入口提供相同指引：默认请求工作区写入／无网络，外部写入或联网须显式申请；审批不扩张申请范围，失败不自动扩权重跑。普通 Full 的有效范围仍由现行模式及硬上限决定。

新默认 Auto 的调用事实和直接脚本读取复用[权限 owner](../permissions/README.md)的 Shell 领域实现；[Shell 行为工厂](shell-approval.ts)随准确执行定义提供审核材料、指引、风险输出解释和同命令候选，再由可信宿主登记。材料保完整命令与执行事实，模型 description 不成为风险依据。ordinary/high/critical 由 Shell owner 映射为统一 approve_once/ask_user/reject；核心和 SQLite 不重新解析领域风险文本。显式自定义 checker 不被替换为该风险解释器。

同命令 scope 原样包装现有完整可信 commandDigest，不引入 trim、前缀、别名或脚本等价。有效同命令授权可以满足默认审核，独立 checker、固定危险拒绝和当前权限继续核验。Shell owner 比对真实父定义、命令与规范化范围后构造自身 Job 的 parentProof，并绑定原父 Execution/inputDigest。Tool 的执行期限与 cancellation 保留原完整调用和 ensure 来源。默认风险审核超时结束本次调用，原 Tool 无派发和后续 Job。启动前材料复核只消费已接受的 materialReviewed 事实。

`createShellExtension({job})` is a pure factory containing five ordinary Tools and one trusted `shell.command` Job. `shell.execute` 的前后台及内部旧 `shell.launch` 共用普通 `operations.ensure` 和不可变 own-record OperationRef，不嵌套调用另一个 Tool。 Only the registered Job's `start` may start a process. Import/factory/read/wait never create another manager or restart a cold reference. JSON input contains no cwd, environment, executable or guardian authority.

`shell.read` reads the exact own-record ref through generic scoped `operations.readOutput`; pages have fixed 64-bit output cursors/high water and preserve explicit gaps. `shell.wait` timeout leaves the original Job alive. `shell.stop` saves only a cancel-request receipt and the current durable execution fact; it cannot synthesize stopped from acceptance, leader exit or EOF. Actual supervisor `ended`/`unknown` qualification remains in the Job leaf. Original Command retry is an original operation; a new parent execution cannot rebind the same operation key.

默认宿主装配由 Service 显式选择 macOS host Shell：真实最终权限、固定 Seatbelt 与独占 launchd coalition 覆盖允许 fork／setsid／orphan 的本次子树。原 Job 终态还须完成准确原根 reap、注册清理和 broker 实际 exit/close；完整当前边界及有限历史 evidence 归 [Jobs owner](../jobs/README.md#默认-macos-宿主-shell)。普通 POSIX 工厂的 groupStopped 继续只证明原组，固定 confined 工厂继续 deny-fork。Linux／Windows 当前运行资格按重构计划延后，不从 macOS 结果推定。[Shell 工具测试](../../test/isolated/tools/shell/README.md)分别证明工厂语义与真实 Runtime/SQLite 的引用失败；实际 SDK／guardian 装配证据归 Service 的 `shell-configuration.test.ts`。

本地 `shell/<shell_id>` 记录明确不存在，或记录类型／版本不匹配时，`shell.read/wait/stop` 返回 `failed/shell_reference_not_found`，提示使用原启动回执中的真实 ID。该预查没有启动或取消 Job，普通 Loop 可将失败和同批其他真实结果交给下一次模型纠正。它不重试原命令、不改写目标 Job，也不从反馈字段取得权限。记录读取本身失败、取得原引用后无法核实执行、输出读取或取消异常仍按原未知／失败边界处理，不因错误名称相似而降级。

每次新执行由运行时从原 Tool 身份派生新内部 key，恢复旧输出使用返回的原 `shell_id` 读取；旧可信调用的显式 key 合同保持。`operations.ensure` 确认该 key 已属于其他请求、并在建立新 Command／Job 前返回 `operation_conflict` 时，前台／后台入口均返回准确 `failed`，说明本次没有启动新 Job，并提示先读取原操作。只在这一步捕获这一已知冲突；取得引用后的存储、等待与监督异常，以及实际效果未知，仍按原边界处理。[引用回归](../../test/isolated/tools/shell/reference-runtime.test.ts)核同批正常工具继续、原 Job 不重放、新授权操作可用新 key 执行，以及真实未知不降级。

`git_worktree` 由同一个 `builtin.shell` Extension 的 `git.worktree@1` 提供，只有 `list/create/remove`；选中它也装配内部 `shell.command@1`，不会连带开放模型 Shell。实际算法、冻结意图、原 ref 恢复和删除保护见 [Worktree owner](git-worktree/README.md)。普通 Shell 的参数、版本、前后台和取消契约保持。

可信 Worktree 命令的环境允许集合、Bun `--no-env-file --config=<path>` 和受保护资产在首个解释器前生效；普通命令继续原路径。Full 下该 worker 的实际范围仍不超过本次请求，network 固定 none。缺少 scope-aware host 的 legacy POSIX 装配只提供 list；自定义 zsh 等启动环境不获得该能力。

2026-11-06，起始 `8e350f99` 加本轮差量，macOS arm64／Bun1.4.4／Git2.54.0：[Service 真实链路](../../../../apps/service/test/isolated/git-worktree-configuration.test.ts)2项76断言通过，核只选择该工具、真实三个 action、工作区外默认范围拒绝、明确 full_access 后成功、分支保留、来源内容/cwd不变、原 key 重放保留重建实体。worker 与恢复故障测试见[测试入口](../../test/isolated/tools/git-worktree/README.md)。Linux/Windows 实机和完整三平台发行资格未取得。

可信worker在首层输出解码时拒绝非法或截断UTF-8，不能让替换字符掩盖输出损坏；普通Shell原二进制/替换字符行为不变。[真实原生回归](../../test/isolated/tools/git-worktree/launch-security.test.ts)同时核合法U+FFFD和原监督停止证明。macOS只读发现并封存系统native Git，不使用会向沙箱外写xcrun缓存的Apple调度桩，也不通过额外写范围放行它。

模型指导要求 Git 工作树创建只调用 `git_worktree`，省略 path 使用持久默认根，不通过 Shell／脚本兜底。普通 Shell 不增加工作树 AST 硬拦截，无法据此承诺拦截任意程序间接创建；临时目标的实际拒绝由 Worktree Tool／worker 执行。非常危险系统级命令的现有兜底保留。
