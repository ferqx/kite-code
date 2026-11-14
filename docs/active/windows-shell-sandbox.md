# Windows Shell 沙箱：direct restricted-token 与已审批当前用户联网

状态：active

读取时机：修改 Windows execution backend、native runner protocol、restricted token/ACL/Job lifecycle、
已审批网络 token、Shell runtime policy、Windows filesystem/network boundary、Platform Capability
Probe，或 Windows Full/fallback UI 状态时。

验证：`bun run check:pre-release-architecture`、`bun test packages/agent/test/isolated/windows-path-security/default.test.ts packages/agent/test/isolated/config/mcp-selection-windows.test.ts tests/isolated/unified-agent/unified-platform.test.ts`、`bun run typecheck`、`bun run check:docs`；Windows native必须在实际win32执行，macOS types/POSIX结果不替代。

2026-10-26 已按用户要求删除除 `apps/kite-cli` 外的旧架构模块。当前实现由[现行 workspace 边界](unified-agent-boundary.md)及各现行 owner 定义；本文指向删除前固定 revision 的源码、旧模块机制和旧测试仅供历史追溯，不再是可运行入口。仍适用的授权、未知结果、恢复、数据保护与发布资格约束继续生效，删除源码不表示这些门禁已经通过。

## 当前新图与Windows资格

