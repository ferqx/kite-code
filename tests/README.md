# 测试体系

本页负责当前测试归属、发现和执行。当前默认为精确八个新 workspace；下面单列的历史机制和原资格记录不参与新默认调度，也不证明当前产品或平台通过。

## 环境基线与 owner

Required CI、release/platform 与正式 soak 固定 Bun 1.4.2。性能或稳定性结果只适用于准确代码、运行时和平台；workflow 定义不等于执行证据。

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

原[默认装配HTTP](../apps/service/test/isolated/assembly-http.test.ts)在同一授权放行前后核source freshness和已受理Run的原能力绑定。[所属Service夹具](../apps/service/test/fixtures/assembled-child.ts)用可取消的文件存在等待消费原release，timer／abort listener均清理，不依赖目录通知；原5秒期限和全部断言保持。失败观察复用原Command／View读取，不增加GET或修改生产权限。原Native基本文件的第三诊断driver阶段通过stdout单次透明读取转发，原字节仍交完整输出断言；观察不抵消真实超时，准确原红与复验归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

[PC 文件变更迁移](../apps/desktop/README.md#原文件变更面板与编辑器)沿原完整 Native 窗口夹具新增文件侧栏、编辑器选择、关闭与冷读断言；默认 Service 真实 Files 回执来自原本机 Provider fixture，不替换 Main/preload/renderer。另由 Files 的 change-preview、Native 的 file-changes 端口和隔离 DOM 文件验证实际 pre/post、精确关联、原 UI 入口与读取释放；端口 callback 不冒充 OS 编辑器窗口，窗口按钮不冒充完整安装／跨平台资格。实际运行与失败归同一[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原文件变更与编辑器入口迁入)。

原 PC 消息路径与常规摘要沿同一 Native 整窗口核首次／冷读、真实缺失文件拒绝、默认配置与 Provider 次数保持；隔离 original-entries DOM 核准确作用域、临时选择分离和原 Markdown 的预览／全文／关闭，文件端口另核已观察 Message、普通目标与派发前 frame。完整证据与未实际启动 OS 编辑器的边界归 [Native owner](../apps/desktop/README.md#原消息文件路径与常规摘要)。

## 默认执行与隔离

根 `test`、`test:all` 和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)。它只发现上述当前 owner 与有限的 root 脚本安全列表，不扩展到整个旧 integration/qualification/release/e2e/golden/TUI 树。纯 `--list` 不创建 Profile、Provider 或子进程。

普通测试与安全 isolated 文件使用共享槽，isolated 每文件独立进程且进程内 concurrency=1；编译、SIGKILL、全局资源和准确分类的 exclusive 文件在并行队列 drain 后逐文件执行。macOS 最多4槽，Linux最多2槽；Windows isolated 逐文件串行。失败停止新派发，已启动任务完成 cleanup。每个测试进程使用独立临时 HOME/USERPROFILE 和准确 KITE_CODE_HOME，清理只覆盖自有目录。

共享队列仍支持调用者声明的 `firstFiles`，保原源码大小／label排序及派发机制。当前 [unifiedTestPlan](../scripts/unified-test-plan.ts) 将[Terminal PTY完整读取与导出](../apps/cli/test/isolated/tui-export-host.test.ts)、[完整CLI登记生命周期](isolated/unified-agent/cli-registration-lifecycle.test.ts)、[真实Native代码升级／回滚](isolated/unified-agent/native-cross-version.test.ts)、[完整Native安装生命周期](isolated/unified-agent/native-install-lifecycle.test.ts)、[安装版恢复交接](isolated/unified-agent/native-restore-interruption.test.ts)和[封闭Terminal安装制品](isolated/unified-agent/terminal-bundle.test.ts)六个准确文件列为独占，在所有concurrent job drain后逐个执行。完整661文件／522job仍各一次，macOS4／Linux2槽、逐文件进程／进程内1和所有原行为断言保持；Windows本来独占，不重复计数。CLI登记／Terminal安装整例120秒及child30秒／20秒，Terminal PTY导出90秒／步骤30秒，Native跨代码420秒／driver120秒／页面15秒，安装生命周期120秒／driver45秒／launch与页面10秒，恢复180秒／driver45秒／launch与页面10秒均不放宽。[实际runner测试](isolated/scripts/test-suite-runner.test.ts)保优先／并发上界／失败drain反例及独占等待退出；默认计划核全集恰好一次及六文件仅在exclusive。调度不证明产品负载延迟，取舍归[受控并行Note](../.agents/notes/implemented/testing/2026-09-28-controlled-parallel-isolated-tests.md)。

原安装生命周期在当前并发默认中，第一次安装直到89.420秒结束，随后用户链被整例期限截断；保留原红和阶段证据后才纳入现有大型制品独占分类。源码外构建、压缩、解包、逐项sync、所有内容校验和最终升级／冷读／回退／保数据卸载仍实际执行。原四路中的基本窗口、问卷和其他普通任务继续受控并行；本分类不能证明四路安装性能或RSS／完整资源资格。真实结果归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)，此前恢复分类的失败归[扩展能力进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。

维护的[Core备份](../packages/agent/test/isolated/maintenance/backup.test.ts)与[Desktop资产](../packages/agent/test/isolated/maintenance/assets.test.ts)在首DB前用[真实引擎夹具](fixtures/unified-agent/qualified-sqlite-fixture.ts)复用正式SQLite builder和公共initializer，核完整资产及发行身份；原业务预算不变，新增setup hook有限60秒。文件最后DB关闭后清理自有selected资产，外部preload资产只复验；loaded selection不能reset，因此这些文件沿原isolated每文件独立进程运行。[独立默认Source资产文件](../packages/agent/test/isolated/maintenance/mcp-source-approval-intents.test.ts)实测默认engine身份，并核严格关闭后实际Core DB/WAL/SHM的presence与完整bytes在create/inspect后保持。两个范围分别记录，单文件绿色不构成完整默认或三平台资格。

## 当前公共场景与证据

Native公共扩展的[实际HTTP链](../apps/desktop/test/isolated/native-extensions-main.test.ts)、[原组件DOM](../apps/desktop/test/isolated/native-extensions-dom.test.tsx)、[真实Node维护](../packages/agent/test/isolated/maintenance/desktop-extensions.test.ts)和[安装版整窗口](../apps/desktop/test/isolated/native-extensions-bundle.test.ts)各核正式消费者的对应边界。窗口以hash前固定参考装配完成source→analyze→完整findings→原mark→新business key和冷GET，不增加默认业务；格式只在首次泛型caller保存升DB9／v18，旧grammar拒绝保持。准确结果／失败与完整回归归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)，局部通过不关闭完整PC、资源或最终退役。

