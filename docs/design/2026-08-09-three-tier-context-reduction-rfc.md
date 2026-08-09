# 三级上下文缩减 RFC

状态：reviewed（首个 foundation 切片已批准；live 与 L3 source identity 待后续 ADR）
日期：2026-08-09
关联：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0090、ADR-0091、`docs/active/plan-state-reminder.md`

## 摘要

Kite Code 当前已经具备不可变 transcript、canonical context frame、统一 ContextProjection、单份
Markdown narrative checkpoint、manual/auto 共用 effect，以及 RuntimeStore lease/revision CAS；但生产
上下文缩减只有语义总结一条路径。Shell/Search 的 4000 字符投影和 MCP 的 128 KiB 模型输出上限分散在
工具边界，旧工具结果不会在历史投影中被确定性回收，summary 输入也直接消费未回收的 settled history。

本 RFC 把模型输入缩减定义为三个按成本和信息损失递增的层级：

1. **L1 结果预算（result budgeting）**：工具完成时限制模型可见结果，保留可信 digest、结构化元数据和
   明确截断标记；不调用模型。
2. **L2 投影回收（deterministic reclaim）**：在 provider-neutral `ToolCallBlockFrame` 上，把满足严格
   白名单和 provenance 条件的旧成功只读结果替换为稳定 stub；不修改 transcript，不调用模型。
3. **L3 语义重基线（semantic rebase）**：沿用当前单次、无工具、零 SDK retry 的 Markdown narrative；
   在后续 checkpoint v2 中记录 summary source 的 L2 projection identity 后，summary source、正常请求、
   preflight、`/context` 和 candidate validation 才共用同一 L2 投影语义。

`manual | auto` 是触发来源，不是压缩层级。Provider admission、ContextHardBlock 和 Runtime
correctness failure 的现有边界不变。

## 外部研究结论及采用边界

Anthropic 当前公开说明称 Claude Code 会先清理旧工具输出，仍不足时才总结会话，并在反复压缩仍快速
回填时停止自动压缩。GitHub 上的运行时请求抓取和清洁室复刻进一步报告了 tool-result budget、history
snip、micro-compaction、full summary、工作集恢复和 Provider cache edit 等机制。

本 RFC 只采用能够在 Kite Provider-neutral Core 内独立验证的共识：

- 便宜、确定性的操作必须先于模型总结；
- tool call/result 必须作为原子协议块处理；
- 原始记录与模型投影分离；
- manual/auto/reactive 是 trigger/recovery policy，而不是不同压缩算法；
- summary 后必须由当前 Runtime 与稳定项目规则重新提供权威状态；
- 重复压缩需要 cooldown、最低收益和 thrash breaker。

以下社区分析细节不成为 Kite 契约：固定 200000 字符、保留最近三个工具结果、固定 13000 token buffer、
恢复固定数量文件、按消息数保留头尾，以及 Anthropic `cache_edits`。这些数值和能力随版本、模型与
Provider 变化，且无法从公开官方源码稳定验证。

参考：

- <https://code.claude.com/docs/en/how-claude-code-works>
- <https://code.claude.com/docs/en/context-window>
- <https://github.com/Yuyz0112/claude-code-reverse>
- <https://github.com/shareAI-lab/learn-claude-code/blob/main/s08_context_compact/README.en.md>
- <https://github.com/ComeOnOliver/claude-code-analysis/blob/main/DOCUMENTATION.md>

## 目标

1. 让大工具结果在进入 transcript 前就有统一、可审计的模型输出预算。
2. 在不调用模型、不修改 transcript 的前提下回收可重放的历史工具正文。
3. 避免 L3 把已经确认可回收的工具正文再次发送给 summary model。
4. 保持 normal call、preflight、summary、candidate validation、restore 和 debug 的投影一致。
5. 首个基础 PR 保持当前 checkpoint v1、Runtime schema v21、manual/auto event/effect、lease/CAS 和单
   narrative 内容契约；L3 消费 L2 前由独立 ADR 升级 checkpoint source identity。
