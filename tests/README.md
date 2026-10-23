# 测试体系

本页负责当前测试归属、发现和执行。当前默认为精确八个新 workspace；下面单列的历史机制和原资格记录不参与新默认调度，也不证明当前产品或平台通过。

[共享启动器](../scripts/test-suite.ts)把计划中的测试文件转成绝对路径传给Bun；相对路径只用于日志。裸相对字符串会被Bun当作发现filter，可能同时匹配忽略目录里的同名证据副本。当前[默认计划回归](integration/scripts/unified-default-plan.test.ts)在真实ignored archive存在同名broken测试时，核计划与库存不变，并实际验证只执行原计划文件；保留归档不要求删除或重命名原证据。此修正不改变并发、独占、隔离、时限或发现范围。

该修正后的freeze32完整默认已一次执行751作业/948文件及全部七独占，退出0；4397非Markdown输入与HEAD前后无漂移。准确结果及原失败边界归[本轮协作验证](e2e/live/model/collaboration-v1.1-cases.md)，不从受控默认通过推成真实模型或其他平台通过。

2026-10-18 按用户最新范围，Windows 本轮只验收 Agent 核心流程：Run／Model 生命周期、扩展 Action／Tool／Job、权限与取消、绑定、child 结果和显式冷恢复。停止继续全仓验收，默认库存与 CI 发现规则保持。本机Agent流程25整文件／180测试／2340断言全部通过，运行前后代码输入无漂移。已修复的环境问题和准确执行结果归[测试环境决定](../.agents/notes/implemented/testing/2026-10-18-portable-test-environment.md#verification)；此前全仓失败仍保留，不以本次流程通过代替完整 Windows、Shell、TUI 或安装资格。

随后合并远端模型工具投影与本地生命周期、Windows环境修复，继续限定同一Agent流程范围，并纳入两份[工具投影回归](../packages/agent/src/model-tools.README.md#验证)。Windows x64／Bun1.4.3实际27整文件197通过／0失败／0跳过／2451断言，4173项代码与配置输入运行前后无漂移；Service授权／恢复夹具三文件另12通过，测试环境与构建依赖证明三文件另22通过。模型和SDK公开名按新合同为`write_file`，持久身份仍为`files.write`；原生命周期钩子、私有ACL、WAL连接、macOS短socket目录及功能等待预算均保留。这些有限合并复验不代替全仓或其他平台资格；原始日志位于`dist/acceptance/environment-fix-20261018/push-merge-*`。

共享测试的临时根使用实际 OS 的 `tmpdir()` 并解析真实路径；有私有存储要求的夹具沿[测试文件系统原语](fixtures/test-filesystem.ts)创建 Windows 受保护 ACL 或 POSIX 0700 目录，不能以 Windows 的 `mode`／`chmod` 代证权限。工作区 file URL 使用 `pathToFileURL`，保留空格、Unicode、百分号与平台盘符。公开权限反例在 Windows 实际加入外部可读 ACL；私有记录的 reparse 拒绝分别用真实 junction／符号链接，硬链接反例另保原断言。编辑器目录外访问反例必须先确认路径确实穿越到外部普通文件，再验证拒绝。[完整回归](isolated/unified-agent/test-filesystem.test.ts)还检查当前八个 owner 的测试与统一夹具，拒绝重新写入固定 POSIX 临时根或拼接 file URL。macOS 的 UUID Unix socket 使用同一原语中的 `temporarySocketDirectory`，在系统短暂存根创建真实私有目录以满足原 103-byte 地址上限；一般文件夹具仍使用实际 `tmpdir()`。历史原始 VM 证据和明确 POSIX 协议的反例不改写；业务断言、容量和调度保持；功能等待预算见下文。路径可移植不等于三平台完整资格，实际结果仍须分别记录。

[首次配置夹具](../packages/ui/test/tui/onboarding.test.tsx)在 React effect 已推进且实际画面／连接阶段就绪后才发送下一按键，保原退出、遮蔽凭据、取消与原 ID 零重发断言，不以固定25ms代表进入发布阶段。临时 act 环境标记准确恢复，整例预算保持。[HTTP 装配测试](../apps/service/test/isolated/assembly-http.test.ts)区分 模型公开名及 SDK wire 名 `write_file`与 Core 的 `files.write` 原身份，实际旧绑定和后续禁用仍分别核实。2026-10-18 Windows 全仓原入口已执行但未通过；默认914文件组成720作业，其中707作业因原失败停止策略未派发，准确命令、HEAD对照与剩余边界见[本轮验收记录](../.agents/notes/implemented/architecture/2026-10-18-settled-lifecycle-observers.md#windows-全仓验收)。

Caller、Recovery、MCP Selection／Connection／Reconnection／Source Approval journal 中连续执行128次真实持久化的六项容量测试，各平台统一使用显式300秒上限，核满额拒绝、原记录完整及未知记录不被淘汰。17MiB压缩摘要及扩展Fork的单次命令等待为300秒、整例600秒；原544分段、Fork、损坏拒绝及冷读全文继续验证。Caller Port 的完整正文与密集journal整例同为600秒。这些是按用户要求适应不同主机I/O速度的功能测试等待预算，不定义单次保存延迟或产品性能承诺；产品取消、连接与清理约束保持。原32–37秒、120秒及40秒超时记录保留，不能据此宣称数据丢失，也不能由功能测试通过授予性能资格。

[测试运行器](../scripts/test-suite.ts)在分配隔离HOME之前，用[显式工具链环境](../scripts/test-environment.ts)固定Cargo／Rustup缓存；TUI子进程沿相同规则传递这两个路径，避免每个临时HOME重新安装工具链。应用配置仍只读取自有HOME，不拷贝用户配置或凭据。四workspace夹具每个实际构建子命令上限为120秒，TUI就绪等待为60秒；各外层测试预算仍生效。恢复夹具在派发前建立并持有同一只读WAL观察连接，结束后先关闭再删自有根；Provider原调用核模型公开名及SDK的`write_file` wire身份，持久层继续核`files.write`。Run绑定夹具先结束Runtime，再关闭自己提供的串行锁和Store，最后删根。具体取舍和本轮证据见[测试环境决定](../.agents/notes/implemented/testing/2026-10-18-portable-test-environment.md)。

正式默认／统一／TUI测试入口遇到Windows Bun安装路径不满足原候选制品ACL条件时，只在自有私有目录复制同字节Bun并复核SHA及实际原生pin，再用它执行原入口与全部原参数；不改安装目录权限。成功并确认关闭后清理自有副本，失败保留准确目录；未知pin关闭直接失败。`--list`和非法参数仍直接只读处理。该准备不提供MSVC或Windows Shell能力。TUI模型夹具保留所有请求的完整观察，另提供显式普通工作请求视图，避免自动标题子会话消耗普通响应队列；精确标题请求必须无Tool。原工具映射核SDK wire名及准确Core ID，Files baseline使用真实原生身份与完整EOF／SHA，未声明或歧义映射继续拒绝。

[daemon宿主](../apps/cli/test/daemon-host.test.ts)、[共享CLI](../apps/cli/test/isolated/shared-cli.test.ts)、[管理](../apps/cli/test/isolated/shared-management.test.ts)、[状态](../apps/cli/test/isolated/status-host.test.ts)和[Skills](../apps/cli/test/isolated/shared-skills.test.ts)夹具的 `beforeAll` 必须沿各自用例的同一既有平台条件：前四份在macOS/Linux构建，Skills保持仅macOS。构建入口的file URL用 `fileURLToPath` 转成真实本地路径。Windows不执行这些原已跳过用例的构建准备，实际适用的恢复等调用者仍执行完整四workspace构建。共享构建器的每个子命令现为120秒，上述五份文件的准备60秒保持。[构建环境原语](fixtures/build-tool-environment.ts)为直接运行的构建子进程定位已安装的标准Cargo／rustup目录，并保留显式工具链环境；运行时HOME和来源隔离不变。Windows专属endpoint／pipe及实际安装链另行验证，不能将平台跳过计作Windows daemon能力通过。

客户端 UI 迁移回归沿当前 TUI 全库存、Desktop／UI／Web owner 整文件及受影响的 Browser／Cookie Gateway／恢复调用者执行，实际整轮结果归[客户端 UI 收束记录](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-15客户端-ui-迁移缺口与回归收束)。模型夹具只读写自有 HOME 的用户配置，不再依赖退役的 Profile 配置。Thought 的快速搜索通过实际下一次 Model 请求的显式同步点观察活动画面，保原步骤、终态及超时，不靠生产延迟或伪造终端帧。

共享恢复夹具的真实管理进程从启动时绑定自有 HOME，并持续存活到原 daemon 正常停止；正式 `--no-orphans` 规则仍保留。只收到真实 start 成功信号后运行原恢复／查询旅程，完成后通过管理进程调用原 stop 并核退出，不能将短命管理进程被清理后的连接失败归为恢复结果。

Caller Port 的大正文 Plan／steer／follow-up／取消和日志容量旅程为准确自有 Session 启用真实 Provider 流等待点，确认模型请求已经到达后再观察活动 Run；普通恢复工作的原 Files Tool call 身份检查保持。该等待点不修改规划权限、不增加生产延迟，也不以固定恢复回答充当新 Plan 的完成结果。

后台停止丢回执的 PTY 旅程关闭阅读面板后等待自动查询，先核实首次原 GET 丢回执，再等下一次原 ID GET；重开时等待当前会话的完整面板帧。最终仍须原 applied 回执、准确一次 POST／两次原 ID GET、完整输出与子日志、兄弟 Job 独立状态及正常清理。Ctrl+L 不触发刷新或查询。

同批子 Tool 的物理历史沿[实际完成顺序](../packages/agent/README.md#同一-step-的并行工具批次)保存。该 reader 旅程核全部 200 条原 Tool 的准确身份、正文及调用集合，最终 Model 紧跟整批实际最后一条结果，再按真实消息索引跨页阅读；不能假设编号 200 必须最后完成，也不能为驱动重排历史。

Native DOM 的读取归属夹具在卸载后等待真实 FIFO timer turn，再关闭 JSDOM 和恢复全局 Event 构造器；Radix FocusScope 的卸载事件必须仍属于原 realm。`Bun.sleep(0)` 让出微任务，不能作为该 timer 已完成的证明；此清理不改变生产组件或增加业务等待预算。

Native Provider／MCP 的实际 macOS 凭据场景使用[自有 HOME 的默认钥匙串引用](../apps/desktop/test/owned-default-keychain.ts)：按进程 UID 只读查询 Directory Services 中的 OS 用户目录，再读取该用户的默认钥匙串，在私有测试 HOME 建立引用，让真实 OS 后端可用；不依赖 Bun 启动时缓存的 HOME、不复制钥匙串、不更改系统默认项或搜索列表。测试仍只保存自有随机凭据，并沿原准确引用撤销及用新 Vault 核实不存在，不能将临时内存后端记作这项资格。普通产品启动和其他平台的后端没有变化。

2026-10-14 已按用户要求在 Windows NT 10.0.26300.0／x64／Bun1.4.2 实际执行本机验证：修复Worker构建路径与四个TOKEN_USER缓冲区问题后，八workspace build通过；原默认首批Desktop作业失败并中断，后续未派发。另26份原完整专项各独立Bun进程，12文件通过／14文件失败，合33pass／34fail／4原平台skip／2error。通过范围含daemon原生叶子、stdio MCP、文件候选与TUI私有记录；Files／媒体发布错误87、普通Workspace配置、四份恢复、ConPTY内容、Desktop夹具和缺MSVC仍阻断完整验收。准确命令、原日志与局部修复归[Windows本机证据](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-14windows-本机首次实际验证)。以下旧“Win/Linux未实测”只描述各历史轮次，当前Windows已实测但未通过，Linux／hosted Actions及完整installed资格不由本轮替代。

`bun run test:tui:integration`／`test:tui:system` 使用[当前统一入口](../scripts/run-unified-tui-system-tests.ts)，逐整文件发现原 `tests/tui-system/scenarios` 的 52 个真实终端旅程，并与新 CLI TUI owner、正式入口和跨模块启动等待文件一起执行。`KITE_TUI_SYSTEM_SHARD` 接受 0/4 至 3/4；四份完整覆盖同一库存，每个文件只归一份。原旅程消费当前 Ink UI、公共 Client 和默认 Service；协议映射只转换原参数与实际新收据，不生产旧 Runtime 事件或伪造结果，原超时、清理门禁和行为断言继续保留。

2026-10-15 在 `2560b7ca1` 加本轮修复的工作树上，macOS arm64／Bun 1.4.2 实际执行标准 `bun run test:tui:system`：当前 113 个完整文件、默认四并发全部完成，退出 0，301.16 秒；运行前后实现与测试输入一致。根与八个 workspace 的 `bun run typecheck`、`bun run build` 通过，`test:tui:harness` 另 4 项通过。前序候选导出缺失、旧用户配置路径、MCP 展示字段误入来源比较、巨正文显示估算阻塞和测试动作范围／审批就绪失败均保留原失败证据后修复；不把分批诊断结果计作本次标准整轮通过。该结果仅覆盖本机，未执行 Win/Linux 原生或完整安装资格。

历史 Store9/11 确属旧数据库格式；其转换按 D08 不适用，对应旅程改验隔离的新 Store／Profile 的会话、重启和维护能力，不能将这些结果记作旧格式兼容；实际旧 State26 文件只作为不读取、不覆盖的隔离反例，遵守 D08。当前新 Store 的版本与维护恢复验证继续由正式测试负责。可选的旧 lifecycle 诊断 fixture 与 `in-process-service-connector` 尚属历史参考，不参与当前 52 个旅程，也不证明全 Runtime 资源或出生后代资格。当前完整执行结果归[进度](../docs/plans/unified-agent-refactor-v1-progress.md)，下面此前默认结果保持其原提交和范围。

当前源码发现由 `bun run scripts/run-default-tests.ts --list` 精确列出，当前合并后为 985 个默认文件；新增的权限树回归沿实际 Shell／Files consumer 核节点边界、错误优先级与独立叶校验。Files／MCP intent 文件、Native 分片和目录分页的测试继续保留各自业务断言，共享夹具只集中同域重复数据或传输，不改变默认发现、隔离与预算。此前 812 文件／638 作业（含 7 个 exclusive）的完整执行和新增改动的有限验证分别记录，失败修复按受影响原整文件验收，仍以[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md)的最终结果为准；不能把分批修复证据写成同次默认命令全绿。普通 UI 的已完成正文位于终端原生历史；巨正文导出夹具用真实 PTY 字节流逐字核全文和准确操作材料，不让测试端 headless 解析队列阻塞用户按键，其他屏幕断言继续使用原 screen 模式。 本轮 TUI 全库存 112 文件已逐整文件通过（首轮 75、项目 MCP 审批修正后 1、补跑未启动 36），包含全部原 52 场景；首轮命令实际退出 1，保留失败记录，不记作单次全绿。Ctrl+T 按用户决定移除，完整 reasoning 由现有 reader 与导出原文继续核实。

本轮原 TUI 迁移前最近完整默认为macOS `a99fdf29` 加当轮最终冻结改动的原 `bun run test`：754完整文件／611唯一正式作业全部通过、actual0／1472.848秒，原四并发／604排空后7独占保持；4493输入、11资产、HEAD和Git零漂移。恢复Actions守卫、四份正式恢复、原Terminal／Web／80×24 TUI与Native头部错误／草稿完整文件均在该图内通过，原三轮失败及修复证据保留。准确冻结、原log与result归[集中收尾进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13actions-恢复接线与-sql-语句缓存-owner-收尾)。最终结果归档仅补文档，不重新命名未变执行输入为新一轮测试；原RSS／完整资源与出生后代仍未闭合，wholeV13／phaseExit保持false，Win/Linux只有配置完成与未实测备注。

此前完整默认证据为macOS clean `2e3c19bd` 的原 `bun run test`：754完整文件／611唯一正式作业全部通过、actual0／1464.452秒，原4并发／604排空后7独占和全部原断言／预算保持。4493文件输入及11运行资产／HEAD／status零漂移，原Native问答失败修复后也在整轮通过；第一轮真实失败仍保留。同名临时fixture仅按冻结源码和父区间归属，不过滤正式失败、不改原runner或为统计重测。准确原始与独立审计证据归[当前整轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13普通调用者退役与-native-修复后的完整统一验证)。完整默认通过不解除原RSS／资源观测或阶段资格；助手 OS 字节未观测不记为通过，但再次人工粘贴不是新增独立门禁。Win/Linux 按用户2026-10-13最新范围只验收 Actions 接线与未实测备注，不把配置或本机通过写成原生执行结果。

2026-10-13 在 macOS 的 clean `4eddd7cc` 执行原 `bun run test`，752 个完整文件组成609个正式作业，原四并发及最后七个独占作业全部通过，实际退出0。执行前后4483个文件输入和11个运行时／Web资产输入无漂移，准确原始日志、冻结与审计结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13当前代码完整默认回归与用户原文粘贴确认)。[测试运行器自测](isolated/scripts/test-suite-runner.test.ts)和[TUI运行器自测](isolated/unified-agent/unified-tui-runner.test.ts)会在所属临时目录运行预期失败及同名夹具，原始日志包含它们的子记录；核定完整默认结果须同时核正式冻结计划、父用例断言、实际退出码和原总结，不能只累计所有 `[test:…]` 文本。本次没有修改运行器或过滤测试；完整默认通过不解除原RSS／资源观测、Win/Linux原系统或阶段退出门禁。

[旧Desktop入口完整测试](isolated/unified-agent/retired-desktop-entrypoints.test.ts)随后新增，属于现行有限root suite：六个package命令和四个直接脚本均在旧archive／Profile／producer之前返回退役诊断／2，原数据字节与目录保持。标准tmpdir／路径及HOME／USERPROFILE／AppData／XDG使同一断言可在三端执行，无macOS-only skip。macOS受影响组合四完整文件31pass／522断言，保原release smoke与CI／consumer断言；默认发现现753文件且该文件恰一次。上述752文件完整回归只证明其冻结版本，不能称为这次新增后的完整默认或Win/Linux实测；当前退役切片及剩余门禁归[准确进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13旧-desktop-普通开发准备与打包调用者退役)。

[旧CLI/TUI与Service入口完整测试](isolated/unified-agent/retired-application-entrypoints.test.ts)再补真实源码普通启动及两个package构建的退役／原Profile保全，并以复制真实wrapper和无副作用历史port核原函数对象、同步API、实际Bun bundle与源码四private helper路由。port仅证明入口胶水，原历史方法另比原提交字节，不代完整旧运行库或OS资格。用户要求Web端保持现状，本轮Web退役改动已撤回，原Web回归保留；助手全文系统剪贴板仍未确认。最终两个退役完整文件3pass／181断言，未变的原release smoke、workspace与CI三完整文件30pass／422断言按本轮原运行复用。当前默认发现754完整文件／611作业（604并发、7独占），两个退役文件各恰一次；该切片提交时未运行754完整默认，后续当前整轮结果见上；阶段及原RSS／观测／平台门禁保持。准确红绿、范围与证据归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13旧-clituiservice-普通入口退役与历史导入保留)。

旧OSS普通发布全链随后在上述退役文件集中核验：build／verify、installer四操作和smoke实际七次调用保archive／prefix／Profile；原安装导出对象／同步／async／常量沿真实wrapper的source与实际bundle，原历史方法另保bytes，原smoke完整检查全bytes保留明确historical qualification。原source检查只移动读取目标，未改原Windows断言。五唯一完整文件34pass／708断言／actual0，原正式release smoke新候选与normal cleanup通过。默认仍754完整文件／611作业，不新增独立窗口；这批改动收束后统一原完整默认结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13旧-oss-发布普通调用者完整退役)，该切片提交时结果未取得，后续当前整轮结果见上。

旧普通调用者收束提交 `f2730258` 后已实际统一执行原754文件／611作业default：Bun退出1，246启动／245通过／1Native问答草稿保存失败／365未启动，原并发／预算及4493文件／11资产／Git输入保持；原red完整保留。确定的enabled Save受History门禁静默返回已补生产单调用，原完整DOM15／127／0及未改原窗口1／32／0通过；不以两文件绿代完整默认，原失败／必要修复归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13统一回归发现的-native-私有草稿保存)。

首次配置的 [PTY 场景](tui-system/scenarios/first-run.test.ts)通过测试专用 `KITE_TUI_SYSTEM_TEMPORARY_CREDENTIALS=1` 选择[临时凭据 Service 组合](tui-system/fixtures/temporary-credential-service.ts)。[当前 TUI 夹具](tui-system/fixtures/current-tui.ts)只为自己构建并持有的 Service 注入该后端，拒绝对共享 Service 使用该选择；普通场景和生产默认仍使用 OS 凭据库。场景验证真实 HTTP 模型发现、凭据引用、配置发布和模型启用／默认选择，配置不含合成 key 明文；临时凭据只随该 Service 进程存活，不构成 OS 凭据库或冷重启资格。

## 环境基线与 owner

[Windows installed TUI 完整调用者](fixtures/unified-agent/windows-installed-tui.qualification.ts)以 `bun run tests/fixtures/unified-agent/windows-installed-tui.qualification.ts --terminal=<absolute-terminal> --native=<absolute-native>` 消费同 release job 已构建的两种准确候选；actual win32/x64 required，无 backend availability skip。真实 80×24 ConPTY 先用独立 Terminal，再登记 Native 到同一稳定前门，每模式 120 秒、各 PTY 30 秒、写操作最多 10 秒，核提交／全文／思考／导出／精确取消／未提交草稿／普通退出／冷读零重放及最终卸载保数据。原 Job0／完整 EOF／strict Close 与未 Terminate 是成功条件，强制收尾不能改成通过；这条新 caller 不修改原 POSIX 窗口或默认 isolated 调度，也不代 Windows 真正跨代码／Shell／MCP／RSS／完整阶段资格。

[Windows TUI 私有记录完整文件](../apps/cli/test/isolated/windows-tui-private-files.test.ts)归 CLI owner，九份 closed 文件、9 MiB 原记录／CAS、recovery 262144／config 8 MiB 边界和原 native hardlink／rebound 拒绝只能由实际 Windows 执行；本机另核非平台拒绝与验证期 Close mock，不能 availability skip 冒充通过。原九份 journal 单测和四份 Profile／路径邻接整文件分别保持原断言与预算。准确输入／日志与未执行范围见 [当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11windows-installed-tui-私有持久化与正式调用者)；Win/Linux 实机按用户最新安排留到最后交 GitHub Actions，用户独立 Windows 验证不由本机 mock 代替，现有接线保留。

