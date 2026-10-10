# Agent Note: Linux stdio MCP 的原 namespace 与完整连接交接

Status: proposed

## Problem

Profile 或已批准 Workspace 的本地 MCP 声明需要通过正式 Service、SQL connection Job 和 SDK 工具完成连接、完整结果、准确取消、Service 关闭及冷历史读取。Linux 平台 guard 原先拒绝这条连接；普通进程组不能证明自行转组或孤儿后代结束，冷 PID 和退出回执也不能重建停止权。已有 Shell namespace 还包含文件、网络和补偿语义，不能借迁移 MCP 改变原明确程序的行为。

## Proposal

当前已接源码的[同一 port](../../../../packages/agent/src/mcp/stdio-port.ts)保持原来源、六字段 binding、SQL Job、独立许可及 SDK 协议，选择[独立 direct-program owner](../../../../packages/agent/src/platform/process/linux-owned-program.ts)。可信 Bubblewrap 建立 user／PID namespace，挂载原宿主文件和设备、原网络；固定[C init](../../../../packages/agent/native/linux-stdio-init.c)为 PID 1。私有 SCM credentials、init／root pidfd、namespace FD、原 birth／父链和 NSpid 映射先取得 namespace → P → held root → G 交接，才直接 execve 原 command／args／cwd／env。没有 Shell `-c` 或额外 Shell mount／network／seccomp 范围。

业务 stdin 为 fd0；fd3 只承载私有控制，fd4 以有界 `KITEMCP1` 长度编码交接原配置。参数、环境与路径不进进程 argv 或冷证据。配置读取须完整 EOF、严格 UTF-8／NUL／字段和总字节检查及原 fd4 关闭；业务只继承 0／1／2，清全部 capabilities 后执行。构建生成准确架构 ELF，安装机器只使用封存资产，缺 compiler／后端或原生失败须失败封闭，没有 `.ts`、编译器或普通 group fallback。

[Linux transport](../../../../packages/agent/src/mcp/linux-stdio-port.ts)完整消费原 SDK JSON-RPC、UTF-8 和工具结果，保既有 frame／stderr／队列／启动与 grace＋4000ms 停止预算。可信 `beforeWrite` 在 ready await 后同步核原 binding、来源与 signal，并立即入队原 stdin；等待中漂移保零 RPC。取消控制不等业务写回调。cancel 后合法 EPIPE／stream-close 仍使原写拒绝及释放计数，由原完整停止合取裁决监督，其他 native／关闭未知不放宽。

结束同时要求原 root WNOWAIT／waitpid／raw status 相符、namespace 内 ECHILD、原 init／root pidfd 死亡、wrapper 实际 exit0／close、stdout／stderr EOF、stdin／配置实际关闭、在途写收束及全部原 FD 严格关闭。首次 unknown 强持原 owner 与证据，不被迟到终态升级；创建清理 unknown 交回原 facade，使 Runtime 保原 lease。closed v4 只保存 `mcp-owned-pid-namespace` 的六身份和有限原证明；[纯 decoder](../../../../packages/agent/src/mcp/linux-stdio-process-evidence.ts)不读取 `/proc`、加载 FFI、重开 FD 或重连，旧 v1／v2／v3 合同保持。

[Service 来源](../../../../apps/service/src/mcp-source-configuration.ts)在明确 Linux 资产装配及每次真实 freshness 边界核完整字节／EOF／身份，原 FD close unknown 强持首错和原对象，不重试数字。现有装配失败及 `beforeResourceClose` 接内部 Profile 关闭门禁，未确认时保原 Profile／Store／candidate 使用权。资产 seal 不替代整候选 pin 或原 Source 许可。

完整源码已接正式消费者，本机 mock、纯 codec 与 macOS 封装邻接只证明其实际范围；Linux 原生与 installed 资格尚未交付，故保留 proposed。当前事实归[MCP owner](../../../../packages/agent/src/mcp/README.md#linux-stdio-所属-namespace)与[Service owner](../../../../apps/service/README.md)。

## Alternatives considered

- 复用旧 POSIX PGID／按 PPID 枚举和数值 kill：不能证明转组、reparent 或重用后的完整归属，采用原 namespace／pidfd 和 init 的真实空树证明。
- 复用 Shell Job／Shell init 的 mode、挂载与网络规则：会改变原 MCP executable 的权限、stdin 和 argv 行为，采用独立 direct exec 与业务管道，只复用已审查的原对象监督算法。
- 在 argv 或共享文件交接完整配置：会暴露原环境和声明，且不能约束完整私有 EOF，采用只有 owner／init 持有的 fd4 配置管道。
- 仅凭根退出、管道关闭或 `--die-with-parent` 宣称完成：没有原后代、wait、原 FD 与 wrapper 关闭的合取，均不足以释放原 lease；该选项只作崩溃兜底。

## Acceptance criteria

- 原 Profile／已批准 Workspace → 正式默认 Service → 原 SQL connection Job → SDK 发现和远端 Tool → 完整原输出 → 准确取消及 Service close → 冷原 Command／Execution／output、cursor 和零 Provider／RPC重放，沿原整文件及原预算取得对应平台证据。
- 实际 Linux 证明直接原 args／env／cwd／stdin、原 kernel credentials／pidfd／namespace／birth、held root gate、转组／孤儿后代、原根 wait、完整空树、两 pidfd 死亡及每项真实关闭；缺后端、编译器或真实失败不能 availability skip。
- SDK wire 等待中来源失效零写；cancel 不受阻塞业务 write 拖住，原写错误不改成功；unknown 首错及强 owner、Profile／Store 保持，冷数据没有执行或控制权。
- 安装、真实跨代码 A→B→A、维护新 Store 及全部正式客户端另保完整验收；本片局部结果不退出阶段。依用户顺序，Linux／Windows 原生留重构后 Actions，本机不安装环境或 dispatch。

## Risks

user namespace、Bubblewrap、Linux headers、pidfd、close_range、原 cwd／设备／网络及完整 ELF 闭包仍须真实 Linux 核实。原 namespace 覆盖其中业务后代；通过外部系统服务另起的工作不由此取得归属或停止证明，远端 Tool 效果不撤销。整个 Runtime 的后代／activeResources／handles 观测与原 RSS red 仍直接阻 P6／§35／最终退役，不是独立连接源码的前置。
