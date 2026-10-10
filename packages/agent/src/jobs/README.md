# Shell Job leaf

本 leaf 提供显式 POSIX、macOS host/confined，以及 Linux host/confined 可信工厂。macOS confined 的 deny-fork 理由仍见[原决定](../../../../.agents/notes/implemented/architecture/2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)；允许 fork 的完整后代方案见[coalition 决定](../../../../.agents/notes/implemented/architecture/2026-10-07-macos-host-shell-owned-coalition.md)。Linux 的原 namespace／gated root 取舍保留在[部分实施提案](../../../../.agents/notes/proposed/architecture/2026-10-10-linux-shell-owned-pid-namespace.md)，原生资格仍 pending。

[createShellJob](shell.ts) 保留显式 POSIX 装配。[createMacosHostShellJob](shell.ts) 由 macOS 默认 ProcessService 选择；factory/import 不启动进程，不读取旧数据。调用者明确选择 cwd/env，统一宿主负责命令、工作区权限与派发；Job input 仅包含 command，Model/HTTP 不能提供 launcher、路径范围或隔离声明。根 manifest 的 `./jobs/shell` 是公开 leaf 导出。

Linux 默认 ProcessService 现选择 `createLinuxHostShellJob`，声明补偿选择 `createLinuxConfinedShellJob`。可信宿主必须提供已经封存的 Bubblewrap 与 native init；包内资产缺失或后端不满足契约时拒绝，没有普通进程组回退。源码、完整调用者接线与原生运行资格分别核验，具体见下节。

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

