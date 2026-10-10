# Agent Note: Linux Shell 使用原 PID namespace 与 gated root

Status: proposed

## Problem

已安装 CLI、TUI 与 Native 的普通 Shell、调用 Shell 的 Task，以及 Workflow 验证与补偿，需要按各自实际权限范围执行，并在自然退出、准确取消和 Service 退出时核实全部原后代。Linux 的普通进程组不能覆盖 `setsid` 与孤儿后代；PID 字符串、一次信号、路径存在和冷证据都不能替代原所属对象的结束证明。当前已接默认 Linux Shell、Workspace Skill verifier 与严格补偿源码，完整能力仍缺 Profile Skill 来源投影和原生资格；RSS 与全部可信 Runtime 观测仍独立阻止资源阶段退出。

## Proposal

正式 Service 持有 namespace 外的原 ChildProcess、私有 SOCK_SEQPACKET、原 init/root pidfd 和 namespace FD；可信 Bubblewrap 建立新的 user、mount、PID namespace，固定 C init 为 PID 1。namespace → P → gated root → G 的两次交接在业务执行前核对原内核对象、credentials、birth、父子关系与 namespace 内 PID 映射。受保护的 init 设置 DUMPABLE=0，不依赖 namespace 外无法读取的 `/proc/<pid>/ns` 链接取得控制权。

Workspace 与 Full 从最终派发授权的所有 leaf 求交，保宿主 HOME 和固定解释器；Workflow verifier 的 cwd 可以是 Skill 目录，写范围仍绑定原 Workspace。严格补偿沿已有契约封存代码、固定读取根、拒绝网络与非线程 fork。可信 init 仅在父端接纳后使用 namespace 内唯一 CAP_SYS_ADMIN，核原 mount、NOEXEC 与只读 flags，清空所有 capabilities 后才创建业务根。明确可执行文件与保护 mask 是闭合交接列表；未知子 mount 拒绝启动，不从任意文件推断许可。

保护根使用 canonical 外层 antichain，避免先遮蔽父目录后再次遍历已不可读的子目录；所有原路径身份仍逐项复核。native 可执行列表仅取 canonical regular file，保原 symlink 身份检查而不把 alias 传给 O_NOFOLLOW。严格补偿在 Workspace 内的祖先独立挂载也纳入 noexec 闭合列表，全部 native 路径合计最多 200；公开 Job、父端和 init 的取消宽限统一最多 5 秒。

正常 terminal 同时需要原根 WNOWAIT／waitpid 相符、namespace 内 ECHILD、原 init/root pidfd 死亡事件、原 wrapper exit0 与 close、完整输出 EOF 和全部 FD 严格关闭。`--die-with-parent` 仅为崩溃兜底。首次 unknown 不升级；仍有效且已接纳的原 init pidfd可作一次清理，未知 Close 不重试。启动清理未确认必须交回原 facade，使 Runtime 保留 resource 与 binding lease；冷数据只供读取，不能重建控制对象。

## Alternatives considered

- 复用旧 Linux detached PGID：不能核完整脱离后代，不满足自然退出与 Service 退出契约。
- 直接复用旧 cgroup/systemd 检测：原 owner 尚未接创建前的准确 scope acknowledgement 与完整空树证明，二进制可用不足以证明归属。
- 将 Bun supervisor 放入 namespace 直接持有 Service 协议 FD：业务可能经 `/proc` 获得 owner 的私有通道，不能作为既有权限保护的替代。
- 使用 Landlock 代替全部 mount 边界：这会新增 kernel 能力要求，也不能由本机 macOS 证明其实际效果；本片保持 Bubblewrap 与明确 mount／syscall 规则，实际支持仍由原生资格核实。

## Acceptance criteria

- 正式安装后的默认 Shell、Task 和 Workflow 沿同一公开 Job 合同，保存完整输出与准确取消；严格补偿保持独立范围，没有不受限回退。
- Profile 内 Skill 验证保原 canonical cwd，准确只读暴露原 Skill 来源且不暴露其他 Profile／coordination 字节；当前拒绝保护根内 cwd，来源投影未完成。macOS 默认 verifier 的原 group 路径仍另需完整迁移，不能用本片 Linux 接线代证。
- 可信资产由 Linux 构建生成并进入候选；安装机器不编译或加载 `.ts` fallback，资产漂移在执行前拒绝。
- Workspace／Full／补偿的文件、网络、父级改名、native 执行与 namespace 逃逸限制，以及所有真实退出资源均取原生 Linux 证据。
- 源码／mock／纯 BPF 检查只证明其实际断言。依用户顺序，原生 Linux／Windows 资格留到重构完成后的 Actions；不得由这些检查、macOS 邻接或 help 输出提前宣告阶段退出。

## Risks

user namespace、Linux headers、mount、pidfd、close_range 和 seccomp 的实际可用性仍未在 Linux 验证；缺任一能力均失败封闭。内核 mount 与 flags 的别名、子挂载及当前 UID 行为须由原生测试确认。外部同 UID 不协作替换仍沿现有可信宿主与 sealed asset 边界，不以本片承诺任意外部攻击者隔离。

当前实现与验证归 [Job owner](../../../../packages/agent/src/jobs/README.md)、[Service owner](../../../../apps/service/README.md) 和 [实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10linux-正式-shelltaskworkflow-源码接线)。Profile 来源投影、全部正式 verifier 迁移及原生资格尚未交付，故保留 proposed。
