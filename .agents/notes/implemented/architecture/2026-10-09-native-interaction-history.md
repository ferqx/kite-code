# Agent Note: 原交互历史与当前回答资格分离

Status: implemented

## Problem

原 PC 已有问题、计划和审批卡片。默认 ask_user 的成功结果只覆盖一种工具版本，不能代表通用问题、已保存但未被执行接收的答案或取消记录；工具历史也不能替代原 Interaction 请求与修订。迁入正式 Native 时，若复用当前 pending 卡的附件 proof，只读历史可能意外成为回答资格。分页中变化的记录也不能拼成一次完整观察。

## Decision

继续复用原会话工具侧栏和共享 InteractionCard，从既有公共 listInteractions 读取当前所选根会话及实际投影的 child 原记录。Main 固定 generation、viewSelection、historyEpoch、Store、Session 与 Workspace，逐页核同一 snapshotCursor、原来源、source-first ancestry 和严格推进的 ID；每页20项不成为总数上限。Renderer 到准确 EOF 才发布完整集合，失败保留同范围上次完整事实并提示重新读取，换范围清理旧记录。

历史附件使用独立 NativeInteractionAttachmentReads 实例；仅接纳本次已读卡的原 key，先 GET 原 Interaction 核同一记录，再沿原 SDK／Native reader 核原身份、字节、hash、UTF-8 与 EOF。该实例不进入当前回答链的 loaded proof；历史卡不提供 onAnswer，保存、取消与 accepted revision 分别展示。计划正文使用原格式化组件，修改反馈保原字符串，完整原附件仍可核实后展开。关闭、换会话或 reset 仅撤销所属 GET 与读句柄，不取消业务执行。

现有公共接口的 snapshotCursor 是 Store 观察游标，其他会话或 Model 输出也可能改变它。本片保留一致读取失败和显式重读，没有增加 Core 冻结历史 API，也不承诺持续变化中的多页读取一定完成。当前只核当前 Store 返回的原记录；恢复到新 Store、全部 Fork／Include 组合仍未取得本片资格。Core／Service／Client API、SQL 和私有格式不变。

本决定部分接续[审批决定](2026-10-09-native-approval-observations.md)与[轮次决定](2026-10-08-native-run-transcript-presentation.md)。前者的有限授权观察和原执行 proof，后者的封存来源、轮次、复制与默认问答结果理由继续适用；本片仅补原 Interaction 记录阅读。当前实现和限制归 [Desktop owner](../../../../apps/desktop/README.md#原交互记录只读历史)。

## Alternatives considered

- 从默认 ask_user 成功回执生成全部历史：遗漏自定义 question、计划、审批以及保存未受理的事实；直接读原 Interaction。
- 复用当前 pending 卡的 reader 与 loaded proof：混淆历史阅读和当前回答资格；只复用 reader 实现，实例与资格分别持有。
- 拼接不同游标的页，或只读第一页作为全部历史：会展示一次并不存在的完整观察；逐页核同一游标，直到真实 EOF，变化即明确未更新。
- 新增 Core 冻结历史 API：本片先接既有公共读取和原 UI，保 Core 边界；代价是持续 Store 变化时需要显式重读，不宣称该情形已关闭。
- 重做问题、计划和审批表单：既有卡片已拥有正文与完整附件阅读；在原侧栏接只读卡，回答保持原当前入口。

## Consequences

原 PC 记录可迁入正式 Native，阅读不增加回答或执行权。原请求、答案与受理是分别可核的事实；完整附件 proof 只服务本次阅读，不形成第二份持久缓存。不同范围、迟到请求和游标漂移不能发布混合结果。

Main 43项分页与附件隔离、原卡 DOM、真实 HTTP／Core 的 child 和自定义 question、macOS 原默认首次／冷读及原计划大附件窗口提供本片证据。准确失败与通过归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原交互记录只读历史)。完整 PC、全部封存／恢复组合、完整 Auto Native 窗口、整片独立审查和全阶段退出仍未关闭；有限入口通过不提升这些资格。
