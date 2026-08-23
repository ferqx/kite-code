# 当前规则：工具描述即契约

状态：active
最后更新：2026-08-21
最后验证：2026-08-21
范围：

- `packages/builtin-runtime/src/tool-contracts.ts`
- `packages/builtin-runtime/src/tool-schemas.ts`
- `packages/builtin-runtime/src/tool-catalog.ts`
- `apps/kite/src/bootstrap/runtime/tool-pipeline-composition.ts`（App composition bridge）
- `tests/helpers/governed-tool.ts`（严格 test-only 的旧执行兼容体，不属于 production authority）
- `tests/tool-definitions.test.ts`、`tests/tool-parse-error.test.ts`、
  `packages/builtin-runtime/test/builtin-runtime.test.ts`（契约与 catalog 验证测试）

读取时机：

- 创建或修改工具定义，包括新增工具、调整 schema 或修改 description。
- 修改 `packages/builtin-runtime/src/tool-contracts.ts` 中的契约结构或内容。
- 修改工具的实际行为（`packages/builtin-runtime/src/git/runtime-module.ts`、
  `packages/builtin-runtime/src/planning/runtime-module.ts` 或 Builtin sandbox consumer），需要同步更新契约。
- 修改 `tests/helpers/governed-tool.ts` 中仅供测试的执行兼容、错误处理或恢复指导。
- 新增 Builtin operation 到 `packages/builtin-runtime/src/model/runtime-module.ts`、
  `packages/builtin-runtime/src/git/runtime-module.ts`、`packages/builtin-runtime/src/planning/runtime-module.ts`、
  `packages/builtin-runtime/src/subagent/runtime-module.ts` 或 `packages/builtin-runtime/src/verification/runtime-module.ts`。

相关：

- `./tool-gated-autonomy.md`
- `../adr/0118-trusted-workspace-unrestricted-file-access.md`
- `docs/space/execution/completed/2026-05-06-tool-description-contracts.md`
- `docs/space/understanding/space-system-design.md`

验证：

- `bun test packages/builtin-runtime/test packages/runtime-spi/test packages/runtime-host/test tests/runtime`
- `bun run typecheck`

## 规则

### 核心原则

工具描述是 ACI（Agent-Computer Interaction）一等 UX，投资程度应与 HCI 等同。每份工具描述必须是可验证的契约，而不仅仅是功能说明。

当前单一事实源是已冻结的 `CapabilityRegistrySnapshot`：
`createBuiltinToolCatalogProjection()` 从同一 SPI snapshot 投影模型 ToolSet、parser/canonicalizer、
availability、effects、traits、descriptor 与 operation/executor revision。包测试机械断言该 projection 的 29
个 operation 中恰有 20 个 `visibility: model` 和 9 个 `visibility: internal`，并逐项比较 schema、revision、
executor revision 与 effects；这些数字不是手工文档事实。App Tool Pipeline 与 Tool Controller 只消费 projection，不能重新声明
schema、parser、effects 或 executor owner。旧 Core Tool Runner 已物理删除；Kernel 只拥有 governance/admission decision。
源码 caller/owner closure 已切到唯一 Builtin/Host/App seams，RM-16 final
manifest/docs/journey/fault/soak Gate 已完成；本节 owner transfer 是当前生产事实。

机械证据来自 Builtin/SPI package tests 与 Runtime manifest checks；schema parity 与 App/Host 行为测试另行执行，不能用手工数字替代。

### 契约结构

Builtin contract 的规范结构是 `ToolContractSection`：`summary`、`useWhen`、`returns`、`constraints`、`recovery` 五类独立事实。`returns.format` 必须是模型实际看到的 `text | json | interrupt`，其 description 和 fields 必须与 Builtin operation result projection 或 Kernel-owned user-input normalization 一致；禁止为了统一外观虚构 `{ok, content, error}`。

20 个 model-visible Builtin catalog entry 已全部绑定唯一的 `ToolContractSection` 结构化事实。不存在旧契约输入、双描述格式或回滚分支；`toolContractSection()` 只验证并返回当前结构。

### 契约存放与绑定

