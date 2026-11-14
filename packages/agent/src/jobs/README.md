# Shell Job leaf

本 leaf 提供显式 POSIX、macOS host/confined，以及 Linux host/confined 可信工厂。macOS confined 的 deny-fork 理由仍见[原决定](../../../../.agents/notes/implemented/architecture/2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)；允许 fork 的完整后代方案见[coalition 决定](../../../../.agents/notes/implemented/architecture/2026-10-07-macos-host-shell-owned-coalition.md)。Linux 的原 namespace／gated root 取舍保留在[部分实施提案](../../../../.agents/notes/proposed/architecture/2026-10-10-linux-shell-owned-pid-namespace.md)，原生资格仍 pending。

[createShellJob](shell.ts) 保留显式 POSIX 装配。[createMacosHostShellJob](shell.ts) 由 macOS 默认 ProcessService 选择；factory/import 不启动进程，不读取旧数据。调用者明确选择 cwd/env，统一宿主负责命令、工作区权限与派发；Job input 仅包含 command，Model/HTTP 不能提供 launcher、路径范围或隔离声明。根 manifest 的 `./jobs/shell` 是公开 leaf 导出。

Linux 默认 ProcessService 现选择 `createLinuxHostShellJob`，低层另保留 `createLinuxConfinedShellJob`。可信宿主必须提供已经封存的 Bubblewrap 与 native init；包内资产缺失或后端不满足契约时拒绝，没有普通进程组回退。源码、完整调用者接线与原生运行资格分别核验，具体见下节。

命令通过独立 Bun [guardian](../platform/process/shell-supervisor.ts) 在新的 POSIX process group 内运行。私有 stdin 控制管道只承载本次启动/取消与真实父生命期：父 EOF 或强杀会让 guardian 清理整个命令组；HTTP/SSE 断线不影响该管道。正常 shell 退出也先清理仍在组内的后台后代。自然退出、cancel、EOF 和失败共用一次 closing；后到入口加入原清理，保留首次入口携带的原根退出／取消事实，不重复 TERM/KILL、清理或发布 terminal。两流完成前的真实输出错误另保失败，不被先到的自然退出覆盖。停止先 SIGTERM、有界等待，再必要时 SIGKILL；只有后端核实原组停止并完成原根收尾才报告 stopped/groupStopped，不把单个 pid 退出当停止确认。无法确认时返回 unknown 与 terminal supervision=unknown，不伪装成功；只有 groupStopped 的证明产生 supervision=ended。较晚停止证明只补充监督事实，不能把已记录的未知 effect 改为成功。调用 cancel/dispose 幂等，host 是唯一业务事件观察者。

macOS 使用私有 [Darwin owned-child port](../platform/process/darwin-owned-child.ts)：原生 posix_spawn 以 SETSID 创建准确 PID=PGID=SID，stdout/stderr 使用自有非阻塞 pipe，argv/env CString 在 native 调用结束前保活。waitid/WNOWAIT 读取原根真实退出但不回收，让内核保留原 PID/组/会话身份；不在 Node/Bun 已自动回收的数值 PGID 上继续发组信号。停止证明要求有界 libproc 完整成员表恰好只含原根，并在前后取得一致的 WNOWAIT 原退出事实；任何其他成员、容量不足或观察失败均继续有限等待或 unknown，EPERM/ESRCH 本身不成为停止证明。确认后排空输出，waitpid 精确回收一次原根，再清理准确私有 temp；回收后不再发组信号。动态库与自有 FD 由同一 owner 管理，完成回收及 FD 关闭后释放。此取舍与最小替代方案见[决定记录](../../../../.agents/notes/implemented/bug-fix/2026-10-06-macos-shell-root-ownership.md)。

guardian 连续排空 stdout/stderr，不等待业务观察回调；每块 UTF-8 内容最多 32 KiB。adapter 默认输出队列 256 KiB，超限保留明确 output_dropped 字节区间，控制终态不会被丢弃；单消费者迟缓或尚未 observe 时也不会无限缓存输出。输入、内部协议帧和启动/停止等待均有界。

stdout／stderr读取拒绝按helper失败收尾，不调用用户取消入口。两项drain各关闭自己的stream，closing等待两项settled后沿原组／coalition证明清理；未确认停止仍unknown。首次输出错误只保128字节内的安全标识符与可用整数errno，不保存stack、路径或命令。私有terminal的failureCode／failureErrno由Shell adapter严格核验后保为结果details.supervisorFailure／supervisorErrno，原自然退出／取消／首个closing及输出预算不变。[独立输出失败整例](../../test/isolated/jobs/shell-drain-failure.test.ts)在私有真实guardian注入迭代拒绝，核failed、helper125、原组停止与原错误；适用macOS／Linux，Windows沿原unsupported skip。本机执行不授Linux原生或完整资源观测资格，也不证明之前间歇连续任务的首个触发源。

Darwin pipe读取使用 `readSync` 的同次原生错误快照，仅 `EAGAIN`／`EINTR` 继续原有轮询；其他错误保留helper失败及可用的正整数errno。原非阻塞FD仍由owned-child关闭，每轮最多32KiB，buffer、backpressure和准确回收保持。[原生整文件回归](../../test/isolated/jobs/darwin-owned-child.test.ts)在真实空pipe返回暂态错误后立即将线程errno改成EPERM，仍须取得完整双流、exit23及准确reap；旧分离FFI读取版本在同一干扰下报 `darwin_owned_child_read/1`。这证明错误观测边界的修复，不证明2026-10-19默认负载中自然EPERM的具体底层触发源，原失败现场继续保留。

[build-assets](build-assets.ts) 将 guardian bundle 到 `dist/platform/process/shell-supervisor.js`。built `dist/jobs/shell.js` 自动定位该资产，固定当前 Bun 执行它；源码测试显式传入已编译 guardian 路径，不回退到 `.ts` 源码。编译为单一 executable 的宿主应从发行资产根显式选定 supervisorPath，不能依赖虚拟 import.meta 路径。凭据/env 经私有管道传递，不进入 helper argv。