[恢复交互历史](isolated/unified-agent/client-interactions.test.ts)复用原真实 Core／配对 HTTP／SDK／Native Main，保存问题、计划修改反馈、child 审批、取消和完整原附件后明确备份恢复。首次与冷只读保公开请求／答案／accepted revision／原出处，原待办按维护结果取消；默认当前列表空、旧卡回答拒绝、原 Store 准入拒绝、Fork 不补来源后来记录、附件原 metadata／完整 hash／EOF及零新水位／Model分别核对。Native Main／原 DOM和原待决分页七文件33项758断言通过。[现有 installed 问答窗口](../apps/desktop/test/isolated/native-restored-questionnaire-bundle.test.ts)只补同一原交互历史的首次／恢复／冷读与 Fork 空记录，保全部原行为断言和120／45／10秒预算；actual0／1pass／24Bun和全部driver／77.95秒。原公共 schema 选项 ID／自由文本对象与 Tool 标签回执分开核实，不把通用 Interaction 猜成默认问答的显示结果。其他 installed 计划／审批和全阶段资格不从本片推导，准确失败归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后完整交互历史)。

[恢复后已回答问答](../apps/desktop/test/isolated/native-restored-questionnaire-bundle.test.ts)复用原 Questionnaire／ToolRow，在搬迁并 installed 的默认 Native 中保存一次真实选项和完整 Unicode／换行自由文本，明确 Fork 后通过包内 CLI 备份恢复为新 Store。三个 macOS 窗口核源会话／分支的原消息、问题、答案、Execution／Run／Store、首次与冷读、切换清理与三次 Service 普通退出／双 EX；原 answer POST 一次、Provider 两次，阅读 POST 与封存来源 Run GET 为零。只读 fetch 观察保原 HTTP 回应和消费者，120秒整例／45秒driver／10秒页面期限保持。[Core 冷出处](../packages/agent/test/isolated/context/restored-origin.test.ts)、[Service 投影](../apps/service/test/message-response.test.ts)和 Main／原 DOM 核各自边界；准确输入、实际失败与未验范围归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后已保存问答回执)，不代证取消问答／审批的全部恢复或整阶段退出。

