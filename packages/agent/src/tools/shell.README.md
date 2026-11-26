# Ordinary Shell Tools

模型侧使用 `exec_command(cmd,workdir?,yield_time_ms?,max_output_tokens?,description?,filesystem?,network?)`、`poll_command(session_id,yield_time_ms?,max_output_tokens?)` 和 `terminate_session(session_id)`。每次启动创建原受管 Job，返回会话内整数 ID、当前状态及已留存输出。启动和续读默认等待 1000ms，允许 0 至 30000ms。原受管命令为非交互，stdin 由宿主关闭。可选 `description` 随原调用保留，桌面会话工具行显示原命令摘要。

新模型不填写 `key` 或 `cancellation`。内部 key 从已持久化的 Tool execution ID 无损派生为 `sh_` 短句柄，当前 UUID 对应26字符，不建别名表或旧摘要读取分支；同一逻辑 Tool 重入仍走原 `operations.ensure`，新 Tool 即使命令相同也有独立 Job。返回的 `shell_id` 用于原操作的读取、等待和停止；`execution_id` 是原启动 Tool 的执行记录 ID，用于查询执行证据或引用计划进度，后台受理不因此证明执行成功。模型要等待已受理的后台命令时沿原 `shell_id` 调用 `shell_wait/read`；即使首次选择后台不符合任务要求，也不能为了改成前台再执行原命令。前台、后台和内部 `shell.launch` 一致提供两种身份；后续 read/wait/stop 的可信模型反馈仍显示原启动 Tool 的 `execution_id`，不把查询 Tool 或内部 Job 身份冒充原调用。模型呈现先核原 owner、引用和身份，不改写 stdout／stderr。结果未知时先核原执行，不能通过新调用找回结果。普通模型前后台均使用 attached 取消关系，原父 Command 取消传播保持。旧 `shell.launch` 内部注册、显式 key、nested permissions、timeoutMs 和 detached 契约保留，新模型目录隐藏这些旧参数；历史模型参数的投影使用原封存 descriptor，不按今日目录重写。恢复仍核原配置与执行来源，不为兼容重新派发未知效果。

`workdir` 只改变本次命令的真实工作目录，省略使用固定 Session cwd。相对值以该 cwd 解析；目录必须真实存在。风险材料、目录身份、命令语义指纹、父 Tool→Job 证明及最终原生执行均绑定该目录；后续调用和 Files 路径不会因此改变。每个动态目录 Job 的 handle 仍交回创建它的原执行器观察、停止和释放。 会话命令 grant 绑定解析后的目录路径与设备/inode 身份；Tool→Job 父授权继承还比较包含目录身份的语义 review key；Job 启动前将当前身份对应的命令摘要与最终 Store 授权快照逐叶核对，已变化则拒绝启动。此核对不持有 OS 目录句柄，不保证最后一次核对到原生进程打开 cwd 之间的原子性。

模型结果中的 `execution_id/cancellation_execution_id` 使用原 ID 的无损短表示，计划进度与执行证据入口准确解码。原 Store 回执仍保存原 ID；不做前缀搜索、近似纠错或选择最近调用，也不改变 Shell 身份与派发次数。

[共享系统提示](../model-context.ts)的基础工作方式段指导模型用 `rg` 搜正文、用 `rg --files` 找文件，命令不可用时选用适合当前 Shell 的替代方式。工作环境段标注随包 `rg` 的版本，并说明 PowerShell 下给 `rg` 传目录、用 `-g` 筛选文件。普通 Shell 的 [输出采集](shell-output.ts) 共用 Store 的 1 MiB JSON／记录预算，在运行中发布稳定前缀，随后有界保留最近输出，在原终态前按顺序发布省略量和尾部。标准输出和错误输出共用预算；两个流的省略字节分别保存。Git 工作树的受信 worker 继续使用完整帧读取。Store 和旧记录合同见 [Jobs owner](../jobs/README.md)。

