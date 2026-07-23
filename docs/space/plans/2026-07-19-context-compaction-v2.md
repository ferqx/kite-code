# 上下文自动压缩与手动压缩优化方案 V2

创建日期：2026-07-19
状态：draft
优先级：P0
依赖：无
取代：`docs/space/plans/2026-06-28-context-compaction.md`（archived，M0/M1 已实施，M2 延后）
关联 ADR：`docs/adr/0021-context-compaction-checkpoint.md`（proposed）

> **Review 注记（2026-07-19，对照当前 `compact` 分支代码）**
>
> 本方案对当前代码的诊断已被验证为准确：
> - `src/core/model/compaction.ts` 的 `shouldCompact()` 确实没有接入生产模型调用路径（model-controller 未传递 `contextBudget`，`contextBudget` 始终为 `undefined`）。
> - 当前 M1 在 `BaseMessage[]` 层执行（`src/core/model/context.ts:273-276`），与方案 3.2 节描述一致。
> - ToolMessage content 的 JSON 反向解析（`extractPath`、`extractTotalLines`、`extractCommand`）确认存在，方案 3.1 和 5.2 节描述准确。
> - `ContextBudget` 定义在 `src/core/types.ts:117`，字段均为 optional，方案 8.1 节的问题描述成立。
> - `RuntimeEffect` 和 `RuntimeEvent` 中均无 compaction 相关类型，方案 14 节的 event/effect 新增是必要的。
> - `FeatureFlags`（`src/core/config/features.ts`）中无 compaction 开关，需按方案 16 节新增。
> - `estimateTokens()` 使用 `gpt-tokenizer` 的 cl100k_base 编码（`src/core/token-counter.ts`），与方案 8.3 节的估算需求兼容，但方案要求覆盖 system/tool schema/runtime 的分项统计，当前实现仅对消息内容计数。
> - `foldOneToolResult()` 中 `path ?? 'unknown'` 会在无 path 时产生 "Read unknown"、"Searched unknown"，方案 PR1 的 P0 修复清单确认了此问题。
>
> 本方案与 `docs/active/plan-state-reminder.md` 的动态投影原则一致：摘要不放入稳定 system prompt 前缀，plan/authorization/mode 始终从 RuntimeState 投影。

---

## 1. 文档结论

Kite Code 的压缩机制应重构为一套统一的、事件驱动的上下文治理系统：

- **M0：TUI 展示聚合**，仅优化界面，不参与模型上下文。
- **M1：确定性工具输出压缩**，在模型上下文投影阶段执行，不修改原始 transcript。
- **M2：结构化对话摘要**，由自动阈值或用户手动命令触发，生成可持久化的 compaction checkpoint。
- 自动压缩和手动压缩必须复用同一个核心服务，只允许触发来源不同。
- 原始 RuntimeEvent 和 transcript 永远保留，压缩只影响模型上下文投影，不能成为不可逆的数据删除操作。

当前生产路径只接入了 M1；`shouldCompact()`、token 阈值和 M2 摘要尚未进入模型调用流程。模型控制器目前完成上下文构建后直接调用模型，没有压缩预检。

本方案的最终目标是：

> 长会话不会因上下文耗尽中断；压缩不会破坏 tool-call 配对、文件事实、计划状态、失败信息和用户约束；任何压缩结果都可以重放、审计、失效和回退。

---

## 2. 目标与非目标

### 2.1 目标

1. 支持自动软阈值和硬阈值压缩。
2. 支持 `/compact` 手动压缩。
3. 保证 assistant tool call 与 ToolMessage 一一配对。
4. 保留用户目标、约束、修改事实、失败结论和待办事项。
5. 与 RuntimeEvent、reducer、snapshot 和 effect lease 架构一致。
6. 支持 session restore、event replay 和并发结果失效。
7. 提供压缩前后 token、覆盖范围、压缩率和失败原因。
8. 不破坏 provider prompt cache 的稳定系统前缀。
9. 对未知模型上下文窗口采取保守、可诊断的行为。
10. 支持逐步灰度，而不是一次替换全部上下文逻辑。

### 2.2 非目标

本次不负责：

- 压缩 RuntimeEvent 日志或数据库文件。
- 删除历史 transcript。
- 使用摘要替代 RuntimeState 中的 plan、authorization、interaction 或 tool lifecycle。
- 在压缩过程中自动修改用户工作区。
- 让 M0 TUI 聚合结果成为模型上下文的数据源。

---

## 3. 当前问题

### 3.1 生产 transcript 缺少压缩需要的元数据

当前 `TranscriptMessage.kind === 'tool'` 只保存：

```ts
{
  kind: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
}
```

没有保存 args、path、command、totalLines、effectClass 或结构化结果。

工具完成时，reducer 也只把 stdout 或 stderr 写入 transcript。

因此当前 M1 从 ToolMessage content 反向解析 path 和 command 的做法不可靠。

> **Review 确认**：`src/core/model/compaction.ts` 中 `extractPath()`、`extractTotalLines()`、`extractCommand()` 均通过 `JSON.parse(content)` 反向解析，方案诊断准确。

### 3.2 压缩发生在错误的数据层

当前流程是在 LangChain `BaseMessage[]` 上执行：

```text
sanitizeToolCallPairs
→ reorderInterleavedMessages
→ microCompactToolOutputs
→ foldToolOutputs
→ provider messages
```

其中 M1 每次构建上下文时都会运行。