[恢复后封存Model正文](../apps/desktop/test/isolated/native-restored-output-bundle.test.ts)通过搬迁并installed的完整Native候选、默认Main／Service／preload和原UI生成一次大回复及明确Fork，退出后用包内CLI备份恢复为新Store。三个真实macOS窗口核108031字节原内容／SHA／CRLF／出处、恢复首次与冷读、关闭／切会话清正文、原source复制资格与三Service普通退出／双EX释放；读取阶段零业务POST、Provider总数1。只读fetch观察不改请求／响应；120秒整例、45秒driver和10秒页面期限保持。Service投影、Main原Model资格与共享组件由[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后封存-model-正文)记录，未验组合不从本片推导。

原四项[退出收尾](../apps/desktop/test/quit-settlement.test.ts)与函数逐字迁入当前 owner；[caller 检查](../apps/desktop/test/native-caller.test.ts)核完整目录／View 的所属 signal、超时未知和零业务写入。原[macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)保全部原任务／冷读／双锁断言，随后用同一不可变源码外候选运行[退出 driver](../apps/desktop/test/native-quit-electron.fixture.ts)：实际关闭与 activate 保草稿，所属 Service SIGSTOP 后两秒到未知确认，取消后继续；扣住 Node child 完成通知后实际等原二十秒，有限 dialog 响应明确强退，核 Main exit1／所属 Service 终态／双 EX 可取／零 Model 重放；另以实际 SIGKILL 核非零 Service 不判正常收尾、明确异常提示和退出。该通知 fault 不代表真实 Service 全故障矩阵，dialog callback 不代证 OS 窗口点击；原 120秒整例、各45秒driver与10秒页面预算保持，新增警告观察上限30秒对应二十秒产品机制。实际结果归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原窗口关闭与退出收尾)。

原[窗口 IPC](../apps/desktop/test/native-window-ipc.test.ts)核文本原文、1 MiB UTF-8 边界、闭合 payload、准确 frame 和零业务 caller；[实际 Native header DOM](../apps/desktop/test/isolated/native-window-actions-dom.test.tsx)核左键／双击／控件过滤、双栏回调、失败提示与草稿保持，原轮次 DOM 保完整正文复制门禁。原[源码外 macOS 整窗口](../apps/desktop/test/isolated/native-bundle.test.ts)使用实际 Main 系统剪贴板核首次／冷读正文，浏览器 fallback 明确抛错；[JXA 保护进程](../apps/desktop/test/native-clipboard-guard.fixture.jxa)在内存保留原剪贴板各格式，stdin EOF 时恢复，不向日志或文件导出内容。header DOM 回调核实际 BrowserWindow 的 maximize／unmaximize，不代证物理双击或拖拽；保原任务、审批、冷读、双锁收尾与 120／45／10 秒预算。准确结果与未验范围归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原消息复制与标题栏缩放)。

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


[默认 macOS host Shell](../packages/agent/test/isolated/jobs/macos-host-shell.test.ts)核真实宿主/fork/setsid、Full/Workspace写、保护根/准确祖先、网络、父退出及注册清理；[源码外默认消费者](isolated/unified-agent/formal-optional-capabilities.test.ts)与[平台报告](isolated/unified-agent/unified-platform.test.ts)核普通默认Provider/Job和cold输出零重放。[默认 continuous](isolated/unified-agent/unified-default-shell-continuous.test.ts)保原两cycle40Command、全部业务断言与180秒预算，并核两个实际Service的独立资源／出生身份／原退出及cold收据；字段缺RSS或原身份仍存活不能取得这项证据。新默认 producer 还严格消费原 Shell 的 startup／terminal 交接：原根 WNOWAIT／waitpid、coalition／registration 与 broker 真正 exit/close，cold核完整原result和启动身份；原整例以真实40个Job核这份证据和缺broker reap拒绝，不扩故障矩阵。原450秒formal组件另由[固定producer](fixtures/unified-agent/soak/continuous-default-shell.ts)运行，两个边界不代九点／全部Runtime后代；并行计算区间取并集，不能加构建/空闲/重复时间取得资格。Win/Linux实际验证依用户选择在重构完成后交给GitHub Actions，平台skip不计原生通过。