6. 通过默认关闭和 shadow/live 分离，使 L2 可以先观测再灰度，关闭后恢复现有字节级行为。

## 非目标

本轮不实现：

- summary source 的分块、merge、渐进安全前缀提交或 Provider overflow 自动推断；
- 新的模型生成 memory、fact ledger、reviewer 或第二份 checkpoint 正文；
- 工具原文 artifact 仓库、跨 session 检索和新的本地正文保留策略；
- Provider-specific `cache_edits`、context management API 或缓存控制协议；
- 任意删除中间 user/assistant 自然语言消息的 message-count snip；
- production auto capability 的资格提升或默认开启。

## 当前问题

### 分散的 L1

Shell/Search 使用逐流 4000 字符 head/tail 投影，MCP 结果使用独立的 128 KiB 序列化边界。它们都能
防止单个结果无限扩张，但没有统一的 policy identity、retention class 和跨工具 conformance 测试。

本轮统一策略入口和命名，保持已有工具的实际限额和模型可见字节不变。为 L2 补齐 locator、
model-content digest 和 provenance 属于 Runtime metadata 行为变化，必须有 reducer/snapshot/conformance
测试。改变模型限额或正文仍需要独立证据，不能借 L2 重构静默完成。

### 缺失的 L2

`ContextProjection` 当前已经构造并校验 `ToolCallBlockFrame`，但随后原样序列化全部 live tail。
active 规则明确声明“不再执行工具结果投影折叠”。恢复 L2 属于新的当前行为和架构决定，必须由新 ADR
取代这条局部结论，不能复活旧 `foldToolOutputs()`：旧实现通过解析正文恢复 path/command，按移动的
recent-N 窗口折叠，并可能破坏 prompt cache 稳定性。

### L3 输入未复用投影

当前 compactor 对 safe boundary 得到的 `TranscriptMessage[]` 直接 JSON 序列化。即使普通请求未来使用
L2，summary 仍可能接收全部旧工具正文，造成 summary 请求自己先超过 `maxSummaryInputTokens`，也会让
before/after 与真实模型投影使用不同缩减规则。

## 三级架构

```text
Tool execution result
  → L1 model-output budget + resultMeta/digests
  → immutable Runtime transcript
  → active narrative checkpoint boundary
  → canonical ContextFrame[]
  → L2 deterministic reclaim (off | shadow | live)
  → pairing validator + provider messages
  → complete request estimate
  → L3 narrative rebase when manual/auto requests it
```

L1 发生在工具结果投影边界；L2 和 L3 发生在 Core ContextProjection。TUI 的 `tool_summary` 聚合不属于
这三个层级，也不能计入 token reduction。

## L1：统一结果预算契约

新增 provider-neutral `ToolResultBudgetPolicyV1` 与共享 helper，作为 ToolSpec `projectResult()` 和 MCP
模型序列化的统一术语入口。首个 PR 只登记现状，不改变输出：

- Shell/Search 继续逐流 head/tail 截断；
- MCP 模型可见输出继续使用当前 128 KiB 上限；
- `rawResultDigest` 必须在模型截断前计算；
- `modelContentDigest` 必须描述模型实际看到的内容；
- `truncated` 与 `digestScope` 必须显式传播；
- L1 不把 stdout、文件或 MCP 正文写入 session log、checkpoint 或 metrics。

后续若需要 artifact 保留，必须先独立决定正文分类、owner-only 存储、配额、保留期、删除、session
fork/rewind 和用户 consent；不能把 `.task_outputs` 式明文目录作为本 RFC 的隐式前提。

## L2：确定性投影回收

### 运行位置

