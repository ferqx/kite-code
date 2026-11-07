# Git Worktree 工具

`builtin.shell` 注册 `git.worktree@1`，模型名为 `git_worktree`，提供 `list/create/remove/observe`。外层工具不持有进程槽或串行资源；全部 Git 调用由现有 `shell.command@1` 的受管 Bun worker 使用 argv 执行。创建返回路径，保留来源 checkout 和 Session cwd，不维护工作树数据库。

## 输入与产品边界

[输入及编排](../git-worktree.ts)使用封闭对象和 action 校验。模型 list 只接收 action，create 使用 `path?、base_ref?、new_branch?、execution_timeout_ms?、filesystem?`，remove 使用原生绝对 path 及可选期限／filesystem；不接收 key、嵌套 permissions 或 network。宿主从已持久 Tool execution 稳定派生意图，返回准确 `operation_ref`。observe 只接收原 operation_ref，读取原扩展记录和原 Job 状态，不调用 ensure、prepare、mutation，也不重放 unknown。

operation_ref 只无损编码原 Tool ID，当前 UUID 为26字符。观察从该原 ID 派生同一个宿主意图键，核原 Store／Session、准确 builtin.shell／git.worktree 定义、真实派发和记录 owner；不重复编码或信任模型填写的内部 key。原结果正文缺失或 outcome_unknown 仍可只读观察原记录和 Job。返回引用不再额外读取、重验记录，避免已知损坏记录失败被第二次异常覆盖；实际受理与失败分类由原执行路径决定。

create 可省略 path，可信默认根为 `~/.kite-code/worktrees/`，最终目标按来源 cwd／Session／宿主意图稳定派生。显式 path 优先。创建默认 detached、`base_ref:HEAD`，`new_branch` 只允许尚不存在的字面本地短名；不展开 Shell、环境变量或 checkout 简写。公开 Schema 提前表达原生绝对路径、分支前缀和 action 字段限制；worker 继续严格验证。期限首次接纳后固定，list 为15秒，创建默认120秒，删除默认60秒。filesystem 默认 workspace_write，full_access 仍经过原权限链；网络固定 none。固定 worker 的实际范围取接纳证明与原申请的交集，Full 也不扩大申请。参数错误为 invalid_tool_arguments，零 Git Job、零意图记录；不要求扩权或换意图重投。

[临时路径策略](../../permissions/worktree-path-policy.ts)从可信平台临时根、环境和最近真实祖先识别临时目录及别名。Tool 首次接纳前、worker prepare 和 mutation 均拒绝新的临时创建目标，原历史回执优先读取，remove 不因目标曾在临时目录而拒绝原安全检查。模型指导要求创建只走本工具，不以 Shell／脚本兜底；没有新增普通 Shell AST 拦截。

省略 path 的原记录保留原输入，并在首次 executable CAS 冻结 resolvedTarget；prepare 请求使用同一值，不能回填改写原授权意图。Store 从原封存 Run 的可信 Shell 配置（含 child configuration 包装）验证根和稳定派生路径。同一内部意图先查原记录／ref，默认设置变化不能重选路径或重发；公开 observe 只定位该原意图。

默认父目录缺失时，prepare 只读保存最近存在祖先、代际和缺失链；原获批 mutation Job 在公共锁内逐级非递归 mkdir，首个 mkdir 后即为 partial。失败保留已有目录，原 owner／ref 恢复边界不变。显式路径仍要求直接父目录已存在；未放宽原仓库 overlap 或删除保护。

## 业务授权与创建通知

[工作树行为工厂](approval.ts)提供有限的 create/remove 会话范围，随真实 Tool 定义登记；不将内部 Shell Job 加入消费 bindings。create 在卡片前通过原可信 Git／路径读取能力取得真实仓库、已存在的批准父目录和 base commit OID，范围只覆盖该父目录的直接子项、固定 commit 及 detached/newBranch 模式。它不运行 prepare Job、不创建 executable 记录；父目录无法核实或尚不存在时保留原单次路径。remove 只覆盖准确现有目标，不包含 create、force 或递归清理。

后续正常 prepare 继续生成实际计划；[范围比较](approval-scope.ts)在[原 SQL 证明桥](../../storage/sqlite/worktree-authorization.ts)核对 prepared frame 与已接纳范围的仓库／父锚点、baseOid、分支模式和直接子项或准确删除目标。选择范围批准后，若卡片所绑定的 HEAD/ref 或父目录身份与 prepared 计划失配，不能启动 mutation，也不自动降级单次继续。范围使用稳定目录身份；ctime 等本次代际仍独立用于 prepare/mutation 安全核验。原单次及 Auto 免审路径保持各自语义，不为它们增加范围批准的固定 commit 义务。相邻[范围回归](../../../test/isolated/tools/git-worktree/approval-scope.test.ts)覆盖真实 Git 的批准前取证、同父目录兄弟候选及 HEAD／父目录漂移零工作树创建。

