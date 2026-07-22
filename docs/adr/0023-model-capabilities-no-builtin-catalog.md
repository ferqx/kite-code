# ADR-0023：模型能力不使用内置名称目录，只接受显式或运行时来源

状态：accepted
日期：2026-07-22
补充：ADR-0007、ADR-0021、ADR-0022
后续：ADR-0024 进一步规定模型能力和 token 估算不得生成容量型 hard block；本 ADR 的历史结论不改写
关联：`docs/active/model-provider-boundary.md`、`docs/active/capability-progressive-disclosure.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`

## 背景

当前 `src/core/model/model-capabilities.ts` 通过 `BUILTIN_MODEL_CAPABILITIES` 按 `providerName/modelName` 推断：

- `contextWindowTokens`；
- `maxOutputTokens`；
- `tokenizerFamily`；
- `supportsUsageMetadata`；
- `supportsPromptCache`。

配置模块和可选模型列表中还存在同类硬编码窗口。`resolveModelCapabilities()` 当前把内置目录放在 adapter metadata 之前，导致一个看似已知的模型名可以覆盖实际接入环境提供的信息。

模型名称不是可靠的能力身份。同一个名称可能经过代理、OpenAI-compatible gateway、区域路由、账户策略或供应商 alias 指向不同后端；供应商也可以不改变名称就调整实际窗口、输出限制或缓存行为。静态目录只能描述某个时间点的公开产品规格，不能证明当前 `baseURL + account + route + model alias` 的真实能力。

因此，内置目录会把 unknown 伪装成 known，并进一步影响：

```text
上下文百分比
→ proactive auto trigger
→ hard-limit block
→ capability disclosure budget
→ summary request admission
→ prompt-cache/usage 行为判断
```

这与 ADR-0022“不依赖客户端猜测真实窗口、manual 始终可尝试”的方向冲突。

## 决策

本 ADR 一旦 accepted，采用以下决定。

### 1. 删除静态模型能力目录

删除 `BUILTIN_MODEL_CAPABILITIES`，并禁止在 Core 中新增按模型名称匹配的 context window、max output、tokenizer、usage metadata 或 prompt-cache capability 表。

内置 Provider/模型列表可以继续用于首次启动、默认选择和 UI 枚举，但只能保存身份与选择信息：

```ts
interface BuiltinModelIdentity {
  provider: string;
  name: string;
  isDefault: boolean;
}
```

不得携带或向 `ResolvedModelCapabilities` 注入：

```text
contextWindow
maxOutputTokens
tokenizerFamily
supportsUsageMetadata
supportsPromptCache
```

`DEFAULT_DEEPSEEK_MODELS`、`builtInProvider()`、`getAvailableModels()` 和其他默认目录中的同类静态字段必须一并审查；不能只删除常量后从另一张内置表继续回填。

### 2. 能力只接受三类来源

字段级解析优先级固定为：

1. `explicit_config`：用户在当前选中模型条目中显式配置；
2. `adapter_runtime`：实际 adapter 针对当前 endpoint/route/model 返回的运行时 metadata；
3. `compatibility_config`：用户通过 `modelKwargs` 显式提供的兼容字段。

不存在以上来源时保持 unknown。禁止使用模型名称、provider type、公开规格、SDK 静态目录或“常见默认值”补齐。

`adapter_runtime` 必须来自实际接入环境。若 adapter 只是根据模型名称查询其编译期目录，该值仍属于 builtin catalog，不得标记为 runtime metadata。

用户显式配置优先于 adapter runtime，是因为用户可能知道当前代理或供应商对公开模型规格进行了收缩。`modelKwargs` 仅作为兼容入口，新的配置应使用模型条目正式字段。

### 3. ResolvedModelCapabilities 保留字段来源

`ResolvedModelCapabilities` 继续作为 provider-neutral 聚合对象，但每个可选字段必须能说明来源：