L2 的 planner 和 applier 都是纯函数。applier 是 `ContextFrame[] + ReclaimPlan → ContextFrame[]` 的纯
变换，位于 canonical frame builder 之后、serializer 和最终 pairing validator 之前。planner 不在这一
位置自行判断 pressure；它接收第一阶段已经完成的 raw projection identity、estimate、environment 与
policy。两者都不得读取 App/TUI 类型、磁盘正文、旧 stdout 字符串结构或 Provider API。

### 初始白名单

首个可交付版本只接受：

- `read_file`
- `search_content`
- `search_files`

一个 `ToolCallBlockFrame` 只有同时满足下列条件才可回收：

1. 所有 call/result 已完整结算且 pairing validator 可通过；
2. block 中每个 call 都在白名单；混合 block 整体保留；
3. 每个结果均成功；错误、取消和未知状态整体保留；
4. 不属于当前 active turn；
5. `rawResultDigest` 或可信 `modelContentDigest` 存在，`digestScope !== legacy_unknown`；
6. canonical call args 与 `resultMeta` 共同提供该工具生成 stub 所需的 locator：pattern/range/glob 从
   已解析 call args 读取，path、matchCount、totalLines 和 digest 从 `resultMeta` 读取；缺失时 fail
   closed；
7. tool effect class 为 read，且没有 `workspaceMutationScope`；
8. 结果正文超过稳定 stub，预计能够产生正收益。

初期不允许 Shell、Web、Task、Skill、Plan、Verification、write/edit、approval、interaction 和动态 MCP。
未来扩白名单需要增加 retention class、replay locator 和相应 conformance 测试。

### 稳定 stub

L2 只替换 `FrameToolResult.content`，保留：

- assistant tool call；
- toolCallId、tool name、args 和 status；
- 原始结构化 resultMeta；
- raw/model digest 与 provenance；
- block 内原有 call 顺序。

stub 使用唯一的稳定 JSON schema：`version`、`reclaimed=true`、tool、原始字符数和固定
`replay="repeat_tool_call_with_original_arguments"`。它不得复制真实 locator、digest 或原正文片段；模型
需要重放时复用仍然保留的 assistant tool-call args。文案不得根据 locale、时间或当前 token 比例变化。

`ReclaimPlanV1` 分开记录 orchestrator 使用的 `rawProjectionDigest`，以及 applier 可从 frames 独立重算的
`rawFramesDigest`/`appliedFramesDigest`。每个 selected entry 固定 frame index、assistant message/turn/tool
call identity、tool name、model-content digest、original chars 和 stub digest。applier 输入为 raw frames 时
校验 `rawFramesDigest` 后应用；输入已是 exact planned stubs 且整体匹配 `appliedFramesDigest` 时返回
`already_applied`；其他任何差异整体拒绝。这里的幂等不表示对任意已修改 frames 重做选择。

### 两阶段投影

为避免“必须先知道完整请求 pressure 才能决定 L2，但完整请求又依赖 L2”的循环，所有 live 入口必须
使用同一两阶段 orchestrator：

```text
Phase A: buildRawProjection(state, checkpoint, environment)
  → raw provider messages + raw estimate + rawProjectionDigest
  → preflight(raw estimate)

Phase B: planReclaim(raw frames, raw preflight, policy, environment)
  → immutable ReclaimPlan(policyId, rawProjectionDigest, rawFramesDigest,
                          appliedFramesDigest, selected entries, estimatedSaving)
  → applyReclaim(raw frames, plan)
  → serialize + pair validation + final estimate
  → resource/provider admission checks the final payload
```

normal call、`/context`、candidate validation 和未来 L3 source 不能各自按 ratio 重新选择候选，而是消费
相同输入生成的固定 `ReclaimPlan`。raw projection identity、projection environment digest、estimator、
warning pressure、policy version 和 checkpoint boundary 全部参与 plan identity。

首个 PR 只实现 raw plan 的 off/shadow 路径，不改变 provider payload；live orchestrator 在后续 PR 实现。

### 模式与触发

新增 `contextReclaimV1` feature flag，默认 `false`；新增：

