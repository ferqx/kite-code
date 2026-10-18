# Agent Note: 可移植测试环境与硬件等待余量

Status: implemented

## Problem

Windows 全仓验收遇到夹具先于业务断言失败：mkdtemp 继承的 ACL 不满足私有存储要求，文件 symlink 需要额外权限，file URL pathname 不能直接作 Windows 子进程路径。隔离 HOME 还令 Rustup/Cargo 将每个夹具视为新的工具链目录，反复下载和编译。17MiB 输出按原协议逐段发布，40秒等待不足；128次真实持久化也受磁盘速度影响。用户明确要求测试时间限制不要过于严格。

## Decision

[运行器](../../../../scripts/test-suite.ts)在设置隔离 HOME 前固定 [Cargo/Rustup缓存](../../../../scripts/test-environment.ts)，TUI受控子进程沿相同两个显式路径传递。保留实际固定 Rust 版本、locked 依赖和完整四workspace构建，不读取用户的应用配置。官方 [Rustup环境变量](https://rust-lang.github.io/rustup/environment-variables.html)与[Cargo Home](https://doc.rust-lang.org/cargo/guide/cargo-home.html)定义这些工具链路径；应用HOME继续由测试独立持有。

Windows 本轮验收按用户最新要求限定为 Agent 核心流程，不再继续全仓测试。默认测试库存和 CI 规则保持，不按平台静默裁剪发现，也不新增 availability skip。Windows Shell、MSVC 安装和完整客户端资格不属于这次流程验收。

正式默认／统一／TUI测试入口使用同一测试运行时准备。当前 Bun 安装目录不能通过原候选制品 ACL／路径校验时，只在两层自有私有目录建立同字节副本，核源与副本 SHA，并保留实际原生 candidate pin后启动原入口。原参数与应用HOME保持，Cargo／Rustup缓存沿原父环境传递；未知验证或关闭错误直接失败，不作为创建第二个owner的理由。成功退出、原pin复核和关闭确认后，仅清理准确自有根；失败保留目录。纯库存与非法参数不进入这项准备，仅为该子进程前置自有bin路径，不修改系统安装、全局PATH或ACL。该准备不会提供缺失的MSVC编译器或Shell后端。

真实私有目录、foreign ACL和reparse反例沿[共享文件系统原语](../../../../tests/fixtures/test-filesystem.ts)。目录别名用Windows junction，私有记录继续拒绝真实reparse入口，硬链接断言保留。故障用例使用fileURLToPath；Windows保活owner，POSIX另外SIGSTOP，双方都必须拒绝接管。原已不适用Windows的retention用例，其准备沿同一既有平台条件，不新增业务skip。

主动损坏自有Artifact时，POSIX临时chmod，Windows由实际owner暂授自身F、写入，再恢复精确R；损坏检查发生在恢复只读策略之后，核hash而非仅ACL失败。普通产品不提供这个入口。Run绑定夹具按Runtime、外部串行锁、Store、临时目录的依赖顺序关闭。恢复夹具在模型派发前建立同一只读WAL连接，Provider回调不反复开关共享映射，最后明确关闭。

按用户要求，六项128条journal容量整例统一300秒，17MiB压缩和扩展Fork的命令300秒、整例600秒，密集Caller Port整例600秒，四workspace构建子命令120秒、TUI启动就绪60秒，三类caller强杀整例120秒。所有实际正文、分段数、原身份、容量、权限拒绝和零重发断言保留。产品操作和资源清理的既有约束不由这些功能等待预算改写。SDK wire名与持久Core ID分别核对，不能将files_write误认成files.write身份改变。原file URL统一用fileURLToPath／pathToFileURL转换，目录别名沿junction，不改变HTTP URL pathname。派发准入夹具沿实际私有目录建立Profile，产品ACL检查原样执行。

TUI 模型夹具保留完整请求观察，精确标题system指令且无Tool的自动命名请求另行响应；普通工作响应队列和getWorkRequests视图不被它消耗。原完整请求计数仍包含自动命名，越界Tool和普通响应缺失仍失败。Files baseline改用实际WorkspaceFiles完整原生身份、EOF与SHA，SDK wire别名只接受唯一原定义，未声明或截断重名不迁移。夹具观察用途明确，不增加普通客户端诊断开关。

## Alternatives considered

- 给机器开启符号链接特权或放宽产品ACL：已有真实junction与ACL夹具可表达反例，无需改变系统或产品权限。
- 放宽安装目录ACL或跳过候选pin：改动用户环境或削弱产品边界；测试自有同字节运行时可以满足真实前提。
- 缩减默认Windows测试库存：用户只限定本轮验收，未授权改变CI资格；保持原正式发现和失败。
- 共享应用HOME或拷贝原用户配置：会污染隔离和凭据边界，只固定构建工具缓存。
- 减少17MiB正文、128条容量或跳过失败：无法证明原产品合同，保完整输入和断言。
- 只增加超时：能解决持续正常I/O，但不能解决ACL、原路径、WAL映射、工具名或缺失Windows Shell后端。
- 以固定延迟判断React／PTY已就绪：真实状态和原语义回执才构成前提，超时只是有限的等待上限。

## Consequences

较慢主机有更多时间完成真实持久化，故障反馈可能变慢。原失败日志保留，不能把分批整文件通过写成同次默认全绿。Windows仍缺手册明确说明的正式Shell后端；本机候选构建还报告windows_terminal_launcher_compiler_unavailable。完整TUI的shell_unavailable、MCP标签展示未满足原断言和资源soak资格不能靠这些环境修复变成通过。用户已将本轮收束为Agent流程，这些原失败保留，不继续扩大到客户端、安装或平台后端实现。产品语义与权限边界按[手册](../../../../docs/handbook/features/tools-and-approvals.md)继续核对。

## Verification

2026-10-18，Windows x64／Bun1.4.3／HEAD bcf70ce8加本轮工作树。原始日志在dist/acceptance/environment-fix-20261018/；25文件Agent流程的最终输入和结果由agent-flow-final-inputs.json／agent-flow-final-result.json保存，包含准确命令与SHA，结果只在本次范围判定；前轮失败归[生命周期验收](../architecture/2026-10-18-settled-lifecycle-observers.md#windows-全仓验收)。

原test:mock四文件29通过／0失败／390断言，包含79秒完成的完整17MiB例；原test:e2e六文件38通过／0失败／337断言；原test:runtime:fault六文件54通过／5原平台skip／0失败／304断言。三类caller强杀整文件3通过／51断言；运行器与共享文件系统两整文件13通过／47断言。后续原默认命令已通过全部28个concurrent作业和前四个exclusive作业，在第五个CLI候选文件报缺MSVC，实际1通过／2失败；清理另报自有HOME的EPERM，原日志保留。默认914文件／720作业未完成，之后按用户最新要求不再继续全仓验收。TUI的MCP完整文件实际2通过／1失败，原具体标签断言仍红；独立标签等待实验未通过，实验代码已撤回，不能记作产品或环境修复。

最终 Windows Agent 流程组合实际执行25个完整文件／180项测试，180通过／0失败／0跳过／2340断言，167.95秒，actual exit0。原HEAD bcf70ce8加本轮工作树，Bun1.4.3／Windows x64；运行前后4164个代码、配置及原生源码输入SHA一致。首次该组合的五项派发准入ACL失败及一项17MiB Fork等待超时保留；修复真实私有目录和等待预算后，复验同一范围并纳入原child结果交付，没有减少正文或断言。

该25文件范围包含纯观察队列、extensions的全部九个整文件、execution的run-lifecycle／lifecycle／model-attempt／model-usage／control／parallel-tools／interactions／tool-dispatch-admission／session-title-generation／owner-handoff、child的result-delivery，以及recovery的crash／run-resume-runtime／job-report-resume-runtime／settlement。核实际Run和Model开始／提交结束、串行Action选择、内部child零业务钩子重入、普通嵌套Action权限与取消、背景绑定寿命、完整Fork来源和真实强杀后显式恢复零重放，不证明外部Shell或远端付费Provider。

受影响测试环境八整文件另87通过／2原平台skip／0失败／507断言。根加八workspace的typecheck、format:check、unified-agent-boundary、check:docs及check:docs-impact --scope=all通过；格式检查仍报告原21 warnings／180 infos。按用户收窄后的验收范围执行iteration_complete，产品手册与跨包生命周期合同已核对，环境修复不改变产品行为或放宽权限／清理门禁；完整Windows、MSVC／Shell、客户端及发行资格仍未完成。
