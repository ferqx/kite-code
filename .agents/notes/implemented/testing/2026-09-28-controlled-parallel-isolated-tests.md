# Agent Note: 逐文件隔离测试的受控并行

Status: implemented

## Problem

默认本地测试保持完整覆盖，但逐文件隔离测试全部串行，使其时长成为主要瓶颈。本机 Bun 1.4.2 基线约 7 分 40 秒，其中 132 个隔离文件约占 5 分 23 秒。原[测试归属与分层执行决定](../process/2026-08-26-test-ownership-and-layered-execution-v2.md)确立了进程隔离，却将进程隔离和全局串行绑定；即使每个文件只修改自身进程环境及独立临时 HOME，其他文件也无法同时运行。

## Decision

默认 runner 统一发现和分类，保留默认文件集合及命令。普通测试、Web Vitest 与经审计可并行的 `isolated/` 文件使用最多 4 槽的队列；普通套件文件数达到 16 时按文件大小分成最多 4 个 job。Linux 队列限为 2 槽，以免 Required runner 同时执行四个大型 Service 分片时争用资源；Linux 与 Windows 的 Bun 文件测试限时为 30 秒，容纳 CI 上耗时超过 Bun 默认 5 秒的仓库扫描。隔离测试仍逐文件启动独立 Bun 进程，进程内 `maxConcurrency=1`，每个子进程拥有独立 HOME 并在结束后清理。失败后停止派发新 job，让已启动的隔离文件完成清理。

