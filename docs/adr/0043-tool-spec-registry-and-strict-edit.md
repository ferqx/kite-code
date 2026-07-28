# ADR-0043：工具单一事实源（ToolSpec Registry）与严格 Edit 语义

状态：accepted
日期：2026-07-26
补充：ADR-0007、ADR-0020、ADR-0042
关联：`docs/design/2026-07-26-tool-spec-registry-rfc.md`、`docs/active/tool-description-contracts.md`、`docs/active/tool-gated-autonomy.md`

## 背景

每个模型工具的完整事实散落在至少八处并全部手工同步：模型 Schema 与部分执行器（`tools/definitions.ts`）、自然语言契约（`tools/tool-contracts.ts`）、请求联合类型与手写解析（`harness/tool-requests.ts`）、执行分支（`harness/tool-runner.ts`）、副作用分类（`policies/tool-capabilities.ts`）、风险评估（`policies/approval-policy.ts`）、路由（`controllers/tool-controller.ts`）、审批载荷（`harness/tool-policy.ts`）。仓库自己的两份提案（`docs/space/plans/2026-07-01-web-search-tool.md`、`docs/design/2026-07-19-mcp-tool-inventory-rfc.md`）把"每新增一个工具同步 6-13 处"制度化了。

2026-07-26 核实的漂移证据：

1. `edit_file` 的 `match_mode` 参数在 Schema 和契约中暴露（且契约主动指导模型使用），但请求解析与执行器全部丢弃——模型合法生成的参数被静默忽略。
2. `read_file` 二进制检测错误要求模型 "Use force: true to read anyway"，但模型表面、请求类型和执行链都不暴露 `force`——恢复路径永远不可达。
3. `definitions.ts` 同时存在真实 `execute`、占位 `execute`（`"Handled by tool runner."`）和 schema-only 三种工具形态；生产链路走 runner 的另一套分支，测试却直调模型 ToolSet 的 `execute()`，验证的不是生产链。
4. 旧 `Skill` 工具已不存在于模型表面，但请求类型、解析分支、controller 拒绝分支、Policy 只读集合、审批分支和 TUI 映射仍保留；不存在的 `list_files` 出现在两处 Policy 集合；`toolRequestFromMessage()` 零调用。
5. `shell_execute` 契约用权限式 "NEVER" 措辞禁止 `grep/rg/find`，而 Policy 按命令形态将其列为只读安全命令——描述在用劝诫承担 Policy 职责。
6. `shell_execute` 允许模型通过 `intent`/`grant_request`/`prefix_rule` 等参数自我声明副作用等级、提议持久授权规则——而副作用分类本已由命令形态分析完成，不依赖这些参数。
7. `ask_user` 契约把 "harness 会拦截并返回 ok:false" 的内部实现泄漏给模型。

ADR-0042 已决定 edit 先读后改（§1）与移除 append（§2），但其 §4（preimage）落地后，§1/§2 因缺少单一落点而未实施。同时 ADR-0042 保留了 `old_string` 的"自然校验"，而实际实现的 `findMatch()` 存在无条件降级链（exact → trimEnd → 逐行 trimming），使 Receipt 无法表达"模型意图 vs 实际匹配"的差异。

## 决策

### 1. 建立唯一 ToolSpec Registry

每个静态工具由单一 `ToolSpec` 定义：模型名、契约文本（whenToUse / commonMistakes / outputFormat / failureHandling）、输入 Schema、可用性谓词、副作用分类、执行前置钩子、执行器、结果投影与展示提示。以下产物全部从 Registry 派生，不再手写：