```ts
type ContextReclaimMode = 'off' | 'shadow' | 'live';
```

- `off`：完全跳过，输出必须与当前 main 字节级一致；
- `shadow`：构造候选并记录无正文的候选数、拒绝原因、预计 token saving，不改变 provider messages；
- `live`：后续晋级模式；只有完整 raw 请求达到 warning pressure，且固定 plan 达到最低绝对收益时使用
  候选投影。

默认 warning/compact/hard 仍为 0.80/0.90/0.94，但三者职责不变：warning 只允许尝试 L2，compact 只
允许尝试 auto L3，hard 仍是诊断而非 Provider admission 或 correctness block。window unknown 时不运行
ratio-driven L2 live；L1 仍执行，manual L3 仍可用。

首个 off/shadow planner 使用 `kite-count-tokens:v1` estimator，按最旧到最新扫描全部 frames，选取所有
满足条件且 stub token saving 为正的完整 block；拒绝计数按 block 的第一个稳定拒绝原因记一次。它不使用
target，也不持久化 reclaim watermark。未来 live 的 target、批量停止和 watermark 需要后续 ADR/plan。
当前选择由 raw projection identity、projection environment digest、estimator、warning pressure、当前
checkpoint boundary 和 policy 唯一决定。纯函数
确定性只保证正确性，不承诺 prompt cache 稳定；cache read/write 退化是 live 晋级门禁。若证据要求稳定
watermark，再通过 Runtime schema ADR 引入，不能预先把未验证状态塞入 checkpoint v1。

### 一致性与 lease

`ContextProjectionEnvironment.leaseMetadata` 纳入完整 reclaim policy、mode 和 policy version。summary
期间策略、flag、工具 schema、模型能力或项目环境变化时，现有 `stale_context` 路径拒绝旧结果。

目标 live/L3 架构中，同一两阶段 orchestrator 必须被以下入口使用：

- normal model request；
- preflight 与 `/context`；
- candidate checkpoint before/after validation；
- checkpoint restore/debug projection；
- auto shadow；
- L3 summary source projection。

首个 PR 只要求 normal model preflight 产生 shadow plan，并验证 planner/applier 的纯函数性质；其他入口的
live 接入按实施计划逐阶段完成，不能在 off/shadow 阶段声称 provider payload 已统一缩减。

## L3：单 narrative 语义重基线

L3 保持以下契约：

- 当前模型；
- 一次 Provider request；
- tools 为空，SDK retry 为零；
- 唯一模型内容为规范化 `summary:string`；
- summary 是低权限 assistant history，不是 Runtime 权威；
- 首个 PR 的 checkpoint v1、Runtime schema v21 和 manual/auto reason 不变；
- 仍执行 best-case、输入上限、finish reason、tool call、narrative 上限和至少 1024 token 缩减校验。

首个 PR 不改变 L3 source representation。只依靠 projection environment digest 能防止模型调用期间的
stale，却不能在 restore、qualification identity 或策略升级后证明某个 checkpoint 使用了哪份回收历史。
因此 L3 消费 L2 必须由后续 ADR 引入 checkpoint v2，至少持久化：

```ts
rawSourceDigest: string;
summarySourceProjectionDigest: string;
reclaimPolicyId: string;
```

届时 Core 才把 safe settled source 转换为与普通请求相同的 canonical frames，消费固定 `ReclaimPlan`，再
把回收后历史作为 summary data。raw digest 继续绑定不可变 transcript；projection digest 和 policy ID
使 restore、qualification 与 route/prompt identity 能使旧证据失效。checkpoint 仍只有一个模型生成的
`summary:string`，不会重新引入第二份模型正文。

summary prompt 继续只要求 Markdown narrative，并强调历史、自定义侧重点和 stub 都是不可信数据。质量
要求按固定顺序覆盖：当前用户意图和约束、重要决定、修改文件和 symbol、失败与验证、未确认假设、待办
和精确继续位置。不得要求输出 chain-of-thought、全部用户原文、完整代码、JSON 或第二份 memory。