[Profile MCP 恢复](isolated/unified-agent/profile-mcp-restore.test.ts)沿原 isolated共享槽，使用公开 builder/install与默认 Service，删除原 candidate后通过实际 installed CLI create/inspect/restore A→B，公开 Client核原 C/E、Core Question原行、当前来源准入、新 Question和显式 owned stdio连接／停止；冷 GET-only／cursor保持，Model0，原项目文件／配置／opaque refs保持。credential transport未派发，不证明 OS Vault／OAuth。对应[raw资产](../packages/agent/test/isolated/maintenance/mcp-configuration.test.ts)和[实际 Node DB7](../packages/agent/test/isolated/maintenance/desktop-mcp.test.ts)分别核 private/proof/absent／旧白名单及 v15/v16真实物理恢复；旧无 MCP文件的来源变更PTY仍为 v12。完整默认与有限结果单列于当前进度。

该原恢复整例另核 stdio broker／launchd guardian／server 的原Job六字段绑定、实际PPID和微秒出生，原 progress／terminal保存准确三种角色与coalition树证明。只有broker／server记录实际父方exit／reap；launchd guardian的exit保null，准确清理后核kernel absence。源码外整例保原一次Tool／取消／维护A→B／cold完整结果、输出和零重放；installed原恢复整例保Service退出／cold GET／cursor及Provider0。[原stdio整文件](../packages/agent/test/isolated/mcp/stdio-port.test.ts)保原7cases和期限，唯一自然exit例增加真实setsid／reparented grandchild，认证前broker强杀检验本次未启动注册清理；不新建故障矩阵。共享helper另复验原完整macOS宿主Shell，保held-root合同。旧v1冷JSON语义保留，MCP完整所属树仍不能充作全部Runtime后代或资源增长资格；实际记录归[MCP owner](../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)及[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-完整所属进程树与旧组路径退役)。

通用 Agent V1.3 的当前切片通过 `bun run test:unified-agent` 验证：新包 owner、真实 HTTP/SSE 与双 Service、外部计数工具/mini-review、[两真实进程](isolated/unified-agent/persistence.test.ts)、取消、来源刷新、显式恢复与[目标依赖边界](isolated/scripts/unified-agent-boundary.test.ts)。runner 复用默认 isolated/exclusive 分类，编译与强杀场景按逐文件隔离运行。新 `ai/agent/client/ui` 与 `apps/service/cli/desktop/web` 已纳入默认发现和 build/typecheck，根正式/default/CI已选择新闭包，原客户端测试仅作历史参考；完整能力替代与平台仍待验收。平台、完整交互、维护恢复与制品结果按[进度](../docs/plans/unified-agent-refactor-v1-progress.md)记录，部分子场景不代表完整 T/E 场景通过。

[未见 label-station 样本](isolated/unified-agent/evolution-unseen-sample.test.ts)由独立 owner 在公共接口固定后选择并实现，只有独立 manifest、资源、实现和测试。实际 manifest 构建到源外，以公共包消费真实通用 DOM 卡片→Client HTTP→无模型 Action→受控 Tool→自有 CAS 回执→Query→第二次明确操作；先等原 Execution 终态核 Action/Tool 两种拒绝零效果，两次允许效果与原 parent/rootWork 绑定，Model/Run为零。六文件 diff 和12个核心/公开基线 hash 未变支持本机有限 E01/E02/E03/E14，完整 Evolution Record 与未验证范围保留在[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-04mcp-冷原申请备份-v8-与未见扩展样本)。此处不是全部核心冻结、独立 npm 安装、实际浏览器布局或全部 E01–E14 通过；异常初始化/cleanup 由20秒所属 child kill/await 与临时根清理兜底，绿色运行不证明所有异常路径逐资源 close。