问题是：

- LangChain message 是 provider 边界格式，不应承担领域级压缩。
- ToolMessage content 是展示给模型的正文，不应同时充当结构化元数据。
- 多 tool-call AIMessage 很容易被错误地作为一个压缩块处理。
- 压缩后没有再次进行严格 tool-pair 校验。

> **Review 确认**：`src/core/model/context.ts:267-276` 调用顺序与此描述一致。

### 3.3 自动压缩未接入

现有 `estimateTokens()` 和 `shouldCompact()` 只是孤立工具函数。

生产模型调用路径没有：

- 解析模型 context window；
- 计算完整请求 token；
- 判断 soft/hard threshold；
- 触发摘要 effect；
- 注入 compaction checkpoint；
- 捕获 context overflow 后恢复。

> **Review 确认**：`model-controller.ts` 调用 `prepareModelContext()` 时未传递 `contextBudget` 参数。

### 3.4 手动压缩未实现

Slash command 定义中没有 `/compact`。命令解析器也没有对应 action。

### 3.5 模型预算来源分散

配置系统已经允许模型条目包含 `contextWindow`。

但模型控制器又单独读取 `modelKwargs.contextWindowTokens` 用于 capability disclosure。

需要建立唯一的模型能力解析层，避免 capability disclosure、context compaction 和模型调用分别使用不同预算。

---

## 4. 目标架构

```text
                    ┌──────────────────────────────┐
                    │ Immutable RuntimeEvent Log   │
                    └──────────────┬───────────────┘
                                   │ reduce/replay
                    ┌──────────────▼───────────────┐
                    │ RuntimeState                 │
                    │ - transcript                 │
                    │ - tools                      │
                    │ - planning                   │
                    │ - interactions               │
                    │ - context checkpoints        │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ Context Projection V2        │
                    │ 1. canonical frames          │
                    │ 2. checkpoint + live tail    │
                    │ 3. M1 deterministic folding  │
                    │ 4. runtime state injection   │
                    │ 5. provider serialization    │
                    │ 6. token estimation          │
                    └───────┬──────────────┬───────┘
                            │              │
                     within budget     over threshold
                            │              │
                    ┌───────▼──────┐ ┌────▼─────────────┐
                    │ call_model   │ │ compact_context  │
                    └──────────────┘ └────┬─────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │ Structured Summary  │
                              │ + deterministic     │
                              │   fact ledger       │
                              └──────────────────────┘
```

核心原则：

1. 压缩发生在 provider-neutral context frame 层。
2. LangChain `BaseMessage[]` 只在最后一步生成。
3. RuntimeState 是运行状态的权威来源。
4. summary 只描述历史，不管理当前运行状态。
5. M1 是临时投影；M2 checkpoint 是持久化投影。
6. 自动和手动压缩共用 `compact_context` effect。

> **架构一致性检查**：此架构与 `docs/active/six-concept-runtime-architecture.md` 的 State → Effect → Event → State 循环一致。新增 `compact_context` effect 和 compaction 事件属于正常的 effect/event 扩展。

---

## 5. 数据模型优化

### 5.1 TranscriptMessage 增强

建议为所有 transcript message 增加统一元数据：

```ts
interface TranscriptMessageMeta {
  messageId: string;
  turnId: string;
  ordinal: number;
  createdAt: string;
}
```

新的 tool message：

```ts
interface TranscriptToolMessage extends TranscriptMessageMeta {
  kind: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;

  resultMeta?: {
    path?: string;
    totalLines?: number;
    command?: string;
    intent?: string;
    matchCount?: number;
    truncated?: boolean;
    contentDigest?: string;
    resourceRevision?: string;
  };
}
```

工具参数仍以 `ToolCallRecord.args` 为权威值，不必在 transcript 重复保存完整参数。

在构建上下文时，通过 `toolCallId` 联结：

```text
TranscriptToolMessage
        +
RuntimeState.tools.calls[toolCallId]
        =
CanonicalToolFrame
```

### 5.2 ToolCallRecord 增强

```ts
interface ToolCallResult {
  ok: boolean;
  summary: string;
  exitCode?: number;

  resultMeta?: {
    path?: string;
    totalLines?: number;
    command?: string;
    intent?: string;
    matchCount?: number;
    contentDigest?: string;
    workspaceMutationScope?: string[];
  };
}
```

这样：

- tool metadata 不依赖 stdout JSON；
- transcript、压缩器和 TUI 可以共享一致元数据；
- session restore 后仍可正确执行 M1。

### 5.3 ContextRuntimeState

在 RuntimeState 中加入：

```ts
interface ContextRuntimeState {
  activeCheckpoint?: ContextCompactionCheckpoint;
  pendingCompaction?: PendingContextCompaction;
  lastFailure?: ContextCompactionFailure;
  history: ContextCompactionHistoryEntry[];
}
```

```ts
interface ContextCompactionCheckpoint {
  compactionId: string;
  version: 1;

  sourceRevision: number;
  sourceDigest: string;

  coveredThroughMessageId: string;
  coveredThroughTurnId: string;

  summary: StructuredContextSummaryV1;

  inputTokensBefore: number;
  inputTokensAfter: number;
  targetTokens: number;

  reason: 'manual' | 'auto_soft' | 'auto_hard' | 'overflow_recovery';
  createdAt: string;
}
```

Runtime schema version 需要递增，并提供旧 snapshot 的 migration 默认值：

