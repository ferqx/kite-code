# ADR-0095：三级上下文缩减分层与确定性回收 Shadow 基础

状态：accepted
日期：2026-08-09
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0090、ADR-0091
关联：`docs/design/2026-08-09-three-tier-context-reduction-rfc.md`、`docs/space/plans/2026-08-09-context-reclaim-foundation.md`
后续提案：`docs/design/2026-08-10-three-tier-context-reduction-complete-rfc.md`
当前后续：ADR-0100 与 `docs/design/2026-08-10-progressive-context-compaction-rfc.md`

## 背景

Kite 当前生产上下文压缩只有单次 Markdown narrative checkpoint。工具边界已经对 Shell/Search 和 MCP
模型输出执行有界投影，但这些限制没有统一 policy identity；canonical `ToolCallBlockFrame` 已经保护
tool call/result 原子性，却没有生产工具结果回收。当前 active 规则因此明确声明模型上下文不执行工具
结果投影折叠。

Claude Code 的官方说明和多份运行时/清洁室分析共同支持“先清理旧工具输出，仍不足时再做模型总结”的
方向，但公开分析中的固定字符数、recent-N、message head/tail snip 和 Provider cache edit 都不是 Kite
可以稳定验证的跨 Provider 契约。

直接恢复历史 `foldToolOutputs()` 不可接受：旧实现解析模型正文恢复领域元数据、使用移动 recent-N，且
没有当前 canonical frame、resultMeta provenance、projection environment lease 和资格评估边界。

## 决策

### 1. 采用三级术语，但不把触发器当层级

模型输入缩减统一使用：

1. L1 result budgeting：工具完成时的有界模型结果和可信 metadata；
2. L2 deterministic reclaim：canonical frame 上的无模型投影候选；
3. L3 semantic rebase：现有单 narrative checkpoint。

`manual | auto` 继续只是 L3 请求来源。Provider error、token pressure 和 reactive recovery 不成为新的
`ContextCompactionReason`。

### 2. 首个切片只接受 L1 metadata 与 L2 off/shadow

本 ADR 只授权：

- 把现有 Shell/Search 4000 字符和 MCP 128 KiB 边界登记为 provider-neutral
  `ToolResultBudgetPolicyV1`，保持模型可见输出字节不变；
- 补齐 L2 白名单需要的 JSON-safe locator、model-content digest 和 provenance；这些字段只进入
  Tool result Runtime metadata，不进入模型正文、session log 或 TUI；
- 新增默认关闭的 `contextReclaimV1`；
- 配置只接受 `reclaimMode: off | shadow`，未配置时为 `off`；
- 在 canonical frame 上实现 pure `planContextReclaim()` 和 `applyContextReclaimPlan()`；
- normal model preflight 可在 `shadow` 下计算候选、拒绝原因与预计缩减，但不得改变 provider payload、
  Runtime transcript、checkpoint、snapshot 或模型调用调度。

`off` 必须保持当前 main 的模型请求字节级行为。`shadow` 只能输出无正文的进程内 metrics；它使用独立、
bounded、严格 DTO 的 `ReclaimShadowReporter`，不得复用或调用可能写 local-debug 磁盘的 compaction
reporter。没有 reporter 时不创建磁盘、事件或 singleton。

### 3. L2 白名单和 fail-closed 条件

初始白名单固定为 `read_file`、`search_content`、`search_files`。只有整个
`ToolCallBlockFrame` 的所有 call 同时满足以下条件才成为候选：

- pairing 完整，结果成功，block 不属于当前 active turn；
- 每个 tool 都在白名单，effect class 为 read-only，没有 mutation scope；
- canonical call args 与 resultMeta 能提供稳定 locator；
- model-content digest 存在且 provenance 不是 `legacy_unknown`；
- 生成的稳定 stub 小于原正文。

混合多工具 block、失败/取消、旧 snapshot metadata、未知 MCP、Shell/Web、Task/Skill/Plan/Verification、
write/edit/approval/interaction 都保留原正文。planner 不解析工具正文恢复 path、args 或 status。

### 4. ReclaimPlan 是固定、可验证的纯数据

`ReclaimPlanV1` 绑定 policy version、raw projection digest、projection environment digest、
`kite-count-tokens:v1` estimator、pressure、checkpoint boundary 和按 transcript 顺序排列的 selected
entries。每个 entry 固定 frame index、assistant message/turn/tool-call identity、tool name、
model-content digest、original chars 和 stub digest。

