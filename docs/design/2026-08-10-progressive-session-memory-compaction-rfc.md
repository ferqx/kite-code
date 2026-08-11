# 渐进式会话记忆压缩 RFC

状态：superseded（由 `2026-08-10-progressive-context-compaction-rfc.md` 取代）
日期：2026-08-10
架构：ADR-0098
取代设计：`2026-08-10-three-tier-context-reduction-complete-rfc.md`
后续设计：`2026-08-10-progressive-context-compaction-rfc.md`

## 摘要

新路线把上下文缩减拆成三个成本和信息损失逐级增加的机制：局部清理旧工具输出、使用会话记忆重建长期
上下文、最后才调用模型生成摘要。原始 transcript 始终保留，三层都只生成模型活动上下文的 projection。

目标不是证明每次摘要都能精确复现旧上下文，而是在安全协议边界内，以最低成本保留继续工作的必要信息。

## 渐进交付模型

最终三级能力分三次独立收敛，不要求首版同时完成：

### 阶段 A：可用压缩基础

```text
有限工具结果预算
  → 局部压缩
  → SessionMemoryProvider = unavailable
  → 单次模型摘要兜底
  → compact boundary + recent window
```

阶段 A 不生成 Session Memory，但已经是一套可独立使用的上下文压缩系统。它交付局部压缩、tool pair/message
边界、最近窗口、附件预处理、模型摘要兜底、boundary 恢复和容量错误。会话记忆接口返回 `unavailable` 是正常
能力状态，不是失败。

### 阶段 B：会话记忆 Shadow

阶段 B 新增独立 Session Memory lifecycle，并保持 `sessionMemoryMode=shadow`：

- 在安全 turn 后生成 bootstrap/incremental memory；
- 持久化、restart、rewind 和 fork 可恢复；
- 计算如果使用 memory 会选择的 recent window 和 token saving；
- 不改变任何 normal Provider payload，不写 active compact boundary；
- `/context` 或本地只读诊断只显示 bounded metadata，正文只通过显式本地 inspection 查看；
- 采集 retention、continuation、延迟、费用和失败 evidence。

阶段 B 即使失败，也只关闭 memory maintenance；阶段 A 的局部压缩和模型摘要继续可用。

### 阶段 C：会话记忆 Live

只有阶段 B 的结构、语义、continuation、恢复、隐私、成本与延迟 Gate 全部通过，才允许显式
`sessionMemoryMode=live`：

- compact orchestrator 优先消费 verified memory；
- memory + recent window 可接纳时不调用摘要 Provider；
- memory 缺失、过期、冲突、tail 过大或最终 admission 失败时进入阶段 A 已有的模型摘要；
- 关闭 live flag 立即回到阶段 A，不删除 transcript、memory candidate 或既有 summary boundary。

三个阶段分别有完成记录和回滚点。阶段 A 完成时只能声明局部压缩与模型摘要可用；阶段 B 只能声明 memory
shadow；阶段 C 才能声明完整三级可用。

## 可选能力接口

压缩 orchestrator 不直接负责生成记忆，只消费以下接口；具体生成由阶段 B 的独立 lifecycle 提供：

```typescript
interface SessionMemoryProviderV1 {
  getVerifiedMemory(input: {
    threadId: string;
    throughMessageId: string;
    projectionPolicyId: string;
  }): SessionMemoryV1 | 'unavailable';
}
```

阶段 A 使用固定的 unavailable provider。阶段 B 的 provider 仍对 normal projection 返回 unavailable，只把候选交给
shadow evaluator。阶段 C 才允许返回 verified memory 给 compact orchestrator。这样 Session Memory 的开发不会
重新阻断基础压缩路径。

## 三级模型

### 第一级：局部压缩

- 候选来自有限白名单，首批覆盖读取、搜索、命令输出、网页读取和成功写入类工具；effectful 工具只清理
  可重建的展示正文，不清理执行结果、错误、receipt 或结构化事实。
- 依据内容大小、距当前 turn 的年龄、最近访问时间和显式保留标记计算资格；当前 turn 永不清理。
- 结果正文替换为稳定、无 locator 的占位符；原正文仍在 transcript/store 中。
- 图片、文档和其他二进制投影使用独立预算，不能复用文本字符阈值。
- 每次应用写入 bounded micro boundary，记录被处理 block identity、压缩前后 token 估算和 policy identity。