交付成品时，随包文档 helper 的 `stage` 将已保存的文件复制到当前 Job 的 `KITE_OUTPUT_DIR`，并通过标准输出向模型提供实际绝对路径和可直接用于 Markdown 的路径。随后的模型请求沿现有工具结果读取回执，归档沿原 Job 终态独立执行。 [交付命令](documents/README.md#成品路径与交付)

宿主把实际选中的方言、已核验版本、可用的 Windows 用户区域和 UTF-8 解码信息交给共享系统提示。PowerShell 的版本来自本次安装发现，Desktop／Core 指引依据真实 edition 或安装布局。工具概述说明 Job 生命周期和原句柄的用法，前后台选择、执行时限和具体权限申请由对应参数说明。诊断指引优先采用退出状态和结构化输出。任务指定语言或区域时，使用实际程序提供的选项。 [Windows Job 运行环境](../jobs/README.md#默认-windows-git-bash)

Windows 工具说明要求在同一个 Shell 中解析路径并执行删除或移动。递归删除或移动前，模型核对解析后的绝对目标是否位于工作区或用户明确授权的目录。PowerShell 通过原生 cmdlet 的 `-LiteralPath` 接收路径。用 `Start-Process` 启动后台辅助程序时使用 `-WindowStyle Hidden`，用户明确要求可见交互窗口时按请求执行。

原 Windows Job 的已结算查找失败回执可携带命令名与候选路径。模型展示核对原 Job 和终态身份后，提供候选绝对路径、来源及单独核验可执行文件和运行时的提示。原命令退出码、双流内容和授权证据继续归该次执行回执。依赖本地进程状态的工作先选定磁盘保存点，同次调用完成修改、保存和关闭，后续调用从磁盘重新打开核对。 [模型结果回归](../../test/isolated/tools/shell/model-presentation.test.ts)

受限 Windows PowerShell 辅助进程指引要求在原 Job 内保存并关闭，提示提前选择程序支持的单进程模式。确需访问受拒的双向本地命名管道时，模型可以通过原授权入口为该条命令申请 `filesystem:full_access` 并保持 `network:none`。共享冲突后先核落盘结果并确认文件已释放，再发起下一次调用。 [原生实机对照](../jobs/README.md#默认-windows-git-bash)

原命令及其子进程结束后，打开的编辑会话和仅在进程内的未保存状态不能留给后续 `shell_execute`。后续调用重新打开已保存的工作区文件，每组编辑、保存和关闭在同一个仍运行的命令内完成。模型反馈只有核对原操作的准确终态且 `cleanupConfirmed`、`processTreeStopped` 均为 true 时，才说明进程作用域已结束、从落盘文件继续；不根据进程峰值或外层 Runner 的终止请求猜测有多少驻留进程。反馈由现有呈现层追加，原回执、输出与审批决定保持。[原 Loop 回归](../../test/isolated/tools/shell/unified-entry.test.ts)覆盖确认与未确认清理、后续模型输入、一次派发和原始结果不变。

`shell_execute` 和 `shell_read` 接受可选 `max_output_tokens`。默认 10,000，按每 token 4 个 UTF-8 字节估算，并与原 Run 中冻结的模型输入容量取小。工具在写入前形成输出段，写到 `content` 后由原 Run 的模型和桌面复用。后续模型请求的容量更小时，在构建该次请求时进一步限制历史 Shell 输出，保存的输出段仍供桌面读取。前台沿原 Job 的固定水位读取各页，和 `shell_read` 共用[输出投影](../../../trajectory/src/shell-output-preview.ts)。投影按记录顺序直接拼接两路内容块，保留原始换行。模型反馈用空行分隔状态与输出，退出码来自原 Job 的结果。轨迹证据沿已验证的 `outputFormat` 显示保存的输出段。输出中的缺口说明计入输出预算。新保存回执另存 `outputGaps` 的流与缺失字节数（未知为 `null`），再次缩小模型预算时依据这些结构化事实保留提示，不从正文猜测缺口。新回执的 `details` 保留退出状态、原 Shell 引用、游标和省略量等事实，不再复制原 stdout／stderr 或整页输出。旧回执仍按原参数和读取端的模型预算计算预览。接下来的 `shell_read` 通过原 Job 的有界输出记录续读。用同一输入游标减小 `limit` 可重新读取该页，无需重启命令。验证见 [Shell 回归](../../test/isolated/tools/shell/unified-entry.test.ts)。

`shell_read({shell_id,cursor?,limit?})` 的 cursor 绑定原 Job 和流位置；`caught_up` 只表示读到当前水位，`terminal` 才表示原执行终态，暂时无输出不表示完成。`shell_stop({shell_id})` 由宿主按原取消 Tool 稳定派生 command 身份，结果同时保原启动 `execution_id` 和独立 `cancellation_execution_id`；请求取消不冒充进程已停止，也不重放命令。`shell_wait({shell_id,wait_ms?})` 仅观察，期限到达不取消业务。

前台期限 `execution_timeout_ms` 单位毫秒、范围1～3600000；省略不设期限。`background:true` 与期限同时填写在模型 Schema 和执行前参数校验中都失败，不创建 Job。`shell_wait` 的 `wait_ms` 保持0～30000、默认30000，超时不停止 Job。

`filesystem` 和 `network` 是独立的顶层申请，省略分别为 `workspace_write`、`none`；只填一个不会开放另一个。`network:internet` 包括 localhost、127.0.0.1、::1、局域网和互联网；风险通过不为 `network:none` 申请增加联网能力。`filesystem:full_access` 申请外部写入，不切换 Full 审批模式，也不自动扩大实际执行范围。默认普通宿主不再额外遮挡 Profile、配置、认证、controlBase 或整目录运行资产；自定义显式保护及 confined 宿主仍沿其原约束。原权限模块统一解析新申请与旧 Job 输入，执行器仍只使用最终接纳的授权证明。description 不进入风险模型输入、命令语义指纹或 Job input；原调用参数和完整性绑定仍保真。

内部调用的显式执行期限从原 Job 进入派发或运行后计算。模型入口的 `yield_time_ms` 只控制本次观察时长，时间到后原 Job 继续。用户取消、后台清理和实际停止证明沿原执行路径。

原装 Windows Git Bash 的工具说明明确指出它没有文件或网络沙箱；若任务必须由系统强制窄范围，不应选择它。非完全模式不能把旧 detached 调用转为原装用户进程；正常后台运行仍跟随父操作。其他支持范围请求的宿主在工具说明开头和参数中要求 Agent 先选范围。当前技能所需的执行、验证和交付步骤在任务允许时显式申请 `filesystem:full_access`，遵守用户指定的较窄范围。普通工作区命令使用 `workspace_write`。Windows 本地辅助进程的启动和双向管道可能需要完整文件范围，即使源文件在工作区内。本地文件和管道操作使用 `network:none`。Windows 工作区命令失败且原 Job 确认已清理时，模型反馈标明原实际范围，提示先核实受限原因和落盘效果再申请新调用。执行范围由本次授权、当前模式和硬上限决定。

新默认 Auto 的调用事实和直接脚本读取复用[权限 owner](../permissions/README.md)的 Shell 领域实现；[Shell 行为工厂](shell-approval.ts)随准确执行定义提供审核材料、指引、风险输出解释和同命令候选，再由可信宿主登记。材料保完整命令与执行事实，模型 description 不成为风险依据。ordinary/high/critical 由 Shell owner 映射为统一 approve_once/ask_user/reject；核心和 SQLite 不重新解析领域风险文本。显式自定义 checker 不被替换为该风险解释器。

macOS 正式宿主的请求批准模式将默认人工审批保留在父 Tool：批准只结算这条实际命令，且准确绑定的附着 Job 才可消费父批准。Job 仍独立核验现行权限和原批准证据，并在原派发事务复核。仅此次不留后续授权；已保存的后续范围保留父 Tool 完整命令摘要（含原期限与执行方式），不把 Job 不含的父参数从授权中去掉。未核实的父子关系或独立审批策略按原规则处理。 [macOS Service 端到端回归](../../../../apps/service/test/isolated/shell-configuration.test.ts)覆盖一次批准不重复确认、同会话复用及参数变化后的独立审批。

同命令 scope 原样包装现有完整可信 commandDigest，不引入 trim、前缀、别名或脚本等价。有效同命令授权可以满足默认审核，独立 checker、固定危险拒绝和当前权限继续核验。Shell owner 比对真实父定义、命令与规范化范围后构造自身 Job 的 parentProof，并绑定原父 Execution/inputDigest。Tool 的执行期限与 cancellation 保留原完整调用和 ensure 来源。默认风险审核超时结束本次调用，原 Tool 无派发和后续 Job。启动前材料复核只消费已接受的 materialReviewed 事实。

`createShellExtension({job})` is a pure factory containing five ordinary Tools and one trusted `shell.command` Job. `shell.execute` 的前后台及内部旧 `shell.launch` 共用普通 `operations.ensure` 和不可变 own-record OperationRef，不嵌套调用另一个 Tool。 Only the registered Job's `start` may start a process. Import/factory/read/wait never create another manager or restart a cold reference. JSON input contains no cwd, environment, executable or guardian authority.

`shell.read` reads the exact own-record ref through generic scoped `operations.readOutput`; pages have fixed 64-bit output cursors/high water and preserve explicit gaps. `shell.wait` timeout leaves the original Job alive. `shell.stop` saves only a cancel-request receipt and the current durable execution fact; it cannot synthesize stopped from acceptance, leader exit or EOF. Actual supervisor `ended`/`unknown` qualification remains in the Job leaf. Original Command retry is an original operation; a new parent execution cannot rebind the same operation key.

默认宿主装配由 Service 显式选择 macOS host Shell：真实最终权限、固定 Seatbelt 与独占 launchd coalition 覆盖允许 fork／setsid／orphan 的本次子树。原 Job 终态还须完成准确原根 reap、注册清理和 broker 实际 exit/close；完整当前边界及有限历史 evidence 归 [Jobs owner](../jobs/README.md#默认-macos-宿主-shell)。普通 POSIX 工厂的 groupStopped 继续只证明原组，固定 confined 工厂继续 deny-fork。Linux／Windows 当前运行资格按重构计划延后，不从 macOS 结果推定。[Shell 工具测试](../../test/isolated/tools/shell/README.md)分别证明工厂语义与真实 Runtime/SQLite 的引用失败；实际 SDK／guardian 装配证据归 Service 的 `shell-configuration.test.ts`。

模型会话 ID 映射到唯一原 Job。找不到当前会话记录时返回可纠正的 `shell_reference_not_found`。续读从模型输入中已有的最近同 Job 输出位置继续，按输出上限分页并明确 `has_more` 与 `terminal`。保留区段丢失用原输出间隔提示。记录无法核实或停止效果未知时保留相应状态。

每次新执行由原 Tool 身份绑定内部 key，并用会话记录登记整数 ID。停止意图由宿主派生、提交给原 Job，并返回观测到的状态。未达终态时继续轮询同一会话。旧记录在历史中按其原标识查询。

`git_worktree` 由同一个 `builtin.shell` Extension 的 `git.worktree@1` 提供，只有 `list/create/remove`；选中它也装配内部 `shell.command@1`，不会连带开放模型 Shell。实际算法、冻结意图、原 ref 恢复和删除保护见 [Worktree owner](git-worktree/README.md)。普通 Shell 的参数、版本、前后台和取消契约保持。

可信 Worktree 命令的环境允许集合、Bun `--no-env-file --config=<path>` 和受保护资产在首个解释器前生效；普通命令继续原路径。Full 下该 worker 的实际范围仍不超过本次请求，network 固定 none。缺少 scope-aware host 的 legacy POSIX 装配只提供 list；自定义 zsh 等启动环境不获得该能力。

2026-11-06，起始 `8e350f99` 加本轮差量，macOS arm64／Bun1.4.4／Git2.54.0：[Service 真实链路](../../../../apps/service/test/isolated/git-worktree-configuration.test.ts)2项76断言通过，核只选择该工具、真实三个 action、工作区外默认范围拒绝、明确 full_access 后成功、分支保留、来源内容/cwd不变、原 key 重放保留重建实体。worker 与恢复故障测试见[测试入口](../../test/isolated/tools/git-worktree/README.md)。Linux/Windows 实机和完整三平台发行资格未取得。

可信worker在首层输出解码时拒绝非法或截断UTF-8，不能让替换字符掩盖输出损坏；普通Shell原二进制/替换字符行为不变。[真实原生回归](../../test/isolated/tools/git-worktree/launch-security.test.ts)同时核合法U+FFFD和原监督停止证明。macOS只读发现并封存系统native Git，不使用会向沙箱外写xcrun缓存的Apple调度桩，也不通过额外写范围放行它。

模型指导要求 Git 工作树创建只调用 `git_worktree`，省略 path 使用持久默认根，不通过 Shell／脚本兜底。普通 Shell 不增加工作树 AST 硬拦截，无法据此承诺拦截任意程序间接创建；临时目标的实际拒绝由 Worktree Tool／worker 执行。非常危险系统级命令的现有兜底保留。