新的 [Browser SDK](../packages/client/test/browser.test.ts)、[Web controller](../apps/web/test/controller.test.ts)与 [Service 配对](../apps/service/test/isolated/development-web.test.ts)分别验证网络合同、视图代次及实际 Core/SQLite 的只读生命周期。Desktop 输入的 [意图](../apps/desktop/test/input.test.ts)与[配对](isolated/unified-agent/desktop-input.test.ts)使用固定 Model/临时新 Store，不接触用户数据。大人工附件的 Client、UI DOM 和便携 Desktop 测试分别证明完整字节/hash、显示后的键盘答复门禁及跨视图证明失效，不能合并声称正式 Electron 或原生浏览器已通过。

[CSP 回归](../packages/client/test/isolated/csp.test.ts)将真实公共 BrowserClient bundle 放入真实 Node V8 的禁用代码生成环境，验证静态生成规则的 closed 请求、嵌套响应和新增字段保留；它不是浏览器布局证据。[Web 预览夹具](fixtures/unified-agent/web-preview.ts)先构建 `apps/web`，再显式启动临时 SQLite、固定 Model 和只读 Cookie Gateway，stdout 仅返回页面 endpoint/identity 与固定计数，不输出 Native token。stdin `append` 只添加一条预定消息，`stop` 结束并清理临时数据。macOS IAB 的实际选区、复制、滚动及诊断结果由 Web owner 和进度记录；没有外部 Provider 或用户 profile。

[独立开发 Web 启动测试](isolated/unified-agent/web-launcher.test.ts)固定已选 profile/配套 entry/API/capabilities 与校验过的资产，经公开 paired Service 和只读 Gateway 验证。有限参数、stdout 仅 endpoint、坏资产零新 profile、浏览器关闭后原 Model 继续，以及真实宿主 EOF/SIGTERM 后所属 PID 和 TCP listener 消失分别断言。隔离 fixture 使用无害固定 Model；不替代正式 daemon/TUI/Electron 或发行安装资格。

[完整 installed Terminal 生命周期](isolated/unified-agent/terminal-bundle.test.ts)保原 120 秒测试预算和全部原断言，平台临时根改用 `tmpdir()`；新增 Linux 分支在实际候选内运行[公共 Store reader](fixtures/unified-agent/terminal-bundle-store.ts)，其裸 imports 只解析 installed node_modules。两个 Worker 的 24 次 WAL 写入、实际 installed maintenance backup/inspect/restore/status 与 cold 原历史/config/fencing 在原最终卸载断言之前执行。升级候选仍是同源码版本指针；当前 Ubuntu x64 仿真实测不代替 Linux 跨代码、原生 CI 或其他平台。准确有限证据归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-当前-terminal-安装与维护链)。

