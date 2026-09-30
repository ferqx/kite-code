# 工具契约、解析与执行流水线

入口：[catalog contract](../src/catalog-contract.ts)、[tool contracts](../src/tool-contracts.ts)、[schemas](../src/tool-schemas.ts)、[pipeline callbacks](../src/tool-pipeline-callbacks.ts)、[prepared dispatch](../src/builtin-prepared-dispatch-adapter.ts)。

`task_wait` 可因独立子 Agent 的已提交模型重试或终态返回；运行中的重试快照只包含有限分类与次数。`task_read` 是同一状态的按需读取。已验证的失败子任务仍作为成功的读取 Tool 结果进入父模型上下文，JSON 中的子任务 `ok:false` 和安全终态原因保持不变；未知或外来 task ID 继续报读取失败。重试进度不清除 required 义务，也不授权重复调用无变化的等待。

五个普通文件工具由 [filesystem module](../src/filesystem/runtime-module.ts) 注册和执行，保留原 operationId、provider identity 及 revision。registry 不注册 `git_inspect`；专用 Broker／schema 已删除，Git 请求由 Shell 路径治理。

## 从模型声明到实际执行

工具声明由同一契约提供描述、schema、parser、effect 分类和可用性。模型传来的 JSON 不直接进入执行器：先解析成规范参数，再结合能力绑定和当前上下文编译策略 facts。描述不能宣称 schema 或执行器未支持的行为。

[工具搜索](../src/tool-search.ts)仅将完整的目录查询重定向到 `list_mcp_tools`；带具体用途的中英文查询继续产生候选与 `searchResult`，不能因为包含“有哪些工具”或“which MCP tools”就拒绝能力发现。搜索结果仍不直接授予执行权限，验证见 [目录与用途查询回归](../test/tool-search-inventory.test.ts)。

Host coordinator 维护 attempt 和提交身份，Builtin callback 提供实际机制；Service adapter 注入 filesystem、Shell、MCP 和子任务依赖。Kernel 决定授权与调度，Builtin 不能以“执行函数可调用”绕过这些决定。

| 交接 | 必须保持 |
| --- | --- |
| 模型声明 → parser | 同一 schema，错误不能变成默认参数继续执行 |
| parser → policy | 使用规范化参数与 effect facts，不再使用未解析原文推导权限 |
| preparation → dispatch | exact capability/attempt/参数 identity |
| 外部结果 → receipt | 区分成功、拒绝、失败、取消和 unknown effects |
| receipt → verification | 只引用已提交成功事实与真实 Artifact |

Subagent suspension 的等待事实绑定已解析参数；不能将 raw input 摘要作为第二执行身份。重试要保留正确的已执行/未执行边界，不通过重复调用制造一次成功结果。

Shell 契约区分有限 `shell_execute`、增量 `shell_read`、精确 `shell_stop` 与显式 service；running 结果只发布受管句柄，不伪造 exit code。普通终态也带完整输出的读取句柄，`shell_read` 按 cursor 返回完整页与 `moreOutput`，通信分页不丢弃历史输出。有限执行默认是本轮 required 义务，匹配的 read/stop 观察到真实终态后才能通过完成守卫。后台 `task` 同样用稳定 task identity 与 `task_read`/`task_cancel` 收敛；唯一 Runtime watcher 先把完整结果写入不可变 Artifact，再发布完整具名报告。`background=true` 返回句柄，`result_disposition` 缺省为 `required`；`after_turn` 与后台执行独立，缺少结构化授权或有效预留时在派发前拒绝。

模型契约要求无依赖 sibling 先异步派发，再继续不重复的独立工作；不得用 Shell `sleep`、空循环或固定间隔 `task_read` 替代后台协调。`task_wait` 是显式、有界的事件驱动 wait-any，适用于首个子结果决定下一步动作的中间决策；仅剩 required 结果时模型提交完成候选，Runtime 在同一 Run 自动等齐。`task_wait` 复用 Background owner watermark，超时或用户新输入只结束本次工具等待，不改变 child 生命周期。`task_read` 是用户主动查询、失败／取消诊断及完整终态报告读取接口，不是等待 primitive。`shell_read` 使用上次返回的 cursor 增量读取，或在确需命令终态时有界等待，不重复读取未变化输出。required 义务只由 Runtime watcher 与 Kernel 接纳的终态解除，`task_wait` 或 `task_read` 的返回都不是第二套完成权威。

[会话协调方案](../../../docs/plans/background-agent-shell-conversation-coordination.md)的 A–C 模型调用指引已经写入工具说明与系统提示。阶段 D 的 QueueOnly Tool Surface 在准确 Host 邮箱端口就绪时向模型暴露 `list_agents`、`wait_agent` 与 `send_message`：列表只返回有权读取的 Agent 元数据，等待只返回唤醒原因，直接父子 Session 间发送的消息持久受理且不唤醒空闲目标；成功回执不表示目标已读取。完整跨 Session Host Port 另向模型暴露 `followup_task` 与 `interrupt_agent`；前者空成功回执只证明来源受理，后者返回准确目标状态，不把消息排队当成模型已执行或清理成功。Builtin 把准确 Tool call／attempt 与 Service 提供的调用者身份转交 Host；来源 Session 的既有 `model.responded`／`tool.queued` 记录发送时的 Tool 参数，邮箱专用正文只在来源私有存储持久化，目标 Event 和 History 不复制正文。Builtin child runtime 的私有不可变 checkpoint 为已结算子轮提供新轮输入；新轮以当前系统消息和新提供的工具、预算、provenance、consumer 构造 Surface，旧系统消息只作为标明来源的历史内容，模型序号接续而工具轮数重新计数。Checkpoint 引用自身不授予执行权，Host／Store 仍须核来源受理、资金与新 grant。

## 新增工具时

先定义产品目的和输入输出，再选择现有 owner module，补全声明、解析、effects/traits、机制与 terminal 投影。把生产注册、模型披露、策略与验证一起核对；不要仅在测试注册工具。

规范见[工具契约](../../../docs/active/tool-description-contracts.md)、[工具自治](../../../docs/active/tool-gated-autonomy.md)。验证：[pipeline](../test/tool-pipeline-callbacks.test.ts)、[runtime callbacks](../test/runtime-tool-pipeline-callbacks.test.ts)、[Subagent schema](../test/tools/subagent-schema-conformance.test.ts)。
