# 三级上下文缩减 Foundation 实施计划

状态：archived
日期：2026-08-09
完成：[`../execution/completed/2026-08-10-context-reclaim-foundation.md`](../execution/completed/2026-08-10-context-reclaim-foundation.md)
优先级：P0
依赖：ADR-0095、`docs/design/2026-08-09-three-tier-context-reduction-rfc.md`、现有 ContextProjection 与 ToolSpec Registry
范围：本计划只实现 L1 policy identity、L2 off/shadow 和证据；不实现 live 或 L3 source 复用

## 目标

在不改变任何 Provider payload、模型调用次数、checkpoint 或 Runtime schema 的前提下，为三级上下文缩减
建立可执行基础：统一登记现有 L1 模型结果预算；在 canonical `ToolCallBlockFrame` 上生成并验证稳定的 L2
`ReclaimPlanV1`；通过默认关闭、显式 shadow 的 normal preflight 收集无正文候选与预计收益。

计划完成不等于三级压缩已对用户生效。只有本计划的 deterministic、安全、隐私和 continuation 基线通过后，
后续计划才可提议 live normal projection；L3 复用还需要 checkpoint v2 ADR。

## 范围与不变量

### 包含

- `ToolResultBudgetPolicyV1`：登记 Shell/Search 4000 字符和 MCP 128 KiB 当前模型边界；
- 白名单 Runtime metadata/provenance 的生产、reducer 与 round-trip；
- `ReclaimPolicyV1`、`ReclaimPlanV1`、eligibility reason、稳定 stub 与 applier；
- `contextReclaimV1=false` 和 `compaction.reclaimMode=off|shadow`；
- normal model raw projection/preflight 后的 shadow planning；
- 无正文 metrics、定向测试、ADR/active/book/documentation-map 收敛。

### 不包含

- provider payload 实际回收、`reclaimMode=live`；
- summary/candidate/restore/debug 对 L2 的消费；
- checkpoint/Runtime schema 变化；
- artifact store、Provider cache edit、渐进 summary、message snip 或白名单扩大；
- production capability promotion 或真实 Provider qualification。

### 不变量

1. `src/core/` 不依赖 `src/app/` 或 TUI 类型。
2. transcript、checkpoint v1、Runtime schema v21、manual/auto reason 和 lease/CAS 不变。
3. off/shadow 的 Provider payload 与 main 字节级一致，shadow 不增加模型调用。
4. planner 只读 canonical args/resultMeta，不解析正文恢复领域事实。
5. tool block 原子性、pairing validator、Provider data admission 和 hard-block 语义不变。
6. metrics/debug/session log 不记录路径、args、digest、stub、summary 或正文。

## 设计切片

### TCRF-01：冻结文档输入、建立基线与 policy identity

核验并冻结已 reviewed/accepted 的 ADR、RFC 与计划输入，更新 documentation map 和 plans index。建立 L1
golden：记录 `src/core/tools/registry/projection.ts` 的 4000 字符默认值，以及
`src/core/harness/tool-runner.ts`、`src/core/tools/registry/builtins/mcp-inventory.ts` 两处 MCP 128 KiB
边界，禁止本计划改变限额、marker、head/tail 内容或 stdout/stderr 分流。

新增共享的 JSON-safe `ToolResultBudgetPolicyV1` 常量/类型，并让 Search projection 与 MCP serializer 引用
同一 policy 值，移除重复 magic number；Shell 继续通过共享 projection helper 使用相同 stream limit。

### TCRF-02：白名单 metadata 与 provenance

确保 `read_file`、`search_content`、`search_files` 经真实 Tool Controller 路径完成后，canonical frame 可从
call args 与 resultMeta 获得：

- path 和必要 pattern/range/glob；
- totalLines/matchCount（存在时）；
- modelContentDigest；
- rawResultDigest（只有确实描述 pre-projection 原始结果时）；
- `digestScope: raw | projected`，不得把未知/截断后的 model digest 伪装成 raw。

只补 JSON-safe metadata，不改变模型正文或 TUI。旧 snapshot 和缺失 provenance 规范化为
`legacy_unknown`，planner 必须拒绝。增加 Tool Controller、reducer、snapshot/replay 和 registry conformance
测试，防止 direct runner/controller 两条路径产生不同 provenance。`toolResultMeta()` 不再把缺少显式
provenance 的旧 `contentDigest` 推断为 raw；`src/core/runtime/kernel.ts` 的
`normalizeRuntimeMetadata()` 同时规范化 `tools.calls[*].result.resultMeta` 与 transcript tool message
metadata，缺证明时补 `digestScope=legacy_unknown`，不提升 Runtime schema。

