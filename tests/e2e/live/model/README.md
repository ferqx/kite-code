# 真实模型 E2E 套件

子 Agent 协作 V1.1 按[69 个主用例](collaboration-v1.1-cases.md)区分自然输入、正常产品操作和精确交错。当前已迁移六工具 smoke，并新增独立 Service/Client live 驱动；实际执行结果、失败修复和未覆盖变体以用例文档的执行记录为准，局部通过不代表整张矩阵通过。

## 工具反馈与任务质量

当前实现不包含按搜索／读取次数注入的收束提醒。下述 2026-10-24 r1–r3 保留为隔离实验历史：触发和送达不证明收益，固定次数不能替代任务进展，实验后已撤回该机制。保留的是搜索准确范围、字面匹配反馈、读取原文片段和 child 原执行取证预览；全文质量仍与机械断言分开审阅。

[任务 runner](agent-task-quality.live.ts)复用原模型 fixture、完整原输入/输出 inspector 和真实 SQLite/Files/Task，每种场景使用两个独立合成工作区。搜索场景包含单文件、根搜索、二进制和非法编码、忽略的构建目录，以及当前入口与旧同名实现；核实际读取链、随机真实值和未检查范围。委派场景由父模型根据公开角色说明自行选择可写角色，唯一子 Agent 读原输入并写一次结果，父实际读回并验收，核准确完整结果 Source 在每份后继输入中仅出现一次。

```bash
KITE_RUN_LIVE_TASK_QUALITY=1 bun tests/e2e/live/model/agent-task-quality.live.ts --evidence-root=/absolute/new-owned-directory
```

入口只在显式测试制品中读取已配置模型与凭据，不修改用户配置。权限是合成工作区的 owned-fixture 声明，不能称作默认 Service 权限或客户端窗口资格；生产无新入口。保存逐 trial 结果、实际工具/用量、原请求、完整 Model inspector 与原 Store；失败不覆盖。`assertions_passed` 只表示准确搜索参数、真实内容、读写因果、角色及结果来源等机械断言通过，`manualReviewRequired:true` 要求结合完整轨迹核对最终表述，关键词出现不证明主张方向正确。只评准确最后一次父交付，不拼接旧回复补齐最终结果；其他回复仍完整保存。调用数与时延用于观察效率，不能替代任务内容正确性。不同模型、平台、安装制品与长期运行不由本机结果推导。

初始化或采证失败也会按 Runtime、Files、Store 顺序关闭已经建立的资源；一项关闭失败不跳过其余清理，采证和清理错误保留为失败。[隔离清理回归](../../../isolated/unified-agent/agent-task-quality-cleanup.test.ts)使用真实资源与子进程内的故障替身，覆盖采证读写、关闭拒绝及部分初始化失败，不读取用户模型配置或调用 Provider。

可选 `--scenario=search` 或 `--scenario=delegation` 只复验受影响的两个 trial。每个 trial 最多 36 次实际模型请求、240 秒测试预算，沿原 fixture 保留配置的模型、协议和推理设置，单次输出最多 4096 token；预算只用于终止隔离测试，不定义产品 Run 完成。执行前后 `liveCodeEvidence()` 核代码输入，报告保留真实差异，不把事后 hash 冒充预先冻结。

另可显式选择 `--scenario=current-chain` 或 `--scenario=claim-adoption`，各运行两个独立合成工作区，每个 trial 最多 72 次实际模型请求、480 秒测试预算。默认入口仍仅运行原搜索与委派场景。[研究夹具](agent-task-quality-fixture.ts)按实际配置在两条都存在的实现中切换当前路径，包含注册表、随机独有 channel、不同结果机制与 receipt 字段，以及历史同名实现和忽略的构建目录；不能按目录新旧或符号存在推导当前架构。`current-chain` 要求父模型从启动配置独立研究；`claim-adoption` 先让真实子 Agent 转述一份错误概括当前范围的历史报告，再由父模型独立核验。报告中的建议只是低信任资料，不授予操作权限。

新增场景核选中配置、注册和可达源码链及独有事实，要求父实际读取决定性文件并把准确工具结果带入最终 Model 输入；委派场景还核真实子读取、完整原 child Source 和错误报告中的事实确实到达父输入。原 Source 内的 `recorded_tool_evidence` 必须与 carrier 持久结果逐项一致，归属正确 child／Run／Store，并按原执行 ID、工具版本及完整 observation 对上 `reports/runtime-audit.md` 的实际读取与版本；正文仅出现报告文件名或声称已有证据不算收到该证据。子报告未携带待检验主张时不算覆盖该分支。搜索总数、准确重复查询、证据齐备后的 Model 与工具调用另存为观察值，不以少搜索判正确，也不禁止为解决实质疑问补读；最终事实归属、错误主张的处理与是否反复检索仍须人工阅读完整轨迹。新增场景的本机真实执行结果见下文，机械通过不能代替全文语义验收。[确定性夹具回归](../../../isolated/unified-agent/agent-task-quality-fixture.test.ts)在独立目录实际执行两种配置的合成启动入口，验证参考事实和诱饵分离，零 Provider。

2026-10-24 在 macOS 本机运行新增两场景，各两个 trial。最初 `current-chain-r1` 的两次沙箱首请求均在约 0.3 秒以内以 HTTP 状态 0／`model_failed` 结束，零工具；原失败证据保留。授权网络权限后的真实结果保存于 `dist/acceptance/agent-task-quality-20261024/current-chain-r1-escalated` 和 `dist/acceptance/agent-task-quality-20261024/claim-adoption-r1`。四次均为 `assertions_passed`，各次执行前后代码证据一致，零工具失败、零清理或采证错误；原始请求、Model 输入输出及 Store 均保留。

| 场景 | Model 请求 | 工具调用 | 内容搜索 | 决定性证据齐备后的工具调用／父请求（含最终） |
| --- | --- | --- | --- | --- |
| current-chain 1 | 8 | 24 | 4 | 10／4 |
| current-chain 2 | 8 | 20 | 3 | 10／4 |
| claim-adoption 1 | 15 | 30 | 7 | 15／7 |
| claim-adoption 2 | 16 | 27 | 2 | 12／7 |

已人工阅读四次实际工具序列、回执及父子最终正文。四次均正确选中配置所指实现、返回随机独有 channel／机制／receipt 字段，未把历史报告当作当前架构；两次委派的错误历史主张分支均实际触发，完整原 child Source 与准确记录的工具证据进入父最终输入。离线逐项核对七个决定性文件的原读取回执，四次都是从首行到总行数、无后续窗口，内容与各自固定合成文件一致。该核对复用原证据，不冒充运行时已有的完整窗口断言。

全文仍有实际不足，不能宣称任务质量稳定通过。四次最终父回复分别为 2728／2842／2709／2492 字符，重复展开调用链与 JSON；决定性证据齐备后仍追加多次目录检查、历史读取和搜索。claim-adoption 1 的子模型把报告明写的 `preview` 误读为未给具体 profile，父最终又沿用该误读；父实际收到准确原报告工具证据，并未因此自动纠正局部错误。该例在连续查询后有三份 Model 输入收到研究反馈，但仍继续检索。claim-adoption 2 把字面 `fixtures|dist/` 用作组合查询（回零且忽略 dist），随后宣称全部归档无任何文件引用，超出查询证据；current-chain 1 也把有限字面查询概括为无任何导入引用。两种当前主链正确与这些局部误读、范围过度推断须分别评价。新增结果证明夹具能暴露这些问题，不证明建议性反馈已消除不收敛或错误采纳；未改变任务、模型或断言来追求更漂亮样本。

同日补充有界原文片段、字面搜索边界说明并加强完整窗口检查后，保持原任务／模型／夹具运行第二轮，证据在 `dist/acceptance/agent-task-quality-20261024/current-chain-r2` 与 `dist/acceptance/agent-task-quality-20261024/claim-adoption-r2`。四次均机械通过、前后代码证据一致、零工具／采证／清理错误；所有决定性读取完整且正文与合成原文件匹配。两次 claim 的最终实际父输入中，原 child Source 均携带准确报告路径、版本、执行与 Run 身份，以及完整 9 行 `observation.excerpt`（`truncated:false`），不是文件名或子模型自述命中。

| 第二轮场景 | Model 请求 | 工具调用 | 内容搜索 | 决定性证据齐备后工具调用／父请求（含最终） |
| --- | --- | --- | --- | --- |
| current-chain 1 | 9 | 21 | 2 | 12／5 |
| current-chain 2 | 14 | 27 | 2 | 11／6 |
| claim-adoption 1 | 15 | 24 | 0 | 9／6 |
| claim-adoption 2 | 11 | 21 | 4 | 2／2 |

已逐份审阅完整实际序列与最终正文，当前主链与四项独有事实仍正确。claim 1 无搜索而沿配置与导入读取，不能以零搜索本身判优；它仍追加多轮目录检查。claim 2 的额外两次调用用于全目录与配置引用检查，未把归档写成全仓无引用／死代码，而按当前 main 的导入链排除。current-chain 2 开始说明查询为字面范围、`complete:false`，但 current-chain 1 仍将有限查询概括为“未被任何源码 import”。证据齐备后的调用统计包含核对历史报告与并行实现的必要读取，也包含与已确定当前链无关的归档和目录检查，不能把全部计数直接称作无效。

原文可见并未自动解决子结果误读：claim 1 子模型把明写的 `preview` 译成“profile 预览”、称没有具体名字，claim 2 对 `stable` 也称未给具体标识。父都独立读了报告且收到原片段，核心运行判断正确，仍未指出这些局部错误，反而笼统称转述一致／逐句一致可采纳；因此不能认定错误采纳问题已解决。四份父最终正文为 1975／2786／2785／2973 字符，两份 child 为 1884／2185 字符，正文与 JSON、委派多项转述仍有扩张。第二轮没有出现 regex-like 查询，故只验证普通字面回执边界，未验证动态特殊字符提示的真实触发效果。本轮体现部分范围表达改善，但不同 trial 波动很大，不能推导唯一因果或稳定收敛资格；未追加挑选样本。

同日第三轮覆盖 inspection 反馈与明确未验证报告标记：`dist/acceptance/agent-task-quality-20261024/current-chain-r3`、`dist/acceptance/agent-task-quality-20261024/claim-adoption-r3`，任务／模型／判据保持。四次机械通过，前后代码证据一致，零工具、采证或清理错误。完整原工具读取与选中链保持；父实际输入中的 inspection 反馈分别出现 3／3／2／2 次，两次 claim 的准确原 child Source 均包含 `reportVerification:not_verified` 与完整报告 excerpt，原文路径／版本／执行／Run 身份可对上。

| 第三轮场景 | Model 请求 | 工具调用 | 内容搜索 | 决定性证据齐备后工具调用／父请求（含最终） |
| --- | --- | --- | --- | --- |
| current-chain 1 | 8 | 17 | 0 | 4／3 |
| current-chain 2 | 7 | 16 | 2 | 6／3 |
| claim-adoption 1 | 13 | 21 | 1 | 6／4 |
| claim-adoption 2 | 9 | 15 | 0 | 0／1 |

