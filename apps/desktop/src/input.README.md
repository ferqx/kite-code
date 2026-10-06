# Portable 输入意图

[input.ts](input.ts) 的 `DesktopInput` 只消费已准入的 `AgentClient` 与生成 DTO。调用者在点击时提供准确 Session、expectedStoreId、contextSelectionId、targetRunId/afterRunId 和新用户意图的 commandId。模块不从选中视图或 activeRun 猜目标，不拥有 Runtime、Store 或 Service 生命周期。

`start`、`steer`、`followUp` 保存深拷贝冻结的原请求。同 commandId/相等内容共用 in-flight Promise，响应未知后也不再发送；不同 Session/内容拒绝。`lookup` 仅查询原 Command，并在原 receipt 指向准确 Run 时读取终态。steer 查询原 targetRun；follow-up accepted 尚无新 Run 时只保持 accepted。applied 不表示模型消费完成；terminal 必须另读取真实 Run，其 completed/failed/cancelled/interrupted 字段保持，不统一伪装成功。

`cancel(originalCommandId, cancelCommandId)` 固定原工作 Session/Store/command，只提交一次取消意图；重复按键共享原取消。取消 receipt 不表示实际停止。响应未知保留原身份，通过 `lookup` 核实，不重新选取当前 Run 或换 Store。

提交 callback 总携带原 Session 和冻结 intent；视图切换不会改投迟到响应。`disposeObserver` 只停止本模块查询与 callback，不断开共享 Client、不取消工作、不关闭配套进程。已有提交仍保存结果供宿主核对。每实例至多保留 128 个工作意图（可显式配置），并为每个工作保留独立的取消身份；满时明确拒绝新工作但不阻止取消，不淘汰未知工作。此限制是客户端身份保留容量，不是工具/模型执行预算。[意图测试](../test/input.test.ts)另验证满容量仍可准确取消、响应丢失只查原身份，以及 observer 只中断所属查询。

[真实 paired 测试](../../../tests/isolated/unified-agent/desktop-input.test.ts)启动实际 Service 子进程、SQLite Worker、固定 Model 和同 Loop child：child 等待时引导同 Run，follow-up 排队后才开始；原回执丢失只查询，精确取消去重；不同视图、错误 Store/目标、调用者修改请求和 observer 退出不会改变原意图。`DesktopInput` 及有限 intent 类型已由 [公共入口](index.tsx)导出。测试只证明便携调用者闭环，不建立正式 Electron、PTY 或入口切换资格；正式 controller 输入流程仍待接入。


Native 的[输入策略](native-input.ts)可在这次 start/follow-up 携显式下一轮 modelId/reasoningEffort；点击时复制选择，Plan 和压缩后的后继输入也使用该次新选择。普通 active steer 不携这两项，仍只引导原 Run。模型偏好与页面临时档位生命周期归[Native owner](../README.md#native-provider-与下一次模型选择)，便携 DesktopInput 不猜当前界面模型。
