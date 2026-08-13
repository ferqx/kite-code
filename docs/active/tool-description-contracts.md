# 当前规则：工具描述即契约

状态：active
最后更新：2026-08-12
最后验证：2026-08-12
范围：

- `src/core/tools/tool-contracts.ts`
- `src/core/tools/registry/builtins/`
- `src/core/tools/definitions.ts`（description 字段）
- `src/core/harness/tool-runner.ts`（恢复指导投影）
- `tests/tool-definitions.test.ts`、`tests/tools/tool-registry-conformance.test.ts`（契约验证测试）

读取时机：

- 创建或修改工具定义，包括新增工具、调整 schema 或修改 description。
- 修改 `src/core/tools/tool-contracts.ts` 中的契约结构或内容。
- 修改工具的实际行为（`src/core/tools/file.ts`、`src/core/tools/shell.ts`），需要同步更新契约。
- 修改 `src/core/harness/tool-runner.ts` 中的工具执行逻辑、错误处理或恢复指导。
- 新增工具注册到 `src/core/tools/registry/builtins.ts`。

相关：

- `./tool-gated-autonomy.md`
- `docs/space/execution/completed/2026-05-06-tool-description-contracts.md`
- `docs/space/understanding/space-system-design.md`

验证：

- `bun test tests/tool-definitions.test.ts tests/tools/tool-registry-conformance.test.ts tests/tool-parse-error.test.ts tests/git-broker.test.ts tests/runtime/git-tool-controller.test.ts`
- `bun run typecheck`

## 规则

### 核心原则

工具描述是 ACI（Agent-Computer Interaction）一等 UX，投资程度应与 HCI 等同。每份工具描述必须是可验证的契约，而不仅仅是功能说明。

### 契约结构

ToolSpec 的规范契约是 `ToolContractSection`：`summary`、`useWhen`、`returns`、`constraints`、`recovery` 五类独立事实。`returns.format` 必须是模型实际看到的 `text | json | interrupt`，其 description 和 fields 必须与 `projectResult()` 或 `createInterrupt()` 一致；禁止为了统一外观虚构 `{ok, content, error}`。

20 个 production builtin ToolSpec 已全部绑定规范结构化事实。旧四段式 `LegacyToolContractSection` 只保留给外部/测试 Registry 的读取兼容；`normalizeToolContract()` 是唯一兼容层，不得把 legacy 输入重新写入 builtin，也不得维护 legacy/V2 两套互相独立的工具事实。

### 契约存放与绑定

- `BUILTIN_TOOL_CONTRACTS` 是当前 20 个 builtin 的规范事实表；各 ToolSpec 直接或通过兼容命名常量绑定其中同一对象，Skill runtime 三工具同样不得另写契约。
- `buildDescription(contract, version)` 从同一组独立事实生成 legacy 或 V2 文本。被拒绝的 candidate 文案及其恒等 production profile 已移除；后续文案实验必须在 evaluator 内显式注入，不得把无行为差异的 profile 贯穿 ToolSpec、Registry 与生产上下文。ADR-0098 默认启用已发布 V2，legacy 可用 `promptContractV2=false` 回滚。V2 逐项投影 selection、参数约束、真实返回格式与恢复语义，不再靠截取旧文案第一句保存关键规则。
- `definitions.ts` 只能投影 Registry，不得硬编码另一份 description。
- Runner 的失败指导只能读取 `spec.contract.recovery` 的规范化结果；禁止维护按工具名分支的第二份 recovery guidance。
- V2 单工具 description 受 token/长度测试约束；确有必要的输入边界和恢复说明可以保留，不能用强制替代工具名、失败关键词或固定段数充数。
- `task` 的兼容契约首句必须保留权威与角色边界：只有当前用户显式要求有界、自包含委派且该工具已披露时才要求委派，架构或设计规划使用只读 `plan`；code 必须有明确写/编辑授权。V2 的完整 role schema 在 Planning/Building 保持稳定，Planning 中 code/review 由 Runtime Policy 返回 phase constraint；legacy rollback 仍可使用 explore/plan-only planning schema。public JSON 只额外允许成功 planning plan child 产生 governed `nextActions`，不得让字段表与文字说明漂移。
- `git_inspect` 仅描述 status/diff/log/branch-list 的 typed broker；不能把 raw shell、Git 写操作或 remote Git 写成 fallback。

