# Agent Note: 逐文件隔离测试的受控并行

Status: implemented

## Problem

默认本地测试保持完整覆盖，但逐文件隔离测试全部串行，使其时长成为主要瓶颈。本机 Bun 1.4.2 基线约 7 分 40 秒，其中 132 个隔离文件约占 5 分 23 秒。原[测试归属与分层执行决定](../process/2026-08-26-test-ownership-and-layered-execution-v2.md)确立了进程隔离，却将进程隔离和全局串行绑定；即使每个文件只修改自身进程环境及独立临时 HOME，其他文件也无法同时运行。

## Decision

默认 runner 统一发现和分类，保留默认文件集合及命令。普通测试、Web Vitest 与经审计可并行的 `isolated/` 文件使用最多 4 槽的队列；普通套件文件数达到 16 时按文件大小分成最多 4 个 job。Linux 队列限为 2 槽，以免 Required runner 同时执行四个大型 Service 分片时争用资源；Linux 与 Windows 的 Bun 文件测试限时为 30 秒，容纳 CI 上耗时超过 Bun 默认 5 秒的仓库扫描。隔离测试仍逐文件启动独立 Bun 进程，进程内 `maxConcurrency=1`，每个子进程拥有独立 HOME 并在结束后清理。失败后停止派发新 job，让已启动的隔离文件完成清理。

`isolated/exclusive/` 表达必须与其他默认 job 全局错开的资源风险，逐文件串行执行。已审计的 Service 子进程、SIGKILL、进程组与编译场景，以及根测试中使用固定临时路径或仓库内建目录的场景归入该目录。`kite-local-runtime` 的真实 macOS 进程快照测试也必须独占：并发子进程恰好退出时，保守观察器会正确返回 `incomplete`，使原有稳定性断言出现时序失败。目录外由 AST 识别的进程级测试默认独占。Windows 暂继续串行运行隔离文件，直到其并发行为完成平台验证。具体执行模型与验证入口由[测试体系](../../../../tests/README.md#默认执行)维护。

2026-10-07：共享队列支持调用者声明的 `firstFiles`，声明作业先派发，其余保原源码大小/label排序。当前统一计划只声明完整CLI登记生命周期；其真实安装闭包含18051个Terminal regular文件，而源码大小不能代表复制、全扫描和逐项sync成本。两次完整图中的该链触及原120秒，最新阶段计时记录重新安装到111.489秒后尚有Native-first PATH/cold步骤；不能从这些事实推导操作系统精确阻塞因果。提前仅改变同一共享队列的派发顺序，保macOS4/Linux2槽、默认集合、逐文件进程/进程内1、原期限和失败drain；Windows原exclusive队列仍串行。生产hash校验、安装持久化和启动不变，调度不证明产品负载延迟。实际三个独立child的barrier验证和完整回归证据由[测试体系](../../../../tests/README.md#默认执行与隔离)及[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期)维护。

## Alternatives considered

- 继续让全部 isolated 文件全局串行：保留最保守的资源隔离，但本机主要耗时无法下降到目标区间。
- 将 isolated 文件合并进共享 Bun 测试进程：减少启动开销，但 `process.env`、cwd、mock、真实子进程与清理状态可能互相污染，违背逐文件隔离的原决定。
- 让所有 isolated 文件并行：不需要独占分类，却会让固定路径、仓库内建目录、编译和进程组测试争用共享资源。采用显式 `exclusive/` 及目录外进程级测试保守独占。

- 只依赖测试源码大小排序，或提高该完整链预算：前者不能表达已观察的大型安装成本，后者扩大原期限却不处理派发方式。当前保原预算，使用调用者明确的共享队列优先项；不把该文件改exclusive、不降低默认槽数或省略内容核验。

## Consequences

进程隔离不再自动意味着全局串行。新隔离文件须按是否争用进程外资源选择 `isolated/` 或 `isolated/exclusive/`；仅使用私有 HOME 并不足以证明固定路径和真实子进程场景安全。并行提高峰值 CPU、内存及子进程数，队列上限限制该代价。失败时已启动 job 仍须结束并清理；Windows 的串行限制牺牲该平台的提速收益。旧决定的 owner 归属、独立进程、默认覆盖和专用资格入口仍有效，其“所有 isolated 串行”部分由本决定调整。