Auto 下准确 `builtin.shell/git.worktree@1` Tool 不调用 generic check 或人工审批，封闭内部 Job 只继承经 Store 完整核实的原 Auto 免审来源；普通 Shell 即使命令相同也不取得该例外。手动模式的一次创建／删除批准仍覆盖原 Tool 的两个封闭步骤，正常外部范围各一张业务卡。prepare 仍按所属变更分类，不改 safeRead，也不免除 Job 派发检查。[准确资产描述](../../permissions/shell.ts)在核验实际 worker 后封存配置身份；[授权边界](../../storage/sqlite/worktree-authorization.ts)核实际 builtin.shell 注册、同 Store／Session／root work／owner、原记录和步骤、权限、期限及原 prepare 的完整输出。mutation 必须使用其实际成功 prepared frame 的原 plan/digest。原来源、当前父子／Planning 策略、控制读集与撤销在最终派发事务再验；自定义独立人工上限不被吸收。普通 Shell 同命令统一范围与准确父链沿各自行为核验，不借用 Worktree 特例。

退出工作树不属于本工具的 Git action：它只返回客户端来源项目／会话，不删除目录、登记或分支。模型须按[默认合同](../../model-context.ts)区分导航与明确目标的删除意图；创建未改变原 Session cwd，不能以 remove 模拟退出。

[通知 helper](notification.ts)只在原创建 owner 已保存稳定成功后，沿现有 sendStableAgentMessage 向 parent 排队确定正文；用实际执行组根关系区分根与子会话，不以 quiescent 作为通知门槛。原 owner 合法恢复可续接同一正文和持久消息身份，新 Execution 历史回执不另发。单次 Tool 回执的 parentNotification 区分 queued/accepted:true、预检或稳定记录保存失败的 failed/accepted:false，以及入队受理不可核实的 outcome_unknown/accepted:null；只表示消息情况，Git outcome 保持。稳定操作记录保存原 Git 回执，消息受理继续由原邮箱 command 持久化；没有队列确认不能宣称父已收到。

父通过现有消息转发给相关直接 child，idle child 需明确 follow-up 才开启新轮。[Task owner](../../extensions/task/README.md)维护投递、接收和完成通知的区别；本工具不广播、不建立目录使用租约，也不新增编辑独占或并行限制。两个可写 child 可共享或分别使用目录；创建与通知均不迁移 cwd，不把路径消息变成编辑授权。

只查询 Git 登记快照，保留 locked/prunable、原因和缺失路径；不推断 dirty、占用或 removable。创建先冻结完整 OID，原子预留不存在的目标，再 `add --no-checkout`；在目的实际配置和双向定位核对后，仅由当前未中断 worker 填充它刚分配的空目标。目的 `includeIf` 不能跳过检查。不会复制来源的本地修改、初始化依赖、fetch、迁移会话或自动清理失败现场。

变更拒绝 bare、unborn、partial clone、shallow、alternates、grafts、sparse checkout、显式 `core.worktree` 等不能证明的仓库配置。每次 Git 调用禁用替换对象、lazy fetch、hooks、fsmonitor、untracked cache、交互和可执行 filters；命令级覆盖不改源配置。filters 按来源和目的分别完整枚举；LFS 等可能只得到提交内的指针文件。

## 记录与恢复

