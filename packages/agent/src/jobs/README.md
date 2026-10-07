# Shell Job leaf

本 leaf 提供普通 POSIX、固定 confined 和 macOS 宿主三个可信工厂。固定 confined 的 deny-fork 理由仍见[原决定](../../../../.agents/notes/implemented/architecture/2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)；默认宿主允许 fork 的完整后代方案见[新决定](../../../../.agents/notes/implemented/architecture/2026-10-07-macos-host-shell-owned-coalition.md)。

[createShellJob](shell.ts) 保留显式 POSIX 装配。[createMacosHostShellJob](shell.ts) 由 macOS 默认 ProcessService 选择；factory/import 不启动进程，不读取旧数据。调用者明确选择 cwd/env，统一宿主负责命令、工作区权限与派发；Job input 仅包含 command，Model/HTTP 不能提供 launcher、路径范围或隔离声明。根 manifest 的 `./jobs/shell` 是公开 leaf 导出。

命令通过独立 Bun [guardian](../platform/process/shell-supervisor.ts) 在新的 POSIX process group 内运行。私有 stdin 控制管道只承载本次启动/取消与真实父生命期：父 EOF 或强杀会让 guardian 清理整个命令组；HTTP/SSE 断线不影响该管道。正常 shell 退出也先清理仍在组内的后台后代。自然退出、cancel、EOF 和失败共用一次 closing；后到入口加入原清理，保留首个进入 closing 的终态事实，不重复 TERM/KILL、清理或发布 terminal。停止先 SIGTERM、有界等待，再必要时 SIGKILL；只有后端核实原组停止并完成原根收尾才报告 stopped/groupStopped，不把单个 pid 退出当停止确认。无法确认时返回 unknown 与 terminal supervision=unknown，不伪装成功；只有 groupStopped 的证明产生 supervision=ended。较晚停止证明只补充监督事实，不能把已记录的未知 effect 改为成功。调用 cancel/dispose 幂等，host 是唯一业务事件观察者。

macOS 使用私有 [Darwin owned-child port](../platform/process/darwin-owned-child.ts)：原生 posix_spawn 以 SETSID 创建准确 PID=PGID=SID，stdout/stderr 使用自有非阻塞 pipe，argv/env CString 在 native 调用结束前保活。waitid/WNOWAIT 读取原根真实退出但不回收，让内核保留原 PID/组/会话身份；不在 Node/Bun 已自动回收的数值 PGID 上继续发组信号。停止证明要求有界 libproc 完整成员表恰好只含原根，并在前后取得一致的 WNOWAIT 原退出事实；任何其他成员、容量不足或观察失败均继续有限等待或 unknown，EPERM/ESRCH 本身不成为停止证明。确认后排空输出，waitpid 精确回收一次原根，再清理准确私有 temp；回收后不再发组信号。动态库与自有 FD 由同一 owner 管理，完成回收及 FD 关闭后释放。此取舍与最小替代方案见[决定记录](../../../../.agents/notes/implemented/bug-fix/2026-10-06-macos-shell-root-ownership.md)。

guardian 连续排空 stdout/stderr，不等待业务观察回调；每块 UTF-8 内容最多 32 KiB。adapter 默认输出队列 256 KiB，超限保留明确 output_dropped 字节区间，控制终态不会被丢弃；单消费者迟缓或尚未 observe 时也不会无限缓存输出。输入、内部协议帧和启动/停止等待均有界。

[build-assets](build-assets.ts) 将 guardian bundle 到 `dist/platform/process/shell-supervisor.js`。built `dist/jobs/shell.js` 自动定位该资产，固定当前 Bun 执行它；源码测试显式传入已编译 guardian 路径，不回退到 `.ts` 源码。编译为单一 executable 的宿主应从发行资产根显式选定 supervisorPath，不能依赖虚拟 import.meta 路径。凭据/env 经私有管道传递，不进入 helper argv。

其他公开 leaf（包括 Workflow verifier）通过 `@kite-ai/agent/jobs/shell` 使用此实现，完整包构建保留独立公开依赖。不能把含相对资产定位的实现以内部相对 import 合并进任意共享 chunk；实际完整 manifest 的源码树外测试同时验证多个入口装配与 guardian 路径。