### 第二级：会话记忆压缩

#### 记忆不是现有能力

当前仓库没有会话记忆实体。checkpoint summary 只在压缩时生成，Plan、Task、Verification、Authorization 和
Runtime context 是独立权威，也不能被改名为会话记忆。因此第二级需要先交付新的 Session Memory lifecycle，
不能直接复用 checkpoint 或假设记忆已经存在；但它只阻断阶段 B/C，不阻断阶段 A。

#### 内容合同

会话记忆是低权限的长期工作摘要。V1 使用一份规范化 Markdown narrative，固定包含：

- 用户目标、约束与偏好；
- 已确认的架构和实现决定；
- 已完成工作与验证结果；
- 当前失败、阻断和未完成事项；
- 继续工作需要的文件、符号和命令线索。

使用固定章节而不是 JSON/facts ledger：

```markdown
## 目标与约束
## 已确认决定
## 已完成与验证
## 失败与阻断
## 未完成事项
## 继续工作线索
```

缺少内容的章节保留标题并写“无”，避免版本间结构漂移。memory 以 assistant history 注入并使用专用 wrapper
转义，不进入 system prompt。它不能修改 Plan、Verification、授权、工具、Interaction、Skill、Task 或 Runtime
事实；这些继续由当前 Runtime projection 提供。

#### 数据模型

```typescript
interface SessionMemorySourceV1 {
  baseMemoryId?: string;
  baseMemoryContentDigest?: string;
  fromExclusiveMessageId?: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  sourceRevision: number;
  sourceRangeDigest: string;
  sourceProjectionPolicyId: string;
  memoryInputDigest: string;
}

interface SessionMemoryV1 {
  version: 1;
  memoryId: string;
  source: SessionMemorySourceV1;
  content: string;
  contentDigest: string;
  estimatedTokens: number;
  promptContractId: string;
  routeIdentityDigest: string;
  createdAt: string;
}

interface PendingSessionMemoryUpdateV1 {
  memoryUpdateId: string;
  reason: 'prewarm' | 'delta_threshold' | 'manual_maintenance';
  requestedAtRevision: number;
  baseMemoryId?: string;
  source: SessionMemorySourceV1;
  phase: 'requested' | 'dispatch_started';
}

interface SessionMemoryRuntimeStateV1 {
  latestMemory?: SessionMemoryV1;
  activeBoundary?: SessionMemoryCompactBoundaryV1;
  activeBoundaryMemory?: SessionMemoryV1;
  pendingUpdate?: PendingSessionMemoryUpdateV1;
  lastFailure?: SessionMemoryFailureV1;
}
```

`activeBoundaryMemory` 只在 active boundary 尚未引用 `latestMemory` 时单独保留，因此滚动 state 最多保存两份
memory 正文。历史 event 可以重放旧内容，但 active state 不建立无上限 memory history。

#### 生成协议

V1 采用一次模型调用生成完整 memory：

1. 首次生成输入为从会话起点到安全 turn boundary 的 settled transcript prefix；
2. 增量生成始终以上一份 `latestMemory` 为 base，输入为该 memory 加上 `fromExclusiveMessageId` 之后的新
   transcript delta；`baseMemoryId` 和 `baseMemoryContentDigest` 必须同时匹配；
3. delta 使用 `memory_update` purpose 的局部压缩 projection：旧的大工具正文可以清理，但 terminal、错误、
   structured metadata 和最近工具结果保留；图片/文档替换为 bounded marker；
4. 请求无工具、零 SDK retry、有限 input/output reservation，只接受单一 Markdown narrative；
5. `memoryInputDigest` 绑定 base memory 正文、局部压缩后的 delta、prompt contract 和 route identity；candidate
   必须通过固定章节、非空、无 tool call、非 truncation、token 上限、source range/input digest 和 stale
   revision 校验，随后才写 `context.memory_update_completed`。

Session Memory 不是“零模型成本”。其优势是把单次、低优先级的增量生成放在压缩阈值之前，使真正触发
第二级压缩时无需临时调用摘要 Provider。

#### 调度协议

自动 memory maintenance 只在下列条件同时成立时请求：

