# Agent Note: Native 连续工具聚合与稳定渲染身份

Status: implemented

## Problem

用户要求所有连续工具进入同一聚合，调整混合工具文案，并排查执行中的短暂外逸与闪烁。原 Native 以探索分类控制分组，回执缺 metadata 且原 Execution 已移出近期 View 时会先单列，分类补齐后再归组；单项升级多项也会切换阅读 key 与组件身份。

后续收起状态复查还确认了独立的 Model 交接窗口：实时 View 已显示下一批工具，历史仍保留 `firstOutput=tool_calls` 的空 incomplete Model。它先把连续工具拆成两组，历史接管 complete 后空消息消失又合并。旧浏览器夹具只有用户与工具消息，没有流式 Model，因而未覆盖这一合法时序。

Shell卡片实际使用中又暴露同一交接的缓存问题：Tool回执已结算，前置Model声明尚为incomplete时，Main按原来源门禁只能给最小Shell事实；调用记录后来完整，但renderer只按不可变Tool回执缓存，不再核对依赖的Model。结果是命令永久缺失，正常输出退回原JSON。此前Shell浏览器场景始终先备齐完整Model call，因而没有证明这条迟到路径。

当前行为归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)与[Desktop owner](../../../../apps/desktop/README.md#原工具过程与结果阅读)，共享布局归[UI owner](../../../../packages/ui/README.md)。本决定只调整 Native／共享 Desktop 呈现，不改变 TUI 的探索分类、工具授权或执行结果合同。

## Decision

- Native 按准确 Run 与可读消息边界提供连续工具分组身份，不依赖工具名称、只读分类、定义版本或 metadata 就绪。第一项即使用聚合壳，回执和 metadata 仅更新原项。
- 摘要按实际工具动作去重并直接拼接，如“编辑文件读取文件运行命令”；按用户指定，不加“了”或顿号，不使用“工具调用 N 项”及重复完成计数。动作标题不表达成功或失败，结果沿各项实际状态呈现。各项名称、参数、审批和权限仍需原有证明。
- 按用户后续要求，聚合标题后不追加状态、数量或异常文本；失败与审批未通过的原因仅在点击对应工具展开后显示，成功读取继续使用原文件行与打开资格。用户后续认为Shell阅读区偏矮，聚合整体上限从240px提高为400px，其中32px标题外的列表最多368px并内部滚动，列表项之间的纵向间距由2px再次调整为0；长详情滚动区随总高收缩、保留全文并提供键盘滚动。该限制不裁掉异常文本或改变执行事实。
- 已批准审批以14px低对比度盾牌勾及可访问Tooltip代替常驻文字；自动审批未通过复用同一布局和交互，以警告色盾牌图标显示，Tooltip只含状态、完整拒绝原因仅在展开详情。其余工具行附属状态使用13px辅助色；确认未派发的审批拒绝／取消只保留审批标记，不再追加重复的未执行／停止，Shell详情不重复审批等待。去重只针对同因的审批与未派发事实，真实超时、结果未知与已派发结果继续独立显示，异常色与逐项详情保持。
- 用户明确限定在工具聚合及工具详情统一ScrollArea与scroll-fade。沿用项目已有shadcn／Radix共享适配，fade显式作用于真实viewport，默认关闭以保其他消费者；工具聚合、异常／原记录、Shell、差异与旧子Agent工具过程各自保稳定viewport。region、键盘焦点、Shell ref／onScroll与跟随转到该节点，PRE只承载正文，避免双重滚动或把offset写到外壳。
- 聚合与逐项详情各自保存阅读身份；默认收起，组内保留差异、输出、原记录和准确子 Agent 导航。代价是单工具也需先展开聚合；新增连续工具不会再把已读单项突然替换成另一容器。
- Shell按用户参考采用紧凑状态／命令行与展开的CodeBlock卡片，按后续要求将命令固定在Header，只有输出滚动，结果固定在Footer；按后续要求，Header命令保原始换行且长行自动折行，不省略全文并可复制原命令；移除回到最新输出按钮，保手动滚回底部恢复跟随。后台受理、读取、等待超时和停止请求分别表达，只有准确Job成功显示成功勾号；不能从Tool消息完整推断进程成功。最小operation不冒充受理证明，失败／未知即使有部分输出仍保完整异常记录。已知execute@1与其他Shell共用该卡，未来版本保原文。Shell局部inline-size containment限制长命令对Radix table wrapper的固有宽度贡献，避免窄窗口内部裁切，不改变主会话滚动组件。
- 浏览器复现了live Execution接替成receipt时逐项id改变、卡片卸载并丢展开的独立问题。逐项React key、展开key与阅读缓存因此共用准确执行的presentationKey，原消息id仍负责读取与业务操作；不改执行身份或赋权。metadata等待与原记录阅读保在同一卡片内，不先闪JSON。命令全文沿既有metadata list有界分片，只有拼齐才标全文，不把summary冒充原命令，也不扩大普通live DTO；准确来源及预算归Desktop owner。
- Shell命令在排队、审批及运行中沿同scope已观察的exact Tool GET读取，复用原metadata list的有界分片，不扩大View／后台目录DTO，不等Model／receipt完成。同一Execution的已核输入可接替到receipt，不能借其旧状态、审批或结果。可见原调用仍要求唯一且匹配Tool输入；匹配声明变化或冲突只重核所属项，正文、思考及无关Model不触发补读，失败保原记录与显式重试。先前Model省略资格前置已由准确Tool输入替代，Files等其他目标规则保持。
- 保留逐消息 `renderMessage` 的逐项调用合同，避免自定义宿主仅收到聚合首项。
- 只有 `firstOutput=tool_calls`、预览为空、无body或明确`contentBytes=0`、格式受支持且无附件的模型声明才投影为隐藏。它保留原身份、role和持久事实，既不占布局也不充当分组边界。非零body的空预览仍需原reader，不按空text一概隐藏；后来真实正文仍成为可读边界。该规则不把工具声明冒充思考阶段。

## Alternatives considered

总数式摘要无法说明混合工具做了什么，未采用。保留原分类并延迟显示整个聚合的方案，无法消除 metadata 补齐后的结构变化，也会把可读内容等待与执行事实核验耦合；仅改 CSS 隐藏独立行同样不能保持节点身份或阅读开关，因此未采用。

前一轮先修复原Model调用补齐时的缓存依赖失效，仍以完整Model为命令读取前置。用户随后明确要求执行中立即显示具体命令，因而本范围改由确切Tool的原输入证明命令，避免把独立Model／receipt的完成时机当作显示前置；该输入本来就是Service提供的display fact。可见原调用仍必须唯一且与准确Tool输入一致，冲突撤资格，Job版本／结果／授权门禁保持。旧缓存失效修复中的匹配调用冲突订阅及失败重试理由继续适用；完整Model及省略body资格不再是known Shell输入可读的必要条件。无条件从未核实View／模型文本补命令或放宽Job版本仍未采用。

## Consequences

分组从工具资格事实解耦；原名称和结果仍独立核验。单项也默认收起，阅读选择随原分组保留，明确的可读消息边界仍建立新的分组。没有增加等待计时器、业务状态或执行授权。

可见调用的唯一性必须先于完整性／格式检查：Main与renderer都统计同来源的全部匹配callId，不能先过滤未完成或unsupported的Model再认定唯一，否则renderer撤下命令后，Main补核会错误恢复它。准确Tool输入只填补原调用未加载／省略的情况，不能绕过已观察的重复冲突。

## 验证

[共享聚合 DOM](../../../../packages/ui/test/isolated/desktop-tool-aggregation.test.tsx)核首项、混合工具、状态与边界、Shell 输出和阅读选择；[Native 运行期 DOM](../../../../apps/desktop/test/isolated/native-live-tool-aggregation-dom.test.tsx)核近期 Execution 移出 View、延迟 metadata 与回执乱序接管。浏览器过程与实际执行记录归 Desktop owner，不从测试文件存在推导安装版或其他平台资格。