[真实测试](../../test/isolated/jobs/shell.test.ts) 在 macOS 验证正常/自然终态、真实子进程组与后代清理、TERM 忽略的强制停止、无关进程保持存活、父 fixture EOF/强杀、输出 gap 与离开源码树的资产定位。该父 fixture 直接运行公开 leaf，证明监督机制；[真实 Service/Core 集成](../../../../tests/isolated/unified-agent/shell-service.test.ts) 使用公开 paired 启动、Action 子操作和已构建 guardian，验证同 profile 的 Session owner 与 Workspace OS 锁、取消回执先于进程组停止、真实输出 GET、Service 父 EOF 与 SIGKILL 清后代且不杀无关进程。EOF 正常停机保存 cancelled；强杀后通过显式恢复保存 outcome_unknown，重开及重复原命令不重启旧 Shell。恢复中的 unknown 不宣称外部 effect 已成功或可重放。Linux 的代码路径存在但本轮运行资格 pending；Windows 明确 unsupported；PTY、Windows Job Object 和三平台发行签名/权限仍 pending。旧 POSIX 实现最终退役状态不由这些叶子测试宣告完成。

原 native 根所有权证据仅在 macOS arm64/Bun 1.4.2 实际运行。[Native 回归](../../test/isolated/jobs/darwin-owned-child.test.ts)核冷 import 零 native I/O、强制 GC 后完整 argv/env、双 pipe 全文、重复 WNOWAIT、原根自然退出后真实 child/grandchild 强停、启动失败零 child/FD 漏出及准确一次 reap。普通 POSIX、严格 confined、显式 Service/Core 与声明补偿各自保留原证据，不能扩为允许 fork 的全树证明。默认宿主的新范围与实际测试见下节；x86_64 ABI 尚未本机执行，Win/Linux 运行验证依用户选择延后到重构完成后的 GitHub Actions。

2026-10-07 先核验了 Endpoint Security 后代接口：SDK27 声明最低 macOS27 与 entitlement，本机 macOS26.7.1 运行库实际没有该符号。它没有成为当前实现依赖；NOTE_TRACK/NOTE_CHILD 也不能提供此证明。探针及限制保留于[阶段证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07宿主-shell-完整后代接口的运行资格)。当前采用下节实际验证过的 launchd resource coalition。

2026-10-07完整默认图在失败启动例的全局`waitid(P_ALL)`断言观察到0，FD集合相等已通过；原记录未保存si_pid，具体child来源未知。准确已知无关child正例证明：40次原失败启动没有新增child/FD，全局P_ALL仍可合法返回0。该例现将原40次throw、完整FD集合相等、严格waitid=-1/ECHILD三项共43条检查放进只执行失败启动的独立进程；父进程真实无关child在probe前后仍活着。原5秒整例保留，probe明确3秒kill/await，全部six场景和原其他断言不变；有限6pass/35条父Bun断言及43条child断言通过。该修正只限定测试所观察的进程namespace，不放宽生产停止证明，不接受waitid=0作为无child。原全图失败、最小反例与阶段复验归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。

仅当前 host 创建的 JobHandle 可观察/取消。JSON reference 可持久保存，但新 host 的恢复不能重新构造旧内存 handle 来执行：本 leaf 尚无 reconcile，未知执行按 core 恢复契约处理，不能自动重跑旧 Shell。

普通 Tool 的 `reportProgress` 可由宿主写入同一有界输出表：存储只接受实际已派发、仍为 dispatching/running 的 Tool、stream=progress。该事实不会修改 Execution 状态，stdout/stderr 仍仅供 Job；取消已提交后的迟到事实可保存，终态以后不再追加 Tool progress。沿用 Job 输出的 32 KiB chunk、JSON/行开销预算、独立 Decimal64 高水位和 owner generation 核实。真实拒绝与迟到事实测试见 storage/jobs.test.ts。

