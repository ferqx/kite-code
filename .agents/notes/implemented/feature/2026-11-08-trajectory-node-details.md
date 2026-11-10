# Agent Note: 轨迹节点分型详情与原材料

Status: implemented

2026-11-09，[逻辑操作决定](2026-11-09-trajectory-semantic-operations.md)部分取代下述“默认Raw仅单对象观察”及“压缩生成／采用在主列表两行”的展示后果。底层仍独立保存，现由同一逻辑操作详情选择原成员；本页工具分型、原材料、完整性与授权边界继续适用。

2026-11-10展示补充：普通阶段不恢复Raw、来源或生命周期。描述性消息附件展示原name／mediaType／size（含0），保重复和原顺序，不因有名称就取得读取资格；仅获准Model输入的闭合四格式inline image可显示原保存字节。子Agent从准确tool_input的prompt／taskName／preset提供可读委派信息并保JSON。压缩原selection仅以消息序号解释保留边界／尾部／范围，触发基线与估算不等同摘要请求usage。问答对象答案按原问题id与原schema提取的const选项匹配，公开交互projection只增有限题干／选项白名单；原答案null、[]、空字符串、未封存和原取消事实分别表达。Shell／Job保每段丢弃量和缺口，计划pending按计划语义，空列表不冒充缺字段。缺失信息不从相邻节点、当前文件／网络／工具配置重建。模型请求仍只在节点间圆点的四Tab，思考只保正文；上述旧表的Raw和模型指标混入思考描述已由后续决定替代。

2026-11-10实机补充：原审批检查Command未必另产规范Command事件，writer只在准确原Command.kind=authorization.check且无Run的Model封存既有display.operation=review；UI仍核同原Store／Session与准确Tool／Job父，缺证明旧记录保守展示。真实流式canonical Message可能早于Model完成时再次封存材料，阶段的呈现锚受准确同Model回复首观察约束，但材料targets仍取所选原版本，不重排真实Tool／child。公开context／interaction的partial是有界公开子集，不代表生成未结束；压缩直接展示原CompressionRecord覆盖／发布消息上下文序号，0发布为未发布。子Agent同原Job已有可用终态答复时默认精简较早进度检查点，显式原观察不删。新记录提示置既有定高toolbar，不新插一行顶动历史内容。

2026-11-10 Native 子范围补充：普通父选择门禁原先拒绝准确子 Session 的正文；保留任意 Session 拒绝，只允许父 reader 已见的原 Task carrier 证明直接 child Session／Run／Store，固定父观测上界并对每份材料复核已见 event／ref／版本。隐藏或换选择撤销证明和 lease；重开在原父 cursor 内只读重证，不继承旧正文权限。另一选择是放开所有子 Session 或信任 renderer 的目标参数，均因扩大读取边界未采用。精确挂接后仅去掉外部 carrier 的那条缺父误报，父子原事实不改。完整 Electron／Service／Runtime／SQLite 与本地确定性模型对话已实测内部工具、压缩、人工审批和冷读恢复；远程 Provider 与跨平台不由该证据证明。

2026-11-10提交审查补充：Native材料读取权与原close身份分开保存，隐藏／关闭先撤销读取代次，关闭未确认仍保留准确原身份重试，不能因同scope重开恢复旧lease。Trace历史材料的异步open／chunk返回前重核原任务分区，取消先撤材料再等待外部engine。原问答空对象答复保留为已保存值，不等于缺失答复。所需边界沿原owner与原测试维护，不新增调试入口或协议版本。

离线包复核补充：详情与可见Loop使用独立材料owner，原输入／输出会自然并发；单lease会互相撤销，现按准确readId独立记offset与关闭，并在I/O前共享有界预留预算。成功pick由Main先退休旧包，Renderer不再重复关闭旧身份；真正迟到pick与卸载仍关闭准确返回身份。换包撤销全部旧读取，不将旧pending预算扣到新包。

## Problem

统一预览内再切入参／出参不能准确表达消息、模型、工具和压缩。工具需要完整 JSON 参数及常规结果；压缩需要实际采用的摘要与同口径前后上下文 Token。生命周期逐阶段列表增加阅读负担，且 Model 成功不等于压缩已经采用。直接透传 `ToolResult.details` 或查询当前行会混入私有字段、实时句柄或未来版本。