- turn 已完整结束，所有 tool call、interaction 和 required verification 已结算；
- 当前没有 primary、compaction 或 memory Provider attempt；
- resolved context window 和 output reservation 已知；
- raw/micro projection 达到 prewarm threshold，或上次 memory 后的 delta 达到 token/turn threshold；
- memory cooldown、累计资源预算和 Provider data admission 允许；
- source input 不超过 memory updater 的绝对上限。

V1 不做真正并行后台调用。同一 session 复用 Runtime effect lease：新用户输入在 `dispatch_started` 前到达时取消
maintenance；已经开始的单次 memory attempt 先终结，随后才允许 primary dispatch。这样不新增第二个并发
Provider ownership 模型。

memory failure 不阻断当前或下一 normal request。已 started 但无 terminal 的 attempt 恢复为
`unknown_external_outcome`，同一 update ID 不重放；只有 source boundary 严格推进后才可创建新 update。

#### 更新不等于激活

`context.memory_update_completed` 只推进 `latestMemory`，不立即替换历史。真正使用 memory 时，compact
orchestrator 必须验证：

- memory source range 仍是 immutable transcript 的有效 prefix；
- recent window 起点不晚于 memory coverage 的下一个协议 block，不能产生消息空洞；
- memory 与 recent window 的合计 token 满足最终 input admission；
- preserved tool pairs 和共享 message identity 完整；
- 应用后的绝对 token saving 达到最低收益。

全部通过后，Kernel 才在一个 CAS batch 中写入引用该 memory 的 `compact_boundary` 并激活 projection。

#### 最近窗口选择

触发压缩时，从最后已记忆范围之后向前选择最近窗口。窗口同时满足：

- 可配置的最小 token；
- 可配置的最少文本消息数；
- 可配置的最大 token；
- tool call/result block 完整；
- 共享 message identity 的 thinking/text/tool-use 流式片段完整。

算法从 memory coverage 的下一条消息开始，先纳入全部未记忆 tail，再向前扩展完整协议 block，直到同时达到
最小 token 和最少文本消息；达到最大 token 前停止。若仅未记忆 tail 已超过最大 token，则该 memory 不可用于
第二级，必须先完成新的 memory update 或进入第三级，不能丢弃中间消息。

活动上下文由 `system/runtime context + session memory + full compact boundary + recent window` 组成。这个步骤
本身不调用摘要 Provider。

#### 持久事件与状态转移

```text
settled turn
  → context.memory_update_requested
  → context.memory_dispatch_started
  → context.memory_update_completed | context.memory_update_failed
  → latestMemory（仍未改变 projection）

compact trigger
  → validate latestMemory + recent window
  → context.compaction_completed(boundary.type=memory)
  → activeBoundary + activeBoundaryMemory
```

所有事件都不进入 transcript。`requested` 可在 dispatch 前取消；`dispatch_started` 后无 terminal 不自动重放。
同一个 `memoryUpdateId` 和 `memoryId` replay 幂等，内容或 source identity 冲突则拒绝该 memory candidate。

#### 恢复、rewind、fork 与 reset

- restart/resume：验证 memory content digest、source range digest、covered message/turn 和 boundary 引用；失败时
  丢弃 memory projection并回到 raw/既有 v1 checkpoint，不硬阻断 Runtime；
- rewind：恢复目标 revision 当时可见的 latest memory 和 active boundary，不把未来 memory 带回过去；
- fork：复制 fork cut 已提交的 memory/boundary并重绑定 session-local event identity，正文和 source range不改；
- `/compact reset`：只撤销 active boundary，保留 verified latest memory 供以后重新评估；
- `/clear`：创建新 session，清空 memory、boundary、pending 和 failure；
- 自定义 `/compact`：直接走第三级，结果不回写 canonical Session Memory，避免定制侧重点污染后续自动路径。

#### 隐私与可观测性

memory 正文与 transcript 同级保存在本地 RuntimeStore，但禁止进入 metadata-only session log、telemetry、evidence
artifact 或错误消息。可观测字段只允许 reason、source token bucket、delta token bucket、input/output tokens、
duration、result kind、memory bytes、recent-window bytes 和无值 digest-presence 标记；禁止 path、args、content、
message/call ID 和 digest 值。

#### 质量边界