其他公开 leaf 通过 `@kite-ai/agent/jobs/shell` 使用此实现，完整包构建保留独立公开依赖。不能把含相对资产定位的实现以内部相对 import 合并进任意共享 chunk；实际完整 manifest 的源码树外测试同时验证多个入口装配与 guardian 路径。

[真实测试](../../test/isolated/jobs/shell.test.ts) 在 macOS 验证正常/自然终态、真实子进程组与后代清理、TERM 忽略的强制停止、无关进程保持存活、父 fixture EOF/强杀、输出 gap 与离开源码树的资产定位。该父 fixture 直接运行公开 leaf，证明监督机制；[真实 Service/Core 集成](../../../../tests/isolated/unified-agent/shell-service.test.ts) 使用公开 paired 启动、Action 子操作和已构建 guardian，验证同 profile 的 Session owner 与 Workspace OS 锁、取消回执先于进程组停止、真实输出 GET、Service 父 EOF 与 SIGKILL 清后代且不杀无关进程。EOF 正常停机保存 cancelled；强杀后通过显式恢复保存 outcome_unknown，重开及重复原命令不重启旧 Shell。恢复中的 unknown 不宣称外部 effect 已成功或可重放。Linux 的代码路径存在但本轮运行资格 pending；此 POSIX leaf 不支持 Windows，默认 Windows Job 后端见下节；PTY 和三平台发行签名/权限仍 pending。旧 POSIX 实现最终退役状态不由这些叶子测试宣告完成。

原 native 根所有权证据仅在 macOS arm64/Bun 1.4.2 实际运行。[Native 回归](../../test/isolated/jobs/darwin-owned-child.test.ts)核冷 import 零 native I/O、强制 GC 后完整 argv/env、双 pipe 全文、重复 WNOWAIT、原根自然退出后真实 child/grandchild 强停、启动失败零 child/FD 漏出及准确一次 reap。普通 POSIX、严格 confined、显式 Service/Core 与声明补偿各自保留原证据，不能扩为允许 fork 的全树证明。默认宿主的新范围与实际测试见下节；x86_64 ABI 尚未本机执行，Win/Linux 运行验证依用户选择延后到重构完成后的 GitHub Actions。

2026-10-07 先核验了 Endpoint Security 后代接口：SDK27 声明最低 macOS27 与 entitlement，本机 macOS26.7.1 运行库实际没有该符号。它没有成为当前实现依赖；NOTE_TRACK/NOTE_CHILD 也不能提供此证明。探针及限制保留于[阶段证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07宿主-shell-完整后代接口的运行资格)。当前采用下节实际验证过的 launchd resource coalition。

2026-10-07完整默认图在失败启动例的全局`waitid(P_ALL)`断言观察到0，FD集合相等已通过；原记录未保存si_pid，具体child来源未知。准确已知无关child正例证明：40次原失败启动没有新增child/FD，全局P_ALL仍可合法返回0。该例现将原40次throw、完整FD集合相等、严格waitid=-1/ECHILD三项共43条检查放进只执行失败启动的独立进程；父进程真实无关child在probe前后仍活着。原5秒整例保留，probe明确3秒kill/await，全部six场景和原其他断言不变；有限6pass/35条父Bun断言及43条child断言通过。该修正只限定测试所观察的进程namespace，不放宽生产停止证明，不接受waitid=0作为无child。原全图失败、最小反例与阶段复验归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。

仅当前 host 创建的 JobHandle 可观察/取消。JSON reference 可持久保存，但新 host 的恢复不能重新构造旧内存 handle 来执行：本 leaf 尚无 reconcile，未知执行按 core 恢复契约处理，不能自动重跑旧 Shell。

普通 Tool 的 `reportProgress` 可由宿主写入同一有界输出表：存储只接受实际已派发、仍为 dispatching/running 的 Tool、stream=progress。该事实不会修改 Execution 状态，stdout/stderr 仍仅供 Job；取消已提交后的迟到事实可保存，终态以后不再追加 Tool progress。沿用 Job 输出的 32 KiB chunk、JSON/行开销预算、独立 Decimal64 高水位和 owner generation 核实。真实拒绝与迟到事实测试见 storage/jobs.test.ts。

Store output paging preserves the one MiB JSON/row-overhead budget independently of terminal facts. A producer drop begins that stream's coalesced tail gap; other streams can still retain normal output while the total budget is available. `output_truncated` records that clipping occurred, while the internal `output_budget_exhausted` flag closes further retention after the global budget fails. There are at most three stream gaps. GET merges every gap intersecting the bounded normal-row page, clipping a gap to the last retained normal-row boundary when more content may remain; clipped byte attribution is null. Cross-stream gap intervals may overlap, so a consumer advances afterSeq to the maximum throughSeq on the page, rather than treating gaps as exclusive global intervals or using only the last item's endpoint. Real Store tests in test/isolated/storage/jobs.test.ts generate 220 normal chunks interleaved with three actual producer gaps through appendExecutionOutput, retain every chunk across a 200-row page, and verify overlapping tail ranges and readonly cursors without SQL relocation.

Ordinary builtin Shell publishes its stable prefix live and buffers a bounded suffix in the Shell adapter. Before publishing the Job terminal event it writes at most one omitted-byte range per stream, followed by the retained suffix. The Store accepts that suffix after a gap for the exact builtin Shell operation, within the same one MiB budget. Published cursor positions and old output records stay valid. The Git worktree worker keeps its existing framed output path. The separate model preview budget is described in [Shell tools](../tools/shell.README.md).

## 默认 Windows Git Bash

`start` 仅在原 runner READY 核验与 GO 写入确认后返回；此前不进入 Core running。失败准入通过 `JobStartError` 交回原 handle，Core 观察原终态并清理，未知清理仍保 handle、资源及 binding，不能丢失后仅保一个无法停止的空引用。已确认零派发的准备失败携带无 handle 的明确事实，Core 保存失败并释放资源。原协议与版本不变。

