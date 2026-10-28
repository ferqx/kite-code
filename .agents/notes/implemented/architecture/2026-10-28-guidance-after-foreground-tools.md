# Agent Note: 显式引导等待前台工具批次收尾

Status: implemented

## Problem

用户要求普通运行中发送只排队，由队列条目旁的独立按钮引导；引导不能阻止已在工具队列中的动作。此前 Native 普通发送直接 steer，Core checkpoint 会退休旧的未派发 Tool 和审批，模型还可能只继续工具而没有回应独立问题。自动压缩交错时，同样需要保留完整新输入及原任务。

## Decision

Native 普通发送固定 follow-up，显式条目操作通过 Main 保留的原输入构造带 `queuedInputCommandId` 的 steer。Store 在一次受理事务中核准确原 pending 输入、身份、前驱、正文和附件，撤下原输入与登记新引导一起提交。原请求不改写，原五类 caller journal 继续保存和查询准确请求；不新增工具、API或私有库版本。新 Native 来源关系使用既有 DB9 caller 标记，旧格式仍拒绝。

Loop 的 Tool 批次期间不应用用户 steer，所有原前台 Tool（包括尚待派发、资源和审批等待）先按原身份收尾；Store 同时拒绝过早 `applyInput`，Tool 最终派发不再被 pending steer 阻断。真实取消、权限变更、未知效果及显式 result.include 的原边界保持。已脱离前台的 Shell／child Job 不加入这个等待。

每条引导仍是一条带原 sourceID 的独立 user 消息。共用模型合同要求先回应新输入，再继续必要工具；不靠伪造助手消息或第二个分类模型实现。标准自动压缩继续保留原输入及来源，在摘要中接到引导时拒绝旧摘要发布，再核实新上下文。

本决定部分替代[统一接收决定](2026-10-23-unified-message-reception.md)中“用户引导退休未派发工具”的含义；统一邮箱、串行接收、原 source／回执／授权及 idle续跑理由仍适用。

## Alternatives considered

- 输入框直接 steer，无法让用户区分排队和明确引导，也与本次确认的条目按钮冲突。
- 先撤回再单独发送，两次写入之间丢响应可能失去消息或重复后继任务；选择原子受理及原 caller journal。
- 引导继续使旧审批和未派发工具失效，会阻碍原工具队列，不符合本次产品要求。
- 等全部后台 Job 结束才接收，会让长后台工作阻塞用户对话；只等待前台 Tool 调用真实收尾。
- 强制追加助手答复或禁止下一工具，不能证明真实模型理解新输入，也会改变正常任务推进；采用合同指导并真实模型核对正文、工具与最终交付。

## Consequences

引导不能用来绕过或取消原待批工具，显式停止仍使用原停止入口。含新 Plan／Skill 选择的队列输入保持后继任务；转引导不替换活动模型配置。转换原申请的有意撤下不作为启动失败显示，队列和持久消息各自只展示一次。

验证入口、实际样本和未验平台范围归[Store 输入 owner](../../../../packages/agent/src/storage/sqlite/inputs/README.md)、[Native 队列 owner](../../../../apps/desktop/README.md#原运行中消息队列)和[真实模型验收](../../../../tests/e2e/live/model/README.md#运行中引导与自动压缩)。
