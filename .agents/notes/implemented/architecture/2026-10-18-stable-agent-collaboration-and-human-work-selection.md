# Agent Note: 稳定协作者、真实工作选择与可靠结果接纳

Status: implemented

2026-10-22 部分替代：用户确认移除独立输入归属判定，当前采用[普通消息直接进入主 Agent](2026-10-22-direct-conversation-input.md)。本记录的输入预判、自然语言控制预处理、selected-work 屏障、按工作过滤普通结果和自动恢复旧配置仅作历史理由；稳定协作者、精确来源、实时权限、unknown 和旧消息审计／呈现兼容仍适用。当前事实以手册与 owner 文档为准。

## Problem

父 Agent 一次普通回复结束不代表 child 的工作、完整结果与必要清理已经结束。原单轮 task/disposition 接口把协作者身份、某次执行、观察水位和结果采用混在一起；简单去掉 report suppression 又会把 A 的迟到结果与效果带进后来独立任务 B。另一方面，用户问进度或澄清并没有撤销 A，取消 B 也不能推出选择 A。运行中改变根审批模式还必须同时作用到已存在的子孙，而不会解除可信只读能力或共享单次批准。

本轮用户明确要求按外部《Kite 子 Agent 协作优化方案 V1.1 · 实施补充版》第1–9节及最新6.5.1实施；第10节历史云端状态与测试数不成为本地证据。基线为 f734245a8b761cd75518624c250c9761e9676091，原文SHA256为 cce7a0760637c0517831ee8fdcf89476e717d5d0dc87f392d5ae5640f2a0280b。当前实现事实分别由[执行手册](../../../../docs/handbook/features/execution.md)、[Task](../../../../packages/agent/src/extensions/task/README.md)、[输入](../../../../packages/agent/src/storage/sqlite/inputs/README.md)、[权限](../../../../packages/agent/src/permissions/README.md)和[跨包契约](../../../../docs/active/unified-agent-boundary.md)负责。

## Decision

真实输入的公共展示保留 SQL 处理轮与业务轮的独立记录，通过只读 `Message.humanInput` 封存同一原输入及公开提交关系。只有准确已应用业务及实际替代 Message 的完整链成立时才标记处理副本；Native 还须在本次读取内核实替代行。首次占位沿公开提交 ID 交接，不能沿后来不同的业务 ID 推断。相同正文的独立新输入继续独立，固定旧上界或不完整读取保原文；此证明不取得执行或恢复权限。

去重后的业务消息保完整身份与附件，展示位置锚定较早的原输入。仅删除早处理行会让夹在两行间的助手答复排到用户之前；改变业务 `seq` 或借处理 ID 拼接正文又会混淆真实阅读出处。采用原业务对象的呈现移位，存储顺序、工具读取和原 Run 资格保持，测试同时核唯一气泡与完整因果顺序。

封存 Fork 只在原出处与本分支实际复制的替代行同时核实时映射本地重复关系，不借源会话后来新增的业务隐藏旧分支原文；正文、parts 和原游标保留。

复用既有 Session/Run/Command/Execution、唯一普通 Loop、ChildSlots 和准确 Artifact/Source。稳定 agent_id 为 child Session，某轮 carrier/Run/result revision 仍各自准确；六工具收敛模型入口，旧定义仅服务真实内部调用与准确历史，不保模型 alias。目录以首次创建 Command seq 为锚点，固定枚举身份上界与每页当前状态分开，原委派/最近输入/结果各保可读来源。

真实公共请求、raw 人类输入、关联/选择/control revision 决定和业务准入分开保存。Host只直接处理当前未引用的明确指令，其余由封存无工具的普通 Model 提出关联，再由Host/Store独立验证；引用、邮件、代码、自报批准均无控制权。处理轮保自身因果，不能借解释做业务。B先保存选择与queued意图，A在必要结果/交互/unknown/条件允许的安全边界技术收束；取消B仍保选择边界，明确继续A才恢复准确原配置与当前权限。

