# Agent 能力与 CI 验证矩阵

本文记录 `el-refactor` 基线 `6d11fd65` 和本次 CI 改动的覆盖范围。一个结果要带上源码 SHA、产品入口、平台及实际断言才有意义。先在 [package.json](../package.json) 找命令，再按下表选用例。各客户端支持的操作见[产品手册](../docs/handbook/capabilities.md)。

## 能力、可观察结果与缺口

本次客户端验收范围为 Windows 和 macOS 桌面。普通 PR 在 Linux 上验证 Agent、Service、公共 Client SDK、可移植组件与打包合同；两种桌面宿主各自有一项原生作业。表中单个文件可用 `bun test <路径>` 定向复验。涉及设备、进程所有权、付费 Provider 或安装包的结果另列在第三栏。

| 能力 | PR 中实际检查的结果与用例 | 补充证据与待验证范围 |
| --- | --- | --- |
| 核心循环、多轮工具、并发与故障 | [Responses/Chat Completions](../apps/service/test/isolated/responses-loop.test.ts) 通过真实 Client、HTTP Service 和 SQLite 跑分片工具调用、三轮循环、冷续跑；不完整响应不产生工具副作用。[并行工具](../packages/agent/test/isolated/execution/parallel-tools.test.ts) 核对逐调用结果。 | 本地真模型 tools 核对模型选择、实际读改写及子 Agent。真实 Provider 的语义和延迟按模型单独记录。 |
| 上下文、历史与压缩 | `test:mock` 的四个文件检查配置、自动压缩、[压缩结果](../packages/agent/test/isolated/context/compression.test.ts)及历史来源。[steering 边界](../packages/agent/test/isolated/context/compression-steering-boundaries.test.ts)检查跨压缩指令。 | 压缩后保留已完成的 Tool 步骤仍有红灯。长历史和上下文窗口耗尽需记录模型、输入规模、保留事实以及重试。 |
| Provider、认证、流与取消 | [认证](../apps/service/test/isolated/codex-auth.test.ts)、[Client SSE](../packages/client/test/sse.test.ts)、[SDK 故障](isolated/unified-agent/live-model-failure.test.ts)和[预算](isolated/unified-agent/live-model-budget.test.ts)用本地夹具验证绑定、丢帧、错误、断流和预算退出。 | 本地真模型套件核真实请求和原业务断言。真实桌面 OAuth 登录、刷新及原生凭据库需要对应平台与独立测试账户。 |
| Session、steer、重放、恢复 | [Service resume](../apps/service/test/isolated/run-resume.test.ts)、[持久 steer](../packages/agent/test/isolated/recovery/run-resume-steering.test.ts)和[文件检查点](../apps/service/test/isolated/file-checkpoint-fork.test.ts)检查冷读、原 Run 归属及历史。 | [打包恢复探针](isolated/unified-agent/unified-soak.test.ts)在源码树外检查 attempt、恢复增量模型调用为零、一次持久效果和退出。replay-provider 证明确定性恢复；live U01 检查实际模型与活动父 Run 的交接。 |
| 子 Agent、后台 Job、Task、计划与取消 | [packaged Task](../apps/service/test/isolated/task-packaged-default.test.ts)、[子计划](../apps/service/test/isolated/per-run-planning-child.test.ts)和[owner handoff](../packages/agent/test/isolated/execution/owner-handoff.test.ts)核对继承、交接及所属执行。[Job 恢复](../apps/service/test/isolated/job-reconcile.test.ts)检查未知结果。 | [协作取消](e2e/live/model/collaboration-cancellation.live.ts)、[审批计划](e2e/live/model/planning-business-approval.live.ts)和真实窗口已有入口。补齐打包父子并发、取消后进程树退出及冷恢复无重复效果的本机证据。 |
| 审批、Sandbox 与 Shell | [权限策略](../packages/agent/test/isolated/permissions/policy.test.ts)、[命令策略](../packages/agent/test/isolated/permissions/shell-command-policy.test.ts)、[Linux 原生 Shell](../packages/agent/test/isolated/jobs/linux-native-shell.test.ts)检查拒绝、范围收窄、执行与清理。 | Linux 要有 cc、bubblewrap 及可用命名空间；macOS 观察实际 Seatbelt/后代；Windows 观察实际受限令牌、Job/HANDLE、MSVC x64、用户会话。[审批真模型](e2e/live/model/approval-execution.live.ts)另核真实选择与授权。 |
| Tool、Skill 与扩展 | [模型工具清单](../packages/agent/src/model-tools.README.md)、[Skill 选择](../apps/service/test/isolated/skill-selection.test.ts)及[扩展升级](isolated/unified-agent/extension-upgrade.test.ts)对应发现、许可、子 Run 继承及版本恢复。 | [全工具实际调用入口](e2e/live/model/model-tools-all.live.ts)包含 31 个固定工具加动态 MCP、9 个基线场景，只接受 Windows/macOS，当前 runner 无有限总预算。后续在本机原生用例加预算并逐工具核对效果。 |
| MCP 工具发现、撤销、凭据与原生 stdio 生命周期 | [打包默认源](../apps/service/test/isolated/mcp-source-packaged-default.test.ts)与[Linux 子进程归属](../packages/agent/test/isolated/mcp/linux-owned-program.test.ts)检查连接、调用、撤销与停止。 | 三系统 stdio 日志需包含所属子进程启动和退出；[真实 keyring 用例](isolated/unified-agent/native-credential-platform.test.ts)访问原生存储，Linux 用私有 D-Bus Secret Service。独立的 MCP 协议与认证作业使用项目自己的 MCP 端点和固定模型。 |
| 浏览器、Web、文件、工作区与可追溯产物 | [Browser 授权](../apps/service/test/isolated/browser-permission-composition.test.ts)、[撤销](../packages/agent/test/isolated/browser/host-revocation.test.ts)、[Web fetch](../apps/service/test/isolated/default-web-fetch.test.ts)、[Artifact 流](../apps/service/test/isolated/artifact-stream.test.ts)和[轨迹访问](../apps/service/test/isolated/trajectory-evidence.test.ts)覆盖授权、来源、流读取及失效。 | 真浏览器的导航、会话、下载、撤销后副作用，需在每个支持的实际产品入口观察。文件原生后端和 Windows 重解析点需要本机 OS 对象。 |
| 图片、PDF 与 Office 交付 | [输入图](../apps/service/test/isolated/input-images.test.ts)、[Office 技能资产](../packages/agent/test/isolated/tools/documents/office.test.ts)、[XLSX 多表/公式预览](../apps/desktop/test/isolated/officecli-xlsx-preview.test.ts)、[预览边界](../apps/desktop/test/isolated/office-preview-security.test.ts)分别核协议、包内容、预览模型及访问。 | 图片/PDF 本地真模型套件核模型准确读出夹具。Office 需记录原件 SHA、交付目标与可解析归档，逐项比较 Word 段落、Excel 目标单元格/公式/样式、PPT 页/形状，再核支持的实际 Native 预览。Windows Luna/high 原始记录有 94 次 HTTP 200，Word 当轮缺交付、Excel 交付未改副本；后续局部复验及仍缺的验收见 [Documents owner](../packages/agent/src/tools/documents/README.md)。 |
| Windows/macOS 桌面客户端 | 两个宿主都运行[文件编辑窗口](../apps/desktop/test/file-ui-electron-runner.fixture.ts)，实际启动 sandboxed Electron BrowserWindow，核对生产组件从编辑／写入、加载、失败、重试到回读的过程，使用合成 bridge 和 Provider。两个宿主各自运行[浏览器页面与窗口归属](../apps/desktop/test/isolated/native-browser.test.ts)、[窗口重启后偏好恢复](../apps/desktop/test/isolated/native-model-preference-electron.test.ts)和[图像解码与真实像素](../apps/desktop/test/isolated/native-image-display-bundle.test.ts)。Windows 另核[原生 Office 文件历史和权限](../apps/desktop/test/isolated/windows-office-editor.test.ts)；macOS 另核 [Electron preload、Service 刷新及关闭](../apps/desktop/test/isolated/native-electron.test.ts)。 | 每个宿主有独立退出状态和证据。真实用户会话中安装、系统对话框、键盘输入、最终文件交付和重启仍需实机复验；两种宿主上的 fixture 通过只覆盖对应断言。Linux 上的 JSX、DOM、CSS、SDK 与打包测试提供技术回归证据。 |