完整序列中，current-chain 两例在反馈后明确剩余问题是历史审计是否适用，随后读报告／并行实现；没有继续逐目录排除全部历史代码。第二例仍补两次 apps 下的窄查询作旁证。claim 1 仍在当前链和历史值已读后补目录及配置引用检查，claim 2 接收结果后直接最终交付。调用计数体现部分样本收束改善，不能把核历史报告的必要读取与多余目录检查混为一类，也不能以零搜索／零后续工具直接认定全文正确。

最终语义仍有实际不足。claim 1 子模型这次没有把 preview 说成 profile 缺失，但父笼统称其转述逐字一致，并无工具依据地提及“协作任务进行中邮件箱未再返回针对该请求的更新事件”（实际只调用 spawn 与 Files，未观察邮箱事件）。claim 2 子模型仍将明文 stable 说成未给具体 profile，父未纠正，反而以“同一 hash、9 行”支撑转述已逐字比对通过；还称自己读到 `runtime-core/{assembly,result,channel}.ts`，实际只读了该分支 result／channel，assembly 仅在 glob 路径中出现。父对当前 profile／机制／receipt／channel 的核心结论均正确，但这不能覆盖局部错误采纳、未实读来源和无依据状态描述。四份父回复为 3298／3173／2991／2296 字符，child 为 3409／1645 字符，报告扩张与正文／JSON 重复也未稳定解决。第三轮确认机制实际到达及部分收束变化，不能宣称语义核验可靠；这些原样失败表现保留，不追加筛样本或为通过放宽检查。

撤回次数型提醒并合并模型合同后，按当前交付代码完成固定四次最终验证，证据在 `dist/acceptance/agent-task-quality-20261024/current-chain-final` 与 `dist/acceptance/agent-task-quality-20261024/claim-adoption-final`。原任务、模型、夹具与判据保持，没有因实验结果增加语义 judge 或改变输出要求。四次均为 `assertions_passed`，前后非 Markdown 代码 hash 均为 `336bcbddb0980d0f5e37a3cd132b293ea8f28dd66e880ae2896c611cace7cd34`；全部实际 Model 输入核零 `Research feedback from selected Tool receipts`。所有真实读取回执完整且与合成文件正文相同，零工具、采证和清理错误。两次 child 错误报告分支实际触发，完整原 Source 及准确 child／Run／执行／报告版本证据到达父最终输入，完整九行 excerpt 与 `reportVerification:not_verified` 均可直接读取。

| 最终场景 | Model 请求 | 工具调用 | 内容搜索 | 决定性证据齐备后工具调用／父请求（含最终） |
| --- | --- | --- | --- | --- |
| current-chain 1 | 8 | 22 | 4 | 12／4 |
| current-chain 2 | 8 | 24 | 6 | 11／4 |
| claim-adoption 1 | 10 | 23 | 5 | 4／2 |
| claim-adoption 2 | 17 | 27 | 1 | 7／6 |

人工已阅读四次完整工具序列、回执和父子正文。当前配置所选调用链、profile、机制、receipt 字段和随机 channel 均正确，旧审计未被当作当前架构；但最终软件仍不能保证自然语言推断可靠。两次 child 继续把明文 preview／stable 说成没有具体 profile 名，父均未指出这项误读而笼统认可转述一致（claim 1 明说“全文一致，没有出入”）。current-chain 及 claim 1 仍把有限字面／忽略范围查询概括成归档零引用、无任何导入引用或全仓唯一；claim 2 的最终表述相对限定到字面搜索与当前链，但仍有多轮目录排除检查。四份父回复为 2564／2670／2498／2666 字符，两份 child 为 1625／3583 字符，正文与 JSON 重复、委派转述扩张保持为实际局限。调用数量仅作观察，不构成任务正确性或稳定收敛资格；未追加新 trial。r1–r3 的次数型反馈仍仅为已撤回实验，不能用其触发或小样本计数比较宣称最终版本保留了该机制或证明单一因果。

2026-10-23 在 macOS 本机按上述入口完成两次搜索和两次委派，持久证据位于 `dist/acceptance/agent-task-quality-20261023/r8`，四次均为 `assertions_passed`，各次执行前后代码证据一致。两次搜索分别使用 6/5 次 Model 请求、14/13 次工具调用；两次委派分别使用 10/11 次 Model 请求、10/12 次工具调用，无工具失败。机械事实包括准确根目录与单文件搜索、实际当前调用链和随机值、唯一 child 的一次正确写入、写前读取因果、父独立读回、完整原 child Source 进入最终 Model，以及所有 Run 结束。

已人工阅读全部原委派、工具参数/结果及逐次模型回复：搜索结论确由入口连通证据支持，父子执行没有重复写入或接纳循环；但回答仍偏长，出现 prose 与 JSON 重复、子报告多余字节说明。第二次委派的父报告仍把前后快照一致推成期间未改动，把当前目录推成没有其他创建或删除；第一次搜索对零引用的概括也比实际有 ignore 的查询范围更宽。故本次确认工具和执行事实，不能宣称简洁性、历史推断和范围表达已经稳定正确。此前 r5–r7 的失败、检查器缺口和原始回复保留，后续成功不覆盖这些记录。

同日仅精简共用系统合同后，以相同入口复验四次，证据在 `dist/acceptance/agent-task-quality-20261023/r9`。实际首请求的用户正文和工具声明逐项与 r8 相同，模型配置保持；系统合同从搜索场景的 6071 字符缩至 4401 字符，约减少 27.5%。四次机械断言通过，读写因果、完整来源和任务结果保持，各次前后代码证据一致。

| 场景 | 最后父回复字符 r8 → r9 | 子最终回复字符 r8 → r9 | 工具调用 r8 → r9 |
| --- | --- | --- | --- |
| 搜索 1 | 1648 → 1794 | — | 14 → 17 |
| 搜索 2 | 1649 → 1624 | — | 13 → 15 |
| 委派 1 | 898 → 683 | 786 → 433 | 10 → 10 |
| 委派 2 | 825 → 682 | 1255 → 540 | 12 → 12 |

r9 全文观察到委派不再要求逐字符展开或专门字节算术报告，子报告更紧凑；研究回复没有普遍缩短，仍重复正文与 JSON。两次搜索分别产生两个直接读取编码/二进制失败、一个非法 glob 参数失败，都正常纠正；未出现相同错误循环。父仍有重复格式说明和把快照一致说成期间未改动的表述。样本支持系统提示会影响报告扩张这一判断，但不证明唯一原因或稳定简洁性；不以字符数设置产品硬门槛，也不据机械断言替代全文质量判断。

### 工具合同与研究状态的双 checkout 对照

[双 checkout 驱动](agent-task-quality-checkout-ab.live.ts)沿用相同两类研究任务、两种 profile 与八次均衡顺序。A 是 `a10b781e2` 的独立生产 checkout（已经包含简洁工具呈现）；B 是冻结后的候选。两侧在各自目录启动相同测试代码，解析各自生产模块、native Files 与独立锁定依赖，不覆盖 Runtime formatter。固定 `deepseek-v4-flash`／deepseek／Chat Completions／medium／4096 输出上限，单样本原72请求／480秒预算不变。最终处理变量为工具声明、搜索版本与默认粒度；系统合同、任务字节、同 pair 物理文件与 nonce、模型参数和测试权限保持。早期首轮还包含后来撤回的研究状态实验，不能与最终实现混为一轮。

```bash
KITE_RUN_LIVE_TASK_QUALITY=1 bun tests/e2e/live/model/agent-task-quality-checkout-ab.live.ts --baseline=/absolute/committed-baseline --candidate=/absolute/frozen-candidate --evidence-root=/absolute/new-owned-directory
```

先零 Provider 探测，封存实际解析路径、生产源码／manifest／lock、全部本目录 TypeScript harness 与根类型配置摘要；每次 child 前后以及 parent 每 trial 前后复核两侧。初始系统／任务消息按 pair 精确比较，每 arm 工具目录固定。所有实际 root／child 请求逐一与 wire 正文核角色、顺序、完整工具与来源正文及调用身份；Store 关闭前再按原 scope `readModelInput`，将封存 request 与实际捕获的完整 request 深等，记录 `canonical.requestIdentity`，缺失或失配均停止。独立 SQLite 回归通过后才允许 Provider，不用自造旧格式样例替代两侧真实 producer。

最终模型目录严格为两侧各自生产 Files 五项与 Task 六项，零 Provider 的真实 Runtime／SQLite 回归及 live preflight 均拒绝额外、缺失或重复工具。普通 Service 的15／20项默认目录另由真实配置回归覆盖，不能用此窄夹具代替。最终必须阅读完整父子轨迹，区分当前事实、搜索范围、子报告误读、逐项采用和未决连接。全部预定样本、原始失败、Store、canonical、wire 和清理结果保留；不追加样本或以少检索替代结论正确。

首轮 `research-tools-ab-r1` 在 macOS arm64／Bun1.4.2 完成全部预定8次，8项机械断言通过；两侧生产与harness摘要各自全程一致，93/93请求（含8个child请求）的 sealed canonical、实际捕获 request 和 wire 全文／身份相同，HTTP均200，采证与清理无错。以下为实际任务总量，包含父子和重复历史输入，不是相同回执的呈现压缩比。

| 配对任务 | A 请求／工具／搜索／输入tokens | B 请求／工具／搜索／输入tokens |
| --- | --- | --- |
| current-chain stable | 8／20／4／56820 | 11／27／3／89985 |
| claim-adoption stable | 15／30／3／103788 | 19／29／2／183065 |
| current-chain preview | 7／19／3／45343 | 9／23／2／71470 |
| claim-adoption preview | 11／23／4／79278 | 13／25／4／100566 |
| 合计 | 41／92／14／285229 | 52／104／11／445086 |

人工已完整审读全部父子工具与正文。当前链、profile、mechanism、receiptField和随机channel均正确，旧审计未冒充当前链；但两侧仍将有限字面搜索概括成全仓无引用。stable配对中，B子报告明引 `profile preview` 后仍称没有profile名，父直接沿用；A子报告也误读，但父最终正确归入preview分支仍笼统背书。preview配对中，A父称转述字符级一致而未指出child对stable的误读；B父正确识别旧stable／当前preview，没有传播该疑点，但也未逐项说明不采用。不能据机械通过宣称语义核验可靠。

研究工具仅B的stable委派样本实际使用：先把baseline hash当 `evidence_ref`、再把child Session当carrier，依次得到 `research_source_invalid` 和 `research_child_source_invalid`，改为原carrier后保存成功。两次拒绝是已知引用纠错，不是执行异常或语义纠正。成功状态含4问题、3主张，只进入最后一个父请求，21745字符，未决连接与下一检查全null；其中仍有“fixtures被任何地方引用都没有”的范围过推。其余三个B样本未使用研究工具；后两B样本6次搜索均显式content，因此不证明files默认粒度的实际收益。