Required CI、正式 soak 与 macOS／Linux 保持 Bun 1.4.2；现有七份含 Windows 的验证矩阵只在 Windows 选择 1.4.3，以覆盖已复现的 tsconfig override 路径问题。性能或稳定性结果只适用于准确代码、运行时和平台；workflow 定义不等于执行证据。

正式 Terminal wrapper 夹具的子环境保三端必要宿主变量及私有HOME／Profile，但清除测试运行器内部 `BUN_FEATURE_FLAG_NO_ORPHANS`：该模式只属于外层测试进程，不能传给短命CLI而提前关闭有明确stop责任的独立daemon。默认运行器原 `--no-orphans`、原完整文件／业务断言／预算及实际daemon stop保持；同默认flag的完整文件已验证此边界，不以关闭全局门禁或自动重试解决失败。

Native 头部操作 DOM 完整用例在 React unmount 后，先等待 FocusScope 已安排的零延迟卸载事件，再关闭同一 DOM 和恢复全局 Event／CustomEvent。原错误弹窗、草稿、窗口调用与零工作九条断言保持；该清理仅覆盖实际下一轮事件，不声称排空任意未来timer，也不延长原预算。

本轮 Win/Linux 无需实际运行，只要求 Actions 配置完整并注明未实测。[Runtime transport](../.github/workflows/runtime-transport-qualification.yml)在原 macOS／Linux／Windows 矩阵及八 workspace build 后，分别以独立 Bun 进程执行原 `run-resume`、`job-report-resume`、`job-reconcile` 和 `recovery-preparation-ownership` 四份完整文件，无过滤／容错或新增平台矩阵；原15分钟job、文件预算和全部断言保持。现有安装／版本／MCP／维护／保数据卸载链仍由各原工作流调度，本轮不 dispatch、不声称平台通过。