运行时清单是两份 Git Bash 副本的唯一闭包目录。每次派发核清单原身份与所选副本全部文件摘要，包含 `ls.exe` 等 Git Bash 自带命令、MSYS、兼容 DLL、Git helper 和证书。权限快照固定同一清单摘要，损坏闭包在原生进程创建前失败。[回归](../../test/isolated/jobs/windows-git-bash.test.ts)实际变更两份闭包的命令、DLL、helper、证书与清单，核零 native 派发。

`createWindowsShellJob`、`captureWindowsGitBashRuntime` 的初始捕获和每次派发复核均异步等待。完整文件校验共用进程内8个读取名额，每个原 FD 独占至多1MiB缓冲，读到实际 EOF 并核前后身份、大小与时间，最后复核原路径；不缓存内容证明。SHA 分块之间按8ms／64步预算主动交还事件循环，避免已完成 I/O 的连续微任务继续阻塞其他会话。排队与读取检查点接受原取消信号；失败停止领取新文件、取消兄弟读取，等待已开始 I/O 和原 FD 关闭后才返回。关闭无法确认时保原 FileHandle 及名额，不把它当已释放；进程池和 Shell 状态复用均未引入。[异步校验回归](../../test/isolated/jobs/launch-identity-async.test.ts)核短读、空文件、尾部变更、增长／截断／替换、读取失败、排队／读取中取消、失败批次收尾、关闭未知的全局上限，以及连续完成的读取确实交还事件循环。

Windows 在原 Job 停止、runner 回执和原 HANDLE 关闭均确认后，等待 `removeRuntimeTempAsync` 清理。清理最多4条并行，每条顺序等待原 FS 操作；核原根身份、逐层核目录后序删除，不遍历目录联接，Windows 只读文件只在原身份复核后恢复删除所需属性。清理不因用户取消提前返回；目录未清除或失败仍保原 Job 引用、资源／binding 与 unknown，不自动重试或重建 owner。其他平台的同步清理入口保持。[真实清理回归](../../test/isolated/jobs/runtime-temp-async.test.ts)核只读文件、外部 canary／联接、原根替换拒绝、4路上限和失败收尾，并在实际 Native Job 中保持清理未完成，核取消等待及失败 unknown。

[适配器](windows-shell.ts)通过 Runner V7 接入普通 Job。工作区写入沿原无账户 write-restricted token 和 ACL，读取沿宿主权限，离线范围使用环境提示。完整文件与联网范围取最终父子授权交集，准确获批的外部写入可实际执行。`cwd` 可以为指定工作目录，工作区 ACL 仍只授权原工作区根。

[原 Job owner](../platform/process/windows-owned-child.ts)与原生 runner 的受限／完整文件启动均使用 `CREATE_NO_WINDOW` 和隐藏窗口的 `STARTUPINFO`，标准流仍走原管道。Windows 可能保留不可见的 console host，它也必须纳入原 Job 的完整成员观察与停止证明，不能因没有可见窗口而省略回收。[真实 Windows 回归](../../test/isolated/jobs/windows-owned-child.test.ts)核隐藏启动、输出、成员身份和完整关闭。

全部命令共用原生启动和监督链路。适配器把权限层已核实的默认范围只读调用映射到 `read_only`，只准备本次临时权限，不进入工作区 ACL 账本或互斥锁。Windows `Path`／`PATH` 在附加固定工具路径前合并为一个 `PATH`，避免大小写重复键让 Bash 丢失工具目录。

可写工作区范围仍由 [原生准备层](../../../../native/windows-sandbox-runner/src/direct_workspace.rs) 使用 [Windows 可回调的继承传播](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-treesetnamedsecurityinfow)。工作区锁等待和传播均可取消。首次在同一工作区锁内持久写入一次未完成账本，传播后再写完成标记。涉及保护路径快照的修改仍先持久保存快照，根 ACE 已存在也不能代替后代准备完成。取消时未创建业务进程且本次临时 ACL 已撤销，才返回原协议的已取消／清理确认回执，撤销不确定仍保 unknown。首次完整传播随文件数增长，完成后复用原账本，下一条命令补全准备时只运行自身。

[准备层](windows-git-bash.ts)固定本机 Git 的私有运行时闭包。仓库 [IPC 兼容层](../../../../native/windows-msys-compat/README.md)修复 MSYS 对象 ACL；Full／完整文件范围保另一份未修改映像，避免并发共享区冲突，不修改安装 Git。两份映像共用复制与校验流程，[准备层回归](../../test/isolated/jobs/windows-git-bash.test.ts)核冷创建、复用、缺失文件恢复和变更文件保留。Windows Shell 构建携带 runner、兼容 DLL 与内置 rg。Git Bash 启动时依次查找内置 rg、所选副本的 `usr/bin` 和 `mingw64/bin`，然后才查找继承路径。未知关闭保 owner，冷读取不从 PID 重建或重跑。

`stageWindowsGitBash`／`windowsShellAssets` 是异步准备入口，调用者须等待完成后才能装配 Shell。源文件仍每次完整读取校验；未修改映像复用同次源 SHA，目标父目录去重，副本复制与完整内容校验最多并行8个文件。同一摘要目录的两套副本和清单由一个跨进程独占文件锁保护；竞争者最多等待30秒，取得锁后才读取目标文件，避免把尚未完成的复制误判为损坏。锁文件保持原身份、不删除；不同摘要目录互不阻塞。已有文件不覆盖，缺失文件使用排他创建；失败先等待已开始的文件操作全部结算，不发布新清单或提前交出可执行资产，随后释放准备锁；既有损坏文件仍失败而不修写。两套副本与派发前完整重核保持，不用 mtime 缓存或链接替代内容验证。[并发回归](../../test/isolated/jobs/windows-git-bash-race.test.ts)用精确半写同步点核跨进程复制／补丁映像／Full／清单发布、同进程竞争、失败全结算和 owner 强杀后的锁释放；POSIX 只证明合成 Git 资产与本机 OS 锁，不代替 Windows 原生资格。