有限 child completion 订阅与 idle 当前自动授权分别保存。child/carrier可靠终态登记唯一报告，父active/idle共用原SQL Source/consume/receipt/ack事务，多结果可以进入一个同工作Run；Source是采用凭据，事件水位或on*回调不是。普通Model只自动展开本工作已接纳结果，原历史、显式Include与合法Fork读取保留。暂缓等待真实相关变化，撤销保存原因并释放通知绑定；暂停继续追加新的有限准入而不改写旧suppressed历史。冷缺绑定与unknown不自动恢复。

根applied permission.mode/revision动态进入子孙当前策略、待批/审核/资源等待与最终dispatch，原只读/工具/信任上限独立相交。旧卡片追加准确失效事实而非伪造用户答案；旧grant/review不跨revision、兄弟或新轮使用。已派发效果保留原事实，模式变化不承诺OS沙箱热改或回滚。

本决定只替代[旧默认Task after-turn提案](../../proposed/architecture/2026-10-03-default-task-after-turn.md)中的普通模型角色/disposition、后续人类输入一概撤销以及单report独占receiver-origin的部分；其可信当前授权、原配置与计划来源核对、有限期限、unknown及显式恢复理由继续适用。每Agent独立Session和QueueOnly不启动idle接收者的既有理由继续保留，当前接线不恢复旧Kernel、资金账本或同Session邮箱。

恢复到新 Store 的旧输入、选择与待决控制保留为历史，不成为当前默认工作；同 Store 冷重开仍保原控制。业务 Run 的 originCommandId 与公共 rootWork ID/序号分开核验，Fork 沿原 v1 proof 绑定两条准确因果，不要求二者相同。GC 清除原命令正文后，可选 carrier 投影允许缺失，完整 Run 历史仍可读；缺少当前可核绑定不能猜目标或恢复资格。

Native 子卡片和缓存绑定准确 carrier。仅有 Session 的导航先等待所属共享目录，首次完整事实唯一时才固定 carrier；缺项或多项不猜最新目标、不因后来刷新改投。旧等待可独立取消，不关闭其他读取者的共享目录。公开输入、业务 Command 与解释观察分别查回：Desktop 只投影经准确业务回执验证的 Run；CLI 对已封存 unresolved 输出完整澄清并以需输入/3 返回，不把 accepted 当业务完成或永久无提示等待，也不制造 Interaction。人类输入决定一旦封存，即使 unresolved 仍不可由后来的 Model 改签；无工具解释中的 Provider 无效调用沿普通 Loop 记录准确失败和完整配对，冷恢复只补未完成步骤。活动父工作可安全收束为 human_work_deferred，原 child 与待决范围保持。

已自动接纳的来源与后来的显式Include各保原事实。复用automatic Source时保原ID、inclusion、seq、出处和自动接纳，不用修改旧行取得新工作读取资格；当前selected范围和冻结upper内准确已应用的Include才投影有效explicit。idle以原Include命令序号为界，active以安全检查点实际发布的意图消息序号为界，queued或仅受理的命令不能倒灌旧快照。后续取消保留已经发生的选入，未应用取消不取得资格；Rewind排除原Include后不能借旧资格。新工作只取得低信任数据读取，不改投原报告ack或继承批准。

审核与人工证明各保准确身份。ask_user不产生review grant；真实人工接纳后只保留同revision的审核引用供最终请求核验，缺人工证明的Store CAS仍拒绝，revision改变仍丢弃旧引用。最终资源内不重启已经完成的审核，也不把审核建议当作人类批准。真正无父Run的可信Action/Tool桥仍需要父权限上界：只登记宿主实际声明的准确child carrier及角色明确指定的Model身份，和普通Run共用描述；child resolver仍先核有效绑定、真实父目录与封存manifest，未知角色、额外Tool与缺失模型不获准入。

真正无父Run的桥只继承空MCP观察，不伪造一个父Run。封存parentRunId:null及真实无Run祖先、原Command与prepare摘要、准确child-start/carrier/manifest血缘后，后代校验并把空观察绑定到自己的真实scope；不生成read-set、Source、连接或凭据许可。实际有Run却省略参数仍只有原不可继承的空观察，非空源或篡改证明拒绝。直接删除空snapshot或跳过scope校验虽能掩盖首层scope错误，却会丢掉下一层的来源边界，因此未采用。

