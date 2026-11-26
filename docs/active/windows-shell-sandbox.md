# Windows Shell 沙箱：direct restricted-token 与已审批当前用户联网

状态：active

读取时机：修改 Windows execution backend、native runner protocol、restricted token/ACL/Job lifecycle、
已审批网络 token、Shell runtime policy、Windows filesystem/network boundary、Platform Capability
Probe，或 Windows Full/fallback UI 状态时。

验证：`bun run check:pre-release-architecture`、`bun test packages/agent/test/isolated/windows-path-security/default.test.ts packages/agent/test/isolated/config/mcp-selection-windows.test.ts tests/isolated/unified-agent/unified-platform.test.ts`、`bun run typecheck`、`bun run check:docs`；Windows native必须在实际win32执行，macOS types/POSIX结果不替代。

2026-10-26 已按用户要求删除除 `apps/kite-cli` 外的旧架构模块。当前实现由[现行 workspace 边界](unified-agent-boundary.md)及各现行 owner 定义；本文指向删除前固定 revision 的源码、旧模块机制和旧测试仅供历史追溯，不再是可运行入口。仍适用的授权、未知结果、恢复、数据保护与发布资格约束继续生效，删除源码不表示这些门禁已经通过。

## 当前新图与Windows资格

普通 Windows Git Bash 使用受信 PATH 所指向的原装解释器，并在普通用户 token 下由原 Job 管理。不能将此前的只读、工作区或离线授权用于此进程。只读操作不构成权限例外，打开设置本身不运行 Bash。下文的受限 token、兼容副本与 ACL 证据仍用于相应受限后端或历史验收，不能据之宣称普通原装 Bash 有文件或网络沙箱。

2026-11-18 工作区文件替换兼容性修复由原生 ACL 准备层提供。文件继承原 capability 的 `WRITE_DAC`，使 `ReplaceFileW` 可以保留原目标 ACL；目录没有这项有效权限。旧账本在原工作区锁内补齐文件继承权限，准备取消和恢复继续使用同一 SID 与未完成标记。PowerShell 5.1、PowerShell 7 和 Git Bash 的原生回归核实保存、文件占用、目录与区外拒绝和只读 Job 边界。 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash) [真实文件替换回归](../../packages/agent/test/isolated/jobs/windows-file-replace.test.ts)

同日完成 Kite Native 中 OpenAI `gpt-6-luna`／high 的 PowerShell 7 与 Git Bash PPT 复测，两份成品均可在 PowerPoint 打开。仍保留跨命令未保存驻留状态导致的各一次失败，以及首次预览与输入快照核验限制；完整环境、23 个 Job 的清理和文件占用证据归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。

随后修正 PowerShell 静态未知分类在 Full 下仍强制人工审批的行为，仅调整 Shell 能力细化的模式条件。通用独立人审、硬拒绝、父子上限与原生执行边界保持；5.1／7／Git Bash 的受控模型 Native 窗口核对零工具审批与 3 个原 Job 清理。修复前对照可复现的补充测试失败及完整资格归 [权限 owner](../../packages/agent/src/permissions/README.md)，取舍见 [Full 审批修复](../../.agents/notes/implemented/bug-fix/2026-11-18-powershell-full-uncertain-approval.md)。

请求批准模式的受限 PowerShell 附着调用由原 `shell.command` Job 承担默认人工决策。可信注册的父 Tool 仅获排队许可，实际 Job 独立核命令、目录、工作区信任、范围及当前控制修订。一次性批准绑定派发 Job。独立策略、硬拒绝和后台关系仍分别适用。 [权限 owner](../../packages/agent/src/permissions/README.md) · [单次审批决定](../../.agents/notes/implemented/bug-fix/2026-11-25-windows-powershell-job-approval.md)