```ts
type ModelCapabilitySource =
  "explicit_config" | "adapter_runtime" | "compatibility_config";

interface ResolvedCapability<T> {
  value: T;
  source: ModelCapabilitySource;
}

interface ResolvedModelCapabilities {
  providerName: string;
  modelName: string;
  contextWindow?: ResolvedCapability<number>;
  maxOutputTokens?: ResolvedCapability<number>;
  tokenizerFamily?: ResolvedCapability<string>;
  supportsUsageMetadata?: ResolvedCapability<boolean>;
  supportsPromptCache?: ResolvedCapability<boolean>;
}
```

具体代码可以采用扁平字段加 `sources` map，但语义必须等价。Unknown 必须使用字段缺失表示，不能把 `supportsPromptCache: false` 与“未知是否支持”混为一谈。

### 4. 未知窗口不产生利用率、ratio trigger 或 hard block

当 `contextWindow` unknown 时：

- `/context` 和 TUI 只显示绝对 approximate size，不显示百分比；
- warning/compact/hard utilization 均为 unknown；
- 不运行基于 ratio 的 proactive auto compaction；
- 不基于本地 estimate 创建 hard-limit block；
- 不声称请求一定能被 Provider 接受；
- Provider failure 按 ADR-0022 直接展示，不推断 overflow。

如果产品仍需要在 unknown window 下自动压缩，必须由用户显式配置一个绝对阈值，例如 `compactAfterEstimatedTokens`。该阈值是用户选择的本地策略，不是模型能力，也不得反向写入 `ResolvedModelCapabilities.contextWindow`。Absolute policy 只能产生 `auto_soft`；没有可信窗口时不存在本地 `auto_hard`。

自动压缩默认关闭。开启 ratio auto 时必须存在已解析的 `contextWindow`；开启 absolute auto 时必须存在显式绝对阈值。两者均只改变触发时机，不改变 ADR-0022 的单次 summary 管线。

Auto rollout policy 与模型能力分离。`off/shadow/soft/soft_hard`、percentage、cohort salt 和 allowlist 都是发布策略，不得写入 `ResolvedModelCapabilities`。Unknown-window cohort 在任何 mode 下最多运行 `auto_soft`；可信窗口达到 hard limit 时，本地安全门禁可以独立于 auto summary rollout 直接 fail closed。只有 `soft_hard` mode 才允许先自动尝试 `auto_hard` summary。

### 5. Token estimate 与 tokenizer capability 解耦

Kite 仍需要确定性估算来比较 before/after、限制 summary source 和展示大致上下文大小，但该估算不需要伪装成模型精确 tokenizer。

- 显式配置或 adapter runtime 提供受支持的 `tokenizerFamily` 时，可以使用对应 estimator。
- tokenizer unknown 时使用统一、稳定、provider-neutral 的 approximate estimator。
- 同一次 candidate validation 的 before/after 必须使用同一 estimator version。
- Approximate estimate 可以判断相对缩减和应用级资源上限，不能证明 Provider admission 或真实 utilization。
- UI、日志和 metrics 必须携带 `estimatorKind`/`estimatorVersion` 与 approximate 标记。

禁止仅根据模型名称选择 tokenizer family。`cl100k_base`、`o200k_base` 或其他 family 不得成为未知模型的隐式默认事实。

### 6. 输出 reservation 只使用实际请求或可信来源

普通模型请求的输出 reservation 优先使用该次请求实际发送的 `maxOutputTokens`。若请求未显式设置，可以使用显式配置或 adapter runtime 值；否则保持 unknown，不通过内置目录或任意 `4096` 默认值声称已计算出真实 usable window。

Manual summary 使用 compaction policy 实际传给 Provider 的 `maxSummaryTokens`，因此不依赖模型目录中的 `maxOutputTokens`。

### 7. Capability disclosure 使用保守独立策略

Capability catalog disclosure 不再从内置模型窗口推导预算。

- context window known 时，可按明确 policy 使用其一小部分，但记录 capability source；
- context window unknown 时，使用固定、保守的应用级 disclosure budget；
- disclosure budget 不能反向证明模型窗口；
- Tool authorization、binding 和执行语义不受模型能力 unknown 影响。