共享行为测试保持三端同一业务断言、预算和完整文件；临时目录、file URL、依赖目录链接及 PTY 只适配平台原语，不用平台 skip 代替能力验证。[Runtime transport workflow](../.github/workflows/runtime-transport-qualification.yml)在 macOS／Linux／Windows 准备后构建当前八 workspace，执行原[草稿完整生命周期](../apps/cli/test/isolated/tui-drafts-host.test.ts)、[CLI Files 三范围恢复](../apps/cli/test/isolated/file-recovery-argv.test.ts)和[E13 完整扩展版本替换](isolated/unified-agent/extension-upgrade.test.ts)，另完整执行 [TUI Files both](../apps/cli/test/isolated/tui-file-recovery.test.ts)、[session／code](../apps/cli/test/isolated/tui-file-recovery-scopes.test.ts)、[物理丢回执](../apps/cli/test/isolated/tui-file-recovery-lost-replies.test.ts)、[两窗口强杀冷恢复](../apps/cli/test/isolated/tui-file-recovery-crash.test.ts)及[当前终端画面回归](../apps/cli/test/file-recovery-pty.test.ts)。Files 共享驱动保完整当前长卡与冷原请求／零POST，宿主和所属Service必须实际退出，方法与资格范围归[CLI Files owner](../apps/cli/README.md#files-三范围恢复-caller)。E13 消费已核制品声明的运行时入口，Windows 使用 junction 和必要系统环境；旧 Job 排空、新 Run 替换、冷读零重放与45／120秒预算保持。[CI guard](../scripts/check-unified-workspaces.ts)及[原 mutation 测试](integration/scripts/unified-ci.test.ts)拒绝删平台、漏文件、测试名过滤或不执行当前构建。草稿使用[Bun 原生 PTY／ConPTY](https://bun.com/docs/runtime/child-process)；Windows 受控强退与实际 OS 信号的验证边界归[CLI owner](../apps/cli/README.md#开发-tui-持久草稿)。本机 macOS 通过不计 Win/Linux 原生资格；其他既有 POSIX TUI 夹具未因此自动完成移植，平台专项用例保各自原适用条件。

Win/Linux 后续验证沿[现行 Actions 接线](../docs/active/release-control.md#winlinux-后续-actions-接线)运行原完整安装、真实代码版本切换、维护恢复及保数据卸载。独立 `test:runtime:stdio` 保原六文件，另接 Linux SDK／namespace、Windows SDK／Job 与 sealed 默认 Source 四份完整文件。前九文件运行后，sealed 文件在独立 Bun 测试进程执行：它必须在宿主首次打开 Database 前选择包内引擎，不能与先前初始化 SQLite 的 source 测试共用进程。两条命令顺序执行、任何非零保持失败，全部原断言与180秒／12秒期限保留。

同一transport命令另完整执行[/recovery](../apps/cli/test/isolated/tui-recovery-host.test.ts)、[/theme／language](../apps/cli/test/isolated/tui-preferences-host.test.ts)和[/mcp连接](../apps/cli/test/isolated/tui-mcp-connection-pty.test.ts)。它们与Files共用[CLI测试PTY原语](../apps/cli/test/fixtures/tui-pty.ts)；业务driver各自保原流程、真实SQLite／HTTP与10秒读取、6＋3秒退出、30／40／180秒整例预算。Windows shared用正式named pipe，MCP测试清理沿绑定原实例的公共Lifecycle正常退出；POSIX保真实SIGTERM。原Source／sealed初始化仍按默认每文件进程隔离，不把它们直接并入一个Bun测试进程。本机完整CLI owner回归与三端原生资格分开记录，测试接线不改变RSS、全Runtime观测或阶段退出门禁。

同一三端命令已接完整[composer](../apps/cli/test/isolated/tui-composer-host.test.ts)、[Workflow 问题](../apps/cli/test/isolated/tui-workflow-question-host.test.ts)及[Planning 四入口](../apps/cli/test/isolated/tui-planning-host.test.ts)，共用上述 PTY 原语和 native driver，不依赖 Python 的 POSIX `pty`。原完整断言、实际 HTTP／SQLite／审批／终态与30／40／30秒预算保留。Workflow 及其 CLI JSON 消费者使用实际 built 默认 Service，移除 macOS 专用 wrapper；Linux transport 在消费前准备 compiler／Bubblewrap，Windows 缺合格 script verifier 仍保持真实失败，不删用例或替换权限后端。最终正文仅观察原问题提交之后的实际输出字节，原 unknown 回执由自动查询恢复，完整正文断言保持；当前答题就绪仍核当前原 Session／Question2／Answer。准确红绿和证据复用范围见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12composerworkflow-问题和-planning-完整三端测试)。

[MCP Tools完整查看](../apps/cli/test/isolated/tui-mcp-tools-pty.test.ts)、[Source来源管理](../apps/cli/test/isolated/tui-mcp-source-mutation-pty.test.ts)、[项目来源批准](../apps/cli/test/isolated/tui-mcp-source-approval-pty.test.ts)、[强制重连](../apps/cli/test/isolated/tui-mcp-reconnection-pty.test.ts)、[Auth管理](../apps/cli/test/isolated/tui-mcp-auth-pty.test.ts)、[配置与清屏](../apps/cli/test/isolated/tui-mcp-pty.test.ts)、[冷配置恢复](../apps/cli/test/isolated/tui-mcp-cold-pty.test.ts)、[paired／shared Skills目录](../apps/cli/test/isolated/tui-skills-host.test.ts)、[正式Terminal完整导出](../apps/cli/test/isolated/tui-export-host.test.ts)、[默认三题问答](../apps/cli/test/isolated/tui-question-pty.test.ts)、[完整权限授权](../apps/cli/test/isolated/tui-permissions-host.test.ts)及[Workspace文件候选](../apps/cli/test/isolated/tui-file-candidates-host.test.ts)现各用一条独立Bun命令进入同一三平台transport job。Windows编译器和当前八workspace构建先于消费，这些完整调用者先于原transport及shared14；导出／问答排在权限之前，避免缺Windows Shell阻止独立能力先验证。Source／重连／导出的首Database前候选engine选择不能合并进已开库Bun进程。Mac原固定版本断言在其平台保留，nonMac用公共审查identity／真实builtin核验，manifest绑定保持。导出POSIX保原0600，Windows对同两实际文件用原生verifyFile，不修ACL；两个新驱动的原完整流程／断言／预算、macOS结果和运输观察真实红归[CLI owner](../apps/cli/README.md#tui-原生滚动与清屏)。Windows Shell 缺项、文件候选实际 Windows 资格及 Source批准红的异常清理未确认继续保门禁。只读文件候选在 Shell 权限例前独立运行，并新增[三端目录记录解码](../apps/cli/test/file-candidate-windows-records.test.ts)与[平台原生后端验证](../apps/cli/test/isolated/file-candidate-windows-native.test.ts)的完整命令；不以平台替身或 availability skip 解除原生门禁。原CI guard逐一拒漏命令／过滤／平台条件与合并进程，不扩大已闭合故障矩阵；Win/Linux及系统Vault／浏览器仍待实际资格，RSS／完整观测门禁不变。

同一三端job另接[普通申请中断／冷原查询](../apps/cli/test/isolated/tui-caller-intents-host.test.ts)、[独立Job停止／冷恢复](../apps/cli/test/isolated/tui-caller-job-stop.test.ts)和[完整CLI library](../apps/cli/test/isolated/cli-caller-library.test.ts)，各整文件／独立进程／无过滤，原30秒预算及所有原断言保持。普通Work不依赖Shell、先于权限；Job夹具退役自建Runtime／Mac Shell／可信策略，消费封闭built默认Service和公开trust／Full，library完整共享消费已重验。POSIX原SIGKILL保持，Windows在同提交丢回应屏障后由实际持有caller的父／driver只终止caller，核native dispatcher0／异常exit／PID gone，不强杀另持Service／sibling或伪造信号。原字节／scope／唯一POST／冷原GET／Model不增加及正常退出保持；缺Windows正式Shell继续真实失败，准确证据归[CLI owner](../apps/cli/README.md#tui-普通-caller-的持久原意图)。

同一三端job增加[正式paired／shared CLI argv](../apps/cli/test/isolated/cli-caller-host.test.ts)、[普通CLI三类原请求](../apps/cli/test/isolated/cli-caller-kinds.test.ts)和[对应TUI有限caller port](../apps/cli/test/isolated/caller-kind-crash.test.ts)三个完整独立Bun进程，均在Shell权限例前；原30秒整例／断言不变。argv消费真实build／verify Terminal和正式SID pipe，旧手工daemon manifest退役；原SQL在新候选Bun中首DB前选择已核engine并持SH。三类caller保原scope／完整正文、真实POST／首GET loss、原Service中断和冷两GET零POST，Windows只对实际所属caller／Service作原生终止并核实际异常exit／ESRCH，POSIX原SIGKILL仍核。argv未知退出保出生身份和所属根，不把异常清理改写为正常。CI guard同步逐一拒漏文件／过滤／平台条件／合并进程；具体范围、真实失败及最终本机证据归[CLI owner](../apps/cli/README.md#普通-cli-caller-的持久原申请)。Win/Linux实际运行、RSS／完整观测仍未通过。

argv保持原顺序准备，完整Terminal candidate归成功的开发Service fixture所属根，spawn失败走原收尾；默认完整制品独占排程保各30秒testcase和十二次cold调用，不缓存或排除测试。持续stdout／stderr、原caller退出／信号及onLaunched之前实际Service出生观察保存早期失败，未知保根。builder异常只有父退出证明，不能补认完整后代资格；原四并发完整default的真实累计超时和必要修复单列，不因单文件绿色宣布组合通过。

[并行Tool原SQLite故障注入](../packages/agent/test/isolated/execution/parallel-tools.test.ts)和[OAuth原证明故障注入](../apps/service/test/isolated/mcp-oauth-actions.test.ts)的实际SQLITE_BUSY红，定位了独立Database未继承Store Worker写锁等待：在原写连接内一次设置同样的 `busy_timeout=1000`，保CREATE／真实terminal拒绝／DROP、全部故障值／恢复／SQL／断言和预算。有限源码核对亦补齐仍持同库Worker的Source entry/result、default after-turn、per-Run child、session logs及running daemon原故障写连接；只读观察和已有100ms等待保持。Run inactive不等于控制事务与owner释放全部结束；独立连接默认0会在注入／清理与合法短事务竞争时立即BUSY。修正只补有界原生等待，不改生产终态、增加应用重试或声称实际Runtime锁泄漏已修复。原临时Workspace URI沿标准 `pathToFileURL` 转换，不用平台skip；准确同机制范围及未证三平台结果归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12默认-task-汇报与-planning-权限单点装配)。

[Client扩展输入](../packages/client/test/isolated/extension-inputs.test.ts)与[原选择](../packages/client/test/isolated/selected-skills.test.ts)两个完整文件保所有原capability／closed输入／快照／唯一POST断言，明确真实HTTP空JSON得到 `invalid_response`，以及发送任何response前物理socket断开得到 `network_outcome_unknown`。后者仍保存完整原请求且各只一次POST；空响应后的socket关闭仅为收尾，注册close前核已关闭状态。无fetch替身、伪造Response、sleep或重试，生产网络错误语义和原预算不变。

真实child的JSON ready publication须先完整写闭同目录临时文件，再rename到原最终路径；父进程仍按原存在屏障一次读取和解析，不吞解析错误。[恢复后Model历史](../packages/agent/test/isolated/recovery/history-followup-runtime.test.ts)的真实空文件红定位了该竞态，同机制的report、Windows caller、deferred和synchronous extension fixture亦补齐原publication。所有原payload／窗口／提交顺序／断言和预算保持，便携路径用系统tmpdir与标准file URL转换。原POSIX SIGKILL保留，Windows核held child的原生dispatch与异常exited；父退出不推广为全后代、Artifact ACL或三平台资格。

[Native审批DOM原完整测试](../apps/desktop/test/isolated/native-approval-dom.test.tsx)在真实点击后等待附件实际 `verified`：onClick的void load仍须完成异步SHA-256，act不能代替该完成条件。等待绑定原整例开始的5秒，核验错误立即失败；原未验证禁批准、完整command字节／原卡／可选grant／标签断言保持，生产reader与digest不替换。

[完整Session／Context管理](../apps/cli/test/isolated/tui-management-host.test.ts)、[paired／shared模型与effort](../apps/cli/test/isolated/tui-models-host.test.ts)和[三类主机状态](../apps/cli/test/isolated/tui-status-host.test.ts)现同样以三条整文件／独立Bun命令进入三端transport，均无Shell依赖、在权限用例前。内嵌Python驱动退役为共享PTY／ConPTY；原实际开发脚本或runTUIHost、开发built Service／raw daemon／默认engine按各自范围保持。管理19／模型18／状态5共42个原Bun静态断言、原20项Python检查和各40秒整例保留；原6秒观察＋3秒exit/EOF join不缩短。管理preload与另外两例透明spawn只观察真实Service所属退出，不替换生产宿主；状态保Build owned-status／Shell unavailable，模型原回应后异常注入不冒称物理socket故障。正常TUI／Service、shared detach和原daemon异常／正常退出分开证明；未知保错误／身份／根。完整本机7pass／53expects和两处真实红归[CLI owner](../apps/cli/README.md#开发-cli-tui-宿主状态)与[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12tui-完整管理模型设置与主机状态的三端测试)。CI guard保逐一漏文件／过滤／错平台／合并进程拒绝；Win/Linux原生、安装制品、RSS／完整资源仍待原门禁。

[完整原生滚动文件](../apps/cli/test/isolated/tui-scrollback-pty.test.ts)和[共享驱动](../apps/cli/test/fixtures/tui-scrollback-driver.ts)也进入三端transport，现22个完整caller独立Bun进程，均在原transport／shared14前；滚动无Shell依赖、在权限前。原有限TSX port及41个Bun静态断言保持，31个mark、全部控制／paste／键序、原始hex和原resize事件由独立20,000行VT复核；原20秒整例、4秒ACK和全部原停顿不放宽。实际Bun原生resize替代ioctl／SIGWINCH，Python文件及Windows skip退役。原fixture正常exit0／EOF、host回执／零mutation及原出生身份dead独立核实；未知或强退保原错误与root，不计正常。此范围没有Service／Provider／installed调用；CI guard继续拒逐一漏命令／过滤／平台条件／合并进程。实际本机、原精确基线复用和Win/Linux未验范围归[CLI owner](../apps/cli/README.md#tui-原生滚动与清屏)，不取得RSS、完整资源或阶段退出资格。

[CI 日志入口](../scripts/ci/logged-shell.ts)由 Actions 自定义 shell 接收带引号的原脚本路径，保留原 run 正文、stdout／stderr 字节和退出码。[完整日志测试](isolated/scripts/ci-logged-shell.test.ts)同时进入有限默认发现及三平台 stdio job；POSIX 核实际 bash，四项 Windows 用例仅由真实 `pwsh` 核 BOM／Unicode、外部 exit23、throw 与输出失败，其他宿主明确 skip。Linux 在完整原生测试前准备 compiler／Bubblewrap，窗口消费者另准备 Xvfb；Windows 使用原安装 MSVC 准备脚本。依赖缺失、运行失败和缺正式资格仍失败，不增加 availability skip、关闭 sandbox 或调低资源门禁。

| 目录 | 当前负责范围 |
| --- | --- |
| `packages/ai/test/` | 中立模型流与明确 SDK adapter |
| `packages/agent/test/` | Loop、Execution/Job、业务 Store、I/O 与扩展 leaves |
| `packages/client/test/` | HTTP/SSE、准入、原意图、Browser/Native 公共合同 |
| `packages/ui/test/` | 公共表单、阅读门禁、复用桌面展示层与便携 TUI 组件 |
| `apps/service/test/` | 可信默认装配、实际 HTTP/SSE、paired/daemon、配置与 Gateway |
| `apps/cli/test/` | 薄 CLI/TUI、宿主资源、原请求与真实 PTY |
| `apps/desktop/test/` | 便携客户端、Electron main/preload/renderer 与私有意图存储 |
| `apps/web/test/` | 只读 Browser controller、DOM 与敏感内容读取 |
| `tests/fixtures/extensions/mini-review/test/` | 有独立 package/公开入口的参考扩展 |
| `tests/isolated/unified-agent/` | 新公共进程、故障、源码外制品与安装交接 |

Owner-local tests 可读自己非公开源码；root integration 使用公开 package exports 或明确 App surface。root 不通过相对 deep-import 另建生产语义，不仅为测试便利扩大 production export。fixtures/helpers 不自动拥有测试；根不保存散落测试或第二通用 `tests/runtime/` owner。

[知识读取 owner](../packages/agent/test/isolated/knowledge-reads/owner.test.ts)与[正式知识收尾调用者](../apps/service/test/isolated/knowledge-cleanup-ownership.test.ts)分别归 Agent／Service。新增完整文件使用 tmpdir／标准 file URL、无 OS skip；真实原 FileHandle／fd 的 JS close 拒绝只证明准确资源持有、两原错误与一次关闭，不代证自然 OS API 失败。Service 覆盖准备、实际 Skill Tool 取消、普通／手动 Workflow 目录及在途关闭；原 child 实际0及双 EOF 后才核公开维护与完整冷读零重放。旧正常知识、Workflow、目录、配置、取消及包外消费者断言／预算保持，本机结果不授 Win/Linux、资源全集、RSS或阶段资格。原红与准确复用范围见[知识收尾进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13同源知识读取与正式目录收尾)。

[显式恢复准备收尾](../apps/service/test/isolated/recovery-preparation-ownership.test.ts)归 Service owner，三例各从正式 SDK 进入 Run resume／Job report resume／Job reconcile，验证实际 standalone WorkspaceFiles 的关闭前 JS 拒绝与 typed 交接。原任务数据逐项完整比较；原交互数组保持，新 accepted Command 仅增加一次游标，report 不增加。关闭失败后独立 Store 的 owner 抢占和维护拒绝、所属进程 0 与双 EOF、公开备份和完整冷读零重放均保留。独立 warm seed 有自己的停止边界，失败清理等待原退出及两输出读取 settle，读取错误仍失败；新整例 15 秒覆盖 10 秒业务和 14 秒清理窗口，不改变任何旧测试预算。使用 tmpdir／标准 file URL、无平台 skip；实际 Win/Linux、原生 OS close 故障、RSS 与完整资源资格仍待原门禁。

[单文件实际资产保护](isolated/unified-agent/single-file-runtime-protection.test.ts)从真实 verified Terminal 候选复制 loader 必需的 SQLite main、observer preload 与 migration，以及原 parser／checksum／MCP guardian；不以替代 Worker 或省略观察修复启动。默认和 custom parser 两条原读写拒绝循环均消费真实 preload，另核其完整原字节保持；邻近 Workspace 写入、paired／cold、真实 parser 和关闭失败后的锁／进程退出合同继续保留。原 34 条 expect 链及 driver 断言、120 秒整例／20 秒 child 预算不变，新增两处字节检查。tmpdir／标准 file URL 适配平台，失败默认保根及原回执／wire／child stderr，成功才清理；原 keep flag 保留。准确 red、修复和原完整默认终态见[当前收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13当前完整默认收束与单文件资产交接)，不从本机绿色推定全资源、RSS或三平台资格。

[TUI 取消中的后继输入](../apps/cli/test/isolated/tui-finishing-input-host.test.ts)属于 CLI owner 的隔离完整文件：真实 HTTP/SDK/SQLite/Runtime、正式 caller port 和 TuiController，以受控 Job 停止屏障核四种公开 `cancelling` 读取、原后继完整正文、切会话晚回执保草稿、原 Command 查询／重复准备零新增 POST，以及正常关闭。临时目录和 file URL 使用平台中立入口，没有 Shell 或平台 skip；它不替代 PTY、原生进程清理与 Win/Linux 实机资格。

[Profile verifier 原生取消](../packages/agent/test/isolated/business/skill-workflow-host-verifier.test.ts)的脚本先写闭同目录临时PID记录，再发布最终记录，父按原预算一次读取。原 `kill(pid,0).toThrow()` 与全树收据断言保持；失败根保存实际读取字节、起始出生、terminal和瞬时kernel观察，不将事后absent追认为断言时已停止。它属于macOS原生叶的资格，其他平台门禁保持；当前完整默认红与有界空发布演示的不同证据范围见[本片进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13取消中的后继输入)。

[恢复后完整Context消费者](isolated/unified-agent/restored-context.test.ts)属于跨workspace隔离集成：实际Service／SQLite、公开backup／restore及两个冷Service，通过正式CLI和Web App reader核HTTP／Cookie完整原结果与出处、当前Store守卫及零重放。owner-local分页／DOM整文件保各自守卫，原TUI管理PTY另核实际开发入口；不把这些范围合称installed恢复PTY、实际浏览器或阶段完整默认。真实红与准确冻结证据见[Context恢复进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后完整-context-正式消费者)。

[恢复后 Native 明确 Include](../apps/desktop/test/isolated/native-restored-context.test.tsx)归 Desktop owner：真实 Job→Rewind→公开 backup/restore A→B，正式 Context DOM 按钮经有限 decoded bridge 调用 Main／实际 SDK／Service／Core，新 Command 属 B，完整原来源属 A，后续明确新 Run 以唯一 source ID 收到完整低信任结果，冷读零重放。公共 Execution 与 Core 接纳投影分开核对，后者只允许准确新 source 变化。原 Main、共享 Context、Core 自动消费／active Include 和原 Electron 作业保完整文件／断言／预算；原窗口 disabled/busy 时 Enter 零POST的真实失败保留，fixture仅先核同按钮 actionability再保原键盘和丢回执流程。六唯一完整作业26文件137pass／1337Bun断言，原窗口另15Node断言；不代证新 installed 恢复窗口或阶段默认，准确红绿与保全见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-context-明确纳入原结果)。

[恢复后 TUI 明确 Include](isolated/unified-agent/restored-tui-context-include.test.tsx)属于公开跨包隔离集成：实际 Job/Rewind/公开 A→B，真实 Ink `/context` 与 `i` 通过正式 CLI helper 调 SDK/Service/Core；新 Command 属 B，完整原 source/Execution/revision 保 A。idle 零 Model，用户明确新 Run 才读取唯一低信任原结果，冷 Service/Client/Ink 只读，原 ledger 效果一次。有限 port 只接受本例实际 start/Include，未知写入拒绝；不冒称 installed 恢复 PTY、活动后端变更或阶段完整默认。原完整管理分片、公共 Context 与 Core active Include 验证及准确失败归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-tui-context-明确纳入原结果)。

[恢复后 Native 压缩原输入](../apps/desktop/test/isolated/native-restored-compression-input.test.tsx)归 Desktop owner：实际压缩、公开 A→B 与两次新 Service／Client／Caller／完整 NativeDesktop DOM，经真实父回调与 decoded bridge 读取原 Core 输入。确认前不读取正文，完整 request／metadata／当前 cursor／IPC 字节及 EOF／SHA 精确核对；Close 清正文，迟到真实 Main open 回复在切 Session 后不发布。原出处／Model／Run／Command 与 cursor 保持，全 GET／cold Model0；跨 Session 快捷入口限制由原文件末尾新增 DOM 例验证。最终五个唯一原完整作业28文件105pass／1027Bun断言，保全部原文件／断言／预算；原压缩窗口另41Node断言及所属 PID 清理。新整例明确确认无 Node 私有数据库的实际草稿告警，不冒称 preload／Electron／installed 恢复窗口或网络中途取消；业务红、旧文件字节保全和复用范围见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-压缩原输入入口)。

[恢复后 TUI 主会话完整输出](isolated/unified-agent/restored-tui-model-output.test.tsx)属于公开跨包隔离集成：真实 Model→Tool→Model/sealed Fork→公开 A→B 恢复，两次冷 Service/Client 和实际 Ink Ctrl+O 读取原完整正文/思考/calls/元数据/current cursor，已加载导出及切换/dispose 迟到交接，全 GET/零重放。透明 exporter 只核真实 serializer，不冒称实盘或 installed 恢复 PTY；原[正式 Terminal PTY](../apps/cli/test/isolated/tui-export-host.test.ts)独立核 9 MiB/0600 文件及正常退出。根 TypeScript 现在同时包含此目录 TS/TSX，两个整例只补必要非空类型标注，原行为断言/预算保留。六个唯一原完整作业34文件230pass/2312Bun断言，包含原后台68断言；夹具冷 owner 修正后只复验受影响整例，生产/依赖/运行配置未变的 UI/PTY 证据按输入复用，真实红及资格范围归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-tui-完整-model-输出与导出)。

[恢复后 TUI 后台读取](isolated/unified-agent/restored-tui-background.test.tsx)使用实际 Service/SQLite、公开 backup/restore 和两个冷 Service，通过公共 HTTP 端口与真实 Ink/controller 核恢复目录、原 Job 220 项跨页输出及 gap、child 完整 Model 正文、原 ID/出处/结果保持、全 GET 和零重放。新例只产生少量 child 消息；多页 child、准确停止与持久 caller 冷查回分别复验原[Job/child PTY](../packages/ui/test/isolated/tui/executions.test.ts)和[正式 host stop PTY](../apps/cli/test/isolated/tui-caller-job-stop.test.ts)。这两个原测试文件字节未改，Job/child fixture 仅接真实 getRun；未修改业务、按键、断言或预算。新增 UI 单元核原 definition/Run 出处及历史 S→Enter 零申请；业务红与标签换行观察失败均保留，不合称 installed 恢复 PTY、默认 Shell 或阶段完整默认。准确输入和结果归[后台恢复进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-tui-后台任务完整读取)。

原[默认装配HTTP](../apps/service/test/isolated/assembly-http.test.ts)在同一授权放行前后核source freshness和已受理Run的原能力绑定。[所属Service夹具](../apps/service/test/fixtures/assembled-child.ts)用可取消的文件存在等待消费原release，timer／abort listener均清理，不依赖目录通知；原5秒期限和全部断言保持。失败观察复用原Command／View读取，不增加GET或修改生产权限。原Native基本文件的第三诊断driver阶段通过stdout单次透明读取转发，原字节仍交完整输出断言；观察不抵消真实超时，准确原红与复验归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

[PC 文件变更迁移](../apps/desktop/README.md#原文件变更面板与编辑器)沿原完整 Native 窗口夹具新增文件侧栏、编辑器选择、关闭与冷读断言；默认 Service 真实 Files 回执来自原本机 Provider fixture，不替换 Main/preload/renderer。另由 Files 的 change-preview、Native 的 file-changes 端口和隔离 DOM 文件验证实际 pre/post、精确关联、原 UI 入口与读取释放；端口 callback 不冒充 OS 编辑器窗口，窗口按钮不冒充完整安装／跨平台资格。实际运行与失败归同一[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原文件变更与编辑器入口迁入)。

原 PC 消息路径与常规摘要沿同一 Native 整窗口核首次／冷读、真实缺失文件拒绝、默认配置与 Provider 次数保持；隔离 original-entries DOM 核准确作用域、临时选择分离和原 Markdown 的预览／全文／关闭，文件端口另核已观察 Message、普通目标与派发前 frame。完整证据与未实际启动 OS 编辑器的边界归 [Native owner](../apps/desktop/README.md#原消息文件路径与常规摘要)。

[恢复后 Native 文件消费者](../apps/desktop/test/isolated/native-restored-file-changes.test.ts)沿默认 Service 的真实 read/write/edit、公开 Fork/backup/restore，使用两个冷 Service 与实际 Node Main reader 核原 write/edit preview、五项 read/write/edit 目标和普通消息路径。外部当前文件变化不污染原差异；原 Run/Command/Execution/Message 和 metadata 保持，冷 GET 零重放，opener callback 只证明当前物理目标资格。原 Main 两个完整默认作业和三个原 DOM 文件保全部断言；新增身份换绑负例限同 revision 定义/结果变化，不扩已闭合物理路径或 frame 矩阵。原业务红、夹具权限失败、最终4274项冻结输入与实际结果见[恢复文件进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-文件历史与当前文件入口)。这不代证新恢复整窗口点击、OS 编辑器或阶段完整默认。

原 TUI 补齐的源码对照与验证归 [TUI owner](../packages/ui/src/tui/README.md#原-ink-展示与明确测试诊断)。新 [14 行主屏](../packages/ui/test/tui/subagent-layout-integration.test.tsx)通过普通 TuiSession 核真实并发子项预算；[错误页与真实 Host](../apps/cli/test/isolated/tui-render-failure-host.test.ts)核明确退出和所属 Service 收尾；[上下文估算](../packages/agent/test/context/context-estimate.test.ts)与 [Host 显示](../apps/cli/test/isolated/tui-display.test.ts)核准确原请求和容量来源。新增测试使用便携 Ink／PTY 端口，不以当前 macOS 执行代替 Win/Linux 系统资格。

## 默认执行与隔离

[Windows 普通 Files 专项](../packages/agent/test/isolated/files/windows.test.ts)按同一默认计划发现完整文件，actual win32 必须执行六工具、真实 Core 大正文、binary 恢复和 Windows 路径保护，无 backend availability skip；本机 macOS 四例平台 skip 不计资格。共享原完整 Files 文件及正式 default／assets／Fork／恢复后新 Store 作业已按原独立进程验证；完整断言／预算不变，范围和保留失败见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-普通-files-与检查点恢复源码)。这些本机证据不代证 Windows syscall／installed caller，也不把 file flush当POSIX目录fsync。

[Windows 物理依赖闭包](isolated/unified-agent/terminal-dependency-materialization.test.ts)、[PE 固定字段](isolated/unified-agent/windows-terminal-launcher.test.ts)和 [安装失败收尾](isolated/unified-agent/windows-terminal-installation.test.ts)按原默认 isolated 发现完整文件：真实 Bun 搬迁解析核版本/peer/alias/资源/同版本循环与不能展开的遮蔽循环；独立 PE 字节核只修改新副本既存字段；三个 subprocess mock 只核 selection、原 DELETE acquire-unknown 和 artifact 准入失败不提前交锁。原 [Windows scope](../packages/agent/test/isolated/artifact-access/windows-scope.test.ts)保 native cases及平台 skips，新 close-only mock 核原 HANDLE/region 与重试，不把 macOS 控制流结果计 Windows syscall。

安装收尾mock按原库存区分active与不存在的可选CLI登记，第三例明确Terminal marker存在／Native marker不存在；coordination保实际纯use-key派生export，I/O仍是隔离port。原parser／准入／关闭检查不旁路，所有原错误对象／保锁／顺序断言与4000ms subprocess及默认5秒预算保持。真实默认失败、原完整文件3pass／12expects／61ms及冻结边界归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，该本机结果不计Windows原生／installed资格。

Windows 完整 installed 链另有显式 `bun run tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts --candidate <absolute-existing-candidate>`，只消费准确已构建 Terminal，不能 availability skip、偷偷重建或借本机邻接通过。原120秒整链/30秒命令、实际 paired Run 与双 EOF/关闭、A 使用中升级/回退及冷读零重放、最终全 EX/保数据卸载保持；B仅版本标签，TUI只help/version，正式 `kite.exe` busy backup→backup/inspect/status/restore/status/GC→新 Store 原完整历史冷读链要求完整媒体、原 config/preferences、旧 Store 拒绝、引用/近期保留和零重放；只核近期 GC，不冒称过宽限删除。当前安装／维护及新增Daemon整链原生均未执行，Native/PTY/完整恢复窗口/跨代码及持续资源仍不在此工具证明范围。release Windows MSVC→Terminal build→qualification 已接并由原 CI guard/mutation 核对，common 原 whole/native/always formal 门禁保留；平台旧 POSIX fixture 和未资格 guard 的真实失败不能过滤。按用户安排留重构后 Actions 执行，本地未 dispatch。证据与实际未验范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-正式-daemon-与原实例版本交接源码)。

该同一工具新增必须执行的[Windows installed Daemon helper](fixtures/unified-agent/windows-daemon-qualification.ts)，保原整链期限/所有原断言：真实B start/status/Web、rollbackA仍reuse B/原SH、A前门共享完整Model、原Client dispose仅detach、busy拒绝/明确cancel restart、原HANDLE实际dead、新A完整原结果零重放、正常stop/双EX/恢复原config，再执行原卸载保数据。新[source叶子](../apps/service/src/daemon/README.md)的五个完整测试文件分别覆盖有限SID/原process/pipe/record/完整bootstrap接线及初始artifact关闭未知保活接线；本机mock和原Windows native skips不算原生通过。此工具仍不证明Native/PTY/Shell/stdio MCP/跨代码/持续资源或最终退役。

根 `test`、`test:all` 和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)。它只发现上述当前 owner 与有限的 root 脚本安全列表，不扩展到整个旧 integration/qualification/release/e2e/golden/TUI 树。纯 `--list` 不创建 Profile、Provider 或子进程。

普通测试与安全 isolated 文件使用共享槽，isolated 每文件独立进程且进程内 concurrency=1；编译、SIGKILL、全局资源和准确分类的 exclusive 文件在并行队列 drain 后逐文件执行。macOS 最多4槽，Linux最多2槽；Windows isolated 逐文件串行。失败停止新派发，已启动任务完成 cleanup。每个测试进程使用独立临时 HOME/USERPROFILE 和准确 KITE_CODE_HOME，清理只覆盖自有目录。

共享队列仍支持调用者声明的 `firstFiles`，保原源码大小／label排序及派发机制。当前 [unifiedTestPlan](../scripts/unified-test-plan.ts) 将[CLI 完整调用者与候选制品验证](../apps/cli/test/isolated/cli-caller-host.test.ts)、[Terminal PTY完整读取与导出](../apps/cli/test/isolated/tui-export-host.test.ts)、[完整CLI登记生命周期](isolated/unified-agent/cli-registration-lifecycle.test.ts)、[真实Native代码升级／回滚](isolated/unified-agent/native-cross-version.test.ts)、[完整Native安装生命周期](isolated/unified-agent/native-install-lifecycle.test.ts)、[安装版恢复交接](isolated/unified-agent/native-restore-interruption.test.ts)和[封闭Terminal安装制品](isolated/unified-agent/terminal-bundle.test.ts)七个准确文件列为独占，在所有concurrent job drain后逐个执行。当前发现计划947文件／750job仍各一次，743concurrent／7exclusive；macOS4／Linux2槽、逐文件进程／进程内1和所有原行为断言保持，Windows本来独占，不重复计数。CLI 调用者每个整例30秒，CLI登记／Terminal安装整例120秒及child30秒／20秒，Terminal PTY导出90秒／步骤30秒，Native跨代码420秒／driver120秒／页面15秒，安装生命周期120秒／driver45秒／launch与页面10秒，恢复180秒／driver45秒／launch与页面10秒均不放宽。[实际runner测试](isolated/scripts/test-suite-runner.test.ts)保优先／并发上界／失败drain反例及独占等待退出；默认计划核全集恰好一次及七文件仅在exclusive。调度不证明产品负载延迟，取舍归[受控并行Note](../.agents/notes/implemented/testing/2026-09-28-controlled-parallel-isolated-tests.md)。

原安装生命周期在当前并发默认中，第一次安装直到89.420秒结束，随后用户链被整例期限截断；保留原红和阶段证据后才纳入现有大型制品独占分类。源码外构建、压缩、解包、逐项sync、所有内容校验和最终升级／冷读／回退／保数据卸载仍实际执行。原四路中的基本窗口、问卷和其他普通任务继续受控并行；本分类不能证明四路安装性能或RSS／完整资源资格。真实结果归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)，此前恢复分类的失败归[扩展能力进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。

维护的[Core备份](../packages/agent/test/isolated/maintenance/backup.test.ts)与[Desktop资产](../packages/agent/test/isolated/maintenance/assets.test.ts)在首DB前用[真实引擎夹具](fixtures/unified-agent/qualified-sqlite-fixture.ts)复用正式SQLite builder和公共initializer，核完整资产及发行身份；原业务预算不变，新增setup hook有限60秒。文件最后DB关闭后清理自有selected资产，外部preload资产只复验；loaded selection不能reset，因此这些文件沿原isolated每文件独立进程运行。[独立默认Source资产文件](../packages/agent/test/isolated/maintenance/mcp-source-approval-intents.test.ts)实测默认engine身份，并核严格关闭后实际Core DB/WAL/SHM的presence与完整bytes在create/inspect后保持。两个范围分别记录，单文件绿色不构成完整默认或三平台资格。

## 子 Agent 协作 V1.1 验证

2026-10-22 范围调整：用户确认移除独立输入归属判定，新消息直接进入普通主 Agent。当前断言归[普通输入 Runtime](../packages/agent/test/isolated/business/task/human-work-runtime.test.ts)、[当前配置热冷续轮](../packages/agent/test/isolated/business/task/collaboration-config-continuation.test.ts)、[旧记录 SIGKILL 后拒绝恢复](../packages/agent/test/isolated/recovery/human-input-processing-crash.test.ts)、[实际 Service](../apps/service/test/isolated/human-input-processing-recovery.test.ts)、[CLI HTTP](../apps/cli/test/ordinary-command-http.test.ts)及[真实 Electron](../apps/desktop/test/isolated/native-human-input-electron.test.ts)。分类专用竞争／继续场景退役，由普通输入、队列、准确取消、结果事务和历史兼容断言接替；旧 paid C04 入口显式拒绝启动。原方案编号和先前运行数保留为历史证据，不构成退役机制的当前要求，也不表示本次重跑过完整发布组合。

本次验证环境为 macOS arm64、Bun 1.4.2，代码为 7b579cfbcc5eca76d286a3f84facdb321d6e0360 加本次未提交改动。协作／权限／历史兼容组合实际 197 项、3165 断言通过（58.36 秒），原 Run 冷恢复组合 66 项、914 断言通过；HTTP／模型选择／附件／标题／授权／双宿主生命周期组合 66 项、1114 断言通过。197 项的实际命令为：

~~~sh
bun test packages/agent/test/isolated/business/task packages/agent/test/isolated/recovery/human-input-processing-crash.test.ts packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts packages/agent/test/isolated/execution/live-permission-mode.test.ts packages/agent/test/isolated/artifacts/input-images.test.ts packages/agent/test/isolated/storage/human-work-control.test.ts packages/agent/test/isolated/storage/human-work-handoff.test.ts
~~~

默认 Service 补充组合（default-after-turn、default-web-fetch、task-configuration、planning-successor-proof）以对应四文件的 bun test 命令实际运行 23 项、313 断言通过（14.69 秒）；隔离夹具通过正式 workspace trust 控制显式信任，未放宽生产策略。开发 CLI 整文件 6 项通过，保原配对／共享退出、准确文件效果及冷 GET-only。旧自然语言暂停／继续的规划测试随分类功能退役，原计划批准、条件变化拒绝、单槽结果接纳与历史来源证明仍有真实断言。

最终源码另运行 bun test apps/desktop/test/isolated/native-human-input-electron.test.ts，真实隔离 Electron 1 项通过（17.54 秒）；正常首次与冷重开均为用户→实际回复，同文重交为两个独立输入，processing=0、rawIds=[]。实际窗口证据在本机 dist/acceptance/human-input-electron-44bbcc78-60f0-4748-9872-67f5230b8ac2/facts.json，属于本次生成证据。全仓 typecheck 覆盖 8 个 workspace；文档、边界、生成 API、测试归属与既有计划证据检查通过。以上未执行付费 Provider 或跨平台完整发布验收，不替代旧失败／未知记录。



本次提交前 review 补齐普通 Native 项目访问准备的未知回执、切换会话和过期观察三项 Main 回归，并把退役的独立范围确认 DOM 用例改为直接输入、权限模式与草稿隔离、原 ID 查询。原正式 Electron 驱动曾停在已删除的“确认项目读取范围”按钮，保存该失败事实；驱动改走当前普通流程后整例实际通过（16.09 秒），`facts.json` 为 `dist/acceptance/human-input-electron-908fe0e7-9a91-42f0-9abc-3e33f39c7cc4/facts.json`，首次／冷重开顺序一致、`processing=0`、恢复命令和问答计数为零，正常退出及所属子进程退出均通过。review 的 36 个唯一受影响文件共 366 项、5682 条 Bun 断言通过；其中 Core／SQLite 8 文件 66 项、Main 权限及 caller 2 文件 36 项、Native DOM 59 项、其余 Service／CLI／恢复／开发组合 23 文件 195 项、NativeConversation 9 项、正式窗口 1 项，重叠补跑不重复计数。全仓 8 workspace 类型检查、文档、API、边界、测试归属及计划证据检查通过；未执行全量默认套件、付费 Provider 或跨平台发布验收。

提交基线随后快进至 `a37c9797749c67a9400e5cdfe0f28d63fabe1e5a`，保留业务已应用后取消输入的历史展示证明。相交的 `human-work-control.test.ts` 整文件重新运行 38 项、291 断言通过（2.36 秒），Agent 类型及文档／边界／API 检查再次通过；该文件与上述组合重叠，不叠加计数。

真实模型测试的输入、交错时点、硬判据、证据与执行顺序归[69 个主用例](e2e/live/model/collaboration-v1.1-cases.md)，映射下述 80 项合同并补标题规则。当前六工具 smoke 与显式 `test:model:collaboration:live` 已接入真实默认模型；执行结果、失败修复及仍未命中的变体归该用例文档，入口、预算和隔离规则见[套件说明](e2e/live/model/README.md)。公网 MCP smoke 仍使用固定模型。下面的受控 Provider 运行证据不计作这张真实模型矩阵通过。

2026-10-20追加普通Native与真实PTY窗口、P04六种顺序、A03等待、P08旧批准/审核、排队child双引导/中断及输入精确交错，按每次非Markdown工作树摘要保留原报告；69主用例和80合同各行分别列已覆盖范围、未测项及证据，不将局部窗口或受控测试升级为全表通过。发现的TUI审批Esc误取消根工作、旧A澄清候选丢失、控制否定撤回、只读等待取消投影、进度目标/当前选择混淆及模糊控制问句被错标进度分别修正并复验；失败和未命中不改写。当前完整默认结果及原预算内夹具前提修正统一归上述执行记录，2026-10-19第七轮通过只覆盖其原冻结输入。

2026-10-19（UTC）真实执行的逐变体记录归上述用例文档：23个协作CLI变体与当前六工具smoke分别报告，固定Provider默认回归另计。已修正idle邮件绑定、首条待决澄清与标题、当前原文位置及新增要求解释、queued B取消后的技术handoff、AbortSignal跨Worker读取Artifact及嵌套carrier收束竞态；另对新读取请求分类和进度回复做独立语义复核并补强历史状态约束。默认复验另修正Darwin Shell pipe错误观测边界和损坏report祖先的类型退路；真实暂态错误后的errno干扰仍须完整输出和准确回收，损坏report须在running/terminal分别拒绝。follow-up测试沿准确carrier回执等待最终提交，保原总deadline与全部终态断言。自然负载EPERM的具体触发源保持未知。最终第七轮完整默认945文件／748job及7 exclusive全部恰好一次通过，代码输入零漂移；准确摘要和前六轮失败归上述用例记录。原失败、夹具修正、未覆盖变体及每次工作树摘要均保留，不以最终绿色标签抹掉前次结果。

本轮依据外部《Kite 子 Agent 协作优化方案 V1.1 · 实施补充版》第1–9节及最新6.5.1，源SHA256为 `cce7a0760637c0517831ee8fdcf89476e717d5d0dc87f392d5ae5640f2a0280b`；第10节历史云端测试数、review人数和状态不计本地证据。实施基线 `f734245a8b761cd75518624c250c9761e9676091`，`el-refactor` 持久checkout本轮未提交改动；本机 macOS、Bun 1.4.2、本地受控 ModelAdapter／compatible SSE Provider。编号对应原方案80项验收，表内列出实际断言入口，不能用有文件代替运行结果。

| 验收范围 | 负责断言与实际边界 |
| --- | --- |
| 1–5、13–19、23–24、34、58–63、67、71–72 | [六工具真实协作](../packages/agent/test/isolated/business/task/collaboration-surface.test.ts)、[分页/父压缩/冷目录及邮箱缺口](../packages/agent/test/isolated/business/task/collaboration-observation.test.ts)、[旧 mailbox/adoption](../packages/agent/test/isolated/business/task/mail-adoption.test.ts)：唯一调用回执、active/queued/idle pin、后续父轮次管理已有直接child与idle复用、职责全文、稳定锚点分页/Decimal64、错误accepted三态及自身邮箱缺口/水位。原invocation重试和相同正文新调用分开。 |
| 6–12、20–21、35–38、46、54–57、61、64 | [通知](../packages/agent/test/isolated/business/task/collaboration-notifications.test.ts)、[实际SQL故障/丢响应](../packages/agent/test/isolated/business/task/collaboration-report-transactions.test.ts)、[冷恢复丢响应与问题去重](../packages/agent/test/isolated/business/task/collaboration-cold-report.test.ts)：active/idle唯一Source/ack、多结果同R、普通队列优先、ack后stop保原target、trigger全回滚、返回丢失原Run继续；on*全缺及同一永不settle observer真实队列溢出仍可靠。 |
| 27–29、37–38、48–53、61、68、72 | [普通输入](../packages/agent/test/isolated/business/task/human-work-runtime.test.ts)核直接执行、无额外解释回复、引导/队列、撤回、同文重交与迟到 child 结果；[历史 SQL](../packages/agent/test/isolated/storage/human-work-control.test.ts)保旧决定及呈现证明。[CLI HTTP](../apps/cli/test/ordinary-command-http.test.ts)核实际回复与冷读取零重发。 |
| 26、50–51 | [热冷当前配置](../packages/agent/test/isolated/business/task/collaboration-config-continuation.test.ts)核新轮次使用当前模型/权限、旧历史保留而原 Run 不复活；[旧 processing SIGKILL](../packages/agent/test/isolated/recovery/human-input-processing-crash.test.ts)及[实际 Service](../apps/service/test/isolated/human-input-processing-recovery.test.ts)核分类不可恢复。 |
| 29、53、68 | 普通正文不再预解析 pause/continue；[历史控制](../packages/agent/test/isolated/storage/human-work-control.test.ts)保准确旧控制、停止、unknown。新的取消／停止经原精确工具与 UI 协议。 |
| 30、69–71、74 | [父子问答闭环](../packages/agent/test/isolated/business/task/question-loop.test.ts)：child有限观察后如实待决，父真实ask_user回答后stable child追问，on*关闭；实际通用摘要Model发布压缩后同Session继续，准确来源；双mail水位、结果携带问题只关联、R1不改投R2、失败/丢响应/双消费者不复制。 |
| 31–33 | [真实Files协作](../packages/agent/test/isolated/business/task/collaboration-files.test.ts)：两个真实child的分页完整基线、未选行变化、同mtime/同内容换inode、失败者新读取保双方修改；X成功Y冲突、外部直写、实际发布后确认失败unknown及原重试零重放。Files CAS不承诺Shell直写原子性或整批回滚。 |
| 39–46、75–80 | [实时权限](../packages/agent/test/isolated/execution/live-permission-mode.test.ts)、[queued/idle/丢响应/策略失败组合](../packages/agent/test/isolated/execution/mode-collaboration.test.ts)、[真实SIGKILL待批](../packages/agent/test/isolated/recovery/live-approval-crash.test.ts)、[批准/审核](../packages/agent/test/isolated/execution/authorization-check.test.ts)：双向当前根模式、三层可信注入、其他根/硬只读隔离、旧grant/review/资源等待/明确拒绝、冷读与准确显式恢复。策略与synthetic effect证据、原生工具和窗口分别陈述。 |
| 22、39–47 | [Native双child整窗口](../apps/desktop/test/isolated/native-collaboration-bundle.test.ts)、[80×24 TUI PTY](../packages/ui/test/isolated/tui/collaboration.test.ts)：准确child审批、stable follow-up、旧轮卡/迟到批准不改投、精确停止、原主输入框/活动选择、冷打开零Provider及owned清理；DOM/projection单测不代替这些交互。 |
| 24、45、65–66、73 | [required/附着结算](../packages/agent/test/isolated/business/task/attached-job-settlement.test.ts)、[生命周期](../packages/agent/test/isolated/execution/run-lifecycle.test.ts)、[默认规划后续](../apps/service/test/isolated/default-after-turn.test.ts)、[计划后继proof](../apps/service/test/isolated/planning-successor-proof.test.ts)：未结清attached Job/unknown不伪报carrier成功，内部child/report不递归业务钩子，原计划义务/来源与准确work保持。 |
| 25 | [原stream负载整文件](../apps/service/test/isolated/multi-session-stream-load.test.ts)：4/16/32 Model槽，32槽8父×3子，持续30秒与原90秒预算、3秒drain、read/health/abort和真实终态不变；[Shell混合负载](../apps/service/test/isolated/multi-session-shell-load.test.ts)另核真实进程和输出，不以轻负载替代。 |
| 26、43、46、63 | [源码外默认Task](../apps/service/test/isolated/task-packaged-default.test.ts)、[完整制品能力](isolated/unified-agent/built-package.test.ts)、原[报告冷恢复](../packages/agent/test/isolated/recovery/job-report-resume-runtime.test.ts)：实际默认装配、完整108042字节Source、准确权限和旧封存历史；无Provider/当前配置替代原绑定。 |

此前定向组合已取得 Core 六文件22项/556断言，Service default-after-turn与planning-successor-proof共14项/134断言；报告事务单文件9项/101断言。原stream定向整文件3项/174断言、43.68秒：32槽实际峰值8父+24子、31.034秒持续段、48批360读取、readFailures=0，全部原drain/终态断言保持。Native双child整窗口1项/13个Bun断言、27.41秒、15次受控Provider请求及原driver行为、TUI两项43断言分别已运行；精确范围由客户端owner维护。新增目录组合1项/72断言实际核双无名协作者、父真实压缩、冷readonly、固定分页上界与Host缺口恢复边界；解释轮两个SIGKILL窗口与Service原配置恢复/人类输入/Fork/审批强杀组合13项/274断言，动态模式组合及原模式/强杀12项/88断言已通过。通知/事务/继续/人类输入/解释强杀/控制竞争/冷报告此前七文件组合31项392断言、原冷报告邻接16项280断言通过；真实Native计划整窗口1项316断言保持完整。

上述解释轮与自然语言控制的强杀、竞争结果属于移除前历史。当前旧处理记录恢复明确拒绝，普通 Run 恢复沿[执行组恢复](../packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts)；[实时权限](../packages/agent/test/isolated/execution/live-permission-mode.test.ts)仍核已派发继续、下一调用按最新 revision。

公开输入消费者另以[共享Client helper](../packages/client/test/ordinary-command.test.ts)、[CLI边界](../apps/cli/test/ordinary-command.test.ts)和[真实HTTP/SQLite](../apps/cli/test/ordinary-command-http.test.ts)共13项92断言，核实际business Run、技术steer被解释为独立工作、封存unresolved与foreign拒绝。真实[开发CLI包装器](isolated/unified-agent/development-cli.test.ts)6项251断言，包含实际paired退出3、完整澄清和冷shared仅GET原输入，不重发也不制造业务Run；[Desktop输入单测](../apps/desktop/test/input.test.ts)9项92断言与[真实配对](isolated/unified-agent/desktop-input.test.ts)4项42断言核同一业务来源与读取隔离。

最后五份原完整[活动历史](isolated/unified-agent/active-view.test.ts)、[Worker关闭](isolated/unified-agent/worker-close-handoff.test.ts)、[正式可选能力](isolated/unified-agent/formal-optional-capabilities.test.ts)、[完整上下文](isolated/unified-agent/client-context.test.ts)和[Model输入](isolated/unified-agent/model-input.test.ts)分别为1/228、2/62、1/41、2/67、1/28，共7项426断言；保留205轮真实历史、真实Worker/Mach关闭、实际正式默认Shell、1MiB输入和17MiB原Model Source。安装的[CLI注册整链](isolated/unified-agent/cli-registration-lifecycle.test.ts)1项75断言、29.41秒及[跨版本终端](isolated/unified-agent/terminal-cross-version.test.ts)2项406断言、119.00秒，保留安装/回退、原数据库、冷读和所属进程退出门禁。

最后衔接回归另核派生业务 origin 与 rootWork ID/序号分离的[Fork证明](../packages/agent/test/isolated/storage/fork-readonly-sources.test.ts)22项379断言、输入/交接/热冷配置五文件26项282断言，以及Files五个直接消费者10项745断言。恢复生成新Store的历史不进入当前工作候选或待决控制；同Store冷重开仍保边界。默认回归发现的GC后空命令正文问题，由[可选来源投影](../packages/agent/test/isolated/storage/background-follow-up.test.ts)1项28断言及[Native窗口和installed维护整链](../apps/desktop/test/isolated/native-background-bundle.test.ts)1项125断言、50.72秒复验；窗口、备份恢复、真实过宽限GC、历史读取和所属清理全部保持。

[完整soak测试](isolated/unified-agent/unified-soak.test.ts)48项167断言、54.22秒通过，缺少完整formal资格时qualification preflight仍为blocked、报告为inconclusive，不提升发布资格。[continuous契约](isolated/unified-agent/unified-soak-continuous.test.ts)5项49断言与[源码外默认Shell](isolated/unified-agent/unified-default-shell-continuous.test.ts)1项25断言均通过；后者保20Session×2cycle、两Service、40次Files效果/child调用/Shell，实际busy并集62168ms、整例74.69秒，原180秒和冷读零重放门禁保持。后续独立工作夹具明确真实意图，并从公开回执读取准确业务Run；原审批、压缩、配置漂移、错误拒绝及Provider计数断言保留，未放宽生产准入。

完成条件与输入检查点另以[completion刷新](../packages/agent/test/isolated/execution/completion-refresh.test.ts)12项131断言，以及[输入检查点](../packages/agent/test/isolated/execution/input-checkpoints.test.ts)、[Tool派发准入](../packages/agent/test/isolated/execution/tool-dispatch-admission.test.ts)、[Model输入检查器](../packages/agent/test/isolated/model-input/inspector.test.ts)合17项180断言核准确public→business steer与消息来源；同Run、原Model次数、旧指令零派发、原request/hash及冷读门禁保持。[默认嵌套MCP](../apps/service/test/isolated/mcp-source-default-child.test.ts)3项246断言，父/子/孙各3次Provider、7张独立审批、一次效果；两层普通spawn同批显式事件等待后，准确原active Run接纳唯一完整Source，实际prepared input核原sourceId一次，不以事件摘要代证。

[Rewind自动校验整文件](../packages/agent/test/isolated/business/automatic-validation.test.ts)15项112断言、6.21秒，公开原文与raw准确关联新的业务Run和唯一Model Source；原验证历史仍可读，fresh Run无旧mutation义务，原检查读取次数与3次Model保持，原5秒等待未改。

后续原完整[权限授权](../packages/agent/test/isolated/execution/permission-grants.test.ts)、[义务与配置](../packages/agent/test/isolated/execution/requirements.test.ts)、[writer取消](../packages/agent/test/isolated/execution/cancel-writer-wait.test.ts)合34项560断言，[Job准确恢复](../packages/agent/test/isolated/recovery/job-reconcile-runtime.test.ts)与[组SIGKILL恢复](../packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts)合34项677断言通过。原新工作明确独立意图并核actual business/Model Source，原digest/跨Session/硬拒绝/CAS、writer旧cancel重放、Job结果/revision/效果一次、孙Agent存活/generation和原配置释放顺序保持。[生命周期整文件](../packages/agent/test/isolated/execution/lifecycle.test.ts)14项111断言、1.22秒，观察者关闭屏障位于真实业务决定事务；原Tool完成一次，A在安全边界deferred、B由存活owner完成，准确2次Model且观察者Model0，不向已收束A追加旧第三次Model。两个[after-turn](../packages/agent/test/isolated/business/task/after-turn.test.ts)/[嵌套after-turn](../packages/agent/test/isolated/business/task/nested-after-turn.test.ts)原整文件分别12项276断言、5项106断言，保原报告先后、授权、Source和Provider次数。

显式Include复用已有automatic Source的[Store整文件](../packages/agent/test/isolated/context/store.test.ts)13项230断言、1.56秒，连同active/Fork/original-selection/restored-origin原整文件合26项469断言。先取得真实红，再验证100k完整结果、旧upper不倒灌、真实active checkpoint与旧审批卡失效/完整配对、queued取消、应用后取消保历史、cold/retry零效果、原Source行和自动接纳不改签；原同工作Rewind/config fence不放松。[完整分页Runtime](../packages/agent/test/isolated/context/selection-runtime.test.ts)1项440断言、1.88秒，101精确公开Include均复用原ID，独立新工作第三Model读全部101来源，第二Rewind后的第四Model全部排除；201Tools、101Job ledger和原body/hash不变。后续context/freshness/checkpoint/opaque输出五文件合17项660断言，业务来源、原Provider时序和完整continuation隐私均保持。

Core冷绑定五份[完整Model正文](../packages/agent/test/isolated/model-body/model-body.test.ts)、[完整操作输出](../packages/agent/test/isolated/extensions/operation-output.test.ts)、[上下文贡献](../packages/agent/test/isolated/extensions/context-contributions.test.ts)、[Run绑定](../packages/agent/test/isolated/extensions/run-bindings.test.ts)和[child绑定](../packages/agent/test/isolated/child/bindings.test.ts)合31项693断言通过，核准确public/raw/business/Model Source，原17MiB正文、完整Job输出、目录、配置释放和效果预算保持。child中的真实ask_user审核回退只保准确审核引用；删去人工证明的最终Store CAS仍拒绝且cursor不变，完整证明只派发一次。原[审核](../packages/agent/test/isolated/execution/authorization-check.test.ts)、[实时模式](../packages/agent/test/isolated/execution/live-permission-mode.test.ts)、[父子模式](../packages/agent/test/isolated/execution/mode-collaboration.test.ts)和[真实审批SIGKILL](../packages/agent/test/isolated/recovery/live-approval-crash.test.ts)四整文件另合28项262断言。

Service的[work cancellation](../apps/service/test/isolated/work-cancellation.test.ts)、[HTTP](../apps/service/test/isolated/http.test.ts)、[multi Service](../apps/service/test/isolated/multi-service.test.ts)和[paired](../apps/service/test/isolated/paired.test.ts)原四整文件合19项360断言；首个多Service等待点位于A首笔真实效果提交后，B仍不接管owner且等待期间Provider为零，原两次效果与时限保持。paired仍核EOF只取消A、B存活、两ledger、原三个Run及冷读/隐私。[pending inputs](../apps/service/test/isolated/pending-inputs.test.ts)另1项31断言，公开follow-up原文与实际steer分别保存，按真正业务ID分页并在原Run准确应用；[caller proof](../apps/service/test/isolated/caller-command-proof.test.ts)另1项62断言，完整Unicode/CRLF正文、五类公开命令摘要、单Run/单Provider与GET零写入保持。[六工具整文件](../packages/agent/test/isolated/business/task/collaboration-surface.test.ts)6项97断言、1.474秒；仅隔离SQL故障连接采用正式引擎已有1000ms busy_timeout，原默认并发、测试总时限与故障断言保持。

[Native Shell实际制品整链](../apps/desktop/test/isolated/native-shell-lifecycle-bundle.test.ts)1项831断言、40.82秒通过，含真实进程树、准确停止、Main与Service两次SIGKILL、完整Unicode输出、冷只读及lease/卸载清理。夹具保完整输入正文并使用独立稳定marker生成合法Tool call ID；原失败的业务Run已completed但非法ID使Native读取不可用，SQL/trace事实保留，生产schema与Source未改。

Service六份默认权限/Task/Skill/嵌套/压缩配置原整文件合29项527断言通过，后续真实输入核公开请求、raw、业务Run和完整Model Source，原审批、效果和预算保持。真正runless桥仅登记可信角色carrier/显式Model，缺父工具目录仍零Provider；[Skill整文件](../apps/service/test/isolated/skill-selection.test.ts)6项130断言、2.61秒，核根零Run、真实后代、十类实际SQL篡改拒绝与readonly冷重开cursor不变，零新增Provider/凭据。[MCP派生整文件](../apps/service/test/isolated/mcp-source-delegated.test.ts)6项58断言、2.66秒，显式空选择保持readSet:null/零新连接/零效果，精确封存父血缘，父raw字节破坏后空孙仍不增加Provider/凭据/RPC；非空来源继续原scope/read-set。连同[默认MCP child](../apps/service/test/isolated/mcp-source-default-child.test.ts)3项246断言、5.87秒及child/default-role/Source配置/replacement原整文件，此六文件共50项651断言，保原模式、范围、来源撤权和预算。

原[macOS Host Shell 整文件](../packages/agent/test/isolated/jobs/macos-host-shell.test.ts)12项223断言、6.56秒；登记已移除场景沿正式引擎已有2秒界限等待准确launchctl print code113，再调用原清理函数，bootout成功本身仍不证明登记或全树已停止。原10秒总时限、真实进程树、范围、EOF/SIGKILL及清理断言保持，生产源码未改。

原[绝对路径Files整文件](../packages/agent/test/isolated/files/path-files.test.ts)9项125断言、760ms，原Windows专例本机skip。真实红保原5秒预算，第二条read公开回执为unresolved、无业务Command、无工具解释已结束；夹具明确独立工作后核public/raw/准确业务follow-up载体、新Run与成功Model Source。原Full/人工批准/拒绝、绝对目标、四次Model、超过1MiB完整BOM/CRLF/hash/Artifact/实际Model正文和全部原时限保持，生产源码未改。

原[审核continuation/Inspector整文件](../packages/agent/test/isolated/execution/authorization-check-continuation.test.ts)4项363断言、1.273秒。普通纯JSON不加新任务前缀，真实raw封存unresolved、业务ID为null、一个零Tool的只读处理Run完成后，原Inspector请求、逐字JSON和continuation标记断言保持；不把业务wait当只读就绪。其余private/semantic大正文、实际审核证明、冷重开/备份恢复和SQL篡改反例及原5秒预算全部保持，生产源码未改。

[标题整文件](../packages/agent/test/isolated/execution/session-title-generation.test.ts)31项246断言、14.18秒通过；原23项166断言保完整Unicode/空白原文、普通Model次数、10秒准确取消与恢复点，由真实Store先准入业务再Runtime执行。真实public的待澄清、Model不可用和全空白另核受限sessionInputMetadata本地兜底，零业务/标题AI，重试和cold零追加写入；派生业务核原public/raw/decision/business链后只命名一次。保留注册锚点位于全局裁剪之后仍可命名，锚点丢失保守拒绝；三类伪造调用零写入，手改为同一兜底仍挡AI覆盖。原source-free [MCP PTY](../apps/cli/test/isolated/tui-mcp-pty.test.ts)1项26断言、8.62秒通过，保80×24、4业务Provider/2审核、零RPC、全部UI步骤、完整待审批历史/私有草稿、唯一效果、冷读与清理。

真实默认Host [HTTP标题整文件](../apps/service/test/isolated/session-title.test.ts)5项82断言、1.150秒，原default/custom两正例保大正文、模型选择/参数、各2Provider；custom精确deny保permission_denied、业务完成和1Provider，quoted待澄清/Model不可用首原文保本地兜底、零业务AI、唯一rename、重试及cold零追加。原生命周期、子结果交付、输入意图、控制及真实工作五整文件另30项444断言通过。

纯JSON Inspector的unresolved决定与解释Run终态分别核对；在原5秒内等待准确receipt.observation.runId结束，原[审核continuation整文件](../packages/agent/test/isolated/execution/authorization-check-continuation.test.ts)4项363断言、1.411秒通过，原JSON、单Model/零Tool、准确Source与完整Inspector断言均保留。

原[共享管理整文件](../apps/cli/test/isolated/shared-management.test.ts)7项73断言、3.25秒，首份独立held工作明确New task，核public回执、实际业务Run、entered Tool归属和单Model；原5秒及全部管理CRUD/Fork/Compress/Include/丢回应/准确取消/shared peer/paired资产零读断言保持，未改生产准入。

历史负载限制：第26轮原默认32槽在180次正文成功后有一次getModelOutput返回network_outcome_unknown，当时SDK包装未保留底层cause。后续只在隔离夹具观察原fetch/Response/reader/EOF和宿主生命周期，不增加请求、补读、重试或运输Source修复；原整文件及第27–38轮默认三档均未复现。即使最终同次完整默认全过，也只能证明当前组合通过，不能声称ECONNRESET根因已闭合。此限制按方案验收25的“记录是否真正闭合”保留，不将历史未知写成已解决。

原[递归检查点压缩](../apps/service/test/isolated/file-checkpoint-compression.test.ts)2项190断言、4.17秒，及[Core原root/Fork来源碰撞](../packages/agent/test/isolated/storage/context-compression-history-source.test.ts)1项26断言、239ms通过。真实Store串行先准入原Command，再由原paired默认HTTP或Runtime执行，精确保留Source ID碰撞、原正文/同ID计数和bridgeAnswer边界；原9/5次Provider、两压缩、三步writer、原bytes/hash/restore/cold与10秒/5秒预算保持，无第二Runtime owner、手写SQL或生产源码变更。

原[默认Web整文件](../apps/service/test/isolated/default-web-fetch.test.ts)3项86断言、2.67秒，夹具正式绑定当前权限管理并对准确Session/Workspace持久Full与trust，核applied/revision；第二独立probe核public/raw/business/Run与真实Source、每Run两Model，原两Tool/四Provider、完整Artifact/readonly和escape零请求保持。off精确核既有硬上限的permission_denied/capability_unavailable及零派发；运行中撤权仍核真实Tool的web_network_denied和两次准确资源revision，DNS/socket均零，全部原20秒/15秒/8秒预算保持。

原[Artifact上下文](../packages/agent/test/isolated/artifacts/context.test.ts)5项96断言934ms、[串行资源](../packages/agent/test/isolated/resources/serial.test.ts)3项22断言293ms、[child结果上下文](../packages/agent/test/isolated/child/result-context.test.ts)2项64断言417ms、[Web Core](../packages/agent/test/isolated/web-fetch/core.test.ts)6项126断言6.40秒，共16项308断言通过。仅明确独立探针或原工作继续，沿实际public/raw/business/Run/Tool/Model Source核对；原effects5/Models6、两Tool/Models3、父3子2、准确Unknown/Artifact拒绝/同ID重试/serial交接/私有来源隔离/完整网络与冷读/取消及全部原预算保持，生产源码未改。

原[Native多根压力](../apps/desktop/test/isolated/native-multi-session-stream-electron.test.ts)与[driver](../apps/desktop/test/native-multi-session-stream-electron.fixture.ts)按task.spawn@1、prompt/task_name与准确Tool-parent carrier复验。Model整文件1项5条Bun断言35.11秒，16同时流/20次Provider/120导航，937次有限读取最终active0/峰值2，长任务0。原mixed模式另1项5条Bun断言47.40秒，16Model+16真实Shell重叠30.131秒/32Provider/120导航，1284次有限读取最终active0/峰值2、长任务0；两组全局observe一条，根停止16→12、单child再到11，原完整输出/停止/终态/所属清理和190秒整例/160秒driver及阶段预算保持。以上本机production renderer受控SSE证据不扩大旧历史性能或正式三平台资格。

原[Native双child窗口](../apps/desktop/test/isolated/native-child-stream-electron.test.ts)及[driver](../apps/desktop/test/native-child-stream-electron.fixture.ts)1项5条Bun断言22.21秒，按实际task.spawn@1/Tool taskName+prompt/parent carrier核两准确child Session与正文。父2次Provider、child各1次、100导航、原大正文与heap/DOM/listener/收尾保持，547次有限读取active0/峰值1，长任务0，原预算不变。

原[CLI报告恢复](../apps/cli/test/isolated/recovery-report-host.test.ts)2项28断言3.09秒、[TUI原恢复五例](../apps/cli/test/isolated/tui-recovery-host.test.ts)5项51断言13.35秒通过。仅[专用报告fixture](../apps/cli/test/fixtures/recovery-report-profile.ts)把已注册准确builtin.task/task@1显式用于内部typed Model合同，普通六工具与配置不变；初始/step/恢复同源，保原schema/版本/权限/reader Model/afterTurn apply真实屏障、SIGKILL/独立Ask/唯一准确Report Source/丢回执只查原ID/Model次数/80×24键序及全部原预算，两原测试未改。

原[Native MCP Main](../apps/desktop/test/isolated/native-mcp-main.test.ts)1项67断言942ms，原workspace_untrusted实际snapshot/controlReads/零派发已保存；隔离夹具经正式持久控制设置准确Session/Workspace的Full和trust并核applied/revision，保全部来源独立批准、credentials/wire、完整descriptor、丢回执及cold GET-only，生产权限未改。

原[TUI Planning四场景](../apps/cli/test/isolated/tui-planning-host.test.ts)4项152断言43.77秒，active-queued仅明确原独立计划意图，核public/raw/decision/business/新rootWork及原plan extensionInputs；保原父安全边界收束与两次Model、80×24/完整Plan Artifact/审批前拒写/唯一写入/7与6 Provider/批准丢回应两次cold原GET/草稿隔离及全部原预算。原红与当前绿分别保留，未改生产源码。

原[CLI host](../apps/cli/test/isolated/host.test.ts)2项60断言5.47秒、[Skill host](../apps/cli/test/isolated/host-skills.test.ts)7项85断言6.69秒、[模型PTY](../apps/cli/test/isolated/tui-models-host.test.ts)3项73断言12.15秒、[权限PTY](../apps/cli/test/isolated/tui-permissions-host.test.ts)1项40断言15.57秒、[101轮管理](../apps/cli/test/isolated/session-context-management.test.ts)1项335断言5.77秒通过。夹具明确原同工作/独立意图，逐条核public/raw/decision/business/Run和真实Model Source；17MiB正文、独立Skill快照、原2+1及4+1业务/标题Provider、模型2POST1GET、权限7业务+3审核/两效果两答案/grant2→0/准确业务取消、101业务+1压缩/202消息/分页Fork/Rewind/reset/delete/丢回执及全部原预算保持。两个PTY只读证明用deny-all Runtime，水位不变，不修改实际Service权限。

[Service 嵌套配置](../apps/service/test/isolated/after-turn-nested-configuration.test.ts)沿原公共输入实际 Run 核 Tool/carrier/Source、权限与 funding deadline。原 pending 判定准备竞态及 29 项运行记录随机制退役；当前普通输入不创建 public/raw/decision/business 链，旧 scope/digest/取消证明继续由 SQL 历史兼容维护。

原[真实Run恢复整文件](../packages/agent/test/isolated/recovery/run-resume-runtime.test.ts)35项478断言7.54秒通过。仅follow_up的第二次准确A配置准备在资源分配前用屏障与原Run恢复分开：原resolve/dispose=1及同IDresume幂等不变；随后核同一原Command全文/digest/原Run配置的continuation，真实business Run/rootWork/User Source及两份资源各释放一次。原29模式+6streak、Model ledger和效果计数、5秒until/原总预算保持，生产恢复逻辑未改。

原[状态宿主](../apps/cli/test/isolated/status-host.test.ts)2项139断言3.70秒、[共享argv](../apps/cli/test/isolated/shared-cli.test.ts)5项139断言2.88秒，以及[完整caller宿主](../apps/cli/test/isolated/cli-caller-host.test.ts)3项100断言17.71秒通过。前两文件明确原独立hold与同工作继续，核public/raw/decision/business/Run/Model Source及held Tool归属；只读零效果、peer保持、超过84KiB正文、detach/cancel与原预算保持。caller末例完整Unicode/combining/CRLF正文明确New task，核完整JSON/body SHA/requestDigest与实际业务Source；两个原物理POST丢回执/SIGKILL/冷GET例、3次Provider/审批/效果一次及原300秒预算保持。

Native journal五项新增身份/派生业务/观察/旧steer回归在旧Source为3失败2通过；修复后连同原Native caller、DesktopInput与共享reader三文件43项438断言870ms通过。真实[Node journal整文件](../apps/desktop/test/isolated/native-caller-journal-host.test.ts)六项154断言12.63秒通过：原五种物理POST/首GET丢失和SIGKILL不变，新增已完成seed后的独立工作核真实public/raw/decision/business/Run/成功ModelInput，冷GET丢一次后两次applied查回保持完整原请求/摘要/主体，只有一次原POST，恢复全GET，commands/runs/executions/cursor/ledger/Provider逐值不变。journal仍先核原public scope/digest/Workspace，保旧技术steer target/selection、cancel、extension执行及冷零POST，processing observation不投影为业务。

原[Native跨版本主场景](isolated/unified-agent/native-cross-version.test.ts)主场景定向1项1435条Bun断言、156.58s通过；第37轮后的冻结诊断又执行原完整文件，两场景共2项1501条Bun断言、255.15秒通过，包含独立legacy拒绝；最终原始默认结果见本节末。B明确New task并保完整352041字节正文；真实SQL核public/raw决定/business/Run/rootWork与成功Model Source，正式Native lookupInput核同原ID并由原ModelInput reader读完整来源。原A/回退A、三个业务Provider、旧数据完整bytes/hash/inode、四暖窗口/两DB9冷窗口、安装备份/回退/卸载、全部退出/双lease与420/120/60/15秒预算保持。原裸B真实unresolved与业务完成后的caller_receipt_unavailable均保留红证据；后者确证Native journal仍按公开ID核Run.origin，已仅复用共享精确业务查回器修复。

原[源码外Native MCP整窗口](../apps/desktop/test/isolated/native-mcp-bundle.test.ts)1项29条Bun断言37.84秒通过。第35轮红证据表明原卡rev1的唯一答案已applied/rev2、Tool已成功且效果一次，夹具却再次click旧pending快照中的disabled/detached卡；现仅按Store/presentation Session/Interaction ID/revision排除已提交原卡，新revision仍独立操作，unknown不新答。真实正式lookupInteraction查原答案Command，准确Run两成功Model/一成功Tool，双Main退出后SQL再核同卡同原revision唯一答案、原digest/receipt/decisionRevision和三Execution均dispatched=1。原248180字节Unicode descriptor/零新增RPC、来源两范围/独立Review、OS引用bind/revoke、refresh/reconnect/oldStop、下一Model schema、唯一效果、DB7冷GET一次/零POST、原25秒Tool/15秒click/150秒driver/整例预算与准确OS凭据和进程清理保持；生产Source未改。

原[连接Host备份恢复整文件](../apps/cli/test/isolated/tui-mcp-connection-restore.test.ts)1项48断言637ms，通过正式权限管理为准确s/w持久Full/trusted并核applied、Store原mutation ID/record/revision；custom policy上限不变。初始连接ready后才公开create/inspect/restore v16，A→B保771字节原journal/ID/digest/subject，foreign意图before-admission的GET/POST/other全零、Model/credential零、RPC2→2、cursor不变与原8秒/30秒预算保持。原红SQL仅初始Auto待批/Job零dispatch、无backups目录；并发maintenance的restore_journal_mismatch为另例预期反例，不属于本测试。生产Source未改。

原[组SIGKILL恢复整文件](../packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts)17项314断言7.01秒通过。仅group_new_descendant用真实Store固定准确raw登记→处理准备的顺序，旧count2在可控场景真实得到3先红；两准确业务Run与失效只读技术Run按完整ID集合及scope/rawdigest/public/decision/business/原来源逐条核，未宽松过滤。技术轮零或单个已登记Model分别保真实阶段；若已登记必须failed/input_proposal_unverifiable、原processingContext/工具为空，SQL dispatched0且authorization为空，原Provider/业务效果ledger/子孙/funding/资源释放和全部17场景及8秒until/20秒预算保持。第36轮原失败现场被旧cleanup删除，只保历史count；后续可控SQL与最终绿为独立证据，不冒称其原ID。生产Source未改。

第37轮原默认与随后未启动作业诊断共40个失败原whole job，集中修复后40/40复验通过，合87项测试、1543次Bun断言，原driver门禁另保。诊断仅在独立临时收集层关闭全局fail-fast，原各leaf分组/命令/新HOME/预算不变、572并发作业完全drain后串行7独占；540通过/39失败及4337冻结输入不漂移为诊断结果，不能代称默认全绿。该批只改43个既有测试/专用夹具，生产Source和runner逐SHA未变；最后完整默认另列。

Service八原整文件共13项327断言，真实Full/trust前提均经正式持久控制建立，独立Workflow和Job审批保留。nested失效处理轮只许0或1个准确failed未派发Model，并核SQL dispatched0/null authorization、原raw/digest/context及空工具；automatic等真实owner释放后完整比View。原[长任务SIGKILL](../apps/service/test/isolated/long-run-resume.test.ts)1项35断言26.60秒，4096以上真实执行/32批/来源与冷恢复不减；[Web parser清理](../apps/service/test/isolated/web-fetch-cleanup-ownership.test.ts)1项29断言1.475秒，保真实清理失败与原截止时间。

CLI/TUI十原整文件共17项262断言；[finishing输入](../apps/cli/test/isolated/tui-finishing-input-host.test.ts)核同一原afterRun下准确raw/decision/queued business与释放后的业务Run/原全文、B草稿、单POST和总两Model。[80×24协作](../packages/ui/test/isolated/tui/collaboration.test.ts)保稳定child/新Run与新审批/准确停止和原效果；专用Model夹具按实际Execution→Run→原业务Command与唯一正文/sourceIds识别真实用户输入，不误用后来抵达的低信任child结果。两个caller强杀、完整请求/冷GET、第二页原问题、文件漂移与PTY管理的原门禁保留。

MCP四原整文件共9项183断言：reconnection共享夹具持久准确Session/Workspace的Full或accept_edits与信任，ask=true仍独立批准，reopen不改原控制或journal。[cold整文件](../apps/cli/test/isolated/tui-mcp-cold.test.ts)1项39断言4.99秒；仅隔离测试制品在原Service确认退出、待测请求前，通过正式管理准备控制，核Store/subject/current revision且零Execution/凭据/admit/RPC，生产403和policy上限不变。原prepared/submitted、物理GET丢失、原POST一次、完整body与journal、跨Store零HTTP和paired存活保持。

Core七原整文件共19项463断言，四种Files与扩展/Skill拒绝probe明确独立工作，逐准确business/Run/成功Model/原Source验证，原适配器次数、大正文/基线/权限零I/O与时限不减。[17MiB child输出](../packages/agent/test/isolated/model-output/child.test.ts)1项38断言8.22秒，恢复后显式Include原carrier结果，复用原sourceId/结果revision/出处、零新增Execution，再独立工作读取完整正文；父2/child1/恢复1Model保持。

Root十一原whole共29项308条Bun断言：Native活动刷新1/17、Context1/4、完整压缩1/3、五caller恢复5/20、安装exclusive1/35、组并行恢复1/49、通知continuation7/56、Service/Client4/40、thin clients3/27、外部扩展升级1/31、默认平台诊断4/26。Native活动原Model保持派发，补充进入同Run下一Model的准确业务Source；observer/journal原受理互不阻塞。Native caller沿同一journal原GET/真实SQL核派生父业务，单项Job取消不误停兄弟；完整安装39.47秒保真实安全窗口、正常退出、原Main升级存活、冷零Provider、回退/双lease/所属kill/卸载和数据hash。独立writer1000ms有界等待与恢复finally、真实owner释放后完整冷View比较均保原fault与预算。

第38轮未经改动的原始 `bun run test` 在默认四并发下完整通过，2026-10-19 13:06:57.688813–13:30:06.027715 UTC，wall 1388.338902秒、同一Python进程monotonic 1388.309352秒。945个默认文件、748个外层作业全部启动并通过，741并发完全drain后7个exclusive严格串行各执行一次；4337非Markdown输入、mode与HEAD均无漂移。归档为 `/private/tmp/kite-collaboration-default-pass-38-20261019T130657Z.*`。原naive计数把runner自测owned临时目录中的两同名夹具start/pass混入外层，补充审计逐Source SHA、父job block、临时inventory及精确四事件白名单重新归属，验证实际外层无重复/缺失；原log与naive archive完整保留，无Source/runner/测试执行变更，独立复算一致。本轮32槽stream实际8父+24子、持续30.995秒、27批234次完整正文读取，readFailures=0；原终态、取消与drain门禁保持。8个workspace typecheck、跨包/API、格式、测试归属、计划证据和最终文档检查均通过。上述为实际本机受控测试，不宣称付费Provider、Linux/Windows原生、数周soak或项目V1.3整体退出。

## 当前公共场景与证据

Native公共扩展的[实际HTTP链](../apps/desktop/test/isolated/native-extensions-main.test.ts)、[原组件DOM](../apps/desktop/test/isolated/native-extensions-dom.test.tsx)、[真实Node维护](../packages/agent/test/isolated/maintenance/desktop-extensions.test.ts)和[安装版整窗口](../apps/desktop/test/isolated/native-extensions-bundle.test.ts)各核正式消费者的对应边界。窗口以hash前固定参考装配完成source→analyze→完整findings→原mark→新business key和冷GET，不增加默认业务；格式只在首次泛型caller保存升DB9／v18，旧grammar拒绝保持。准确结果／失败与完整回归归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)，局部通过不关闭完整PC、资源或最终退役。