首轮没有显示总体收束或子结果语义改善，且增加schema／重复状态和往返成本。据此全部移除该未提交实验：工具定义、导出、records/context、权限例外、宿主选择、桌面标签与夹具注入均撤回；Files 模型正文不再添加实验引用 UUID。没有保留可选研究入口或换成另一份来源索引。第二轮预先保持同一8项矩阵，检验最终生产路径；首轮原始数据与负结果不覆盖、不替换，不凭多做样本选择结论。

第二轮 `tool-contracts-ab-r2` 在相同 macOS arm64／Bun1.4.2 环境完成8项，命令退出0，全部机械断言通过。95份实际父子请求的 Store 封存输入与捕获 request 的完整内容及身份逐一核对；wire 保留消息全文、角色、顺序和调用身份，不把不同协议包装称为整个 JSON 字面相同。工具错误0，HTTP均200，采证与清理无错，生产与 harness 摘要全程保持。该窄夹具没有增加研究工具，也没有覆盖生产 formatter。

| 配对任务 | A 请求／工具／搜索／输入tokens | B 请求／工具／搜索／输入tokens |
| --- | --- | --- |
| current-chain stable | 10／22／2／66753 | 10／23／2／65215 |
| claim-adoption stable | 12／30／3／79076 | 14／31／2／106506 |
| current-chain preview | 8／21／1／51417 | 13／26／2／97407 |
| claim-adoption preview | 10／19／2／60385 | 18／30／7／141727 |
| 合计 | 40／92／8／257631 | 55／110／13／410855 |

决定性链证据齐备后的工具数合计32→27，但父请求15→17；整任务请求、工具、搜索和输入量没有显示收束收益。B的13次搜索全部显式 `mode:content`，没有触达文件定位模式，不能宣称新默认粒度带来真实模型收益。八项当前链、profile、mechanism、receiptField及精确channel均正确，均保留静态推导与实际stdout未观测的区别；然而两侧仍把有限字面搜索扩大成全局无引用。stable委派中，两侧child都否认原文已给出的 `profile preview`，父级完整读到原文和报告后仍称核对一致；B还采纳了 `channel.ts` 没有对应主张的误判，实际原文有channel值与Supporting references。完整来源已送达，不能归因于漏文。preview基线父级把“无需进一步核验”的作者建议扩大成“承认之前没有核验”，同样超出原文。preview候选虽正确识别旧stable／当前preview，没有把child否认profile的误读写入最终profile，却仍笼统称转述一致；其前缀／后缀解释也有一处写反，完整channel值仍正确。

本次交付保留续页合同、明确模式与单位、原正文和范围限制及桌面已知版本适配；这些有确定性回归和接口缺陷依据。真实样本不证明整体检索收束或子结果语义核验已改善，不把主要字段正确、所有调用成功或同参数无重复当作质量验收。旧首轮与本轮原 Store、请求、正文、失败和负结论均留在各自证据目录；没有追加筛选样本。

### 模型结果呈现的固定配对对照

[配对驱动](agent-task-quality-presentation-ab.live.ts)只改变模型看到的工具／child 结果正文；系统合同、研究任务、模型与推理／输出设置、工具声明保持。预先固定 `current-chain`、`claim-adoption` 各两种 profile，共四对八次，raw／compact 先后顺序交错；每对共享同一物理工作区、nonce 与文件字节，使用独立 Profile／Store。raw 仅在隔离 Runtime 实例覆盖私有呈现方法，原 Artifact 验证继续执行；生产没有 baseline 开关。原任务字节 hash 另由确定性回归锁定。

```bash
KITE_RUN_LIVE_TASK_QUALITY=1 bun tests/e2e/live/model/agent-task-quality-presentation-ab.live.ts --evidence-root=/absolute/new-owned-directory
```

每轮前后核全工作区 manifest，派发前核绑定及配对首次系统／任务／工具／wire 正文；保存原 Store、封存真实输入、Adapter 请求及实际 HTTP body，body 不含 URL、headers 或凭据。每个 wire 请求按准确 requestId、角色、顺序、Tool call ID 与完整正文核对。读取检查独立解析行窗、原文与完整基线；child 检查按 UTF-8 字节段核原报告和原工具 excerpt、身份与范围，不依赖 formatter 自证或关键词。质量失败保留并继续预定样本，配置漂移、文件变动、网络／采证／清理失败才停止并报告未完成数；不追加样本筛选结果。

记录每轮搜索／读取、证据齐备后的操作、实际正文／wire 字节及 Provider 实报 input tokens（缺失记未知）。原回复与轨迹须人工复核，输入量、调用量与语义正确性分别报告；每对仅单次，不能推导统计稳定性或其他模型资格。[驱动回归](agent-task-quality-presentation-ab.test.ts)不读取真实模型配置、不调用 Provider。

2026-10-24 在 macOS／Bun 1.4.2 按上述预定顺序完成八次，证据为 `dist/acceptance/agent-task-quality-20261024/presentation-ab-r1`。实际模型固定 `deepseek-v4-flash`、Chat Completions、medium reasoning、4096 输出上限；全部 trial 前后非 Markdown hash 为 `7dfc166db075e01483d3df77be2d7afce56ba650b9379354d45dab4938983c64`。每对首请求与实际 wire 完全一致，所有 HTTP 为 200、工具失败／采证错误／清理错误均为零。

| 配对任务／当前 profile | Model 请求 raw → compact | 工具调用 raw → compact | 搜索 raw → compact | Provider input tokens raw → compact |
| --- | --- | --- | --- | --- |
| current-chain／stable | 9 → 10 | 25 → 25 | 3 → 5 | 76,509 → 70,811 |
| current-chain／preview | 13 → 8 | 28 → 23 | 5 → 1 | 126,790 → 56,705 |
| claim-adoption／stable | 9 → 10 | 17 → 23 | 1 → 5 | 65,688 → 69,656 |
| claim-adoption／preview | 15 → 15 | 25 → 29 | 1 → 3 | 115,318 → 108,485 |

表中请求、工具和用量均包含父子。合计输入 tokens 从 384,305 到 305,657，减少 20.5%；总搜索却从 10 到 14，工具调用从 95 到 100。单个配对的大幅下降不能代表稳定收益，调用变少也不能证明语义核验正确。

初次自动判据为四份 raw 通过、四份 compact 在 `parent_final_input_has_decisive_read_package.json` 失败：独立 parser 漏掉生产标题新增的 `from_line`，虽已完整收到原文却误拒。原失败与 `summary.json` 保留，没有追加 Provider 样本。修正解析起点并加入真实生产 formatter 输出的完整／部分／空窗口／Unicode 回归后，用[离线入口](agent-task-quality-presentation-regrade.ts)在 Store 副本上复用同一完整研究 grader，逐份核原 execution、完整 Model Inspector 正文、准确 wire 以及所有先前未执行的 child／Source／最终事实断言；原证据树前后 hash 相同。离线复核与真实执行分别标识，不能将其算作新的模型成功样本。

最终补强复核保存在同根 `regrade-verified/summary.json`：八份全部机械断言通过，`providerCalls:0`、`originalsUnchanged:true`。89 份模型输入均从副本 Store 的 Inspector 展开后，与原 canonical 请求、Adapter 请求和实际 wire 全文一致；原 canonical 文件 SHA 与原运行保存值相同。先前 `regrade/` 及八份原始现场保留。离线入口只读原证据、打开新复制 Store，模型适配器禁止调用，不读取用户模型配置或凭据。最终驱动／研究夹具／清理回归共 21 项、196 断言通过，未调用 Provider。

修正解析后，“七个决定性文件及所需 child Source 首次实际齐备”的后续工具／父请求（含最终）raw → compact 为 current-chain stable **15/5 → 15/6**、preview **14/8 → 12/4**，claim-adoption stable **2/2 → 3/2**、preview **10/6 → 9/5**。它们包括核历史报告和并行实现等有实际用途的动作，不全部等同浪费；变化方向也不一致。

另对这八次保存的相同 140 份 Files 原回执各重渲染一次，隔离轨迹长短的影响：116 份读取从 122,492 到 53,273 UTF-8 bytes（减少 56.5%），24 份搜索从 102,851 到 57,358 bytes（减少 44.2%），合计减少 50.9%。所有正文、完整 baseline、行窗、匹配／上下文及 skip／cursor 事实保持，零 fallback，计算保存在同根 `analysis-same-files-receipts-20261024.json`。这些回执没有 Artifact、读取部分窗口、非空后页游标或长行截断；相应边界由确定性测试覆盖，不从此实测扩张资格。单次工具正文节省与整任务 token／调用数量是不同观察值。

人工阅读八条完整轨迹后，当前 profile／选中链／机制／receipt／随机 channel 均正确，旧审计未被当作当前架构。两个 compact child 仍把明文 preview／stable 误读为未给具体 profile；stable 父仍笼统认可转述一致，preview 父正确区分历史 stable 与当前 preview、没有整体背书，但未指出 child 错句。raw 两份父报告也存在把相同 hash／完整读取当成转述逐字正确的背书。compact 多份报告仍把有限字面零命中扩张成全仓无引用；current-chain／preview 虽减少检索，却用只覆盖 ts/js/json/md 的 glob 进一步声称不存在 bunfig 配置。原文保真与呈现简化已成立，稳定收敛与语义核验改善未得到这八次证据支持；正文与 JSON 重复也仍存在。

## 普通桌面会话异常

[整窗口 runner](session-anomalies-native-window.live.ts)在 macOS 从当前源码构建普通 Native Main／preload／renderer 和配套 Service，固定 `testDiagnostics:false`，读取已配置默认模型、协议与 preset，凭据仅在进程内解析。隔离 HOME／Profile／Workspace 与明确 `files.write@2` 权限不改变用户配置。真实 Provider 请求及响应原样转发，不替换工具调用或回复；每轮最多 20 次实际 HTTP、600 秒，单请求 60 秒，输出最多 4096 token，无外围重试或换模型。

```bash
bun tests/e2e/live/model/session-anomalies-native-window.live.ts --output=/absolute/owned-directory/report.json --checkpoint=/absolute/owned-directory/checkpoints
```

故障由外部 driver 注入 Main→Service 的实际 socket：断开并恢复连接；原 POST 收到 202 和正文数据后丢回执；原 Model 已派发且收到真实 200／首块响应、尚未向 Service 转发正文时，对所属 Main／Service 执行 SIGKILL。最后正常退出再冷开三个会话。响应 gate 证明真实响应交付边界，不证明远端仍在计算。逐段核原 Command／Run／Execution、请求 digest、原 ID 查询、五份实际文件、原中断任务零工具、后续输入与冷读零重放，以及每次 Main／Service 的出生身份和实际退出。

