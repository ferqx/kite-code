# CLI 与 TUI

Source 审批 Host、完整安全分页和跨 Session 原申请 journal 已接入；新申请与历史读取的当前边界见[Source owner](#tui-mcp-项目来源决定与原申请)。同 Store 与错 Store 源码外键盘及当前完整默认图已通过，本片取舍和有限资格见[Source 决定](../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

新 `@kite-ai/cli` 的业务调用依赖 Client；宿主离线维护直接调用 Agent maintenance leaf。根 `agent` / `tui` / `prod:tui` 已固定选择新 Terminal 候选，开发入口仍显式使用 development profile。旧源码不参与正式/default/CI 调度；能力保真与三平台资格按手册和当前进度分别核对。

权限控制的薄入口位于 [permissions.ts](src/permissions.ts)。`getPermissionMode/getWorkspaceTrust` 只读显示当前事实；`setPermissionMode/setWorkspaceTrust` 接收明确原 Store、目标、commandId、观察 revision 及模式/default 或信任摘要的封存请求。`runNonInteractive` 支持 `permission-mode <session> {"storeId":...}`、`workspace-trust <workspace> {"storeId":...}`、`set-permission-mode <root-session> <request-json>` 和 `set-workspace-trust <workspace> <request-json>`，只接受该三项参数及生成契约中的闭合 JSON。保存成功的退出码 0 只证明控制事务已 applied，不表示创建或完成了 Run。失败为 1，结果未知为 2。

显式前台调用可使用 `createStdioPermissionReader(input?)` 配合 `promptPermissionMode/promptWorkspaceTrust`，导入或创建 reader 不读取输入。提示先显示准确原身份、CAS 版本与实际读取范围，再接受一行明确选择；模式可输入 `ask/accept_edits/auto/full`，加 ` default` 才修改用户默认值，信任使用 `trust/untrust`。子会话只读展示继承的根模式；需要明确选根才能保存。EOF、空行、未完成行、无效 UTF-8、超过 256 字节或未提供的选项均返回 not_submitted/3；Ctrl+C 返回 130，`dispose()` 释放本地监听，均不创建控制意图或取消工作。响应丢失只用原 commandId/Store 查询 `lookupPermissionOutcome`，不重发、不刷新授权后换版本提交。CAS 冲突保留原选择与请求，下一次选择须由用户明确发起。

[permissions.test.ts](test/permissions.test.ts) 启动公开 production `Service main` 的真实 paired 子进程与临时 SQLite，验证默认保存、信任/撤销、竞争 CAS、EOF/取消/输入边界及严格非交互参数，Run/Execution 数量始终为零。实际写入提交后强制关闭自有 socket，CLI 仅查回原回执，数据库只保留一次控制写入；与 HTTP/Native Client 三文件组合 12 tests、113 assertions 通过。此可调用接口尚未切换正式 CLI/TUI 命令或构成 PTY/三平台终端资格。

[src/index.ts](src/index.ts) 提供 `run`、`invokeExtension`、`queryExtension`、非交互 `runNonInteractive` 与当前前台操作的 `withCtrlC`。launcher 注入已经选择并准入的 Client；参数不包含 token，CLI 不复制 Runtime 或配套进程协议。非交互参数为 operation、sessionId、JSON request；query 另带 extensionId/queryId。

输出分别打印 `accepted <原 command ID>` 和真实 `terminal`。HTTP 202 不产生成功退出；CLI 查询原 Command 与其 Run/Action Execution，准备下一 attempt 的 predecessor 终态不能冒充本次完成。退出码：0 成功、1 失败、2 结果未知、130 用户取消/已确认取消。缺省前台等待没有隐式总期限；只有明确提供 `timeoutMs` 才限制本地等待，超时不取消已受理的 Service 工作。等待超时及网络结果不明保留原身份，不重放意图。

Ctrl+C 保存中断意图，并用原 `expectedStoreId`/commandId 精确提交一次 cancel；即使尚无 runId，也不取消别的当前 Run。执行终态与 cancel 受理分开输出。`CommandOutcome.cancellationAttempted` 只在实际尝试提交原取消请求后为 true（丢失回执也保留）；宿主跨观察轮次依据该事实停止再次提交，不能以 signal 已 aborted 推断取消已经发送。信号在异步读取 Interaction 期间到达而本轮先返回 waiting 时，下一次观察仍须处理该取消意图。配套进程真实退出由 launcher 独立拥有，网络断开不停止 Service。

验证：`bun run --cwd apps/cli typecheck`、`build`、`test` 和根 [thin-clients](../../tests/isolated/unified-agent/thin-clients.test.ts) 真实 Service 测试。P2 非交互调用者不替代 P5 完整终端交互或三平台发行验收。

P3 `CLIOptions.answerInteraction` 是宿主显式注入的异步回答接口，参数为当前真实 Interaction 与网络截止 signal；CLI 不自行打开 stdin。运行期间读取原根 Session 的 pending 页，处理一次 ID/revision（包括实际 child 来源的根投影），回答固定原 presentationSessionId/Store/ID/revision 与稳定 answer commandId。输出 `answer saved`、`answer accepted; execution pending` 与最终实际 Run/Execution 分开；丢失回答响应只查询保存的 answer command，不重新提交。

没有 handler、handler 返回 undefined、handler 失败或回答回执无法核实时，返回 `waiting_interaction`、退出码 3 和原 unresolved Interaction；不打印 terminal success，不停止 Run。返回值可附原 `answerIntent` 供调用者核对，输出不打印 answer 内容。显式 Ctrl+C 仍只取消原 work command，handler 的等待会被中断；网络 detach/退出等待不会隐式停止任务。每次 pending 查询最多 20 卡，沿实际 nextAfterId 完整读取后才筛选原 work；重复 ID、外来 Store/presentation Session、无进展或非法游标局部失败，不进入回答 handler。无 Run 的 nested Job 从持久原 parentExecutionId 链核对所属 work，不能用当前活动 Run 代替。回答 intent 原身份保留。

[test/interactions.test.ts](test/interactions.test.ts) 使用临时实际 SQLite Worker、固定模型、loopback Service/Client，验证审批后真实 tool requestInput、内部 choice 值、最终 Run 完成，以及未回答退出和 Desktop 原目标回答。此为薄客户端可调用的交互接口，不是正式 TUI/PTy/Electron/P5 验收。

真实子进程 fixture 通过公开 `@kite-ai/service/main` 的 `runServiceProcess` 注入确定模型与无害工具；测试 launcher 通过公开 `@kite-ai/service/paired` 传私有启动 JSON，实际 SQLite Worker 与 HTTP 命令仍走同一 Runtime。该过程测试验证 approval/question 与外置临时 ledger，未调用收费 Provider。CLI 只匹配原 work 的持久 runId/childSessionId/parentExecutionId 因果关系，不把同根旧后台 Interaction 改投给新 work 的 handler。

Context 公共薄接口（`rewindContext` 仅选择上下文，不提供 Files 文件回退；用户三范围入口见下文）：`getContext(sessionId, ContextQuery, options)` 读取一个有界页；`rewindContext(sessionId, SelectContextRequest, options)` 与 `includeHistoricalResult(sessionId, executionId, IncludeResultRequest, options)` 接收显式固定 Store/selection/commandId 的请求。`runNonInteractive` 增加 `context <session> <query-json>`、`rewind <session> <request-json>` 与 `include <session> <request-json> <execution-id>`。分页调用者保持 selection/highWater，并分别推进消息和来源游标，不把历史列表误作当前选择。

写入请求返回 `ContextOutcome`，保存原 request、Session 和准确 execution ID；applied 退出码 0 仅表示配置上下文事务落定，不代表模型已消费/执行成功。相同 Client/commandId 的重复提交不再发请求；同 ID 不同内容拒绝。未知响应只查询保存的原 Command，结果仍未知则返回原 intent（退出码 2），可用 `lookupContextOutcome` 显式再次读取，不能自动换 ID、Store、选择或改绑目标。Rewind 仍要求 idle；活动 include 必须由调用者明确封存 `targetRunId`，不从当前视图猜测。原 accepted/result_queued 返回 queued（退出码 2），只表示等待原 Run checkpoint；原 Command applied 才表示来源已纳入，不能把 202 当完成。CLI 不自行创造 steer。每 Client 最多保留 128 个写入意图。

[test/context.test.ts](test/context.test.ts) 通过公开 paired launcher 启动实际 Service 子进程与 SQLite Worker：Job 完成后 Rewind suppressed，Desktop 显式 include 与 CLI 重复 include 只保存同一 source，原外置 ledger 一次，固定模型保持两次请求；另行 startRun 才以准确 source ID/原 execution 在第三次请求读到结果。未调用收费模型，未建立完整 TUI/PTy 或 Context 压缩资格。


plan_review 使用同一显式回答回调：收到原 Interaction 后，approve 仅允许请求中明确提供的 auto/accept_edits 模式，缺模式、Full、陌生 metadata/modes 或过长反馈明确保留等待状态，且不发起回答写入。deny/revise 是信息答复，不携带 mode。输出明确 `review information saved / tool permissions unchanged`；原审批、required evaluator 与实际派发资格不由计划答复替代。迟到答复可能按协议保存 answer_saved/cancelled:true 历史，Core 不接受该 decision，也不复活执行。

[test/plan-review.test.ts](test/plan-review.test.ts) 以实际 SQLite Worker/Core、loopback HTTP 与固定模型验证两模式/deny/revise 绑定同一原 Tool execution/attempt，原 Tool approval 保留，下一 Tool 仍需独立审批；duplicate Desktop 回答一次，取消后的迟到历史答复无新模型或额外 ledger 效果。此证据不建立正式 Electron/TUI/PTy 或全计划业务完成资格。


当原人工卡含公开完整附件时，`answerInteraction` handler 仅在 SDK 对原 scope 全量读取、完整 SHA-256 和严格 UTF-8 校验成功后调用，context 提供 `completeAttachment:{identity,text,reference}`。没有 handler 或读取失败时返回已知 waiting_interaction，零回答 mutation/工具效果；无强制 stdin、无正文永久缓存。附件读取/网络脱离不停止 Run，显式用户取消仍精确取消原 Command。普通无附件卡保留原 callback 行为。

[test/large-attachments.test.ts](test/large-attachments.test.ts) 通过实际 Core Auto ask_user、SQLite、ArtifactStore 和本机 HTTP 验证超过 17 MiB 完整正文到 handler、损坏失败不调用 handler，以及随后批准只产生一次原效果。当前 SDK 仍整份 Uint8Array/字符串分配，物理内存限制未被消除；该证据不是正式 TUI/PTy 验收。

公开 `createStdioInteractionHandler({input?,write?})` 提供显式选择的前台 stdio 回答适配器，调用者将其 `answerInteraction` 传给 `run`/`invokeExtension`，结束后调用 `dispose()` 释放输入监听。导入 CLI 或未注入 handler 不读取 stdin。缺省输入是 stdin，提示写到 stderr，与 accepted/terminal 输出分开；调用者也可注入独立 Readable 和提示输出。提示展示原 Store、Session、presentation root、Run、Execution、attempt、Interaction/revision 和完整请求；完整附件仅在既有全量 scope/hash/UTF-8 验证成功后展示。JSON 转义保留正文并防止终端控制字符直接执行。

每个答案必须是完成的一行：审批输入 `approve`（缺省仅一次，发送 `grant:approve_once`）或 `deny`（不携带 grant）；只有原请求 `grants` 数组实际提供 `same_command` 时，提示才列出 `approve same_command`（本 Session 相同命令），发送 `grant:same_command`，未提供该选项时此输入保留 waiting；问题输入符合原 `request.schema` 的 JSON，使用原内部 choice ID；计划审阅输入 `approve <明确提供的 auto|accept_edits>`、`deny` 或 `revise <反馈>`。计划信息不授予 Tool 权限。问题表单支持有限 object/array/string/number/integer/boolean/null、const/enum、oneOf/anyOf、required 和长度/数值边界；pattern 仅支持准确非空白扫描 `\S`。组合先核所有分支，再按原 JSON 值判断；未知或畸形分支整卡拒绝。未知 schema 关键字、陌生模式、无答案、未完成行或 EOF 均保留 `waiting_interaction`，不默认批准、不发起 answer mutation。输入每行最多 64 KiB、待消费行最多 16；超出时停止本地读取并保留等待，不截断成答案。此上限仅约束人工答案输入，不裁剪请求或附件正文。

适配器只消费一个前台回答。回答仍由 CLI 封存原 Store/Interaction/revision 并通过根投影提交；原 child 身份不改写成当前 Session。Ctrl+C 中断本地输入后仍由 CLI 精确取消原 work command，迟到输入不复活任务；`dispose()`、EOF、网络脱离和明确等待 timeout 均不关闭 Service 或取消 Runtime。

[test/stdio-interactions.test.ts](test/stdio-interactions.test.ts) 使用真实 paired Service、临时 SQLite 与固定模型验证 stdio 批准后 question 内部值、终态、EOF/空行/不支持输入、原 Command 精确取消、超过 17 MiB 全附件、附件读取被取消时零回答/零工具效果、显式 timeout 后工作继续，以及实际超过 30 秒仍能完成的缺省等待。真实同 Loop child 的原卡通过 presentation root 回答；CLI 按从 child 到 root 的实际 ancestry 和 carrier 的 parentExecutionId 找到原 work，不依赖 carrier 的空 runId 或当前活动 Run。[test/stdio-unit.test.ts](test/stdio-unit.test.ts) 独立核对 offered modes、问题 schema 子集、输入边界和同根旧 child 卡排除。此前 macOS 固定模型验证为 CLI 受影响测试 25 项／209 个断言通过（显式排除已执行的长等待项），另有真实约 30.3 秒长等待项／3 个断言通过。该可调用 stdio 闭环未建立正式 `kite run` 的原生 stdin、三平台终端或完整交互体验资格。

[test/stdio-grants.test.ts](test/stdio-grants.test.ts) 独立核对显式原卡选项、一次默认、准确原 child/展示根/决定版本提示、deny 无 grant，以及未提供选项、plan/question、非法输入和 EOF 不能制造会话授权。stdio 不保存权限缓存；真正的 grant 保存/clear 和执行资格仍由原 Store 的 Core/Service 决定，此适配器不代表正式 TUI/PTY 迁移。

活动 include 的真实配对证据见 [test/context-active.test.ts](test/context-active.test.ts)：原 Run 等待时保存准确目标，checkpoint 前无来源，后续 Model 使用准确 source ID；历史 Job ledger 不重放。失效响应只查询原意图的有限测试见 [test/context-intent.test.ts](test/context-intent.test.ts)。

`host/main.ts` 的 `trace <events.jsonl> [--turn N] [--format json]` 在读取配套 Service 制品和选择 profile 之前进入 [src/trace.ts](src/trace.ts)，由宿主读取用户明确给定的文件，纯参数模块只接收该文件字节。整份内容通过严格 UTF-8 与逐行完整 JSON 校验后才输出；任何坏尾行都失败，不把已解析前缀当成功。未知记录与字段可读，JSON 输出保留原数值字面量；缺省文本将 ANSI、NUL、C1 和双向控制字符转义，不执行日志内容。

`--turn` 优先使用记录明确正整数 `turn`；没有该字段时，沿已校验的 `runtime.turn.started` 原日志分段顺序选择第 N 轮，文本注明这是日志轮次而非 Runtime 身份，不从 turnId 文本猜测。该读取不发现服务、联网、启动 Service/Provider 或重放事件。[test/isolated/trace.test.ts](test/isolated/trace.test.ts) 的真实 argv 子进程拦截网络与子进程启动，验证原旧 JSONL 词汇、未知内容、坏 UTF-8/尾行和终端安全输出；正式旧 CLI/TUI 入口切换仍由整体门禁负责。

新宿主的重复 `--skill <名称或ID>` 通过原 `run.start` Command 的 `selectedSkills` 选择默认 Service 已配置、已发现的真实 Skill，配对与共享模式使用同一公开契约，不把参数解释为路径或新的可信 root。名称须唯一，名称与 ID 指向同项时去重；未知/重名在凭据读取和 Provider 请求前持久拒绝原 Command，CLI 严核原回执并输出转义后的原因，不改用别的 Skill 或重发。未传 `--skill` 时保持 Service 原配置行为。

选择只缩小当前 Run 的 catalogue、sources、Tool lookup 和封存配置，不隐式启用 `skills.load`、运行资源脚本、扩大文件/网络范围或记录信任。已选择普通 `skills.load` 的宿主可按需读取全文，仍走真实权限与 UnifiedExecution；CLI 不复制发现器或 Skill manager。[test/isolated/host-skills.test.ts](test/isolated/host-skills.test.ts) 的知识场景使用实际 argv、构建 Service、临时 SQLite 与本机固定 compatible endpoint，验证完整正文/原来源、两 Run 独立 ID/hash 快照、unknown/ambiguous 原拒绝与零 Provider，以及未信任时零 Tool 派发、零脚本。完整资源操作与正式 CLI/TUI 制品切换仍由整体资格负责。

显式 Workflow 使用独立、可重复的 `--activate-skill <compiled-name或skill:ID>`，仅 `run/resume` 接受，状态查询与管理/维护入口拒绝混用。参数存在时先要求实际 `skill_workflow_catalogue/run_extension_inputs`，在创建任务前由公共 `listAllSkills(...,{workflow:'manual'})` 穷尽原目录，不扫描本机文件或推断 flags。helper [workflow-activations.ts](host/workflow-activations.ts) 优先匹配真实 compiled name/ID；只有不可用项才可借知识名提供拒绝原因。重名拒绝、同项去重，生成稳定 `manual-N` key 与原 `input:{}`，任务内容不转成 schema 字段。

知识 `selectedSkills` 与 Workflow `extensionInputs` 可以共存，各自保留原 Command。激活前读取原 Session view；idle 使用 `run.start`，有原活动 Run 时用准确 `afterRunId/contextSelectionId` 的 `input.follow_up`。便携 [run helper](src/index.ts) 对两类意图共用冻结、原 ID 查回与观察，不重发丢回执或更改原 Run 契约。目录 revision 仅用于完整分页，Service 仍在实际开始时重新绑定可信源。[配对测试](test/isolated/host-skills.test.ts)和[共享测试](test/isolated/shared-skills.test.ts)包含真实 argv、混合知识/Workflow、关闭及结构化输入零 Model、物理断线一 POST，以及活动 Run 的后续激活；实际结果见[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

开发 TUI 宿主见 [host/tui.tsx](host/tui.tsx) 与 [host/tui-main.ts](host/tui-main.ts)。公开 `/tui-host` 的 `runTUIHost` 接收明确 `artifact/dataRoot/profile/workspace/thread` 和独立宿主退出 signal；`/tui-main` 提供纯 `parseTUIArguments` 与 `runTUIProcess`。help/version 和非终端拒绝均先于 profile 创建；没有制品 source fallback、隐式服务发现、argv token 或权限模式猜测；显式 `server` 选择既有共享服务。配对启动校验既有 Service/Bun SHA、profile/instance/build/API/capabilities，私有 bootstrap 不打印到终端。

宿主复用公开 `@kite-ai/ui/tui` 的单一 controller，读取同 Workspace 的完整固定上界 Session 目录和会话历史；原审批附件与 Model 正文经公共 SDK 全量验证后才显示。活动输入封存准确 Run/context selection，空闲输入创建新 Run；批准保存不等于执行完成，未知仅查询原 Command，不换 ID 或重发。`Ctrl+R` 选已有 Session，`Ctrl+N` 创建同 Workspace 新 Session（未确认创建时再次按键只查询原 ID），`Ctrl+K` 查询原未知工作，`Ctrl+C` 精确取消原工作且不退出共享 Service。`Ctrl+Q` 或明确 SIGTERM 才退出并关闭本宿主拥有的 paired Service；stdin EOF 停止视图读与输入，保留原等待任务且不默认批准，直到明确宿主退出。切换会话不取消旧工作。

本开发宿主新增下述有限 slash 路由；原 `tui`、旧 CLI/daemon/Electron 入口没有由此退役。复杂编辑、完整终端屏幕滚动/resize 与三平台资格仍未完成。开发入口的 buildId 只证明配套 Service entry 的准确 SHA，不是完整发行 candidate 身份。[test/isolated/tui-host.test.ts](test/isolated/tui-host.test.ts) 通过真实 argv/PTy 和构建 Service 验证宿主生命周期；平台与测试结果以实际验证记录为准。

本切片在 macOS 的真实 POSIX PTY 验证为 5 项／56 个断言：纯参数与无终端前置拒绝；三条实际 `scripts/development/unified-tui.ts` 路径使用 built Service、临时 SQLite/profile、仅本机固定 compatible SDK。正常路径核实 9 MiB 文件的完整末尾进入下一实际 Model 请求、显式读取 360025 字节完整输出尾、同 Workspace 新 Session/已有 Session 选择；取消路径双次 Ctrl+C 不批准、不产生原文件效果；EOF 路径在明确退出前仍 `waiting_interaction`、零 accepted，SIGTERM 后由所属 Service drain。三个路径均核实原 Service PID 消失、同 profile 可重新准入且没有额外 Model 请求。PTY 主端关闭带来的 SIGHUP/输出 EIO 只结束观察，不冒充用户退出；SIGTERM listener 保留到异步清理完成，避免 Ink 信号转发提前结束 drain。此证据不覆盖 Linux/Windows、复杂输入/粘贴合并、多平台屏幕滚动或源码树外完整发行资格。


开发 CLI 管理入口由纯参数层先核对生成的 closed DTO，再按是否明确提供 `--server <本地socket>` 选择既有共享 Service 或配套 Service：`session rename|delete|fork <sessionId> --input '<request-json>'`，以及 `context read|rewind|include|compact|reset <sessionId> --input '<request-json>'`；include 还须 `--execution <原ID>`。`--data-root`/互斥旧高级 profile 参数仍只选择宿主根，不提供权限。JSON 必须明确原 Store、command、revision/selection，宿主不猜当前 ID；未知字段或不完整输入在资产/profile I/O 前拒绝。读取仍走已准入公共 HTTP，不直接读取 SQL。

[src/session-management.ts](src/session-management.ts) 保存最多 128 个完整原意图，不丢弃未知；重复只读原 Command，不第二次 POST、不换 Store/选择。rename/delete 核对原控制版本；delete 的 `delete_requested`、退出码 2 明确停止尚未确认，文件不回滚。Fork 核对新 Session、原来源/选择及准确 namespaceReport；omittedExtensionState 如实表示是否有省略。空来源的报告为空、标记为 false，未登记规则的实际记录默认 omit；复制或重建不将旧正文引用改绑新作用域。compress/reset 的 Command applied 只是创建维护 Run，只有准确原 Run completed 才报告完成；失败/未知保留原身份；读取或提交前 Ctrl+C 只结束本地等待，已核实原管理事实后才精确请求取消原 command，冲突或无法核实的意图不猜测取消。配套宿主结束按其所属生命周期清理，共享宿主结束只断开网络。`getCompleteContext` 固定选择/上界，独立推进消息与 resultSources 游标，已结束流不本地追加，不按总数裁剪；接口没有禁用已结束流字段，后页保持其最终游标。

共享管理不解析配套资产，也不启动替代实例；开发 selector 和 `runCLIProcess` 同样延迟资产解析。连接固定原 profile/instance/build/Store，目标必须为 daemon 原 Workspace 的 root Session，以完整 Workspace 目录的 canonical root URI 核对，不接受另一工作区或 child Session。Fork 回执另核原来源 Session/selection 与实际新 Session；取消不能因复用冲突的命令 ID 而作用于其他既有操作。SIGTERM 中断所属读取和取消请求后只 dispose 本 Client，daemon 与其他客户端工作保持。测试见 [shared-management.test.ts](test/isolated/shared-management.test.ts)，包含实际 argv、零资产 resolver、物理丢回执仅一次 POST、准确取消与跨 Workspace 冲突反例。


开发 TUI 明确路由 `/new`、`/resume`、`/context`、`/rewind`、`/compact [focus]`、`/compact reset`、`/status`、`/exit`（`/quit`/`/q`），以及开发管理词汇 `/session rename <title>`、`/session delete confirm`、`/session fork <title>`。陌生或本阶段不支持的旧 slash 保留草稿并局部报 unavailable，不发送 Model。`/new` 可复用无用户消息的空 Session；当前 Session 删除受理后创建新空 Session，但不假称旧 work 已停止。Context 面板只展示当前选择，绝不是原 Model 输入 Inspector；`/rewind` 另走下文 Files 三范围目录，实际 Fork/Code 提交保留静止门禁与准确边界，Include 保存准确结果 revision 与实际 active Run（如存在），queued 不显示已纳入。维护 Run 期间普通文本使用原 Run/context selection 的 follow-up，而不是 steer 压缩执行。切换、EOF 不批准、不取消别的工作；关闭 Context 面板只 abort 所属读取。

新验证见 [纯 Context 分页](test/context-pagination.test.ts)、[实际管理 HTTP](test/isolated/session-context-management.test.ts)、[真实开发 argv](test/isolated/management-argv.test.ts) 与 [实际管理 PTY](test/isolated/tui-management-host.test.ts)。HTTP fixture 物理丢弃已提交 rename 响应后核对原 ID/零重发，并读取 202 条真实消息；压缩使用实际 Model/Run 终态，缺可信 expanded preflight 的 reset 准确失败并保留旧点。该开发消费者资格不等于正式旧 CLI/TUI 切换、复杂终端编辑或 Linux/Windows/全发行资格。


本管理切片的最终资格分组记录：CLI 参数/完整 Context 分页与 Ink/port 组合 21 项／398 个断言；实际公共 HTTP 与真实 argv 管理 2 项／146 个断言；原 active include/Context 意图回归 4 项／56 个断言；原开发宿主 5 项／56 个断言与 UI 实际 PTY 3 项／19 个断言保持。新增管理 PTY 1 项／11 个断言独立验证完整 focus/原正文到压缩请求、维护期间 follow-up、后续请求来源、原命令 GET 和有限 slash，结果以该实际测试日志为准，不累加成平台完整资格。


开发 TUI 的 `/permissions` 接公共 Native permission_controls：独立读取当前模式/default、实际 Workspace 信任范围与完整 fixed-upper same_command 目录，不等待 Model 结束。上下选择模式、D 选择未来默认、T/U 信任/撤销、C 清除准确所选 Session；每次先核对原观察再显式 Enter 确认。R 只刷新、K 只核实原未知 mutation；child 模式只读继承，clear 不隐式跨 Session。实际 Store/revision/command/hash 冻结，重复、丢响应和 scope 切换均不第二次写入，128 个未知不淘汰。控制 applied 仅证明事务保存，不证明执行成功。

原 approval 上下键只选择原卡实际 offered 项，Enter 无选择时不回答；same_command 不从 nested policy、计划审阅、question 或 Model 授权推造。卡片身份和 decision revision 改变时旧选择不复用。[permission-intent.test.ts](test/permission-intent.test.ts) 覆盖 201 个 grants 完整分页、改变 epoch 拒绝、invalid_response 原查询与未知容量；[permissions.test.ts](test/permissions.test.ts) 7 项／56 个断言含真实 SQLite CAS/重启控制、零执行以及物理丢失已提交 clear 响应后的单 POST/原 GET。

[实际权限 PTY](test/isolated/tui-permissions-host.test.ts) 使用 built Service、可信显式 Shell 资产装配、固定本机 compatible SDK 与临时 SQLite/ledger，验证 mode/trust 确认、空 Enter 零批准、准确 Tool/Job 两张同命令授权、不同 operation key 相同执行语义再次执行免卡、清除后再审批及精确取消；不会从 JSONC 自授 Shell。与 [管理 PTY](test/isolated/tui-management-host.test.ts) 及共享 UI 原 child complete/EOF 配对合计 4 项／41 个断言通过。原 CLI host/参数、UI paired 与 permission API 基线组合 15 项／131 个断言通过，保留全文尾部、EOF 零批准与所属 PID 清理证据。

SSE reset 仅重开一条观察：先读取原 Store 全局 snapshotCursor 基线，再完整读取目录及所选事实，使用 Client startAfter 作为读取起点；快照不推进 lastAppliedCursor。实际回调成功前 EOF 仍沿该起点，成功事件/checkpoint 才 ACK；Store 改变保失联，不重绑旧意图。[tui-observation.test.ts](test/tui-observation.test.ts) 核对顺序、无 ACK、wrong Store、失败与 abort。原正式 CLI/TUI 入口仍未切换；当前证据只支持本机 macOS 固定 SDK/PTY，不代表 Linux、Windows 或完整终端设置体验。


开发 TUI `/export` 不带参数，导出当时已加载对话的 Markdown，而不是 raw Session backup。UI 只提供原 Store/Session/generation 与已加载文本；[宿主 exporter](host/tui-export.ts) 使用已选 profile 的用户配置目录（当前实际 `profilePath/config.jsonc` 所在目录），生成 `session-<时间>-<随机ID>.md`，以 exclusive 0600 写入，完整写入并关闭后才报告路径。renderer 和 Model 不能提供写路径。运行中冻结原文本，Tool 卡、审批、完整诊断不保证包含；未加载全文只保真实 preview 并明确说明，导出不发额外 body GET，不启动/重放任务。切换会话的迟到结果不报告到新会话；取消/失败移除本次不完整文件，显示 Export failed。

[文件测试](test/isolated/tui-export.test.ts) 验证真实9MiB全文/reason尾部、0600、原Store/abort/写失败；共享 [纯serializer/controller测试](../../packages/ui/test/tui/export.test.ts) 验证准确loaded身份、未读正文0GET与late隔离。[实际标准80×24 PTY](test/isolated/tui-export-host.test.ts) 验证未读 preview、Ctrl+O 后9MiB完整正文及思考尾部、两次真实0600文件、新文件路径提示、固定模型精确2次调用和所属 Service 退出/冷重开。大正文投影复用后，草稿和notice不再重复解析正文。正式旧 CLI/TUI入口仍由完整迁移门禁负责。

## TUI 原生滚动与清屏

[原生滚动 PTY](test/isolated/tui-scrollback-pty.test.ts)通过当前公共 TUI 源码、有限 UI port 和实际80×24 PTY字节驱动已安装 headless VT。三轮90个完成正文标记、40个活动正文、35行待决问题与60行选项描述各出现一次；各场景明确从底部上滚100行，状态更新、键盘编辑及改选不重发原材料、不清原生历史且保留阅读位置。折叠的179字符 paste、显式12行自由输入及150字符软换行分别核显示与单光标；复杂 question 再核完整30项Unicode JSON paste与显式12行JSON编辑。40→80列重排、同会话正文替换、`/clear`、同会话刷新与跨会话切换核原正文、输入栏和显示基线，原 snapshot 及零业务 mutation 同时核对；held Popen 正常退出。该有限 port 资格不代表默认 Service、安装制品、GUI终端或其他平台。

共享 UI 的当前材料版本、原顺序与剩余动态长尾限制由[TUI owner](../../packages/ui/src/tui/README.md)维护。当前源码外[默认问题 PTY](test/isolated/tui-question-pty.test.ts)另核真实默认 Tool/Service/Provider 与原答案；题目和完整选项核该步骤实际发出的原材料，题号/选择/可交互状态核最新动态帧，不把留在原生历史的正文当成当前控件，也不要求每次按键重印正文。上方大正文 PTY 使用开发宿主与 built Service，保留实际 Ctrl+O 全文尾部、两次导出及正常退出/冷重开。输入需等待实际可交互提示或命令回显；全文观察在 reader 展示时核对，不要求后续导出或退出重复打印已完成正文。业务预算、原卡版本、完整文件与零额外工具效果断言保持。具体当前运行范围与未闭合资格归[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[默认 ask_user stdio 测试](test/isolated/ask-user-stdio.test.ts)沿真实默认 Process configuration、compatible Provider、Service/SQLite、公开 Client/CLI 与注入 Readable 回答 canonical 三题。纯空白先保持原卡 pending、零 Answer；合法输入随后一次提交，持久原选项 ID 和闭合自由对象，第二 Provider 与历史收到文案及原 Unicode、多行和空格。自由原文与选项 ID 同字时仍保留自由输入。EOF、未知 schema 和重复观察不建立新的回答权。该测试使用公开源码入口和有限 Readable；源码外安装制品的原生 stdin 资格另按整体门禁判断。

## TUI 普通问题步骤

正式 Terminal 与 `tui:dev` 消费同一个 [TuiSession 问题面板](../../packages/ui/src/tui/README.md)，有限原 schema 可生成单题和多步骤选择/自由回答。默认普通 [ask_user Tool](../../packages/agent/src/tools/ask-user/README.md)生产 1–3 题；请求、schema、内部 ID 与用户原文仍来自原 Interaction，不复用旧 Runtime 的 questions payload。返回上题保留后题草稿，最后一步才通过原 caller host 提交一次 Answer；回执未知仍只查询原命令。选项保原 ID，明确 Custom 保闭合 `{text}` 原对象，避免同字自由文被解释成选项。stdio 仍按其有限 JSON 输入子集传原值。

[源码外真实 PTY](test/isolated/tui-question-pty.test.ts)使用公共 Terminal candidate builder、实际默认 Process configuration 与普通 ask_user、真实 Service/SQLite/Client 和 80×24 键盘。Profile 不显式列出 Tool，键盘确认 Workspace trust 与 Ask；本机 compatible Provider 发出 canonical 三题，并核后续真实请求中的文案与自由原文。测试验证推荐标记、无默认答案、多题回退改选、Unicode/首尾空格/多行 paste、自由 ID 碰撞、各中间步骤零 Answer，以及最终原卡唯一答案、原 Tool/Run 完成、GET-only 观察、正常 Ctrl+Q 和所属 Service 清理。临时 credential backend 不证明 OS vault；不建立收费 Provider、正式安装、异常退出或其他平台资格。

[原 Workflow PTY](test/isolated/tui-workflow-question-host.test.ts)已改为真实 decision/detail 步骤键序；replan/waive 的丢 Answer 响应和首 GET 丢回执仍只查询原答案命令，取消仍准确作用原 Run。既有[配对](../../packages/ui/test/isolated/tui/paired.test.ts)与[子会话](../../packages/ui/test/isolated/tui/child-permissions.test.ts)保持完整正文、原卡身份、取消及 EOF 零批准断言，仅更新已支持问题的选择键序。实际范围、冻结版本与日志见[总体进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

## 开发 CLI 离线维护

Workflow 的独立开关文件 `skill-workflow.jsonc` 作为 `skillWorkflowConfiguration` 原字节资产采集。JSON coverage 明确列出该项，保留注释、未知字段及损坏 JSONC，不解析或启用特性；缺失保持 absent，恢复保原字节。它不改变 `profileComplete:false` 或凭据排除范围。

[host/maintenance.ts](host/maintenance.ts) 接入公开 `@kite-ai/agent/maintenance`，不启动 Service、Provider 或执行任务。命令及用户操作见[手册](../../docs/handbook/cli/commands.md#通用开发入口离线维护)。[纯参数层](src/arguments.ts) 要求显式绝对 data root/profile、选定备份与原观察身份；恢复及 journal 完成/回退另要求独立 `--confirm-data-loss`，未知、重复、缺值及相对路径在 I/O 前拒绝。help 和只读 status 不初始化 profile 或 coordination；开发 selector 原样转发这些参数，无需 Service 资产。

backup/restore/reconcile 复用 Agent 外置 profile-use exclusive OS 锁；busy 非零退出且不结束所属进程。status 只输出 journal 观察，reconcile 绑定其中准确 restoreId/digest 和 complete/rollback；普通任务入口不会自动修复未完成 journal。失败只打印有限错误码，不输出 raw stack 或配置正文。

当前 JSON 明确 `coverage.profileComplete:false`：包括SQLite、被引用不可变媒体，以及分别采集的实际config.jsonc原字节和Desktop私有UI一致副本；缺文件如实记录absent，TUI未提交文本由真实 `ui/tui.json` owner 纳入采集，终端显示偏好 `ui/preferences.jsonc` 也按完整原字节采集（含损坏 JSONC，不静默修复）。原配置可能含敏感内容，0600保存，不解析vault或自动redact。恢复保留旧目录，发布备份中实际存在的config/UI，保留原草稿和创建身份；credentials/vault及未采集私有文件仍缺失，不能把该命令解释为完整W19/profile资格。底层身份、fencing、目录发布与 engine/platform 资格见 [maintenance owner](../../packages/agent/src/maintenance/README.md)。

coverage 的 Desktop 支持版本为 DB1–5，并明确列出 `mcpSelectionIntents` 的 `ui/mcp-selection-intents.json@1`；这是现行严格资产 codec 的支持范围，实际文件存在与完整摘要仍由所选 backup manifest 证明。源码外 maintenance fixture 沿正式 `packages:external` 构建公开入口并复制真实 npm 闭包，构造失败先确认 Store 关闭才清理所属目录；实际四个 argv 场景验证原字节、身份、busy 和准确 journal 决定，不要求安装 Ink 的开发 optional peer，也不借源码别名补路径。

[test/maintenance-arguments.test.ts](test/maintenance-arguments.test.ts) 核对闭合词汇；[真实离线 argv](test/isolated/maintenance.test.ts) 在源码树外临时 built workspace 包、真实 SQLite 与第二进程验证 create/inspect/restore、旧 Store 拒绝、冷读零 Run/Execution、busy、失败不建库及 exact journal complete/rollback。消费进程没有 Service 运行资产，未使用 source fallback、收费 Provider 或用户数据。此本机 macOS/Bun 证据不建立 Linux/Windows 或完整发行资格。

## 开发 TUI 持久草稿

[文件 owner](host/tui-drafts.ts) 和 [编辑接缝](host/tui-draft-port.ts) 只持久真实未提交文本，按原 Store、Workspace、Session 的完整身份隔离。编辑180ms合并保存，切换、EOF与正常退出先同步最后编辑；成功accepted/applied才以原编辑revision清除，迟到成功不能删除并发新输入（包括改动后又改回相同文本）。失败和unknown保原文；核实原Command后成功仍按原revision清除，不重发。没有持久主题、语言、队列、审批答案或执行意图。

宿主在配对Service启动前、或显式共享连接准入成功后取得独立 `@kite-ai/agent/profile-access` 共享lease，直到UI文件操作完成且宿主退出才释放；Service死亡保留宿主、编辑器及lease，不自动发送草稿。每次短写锁使用同coordination的固定 `tui-private.lock`，atomic/CAS、600文件/700父目录、完整UTF-8 JSON与Decimal64，损坏格式不重建。并发冲突保本地内存与磁盘各自原文，不采纳新revision自动覆盖。正常Ctrl+Q或`/exit`最后保存失败会阻止退出并显示 `tui_draft_save_failed_exit_blocked`；SIGTERM强制退出若保存失败返回1，强杀不保证尚未落盘的文本。

`/drafts`列出已落盘非空草稿身份和ID；`/draft <id>`只读显示原全文与关联current/unavailable，不把原文插入当前输入或重绑。尚未保存或冲突的本地编辑仍在当前composer，目录不能冒称它已经落盘。删除Session或恢复换Store保原文本；旧Store草稿不会自动成为新Store输入。文件16MiB、4096记录含空文本revision记录的限额会明确失败保原字节，没有静默淘汰/截断。180ms合并避免每键重写大文件，退出只在保存成功后关闭。

[真实文件/CAS测试](test/tui-drafts.test.ts) 验证9MiB完整尾部、100次快速编辑仅一次文件发布、冲突/坏格式/权限/软硬链接及明确容量失败；[UI测试](../../packages/ui/test/tui/drafts.test.ts) 核对冷scope、迟到成功、ABA、原目录只读与unknown。[源码树外built PTY](test/isolated/tui-drafts-host.test.ts) 使用自有临时profile和固定loopback模型，验证冷重开最后编辑、Service SIGKILL后仍持共享lease/维护busy、新Store恢复原文不改标及零Provider调用。此资格限本机macOS，不完成正式旧TUI切换或三平台发行。

开发 `cli:dev server start|restart` 由 [unified-cli selector](../../scripts/development/unified-cli.ts)提供私有 `resolveArtifact` 回调，只有真正启动或重启预检时才读取目标构建。`server status/stop`、`web` 和已经兼容的 `server start` 复用不依赖目标资产存在；absent 状态查询/停止不创建 profile、启动 Service 或调用 Provider。该回调属于可信宿主，不进入 argv 或公共业务 schema。

daemon 制品选择固定 `apps/service/dist/daemon-main.js` 与 `apps/web/dist/manifest.json`，核真实常规文件和 canonical Web 目录、准确字节 SHA；buildId 同时绑定 paired entry 摘要、daemon entry 摘要和 Web manifest 摘要。manifest 内容的有限资产资格仍由实际 daemon preflight 校验，不把摘要当目录授权。缺失/链接资产在需要 launch 时明确失败，不读取源码 fallback。默认 run/resume 及 session/context 的 paired selector 保持原 entry/executable 准入与 buildId；显式共享 run/resume 不选择配套资产。

[development-cli.test.ts](../../tests/isolated/unified-agent/development-cli.test.ts)保留实际配对构建、完整原任务输出与一次本地模型请求，并补纯只读零资产选择、惰性启动失败、真实原实例兼容复用零目标构建、entry/manifest 字节变更及链接拒绝。此开发入口适配不代表正式发行 CLI/daemon 切换或三平台资格。


[host/daemon.ts](host/daemon.ts)通过私有 socket 核原 reservation/PID 启动身份，随后只用公共 Lifecycle Client 查询与关闭。start兼容复用不替换build；restart先核目标资产并运行目标只读Store预检，再一次if_idle或明确cancel。未确认原PID退出不启动替代，不以超时强杀；start不自动删除dead/未知endpoint。workspace省略沿用原实例，显式不一致拒绝。status输出分开记录running/target build；未选择目标构建时target为null，不能编造当前安装版本。

[test/daemon-host.test.ts](test/daemon-host.test.ts)实际构建公开四包manifest并启动所属子进程：默认与显式endpoint缺席零路径创建、lazy resolver零无关调用、准确原实例复用、web只观测、坏目标保留旧服务、实际busy与cancel重启、原Workspace保留及冷启动零Model。该macOS资格未覆盖未知handoff与所有故障窗口，也不完成正式release入口迁移。生命周期编排与共享业务连接分别验证，不能以此证明正式调用者已切换。


## 开发 CLI/TUI 共享连接

[shared-service.ts](host/shared-service.ts) 是私有宿主接缝：只在显式 `--server` 路径动态载入 Service daemon bootstrap，再通过公共 Client 核对启动前选定的 profile、API major 与必需能力，以及私有通道固定的原 instance/build。它返回已准入 ServerInfo 和原 canonical Workspace；不要求正在运行的 build 与客户端安装一致。显式 workspace 经 realpath 核对，省略时不使用调用者 cwd 改绑；原 thread 仍须属于这个 Workspace。

共享 `close()` 幂等且只释放本 Client 网络，没有 PID、exited Promise、launcher 或 shutdown。CLI run/resume 在共享模式跳过所有配套资产选择，waiting/unknown 返回准确非零状态和原 intent，不进入依赖 paired.exited 的保活循环。宿主 SIGTERM 只 detach；用户 Ctrl+C 继续走原 command 精确取消。TUI 连接成功后才取得独立 profile-use lease，保留原 draft owner 与 SSE reset/readbaseline/ACK 语义；失联不采用替代 daemon，退出释放网络和自己的 UI 文件资源。

共享 `--skill` 要求原 Service 发布 `run_skill_selection`，选择随本次原 Command 保存，不修改 daemon 全局配置。未传该选项时省略选择字段，保持配置目录；每次 `run/resume` 独立选择。原 ID 的查询和未知回执处理保留同一选择，不重新 POST。正式候选也复用该共享路径；macOS 本机验证不扩展为三平台资格。


共享验证分别位于[连接准入](test/isolated/shared-service.test.ts)、[实际 CLI 子进程](test/isolated/shared-cli.test.ts)与[实际 TUI PTY](test/isolated/tui-shared-host.test.ts)。连接测试包括原实例/能力/工作区拒绝、多个客户端断开后 held Run 继续、安全诊断无假 Store，以及没有 Service/node_modules 的包外宿主导入。CLI 组合验证已有 paired 完整输出、开发 selector、无 Service 资产的离线维护；共享 SIGTERM 同时覆盖模型等待和保持 stdin 开放的真实人工提问，后者先 dispose 本地 answer reader，保留原 pending Interaction。测试均使用自有临时 profile、固定模型与所属进程；精确结果归[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。


TUI 观察不可用独立于快照读取失败：SSE 出错而 HTTP 仍健康时，刷新或切换不能清掉持续观察失联。宿主只由公共 Client 已校验的原 Store `onReady` 恢复观察状态；reset 先取得原读取基线和完整事实，不能因为失联标志阻止这次必要只读恢复。snapshot 成功不推进事件 ACK，也不使停止的 observer 看起来正常。


## 开发 TUI 模型设置

`host/tui.tsx` 将公共 getModelSettings/updateModelSettings/getHostMutation 适配为 UI 的有限模型端口。`/model` 提供准确 ID 的项目默认值与启禁，`/effort` 使用真实 metadata 的有限值或 null；所有修改先核对再提交。宿主不写 JSONC、不自行推导 Provider 能力。只读 scope 固定原 Workspace，提交固定原 Store/read-set/commandId；已知 4xx 拒绝返回 failed，但 mutation_incomplete 保持未知；丢回执或不可验证响应保留 outcome_unknown。原查询比较 scope、Workspace、准确 ifMatch、完整 read-set 和操作的语义字段，不依赖对象 key 顺序、不重发 POST。

[模型 controller 测试](../../packages/ui/test/tui/models.test.tsx) 核对 stale、原观察、迟到与原查询；[实际 PTY 测试](test/isolated/tui-models-host.test.ts) 使用自有临时 profile、固定本机 compatible Provider 和标准 80×24 终端验证真实按键。最终资格与失败过程记录于[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。此接入不扩展 Native 的有限设置 IPC，也不代表远端模型发现或正式旧 TUI 切换完成。


开发 `job reconcile <root-session> --input <ReconcileJobRequest JSON> [--server <local socket>]` 使用原 profile/Workspace 的配对或共享 Service。input 固定 `kind:"job.reconcile"`、expectedStoreId、commandId、executionId、expectedResultRevision，不能提交 adapter、关联或结果。`src/job-reconcile.ts` 在输出中保存准确原意图，丢回应只 GET 原 Command，同一 Client/commandId 不重复 POST；闭合回执必须匹配原 Store/Session/Execution/revision。verified退出0，已知拒绝1，unresolved/accepted/坏回执/未知2。0只证明核实，不表示原 Run 已恢复或工具重新执行。

Ctrl+C 中止该客户端的查询等待并返回130；共享模式仅detach，不取消原 Job 或其他工作。配套模式仍由所属进程关闭机制排空。`lookupJobReconcile` 可显式再查原申请；没有自动重发或后台轮询核实。CLI resume继续新任务、maintenance reconcile核实离线恢复journal，两者语义不变。[协议和参数](test/job-reconcile.test.ts)与[实际编译argv配对/共享宿主](test/isolated/job-reconcile-host.test.ts)分别验证丢回执/坏身份及冷外部ledger只查询一次、零重复效果与所属进程清理。


## 开发 CLI/TUI 宿主状态

`run --execution-status|--release-status|--telemetry-status` 支持配对与显式共享 Service。连接需要实际 `host_status`，使用 Client 的同一有限诊断；共享模式不选择配套资产、不停 daemon，配对退出只清理本次所属 Service。stdout 只输出一个 `{identity,scope,execution|release|telemetry}` JSON；原信任意图与宿主收尾提示使用 stderr，未知信任回执仍只查原 ID。

状态查询先定位准确 Workspace，显式 thread 必须已存在且匹配选定 Workspace。未信任时拒绝；只有显式 `--trust-workspace` 才注册缺失 Workspace 并保存原 revision/身份的信任 CAS，不创建 Session/Run 或发送任务。已信任的查询不新增业务记录。Store 不可用时只读无 scope 的安全诊断，输出 unavailable 并退出2；不尝试建库替代或信任写入。模型/Skill/权限任务选项不因状态读取而执行或改写 Session。

开发 TUI `/status` 通过有限 status port 调用同一 HTTP GET。host固定原 profile显示名和paired/shared模式，复核准入身份后只向UI传有限事实；观察流状态与诊断GET分开，GET成功不清除SSE失联。关闭或切换只释放所属读取，失败保最后确认事实并标当前unknown；不会取消Run或关闭Service。面板使用明确字段，不把完整DTO序列化到终端，更不显示token、endpoint或本机路径。该状态迁移不证明正式release/sandbox/exporter装配已具备。

[真实编译CLI状态](test/isolated/status-host.test.ts)验证配对/共享三flag、纯JSON、信任CAS、坏配置、原scope与零Provider/凭据backend访问；[真实80×24 TUI](test/isolated/tui-status-host.test.ts)验证paired/shared、读取失败重试与daemon强杀后的unknown，原运行和所属进程分别核实。

## 开发 TUI Skill 目录

`host/tui.tsx` 将公共 `listAllSkills(workspaceId,{storeId,signal,workflow?})` 接入 `/skills`。全部页使用原准入 Store 与当前 Workspace，在固定目录 revision 下完整收集；宿主不扫描 Skill 文件、读取正文或制造执行请求。仅确认 `skill_workflow_catalogue/run_extension_inputs` 两项能力时设置 `workflow:'manual'` 和 port 的 `workflowActivation`；无能力仍保持原知识目录。目录面板仅查看 metadata、独立 Workflow 资格与有限原因；R 刷新，Esc/Ctrl+C 释放所属读取。配对/共享使用同一方法，退出按已有所属生命周期处理。

共享 UI controller 实现动态 `/<compiled-name> [task]`、原 scope/草稿复核和准确 start/follow-up，host 只转交公共请求；固定命令优先，知识名不成为执行许可。Ctrl+L 核实原 unknown Command 后只刷新仍选中会话，Ctrl+K 保留宿主原查询入口，两者均不重复 POST。操作语义见[TUI 指南](../../docs/handbook/clients/tui/guides/mcp-and-skills.md#通用开发-tui-的-skill-目录)。[实际80×24目录测试](test/isolated/tui-skills-host.test.ts)负责跨页、读取隔离、零模型/执行；[动态 Workflow PTY](test/isolated/tui-workflow-host.test.ts)验证配对/共享实际输入、初始指令、原激活与完整完成，以及退出时准确所属进程。实际结果记录在[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

## 开发 TUI 显示偏好

`/theme` 与 `/language` 使用本机宿主 [tui-preferences.ts](host/tui-preferences.ts)，通过 UI 的有限 preference port 读写当前 profile 的 `ui/preferences.jsonc`。默认 `language: system`、`colorPreset: teal`、`theme: dark`；基础 `theme` 支持手工配置 dark/light。语言可选 system、zh-CN、en-US，配色可选 teal、blue、purple、cyan、mono。macOS 的 system 优先有界读取 AppleLanguages，再使用 Intl locale；其他平台使用 Intl。该新数据基线不读取旧用户目录，也不写 Service `config.jsonc`。

宿主持续持有 profile shared lease，读取和发布时核实原真实使用权、私有路径及文件；实际保存复用 configuration leaf 的稳定短文件锁、完整字节 SHA CAS、JSONC 单字段编辑和持久原子替换，保留无关字段与可保留注释。损坏、非法值、links、宽权限或失效 lease 局部拒绝。旧 revision 冲突不自动重试；另一个终端写入后需重新读取再明确选择。保存失败保留原显示值，发布后无法确认则报告有限 unknown 原因并允许重读。偏好文件纳入维护备份原字节资产，文件锁本身不进入备份。

设置属于当前 profile 的终端显示，不随 Session 切换、不依赖 SSE 写入准入，不提交 Command、Run、Model 或权限。关闭选择器不取消业务工作。当前实现与实际验证范围继续见总体[实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不能据此认定正式旧 TUI 或三平台发布已切换。

## 通用终端候选安装

新 `release:terminal` 的构建、完整 npm/固定 Bun 闭包、归档、安装、升级、回滚和使用锁卸载见[终端制品 owner](docs/terminal-release.md)。安装入口使用完整候选身份与独立 `default` profile；真实 macOS 搬迁与生命周期已验证，根正式入口已切换，完整跨平台资格仍待取得。

## 开发 Workflow 核验问题

CLI 保持原 Command 的 Store/Session/Run scope；原 Session 中没有独立 Run 的嵌套 verifier Job 审批，沿实际 `getExecution` 的持久 parent chain 核对归属，不依赖有限 view 窗口或当前 active Run。每一级必须匹配准确原 Store、Session 和 Execution ID；陌生 scope、循环或缺事实保持 unknown，不能通过回答另一任务的审批继续。父 `complete_skill` 与 `skill.workflow.verify` 的最低人工审批分别核对，父批准不替代 Job 批准。

[真实问题 CLI fixture](test/isolated/workflow-question-host.test.ts)采用默认 Service、真实 SQLite、固定 loopback Model 和原监督 verifier，通过实际普通 question 的 JSON `replan/waive`；保留 attempt 1 的全文输出、失败核验和准确原用户决定。丢失原答案响应和首次 GET 后，paired wait cycle 只查询封存原答案，不重复提示或 POST；保存答案仍不证明原 work 完成。[80×24 PTY fixture](test/isolated/tui-workflow-question-host.test.ts)通过真实独立审批按键和原 question JSON，Ctrl+L 核实原答案并重读当前快照，Ctrl+C 则取消准确原 work。精确资格和失败过程归[总体实施进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，本机固定模型证据不扩展为生产 sandbox、其他平台或完整 V1.3 资格。

## 显式冷恢复消费者

开发宿主提供 `recovery run <root-session> --input <ResumeRunRequest JSON>`、`recovery report <root-session> <original report Command ID> --input <ResumeJobReportRequest JSON>` 和 `recovery interrupt <root-session> --input <RecoverSessionRequest JSON>`。`resume` 继续表示已有会话的新 follow-up。Run 和 report 目标必须明确提供，提交前分别实际读取原 `getRun` / `getCommand` 并核对 ID、Store、Session；report 还须是原 `job.report`，不会从有限 view、活动 Run 或 pending input 目录猜目标。interrupt 只接受 `decision:interrupt`，公共请求不接受 owner generation、lease 或其他私有执行权。

[src/recovery.ts](src/recovery.ts) 封存原 Store、Session、commandId 和目标请求。CLI 和 TUI host 使用 [recovery-journal.ts](host/recovery-journal.ts) 在首次 POST 前持久发布 `ui/recovery.json`；闭合 version 1、最多 128 条、256 KiB，只有原公共 ID、目标、明确 interrupt 决定和 caller phase，不保存凭据或私有执行权，也不构成 Core 权威。宿主持有公开 profile-use lease，使用 `tui_private` 数据锁与私有权限、身份核验和 fsync 原子发布。冲突、满槽、坏文件、链接或不可用使用权局部拒绝且零 POST；未知和已确认申请均不自动驱逐，关闭面板不等于终态。旧 Store/Session 身份永久保留，不能重标到恢复后的新 Store。

`recovery list <root-session> --input '{"expectedStoreId":"..."}'` 读取当前原 scope 的 caller 目录；`recovery lookup <original-session> --input '{"expectedStoreId":"...","commandId":"..."}'` 按保存申请只 GET 原命令，也接受完整封存 `RecoveryIntent`。冷进程中的 submitting/accepted 只作为待核实意图，不重复提交。TUI `/recovery` 通过有限 host port 恢复未决记录；组件不开文件，切换/关闭不丢原 unknown，Ctrl+L 只查原申请。

回执须通过公共专用 decoder 与原 command/Store/Session/目标绑定；恢复 Run 再读取准确原 Run 并核对 originCommandId，report Run 的来源仍是原报告 command。`resumed` / `applied` 不表示模型完成。CLI [原 Run 观察器](src/index.ts) 固定原 runId/originCommandId，持续读取实际生命周期并复用原审批、question、附件和严格原答案回执；嵌套 Job 沿持久 parent chain 核归属。只读正常观察没有隐性总期限，Ctrl+C 结束本次等待、退出 130，零普通 work cancel。非交互 EOF 或未知原答案不能证明完成，仍活动时明确输出观察结束与 paired 所属 Service 收尾/shared detach；退出 0 仅在实际 completed 或无未知执行的显式中断回执，1 为明确失败/抑制，2 为受理/待交互/未知。中断回执保留实际 Tool/Model 未知列表，不把原未知效果改成成功。

[recovery-host.test.ts](test/isolated/recovery-host.test.ts) 使用编译默认 Service、固定 loopback SDK、普通 Ask 原 files.write 审批和 disposable owned SQLite，在原 Service SIGKILL 后验证接续/中断、一次 POST 与首次原 GET 丢回执；编译 paired/shared CLI 核原卡一次回答、准确决定 revision、原 Run 完成或中断、保存目录与冷 reference lookup、零 cancel 与重复效果。[tui-recovery-host.test.ts](test/isolated/tui-recovery-host.test.ts) 使用真实 80×24 PTY，另验证 TUI 宿主 SIGKILL、配对 Service 退出和冷进程从 durable journal 只原 GET，Ctrl+C/Ctrl+L 保原 scope。

恢复 PTY 的 Run、interrupt 与 report 窗口明确在一次原生写入中发送 Ctrl+C/Ctrl+L，沿同一原请求检查结果；暖/冷独立申请、原审批、单 POST、原 GET 与实际 Run/效果断言保持。共享 [恢复面板](../../packages/ui/src/tui/recovery-panel.tsx)区分控制批次与 bracketed paste，原材料和当前控件分别按其实际输出核对。完整默认负载及 scoped 结果归[总体进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不由驱动等待或有限组件反例推定全平台恢复资格。

[recovery-report-host.test.ts](test/isolated/recovery-report-host.test.ts) 与同一 PTY fixture 使用显式 program-host afterTurn policy、冻结 reader 角色/model/Task 与真实原 `job.report`：父 Run 已完成，独立 Child Job 批准且效果一次，冷恢复只生成唯一来源绑定的 report Run，report completion 通过原 ledger/SQLite 核实。该证据只覆盖 configured host，不证明默认制品已启用后台汇报。当前 macOS 开发资格不代表完整公共报告目录、全部崩溃窗口、其他平台或正式旧入口切换。

## 开发 TUI 输入编辑

通用 UI composer 提供原 scope 的 grapheme 光标、视觉行导航、历史、固定 slash 候选与真正 bracketed paste；CLI host 继续保存原完整 draft，输入层不扫描文件或取得业务执行权。[80×24 composer fixture](test/isolated/tui-composer-host.test.ts) 使用默认编译 Service、同 Store 明确新 Session、普通 Ask 与实际 loopback SDK relay，核对中文/emoji/combining中间编辑、原完整 CRLF/LF 粘贴一次提交、块删除、补全零提前 POST、真实 held Model 时多行草稿落盘、历史与会话切换，以及原审批一次回答后的 SQLite 完成。relay只保持并转发真实 SDK 响应，不伪造业务成功。

原已中断 Session 的后继输入曾在 composer 诊断中暴露未闭合 Tool history，真实失败日志已交 Core owner；本 fixture 的新明确 Session 资格不能替代那个恢复场景。文件补全、全部输入队列与完整正式终端切换仍分别待闭合。

开发 TUI `Ctrl+B` 已接 UI 的独立 pending 卡选择器。CLI host 保持原 Store 的完整分页公共目录与完整 artifact reader；选择和各卡草稿仅属 UI，POST 仍固定原展示 Session/card/revision，不从父 Run 或有限 view 推导权限。UI 的 [真实四卡 PTY](../../packages/ui/test/isolated/tui/pending-cards.test.ts) 使用 configured Core/Service 证明 sibling/root/ordinary required Job 的独立原作用域与完整附件；实际 `skill.workflow.verify` 默认工厂资格继续由本包 Workflow question/compensation fixture 单独提供。

开发 TUI 的 `/background` 由 host 仅接公共 SDK getExecution、listExecutionOutput、getView、listMessages、getModelOutput、cancelExecution/getCommand。UI 不获得 profile 文件、私有 ledger 或新的执行权。停止固定原 Job，独立于父 Run；响应未知只查原 Command。输出 gap 保持原事实，child 日志依实际 carrier/parent chain 与公共 child Session 关系核原 scope，具名 Model 全文单独验证。关闭读取和切会话不取消执行；当前 Job stop unknown 仅保存于 controller 内存，不等同于既有恢复申请的持久 journal。

UI 的 [真实 Job/child PTY](../../packages/ui/test/isolated/tui/executions.test.ts) 在 80×24 与 owned Service 证明原 Job 选择性停止、两条独立完整保留输出/gap、父 Run 完成后完整分页 child 历史和具名外置 Model 正文。实际线端一条停止 POST、原 Command 两条 GET，以及另一 Job 零取消和正常成功分别核验；该资格使用 configured harmless host policy，未覆盖默认 Shell adapter 或应用强杀后的 Job stop 意图持久化。

开发 TUI 的 `/plan`、`/plan <任务>` 与 Shift+Tab 复用公共 extensionInputs，不增加 profile/权限写入端口。空操作只切换原 Store/Workspace/Session 的下一次草稿；Planning 正文 POST 为 run.start 或原 Run 后的 input.follow_up，原 unknown 保冻结意图并只查询原 Command。模式不成为默认 Full 或跨会话授权。

[tui-planning-host.test.ts](test/isolated/tui-planning-host.test.ts) 的 slash-task/draft-mode/active-queued/scope-draft 四个真实 80×24 场景复用已冻结 compiled Service/supervisor 构建，但显式替换 owned 配置为 files.read/write 和固定兼容 Model，无 Skill 参与。原 Full 下先写失败；约143KB真实 Plan Artifact 由公共 SDK 完整读取一次，首 answer POST/首原 GET 丢回应后仍只有一条原答案及原 GET 两次。SQLite 核实际决定 revision、原 Run Planning snapshot、单次写入、真实 planning.update 效果 receipt/completePlan 与最终 completed；所属 Service 正常收尾。该 canonical disposable workspace 不替代普通路径 alias 平台资格，active-queued 实际冻结原 Run/selection，旧 Model 释放并完成后才运行唯一新规划；scope-draft 保另一原 Session 未提交文字与 Planning 模式，零另 Session Run。客户端强杀后的申请意图查回、其他平台或正式旧入口仍未由此资格覆盖。

## 开发 TUI Workspace 文件候选

[host/file-candidates.ts](host/file-candidates.ts) 实现 UI 的有限 readonly port；renderer 只给原 Store/Session/Workspace、query 和 opaque cursor，不能给 FS root。host 用实际 getView/listWorkspaces 核原身份，再从 canonical Workspace 的祖先目录逐段 no-follow openat，通过目录 FD 枚举相对文件名，不读取候选文件正文。固定排除与隐藏项保留；每个目录的 .gitignore 配置仅由同目录 FD no-follow 打开，核 regular/nlink/严格 UTF-8/前后事实，使用直接声明且精确锁定的 ignore 5.3.2 保留 comments/negation/嵌套 scope。坏配置、符号链接及变化子树明确 unavailable，不读取外部目标；目录更换/原 SDK scope 改变失败。配置按块读取并响应取消，候选目录没有首 500/8 项裁剪或新目录 quota；匹配排序后用固定 snapshot 完整分页。

[test/isolated/tui-file-candidates-host.test.ts](test/isolated/tui-file-candidates-host.test.ts) 的真实 owned Service/SDK/SQLite 与 80×24 PTY 核对 605 文件穷尽、嵌套 ignore、坏 UTF-8/硬链/外部 symlink、中文空格与 quote/backslash 的精确闭合普通文本。Tab、Esc 后编辑及候选 Ctrl+C 只影响本地读取，网络零 POST、files Session 零 Run、固定 provider 不增请求；真实另一 Workspace 的延迟原页不发布到新草稿。独立 built adapter 在源码目录外解析同一已安装 ignore@5.3.2 资产，不以 transitive/root import 绕过依赖声明。文件引用只是普通输入文本，未自动转成附件读取或 Model source。当前证明为本机 macOS；Linux/Windows 和正式旧 TUI 切换仍未由本 fixture 验证。

### TUI 普通 caller 的持久原意图

[TUI caller port](host/caller-port.ts) 与 [私有 journal](host/caller-journal.ts) 在首次发送普通 `run.start`、`input.steer`、`input.follow_up`（包含单次 Plan/Workflow envelope）、原 `command.cancel` 和准确 `execution.cancel` 前，持久发布独立 `ui/caller-intents.json` version 1。每条完整保存原 Store/Workspace/Session、认证 subject、Command ID、精确 target、完整闭合请求、完整正文 SHA 与公共 canonical request SHA；另存原草稿 ID/revision/text SHA，不把它作为新的执行权限。摘要及文件操作只属于 Node host；UI 不打开文件或取得 token/generation。私有文件 0600/regular/nlink1、目录 0700、公开 profile-use 与 `tui_private` 锁、UTF-8/etag CAS、write/fsync/rename/dir fsync 均在首次 POST 前完成。

容量为 128 条和整文件 16 MiB，属于本地私有元数据限制；满槽、容量、冲突、损坏、链接或使用权失败明确拒绝且零 POST，不裁正文或驱逐未确认记录。首次 POST 权只由成功新建记录获得并只消费一次；同 ID 已有记录（包括尚无服务端回执的 submitting）一律只 GET。冷 submitting/accepted 转 unknown，丢回执、缺失或错误证明保持原 unknown。查回精确核原 Command kind/Store/Session/subject/requestDigest、原 Session 的 Workspace，以及 Work receipt 的实际 Run/originCommand 或 steer target/context；cancel requested 仅表示请求取消，applied Work 不表示 Run 已完成。

`/recovery` 列出所有保存 caller，以箭头选择、Ctrl+L 只读原 Command、Ctrl+V 查看完整冻结请求；Ctrl+D 仅显式清除已核实 applied/rejected。Ctrl+C/关闭面板只停本次读取，切 Session 不改原身份；查回不会清理冷进程新草稿或单次 Plan 开关。原 caller 的取消优先保原 Command scope，Job 停止另核准确原新鲜 Job，零借父 Run 或另一 Job。有限端口的局部 prepare 失败保留输入，允许用户解决容量后明确新申请。普通 CLI JSON Work 入口共用下述有限 caller port。

真实资格由 [Work 强杀 PTY](test/isolated/tui-caller-intents-host.test.ts)、[三种原请求强杀](test/isolated/caller-kind-crash.test.ts)、[大正文/容量/身份反例](test/isolated/caller-port-host.test.ts) 和 [Job Stop 强杀 PTY](test/isolated/tui-caller-job-stop.test.ts) 分别证明：前者为真实默认 compiled paired Service 与 80×24 `runTUIHost`；三种请求为真实 compiled paired Service、申请进程和 Service SIGKILL；Job 窗口为真实兼容 SDK、可信显式普通 Shell factory、有限 host policy、两个真实独立 Job、生产 TUI/controller/caller port 的 80×24 宿主。factory 的 configurationId 文本不形成 OS 隔离。后者不冒称 daemon bootstrap 或配对 Job supervisor 的全部崩溃窗口。POST 与首次 caller GET 用真实 HTTP socket 丢回执，保留 wire、SQLite/公共 execution 事实、完整 journal 字节与 PTY；冷仅原 GET，另一 Job 未取消。2026-10-06 当前 macOS arm64 guardian 输入实际 1/16 通过，原 execution.cancel 在 POST 前落盘，caller SIGKILL 后首次原 GET 物理丢回执，再次只查同一 Command，冷 POST 为零、另一 Job 仍 running、Model 保持两次。Plan 大正文与原 draft proof 实测，Workflow envelope 的实际旧业务邻接与通用完整请求持久校验分别验证，尚未声称 Workflow 业务每个强杀窗口。

Offline maintenance v4 的 `assets.callerIntents` 与 CLI `caller_intents` 覆盖声明包含原有限私有资产；旧 v2/v3 白名单保持，展示不声明 profileComplete，也不将 UI 保存请求升级为 Core 执行 ledger。正式旧 TUI 入口、Linux/Windows 平台和其他 caller 强杀窗口仍按独立资格记录。

### 普通 CLI caller 的持久原申请

通用 CLI 的 `run/resume`、显式 Workflow 激活，以及有限 JSON 入口共用 [caller port](host/caller-port.ts) 和 `ui/caller-intents.json` v1。该文件保存原五类请求与四种固定Auth invoke、原 Store/Session/Workspace/subject/Command ID、准确 target、完整 body SHA 与公共 canonical request SHA；普通 CLI 不伪造 UI draft。首次 POST 必须在 journal write/fsync/etag CAS/rename/目录 fsync 后，已有 ID（包括 prepared 且查不到回执）只能 GET 原 Command，不换 ID 补发。128 槽、16 MiB 是该私有整文件的明确容量；未知记录不驱逐，正文不截断，满额/坏文件/硬链失败零 POST。存储格式、profile-use 锁和 Caller 维护资产与 TUI 共用；实际含固定 Auth 时采用闭合 v13，旧 v4–v12 请求文法保持，没有新增服务端任务 quota。

有限词法如下，均支持原 `--data-root`/`--kite-home` 与显式 `--server`：

```sh
kite work <sessionId> --input '<闭合 Caller DTO JSON：原五类或四固定 Auth>'
kite caller list <sessionId> --input '{"expectedStoreId":"原Store","workspaceId":"原Workspace"}'
kite caller lookup <sessionId> --input '<directory 中的完整原 intent JSON>'
```

`work` 接受原五类DTO及四个固定Auth invoke：builtin.mcp.sources、definitionVersion1、mcp.auth.login/refresh/clear/revoke，input恰serverId/full expectedReadSet。没有 URL、任意 action、私有 owner/generation 或通用 HTTP 转发。`lookup` 在资产/profile I/O 前检查闭合 intent 与摘要，随后要求本地完整原记录相等；缺记录、改正文/Store/Workspace/subject、原 GET 缺失或无法核实都保 unknown，永不补 POST。`list` 只返回原 Store/Session/Workspace 的本地申请；不是 Command/报告目录。读取关闭或 Ctrl+C 不清记录。`work run.start/input.follow_up` 依次输出完整 `caller.intent`、原 `caller.receipt`、只观察原 Command 的 `work.event` 与 `work.outcome` JSON；原申请得到实际 Run 后继续原审批、question 和完整输出生命周期，准确 Run completed 才成功退出。queued follow-up 持续查原 Command 与其实际 Run，不借当前 active Run。其他取消及Auth work和caller查询输出有限receipt/directory JSON；Auth applied仅是原Command结果，须另核mcp.auth.result，不能宣称Token保存；它们的 applied 只证明原回执，`cancel_requested` 不称目标已 cancelled。生命周期提示与原卡输入提示留给 stderr。退出 1 表示原失败或明确 prepare 未发 POST 的局部失败，2 表示尚未完成/unknown；非交互 EOF 或信号结束观察保留原记录。shared 仅 detach；paired 明确提示所属 Service 收尾可能中断仍活动的工作。

普通 `run/resume` 继续原实际分支：resume 选择 Session 后发起新 Work，并非冷恢复；普通路径构造 `run.start`，显式 Workflow 激活遇到实际 active Run 才构造冻结原 Run/context 的 follow-up。本片不改变活动处理。完整 Workflow/Plan `extensionInputs` 随原请求保存。Ctrl+C 取消是新的持久 `command.cancel` 申请，目标固定原 Work Command；paired 后续观察仍通过原 caller port，不跳过摘要/subject 检查。`runNonInteractive` 的 run/work 需要宿主提供 durable caller port；裸 Client 不具有本地持久申请权限，其他旧查询/管理语义保持。

实际资格见 [普通 argv](test/isolated/cli-caller-host.test.ts)、[三种原 caller 强杀](test/isolated/cli-caller-kinds.test.ts)、[library 与准确 Job Stop](test/isolated/cli-caller-library.test.ts)、[有限参数](test/caller-arguments.test.ts)。argv 使用 compiled 默认 Service、固定本机 compatible provider、owned disposable profile，分别验证 paired/shared 宿主 SIGKILL、prepared 零实际 POST、POST/首 GET 物理丢回执、原 GET、完整 UTF-8/CRLF Workflow 请求与 scope/body/subject 漂移零 POST。该 Workflow 例为绑定原 interrupted Run 的 queued/accepted follow-up，以显式结束观察保留 unknown，只证明原完整申请与查回，尚未提供 queued follow-up 完整等待至终态的正例，不称未配置 Workflow 业务执行成功。独立 actual main argv 正例在原 Session 显式 interrupt 后提交普通完整 UTF-8/CRLF Work，经一次原 Tool 审批、一次真实文件效果与三次 provider 请求，核原 Command 的实际 Run completed 后才关闭 paired Service；stdout 全部为 JSON，SQLite 与完整输出分别证明终态。library Job 资格复用真实普通 Shell guardian 与明确有限可信 host policy，两独立 Job 的原父 Run 已 completed；停止一个的强杀恢复不取消 sibling。此资格不替代 Native、三平台、正式旧入口切换或 §35 全部能力。


## Files 三范围恢复 caller

[Files host](host/file-recovery.ts) 用真实公共 SDK 的恢复点目录、完整详情与 recovery boundary 绑定当前 Store/Session/Workspace/subject/selector。[参数解析](src/arguments.ts) 提供 `files checkpoints|list <session>`、`files detail <session> <checkpoint>`、`files restore <session> <checkpoint> --scope=session|code|both`，以及 `files intents <session>`、`files lookup|continue <session> --input '<完整原 intent JSON>'`。session 创建实际 Fork；code 只恢复文件；both 先等待原 Code Job 的明确成功，再由用户明确 continue 原 Fork。Action applied 或 launch succeeded 均不代替 Job/逐文件 journal 成功。Code 的普通独立 Ask 经完整原卡回答，不能借原 Tool、会话模式或 Fork 来源授予权限。

[独立 journal](host/file-recovery-intents.ts) 将完整原点、原 scope、所有 Code/Fork Command、restore/newSession IDs、完整请求与摘要在首次 POST 前 fsync 到 `ui/file-recovery-intents.json@1`。它沿 profile-use/private-data 锁、0600 regular/no-follow/nlink1、etag CAS、rename/目录 fsync 发布。两 leg 分别保存；冷 prepared/submitting/unknown 只查原 Command/status，没有热 permit 或自动 POST。同 restore ID 不重写，unknown 不驱逐；Store 变更保留原身份并只读，不能重标新 Store。lookup 不开始第二 leg；continue 仍核当前真实身份和 selector，both 另核原 Code 成功与 fresh detail 每 path unchanged。外部编辑或后来完成的 distinct Run 可拒绝 Fork，保留 Code succeeded/Fork not_started，零 Code 重做。最后 detail 读取与 Fork 之间的外部编辑竞争未由全局文件锁消除。

`files.restore` 输出完整冻结 intent 与原 outcome；所有请求成功 exit 0、失败 exit 1、pending/unknown/部分完成 exit 2。EOF/信号只停止本地读取，不发取消 Job/Run。TUI 共用同一 host，renderer 不持 profile/token/文件权限，操作见 [TUI 恢复指南](../../docs/handbook/clients/tui/guides/cancellation-and-recovery.md)。

实际 [argv 三范围](test/isolated/file-recovery-argv.test.ts)、[CLI SIGKILL](test/isolated/file-recovery-crash.test.ts)、[物理丢回执](test/isolated/file-recovery-lost-replies.test.ts) 与 [第二 leg 漂移](test/isolated/file-recovery-second-leg-drift.test.ts) 使用源码外 compiled argv/default compiled Service、独立 HOME/profile、真实 SQLite/SDK 和固定兼容 Provider。真实 [80×24 PTY](test/isolated/tui-file-recovery.test.ts)、[另外两范围](test/isolated/tui-file-recovery-scopes.test.ts)、[TUI 丢回执](test/isolated/tui-file-recovery-lost-replies.test.ts) 与 [TUI SIGKILL](test/isolated/tui-file-recovery-crash.test.ts) 验证目录/三范围选择、独立 Ask、原 GET 与明确第二 leg；宿主编译保留已安装 Ink/React 依赖，不以 TS fallback 代替编译窗口。资格限本机 macOS，不代表正式旧 TUI 切换、Native 或其他平台；Files 捕获范围由业务 owner 定义，不能扩称 Shell/外部编辑的完整 workspace snapshot。

## 正式前门与 Native 登记

`bun run agent` / `tui` 固定使用 `dist/unified-terminal` 的完整候选；先构建依赖和该候选。显式 source/candidate 选择不读取安装登记。独立安装的 `bin/kite` / `kite-tui` 前门可由 Native 安装器显式登记：它持原 Terminal 使用锁，复核双方 nonce、Native active 与完整 outer/inner 闭包，再执行 Native 包内 Bun 和固定 CLI/TUI。其配套 Service 也来自同一闭包。

登记更新、撤销和原子指针的负责边界见[终端制品](docs/terminal-release.md)与[Native 制品](../desktop/docs/native-release.md)。纯帮助、版本、trace 及非 TTY 拒绝保持在业务准入之前。三条真实 CLI/TUI Work 已通过公共 Store 原 Command→Run 终态核对；本机证据限 macOS，不代表完整 §35 或其他平台。

待决分页当前验证见[CLI 纯页守卫](test/interaction-pages.test.ts)、[真实 40 Job 卡](test/isolated/interaction-pages.test.ts)及[真实原 work 后页](test/isolated/interaction-pages-original-work.test.ts)。后者保留先前已完成 Run 的 20 个 detached Job 审批待决，在后一原 Run 的 question 确实仍位于第二页时由 CLI 回答；回答时再次读取首页仍为原 20 卡，原 question 只产生一次效果且后一 Run completed。不能将先答完前页后移到首页的卡计为后页答复。

## TUI MCP 目录与配置选择

[原目录工具描述查看](../../packages/agent/src/mcp/README.md#原工具-metadata-的不可变保存与查看)通过公共 `decodeMcpToolsSnapshots`、`decodeMcpToolsPage` 与 `readMcpToolDescriptor` 接线。Host核当前准入 Store/subject/Session，原snapshot origin/generation/indexDigest与准确startIndex，nextAfterKey严格超过原请求afterKey；filtered空页可以前进。完整descriptor沿原publisher Artifact scope读取，currentStore与历史origin分别绑定，查询没有POST/连接/凭据或业务取消。

[Host有限端口测试](test/mcp-tools-port.test.ts)与新Ink/原15MCP组合25/550/0；其Artifact callback属于受控接线fixture，真实HTTP完整字节由Client独立40/128证明。[源码外80×24实际PTY](test/isolated/tui-mcp-tools-pty.test.ts)当前两份独立Profile并发各1/43/0、12.34s/12.33s：两代暖/冷各自选择后页Tool，完整EOF/hash后键盘到inputSchema及metadata tail，各保8份原帧。UI HTTP分别817/796条、全部GET，原RPC各4未增加，Model/credential0，四次公共getView各原Session均无Run。真实default scoped source的connect与refresh取得三个独立Ask，冷轮移除源仍读原metadata；此前832GET/cold422属于原先独立source窗口。

该candidate使用默认1MiB MCP frame预算，实际schema约714KiB；Agent与Client超过1MiB原body分别有独立资格，不将这份PTY称为大于1MiB wire。正常暖/冷TUI与所属Service均确认退出，cleanup=true并删除ownedroot。默认全图曾暴露API完成早于TUI渲染、输入被待决卡吞掉的fixture竞态；现在在原10s内等最新完整Ink帧的准确原refresh result executionId、metadata及无审批Composer后才输入，不用旧累计画面提前命中。原180s期限、43断言和helper保持。此前默认来源、GET、按键及64cells行断开红日志保留；异常timeout/throw/SIGKILL清理未因正常退出取得资格。当前Tool查看不代替认证、重连、增删或三平台发行。

[tui-mcp.ts](host/tui-mcp.ts)仅通过公共Client接固定 `mcp.servers` Query、`mcp.server.select@1`普通Action与原Command/Execution/HostMutation GET。完整安全目录与UI选择合同归[TUI owner](../../packages/ui/src/tui/README.md#mcp-安全目录与原选择意图)；host不接原始Server配置或secret，读取零连接/凭据/Model。点击时封存实际Store/Session/Workspace/identity、完整read-set、server/enabled/scope和commandId；请求SHA按实际Core canonical input核，不能用HTTP bodyDigest互换。

accepted Command保持pending；配置已保存须原subject/Store/Command kind/request SHA、原Action版本/Execution及成功结果binding、真实原config mutation请求摘要/安全CAS marker/applied receipt和公共HostMutation GET全部一致。派发失败只有明确effectAttempted:false才显示known failed；发布后SQLite receipt故障仍unknown，lookup只有原GET，不重POST或换CAS。

独立 [intent codec](host/mcp-selection-intents.ts) 与 [journal](host/mcp-selection-journal.ts) 持有 `ui/mcp-selection-intents.json@1`，不扩展普通五类 caller、答案或 Files 格式。首次 POST 前保存完整原 subject、Store/Session/Workspace/identity、Command/request、body/request SHA 和 phase；同一短 data lock 内复核冲突与容量，再经私有 temp/fsync、原 etag CAS、rename/目录同步和重读验证。最多128条、整文件16MiB，未知不淘汰；既有或冷记录永无 prepare 的热 POST 权利。冷列表按未知意图显示，由用户选择原 ID 后显式 GET；换 Store 或 subject 不匹配在 GET 前拒绝。历史 GET 不依赖当前目录或物理 Workspace 仍存在；新修改仍须核当前实际 Workspace identity 与完整 read-set。

[真实MCP Host测试](test/isolated/tui-mcp-host.test.ts)使用实际default Service/SQLite/loopback、owned config与临时credentialBackend，4项43断言通过：JSONC注释/未知值保留，原POST丢回执后单Command/Execution与只GET，实际CAS drift零修改，普通Ask批准前零修改，发布后真实HostMutation SQL故障保unknown。丢响应hook转发实际SDK后报网络未知，不宣称物理socket破坏。当前安全Query、有限启停与原Tools查看不覆盖OAuth、重连或增删；真实PTY及平台资格另按[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)保留。

[真实冷 Host](test/isolated/tui-mcp-cold.test.ts)以源码外编译 caller、物理 relay socket 丢失和准确 SIGKILL 核预 POST 与已提交两个窗口，同 Profile 冷查只 GET 原 Command/Execution/HostMutation；Server 移除和 Workspace 改名后仍能查询历史，fresh drift 零 POST。实际 [80×24 PTY](test/isolated/tui-mcp-pty.test.ts)核一份真实 MCP 修改、后续 active Run、原审批/history/drafts 保留及关闭/刷新/clear 隔离。 返回Main/clear后核当前待决输入与原卡公开事实，不要求同版本Static材料重印；当前1项21断言、9.83s，原四次Provider、一份配置POST、零MCP RPC与效果/草稿断言保持。独立 [journal 测试](test/mcp-selection-journal.test.ts)核128/16MiB、重复身份、scope冲突和坏文件。[冷重开真实80×24 TUI](test/isolated/tui-mcp-cold-pty.test.ts)由首轮真实键盘生成两份原选择并独立批准原 Job，正常 Ctrl+Q 后同 Profile/Store/subject/Session/Workspace 再开真实空目录。上下/Enter 选择第二原 ID 时零查询，再明确 Check 才唯一 GET 第二原 Command 并核原 Execution/HostMutation；冷轮所有 POST、Model、Run、凭据、MCP RPC 与取消均零，所属 TUI/Service 逐 PID ESRCH。控制端只观察/批准原卡，不代替被测试的 TUI 提交或导航。异常收尾先 SIGINT 交给仍持有 Popen 的 Python finally；未确认退出保留根并失败，不对历史数字 PID/PGID 发 fallback 信号，该异常分支未完整资格验证。当前这些实际证据均在 macOS；私有文件 owner/mode/no-follow 路径不能据此冒称 Windows 或 sealed default-main/full release 资格。备份 v8 的字节与外来 Store 冷读取由[维护 owner](../../packages/agent/src/maintenance/README.md#mcp-选择意图的独立离线资产)单独验证。

## TUI MCP 项目来源决定与原申请

[Source Host](host/tui-mcp-source-approval.ts)只用公开 Client 查询 `mcp.sources@1`、提交普通 `builtin.mcp.sources/mcp.source.approve@1` 和读取 `mcp.source.result@1`，通过可选 `TuiMcpPort.source` 接入共享 TUI。当前目录核真实 serverInfo Store/subject、Session 未删、完整 `listAllWorkspaces` 和 canonical root/dev/ino；来源每页25项、完整 envelope64KiB、累计8192项/16MiB。所有页的完整六字段 Source readSet、registryRevision、errors 必须相等，ID严格递增、cursor前进；失败不交付部分complete。正常errors为准确四文件键对象，unavailable为非空有限代码数组，不改变backend合同。Source ID沿原名称生成，不能从invalid安全显示名反推。

新申请重新完整读取并核对原observed及 `input.expectedReadSet`；项目transport/source binding有效且workspace read error为空才prepare，不要求admitted/enabled。Source readSet与管理readSet不互换：scopeDigest、user、workspace、approvalEtag、bindingEtag、variablesDigest及各文件的identity/etag/error完整保存，error沿string|null，无新增单字段长度合同；整体仍有预算。当前源码通过准确keycount与membership核闭合对象，拒绝带逗号的替代键。

[意图codec](host/mcp-source-approval-intents.ts)及[journal](host/mcp-source-approval-journal.ts)独立持有 `ui/mcp-source-approval-intents.json@1`。闭合intent保存原S/W/full workspaceIdentity和完整request；record另保subject、完整bodySHA、去expectedStoreId/commandId的Core requestSHA及phase。只在成功私有durable prepare后本次调用首次POST；重复或冷记录只原GET。同Store+Workspace+Server的submitting/pending/unknown跨Session和fingerprint阻止新申请；128条/16MiB不淘汰unknown，saved/failed/cancelled不降级。原Profile-use lease、短data lock、no-follow/private/owner/single-link、held stat、etag CAS、exclusive temp/fsync/rename/目录sync和重读保持。临时文件删除失败仍进入独立finally释放短写锁，该异常故障位置尚未注入资格。

历史list只恢复原意图为unknown、零HTTP；显式lookup或duplicate核原subject/Store/完整journal identity后才GET原Command和有限Query，不读取当前物理Workspace/source，不补POST。结果再次匹配原Command digest/status/receipt Execution、原Execution inputDigest/definition/Store/S、八字段proof、确定性mutation ID/subject及实际终态。Command.applied、journal终态或部分mutation均不能单独证明saved；跨读窗口不一致保unknown，下次准确原GET确认。

[真实Host](test/isolated/tui-mcp-source-approval-host.test.ts)当前7项817断言与[journal](test/mcp-source-approval-journal.test.ts)5项44断言通过，固定28个当前owner文件、原runner4/isolated max1/no-orphans与parent umask022；实际103来源/102 Workspace、原approved/rejected/cancel、scope/source漂移零POST、跨Session冲突、wrong subject零GET、同Store冷移走物理W、公开v10 A→B后list/lookup/duplicate所有HTTP0。真实发布完成后relay物理断POST回执，冷原GET再断socket仍unknown，随后duplicate只GET确认同原proof/mutation且总POST1；Model/vault/MCP RPC均0。有限页budget另用真实public scope/row模板的合成328页核8192正/8193负，不冒称8193真实producer及时资格；先前真实8193来源20s测试超时、原runner106.892s排空的红日志保留。字段别名、64KiB/16KiB envelope和坏原proof等反例分别核所述范围。 初次POST后的Command GET与有限Query可能跨状态变化，不能强求立即pending；fixture只提交一次，再在既有8s预算内明确GET同一原ID等待准确pending，不改生产unknown守卫。

[源码外当前80×24 PTY](test/isolated/tui-mcp-source-approval-pty.test.ts)实际1项280断言通过，原runner排空16.249s。公开terminal builder/verifier与真实Root Git生成独立candidate；父进程在首DB/Worker前通过Artifact SH、锁内重验与公开引擎选择装载同candidate实际SQLite3.51.3，Service依赖按实际owner解析核验。真实键盘分别完成approved/rejected/cancel的独立Review、普通审批和原Source Question，初始空Enter未增加Answer；暖窗准确3个Source Action POST、3个普通approval Answer及3个Source Question Answer。先移除source文件，再移动物理Workspace，两次冷窗各逐一选择三个原ID，选择零结果GET，明确Check后每项恰1个原Command GET及原Query；两窗UI POST均0，原proof/Execution/mutation保持。随后公开v10 create/inspect/restore生成B，真实B终端显示A的三个原Store/Command/Session，明确Check全部保持unknown且原Command/result lookup HTTP0、POST0；正常B目录启动GET允许，fixture确认original_store_mismatch，公开fact不伪造额外reason。四窗journal4977原字节及SHA保持，Model/凭据/MCP RPC/Run均0。

首个冷原决定本来已选中，只在核准原Command/Store/Session明细后沿用同步完整帧；后两项等待实际明细切换。明确Check已证明的同一unknown明细可沿用无变化帧，不当作新server receipt。观察器的wire记录POST attempt早于受理提交，准确404/command_not_found仅在原10s内继续GET同ID，其他错误立即失败，不重POST。原10/12/6+3/180s与全部业务断言保持。四个TUI正常Ctrl+Q，seed与四窗共五份所属Service退出收据匹配，ownedroot及parentHOME删除。之前的重选、父引擎未选择、原只读维护创建副文件和观察窗口红证据分别保留，不回推未观测的精确因果。本轮未测Store change cursor、异常清理fault、Screen emulator、中文或Linux/Windows；cursor合同由上面的真实Host另核。当前正常Root/八workspace构建与类型检查通过，观察器修正后的CLI类型检查再通过；第27轮534文件/432唯一主任务完整默认实际exit0、734.039s排空，准确冻结和其余未验证范围见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

## TUI MCP 显式连接与原申请

[connection host](host/tui-mcp-connection.ts)只通过公共Client申请普通 `builtin.mcp/mcp.connect@1`、GET原Command与有限 `mcp.connection@1` Query，不建第二Runtime。新提交核真实serverInfo Store/subject、Session、`listAllWorkspaces`完整目录、物理canonical root/dev/ino、当前完整安全目录等于原observed，并要求准确Server admitted/selected/available。原read-set只核新申请来源观察，不伪装为connect input CAS；最终来源捕获和派发仍由Service核实。历史读取不要求当前Source或物理Workspace仍存在。

[独立codec](host/mcp-connection-intents.ts)与[journal](host/mcp-connection-journal.ts)保存 `ui/mcp-connection-intents.json@1`，不扩大五类caller、答案、Files或旧MCP选择格式。每条闭合完整原request/subject/Store/Session/Workspace/identity、body/request SHA和有限phase；只有本进程成功durable prepare才有原首次POST权，重复/冷记录只查原GET。沿Profile-use lease、短data lock、private/no-follow/单链接/实体、16MiB/128、etag CAS、temp/fsync/rename/目录同步和重读。冲突域Store+Session+Server，unknown不淘汰；ready/failed journal终态不降级，cold list只恢复原意图为unknown，不当当前结果证明。

原Command须准确originStore/subject/Session/kind/requestDigest，applied receipt指向原Action；Query核Action inputDigest、definition/version、原operationRef六字段、实际connection Job/parent和created key关系。完整Display envelope≤16KiB，不传transport、credential或definitions正文。accepted只pending；ready、current live和新建/复用独立，带detached operation的失败不清unknown。stored intent与当前Store或subject不同在任何GET前拒绝，不替换ID/key；丢回应、404或坏结果只unknown。

[journal实际文件测试](test/mcp-connection-journal.test.ts)5项174断言通过。[真实DefaultService/SQLite/HTTP Host](test/isolated/tui-mcp-connection-host.test.ts)4项90断言通过：两个普通Ask前零RPC、真实新建及warm复用、同Store冷removed-source原GET不重POST、明确cold新申请、实际丢调用方回应与冷duplicate GET-only、source漂移/foreign主体Store/坏有限结果拒绝。第四例实际102个Workspace，旧首100页不含当前w，而完整目录核验仍新建连接；准确legacy方法调用计数为0。控制端仅批准实际原卡，Model、credential、Run均0；丢回应hook不是物理socket破坏。

[实际Host备份恢复](test/isolated/tui-mcp-connection-restore.test.ts)1项37断言、743ms：真实普通连接至ready后停Service/Runtime/Store、关journal并释放Profile lease，公开create/inspect/restore v9生成B。原727字节journal、A身份/Command/subject/SHA/ready保持；B以实际serverInfo重新准入，list/选原ID、lookup和duplicate submit均HTTP GET/POST/其他0、peer RPC保持2、Model/credential0、cursor保持16、原bytes不变。没有新B连接或重标；正常所属资源关闭及ownedroot清理确认。该例补足实际Port跨Store拒绝，独立于下面同Store冷TUI。

[此前源码外80×24 PTY](test/isolated/tui-mcp-connection-pty.test.ts)1项61断言、10.85s，在固定文案locale修复后的fresh构建上，通过真实键盘暖申请、warm复用、paired退出、removed-source冷空目录选第二原ID零GET、显式原查回零POST，再恢复owned source并独立确认新申请。warm UI HTTP GET126/POST2、cold GET197/POST1，最后cold POST来自明确新确认；原查回ready但live=false，新申请新Job/created=true。Model/credential/Run0。shared TUI exit0时held Service仍live，随后持有的subprocess handle SIGTERM关闭并exit0；两TUI exit0、paired ESRCH、cleanupConfirmed=true、ownedroot删除。candidate `e25977303279ce68fc182f4db8f11030b9cde2c183d4717aed7774920de76212`，helper `b84e4e2fc7d02b2e2c1d81a3c940781a70d10140d1d13eb300d93d881ed288d5`，packet SHA `cbb47d49834713512c77dc0a2d378cf3a83c6edbfe013722a370c2452eab082b`。实际原IDs与分段计数保存在owned packet；红日志和旧sourcewindow保留。本例为英文实际终端，中文固定文案与外部metadata保真由[UI实际Ink测试](../../packages/ui/src/tui/README.md#mcp-显式连接与原申请)单独证明；正常生命周期不推定timeout/SIGKILL/异常cleanup或其他平台。v9原字节维护由[maintenance owner](../../packages/agent/src/maintenance/README.md#mcp-连接申请的独立离线资产)负责；完整OAuth、强制warm重连、增删与三平台仍未闭合。

当前Source入口整合后的同一[connection PTY](test/isolated/tui-mcp-connection-pty.test.ts)明确选observed Server与原ID明细，适配新增Project sources/Review行。恢复原申请后按当前完整帧的选项标签进行有限导航，不再按固定两次Up推定Check位置；实际公开candidate 1项71断言、10.67s排空通过。保原普通申请、warm复用、原冷GET、独立新Confirm、shared detach与paired cleanup；准确原Store/Session核验、helper字节和原业务预算保持。旧菜单导航红与最新有限通过分别见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，当前完整默认资格独立核对。

## TUI MCP 强制重连与原申请

[Host](host/tui-mcp-reconnection.ts)在任何新HTTP前核own journal、原subject/Store/S、完整flat targetRequest与本次closed request。Review读取原Command/connection或RQuery的真实live/generation，再完整分页读取当前Workspace/Source并核physical identity与read-set。prepare前及首次POST前再次核同一完整观察；当前Host预算为8192项/16MiB、Source25项分页/64KiB envelope，不用管理目录32项预算截断来源。历史lookup只原Command与有限RQuery，不依赖source文件或physical Workspace仍存在。

[实际事件刷新](host/tui.tsx)明确标识同Session后台历史读取，[controller](../../packages/ui/src/tui/controller.ts)在健康原scope保留独立Review；显式选Session、Workspace变化、离线或失败快照仍失效。原Host完整fresh核验与普通Action/Job审批不变。PTY驱动读取当前完整帧的全部原ID，排除旧回执并核本次Command；控制HTTP等待期间持续排空PTY，且下一次 `/mcp` 等当前非Loading composer。新ID出现本身不证明durable prepare或POST，真正受理与原审批仍由公开Client读取核证；原10秒业务/帧及12秒控制期限保持。

独立[reconnection journal](host/mcp-reconnection-journal.ts)保存 `ui/mcp-reconnection-intents.json@1` 的intent/subjectId/bodySha256/requestSha256/phase。body与Core canonical请求摘要分别重算；targetRequest保准确前一普通C或R完整request，不递归嵌套。只有成功私有durable prepare的本次进程可首次POST；cold/duplicate仅原GET，foreign Store/subject在全部HTTP前拒绝。128条/16MiB不淘汰unknown。

[共用文件边界](host/mcp-transport-journal-files.ts)沿Profile-use lease与同一短 `tui-private.lock`核ordinary/reconnection未确认冲突，保no-follow、owner/mode、单硬链、held实体、fatal UTF8、etag CAS、exclusive temp、fsync/rename/目录sync。同Store+S+Server跨两个journal仍冲突，不能靠两个内存Map绕过。维护通过公共v11保存完整原bytes，新Store不retag、不授原HTTP或热权利。

[真实Host](test/isolated/tui-mcp-reconnection-host.test.ts)、[物理回执丢失](test/isolated/tui-mcp-reconnection-recovery.test.ts)、[公开A→B恢复](test/isolated/tui-mcp-reconnection-restore.test.ts)实际8项134断言与[journal](test/mcp-reconnection-journal.test.ts)6项181断言分别维护其范围。约700KiB完整Unicode/CRLF descriptor沿默认1MiB Source frame预算，不称大于1MiB wire。原POST受理后与冷首GET实际毁socket；unknown阻两类新申请，原Store恢复拒绝全部HTTP，原metadata/journal bytes/cursor和零Model/vault/Tool保持。

[源码外80×24测试](test/isolated/tui-mcp-reconnection-pty.test.ts)经公开Root builder与实际Git构建独立candidate，最新整例实际1项226断言、13.87s原runner正常排空。真实键盘完成ordinary A、warm B、R1独立Confirm/Action与Job批准、R2以原R1为target并独立拒绝新Job；准确旧terminal/transportStopped早于新open，暖窗4次UI POST、两组initialize/tools-list，原ready与旧停新失败分别保留。Source与physical Workspace移除后的冷窗选择原ID零GET，明确Check只原Command/Query两GET、UI POST0；公开v11 A→B后原申请7317bytes/SHA保持，B明确查回仍在全部原HTTP前拒绝。两冷窗Store cursor均保持，Model/凭据/Tool效果零；所属服务与TUI正常退出、candidate lease和ownedroot释放。早期导航/答案失败保在[总体进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，异常清理、持续Soak、OSvault和Linux/Windows仍按各实际窗口验收。

## TUI MCP 来源条目增删与原申请

共享 controller 的来源目录与原申请读取各有独立 lifetime；原 ID 的选择和明确查回不取消当前目录查询。同 Session 历史刷新保留实际 Reading，关闭或切 Session/Workspace 取消所属 Reader，已经提交的原 Action/Job 与审批继续。原源码外窗口 Add→查回→Remove、cold removed和foreign恢复验证这一交接，实际资格见[共享 TUI](../../packages/ui/src/tui/README.md#mcp-来源条目增删与原申请)和[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[独立 Host](host/tui-mcp-source-mutation.ts)接普通 `builtin.mcp.sources/mcp.source.add@1`、`mcp.source.remove@1`，当前 `mcp.source.entry.preview` 与历史 `mcp.source.mutation.result` Query。提交核真实 Store/subject/Session、完整 Workspace 目录、canonical root/dev/ino、同版本完整 Source 分页及六字段 read-set；当前读取预算为 8192 项/16MiB。Add 只接受闭合 basic 名称、HTTP URL 或绝对 STDIO command，不收 args/env/headers/auth/Tool policy；Remove 核准确 source/raw digest 和安全 fallback，不让当前目录替代原删除身份。

[原 intent codec](host/mcp-source-mutation-intents.ts)与[journal](host/mcp-source-mutation-journal.ts)保存独立 `ui/mcp-source-mutation-intents.json@1`，闭合每条完整 intent/subjectId/bodySha256/requestSha256/phase。完整 body 与公开 canonical request 分别重算摘要；128 条/16MiB 不淘汰 unknown。只有本次完整 durable prepare 有一次原 POST 权，cold、已有或 duplicate 仅查原 ID。选择原记录零 GET，明确 Check 只原 Command 与有限历史 Query；foreign Store/subject 在原 HTTP 前拒绝，关闭及切 Session 不取消 Action、Run 或审批。

[共享 Source 文件边界](host/mcp-source-journal-files.ts)在同一 `tui_private` 短锁内核变更与批准的原 closed 文件。原 Store 中同一来源文件的未确认修改跨 Session 阻挡，user 来源跨 Workspace，project 来源按准确原 source identity；批准的两层 read-set 与变更目标 identity 相交时也拒绝。坏 sibling、跨 journal 重复 Command、容量和 private/no-follow/held identity 失败均零新 POST。selection 的配置介质、ordinary/forced transport 的既有 unknown guard 继续独立；raw 修改不修复、重绑或重放其效果。

saved 必须同时核准确原 Command/subject/requestDigest、原 E 的 definition/version/inputDigest/root-work、完整结果 finalization、HostMutation applied 与 leaf 的 old/new ETag 和 marker/raw digest。failed/cancelled 仅在匹配原终态及完整零 publication 证明时解除未知，阶段字符串不作成功证明；不完整 receipt、404、丢回复或准备下一 attempt 保 unknown。Query 内部读取私有 Mutation 证明，公共配置管理 API 的同名方法不用于伪造此审计。

[codec/journal 测试](test/mcp-source-mutation.test.ts)、[有限 Host 反例](test/tui-mcp-source-mutation.test.ts)、[真实默认 Service 恢复测试](test/isolated/tui-mcp-source-mutation-recovery.test.ts)分别覆盖本地冲突/容量、closed 原事实和物理 socket 丢 POST/首 GET 回复。恢复测试实际 Add/Remove 各只有一个 POST，冷 caller 明确 lookup 得到原 saved 后 duplicate 仍仅 GET，游标、来源字节与唯一 Mutation 保持；Remove 读取 52 个来源的三页及 101 个 Workspace，目标不在首页。它证明同进程 caller/journal/Profile lease 冷重开，不声明 SIGKILL。

[源码外 80×24 PTY](test/isolated/tui-mcp-source-mutation-pty.test.ts)沿真实 public terminal builder、Git、完整 candidate 和首 DB 前 selected SQLite 3.51.3，逐键 Add、Remove、Review/Confirm 与独立普通审批。移除 project 前明确显示 user fallback；新 project 保存仍 pending 独立来源批准。Source 与 physical Workspace 移除后的原选择零 GET、明确 Check 两原 GET、POST 0；公开 v12 create/inspect/restore 至新 Store 后保原 journal bytes/IDs，明确查回零原 HTTP。准确冻结、原失败、最新复验、正常退出和当前完整默认由[总体进度](../../docs/plans/unified-agent-refactor-v1-progress.md)记录。source-entry saved只证明声明发布，当前可选credentialCleanup单独表示owned本地清理；真实OS浏览器、OAuth PTY、持续Soak与三平台仍按各实际证据核验。


## TUI MCP HTTP 认证与原申请

[Auth host](host/tui-mcp-auth.ts)以当前完整Source snapshot/read-set核四个固定普通Action，prepare/submit复用同一[caller port](host/caller-port.ts)和ui/caller-intents.json，没有新Auth journal。首次POST仍需当前durable prepare；cold/duplicate只原GET，Store/subject在HTTP前实核。canonical Caller只闭合这四种Auth，不成为任意invoke转发；原五类请求类型继续供旧Desktop语法。

status只当前safe policy/backend/presence。lookup核原Caller C/subject/request digest/receipt Execution，再核mcp.auth.result的完整binding/input digest/phase/authStatus/effectAttempted；Command applied单独不显示认证成功。history无当前Source/W/Vault读取，新Clear/Revoke仍需fresh Source/read-set，不能借历史越域。pending/unknown阻同scope冲突，cancel用同一execution.cancel普通申请。

TUI先Review再独立Enter确认，成功提示凭据保存和另行连接；冷选择零GET，明确Check才查原Caller/Query，关闭/切S只停Reader。现有asset实际含Auth才选v13，旧manifest/请求语法不扩大，A→B保原bytes/身份且不授新HTTP许可。[Host](test/isolated/tui-mcp-auth.test.ts)、[Caller契约](test/isolated/caller-auth-contract.test.ts)和[Ink](../../packages/ui/test/tui/mcp-auth.test.tsx)各保实际范围；当前默认图与历史红见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[源码外80×24 Auth PTY](test/isolated/tui-mcp-auth-pty.test.ts)经公开 terminal builder、实际 paired Service/Runtime/SQLite 与 Client，真实键盘依次完成 Login、Refresh、Revoke、Login、Clear 的 Review 与独立 Enter Confirm。五个原 Command/Execution 唯一，UI仅五次 Auth POST；每次普通 Ask 核准确原 Execution/definition/revision，由 observer SDK 回答 approve_once，不能称为键盘审批。受控 AS 实际经过 discovery、两次 DCR/PKCE/callback、token、refresh 和 revoke，MCP RPC/Model均零，没有自动连接。

同Profile/Store/subject/Session冷重开前实际移除Source与physical Workspace；选择准确第二原ID零原结果GET，明确Check后该次实际仅原Command与mcp.auth.result两GET、POST零，AS与Vault操作数保持。最新完整Ink帧的可见目标用于导航，保原10s步骤、12s control及180s测试预算。暖/冷TUI和seed/warm/cold Service均有正常退出与所属清理确认。该本机资格使用临时Vault和fetch callback opener，系统浏览器、原生OAuth Vault组合、异常cleanup、cursor不变、A→B及Linux/Windows仍须各自实际证据。