```ts
context: {
  history: []
}
```

---

## 6. Canonical Context Frame

新增 provider-neutral 类型：

```ts
type ContextFrame =
  | UserFrame
  | AssistantFrame
  | ToolCallBlockFrame
  | RuntimeFrame
  | CompactionSummaryFrame;
```

多工具调用必须保持为一个完整 block：

```ts
interface ToolCallBlockFrame {
  kind: 'tool_block';
  assistantMessageId: string;
  assistantContent?: string;

  calls: Array<{
    id: string;
    name: string;
    args: unknown;
    result: {
      content: string;
      ok: boolean;
      resultMeta?: ToolResultMeta;
    };
  }>;
}
```

严格规则：

- 一个 tool call 必须有且只有一个结果。
- 未完成 block 不允许进入 M2 可压缩区域。
- 不得把多个 ToolMessage 合并为一个 ToolMessage。
- M1 只能替换各自 result 的 content。
- provider 序列化完成后必须运行只读 validator。
- validator 失败应阻止模型调用，不再尝试自动"猜测修复"。

---

## 7. M1 确定性压缩方案

### 7.1 定位

M1：

- 不调用模型；
- 不修改 RuntimeState；
- 不修改 transcript；
- 每次 context projection 时幂等执行；
- 只处理 settled 历史区域；
- 最新活跃尾部保持完整。

### 7.2 窗口单位

废弃"最近 N 条消息"的保护方式，改为：

```ts
recentTurns: number
```

原因：

- 消息数可能切开 assistant/tool block；
- 单个模型回复可能包含多个 tool calls；
- turn 是更稳定的语义边界。

建议初始默认：

```json
{
  "recentTurns": 3
}
```

### 7.3 工具分类

#### 可压缩

- `read_file`
- `search_content`
- `search_files`
- `read_mcp_resource`
- 明确标记为 read-only inspect 的 shell 搜索
- 可证明无副作用的动态 MCP 工具

#### 禁止压缩

- `edit_file`
- `write_file`
- `apply_patch`
- 任意可能修改 workspace 的 shell
- `ask_user`
- plan 提交和审批工具
- verification 工具
- task/subagent 最终结果
- 所有失败结果，除非完整错误信息仍被保留
- effectClass 未知的工具

### 7.4 read_file 压缩规则

不要保留"第一次读取"，应保留：

> 每个资源版本最近一次完整、成功、可信的观察。

折叠摘要示例：

```json
{
  "_folded": true,
  "tool": "read_file",
  "path": "src/core/model/context.ts",
  "totalLines": 348,
  "contentDigest": "sha256:...",
  "note": "Earlier read omitted; a newer full observation of the same resource version is retained."
}
```

资源失效条件：

- edit/write/apply_patch 修改该路径；
- shell 或 MCP 声明可能修改该路径；
- git checkout/reset/rebase；
- codegen/build 可能重写文件；
- 外部修改 revision 变化；
- 无法确定 mutation scope。

若无法精确判断影响路径，标记整个 workspace observation set 为 stale。

### 7.5 搜索结果压缩规则

不能只保留 query。

最低保留：

```ts
{
  query: string;
  scope?: string;
  matchCount: number;
  topMatches: string[];
  truncated: boolean;
  resultDigest: string;
}
```

示例：

```json
{
  "_folded": true,
  "tool": "search_content",
  "query": "shouldCompact",
  "matchCount": 4,
  "topMatches": [
    "src/core/model/compaction.ts:207",
    "tests/context.test.ts:..."
  ],
  "truncated": false
}
```

### 7.6 重复调用微压缩

只有同时满足以下条件才判定结果重复：

```text
tool name 相同
+ normalized args digest 相同
+ result digest 相同
+ effectClass 为 read_only
+ 中间没有资源失效事件
+ 调用属于同一个连续 tool-run
```

即使压缩，每个调用仍保留自己的 ToolMessage：

```json
{
  "_compacted": true,
  "sameAsToolCallId": "call-001",
  "resultDigest": "sha256:..."
}
```

不能再使用"以第一个 ToolMessage 代替整个 block"的方式。

### 7.7 错误保护

失败结果必须至少保留：

- error kind；
- message；
- retryable；
- modelFixable；
- next step；
- tool name 和关键参数；
- 是否产生部分副作用。

任何失败结论都应进入 M2 的 mandatory facts。

---

## 8. Token Budget 统一设计

### 8.1 ResolvedModelCapabilities

新增统一能力对象：

```ts
interface ResolvedModelCapabilities {
  providerName: string;
  modelName: string;

  contextWindowTokens?: number;
  maxOutputTokens?: number;

  tokenizerFamily?: string;
  supportsUsageMetadata: boolean;
  supportsPromptCache: boolean;
}
```

解析优先级：

1. 模型条目显式配置。
2. 内置模型目录。
3. provider adapter 返回的模型元数据。
4. `modelKwargs` 兼容字段。
5. 无法确定时标记 unknown，而不是假设一个很大的默认值。

`capability disclosure` 和 `context compaction` 必须使用同一个 resolved object。

### 8.2 可用输入预算

```ts
usableInputTokens =
  contextWindowTokens
  - reservedOutputTokens
  - providerSafetyMarginTokens
```

`reservedOutputTokens` 应优先使用：

1. 请求中的 max output tokens；
2. 模型配置中的 maxOutputTokens；
3. provider 默认值；
4. 保守 fallback。