[原完整 Native 安装生命周期](isolated/unified-agent/native-install-lifecycle.test.ts)现覆盖 macOS/Linux，保原120秒整例、45秒driver和全部原断言；平台临时根/发行目录/ps列与明确.mjs支持Linux。driver显式开启Chromium sandbox，并核两次实际窗口安全选项和无no-sandbox；只转发显示环境。当前原生Linux arm64有限实测与x64仿真失败分别保[Native owner](../apps/desktop/docs/native-release.md#linux-arm64-安装生命周期)。release-candidate执行Linux整个文件，Required unit在Xvfb内执行完整默认图，CI守卫拒绝移除/过滤/echo/错平台或静默入口；定义不作为hosted结果。

该安装用例从实际第一候选的完整Terminal制作原同基线版本输入，以独立输出目录构建第二真实候选，与第一候选的归档／搬迁核验重叠；两支全部settled之后才删除原源，任一错误保留并等待另一支。原SQLite probe、全部内容校验、两层digest和用户生命周期不省略；两个窗口在真实会话navigation内严格选择同名会话。prepare阶段观察不扩大原120／45／10秒期限，实际结果与剩余失败归[制品收束进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

[安装版 PC 恢复中断](isolated/unified-agent/native-restore-interruption.test.ts)补 macOS 默认入口在旧 Profile 已移走时的拒开与明确 complete。它复用 source 的现有观察点和候选内 Bun／所选引擎作 fault publisher；真实第二进程是未修改的 installed Main／配对 Service，[窗口 driver](fixtures/unified-agent/native-restore-electron.ts)核持锁／SIGKILL 后两次业务准入拒绝、未建空库、稳定锁、installed status／reconcile 和同窗重新加载原 Session。原 Core 七个中断窗口不重复扩为 PC 矩阵；新例独立180秒、driver45秒、窗口10秒，不改既有预算。普通退出／候选双 EX／实际卸载保数据与 Provider0保持；这一条不覆盖 installed restore 自身全部中断点、rollback、其他平台或完整 W19。准确证据归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08安装版-pc-恢复目录缺失边界)。

[Terminal 跨代码版本](isolated/unified-agent/terminal-cross-version.test.ts)由[固定旧提交夹具](fixtures/unified-agent/terminal-predecessor.ts)调用其原builder，当前固定复用PC展示层后的DB7原提交a2b6441f，与当前源码分别生成完整候选；原Mac3140／Linux1b796只保其历史锁输入和证据。两候选保持同一productVersion、锁输入和SQL基线，搬迁后删除旧source与原输出。实际安装CLI/daemon A→B→A→B核同原Store、新正文完整读回和进入回退后的新模型请求、冷只读零重放、准确普通停止/EX及卸载保数据；[reader](fixtures/unified-agent/terminal-cross-version-read.ts)的裸imports只解析各自安装候选。它沿原isolated每文件进程/进程内concurrency=1，共享默认槽且不修改当前实现源码；Required unit完整history缺固定旧commit即失败。release candidate在macOS/Linux另运行整文件并守卫准确命令。本地代码比较不是已发布旧fixture或三平台资格；Mac原证据归[原进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07terminal-真实代码升级与冷回退)，Linux完整链归[本轮进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。

[Native 跨代码版本](isolated/unified-agent/native-cross-version.test.ts)在同一旧提交夹具中明确选择旧 Native builder，再由实际 installed `bin/kite-desktop` 驱动 A→B→A→B 四个默认窗口。当前实现仍留在 durable checkout；临时 clone 只构建原旧代码输入，完成后删除源码。外部[readonly probe](fixtures/unified-agent/native-cross-version-store.ts)只解析当次安装 inner 的公共 Store/引擎；[窗口 driver](../apps/desktop/test/native-cross-version-electron.fixture.ts)的纯读取 verifier 纳入自身闭包，Playwright 使用已安装 harness 依赖，产品不依赖该 driver。小回答核真实内联全文，大正文点击原完整读取按钮；各自 Main/HTTP 完整快照、原 scope/hash/ref、冷 GET 游标/Provider、持久 caller 与当前 hot 输入分别核对。四次普通退出、全部候选双 EX 与代码指针/卸载的数据保留属于本机有限资格，不替代已发布 predecessor/T029、其他平台或整个 §35；当前阶段结果归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-真实代码升级与冷回退)。macOS现于第四B窗口沿原侧栏产生实际DB8 unknown原申请，再用同一安装候选完成两个独立冷窗口：原DB7版本拒绝私有存储且保原bytes／inode，兼容Core历史仍完整只读；切回当前版后明确原GET查回，无新POST或Model。最终统一卸载保数据，六Service普通退出，整文件1／513／actual0／320.79秒；准确范围见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-db8-真实代码回退)。原同源码 Native 生命周期及其 signal 故障断言保持不变。