## Decision

[工作台决定](2026-11-08-trajectory-workbench.md)负责右侧标签入口、组合过滤、真实层级、历史、调宽与窄栏覆盖；本决定负责节点内容。生命周期不再呈现为区域、Tab 或阶段跳转，原事件、phase、状态归并、版本和导出继续保存。

| 节点 | Tab | 读取内容 |
| --- | --- | --- |
| 用户消息／Agent 回复 | 概述、预览、原始内容 | 原消息角色、完整性、正文和公开附件名称；不把工具结果当 Agent 回复。 |
| 普通模型 | 概述、预览、原始内容 | 已保存请求和公开输出，原 usage 单列；思考仅在已保存且获准的材料内默认收起。 |
| 工具 | 概述、参数、结果、原始内容 | 参数是原执行 JSON；结果使用 owner 封存的公开分型，Raw 保留规范事件与原公开字节。 |
| 子任务／后台／子会话 | 概述、预览、原始内容 | 原投递回执、保留的输出与已确证关联；accepted 不冒充执行完成，缺 child 正文不跨 scope 补读。 |
| 自动压缩模型／压缩发布 | 概述、预览、原始内容 | 候选或已采用状态、同口径上下文计数、原摘要与原保留范围，预览抑制 reasoning。 |
| 审批／问答 | 概述、预览、原始内容 | 原请求、决定和回答，仅查看，不新增接受／重提操作。 |
| 会话、执行轮次及无预览结构项 | 概述、原始内容 | 按实际能力裁剪空预览。辅助／未知事件仅解释安全规范 envelope。 |

跨类型选择时不适用 Tab 回退概述，不能将工具结果页继承为模型的虚构结果。旧持久化入参／出参／生命周期状态仅兼容读取，不恢复旧控件。Raw 以当前所选原观察的规范公开事件为准，不输出所有阶段数组、私有封装或当前业务快照。

### 工具参数与结果

`tool_input` 在实际 Execution 的原写事务封存原输入：null、空对象、数组、标量和大参数保持原值。公共内容就是该 JSON，不添加私有身份 wrapper。Runtime 先核主体、Session、Execution、原 Store、定义及版本，再读取对应 binding；旧事实没有 input ref 时明确未封存，不从邻近 Model.arguments 或今天的 intent 补齐。

结果由原注册定义及版本的适配器生成闭合 `presentation`，与原结果一起封存。公开材料只含 outcome/content 和通过 schema 的白名单；私有 wrapper 留在原 Store。未知定义、未来版本、旧结果或不识别 presentation 继续公开文本／JSON 回退，不能靠名称或任意 details 决定卡片类型。

| 分型 | 原字段与展示 |
| --- | --- |
| 文件 | 原操作、路径、行范围、已保存文本及截断状态；原 FileChange 展示差异，不能重读当前文件。 |
| Shell | 原执行回执、status/accepted/cancelRequested/timedOut、exit code、stdout/stderr/progress/gap；保留 Decimal64 输出区间和 droppedBytes，预览不冒充完整日志。 |
| 网页／浏览器 | 原 URL、标题、公开内容／快照、已保存状态和元素信息；不重新抓网页、控制页面或读取现在画面。 |
| 子任务 | 原 agent/execution/run、投递与状态回执；执行与回执意义分离，相关原节点可定位。 |
| 计划／工作树／技能 | 原计划正文、步骤和版本；原路径及 mutation/cwd 结果；原技能版本与正文。 |
| MCP／问答 | MCP 原公开文本、isError、structuredContent 及常规内容回退；原问题与答案。动态工具不能凭名称强制定制。 |
| 原媒体／产物 | 只读正式原 Artifact 引用；图片、PDF和大正文按原 owner/subject/Store/size/mediaType 校验，不暴露本机路径或任意 URI。 |

工具失败、取消或等待时仍可读已经封存的原参数。结果未知、未发生、部分、截断、缺失、不可用、遮蔽和空内容分别说明，不补造成功或零值。大正文沿原 `modelContent` Artifact 精确读取到 EOF；私有 Model 封装、伪 Artifact 引用与异主体材料被拒绝。只读页没有重跑工具、恢复执行、审批或写文件动作。