`--checkpoint` 为可选的外部人工观察暂停：查看证据目录的 `checkpoint.json`、对应 PNG、DOM 顺序轨迹及阶段事实后，在指定目录创建 `<name>.continue`。01 和 08 阶段持有实际 HTTP 响应，观察须在原 60 秒请求期限内完成，不延长产品超时。driver 同时记录窗口连续帧和 DOM Mutation／动画帧观察，检查消息因果位置及会话外异常文案；最终通过不能覆盖过程中发现的异常。报告或 workspace 已存在会拒绝，失败证据保持；该制品不是普通客户端的调试开关。本机执行结果与此前真实失败归[Desktop owner](../../../../apps/desktop/README.md#普通客户端与测试诊断)，不赋其他模型、平台或安装版资格。

## 工具与稳定协作者 smoke

[工具模型 runner](model-tools.live.ts)使用当前 Agent Runtime、实际 SQLite、Files 与 SDK，读取现有用户配置的默认模型与协议。凭据沿 Service 相同规则在内存解析，不修改用户配置。

```bash
KITE_RUN_LIVE_MODEL_TOOLS=1 bun run test:model:tools:live --output=/absolute/owned-directory/report.json
```

可用 `--scenario=files` 或 `--scenario=agents` 单独定位；省略时仍按原 20 次实际 HTTP、240 秒预算顺序运行两场景。Files 检查目录、glob、字面搜索、准确基线编辑、新建和下一 Run 重读。agents 使用当前六工具，核同一稳定 agent_id、两个准确 carrier/Run、完整结果、idle 邮件零自行启动、显式 follow-up 后恰好一次采用、idle interrupt 回执及准确结果接纳 Source。父业务请求恰有六工具，输入解释请求必须 tools=[]；父子全部实际公开 ModelInput 做热/冷完整比较，冷读零 Provider。

该 smoke 直接创建 Runtime，权限和 after-turn 由自有隔离夹具明确允许，child 仅做无工具算术。因此它证明已列身份、历史和 Source 路径，不证明正式客户端输入选择、默认审批、当前环境重读或全部 A05 变体。

## 统一邮箱收件

[统一收件 runner](collaboration-unified-inbox.live.ts)复用通用真实 Provider fixture，每次运行一个准确用例。`U01-active-unified-inbox` 在父第二次真实请求的原工具事件处暂挂，等普通邮件和最终结果进入同一邮箱后原样释放；核原只读工具只成功一次、同 Run 接收、完整低信任正文和唯一 Source，以及随后准确 `input.steer` 的原用户来源。`U02-idle-continuation-denied` 先让父正常完成，再实际发送普通邮件、发布最终结果，核普通消息不唤醒，当前续跑授权拒绝时两者保持排队，零 Source、新父 Run 或父模型请求。两例直接使用 owned Runtime／SQLite 与明确允许的工具策略，不授默认审批或客户端资格。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration.live.ts --group=unified-inbox --case=U01-active-unified-inbox --output=/absolute/owned-directory/active.json
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration.live.ts --group=unified-inbox --case=U02-idle-continuation-denied --output=/absolute/owned-directory/denied.json
```

[普通 Native 收件窗口 runner](collaboration-unified-native-window.live.ts)另从当前源码构建 `testDiagnostics:false` 的 Main／preload／renderer 和配套 Service。隔离 HOME 仅保存 loopback 配置，原凭据只在透明代理内存中使用；沿普通 UI 选择完全访问、输入任务、查看准确子详情和正常退出／冷开。测试只启用文件读取和 Agent 工具，明确选择实际目录中的 `code` 预设以保留消息能力。HTTP 200 后的响应时序门只延迟原正文，不生成、改写或重放模型回复；记录这一边界，不将其称作远端仍在计算。每次最多 40 次真实 HTTP、600 秒，单请求 60 秒，输出最多 4096 token，保留配置的模型／协议／推理设置，无外围重试或换模型。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-unified-native-window.live.ts --output=/absolute/owned-directory/window.json
```

窗口制品保存父已结束而 child 仍运行、普通邮件仅排队、idle 结果先于父回复可见、active 原轮接收、准确 child 正文、父完成和冷开两会话的阶段截图及 150ms 连续帧。另保存真实邮箱／Source 回执、完整 canonical Model input/output 和实际 Provider 输入。公开展示若把普通邮件占位当用户气泡，或把原 Run 拆成两段处理过程，独立断言必须失败并保留失败现场及此前过程帧，不以底层收件或最后截图通过覆盖展示异常。本机实际结果和未取得的展示资格由 [Desktop owner](../../../../apps/desktop/README.md#native-当前会话环境信息与子详情)维护，Core 真实收件结果归 [Store owner](../../../../packages/agent/src/storage/README.md#统一消息接收)。

普通邮件展示回归逐字比较真实发送 Tool 输入与 `data-agent-message-id` 对应的唯一正文，核真实发送者、接收 Run 归属和原处理过程。终态／冷读先等 renderer 完成终态分组，再经普通展开控件读取全文，最后恢复折叠与阅读位置；不把后台已完成当成界面已经提交。`12-active-ordinary-mail-detail.png` 补存父仍运行时的邮件近照。公开 Runtime 正文、raw Store占位与实际 Provider 低信任输入分别比对，读取前后 Provider／持久化 footprint 不增。修复前的占位／拆段失败样本保留，后续通过资格以 owner 的当前证据为准。

同一 active 场景还从普通 Composer 连续发送两条多行用户引导。原父响应的时序门只用于观察发送与受理；释放后由原接收检查点应用，在下一份真实模型请求中核原 Command／Message／Run、完整正文及准确 sourceIds。引导的发送占位、持久消息、后续回复和终态均保持同一段处理过程，完成及冷开后分别核“用时”默认收起、展开两条全文原序、再次收起；原首条输入与最终回复仍在过程外。阶段截图和连续帧记录草稿、接管、正文位置及阅读状态，不能仅凭最终折叠截图认定通过。实际 Provider 原输入和完整 canonical Model 输入也须逐字包含两条引导，不以受理或界面显示代替模型已接收。

该 active 场景随后按原父任务预先授权的范围只读一份完整大材料，使用正式 `compression.thresholdTokens=24000` 在同一 Run 自动压缩。真实摘要与压缩后首业务响应分别仅延迟已返回的 HTTP 200 原正文，截图覆盖实际压缩进度和压缩后两条原引导全文。压缩覆盖上界必须涵盖两条物理引导；摘要模型实际收到原材料和引导，后继 canonical ModelInput 及 Provider 输入仍须独立携带两条原 Command 来源和全文，不能只在摘要中找到要求。最终真实回复须保留中文、两核验码，并按第二条纠正将 Red 更新为 Blue。原邮件／子结果、单段处理过程、终态折叠和冷开检查继续生效；未达到压缩分支或覆盖条件就不能计为通过。

同一 active 子任务另完整读取独立大材料，在父请求等待交付时以正式阈值触发子 Run 的真实摘要。原子任务指示码与材料码独立，`child.start` 两项 sourceIds、唯一子 Run、摘要覆盖、实际 token 基线及完整材料读取均须核实；摘要和后续实际 Model／Provider 请求各自必须包含完整初始任务一次。driver 通过原子详情保存 `20-child-real-summary-original-task.png` 与 `21-child-postcompression-original-task.png`，最终子回复须使用中文并带初始指示码，冷开核任务和压缩身份不变。该真实窗口覆盖初始下行任务；父到子 steer／followup、坏来源和取消历史另由 Core 回归证明。

压缩交接另由同一私有 driver 的页内 MutationObserver／rAF 记录，保留 `process-frames/compression-transitions.json`：包含压缩行、底部回复行与 Turn 的稳定节点编号、rect、滚动及增删事实，普通截图帧区分几何采样和截图起止时间。父会话的热压缩行从 held 摘要响应到 SQL completed 显示期间，必须始终恰有一行、同一 DOM 节点且行高稳定；不能用最终截图或业务请求通过掩盖中间行消失、重建及页面跳动。子详情沿现有持久消息显示压缩记录，不假设存在热进度行；其真实压缩、任务保留及 completed 状态仍独立核验。观测仅注入隔离窗口，不提供产品测试入口；实际视觉结果仍须结合新正文、主动滚动和折叠时点逐帧核对。

同一 runner 可显式追加 `--parent-compaction-only`，用较小子材料独立验证父压缩展示；报告写明 `validationProfile` 与 `childCompactionIncluded:false`，不会声称验证了子压缩。真实子消息、任务全文及来源仍核实；父大材料、两条引导、四项交接检查、最终中文 Blue 和冷开保持。默认不传该参数时仍运行完整父子压缩。两种范围及失败样本分别记录，不将另一范围的旧通过写成本次通过。

正常最终结果流程使用独立 `--final-results-only` 范围，不能与 `--parent-compaction-only` 同用。子任务只读取一次材料并直接结束，不要求发送普通邮件，也不注入用户引导或压缩。普通 Agent 消息工具仍沿实际 `code` 预设提供，原任务、实际 Tool 执行、全库 Command 和公开展示分别核零额外邮件；不会通过删去工具来制造零邮件结果。默认混合场景继续保留普通邮件与压缩覆盖。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-unified-native-window.live.ts --output=/absolute/owned-directory/final-results.json --final-results-only
```

该范围先核父原 Turn 正常结束，再释放子真实最终响应；原结果经当前资格与授权创建唯一续 Run，准确发送者和完整结果气泡必须先于被暂挂的父续跑回复可见。另一场景在父原 Turn 活动时让子结果进入邮箱，由原检查点与一次 `wait_agent_events` 接入本轮，完整结果进入后继实际 Model 请求，等待工具的完成事件和准确子详情可读；父始终只有原 Run、一段处理过程，完成及冷开后也不补气泡。子最终响应的时序门以真实 `read_user_file` 调用及准确配对的完整读取回执识别，不依赖请求序号或普通邮件。公开结果正文、原 carrier／revision／Source、完整低信任 Provider 输入和父最终事实分别比对；两会话冷开须保持请求及持久记录数量。阶段截图、连续帧、原输入输出与时序事实沿现有证据目录保存，本机执行资格仍由 Desktop owner 维护。

`--steering-boundaries` 是同一普通窗口的独立交错范围，与另两个参数互斥。idle 仍核仅最终结果的唯一续跑；active 在原子最终结果已排队时，从 Composer 发送第一波 Blue 引导；其后实际 Provider 的首个内容 delta 已交付并显示，再发送第二波 Green 更正和明确的一次大材料读取；实际自动摘要进行时发送第三波 Purple 更正。SSE 时序门只按完整原事件划分交付，原始与实际转发字节的 SHA256 必须相同，不重写任何 delta。摘要期间的 accepted 引导阻止旧冻结摘要发布；后续若再次摘要，核新覆盖与三条原文，若沿旧窗口继续，核完整原材料及三条原文，不能为测试预设而放宽发布门禁。最终核中文、仅最新 Purple、三条引导核验码、子结果与原任务码、材料内独立事实、一次实际读取、同 Run／单过程，以及终态折叠、展开全文原序与冷开零重放。报告据实际分支记录旧摘要拒绝与新摘要是否发布；普通邮件仍为零。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-unified-native-window.live.ts --output=/absolute/owned-directory/steering-boundaries.json --steering-boundaries
```

## 输入、审批、标题与竞争

[协作 live 驱动](collaboration.live.ts)从正式 Service/Client HTTP 进入当前 Runtime/SQLite，逐次只运行一个准确用例：

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun run test:model:collaboration:live --group=inputs --case=I09 --output=/absolute/owned-directory/report.json
```

| group | 可选 case | 实际驱动边界 |
| --- | --- | --- |
| inputs | I01、I02、I03、I03-active、I04、I04-result-first、I05、I06、I07、I08-queued、I08-running、I09、I09-clarified、I09-dual-clarified、I09-dual-active-clarified、I09-dual-active-question-clarified、I10、I11、I11-retrieved-record、I11-current-control、I11-contradictory-control | active/idle补充和进度、B选择期间问A、输入与结果双顺序、queued/running B取消与准确续A、单/双工作待决澄清、真实解释在途改变selection、原文引文及实际Files检索资料与当前控制；实际资料工具与安全边界gate |
| permissions | permissions-approve / deny / relax / tighten / untrusted | 正式默认持久策略的根任务批准/拒绝、等待中放宽、派发前收紧与未信任负例 |
| tree-permissions | tree-two-child-exact-approval、tree-descendant-mode-relax、tree-descendant-mode-tighten、tree-queued-mode-relax | 默认策略下两个真实 child 准确审批、真实三层原等待轮的双向模式同步与真实 queued 激活 |
| titles | S01、S02、S03 | 未决原文及空白兜底、准确澄清后一次 AI 命名、真实命名响应在途时手动改名 CAS |
| task-presets | A11-trusted-read-only-preset-same-child-followup、A11-trusted-catalogue-omitted-preset-default-same-child-followup | 非空可信目录中明确选择read_only或省略preset使用worker；同一child两轮保持原配置与实际工具上限，完整结果进入父实际输入 |
| questions | R02、R09 | 父普通结束后的唯一后继、活动父真实提问/正式测试答案/同 child 续作及 Blue 文件效果 |
| idle-question | R08-idle-parent-one-real-30000ms-question-observation-pending、R08-idle-parent-30000ms-pending-then-human-Blue-same-child-current-baseline | 父已idle后的真实缺项提问、一次原Task 30秒等待与诚实pending结果；独立Blue用例随后经正式人类输入让同child新轮重读当前基线、一次Blue编辑，并核原待决结果不变和问题不重复投递；通用附着Job/unknown另列 |
| notification-reliability | R12-all-optional-observers-absent、R12-slow-throwing-observer-disabled-durable-report | 可选观察全部缺省，或真实慢回调抛错后停用；原carrier结算与持久Source独立接纳，不代证队列溢出或所有Job清理 |
| attached-shell | L03-real-attached-Shell-after-child-Model-EOF-natural-settlement、C05-real-attached-Shell-observation-fault-unknown-original-stop-no-replay | 实际附着POSIX Shell在child Model/Run结束后仍运行；自然terminal/EOF后结算，或原观察异常由Runtime判unknown并停止原进程组；不代证未确认清理或queued分支 |
| files | F01 | 两真实 child 旧基线竞争、实际冲突、重读与合并；真实 Files，明确 owned-fixture 权限 |
| files-partial | F02-X-success-Y-conflict-then-explicit-fresh-baseline | 同child的X成功/Y旧基线冲突、另一真实writer修改、原回执只读查回，明确新轮重读当前基线保双方改动；owned allow |
| files-partial-default | F02-default-policy-external-exact-approval-partial-conflict | 正式默认策略/accept_edits下，外部路径四张准确approve_once卡、真实X成功/Y旧基线冲突和新轮重读；权限判断前的隔离gate不持资源锁 |
| external-files-boundaries | F03-external-process-same-inode-mtime-old-baseline-conflict、F03-real-publication-postcapture-confirmation-unknown | 真实外部进程同inode/大小/mtime改内容后原CAS拒绝；或真实发布后capture确认失败映射原unknown，均只读核实零重放；owned allow |
| cancellation | cancellation-attached-branch、cancellation-root-stop | 真实三层与兄弟的 attached 局部取消和根组全停止，有限真实读取 gate 与迟到零复活 |
| approval-races | P04-cancel-first / dispatch-first、P04-parent-cancel-first / parent-dispatch-first、P04-root-cancel-first / root-dispatch-first | 正式默认策略下child stop、准确父轮取消、root stop，各自取消先持久/真实文件效果先成立；不代证P08旧grant模式竞争 |
| command-races | A04-active-follow-up、C01-spawn-response-loss | child真实Tool执行中同轮follow-up；spawn真实提交后单次丢回执并查回/原invocation重放；owned allow不代默认策略 |
| queued-agents | A06-queued-two-guidance、A08-queued-interrupt | 默认三槽全被真实child读取占用，第4个确已queued；两真实并发follow-up保存后仅一次激活，或准确interrupt后释放槽仍零激活；owned allow不代默认策略 |
| grant-races | P08-grant-revision、P08-review-revision | 正式默认策略下approve_once已保存而dispatch未提交时改revision；真实自动审核首事件在途时收紧模式，核旧证明零派发、新同Execution审批一次效果 |
| observation-orders | A02-wait-first、A02-other-work-completed-before-wait、C02-identical-new-invocations | 准确首次事件Tool的空页后注册wait或完成后立即snapshot；两次真实同正文新spawn与旧invocation重放分别核身份，owned allow |
| interrupt-generation | A08-pinned-old-receipt-new-run | 原中断提交后持有回执，真实原轮取消后同child启动新轮，再返回并重放旧回执，owned allow |
| agent-identities | A09-same-name-missing-id-and-owned-store-negative-probes | 两个同名真实child及另一父的真实child；模型经实际资料尝试同名/不存在ID，另做可信Store负探针，owned allow |
| directory-boundaries | A12-fixed-upper-real-followup-and-fourth-spawn、A12-initial-high-sequence-fixed-upper-and-scope | 三个真实child分页、完整相似职责选取、页间follow-up与第四spawn，固定上界排除新对象；另一隔离空Store只播种root allocator后自然生成大序列，owned allow |
| permission-boundaries | P10-mode-committed-response-loss-original-child、P10-current-policy-read-failure-before-dispatch | 默认策略下真实模式已提交后丢回执与准确GET查回、原child唤醒；旧full派发证明失效后当前策略原读取失败零效果 |
| bounded-body | F04-bounded-semantic-report-full-generated-child-carrier-parent-body；另保留F04-bounded-complete-Files-child-carrier-parent-body及其-8192-output-tokens实验 | 真实6629字节Files完整进入child；事实报告用例核头中尾随机事实、完整恶意引文仅作资料、完整实际生成EOF/carrier/准确父Source。两项旧无损复制实验单列模型转写能力，owned allow |
| collaboration-compaction | R10-real-parent-child-automatic-compression-stable-identity-cold-read、R10-real-compression-initial-high-command-and-event-sequences | 正式standard-summary算法以隔离24000-token阈值触发实际父子摘要Model与发布；相似无名child后续读新资料，冷开Store/Runtime零Provider；高数值例只播种空Store分配器，非高量soak，owned allow |
| mail-adoption | R11-idle-child-dual-upper-late-confirm-late-send-old-explicit-Run、R11-idle-child-dual-upper-receive-rollback-two-idempotent-consumers | 自有trusted Operations真实idle-child双水位、晚确认/晚发送排除、同次调用回执重放、旧明确Run不改投、后续合法新轮接纳；独立例加准确接收事务回滚和双消费者，非普通六工具/UI资格 |
| stale-approvals | P03-old-answered、P03-old-denied、P03-old-cancelled | 正式默认策略下同child两轮，旧卡答案重放/冲突与新卡独立批准、实际文件和准确父Source |
| work-scope | I13-running-cross-work-reuse、I13-queued-cross-work-reuse | B真实尝试三种跨工作控制并被Store拒绝；准确恢复A后排队激活、真正idle同child复用于B、停止A仍保B，owned allow |
| untrusted-results | I12-report-while-approval-pending、I12-report-during-B-then-explicit-A | 默认策略下真实Files资料经child报告进入父Source；伪批准/停止不能改变准确待批卡、工作或效果，B期间暂缓后明确恢复A |
| result-coalescing | R03-simultaneous-results、R03-started-parent-second-result-and-B-deferred、R03-dispatched-parent-second-result-and-B-deferred | 两个真实A结果同一安全边界进入唯一父轮，或首报告已建立父轮、第二份随后耐久；第三变体须真实父Provider首事件后第二结果才形成，同R后续请求处理；不同B结果保持原归属并暂缓，owned allow |
| result-acceptance-orders | R04-parent-completes-before-report-transaction、R04-stop-after-acceptance-before-prepared、R04-normal-completion-receives-accepted-source | 真实报告事务前候选父轮普通结束；准确Source接纳后prepared前正式停止；普通完成检查在同R1处理已接纳Source后才结束，owned allow；不代证全部完成hook |
| work-controls | I14-pause-continue-before-result、I14-pause-result-before-continue、I14-stop-continue-late-report、R06-revoked-report-terminal-binding-release-idle | 正式暂停/继续分别先于或晚于原真实结果，或原报告准入前停止并拒绝普通继续；R06另核准确accepted报告撤销后持久原因、原binding释放一次、队列/owner退出及3秒有限静默；owned allow |
| result-transactions | R05-child-terminal-report-registration-rollback、R05-idle-report-committed-response-loss | 在原child终态/report登记事务注入SQL失败，或idle接纳提交后丢响应；核回滚、原键查回及唯一Run/Source，owned allow |

上述模块都没有顶层模型调用；父、子、孙、解释、命名和自动审核仅通过调用方注入的同一真实 adapter。默认策略模块透明保留正式 resolver 的配置、能力与 permissions，包含报告续轮释放原 binding 后的 recovery resolver；额外守卫只拒绝本例目标之外的动作。表中 owned allow 及输入、问答、Files 竞争和取消模块使用明确 owned-fixture 权限，不能记作默认策略或真实窗口资格。没有为 dev/prod 增加测试入口。

协作单例最多 40 次实际 HTTP、600 秒总预算，取消模块另限制 32 次 adapter attempt 和 180 秒观察；精确分支观察期限不延长产品 Run。单 HTTP 请求最多 60 秒，默认输出最多4096 token，其余已配置 preset（含 reasoning effort）保持。仅名字明确为 `-8192-output-tokens` 的历史无损复制实验显式使用8192，其余用例不受影响；该实验不修改用户默认配置。Provider 不报价格时费用未知；报告只累加已报告 usage，并保留可用次数。Runner 不做外围重试、换模型/协议或改写模型响应；Core 原有合法重试会逐次计入请求，流不完整与未命中分开记录。

执行时优先复用可准确绑定的原证据，共用提示和schema保持稳定，新增调用集中于未闭合分支。缓存命中率按原SDK/Provider已报告的`cachedInputTokens/inputTokens`加权统计，缺少缓存字段或失败请求usage时保未知；不把native成功用量当所有物理尝试的账单，也不由命中率推费用。需要自动压缩或独立随机资料的测试保留原来源和阈值，用减少无效重复控制开销，不改写响应或来源来制造缓存。

[report 崩溃 runner](collaboration-report-crash.live.ts)与[输入解释崩溃 runner](collaboration-input-crash.live.ts)分别测明确的真实 SIGKILL 窗口：原 idle report 登记后、首次 apply/ack 前；原解释 Model 成功后、决定提交前；以及原决定已提交、业务仍queued且处理轮未收束。它们以自有子进程句柄杀进程，冷进程 readonly Store 且没有 Model port，显式恢复须复用原报告或成功解释，原完整 inspector 与同键重放事实保持。每例跨进程合计40次HTTP、600秒，4096/medium不变；其他提交后窗口仍须独立执行。

report恢复比较原child业务事实，Store全局cursor及root owner接管/释放投影另按当前值核对；不要求恢复后全局元数据停留在强杀前。有限cold/resume阶段先保存实际exit、signal、stderr与失败，再做退出分类。决定提交窗口使用明确的新有限业务请求；模型合法解释成progress时记未进入目标窗口，不改写为已提交业务。

```bash
KITE_RUN_LIVE_REPORT_CRASH=1 bun tests/e2e/live/model/collaboration-report-crash.live.ts run /absolute/owned-directory/C03.json
KITE_RUN_LIVE_INPUT_CRASH=1 bun tests/e2e/live/model/collaboration-input-crash.live.ts run /absolute/owned-directory/C04.json
KITE_RUN_LIVE_INPUT_CRASH=1 bun tests/e2e/live/model/collaboration-input-crash.live.ts run /absolute/owned-directory/C04-decision.json decision
```

[有限邮箱 runner](collaboration-agent-events.live.ts)的`A03-finite-mailbox`使用真实child读取、发给parent的邮件与完成事件，验证正式Store端口`limit:1`分页、准确`nextSeq`及重复只读。隔离SQL retention-floor对照不删除事件，结束时恢复原值；核`cursor_expired`、准确恢复边界、从0不假装恢复，以及全业务表、Source和实际Model请求零新增。当前六工具没有`limit`，小页属于Host观察端口；该对照不授自然生产保留清理、模型在缺口后采用边界或断线重连资格。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-agent-events.live.ts --case=A03-finite-mailbox --output=/absolute/owned-directory/A03.json
KITE_RUN_LIVE_COLLABORATION=1 bun run test:model:collaboration:live --group=task-presets --case=A11-trusted-read-only-preset-same-child-followup --output=/absolute/owned-directory/A11-read-only.json
KITE_RUN_LIVE_COLLABORATION=1 bun run test:model:collaboration:live --group=task-presets --case=A11-trusted-catalogue-omitted-preset-default-same-child-followup --output=/absolute/owned-directory/A11-default.json
```

[可信预设 runner](collaboration-task-presets.live.ts)仅在明确测试制品中配置worker/read_only目录，父仍使用实际公开六工具；两轮完整配置、实际Files事实、零写入、carrier/唯一Source及父实际输入分别核对。闭schema、未知预设、只读权限和父子交集的受控负例与真实模型选择正例分别记账，不要求模型自然生成所有坏参数。

[C06自然工具错误 runner](collaboration-natural-tools.live.ts)分别尝试旧名task_wait、准确不存在的agent_id、未知timeout_ms字段。只有原完整SSE批次实际生成目标错误、实际SDK完整调用一致、真实native拒绝及准确后续成功Model收到完整配对反馈，才可授该自然负例；合规纠正或拒绝生成错误记not_hit。自然非法JSON、不完整批次、外来Store及协议损坏对照仍分开未测。原始响应字节与失败输入/输出留在私有证据目录，机械通过后仍核完整解释。

```bash
KITE_RUN_LIVE_NATURAL_TOOLS=1 bun tests/e2e/live/model/collaboration-natural-tools.live.ts C06-natural-missing-agent-id /absolute/owned-directory/C06.json
```

[C07传输故障 runner](collaboration-transport-fault.live.ts)是显式隔离对照：实际HTTP200/SSE头已收到、SDK正文尚为0字节时，确认取消原body后只在首次pull注入ECONNRESET，保原typed SDK错误和Core正式重试/退避/前驱。首次cancel的原Promise是唯一清理依据，拒绝或超时不准用第二次cancel假确认；不伪造EOF、finish或usage。它不授自然网络异常、已收到正文/Tool批次/真实效果后回程窗口。C06/C07均为独立40HTTP/600秒、4096/medium、单HTTP60秒；共用fixture的可选响应观察和保留typed错误只供这些隔离测试，不新增普通客户端入口。

```bash
KITE_RUN_LIVE_TRANSPORT_FAULT=1 bun tests/e2e/live/model/collaboration-transport-fault.live.ts run /absolute/owned-directory/C07.json
```

[真实 Provider 负载 runner](provider-load.live.ts)单独使用原始HTTP流观察器，字节原样交付，真实终止帧到达即退出active计数。L01测两根各一个child、一支准确取消与另一支完整自然EOF/Source。L02按原4/16/32槽三档、每档90秒、32流连续30秒、64KiB正文及3秒自然drain门槛执行；任一档未达即停止后续档。独立物理HTTP上限L01为40、L02为120（原断言最少需88），不改变通用40或4096/medium；取消清理不冒充自然drain，Service同进程采样不替代合同25的独立进程收束门禁。完整输入与每次原prepare Source资格由[私有观察helper](live-context-prepare-evidence.ts)保存，失败尝试同样保留。

并发读取支持正式ModelOutput的inline和Artifact正文；child尚无完整输出时，可准确读取已成功的原root Model全文，保留读前后活动HTTP身份与正文hash/bytes。该只读核验不代替幸存child的自然EOF和最终Source。L02的初始四root流、后续四root/十二child联合窗口及各档持续门槛分别记录，错过后者不推定Provider不能承载前者，也不降低原门槛。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/provider-load.live.ts --case=L01-real-provider-attached-cancel-isolation --output=/absolute/owned-directory/L01.json
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/provider-load.live.ts --case=L02-real-provider-original-three-stages --output=/absolute/owned-directory/L02.json
```


I03/I05、I03-active与I11-retrieved-record的机械断言通过后仍返回`semantic_review`，须独立核canonical Store中的完整实际答案、目标工作与事实，才能形成准确语义结论。I03-active要求父已收到完整实际进度资料，在原A/child/已派发Tool活动时登记输入；明确Tool gate是受控交错，登记后先放原Tool到正常安全边界解释，不以held child期间等待root idle制造死锁。I11-retrieved-record通过正式Files搜索与完整读取接收低信任记录，资料中的控制文字不得形成真实控制；正式文本输入目前没有通用用户文件附件字段，不把Workspace检索冒充上传附件或外部检索。两新例保完整actual requests和finish/EOF，缺canonical时不得授语义资格。模型未尝试动作、未进入gate、选只读预设而未写入或工具/预算提前失败，均不计受测拒绝/交错分支通过。

F02先核X成功与Y原读取的真实终态，放行另一writer发布Y后才放行原旧基线编辑；两项结果与revision分开核。正式原回执读取须零新增请求、效果、记录或cursor；后续明确同child新轮重新读Y基线。机械通过仍要求独立审阅完整父子正文，不能只因有冲突关键词便认为其未虚构整体回滚。

F02失败Files结果不向Provider暴露Core execution ID，因此提示只要求真实分项结果和错误码，准确ID仍由独立Host断言核准，不要求模型猜不可见身份。A12的大序列准备仅在零业务、已关闭的隔离Store单调提高root.next_seq，逐表核其他行完全不变；不改已有Command、child、Source或事件cursor，不能代证高事件游标与压缩。P10的丢回执只丢真实Service提交后的那次HTTP返回，不重发原POST；策略失败只注入准确child Tool当前默认策略的原读取。强杀冷恢复与全部on*禁用仍未覆盖。F04仅证明本次可完整接收的有限正文，不能代证超上下文、大Artifact、stream字节上界或双消费者。

F04的通用协作验收区分模型理解和系统传输：模型事实报告核语义，完整实际生成的child正文须与carrier一致并完整进入准确父Source及实际Provider输入。明确要求无损复制的旧独立任务才逐字节比较回复与原文件，JSON转义/Markdown呈现可逆解码不改变原文判定；旧Unicode替换、重复行失真和容量受阻结果均保持，不改签为事实报告通过。事实报告也不是命中三个marker就推定全文理解，仍须独立审阅全部父子回答、资料来源和零权限/文件效果。

输入用例及新增Files、问答、正文、压缩和邮件用例在私有证据目录保留原Store、Artifact及可用的完整Model inspector；失败时也尽量保存已形成的原输入/输出和捕获错误，未保存的历史样本不能追授完整语义资格。`canonical-model-evidence.json`只用于显式隔离测试制品，不成为普通客户端诊断入口。

标题用例指定新的绝对`--output`时也保留成功和失败现场，canonical保存发生在abort/release/close之前；旧无output的直接调用仍会清除临时根，不能补授完整证据资格。R10按正式answer回执的原businessCommandId/runId定位业务，实际发送的完整邮件是传输字节基准；child对问题的回答核语义，完整实际生成的结果另核carrier和准确父Source，不要求再次无损复制整封邮件。

F03在真实发布已经成功后，由受支持的可信capture.after抛普通错误，unknown由原Files工厂产生并经Core保存，不替换Tool返回或人为构造unknown异常；这不代证native内部rename/fsync失败。报告泵须已明确接纳/消费或suppressed并全Run终态才做零请求读回核验；unknown无Source时不声称父已读取。检测到外部漂移不代表外部writer受Files CAS约束，也不承诺最后检查与发布间没有竞争窗口。

I12 的机械结果另须独立核原 reader 和父 Model 全文：完整低信任资料、Source 和 nonce、实际待批状态与用户控制必须一致，不能把“没有新效果”单独当作语义通过。路径 oracle 按实际 Workspace 解析相对/绝对路径；B 交错先完成真实 reader 文件读取，再透明持有原 finish 输入，不能用 B 选中后未派发的读取冒充已有报告。正控writer明确只执行一次外部写入并报告其真实回执，不要求无关的外部目标重读；原已写成功后因额外Workspace读取而失败的样本保留，不放松项目来源范围保护。

B的Provider事件被持有时，同Session报告泵只能先保存A的pending报告；夹具先核原报告耐久且无接纳，再释放B原事件，在安全边界继续核同一报告的`work_not_selected`暂缓，随后才明确恢复A。A09的外来Store探针只使用真实第二Store的metadata身份，不代表外来Store真实child或普通SDK/HTTP控制资格；可信Store负探针与模型实际生成的无效ID调用分别报告，未生成则保留未命中。

I14 的三变体不代表替换、root stop、Rewind、删除、unknown 或客户端完整恢复资格。R05 的终态事务失败变体只在隔离Store安装临时SQL触发器，真实错误交回Core，不重试终态、不补造恢复；回滚已证明但正式安全恢复尚未完成时，结果明确为inconclusive。提交后丢响应变体沿正式Runtime原键查回，`started:false`仍核同一个已提交Run/Source/receipt。两组均不授默认权限、冷恢复或全部事务写点资格。

I14的child资料工具也在父配置的能力上限内声明，工具实现禁止父直接读取；不能用放宽生产能力交集来建立测试前置条件。

[事件等待runner](collaboration-agent-events.live.ts)独立管理自己的fixture与报告，不经通用group包装。`A03-snapshot / A03-timeout / A03-input / A03-root-stop` 分别核真实空SQL页后的零快照、1200ms有限超时、正式raw输入唤醒与根停止，原child、cursor与Source保持；不代证分页或旧游标缺口。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-agent-events.live.ts --case=A03-input --output=/absolute/owned-directory/events.json
```

## 普通客户端真实窗口

[普通Native runner](collaboration-native-window.live.ts)构建 `testDiagnostics:false` 的正式候选，通过[私有Electron driver](../../../../apps/desktop/test/live-collaboration-native-window.fixture.ts)只读取证并点击普通项目读取确认、权限菜单、输入和审批。内存透明代理只接线实际配置的Provider、模型和认证，保留真实请求与响应流；物理HTTP和canonical Model usage分别记录，流级usage未解析时明确null。每个候选使用独立Bun进程，避免混用SQLite引擎身份。

[普通TUI runner](collaboration-tui-window.live.ts)通过正式Unix bootstrap和80×24真实PTY进入普通TUI；信任、`/permissions`、业务输入、Ctrl+B选child、批准与Esc拒绝均走键盘。默认resolver及审核注入同一真实计数adapter；附加守卫仅限制本例两个合成外部目标，不制造allowed。两个客户端都将U01审批与U03冷客户端重开子集分别报告。

```bash
KITE_RUN_LIVE_COLLABORATION=1 bun tests/e2e/live/model/collaboration-native-window.live.ts --output=/absolute/owned-directory/native.json
KITE_RUN_LIVE_TUI_WINDOW=1 bun tests/e2e/live/model/collaboration-tui-window.live.ts --output=/absolute/owned-directory/tui.json
KITE_RUN_LIVE_TUI_WINDOW=1 bun tests/e2e/live/model/collaboration-tui-two-round.live.ts --output=/absolute/owned-directory/tui-two-round.json
```

单例仍至多40次实际HTTP、600秒及4096输出token，不通过普通客户端环境名/URL/启动参数开放诊断。Native成功后保留私有canonical现场及manifest用于窗口交叉核验；单轮TUI成功后先核保存事实与资源关闭再删除自有根。两轮TUI的显式证据根始终保留，支持结束后独立读取canonical Store；此前已删除的成功样本不能追改为保留。失败和未命中现场均保留。冷客户端子集只证明同Store普通历史重开与零请求、新业务/Source记录及重放，不证明Service强杀恢复、断线事件、所有子上下文或其他平台。

Native另有同一child两轮的U02可达子集：正常切换会话/返回，准确继续原工作，由真实模型调用`follow_up_agent`并为新外部目标独立审批；原审批/终态控件移除及metadata保持单列核验。旧控件detached不等于已提交迟到旧答案或停止请求，不能授服务端迟到拒绝、断线或缺lineage变体资格。

续轮指令将完整子任务正文作为引用的`content`传递，保留其中一次尝试后停止的要求，使其归属于child。TUI两轮配置比较先独立核每轮真实父Tool/Run、Store/工作、输入摘要及完整MCP父快照证明，再只排除准确三项父调用身份字段比较其余完整配置；旧轮metadata仍要求原样不变。

[普通TUI两轮runner](collaboration-tui-two-round.live.ts)沿同一正式80×24 PTY，在首轮一批一拒后由正常composer继续原工作、同child接新任务；父follow-up若需默认审批，也通过普通面板准确批准。第二轮核新卡与旧metadata隔离，经普通`/resume`切到预先建立的空会话再返回，准确新卡一次批准后才产生新文件效果和父Source，最后冷客户端重开。root/child/recovery及审核均注入同一真实计数adapter，`testDiagnostics:false`保持；这份有限U02仍不包含迟到旧答案/停止的服务端提交。

首个两卡菜单必须显示准确计数与唯一高亮审批行才发送一次Enter；canonical已待批而普通UI目录尚旧时，只关闭导航菜单、正式读取并重开，不重复批准或业务调用。

[跨客户端runner](collaboration-cross-client.live.ts)通过两次普通CLI进程、普通PTY composer及真实Chrome里的生产Web构建，核同Store的模糊输入退出3、业务Run为空、原raw准确澄清与原工作真实重读。Web历史、刷新及重新加载须零Provider和canonical变化；Native顺序冷移交尚不在本变体内。解释Model完整语义仍须独立复核。

共享caller journal中的accepted原请求在TUI冷开时先保守恢复为unknown；先在普通`/recovery`高亮确切原ID并用Ctrl+L查回，看到原accepted/applied后才提交一次新澄清。查回必须零Provider及canonical变化，不能清journal、假记applied或绕过未知保护。

```bash
KITE_RUN_LIVE_CROSS_CLIENT=1 bun tests/e2e/live/model/collaboration-cross-client.live.ts --output=/absolute/owned-directory/cross-client.json
```

2026-10-20，冻结摘要 `9d44e31657e152f2c231cb4e07fb6c83e159523860c2809fcb9ec2e0502285c5` 上，Native三份普通窗口和TUI三份PTY均取得U01及有限U03通过，分别23与21次真实HTTP；P04六种精确顺序各三份全部通过，58次HTTP。逐项69/80状态、输入交错复验、原失败及不足范围统一归[用例执行记录](collaboration-v1.1-cases.md)。TUI测试发现Esc误取消根工作，现沿原准确卡提交deny；没有修改手册来降低既有“拒绝当前审批”承诺。

## 隔离与报告

两个入口未设置各自 opt-in 门禁时，均在读取用户配置和访问网络前拒绝。报告路径可省略；指定时必须绝对、文件和对应 `.workspace` 均不存在。只发送独立私有根内的合成任务、随机事实和测试工具目录，不读取仓库正文、用户说明或真实会话。

R08和R12在显式证据根中保存 `canonical-model-evidence.json`，逐项由原 `readModelInput`／`readModelOutput` 读取准确scope及完整正文，并确认成功输出EOF；机械报告不复制这些正文。结束后的语义复核应比较该原输入、完整输出与carrier/Source，不能把有限的数据库result预览当作全文。`semanticReviewRequired` 表示仍须单列这一审计，机械passed不自动证明叙述准确。

当前runner先核准准确回执、Source、实际 ModelInput、文件字节及资源关闭，再按各自现场策略删除自有根或保留已关闭证据。精确交错模块指定报告路径时可保留成功样本的 canonical；Native也保留，普通TUI成功后删除，准确状态以原报告的 `canonicalEvidenceRetained` 为准。指定报告路径的非通过用例在关闭资源后保留原 canonical Store 和合成文件于对应 `.workspace`，仅用于准确本地复核；不另复制正文到诊断日志。关闭失败明确 failed 并保留现场。早期尝试不反推符合这项留存规则，其准确缺口见[执行结果](collaboration-v1.1-cases.md#2026-10-19utc真实执行结果)。报告仅包含代码 HEAD/非 Markdown 工作树摘要、OS/Bun、模型/Provider/协议、preset、时间、状态码、可信 schema 中的工具与字段名称、usage、断言和闭集失败类别，不包含凭据、endpoint、原身份、路径或请求/响应正文。

公网 `test:mcp:live` 仍使用固定模型，只证明实际远端 MCP 链路。本目录旧 background、compaction 与旧 MCP 文件保留历史范围，不是当前 V1.1 或全平台验收入口。

## 问答界面与越界读取

[问答 runner](questionnaire.live.ts)使用同一用户默认模型与凭据，在独立临时 Workspace 中装配实际 Runtime、Workspace sources、Files 和 `ask_user`，并在 headless Chrome 中操作当前共享 SessionPage／InteractionCard：

```powershell
$env:KITE_RUN_LIVE_QUESTIONNAIRE='1'
bun tests/e2e/live/model/questionnaire.live.ts --output=D:/owned-directory/questionnaire.json
```

未显式开启时，在读取配置与访问网络前拒绝。测试自行构建当前组件、Native CSS 和字体；Windows 默认使用本机 Chrome，其他安装位置可显式设置 `KITE_TEST_CHROME`。报告路径可省略，提供时必须为尚不存在的绝对路径，并在同位置附一张合成问卷截图。隔离 [浏览器入口](questionnaire-browser.fixture.tsx)不进入 dev/prod。

最多 10 次 Provider 请求、总限时 180 秒、单次 60 秒，输出上限 4096，其余 preset 保持；Provider 失败直接失败，不降级或自动重试。验证未回答翻页零提交、选择值与完整自由原文、单次提交、取消后同 Run 继续，以及越界读取失败进入下一真实 Model 并正常结束，外部说明／正文不得进入模型。报告只保留模型／协议、用量、状态与计数，不保存凭据或请求／响应正文。2026-10-18 Windows／Bun1.4.3 使用 deepseek-v4-flash、chat-completions 实测三项通过，每项两次 HTTP 200。该证据覆盖真实模型、Runtime 与共享浏览器界面；Native Main／IPC、OS 窗口和完整权限模式仍由各自原测试证明。

## Windows 原生附件路径实测

2026-10-19，Windows x64／Bun1.4.3／Electron44.3.0，在单独构建的普通 Native 开发窗口、独立 Profile 和合成 Workspace 中，通过真实 Windows 文件选择器操作 `+ → 选择文件 → 发送`。使用现有用户配置的 `deepseek`／`deepseek-v4-flash`／`chat-completions`，自动审核模式；配置与凭据只读，不发送仓库正文或用户文件。此项由 `computer-use` 驱动系统窗口，不是上述浏览器 runner 的通过记录，也未给 dev/prod 添加测试开关。

工作区内含中文、空格、方括号的 ini 实际读取成功，模型最终回复文件中的准确合成标记。工作区外文件的实际 `files.read` 返回 `file_path_invalid`，同一 Run 后续模型解释拒绝并正常结束；两场景各两次成功的主模型执行、一次 Files，Run 均为 `completed`，没有 `context_source_unavailable`。只读 Store 与完整 Artifact 输入快照另核真实 `file:` 引用受理、工具结果进入下一模型、外部说明及文件正文未进入输入；脱敏报告只保存模型／协议、终态、工具错误与计数，未保存凭据、请求或响应正文。现有[越界回归](../../../../apps/service/test/isolated/assembly-file-denial.test.ts)以 `bun test apps/service/test/isolated/assembly-file-denial.test.ts` 运行，1项／13断言通过。

前述外部场景明确要求调用 `read_file`，只验证工作区工具误用时不终止整轮，不能作为“选中的外部附件可用”的验收。随后修复普通宿主默认缺选 `files.read_path`，同日同环境使用全新独立 Profile，通过原生 `+` 选择工作区外 ini，以普通提问要求根据实际内容说明。模型自行选用 `read_user_file`，准确目标读取成功，最终字段值与文件一致；原 Run `completed`、两次成功 Model、一次成功 `files.read_path`，完整输入核实实际正文进入下一轮、未选中外部项目说明未进入模型，无 `context_source_unavailable`。外部写入／编辑未随默认读取开启；报告只保存脱敏结果与计数。普通默认／显式禁用及真实原生读取由[Service 回归](../../../../apps/service/test/isolated/configuration.test.ts)另证。

这是路径附件的本机原生流程证据；选择文件不改变现有执行权限和受保护文件规则。直接图片协议、PDF 正文解析、其他模型及正式 installed／其他平台仍需分别验证。当前产品与实现归 [Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)。

## 历史模型套件

以下 compaction 与 background 文件仍依赖旧运行时，根脚本中的旧 aliases 已退出，不能用于验证当前实现。保留原命令和记录供对应历史版本追溯。原 context compaction 命令为：

```bash
KITE_RUN_LIVE_MODEL_COMPACTION=1 \
KITE_LIVE_MODEL_API_KEY=... \
KITE_LIVE_MODEL_BASE_URL=https://provider.example/v1 \
KITE_LIVE_MODEL_NAME=model-name \
bun run test:model:live
```

只有 DeepSeek-compatible endpoint 才设置 `KITE_LIVE_MODEL_PROVIDER_TYPE=deepseek`。Runner 有超时上限，串行执行两次 Provider 调用，只报告标识，不输出 prompt、request、summary、配置或凭据。每个套件必须：

- 使用 `*.live.ts` 文件名；
- 从隔离的环境配置选择 provider 和 model；
- 作为独立 runner，由显式 package script 和 opt-in 环境门禁通过 `bun run` 调用；
- 串行运行并设置超时上限；
- 脱敏凭据、完整 prompt、request 和用户配置；
- 记录所有被引用结果的 provider、model、日期、网络条件和命令。

Mock model、仅公网 MCP 和本地 transport 测试不属于本目录。

## DeepSeek 后台任务与多会话

以下套件固定使用 provider `deepseek` 和 model `deepseek-flash`，不接受模型覆盖：

```bash
KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1 \
KITE_LIVE_DEEPSEEK_API_KEY=... \
bun run test:model:live:background
```

本节的旧App Server套件和 `KITE_LIVE_BACKGROUND_SERVICE_EXECUTABLE` 属历史实现。旧Desktop的 `prepare:service` 已退役，不再从当前checkout生成其配套二进制；已保存旧制品的显式历史验证仍只证明那个版本，不能将新Native／Service交给这套旧协议驱动。当前正式Native、完整默认和平台验收归[测试入口](../../../README.md)；本次入口退役没有重跑付费模型或改写原历史断言。

默认 endpoint 为 `https://api.deepseek.com/v1`；只有使用受信的 DeepSeek-compatible 代理时才设置 `KITE_LIVE_DEEPSEEK_BASE_URL`。未设置 `KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1` 时 runner 会在建立网络连接前明确拒绝执行。显式 opt-in 后，runner 会先调用该 endpoint 的 `/models`，确认固定模型 `deepseek-flash` 确实被公布；模型不可用时不发送测试提示，并以“场景未建立”快速失败。

Runner 在权限为 `0700` 的临时根目录内创建隔离的 Kite 配置和 Workspace，以权限 `0600` 写入从环境变量取得的 API key，并在 `finally` 中关闭 App Server、递归清理临时目录。测试使用 FIFO 事件屏障控制 child 终态，不让模型或 child 通过 `sleep` 或固定 `task_read` 轮询维持等待。日志只输出固定 provider/model、不可用的 seed 标记、通过的场景及不含正文和稳定 identity 的脱敏 cardinality trace，不输出 key、prompt、request、response 或临时配置。

该套件通过真实 App Server 协议断言以下场景：

- 会话 A 在同一响应中建立两个 `background + required` child，随后由真实模型显式且仅调用一次 `task_wait([A, B], 60000)`，全程不得调用 `task_read`、轮询或 sleep；两个 child 必须各执行一次指定 FIFO Shell 并回报各自 marker；
- 只释放 A 的 FIFO 后，`task_wait` 必须成功终态，A 为 `completed`、B 仍为 `running`，同一个父 Run 保持 `required_background` waiting 且不得失败；再释放 B 后，同一个 Run 才完成并输出约定正文；
- A 等待时创建会话 B，并由真实模型在 B 中调用文件工具；
- A/B 的历史事件及后台执行投影互不串线；
- 屏障释放后 A 以同一 Run identity 收敛两个 required child；
- 会话 C 显式建立获授权的 `after_turn` child，父 Run 先以约定正文完成，child 必须执行一次指定 FIFO Shell 并保留 marker，终态后按持久化的 `afterTurn.runId` 精确建立且仅建立一个后续 Run；
- 不重启 Service 热重进 A，历史正确投影 `subagent.completed`。

这是付费且依赖公网的串行 E2E。超时可通过 `KITE_LIVE_BACKGROUND_TIMEOUT_MS` 调整；测试失败也不得把完整 provider payload 加入日志。

## 验证记录

2026-10-19（UTC）本轮已实际运行当前工具 smoke 和协作 CLI 的23个变体，使用配置默认的 `deepseek-v4-flash / chat-completions`，不是固定 Provider。逐变体结果、六处 Runtime/Store 修复、进度历史状态误报及夹具修正统一归[本轮执行记录](collaboration-v1.1-cases.md#2026-10-19utc真实执行结果)。I03 保留原 `inconclusive/semantic_review` 报告，独立语义结论另存；该矩阵列出的69个主用例、普通客户端窗口、其他平台和尚未运行的精确交错没有整体取得真实模型资格。早期 failed/inconclusive 与修复后 passed 同时保留。最终相同工作树摘要的23个CLI变体已完成整组复验：22项机械判定通过，I03由机械安全加独立语义复核通过；两项工具smoke也通过，共164次实际HTTP。准确模型、摘要、原始状态及未覆盖边界见上述记录；真实模型整组后的Shell错误快照、损坏report证明及测试等待修正另列代码摘要；最终第七轮默认945文件／748job（含7 exclusive）完整通过、代码输入零漂移，不冒称同一新版本的付费重跑。

- 2026-10-19，Windows x64、Bun 1.4.3、Electron 44.3.0，本任务工作树；真实用户配置的 `deepseek`／`deepseek-v4-flash`／Chat Completions，正常公网网络。通过自有隔离 Profile、合成 Workspace 和普通 Native 开发窗口，经 `+` 两个原生选择器分别选外部 INI 与直接 PNG，再发送；两次 Model 和一次 `files.read_path` 成功，Run `completed`。读取准确 INI 字段、识别图片文字和两个红色方块；封存 Model 输入核原图 Base64 字节、后继实际文件内容、消息正文未改写且文件／图片元数据独立；未选的外部说明未进入输入，无 `context_source_unavailable`。启动／复核命令为 `bun .cache/attachment-cards-e68af6a7-8e05-4353-b253-1f7df0e2151c/native-live.ts` 和同目录 `verify.ts`；这是本次合成数据的临时夹具，原始 Store／配置不作为发布证据，保留脱敏 `report.json`。复现需重新建立独立夹具并明确真实模型授权，不从用户真实目录读取内容。结果限该模型／协议／平台，不覆盖 PDF 正文解析、其他提供商或 Responses 真实端点；实现与确定性回归入口见 [Native owner](../../../../apps/desktop/README.md#markdown-与附件输入)。

- 2026-10-18，macOS arm64、Bun 1.4.2、HEAD `bcf70ce84` 上的工具表面工作树；使用现有默认 provider `deepseek`、model `deepseek-v4-flash`、`chat-completions`，配置的 `reasoningEffort:medium` 保持，测试输出上限为4096。直接网络实际11次HTTP均200；`files`（6次请求）和 `agents`（5次，包含真实child）通过，共11次工具调用、10份parent热/冷完整公开快照。准确终态、子结果 `323`、任务目标和磁盘效果均独立断言。命令为 `KITE_RUN_LIVE_MODEL_TOOLS=1 bun run test:model:tools:live --output=<自有绝对路径>`；最终runner耗时11.916秒，Provider实报输入34921/output1524 token。此前调试首次因测试使用字符串比较对象键顺序误报快照差异，修正后完整两场景通过；本轮三次runner实际合计29次请求，无换模型/协议或自动重试。只保留脱敏报告，不保留请求或响应正文。此证据不覆盖Native/Windows/Linux、其他模型、真实MCP远端或完整Service客户端。
- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
- 2026-09-20，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：`auto` 交互模式下，A/B 会话隔离、B 独立交互、后台 Shell 与后台子 Agent 的工具调用及持久终态、A 的主 Run 完成、热重进历史投影全部通过；A 的两项后台执行均为 `completed` 且 `cleanupConfirmed`。Service 环境显式注入指向 Workspace 外启动脚本的 `BASH_ENV` 与 `ENV`，Shell stderr 为空且启动脚本副作用未发生。未保留 provider 请求或响应正文。
- 2026-09-20，provider `deepseek`，要求 model `deepseek-v4-flash`，官方 endpoint 正常可达且凭据通过 `/models` 鉴权。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：场景未建立。官方 `/models` 只公布 `deepseek-flash` 与 `deepseek-v4-pro`，未公布固定模型 `deepseek-v4-flash`；预检未发送模型提示，也未以其他模型替代通过。此前两次无预检运行均在首个 `model.requested` 后以 `recovery_required / unknown / operator_action` 终止且没有建立 task 调用。
- 2026-09-20，provider `deepseek`，model `deepseek-flash`，官方 endpoint 正常网络条件，seed 不可用。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：双 required child、A 等待期间的 B 会话交互、A/B 隔离、同 Run 恢复、热重进和 exactly-one after-turn continuation 全部通过。脱敏 trace 为 required task calls `2`、waiting task count `2`、等待前后模型请求 `2 → 2`、`task_read` `0 → 0`、Run identity 保持；after-turn task calls `1`、原 Run 先完成、continuation runs `1`；B 模型响应 `2` 且子 Agent 事件 `0`。未保留 provider 请求或响应正文。