- `BUILTIN_TOOL_CONTRACTS`（`packages/builtin-runtime/src/tool-contracts.ts`）是当前 20 个 model-visible builtin 的规范事实表；各 Builtin definition 直接或通过兼容命名常量绑定其中同一对象，Skill runtime 三工具同样不得另写契约。
- `buildDescription(contract, style)` 只从同一组独立事实生成 standard 或 catalog 展示；style 不改变 schema、可用性或执行语义。后续文案实验必须在 evaluator 内显式注入，不得把无行为差异的 profile 贯穿 Builtin contract、SPI registry 与生产上下文。
- App composition bridge 只能投影 Builtin catalog 与独立 dynamic-MCP overlay，不得硬编码另一份 description；它不是 schema authority。
- 任何失败指导投影都只能读取 Builtin contract 的规范化 `recovery` 结果；禁止维护按工具名分支的第二份 recovery guidance。test-only 兼容体也必须遵守同一规则。
- 单工具 description 受 token/长度测试约束；确有必要的输入边界和恢复说明可以保留，不能用强制替代工具名、失败关键词或固定段数充数。
- `task` 契约首句必须说明只委派有界、自包含且值得隔离调用的工作；模型自主选择 role，架构或设计规划使用只读 `plan`，只读审查使用 `review`，仅在用户任务要求实施时使用 `code`。多个有价值且独立的任务应在同一响应中作为 sibling calls 派发，让 Runtime 在共享预算内有界并发；依赖前序结果的任务以及写范围重叠的 code tasks 必须串行。用户明确要求不委派时必须遵守。完整 role schema 在 Planning/Building 保持稳定，Planning 中 code/review 由 Runtime Policy 返回 phase constraint。public JSON 必须回传终态 `terminalStatus`（存在时）以区分 completed、failed、cancelled 与 exhausted；只额外允许成功 planning plan child 产生 governed `nextActions`，不得让字段表与文字说明漂移。
- `task` 的 raw 模型输入形态是严格闭合的 `{subagent_type, task}`；Model Controller 必须在 queue commit 前把正文写入 private Artifact，durable 形态只允许独立的 `{subagent_type, taskArtifact}` 严格分支。二者不得混合，否则 Builtin parser 与 Tool Pipeline 必须在 hydration、Provider 与 child dispatch 前返回 `invalid_arguments`。当前格式不恢复已持久化 raw Task，也不把 private 字段暴露到模型 schema。
- `git_inspect` 仅描述 status/diff/log/branch-list 的 typed broker；不能把 raw shell、Git 写操作或 remote Git 写成 fallback。
- 五个 filesystem 工具的 path 文案必须与 ADR-0118 一致：read/search 接受 Workspace-relative、absolute 与
  `~` 路径且不把外部读取描述成审批；write/edit 对受信任 Workspace 内路径可直接执行，对 Workspace 外
  路径说明需要 exact mutation approval。Schema/contract 不得继续声称 path 只能相对 Workspace，也不得把
  文件工具的开放语义扩写成 Shell/MCP/Git 权限。

### Builtin catalog 迁移边界（ADR-0043）

工具契约由 `packages/builtin-runtime/src/tool-contracts.ts` 与 Builtin operation definition 绑定，并由
`createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot()` →
`createBuiltinToolCatalogProjection()` 投影；新增 builtin 必须先在 Builtin definition 注册完整结构化事实，再进入
SPI registry。模型 surface、Runner recovery guidance 与 capability descriptor 必须来自同一 frozen projection。
`apps/kite/src/bootstrap/runtime/tool-pipeline-composition.ts` 只是 App composition bridge，不能成为第二 authority。
确定性由 `packages/builtin-runtime/test/builtin-runtime.test.ts`、`tests/tool-definitions.test.ts` 与 schema-parity 测试守护。

Builtin catalog conformance 必须枚举当前 20 个 model-visible entry 与 9 个 internal entry，并在
planning/building 的合法 availability context 中验证 Skill catalog、active frame、task adapter、tool search
与 phase/role 的真实可用形态；可用集合与 projection 一致，description 来自同一 resolved contract，Builtin parser
与 model JSON Schema projection 分别验证有效、无效及 unknown-field 输入，不能只把两个同源 `safeParse({})`
结果互相比较。dynamic MCP 仍是独立的 binding/descriptor route，不计入 Builtin 20 个 model tools。

20 个 model-visible entry 还必须逐一执行真实 Builtin projection/result path；`ask_user` 必须验证
`normalizeAskUserRequest()` 的 Kernel-owned interrupt 输入路径并保持 catalog dispatch 零调用，再经过 Controller 的 canonical `tool.finished` 投影、Runtime reducer 与 provider context
projection。`returns.format=json` 的真实顶层 key 必须全部位于 contract fields；`text` 不得虚构
`ok/stdout/stderr/resultMeta` 字段。Builtin classifier advice 必须随统一执行结果进入同一个 canonical terminal，
不能在 Runner 重建或丢失。父 Runtime reducer 与 Subagent provider context 必须调用唯一的 Runtime-owned
public model-content helper；Shell failure 的 production path 必须从
Host prepared authority 经过 App Tool Pipeline terminal、Kernel reducer 到 provider
context，逐项等于 Builtin projection。旧 Core `invokeGovernedTool()` 已删除；测试 helper
只存在于 `tests/helpers/`，production source 不得导入。20/20 closure
不能只靠预折叠 terminal fixture。不得把完整执行结果 JSON 化进 child transcript，也不得额外暴露
command/path/resultMeta、private recovery guidance 或 canonical-private lineage。`read_file` 的 ENOENT 公共结果固定
为低信息稳定文本，具体 path 已由原 tool call 表达，不能在 Tool Result 重复泄露。

