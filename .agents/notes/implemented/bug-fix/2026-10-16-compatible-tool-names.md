# Agent Note: Compatible 请求中的工具名转换

Status: implemented

## Problem

用户桌面的首个 DeepSeek 请求在约300毫秒内以 model_failed／execution_failed 结束，原错误响应没有保留。原 ModelInput 未设置 reasoningEffort，却带有 files.read 等八个默认工具；SDK 将内部 ID 直接写入远端 function.name。[DeepSeek 官方合同](https://api-docs.deepseek.com/api/create-chat-completion/)只允许函数名包含字母、数字、下划线和连字符。原模拟服务接受带点名称，导致工具整轮测试通过而没有检验这条合同。获准的一次真实无工具“你好”请求返回200并完整结束；随后另经明确授权，使用原八个工具定义、相同“你好”和相同其他请求字段，真实对照确认旧工具名导致400，转换后200且完整结束。

## Decision

Tool ID 与持久历史保持原值，只在 SDK 请求边界转换函数名。原本符合1–64字符 ASCII 语法的名称保留；非法字符改为下划线，截短后的候选与全部合法原名、已分配名称冲突时添加有限长度后缀。收集当前声明和所有历史调用名称，按原 ID 排序分配，声明、assistant 调用和工具结果共享映射；完整返回调用在交给 Core 前还原 ID。不存在的工具仍由原 Core 合同处理，转换不授予工具执行权。

公开转换标记 kite.sdk.messages 升为2，历史快照不改写。转换是每个请求的编码事实，不成为数据库迁移、Provider 能力判断、远端错误后的回退或第二次请求。

## Alternatives considered

- 将 Core 工具全局改成下划线名称：会改变权限、扩展定义、历史与恢复身份，超出传输问题，未采用。
- 仅将点替换成下划线：files.read 与合法 files_read 会碰撞，长名称和中文名称仍不满足约束，未采用。
- 用不透明序号替换所有名称：虽然可逆，但会改变已有合法名称并降低可读性，未采用。
- 只增加无工具的生产连通测试：不能覆盖普通客户端实际发送的默认工具声明，未采用。

## Consequences

[严格 SDK 测试](../../../../packages/ai/test/sdk.test.ts)覆盖带点、合法名碰撞、中文、超长及已退役历史工具，核声明、历史、返回调用和原输入不变；[真实 paired 宿主](../../../../apps/service/test/isolated/configuration.test.ts)以默认八工具完成项目文件读取和带历史的后续模型请求。两项在修复前均失败、修复后通过。原先的模拟服务只证明它实际接受的请求；协议约束必须成为端点断言。

2026-10-16 在 Windows x64／Bun 1.4.2 的本次工具名转换工作树，对 DeepSeek 官方接口的 deepseek-v4-flash 执行恰两次获准对照。八个工具定义来自原失败 Execution，正文仅“你好”，未发送原系统／项目上下文；两份实际请求除 function.name 外完全相同，也均无 reasoning_effort。旧名称含六个带点函数名，138毫秒返回400／invalid_request_error，有限错误分类指向 function/name/tools；转换后非法名称为零，1034毫秒返回200，SDK收到182字节正文、178字节思考内容和完整 finish。只记录状态、计数和固定分类，不记录密钥、原错误或回复正文；两次均没有工具调用，且实验未装配任何执行工具的运行时。

该对照证实此工具名缺陷会被真实服务拒绝，补齐了旧宽松端点的遗漏。它不恢复原事件已丢失的 HTTP 响应，不证明真实文件工具执行、其他模型或其他参数值；原错误被归一化为通用码的既有行为仍在。当前实现与实测范围归[AI owner](../../../../packages/ai/README.md)，普通宿主验收归[Service owner](../../../../apps/service/README.md#native-provider-与下一次模型绑定)。