Windows x64 桌面 Service 启动时确定自动选项的解释器，优先完整 Git Bash，明确未发现才探测系统 Windows PowerShell 5.1。常规设置可明确选择其中一个解释器。新会话创建时封存实际选项，之后的轮次和子任务沿该会话。发现后发生的资产校验、权限、启动或身份异常沿原失败路径处理；设置请求在两种解释器的可用性确定后才保存偏好，准备失败后可再次请求。已派发命令的读取、取消和清理继续使用原 Job。Git 分支和工作树独立依据 Git 的可用性。制品内的 Service 和 Runner 同步使用 V7，模型使用 `shell_execute` 并取得实际方言。实现入口见 [桌面 Shell 设置](../../apps/service/README.md#默认-shell-装配)、[PowerShell Job](../../packages/agent/src/jobs/README.md#windows-桌面-powershell-回退)和 [Shell 审批](../../packages/agent/src/permissions/README.md)。

Git Bash 准备入口异步等待两套副本完整校验，最多8个文件并发，未修改映像只复用本次读取所得的源摘要。现存资产不覆盖，排他创建缺失文件。失败等待所有已开始的读写结算后拒绝返回。所选副本每次派发前完整核验。常用命令来自该副本的 `usr/bin`，只读目录查询也固定使用同一副本的 `ls.exe`。构建与 Runner 使用当前 V7 的解释器路径及摘要，移除独立 Coreutils 资产与临时命令链接。实现、回归与本机耗时范围归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)和 [Desktop owner](../../apps/desktop/README.md#开发热更新与服务重载)。

Job 只有在 READY 核验与 GO 写入确认后进入 running。失败准入仍把原 handle 交回 Core，清理未知时保留停止能力与资源。确认未派发的准备失败正常释放资源。运行时以原 manifest 固定所选副本的完整文件摘要，每次派发重核。Runner 的 ACL 账本同步、关闭写句柄后再原子发布。Windows 临时访问或共享冲突仅在200ms内重试原替换，持续失败保留原账本并拒绝启动。连续替换、短冲突恢复与持续冲突零损坏由 [原生回归](../../native/windows-sandbox-runner/src/direct_workspace.rs)核验。

派发前完整资产校验已改为有界、可取消的异步读取，主动交还事件循环；取消和失败等待已开始读取关闭，确认零业务派发后才结算。多会话共享读取名额但独立持有校验状态，B 的读取未完成不会阻止 A 取消或 C 执行。每条命令仍创建独立 Bash／Job，不复用活进程；资源上限、完整身份与 SHA 守卫及本机回归归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)，正式调度证据归 [Service](../../apps/service/README.md#默认-shell-装配)。

同日扩大到32会话后，真实排队／32条同时执行、单独取消及准确关闭通过，完整校验保持进程内8路上限。随后按确认范围优化新鲜配置／权限检查调度、纯模型 schema 编译复用及 Windows 临时目录异步清理；无 profiler 的相同32会话夹具中，默认4槽最大心跳约1608→598ms，显式32槽约2858→553ms，原执行／取消／全关闭断言保持。会话锁路径、Store 序列化及 Artifact 持久发布仍有峰值，完整链路的响应性缺口尚未全部消除，不能据此宣称几十会话始终不卡。完整比较、实现 owner 与复现入口归 [Service](../../apps/service/README.md#默认-shell-装配)；正式默认并发、完整校验及逐条独立执行保持，没有引入进程池。

2026-11-05，Windows x64／Bun1.4.4 的隔离 Native 开发制品使用真实默认 Service／SQLite／Git Bash 与固定本地模型，连续观察提交、资产读取、取消、其他会话执行和恢复。测试夹具保持 B 的真实读取未完成，A 的原 Job 在191／238ms内确认取消，C 随后完成写入与管道；B 取消后先关闭读取，保持零 native reference、零业务写入。长消息场景中取消等待时切换约72ms，真实滚轮将原阅读位置移动500px，取消完成后仍停在同一阅读位置；Main 心跳最大约73ms、Renderer 帧间隔最大约25ms，观察全程没有新可见终端窗口。原始过程及截图保于本机 `.cache/cancel-native-inspection-ft2CEn/` 的 `SHELL-ASYNC-UI-RESULT.json`、`SHELL-ASYNC-SCROLL-UI-RESULT.json` 与对应 trace。暂停读取只在独立测试制品启用，普通客户端没有新开关。客户端现有取消等待期间的输入禁用状态保持；上述结果仅覆盖本机读取调度与所观察过程，不代表其他卡顿来源、实际拖窗或完整安装发布资格。

三条同步路径优化后，同一独立 Native 场景再观察183份连续页面状态与 trace：B 保持读取时 A 在331ms确认取消、C 实际完成写入和管道；B 取消等待期间切换约73ms、滚动500px，读取关闭后恢复且阅读位置保持，零 Renderer 错误／新增终端。Main 心跳最大约57ms、帧间隔最大约31ms。证据为上述本机目录的 `SHELL-OPTIMIZED-SCROLL-UI-RESULT.json` 及 `shell-optimized-scroll-trace.zip`；原 Main／Service 均已退出。此处仍仅为三会话实际 UI 过程，32会话结果来自独立 Service 压测，两者不混称为32会话 Native 资格。

2026-11-02 已按用户确认的无账户 unelevated 边界，将原协议6 runner 接入普通 Job 和默认 Git Bash。工作区范围沿原 WRITE_RESTRICTED 令牌及 capability ACL 限制写入；读取沿宿主 ACL，离线范围提供代理及常用包管理器的环境提示，不承诺系统级断网或禁止读取路径。Full 明确绕过沙箱；准确批准的完整文件范围与网络范围分别传递，不能由联网批准隐式扩大文件权限。没有新增账户、WFP 规则或设置入口。

当前执行宿主为 Windows x64 的 Bun Service；正式 Terminal／Native 客户端使用该宿主。Node 嵌入不宣告这一依赖 Bun FFI 的 Shell 能力，避免先提供定义再在派发时失败。工作区加联网范围仍保持受限令牌；依赖系统 Schannel 的工具可能保留该令牌的兼容性限制，不能自动升为完整文件范围。

统一环境路径、后台隐藏窗口、可取消的工作区准备及未完成权限传播恢复归 [Shell owner](../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。PowerShell 与 Git Bash 的已核实只读调用使用现有 Runner V7 的 `read_only`，不加入可写工作区 capability。Git 查询还以原 Job 的活动进程上限阻止第三个进程。可写准备取消不能把部分继承标为完成，也不能忽略本次临时 ACL 撤销失败。已有业务进程继续核原完整 Job。

业务允许／拒绝只由统一权限与计划／角色上限决定。Tool 和真实 Job 按各自原身份授权；runner 只消费最终 markDispatching 接纳的父／子范围交集，不按默认范围覆盖批准，也不再安装独立命令拒绝脚本。范围外的 OS 访问失败、坏协议／资产身份及清理未知仍按执行事实报告，不构成新的业务审批。批准外部写入后，完整文件范围可实际执行；不因它位于 Workspace 外在 Shell 层再拒一次。

[运行时准备](../../packages/agent/src/jobs/windows-git-bash.ts)从本机 Git for Windows 生成私有摘要闭包。MSYS 用户信号管道的 [IPC 支持](../../native/windows-msys-compat/README.md)在工作区限制 SID 下保留同登录会话的必要权限。完整文件范围使用未修改的独立 MSYS 副本，避免并发共享区冲突。制品内置 Runner、Git Bash 所需的辅助文件和 rg。PowerShell 由 Windows 提供并直接进入相同的令牌、ACL 和 Job 路径。联网范围独立于文件范围。`network:none` 的环境约束和已知联网意图检查属于本次交付，系统级断网需独立验证 AppContainer。

生命周期与其他平台共用普通 Job：准备／READY 后由原 owner 放行 GO，READY 最多等待5秒，超时后的迟到 READY 不再放行。持续排空双流，取消作用于原 Job；根退出后清理剩余后代。正常 ended 须原 runner 回执、外层 Job 空树、进程 wait、句柄关闭和 temp 清理均确认。GO 前取消有原空树和未派发证明；关闭未知继续保原 owner 和 binding，不回收成成功。宿主 EOF／强杀由 kill-on-close 清整个嵌套 Job；冷读取只保原结果，不用 PID 重建控制或重放。

[实际 Windows Shell](../../packages/agent/test/isolated/jobs/windows-shell.test.ts)已核空 ambient PATH 的内置 rg、中文／空格文件、fork／管道、Git 子 Shell、受限与 Full 并发、写范围收窄、环境离线与准确联网范围、启动取消、后台后代取消、宿主 EOF／强杀与原 HANDLE 死亡。[真实 Service／SQLite](../../apps/service/test/isolated/shell-search-configuration.test.ts)核只读子 Agent、计划前检索和原审批卡、外部写入批准前零效果／批准后实际写入、重复命令及冷只读零重放。原 [Job owner 回归](../../packages/agent/test/isolated/jobs/windows-owned-child.test.ts)保关闭失败／unknown 合同。此范围是本机 Windows 开发验证，不代表完整安装、签名或全部平台发布资格。

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