Windows x64 桌面设置只提供 Git Shell 与 PowerShell，默认优先完整 Git Shell；缺少 Git 时使用已核验的 PowerShell。PowerShell 从受信任的本机安装中实际核验全部候选并选择最高版本，不固定主版本、不内置解释器。新会话创建时封存类型，子任务沿所属根会话；PowerShell 新装配重新核版本，已派发 Job 与冻结 Run 保留原解释器和资产摘要。旧 `auto`／`powershell-7` 记录兼容读取，新设置与绑定归一为两类。通用审批、范围、Job 监督与清理不按版本分叉，不新增 CLI 特例。Git 分支和工作树独立依据 Git 的可用性。Service 与 Runner 使用原 V7。业务模型从共享系统提示取得实际工作环境及本次解释器版本。实现入口见 [桌面 Shell 设置](../../apps/service/README.md#默认-shell-装配)、[PowerShell Job](../../packages/agent/src/jobs/README.md#windows-桌面-powershell-回退)和 [Shell 审批](../../packages/agent/src/permissions/README.md)。

2026-11-18，Windows x64 隔离 Native 开发制品与本地受控 Provider 验证两类设置、Git 默认、PowerShell 7.6.9 最高选择、原 Git 会话保持和冷启动仅发现 5.1.26100.10066 时的同类型执行。四个 Run／Job 完成，模型、设置与实际进程版本一致，四个 Job 均确认原清理与进程树停止，工具审批为零。完整过程与验证边界归 [Desktop owner](../../apps/desktop/README.md#windows-集成终端-shell)，不扩大为远程真实模型或安装发行资格。下方 2026-11-17 段为旧版本独立选项的历史验证。

同日后续真实 OpenAI `gpt-6-luna`／high／Full 的两类 Shell PPT 复测完成交付，12 个 Job 均确认清理，所属驻留残留、文件占用与工具审批为零。原复测同时发现 Git 一次未保存状态丢失、PowerShell 复合脚本漏报末尾原生失败、Git 首次预览等待未完成和带图输入读取核验失败。随后通用 Runner 修复状态捕获，在本机 5.1 与最高版本进行原生及受管 Job 对照通过；终态反馈明确进程内状态不能跨已结束命令保留。Service 补全图片响应字段后，原 19 条输入全部完整核验且零模型重放。审批、原 Job 清理及 OfficeCLI 保持，未按 CLI 或 PowerShell 固定版本增加特例。首次复测的失败与后续验证边界归 [Shell owner](../../packages/agent/src/jobs/README.md#类型统一后的真实模型复测)与 [Desktop owner](../../apps/desktop/README.md#windows-集成终端-shell)。

修后真实模型再次验证最终五页成品交付与冷读，14 个 Job 均确认原清理，无所属驻留残留、文件占用或工具审批；保留 PowerShell 首次模型脚本错误未交付、原会话继续后成功，以及 Git 自行恢复的原始失败。23 条实际输入完整核验。本轮两类成品首开均约 0.8 秒，原先的首开延迟未复现且根因未确认，未修改预览实现或超时。模型自行编写命令仍可能出错，结束 Job 中的未保存内存也不会自动变成落盘文件；完整证据和本机开发制品范围仍由上述 owner 维护。

随后两个新会话同任务复验均自行交付，PowerShell 10 个 Job 无失败，Git 13 个 Job 保留三次失败。其中一次 Full Job 在原批处理中报告文件替换失败，已确认原进程树停止、无持续占用或审批；恢复后副本的直接 CLI each／auto 及受管 PowerShell 对照均成功，故根因仍未确定，不能归给 CLI、生命周期或权限，也未为其增加特例。最终成品与首次／冷预览通过、32 条输入完整核验，不覆盖该原始失败；当前未解决事实与证据继续由上述 owner 维护。

Windows Shell 的共用 Runner 现把实际退出码、原 Job 终止前后的活动数、双流 EOF 或读取错误、直接关闭的句柄结果和 ACL 清理记录到同一个 Job 的私有详情。退出状态或清理无法确认时保留结果未知。诊断使用原 Runner 的独立 stderr，V7 的握手、授权范围和原 Job 终态证明继续适用。 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash) [退出状态决策](../../.agents/notes/implemented/architecture/2026-11-16-supervised-shell-exit-status.md)

Windows 的通用命令查找使用原 Job 中可核实的查找结果，候选记录与脚本最终退出码独立。从本次 PATH、用户／系统 App Paths 及显式工具目录查询本地文件属性。Windows paired 启动沿显式白名单传递工具目录。候选保存于原 Job，后续启动由普通 Shell 授权与生命周期管理。原生回归覆盖系统 PowerShell、本机最高 PowerShell 与 Git Shell 的 PATH 命中、便携目录、应用登记、缺失命令、已处理的非 127 状态和显式退出码。 [查找回归](../../packages/agent/test/isolated/jobs/windows-command-lookup.test.ts) [Service 启动](../../apps/service/src/paired.ts)

本机隔离 Service 用编译后的 Agent 和受控模型响应核实了实际交接。PowerShell 7.6.9 的首次命令返回 127，模型在下一轮输入中收到精确候选及来源，随后显式提交的绝对路径调用返回 0。原 Git 文件替换失败命令在等字节的重建副本上经 Kite Runner、直接 Git Shell 和提前保存的直接对照都返回 0，原故障瞬间的文件操作仍待取证。证据分别保存在本机 `.cache/kite-command-lookup-service-smoke.json` 和 `.cache/kite-shell-ppt-retest-20261118-603e9545/evidence/git-replace-after-command-lookup.json`。

修正非 127 查找与 paired 目录传递后，隔离 Kite Native 开发制品用真实 OpenAI `gpt-6.1-terra`／medium／Full 在 PowerShell 7.6.9 与 Git Shell 各完成一次五页 PPT。两条首探分别退出 127 和 1，模型均收到启动配置目录中的候选并成功调用。Git 另有一次盘符路径写错，自行纠正后继续，并有一次退出 0 的可选工具查找仍保留未命中诊断。15 个 Job 的退出码与原生证据一致，全部确认清理，无审批、驻留残留或文件占用。两份文件通过 Kite 首开与冷预览、PowerPoint 五页渲染。复测沿用 PATH，仅用本机已有工具；原生通用 CLI 夹具另核 PowerShell 5.1／7 静默探测返回 2、Git 的静默探测与处理后返回 0。真实请求与成品证据在本机 `.cache/kite-shell-ppt-retest-20261118-534e834b/evidence/terra-retest-proof.json`。

本机 Windows x64 下，系统 PowerShell 5.1.26100.10066、自动发现的最高 PowerShell 7.6.9 和 Git for Windows 2.56.1 各运行一对 Full Job。首条命令启动会公布 PID 的持锁子进程，替换普通文件返回 Win32 32，源与目标字节保留。首条 Job 诊断确认剩余活动进程由非零降为零，双流读到 EOF，输出句柄及 Job 句柄关闭。下一条 Job 立即替换成功。原 Git PPT 批处理在同一重建前置文件的两个副本上经新 Runner 和直接 Bash 对照均返回 0，进程树均停止。证据在本机 `.cache/kite-shell-bottom-replay-39291bf1/proof.json`。原失败发生时持有文件的进程和系统错误码仍未取得。 [跨 Job 持锁回归](../../packages/agent/test/isolated/jobs/windows-shell-cleanup.test.ts)

2026-11-17 Windows x64 的独立 Kite 开发制品与本地受控 Provider 观察了设置读取、保存、首条消息接管、原会话继续和冷重开。启动环境中的 PowerShell 7.6.9 可选，保存后新会话执行 7.6.9，原会话继续执行 5.1.26100.10066。移除测试启动环境中的 7 路径后，设置提示回退，新会话执行 5.1.26100.10066。Provider 收到四个 Run 对应的实际版本，四条原生 Job 都返回 0 并确认进程树停止和清理。实际窗口与 SQLite 冷读证据位于本机 `.cache/kite-powershell-discovery-window-d9a5dd82/`。7 专属语法、实际版本输出和受限 Job 的[原生回归](../../packages/agent/test/isolated/permissions/powershell-command-policy.test.ts)独立通过。

Git Bash 准备入口核实本机安装并异步准备一份受限运行时。只读与工作区写入使用该副本，完整文件范围直接使用原安装的 Bash。V7 Runner 按所选路径和解释器摘要启动。派发前核实所选路径的登记资产。实现与本机回归归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。

2026-11-19，Windows x64／Bun 1.4.4／Git for Windows 2.56.1，分别通过构建后的 `windowsShellAssets` 和原生 Job 检查只读、工作区写入和完整文件范围下的两种联网设置。实际 Shell 映射证实完整文件范围启动原安装，受限范围使用私有副本。`file` 四次均能识别 PNG，区外写入仅在完整文件范围成功，四个 Job 均确认原进程树停止。以同一 V7 Runner 对照，两个原安装入口均在受限令牌下报 MSYS 信号管道 Win32 5。`bash.exe` 和原 MSYS DLL 的源摘要保持一致。证据为本地 `.cache/managed-installed-bash.json` 和 `.cache/installed-bash-probe.json`。 [实际 Job 回归](../../packages/agent/test/isolated/jobs/windows-shell.test.ts)

同一构建通过 [Service 并发回归](../../apps/service/test/isolated/shell-concurrency-configuration.test.ts)。核对完整文件范围的原安装路径、各 Job 实际映射的独立临时目录、工作区写入和定点取消。成功 Job 的交付暂存归档后移除，取消的 producer 暂存由原收集记录持有。 [交付与暂存生命周期](../../packages/agent/src/business/output-collection.README.md#生命周期)

2026-11-19 合入工作区后，以 Kite Native 的 Windows x64 源码开发制品在默认 Git Shell 和完全权限下复测《新品上市计划》。原 OpenAI 连接的 `gpt-6-luna`／medium 完成 6 次模型调用。实际进程观察逐一匹配 4 个 Shell Job 的 Runner，均启动已安装的 `usr/bin/bash.exe`。3 次命令成功，1 次 OfficeCLI batch 因模型传入 `target` 字段返回 `invalid_input`／退出 1，模型改用 `path` 后完成交付。4 个 Job 均确认进程树归零和清理，工具审批为零。

最终回复引用实际绝对路径，首次点击约 686ms 在右侧显示 5 页。模型先后归档两个同名版本，首次夹具按原始记录数等待超时。重开原会话后，按实际成品摘要核对归档，界面呈现一张成品卡，附件点击约 772ms 在右侧显示 5 页。冷重开后仍只有一条用户消息和一张成品卡，模型调用数保持为 6。PowerPoint 16.0 以只读权限打开同一份文件并逐页导出，标题与正文可编辑，后四页各两项。第 2、4 页各有一个句号单独换行。成品前后摘要一致，独占读取成功。证据位于本机 `.cache/kite-installed-bash-live-ppt-3cc07f62/evidence/`，包含首次过程、冷重开、进程观察和 PowerPoint 证据。

整合远端桌面改动后，以新建的 Native 开发制品重开同一测试会话。正文链接和成品卡分别在约 820ms、806ms 打开右侧 5 页预览。再次冷重开仍显示一条回复和一张成品卡，原 Run 与 6 次模型调用保持同一组记录。复验证据位于上述目录的 `merge-review-preview/`。

Git Bash 根据宿主 `PATH` 的 Git 和同一安装内的实际运行时确定程序目录，派发使用对应的 `bin`。受限副本按原相对路径保留共享系统数据，完整文件范围可访问原安装布局。PowerShell 将可确定的独立原生调用非零码及未捕获的查找、启动异常交给现有 Job 结果。模型依赖检查在该 Job 环境内执行。两种 Shell 的技能交付均以准确 producer 的成功终态为依据。实现见 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)和[文件交付](../../packages/agent/src/business/output-collection.README.md)。

2026-11-16 在 Windows x64／Git for Windows 2.56.1 用真实 Git Bash Job 核实继承 PATH 为空时仍可运行 Git。准备层夹具覆盖 `mingw64`、`ucrt64` 和自定义目录名。源码开发配对 Service 通过正常客户端接口和固定本地模型响应，对内置 PPTX 技能和从用户技能目录安装的非办公技能分别运行 PowerShell／Git Bash。四组均在原 Job 探测到 Python 3.12.10，按顺序观察到命令缺失 127、已写暂存文件的进程退出 7、成功交付和冷读。失败暂存未发布，独立 Job 复用工作区中间文件，客户端读取并核对了成功文件字节。Service 证据在本机 `.cache/shell-stability-desktop-70be0a58/timeline.jsonl`。

同日以 Electron 44.3.0 的 Native 源码开发制品和正常 Renderer 路径复测四组。持续观察提交、失败后等待、草稿输入、最终回复、文件可见及冷重开。每组只显示一个用户消息和最终回复，保留执行中输入的草稿。失败阶段无成品卡，后续成功 Job 的文件卡出现后正常重读。两次 Main 均正常退出，冷重开没有再次请求模型。过程保存在本机 `.cache/shell-stability-desktop-f28928ea/desktop-observation.json`、同目录截图和 Job 日志。验证范围为 Windows 源码开发制品及固定模型响应，正式安装资格沿原发布流程。

Job 只有在 READY 核验与 GO 写入确认后进入 running。失败准入仍把原 handle 交回 Core，清理未知时保留停止能力与资源。确认未派发的准备失败正常释放资源。运行时以原 manifest 固定所选副本的完整文件摘要，每次派发重核。Runner 的 ACL 账本同步、关闭写句柄后再原子发布。Windows 临时访问或共享冲突仅在200ms内重试原替换，持续失败保留原账本并拒绝启动。连续替换、短冲突恢复与持续冲突零损坏由 [原生回归](../../native/windows-sandbox-runner/src/direct_workspace.rs)核验。

派发前完整资产校验已改为有界、可取消的异步读取，主动交还事件循环；取消和失败等待已开始读取关闭，确认零业务派发后才结算。多会话共享读取名额但独立持有校验状态，B 的读取未完成不会阻止 A 取消或 C 执行。每条命令仍创建独立 Bash／Job，不复用活进程；资源上限、完整身份与 SHA 守卫及本机回归归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)，正式调度证据归 [Service](../../apps/service/README.md#默认-shell-装配)。

同日扩大到32会话后，真实排队／32条同时执行、单独取消及准确关闭通过，完整校验保持进程内8路上限。随后按确认范围优化新鲜配置／权限检查调度、纯模型 schema 编译复用及 Windows 临时目录异步清理；无 profiler 的相同32会话夹具中，默认4槽最大心跳约1608→598ms，显式32槽约2858→553ms，原执行／取消／全关闭断言保持。会话锁路径、Store 序列化及 Artifact 持久发布仍有峰值，完整链路的响应性缺口尚未全部消除，不能据此宣称几十会话始终不卡。完整比较、实现 owner 与复现入口归 [Service](../../apps/service/README.md#默认-shell-装配)；正式默认并发、完整校验及逐条独立执行保持，没有引入进程池。

2026-11-05，Windows x64／Bun1.4.4 的隔离 Native 开发制品使用真实默认 Service／SQLite／Git Bash 与固定本地模型，连续观察提交、资产读取、取消、其他会话执行和恢复。测试夹具保持 B 的真实读取未完成，A 的原 Job 在191／238ms内确认取消，C 随后完成写入与管道；B 取消后先关闭读取，保持零 native reference、零业务写入。长消息场景中取消等待时切换约72ms，真实滚轮将原阅读位置移动500px，取消完成后仍停在同一阅读位置；Main 心跳最大约73ms、Renderer 帧间隔最大约25ms，观察全程没有新可见终端窗口。原始过程及截图保于本机 `.cache/cancel-native-inspection-ft2CEn/` 的 `SHELL-ASYNC-UI-RESULT.json`、`SHELL-ASYNC-SCROLL-UI-RESULT.json` 与对应 trace。暂停读取只在独立测试制品启用，普通客户端没有新开关。客户端现有取消等待期间的输入禁用状态保持；上述结果仅覆盖本机读取调度与所观察过程，不代表其他卡顿来源、实际拖窗或完整安装发布资格。

三条同步路径优化后，同一独立 Native 场景再观察183份连续页面状态与 trace：B 保持读取时 A 在331ms确认取消、C 实际完成写入和管道；B 取消等待期间切换约73ms、滚动500px，读取关闭后恢复且阅读位置保持，零 Renderer 错误／新增终端。Main 心跳最大约57ms、帧间隔最大约31ms。证据为上述本机目录的 `SHELL-OPTIMIZED-SCROLL-UI-RESULT.json` 及 `shell-optimized-scroll-trace.zip`；原 Main／Service 均已退出。此处仍仅为三会话实际 UI 过程，32会话结果来自独立 Service 压测，两者不混称为32会话 Native 资格。

2026-11-02 已按用户确认的无账户 unelevated 边界，将原协议6 runner 接入普通 Job 和默认 Git Bash。工作区范围沿原 WRITE_RESTRICTED 令牌及 capability ACL 限制写入；读取沿宿主 ACL，离线范围提供代理及常用包管理器的环境提示，不承诺系统级断网或禁止读取路径。Full 明确绕过沙箱；准确批准的完整文件范围与网络范围分别传递，不能由联网批准隐式扩大文件权限。没有新增账户、WFP 规则或设置入口。

当前执行宿主为 Windows x64 的 Bun Service；正式 Terminal／Native 客户端使用该宿主。Node 嵌入不宣告这一依赖 Bun FFI 的 Shell 能力，避免先提供定义再在派发时失败。工作区加联网范围仍保持受限令牌；依赖系统 Schannel 的工具可能保留该令牌的兼容性限制，不能自动升为完整文件范围。

统一环境路径、后台隐藏窗口、可取消的工作区准备及未完成权限传播恢复归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。PowerShell 与 Git Bash 的已核实只读调用使用现有 Runner V7 的 `read_only`，不加入可写工作区 capability。Git 查询还以原 Job 的活动进程上限阻止第三个进程。可写准备取消不能把部分继承标为完成，也不能忽略本次临时 ACL 撤销失败。已有业务进程继续核原完整 Job。

业务允许／拒绝只由统一权限与计划／角色上限决定。Tool 和真实 Job 按各自原身份授权；runner 只消费最终 markDispatching 接纳的父／子范围交集，不按默认范围覆盖批准，也不再安装独立命令拒绝脚本。范围外的 OS 访问失败、坏协议／资产身份及清理未知仍按执行事实报告，不构成新的业务审批。批准外部写入后，完整文件范围可实际执行；不因它位于 Workspace 外在 Shell 层再拒一次。

[运行时准备](../../packages/agent/src/jobs/windows-git-bash.ts)从本机 Git for Windows 准备受限副本。MSYS 用户信号管道的 [IPC 支持](../../native/windows-msys-compat/README.md)在工作区限制 SID 下保留同登录会话的必要权限。完整文件范围使用原安装，与受限副本各有自己的 MSYS 对象空间。制品内置 Runner、兼容 DLL 和 rg。PowerShell 由 Windows 提供并直接进入相同的令牌、ACL 和 Job 路径。联网范围独立于文件范围。`network:none` 的环境约束和已知联网意图检查属于本次交付，系统级断网需独立验证 AppContainer。

生命周期与其他平台共用普通 Job：准备／READY 后由原 owner 放行 GO，READY 最多等待5秒，超时后的迟到 READY 不再放行。持续排空双流，取消作用于原 Job；根退出后清理剩余后代。正常 ended 须原 runner 回执、外层 Job 空树、进程 wait、句柄关闭和 temp 清理均确认。GO 前取消有原空树和未派发证明；关闭未知继续保原 owner 和 binding，不回收成成功。宿主 EOF／强杀由 kill-on-close 清整个嵌套 Job；冷读取只保原结果，不用 PID 重建控制或重放。

2026-11-17 实机对照核实两个 Windows 后端的本地命名管道写入和文件替换限制。命令仍在运行时已观察到受限令牌下的双向管道连接拒绝，随后观察到原 Job 终止剩余辅助进程并释放文件句柄。PowerShell 7 与 Git Bash 均用固定命令验证了两种写入流程。单进程在工作区范围内落盘。需驻留时，完整文件范围配合 `network:none` 在同一 Job 内完成写入与关闭，退出后复核页数，下一 Job 验证 PPTX 结构。14 个 Job 均确认清理和进程树停止，工作区外写入的负例仍被拒绝。源证据位于本机 `.cache/windows-shell-resident-20261117/scoped-ipc-f5ae7d85/`。权限与通用 Shell 指引归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。

通用脚本对照覆盖 PowerShell 顶层作用域与 Git Bash 的 `-c` 参数截断。Git Bash 在达到 Win32 上限前即可能截断，Runner 按完整转义命令行字节数提前改用已有 stdin 传输。两个后端的工作环境系统提示使用探测所得的版本、可用的 Windows 用户区域和 UTF-8 解码信息。脚本传输与探测细节归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。

[实际 Windows Shell](../../packages/agent/test/isolated/jobs/windows-shell.test.ts)已核空 ambient PATH 的内置 rg、中文／空格文件、fork／管道、Git 子 Shell、受限与 Full 并发、写范围收窄、环境离线与准确联网范围、启动取消、后台后代取消、宿主 EOF／强杀与原 HANDLE 死亡。[真实 Service／SQLite](../../apps/service/test/isolated/shell-search-configuration.test.ts)核只读子 Agent、计划前检索和原审批卡、外部写入批准前零效果／批准后实际写入、重复命令及冷只读零重放。原 [Job owner 回归](../../packages/agent/test/isolated/jobs/windows-owned-child.test.ts)保关闭失败／unknown 合同。此范围是本机 Windows 开发验证，不代表完整安装、签名或全部平台发布资格。

2026-11-26，Windows 源码 Desktop 与配套 Service 使用本机 Codex 的 `gpt-6-luna`／`medium` 复查合成文件交付。Git Shell 直跑原生 Git Bash，进程使用当前用户的令牌，文件与网络能力随该令牌及系统策略。模型请求 `workspace_write`／`network:none` 时，审批卡按原生进程的实际能力标记为 `full_access`／`internet`。审批只决定是否启动该命令。该次审批取消，原 Job 未派发，符合当前原生 Git Bash 的行为。新会话绑定 PowerShell 7.6.9 后，模型请求按 `workspace_write`／`network:none` 派发，原 Job 退出码为 0，进程树停止且清理确认，人工审批记录为 0。两份 Markdown 归档摘要与原文件一致，桌面在原回复下显示两张文件卡。记录位于本机 `.cache/conversation-powershell-evidence-20261126/` 的 `git-shell-approval.json` 和 `job-and-output.json`。

2026-11-14 在 Windows x64／Bun 1.4.4 用 5,001 个文件的隔离工作区对照 `04807430e` 与本轮。每个后端和范围取三次首输出中位数。首次可核实检索从可写范围改用只读范围后，PowerShell 由 1,329ms 降至 464ms，Git Bash 由 1,602ms 降至 730ms，且无工作区权限账本。随后首次可写分别为 1,291ms 与 1,587ms，同范围热执行为 418ms 与 706ms。计时从原生 Job 工厂完成后的 start 开始。实际权限与调用结果另由 [Auto Service 回归](../../apps/service/test/isolated/windows-shell-auto.test.ts)验证。

同机使用真实 Electron 开发窗口、独立 Profile 和固定审核结果，逐步观察两种 Shell 的检索、普通脚本、高风险批准、高风险拒绝、严重风险拒绝和再次检索。两种后端的可见审批卡数均为 0、0、1、1、0、0。四次脚本请求各只审核一次，审核材料含对应脚本正文。等待高风险确认期间尚未写入，普通脚本和批准的脚本实际写入，两种拒绝均无写入，随后输入和检索恢复。过程记录位于本机 `.cache/native-windows-auto-risk-result.json`，原生计时位于 `.cache/windows-auto-timing-results.json`。

修复前，同日以本机已配置的 OpenAI Responses 连接在独立 Kite 桌面开发 Profile 实测 `gpt-6-luna`。业务请求使用 high，实际审核请求使用 low，当时的审核预算为 256 输出 token 和 8 秒。两种后端的可核实检索均无审核请求，普通脚本由模型判为 ordinary 后写入。两种后端均观察到 high 样本出现一张卡并在拒绝后零派发。另一个 PowerShell high 样本获批后仅派发一次，原 Job 继承原审核，回环端点收到一次合成数据。已完成审核的端到端耗时为 1,996～5,370ms。

两份修复前冷读记录共查到四次审核触及输出上限，均以技术失败结算，零卡、零派发。补测中一次预期为 critical 的 Git Bash 合成样本耗尽 8 秒，按当时的超时放行规则启动原 Job，回环端点收到一次合成数据。该次未取得风险分类。两个后端随后都在原会话完成检索，Git Bash 的该轮还保留了一次业务模型失败。该轮未通过严重风险分类及拒绝验收。原始观察保存在本机 `.cache/windows-shell-openai-luna-high-42c2a32a-85d3-4f8d-b28c-fd1500320c27.json` 与 `.cache/windows-shell-openai-luna-high-b76d8566-ad5b-4ac3-9f93-ccd9f4482737.json`。

修复后，以同一 Kite OpenAI 连接复测。封存业务请求为 `gpt-6-luna`／high，审核为同模型／low，未传输出 token 上限，实际期限为 8 秒。PowerShell 与 Git Bash 的四个 high 样本各出现一张卡，两次批准各派发一个自身 Job 并只向回环接收端交付一次合成数据，两次人工拒绝均无 Job 或流量。首轮 Git Bash 的严重风险样本获得 `critical` 并直接拒绝。PowerShell 的同类样本一次 8,002ms 超时后零卡、零派发、零流量，另一次只从待发送文件名和注释推断凭据类型，被模型归为 high 并由测试操作员拒绝。保留这两项原结果。

在相同代码和期限下，将凭据用途明确表达为脚本执行时的认证头，载荷仍为合成数据，目标仍为本机回环。两个后端均由模型判为 `critical` 并直接拒绝，审核分别为 1,712ms 与 1,938ms，零卡、零派发、零流量，之后均在原会话完成检索。原生回归另核两个后端在审核超时后收到迟到分类，原检查终态保持，后续只读调用完成。[Windows Shell 回归](../../apps/service/test/isolated/windows-shell-auto.test.ts)

修复后的桌面报告位于本机 `.cache/windows-shell-openai-luna-uncapped-f2e125f7-4509-477d-bb54-bf32e9520fca.json`、`.cache/windows-shell-openai-luna-uncapped-f28df665-3f29-46c3-805d-d1a03bb9c9d2.json` 与 `.cache/windows-shell-openai-luna-uncapped-24c501dc-8549-4725-b1dc-891262126006.json`。上述证据覆盖指定模型与隔离桌面样本，保留模型分类仍取决于可见材料的实际观察。

2026-11-12 在 Windows x64／Bun 1.4.4，以同一正式桌面候选的包内 Service 和 Runner V7 核实三组进程 PATH。完整 Git Bash 组使用 Bash，无 Git 组用 PowerShell，只有独立 Git 时 PowerShell 与工作树列表均可用。模型工具收到实际方言，三组实际使用内置 rg 返回中文。两组有 Git 的工作树列表返回测试仓库的 `refs/heads/main`。包内 Runner 直接启动 PowerShell 的复验覆盖只读临时写、工作区写、联网许可不扩大写范围、批准外部写、中文双流、大脚本、原后代取消与超时、摘要变化和 V6 请求拒绝。日志在本机 `.cache/powershell-fallback-a45ca81cf/` 的 `packaged-service-v7.log` 和 `direct-v7-final.log`。目录联接及工作目录与写范围分离由 [Windows Job 回归](../../packages/agent/test/isolated/jobs/windows-shell.test.ts)核对，别名与已知效果由 [真实 AST 回归](../../packages/agent/test/isolated/permissions/powershell-command-policy.test.ts)核对。

2026-11-12 在 Windows x64／Git for Windows 2.53.0.windows.1 上验证随附命令。原生回归核实际命令来源、中文路径、管道、工作区与完整范围、取消和清理。新桌面候选通过完整清单核验，隔离安装实际观察两条 Git Bash 命令从提交、运行到各自的结果，退出后读回两个完成记录；同一制品在无 Git 的 PATH 下使用系统 PowerShell 读取中文文件。界面过程与结果保于本机 `.cache/windows-stock-git-bash-20261112/installed-shell-settings-6ae9aaa5.json`。

Windows stdio MCP 继续使用同一[原 Job／HANDLE owner](../../packages/agent/src/platform/process/windows-owned-child.ts)，其 [transport](../../packages/agent/src/mcp/README.md#windows-stdio-所属-job)边界独立。Windows Files 的原 HANDLE 端口亦不由 Shell 取代，见 [Files owner](../../packages/agent/src/tools/files/README.md#windows-workspace-文件源码)。旧 Runtime、State writer、Workflow 执行和旧调用方不恢复。

下方V6/restricted-token/Schannel/Job、旧candidate与旧Gate资料保留历史机制、实际限制和安全经验。若后续将其中能力移入新宿主，仍须以新公共Execution/Job、准确封闭来源/许可、实际Windowsnative与完整制品证明；不能包装旧Host/writer，或凭旧pin/CI记录启用新的effectfulplatform。当前新平台formal verifier继续拒完整缺资格；三OS结果由[当前进度](../plans/unified-agent-refactor-v1-progress.md)核对。

## 历史runner与仍适用的安全约束

旧实现验证：`bun test apps/kite-service/test/tool-definitions.test.ts apps/kite-service/test/tool-runner.test.ts
packages/builtin-runtime/test/sandbox/platform-backends.test.ts tests/qualification/sandbox/windows-restricted-token.test.ts
tests/qualification/sandbox/windows-network-setup.test.ts tests/qualification/sandbox/platform-capability-probe.test.ts
tests/qualification/sandbox/platform-capability-verifier.test.ts tests/qualification/sandbox/process-tree-limit.test.ts
apps/kite-service/test/sandbox/app-sandbox-composition.test.ts apps/kite-service/test/isolated/sandbox/execution-boundary.test.ts
apps/kite-service/test/git-broker.test.ts apps/kite-service/test/runtime/git-tool-controller.test.ts
apps/kite-cli/test/tui-exit-coordinator.test.ts apps/kite-service/test/isolated/runtime/cli-runtime-coordinator.test.ts apps/kite-service/test/runtime/runtime-session-coordinator.test.ts apps/kite-cli/test/tui-reducer.test.ts`、
`bun run typecheck`、`bun run check:docs`。native runner
变更还必须运行 `cargo test --manifest-path native/windows-sandbox-runner/Cargo.toml` 和 release
script 指定的 Win11 native E2E/probe。direct backend E2E 为
`KITE_RUN_WINDOWS_RESTRICTED_TOKEN_E2E=1 bun test --max-concurrency=1
tests/qualification/sandbox/windows-restricted-token.test.ts`；它必须经 App composition，并由 test-only Runtime lifecycle
oracle 先 ack preparation intent。当前 Local Provider 随后必须以
数据化的 `windows_restricted_token_v1` prepared transport 通过 ready/dispatch lifecycle；native E2E 使用
`printf SANDBOX_OK` 断言受限 token runner 的实际 stdout、Job cleanup 与 `disposed=true` disposal receipt。
该 native conformance 显式设置 `hostFallbackPolicy=deny`，确保成功输出来自 runner 而不是 host fallback。
Online 账户 setup 已不属于该 backend；required conformance 不创建账户，也不发起单独的 Schannel smoke。
非 Windows 开发机缺少固定 GNU target/toolchain 时，本地 TypeScript 协议测试不能替代 native runner
编译证据；包含 runner Rust 源码的 PR 必须等绑定当前 head 的 `candidate-windows-x64` 或 Windows
Platform Capability Probe 完成 `build-windows-runner.ts` 构建，才能宣称该平台改动已通过；该构建必须
同时闭合 library 与 `kite-windows-runner` binary 的接口，不能用仅编译 library 的结果替代。
`cargo test` 还必须编译 binary 的 `cfg(test)` target；bootstrap/frame material fixture 比较 exact bytes，
不能把内部 `Arc`/`Vec` ownership shape 当作 wire contract 或因此跳过 native test target。每个 fresh runner
control stream 接受一次合法 bootstrap；同一 stream 的第二份 bootstrap 位于 request frame 位置，必须由
frame decoder 拒绝，不能把“single-use”误写成跨独立 stream 拒绝相同测试向量。
Windows 10 使用 22H2 (10.0.19045) API/build baseline；本记录不声称 physical Win10 conformance。

主 Run 无期限的源码协议现允许显式 `timeoutMs: null`，Rust request 使用 `Option<u64>`，Job 等待继续同时监听 process 与 cancel；有限正整数仍保留计时器。Service 的空期限不装生命周期 timer，但取消后仍装有限 cleanup watchdog。缺字段、零值及非法数字不能当作无限期限。本次只取得 TypeScript codec／受控 adapter 与真实 Rust protocol 源码的测试证据；macOS 不能完成 Windows native binary 构建或 Job 实机验证，现有 runner pin 未重建。因此此扩展尚未取得绑定当前源码的 Windows 平台资格，上述 canonical build、binary pin 与 native conformance 门禁继续适用。
当前 GitHub-hosted E2E 不执行 Node/npm/Bun/cmd/PowerShell runtime smoke 或受管网络 Schannel smoke；
runner native 实现与可复现构建覆盖由独立 Cargo/protocol evidence 提供，不能绕过 Local Provider admission。
若未来 Provider 获得新 accepted authority，runtime smoke 必须拆为独立调用并给 Defender 冷启动各自有界预算，
Schannel smoke 也必须保持单一网络维度，不能用复合命令或错路由替代资格证据。
Windows 临时 Workspace 的原生断言比较 canonical、大小写不敏感的 path identity，不把 8.3 短路径与
同一目录的长路径 spelling 差异误报为 cwd 越界。
runner evidence 在 Windows CI 中显式选择固定版本的 GNU toolchain，并通过
`bun run scripts/release/build-windows-runner.ts` 固定 toolchain 内置 `rust-lld`、重映射
checkout/Cargo cache 路径并清除 PE 时间戳；
重新生成 manifest 后必须以 `git diff --exit-code` 证明提交的 runner pin 与构建产物一致。

相关：[Agent Note 0074](../../.agents/notes/implemented/process/2026-08-08-windows-10-api-compatibility-baseline.md)、[Agent Note 0077](../../.agents/notes/implemented/simplification/2026-08-08-unified-sandbox-startup-downgrade.md)、[Agent Note 0079](../../.agents/notes/implemented/architecture/2026-08-08-windows-managed-restricted-token-sandbox.md) 至 [Agent Note 0089](../../.agents/notes/implemented/feature/2026-08-08-windows-online-loopback-proxy-inheritance.md)、[Agent Note 0097](../../.agents/notes/implemented/feature/2026-08-13-brokered-git-capability.md)、[Agent Note 0110](../../.agents/notes/implemented/feature/2026-08-18-tool-pipeline-commit-boundaries.md)、[Agent Note 0131](../../.agents/notes/implemented/simplification/2026-08-24-whole-workspace-sandbox-admission.md)、[Agent Note 0137](../../.agents/notes/implemented/bug-fix/2026-08-25-shell-sandbox-durable-approval-queue.md)。

## SAQ-10 当前 contract

Windows restricted-token 只兑现明确的 sealed scope；UI 展示的 scope、prepared transport 中的
scope，以及 native runner 的实际 boundary 必须一致。`interactionMode=full` 是 Full 的唯一表达，
不再存在 `full_access` approval grant 或第二个 authorization mode。`none`/能力不可用时，受限
执行 clean fail closed，不能退回 host Shell；这不应把 Full 选择器误报为需要一个旧 grant。

SAQ-10 的阶段基线是 Building 的 Workspace 读写 baseline 与 Planning 的 Workspace 只读 baseline。
已知的 external/sensitive scope 由 Tool Policy 路由到 `approve_once`、`same_command` 或 Auto
review；同一 invocation 的 sealed scope 仍须在 approval、recovery 与 dispatch 中保持不变。Plan 与
Full 正交：Planning + Full 可直接执行但仍保留 Plan lifecycle。只有同一轮并发多个 Explore children
才派生 Auto；单个 Explore 及 plan/code/review children 继承 parent route。

人工队列由 State 27/SAQ epoch 持久化。Enter提交exact interactionId/generation；Esc拒绝当前可见焦点并原子取消同turn
其余未终结sibling、结束turn，Ctrl+C仍是独立整轮取消输入；`/permissions` 的 session grants 清除通过 canonical event
持久化，并在 session/revision/generation 不匹配时 no-op。旧 queue/grant 或旧 epoch 不能在 restore
后复活。

## 当前 backend 选择

旧架构的 V6 Windows runtime 使用以下 outcome：

| outcome | 选择条件 | Workspace 模型 | assurance 与 Full |
| --- | --- | --- | --- |
| windows_restricted_token | protocol V6/native runner compatibility path；Builtin Local Provider 在 durable intent 后生成 transport，Runtime lifecycle consumer 经唯一 Host spawn primitive 启动 | canonical 真实 Workspace，不复制 repository | development restricted-token sandbox；开发期 Full 可用，production qualification 不可用 |
| none / denied | candidate 不可用、sandbox 关闭或语义不受支持 | 不启动用户命令 | 零 host Shell fallback；受限 scope clean fail closed，Full 不转成旧 grant |

另有 [Agent Note 0100](../../.agents/notes/implemented/feature/2026-08-13-user-approved-external-filesystem-capability.md) 定义的逐 invocation approved-filesystem scope：普通 Workspace 外读写或路径范围无法
证明的命令审批通过后，仍由去权 restricted token 与 Job Object 执行，只使用当前用户普通 ACL，而不使用
Workspace-only `WRITE_RESTRICTED` capability gate。它不是 host executor、startup fallback 或失败后 replay。

AppContainer backend、`KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL` 选择逻辑、private Workspace
staging、repository copy、预算 Worker 和 reconciliation 已由 [Agent Note 0088](../../.agents/notes/implemented/simplification/2026-08-08-remove-windows-appcontainer-backend.md) 删除。设置旧环境变量不会改变
backend。该移除不降低 production 能力，因为实验路径从未取得 production qualification。

RM-13 保留了当时的 protocol V6 和 fallback 规则。runner manifest、transport preparation、
protected-path/network/resource 语义位于 `packages/builtin-runtime/src/sandbox/`，通用异步进程创建、POSIX
supervisor、output drain 与 process-tree cleanup 位于 `packages/runtime-host/src/`，唯一 App composition 位于
`apps/kite-service/src/sandbox/`。已删除的 `src/core/sandbox/**` 和 protocol/Core 旧路径不得恢复为兼容导出或
durable lifecycle adapter，也不得重新加入 `Bun.spawn`、第二个 runner handler 或 post-dispatch replay。

正常本地路径无需 UAC，TUI 不检查联网身份。foreground CLI 保留 `bun run agent sandbox status` 与
`bun run agent sandbox setup` 作为非提升兼容入口；两者在 pinned runner 可用时均报告
`current_user_restricted_token`。Runtime 记录该次 Shell 的 sealed-scope 授权后，native runner 直接
使用当前登录用户 token 运行该 exact command，不创建、登录或依赖另一 Windows 本地账户。

## direct Workspace restricted-token backend

1. TypeScript adapter 验证 pinned native runner，并在 TUI 首次渲染后安排 structural startup probe。
   它不枚举、复制、hash 或 reconciliation 用户仓库。
2. runner canonicalize 真实 Workspace 与 invocation-private runtime。command cwd 与 workspace root
   都是真实 Workspace，写入直接落到该 Workspace。
3. 每个 Workspace 有持久 synthetic capability SID 和 user-owned ledger。root inheritable allow ACE
   保持持久；V3 ledger 把 canonical Workspace 作为完整身份，并在升级时恢复、删除 V2 留下的内部
   protected-path DACL snapshot。
4. 每个 invocation 有单独 runtime capability SID，只授予 invocation runtime。startup probe 使用
   ephemeral Workspace SID，不修改真实 Workspace ledger。
5. `networkMode=off` 从 current user 派生 write-restricted primary token，使用
   `CreateRestrictedToken` 的 `DISABLE_MAX_PRIVILEGE`、`LUA_TOKEN`、`WRITE_RESTRICTED`
   与 capability SID。
6. persistent Workspace capability ledger 只持久化根 allow ACE；Workspace member 不再生成或刷新
   名称级 deny。升级时在 Workspace mutex 下只对仍带旧 capability deny ACE 的 snapshot 执行恢复，
   已被宿主替换且不再带该 ACE 的对象不会套用 stale snapshot。
7. 只有同一次 invocation 在 `interactionMode=full` 下获得
   `filesystem=full_access, network=allow_all` sealed scope 时，native runner 才使用当前登录用户
   token 启动该 exact command，并先把它加入 kill-on-close/active-process-limit Job。它不调用
   `CreateProcessWithLogonW`，也不创建、登录或轮换 `KiteNet*`/其他本地账户。`network=allow_all` 配合
   `read_only` 或 `workspace_write` 必须由 TypeScript adapter 与 native runner 在 user script 前以
   `approved_network_requires_full_filesystem_scope` fail closed：不得为了 Schannel 静默放弃受限 token 的
   文件系统边界。
8. 上述同时获批网络与完整文件系统的 command environment 只保留当前用户 profile 中 Schannel 所需的 `APPDATA`、
   `LOCALAPPDATA`、`USERPROFILE` 等路径，再覆盖受信 runtime allowlist；这使 TLS 使用当前用户的
   credential store。此 exact `full_access + allow_all` invocation 还继承用户已有的标准 proxy variables
   （`HTTP[S]_PROXY`、`ALL_PROXY`、`NO_PROXY`；Windows environment 名称不区分大小写），使企业或本地代理可达；network-off、
   policy-proven read-only 与未批准调用不得继承这些变量。proxy 值只由 runner 在实际 spawn 时从当前进程
   读取，不能出现在持久化的 preparation 或 recovery artifact 中。
9. 未获网络授权的调用仍使用 write-restricted token。Windows development backend 不将该事实表述为
   structural network-off；已审批联网调用也不声称具备独立的 restricted-token filesystem ceiling。

runner 只使用 manifest 固定的 POSIX runtime 与最小 environment allowlist。可验证的 Bun executable
可通过 invocation runtime/PATH 暴露，但不会复制 repository。默认 command language 仍为 POSIX/Bash，
也可显式调用 cmd.exe、pwsh 或 powershell.exe。

Windows standalone candidate 曾将固定 Runner 与配套工具保留在 immutable
managed candidate root。v2 managed-install marker 与唯一 `active` regular-file pointer 绑定当前 candidate；stable
launcher 将其启动时的 candidate root 显式 pin 给 child process，running process 不重新读取 pointer。Runner resolver
只接受 marker、pointer、`.candidate-id` 与 candidate `manifest.json` identity 完全一致的 candidate，并对 launcher、
marker、pointer、candidate root、runner manifest、runner 与 Shell/Coreutils runtime 执行 no-follow/non-reparse/
regular-file 检查；缺失、替换或 digest 不一致使 backend 不可用，不会加载未固定的 host runner，也不会回退 cwd、PATH
或 ambient home。真实 Windows ACL/write-through 与三平台 candidate/process qualification 仍待 hosted/真实证据。

## 历史 V6 协议

adapter 与 runner 必须要求 native invocation `protocolVersion=6`。V6 只描述 direct
`windows_restricted_token` invocation，携带 development network `off | allow_all` 与 filesystem
`read_only | workspace_write | full_access` sealed-scope projection；`full_access` scope 只能由当前
interaction/policy facts 产生，不能由一个旧 grant 隐式扩大。没有匹配 scope 时在 user script 前拒绝。
`full_access + allow_all` 的当前用户 token 不携带 Workspace synthetic SID；Workspace 外固定路径仍由
approved-filesystem guard 保护。V6 继承 V5
删除的 backend mode、AppContainer identity 与 staging 字段；任何 V1-V5 runner 都在 user script 前
fail closed。

当前构建从同次原生输出生成制品内 Shell 清单和各资产摘要。Service 与 Runner 共同校验 V7。旧协议或旧制品的摘要不用于 V7 派发。构建与安装的制品身份由 [Native owner](../../apps/desktop/docs/native-release.md)维护。
Windows candidate 的 standalone resolver 还必须把 `@kite-ai/builtin-runtime/sandbox` 及其他 workspace public
exports 直接映射到仓库 source，禁止经过 `node_modules/@kite-ai/*` symlink；否则 Windows Bun standalone 可能因反斜杠
pretty path 崩溃，导致已验证 runner 无法进入候选包。release test 从 package exports 机械验证该闭包。

## 能力边界

local path 的 `WRITE_RESTRICTED` 通过 restricted SID check 限制写入，但 current user 仍可能拥有普通读取
权限。approved filesystem path 同样保留 `WRITE_RESTRICTED`、LUA 与 privilege stripping，使 read/execute
只服从 current user 普通 ACL，并让 restricted SID check 仅参与写访问；token 的 restricted SID 集合镜像
user/group SID 并加入 compatibility SID，同时保留 Logon/World SID。这样 GitHub runner toolcache 等只向普通用户
ACL 身份授予执行权的 system/toolchain binary 仍可运行；按 [Agent Note 0132](../../.agents/notes/implemented/feature/2026-08-24-sensitive-external-paths-use-exact-approval.md)，Workspace 外固定路径不再对该 SID
安装 write deny ACE。approved token 与普通 Workspace token 使用同一
Logon/World/capability default DACL 初始化，确保 shell 创建的 pipe 与 Node/npm 等 descendant process
object 可由该 token 继续访问。只有带 `full_access + allow_all` sealed scope 的网络调用才改用当前用户 token，
以便 Schannel 读取当前 profile；因此它不保留 restricted-token filesystem ceiling，普通用户 ACL 成为该
exact 已审批 command 的文件权限边界，也不得安装该 token 无法命中的 temporary guard ACE。任何较小
filesystem scope 的网络调用均被拒绝，不能把 network approval 变成该 filesystem 扩权。
Job Object 提供进程树数量和终止边界，不单独作为 filesystem 或 network boundary。

该 backend 没有 structural network-off 或 arbitrary-descendant allowlist。按 [Agent Note 0131](../../.agents/notes/implemented/simplification/2026-08-24-whole-workspace-sandbox-admission.md)，Workspace 内
`.env.*` 等名称不再需要动态 deny；ledger 属于 trusted host state，并只保留完整 Workspace root capability。
用户目录等 Workspace 外 protected path 不得写入该 ledger，因为 Workspace capability 在外部没有 allow ACE。
按 [Agent Note 0132](../../.agents/notes/implemented/feature/2026-08-24-sensitive-external-paths-use-exact-approval.md)/[Agent Note 0133](../../.agents/notes/implemented/feature/2026-08-24-mode-aware-sensitive-external-authorization.md)，approved filesystem invocation 已在 Tool Policy 完成当前模式授权，runner 不再为外部固定路径
安装 guard deny ACE；compatibility SID 暂时保留以维持 protocol V6，且外部路径不进入 Workspace repair。

因此 `windows_restricted_token` 是 development backend：

- 可以开启 [Agent Note 0121](../../.agents/notes/implemented/feature/2026-08-18-windows-development-full-mode.md) 定义的开发期 Full，但不能以此宣称 production Full qualification；
- 不能为 arbitrary Shell descendant 资格化 network-off 或 allowlist；
- 不再提供或要求 Workspace 内 `.env.*` protected-path deny；
- `productionSupported=false`，D-04 仍为 excluded。

Tool Policy 保持逐调用授权：可证明本地的 version query 投影为 `off`；网络命令和 uncertain script
经批准后投影为 `allow_all`；Windows 仅在 interaction/policy facts 明确给出对应 filesystem scope 时使用当前
登录用户 token，否则在 native runner 前 fail closed。这里的模式是 development scope projection，不产生域名 allowlist 或
production network evidence。

文件系统 effects 独立处理：`externalRead`、`externalWrite` 与 `uncertainEffects` 审批通过后与其他平台
相同投影 approved filesystem scope；Full 直接授权，Auto 模型选择批准、拒绝或请求真人审批，技术异常和
circuit breaker 转真人审批。
该 invocation 不准备或修改 restricted-token Workspace ACL ledger。canonical Workspace 内全部名称均允许；
普通临时目录和外部文件可在批准后执行；Workspace 外凭据、持久化入口和关键系统文件进入相同模式感知
授权，其他模式请求 exact user approval；授权后 runner 不再二次拒绝。关键 destructive 操作仍硬拒绝。
命令自身或宿主 ACL 失败仍原样返回。

## startup denial 与 no replay

TUI 静默预热不阻塞首帧、typing 或静态 Working 状态的事件驱动渲染。bootstrap 把 executor
注册到统一退出协调器。退出或等待 `prepare()` 的当前
SessionRuntime 被取消时会中止探针，runner 清空 Job 并回收 ephemeral ACL；中止结果不缓存。setup gate
与预热并行，并在用户确认时 re-check readiness。

development/production App 在 user script 前确认 runner pin、OS baseline 或 token capability
等 essential capability unavailable 时，缓存 backend=`none`/mode=`denied`，不使用 host Shell。
该 denial 只表示受限执行不可用；Full 选择仍由 `interactionMode=full` 表达，实际执行在缺能力时
按 sealed scope clean fail closed。

一旦 user script 交给 native runner，它至多执行一次。non-zero exit、timeout、cancellation、runner
error、Job cleanup、ACL lease cleanup 或其他 command-time failure 都作为该 backend 的结果返回，不得
在 host Bash/cmd/PowerShell replay。production composition 始终使用 fail-closed executor。

## evidence 与错误分类

native runner 在低于 Windows 10 22H2 (10.0.19045) 时 fail closed。Win11 GitHub-hosted environment 是
runner build/Cargo/protocol、Local Provider 及成功 command dispatch conformance 的原生 evidence 来源。token、ACL
与 Job conformance 通过仍不能提升 strict network/protected-glob
或 production 资格。

正式 Platform Capability Probe 的 Windows 命令使用正常 persistent Workspace capability，而不是
startup probe 的 ephemeral Workspace SID，因此完整 Workspace read/write/execute 与 V3 legacy protected
snapshot migration 结论必须经过真实 ledger/DACL 刷新路径。probe Workspace 创建后立即固定 canonical identity，采集与 finally repair 必须共用该值，
不能让 Windows 8.3/长路径 alias 分裂 ledger。probe Workspace 仍是临时目录；采集结束时先调用 runner repair 恢复 snapshot、撤销 root ACE
并删除 ledger，再删除临时目录。资格 workflow 的 paths gate 必须覆盖 native runner、当前 Shell 构建输入、
Windows adapter 使用的 App composition、Builtin sandbox、Host lifecycle、SPI contract 以及 evidence scripts，不能让这些依赖单独变更而跳过原生
E2E/probe。

| 条件 | 必须的结果 |
| --- | --- |
| user script 前 runner pin/OS/token/cleanup structural capability unavailable | App 缓存 backend none/mode denied，不启动 host command；受限 scope clean fail closed，Full 不转成旧 grant |
| user script 开始后的 command/timeout/cancel/cleanup failure | selected backend fail closed；不 host replay |
| legacy protected snapshot migration 或 Workspace ACL/ledger recovery failure | fail closed 并保留 diagnostic |
| `full_access + allow_all` sealed scope + `interactionMode=full` | 当前用户 token 在 Job Object 中运行 exact command；不创建账户、不请求 UAC |
| `allow_all + read_only/workspace_write` | `approved_network_requires_full_filesystem_scope`，不启动 user script，不 host replay |
| none 请求受限 scope | disabled/rejected，并显示当前 backend 不可用；不 host fallback |
| windows_restricted_token 请求 Full | 允许开发期 Full；不改变 `productionSupported=false` 或 strict production evidence 要求 |

[Agent Note 0120](../../.agents/notes/implemented/feature/2026-08-18-windows-strict-appcontainer-profile.md) 开始实现 direct Workspace 的临时 AppContainer strict candidate：它不是 Windows 登录账户，
不请求 UAC，也不恢复 repository copy。默认零 capability profile 与已批准网络 profile 必须分离；在
offline network、Workspace 外 read/write/protected identity、Job/ACL/profile cleanup 和两入口 native
conformance 全部通过前，它仍不是可选择 backend，也不能用于 production Full qualification。开发期 Full
已由 [Agent Note 0121](../../.agents/notes/implemented/feature/2026-08-18-windows-development-full-mode.md) 的 direct backend 语义提供。

按 [Agent Note 0131](../../.agents/notes/implemented/simplification/2026-08-24-whole-workspace-sandbox-admission.md)，Windows restricted-token 开发 backend 不再尝试证明通用 Shell 对 Workspace `.git`
metadata 的独立 read/write deny；旧 ACL snapshot 会由 V3 ledger migration 恢复并删除。专用 Git Broker、
schema 与资格字段现已退役，普通 Shell 的 OS 权限与执行资格仍保留。按 [Agent Note 0137](../../.agents/notes/implemented/bug-fix/2026-08-25-shell-sandbox-durable-approval-queue.md)，Windows raw Shell 先按 interactionMode
与 phase 选择 Workspace baseline：Building 使用 Workspace 读写，Planning 非 Full 使用 Workspace 只读；
baseline 不再因为命令名进入全量人工审批，已知 external/sensitive scope 才路由到 durable approval/Auto
review。命中 [Agent Note 0134](../../.agents/notes/implemented/simplification/2026-08-24-closed-read-only-git-shell-grammar.md) read-only classifier 的命令仍可使用 hardened environment，并固定关闭 external
config、prompt、pager、optional locks 与 fsmonitor；该分类不跳过 mode/policy review。raw Git token 不被
硬拒绝；删除 Git 专用资格不构成 Windows 平台生产资格通过的证据。

## Git Worktree worker 的新增范围

`builtin.shell/git.worktree@1` 沿 `shell.command@1` 运行固定 Bun worker。启动前核对 Bun/Git/worker/config/空 hooks 及摘要，使用 `--no-env-file --config=<absolute>` 和独立环境。仅准确固定的 list 为只读。Full 保留该 worker 的原申请，network 固定 none。Windows Git Bash 与 PowerShell 都使用所属 Native Job。PowerShell 仅转换匹配原操作身份的 worker 命令，审批和历史仍使用原调用身份。

2026-11-06，本次新 worker 已在 macOS arm64／Bun1.4.4／Git2.54.0 验证真实三个 action、launchd 启动保护和发行资产搬迁后的实际Job；Linux和Windows本次未有对应实机环境，原平台的普通Shell证据不授予该新worker的监管、Windows reparse或完整发行资格。具体算法和不支持配置由 [Worktree owner](../../packages/agent/src/tools/git-worktree/README.md)维护，Windows删除仍遵循[只读清理门禁](../development/worktree-safety.md)。