不要继续只使用固定的 `min(6%, 16K)` 作为唯一依据。

### 8.3 Token 构成

估算必须覆盖：

```text
static system prompt
+ cacheable runtime context
+ active skill instructions
+ capability/tool schemas
+ checkpoint summary
+ transcript live tail
+ runtime mode snapshot
+ plan reminder
+ provider message framing
```

返回分项统计：

```ts
interface ContextTokenEstimate {
  systemTokens: number;
  toolSchemaTokens: number;
  transcriptTokens: number;
  summaryTokens: number;
  dynamicRuntimeTokens: number;
  framingTokens: number;
  totalInputTokens: number;
}
```

### 8.4 推荐阈值

初始建议：

```json
{
  "softRatio": 0.72,
  "hardRatio": 0.88,
  "targetRatio": 0.55,
  "minimumReductionRatio": 0.15
}
```

含义：

- soft：允许继续执行，但优先创建 checkpoint。
- hard：模型调用前必须完成压缩。
- target：压缩后期望降至可用输入预算的 55%。
- minimumReduction：新摘要至少带来 15% 减少，否则不替换旧 checkpoint。

这些数值应通过真实会话 telemetry 调整。

---

## 9. 自动压缩流程

### 9.1 模型调用预检

`call_model` effect 执行时：

```text
1. 构建 checkpoint + live tail
2. 执行 M1
3. 构建完整工具 schema 和动态上下文
4. 估算 token
5. 计算 compaction decision
```

返回：

```ts
type ContextPreflightDecision =
  | { action: 'invoke'; prepared: PreparedContext }
  | {
      action: 'request_compaction';
      reason: 'auto_soft' | 'auto_hard';
      estimate: ContextTokenEstimate;
    };
```

当需要压缩时，model controller 不调用 provider，而是返回：

```ts
context.compaction_requested
```

然后 scheduler 在下一轮返回：

```ts
{ type: 'compact_context', compactionId }
```

### 9.2 自动触发条件

#### Soft

满足以下条件才触发：

- 超过 soft threshold；
- 没有 pending compaction；
- 当前处于安全切分点；
- 距离上次压缩超过最小 turn cooldown；
- 预计可获得足够 token 收益。

#### Hard

超过 hard threshold 时：

- 必须触发；
- 忽略普通 cooldown；
- 仍然不能切开未完成工具或交互；
- 若当前不是安全点，先结束当前确定性 effect，禁止再发起新的 model call。

### 9.3 Provider overflow 恢复

即使本地估算未超限，provider 仍可能返回 context overflow。

处理顺序：

```text
provider context overflow
→ context.compaction_requested(reason=overflow_recovery)
→ compact_context
→ 重新构建和估算
→ 最多重试一次原模型请求
```

不得把 context overflow 当作普通 transient retry 原样重试。

---

## 10. 手动压缩机制

### 10.1 命令设计

```text
/compact
/compact preview
/compact status
/compact force
/compact reset
```

#### `/compact`

立即请求正常手动压缩。

#### `/compact preview`

只计算：

- 当前 token；
- M1 后 token；
- 可压缩历史范围；
- 预计 M2 后范围；
- 是否处于安全切分点。

不产生事件，不修改状态。

#### `/compact status`

显示：

- context window；
- 当前估算；
- active checkpoint；
- checkpoint 覆盖范围；
- 压缩前后 token；
- 上次失败；
- 当前是否可以压缩。

#### `/compact force`

跳过 soft threshold 和 cooldown，但不跳过：

- tool-pair 完整性；
- interaction barrier；
- effect lease；
- summary schema 校验；
- mandatory facts 校验。

#### `/compact reset`

使 active checkpoint 失效，重新使用原始 transcript。

原始 transcript 没有被删除，因此 reset 是安全操作。若 reset 后预计超出 hard threshold，应提示用户无法继续调用模型，直到重新压缩或开启新 session。

### 10.2 手动请求排队

用户执行 `/compact` 时若存在：

- running/queued tool；
- awaiting approval；
- awaiting user input；
- awaiting plan review；
- provider recovery interaction；

则记录 pending manual request，并显示：

```text
Compaction queued; it will run after the current interaction reaches a settled boundary.
```

不能在用户输入 barrier 中直接启动另一个模型摘要请求。

### 10.3 TUI 接入

修改：

- `useSlashSuggestions.ts`
- `useSlashCommand.ts`
- TUI runtime host callback
- help panel
- status line

建议增加 reducer action：

```ts
{ type: 'REQUEST_CONTEXT_COMPACTION'; mode: 'normal' | 'force' }
```

该 action 最终必须进入 Kernel/RuntimeEvent，不能只修改 TUI 本地状态。

---

## 11. M2 结构化摘要

### 11.1 混合摘要模式

不要把所有事实提取完全交给模型。

采用：

```text
Deterministic Fact Ledger
+
Compactable Historical Messages
→ Summary Model
→ StructuredContextSummaryV1
```

#### Deterministic Fact Ledger

从 RuntimeState 和事件结构提取：

- 用户目标和明确约束；
- 成功的文件修改；
- side-effecting capability 结果；
- 所有失败和拒绝；
- verification 结果；
- plan 文档引用；
- 最近可靠资源观察；
- 未完成问题；
- summary 必须覆盖的 fact IDs。

模型负责压缩叙述，不负责决定哪些事实可以丢失。