plan 同时包含 applier 可从 frames 独立重算的 `rawFramesDigest` 与 `appliedFramesDigest`。applier 对匹配
raw digest 的输入替换正文并再次运行 pairing validator；对整体匹配 applied digest 且所有 selected entry
已经是 exact planned stub 的输入返回 `already_applied`；其他任何差异整体拒绝。`rawProjectionDigest`
属于 orchestrator identity，不要求 applier 从 frames 重算。

stub 唯一 schema 只包含 `version`、`reclaimed=true`、tool、original chars 和固定
`replay="repeat_tool_call_with_original_arguments"`；不包含真实 locator、digest、原正文、时间或 locale
文案。模型重放复用保留的 assistant tool-call args。

Shadow planner 按最旧到最新扫描全部 frames，选择所有满足条件且 stub token saving 为正的完整 block；
拒绝计数按 block 的第一个稳定拒绝原因记一次，不使用 target。Shadow 阶段可以在 raw
projection/preflight 之后构造 plan，但不把 applier 结果发给 Provider。未来 live
必须使用“raw projection → 固定 plan → final projection → final payload admission”的两阶段 orchestrator，
不得在各入口独立按 ratio 选择候选；target、批量停止和 watermark 由后续 ADR 决定。

### 5. L3、checkpoint 和 Runtime schema 保持不变

本 ADR 不允许 L3 summary source 消费 L2。checkpoint 继续是 version 1，Runtime schema 继续是 21，
`sourceDigest` 继续只绑定现有不可变 transcript source。

未来 L3 复用 L2 必须新增 ADR 和 checkpoint v2，持久化 raw source digest、summary source projection
digest 与 reclaim policy identity，并更新 restore、migration 和 ADR-0057 qualification identity。不能只
依赖调用期间的 projection environment digest 冒充持久审计身份。

### 6. 不改变现有 admission 与 failure 语义

- warning/compact/hard ratio 仍分别是诊断或自动尝试启发式，不证明 Provider admission；
- window unknown 不运行 ratio-driven reclaim shadow eligibility；
- 通用 HTTP 400/Provider error 不触发 L2/L3，不创建 ContextHardBlock；
- ContextHardBlock 仍只保护可证明的 Runtime correctness failure；
- L2 不改变 Provider data classification 或 route policy；未来 live admission 必须检查最终 payload；
- production compaction capability 和 auto 默认状态不因本 ADR 提升。

## 延期决定

以下内容不属于本 ADR：

- `reclaimMode=live` 和持久 reclaim watermark；
- L3 summary source 复用与 checkpoint v2；
- 渐进安全前缀、chunk/merge 或 Provider overflow 自动恢复；
- 工具原文 artifact store、跨 session 检索和正文保留策略；
- Provider `cache_edits` 或 context-management adapter；
- 任意 user/assistant message-count snip；
- 扩大到 MCP、Shell、Web 或有副作用工具。

这些能力必须以独立证据和 ADR 决定，不能通过放宽 flag 配置静默上线。

## 后果

### 正面

- 三级术语与现有 checkpoint 架构对齐，manual/auto 不再被误称为算法层；
- 首个 PR 能验证 canonical-frame L2 的 eligibility、stub、收益和隐私，而不改变模型行为；
- L1 限额获得统一 identity，未来阈值变化可被文档和 qualification 精确识别；
- live 与 L3 的 schema、缓存和持久身份风险被隔离到后续决策。

### 负面

- 本 ADR 合入后用户不会立即获得 token saving；shadow 只产生证据；
- Runtime metadata 会增加少量 JSON-safe 字段和 snapshot 体积；
- 无持久 watermark，shadow 只能评估确定性与收益，不能证明 prompt cache 稳定；
- 完整三级能力需要至少两个后续切片。

## 验收

1. `contextReclaimV1=false` 和 `reclaimMode=off` 时现有 provider payload golden 不变。
2. L1 模型内容限额和截断文案不变；metadata 通过 reducer/snapshot round-trip。
3. planner 拒绝非白名单、失败、副作用、legacy metadata、当前 turn 和混合 block。
4. applier 保持 tool call/result 数量、ID、顺序和 pairing，重复应用字节级幂等。
5. stub 不包含原正文，metrics 不包含路径、args、digest 或正文。
6. shadow 不调用额外模型、不写 Runtime event/checkpoint/snapshot、不改变普通请求。
7. Core 不依赖 App/TUI，通用 Provider error 和 hard-block 语义不变。
8. 相关单元、Runtime、工具 conformance、文档和默认门禁通过。

## 回滚

关闭 `contextReclaimV1` 或把 `reclaimMode` 设为 `off` 即停止 shadow planner。回滚可以删除新增的纯 planner
和无正文 metrics，但不得删除 transcript/checkpoint、恢复旧正文解析 M1、改变 L1 既有限额，或借回滚
引入 live/L3 source 复用。