该Native跨代码文件同时执行macOS/Linux，当前沿固定a2b6441f前驱；以下Linux结果仅属此前1b796锁输入和源码，当前组合留待重构后的Actions。Mac两项前端差异断言保持；历史Linux完整安装链核真实Agent差异，当时Main hash不同、renderer相同。driver使用manifest executable、明确ESM和平台ps，四次窗口均核Chromium sandbox。Linux arm64整文件374条Bun断言/actual0/171.298秒，原420秒整例、120秒driver和15秒窗口期限保持；准确范围归[Native owner](../apps/desktop/docs/native-release.md#linux-真代码升级与冷回退)。release candidate分平台调用整文件，Linux使用Xvfb，guard拒绝关闭/错平台/echo/过滤/缺显示；hosted与完整资格仍需实际结果。

[Model Inspector Core](../packages/agent/test/isolated/model-input/inspector.test.ts)、[Client 完整流](../packages/client/test/isolated/model-input.test.ts)、[实际 Service/Gateway](isolated/unified-agent/model-input.test.ts)和[Web DOM](../apps/web/test/model-input.test.tsx)分别验证准确原调用、完整交接和展示。>200 目录压力通过具名 Store 建立 planned intents，不称发生了相同数量的 Provider 调用；实际17MiB内容经过原scope Artifact/固定Model与Native/Browser，成功EOF/hash前不发布正文。真实流在首块后停住仍能取消，非法metadata先释放body；UI确认前零正文GET，隐藏/关闭/切换清正文，缺失settings明确unavailable。IAB验收固定无害内容，关闭后Model计数保持，不将当前Context或Runtime logs导航等同该原请求入口。

原审批 [DOM 回归](../apps/desktop/test/isolated/native-approval-dom.test.tsx)先建立浏览器环境，再动态导入原 Radix／ReactDOM 组件，并在独立文件进程运行，避免服务端模块缓存使菜单 layout effect 缺席。完整请求 fixture 证明 UI 门禁与准确答案，不代替 Service／Artifact 原 proof；[Core 授权](../packages/agent/test/isolated/execution/authorization-review.test.ts)、[HTTP／Client](isolated/unified-agent/client-interactions.test.ts)和[源码外默认窗口](../apps/desktop/test/isolated/native-bundle.test.ts)分别负责原资格、公开投影及首次／冷读的实际原审批。[计划窗口](../apps/desktop/test/isolated/native-plan-review-bundle.test.ts)保独立审批、大正文、反馈、Files 和原预算；标题定位使用当前原 SessionPage 的准确标题并核原 Session ID。实际结果、失败和边界见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。

[当前会话 Auto 窗口](../apps/desktop/test/isolated/native-auto-approval-bundle.test.ts)构建完整 Native＋Terminal，搬迁并删除原输出后沿原 Composer／Approval／ToolActivity 验证实际批准、拒绝、转人工、无效结果和准确停止；本机固定 Provider 持有原审查，核 Store／Session／Execution／任务与参数，停止后才释放迟到批准。原文件效果、两个人工 answer、普通退出后五条冷记录及零重复调用分别核实，最终再以公开 Store 只读核原 ID 和终态。夹具按原写入卡 `.tool-edit-heading` 定位，失败会释放所属审查以收尾而保留原断言；120秒整例、45秒 driver 和10秒 UI 时限保持。它是 macOS 当前 Store 的产品路径验证，不代替全恢复／installed／其他平台；实际输入与失败见[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原会话权限停止与自动审批闭环)。

## 显式命令与 CI

原 [交互历史 DOM](../apps/desktop/test/isolated/native-interaction-history-dom.test.tsx)核通用 JSON 答案、取消、准确反馈、只读按钮与迟到范围；[Main reader](../apps/desktop/test/native-interaction-history.test.ts)核43项分页、child 原关系、变化拒绝和历史／当前审批附件资格隔离。[真实 HTTP](isolated/unified-agent/client-interactions.test.ts)另核实际 child 卡和 Core 通用问题的原答案／受理、游标与效果不增长。原默认窗口保首次／冷读，计划历史原字节从已验证完整附件读取，不把格式化 Markdown 的显示文本当源字节。邻接附件 fixture 等实际通知读取失败／恢复后才断言，原拒绝、零写入和期限保持；准确失败与通过归[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原交互记录只读历史)。


根默认和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)：精确八 workspace、mini-review 独立扩展、新 root unified-agent 场景及有限脚本安全列表；不会发现整个旧 integration/qualification/release/e2e/golden/TUI 树。原测试机制的独立 HOME、exclusive、失败停止派发、运行者 drain 与 OS 并发上限保持。新增 source-free/真实 Native/TTY 场景按实际分类单独进程执行，不以历史排除规则丢失其断言。

新 `test:tui:system` 由[当前 runner](../scripts/run-unified-tui-system-tests.ts)从新 UI TUI 与 CLI `tui*.test.ts` owner 动态发现，按当前文件清单分配四个 shard；`--list` 只读返回准确 inventory，只有所有 shard 成功才通过既有 `tui-system` check。根 runtime mock/e2e/fault/stdio/transport 与 Desktop aliases 已指向当前 owner 测试；旧 WebSocket/standalone/foundation/模型 live aliases 已退出，未将 paid Provider 测试重命名为 mock 通过。