### 11.2 Summary Schema

```ts
interface StructuredContextSummaryV1 {
  objective: string;

  userConstraints: Array<{
    factId: string;
    text: string;
  }>;

  decisions: Array<{
    factId?: string;
    decision: string;
    rationale?: string;
  }>;

  completedWork: Array<{
    factId: string;
    path?: string;
    summary: string;
    evidenceMessageIds: string[];
  }>;

  observations: Array<{
    factId?: string;
    resource: string;
    revision?: string;
    digest?: string;
    keyFacts: string[];
  }>;

  failures: Array<{
    factId: string;
    operation: string;
    error: string;
    consequence: string;
  }>;

  pendingWork: Array<{
    text: string;
    blockedBy?: string;
  }>;

  unresolvedQuestions: string[];

  recentUserIntent: string;

  provenance: {
    firstMessageId: string;
    lastMessageId: string;
    sourceDigest: string;
    mandatoryFactIds: string[];
  };
}
```

### 11.3 不应写入摘要的权威状态

以下内容必须继续动态投影自 RuntimeState：

- 当前 planning lifecycle；
- 当前 plan version；
- 当前 interaction mode；
- authorization；
- active/pending tools；
- capability bindings；
- skill frames；
- verification 当前状态；
- task active/completed 状态。

摘要可以描述历史决定，但不能成为这些状态的事实来源。

> **与 `plan-state-reminder.md` 的一致性检查**：此设计符合 `docs/active/plan-state-reminder.md` 的要求——plan、mode、authorization 等高频动态事实继续由 RuntimeState 投影到会话尾部，不写入静态前缀或摘要。

### 11.4 摘要模型配置

默认使用当前主模型，但：

- 不绑定任何工具；
- temperature 使用确定性设置；
- 限制最大输出；
- 使用 JSON/schema structured output；
- 支持独立配置低成本 summary model；
- summary model 的 context window 必须足以处理待压缩区域。

建议配置：

```json
{
  "compaction": {
    "summaryProvider": null,
    "summaryModel": null,
    "maxSummaryTokens": 6000
  }
}
```

`null` 表示复用当前模型。

### 11.5 校验流程

```text
模型返回
→ JSON 解析
→ Zod schema 校验
→ provenance 校验
→ mandatory fact IDs 完整性校验
→ message coverage 校验
→ token gain 校验
→ 写入 completed event
```

失败时允许一次 schema repair。

不能通过校验则：

- soft：记录失败，继续使用未压缩上下文；
- hard：进入 chunked compaction；
- chunked compaction 仍失败：fail closed，向用户显示明确错误。

---

## 12. Chunked Compaction

当历史前缀无法在一次 summary 请求中处理时：

```text
历史 settled prefix
→ 按完整 turn/tool block 分块
→ 每块生成 StructuredChunkSummary
→ 合并 chunk summaries + fact ledger
→ 生成最终 StructuredContextSummaryV1
```

规则：

- 按 token 分块，不能按字符数粗切；
- 不切 assistant/tool block；
- 每个 chunk 有 source digest；
- merge 阶段必须携带所有 mandatory fact IDs；
- chunk summary 只作为中间数据，不成为 active checkpoint；
- 只有最终 summary 校验成功才产生 completed event。

---

## 13. 安全切分点

可压缩前缀必须满足：

1. 所有 tool calls 已终态。
2. assistant tool call 和 ToolMessage 完整配对。
3. 不包含 queued、approved 或 running tool。
4. 不包含当前等待中的用户交互。
5. 不切开当前 turn。
6. 不覆盖最新用户请求。
7. 保留最近 `recentTurns`。
8. 保留所有未解决失败附近的必要上下文。
9. 保留 active task 所需的最新证据。
10. coveredThroughMessageId 必须存在于当前 source revision。

建议增加：

```ts
findSafeCompactionBoundary(state, options)
```

返回：

```ts
{
  eligible: boolean;
  reason?: string;
  firstMessageId?: string;
  lastMessageId?: string;
  protectedMessageIds: string[];
}
```

---

## 14. RuntimeEvent 与 Effect

### 14.1 新增事件

```ts
ContextCompactionRequestedEvent
ContextCompactionCompletedEvent
ContextCompactionFailedEvent
ContextCompactionResetEvent
```

#### Requested

```ts
{
  type: 'context.compaction_requested';
  compactionId: string;
  reason: 'manual' | 'auto_soft' | 'auto_hard' | 'overflow_recovery';
  requestedAtRevision: number;
  requestedAtTurnId: string;
  force: boolean;
  estimate: ContextTokenEstimate;
}
```

#### Completed

```ts
{
  type: 'context.compaction_completed';
  compactionId: string;
  sourceRevision: number;
  checkpoint: ContextCompactionCheckpoint;
}
```

#### Failed

```ts
{
  type: 'context.compaction_failed';
  compactionId: string;
  sourceRevision: number;
  errorKind:
    | 'unsafe_boundary'
    | 'summary_model_failed'
    | 'invalid_schema'
    | 'missing_mandatory_facts'
    | 'insufficient_reduction'
    | 'stale_source';
  message: string;
  retryable: boolean;
}
```

#### Reset

```ts
{
  type: 'context.compaction_reset';
  checkpointId: string;
  reason: 'manual';
}
```

### 14.2 新增 effect

```ts
| {
    type: 'compact_context';
    compactionId: string;
  }
```

### 14.3 Scheduler 优先级