## 工作流与检查名

| 工作流 | 触发、输入与证据 |
| --- | --- |
| [Required](../.github/workflows/required.yml) | 所有 PR 对合并 SHA，push 到 main、compact、man、el-refactor 对 push SHA。`quality`、`unit`、`compaction-contract`、`runtime-e2e`、`runtime-fault-soak` 保留；`protected-branch` 仅适用于 man ref。八个 `unit (N/8)` 分片全部成功才通过 `unit`。桌面作业分别上报 `Desktop client (windows-2025)`、`Desktop client (macos-15)`，各自归档窗口截图、断言报告和执行日志。原 TUI 聚合及四个 TUI 状态名退出现行 Required。fault 失败后仍按原条件收集有界诊断，缺证据会导致失败。 |
| [Execution Boundary Artifact Conformance](../.github/workflows/execution-boundary-conformance.yml) | 相关路径 PR / 手动，三 OS。四个共用整文件，macOS/Linux optional 和 macOS native protection 各回所属主机。原 `execution-boundary-negative-conformance-<os>` 改含执行日志；此前消费其中 `platform.json` 的人改取下一行产物。 |
| [Platform Capability Probe](../.github/workflows/platform-capability-probe.yml) | 相关路径 PR / 手动，三 OS。构建当前 checkout 的 Terminal，搬出源码运行，诊断校验并归档 `platform-capability-<os>/platform.json`。手动运行额外执行 formal verifier。 |
| [OSS Release Candidate](../.github/workflows/release-candidate.yml) | 所有 PR / main push / 手动。PR 使用贡献者 head 仓库及 SHA，保留三个 `candidate-<target>`、安装/升级、Terminal/Native/Desktop 与 formal 断言。合并 SHA 与 head 的二进制不可互作证据；本次只去掉执行边界工作流对同一 merge SHA 的重复构建。现有 formal 会拒绝当前 packet，PR 也会显示 release 失败。 |
| [Runtime stdio smoke](../.github/workflows/runtime-stdio-smoke.yml) / [Runtime transport qualification](../.github/workflows/runtime-transport-qualification.yml) | 各自按路径 PR / 手动，三 OS。前者保留 stdio 与 paired 生命周期日志；后者核 Service 恢复、锁、交接。Windows 目录记录解码各主机均执行，实际 NT 目录句柄仅 Windows 执行。 |
| [Session Log ACL Smoke](../.github/workflows/session-log-acl-smoke.yml) / [MCP native keyring smoke](../.github/workflows/mcp-native-keyring-smoke.yml) | ACL 使用相关路径 PR / 手动并保留证据；keyring 用相关路径 PR、main push 或手动触发，各平台实际访问其凭据后端。 |
| [MCP conformance](../.github/workflows/mcp-conformance.yml) | 相关改动 PR 和手动运行 `MCP protocol and authentication`。隔离本机 HTTP 服务、固定模型与真实 SDK 产生 `mcp-conformance.json`；Linux 核查十个协议、权限与认证整文件。macOS 单独跑资源与提示整文件，要求默认 stdio 的真实连接、完整模型内容和持久记录实际通过。各自归档 JUnit 并检查计数、缺项、跳过和失败。 |
| [Runtime Resilience Qualification](../.github/workflows/runtime-resilience-qualification.yml) | 仅手动；Linux 固定八轮、至少 60 分钟、原验证器和原报告。单次 CI 诊断以及多次强杀的 replay smoke 各有独立证据范围。 |