- 模型 ToolSet（**全部 schema-only**，使用 AI SDK `tool()` 的无 `execute` 重载；动态 MCP 工具继续使用 `dynamicTool()` + binding 流程）；
- 工具调用解析（泛型替代 `toolRequestFromCall` 的逐工具 `if` 分支；解析后 `args` 恒等于 Schema 解析结果，禁止逐字段重映射）；
- `PendingToolRequest` 联合类型（派生；序列化形状 `{ id?, name, args, reason, protectedCommand }` 保持不变，保证 event store 回放兼容）；
- 执行分发（单一 dispatch 替代 `runApprovedTool` 分支表；Policy 预检上提为管线公共段）；
- `CapabilityDescriptor` 投影（`builtin_tool` kind，revision 复用内容哈希算法）；
- 契约描述（由契约小节生成，不存在第二份手写描述）。

`definitions.ts` 不再拥有真实 `execute()`。真实执行只允许经过 Registry dispatch。

### 2. 模型参数不承担治理职责

`shell_execute` 模型表面收敛为 `command` / `description` / `timeout_ms`（即现有 `ShellActionEnvelope` 删除 `intent`、`objective`、`justification`、`expected_observation`、`failure_strategy`、`prefix_rule`、`grant_request` 后的剩余字段，不新增能力）。配套：

- inspect 免审批快车道改为**纯命令形态驱动**（复用现有 `isReadOnlyShellCommand` 等分析），不信任模型自我分类；
- 执行 `action` 元数据从分类结果与授权层派生，不再回显模型声明；
- 授权规则提议（approve_once / same_command / full_access）保留在审批层由用户选择，模型不得经工具参数提议持久规则。

契约文本只说明工具职责、输入语义与关键约束，不承担权限控制、工具路由或恢复状态机职责。`ask_user` 契约删除 harness 拦截细节，改为行为描述；拦截由 `kind: 'interrupt'` 在 Registry 层表达。

### 3. Edit 严格化

- 删除模型表面的 `match_mode`（该参数今天即被丢弃，删除零行为变化）；
- `findMatch()` 的无条件降级链（exact → trimEnd → 逐行 trimming）改为**默认仅 exact**，模糊匹配降为内部显式 opt-in 或移除。匹配失败即失败，模型重新 `read_file` 后提交准确文本；
- 同期落地 ADR-0042 §1（先读后改 / 过期拒绝，作为 edit spec 的执行前置钩子）与 §2（删除 `write_file` 的 `mode` 参数与 append 分支），次序沿用 ADR-0042 的 §4（已落地）→ §1 → §2。

### 4. 模型可见工具名保持 snake_case

不改名为 Claude Code 风格（Read / Edit / Glob / Grep / Bash 等）。Kite 的权威执行身份是 `capabilityId + revision`，模型名只是 binding 暴露名，治理不键于名字；改名需要 event store 回放别名表、TUI 历史渲染、golden prompt 与全部测试迁移，成本与架构收益不匹配。命名对齐保留为独立可选后续项，如实施须经新 ADR 并走别名表。

### 5. 一致性不变量由机器校验

以下不变量以测试强制（与 Registry 同批落地），替代人工同步纪律：

- 解析后 `args` 恒等于 Schema 解析结果（杀死字段丢弃类 bug）；
- 模型 ToolSet 全部 schema-only；
- Policy / 分类引用的工具名 ⊆ Registry 名集；
- `KNOWN_TOOL_NAMES` ≡ Registry 名集 ∪ `mcp__*`；
- 写工具必产出 mutation scope 与 digest 输入；
- 描述是契约小节的纯函数；
- 动态工具 binding/turn/revision/schema 校验链保持；
- shell 分类不读取已删除的治理参数。

### 6. 保持不变的部分

MCP 动态工具的 binding/turn/revision/schema 校验与 `callCapability` 复核、mode policy 四档、审批与自动复核 interrupt、MCP invocation Receipt 与 Artifact、Verification 调度、plan 工具的模型表面与状态机语义（控制平面拆分仅为方向，实施须经独立 RFC）。

## 备选方案

