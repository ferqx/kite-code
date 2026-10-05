# Agent Note: macOS 受限 Shell 固定拒绝子进程与临时程序执行

Status: implemented

## Problem

普通 Shell guardian 可以监督进程组，但这不能证明脚本没有访问组外进程、文件或网络。声明补偿必须关闭网络并限制原工作区。真实探针证明允许 fork 时子进程能 setsid 逃出原进程组，原组消失后仍有外部效果；只省略临时目录的 executable-map allow 也不能阻止复制 native 程序后 execv。用户批准不能弥补这些执行环境缺口。

## Decision

新增显式 `createMacosConfinedShellJob`，固定 Seatbelt deny network、process-fork，以及该 Job 私有临时目录的 process-exec/file-map-executable deny。它沿用普通 Job、原 guardian 和准确句柄，公开输入仍仅 command；profile、exe/argv、路径身份和完整摘要来自可信工厂。原 canonical 工作区、只读 runtime 资产和完全拒绝的 profile/coordination 根在 start 及 guardian 派发前复核。私有临时目录只在真实停止后由准确身份清理，未确认保 unknown，不降级为不受限 Shell。

## Alternatives considered

- 继续允许 fork 并只清理原进程组：真实 setsid 反例否定其监督完整性；未声称拥有全后代可靠查询和杀停，因此未采用。
- 从允许执行映射中去掉临时目录：真实 execv 已运行 copied main，不能作为明确执行拒绝；改为显式 deny。
- 沙箱不支持时退回普通 Shell：拒绝，V1.3 §17 和既有补偿约束要求在实际边界 fail closed。
- 把全部系统解释器或脚本行为视为支持：拒绝，需要派生子进程的脚本当前会失败，真实资格仅包含原进程和线程执行。

## Consequences

当前支持范围为 macOS 禁止派生子进程的受限脚本。业务 owner 仍负责封存原声明及完整资产副本、输出/attempt、用户选择和权限，工厂不把任意 command 变成可信声明。只读资产根必须与完全 deny 的 profile/control 根分离，不能靠例外放开凭据目录。普通 Shell 工厂保持原监督语义；没有 Linux/Windows 或默认生产全 Shell 隔离资格。

真实普通/受限组合22项134断言通过，含允许 fork 的逃逸反例、拒绝 fork/daemon/setsid/foreign signal、真实 TCP/Unix 零 accept、复制临时 native execv 的 EPERM 和零 main marker、root/profile 漂移、EOF/SIGKILL 清理及源码外完整 manifest。日志 `/private/tmp/kite-confined-shell-tenth-qualified.log`；真实旧 Shell Service 4项51断言通过，日志 `/private/tmp/kite-confined-shell-service-qualified.log`。types/build/Biome/docs/边界/归属亦通过。修前 copied-temp 失败保留 `/private/tmp/kite-confined-shell-eighth-qualified.log`，其他 fixture 编译/终态期望中间失败没有改写为产品资格。

负责事实见 [Jobs](../../../../packages/agent/src/jobs/README.md) 与[平台资产](../../../../packages/agent/src/platform/README.md)。
