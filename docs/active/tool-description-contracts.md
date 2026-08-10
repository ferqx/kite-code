# 当前规则：工具描述即契约

状态：active
最后更新：2026-08-09
最后验证：2026-08-09
范围：

- `src/core/tools/tool-contracts.ts`
- `src/core/tools/definitions.ts`（description 字段）
- `tests/tool-definitions.test.ts`（契约验证测试）

读取时机：

- 创建或修改工具定义，包括新增工具、调整 schema 或修改 description。
- 修改 `src/tools/tool-contracts.ts` 中的契约结构或内容。
- 修改工具的实际行为（`src/core/tools/file.ts`、`src/core/tools/shell.ts`），需要同步更新契约。
- 修改 `src/harness/tool-runner.ts` 中的工具执行逻辑、错误处理或 `toolUsageGuidance()`。
- 新增工具注册到 `src/core/tools/registry/builtins.ts`。

相关：

- `./tool-gated-autonomy.md`
- `docs/space/execution/completed/2026-05-06-tool-description-contracts.md`
- `docs/space/understanding/space-system-design.md`

验证：

- `bun test tests/tool-definitions.test.ts`
- `bun run typecheck`

## 规则

### 核心原则

工具描述是 ACI（Agent-Computer Interaction）一等 UX，投资程度应与 HCI 等同。每份工具描述必须是可验证的契约，而不仅仅是功能说明。

### 契约结构

ToolSpec 的规范契约是 `ToolContractSection`：`summary`、`useWhen`、`returns`，以及按需提供的 `constraints`、`recovery`。`returns.format` 必须是模型实际看到的 `text | json | interrupt`，其 description 和 fields 必须与 `projectResult()` 或 `createInterrupt()` 一致；禁止为了统一外观虚构 `{ok, content, error}`。

迁移期仍可读取旧的四段式 `LegacyToolContractSection`。`normalizeToolContract()` 是唯一兼容层，将旧事实确定性归一为结构化契约；不得维护 legacy/V2 两套互相独立的工具事实。

### 契约存放与绑定

- 契约跟随 ToolSpec 存放；尚未迁移的常量继续集中在 `src/core/tools/tool-contracts.ts`。
- `buildDescription(contract, version)` 从同一契约生成 legacy 或 V2 concise 文本。`promptContractV2=false` 保持 wire-compatible legacy 表达；V2 使用有界的摘要、使用条件、真实返回格式和必要约束/恢复说明。
- `definitions.ts` 只能投影 Registry，不得硬编码另一份 description。
- V2 单工具 description 受 token/长度测试约束；确有必要的输入边界和恢复说明可以保留，不能用强制替代工具名、失败关键词或固定段数充数。
- `task` 的兼容契约首句必须保留权威与角色边界：只有当前用户显式要求有界、自包含委派且该工具已披露时才要求委派，架构或设计规划使用只读 `plan`。Planning 的 context-sensitive schema 重写 `subagent_type` 枚举时必须保留字段 description，避免 V2 精简 description 与 JSON Schema 同时丢失角色选择依据。

### Registry 迁移边界（ADR-0043）

工具契约的单一事实源正从 `tool-contracts.ts` 迁移到 ToolSpec Registry（`src/core/tools/registry/`）。迁移期规则：

- 未迁移工具：契约继续写在 `tool-contracts.ts`，由归一化兼容层消费。
- 已迁移工具：契约移入 `spec.contract`，`description` 仍由 `buildDescription()` 生成。
- 新增工具一律直接注册到 Registry；模型表面 description 的确定性由 `tests/tools/tool-registry-conformance.test.ts` 守护。

### 契约与实现的同步

- 修改工具实现行为时必须同步更新对应结构化事实。
- 修改执行结果格式、错误信息或恢复语义时，必须检查 `returns`、`constraints` 和 `recovery` 是否一致。
- 修改静态工具的模型结果、截断、diff 或结构化元数据时，必须在对应 `spec.projectResult()` 中完成；Runner/Controller 只消费投影。
- 新增工具时必须先创建 ToolSpec 契约，再在生产 Registry 中注册；`definitions.ts` 只投影 Registry，不得再次枚举静态工具名。

### `ask_user` 模型输入边界

`ask_user` 的模型参数只有一种规范形态：顶层必须且只能使用 `questions` 数组，单问题也是长度为 1 的数组。每次调用包含 1-3 个问题，每个问题包含 `question` 和 2-3 个 `{label, description, recommended}` 选项，且必须有且仅有一个选项设置 `recommended: true`，其余选项设置为 `recommended: false`。模型不得提交顶层 `question`/`options`、`recommended` 或 `allow_free_text`，也不得显式添加 `Other` 选项。

ToolSpec 的输入 Schema 只描述并校验上述模型形态，不得使用无法稳定投影为 JSON Schema 的 transform。`createInterrupt()` 在 Schema 校验后生成稳定的问题/选项 ID，并根据选项上的 `recommended: true` 派生内部推荐项，再为普通模型提问启用客户端自由输入，再产生内部 `UserInputRequest`。TUI、系统恢复交互与历史回放继续消费内部协议，因此可以保留 `allow_free_text=false` 等非模型控制能力。

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

- 不要在 `definitions.ts` 中硬编码第二份 description。
- 不要把契约字段视为营销文案；它们必须反映实际模型投影，不能美化或隐藏限制。
- 不要修改工具实现后不同步更新契约。
- 不要新增工具却不创建对应契约。
- 不要用“必须提及替代工具”“必须出现失败关键词”“必须声明 ok JSON”等膨胀启发式代替真实性测试。

## 测试期望

`tests/tool-definitions.test.ts` 中 `tool contracts (ACI)` describe 块应断言：

- 每个注册工具都有可归一化的结构化契约。
- legacy/V2 description 都由同一事实生成，V2 保持在预算内。
- 每个 ToolSpec 的 `projectResult()` 与 `returns.format`、字段声明一致；interrupt 工具与内部请求协议一致。
- context-sensitive schema 的模型投影和调用解析使用同一个 resolved schema。
- Planning/Building 工具集合、task 子类型差异以及 planning schema 的角色 description 被确定性覆盖。
- `shell_execute` 契约专项覆盖纯命令形态驱动的审批拒绝与恢复场景；契约不得再要求模型提交 `intent`、授权建议或 prefix rule。