[恢复交互历史](isolated/unified-agent/client-interactions.test.ts)复用原真实 Core／配对 HTTP／SDK／Native Main，保存问题、计划修改反馈、child 审批、取消和完整原附件后明确备份恢复。首次与冷只读保公开请求／答案／accepted revision／原出处，原待办按维护结果取消；默认当前列表空、旧卡回答拒绝、原 Store 准入拒绝、Fork 不补来源后来记录、附件原 metadata／完整 hash／EOF及零新水位／Model分别核对。Native Main／原 DOM和原待决分页七文件33项758断言通过。[现有 installed 问答窗口](../apps/desktop/test/isolated/native-restored-questionnaire-bundle.test.ts)只补同一原交互历史的首次／恢复／冷读与 Fork 空记录，保全部原行为断言和120／45／10秒预算；actual0／1pass／24Bun和全部driver／77.95秒。原公共 schema 选项 ID／自由文本对象与 Tool 标签回执分开核实，不把通用 Interaction 猜成默认问答的显示结果。其他 installed 计划／审批和全阶段资格不从本片推导，准确失败归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后完整交互历史)。

[恢复后已回答问答](../apps/desktop/test/isolated/native-restored-questionnaire-bundle.test.ts)复用原 Questionnaire／ToolRow，在搬迁并 installed 的默认 Native 中保存一次真实选项和完整 Unicode／换行自由文本，明确 Fork 后通过包内 CLI 备份恢复为新 Store。三个 macOS 窗口核源会话／分支的原消息、问题、答案、Execution／Run／Store、首次与冷读、切换清理与三次 Service 普通退出／双 EX；原 answer POST 一次、Provider 两次，阅读 POST 与封存来源 Run GET 为零。只读 fetch 观察保原 HTTP 回应和消费者，120秒整例／45秒driver／10秒页面期限保持。[Core 冷出处](../packages/agent/test/isolated/context/restored-origin.test.ts)、[Service 投影](../apps/service/test/message-response.test.ts)和 Main／原 DOM 核各自边界；准确输入、实际失败与未验范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后已保存问答回执)，不代证取消问答／审批的全部恢复或整阶段退出。