### 本地清单与 Required 的边界

`bun run test --list` 对应原来的完整本地计划，含十个 workspace、mini-review、isolated unified-agent 与十三个显式根文件。`KITE_TEST_SCOPE=required-agent bun run test --list` 列出 Linux Required 的实际文件；加上 `KITE_UNIT_SHARD=0/8` 选择其中一份，去掉 `--list` 实跑。本次清点为本地 1,445 个文件、Required 1,299 个。两者相差 146 个：CLI 61、UI 的 TUI 专属目录 62、独立 Web 11、桌面窗口 4、根隔离用例 8。八份合起来覆盖所选范围，并保留原来的隔离／独占策略。Web 资产哈希、终端目录记录解码、MCP 的私有记录及制品读回仍有独立合同。Service HTTP/paired/lifecycle 与 Client SSE 继续由六文件 `test:e2e` 验证，六文件 `test:runtime:fault` 继续检查故障与恢复。[默认计划](../scripts/unified-test-plan.ts) · [根命令](../package.json)

TUI 专项旅程和界面回归移出 Required 的独立分片与 Linux 默认范围；本地 `bun run test:tui:system --list` 和 `bun run test:tui:system` 仍枚举、诊断同一批用例。独立 Web 客户端不计入本轮桌面验收。供 Agent 使用的网络工具、公共 Client SDK、Terminal 安装与资产、跨调用方恢复和故障处理继续按原合同验证。

