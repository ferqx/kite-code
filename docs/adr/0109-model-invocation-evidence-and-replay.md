# ADR-0109：模型调用证据与严格 Replay

状态：accepted

日期：2026-08-16

决策者：github:@ferqx

相关：ADR-0001、ADR-0021、ADR-0032、ADR-0055、ADR-0056、ADR-0066、ADR-0105、`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

当前 Context Projection 能统一生成模型消息、工具声明与 token estimate，但主 Agent、上下文压缩、
auto review、Verification reviewer 和 Subagent 仍分别进入低层模型调用。`model.requested` 只证明一次
主 Agent 请求已经开始，不能证明 Provider 实际收到的完整语义请求，也不能在项目指令、Skill、
Capability Binding、sandbox 投影或模型参数变化后精确重建历史请求。

Runtime Event 与 reducer 必须继续作为恢复权威；同时，精确请求与响应正文不适合进入 metadata-first
Session Logger 或通用遥测。Kernel event replay 也不能替代 LLM response replay。

## 决策

1. 新增 protocol-first 的 `ModelSurfaceV1`、`ModelInvocationEnvelopeV1`、
   `ModelResponseRecordV1` 与私有 artifact reference。Surface 是 Kite 自有、JSON-safe、
   provider-neutral 的完整语义请求，不持久化 AI SDK 类型、closure 或 credential。
2. Surface 在 provider data admission 和 resource admission 前只编译一次。预算、artifact、Gateway 与
   transport 必须消费同一冻结对象；system 合并、消息、工具声明、generation 参数、single-step stop、
   stream/generate 选择、SDK retry=0、resolved capability 与 provider options 都属于 Surface 身份。
3. `surfaceDigest` 使用版本化、domain-separated 的严格 canonical JSON，只覆盖
   `ModelSurfaceV1`。invocation/thread/turn、Runtime revision、reservation、admission decision、时间、
   PID 和 artifact 路径只进入 envelope，不得污染相同语义请求的 digest。
4. Surface 与 response 存入私有 immutable artifact store；Runtime Event、Session Logger 与遥测只接收
   opaque/keyed reference 和低基数 metadata，不接收 prompt、reasoning、tool arguments 或 response
   正文。artifact 不能直接驱动 Runtime 状态转换。
5. `ModelInvocationGatewayV1` 是 live/record/replay response source、attempt orchestration 与 artifact
   protocol 的唯一生产边界。每次真实 Provider attempt 都必须先持久化 attempt evidence 并等待 Kernel
   acknowledgement；ack 失败时 dispatch 为零。成功 response 只有在 immutable response artifact 和
   terminal event batch 均提交后才能离开 sealed completion handle。
6. replay 只接受严格匹配的 Surface、route identity、adapter replay-owner、catalog revision 与 actor-local
   consumption。miss、corruption、owner mismatch、游标歧义或持久化失败一律 fail closed，绝不回退 live
   Provider，也不宣称 replay 能证明真实模型质量。
7. `primary_agent`、`context_compaction`、`auto_review`、`verification_review`、`subagent` 是封闭 purpose；
   它们与当前 Provider dispatch purpose 保持 protocol 中的一一映射。五类调用最终都必须经过同一 Gateway。
8. 本决策不单独切换 Runtime format epoch。只有计划中的 `CUT-01` 在 Model、Tool Pipeline 与三条 Local
   Provider seam 全部迁移、旧 dispatch composition 全部删除后才能切换 epoch；不存在运行时 legacy fallback。
9. 本决策对 ADR-0105“新增入口须在同一改动替代旧权威”作窄化补充：MS-01 只允许新增尚未接入
   production dispatch 的 protocol/canonical identity scaffolding；MS-03 与 MS-04 必须作为同一模型迁移
   series 接入 Gateway 并删除所有低层 transport 绕过。该例外不允许两个 production 模型入口共存。
10. `core-entry-criteria` 对 Engine 的一般 feature-flag 要求在本 correctness migration 中由“未接线的开发期
    task + differential/no-bypass evidence + CUT-01 单次切换”替代。不得新增能在 Gateway 失败时恢复旧模型
    dispatch 的 runtime flag；`live | record | replay` 只选择 Gateway response source，不选择证据边界。

## 备选方案

- 只保存最终 AI SDK request 或 HTTP body：拒绝。它把 SDK/provider 私有类型变成 Runtime 契约，仍不能
  保证预算和实际 dispatch 消费同一冻结输入。
- 把 prompt/response 写入 Runtime Event 或 Session Logger：拒绝。它扩大恢复状态和日志的正文域，违背
  metadata-first 边界。
- replay miss 时调用 live Provider：拒绝。它让无 key 回归变成非确定性、可能外发正文的旁路。
- 让五类调用各自保存 evidence：拒绝。它保留多条可绕过的模型证据边界。

## 后果

- Model Surface artifact 必然包含模型可见正文，因此其权限、原子写、完整性 key、retention 与 GC 都必须
  独立于 Session Logger，并在后续任务中 fail closed 实现。
- streaming delta 继续是 ephemeral UI 事件；它不成为 response receipt 或恢复状态。
- dispatch 已发生而 response/terminal receipt 未能提交时，恢复只能标记 interrupted/unknown，默认不得
  自动重发 live 请求。
- MS-01 可先纯新增 protocol 和 canonical identity，不改变当前 dispatch；生产切换必须等待全部依赖完成。

## 回滚

CUT-01 前可以撤销尚未合并的 Model Surface 实现，但不得以 feature flag 接回无 evidence dispatch。
CUT-01 后只允许 fail closed；若未来需要兼容公开格式，应新增 ADR、格式版本和显式离线迁移边界。
