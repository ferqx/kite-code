# Agent Note: 显式 Responses 协议与私有 continuation

Status: implemented

## Problem

只有 Chat Completions 的连接不能访问只提供 Responses 的模型。仅替换 endpoint 会丢失 Responses function call 身份和加密推理状态；另建循环则会绕过已有工具授权、取消和定时任务运行边界。

## Decision

在原模型连接上增加显式 `protocol`，旧配置缺省仍为 `chat-completions`；OpenAI/compatible 可选择 `responses`。同一 endpoint 的协议分别形成连接身份，协议错误不回退。继续使用原 Agent Loop，官方 AI SDK OpenAI Responses provider 只负责一次模型传输。

采用 `store:false`，完整 SDK assistant content 作为不透明 continuation，含原 tool call ID、可见 summary 和 encrypted reasoning。只在可安全提交的成功 finish 后（包括长任务的非空纯文本 length，排除截断工具批次与未完成压缩），沿现有私有 ModelOutput Artifact 分段链保存；下一步、多轮、冷恢复和原请求恢复使用它。不新增 SQL 表、不把 encrypted reasoning 塞入用户消息或公开 Inspector。Auto 审核的消息上下文另外投影为纯语义字段，不把私有 continuation 经 JSON 变成普通审核正文；原私有输入和 carrier 的完整绑定核验不变。公开旧审核 Message／Run 配置与 Inspector 按准确原 carrier、初始 sourceIds 和 Store 身份投影，不按文字相似或整个审核 Run 误删普通 steer。绑定摘要包含 endpoint、provider、model、凭据与 headers，另核路由 ID；换连接或账户不回传旧 opaque state。

与[工具名转换](../bug-fix/2026-10-16-compatible-tool-names.md)组合后，Chat Completions 的转换版本保持2，Responses 升为3；私有 continuation envelope 仍为1。回放 assistant tool-call 时按准确 call ID 取原 Core 工具名，再按当前声明和历史的碰撞集合编码；不直接信任旧 wire 名，不改写已存 Artifact 或 encrypted reasoning。缺少原调用对应关系在网络前拒绝；真实 SQLite 冷读和旧 v1 内容均验证该边界。

## Alternatives considered

- 手写 SSE parser：重复官方 SDK 的事件和 finish 处理，增加协议漂移与工具 ID 错配风险，未采用。
- 改用 provider 存储与 previous_response_id：引入服务端状态、保留语义与跨恢复依赖，当前使用完整 stateless 历史。
- 只保存推理文字：summary 不能代替 encrypted reasoning，工具回合续推会丢状态，未采用。
- 给定时任务或 Responses 单独建执行引擎：重复工具授权与生命周期；保留唯一 Agent Loop。
- 将 opaque state 放入普通 assistant content 或公开 execution result：可能向界面和日志暴露私有 Provider 状态；复用已有 Artifact port。

## Consequences

会话内的协议切换另受[会话协议决定](2026-10-24-session-model-protocol.md)约束：首次实际 Run 后保持 Responses 或 Chat Completions，同协议仍可更换模型；本篇传输、私有 continuation 与不同绑定的隔离理由保持。

本机 ChatGPT 登录来源已由[Codex 认证决定](2026-10-24-local-codex-authentication.md)扩展；本篇普通 OpenAI/compatible 连接的 API 凭据、显式协议、唯一工具循环与私有 continuation 理由继续适用。

自定义 Runtime 使用 Responses 时必须提供 Artifact port；普通 Service 已提供。协议与转换版本成为可审计的非秘密 metadata，私有绑定哈希不携带原始连接数据。Responses SDK warning details 可能包含历史正文，因此输出前替换成通用诊断。

实现与测试入口见 [AI owner](../../../../packages/ai/README.md)、[模型配置手册](../../../../docs/handbook/features/models-and-configuration.md)、[输出存储](../../../../packages/agent/src/model-output/README.md)。本地 HTTP mock 覆盖真实 Responses wire、工具循环和定时任务；不构成生产付费模型或第三方 provider 兼容性认证。没有增加 OAuth 或 ChatGPT 账号登录。