[恢复后封存Model正文](../apps/desktop/test/isolated/native-restored-output-bundle.test.ts)通过搬迁并installed的完整Native候选、默认Main／Service／preload和原UI生成一次大回复及明确Fork，退出后用包内CLI备份恢复为新Store。三个真实macOS窗口核108031字节原内容／SHA／CRLF／出处、恢复首次与冷读、关闭／切会话清正文、原source复制资格与三Service普通退出／双EX释放；读取阶段零业务POST、Provider总数1。只读fetch观察不改请求／响应；120秒整例、45秒driver和10秒页面期限保持。Service投影、Main原Model资格与共享组件由[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后封存-model-正文)记录，未验组合不从本片推导。

[退出收尾](../apps/desktop/test/quit-settlement.test.ts)核后台单次清理、同步／异步失败及未完成时没有计时器或提前结算；[caller 检查](../apps/desktop/test/native-caller.test.ts)核完整目录／View 的所属 signal、超时未知和零业务写入。[macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)保全部原任务／冷读／双锁断言，随后用同一不可变源码外候选运行[退出 driver](../apps/desktop/test/native-quit-electron.fixture.ts)：实际关闭与 activate 保草稿，所属 Service SIGSTOP 后两秒到未知确认，取消后继续；再次确认后一秒内销毁全部窗口、关闭 renderer 并隐藏 Dock，重复退出或激活不增加提示或复活界面。原 Main／Service 与双锁在后台保持超过20.5秒，SIGCONT 后才自然退出0／双 EX 可取／零 Model 重放；实际 SIGKILL 另核窗口销毁、非零退出且没有清理警告。2026-10-22 当前完整原文件在 macOS 通过1项／42条Bun断言及全部driver断言，wall64.27秒，退出driver29.16秒。生产候选／Service 字节保持，dialog callback 不代证 OS 窗口点击；原120秒整例、各45秒driver与10秒页面预算保持。原警告流程历史结果归[进度证据](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原窗口关闭与退出收尾)；当前[有限 Main 宿主](../apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts)与 helper 共32项／340条断言／2.13秒通过，核开启中／重载时界面先关闭、后台完成后退出、取消恢复、外部停止与迟到 ready 不建窗口。

同次补跑[计划审批整窗口](../apps/desktop/test/isolated/native-plan-review-bundle.test.ts)在首次退出前的 `toolApproval` 断言失败：实际1项而预期0项，尚未到退出确认，未取得该完整整例通过。两文件同一Bun进程顺序运行时，前例删掉其进程级SQLite引擎资产还导致后一例 `sqlite_engine_asset_unavailable`；退出专项因此独立进程运行，不把此调度错误当生产回归通过，也不修改计划审批断言。

原[窗口 IPC](../apps/desktop/test/native-window-ipc.test.ts)核文本原文、1 MiB UTF-8 边界、闭合 payload、准确 frame 和零业务 caller；[实际 Native header DOM](../apps/desktop/test/isolated/native-window-actions-dom.test.tsx)核左键／双击／控件过滤、双栏回调、失败提示与草稿保持，原轮次 DOM 保完整正文复制门禁。原[源码外 macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)使用实际 Main 系统剪贴板核首次／冷读正文，浏览器 fallback 明确抛错；[JXA 保护进程](../apps/desktop/test/native-clipboard-guard.fixture.jxa)在内存保留原剪贴板各格式，stdin EOF 时恢复，不向日志或文件导出内容。header DOM 回调核实际 BrowserWindow 的 maximize／unmaximize，不代证物理双击或拖拽；保原任务、审批、冷读、双锁收尾与 120／45／10 秒预算。准确结果与未验范围归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原消息复制与标题栏缩放)。

Main 的 Git／编辑器 launcher [所属进程整例](../apps/desktop/test/isolated/native-processes.test.ts)在实际 Node 中运行同一 owner 和 Caller，核原 ChildProcess close、双 EOF、准确原 handle、关闭后禁止准入、首个 error／timeout 只在实际 close 后结算；实际 Git／editor leaf 的调用参数继续保15秒／10秒。编辑器仅替换为本任务隔离 Node child，未操作个人应用，不代证真实编辑器窗口。原[首次发送真实 Git](../apps/desktop/test/native-conversation.test.ts)、[文件入口](../apps/desktop/test/native-file-changes.test.ts)和上述源码外完整窗口分别核业务、目标／frame以及默认 Main 关闭与 lease 顺序；本轮不增加已闭合窗口的故障矩阵或放宽预算。实际执行与保留限制归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10native-普通用户操作的所属-helper-收尾)。

原四项[主题 DOM](../apps/desktop/test/isolated/native-theme-dom.test.tsx)迁至当前 Native Hook，保全部原断言；[主题 IPC](../apps/desktop/test/native-theme-ipc.test.ts)核三档、闭合输入、当前主 frame、销毁窗口和 Service 连接失败时仍不打开业务 caller。原[默认源码外 macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)操作原菜单，核真实 nativeTheme、窗口／页面底色、引擎变化和冷启动偏好。Playwright 默认浅色媒体覆盖须通过 `emulateMedia({colorScheme:null})` 取消；保颜色一致、10秒 UI、45秒driver和全部原业务断言。引擎信号不冒称真实 OS 设置切换，高速人工拉伸与完整视觉资格仍未由本测试证明。准确输入、原失败与结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原主题与窗口背景联动)。