`read_file` 省略 `limit` 时默认读取最多 2000 个源行；无论模型提供多大的显式 `limit`，
Builtin result projection 的完整文本（含 marker）都必须保持在 64 KiB 字符内。多行截断 marker 只能
给出最后一个完整可见源行之后的准确 continuation offset；单行超限必须标记该行被 clipped，
并明确 line offset 无法在行内无损续读。`resultMeta` 同时声明 `truncated` 和截断前结果摘要，
完整 `rawContent` 只供 read-state 指纹使用，不属于模型结果契约。

### 契约与实现的同步

- 修改工具实现行为时必须同步更新对应结构化事实。
- 修改执行结果格式、错误信息或恢复语义时，必须检查 `returns`、`constraints` 和 `recovery` 是否一致。
- 修改静态工具的模型结果、截断、diff 或结构化元数据时，必须在对应 Builtin result projection 中完成；Runner/Controller 只消费投影。
- 新增工具时必须先创建 Builtin contract，再在唯一 SPI registry 中注册；App bridge 只投影 catalog，不得再次枚举静态工具名。
- strict schema 剥离 unknown field 前只允许记录 `hasUnknown/count/toolClass/schemaRevision` 低基数观测；字段名和值不得进入 Session 或 telemetry。

### `ask_user` 模型输入边界

`ask_user` 的模型参数只有一种规范形态：顶层必须且只能使用 `questions` 数组，单问题也是长度为 1 的数组。每次调用包含 1-3 个问题，每个问题包含 `question` 和 2-3 个 `{label, description, recommended}` 选项，且必须有且仅有一个选项设置 `recommended: true`，其余选项设置为 `recommended: false`。模型不得提交顶层 `question`/`options`、`recommended` 或 `allow_free_text`，也不得显式添加 `Other` 选项。

Builtin catalog 的输入 schema/parser 只描述并校验上述模型形态，不得使用无法稳定投影为 JSON Schema 的 transform。`normalizeAskUserRequest()` 在 schema 校验后生成稳定的问题/选项 ID，并根据选项上的 `recommended: true` 派生内部推荐项，再为普通模型提问启用客户端自由输入，再产生内部 `UserInputRequest`。TUI、系统恢复交互与历史回放继续消费内部协议，因此可以保留 `allow_free_text=false` 等非模型控制能力。

`ask_user` 只属于主 Agent 的模型工具面。`task` 必须在派发前携带已澄清的自包含指令；所有 child role 都从工具声明中移除 `ask_user`。若仍缺少必要前提，child 必须在最终结果中报告给 parent，不得打开或转交用户交互。Full/Plan 模式允许提问仅指主 Agent 可在委派前调用 `ask_user`。

### Plan 工具契约边界

`write_plan` 新写入 V2 Plan，标题/step title 为单行、正文至少 20 字符、step ID 唯一且总数不超过
12。首次保存由 Runtime 创建 identity；后续 save、submit 与 executing replan 都要求模型原样回传
`plan_id + version + structural_digest`。`update_plan` 也要求同一完整 identity，并只接受 step progress、
note、skipped reason code 与 `complete_plan`；其 strict schema 必须拒绝 command、path、stdout、
`completion_evidence` 和模型自报 success。完成证据由 Runtime terminal Tool/Verification/Approval 事实
投影，且 all-skipped Plan 不得完成。Approval Tool Result 顶层返回完整
`plan_id + version + structural_digest` identity；工具契约只能说明这些 metadata-only 返回/拒绝语义，
不能让模型提供证据正文。

## 不要做

- 不要在 App composition bridge 或 Controller 中硬编码第二份 description。
- 不要把契约字段视为营销文案；它们必须反映实际模型投影，不能美化或隐藏限制。
- 不要修改工具实现后不同步更新契约。
- 不要新增工具却不创建对应契约。
- 不要用“必须提及替代工具”“必须出现失败关键词”“必须声明 ok JSON”等膨胀启发式代替真实性测试。

## 测试期望

`tests/tool-definitions.test.ts` 中 `tool contracts (ACI)` describe 块应断言：

- 每个注册工具都有可归一化的结构化契约。
- standard/catalog description 都由同一事实生成并保持在预算内。
- 不得为已删除的文案 candidate 保留 production profile，也不得复制一套与主 first-decision 近似相同的 live 工具 fixture。
- 每个 Builtin operation 的 result projection 与 `returns.format`、字段声明一致；`ask_user` 与 Kernel/TUI 内部请求协议一致。
- context-sensitive schema 的模型投影和调用解析使用同一个 resolved schema。
- Planning/Building 的完整 builtin 名称、description、JSON schema 恒等；phase/role 的拒绝由 Runtime Policy 确定性覆盖。
- `shell_execute` 契约专项覆盖纯命令形态驱动的审批拒绝与恢复场景；契约不得再要求模型提交 `intent`、授权建议或 prefix rule。