- **维持现状 + 强化文档同步纪律**：拒绝。两份在库提案已把多点同步制度化，七类漂移证明人工同步不可靠。
- **仅 Schema 层单一来源**（保留手写请求解析与 runner 分支）：拒绝。无法消除字段丢弃类 bug，双执行路径依旧。
- **全面更名对齐 Claude Code**：本阶段拒绝（见 §4），保留为可选后续项。
- **一次性重写工具层**：拒绝。采用逐工具 feature flag 迁移（`toolSpecRegistryV1`，默认 false，旧路径保留 ≥2 周），任一时刻每个工具单路径生效。

## 后果

- `definitions.ts` 降级为 Registry 生成的 schema-only 层；`tool-requests.ts`、`tool-runner.ts`、`tool-contracts.ts`、`tool-capabilities.ts` 的逐工具分支随迁移逐批删除。
- 严格 Edit 会使模型初期 edit 失败率上升（未读即改、空白不匹配被拒），错误信息引导重读自纠——这是 ADR-0042 已预期的设计意图。
- shell 治理参数删除后，审批决策完全由命令形态与授权状态驱动；只读命令免审批快车道命中率应不低于迁移前（迁移前后对比验证）。
- 迁移期每个工具的 description 保持逐字节稳定（golden 测试守护）；Schema 变更集中在明确批次，各触发一次性 prompt cache miss。
- 直调模型 ToolSet `execute()` 的存量测试随迁移改为经 dispatch 验证生产链。

## 回滚

- `toolSpecRegistryV1=false` 回退旧路径（旧分支在 golden 期内保留）；flag 默认 true 后的清理 PR 可独立 revert 恢复双路径可切换状态。
- 严格 Edit 以 `findMatch` 降级链的 opt-in 开关为回退点。
- Registry 基建为附加代码，删除不影响旧路径。
- 阶段 0 止血改动（删除被丢弃参数、死代码、幽灵名、措辞收敛）均为独立可 revert 的小改动。

## 实施记录

### 2026-07-27：Registry 不变量加固

- **ToolAvailabilityContext 复用**：模型表面生成与模型返回后的 effects 分类使用同一份不可变快照，修复 `complete_skill` 等条件性工具在 effects 分类时被误判为有副作用。
- **governanceRevision**：ToolSpec 新增可选 `governanceRevision` 字段，纳入 descriptor revision 哈希，使 effects 分类逻辑变化（如 shell 只读命令白名单修改）能触发缓存失效。
- **string 重载收紧**：`toolRequestFromCall` 的 string 重载仅提供 `workspace`，移除伪造的 `hasTaskAdapter`/`activeSkillFrameIds`/feature flags。
- **read_file Schema**：`offset` 和 `limit` 增加 `int().min(1)` 校验。

### 2026-07-27：Runner 通用 Registry 分发

- `runApprovedTool` 新增通用 Registry 回退路径：工具未命中任何子分支时，通过 `builtinToolRegistry.get()` 查找 spec 并调用 `dispatchRegisteredTool`，新增注册工具不再需要手工添加 Runner 分支。

### 2026-07-27：PendingToolRequest 简化

- 将 22 成员的可辨识联合类型（手写每工具参数声明）替换为简单接口 `{ id?, name, args: unknown, reason, protectedCommand }`。`args` 经 Registry `inputSchema` 解析后透传（i1），消费者在需要字段级访问时使用显式 `Record<string,unknown>` 转换。删除 229 行重复 Schema 声明。

- 所有 19 个 builtin spec 导出 `z.infer` 的 Input 类型。tool-runner 与 tool-controller 在每个工具分支入口用一行 `as XxxInput` 收窄 args，替代散落的逐字段 cast。

- `PendingToolRequest` 拆分为 `PendingBuiltinToolRequest | PendingMcpToolRequest`。Builtin 侧通过 `MakeRequest<'name', InputType>` 手工维护可辨识联合（19 行），TypeScript 在 `request.name === '...'` 守卫后自动收窄 `request.args` 到对应 Input 类型——不再需要 `as XxxInput` 手动 cast。MCP 侧保持 `Record<string,unknown>`。