仍有三处会实际触及终端界面。打包故障／长跑报告固定含 [`tui_lifecycle_churn`](../scripts/runtime/unified-soak-cases.ts)，必须观察 PTY、输入、退出与焦点循环。按路径触发的 [transport qualification](../.github/workflows/runtime-transport-qualification.yml) 仍核旧调用方的操作与冷恢复，包含显式的 TUI 整文件。发布候选仍要求 [Windows 已安装 TUI](fixtures/unified-agent/windows-installed-tui.qualification.ts) 与 [Terminal/Native 注册切换](fixtures/unified-agent/native-terminal-split.qualification.ts)。这些结果继续约束各自的传输、生命周期或发布声明。拆除其中任何必需证据都需要单独修订对应合同。

## MCP 返回与认证

- [本机 smoke](../scripts/runtime/unified-mcp-smoke.ts) 通过 Client、Service、Runtime 和两个独立的 Streamable HTTP 来源，区分同名工具；检查原执行与参数、成功的文本和结构化返回、远端工具失败和 JSON-RPC 错误的未知结果。另核 `resources/list`、`resources/read`、`prompts/list`、`prompts/get`，来源释放或过期后旧句柄不再发送请求，新连接重新发现。[资源与提示 Service 整文件](../apps/service/test/isolated/mcp-resources-prompts.test.ts)覆盖正常公开路径的落库与回读。
- MCP server 认证与模型 Provider 认证分别核对。项目自有 HTTP peer 校验合成 Bearer，分别观察有效、缺失与错误凭据，查验可公开读取的状态与结果。[静态凭据](../apps/service/test/isolated/mcp-source-configuration.test.ts) · [凭据作用域](../apps/service/test/isolated/mcp-credentials.test.ts)。OAuth 的注册、PKCE、回调、冷恢复、提前刷新、拒绝／无效刷新和撤销沿真实 SDK 与 loopback 授权服务验证。在第一次 HTTP 401 后显式批准登录，冷连接完成时旧工具调用数仍为零。此后另行提交并批准的新 Run 必须携带正确凭据，向对端恰好发送一次参数完全匹配的工具调用并落库；公开结果和模拟 Provider 请求均检查隐私材料是否泄露。[OAuth Session](../apps/service/test/isolated/mcp-oauth-session.test.ts) · [连接与认证](../apps/service/test/isolated/mcp-source-oauth-integration.test.ts) · [token 端点](../apps/service/test/isolated/mcp-oauth-network.test.ts)。
- stdio 端的进程所有权、退出、平台约束与原生凭据库仍各有独立断言。HTTP OAuth 的结果不用于判断 stdio 的凭据或真实桌面登录体验。旧版定时公网服务 smoke 已移除，现有本地真模型与 Provider 认证入口保持原有用途。

