# Portable 输入意图

[input.ts](input.ts) 的 `DesktopInput` 只消费已准入的 `AgentClient` 与生成 DTO。调用者在点击时提供准确 Session、expectedStoreId、contextSelectionId、targetRunId/afterRunId 和新用户意图的 commandId。模块不从选中视图或 activeRun 猜目标，不拥有 Runtime、Store 或 Service 生命周期。

`start`、`steer`、`followUp` 保存深拷贝冻结的原请求。同 commandId/相等内容共用 in-flight Promise，响应未知后也不再发送；不同 Session/内容拒绝。`lookup` 仅查询原 Command，沿 Client 的 `readOrdinaryCommandApplication` 核准确业务 Command/Run，不要求公开 ID 等于业务 Run.originCommandId。旧直接 steer 仍核原 targetRun；真实人类决定另开工作时以已封存业务回执绑定新 Run，原技术目标和请求保持不变。accepted 尚无已应用业务时不借原 targetRun 的终态冒称输入已完成。applied 不表示模型消费完成；terminal 必须另读取真实业务 Run，其 completed/failed/cancelled/interrupted 字段保持，不统一伪装成功。

`accepted` 也不保证 Run 已创建：宿主资产或配置准备可在受理后将原 Command 拒绝。DesktopInput 保留已核实的 `receipt.reason`；Native 对当前 Session 的原输入 ID 继续只读查询，热首次提交沿原 `conversation.lookup`，冷持久 caller 沿原 `caller.lookup`。无 Run 的拒绝在原输入后显示共享轻量失败；冷 Session 没有对应新 Message 时也显示启动失败，即使已有成功历史，不回到欢迎页、不伪造用户历史。无可关联消息的失败按准确 Store/Session/Command 独立展示，完整历史首次可读后固定本进程位置，后续新输入不使旧失败漂移；冷态无排序依据时不臆造它与既有消息的因果顺序。错误详情采用可读说明，不展示内部原因码。热态仅在原草稿未被后续编辑时恢复原文，已保存的历史保持原顺序；再次发送必须来自明确的新输入意图，查询、切换和重开均不自动 POST。

正式 Native 的[宿主 journal](../electron/caller-journal.ts)在核原公开 ID、请求摘要、主体和 Store/Workspace/Session 后，复用同一业务查回器。已封存的人类补充可沿实际 `input.steer` 业务绑定原 Run，独立工作可绑定新的业务 Run；旧技术 steer 仍核原 target 和 contextSelection。applied 的只读观察允许顶层 Run 为空，实际观察 Model 单独验证；unresolved 保持 accepted。冷查回只读原身份，不获得重新提交权限。[宿主回归](../test/native-caller.test.ts)覆盖这些分支与外来、未应用和伪造绑定拒绝。

进度或需澄清的已封存观察可核真实解释 Model/Run，但不把解释轮投影为该输入的业务 Run。需澄清的公开命令保持 accepted，原正文通过会话视图读取；查询不创建业务、取消或替代提交。[纯回归](../test/input.test.ts)另核业务身份、外来/未应用回执拒绝、pending steer 不伪终结，以及解释观察不冒充业务轮。

`cancel(originalCommandId, cancelCommandId)` 固定原工作 Session/Store/command，只提交一次取消意图；重复按键共享原取消。取消 receipt 不表示实际停止。响应未知保留原身份，通过 `lookup` 核实，不重新选取当前 Run 或换 Store。

提交 callback 总携带原 Session 和冻结 intent；视图切换不会改投迟到响应。`disposeObserver` 只停止本模块查询与 callback，不断开共享 Client、不取消工作、不关闭配套进程。已有提交仍保存结果供宿主核对。每实例至多保留 128 个工作意图（可显式配置），并为每个工作保留独立的取消身份；满时明确拒绝新工作但不阻止取消，不淘汰未知工作。此限制是客户端身份保留容量，不是工具/模型执行预算。[意图测试](../test/input.test.ts)另验证满容量仍可准确取消、响应丢失只查原身份，以及 observer 只中断所属查询。

[真实 paired 测试](../../../tests/isolated/unified-agent/desktop-input.test.ts)启动实际 Service 子进程、SQLite Worker、固定 Model 和同 Loop child：child 等待时引导同 Run，follow-up 排队后才开始；原回执丢失只查询，精确取消去重；不同视图、错误 Store/目标、调用者修改请求和 observer 退出不会改变原意图。`DesktopInput` 及有限 intent 类型已由 [公共入口](index.tsx)导出。测试只证明便携调用者闭环，不建立正式 Electron、PTY 或入口切换资格；正式 controller 输入流程仍待接入。


Native 的[输入策略](native-input.ts)可在这次 start/follow-up 携显式下一轮 modelId/reasoningEffort；点击时复制选择，Plan 和压缩后的后继输入也使用该次新选择。普通 active steer 不携这两项，仍只引导原 Run。模型偏好与页面临时档位生命周期归[Native owner](../README.md#native-provider-与下一次模型选择)，便携 DesktopInput 不猜当前界面模型。
