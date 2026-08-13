# ADR-0096：Runtime 统一工具结果与恢复协议并以整轮 Journey 评测

状态：accepted
日期：2026-08-09
决策者：github:@ferqx
关联：ADR-0043、ADR-0044、ADR-0049、ADR-0055、ADR-0056、ADR-0092

## 背景

ToolSpec Registry 已统一工具名称、schema、effect、availability、执行与结果投影，但普通工具失败仍主要以
`ok=false`、exit code、stdout/stderr 进入 transcript。模型需要猜测权限拒绝、参数错误、命令退出、超时和沙盒能力缺失
是否可重试；主 Runtime 也没有接入与 subagent 等价的无进展失败 journal。

现有 Prompt Contract A/B 只验证单次模型响应，不执行完整 model → tool → model 循环。它能衡量首次工具选择，不能证明
工具执行成功、失败后的修复质量、审批等待、跨轮重复、整轮耗时或最终任务完成。因此，继续只调 prompt 可能改善首轮
指标，却放大失败链和真实对话延迟。

工具描述还存在两类漂移：V2 从 legacy 长文本抽取首句，可能丢失关键恢复边界；部分 harness 另有手写 failure guidance，
与 ToolSpec 和现行 schema 不一致。

## 决策

1. Core Runtime 持有版本化 `ToolOutcomeV1` envelope；ToolSpec 只贡献工具特定的 result classifier 与 recovery contract。
   Registry parse、Policy、Controller 与 executor 只能填写各自权威控制的字段，工具输出不能自报可信 dispatch、effect 或 timing。
   Envelope 至少包含：
   - `status = success | failed | rejected | cancelled | timed_out | exhausted | unknown`；
   - 复用现有 `FailureKind` 的低基数 `kind`，以及版本化闭集 `detailCode`；
   - `dispatchState = not_started | started | unknown` 与 `externalEffects = none | known | unknown`；
   - `recovery.disposition = never | correct_args | retry_once | alternative | user_action`、最大额外调用数、是否需要新模型
     响应、是否允许 Runtime 自动重放、可选 retry-after 与稳定 capability intent；
   - 由可信边界测量的 queue、execution、approval wait 与 total active timing。
2. controller、Runtime event、reducer transcript、session log、metrics 与 TUI 从同一 outcome 派生；不得依赖 stderr
   文本推断恢复动作。模型/UI 的 `nextStep` 由固定模板即时生成，不持久化为 telemetry。动态 capability 执行前重新验证
   availability 与 binding；不得持久化 raw executable identity。
3. 模型修正与 Runtime 自动重放严格区分：`correct_args` 只允许下一次模型提出新的 invocation，绝不自动执行原 args；
   `retry_once` 只有在明确 pre-dispatch，或 safe-read/idempotency receipt 证明可重放时才允许，并消耗统一 retry budget。
   timeout、cancel 或 unknown external effect 默认不得自动重放。policy/approval rejection 后 Runtime 不自动产生同操作调用；
   模型再次提议时，Controller 在 dispatch 前阻断并生成配对 Tool Result，该提议计入质量违规。
4. 每个失败实例获得稳定内部 identity；后续恢复调用由 Runtime 记录 `recoveryOf` lineage，不要求模型提供。这样即使 args
   改变，也能约束“最多修正一次”并计算 next-eligible-model-response 的恢复成功率。
5. 父 Runtime 与 subagent 共用 durable/replayable 无进展 journal。failure instance、`recoveryOf` 与 guard counter 进入
   canonical Runtime Store，或可从 durable tool-call/outcome 确定性重建；进程重启不能重置 retry ceiling。成功 parse 后，
   内部 identity 由 spec 指定的 fields 经 schema parse/default 后规范化。parse 前的 invalid JSON/schema、unknown/unavailable
   tool 由 Registry/Runtime 使用保守 fallback identity：tool name、低基数 parse code/path category，以及仅供内部比较的 raw-call
   equality 或 per-install keyed opaque digest。不得为此在 canonical store 之外复制 raw args。