### 2026-07-27：类型单一事实源（消除手写联合与类型擦除）

- **`ToolSpec<Name, Input, Output>` 泛型化**：`BaseToolSpec` 新增 `Name extends string` 参数，`name` 字段类型从 `string` 收紧为字面量。`defineExecutableTool` / `defineInterruptTool` 使用 `const` type parameter 保留字面量推导，替代旧的 `const spec: ToolSpec<Input, Output> = { name: '...' as const }` 模式（外部类型标注会擦除 `as const`）。
- **所有 Input 从 Schema 派生**：5 个手写 interface（`ReadFileInput`、`WriteFileToolInput`、`EditFileToolInput`、`SearchContentInput`、`SearchFilesInput`）替换为 `z.infer<typeof xxxInputSchema>`。每个 spec 文件导出命名 Schema const，消除 interface 与 Schema 的漂移风险。
- **Registry 从 const tuple 构建**：`builtinToolRegistry = createToolRegistry(builtinToolSpecs)`，删除 19 行 `.register()` 链。`createToolRegistry` 接受 `readonly AnyToolSpec[]` 并返回 `ToolRegistry<Specs[number]>`。
- **`PendingBuiltinToolRequest` 自动推导**：删除 19 行手写 `MakeRequest` 联合，替换为分布式条件类型 `RequestOf<BuiltinSpec>`（从 `builtinToolSpecs` tuple 推导）。新增工具只需在 tuple 追加一行。
- **`parseToolCall` 类型化返回**：`ToolRegistry<Spec>` 泛型化，`parseToolCall` 返回 `ParseResultOf<Spec> | ParseFailure | null`。唯一允许的异构类型断言位于 Registry 内部紧跟 `safeParse` 之后；Registry 外部不再恢复参数类型。
- **无效调用分离**：`InvalidToolRequest`（`source: 'invalid'`）独立建模，不混入 `PendingToolRequest` 联合。`toolRequestFromCall` 返回 `ToolRequestParseResult | null`，调用方在 `!parsed.ok` 时生成错误事件，`runApprovedTool` 不再处理 `_raw_invalid_args`。
- **`isMcpRequest` type guard**：替代 `request.name.startsWith('mcp__')` 的不可缩窄模式，使 MCP 分支内 `request.args` 自动收窄为 `Record<string, unknown>`。
- **编译期不变量测试**：`Equal` / `Expect` 类型断言验证 `name === 'read_file' ⇒ args ≡ z.infer<typeof readFileInputSchema>`，以及 `BuiltinName ≡ PendingBuiltinToolRequest['name']` 覆盖检查。

### 2026-07-28：请求来源判别与错误分类修正

- **`source` 判别字段**：`PendingBuiltinToolRequest` 增加 `source: 'builtin'`，`PendingMcpToolRequest` 增加 `source: 'mcp'`，`isMcpRequest` 改用 `req.source === 'mcp'` 替代 `req.name.startsWith('mcp__')`。`ToolRegistry.register` 拒绝 `mcp__` 前缀的 builtin spec。
- **Schema 参数错误修正**：`toolRequestFromCall` 对 Registry `ParseFailure` 返回 `InvalidToolRequest`（`tool_invalid_args`），不再返回 `null`（`tool_not_found`）。模型收到 `"Invalid arguments for 'read_file': ..."` 而非 `"Unsupported tool 'read_file'"`。
- **`_parse_error` 修正**：合成非法调用的 `parseError` 使用 `_parse_error` 字段，原始非法 JSON 保留在 `rawArgs`。
- **不可信边界收紧**：`toolRequestFromCall` 签名 `args` 改为 `unknown`，`InvalidToolRequest.rawArgs` 改为 `unknown`，MCP 路径显式验证 args 为非 null 对象。
- **类型测试扩展**：新增 `ask_user` transform 输出（`UserInputRequest`）与 `write_plan` 可选 `action` 的编译期断言。