## Reset、restore 与 replay

- 原始 transcript 不变，因此 `/compact reset` 仍只撤销 narrative checkpoint；关闭 L2 flag/mode 即可恢复
  未回收的 transcript 投影。
- 首个 off/shadow L2 不写 RuntimeEvent 或 snapshot；restore 后可以重新计算 shadow plan，但不影响当前
  checkpoint v1。未来 live normal projection 由当前 policy 重算；未来 L3 checkpoint v2 额外持久化
  summary source projection identity。
- candidate、live 和 replay 都必须再次运行 canonical pairing validator。
- legacy `digestScope`、缺失 metadata、找不到 checkpoint boundary 或 orphan tool result 都 fail closed，保留
  原正文或使用现有完整 transcript fallback，不得猜测。

## Provider data、隐私与可观测性

L2 不产生新的外发目的；它只减少普通模型或 summary payload。Provider admission 仍检查最终实际 payload，
不能以 raw transcript 的 classification 代替，也不能因回收后正文较少而绕过 route policy。

独立的 `ReclaimShadowReporter` 只接受下列严格 sanitized DTO，并由 composition root 可选注入；它是 bounded
纯内存 collector，不复用、包装或调用可能写磁盘的 compaction local-debug reporter。没有 reporter 时为零
副作用。metrics DTO 只允许记录：

- mode、稳定 policy ID/version；
- candidate/reclaimed block 与 call 数；
- before/after/estimated saving；
- 按枚举聚合的拒绝原因；
- duration、cache usage metadata 和后续重复读取次数。

禁止记录 policy/content/environment digest、stub locator 的真实路径、args、tool content、summary 或
transcript 正文。local debug 也必须遵守现有 no-content policy。

## 失败语义

- L1 投影失败：沿用对应工具的 fail-closed 结果，不进入 L2。
- L2 构造或 validator 失败：`shadow` 只记录拒绝；`live` 回退未回收投影并报告 Runtime invariant telemetry，
  不得静默发送未验证候选。
- auto L3 失败：沿用当前 admission gate、cooldown 和 breaker；不回落本 turn 普通调用。
- manual L3 失败：保留原 transcript/checkpoint，返回现有脱敏终态。
- 通用 HTTP 400/Provider error 不触发 L2/L3，不创建 ContextHardBlock。
- ContextHardBlock 仍只表示可证明的 Runtime correctness failure。

## 被拒绝的方案

### 把 manual、auto、reactive 称为三级

拒绝。三者改变的是触发和恢复时机，不改变信息处理算法，会导致 controller、event 和文档复制。

### 任意 head/tail message snip

拒绝。消息数量与语义价值无稳定关系，也无法证明早期用户约束可以删除。L2 只能处理可验证、可恢复的
结构化工具结果；自然语言历史只能由 L3 语义总结覆盖。

### 直接恢复旧 M1

拒绝。旧实现解析 model content 恢复 path/command、使用移动 recent-N、对白名单和 mutation boundary 的
证明不足；新实现只读取 canonical frame 的 resultMeta 和 effect class。

### 首个 PR 引入 artifact store

拒绝。它会同时引入正文保留、配额、加密/ACL、fork/rewind、删除与 consent 生命周期。当前不可变
transcript 已足以支持 projection-only reset，不需要把本地正文存储变成 L2 前置条件。

### 首个 PR 引入渐进 summary 或 Provider cache edit

拒绝。渐进 summary 会改变 ADR-0022 的 source coverage 和失败提交语义；Provider cache edit 是 adapter
优化而非 Core 正确性。两者都应在本地 L2 语义和证据稳定后单独决策。

## 迁移与回滚