6. journal 只接受 tool-owned progress evidence（文件内容 revision、plan version、capability/provider revision、成功 receipt）；
   全局 state revision、文本变化或时间流逝不算进展。identity/fingerprint 不进入诊断 SessionLog、remote telemetry 或 live
   eval artifact；普通 SHA 不能视为匿名化。这里的 SessionLog 不包含 canonical private Runtime Store。
7. recovery 使用 fail-closed precedence：Policy/approval、dispatch certainty、external-effect certainty 与 idempotency evidence
   构成 Runtime ceiling；ToolSpec 只能收紧，不能放宽。classifier 缺失/抛错、字段冲突或未知 detail code 时，使用
   `status=unknown`、`recovery.disposition=never`、`safeAutomaticRetry=false` 并产生结构化低基数 diagnostic，不解析 stderr。
8. typed outcome 的迁移双写只发生在同一个 versioned terminal event：保留 legacy result fields，并增加 shadow
   `outcomeV1`，reducer 只生成一个 ToolMessage。旧 `tool.finished(ok=false)` replay 映射为
   `legacy_unclassified + dispatchState=unknown + externalEffects=unknown`，不从历史 stderr 正则补分类，也不自动重试。
9. 工具描述改为 ToolSpec 中的结构化事实：selection boundary、参数约束、结果语义与 typed recovery 分字段维护；legacy 与
   V2 由同一事实投影。删除独立手写 failure guidance。契约测试直接遍历全部 builtin specs。
10. 未知参数必须在 Zod strip 前观测，只记录 `hasUnknown`、数量、低基数 builtin tool class 与 schema revision，不记录
   字段名或值；dynamic MCP 聚合为 `mcp_tool`。分母为 provider 产生且可解析为 object 的 tool call。取得 baseline 后，
   再按工具风险决定 strict schema。
11. `Tool Journey Eval V1` 分两步：产品改动前先用 scripted model、真实 Runtime loop 与注入故障建立纯观测 baseline；
   typed outcome 与 guard 落地后再接入回归评测。deterministic fixture 使用隔离 HOME/workspace；live suite 使用真实模型但
   仍只操作 synthetic workspace。现有 A/B 明确命名为 first-decision eval，不能作为整轮性能证据。

## 备选方案

1. **继续优化 system prompt 并扩大 A/B 样本**：拒绝。单轮样本再大也不覆盖执行与恢复链。
2. **从 stderr 建正则分类器**：拒绝。跨平台、本地化和工具版本会导致不稳定，且会继续复制恢复规则。
3. **遇到失败都自动重试一次**：拒绝。审批拒绝、policy deny 和确定性参数错误的重复会增加延迟并制造越权压力。
4. **立即把全部 schema 设为 strict**：拒绝。应先观测未知字段来源，再对高风险工具有序收紧。

## 影响

- 工具失败将可聚合、可测试、可提供唯一恢复动作，减少模型解析原始错误和重复调用。
- 需要扩展 Runtime event 与 session schema，并提供版本兼容；新增字段必须保持 metadata-only。
- 评测和遥测只保存固定 case/category、计数、可信 timing 与 allowlisted candidate/model/config identity，不保存 prompt、
  response、args、path、command、stdout/stderr、stack、provider body、完整 endpoint 或内部 invocation fingerprint。
- 发布门禁将同时考察首次工具选择、完整任务成功、失败放大和关键路径耗时，避免全局平均值掩盖核心类别回退。
- Prompt Contract V2 默认值仍受 ADR-0094 约束；本 ADR 不授权翻转。

## 回滚

先以单一 terminal event 内的 shadow outcome 和双写断言验证 typed outcome，不改变用户可见恢复行为；随后逐工具切换投影。若分类或 guard 误伤，
可回到上一版本投影，但保留原始执行结果与 typed outcome 的对照测试。不得回滚为无限重复；灾难预算仍作为最终上限。