原两项[诊断保存测试](../apps/desktop/test/startup-report.test.ts)和保存函数迁入新 owner，[闭合 codec](../apps/service/test/startup-diagnostic.test.ts)、[真实 paired](../apps/service/test/isolated/paired.test.ts)、[host IPC](../apps/desktop/test/native-startup-ipc.test.ts)与[启动 DOM](../apps/desktop/test/isolated/native-startup-dom.test.tsx)核各自边界。原源码外 macOS 整窗口保原任务／冷读／退出断言后，同一不可变候选运行[诊断 driver](../apps/desktop/test/native-startup-diagnostic-electron.fixture.ts)：真实坏 Store→原启动保存按钮→取消零写／已有文件不覆盖／新私有闭合 JSON→外部修复后同窗明确重试→零 Model及双锁收尾；仅 dialog 选路径 callback 被控制，不代证 OS 人工点击或全部存储故障分类。原整例120秒、页面10秒与其他driver预算保持，新增driver20秒；准确输入、真实失败与实际结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动诊断保存与明确重试)。

原[启动 DOM](../apps/desktop/test/isolated/native-startup-dom.test.tsx)使用实际 NativeDesktop 与原共享 UI，核 attach／完整目录等待、未核实目录、空项目／无模型进入、初始化失败后一次明确重试、旧代次隔离及进入后断线保原草稿，有限 bridge 不代证实际服务故障。原[默认源码外 macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)核启动 CSS 打包、首次与冷启动完成后进入页面，原任务／审批／业务／双锁退出断言及期限保持，不直接验证短暂启动页或真实初始化故障。准确输入、实际执行结果和未验范围归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动页与初始化重试)。

原[问卷整窗口](../apps/desktop/test/isolated/native-questionnaire-bundle.test.ts)用加载前的[只读阶段观察](../apps/desktop/test/native-startup-observation.fixture.ts)定位真实首次启动失败：透明记录原 IPC、制品／私有 lease 子进程和四种原 GET 的阶段，容量 128 并显式记录 overflow，GET 结束仅代表 headers。原请求／结果、六个准备调用及 10／45／120 秒期限保持；只有失败才读取记录并保留自有资料，进程与 lease 仍按原路径清理。控件超时、原 state 请求和采样完成分别计时。[正式 Terminal 原完整文件](isolated/unified-agent/formal-terminal-entrypoints.test.ts)只记录现有构建／入口／复核／stop 阶段，保原 71 处 expect、20 个操作及 60 秒整例。实际失败和完整结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)，阶段观察不另列为产品能力。

[原长历史整窗口](../apps/desktop/test/isolated/native-history-electron.test.ts)沿完成轮次的真实展开入口读取全部 5051 条正文，重命名后按准确新标题切回；原 36 条 driver 断言、六处 parent matcher 及 10／75／90 秒期限保持。有限阶段记录透明保留原 stdout；Main 与后代仅在真实 kernel birth、当前 PPID 和所属 argv 一致时登记。失败时先安全收束已绑定进程再等 EOF，退出过渡仅在原父预算内核验；未知身份仍失败并保留自有目录，成功退出后的遗留进程也不能被强制清理改写为成功。原业务结果及完整回归仍按[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)判定，阶段和清理观察不另列为用户能力。

同类[完整 Model](../apps/desktop/test/isolated/native-model-output-electron.test.ts)与[Fork](../apps/desktop/test/isolated/native-sessions-electron.test.ts)窗口复用 Desktop 私有[进程 owner](../apps/desktop/test/native-owned-processes.fixture.ts)，保原业务断言和时间预算；未知身份、正常残留及失败保留规则归 [Desktop owner](../apps/desktop/README.md)。有限 phase 只服务原失败定位及准确进程捕获，不另列用户能力；临时 IPC／DOM 定位观察已退役，原红、实际复验与完整默认结论归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

[原依赖复制文件](isolated/unified-agent/terminal-dependencies.test.ts)保留原多版本／peer／alias／循环／平台及实际 native bytes 断言，新增已内联普通依赖在原包与构建源缺失、实际搬迁后仍能运行生成 export 的验证；其他 external与peer按原物理图解析，未知／重复／peer／workspace内联声明拒绝。正式候选仍由原 builder与全部 inventory产生；此局部证据不替代原普通启动窗口或完整默认回归。

原Composer的[缓存指标DOM](../apps/desktop/test/isolated/native-cache-metrics-dom.test.tsx)核实际样本累计、封存副本去重、32项批次、历史未完整时隐藏、无样本与真实0%的区别、迟到会话隔离和失败后显式只读重试。[Main来源测试](../apps/desktop/test/native-tool-messages.test.ts)核不可变Model用量、来源／恢复终态、无缓存字段和原消息变化拒绝；原[默认源码外macOS窗口](../apps/desktop/test/isolated/native-bundle.test.ts)在原三次实际SDK请求中记录200／400缓存token，核首次50%、切无样本会话隐藏、返回与冷读50%，Provider不增长。完整driver、退出／双锁／原期限保持；准确运行版本和结果见[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原输入区累计缓存命中率)，DOM不代证实际SDK或平台资格。

复用原桌面页面的 [UI 展示断言](../packages/ui/test/desktop-page.test.tsx)与 Native 目录/草稿/问卷/计划 DOM 核新宿主适配；真实 CSS、字体、输入操作及源码外闭包分别沿 [Native 候选](../apps/desktop/test/isolated/native-bundle.test.ts)和[设置与刷新窗口](../apps/desktop/test/isolated/native-electron.test.ts)核验，不由 DOM 结果推导完整产品视觉资格。[边界测试](isolated/scripts/unified-agent-boundary.test.ts)另核声明的 CSS 真实导出、缺失/越界/旧目标拒绝，以及显式 UI builder 的宿主 I/O 与 source 的便携限制。运行范围、原失败和剩余页面迁移归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)。
原 PC 工具行的 [Main metadata／有限 IPC](../apps/desktop/test/native-tool-messages.test.ts)、[正式 caller](../apps/desktop/test/native-caller.test.ts)与[工具 DOM](../apps/desktop/test/isolated/native-tool-messages-dom.test.tsx)核准确原结果、>200历史、未知同名版本、所属GET释放和原结果展开；原 [源码外 Native](../apps/desktop/test/isolated/native-bundle.test.ts)另核活动工具、真实 Files read3失败及正常／冷读，保原完整预算与退出断言。实际执行与剩余PC边界归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原工具过程与结果阅读)。

原轮次的 [Conversation DOM](../apps/desktop/test/isolated/native-transcript-dom.test.tsx)核过程折叠／重开、连续探索分组、逐项文件 callback、准确复制、问答标签和信息取消；全文复制案例仅提供 UI snapshot fixture，真实身份／hash／EOF 门禁仍归原 Native reader。Main／正式 caller 另核已观察 Message 的有界 Run GET、封存边界、恢复终态保出处及 foreign active 拒绝、普通刷新和所属 close。原 macOS 源码外窗口核首次／冷读的原折叠、展开及准确最终正文复制；clipboard 写入只由所属测试窗口的替身接收，原断言／期限／退出资格保持。实际执行与未闭合范围归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原轮次阅读聚合与问答回执)。


[默认 macOS host Shell](../packages/agent/test/isolated/jobs/macos-host-shell.test.ts)核真实宿主/fork/setsid、Full/Workspace写、保护根/准确祖先、网络、父退出及注册清理；[源码外默认消费者](isolated/unified-agent/formal-optional-capabilities.test.ts)与[平台报告](isolated/unified-agent/unified-platform.test.ts)核普通默认Provider/Job和cold输出零重放。[默认 continuous](isolated/unified-agent/unified-default-shell-continuous.test.ts)现接Mac v2／Linux v3，保原两cycle40Command、25项断言及180秒预算，同一source-free候选两Service、20Session、Files／普通child实际完成等待／detached Shell与cold完整原reference／result／output／Command／cursor及Provider零重放。当前六工具路径由spawn_agent后wait_agent_events核准确child成功终态，不重新开放legacy required参数；原内部required义务另由Agent回归负责。Mac保原coalition／broker退出条件；Linux保存原ready reference和terminal namespace证明，核完整原出生／父子／localPid连续、实际wait0／raw0、wrapper exit0／reap／close、双EOF及全部原FD关闭，inode允许重用。两个Service资源收据分别v1／v2，缺RSS、身份漂移或仍存活均拒绝；Linux[纯continuous契约](isolated/unified-agent/unified-soak-continuous.test.ts)及[资源契约](isolated/unified-agent/unified-soak-service-resources.test.ts)不代Linux真实syscall。原450秒formal组件仍沿[固定producer](fixtures/unified-agent/soak/continuous-default-shell.ts)，两Service／Job有限证据不代九点／全Runtime；busy取并集，不加构建或空闲。Win/Linux实机验证依用户选择重构完成后交给GitHub Actions，平台skip不计原生通过；准确本机红绿归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10linux-持续普通任务的正式调用者迁移)。

[Profile Workflow 原来源 leaf](../packages/agent/test/isolated/business/skill-workflow-host-verifier.test.ts)核真实 macOS Workspace／Full 的原 cwd、相对依赖及忽略资源读取、来源只读、私有兄弟／coordination／祖先列表／native exec-map 拒绝、漂移零启动及取消／超时完整 coalition。所属[正式 Service 整例](../apps/service/test/isolated/skill-workflow-profile-host.test.ts)沿真实 Runtime／SQLite／Skill 激活、独立 Tool／Job 审批、原 verify proof、效果一次和 drain 后 cold 原完整结果全等零重放；Linux 分支编译准确生产 init 并要求真实 Bubblewrap，缺依赖或实际失败不跳过。Linux 纯准备／协议仅核源码交接，本机 macOS 不取得 Linux 内核或 installed 全客户端资格。准确输入、实际执行和保留失败归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10profile-workflow-原来源与正式-verifier-迁移)。

原[Service Shell 整文件](../apps/service/test/isolated/shell-configuration.test.ts)的 exact-stop 例在真实 Model 发出 stop 前，沿原 Store／Execution／有效 guardian reference 观察实际持久 stdout `ready`；它验证已启动 guardian 的停止证明。原119个 `expect` 调用有序逐字保持、15秒整例／8秒等待不变，其他例没有该回调，生产 startup cancel／unknown 合同未改。原 dispatching 时 stop 的真实红与完整文件复验保留于上述进度。

[Profile MCP 恢复](isolated/unified-agent/profile-mcp-restore.test.ts)沿原 isolated共享槽，使用公开 builder/install与默认 Service，删除原 candidate后通过实际 installed CLI create/inspect/restore A→B，公开 Client核原 C/E、Core Question原行、当前来源准入、新 Question和显式 owned stdio连接／停止；冷 GET-only／cursor保持，Model0，原项目文件／配置／opaque refs保持。credential transport未派发，不证明 OS Vault／OAuth。对应[raw资产](../packages/agent/test/isolated/maintenance/mcp-configuration.test.ts)和[实际 Node DB7](../packages/agent/test/isolated/maintenance/desktop-mcp.test.ts)分别核 private/proof/absent／旧白名单及 v15/v16真实物理恢复；旧无 MCP文件的来源变更PTY仍为 v12。完整默认与有限结果单列于当前进度。

该原恢复整例另核 stdio broker／launchd guardian／server 的原Job六字段绑定、实际PPID和微秒出生，原 progress／terminal保存准确三种角色与coalition树证明。只有broker／server记录实际父方exit／reap；launchd guardian的exit保null，准确清理后核kernel absence。源码外整例保原一次Tool／取消／维护A→B／cold完整结果、输出和零重放；installed原恢复整例保Service退出／cold GET／cursor及Provider0。[原stdio整文件](../packages/agent/test/isolated/mcp/stdio-port.test.ts)保原7cases和期限，唯一自然exit例增加真实setsid／reparented grandchild，认证前broker强杀检验本次未启动注册清理；不新建故障矩阵。共享helper另复验原完整macOS宿主Shell，保held-root合同。旧v1冷JSON语义保留，MCP完整所属树仍不能充作全部Runtime后代或资源增长资格；实际记录归[MCP owner](../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)及[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-完整所属进程树与旧组路径退役)。

通用 Agent V1.3 的当前切片通过 `bun run test:unified-agent` 验证：新包 owner、真实 HTTP/SSE 与双 Service、外部计数工具/mini-review、[两真实进程](isolated/unified-agent/persistence.test.ts)、取消、来源刷新、显式恢复与[目标依赖边界](isolated/scripts/unified-agent-boundary.test.ts)。runner 复用默认 isolated/exclusive 分类，编译与强杀场景按逐文件隔离运行。新 `ai/agent/client/ui` 与 `apps/service/cli/desktop/web` 已纳入默认发现和 build/typecheck，根正式/default/CI已选择新闭包，原客户端测试仅作历史参考；完整能力替代与平台仍待验收。平台、完整交互、维护恢复与制品结果按[进度](../docs/plans/unified-agent-refactor-v1-progress.md)记录，部分子场景不代表完整 T/E 场景通过。

[未见 label-station 样本](isolated/unified-agent/evolution-unseen-sample.test.ts)由独立 owner 在公共接口固定后选择并实现，只有独立 manifest、资源、实现和测试。实际 manifest 构建到源外，以公共包消费真实通用 DOM 卡片→Client HTTP→无模型 Action→受控 Tool→自有 CAS 回执→Query→第二次明确操作；先等原 Execution 终态核 Action/Tool 两种拒绝零效果，两次允许效果与原 parent/rootWork 绑定，Model/Run为零。六文件 diff 和12个核心/公开基线 hash 未变支持本机有限 E01/E02/E03/E14，完整 Evolution Record 与未验证范围保留在[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-04mcp-冷原申请备份-v8-与未见扩展样本)。此处不是全部核心冻结、独立 npm 安装、实际浏览器布局或全部 E01–E14 通过；异常初始化/cleanup 由20秒所属 child kill/await 与临时根清理兜底，绿色运行不证明所有异常路径逐资源 close。

[并行工具整文件](../packages/agent/test/isolated/execution/parallel-tools.test.ts)用真实 Runtime/SQLite 核 T048：第二项先完成、物理历史保持实际顺序、下一 Model 保原调用顺序与完整结果；拒绝时等已开始工具清理，独立后发 SQL 保存错误不能被首个未知结果覆盖。[并行检查点接续](../packages/agent/test/isolated/recovery/parallel-resume-runtime.test.ts)核原 PID/出生/PPID 后真实 SIGKILL，前项原 Ask/planned、后项完整 success；明确接续只执行原前项一次，保原审批和当前权限，后项零重放，正常关闭后冷记录全等。两文件保持默认5秒，不构造新的长期故障矩阵。

原 [201 Tool/101 detached Job](../packages/agent/test/isolated/context/selection-runtime.test.ts)整例保持全部输入、结果来源、selection/rewind、冷读零重放及原期限。[Store 背压](../packages/agent/test/isolated/storage/backpressure.test.ts)核真实 Worker 的原条数/完整 frame 字节上限、控制预留、普通请求公平进度、等待后 owner 复核、关闭排空、投递/Worker失败清理与零自动重试；[唤醒容量](../packages/agent/test/isolated/execution/change-waits.test.ts)保持最多64个活动登记，额外调用 FIFO 等待，原绝对timer不在准入重建，准确abort/close、单200事件页与expired wake保持。原 [Worker 硬门禁](../packages/agent/test/isolated/storage/queue.test.ts)仍直接拒绝超限入队。这些只核相应基础设施边界，生产者等待人口不授整个 Runtime RSS/资源资格。

原[必要义务整文件](../packages/agent/test/isolated/execution/requirements.test.ts)验证登记后的同 Model 决策仍受当前准入限制；该 case 的登记/证据与 dependent effect 现在明确声明同一 Session serial key。精确 Store 转发时序证实原无资源版本 effect 在 registration 提交前已合法派发，不能将它报告为漏读已登记义务；原全部断言、期限和生产最终 refs/SQL 门禁保持，三份并行/义务完整文件13pass/259assert。完整默认原失败及重新冻结的当前回归分别归本轮进度。

原[业务来源整文件](../packages/agent/test/isolated/extensions/context-contributions.test.ts)两例的写记录/后项效果共享现有 Session serial key，保留原记录更新后旧决策拒绝、不同输入、完整 v1/v2 来源、scope/namespace 和冷读零回调断言。原无资源版本的实际效果派发与回调均先于写入提交，只修这两例的依赖前提；移除新增声明可逐字恢复原21321B文件。来源、并行、义务和 step bindings 四份整文件17pass/658assert/0fail，默认期限未改。

[Run bindings](../packages/agent/test/isolated/extensions/run-bindings.test.ts)新增 T009 真实初始化失败只影响本 Run，独立活动工具仍完成，dispose 一次，冷读零回调；[移除扩展装配](isolated/unified-agent/extension-uninstalled.test.ts)沿三个真实 Host 保自有未知记录和历史，已移除 Action 在 Command 准入前返回 `404 action_not_found`，普通任务仍完成，冷读零效果。[同步边界](isolated/unified-agent/extension-synchronous-boundary.test.ts)核实际同步回调阻塞同宿主 timer/observer，独立 Runtime 可继续，原所属 child 由保留的 handle 强杀/reap 后冷读未决事实；这不证明同步代码可协作取消或完整 Runtime census。[存储整文件](../packages/agent/test/isolated/storage/session-management.test.ts)补 T031 窄标题更新保 future record 原 JSON/版本/revision 与 schema，T033 损坏 JSON 明确 `storage_error`、原字节和其他 Session 保持；缺附件已有 [Artifact 整文件](../packages/agent/test/isolated/artifacts/artifacts.test.ts)的实际拒绝证据。

原[基础 Electron](../apps/desktop/test/native-electron.fixture.ts)、[Model 输入](../apps/desktop/test/native-model-input-electron.fixture.ts)、[Model 输出](../apps/desktop/test/native-model-output-electron.fixture.ts)、[压缩](../apps/desktop/test/native-compression-electron.fixture.ts)、[模型设置](../apps/desktop/test/native-model-settings-electron.fixture.ts)、[问答](../apps/desktop/test/native-questionnaire-electron.fixture.ts)、[恢复后问答](../apps/desktop/test/native-restored-questionnaire-electron.fixture.ts)、[完整包](../apps/desktop/test/native-bundle-electron.fixture.ts)和[跨代码首次窗口](../apps/desktop/test/native-cross-version-electron.fixture.ts)的正向准备按真实权限合同显式读取、选择原 mode 再选择 trust；原 ask/full 与准确恢复前 Store 保持，跨代码后续真实 DOM 选择不变。每项最多三次；只有准确 `permission_observation_changed`，且同 generation/Store/Session/Workspace 与原 commandId 集合未变，才允许再读并提交同一选择。已保存意图、未知结果及其他错误立即失败，生产写保护和原旧观察反例保持。固定 `native_permission_attempt` 只转发选择/尝试/观察 ID/结果元数据；成功也保留实际次数，不默认称已覆盖重读分支。原业务断言及各自原驱动、页面和整例期限不变。TUI 文件恢复的审批准备只采用完整 BSU/ESU 帧，无完整帧返回空值，保原输入、原 ID、丢回执和范围断言。真实红、局部范围与完整回归结果归本轮进度。

原[四卡整文件](../packages/ui/test/isolated/tui/pending-cards.test.ts)的测试目录只发布Controller已接纳的完整pending快照；80ms真实预读保留，仅完整事实变化才刷新UI，交互准备只核完整终端帧。原root-first/job-first、独立附件、4POST/2原GET、unknown零重发与8秒/30秒预算保持；没有暂停真实后台变化或重复发送答案，production loading/stale guard不变。真实失败及夹具同步的限度归同一本轮进度。

T/E 的适用范围仍须按[能力映射](../docs/plans/unified-agent-refactor-v1-capabilities.tsv)和[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-独立能力与并行工具完整行为)核对。原[扩展版本切换](isolated/unified-agent/extension-upgrade.test.ts)证明 E13 的源外 v1/v2 资产、旧 Job lease、完整未来记录和冷读取零重放；它不证明独立 npm 发布安装。T002 根入口无调用测试不等于完整 Runtime syscall 观测，T029 在新基线首发前没有适用的已发布前驱。缺项继续保留，关联了全部 T/E ID 不表示全部场景通过。

新的 [Browser SDK](../packages/client/test/browser.test.ts)、[Web controller](../apps/web/test/controller.test.ts)与 [Service 配对](../apps/service/test/isolated/development-web.test.ts)分别验证网络合同、视图代次及实际 Core/SQLite 的只读生命周期。Desktop 输入的 [意图](../apps/desktop/test/input.test.ts)与[配对](isolated/unified-agent/desktop-input.test.ts)使用固定 Model/临时新 Store，不接触用户数据。大人工附件的 Client、UI DOM 和便携 Desktop 测试分别证明完整字节/hash、显示后的键盘答复门禁及跨视图证明失效，不能合并声称正式 Electron 或原生浏览器已通过。

[恢复后Web完整Model正文](isolated/unified-agent/restored-web-model-output.test.ts)用公开Fork和backup/restore A→B、两次冷真实Service／Cookie BrowserClient挂载正式mountWebPage，核plain/sealed完整正文、inline回答、原完整Tool call、Copy／Close／切换清全文、错source Session拒绝。原身份和metadata全等、全GET、Model2／Tool效果1／coldModel0证明零重放；reasoning仍不在普通页面或复制中显示。JSDOM与内存clipboard只证明该正式页面消费者，原17MiB／取消和缺省foreign守卫由原完整共享UI／Client作业继续验证。fixture小回复本来inline，Markdown也会处理换行前空格；实际初始观察失败与最终同字节业务红绿均保留，未删断言或放宽预算。准确输入、22整文件／122项／1605Bun断言、source正式路由核对与installed/原生浏览器未验范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-web-完整-model-正文)。

[CSP 回归](../packages/client/test/isolated/csp.test.ts)将真实公共 BrowserClient bundle 放入真实 Node V8 的禁用代码生成环境，验证静态生成规则的 closed 请求、嵌套响应和新增字段保留；它不是浏览器布局证据。[Web 预览夹具](fixtures/unified-agent/web-preview.ts)先构建 `apps/web`，再显式启动临时 SQLite、固定 Model 和只读 Cookie Gateway，stdout 仅返回页面 endpoint/identity 与固定计数，不输出 Native token。stdin `append` 只添加一条预定消息，`stop` 结束并清理临时数据。macOS IAB 的实际选区、复制、滚动及诊断结果由 Web owner 和进度记录；没有外部 Provider 或用户 profile。

[独立开发 Web 启动测试](isolated/unified-agent/web-launcher.test.ts)固定已选 profile/配套 entry/API/capabilities 与校验过的资产，经公开 paired Service 和只读 Gateway 验证。有限参数、stdout 仅 endpoint、坏资产零新 profile、浏览器关闭后原 Model 继续，以及真实宿主 EOF/SIGTERM 后所属 PID 和 TCP listener 消失分别断言。隔离 fixture 使用无害固定 Model；不替代正式 daemon/TUI/Electron 或发行安装资格。