### TCRF-03：Pure reclaim planner 与 applier

新增 `src/core/model/context-reclaim.ts`（最终文件名可在实现时按现有目录惯例调整），导出：

```ts
planContextReclaim(input): ReclaimPlanV1;
applyContextReclaimPlan(frames, plan): ReclaimApplicationV1;
digestRawContextProjection(input): string;
```

`ReclaimPlanV1` 只包含无正文纯数据：version/policyId、rawProjectionDigest、rawFramesDigest、
appliedFramesDigest、environmentDigest、`kite-count-tokens:v1`、pressure、checkpoint boundary、selected
entries、预计字符/token saving 和拒绝原因计数。canonical frames digest 使用 versioned stable JSON；
selected entry 固定 `frameIndex/assistantMessageId/turnId/toolCallId/name/modelContentDigest/originalChars/
stubDigest`。

planner 按最旧到最新评估全部 `ToolCallBlockFrame`，执行 ADR-0095 的白名单与 fail-closed 矩阵，选择所有
stub token saving 为正的 block；拒绝计数按 block 第一个稳定拒绝原因记一次，不使用 target。applier 对
raw frames digest 匹配时只替换 content，随后调用现有 frame/message pairing validator；对 exact planned
stubs 且整体 applied digest 匹配时返回 `already_applied`；其他 mismatch 拒绝整个 plan。

stub 唯一稳定 JSON schema 为：

```json
{"version":1,"reclaimed":true,"tool":"read_file","originalChars":1234,"replay":"repeat_tool_call_with_original_arguments"}
```

它不包含真实 locator、digest 或正文；assistant tool-call args 和 frame resultMeta 保持不变。metrics 不接收
plan 或 selected entries。

### TCRF-04：Flag、配置与纯内存 Shadow Reporter

登记 `contextReclaimV1=false`；配置新增严格枚举 `compaction.reclaimMode=off|shadow`，flag false 时强制
effective mode=off。不得提前接受 `live` 字符串。新增独立、bounded、纯内存
`ReclaimShadowReporter`/collector，只接受严格 sanitized DTO；禁止传入 plan、selected entries、call/frame ID、
path、args、digest、stub 或正文，也禁止复用 `CompactionReporter`、`compaction-debug.ts` 或 local-debug writer。

### TCRF-05：Model Controller Shadow 集成

Model Controller 继续先构建当前 raw projection 和 preflight。只有 flag true、mode shadow 且 pressure 至少
为 warning 时，才调用 planner；planner 结果只交给 reporter，不替换 `projection.providerMessages`，不改变
resource admission token identity，不产生 Runtime event 或 effect。

`ContextProjectionEnvironment.leaseMetadata.summaryPolicy` 纳入 reclaim flag、effective mode、policy ID 和
planner estimator identity，确保未来 compaction effect 环境变化可被现有 stale gate 检测。本计划不让 L3
消费 plan，也不改变 checkpoint digest。

composition root 可选注入 reporter；没有 reporter 时 planner 仍可跳过以保证零开销和零副作用。sanitized
sample 只允许：

- policyId/version/mode；
- raw input tokens、candidate block/call count；
- estimated saved chars/tokens；
- 枚举拒绝原因计数；
- duration。

不得记录 callId、messageId、path、pattern、args、policy/content/environment digest、stub 或正文。
collector 有固定样本上限和 clear 语义，不写 event/snapshot/disk。现有 `m1FramesFolded` 历史字段不得被
shadow 候选冒充实际回收；可在本计划中标记 deprecated，但删除需要确认没有兼容消费者。

### TCRF-06：文档与验证收敛

更新：

- `docs/active/plan-state-reminder.md`：当前仍不执行 live 工具结果折叠，但存在默认关闭的 shadow planner；
- `docs/active/model-provider-boundary.md`：off/shadow 不改变 Provider payload/admission；
- `docs/active/feature-flags.md`：flag/mode 和默认值；
- `docs/active/observability-privacy-operations.md`：独立纯内存 shadow reporter 与禁止 local-debug 复用；
- `docs/active/file-reading-shared-boundary.md`、`tool-gated-autonomy.md`、
  `mcp-runtime-governance.md`：统一 L1 policy 与 metadata provenance；
- `docs/book/04-Agent引擎.md`、`05-工具系统与安全策略.md`、`09-CLI模式与配置.md`、`12-测试体系.md`
  的相应概述；
- `docs/documentation-map.json`、plans index 和完成记录。