[原生测试](../../test/isolated/jobs/windows-shell.test.ts)与 [Service 集成](../../../../apps/service/test/isolated/shell-search-configuration.test.ts)覆盖检索、Git／fork／管道、范围与审批、并发、取消／宿主死亡、准确关闭和冷零重放；事实及安装资格范围归 [Windows active](../../../../docs/active/windows-shell-sandbox.md)。

每次 Windows Shell 仍创建独立 runner、Bash、原 Job、临时目录和双流，下一条命令从原 Workspace／宿主环境开始，不继承前一条的 `cd`／`export`。共享的是已准备的摘要运行时及工作区 ACL 账本；ACL mutex 只串行准备，Shell 本身仅申请 process slot，没有工作区执行串行锁。[真实 Service 跨会话回归](../../../../apps/service/test/isolated/shell-concurrency-configuration.test.ts)在实际 Windows／Runtime／SQLite、两个 process slot 下核两个会话并行、第三个排队、准确取消一个时另一原 HANDLE 仍存活、同／不同工作区与受限／Full、输出和 temp 分离及后续命令状态重置。它也确定性证明同一 Workspace 的文件可被另一会话覆盖；执行隔离不提供文件副本或 Git 索引隔离。

每个 Runtime 默认4个 process 任务名额，覆盖派发准备及实际执行，超额任务可取消地等待；同一 Shell 可有多个子进程，名额不是 OS 进程总数。进程内8路完整资产读取与该名额分开，既不按会话各分8路，也不串行全部命令。Run 配置捕获、权限与扩展装配并不全部受 process 名额限制，不能由4槽或8个校验缓冲推导整个 Service 的 CPU／RSS／响应延迟上限。32会话的真实排队、实际32条并发、关闭证明及秒级心跳缺口见 [Service 压测](../../../../apps/service/README.md#默认-shell-装配)。

显式[启动计时夹具](../../test/fixtures/windows-shell-timing.ts)可用 `bun packages/agent/test/fixtures/windows-shell-timing.ts` 复现；只运行隔离固定命令，不增加普通客户端入口或性能阈值。2026-11-05 Windows x64／Bun1.4.4，异步化前8次采样去掉首个完整调用后，同步 start 中位约739ms，校验期间最大心跳间隔约793ms；异步化后同入口同步 start 约0.04ms、最大心跳间隔约38ms，热调用总耗时中位约860ms。完整内容校验仍占数百毫秒，不承诺减少总 I/O。直接 Bash 启动约35ms的比较省略授权、校验、受限令牌／Job／ACL及清理，只是本机下界，不代表可省掉这些边界。数据仅为本次源码与本机隔离采样，不构成其他机器的延迟保证。

2026-11-05 本机 Windows x64／Bun1.4.4 对本轮源码运行原生 Cargo、上述 Shell／Service、原 Job owner 与 Windows stdio MCP 回归通过，新增实际 Path 大小写、部分继承恢复、锁等待取消、撤销失败保守结算及目录联接外部写拒绝断言。隔离 Native 制品在50000文件工作区运行同一组合写入／管道脚本：准备中取消约147ms确认、业务文件未写；切换会话后执行新命令，约14.1秒完成权限恢复、写入与正确输出，exit0、原 Job 空树及资源关闭均确认。持续界面采样与控制台观察未见新增终端，取消后 Main 心跳最大约32ms、renderer帧间隔最大约88ms；此场景未复现此前报告的长时间整窗冻结，不外推其他冻结原因或安装／发布资格。首次完整 ACL 准备成本仍随文件数增长。

## Windows 桌面 PowerShell 回退

Windows 桌面明确选择 PowerShell，或自动选项明确未发现 Git Bash 时，[系统 PowerShell 探测](windows-powershell.ts)从 `GetSystemDirectoryW` 定位 Windows PowerShell 5.1，固定实际 EXE 和 AST 引擎身份。每个命令由 [Windows Job 适配器](windows-shell.ts)固定解释器、范围和资产，再由 [原生 Runner](../../../../native/windows-sandbox-runner/src/main.rs)校验系统路径和 EXE 摘要，保持原读句柄直到进程创建。只有 Git Bash 请求携带运行时目录。按会话装配归 [Service owner](../../../../apps/service/README.md#默认-shell-装配)。

Runner 以非交互、无 Profile 方式直接启动 PowerShell。脚本经所属 stdin 管道按 UTF-8 与长度传递，双流继续由原 Job 收集。可证明的只读命令在受限范围下使用 `read_only`，工作区与完整文件写入使用各自令牌。取消、有限超时、父退出和清理复用原监督与回执。网络约束、审批和安装证据归 [Windows active](../../../../docs/active/windows-shell-sandbox.md)。

两个后端的独立 Git 查询均固定 Git 可执行文件，并沿原 Runner 请求把活动进程数限制为解释器和一个 Git 进程。Git Bash 使用同一 staged 资产闭包，PowerShell 优先使用已发现 Git for Windows 的真实程序，避免 PATH 包装器引入额外进程。适配器移除继承的 Git 环境选项，再关闭 Git 协议和交互提示。项目配置要求运行外部 clean filter 等助手时，Git 可能报告助手启动失败。原 stdout、stderr 和退出码照常保存。

## 默认 macOS 宿主 Shell

[启动文件身份](launch-identity.ts)在同一个no-follow FD上读至真实EOF并计算完整SHA，每次调用只持一个 `max(1,min(fileSize,1MiB))` scratch；不整份读取Bun等大资产，也不缓存历史digest。stat／opened／after／当前canonical对象的regular-file、dev／ino／mode／size／mtime／ctime一致性均复核，增长超过原大小提前拒绝，短读继续，所有失败仍关闭原FD。宿主准备与guardian各自执行原新鲜度检查，分块不是省略复核或改变broker／guardian／coalition结构。[定向回归](../../test/isolated/jobs/launch-identity-bounded.test.ts)核空／小／多块短尾、强制短读、单scratch上限、同大小尾篡改、读中增长／截断／替换／mode变化和异常关闭；真实取消／父死亡门禁仍由原Shell测试负责。缓冲区取舍见[完整验证与有界工作内存](../../../../.agents/notes/implemented/architecture/2026-10-16-bounded-verified-file-reads.md)。

[host-preparation](host-preparation.ts)捕获真实 canonical Workspace、controlBase、自定义显式保护／只读资产，以及 Bun/shell/guardian/sandbox-exec 的 dev/ino/mode 和文件摘要。可信 host 可提供 `executionScope`，由[范围 helper](shell-scope.ts)一次解析独立 filesystem/network tuple；正式 Service 始终从最终接纳的 dispatch snapshot 提供这一 resolver，人工/模型批准不改整场权限。Workspace 仅写授权 Workspace/本次 temp，Full 允许普通宿主写；network=none 拒全部网络，包括 Unix socket，internet 开 IP，Workspace 仍拒 Unix bind/outbound。旧显式低层 `filesystemScope` 工厂保其原联网 ABI，不作为新正式默认权限。所有后代继承 Seatbelt，宿主 HOME 与工具链保留；默认 Service 不再自动增加 Profile、配置、认证、controlBase 或整运行目录遮挡；自定义显式 private roots／只读资产仍拒相应访问与祖先 unlink，Full 不覆盖这些显式宿主上限。temp 在 Workspace 外、0700、拒 native exec/map；注入环境变量仍移除。同 UID 非合作外部替换仍属原可信宿主边界。

[launchd broker](../platform/process/darwin-launchd-supervisor.ts)以随机准确标签注册本用户 Background guardian。共享helper另支持闭合MCP kind与有界双向RPC，MCP使用独立标签／coalition，具体归[MCP owner](../mcp/README.md#显式-stdio-guardian-port)；本Shell的原帧上限、权限、held-root／group proof和一次reap保持。控制文件/Unix socket 位于当前用户私有权限的监管目录，秘密握手独立于公开 Job nonce，先核 launchctl 返回的准确 guardian PID，再传业务帧。相对 socket 路径支持长 Profile 路径。guardian 在启动业务前取得[owned resource coalition](../platform/process/darwin-owned-coalition.ts)：原自身 unique/pidversion/coalition 稳定且内核 task count 必须为1。fork/exec/setsid/orphan 后代仍属于该资源 coalition；有界 PID 观察只用于选择成员，信号用内核原 pidversion audit token，绝不回退数值 kill。

自然退出、cancel、父 EOF/SIGKILL 加入同一次停止。完整子树为空要求原 guardian 仍在同一 coalition、内核 count=1、原命令根已退出，再核原根/组证明及准确 reap。只有本次 coalition 的证明才保存 `processTreeStopped:true`；普通 POSIX groupStopped 继续只表达原组。正常 broker 尝试准确 bootout，再须核准确 label absence 和原私有目录清理才交付私有 terminal；adapter 暂存首个终态，等原 broker 的真实 exit 与 stdout/stderr close 后才发布原 Job 的 ended 结果。失联、容量不足、身份漂移或清理不确定保存 unknown。父已退出时 guardian 只在全树证明后删除原目录并撤销自己的注册。原 cold reference 仅供读取，不创建新 handle 或重跑。

[Shell process evidence](shell-process-evidence.ts)的 closed v1 `shell-owned-coalition` 随原 reference／terminal 保存，不另建 journal。binding 固定原 Session／Execution／nonce，原 `supervisorPid` 保 broker，`launchdGuardianPid` 区分 launchd 直接拥有的 guardian。启动 reference 是独立不可变快照；terminal 保存原 root 的 WNOWAIT kind/status、准确 waitpid pid/raw status/match/reap、coalition 原 unique/pidversion／claim和terminal count1、registration 清理及 broker 的实际父方 exit/reap。guardian 的 exit 恒为 null，只记录实际原 birth 已 absent 或被新 birth reuse，不能代造 launchd reap。首个私有 terminal 不被后来帧覆写；缺 broker 回收在原有限期限内保 unknown，迟到停止证明不改写已记录的未知 effect。startup 5000ms、cancel grace+4000ms、输出和权限边界保持；纯 decoder 只读原数据，不取得新控制权。

Shell 在原 broker spawn 后立即登记所属 handle。启动超时、协议错误或首帧写入失败沿 `JobStartError` 把同一个 handle 交还 Execution；保持原双向通道，以原 nonce 取消并接收迟到 ready／停止证明，不提前发送 EOF。每次读取 reference 取得独立快照，迟到身份只补充原 handle 当前可证明的身份，不改写已经返回的快照或已记录的 unknown 效果。未确认原树停止及所属资源清理时，dispose 拒绝释放；取得原证明后可重试同一 handle，不能重发业务命令。无 PID 的原 spawn 失败仅在本次清理完成后按未创建 broker 结算；清理失败保 unknown，原因解除后凭原零 broker 证明重试同一清理，不再 spawn，也不覆盖原未知业务结果。[启动接管回归](../../test/isolated/jobs/shell-startup-handoff.test.ts)覆盖迟到 ready、协议／写入失败、停止未知、零 broker 清理重试及 Runtime 关闭。

创建任何临时资源及调用 host resolver 前，纯平台／取消／输入／启动资产预检的失败以 `JobStartError(undefined)` 明确报告未尝试 adapter，保准确 failed／cancelled 并释放原名额。该证书不覆盖 `trustedWorkerLaunch`、`prepare` 或其后的未知资源清理。上述回归通过真实 Runtime／SQLite 连续核四次缺失监督器失败后，同一 Runtime 的健康 Shell 正常执行，原 binding 与执行名额均释放；不以重建 Runtime 绕过资源占用。

launchd 启动失败先标记原启动结束并关闭本 server 已接纳的全部 socket，再等待 server 关闭；结束后交付的排队连接立即关闭。正在核对准确 PID 的认证响应迟到时，须再次核原启动及 socket 仍有效，不能重新接纳业务。关闭 socket 本身不构成进程树停止证明；原注册 bootout、准确 label absence 与树证明仍独立执行。[通道回归](../../test/isolated/jobs/darwin-launchd-channel.test.ts)保留真实启动期限，覆盖认证在途、排队连接及迟到认证的零业务派发。

默认两 Service 的[普通连续任务](../../../../tests/fixtures/unified-agent/soak/continuous-default-shell.ts)仍从原 Files／required Task／detached Shell／wait 完整链取得终态和输出；新 producer 必须消费这份原 Shell 交接，关闭后核完整原 result、startup reference 身份、输出／Command／cursor及Provider零重放。旧 continuous v2 缺字段保持旧语义，有新字段必核严格 decoder 与原 owner；它不补授原九点RSS或全部Runtime资源资格。

[真实 host 测试](../../test/isolated/jobs/macos-host-shell.test.ts)11项/65断言已在 macOS26.7.1 arm64/Bun1.4.2 运行通过：宿主工具/fork/HOME/广泛读取、两种写范围、IP与带无沙箱正例的Unix拒绝、实际 Full 父目录 rename/hardlink拒绝、自然根退出后的 setsid/grandchildren、重复取消/无关存活、长控制路径、输出gap和父 EOF/SIGKILL及准确标签已撤销后的清理。夹具先完整关闭 PID 记录，再原子发布就绪路径；父退出场景核三项均为正整数后才观察实际后代。原清理断言和观察期限保持。默认消费者、最终 Ask/Full 快照、源码树外/持久输出及持续负载分别归[Service owner](../../../../apps/service/README.md#默认-shell-装配)和[韧性 owner](../../../../docs/active/runtime-resilience-qualification.md)。这些不等于跨平台、全部原生资源指标或完整发布 qualification。

自定义普通 host 与 confined 工厂仍可显式接可信 `protectedFiles`，与必须存在且为目录的 `protectedRoots` 分开。[私有文件准备](protected-files.ts)只观察路径及最近存在父目录的 metadata，不读认证正文或计算文件摘要；派发前核父目录和 canonical 名称，允许原文件缺失、稍后创建或正常原子轮换。macOS 规则拒绝原路径／canonical 名称的读取、写入与映射，并保护祖先改名及尚不存在父目录的重定向。认证位于授权 Workspace 内也不取得读取资格。[实际私有文件回归](../../test/isolated/jobs/protected-files.test.ts)覆盖默认 host、Workspace／Full、缺失路径、轮换及低层 confined 工厂，普通 Workspace 写入继续可用。

## Profile Skill 的准确只读来源

本节保留原 Workflow verifier 的低层隔离取舍和历史验证。执行调用链已退役，以下工厂与 helper 不构成当前 Skill 执行入口。

[read-only-source](read-only-source.ts)只接可信verifier在原来源复核后提供的准确canonical Skill cwd。来源必须是保护根的严格子树，不能包含原Workspace或其他保护根，与control双向不重叠；原Workspace仍不能位于保护根内，confined拒绝此选项。全部原目录和祖先身份仍在派发前复验；不是模型参数、通用文件grant或新的恢复控制权。

macOS host在读取deny中精确减去该子树及必要祖先metadata，单独拒绝祖先data／xattr读取；整保护根write／unlink／ioctl和native exec-map禁止保留，Full也不能移动原来源或其祖先。Linux host用每级独立私有tmpfs代替原Profile祖先，只接回原来源ro-bind；init在P后／业务fork前持原DIR FD核每级0700 tmpfs只有唯一下级和来源原dev／ino／RO，改0111并逐项封RO／NOEXEC／NOSUID／NODEV，复核closed children／原内部身份并严格关闭FD后清空capabilities。其他mask仍为000；来源内未声明子mount拒绝，unknown不打开业务gate。

原目录投影保原cwd、相对导入及忽略目录资源；`contract.files`仍只约束其实际参与摘要的文件，不把该集合当完整目录镜像。外部不合作同UID最后一刻替换仍是原可信宿主边界。[原生verifier整例](https://github.com/ferqx/kite-code/blob/840f71b315e5b2a48f370449ddb3dd5048dfdee8/packages/agent/test/isolated/business/skill-workflow-host-verifier.test.ts)实际核macOS Workspace／Full下完整读取、私有保护、source drift、准确取消与超时的原coalition结束；[正式Service整例](https://github.com/ferqx/kite-code/blob/840f71b315e5b2a48f370449ddb3dd5048dfdee8/apps/service/test/isolated/skill-workflow-profile-host.test.ts)另核完整Run／proof和cold零重放。Linux源码、纯协议与C语法适配通过不代对应Linux原生资格；取舍见[原来源决定](../../../../.agents/notes/implemented/architecture/2026-10-10-profile-workflow-read-only-original-source.md)。

## 固定 macOS confined Shell

同一公开 `@kite-ai/agent/jobs/shell` leaf 的 `createMacosConfinedShellJob(options)` 接受原 `ShellJobOptions` 与可信宿主的 `runtimeReadOnlyRoots?: readonly string[]`、`protectedRoots: readonly string[]`、`temporaryRoot?: string`。唯一 Job input 仍为 `{command}`，没有 Model/HTTP 可选 launcher、profile、网络模式或隔离声明。factory 只捕获事实，不启动进程；真正 start 在普通权限/资源等待后核原 canonical Workspace、只读/保护目录和固定 Bun、shell、guardian、`/usr/bin/sandbox-exec` 文件 identity/digest，guardian 接收私有帧后再次复核。profile 固定生成于内存，`-p` 原字节及 digest 随私有 executable/argv tuple 使用；缺平台、缺资产、漂移、无效 profile 都不回退普通 Shell。

[Seatbelt](seatbelt.ts) 固定 restricted read、Workspace write、network deny。显式只读根允许读、拒绝写；protected roots 覆盖 Workspace allow，拒绝读/写/映射。只选明确系统运行依赖与固定 runtime，不从 PATH 搜索 Bun/Node 或自动放行 Homebrew/home。宿主必须把原 profile、配置/凭据、协调目录等实际保护根传入；readonly 根只表示 OS 路径权限，不证明其中的脚本来源或内容没变。业务调用者仍负责原声明/binding、最后业务新鲜度和完整只读脚本/资产封存，不能仅 hash 原可写脚本后重新执行它。

每次 start 建立独立 0700 temp，设置 HOME/TMPDIR/TMP/TEMP；temp base 必须在 Workspace 外，避免任务重命名其宿主容器。显式禁止 temp 的 process-exec 和 file-map-executable；仅遗漏 allow 不构成拒绝。loader/startup 注入环境变量被移除，其他 env 仍由可信宿主显式选择。真实原组停止后 guardian 删除原 dev/ino temp，覆盖父 EOF/SIGKILL；清理身份变化或停止不可核实保留 unknown，不删除替换目录。该文件核验与 spawn 不宣称跨文件系统原子，不能防住任意同 UID 外部攻击者的最后一刻替换。

此 factory **固定禁止 process-fork**。当前实际 macOS 资格确认 Bun JS 与线程正常运行，但 Bun.spawn、fork、libc daemon 和原 session-leader setsid 均被拒绝；same-sandbox signal 无权终止无关进程。需要子进程的脚本不在本 factory 支持范围，须如实失败，不借用户批准扩大权限。普通 createShellJob 仍保持 POSIX 监督契约：真实 allow-fork+setsid 反例证明原 process group 消失后仍可有活 daemon，因此普通 groupStopped 不代表任意已逃逸进程树消失，不能把它当完整进程隔离。confined factory 的 stopped 资格依赖固定 deny-fork 的实际 OS 边界；不开一个可选 allow-fork 模式并沿用同样证明。

[真实 confined 测试](../../test/isolated/jobs/confined-shell.test.ts)覆盖原 allow-fork 逃逸反例、固定 fork/daemon/setsid/foreign signal 拒绝，Workspace/temp 写与 readonly/protected/外部/symlink 拒绝，TCP+Unix 零接收、temp native exec 拒绝、factory/guardian root/profile 漂移零启动、TERM 忽略强停、父 EOF/SIGKILL 与私有 temp 清理、完整公开 manifest 源码树外 guardian 定位及缺资产拒绝。普通 Shell 原后代/自然退出/输出预算测试同时复验。当前实际资格仅为 macOS；Linux 的独立 confined factory 已接源码但未执行原生资格，原 macOS factory 在其他平台仍拒绝，Windows 未提供后端。普通 Shell 的平台资格不因此改变。该基础不等于所有补偿脚本都可运行。

## Linux 宿主与严格补偿源码

Linux `protectedFiles` 复用既有目录 mask；2026-11-06 后普通 Service 不自动提供认证保护，以下目录隔离合同适用于显式配置的自定义宿主及原 confined，不代表当前普通默认值。独立自定义目录及 Workspace 内私有子目录保持正常执行与真实 Workspace／Full 写入；长任务期间宿主原子轮换认证叶仍由父目录 mask 持续保护。工厂与 Run 准备只捕获 metadata；仅在已授权 Job 派发时，[私有目录准备](linux-private-directory.ts)沿最近存在父目录的原 FD 逐级 mkdir／no-follow，创建0700缺失目录，不打开认证、不改既有 mode、不删除共享目录。重叠 HOME／Workspace／资产／temp 的宽根及可被业务重定向的别名仅使原 Job 以 `linux_shell_private_file_layout_invalid` 失败；正常专用目录不受影响。原已核实 Skill 来源仍只能走准确只读投影，原生挂载检查不放宽。历史决定和代价见[认证目录隔离](../../../../.agents/notes/implemented/architecture/2026-10-24-linux-codex-shell-isolation.md)。

2026-10-24 在 Linux6.12.69-linuxkit arm64／Bun1.4.2／Bubblewrap0.12.0 的隔离容器中，12个准确整文件69项／782断言、零跳过／失败通过；包含6项真实 native namespace、正式 Service／SDK／Shell／Files 工具循环、深 coordination、缺失认证目录、Workspace／Full 新建读写、长任务四次认证原子轮换及准确 Skill 只读投影。仅测试副本补建原 Rust Files／Workflow worker 资产，network=none，只挂隔离源码副本，没有挂真实 HOME／凭据或主工作树。exact命令、环境和测试时源码摘要在 `dist/unified-evidence/linux-codex-shell-20261024.json`，原日志在同目录 `.log`；本轮证据不扩为安装发行、其他架构或全部 Linux 内核资格。

随后默认 HOME 来源仅补只读物理路径归一，防止系统 HOME 别名误触专用目录规则；显式 `codexHome` 及原 namespace 执行叶未变，原真实 Linux 夹具使用的分支可复用该证据。新增来源分支由 macOS 上的 Source／Codex Connection／User Configuration 三文件38项／327断言、1项 Linux 跳过补验，覆盖合成 HOME 别名、缺失／相对路径、无目录或认证写入；原 Linux 日志和源码摘要保留测试时事实，不改写为后来代码的执行证明。

正式深 coordination 的原祖先 self-bind 若位于外层私有 mask 内，会成为不可见子挂载并被 native 严格检查拒绝。布局仅剔除这些无用途的隐藏父挂载，全部原宿主身份仍复核，准确来源 scaffold 保留，native 检查没有放宽。对应正式深路径已加入原[实际 native 夹具](../../test/isolated/jobs/linux-native-shell.test.ts)。

[linux-preparation](linux-preparation.ts)捕获实际 cwd 与独立授权 Workspace、全部原保护根、固定解释器／Bun／init／Bubblewrap、runtimeAssets、运行根和 temp 的身份。host 保广泛读取、宿主 HOME 和最终派发的独立 filesystem/network 范围；confined 只暴露固定系统根、只读资产、Workspace 与私有 temp，拒网络及非线程 fork，要求 cwd 等于 Workspace。外层保护 mask 覆盖嵌套 coordination，原子目录身份仍逐项复验；实际 mount 与 native 协议共用可见最外层 mask。可执行证明只收已绑定的 canonical regular file，原 `/bin/sh` 等别名仍参与身份漂移检查。保护祖先自绑定阻止改名；未知子 mount 不猜成许可。confined 的 Workspace、私有 temp、只读数据目录及相关子挂载由 init 核 NOEXEC／NOSUID／NODEV，保留原只读 flags。

[native init](../../native/linux-shell-init.c)为新 PID namespace 的 PID 1；[Service 内原 owner](../platform/process/linux-owned-shell.ts)在 namespace 外持原 ChildProcess、私有 SOCK_SEQPACKET、原 init/root pidfd 与 namespace FD。业务尚未创建时先交接 namespace 原对象和 kernel credentials，父端核实际 birth／parent／NSpid 后发 P；init 以 namespace 内唯一 CAP_SYS_ADMIN 封闭 mounts、清空 capabilities，再交接被 gate 阻住的原 root；父端接纳才发 G。init 的 DUMPABLE=0 阻断业务经 `/proc` 取得控制 FD，业务仅有 stdio 0/1/2。网络、namespace/mount、clone3 和 io_uring 的固定 syscall 门禁由原 C filter执行，不由 command JSON 配置。network=none 增加 Bubblewrap `--unshare-net`；原 trusted argv 的闭合 `--network-scope` 使 socket/socketpair 独立于 filesystem mode，原 profileDigest 绑定该范围。原低层未提供新字段的 argv ABI 保留，冷证据不新增控制权。

[普通 Linux Job](linux-shell.ts)持续排空真实双流，沿原输出预算保存 UTF-8、gap 和一个 terminal；公开输入仍只有 command。自然根的 WNOWAIT／准确 waitpid 后在本 namespace 内清理剩余后代直到 ECHILD。正常 ended 还须原 wrapper 实际 exit0／close、双流 EOF、两枚原 pidfd 死亡和每个原 FD 严格关闭，随后才能删除原 temp。可信 worker 的 cancel/dispose 同时等待 adapter 完成严格输出解码、终态发布和 temp 清理，不以 native completion 单独代替 Job 收尾；失败的 dispose 不永久缓存拒绝，重试仍核原监督与清理事实。[隔离收尾回归](../../test/isolated/jobs/linux-trusted-shell-completion.test.ts)调用实际 adapter，替换原生 owner 与准备层，覆盖活动 Job 释放、串行／并行取消及未知和输出错误；它不授予 Linux 原生资格。`--die-with-parent` 只为 crash fallback，不能代正常证明。首个 unknown 保持不变；有效原 init pidfd可作一次清理，Close 未确认不重试，强持原对象。同步启动或准备清理未知通过原 facade／handle交回 Runtime，dispose继续失败，resource与binding lease不提前释放。

[closed v2 冷证据](linux-shell-process-evidence.ts)使用 `shell-owned-pid-namespace`，绑定原 Session／Execution／nonce，保存原 wrapper、namespace、init/root birth／parent／localPid与原 wait receipt、EOF／FD关闭事实。公共 decoder按版本选择原 macOS v1 或 Linux v2，冷解码只读复制并冻结数据，不进行 native I/O、恢复进程控制或重跑。Linux[默认连续任务调用者](../../../../tests/fixtures/unified-agent/soak/continuous-default-shell.ts)现以独立continuous v3消费同候选的原ready reference及终态证明，核完整原身份、业务wait0／raw0和严格结束；cold完整reference／result／output／Command／cursor及Provider零重放保持。Mac continuous v2仍消费自身v1；两Service有限资源收据与全部Runtime／RSS资格各自独立，Linux原生和installed资格尚未取得，详见[韧性合同](../../../../docs/active/runtime-resilience-qualification.md)。

Linux [build-assets](build-assets.ts)在构建机器使用 C compiler生成 ELF64 native init，核对应 x64／arm64 machine、0755后纳入完整候选 inventory；已安装机器只定位包内 `platform/process/linux-shell-init`，不编译或退回 `.ts`。构建依赖 compiler、执行依赖 Bubblewrap及相应内核能力；缺依赖失败封闭，代码与静态检查不证明其存在。

Shell 与 MCP 两个 Linux init 的 unknown-owner 固定 stderr 诊断按 `sizeof(diagnostic)-1` 的准确长度写入，EINTR重试，短写或错误继续标记unknown；原无限等待和零完成receipt保持。该修复保正式FORTIFY／Werror构建约束，不增加产品能力。[诊断回归](../../test/isolated/jobs/linux-init-diagnostic.test.ts)在正式C编译参数下分别核成功、EINTR、短写及EIO（两项／20断言）；完整八workspace build通过不替代namespace或安装运行资格。

[准备层](../../test/isolated/jobs/linux-preparation.test.ts)、[原 owner mock](../../test/isolated/jobs/linux-owned-shell.test.ts)、[普通 Job 生命周期](../../test/isolated/jobs/linux-shell.test.ts)、[冷证据](../../test/isolated/jobs/linux-shell-process-evidence.test.ts)和[正式 Service 装配](../../../../apps/service/test/isolated/linux-shell-configuration.test.ts)已分别实际执行纯布局／身份、模拟内核交接、输出／取消／unknown、严格冷形状与真实配置接线；不执行 Linux 内核。[四个原生整例](../../test/isolated/jobs/linux-native-shell.test.ts)定义文件／网络／fork／temp exec、自然脱离后代和准确取消的验收；[历史 Workflow 来源整例](https://github.com/ferqx/kite-code/blob/840f71b315e5b2a48f370449ddb3dd5048dfdee8/apps/service/test/isolated/skill-workflow-profile-host.test.ts)另定义原 Profile／Workspace与零启动漂移闭环，执行入口现已退役。Linux缺工具／编译／执行失败直接失败，本机platform skip及macOS通过不计Linux资格。Linux ABI／完整 installed用户链仍依原资格范围核验；Windows 默认后端见上节，RSS与完整Runtime观测仍保原退出缺口。

2026-11-06 普通 Shell 路径调整：默认不再 mask Profile/config/Codex/Browser/controlBase 或整目录 runtimeReadOnlyRoots；macOS 实际Full读写及监管回归、Linux装配模拟与自定义显式保护分别验证。Linux native init 要求准确可执行文件 RO，其最小 binary bind 与资产验真保留；ordinary 变更不修改 confined 与退休 verifier 的历史合同。