V1 只能做结构、来源、容量和协议验证，不能在不增加第二次模型调用的情况下证明语义无损。设计明确接受
Session Memory 是 lossy projection，并通过三项措施限制风险：上一份 memory 始终作为增量输入、recent window
保留近期原文、Plan/Verification/Authorization 等关键事实不从 memory 读取。离线资格必须使用长会话 fixture
验证目标、约束、决定、失败、验证结论和下一步的保留率及继续执行成功率；未通过的 route/prompt contract 只能
关闭 Session Memory，回退 raw 或第三级。不得因为章节齐全就宣称语义正确。

### 第三级：模型摘要兜底

仅在以下情况进入：

- 手动压缩携带自定义指令；
- 会话记忆缺失、过期、冲突或无法覆盖安全源范围；
- 局部压缩和会话记忆压缩后仍无法形成可接纳 payload；
- 显式紧急降级策略允许。

摘要前移除或替换大图片、可重新注入附件和不需要重复总结的稳定资源。摘要成功后，在独立预算内重新注入
项目指令、最近读取资源、已激活 Skill 和工具发现摘要。重新注入内容仍需经过 Provider data admission。

摘要请求保持单次、无工具、零 SDK retry、单 Markdown narrative。失败不删除 transcript，不伪造 boundary，
也不自动重放已开始的 Provider attempt。

## Boundary 与恢复

定义两类持久边界：

- `micro_compact_boundary`：记录局部清理的 policy、源范围、候选集合摘要和 token saving；
- `compact_boundary`：记录 `memory | summary | manual` 类型、源范围、最后用户消息、记忆/摘要 identity、
  preserved segment 和压缩前后 token。

恢复器选择最后一个可验证的 `compact_boundary`，加载其对应记忆或摘要，再追加 preserved segment 与 tail。
boundary 或记忆无效时回退到更早的有效 boundary；全部无效时使用原始 transcript，不猜测缺失事实。

## 触发和优先级

```text
每次 normal prepare
  → 应用第一级局部压缩
  → 若未达到压缩阈值，发送 normal payload
  → 若达到阈值且会话记忆可用，应用第二级
  → 若 payload 可接纳，发送 normal payload
  → 否则在策略允许时应用第三级
  → 仍不可接纳则返回明确容量错误
```

手动普通压缩可以优先使用会话记忆；带自定义指令的手动压缩直接进入第三级。通用 HTTP 400/413 不自动
判定为上下文过长；只有本地容量证明或 Provider typed overflow 才允许进入紧急降级。

## 从旧路线迁移

迁移采用“先停写、再换单路径、最后删除兼容读取”的顺序。阶段 A 开始编码前必须先移除或物理隔离旧路线
的所有 producer、scheduler/controller 入口和 qualification runner，禁止新旧两个 compaction orchestrator 同时
存在。对已经可能写入本地 Store 的旧 checkpoint/schema，只保留 bounded read-only normalizer，不能继续产生
新数据；确认没有已发布兼容义务后再删除 reader。

| 旧能力 | 处理 |
| --- | --- |
| L1 有限工具结果预算、verified terminal | 保留 |
| immutable transcript、prepared/final admission | 保留 |
| 旧工具 block 确定性回收 | 改造成第一级局部压缩 |
| checkpoint v1 单叙事摘要 | 保留为第三级兼容格式 |
| checkpoint v2 三段证明 | 阶段 A 前移除 writer/producer；必要时只保留 read-only normalizer |
| `cache_safe_fork:v1` | 阶段 A 前删除生产入口与调用链；持久 identity 只由兼容 reader 识别 |
| route cache evidence registry | 阶段 A 前删除 runner、registry 和 qualification 分支 |
| durable refill guard | 阶段 A 前删除 producer/门禁；如需 cooldown 由新策略重新设计，不复用旧状态机 |
| Store exact CAS/generation fence | 保留 |

## 待评审问题

1. memory prewarm utilization、delta token/turn、cooldown、最大 input/output 的冻结数值；
2. 最近窗口的默认 min/max token 与最少文本消息参数；
3. 可局部清理工具白名单和显式 pin/must-keep 接口；
4. 第三级重新注入文件、Skill 和项目指令的预算分配；
5. 旧 schema v23/checkpoint v2 在尚未发布时直接移除，还是保留一次只读迁移；
6. memory updater 是否允许使用与 primary 不同但 data policy 等价的低成本 route；V1 默认要求同一已接纳 route。

这些问题关闭并完成独立设计评审前，不开始新的功能实现。