显式零MCP选择保留普通child身份和精确持久血缘，自己的readSet仍为null。空后代只校验Store中的完整链和封存manifest，父层非空read-set不成为它的读取资格或raw字节依赖；非空后代继续原完整派生与撤权路径。保留旧“无inheritance”内部结构会使下一代误用父scope，复制父read-set又违背零源选择，因此采用零源资格与准确血缘分离，原连接/效果/预算断言保持。

2026-10-19，用户明确确认待澄清首输入仍保留原文标题兜底。可信宿主的 sessionInputMetadata 在真实 public/raw 耐久保存后、解释 revision 捕获前，只沿本会话 rename CAS 保存兜底；它不调度 Action、Tool、Job 或 Model，也不选择工作。原始主体、Store、Session、observed revision 0、空 selection/历史及准确保留注册事件均须可核；手动改名和事件缺口拒绝推断，同一 metadata Command 去重。实际业务随后沿 public/raw/decision/business 回执确认同一原文，由原启动 Action 补 marker，AI 仍只在准确业务满足正常完成条件后、最终成功状态提交前经原受管 child 执行。原 processing guard、两业务钩子范围和只读 on* 均保持，Core 不包含标题规则、公开用途字段或专用恢复格式。

并发pending准备采用乐观读取。直接业务决定先提交后，原begin的input_processing_unavailable只在完整同Store/Session/subject、raw digest、当前根scope/selection/取消、applied决定及public/business回执都可查时视为准备失效；仍进入原业务应用和派发门禁。取消、Rewind、未封存、伪digest或缺失business继续失败。相反顺序中已登记的只读技术轮可准确失败且零派发，其历史不伪装为业务Run，也不要求业务Skill配置。

正式Native journal先验证原公开命令的ID/kind、Store/Workspace/Session、subject和canonical request digest，再复用Client的业务查回器核真实business/Run。公开输入与业务Command的身份分离，不能要求Run.origin等于原公开ID；同Run补充保原origin，封存独立工作允许越过旧技术steer target。顶层Run为空的applied观察核真实成功Model，但不成为业务Run；unresolved仍accepted。旧技术steer的target/selection、取消、extension Job与unknown/冷零POST门禁保持。

## Alternatives considered

- 删除处理轮消息或在 HTTP 分页中过滤，会破坏原审计记录或让整页隐藏误报 EOF；按正文去重会吞掉用户明确重复提交的意图。选择在原 SQL 因果链生成只读呈现证明，并在完整当前读取内合并，不重写历史、游标或业务身份。

- 仅按公开ID校验业务Run.origin会拒绝合法派生业务；只信receipt内任意Run又会接纳外来或未应用业务。选择复用已有精确业务查回器，并保留Native公开身份与旧技术steer边界，不新增提交或重放路径。

- 忽略所有处理准备错误、清掉整会话诊断或重发新决定都会掩盖取消/选择变化或制造重复准入。选择只读查回准确既有业务证明后放弃过期准备，不新增Store写API或第二调度循环；原SQL错误及最终效果门禁继续负责安全。

- 将首输入一概作为业务、放开解释轮通用 Action，或等到业务准入后才保存标题：前两者会给未决输入业务效果，后者违背用户确认的原文兜底承诺。选择可信宿主的有限本会话元数据接点，复用原 rename CAS；AI 资格仍须真实业务证明，元数据不成为执行许可。

- 只重命名旧Task或删除human_start_preferred：没有原输入/工作选择/最终Source事务，无法证明A/B隔离，也不能处理C2接入C1创建的父轮。
- 让onRunEnd/onModelEnd负责完成回传：这些回调明确可丢失、队列可溢出、Promise可不结算，且Model结束不能证明附着Job已停止，不能承担可靠结果authority。
- 任何输入都当作新任务或撤销：问进度会丢订阅，独立B取消会误续A，模糊指代又可能猜错取消。采用真实raw、可审计决定与有限待决。
- 另建Agent registry、Goal或全局scheduler：当前稳定Session、Command seq和原report足够表达有限协作；新authority会重复所有权及恢复边界，超出本轮目标。
- 冻结child创建时模式，或让根Full覆盖所有限制：前者不满足运行中动态跟随，后者会解除可信只读与准确单次批准边界；采用当前根模式与硬能力交集。
- 丢响应后换key重发或按相同正文去重：前者可能重复child/效果，后者会丢掉模型明确的新意图。原invocation只查准确回执，新invocation保独立身份。