### Registry 迁移边界（ADR-0043）

工具契约由 ToolSpec Registry（`src/core/tools/registry/`）绑定并投影；新增 builtin 一律先向 `KNOWN_TOOL_NAMES` 与 `BUILTIN_TOOL_CONTRACTS` 增加完整结构化事实，再注册 ToolSpec。模型表面 description、Runner recovery guidance 与 capability descriptor 都必须从该 ToolSpec 契约派生，确定性由 `tests/tools/tool-registry-conformance.test.ts` 守护。

Registry conformance 必须枚举当前 20/20 builtin，并在 legacy/V2 × planning/building 的合法 availability context 中验证：Skill catalog、active frame、task adapter、tool search 与 phase/role 都必须是真实可用形态；可用集合与投影一致，description 来自同一 resolved contract，provider JSON Schema validation 与 Registry `parseToolCall()` 分别验证有效、无效及 unknown-field 输入，不能只把两个同源 `safeParse({})` 结果互相比较。

20 个工具还必须逐一执行真实 `projectResult()`（interrupt 工具执行 `createInterrupt()`），再经过 Controller 的 canonical `tool.finished` 投影、Runtime reducer 与 provider context projection。`returns.format=json` 的真实顶层 key 必须全部位于 contract fields；`text` 不得虚构 `ok/stdout/stderr/resultMeta` 字段。Registry-owned classifier advice 必须随统一执行结果进入同一个 canonical terminal，不能在 Runner 重建或丢失。父 Runtime reducer 与 Subagent provider context 必须调用唯一的 Runtime-owned public model-content helper：success 固定为 `stdout || stderr || ''`，failure 固定为 `stderr || stdout || ''`，并接收 `ok` 与 terminal status 防止状态分支漂移；success/failure × stdout 空/非空 × stderr 空/非空的八组合必须保持同构。Shell failure 还必须从真实 `runApprovedTool` 经过 Controller terminal、Kernel reducer 到 provider context，逐项等于 `shellExecuteSpec.projectResult()` 与 `returns.format=text`，20/20 closure 不能只靠预折叠 terminal fixture。不得把完整执行结果 JSON 化进 child transcript，也不得额外暴露 command/path/resultMeta、private recovery guidance 或 canonical-private lineage。`read_file` 的 ENOENT 公共结果固定为低信息稳定文本，具体 path 已由原 tool call 表达，不能在 Tool Result 重复泄露。

### 契约与实现的同步

- 修改工具实现行为时必须同步更新对应结构化事实。
- 修改执行结果格式、错误信息或恢复语义时，必须检查 `returns`、`constraints` 和 `recovery` 是否一致。
- 修改静态工具的模型结果、截断、diff 或结构化元数据时，必须在对应 `spec.projectResult()` 中完成；Runner/Controller 只消费投影。
- 新增工具时必须先创建 ToolSpec 契约，再在生产 Registry 中注册；`definitions.ts` 只投影 Registry，不得再次枚举静态工具名。
- strict schema 剥离 unknown field 前只允许记录 `hasUnknown/count/toolClass/schemaRevision` 低基数观测；字段名和值不得进入 Session、telemetry 或 eval。

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
- legacy/V2 description 必须从同一规范事实生成；不得为已回滚的文案 candidate 保留恒等 production profile，也不得复制一套与主 first-decision 近似相同的 live 工具 fixture。
- 每个 ToolSpec 的 `projectResult()` 与 `returns.format`、字段声明一致；interrupt 工具与内部请求协议一致。
- context-sensitive schema 的模型投影和调用解析使用同一个 resolved schema。
- V2 Planning/Building 的完整 builtin 名称、description、JSON schema 恒等；legacy planning 的 task 子类型差异与字段 description 仍被确定性覆盖。
- `shell_execute` 契约专项覆盖纯命令形态驱动的审批拒绝与恢复场景；契约不得再要求模型提交 `intent`、授权建议或 prefix rule。
