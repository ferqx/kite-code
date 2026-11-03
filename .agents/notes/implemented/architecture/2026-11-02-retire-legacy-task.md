# Agent Note: 移除旧 Task 执行协议，保留当前异步协作

Status: implemented

## Problem

六工具已经提供稳定子 Agent 协作，工厂却仍注册隐藏旧工具，旧结果义务、显式 after_turn 和测试桥同时维护两套模型入口及完成路径。仅隐藏不能阻止可信调用继续使用旧协议。用户明确要求彻底移除旧 Task 语义，不保留兼容；后台 Agent、Shell、消息追发和引导仍是当前产品能力。

## Decision

- 工厂只注册 task.spawn/message/follow_up/events/list/interrupt，保持当前 v1 定义与六个公开名称。旧 Task 工具、参数、记录／条件和隔离兼容夹具删除，Service 不再选择旧定义。
- 删除 resultRequirement、专用必需结果自动消费与等待、status-only 诊断结算和客户端 Required results 状态。通用 Requirement 与原计划审批仍检查真实业务条件，不因为移除旧 Task 放宽权限、取消、unknown 或恢复门禁。
- 完成结果仅沿当前 agent_completion 邮箱订阅；AfterTurnPolicy 仍是 idle 自动通知轮的可信授权，不能与退役的显式 after_turn 意图混淆。旧无 marker 报告不回退执行。
- 通用 Extension Operation API 仍是支持合同：真实第三方／测试扩展使用 ensure、wait、Agent 读写和邮箱。它们不是旧 Task 别名，不随模型工具退役一起删除。后台 Shell 仍沿原 Job 的启动、输出、等待、停止与清理链路；父普通结束不取消已受理 child，queued 引导和 idle 明确 follow-up 保持稳定 Session。
- 不递增工具、存储或 native runner 版本，不破坏数据库列与普通来源的既有身份。遗留空列／固定序列化标记没有旧 Task 执行解码或授权路径；旧工具配置不能继续执行，历史存储不等于执行兼容。

## Alternatives considered

- 继续隐藏旧定义供内部调用和恢复：仍维护两套语义，与用户明确要求冲突，未采用。
- 一并删除通用 Agent Operation／邮箱接口：会破坏当前扩展合同和后台协作，超出旧 Task 移除范围，未采用。
- 保留旧必需结果等待但改名：仍保留旧完成机制与客户端状态，未采用；当前 Agent 使用六工具观察实际工作及原邮箱结果。

## Consequences

当前六工具、后台 Job 和消息机制继续共用普通 Runtime／Store。旧 Task 调用方须改用当前工具或通用 Operation，旧定义缺失时拒绝执行，不恢复旧处理器。退役不把受理、观察、消费或业务成功混为一谈。

当前实现与回归归[协作 owner](../../../../packages/agent/src/extensions/task/README.md)和[测试 owner](../../../../packages/agent/test/isolated/business/task/README.md)。执行组崩溃测试用固定通用 Operation 夹具保留排队、审批、取消及后代配置释放断言，不通过测试桥重建旧模型参数。原结果显式恢复暂缓时，在同一事务保存准确 report_deferred 恢复回执，原结果保持待接纳且不调用模型。

本决定部分取代[稳定协作者](2026-10-18-stable-agent-collaboration-and-human-work-selection.md)中保留隐藏旧工具的选择，以及[独立子 Session](../feature/2026-09-26-independent-agent-sessions-and-result-bridge.md)中的旧 required 桥接；稳定身份、独立上下文、准确来源与取消取舍继续适用。通用扩展与当前手册始终定义现行边界。