三平台 workflow 使用新实际 producer/SQLite/平台报告，保 Bun1.4.2、40位Action pin、PR源head、clean-source与失败上传。OS vault 只在 CI 双 gate执行随机 owned namespace；默认 gate关闭零vault调用。live MCP默认gate关闭零network，workflow明确开启后才真实官方 tools/list+Tool。ACL脚本按实际OS核private路径，Winx64走currentSID/DACL；ARM64明确unsupported，运行失败非skip。

release candidate CI 在 macOS 和 Linux 调用整个原 installed Terminal 生命周期文件，原[CI 守卫](integration/scripts/unified-ci.test.ts)增加双方平台、真实 Bun 完整命令的反例检查；仅 macOS、echo 或 never-match 过滤均拒绝。精确 SQLite 3.53.2 source 准入另由[release tools](isolated/unified-agent/release-tools.test.ts)核近似 source、未知版本、linkage、额外字段和实际身份不符拒绝；原 fresh 完整候选测试继续执行。

Windows transport的原Store/config测试加[五项Node后端案例](../apps/desktop/test/isolated/windows-node-access.test.ts)，release的Native build均先调用[有限预装工具准备](../scripts/release/prepare-windows-native-ci.ts)。准备只收固定x64 compiler/SDK事实和十个环境变量，原字节严格解码、清空CL参数注入；Windows缺编译器/addon/ABI实际失败，不依据availability跳过。CI guard核原head/repository、完整消费命令和准备顺序；[纯合同测试](isolated/unified-agent/windows-native-ci.test.ts)不能代替本机未执行的Windows编译/生命周期。

完整平台与soak verifier继续拒绝缺资格：bounded source-free诊断不等于生产Shell/network/fork/resource边界，闭合v2固定七类CI不等于8外层/60分钟、每类warmup0+measured1—8原生资源和§33.3完整连续组合负载资格。旧ci-baseline/State测试保历史，不参与新默认执行；[当前CI守卫](integration/scripts/unified-ci.test.ts)核真实新调度与反例。最新执行、失败及平台范围见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md)。

macOS 另可显式执行 `bun run scripts/runtime/unified-soak.ts --profile=qualification --collect-blocked --output="${TMPDIR%/}/kite-full-soak/report.json"`，按原完整8outer／九点／60—168分钟预算采集，而不缩短到preflight。报告必须位于当前用户拥有且其他用户不可写的父目录；共享 `/private/tmp` 不能直接作父目录。支持的检查通过后仍blocked／inconclusive及退出1；实际失败则failed／退出1，formal拒绝保持。完成的各阶段复用原最终保留资源增长判定，增长失败保留私有原root与JSON，不以提前退出充作八轮通过。完整默认continuous消费父runner的同一已核验候选，源码外编译测试仍保两cycle／40Command、全部原断言与180秒预算，并核候选摘要和零重建。当前真实九点RSS增长失败、缺失Bun资源指标及全体后代资格仍单独记未具备，证据归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08macos-完整负载采集与冻结候选)。

macOS [原 mcp_churn 场景](fixtures/unified-agent/soak/mcp-owned-stdio.ts)现沿默认 Source／Core／connection Job 完成真实调用后 exit7、原 Tool unknown、完整所属树及 cold 原结果保全。原五类[完整场景](isolated/unified-agent/unified-soak-cases.test.ts)和[完整报告](isolated/unified-agent/unified-soak.test.ts)保原案例／断言／预算，另在原 macOS 场景内核精确交接及缺 broker reap／cold输出变化／错 Execution 身份拒绝，没有增加独立矩阵。非 macOS 继续原公开 adapter 协议诊断，不产生正式 Job 收据；原通过和清理断言仍执行，Mac owner 失败不转诊断。原 Source 后端的平台未具备保持。准确冻结、首轮失败、最终四文件有效结果与复用范围归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10原-soak-stdio-caller-迁移与冷结果保全)，它不代替阶段完整默认或资源资格。

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