行为描述必须明确：本计划只上线 shadow 基础，没有用户可见 token saving，不得声称三级压缩 live 或
Claude Code parity。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| TCRF-01 | ADR-0095 | 冻结 RFC/ADR/计划、L1 policy/golden | projection/tool runner tests、`check:docs` | policy 只登记现值，可独立回退 |
| TCRF-02 | TCRF-01 | ToolSpec/Controller resultMeta、reducer/snapshot fixtures | tool registry、tool runner、reducer tests | 旧 metadata 归一为 legacy_unknown |
| TCRF-03 | TCRF-02 | context reclaim planner/applier、stable stub | context/pairing/property tests | 纯函数未接 Provider，可直接删除 |
| TCRF-04 | TCRF-03 | feature/config、独立内存 reporter | feature/config/reporter privacy tests | flag false 或 mode off；collector 可删除 |
| TCRF-05 | TCRF-04 | Model Controller shadow 接入 | model controller/runtime/admission tests | 不替换 raw projection；无 reporter 零副作用 |
| TCRF-06 | TCRF-01..05 | active/book/map/完成记录 | docs impact/docs/default gates | 文档与实现共同回退 |

## 定向验证

实现至少运行：

```bash
bun test tests/context.test.ts tests/context-budget.test.ts tests/runtime-context.test.ts
bun test tests/context-reclaim.test.ts tests/runtime/context-reclaim-shadow.test.ts
bun test tests/tools/tool-registry-conformance.test.ts tests/tool-runner.test.ts
bun test tests/runtime/reducer.test.ts tests/runtime/context-compaction-summary.test.ts
bun test tests/runtime/context-compaction-e2e.test.ts tests/runtime/compaction-metrics.test.ts
bun test tests/runtime/tool-controller.test.ts tests/runtime/kernel.test.ts tests/runtime/store.test.ts
bun test tests/runtime/context-compaction-auto.test.ts tests/runtime/resource-budget-admission.test.ts
bun test tests/config/features.test.ts tests/config.test.ts
bun run test:mock
bun run typecheck
bun run format:check
bun run lint
bun run check:core-boundary
bun run check:compaction-legacy
bun run check:docs-impact
bun run check:docs
git diff --check
```

若实际配置测试文件名不同，实施前必须用 `rg --files tests` 解析并更新本计划；空 glob、skipped live runner
或 mock 不能替代实际门禁。真实 Provider 测试仍为显式 opt-in，不属于本 foundation 的完成条件。

本计划明确新增：

- `tests/context-reclaim.test.ts`：planner/applier eligibility、stable digest、mismatch、pairing、stub 和
  `already_applied` property；
- `tests/runtime/context-reclaim-shadow.test.ts`：effective off/shadow、Model Controller composition 注入、
  bounded/clear、strict DTO、无磁盘写入、无 Runtime event/model call 变化和 resource-admission identity。

## 验收门禁

### G0：零行为回归

- flag false、mode off、flag true+shadow 三种情况下，Provider 请求正文、工具 schema、模型调用次数和
  Runtime lifecycle event 相对 main 不变；
- L1 golden 字节不变，Runtime metadata 新字段 round-trip 稳定；
- shadow 不改变 resource admission 的 input token identity。

### G1：L2 正确性

- 白名单成功旧 block 能生成正收益候选；current turn 和所有拒绝类均保留；
- 混合/多工具 block 不拆分，plan/applier mismatch fail closed；
- stable stub 幂等且不包含原正文；原 frames/transcript 不被 mutation；
- pairing validator 在原始、候选和重复 apply 后全部通过。

### G2：隐私、恢复与文档

- metrics/debug/session trace 不含 locator、args、digest、stub 或正文；
- snapshot/replay 对新旧 metadata 都可恢复，旧数据不会被误判可回收；
- manual/auto direct/incremental summary、reset、Provider error 和 correctness hard block 回归通过；
- docs impact、docs、typecheck、format、lint、core boundary、legacy checker 和默认确定性测试通过。

## 风险与回滚

- **metadata provenance 漂移**：Controller、Runner、Reducer conformance 固定同一语义；不确定即
  `legacy_unknown`。
- **shadow 产生隐私旁路**：reporter 类型不接受 content/locator 字段，测试 JSON snapshot；无 reporter 零
  副作用。
- **planner 影响主路径延迟**：只在 warning+shadow 运行，记录 duration；超出预注册预算时关闭 flag。
- **误把候选当实际回收**：metrics 命名固定 `reclaimShadowCandidate*`，不复用 completed/folded 计数。
- **未来 live 直接复用不完整 identity**：本计划的 plan 类型携带两阶段所需 identity，但 `live` 配置不进入
  schema；后续必须新 ADR/计划。

立即回滚设置 `contextReclaimV1=false` 或移除 `reclaimMode=shadow`。回滚不修改 transcript、checkpoint 或
Runtime schema，也不恢复旧 M1。