- 直接把已存在Source的automatic改成explicit：会改变原来源事实并让旧upper快照取得后来的读取资格。保留旧Source，按原Include命令/实际应用发布序号证明有效显式读取；原自动接纳不改签。

## Consequences

六工具、稳定复用、锚点分页、职责全文、active/queued/idle 及跨工作边界由真实 Runtime/SQLite 与默认 Service 消费者核验。输入、交接和报告事务用实际 SQL trigger、提交后响应丢失和原 invocation 重试验证；解释轮与审批恢复使用真实 SIGKILL，包含 unresolved 决定已提交但 Tool 尚未创建的窗口。封存的首次 Model/决定不重放或改写，后续有效提案不追加控制，冷读取和重复恢复不产生新效果。

运行中模式收紧和放宽覆盖子孙、queued/idle、待批/自动审核、旧 grant/review 与最终 dispatch。派发已经先发生的动作保留原模式证明并自然完成；下一 invocation 用收紧后的当前 revision，批准前无第二次效果。单次批准不跨轮共享，根 Full 也不解除可信只读、工具、信任或准确工作范围。

原 stream 整文件实际 3 项、174 断言、43.68 秒；32 槽峰值为 8 父与 24 子，持续 31.034 秒、48 批、360 次读取，readFailures=0，原 90 秒预算、3 秒 drain、取消、终态和资源断言保持。真实 Native 双 child 窗口 1 项、13 个 Bun 断言、27.41 秒，15 次受控 Provider 请求，冷启动零重放，所属清理 observed/forced/remaining 均为空；同工作 follow-up 明确沿原工作，正常 UI 关闭侧栏后操作准确新审批。TUI、真实 Files 并发/部分发布未知、原 Shell 负载、有界 soak 与其他完整验收入口及环境由[测试 owner](../../../../tests/README.md#子-agent-协作-v11-验证)维护，不以投影单测代证窗口或原生效果。

第38轮未经改动的原始 `bun run test` 在默认四并发下完整通过，2026-10-19 13:06:57.688813–13:30:06.027715 UTC，wall 1388.338902秒、同一Python进程monotonic 1388.309352秒。945个默认文件、748个外层作业全部启动并通过，741并发完全drain后7个exclusive严格串行各执行一次；4337非Markdown输入、mode与HEAD均无漂移。归档为 `/private/tmp/kite-collaboration-default-pass-38-20261019T130657Z.*`。原naive计数把runner自测owned临时目录中的两同名夹具start/pass混入外层，补充审计逐Source SHA、父job block、临时inventory及精确四事件白名单重新归属，验证实际外层无重复/缺失；原log与naive archive完整保留，无Source/runner/测试执行变更，独立复算一致。本轮32槽stream实际8父+24子、持续30.995秒、27批234次完整正文读取，readFailures=0；原终态、取消与drain门禁保持。

第26轮原负载曾出现一次 getModelOutput 的 network_outcome_unknown，当时未保留底层 cause；后续原三档未复现，没有运输层 Source 修复。准确失败与当前通过分别归测试 owner，不能将最终全绿表述为 ECONNRESET 根因闭合。

关联解释仍可能不能确定任意自然语言的目标；不明确时保留待决并请求新的真实澄清。已派发效果、外部直写与 unknown 沿原监督和显式恢复，不承诺 Shell 的 Files CAS、整批回滚或 OS 沙箱热改。压缩摘要低信任且有损，不承诺无限无损记忆。本机 macOS/Bun 1.4.2 和受控适配器证据不等同付费 Provider、Linux/Windows 原生、数周 soak 或项目 V1.3 全部退出与发布资格。