Store output paging preserves the one MiB JSON/row-overhead budget independently of terminal facts. A producer drop begins that stream's coalesced tail gap; other streams can still retain normal output while the total budget is available. `output_truncated` records that clipping occurred, while the internal `output_budget_exhausted` flag closes further retention after the global budget fails. There are at most three stream gaps. GET merges every gap intersecting the bounded normal-row page, clipping a gap to the last retained normal-row boundary when more content may remain; clipped byte attribution is null. Cross-stream gap intervals may overlap, so a consumer advances afterSeq to the maximum throughSeq on the page, rather than treating gaps as exclusive global intervals or using only the last item's endpoint. Real Store tests in test/isolated/storage/jobs.test.ts generate 220 normal chunks interleaved with three actual producer gaps through appendExecutionOutput, retain every chunk across a 200-row page, and verify overlapping tail ranges and readonly cursors without SQL relocation.

## 默认 macOS 宿主 Shell

[host-preparation](host-preparation.ts)捕获真实 canonical Workspace、Profile/coordination、只读 runtimeAssets、Bun/shell/guardian/sandbox-exec 的 dev/ino/mode 和文件摘要。Job.start 在普通资源等待与最终派发事务之后从可信 `JobContext.dispatchAuthorization` 选取 `workspace_write` 或 `full_access`；Service 有界展开原根及子 Agent 父子交集，仅全部已接纳的默认策略叶为 Full 时选择宿主写范围，其他受支持叶取 Workspace 范围，缺失或未知策略拒绝。复核原身份后生成固定 Seatbelt。宿主 HOME 与工具链保留；所有后代继承 sandbox。非 Full 写 Workspace/本次私有 temp，允许 IP、拒绝 Unix bind/outbound；Full 允许宿主写/网络。实际 private roots 拒绝读/写/映射，准确 runtimeAssets 与运行根只读；准确祖先的 unlink 拒绝阻止 Full 通过重命名父目录绕过这些边界。temp 在 Workspace 外、0700，并拒绝 temp exec/map；注入环境变量仍移除。该捕获和 spawn 不宣称防住任意不合作的同 UID 外部替换。

[launchd broker](../platform/process/darwin-launchd-supervisor.ts)以随机准确标签注册本用户 Background guardian。控制文件/Unix socket 位于实际受保护的私有目录，秘密握手独立于公开 Job nonce，先核 launchctl 返回的准确 guardian PID，再传业务帧。相对 socket 路径支持长 Profile 路径。guardian 在启动业务前取得[owned resource coalition](../platform/process/darwin-owned-coalition.ts)：原自身 unique/pidversion/coalition 稳定且内核 task count 必须为1。fork/exec/setsid/orphan 后代仍属于该资源 coalition；有界 PID 观察只用于选择成员，信号用内核原 pidversion audit token，绝不回退数值 kill。

自然退出、cancel、父 EOF/SIGKILL 加入同一次停止。完整子树为空要求原 guardian 仍在同一 coalition、内核 count=1、原命令根已退出，再核原根/组证明及准确 reap。只有本次 coalition 的证明才保存 `processTreeStopped:true`；普通 POSIX groupStopped 继续只表达原组。正常 broker 尝试准确 bootout，再须核准确 label absence 和原私有目录清理才交付 terminal；失联、容量不足、身份漂移或清理不确定保存 unknown。父已退出时 guardian 只在全树证明后删除原目录并撤销自己的注册。原 cold reference 仅供读取，不创建新 handle 或重跑。