```text
recovery block
→ external interaction
→ runnable tools
→ verification
→ emit final
→ pending context compaction
→ call model
```

自动预检产生 requested event 后，下一次 scheduler 选择 `compact_context`。

### 14.4 并发与 stale result

现有 Kernel 已经提供：

- 单 runner lease；
- effect expectedRevision；
- stale result rejection；
- 原子 event + snapshot 持久化。

压缩必须复用该机制。

流程：

```text
begin compact_context effect
→ 捕获 expectedRevision
→ 调用 summary model
→ 返回 completed/failed events
→ applyEffectResult
```

若摘要生成期间收到新事件：

- applyEffectResult 返回 false；
- 摘要结果丢弃；
- 不写 checkpoint；
- scheduler 基于新 revision 重新计算。

不要自行实现第二套锁或并发版本号。

---

## 15. Context Projection V2

建议将 `prepareModelContext()` 拆成：

```ts
resolveContextSource()
buildCanonicalFrames()
applyActiveCheckpoint()
applyDeterministicCompaction()
buildRuntimeMessages()
serializeProviderMessages()
estimatePreparedContext()
validateProviderMessageSequence()
```

返回：

```ts
interface PreparedModelContext {
  messages: BaseMessage[];

  tokenEstimate: ContextTokenEstimate;

  source: {
    checkpointId?: string;
    liveTailFirstMessageId?: string;
    liveTailLastMessageId?: string;
  };

  diagnostics: {
    foldedToolResults: number;
    protectedTurns: number;
    toolPairsValid: boolean;
  };
}
```

最终消息顺序：

```text
1. stable system prompt
2. cacheable workspace context
3. active compaction summary
4. uncompacted live transcript tail
5. runtime mode snapshot
6. active plan reminder
```

摘要属于动态历史消息，不放入稳定 system prompt，以避免每次压缩破坏整个缓存前缀。

> **与现有实现的对照**：当前 `prepareModelContext()` 产出的 `PreparedModelContext` 仅有 `messages` 字段。方案新增的 `tokenEstimate`、`source`、`diagnostics` 字段是合理扩展，不改变调用方的消息消费路径。

---

## 16. 配置方案

新增正式 schema：

```json
{
  "compaction": {
    "enabled": true,
    "automatic": true,
    "manual": true,

    "softRatio": 0.72,
    "hardRatio": 0.88,
    "targetRatio": 0.55,

    "recentTurns": 3,
    "minimumReductionRatio": 0.15,
    "cooldownTurns": 2,

    "maxSummaryTokens": 6000,
    "summaryProvider": null,
    "summaryModel": null
  }
}
```

模型条目正式化：

```json
{
  "name": "example-model",
  "default": true,
  "contextWindow": 128000,
  "maxOutputTokens": 8192
}
```

特性开关：

```ts
contextCompactionV2: boolean;
contextCompactionAutoV1: boolean;
contextCompactionManualV1: boolean;
```

建议：

- 第一阶段只开 `contextCompactionV2` 和安全 M1；
- 自动 M2 单独灰度；
- 手动 `/compact` 可先于自动 M2 开放；
- 老 M1 代码在 V2 稳定后删除。

---

## 17. 可观测性

### 17.1 指标

记录：

```text
context_estimated_tokens
context_usable_tokens
context_utilization_ratio
m1_tokens_before
m1_tokens_after
m1_folded_result_count
compaction_requested_total
compaction_completed_total
compaction_failed_total
compaction_duration_ms
compaction_tokens_before
compaction_tokens_after
compaction_reduction_ratio
context_overflow_recovery_total
checkpoint_age_turns
```

### 17.2 TUI

StatsLine 建议展示：

```text
Context 84K / 128K · 66% · compacted 31%
```

压缩事件提示：

```text
Compacted 47 earlier messages: 91K → 42K tokens.
```

失败提示：

```text
Context compaction failed: summary omitted required file mutation facts.
The original conversation was preserved.
```

### 17.3 日志安全

日志中只写：

- compaction id；
- source digest；
- message ID 范围；
- token stats；
- error kind。

不要默认写 summary 正文或用户文件内容。

---

## 18. 测试方案

### 18.1 单元测试

#### Canonical frame

- 单 tool call 配对。
- 多 tool call 配对。
- interleaved user message。
- orphan assistant call。
- orphan tool result。
- cancelled/rejected/failed 工具。

#### M1

- read_file 最新完整观察保留。
- read after edit 保留。
- shell 修改导致 observation invalidation。
- MCP 修改导致 observation invalidation。
- 同 args 不同 result 不折叠。
- 同 args 同 digest 正确折叠。
- 非连续调用不作为同一 run。
- 搜索结果保留 top matches。
- 错误信息不丢失。
- M1 幂等。
- M1 后 token 不增加。

#### Token budget

- system/tool schema/runtime 全部计入。
- output reserve 正确扣除。
- 128K、1M 和未知窗口。
- capability disclosure 与 compaction 使用同一预算。

#### Summary

- schema validation。
- mandatory fact coverage。
- provenance coverage。
- insufficient reduction。
- chunk merge。
- invalid model JSON repair。

### 18.2 真实数据链路测试

必须增加当前测试缺失的完整链路：

```text
RuntimeEvent
→ reduceRuntimeState
→ RuntimeState
→ canonical frames
→ M1
→ provider messages
→ pairing validator
```