`isolated/exclusive/` 表达必须与其他默认 job 全局错开的资源风险，逐文件串行执行。已审计的 Service 子进程、SIGKILL、进程组与编译场景，以及根测试中使用固定临时路径或仓库内建目录的场景归入该目录。`kite-local-runtime` 的真实 macOS 进程快照测试也必须独占：并发子进程恰好退出时，保守观察器会正确返回 `incomplete`，使原有稳定性断言出现时序失败。目录外由 AST 识别的进程级测试默认独占。Windows 暂继续串行运行隔离文件，直到其并发行为完成平台验证。具体执行模型与验证入口由[测试体系](../../../../tests/README.md#默认执行)维护。

2026-10-07：共享队列支持调用者声明的 `firstFiles`，声明作业先派发，其余保原源码大小/label排序。当时统一计划只声明完整CLI登记生命周期；其真实安装闭包含18051个Terminal regular文件，而源码大小不能代表复制、全扫描和逐项sync成本。两次完整图中的该链触及原120秒，最新阶段计时记录重新安装到111.489秒后尚有Native-first PATH/cold步骤；不能从这些事实推导操作系统精确阻塞因果。提前仅改变同一共享队列的派发顺序，保macOS4/Linux2槽、默认集合、逐文件进程/进程内1、原期限和失败drain；Windows原exclusive队列仍串行。生产hash校验、安装持久化和启动不变，调度不证明产品负载延迟。实际三个独立child的barrier验证和完整回归证据由[测试体系](../../../../tests/README.md#默认执行与隔离)及[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期)维护。

2026-10-09：共享优先的原完整登记链在当前默认图再次触120秒，Native重装结束于110.696秒，随后原Native-first PATH／冷查询未完成；实际120003.76ms超时／46断言，其他已派发作业完成drain。该输入为0ff1b93f加Context fixture直接结束标记观察，生产安装／校验／持久化代码未变。原优先排序仍不足以收束这项真实构建、复制／全扫描／sync的默认资格；具体OS耗时因果未知，不能将测试争用当产品资源泄漏证明。

随后原完整默认中的封闭Terminal安装制品也在原120秒超时，实际121084.63ms／3831断言；它同时核归档搬迁、安装、真实执行、指针切换、完整验证与离线维护，没有保存末步骤，精确耗时因果未知。原完整文件在有限顺序复验中93351.27ms通过，全部原断言及120秒／child20秒保持；未修改生产复制、hash、sync或执行实现。

随后真实Native代码升级在并发默认下触原四窗口driver120秒SIGTERM，第三个窗口117.675秒刚启动，原Model阅读随Main进入draining而拒绝；实际整例346.637秒失败。单独原完整六窗口256.425秒通过，另一轮默认407.639秒也通过；这些有限通过不抵消实际期限失败。只把该第三个准确文件加入现有exclusive，保原120秒driver／420秒整例与原版本、字节、身份和冷回退校验，不修改产品Main或清理行为。

随后原Terminal PTY完整读取／导出文件在默认并发下触90秒整例，实际90001.48ms／2断言失败；末阶段未保存，精确耗时因果未知。原完整文件独立进程实际65375.34ms通过，17断言、九MiB来源／超过8MiB全文、原结果折叠展开／reason显示隐藏、两次导出／0600、准确原Profile及所属Service退出保持，原90秒整例与30秒步骤未提高。仅把这个第四个准确文件加入已有exclusive，其他isolated仍受控并行，没有修改TUI产品实现或增加矩阵。

本次公共扩展能力收束的完整默认又在原安装恢复文件实际失败：首Electron inspector已经连接，但Chromium DevTools websocket未在原10秒launch期限内完成；整文件101.994秒失败，219作业结束后停止派发。未改Main／Service／恢复实现、未放宽原180秒整例／45秒driver／10秒launch与页面期限，也不将未抵达的恢复步骤标通过。该完整文件当前按保存的原job／独立HOME复验89.583秒通过，54断言与全部driver保持；具体OS或调试连接阻塞原因未知。只把这第五个准确文件加入已有exclusive，完整文件及全部业务／数据／身份／资源断言保持，其他isolated继续受控并行。

当前 [统一计划](../../../../scripts/unified-test-plan.ts) 用有限caller声明将[Terminal PTY大正文读取与导出](../../../../apps/cli/test/isolated/tui-export-host.test.ts)、完整CLI登记生命周期、[真实Native代码升级／回滚](../../../../tests/isolated/unified-agent/native-cross-version.test.ts)、[安装版恢复交接](../../../../tests/isolated/unified-agent/native-restore-interruption.test.ts)与[封闭Terminal安装制品](../../../../tests/isolated/unified-agent/terminal-bundle.test.ts)五个准确文件转入已有exclusive队列，其他concurrent全部结束后才逐个执行。Windows本已exclusive，保分类／计数；其他平台只转移同一逐文件job，保完整发现恰好一次、macOS4／Linux2槽、进程内1、CLI登记／Terminal安装原120秒整例及child30秒／20秒、Terminal PTY导出原90秒整例／30秒步骤、Native420秒整例／四窗口driver120秒／原15秒页面观察，以及恢复原180秒整例／45秒driver／10秒launch与页面期限和全部归档、原身份、完整正文、六窗口、Provider、Store、PATH和保数据断言。通用firstFiles支持及原barrier／失败drain反例仍保留；这五个原完整文件与其他默认负载错开，其他isolated继续受控并行。实际runner／默认发现两文件11pass／77断言，新的完整默认结果由[阶段进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)维护；未完成运行不能表示资格通过。

此处替代2026-10-07对CLI单项继续共享优先的选择，并纳入后续已观测的另外三个完整文件；既有owner归属、默认覆盖、其他安全isolated受控并行、每进程环境、OS上界与失败清理仍适用。产品启动与安装验证仍完整读取原内容，不引入复用缓存或降低校验。

五项分类后的当前完整默认仍实际失败：原Native问卷窗口第一次选择会话前，工作空间准备未在原10秒页面期限内结束，Provider0，整轮231作业结束／230通过／实际退出1。保存的原完整job未改源码或预算，独立复验64.995秒／32断言通过；具体启动阻塞原因未知。本轮不据这项单作业通过宣布默认或产品负载资格，不追加问卷窗口矩阵；该未解决启动错误与原RSS／八轮／全资源要求归当前普通启动及任务资格。准确输入、原截图、实际失败及限定复验由[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)保存。


## Alternatives considered

- 继续让全部 isolated 文件全局串行：保留最保守的资源隔离，但本机主要耗时无法下降到目标区间。
- 将 isolated 文件合并进共享 Bun 测试进程：减少启动开销，但 `process.env`、cwd、mock、真实子进程与清理状态可能互相污染，违背逐文件隔离的原决定。
- 让所有 isolated 文件并行：不需要独占分类，却会让固定路径、仓库内建目录、编译和进程组测试争用共享资源。采用显式 `exclusive/` 及目录外进程级测试保守独占。

- 只依赖测试源码大小排序，或提高该完整链预算：源码大小不能表达真实大型安装成本，增加期限也不处理派发。2026-10-07曾选择共享优先并保不改exclusive；当前实际超时后将CLI登记、随后失败的封闭Terminal、真实Native升级与Terminal大正文导出改为精确四项exclusive，保各自原期限和内容核验。继续共享优先已不足以守住当前整例预算；全体isolated串行的原代价仍保留，未作为本次选择。

## Consequences

进程隔离不再自动意味着全局串行。新隔离文件须按是否争用进程外资源选择 `isolated/` 或 `isolated/exclusive/`；仅使用私有 HOME 并不足以证明固定路径和真实子进程场景安全。并行提高峰值 CPU、内存及子进程数，队列上限限制该代价。失败时已启动 job 仍须结束并清理；Windows 的串行限制牺牲该平台的提速收益。旧决定的 owner 归属、独立进程、默认覆盖和专用资格入口仍有效，其“所有 isolated 串行”部分由本决定调整。