1. 新增 ADR，取代 active 规则中“模型上下文不执行工具结果投影折叠”的局部结论；不改写旧 ADR。
2. 登记 `contextReclaimV1=false`，首个 PR 只实现 off/shadow；off 必须保持现有行为。
3. 统一 L1 policy 入口，保持模型字节不变；补齐白名单所需 metadata/provenance，并增加 golden、reducer、
   snapshot 与 conformance 测试。
4. 实现 canonical-frame planner/applier、拒绝矩阵、幂等和 pairing property tests；normal preflight 只记录
   shadow plan。
5. 后续 PR 实现两阶段 live normal projection；只有 shadow 指标和 continuation qualification 满足门禁后
   才允许开发/内测显式 live；production profile 仍保持 compaction capability off。
6. 再以 checkpoint v2 ADR 让 candidate、restore 和 L3 source 使用同一固定 plan/identity。

回滚只需关闭 `contextReclaimV1` 或把 `reclaimMode` 设为 `off`。回滚不得删除 transcript/checkpoint、恢复
旧正文解析 M1、改变 manual/auto reason，或把 Provider error 解释为 overflow。

## 验证与验收

### G0：结构与等价

- flag 关闭时现有 normal/preflight/summary/candidate provider payload golden 字节级不变；
- L1 各工具当前模型输出字节、truncated 和 TUI presentation 不变；新增 locator/digest provenance 只进入
  Runtime metadata，并通过 reducer/snapshot round-trip；
- L2 对非白名单、失败、副作用、legacy metadata、混合多工具 block、当前 turn 全部 fail closed；
- 多工具 block、toolCallId、顺序和 result count 在 L2 前后完全一致；
- reclaim stub 字节级确定、幂等，且不包含原正文；
- transcript、RuntimeState、snapshot、checkpoint v1 不被 L2 修改；
- policy 或 projection environment 变化使旧 summary effect 以 `stale_context` 收敛。

### G1：后续 live 投影一致性

- normal request、preflight、`/context`、debug、restore、candidate validation 和 summary source 对同一状态得到
  相同 L2 identity；
- L3 before/after 都使用相同 policy，source digest 仍可从原 transcript 重算；
- window unknown 不运行 ratio L2；hard ratio 不阻断请求；Provider error 不触发压缩；
- `/compact reset` 与 flag-off 恢复原 transcript 投影，无 orphan pair。

### G2：后续 live/L3 收益与质量

- synthetic tool-heavy fixture 达到预注册的绝对 token saving，且无回收时不产生负收益；
- manual/auto direct 与 incremental E2E 保持通过；
- ADR-0057 的结构、semantic facts 和 continuation non-inferiority 门禁不因 L2 降级；
- 统计 cache read/write metadata、三轮 refill、重复 read/search 和 breaker，不保存正文。

### 本轮验证命令

最终实施计划应至少包含：

```bash
bun test tests/context.test.ts tests/context-budget.test.ts tests/runtime-context.test.ts
bun test tests/runtime/context-compaction-e2e.test.ts tests/runtime/compaction-*.test.ts
bun test tests/tools/tool-registry-conformance.test.ts tests/tool-runner.test.ts
bun run typecheck
bun run format:check
bun run lint
bun run check:core-boundary
bun run check:compaction-legacy
bun run check:docs-impact
bun run check:docs
git diff --check
```

若仓库中不存在上述某个 glob 对应文件，计划必须用实际测试文件替换，不能用空匹配宣称通过。真实 Provider
验证仍为显式 opt-in，不得以 mock 结果声称 route qualification。

## 待后续 ADR 的问题

1. 是否需要持久 reclaim watermark 来稳定 prompt cache prefix。
2. 是否建立受治理的工具原文 artifact store，以及其正文分类和删除契约。
3. 是否采用有类型的 Provider context-management/cache-edit adapter。
4. 超长 summary source 是否允许渐进安全前缀 checkpoint，以及中途失败是否激活部分进度。
5. 是否在 continuation qualification 后扩大到只读 MCP、inspect Shell 或 Web 结果。