不能继续只手工构造与生产格式不同的 ToolMessage。

### 18.3 集成测试

- soft 自动压缩。
- hard 自动压缩。
- `/compact`。
- `/compact force`。
- `/compact reset`。
- active interaction 时排队。
- summary model 失败。
- stale revision 丢弃。
- 请求事件落盘后进程崩溃。
- completed event 后进程崩溃。
- session restore 使用相同 checkpoint。
- provider overflow 后恢复。
- checkpoint + 新 tail 再次压缩。
- 模型切换到更小 context window 后立即重评估。

### 18.4 属性测试

随机生成 transcript，验证：

```text
所有 provider tool_call 都有且只有一个结果
消息顺序保持
protected turn 不变
M1 幂等
M1 token 不增加
checkpoint 覆盖区间连续
checkpoint source digest 可重算
任何失败或 mutation mandatory fact 不丢失
```

### 18.5 E2E

构造长会话：

1. 连续读取和搜索多个文件。
2. 修改部分文件。
3. 产生一次失败。
4. 创建并执行 plan。
5. 达到 soft threshold。
6. 验证自动 checkpoint。
7. 重启 session。
8. 继续执行。
9. 手动 `/compact`。
10. 验证模型仍能准确说明已修改文件、失败原因和下一步。

---

## 19. 实施阶段与 PR 顺序

### PR 1：立即修复 P0

- 禁止旧 micro compaction 处理多 tool-call AIMessage。
- 压缩后增加 pairing validator。
- 暂时关闭无法获得结构化 metadata 的 read/search folding。
- 增加生产形态测试。

验收：

- 不再产生 orphan ToolMessage。
- 不再出现 `Read unknown`、`Searched unknown`。

### PR 2：Canonical Context Frame

新增：

- `context-frame.ts`
- `context-frame-builder.ts`
- tool block normalization
- provider serializer
- pairing validator

把 LangChain message 转换移动到最后一步。

### PR 3：结构化工具结果

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

修改：

- `runtime/state.ts`
- `runtime/events.ts`
- `runtime/reducer.ts`
- tool controller/tool runner
- snapshot migration

补充 tool result metadata 和 turn/message identity。

### PR 4：M1 V2

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- resource observation tracking；
- deterministic folding；
- search result summaries；
- result digest；
- mutation invalidation；
- recent turn protection。

旧 `microCompactToolOutputs()` 和 `foldToolOutputs()` 标记 deprecated。

### PR 5：统一模型预算

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- `ResolvedModelCapabilities`
- formal model contextWindow/maxOutputTokens schema
- full request estimator
- context preflight
- utilization telemetry

### PR 6：事件化 M2 Checkpoint

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- ContextRuntimeState
- compaction events
- reducer
- invariants
- migration
- `compact_context` effect
- scheduler 接入
- compaction controller

### PR 7：Structured Summary

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- deterministic fact ledger
- summary schema
- summary prompt
- mandatory fact validator
- chunked compaction
- failure handling

### PR 8：自动压缩

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- soft/hard threshold
- preflight request event
- overflow recovery
- cooldown/hysteresis
- feature flag rollout

### PR 9：手动压缩

状态：implemented（2026-07-20，待随整组 compaction 改动提交）

实现：

- `/compact`
- preview/status/force/reset
- TUI feedback
- queued manual request

### PR 10：可观测性和清理

- StatsLine
- metrics
- E2E
- 删除旧 M1
- 更新文档和配置示例
- 开启默认 feature flag

---

## 20. 文件变更清单

### Runtime

```text
src/core/runtime/state.ts
src/core/runtime/events.ts
src/core/runtime/reducer.ts
src/core/runtime/effects.ts
src/core/runtime/scheduler.ts
src/core/runtime/kernel.ts
src/core/runtime/invariants.ts
src/core/runtime/actions.ts
```

### Model/context

```text
src/core/model/context.ts
src/core/model/context-frame.ts
src/core/model/context-frame-builder.ts
src/core/model/context-serializer.ts
src/core/model/context-validator.ts
src/core/model/token-budget.ts
src/core/model/compaction-v2.ts
src/core/model/compaction-summary.ts
src/core/model/compaction-schema.ts
src/core/model/prompts/context-summary.txt
```

### Controllers

```text
src/core/controllers/model-controller.ts
src/core/controllers/compaction-controller.ts
src/core/controllers/tool-controller.ts
```

### Config

```text
src/core/config/index.ts
src/core/config/features.ts
```

### TUI

```text
src/app/tui/hooks/useSlashCommand.ts
src/app/tui/hooks/useSlashSuggestions.ts
src/app/tui/StatsLine.tsx
src/app/tui/index.tsx
```

### Tests

```text
tests/context.test.ts
tests/runtime/context-frame.test.ts
tests/runtime/context-compaction.test.ts
tests/runtime/context-compaction-recovery.test.ts
tests/runtime/context-compaction-property.test.ts
tests/tui-slash-command.test.ts
tests/e2e/context-compaction.e2e.test.ts
```

> **文档影响补充**：新增文件还需要更新 `docs/documentation-map.json` 的 `model-and-context` mapping zone，将新增的 model/context 文件加入该 zone。

---

## 21. 验收标准

功能完成必须同时满足：

### 正确性

- 任何上下文中不存在孤儿 tool call 或 ToolMessage。
- 多 tool-call block 压缩后结构完全有效。
- 用户约束、文件修改、失败结论和 pending work 不丢失。
- active plan 和 authorization 始终来自 RuntimeState。
- 原始 transcript 和 event log 不被删除或覆盖。