普通 Native 会话列表通过[Store 目录](../../storage/README.md#目录分页)的 `activity.hasCreatedWorktree` 展示原 Session 曾成功创建工作树的历史标记，来源为下述原生成功 create 稳定记录。无需新工作树数据库、目录探测或工具版本升级；remove 不清除历史，Fork 沿原 omit 规则不继承，子会话创建不回填父会话。图标不表示目标当前存在，不改变 cwd 或访问授权。

[工具编排](../git-worktree.ts)在原 Session 的 `git-worktree/` namespace 用 CAS 首次写入 `executable:true`，记录 Fork 为 omit。冻结来源、意图、权限、原 owner Execution、绝对期限、prepare/mutation 的完整 Job input 与 key。每次 ensure 之前先保存冻结步骤；已保存 ref 时始终 get/wait/readOutput 原 Job。

同 key 的不同意图返回 conflict。新的 Tool Execution 不能接管 accepted/prepared，也不能在 ref 未落盘时重新 ensure；只有 Runtime 对原 owner 的合法 resume 可逐字续接原 input。原 owner 独占执行记录的后续 CAS；其他 Execution 只观察原记录和 Job，不保存 prepare 计划、lastObservation 或 stableResult，避免观察抢写打断活跃 owner。观察者仍可从原 mutation 的完整输出返回确定结果，原 owner 恢复后负责保存稳定回执和原通知身份。prepare 成功只表示计划已冻结。原 owner 将未知结果保存为 unresolved/lastObservation，后续仍能从原 ref 得到确定证据；prepare已确定完成且尚未保存mutation步骤时的期限耗尽返回已知未开始，mutation接纳窗口仍保持未知；不能永久缓存 unknown，更不能换 key 重跑已接纳效果。历史成功回执保留原 observedAt，不保证路径今天仍存在；同路径重建不会被旧删除 key 再删。

[完整输出 reader](read-output.ts)验证原 Store/Session/Execution/Job 身份、真实终态和相符结果，固定高水位完整分页；拒绝输出丢失、游标异常、多帧、错误 token/phase、非法 UTF-8，以及 `droppedBytes:null`。可信worker的原始stdout/stderr在首层监督进程严格解码UTF-8，避免先被替换成U+FFFD再进入记录；合法的U+FFFD仍可保真。普通Shell的原解码行为保持。不使用前台 Shell 预览作为 Git 机器结果。冷重启后的原 Shell Job没有进程重连能力，不能验证时保留 `outcome_unknown`。取消及超时只作用于原 attached Job，Runtime 未确认停止时不能宣称 cancelled；残留目录、登记和分支如实返回。

[错误分类](errors.ts)只给新观察到的失败增加可选 `details.failure`，工具和协议仍为1。`process_start` 来自实际 spawn 失败，`git_permission_denied/permission_denied` 来自明确文件访问拒绝，`git_command` 来自已启动 Git 的非零退出码；其余检查为 `verification`。保留有限 errno、退出码与原业务 code，不从 stderr 文本或旧 `git_operation_failed` 推测审批拒绝。新回执不发布 Git 原始 stderr，避免其中的路径、URL 或凭据进入诊断。外层 Runtime 的权限拒绝继续使用原事实，不伪造 worker 帧。清理失败保留主因及 `cleanupUnconfirmed`，mutation 和原 Job 不降级为未执行。工具回执与[默认模型合同](../../model-context.ts)要求查准确原因、不扩权、不换 key／参数／Shell 重试；稳定失败回读仍只观察原操作。

## 删除保护

[worker](worker.ts)仅删除同仓库、唯一登记且定位双向一致的 linked worktree，保护主树、当前来源、locked/prunable、嵌套树和 Git 元数据。prepare 保存根、pointer 内容、admin、HEAD、登记及文件系统代际，变更前重新比较。索引冲突、gitlink、assume-unchanged、skip-worktree、tracked/untracked/ignored 内容、额外空目录、链接、特殊文件及不完整扫描都拒绝。

status 为空不单独证明 tracked 内容安全。每个普通 stage-0 文件通过不跟随链接的只读 FD 交给 Git 重新计算内容 OID，并匹配索引中的真实 blob；stored blob 也完整流式读取和核验对象 OID，缺失或正文损坏均拒绝。文件哈希保留 CRLF、ident、working-tree-encoding 等 Git 内建 clean 转换，外部 filter 继续禁用；POSIX 另核实际 owner executable 位，不沿用 `core.filemode=false` 的忽略。读取前后、目录扫描及提交检查后重核文件代际，stat 缓存不参与内容证明。Windows 继续以原生 reparse 和内容检查为准，不承诺 POSIX executable 位语义。

提交保护严格读取 files 后端的完整 HEAD reflog，每条 old/new 非零 OID 与当前 HEAD 都必须存在且为 commit；保护 tips 只来自共享本地 heads 和能剥离为 commit 的 tags。符号引用链必须有界、无环、全程处于共享 heads/tags 并最终抵达直接引用；依赖待删管理目录、任何 worktree HEAD 或其他私有引用的链不算独立保护。普通 packed refs 继续支持，其实际公共存储必须可核实且没有文件系统链接／reparse 重定向，不能通过删除 admin 同时删除所谓保留引用。关闭 replace 后使用显式正负 OID 集合证明可达，不以目标 HEAD、其他 detached HEAD、remote refs 或 reflog 自身充当保护引用。缺失、损坏和不可验证历史拒删。

[路径检查](paths.ts)在 POSIX 不跟随链接，Windows 复用原生 reparse 检查。Linux 使用完整 mountinfo，macOS 使用原生 getfsstat64 挂载表；检查目标及内部挂载边界。树扫描保存每个已遍历目录的代际、完整直接条目名称摘要及 mount digest；prepare 结束及真正 remove 前，与 tracked 文件证据一起同步复核这份闭合证据，防止提交检查期间新增 nested ignored 内容、空目录或挂载边界被漏过。读取错误、超限或变化不降级。Windows 按既有[工作树清理规则](../../../../../docs/development/worktree-safety.md)处理，不能靠 Node symlink 判断或 Git 默认 clean 放行。

prepare 结束后、首次 remove ensure 之前，工具要求 `readRunExecutionSafety` 精确排除当前 Tool 且无未确认执行，以及 Service 提供的同 Store、完整分页、物理路径可解释的已登记 Workspace 根。目标等于或包含任何登记根即拒绝。缺少可信 Host 回调的 SDK 装配没有删除能力。

所有 worker 变更用 commonDir 内原子目录锁协调，owner 含 operationToken 和随机 nonce；未知锁不按 PID/TTL 抢占。锁覆盖变更、失败残留观察和后置核验，仅 owner 定点 unlink 普通元数据和 rmdir 空锁。清理完成后才输出唯一终帧。业务成功但锁清理失败返回 failed/mutation completed，保留锁事实，不重跑 Git。不传 force、不 prune、不递归删除、不删除分支/tag。

这不是跨 Run 全局占用租约，也不检测外部进程、未登记目录或其他 Run 经 Shell 临时 cd 的占用。用户需先停止使用目标；检测到的变化一律拒绝。工作树共享对象和 refs，不是安全沙箱。

## 可信资产与验证

Windows 的 Git 子调用由[文件句柄捕获](windows-process.ts)替代 stdio pipe：本机 Bun1.4.4 的 pipe 创建在原 `workspace_write` 受限 token 下会因 `uv_spawn EPERM` 失败，相同原宿主继承普通 FD 可成功。本实现只在所属 Job 私有 TEMP 中独占创建文件，64KiB增量读取，保原 stdout 16MiB／stderr 256KiB、精确 hash 长度和最终 EOF／代际核验；借用 inputFd 不关闭，定点清理无法核实则保留失败。权限、环境允许集合、Git 安全配置、进程取消和工具／协议版本均未放宽，原因与备选见[取舍](../../../../../.agents/notes/implemented/bug-fix/2026-11-06-windows-worktree-git-stdio.md)。

[构建](build-assets.ts)发布独立 `worker.js`、无 preload 的 `empty-bunfig.toml`、空 `empty-hooks/` 及 SHA256 manifest。Host 固定 Bun/Git/worker、cwd、配置身份和环境允许集合；严格识别规范化单一命令，派发前重验。macOS在首次装配只读核验root所有且祖先不可被group/world写入的系统native Git，不把`/usr/bin/git`的Apple调度桩当作实际实现身份；不依赖其沙箱外xcrun缓存写入。Bun1.4.4 实测使用 `--no-env-file --config=<absolute>`，分开的 config 参数会空执行，不能仅靠退出码断言成功。macOS 外层 supervisor 和 launchd 再启动、Linux 首次解释器以及 Windows 原生入口均应用该 profile；项目 .env/bunfig 和环境 preload 不得先执行。

正式 Service 的合格 Shell host 支持三 action；自定义 POSIX zsh 等可加载启动文件的 Shell 不取得 worktree 能力。没有 scope-aware host 的 legacy POSIX 装配只支持 list，不能借它执行变更。资产或 Git 缺失局部不可用，不阻断普通 Session 启动。Linux/Windows 原生运行和安装资格分别取得，不能由源码检查或 macOS测试代证。

自动化入口：[测试目录](../../../test/isolated/tools/git-worktree/README.md)、[Service 全链路](../../../../../apps/service/test/isolated/git-worktree-configuration.test.ts)、[发行与搬迁](../../../../../tests/isolated/unified-agent/terminal-bundle.test.ts)、[真实模型与子 Agent](../../../../../tests/e2e/live/model/README.md#git-工作树与直接子-agent)。当前执行证据由 Shell/权限/Service owner 和 Terminal owner 维护。持久取舍见[设计决定](../../../../../.agents/notes/implemented/feature/2026-11-06-git-worktree-tool.md)。