### 自动压缩

触发时用量、摘要模型 usage、压前／压后上下文是三种口径。触发观察可含 Provider 实测基线加本地估算，或纯本地估算；不能把摘要调用的 input/outputTokens 改名为压前／压后。

压缩端口支持可选 prepare measurement 和 `validateSummaryReport`，原 boolean validator 保持兼容。仅原发布事务成功采用后记录 `compression.adopted:true` 和同口径 `local-context-estimate-v1` 的 beforeTokens/afterTokens；计算减少量／比例。旧数据、自定义算法没有报告时说明未记录，失败／拒绝／取消／未发布不显示实际压后容量或虚构 0。

压缩模型生成事件当时是候选，后来的 Context publication 标记真正采用；旧 Model 事实不追改、不与发布节点合并或重挂父级。按原 compression 身份关联定位，默认概述可使用当前历史前缀内的确证发布事实；明确选择旧观察时不能偷用未来发布。发布记录绑定准确原摘要 checkpoint，公共读取仅 `content/complete`；预览完整原摘要，不混入 reasoning。保留范围仅来自原快照材料，不从当前上下文重新构造。

### 读取与兼容

详情仅请求当前节点／Tab 需要的准确 refs，绑定原 event/atCursor/contentVersion。原 source、owner、cursor 或可见性改变的 render 先隐藏旧正文；请求队列也绑定原 source/scope，不能将上个包的目标自动交给新包。取消、A→B→A、迟到 open、断开重连与关闭重开由 epoch 和原 source lease 清理共同守卫。无权限或离线缺材料不能回连补正文。

`tool_input` 为共享 Evidence 新类别但没有协议／工具版本递增；Trace 必须 manifest 和新授权都显式允许，旧 grant 不自动扩大。新读端读取旧 V1 的缺项状态保持；当前 bundle 可精确保存新参数和压缩 metadata，错误 event/ref/version 无材料。未知未来规范事件只保安全 envelope；离线包沿用不支持事件版本整页拒绝的既有边界，不将它描述为已支持未来格式。

## Alternatives considered

- 所有节点三 Tab、预览内再切入出参：用户要求工具参数和结果同级；采用工具四 Tab、其他按能力三／两 Tab。
- 保留生命周期折叠区：能逐阶段审计但阅读杂乱；按用户要求移除界面，完整事实与归并保留。
- 当前 Execution 或相邻 Model 补参数：不能证明原请求；只读取原事务封存，旧缺失明确说明。
- `ToolResult.details` 全量透传：包含私有数据、句柄及未核类型；采用原版本适配器与闭合 DTO。
- 模型 input/output 用量当压前／后：混淆摘要请求与上下文；采用独立同口径报告，usage 单列。
- 模型成功即压缩完成或合并发布节点：掩盖拒绝／未采用且改变原因果；保留两类原节点和准确关联。
- 所有动态工具定制卡：名称不能证明版本与结构；正式适配器之外保留公开文本、JSON、错误和媒体描述回退。

## Consequences

分型准确性依赖原事务新增封存，不能只改前端 Tabs。旧记录缺字段不会因新 UI 被补齐；参数及 typed 材料的精确版本、授权、导出和离线回归属于同一交付边界。模型和发布分别保留会产生两行压缩相关节点，这是保存原事实和采用关系的代价。

负责实现归 [Agent trajectory](../../../../packages/agent/src/trajectory/README.md)、[共享协议](../../../../packages/trajectory/README.md)、[UI](../../../../packages/ui/README.md)、[Native](../../../../apps/desktop/README.md) 与 [Client](../../../../packages/client/README.md)。原事务反例覆盖参数类型／取消／大正文、typed 注入、原图片/PDF及伪引用、压缩报告接受／拒绝／旧精确摘要；纯层及 DOM 覆盖 Tab 裁剪、全局顺序、筛选外选择、旧 prefix、读源替换和 lease。生产编译浏览器过程与安装／真实 Provider／跨平台资格分开记录，不用最终截图单独代替体验验收。