### 8. Usage 与 Prompt Cache 使用运行时观测

`supportsUsageMetadata` 和 `supportsPromptCache` 不从模型名称推断。

- 显式配置可以声明预期支持；
- adapter runtime 可以声明实际支持；
- Provider response 出现 usage/cache 字段时可以记录本次观测；
- 未声明或未观测时保持 unknown；
- cache metric 缺失不能影响请求正确性或 compaction acceptance。

运行时观测可以用于诊断和后续请求优化，但不得在没有稳定 provider contract 时自动持久化为全局模型事实。

## 备选方案

### 继续维护内置目录并定期更新

实现简单，也能让已知官方模型默认显示百分比。但它无法覆盖代理、alias、账户限制和供应商临时调整，更新时间再快也不能证明实际路由能力，因此不采用。

### 内置目录降级到 adapter metadata 之后

比当前优先级更合理，但仍会把缺失值补成未经当前环境确认的事实。对于 auto trigger 和 hard block，错误的 known 比 honest unknown 更危险，因此不采用。

### 从任意 Provider 400 反推窗口

错误原因不稳定，也无法区分 schema、参数和网关限制。ADR-0022 已决定 Core 不推断通用 400，因此不采用。

### 强制所有用户配置 contextWindow

能够恢复 ratio auto，但增加配置负担，也不能保证用户填写准确。Manual 不应依赖该字段；auto 需要时由用户选择显式配置或 absolute threshold。

### 完全删除 ResolvedModelCapabilities

可以进一步简化，但显式配置和真正的 runtime metadata 仍需要统一投影给 TUI、preflight 和 capability disclosure。保留聚合对象，删除不可信来源。

## 后果

### 正面后果

- 不再因官方规格或模型名相同而错误判断真实供应商窗口。
- `/context`、auto trigger、hard block 和 disclosure 使用同一套可解释来源。
- Manual compaction 在 capability unknown 时仍可工作。
- Provider alias、代理和私有部署默认得到 honest unknown，而不是错误的已知值。
- Token estimate 明确区分相对估算与 Provider admission。

### 负面后果

- 默认模型在未配置时不再显示上下文百分比。
- Ratio-based auto 对更多模型保持不可用。
- 用户若需要准确百分比或 ratio auto，需要显式配置窗口或依赖真实 runtime metadata。
- Adapter 和 UI 需要处理 tri-state capability，而不是简单 boolean/number 默认值。

### 风险控制

- TUI 提供清晰的 unknown/approximate 表示，不把未知误报为故障。
- Auto 默认关闭；没有可信窗口时仍可选择显式 absolute threshold。
- Manual summary 使用应用级 bounded prefix，不依赖能力目录。
- Tests 必须覆盖知名官方模型名在无显式/runtime metadata 时仍为 unknown。

## 实施顺序

1. 本 ADR accepted。
2. 更新 active model-provider、capability disclosure 和配置文档。
3. 为 `ResolvedModelCapabilities` 增加字段级 source/unknown 语义。
4. 删除 `BUILTIN_MODEL_CAPABILITIES` 及其他内置窗口/输出/tokenizer/cache 字段。
5. 更新 `/context`、TUI、auto decision、hard block、disclosure 和 metrics。
6. 增加 explicit/runtime/compatibility/unknown 的 table-driven tests。
7. 再进入 ADR-0022 的 auto shadow/canary。

## 回滚

关闭 `contextCompactionAutoV1` 会停止 shadow、`auto_soft` 和 `auto_hard` summary，但不会恢复旧内置 capability，也不会关闭可信窗口下独立的 hard-limit safety。由于当前 agent 尚未正式上线，不为旧内置 capability 行为提供兼容开关；开发期配置和测试直接更新。

如果本 ADR 在实现前被拒绝，保留当前 resolver 和 active 文档，不产生运行时变化。