### 压缩效果

- M1 在重复读取/搜索场景中显著减少 token。
- M2 完成后低于 target ratio，或达到配置的 minimum reduction。
- 连续 compaction 不产生摘要指数膨胀。
- checkpoint + live tail 的 token 估算稳定。

### 恢复能力

- restart 后 checkpoint 一致。
- stale summary 不落盘。
- summary failure 不损坏原始会话。
- context overflow 可以触发一次安全恢复。
- `/compact reset` 可以恢复原始上下文投影。

### 用户体验

- 用户能看到压缩原因和结果。
- 手动命令不会无响应。
- 交互中请求会排队，而不是破坏当前流程。
- 未知 context window 会给出明确配置提示。

### 工程质量

- 核心压缩逻辑不依赖 LangChain class instance。
- 压缩器不从 stdout 文本猜测结构化 metadata。
- 自动和手动压缩共用同一 controller/effect。
- 所有 snapshot migration 和 replay 测试通过。

---

## 22. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 摘要遗漏关键事实 | deterministic fact ledger + mandatory fact IDs |
| 摘要模型幻觉 | structured schema + provenance + static validation |
| tool pairing 损坏 | canonical block + final validator |
| 并发摘要覆盖新状态 | Kernel effect lease |
| 压缩收益过低 | minimum reduction threshold |
| 摘要反复嵌套膨胀 | checkpoint replacement，不把旧摘要当普通历史反复摘要 |
| 小模型无法处理长前缀 | chunked compaction |
| 未知上下文窗口 | 显式 unknown 状态和配置提示 |
| 自动压缩频繁触发 | soft/hard hysteresis + cooldown |
| 压缩后模型忘记当前 plan | plan 始终由 RuntimeState 动态注入 |
| 文件观察过期 | resource revision/digest + mutation invalidation |
| 旧 session 不兼容 | schema migration + feature flags |

---

## 23. 最终推荐

不要直接在现有 `BaseMessage[]` 压缩代码上继续增加 M2。

正确实施顺序应是：

```text
先修复生产数据链
→ 建立 canonical context frame
→ 保证 tool pairing
→ 完成安全 M1
→ 统一 token budget
→ 建立事件化 checkpoint
→ 接入自动 M2
→ 添加手动 /compact
```

最重要的架构决定是：

> 原始 transcript 是不可变历史；RuntimeState 是当前状态权威；checkpoint 是模型上下文投影；summary 是受验证的派生数据。

只要坚持这个边界，自动压缩、手动压缩、session restore、并发控制和未来多模型支持都可以在同一套机制上稳定演进。

下一步建议按文末 PR 顺序执行，首先完成 P0 数据链和 tool-pair 完整性修复，再开放任何自动压缩入口。

---

## Review Notes（对照当前代码补充）

以下是在 `compact` 分支当前代码上对照验证后的补充说明，不属于原方案正文：

1. **`contextBudget` 未传递确认**：`src/core/controllers/model-controller.ts` 调用 `prepareModelContext()` 时仅传递 `workspace`、`messages`、`planningState` 等字段，未传递 `contextBudget`。PR 5 需要在 model-controller 中接入 `ResolvedModelCapabilities` 并传递预算。

2. **`ContextBudget` 类型位置**：定义在 `src/core/types.ts:117`，建议 PR 5 将其迁移到 `token-budget.ts` 或扩展为包含 `contextWindow` 和 `maxOutputTokens` 的正式类型。

3. **特征开关命名**：方案建议的 `contextCompactionV2`、`contextCompactionAutoV1`、`contextCompactionManualV1` 符合现有 `FeatureFlags` 命名模式（camelCase，V1/V2 后缀），可直接扩展。

4. **现有测试覆盖**：`tests/context.test.ts`（约 1400 行）已覆盖 `foldToolOutputs`、`microCompactToolOutputs`、`estimateTokens`、`shouldCompact`、`sanitizeToolCallPairs`、`reorderInterleavedMessages`。PR 1-4 需要在此基础上升级测试，PR 6-9 需要新增 `tests/runtime/` 下的集成测试。

5. **token 计数器**：使用 `gpt-tokenizer/encoding/cl100k_base`（`src/core/token-counter.ts`），方案 8.3 的分项估算需要在此之上新增各组成部分的独立计算。

6. **文档映射更新**：实施 PR 2 新增 `context-frame.ts` 等文件后，需要更新 `docs/documentation-map.json` 的 `model-and-context` zone。

7. **ADR 建议**：此方案涉及 RuntimeState schema 变更（新增 `context` 字段）、新的 RuntimeEffect 类型和 scheduler 优先级调整，按 `docs/AGENTS.md` 第 4 条，建议在 PR 6 前创建新 ADR（ADR-0021），描述 compaction checkpoint 的持久化语义和恢复契约。

8. **关联现有文档**：
   - `docs/active/plan-state-reminder.md` — 方案 15 节的消息顺序和 11.3 节的动态投影规则必须与此一致。
   - `docs/active/model-provider-boundary.md` — 方案 8.1 节的 `ResolvedModelCapabilities` 是 provider-neutral 的预算层，不引入 provider 专有假设。
   - `docs/active/feature-flags.md` — 新增 feature flag 需要更新此文档的 flags 清单。