[真实 host 测试](../../test/isolated/jobs/macos-host-shell.test.ts)11项/65断言已在 macOS26.7.1 arm64/Bun1.4.2 运行通过：宿主工具/fork/HOME/广泛读取、两种写范围、IP与带无沙箱正例的Unix拒绝、实际 Full 父目录 rename/hardlink拒绝、自然根退出后的 setsid/grandchildren、重复取消/无关存活、长控制路径、输出gap和父 EOF/SIGKILL及准确标签已撤销后的清理。夹具先完整关闭 PID 记录，再原子发布就绪路径；父退出场景核三项均为正整数后才观察实际后代。原清理断言和观察期限保持。默认消费者、最终 Ask/Full 快照、源码树外/持久输出及持续负载分别归[Service owner](../../../../apps/service/README.md#默认-shell-装配)和[韧性 owner](../../../../docs/active/runtime-resilience-qualification.md)。这些不等于跨平台、全部原生资源指标或完整发布 qualification。

## 固定 macOS confined Shell

同一公开 `@kite-ai/agent/jobs/shell` leaf 的 `createMacosConfinedShellJob(options)` 接受原 `ShellJobOptions` 与可信宿主的 `runtimeReadOnlyRoots?: readonly string[]`、`protectedRoots: readonly string[]`、`temporaryRoot?: string`。唯一 Job input 仍为 `{command}`，没有 Model/HTTP 可选 launcher、profile、网络模式或隔离声明。factory 只捕获事实，不启动进程；真正 start 在普通权限/资源等待后核原 canonical Workspace、只读/保护目录和固定 Bun、shell、guardian、`/usr/bin/sandbox-exec` 文件 identity/digest，guardian 接收私有帧后再次复核。profile 固定生成于内存，`-p` 原字节及 digest 随私有 executable/argv tuple 使用；缺平台、缺资产、漂移、无效 profile 都不回退普通 Shell。

[Seatbelt](seatbelt.ts) 固定 restricted read、Workspace write、network deny。显式只读根允许读、拒绝写；protected roots 覆盖 Workspace allow，拒绝读/写/映射。只选明确系统运行依赖与固定 runtime，不从 PATH 搜索 Bun/Node 或自动放行 Homebrew/home。宿主必须把原 profile、配置/凭据、协调目录等实际保护根传入；readonly 根只表示 OS 路径权限，不证明其中的脚本来源或内容没变。业务调用者仍负责原声明/binding、最后业务新鲜度和完整只读脚本/资产封存，不能仅 hash 原可写脚本后重新执行它。

每次 start 建立独立 0700 temp，设置 HOME/TMPDIR/TMP/TEMP；temp base 必须在 Workspace 外，避免任务重命名其宿主容器。显式禁止 temp 的 process-exec 和 file-map-executable；仅遗漏 allow 不构成拒绝。loader/startup 注入环境变量被移除，其他 env 仍由可信宿主显式选择。真实原组停止后 guardian 删除原 dev/ino temp，覆盖父 EOF/SIGKILL；清理身份变化或停止不可核实保留 unknown，不删除替换目录。该文件核验与 spawn 不宣称跨文件系统原子，不能防住任意同 UID 外部攻击者的最后一刻替换。

此 factory **固定禁止 process-fork**。当前实际 macOS 资格确认 Bun JS 与线程正常运行，但 Bun.spawn、fork、libc daemon 和原 session-leader setsid 均被拒绝；same-sandbox signal 无权终止无关进程。需要子进程的脚本不在本 factory 支持范围，须如实失败，不借用户批准扩大权限。普通 createShellJob 仍保持 POSIX 监督契约：真实 allow-fork+setsid 反例证明原 process group 消失后仍可有活 daemon，因此普通 groupStopped 不代表任意已逃逸进程树消失，不能把它当完整进程隔离。confined factory 的 stopped 资格依赖固定 deny-fork 的实际 OS 边界；不开一个可选 allow-fork 模式并沿用同样证明。

[真实 confined 测试](../../test/isolated/jobs/confined-shell.test.ts)覆盖原 allow-fork 逃逸反例、固定 fork/daemon/setsid/foreign signal 拒绝，Workspace/temp 写与 readonly/protected/外部/symlink 拒绝，TCP+Unix 零接收、temp native exec 拒绝、factory/guardian root/profile 漂移零启动、TERM 忽略强停、父 EOF/SIGKILL 与私有 temp 清理、完整公开 manifest 源码树外 guardian 定位及缺资产拒绝。普通 Shell 原后代/自然退出/输出预算测试同时复验。当前资格仅为 macOS；Linux/Windows confined factory 均明确拒绝，普通 Shell 的平台状态不因此改变。该基础不等于业务 compensation 已接入或所有补偿脚本都可运行。
