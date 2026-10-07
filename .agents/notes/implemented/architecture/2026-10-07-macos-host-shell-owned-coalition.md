# Agent Note: 默认 macOS 宿主 Shell 使用独占 resource coalition

Status: implemented

## Problem

用户明确要求保留 macOS 宿主 Shell、工具链和广泛只读宿主视图，且先解决 macOS。普通命令需要 fork/exec，后代可 setsid 或成为 orphan；原 POSIX 进程组不能据此证明完整停止。固定 deny-fork 样本支持声明补偿，却不能满足普通宿主工具。默认 Job 还需要真实私有根/运行资产保护、最终权限范围、持久输出和父退出清理。

## Decision

默认 macOS ProcessService 选择实际 Terminal/Native 资产与宿主路径，使用普通 Tool/Job 及最终 Store 派发事务。已接受的根快照及子 Agent 的 agent.permission-intersection 父子交集进入 Job.start；Service 有界展开全部 builtin.permissions 叶，仅所有叶为 Full 时选择宿主写范围，其他受支持叶选择 Workspace/私有 temp 写，缺失或未知叶拒绝。人工和自动批准保留原快照；原 allowed=false 可表示最终事务已接纳的审批挑战，不能据此覆盖叶的硬门禁或凭元数据另造授权。权限元数据不成为第二授权接口，Model/JSONC 不能选择 launcher、保护路径或隔离声明。

固定 Seatbelt 允许 fork、保留 HOME/宿主运行根和广泛读取；后代继承边界。实际 Profile/coordination 拒读写映射，准确 runtimeAssets/运行根只读，私有 temp 不执行。Full 也拒绝这些根和准确祖先的 unlink。真实 Full 父目录 rename 先复现绕过，随后用准确祖先规则关闭；只保护子路径不足以保持其原归属。非 Full 允许 IP、拒绝 Unix socket bind/outbound，Full 使用宿主网络范围。

私有 broker 在受保护 control base 创建0700目录、独立秘密握手及随机准确本用户 launchd Background 标签。先核 launchctl 返回的原 guardian PID，再传业务帧；relative Unix socket 支持长 Profile 路径。guardian 原自身 unique/pidversion/resource coalition 稳定且内核 task count=1 时才启动命令。fork/exec 继承此资源归属，setsid/orphan 不改变它；停止信号使用成员原 pidversion audit token，内核原子比对身份，不回退数值 PID。

完整后代为空由原 guardian 仍属原 coalition、内核 task count=1、原根真实退出及 held-root/group proof 共同确认，再准确回收原根。自然退出、cancel、父 EOF/SIGKILL 共用同一次 closing。正常 broker 在原 subtree 证明后撤销标签，并以准确 print=absence 和原目录身份确认清理；bootout 成功本身不作 subtree 或清理证明，先前已经移除或移除已提交但回复丢失也可由准确 absence 确认。失联、容量不足、漂移或未确认保持 unknown。host start 只将固定非秘密错误码交给原 Core 失败合同，guardian stderr 与有界早期失败诊断留在受保护 control base，读取最多8192bytes，不用诊断代替停止证明。cold reference 只读持久结果，不重建旧 handle 或执行。

## Alternatives considered

- 只用原 PGID、PID/ppid 列表或 kqueue：实际 setsid/orphan 可逃组，PID 观察有复用窗口，Darwin NOTE_TRACK/CHILD 不提供完整跟踪；不能满足全树停止。
- 默认使用原固定 confined deny-fork：破坏需要派生进程的宿主工具；仍保留原声明补偿工厂及其理由，不给它增加可选 allow-fork。
- Endpoint Security descendants client：SDK27 声明最低 macOS27/entitlement，本机26.7.1运行库没有符号，无法取得当前资格；不升级OS或安装 entitlement。
- 新建/终止 privileged coalition：当前用户无管理资格，coalition terminate 也不等于 task kill；未采用。改用 launchd 原生新资源归属和用户自身成员的身份信号。
- Linux 容器作为默认：用户明确选择保留 macOS 宿主语义，未采用。Win/Linux 在重构完成后由 GitHub Actions 另验。
- 仅保护实际子目录：真实 Full parent rename 可把保护根搬出原路径；必须同时拒绝准确祖先 unlink，允许无关 sibling 的正常写入。

## Consequences

实现依赖固定 libproc 私有 ABI 和 launchd 行为，但仅在实际启动加载，冷 import 不产生 native I/O；当前运行证据为 macOS26.7.1/25G241 arm64 UID501/Bun1.4.2。有界 coalition/PID 列表的饱和或观察失败保 unknown；它不提供 OS CPU/内存/pids 资源限额，不抵御任意不合作的同 UID 外部替换，不取得三平台或完整生产发布资格。

原 [held-root 决定](../bug-fix/2026-10-06-macos-shell-root-ownership.md)继续约束原根/组的内核占位和一次回收；原 [fixed confined 决定](2026-10-03-macos-confined-shell-refuses-fork-and-temp-exec.md)继续约束声明补偿的 deny-fork/网络关闭/无 fallback。本决定只增加默认宿主后端，不整体替代二者。

实际源码、范围与测试由 [Jobs owner](../../../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)、[Service owner](../../../../apps/service/README.md#默认-shell-装配)和[韧性 owner](../../../../docs/active/runtime-resilience-qualification.md)维护。运行的原失败、修正与资格边界归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
