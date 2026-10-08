# Agent Note: 原 PC 工具行沿真实执行观察迁入

Status: implemented

## Problem

原 PC 使用 ToolActivity／ToolRow 展示工具过程与结果。新公开 Message 的 complete 只表示结果消息完整，不证明工具成功；source Execution、工具结果和活动 Run 独立保存。旧 UI 分类还会解释 ask_user、task 等旧名称，直接套用未来同名定义可能隐藏正文或补造语义。已确认目标是复用原 PC 界面并接统一 Client，不恢复旧 State／stdio 路径。

## Decision

Main 的普通 metadata reader 只读取已观察 Message 的唯一 source Execution，核同原 Store／Session／Run、tool kind、终态、result outcome 与完全相同 content；完整历史分批32项，不依赖 View 的近200执行列表。读取以 generation／viewSelection／history epoch 绑定，close／detach／选择变化只释放所属 GET。失败与未知保原正文，明确重试仍是只读。普通事件刷新暂清controller snapshot时沿同选择／Store的已验证lastView保留阅读身份；明确选择、reset和Store变化仍撤销。

工具目标仅展示同一原来源／Run、结果前且已读历史中唯一 Model call 的请求字段，有歧义不补。它不建立执行身份、不证明实际目标与效果、不取得文件打开资格；后者仍沿独立 Files receipt／观察ID。当前Files read3与已知read2的路径均核baseline，write/edit仍限已知版本2。

当前非终态工具只来自当前 Store、所选会话活动 Run 的真实 tool Execution；同源结果消息接管，foreign恢复历史不遮掉新工作。停止申请不冒充终态。Shell工具操作沿准确名称表达，启动受理不冒充Job完成；完整Job输出与精确停止继续原独立入口。

Native直接复用原ToolActivity／ToolRow的轻量行、箭头和结果展开；只对已知定义／版本适配旧分类。未知定义／版本保原ID、version与可展开原文，不能借同名旧分类解释。当前范围归[Native owner](../../../../apps/desktop/README.md#原工具过程与结果阅读)与[实际进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原工具过程与结果阅读)。

原Composer累计缓存用量复用同一有限reader与所属lease，另设只读usage页，避免把用量读取失败连带为Run／工具展示失败。完整已观察助手Message的唯一原Model成功结果、Session／Run／content及实际cached字段分别核实，32项分批；sealed副本按原Store／Execution只计一次。用量是不可变Model事实，允许读取准确封存来源，不能套用轮次reader的未封存限制，也不查询来源Run后来状态；已恢复foreign结果另核终态出处，foreign active拒绝。无样本不造0%，新批读取失败不发布部分累计，不新增持久缓存、Core／HTTP或执行链。当前实现与证据归[Native owner](../../../../apps/desktop/README.md#原输入区累计缓存命中率)。

## Alternatives considered

- 将Message complete直接映射为工具成功：会把真实失败、取消与未知当作成功；未采用。
- 只用View近200项或重复toolCallId寻找执行：完整旧历史和重复模型调用无法准确关联；沿原source Execution读取。
- 将新Shell launch映射为旧同步Shell成功：受理与Job终态不同；各操作保真实含义，Job控制与完整输出保原入口。
- 所有定义名直接交旧工具分类：未来同名task等会触发旧分支并隐藏正文；未知定义／版本仅提供文字标题与原文。
- 从请求字段授予文件打开或重建逐操作diff：请求不证明执行成功／目标／结果；只作展示，仍沿[Files回执决定](2026-10-08-native-file-change-receipts.md)处理实际文件入口。
- 重写消息UI或重新接旧Runtime：不符合原PC复用与统一调用目标；直接消费已有组件，不增加第二提交链。

- 将缓存用量并入仅保代表Message的Run页：会遗漏同Run的其他Model记录，并使遥测失败影响轮次阅读；保独立有限usage页、复用原Main观察与lease。
- 把缺缓存字段当成零命中，或逐个sealed副本重复累计：前者编造样本，后者重复同一Model；仅累计真实用量并按原Store／Execution去重。

## Consequences

轮次阅读、相邻已知读取聚合和默认ask_user v1回执的后续接入归[轮次展示决定](2026-10-08-native-run-transcript-presentation.md)；该部分更新此前未接入范围。本篇唯一source／原结果核验、32项scope／所属GET、目标不授予文件权限、未知版本与Shell／Job分离理由继续指导当前实现。

工具状态来自真实执行；结果正文和控制权分开，关闭阅读不取消工作。Core／生成HTTP API／SQL／私有维护格式均未改变。有限metadata与DOM、默认源码外macOS窗口只证明对应断言；有限审批历史后续沿[审批决定](2026-10-09-native-approval-observations.md)接入；完整自动审批窗口、通用交互历史及全部封存／恢复组合的就地呈现仍未闭合，完整PC、安装版、其他平台、独立审查和资源退出资格不由本片代证。