[完整 installed Terminal 生命周期](isolated/unified-agent/terminal-bundle.test.ts)保原 120 秒测试预算和全部原断言，平台临时根改用 `tmpdir()`；新增 Linux 分支在实际候选内运行[公共 Store reader](fixtures/unified-agent/terminal-bundle-store.ts)，其裸 imports 只解析 installed node_modules。两个 Worker 的 24 次 WAL 写入、实际 installed maintenance backup/inspect/restore/status 与 cold 原历史/config/fencing 在原最终卸载断言之前执行。升级候选仍是同源码版本指针；当前 Ubuntu x64 仿真实测不代替 Linux 跨代码、原生 CI 或其他平台。准确有限证据归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-当前-terminal-安装与维护链)。

[原完整 Native 安装生命周期](isolated/unified-agent/native-install-lifecycle.test.ts)现覆盖 macOS/Linux，保原120秒整例、45秒driver和全部原断言；平台临时根/发行目录/ps列与明确.mjs支持Linux。driver显式开启Chromium sandbox，并核两次实际窗口安全选项和无no-sandbox；只转发显示环境。当前原生Linux arm64有限实测与x64仿真失败分别保[Native owner](../apps/desktop/docs/native-release.md#linux-arm64-安装生命周期)。release-candidate执行Linux整个文件，Required unit在Xvfb内执行完整默认图，CI守卫拒绝移除/过滤/echo/错平台或静默入口；定义不作为hosted结果。

Windows另接[安装版本／维护完整caller](fixtures/unified-agent/windows-native-installation.qualification.ts)，直接消费同job先前build／verify／smoke的准确Native候选；explicit Win32 x64 required，无availability skip。通过稳定零参数前门及系统[UIAutomation](fixtures/unified-agent/windows-native-uia.ts)真实输入、提交、历史和菜单退出；原Job成员HANDLE／FILETIME与双EX独立核退出，禁止fixture强制清理计成功。A→同代码合成B→冷rollbackA保基础120／driver45／操作10秒，安装CLI恢复新Store和第四冷窗口保独立维护180／driver45／操作10秒，最后只卸载一次并核完整原业务与数据字节。原POSIX窗口文件／断言／预算不变。current CI guard整文件含新mandatory步骤和顺序mutation；本机控制流／类型检查不代Windows UIA／原生／installed通过，具体资格归[Native owner](../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。

[Windows真实代码统一caller](fixtures/unified-agent/windows-cross-version.qualification.ts)消费同job准确Terminal／Native，实际Win32 x64以固定 `4a4c0e440b2098e5b4ec58c5831452773b39228f` 原源码自己的两类builder核同schema跨代码。11项锁输入按原字节相同或已审查的完整 raw 配对准入，0001／0002 SQL 仍核原字节及固定 checksum；原837的历史输入和SHA单元继续保留。Terminal三任务／完整352041字节冷context、Native四窗口／三任务及installed新Store恢复第五窗／唯一卸载、Provider3、原Job／HANDLE／FILETIME／EOF／自然退出／strict Close／双EX全部保持。原1140000ms绝对期限含物化、360秒Terminal与420秒Native、各命令／窗口／维护原期限，不扩预算。本机源码与macOS结果不授Windows／Linux原生资格；完整边界归[Terminal owner](../apps/cli/docs/terminal-release.md#windows-真实代码升级与冷回退调用者)。

该安装用例从实际第一候选的完整Terminal制作原同基线版本输入，以独立输出目录构建第二真实候选，与第一候选的归档／搬迁核验重叠；两支全部settled之后才删除原源，任一错误保留并等待另一支。原SQLite probe、全部内容校验、两层digest和用户生命周期不省略；两个窗口在真实会话navigation内严格选择同名会话。prepare阶段观察不扩大原120／45／10秒期限，实际结果与剩余失败归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

[安装版 PC 恢复中断](isolated/unified-agent/native-restore-interruption.test.ts)沿原 `old_directory_moved` source观察点补macOS正式消费者，fault publisher使用候选内Bun／所选引擎，installed Main／Service／维护命令未修改。真实持锁／SIGKILL拒开且不建空库，包内CLI绑定原ID／digest明确rollback，Native reload读取原current Store／后来Session，readonly核原Command／Core／配置和保留候选字节。所属Service实际退出、Profile及双制品EX取得后才再次准备，完整保留原complete腿、新Store与备份Session、原命令不存在及唯一卸载。原Core七窗不扩矩阵，180秒整例／同一45秒driver／10秒窗口保持，Provider0；未在rollback窗口重跑完整Model／问答展示，不覆盖installed restore全部中断点／平台或整个W19。实际证据归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)。

[Terminal跨代码版本](isolated/unified-agent/terminal-cross-version.test.ts)以固定4a4c兼容前驱和当前源码各用原builder；11项 lock／workspace／patch 输入按原字节相同或已审查的完整 raw 配对准入，0001／0002 SQL 仍另核固定原字节及 checksum。同productVersion、实际Agent／候选差异、clean旧源码／源码删除／归档搬迁保持。原360秒A→B→A→B整例继续核原Store／Command／Run／Model、352041字节B全文及后续请求、冷读零重放、准确正常停止／EX和卸载保数据。原a2b另在独立240秒整例核实际旧installed CLI／Store leaf拒绝0002、诊断不可用、零重放与原bytes／inode／View／cursor不变；[拒绝reader](fixtures/unified-agent/terminal-incompatible-store-read.ts)裸imports只解析实际旧候选。Required unit保完整Git历史；本地比较不授已发布样本或其他平台资格。

[Native跨代码版本](isolated/unified-agent/native-cross-version.test.ts)的兼容主链固定4a4c，同schema真实双builder、源码外installed四窗口／三任务、完整正文／身份／零重放／普通退出／双EX及原420／120／60／15秒预算保持。DB8捕获／唯一POST丢回执生成DB9后，兼容A保原unknown并只读查询，B再查原完整回执和finding／sealed reference；installed backup／inspect与最终唯一卸载继续核原bytes。原a2b另有独立300秒负例，用两个不复制／不恢复的owned Profile分别核真实旧Main拒绝Core0002与旧private leaf拒绝DB9，两次退出和卸载后均核Core／private／两配置的bytes／inode、Provider0与准确进程退出。当前production owner生成私有数据的[fixture](../apps/desktop/test/native-legacy-private.fixture.ts)不代称当前Native安装资格，完整范围归[Native owner](../apps/desktop/docs/native-release.md#真实代码升级与冷回退)。

原a2b／837 legacy输入另由[精确声明投影](fixtures/unified-agent/predecessor-workspace-declarations.ts)识别 `cf6b4946e` 的 Agent context-estimate export／build／tokenizer 三件套与 UI scroll workspace 声明，以及 `21fd426d7` 的 UI Markdown export。只移除准确增量后交原全字节 matcher，resolved package 闭包不变；原 SHA 断言保留，实际当前 SHA 与具体 refinement 在 provenance 独立登记。缺项、重复、版本、路径、额外字段和闭包变化继续拒绝。Windows 保留独立路径限制，不借 POSIX source-entry 例外。[兼容输入守卫](fixtures/unified-agent/compatible-predecessor-input.ts)不借用这些 legacy 投影；新增独立[完整 raw 配对守卫](fixtures/unified-agent/predecessor-reviewed-input.ts)，仅承认固定 context、六项准确路径与双方完整 SHA。真实新增的 OpenAI resolved 闭包明确标为依赖增量，不标 identical；原11项 raw hash、两 SQL 原字节和固定 checksum 均保留。其[完整单元](isolated/unified-agent/predecessor-reviewed-input.test.ts)核不同旧 context、旧／当前任一字节、缺项／重复、包版本／URL／依赖／integrity、原闭包、live 脚本与 build entry 漂移均拒绝；五项未变化输入及 SQL 不进入例外。原 Terminal／Windows 单元继续以准确历史快照核原 SHA 与历史分支，另核实际当前输入及非 identical provenance；30e7的UI差异与21fd缺0002的真实 Git 反例保持。完整授权增量及运行边界归[Terminal owner](../apps/cli/docs/terminal-release.md#验证边界)。

依赖镜像只跳过开发 renderer 所属的准确 `.vite-desktop-dev` 真实缓存目录，避免将当前生成物带入旧构建；同名符号链接和其他非链接依赖继续走原拒绝守卫，当前缓存不被清理。目录边界归[Terminal owner](../apps/cli/docs/terminal-release.md#验证边界)。

[前驱输入守卫](isolated/unified-agent/terminal-predecessor-inputs.test.ts)保原legacy分支，只接受同字节、根清单的已知 stdio CI 完整单行增量或对应Agent／Service的已知export/build双增量；实际原清单和当前清单输入核依赖变化、额外export、build target、metadata、错path及缺任一增量均拒绝。此有界unit对应真实构建前失败，不允许任意忽略清单字段或改写旧源码。

该Native跨代码文件同时执行macOS/Linux，当前兼容链沿固定4a4c前驱；以下Linux结果仅属此前1b796锁输入和源码，当前组合留待重构后的Actions。Mac两项前端差异断言保持；历史Linux完整安装链核真实Agent差异，当时Main hash不同、renderer相同。driver使用manifest executable、明确ESM和平台ps，四次窗口均核Chromium sandbox。Linux arm64整文件374条Bun断言/actual0/171.298秒，原420秒整例、120秒driver和15秒窗口期限保持；准确范围归[Native owner](../apps/desktop/docs/native-release.md#linux-真代码升级与冷回退)。release candidate分平台调用整文件，Linux使用Xvfb，guard拒绝关闭/错平台/echo/过滤/缺显示；hosted与完整资格仍需实际结果。

[Model Inspector Core](../packages/agent/test/isolated/model-input/inspector.test.ts)、[Client 完整流](../packages/client/test/isolated/model-input.test.ts)、[实际 Service/Gateway](isolated/unified-agent/model-input.test.ts)和[Web DOM](../apps/web/test/model-input.test.tsx)分别验证准确原调用、完整交接和展示。>200 目录压力通过具名 Store 建立 planned intents，不称发生了相同数量的 Provider 调用；实际17MiB内容经过原scope Artifact/固定Model与Native/Browser，成功EOF/hash前不发布正文。真实流在首块后停住仍能取消，非法metadata先释放body；UI确认前零正文GET，隐藏/关闭/切换清正文，缺失settings明确unavailable。IAB验收固定无害内容，关闭后Model计数保持，不将当前Context或Runtime logs导航等同该原请求入口。

原审批 [DOM 回归](../apps/desktop/test/isolated/native-approval-dom.test.tsx)先建立浏览器环境，再动态导入原 Radix／ReactDOM 组件，并在独立文件进程运行，避免服务端模块缓存使菜单 layout effect 缺席。完整请求 fixture 证明 UI 门禁与准确答案，不代替 Service／Artifact 原 proof；[Core 授权](../packages/agent/test/isolated/execution/authorization-check.test.ts)、[HTTP／Client](isolated/unified-agent/client-interactions.test.ts)和[源码外默认窗口](../apps/desktop/test/isolated/native-bundle.test.ts)分别负责原资格、公开投影及首次／冷读的实际原审批。[计划窗口](../apps/desktop/test/isolated/native-plan-review-bundle.test.ts)保独立审批、大正文、反馈、Files 和原预算；标题定位使用当前原 SessionPage 的准确标题并核原 Session ID。实际结果、失败和边界见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。

[当前会话 Auto 窗口](../apps/desktop/test/isolated/native-auto-approval-bundle.test.ts)构建完整 Native＋Terminal，搬迁并删除原输出后沿原 Composer／Approval／ToolActivity 验证实际批准、拒绝、转人工、无效结果和准确停止；本机固定 Provider 持有原审查，核 Store／Session／Execution／任务与参数，停止后才释放迟到批准。原文件效果、两个人工 answer、普通退出后五条冷记录及零重复调用分别核实，最终再以公开 Store 只读核原 ID 和终态。夹具按原写入卡 `.tool-edit-heading` 定位，失败会释放所属审查以收尾而保留原断言；120秒整例、45秒 driver 和10秒 UI 时限保持。它是 macOS 当前 Store 的产品路径验证，不代替全恢复／installed／其他平台；实际输入与失败见[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原会话权限停止与自动审批闭环)。

[冷审核恢复](../packages/agent/test/isolated/recovery/run-resume-check-ownership.test.ts)使用真实子进程留下已结算的审核及失去 owner 的原 Run。seed 完整写闭同目录临时文件后才发布原 ready，父仍在原五秒内观察并真实停止所持 child，不能以空文件存在代替完整 Store ID。异常独立关闭已取得的冷 Store／DB，保留原错误、ready 字节与可取得的 metadata；原 identity／proof／generation、13 个静态断言和每例十秒期限保持。临时目录及 URL 转换使用标准平台接口，Windows/Linux 原生资格仍后置；本机原并发完整回归和唯一控制复现的准确范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13当前默认回归与冷审核恢复交接)。

## 显式命令与 CI

原 [交互历史 DOM](../apps/desktop/test/isolated/native-interaction-history-dom.test.tsx)核通用 JSON 答案、取消、准确反馈、只读按钮与迟到范围；[Main reader](../apps/desktop/test/native-interaction-history.test.ts)核43项分页、child 原关系、变化拒绝和历史／当前审批附件资格隔离。[真实 HTTP](isolated/unified-agent/client-interactions.test.ts)另核实际 child 卡和 Core 通用问题的原答案／受理、游标与效果不增长。原默认窗口保首次／冷读，计划历史原字节从已验证完整附件读取，不把格式化 Markdown 的显示文本当源字节。邻接附件 fixture 等实际通知读取失败／恢复后才断言，原拒绝、零写入和期限保持；准确失败与通过归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原交互记录只读历史)。


根默认和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)：精确八 workspace、mini-review 独立扩展、新 root unified-agent 场景及有限脚本安全列表；不会发现整个旧 integration/qualification/release/e2e/golden/TUI 树。原测试机制的独立 HOME、exclusive、失败停止派发、运行者 drain 与 OS 并发上限保持。新增 source-free/真实 Native/TTY 场景按实际分类单独进程执行，不以历史排除规则丢失其断言。

新 `test:tui:system` 由[当前 runner](../scripts/run-unified-tui-system-tests.ts)从新 UI TUI 与 CLI `tui*.test.ts` owner 动态发现，按当前文件清单分配四个 shard；`--list` 只读返回准确 inventory，只有所有 shard 成功才通过既有 `tui-system` check。根 runtime mock/e2e/fault/stdio/transport 与 Desktop aliases 已指向当前 owner 测试；旧 WebSocket/standalone/foundation/模型 live aliases 已退出，未将 paid Provider 测试重命名为 mock 通过。

当前显式工具模型入口为 `test:model:tools:live`，以 `KITE_RUN_LIVE_MODEL_TOOLS=1` 启用。[套件说明](e2e/live/model/README.md)定义实际 Agent/SDK、现有默认模型、合成 Workspace、请求预算和脱敏报告；该 runner 使用 `.live.ts`，不进入默认测试发现，也不恢复旧模型 aliases。

PDF 扫描页与图表使用显式 `test:model:pdf:live` 和 `KITE_RUN_LIVE_PDF_VISION=1`；它不进入默认测试发现。真实模型、上传删源后的实际页图、请求预算与识别限制沿[PDF live 说明](e2e/live/model/README.md#pdf-扫描页与图表)维护。

正式入口共享夹具的[TUI runner](isolated/unified-agent/unified-tui-runner.test.ts)、[开发选择](isolated/unified-agent/development-tui.test.ts)、[依赖图](isolated/unified-agent/terminal-dependencies.test.ts)与[完整formal caller](isolated/unified-agent/formal-terminal-entrypoints.test.ts)使用平台临时目录；child保宿主必要环境并隔离用户数据目录，Windows目录链接用junction／endpoint用named pipe，生成imports用file URL。formal caller复用已有Bun PTY／ConPTY执行原80×24完整步骤，真实host0＋EOF后才输出成功marker；原读取、HTTP成功、正常退出、目录删除、冷读和篡改拒绝／全部预算保持。四个完整文件macOS合11pass／1172expects，准确范围见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13正式入口完整测试的三端夹具接线)。Windows串行合同和原POSIX并发例适用条件保持；文件symlink／执行位等原生断言不删，Win/Linux仍由实际平台验证。上述最近整轮只属其冻结输入，不冒称夹具调整后的新完整默认或阶段退出。

三平台 workflow 使用新实际 producer/SQLite/平台报告，保 Bun1.4.2、40位Action pin、PR源head、clean-source与失败上传。OS vault 只在 CI 双 gate执行随机 owned namespace；默认 gate关闭零vault调用。live MCP默认gate关闭零network，workflow明确开启后才真实官方 tools/list+Tool。ACL脚本按实际OS核private路径，Winx64走currentSID/DACL；ARM64明确unsupported，运行失败非skip。

release candidate CI 在 macOS 和 Linux 调用整个原 installed Terminal 生命周期文件，原[CI 守卫](integration/scripts/unified-ci.test.ts)增加双方平台、真实 Bun 完整命令的反例检查；仅 macOS、echo 或 never-match 过滤均拒绝。精确 SQLite 3.53.2 source 准入另由[release tools](isolated/unified-agent/release-tools.test.ts)核近似 source、未知版本、linkage、额外字段和实际身份不符拒绝；原 fresh 完整候选测试继续执行。

Windows transport的原Store/config测试加[五项Node后端案例](../apps/desktop/test/isolated/windows-node-access.test.ts)，release的Native build均先调用[有限预装工具准备](../scripts/release/prepare-windows-native-ci.ts)。准备只收固定x64 compiler/SDK事实和十个环境变量，原字节严格解码、清空CL参数注入；Windows缺编译器/addon/ABI实际失败，不依据availability跳过。CI guard核原head/repository、完整消费命令和准备顺序；[纯合同测试](isolated/unified-agent/windows-native-ci.test.ts)不能代替本机未执行的Windows编译/生命周期。

Windows managed Native 源码现另接四个稳定前门、两跳实际创建证书和 Main 的完整 `candidateShared`；上述原五后端场景、期限与缺 handoff 拒绝保持，新增 fake-parent／marker 负例不得取得 SH。[handoff](isolated/unified-agent/windows-native-handoff.test.ts)、[parent](isolated/unified-agent/windows-native-parent.test.ts)、[正式 Terminal 转交](isolated/unified-agent/windows-terminal-verifier.test.ts)、[安装](isolated/unified-agent/windows-native-installation.test.ts)、[登记](isolated/unified-agent/windows-cli-registration.test.ts)与[归档](isolated/unified-agent/windows-native-archive.test.ts)的有限 mock／字节检查仅证明源码合同；真实 Bun child 的 compiler／SQLite probe 例只证明实际退出先于自有资源清理。完整实际 Node、Native bundle、安装／版本与登记文件仍按原用户行为和原预算运行；本机 macOS 结果不替 Windows MSVC／Electron／DACL／pipe／维护恢复或 Win/Linux 平台资格，准确本轮范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-managed-native-正式安装与可信启动源码)。

完整平台与soak verifier继续拒绝缺资格：bounded source-free诊断不等于生产Shell/network/fork/resource边界，闭合v2固定七类CI不等于8外层/60分钟、每类warmup0+measured1—8原生资源和§33.3完整连续组合负载资格。旧ci-baseline/State测试保历史，不参与新默认执行；[当前CI守卫](integration/scripts/unified-ci.test.ts)核真实新调度与反例。最新执行、失败及平台范围见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md)。

[原完整报告](isolated/unified-agent/unified-soak.test.ts)和[原九点 crash series](isolated/unified-agent/unified-soak-series.test.ts)保全部原业务断言／预算，追加所属 probe 的实际出生、原退出码与 kernelState：同一 attempt 的三类普通 probe 及各原 crash／recover 都须确认准确身份已退出。纯反例核当前未知／仍存活／外来身份和 full collection 缺收据拒绝，不将 synthetic 输入称原生资格。stderr 使用真实 pipe EOF、停止只作用尚未结算的原 child handle，不能以 PID 数值、目录删除或退出字段推断正常。原 macOS／Linux syscall 和 Windows 不支持条件保持；这些有限证明不解除完整后代、Bun 指标或 RSS 门禁。准确结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12资格收尾来源与-web-固定能力归属)。

macOS 另可显式执行 `bun run scripts/runtime/unified-soak.ts --profile=qualification --collect-blocked --output="${TMPDIR%/}/kite-full-soak/report.json"`，按原完整8outer／九点／60—168分钟预算采集，而不缩短到preflight。报告必须位于当前用户拥有且其他用户不可写的父目录；共享 `/private/tmp` 不能直接作父目录。支持的检查通过后仍blocked／inconclusive及退出1；实际失败则failed／退出1，formal拒绝保持。完成的各阶段复用原最终保留资源增长判定，增长失败保留私有原root与JSON，不以提前退出充作八轮通过。完整默认continuous消费父runner的同一已核验候选，源码外编译测试仍保两cycle／40Command、全部原断言与180秒预算，并核候选摘要和零重建。当前真实九点RSS增长失败、缺失Bun资源指标及全体后代资格仍单独记未具备，证据归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08macos-完整负载采集与冻结候选)。

私有[VM 协议完整测试](isolated/unified-agent/unified-soak-vm-observer.test.ts)无平台 skip，三端可用同一纯[严格读取器](../scripts/runtime/unified-soak-vm-observer.ts)核真实 Darwin 校准原记录、V1／V2 请求地址区别、64 位身份／时基／地址、完整 frame／footer、部分释放／并发顺序未知及输入／计算上限。原九项保持，现另核稀疏索引、密集真实输出拒绝、remap 存在性短路与全部 unmap 原序；本机完整 13 pass／16474 expects。默认 200 万／最高 1 亿计算预算保持，索引、排序、访问与区间处理计费。它不调用 FFI 或模拟 Windows／Linux 原生资格。[C 观察器](../scripts/runtime/native/unified-soak-vm-observer.darwin.c)仅为 macOS 私有导入诊断，本机校准核 syscall 原返回／errno、真实输入 hint 和两次部分 munmap；生产容量溢出整条拒绝，临时小容量校准保原 syscall 并由读取器拒绝 writeErrors。原 lifecycle RSS 是 probe 自身 PID，与默认 continuous 两 Service 的指标分开保留。本轮只离线复用原 450 秒／九点记录，完整交集仍超限，RSS／live allocation owner 及全资源／出生后代继续未闭合，准确范围见[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13rss-离线读取缺口与完整观测来源)。