[launchd broker](../platform/process/darwin-launchd-supervisor.ts)以随机准确标签注册本用户 Background guardian。共享helper另支持闭合MCP kind与有界双向RPC，MCP使用独立标签／coalition，具体归[MCP owner](../mcp/README.md#显式-stdio-guardian-port)；本Shell的原帧上限、权限、held-root／group proof和一次reap保持。控制文件/Unix socket 位于实际受保护的私有目录，秘密握手独立于公开 Job nonce，先核 launchctl 返回的准确 guardian PID，再传业务帧。相对 socket 路径支持长 Profile 路径。guardian 在启动业务前取得[owned resource coalition](../platform/process/darwin-owned-coalition.ts)：原自身 unique/pidversion/coalition 稳定且内核 task count 必须为1。fork/exec/setsid/orphan 后代仍属于该资源 coalition；有界 PID 观察只用于选择成员，信号用内核原 pidversion audit token，绝不回退数值 kill。

自然退出、cancel、父 EOF/SIGKILL 加入同一次停止。完整子树为空要求原 guardian 仍在同一 coalition、内核 count=1、原命令根已退出，再核原根/组证明及准确 reap。只有本次 coalition 的证明才保存 `processTreeStopped:true`；普通 POSIX groupStopped 继续只表达原组。正常 broker 尝试准确 bootout，再须核准确 label absence 和原私有目录清理才交付私有 terminal；adapter 暂存首个终态，等原 broker 的真实 exit 与 stdout/stderr close 后才发布原 Job 的 ended 结果。失联、容量不足、身份漂移或清理不确定保存 unknown。父已退出时 guardian 只在全树证明后删除原目录并撤销自己的注册。原 cold reference 仅供读取，不创建新 handle 或重跑。

[Shell process evidence](shell-process-evidence.ts)的 closed v1 `shell-owned-coalition` 随原 reference／terminal 保存，不另建 journal。binding 固定原 Session／Execution／nonce，原 `supervisorPid` 保 broker，`launchdGuardianPid` 区分 launchd 直接拥有的 guardian。启动 reference 是独立不可变快照；terminal 保存原 root 的 WNOWAIT kind/status、准确 waitpid pid/raw status/match/reap、coalition 原 unique/pidversion／claim和terminal count1、registration 清理及 broker 的实际父方 exit/reap。guardian 的 exit 恒为 null，只记录实际原 birth 已 absent 或被新 birth reuse，不能代造 launchd reap。首个私有 terminal 不被后来帧覆写；缺 broker 回收在原有限期限内保 unknown，迟到停止证明不改写已记录的未知 effect。startup 5000ms、cancel grace+4000ms、输出和权限边界保持；纯 decoder 只读原数据，不取得新控制权。

默认两 Service 的[普通连续任务](../../../../tests/fixtures/unified-agent/soak/continuous-default-shell.ts)仍从原 Files／required Task／detached Shell／wait 完整链取得终态和输出；新 producer 必须消费这份原 Shell 交接，关闭后核完整原 result、startup reference 身份、输出／Command／cursor及Provider零重放。旧 continuous v2 缺字段保持旧语义，有新字段必核严格 decoder 与原 owner；它不补授原九点RSS或全部Runtime资源资格。

[真实 host 测试](../../test/isolated/jobs/macos-host-shell.test.ts)11项/65断言已在 macOS26.7.1 arm64/Bun1.4.2 运行通过：宿主工具/fork/HOME/广泛读取、两种写范围、IP与带无沙箱正例的Unix拒绝、实际 Full 父目录 rename/hardlink拒绝、自然根退出后的 setsid/grandchildren、重复取消/无关存活、长控制路径、输出gap和父 EOF/SIGKILL及准确标签已撤销后的清理。夹具先完整关闭 PID 记录，再原子发布就绪路径；父退出场景核三项均为正整数后才观察实际后代。原清理断言和观察期限保持。默认消费者、最终 Ask/Full 快照、源码树外/持久输出及持续负载分别归[Service owner](../../../../apps/service/README.md#默认-shell-装配)和[韧性 owner](../../../../docs/active/runtime-resilience-qualification.md)。这些不等于跨平台、全部原生资源指标或完整发布 qualification。

## 固定 macOS confined Shell

同一公开 `@kite-ai/agent/jobs/shell` leaf 的 `createMacosConfinedShellJob(options)` 接受原 `ShellJobOptions` 与可信宿主的 `runtimeReadOnlyRoots?: readonly string[]`、`protectedRoots: readonly string[]`、`temporaryRoot?: string`。唯一 Job input 仍为 `{command}`，没有 Model/HTTP 可选 launcher、profile、网络模式或隔离声明。factory 只捕获事实，不启动进程；真正 start 在普通权限/资源等待后核原 canonical Workspace、只读/保护目录和固定 Bun、shell、guardian、`/usr/bin/sandbox-exec` 文件 identity/digest，guardian 接收私有帧后再次复核。profile 固定生成于内存，`-p` 原字节及 digest 随私有 executable/argv tuple 使用；缺平台、缺资产、漂移、无效 profile 都不回退普通 Shell。

[Seatbelt](seatbelt.ts) 固定 restricted read、Workspace write、network deny。显式只读根允许读、拒绝写；protected roots 覆盖 Workspace allow，拒绝读/写/映射。只选明确系统运行依赖与固定 runtime，不从 PATH 搜索 Bun/Node 或自动放行 Homebrew/home。宿主必须把原 profile、配置/凭据、协调目录等实际保护根传入；readonly 根只表示 OS 路径权限，不证明其中的脚本来源或内容没变。业务调用者仍负责原声明/binding、最后业务新鲜度和完整只读脚本/资产封存，不能仅 hash 原可写脚本后重新执行它。

每次 start 建立独立 0700 temp，设置 HOME/TMPDIR/TMP/TEMP；temp base 必须在 Workspace 外，避免任务重命名其宿主容器。显式禁止 temp 的 process-exec 和 file-map-executable；仅遗漏 allow 不构成拒绝。loader/startup 注入环境变量被移除，其他 env 仍由可信宿主显式选择。真实原组停止后 guardian 删除原 dev/ino temp，覆盖父 EOF/SIGKILL；清理身份变化或停止不可核实保留 unknown，不删除替换目录。该文件核验与 spawn 不宣称跨文件系统原子，不能防住任意同 UID 外部攻击者的最后一刻替换。

此 factory **固定禁止 process-fork**。当前实际 macOS 资格确认 Bun JS 与线程正常运行，但 Bun.spawn、fork、libc daemon 和原 session-leader setsid 均被拒绝；same-sandbox signal 无权终止无关进程。需要子进程的脚本不在本 factory 支持范围，须如实失败，不借用户批准扩大权限。普通 createShellJob 仍保持 POSIX 监督契约：真实 allow-fork+setsid 反例证明原 process group 消失后仍可有活 daemon，因此普通 groupStopped 不代表任意已逃逸进程树消失，不能把它当完整进程隔离。confined factory 的 stopped 资格依赖固定 deny-fork 的实际 OS 边界；不开一个可选 allow-fork 模式并沿用同样证明。

[真实 confined 测试](../../test/isolated/jobs/confined-shell.test.ts)覆盖原 allow-fork 逃逸反例、固定 fork/daemon/setsid/foreign signal 拒绝，Workspace/temp 写与 readonly/protected/外部/symlink 拒绝，TCP+Unix 零接收、temp native exec 拒绝、factory/guardian root/profile 漂移零启动、TERM 忽略强停、父 EOF/SIGKILL 与私有 temp 清理、完整公开 manifest 源码树外 guardian 定位及缺资产拒绝。普通 Shell 原后代/自然退出/输出预算测试同时复验。当前实际资格仅为 macOS；Linux 的独立 confined factory 已接源码但未执行原生资格，原 macOS factory 在其他平台仍拒绝，Windows 未提供后端。普通 Shell 的平台资格不因此改变。该基础不等于所有补偿脚本都可运行。

## Linux 宿主与严格补偿源码

[linux-preparation](linux-preparation.ts)捕获实际 cwd 与独立授权 Workspace、全部原保护根、固定解释器／Bun／init／Bubblewrap、runtimeAssets、运行根和 temp 的身份。host 保广泛读取、宿主 HOME 和最终派发的 Workspace／Full 写范围；confined 只暴露固定系统根、只读资产、Workspace 与私有 temp，拒网络及非线程 fork，要求 cwd 等于 Workspace。外层保护 mask 覆盖嵌套 coordination，原子目录身份仍逐项复验；实际 mount 与 native 协议共用可见最外层 mask。可执行证明只收已绑定的 canonical regular file，原 `/bin/sh` 等别名仍参与身份漂移检查。保护祖先自绑定阻止改名；未知子 mount 不猜成许可。confined 的 Workspace、私有 temp、只读数据目录及相关子挂载由 init 核 NOEXEC／NOSUID／NODEV，保留原只读 flags。

[native init](../../native/linux-shell-init.c)为新 PID namespace 的 PID 1；[Service 内原 owner](../platform/process/linux-owned-shell.ts)在 namespace 外持原 ChildProcess、私有 SOCK_SEQPACKET、原 init/root pidfd 与 namespace FD。业务尚未创建时先交接 namespace 原对象和 kernel credentials，父端核实际 birth／parent／NSpid 后发 P；init 以 namespace 内唯一 CAP_SYS_ADMIN 封闭 mounts、清空 capabilities，再交接被 gate 阻住的原 root；父端接纳才发 G。init 的 DUMPABLE=0 阻断业务经 `/proc` 取得控制 FD，业务仅有 stdio 0/1/2。网络、namespace/mount、clone3 和 io_uring 的固定 syscall 门禁由原 C filter执行，不由 command JSON 配置。

[普通 Linux Job](linux-shell.ts)持续排空真实双流，沿原输出预算保存 UTF-8、gap 和一个 terminal；公开输入仍只有 command。自然根的 WNOWAIT／准确 waitpid 后在本 namespace 内清理剩余后代直到 ECHILD。正常 ended 还须原 wrapper 实际 exit0／close、双流 EOF、两枚原 pidfd 死亡和每个原 FD 严格关闭，随后才能删除原 temp。`--die-with-parent` 只为 crash fallback，不能代正常证明。首个 unknown 保持不变；有效原 init pidfd可作一次清理，Close 未确认不重试，强持原对象。同步启动或准备清理未知通过原 facade／handle交回 Runtime，dispose继续失败，resource与binding lease不提前释放。

[closed v2 冷证据](linux-shell-process-evidence.ts)使用 `shell-owned-pid-namespace`，绑定原 Session／Execution／nonce，保存原 wrapper、namespace、init/root birth／parent／localPid与原 wait receipt、EOF／FD关闭事实。公共 decoder按版本选择原 macOS v1 或 Linux v2，冷解码只读复制并冻结数据，不进行 native I/O、恢复进程控制或重跑；macOS continuous producer仍明确消费自身 v1，不产生新的 RSS 样本或资源资格。

Linux [build-assets](build-assets.ts)在构建机器使用 C compiler生成 ELF64 native init，核对应 x64／arm64 machine、0755后纳入完整候选 inventory；已安装机器只定位包内 `platform/process/linux-shell-init`，不编译或退回 `.ts`。构建依赖 compiler、执行依赖 Bubblewrap及相应内核能力；缺依赖失败封闭，代码与静态检查不证明其存在。

[准备层](../../test/isolated/jobs/linux-preparation.test.ts)、[原 owner mock](../../test/isolated/jobs/linux-owned-shell.test.ts)、[普通 Job 生命周期](../../test/isolated/jobs/linux-shell.test.ts)、[冷证据](../../test/isolated/jobs/linux-shell-process-evidence.test.ts)和[正式 Service 装配](../../../../apps/service/test/isolated/linux-shell-configuration.test.ts)已分别实际执行纯布局／身份、模拟内核交接、输出／取消／unknown、严格冷形状与真实配置接线；不执行 Linux 内核。[三个原生整例](../../test/isolated/jobs/linux-native-shell.test.ts)定义文件／网络／fork／temp exec、自然脱离后代和准确取消的验收；Linux缺工具／编译／执行失败直接失败，本机macOS的3个platform skip不计通过。Linux ABI／完整 installed用户链仍依用户安排留重构后Actions。Profile内Skill verifier还缺保原cwd且不揭露私有根的精确来源投影，Windows权限后端、RSS与完整Runtime观测仍保退出缺口。
