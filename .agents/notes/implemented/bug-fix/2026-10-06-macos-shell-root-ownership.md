# Agent Note: macOS Shell 保留原根以拥有进程组停止

Status: implemented

## Problem

Shell 根命令可以先退出，后台后代仍需清理。原 guardian 的 Node/Bun child exit 会自动回收根，只缓存数值 PGID；后续组信号缺少仍由内核保留的原身份，不能据此排除号码被复用的情况。本次没有复现向外国组误发信号，不把该风险写成已发生的事故。另一个已复现的缺陷是自然退出与 cancel 各自启动清理，真实原组收到两次 TERM。普通 Shell、显式 Service Shell 和严格受限 Workflow 补偿都实际消费该 guardian。

## Decision

macOS guardian 通过私有 Darwin owned-child port 原生启动直接 child，固定 SETSID/CLOEXEC_DEFAULT，使原 PID=PGID=SID。waitid/WNOWAIT 观察原根真实退出但不回收，让原身份在全部组信号期间仍有内核占位。停止仅接受完整、有界的 libproc 成员表恰好包含原根一项，并在表读取前后核得一致原 WNOWAIT 退出事实。其他成员即使已为 zombie 也不接纳；容量或观察不足保持有限等待或 unknown。TERM/必要 KILL 结束后先排空输出，再 waitpid 精确回收一次原根；回收以后不再发送组信号。

自然退出、cancel、EOF、失败共用原 guardian 的一次 closing，后到入口加入同一 promise，保留首个进入收尾的事实。端口自行拥有 pipe FD、原根和动态库；释放需要原根已回收且 FD 已关闭。argv/env 地址表不代替 CString 的生存期，局部强引用集合在 native spawn 返回后有真实可观察读取；核验失败保留 owner/unknown，不在成功 spawn 后抛错丢失原根。

## Alternatives considered

- 只在每次信号前核 PID 启动时间、kill(0) 或 ps：检查到信号之间仍可失去占位，不能提供同一内核原组所有权，未采用。
- 只缓存一个 stop promise：足以修复重复 TERM，不能弥补 Node/Bun 自动 reap 后的原组身份缺口；保留该最小竞态修复，并补直接 child 的 native owner。
- Darwin kqueue NOTE_TRACK/CHILD：当前平台不提供所需跟踪能力，NOTE_FORK 也不给出完整 child 身份；不能冒充可用后代监督。
- 将成员表中的非根 zombie 当作已停止：成员可能在退出前已派生新后代，条件快照不能据此证明完整停止；只采用准确原根一项的最小证明。
- 放开 fork、仅禁止 setsid/setpgid 后默认启用 Shell：真实 posix_spawn 可从内部调用改变组/会话；额外拒绝 posix_spawn 虽保传统 fork/exec，却尚不支持通用 Bun/Node 工具链。本次没有改变任何生产 Seatbelt 权限或默认装配。

## Consequences

该端口引入固定 Darwin ABI/FFI 依赖，但只在实际 start 加载库，冷 import 无 native I/O。arm64 fcntl 的 variadic ABI 不能按固定三参数调用，采用固定入口 __fcntl 并读回 CLOEXEC/nonblocking 标志。原严格 deny-fork、网络/文件/保护根/私有 temp 约束继续有效；这些原因由[原受限 Shell 决定](../architecture/2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)维护。本次只补原进程组身份与收尾，不证明普通 Shell 已逃组的任意后代，也不授予默认 ProcessService、x86_64 运行或 Linux/Windows 资格。

当前 macOS arm64/Bun 1.4.2，native 6/74、普通 Shell 最新 10/52、现有 Service/Core/Shell/补偿三文件 15/201 均实际通过；严格 confined 原 13 项在相同生产输入通过。正常 Agent build/typecheck 和四个所属 TypeScript 的 Biome 通过。原重复 TERM 红证据保留于 `/private/tmp/kite-shell-cleanup-overlap-red-20261006.log`；当前 native、竞态和消费路径日志分别为 `/private/tmp/kite-darwin-owned-child-abi/test-gc-keepalive-final.log`、`/private/tmp/kite-macos-guardian-overlap-held-root-20261006.log` 和 `/private/tmp/kite-macos-guardian-consumers-current-20261006.log`。首次 native 集成的竞态 fixture 仍等待根 PID 消失而失败；改为 cancel 前实际后代 TERM 观测后通过，保留原 5000ms 及全部业务断言。GC 回归证明参数生存期修正，不声称此前发生过 UAF。

当前完整事实与验证边界归 [Jobs owner](../../../../packages/agent/src/jobs/README.md)，平台入口归[平台 owner](../../../../packages/agent/src/platform/README.md)。

2026-10-07完整默认的失败启动例在全局P_ALL观测到0，但原FD集合相等已通过、准确child来源未留。已知自有无关child正例证明该全局条件能受harness影响；失败启动的原40次throw、FD集合、严格waitid=-1/ECHILD共43条断言现全部在fresh owner进程执行，父进程真实无关child前后仍活着。有限整个文件6pass/35条父Bun加43条child断言/actual0，原5000ms整例和生产端口保持，probe另有3000ms准确kill/await。原失败与未知、最小正例及完整阶段结果归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)；本补充只修测试namespace，不放宽进程停止证明。