## Actions 之外的真模型验收

真实模型保留本地/桌面入口。现有根命令为 `bun run test:model:tools:live`、`bun run test:model:image:live`、`bun run test:model:pdf:live` 和 `bun run test:model:collaboration:live`；四项对应的显式开关是 `KITE_RUN_LIVE_MODEL_TOOLS`、`KITE_RUN_LIVE_IMAGE_VISION`、`KITE_RUN_LIVE_PDF_VISION` 和 `KITE_RUN_LIVE_COLLABORATION`。本地使用隔离模型配置、合成工作区及新的绝对输出路径，冻结安装后运行 `bun run build` 准备图片/PDF worker。工具场景上限为 20 次/240 秒，图片、PDF 各 5 次/120 秒；协作入口显式选择组和用例（例如 `--group=unified-inbox --case=U01-active-unified-inbox`，40 次/600 秒），U01 的机器断言通过后仍有语义审阅。保留套件退出、模型和场景、实际请求数、业务断言及清理结果，超时或缺配置不能计入接受。[本地真模型说明](e2e/live/model/README.md)和[macOS Electron 窗口入口](e2e/live/model/collaboration-unified-native-window.live.ts)列出具体条件。GitHub Actions 的 Provider 夹具、确定性 replay、本机 MCP 协议套件各按自己的实际对象提供证据。

## 迁移与尚缺的资格证据

- 基线 [Required #537](https://github.com/ferqx/kite-code/actions/runs/44472063151) 有 8 项失败、2 项成功、1 项按条件跳过且没有 artifacts；当时最近二十次为 18 次失败、2 次取消。压缩和 workspace_changes 仍由所属 Agent 检查报告；旧 TUI 清理失败保留在历史证据中，可经本地 TUI 诊断复现。八分片的时间预算和 hosted 运行成本要在实际 PR 上量测。
- 检查名迁移：`tui-system`、`tui-system (0)` 至 `tui-system (3)` 退出 Required；新桌面状态分别对应 Windows 和 macOS。2026-11-19 公开 [main](https://api.github.com/repos/ferqx/kite-code/branches/main) 与 [el-refactor](https://api.github.com/repos/ferqx/kite-code/branches/el-refactor) 显示未启用保护、required contexts 为空；compact 和 man 查询为 404，仓库唯一公开 ruleset 已禁用。本次匿名详细保护接口返回 401。若另有外部合并规则绑定旧名，仓库维护者需在启用变更前迁移相应规则；此次只改工作树。
- [平台验证器](../scripts/release/unified-platform-verify.ts) 在 formal 模式始终记录 `default_effectful_platform_not_qualified`，当前 probe 的 effectful/production 均为 false。要推进资格需提交准确 OS、backend、已安装产品、默认能力和进程树的真实证据，处理诊断中非 Darwin 默认 Shell 假设与 Service 条件后端的差异。本次 Linux 搬迁保留清单要求的空 Git hooks 目录后，实际子进程到达原 Shell 断言，仍报 `default_shell_gate_not_closed`。该机尚无通过的平台诊断。
- [长跑数据模型](../scripts/runtime/unified-soak-report.ts)保留 `descendant_identity_qualification_not_implemented`，Linux 尚缺活动资源、句柄、后代身份、后台 Shell 及平台工作负载证据。完整时长内未观察到故障仍会按[收集器](../scripts/runtime/unified-soak.ts)给出 inconclusive。先实现平台观测与身份核对，再按原阈值收集。
- 性能用专用、可信的手动运行记录相同候选、主机、模型、并发度、预算和输入的延迟分位数、吞吐、错误及内存。现有 [Provider load](e2e/live/model/provider-load.live.ts)、[审批复用](e2e/live/model/approval-reuse.benchmark.ts)和[图片读取](e2e/live/model/image-reading.benchmark.ts)是独立入口；尚无经过校准的跨机基线或自动性能放行。Office 交付、全工具预算、真实桌面交互优先沿上表已有入口补证。