[Coalition 前缀整文件](isolated/unified-agent/unified-soak-coalition.test.ts)三端无 skip，纯解码核 64 位精度／byteOffset、失败与 untouched 数据、guardian仍活的计数关系及非法原身份先拒绝；本机3pass／12expects。它不把 syscall／共享 coalition 数字授为完整资格；本机一次原 PID unique／version／CID 守卫下的真实前缀读取只证明该来源可用。[原生 census 补丁](../native/runtime-observer/README.md)另保九项独立 Rust 单元测试；原生 SDK 选择与 Timer 实际准入修复后 native build 和真实局部释放通过，全部原语仍未接齐，未进入默认运行时或 Actions资产。按用户最新安排停止额外采集；原 RSS／观测／完整默认阶段门禁保持，范围归[收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13原生观测源码与性能诊断收束)。

三平台[原 mcp_churn 场景](fixtures/unified-agent/soak/mcp-owned-stdio.ts)现均沿默认Source／Core／connection Job完成真实调用后exit7、原Tool unknown、完整所属树及cold原结果保全；非macOS直接stdio adapter诊断回退已退役，原四项断言迁入正式路径。原五类[完整场景](isolated/unified-agent/unified-soak-cases.test.ts)和[完整报告](isolated/unified-agent/unified-soak.test.ts)保原案例／断言／预算，v2／v3／v4严格交接按实际平台核原ready→terminal完整身份、实际root exit7、树与native关闭及cold原对象／cursor／零Provider。源码测试仅从实际built leaf取得Linux资产，compiled probe从父同候选定位原资产，缺资产／后端或真实失败不availability skip、不adapter回退。报告另核错误平台、原身份替换、未关闭及遗漏point／formal交接拒绝；synthetic输入只证明纯verifier。原Source完整关闭未确认时cleanup保false，不能以相邻fixture关闭覆盖。准确源码冻结和本机完整文件证据归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10三平台-mcp-正式-soak-调用者迁移)，Win/Linux原生／installed仍未验，原RSS／观测和阶段完整回归门禁保持。

Linux stdio Source后端现已接独立direct-program／namespace源码。新增[owner整文件](../packages/agent/test/isolated/mcp/linux-owned-program.test.ts)、[SDK／cold整文件](../packages/agent/test/isolated/mcp/linux-stdio-port.test.ts)及[Service资产FD整文件](../apps/service/test/isolated/mcp-linux-source-assets.test.ts)核本机mock／纯解码／完整SDK结果、真正wire前来源复核、取消写错误与close unknown；原[封装默认整例](../apps/service/test/isolated/mcp-source-packaged-default.test.ts)保180s／12s及全部Mac／Windows断言，并增加真实Linux资产／原host身份／终态／冷cursor。Linux实际case缺compiler／Bubblewrap或原生失败必须失败，只有非Linux条件skip。本机执行不代Linuxnamespace／ELF／installed资格，上述Soak调用者源码已迁入原Job而对应native资格仍pending；原RSS／观测门禁及原Mac stdio红保持，完整后端证据归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10linux-正式-stdio-mcp-完整连接源码)。

当前命令以根 [package.json](../package.json) 为准。`test:mock` 使用固定模型配置；`test:runtime:fault`、`test:e2e`、`test:runtime:stdio`、`test:runtime:transport` 与 `test:desktop:native` 指向新 owner。`test:desktop:window` 验完整 Native lifecycle；`test:shell:native` 验实际 confined leaf。纯 version smoke 不能替代真实窗口/PTY/平台证据。

`check:docs` 核可检查链接、active 元数据和当前 owner；`check:docs-impact` 提示实际 diff 的产品/技术核对范围，Markdown diff 不证明语义。`check:plan-evidence` 核保留历史证据与对应代码身份，不将旧 run 当新资格。文档同步 Skill 的 ready/blocked 只覆盖对应 action，不能扩大 Git 授权或表示完整 V1.3 完成。

## 历史机制与原资格记录

以下仅保留原测试职责、设计约束和已发生的证据。旧 package、State/App Server、standalone、默认发现或命令字样不构成当前执行入口；不得用这些记录替代新 public Runtime/Client/Store 的断言或当前三平台验收。

### Runtime Server V1 owner 与 transport 测试

默认workspace typecheck runner覆盖当前Runtime workspace集合。`packages/agent-api-contract/test/`验证Public snake_case DTO、closed request、
forward-compatible response、bounded JSON/UTF-8 limits、Interaction/Run/resync invariants，以及OpenAPI/JSON Schema/wire/example/digest
byte-exact generation；独立`check:agent-api-packages`验证zero-workspace dependency与browser-safe root export。`packages/agent-api-client/test/`
验证cookie REST、contract header/Problem、path/cursor与`after_sequence`编码。`apps/kite-web/test/`验证Workspace懒加载、Session/History/
Checkpoint presentation、generation隔离与迟到日志隔离；可见性轮询的验证缺口见[Web 验证](../apps/kite-web/docs/testing.md)。
`apps/kite-service/test/agent-api/`验证Agent capability与Browser launch exchange、
Workspace Trust/Directory scope、hash-only context/session、role/TTL/generation/revoke及bounded Workspace/Session/History/Checkpoint adapter，
包括cursor checksum/filter、History through/boundary/after-sequence、Checkpoint path non-disclosure与drain。daemon Web carrier test证明
static与Browser `/v1`复用一个listener且credential route不混用；同时固定退役`/_kite/web/*`业务route 404以及`/api-docs`精确allowlist。
KASAPI-02D的`apps/kite-service/test/agent-api/reference-client.ts`是test-only Public codec client；conformance suite用它同时驱动handler与真实
Worker HTTP listener，验证两种role、capability incompatibility/replay、concurrent keyset page、fixed-through History、1 MiB body/response、
16-request overload/drain、Worker replacement及non-disclosure。它不是production SDK；当前Web由显式daemon-owned static/auth carrier承载，
不再保留独立Gateway process restart矩阵。
`packages/kite-app-contract/test/` 验证browser-safe、no-secret、
exact App Control codec；`packages/kite-local-runtime/test/`验证App Server transport、credential codec、profile/config filesystem与
owner-only daemon endpoint lifecycle。dead cleanup focused suite验证PID/start/reservation/socket identity全部exact，drift/uncertain保持fail closed。

KLSV1-06 clean cutover后，`apps/kite-service/test/`拥有真实Runtime Application/Host/Store/Builtin、History/App Control与
carrier composition tests；`apps/kite-cli/test/`只验证default managed client/presentation、两阶段Workspace Trust、
disconnect/exit不shutdown owner及无embedded fallback。旧fake process harness已删除，不能以test-only lifecycle保留退役production抽象。

`tests/release/app-server-daemon.test.ts`负责Web当前证据：absent discovery不spawn、stable origin/static shell、HttpOnly Browser `/v1`读取
Native client写入同一`kite-session.sqlite`的Session、v1/v2 mismatch、双client History与stop清理。

KRSV1 的 package-owner coverage 固定为以下十个测试文件：

- `packages/runtime-contract/test/runtime-contract.test.ts`
- `packages/runtime-protocol/test/runtime-protocol.test.ts`
- `packages/runtime-server/test/runtime-server.test.ts`
- `packages/runtime-client/test/runtime-client.test.ts`、`packages/runtime-client/test/store.test.ts`
- `packages/runtime-host/test/command-receipt.test.ts`、`persistent-command-host.test.ts`、`persistent-command-crash-windows.test.ts`
- `packages/runtime-storage-sqlite/test/compatibility-store.test.ts`、`store-conformance.test.ts`

KRSRUN-01A另由`packages/runtime-host/test/runtime-run-store.test.ts`与
`packages/runtime-storage-sqlite/test/run-store.test.ts`固定neutral Run/receipt-result contract、Store 8 exact marker/11-table/3-index/foreign-key
shape、coverage/lifecycle/keyset/query-plan、Store 7双向拒绝及unknown/missing DDL、terminal/result drift negatives。该suite只证明unpublished
mechanism target；Host atomic lifecycle由01B补齐，migration、Worker reopen与Public `runs` capability仍由后续Task拥有。

KRSRUN-02A再由`packages/runtime-storage-sqlite/test/run-recovery.test.ts`、`run-store.test.ts`及Runtime Host的`runtime-host.test.ts`/
`state-session.test.ts`固定delete cascade与receipt retention、rewind partial/unknown拒绝及fault rollback、fork terminal origin/coverage/
no-receipt copy、reopen/Workspace isolation、pre-resume unknown投影、显式resume与unknown terminal refinement。它仍是unpublished Store8
mechanism evidence，不替代02B migration、03A production composition或release三平台qualification。

KRSRUN-02B的Store7→Store8 migration是未发布历史机制；[Agent Note 0154](../.agents/notes/implemented/simplification/2026-08-30-pre-release-store9-clean-cutover.md)确定 clean cutover 后，不再由`tests/release`或正式CLI验证/组合。current release
只验证App Server、Store 9与retired companion absence。

KRSRUN-03A的历史证据由同一migration suite的active adapter/new-Workspace case、`workspace-worker/application.test.ts`、
`process-foreground.test.ts`及Store Catalog layout tests固定Store8-only Worker readiness/reopen、
Controller/read/Run façade、first-write fence、fresh layout/new Workspace、private Run query与Store7 no-fallback。Public `runs`与三平台hosted
candidate仍由后续Gate拥有。

这十个 owner tests 覆盖 closed contract/protocol、Server/Client state、Store 6 receipt 的原子性、restart/crash
replay 与 Store 5 source-only import；完整 durable history由SQLite log-query、
`apps/kite-service/test/runtime-history-client.test.ts`和Session persistence/format PTY journeys验证全量分页、已选
compatibility import、ephemeral→durable transcript与live/replay reducer等价；presentation replay断言位于CLI/TUI
tests。Session/TUI tests还固定
验证 reasoning delta/completed 都走无 revision 的 Server presentation route，以及 tool-bearing durable terminal
先于累计 text delta 时连续探索工具仍聚合为同一 Thought；模型展示 `requestId` 贯穿
Kernel/Contract/Protocol/history mapper，正文先于 reasoning 或 terminal 越过 ephemeral delta 时，最终正文、
Thinking 与工具聚合仍各自只有一个 block owner。TUI harness 还以逐帧
`reasoning prefix → content → reasoning suffix → terminal` 验证正文首帧关闭纯 reasoning 活动态，后到 reasoning 只
补充隐藏 Thought metadata；live 与重启 `/resume` 都不得泄漏后缀、恢复活动圆点或重复回答。会创建真实
child、socket、SQLite file、cwd 或 global process environment 的backend tests必须留在
`apps/kite-service/test/isolated/`；CLI isolated目录只保留terminal/client-owned process journey。默认runner逐文件、
逐进程执行；可并行文件仍不能为了提速改成共享进程，独占文件必须放在 `isolated/exclusive/`。

Runtime Server/Client owner tests 还必须固定 reconnect generation 立即失效 Session readiness、cursor 超过
Host watermark 时以 current snapshot reset/ready 收敛，以及 blocked carrier 的 in-flight send 在 settle 前继续
占用 connection/global encoded-byte budget。

三个显式 transport scripts也都是隔离套件：`bun run test:runtime:stdio`覆盖Service-owned实际child/stdio lifecycle，
`bun run test:runtime:websocket` 覆盖一次性 bootstrap、cookie、loopback socket 与 browser reference，
`bun run test:runtime:transport` 以同一 raw JSON-RPC matrix 覆盖 InProcess、真实 stdio child 与真实 development
WebSocket。该矩阵验证 initialize/allowlist、唯一 Workspace admission、subscribe ack/reset/ready、unsubscribe、
close/drain 与 bounded ping mini-soak；它不把WebSocket升级为production entrypoint。stdio child必须由parent显式提供
isolated Workspace admission与nondefault `--checkpoints` path，不能打开managed default Store。

`.github/workflows/runtime-stdio-smoke.yml` 与 `.github/workflows/runtime-transport-qualification.yml` 都在
`macos-15`、`ubuntu-24.04`、`windows-2025` 上运行相应脚本。它们是 pending qualification checks：在对应 PR 的
三平台结果实际返回前，测试文档不得称其 passed、不得以 workflow 定义代替 evidence。

### KLSV1-06/07 当前 evidence 边界

KLSV1/KCWW本地cutover Gate已执行：当前default runner的Service owner为1519 tests / 8428 expects，CLI owner为
704 + 76 sandbox + 1 conformance，共781 tests；Web workspace为17 tests。Runtime transport为3 tests / 852 expects。
相关package typecheck、Biome与diff-check通过；15-workspace typecheck及runtime package/core/pre-release/test-ownership Gate也通过。

KLSV1-07当前只登记本地结果：Runtime fault 36/106、CI-profile soak 7/7 cases、carrier 23/129、Service shell
23/97，以及macOS arm64 candidate build/verify/smoke；smoke覆盖安装、CLI/TUI、Service/Coordinator/Worker/Gateway companion
assets、真实 Coordinator→Worker ensure/mint/handshake、Web payload、MCP stdio wrapper、精确PID+OS start-token绑定的test-owned
companion cleanup、升级、回滚与卸载，结束后无该smoke残留进程。当前 release manifest 的 `releaseSlots`
已绑定 CLI、TUI、Service、Coordinator、Worker、Gateway 与 Web entrypoint/identity；asset/entrypoint smoke 不提供 formal
qualification metrics。Windows managed runner v2 marker、唯一 `active` pointer、immutable candidate pin 与 no-follow/fail-closed
只已有本地定向测试；真实 Windows ACL/write-through 及 GitHub-hosted macOS 15、Ubuntu 24.04、Windows 2025 的当前实现 head
process/transport/release evidence 在完整 matrix 成功前仍 pending，本地 POSIX、workflow 定义或单平台 artifact 不能升级平台结论。

### 迁移期测试

Parity/cutover 测试只有在每条独有断言映射到 owner 测试后才能删除。State 26 read-side compatibility、
fail-closed 和历史恢复测试继续保留，但使用领域化 compatibility 名称；schema 数字只出现在测试数据和断言中。

本次 V2 已删除两个不再比较独立实现的迁移 harness：

- 原 Agent Kernel package parity 的 State bytes、codec、129-case reducer、recovery、scheduler 与 completion
  断言分别由 `packages/agent-kernel/test/agent-kernel.test.ts`、`codec.test.ts`、`recovery.test.ts`、
  `state-migration.test.ts`、`core-reducers.test.ts` 和 `completion.test.ts` 承接；
- 原 event-type parity 的 discriminant、required-field 与 unknown-event 断言由
  `packages/agent-kernel/test/agent-kernel.test.ts` 和 `codec.test.ts` 承接。

其余改名为 conformance 的测试继续验证真实跨 owner seam，不是同一实现的自比较。

### 门禁

`bun run check:test-ownership` 验证目录、deep import、root 散落、isolated 分类和 test discovery。
`bun run test` 验证默认执行，系统/qualification 使用各自显式命令。
`tests/integration/scripts/ci-bun-baseline.test.ts` 验证所有 `setup-bun` workflow 与 formal qualification
共同 pin Bun `1.4.2`，普通Required/keyring/stdio/transport/ACL workflow只取消同一PR/ref的过期运行，正式release/platform
evidence不自动取消，并确保native keyring push只覆盖`main`且path filter与执行命令共同指向
`tests/qualification/mcp-keyring-platform-smoke.test.ts`。同一测试还验证平台job有界timeout、stdio只有一个workflow owner，以及
execution-boundary workflow 的触发路径与 adversarial command 全部使用迁移后的 `apps/kite-service/test/**` current
owner，并显式拒绝旧 `apps/kite-cli/test/**` 路径。stateful TUI overlay journey在发送确认键前等待对应action footer，
避免把标题已渲染误作输入层已ready；mutation次数与最终disk/Session断言不放宽。fixture lifecycle owner test使用真实
explicit Kite home/state absent组合，先验证manager stop fence，再验证其余server/workspace cleanup与聚合错误顺序。

### 文档结构、影响与保留证据

`bun run check:docs` 递归检查当前手册、内部文档和入口；`bun run check:docs-impact` 的 all/staged/range 输出需要核对的文档，不以 Markdown diff 证明语义正确。映射或路径错误仍失败。

`bun run check:plan-evidence` 独立检查 release/oss-first-release/evidence 中实际保留的任务和完成证据。App Server 迁移证据位于 release/app-server/evidence，由对应 release tests 消费；不再要求历史 Space 索引存在。

文档工具回归：`bun test tests/integration/docs-impact.test.ts tests/integration/docs-structure.test.ts tests/isolated/scripts/docs-impact-scopes.test.ts`。客户端行为分别使用 TUI/PTY 与 Web tests，不能互相代替。

### 文档任务路由与完成动作

文档映射按 Web 视觉/路由/数据/诊断、TUI 输入/导航/审批/投影/终端、Storage 查询/事务/authority/Artifact 和 Host 职责定位。全部生产文件仍必须有唯一 source owner；新增路径不能通过重叠或漏映射满足检查。

`tests/integration/document-sync-skill.test.ts` 使用 JSON Schema 验证 design_complete、iteration_complete 和既有提交动作，并保留 ready/blocked 输出契约。语义完整性由 skill 与评审核对，测试不把标题或字数当作正确性。

设计方案链接位于产品和技术页面；`tests/isolated/scripts/docs-impact-scopes.test.ts` 验证计划删除后两侧都必须清理链接，部分交付保持有效入口。核心回归命令：`bun test tests/integration/docs-impact.test.ts tests/integration/docs-structure.test.ts tests/integration/document-sync-skill.test.ts tests/isolated/scripts/docs-impact-scopes.test.ts`。

根入口检查覆盖仓库根目录与 docs 根目录的全部 Markdown，而非仅固定 README 名单；新增客户端规则或产品入口的失效链接同样会失败。已归档的 Agent Notes 按历史材料处理，不以旧代码路径强制改写其正文；当前文档引用仍须链接有效。


### 桌面客户端验证

`apps/kite-desktop/test` 归属桌面 owner，已加入默认测试发现。页面与 client 测试验证累计文本、持久终态、导航、恢复与发送失败不重试；bridge/preload 测试固定具名方法和 channel，不暴露通用 `ipcRenderer`。Electron host 测试分别覆盖 IPC 来源与封闭参数、项目/Git/编辑器、Service 制品与进程、窗口生命周期，以及 renderer initialize 复用、旧代次隔离和订阅清理。

`bun run typecheck` 与 runtime package gate 包含桌面 workspace。renderer 只允许 `kite-local-runtime/client/protocol` 及 browser-safe contracts，禁止 Electron、Node/Bun、Host、Store、Service concrete source 和 Native I/O 根入口；Node/Electron 依赖只存在于 main/preload owner。

`bun run test:desktop:native` 是显式配套 Service smoke，需先执行 `prepare:service`。它使用隔离 home/workspace、本地模型 fixture、真实 `DesktopHost` 与同 candidate stdio Service，验证配对 initialize、流式执行中的 renderer 重接、持久历史、活动模型 EOF 清理及后继进程读取；不调用外部 Provider，也不证明 Electron preload、原生窗口、目录对话框、隐藏/激活或工具进程树崩溃清理。

`build:desktop` 构建 renderer 与 main/preload，再由官方 Electron Packager 生成 macOS `.app`。[packaged window smoke](../apps/kite-desktop/scripts/native-smoke.ts)用于在隔离 home/app data/workspace 下驱动真实制品，核对沙箱 bridge、IPC/Service、流式刷新重接、隐藏/激活和确认退出；只有脚本实际通过并登记准确制品后才能形成 Electron 原生资格。当前该结果仍 pending。迁移前 Tauri `.app` 的本机证据保留在[原生验收](../apps/kite-desktop/docs/native-validation.md)，不替代 Electron 或正式发布与其他平台资格。

文档结构测试中的子进程检查位于 `tests/isolated/scripts/docs-structure.test.ts`；普通 workspace/契约导航读取仍在 `tests/integration/docs-structure.test.ts`，原断言保持。

桌面 Electron 安装包的显式窗口验收入口为 `bun run test:desktop:window`（先构建 `build:desktop`），通过隔离的源码外 `.app`、preload 与本机模型检查流式重接、隐藏恢复和退出；原生对话框由 fixture 代答，系统输入法和人工窗口操作资格见[桌面原生记录](../apps/kite-desktop/docs/native-validation.md)。


原[OAuth Session](../apps/service/test/isolated/mcp-oauth-session.test.ts)和[默认 Source 集成](../apps/service/test/isolated/mcp-source-oauth-integration.test.ts)沿实际 SDK DCR／PKCE／callback、独立许可、Login取消、fresh连接和cold原Query核所属launcher的出生／真实exited与reap交接。私有可信spawn seam使用真实Bun child驱动原协议，原callback／整例期限和业务断言保持；该新资源证据不操作用户浏览器，实际OS浏览器既有资格沿认证owner保留。clear／refresh／revoke不生成launcher，旧六字段cold结果兼容、有限不可用与未知cleanup不改effect。


原[Native 交互分页整文件](../apps/desktop/test/isolated/interaction-pages-electron.test.ts)在关闭/切换准备中核 Main 的真实 fetch 进入信号，保 pending 的实际结局；同一10秒准备预算内最多三次显式读取同 generation/Store/Session/Workspace 的新 state，仅确切观察失效且尚未进入 fetch 的只读拒绝可再读。已进入的读取和其他错误不重试；关闭前核尚未取消，之后核真实 abort、释放 held 回包并等待同一请求结束。IPC仍受原外层期限约束，该准备预算不冒称每次IPC的硬中断。原20卡分页、40效果、一次原答案POST、原身份、晚回包不换scope及35/45/60秒期限保持，生产SSE与过期guard不变；实际次数及整例/默认结果归本轮进度。

该原窗口现同时核正常退出：只观察既有请求、实际 before-quit、退出期间的操作／启动弹窗，以及原 Electron 和准确所属 Service ChildProcess 的真实 close0／无信号；不注入 `native_draining`、新任务或延长窗口。退出时合法的读取拒绝只记录，不要求所有 IPC 成功；业务阶段原未知回执提示仍保留。清理失败与实际业务失败分别保留，强杀不能算普通退出。[读取归属 DOM](../apps/desktop/test/isolated/native-read-ownership-dom.test.tsx)保原八项，六项新增断言对应四类待完成读取的生命周期、取消后原草稿与零重发，以及当前真实错误／已提交未知回执仍显示。Radix 卸载的原零延迟焦点任务在销毁 DOM 前排空，避免跨 Event realm；这不是断言前等待或期限放宽。共享 DOM／codec 测试不新增平台条件，真实窗口仍保原 macOS 适用范围。准确运行归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12native-退出期间操作未完成误报)。
