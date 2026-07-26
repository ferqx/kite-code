# 工具单一事实源（ToolSpec Registry）RFC

**状态：** Proposed
**日期：** 2026-07-26
**主要模块：** `src/core/tools/`、`src/core/harness/`、`src/core/policies/`、`src/core/controllers/tool-controller.ts`、`src/core/capabilities/`
**前置决策：** ADR-0007（Capability Binding）、ADR-0020（MCP 按需加载）、ADR-0025（文件工具语义与写入安全）
**批准要求：** 本 RFC 批准后、实施前必须新增 ADR-0026（工具单一事实源与严格 Edit 语义），并在 `docs/space/plans/` 形成可验证的实施计划。

---

## 1. 背景

### 1.1 问题陈述

当前每个模型工具的完整事实散落在至少八处，且全部手工同步：

| 事实维度 | 权威位置 | 文件 |
| --- | --- | --- |
| 模型可见 Schema + 部分执行器 | `createAgentTools()` | `src/core/tools/definitions.ts` |
| 自然语言契约（whenToUse / commonMistakes / outputFormat / failureHandling） | `TOOL_CONTRACTS` | `src/core/tools/tool-contracts.ts` |
| 请求类型与手写解析 | `PendingToolRequest` / `toolRequestFromCall()` | `src/core/harness/tool-requests.ts` |
| 实际执行分支 | `runApprovedTool()` | `src/core/harness/tool-runner.ts` |
| 副作用分类 | `classifyToolCapability()` | `src/core/policies/tool-capabilities.ts` |
| 风险与审批评估 | `evaluateToolApproval()` | `src/core/policies/approval-policy.ts` |
| 路由（内联处理 vs 委派 runner） | `executeRuntimeTools()` | `src/core/controllers/tool-controller.ts` |
| 审批展示载荷与命令授权 | `buildToolApproval()` | `src/core/harness/tool-policy.ts` |
| TUI 展示映射 | `ACTION_NAMES` / preview / detail | `src/app/tui/components/render-utils.ts` |

这不是"文档写得不够"，而是结构问题：新增或修改一个工具需要同步上述全部位置，任何一处遗漏都会产生静默漂移。仓库自己的两份提案已经把这个成本制度化了——`docs/space/plans/2026-07-01-web-search-tool.md` 为一个工具列出了 6 个文件的同步步骤，`docs/design/2026-07-19-mcp-tool-inventory-rfc.md` §13 为 `list_mcp_tools` 列出了 13 个修改文件。

### 1.2 已核实的漂移证据（2026-07-26）

以下每一条都经过源码核对，行号为核实当时：

1. **`match_mode` 被静默丢弃。** Schema 暴露 `match_mode: enum(['exact','trimmed'])`（`definitions.ts:139-144`），契约文本**主动指导模型使用它**（`tool-contracts.ts:102`："set match_mode: 'trimmed' to skip straight to per-line matching"）；但 `definitions.ts:147` 的 `execute` 只解构四个参数，`tool-requests.ts:349-368` 的请求类型不含该字段，`tool-runner.ts:332` 调用 `editFile()` 时也不传递。底层 `editFile()` 实际支持 `matchMode`（`file.ts:334,366`）——参数在中间层被丢弃。
2. **`read_file` 的 `force` 是永远无法执行的恢复路径。** 底层 `readFile()` 支持 `force`（`file.ts:148,184,213,241,265,282`），二进制检测错误明确要求模型 "Use force: true to read anyway"（`file.ts:193`）；但模型 Schema 只有 `path/offset/limit`（`definitions.ts:113-121`），请求类型与 runner 均无 `force`。模型永远无法按错误提示完成恢复。
3. **双执行路径并存。** `definitions.ts` 中 `read_file`（:120）、`edit_file`（:147）、`write_file`（:173）、`shell_execute`（:210）、`search_content`（:327）、`search_files`（:343）、`web_fetch`（:459）带有真实 `execute`；而生产链路走 `executeRuntimeTools() → runApprovedTool()`，runner 里有同名的另一套执行分支（`tool-runner.ts:287,310,409,853,539,566,792`）。`list_mcp_tools` 的 `execute` 只返回 `"Handled by tool runner."`（`definitions.ts:284`），MCP 绑定工具则已经是 schema-only（`definitions.ts:542-546`）——同一个文件里同时存在三种工具形态，开发者无法从定义判断语义。
4. **测试在验证一条生产上被绕过的链路。** `tests/tool-definitions.test.ts:120,216,219` 直接调用模型 ToolSet 上的 `.execute()`，验证的是 `definitions.ts` 里的执行器，而不是经过 Policy、Receipt、Verification 的生产链路。绿色测试给了虚假安全感。
5. **工具描述与治理层表达不一致。** `shell_execute` 契约四次使用权限式措辞禁止 `grep/rg/find`（`tool-contracts.ts:144-145,173-174,200-201,210`）；而 inspect 免审批白名单把 `grep/rg/find/ls` 全部列为只读安全命令（`definitions.ts:869-891`，`isReadOnlyShellCommand()` :905），`classifyToolCapability()` 同样按命令形态判定只读（`tool-capabilities.ts:83-94`）。描述在用劝诫承担本属于 Policy 的职责。
6. **兼容债务。** 旧 `Skill` 请求类型仍存在（`tool-requests.ts:189`），controller 为其保留"总是拒绝"分支（`tool-controller.ts:1135`），Policy 只读集合仍收录它（`tool-capabilities.ts:35`）；不存在的 `list_files` 出现在 Policy（`tool-capabilities.ts:27`）和 Skill 目录（`skills/catalog.ts:32`）；`toolRequestFromMessage()` 定义于 `tool-requests.ts:631`，全仓库零调用。
7. **Runtime 内部实现泄漏进模型 ACI。** `ask_user` 契约告诉模型 "It returns ok: false (the harness intercepts it)"（`tool-contracts.ts:309,314`）——harness 拦截机制不应出现在模型可见契约里。
8. **模型参数承担治理职责。** `shell_execute` Schema 暴露 `intent`、`prefix_rule`、`grant_request`（`definitions.ts:188-204`），请求归一化还接收 `objective`、`justification`、`expected_observation`、`failure_strategy`（`tool-requests.ts:933-951`），runner 将其写入 `action` 元数据（`tool-runner.ts:875-883`）。模型得以自我声明副作用等级、提议持久授权规则——而副作用分类本已由命令形态分析完成（`tool-capabilities.ts:83-118`），不依赖这些参数。

### 1.3 与既有决策的关系

- **ADR-0025（已接受，2026-07-25）** 决定 `edit_file` 先读后改 + 过期拒绝（§1）、移除 `write_file` 的 `append`（§2）、写入前持久化 preimage（§4）。核实结果：§4 的 preimage 基建已落地（`tool-runner.ts:325-331,415-425`，`runtime/file-checkpoints.ts:27`，`executor.ts:161` 注入），**§1/§2 尚未实现**——当前仅有模型面向的软引导文本（`tool-runner.ts:1029`），Schema 仍保留 `mode: 'overwrite' | 'append'`（`definitions.ts:165-170`）。本 RFC 的 Registry 为 §1/§2 提供唯一落点（pre-hook 与 Schema 收敛），实施次序沿用 ADR-0025 的 §4 → §1 → §2。
- **ADR-0007 / ADR-0020** 建立的 Capability Binding（turn-scoped、revision-pinned）与按需加载机制保持不变，本 RFC 只统一静态内建工具的注册与执行路径。
- **ADR-0023** 规范的是 **LLM 模型能力目录**（context window、tokenizer 等不得按模型名内置），与工具注册正交，无冲突。`CapabilityDescriptor` 的 `builtin_tool` kind 已是协议既有类型（`src/protocol/capabilities.ts:3-9`）。

### 1.4 结论

保留 Kite 已建立的 Runtime 治理（Kernel、Binding、Receipt、Verification、preimage），把**工具契约层**收口为单一事实源。一句话：**借鉴 Claude Code 的工具契约纪律，不复制它的 Runtime 实现。**

---

## 2. 目标与非目标

### 2.1 目标

1. 建立唯一 `ToolSpec`：每个静态工具的 Schema、契约文本、可用性、副作用分类、执行器、结果投影、展示提示来自同一份定义。
2. 模型 ToolSet 全部 schema-only（AI SDK `tool()` 的无 `execute` 重载已支持，MCP 绑定工具现状即如此）；真实执行只存在一条路径。
3. 请求解析与分发由 Registry 泛型驱动，消除逐工具 `if` 分支与手写联合类型。
4. 副作用与审批输入只能由 `input + context` 推导，不得信任模型自我声明的治理参数。
5. 用机器可验证的一致性测试替代"人工同步 + 文档提醒"。

### 2.2 非目标

1. **不改模型可见工具名**（不改成 `Read/Edit/Glob/Grep/Bash` 等 PascalCase）。原因见 §8 备选方案 C：Kite 的权威身份是 `capabilityId + revision`，模型名只是 binding 暴露名，重命名不承载架构价值，却要付出事件回放、TUI 历史渲染、golden prompt、`exposedToolName` 的迁移成本。命名对齐列为独立可选后续项。
2. **不重做 MCP 动态工具链路**。`mcp__*` 的 binding/turn/revision/schema 校验（`tool-controller.ts:557-616`）与 `callCapability` 运行时复核保持不变。
3. **不改动计划状态机语义**。`read_plan/write_plan/update_plan` 本阶段只迁入 Registry，表面不变；门面化或 Runtime Action 化是后续独立 RFC（§5.3 只给方向）。
4. **不引入 Claude Code 的 Runtime 概念**（Hooks 体系、permission rule 文件等）。

---

## 3. 现状盘点：准确调用链

```text
model tool call
  → AI SDK ToolSet（definitions.ts，部分带 execute，生产上不被调用）
  → state.tools.calls 记录 ToolCallRecord
  → executeRuntimeTools()（tool-controller.ts:501，按 toolCallIds 取记录）
      → toolRequestFromCall() 手写解析为 PendingToolRequest
      → mcp__* 前缀：binding / turn(:575) / revision(:580) / availability(:586) / schema(:596) 校验
      → 内联处理：tool_search(:618) activate_skill(:792) read_skill_reference(:1019)
        complete_skill(:1071) Skill(:1135，总是拒绝) ask_user(:1144，interrupt)
        read_plan(:1167) write_plan(:1247) update_plan(:1550)
      → 委派 runApprovedTool()（:2002）：task / 文件 / 搜索 / shell / web_fetch /
        mcp 资源三件 / mcp__* / list_mcp_tools
  → runApprovedTool()（tool-runner.ts:118）
      → evaluateToolApproval()（approval-policy.ts:239，消费 classifyToolCapability）
      → mode policy 防御性复核（default / accept-edits / plan / full_access）
      → 执行分支（:229-886）→ withFailureGuidance / truncateToolOutput
  → tool.finished（:2083-2110）+ computeToolResultDigest（:70，raw|projected）
  → MCP：capability.invocation_recorded / execution_succeeded Receipt（:2151,:2224）
  → verificationRequestForCapability（:2056，flag verificationV1）
```

需要保留的既有能力：binding 校验链、mode policy 四档、审批 interrupt（`approval.requested` / `auto_review.requested`）、命令授权（`approve_once | same_command | full_access`）、preimage 记录、结果 digest 与 `workspaceMutationScope`、命令形态只读分析、Schema admission 预算（`capabilities/schema.ts:15-18`）。

---

## 4. 目标设计

### 4.1 ToolSpec 接口

```ts
// src/core/tools/registry/spec.ts（新增）

export type ToolKind =
  | 'computer'      // 稳定的计算原语：read_file / edit_file / write_file / search_* / shell_execute / web_fetch
  | 'coordination'  // Agent 协作：task / tool_search / skill 三件 / mcp 资源三件 / list_mcp_tools
  | 'interrupt'     // 用户交互协议：ask_user（harness 拦截，不进入 execute）
  | 'runtime_action'; // Runtime 状态变更：plan 三件（本阶段只接入，不改语义）

export interface ToolSpec<Input, Output> {
  /** 模型可见名。稳定 snake_case，本 RFC 不改名（§2.2）。 */
  readonly name: string;
  readonly kind: ToolKind;

  /** 契约文本唯一来源。description 由 buildDescription(sections) 生成，不再二次手写。 */
  readonly contract: ToolContractSections; // whenToUse / commonMistakes / outputFormat / failureHandling

  /** 模型参数 Schema。execute 接收的对象必须恒等于该 Schema 的解析结果（§6 不变量 i1）。 */
  readonly inputSchema: ZodType<Input>;

  /** 可用性谓词，替代 createAgentTools 中的条件 spread（phase / interactionMode / skill frame 等）。 */
  availability(context: ToolContext): boolean;

  /**
   * 副作用分类。必须是 (input, context) 的纯函数；
   * 复用 ToolEffectClass（read_only / plan_only / workspace_write / external_side_effect / unknown），
   * 同时投影出 CapabilityDescriptor.effectiveEffects（filesystem / network / externalState）。
   * shell_execute 的分类复用现有命令形态分析（isReadOnlyShellCommand 等），
   * 不读取、也不允许存在模型自我声明的副作用字段。
   */
  effects(input: Input, context: ToolContext): ToolEffects;

  /** 审批展示命令（可选）。默认 `${name} ${primaryArg}`，替代逐分支的 protectedCommand。 */
  approvalSummary?(input: Input, context: ToolContext): string;

  /**
   * 执行前置钩子（可选，按序执行，fail-fast）：
   * - ADR-0025 §1：edit 的会话级读取状态校验（未读拒绝 / 过期拒绝）；
   * - ADR-0025 §4：写工具 preimage 持久化（现 safeRecordPreimage 逻辑）；
   * - read_file 读取状态登记。
   * 钩子是 Registry 层统一机制，不再是 runner 每个分支里的内联代码。
   */
  preExecute?(input: Input, context: ToolExecutionContext): Promise<PreExecuteOutcome>;

  /** 唯一执行器。只有 Registry dispatch 可以调用它。 */
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;

  /**
   * 结果投影：模型可见内容（含截断与失败引导，复用 truncateToolOutput /
   * withFailureGuidance / toolUsageGuidance 的既有逻辑）+ resultMeta
   * （workspaceMutationScope、truncated、digest 输入）+ 展示提示。
   * display 只产出纯字符串，不引用 TUI 类型（Core→App 边界不变量）。
   */
  projectResult(output: Output, context: ToolExecutionContext): ProjectedToolResult;

  /** 验证需求声明（可选），对接现有 verificationRequestForCapability。 */
  verification?(input: Input, output: Output): VerificationRequirement[];
}

export interface ProjectedToolResult {
  modelContent: string;            // tool.finished 的 stdout/stderr 归一输入
  ok: boolean;
  resultMeta: {
    workspaceMutationScope?: string[];
    truncated?: boolean;
  };
  display: { verb: string; preview?: string; detail?: string }; // TUI 消费的纯字符串
}
```

**identity 规则：** `capabilityId = builtin:<name>`；`revision` 复用 `descriptorRevision()` 的内容哈希算法（`capabilities/catalog.ts:30-32`）。Schema / 契约 / effects 语义变化即 revision 变化，为未来内建工具参与 binding 校验留出口子（当前内建工具不走 binding，不改变现状）。

### 4.2 Registry 与派生产物

```text
ToolSpec Registry（唯一事实源）
  ├─ toSchemaOnlyToolSet(context)   → AI SDK ToolSet（tool() 无 execute 重载；动态 MCP 仍用 dynamicTool + binding 流程）
  ├─ parseToolCall(call, workspace) → 泛型 toolRequestFromCall：lookup → inputSchema 解析 → 构造请求；args 原样透传
  ├─ PendingToolRequest（派生联合） → { id?, name, args, reason, protectedCommand } 序列化形状不变（回放兼容，§7.4）
  ├─ descriptorOf(spec)             → CapabilityDescriptor 投影（builtin_tool kind；用于一致性校验与 Policy 输入）
  ├─ dispatch(request, execContext) → 唯一执行入口：pre-gates → preExecute → execute → projectResult
  └─ conformance tests              → §6 全部不变量
```

`dispatch` 内部复用现有 pre-gates 顺序：`evaluateToolApproval()` → mode policy 防御性复核 → permit 认领（`tool-runner.ts:161-227` 的既有逻辑上提为管线公共段）。Controller 的内联分支（skill / plan / ask_user / tool_search）迁移为对应 spec 的 `execute`；`mcp__*` 前缀路径保持 controller 内联校验 + Registry dispatch 委派，binding 校验链不动。

### 4.3 目标调用链

```text
model tool call
  → Registry lookup（name → spec；未注册名直接拒绝）
  → inputSchema 校验（args 透传，无逐字段重映射）
  → 动态工具：binding / turn / revision / schema 校验（现状保持，tool-controller.ts:557-616）
  → effects 解析（spec.effects，纯函数）
  → evaluateToolApproval + mode policy（消费 effects，不消费模型声明）
  → 审批 / 自动复核 interrupt（approval.requested / auto_review.requested，现状保持）
  → preExecute 钩子（ADR-0025 §1/§4、读取登记）
  → spec.execute
  → projectResult（模型内容 + resultMeta + display）
  → tool.finished + digest（computeToolResultDigest，现状保持）
  → Receipt / Artifact（MCP invocation 记录现状保持）
  → Verification 调度（verificationRequestForCapability，现状保持）
```

### 4.4 模型参数治理（ACI 纪律）

**`shell_execute` 模型表面收敛为：**

```ts
{
  command: string;
  description?: string;
  timeout_ms?: number;
}
```

即现存 `ShellActionEnvelope`（`src/core/types.ts:29-40`）删除 `intent`、`objective`、`justification`、`expected_observation`、`failure_strategy`、`prefix_rule`、`grant_request` 后的剩余字段，不新增任何能力。

移除 `intent`、`objective`、`justification`、`expected_observation`、`failure_strategy`、`prefix_rule`、`grant_request`。配套：

- **inspect 免审批快车道改为纯命令形态驱动。** `classifyToolCapability()` 已按命令形态判只读（`tool-capabilities.ts:88-94`），但 `approval-policy.ts` 与 `buildToolApproval()` 当前部分依赖模型声明的 `intent`。迁移后，快车道触发条件 = 命令形态只读，不信任模型自我分类——这比现状更安全。
- **runner `action` 元数据（`tool-runner.ts:875-883`）改为从分类结果与授权层派生**：`classificationReason`、grant 使用情况、命令形态标签，不再回显模型声明。
- **授权规则提议权留在审批层。** `approve_once | same_command | full_access` 由用户在审批 UI 选择（`buildToolApproval()` 现状），模型不得通过工具参数提议持久规则。
- 模型仍可在 `description` 中解释命令目的（供审批展示），但不能以此降低审批等级。

**契约文本职责收窄：** 契约只说明"工具做什么、核心输入语义、一两个关键约束"。移除 `shell_execute` 契约中的权限式 "NEVER use grep/rg/find"（`tool-contracts.ts:200-201` 等四处），改为一句话偏好引导（专用搜索工具提供 gitignore 处理与结构化输出）；约束由 Policy 与命令形态分析表达。

**`ask_user` 契约去泄漏：** 删除 "returns ok: false (the harness intercepts it)" 类句子（`tool-contracts.ts:309,314`），替换为行为描述（"暂停当前轮次，等待用户回答后继续"）。`kind: 'interrupt'` 使拦截成为 Registry 层机制而非契约文字。

### 4.5 Edit 严格化（与 ADR-0025 协同）

分两步，第二步需要 ADR-0026：

1. **阶段 0（零行为变化）：** 从 Schema、契约、请求类型中删除 `match_mode`。该参数今天就被丢弃，删除不改变任何执行行为，只消除"契约指导模型使用一个被丢弃的参数"的欺骗性表面。
2. **阶段 1（行为变化，ADR-0026 批准后）：** `findMatch()` 的无条件降级链（exact → trimEnd `file.ts:417-421` → 逐行 trimming `file.ts:444+`）改为**默认仅 exact**，模糊匹配降为内部显式 opt-in（或直接移除）。对齐 Claude Code 的严格 Edit：匹配失败即失败，模型重新 `Read` 提交准确文本。理由：无条件降级使 Receipt 无法表达"模型意图 vs 实际匹配"的差异，且空白在代码中可能具有语义。同期落地 ADR-0025 §1（先读后改 / 过期拒绝，作为 edit spec 的 `preExecute` 钩子）与 §2（删除 `write_file` 的 `mode` 参数与 append 分支）。

`read_file` 的 `force`：**不暴露模型表面**。重写二进制检测错误文本（`file.ts:193`）为"该文件为二进制，无法作为文本读取；如确需查看，请向用户确认"，底层 `opts.force` 保留供内部与测试使用。

### 4.6 控制平面分层（本阶段只接入，方向在此冻结）

| 层级 | 工具 | 本 RFC 动作 |
| --- | --- | --- |
| computer | read_file / edit_file / write_file / search_files / search_content / shell_execute / web_fetch | 阶段 1-2 迁入 Registry |
| coordination | task / tool_search / activate_skill / complete_skill / read_skill_reference / list_mcp_tools / list_mcp_resources / read_mcp_resource | 阶段 2 迁入 |
| interrupt | ask_user | 阶段 2 迁入，`kind: 'interrupt'` |
| runtime_action | read_plan / write_plan / update_plan | 阶段 2 仅接入 Registry，语义不动 |

方向（不在本 RFC 实施）：plan 三件收敛为单一 `Plan` 门面或下沉为 Runtime Action；skill 生命周期事件化。若计划能力是产品差异化核心，保留模型表面但整理门面，避免三个工具各自暴露状态机细节。

---

## 5. 一致性不变量（机器校验，随阶段 1 同批落地）

新增 `tests/tools/tool-registry-conformance.test.ts`，断言：

| # | 不变量 | 校验方式 |
| --- | --- | --- |
| i1 | **args 透传恒等**：`parseToolCall` 输出的 `args` 恒等于 `inputSchema.parse` 结果 | 对每个 spec 构造含全部可选字段的输入，断言 deep-equal。这条从结构上杀死 match_mode 式字段丢弃 |
| i2 | 模型 ToolSet 全部 schema-only | `createAgentTools()` 产出的每个工具 `execute === undefined` |
| i3 | Policy / 分类名集 ⊆ Registry 名集 | `tool-capabilities.ts`、`approval-policy.ts` 引用的工具名全部已注册（顺带捕获 `list_files` 式幽灵名） |
| i4 | `KNOWN_TOOL_NAMES` ≡ Registry 名集 ∪ `mcp__*` | 直接比较 |
| i5 | 写工具必产出 `workspaceMutationScope` + digest 输入 | edit/write spec 的 projectResult 断言 |
| i6 | description 是 contract sections 的纯函数 | 对每个 spec 断言 `description === buildDescription(sections)`，不存在第二份手写描述 |
| i7 | Core→App 边界 | 现有 `bun run check:core-boundary`（display 提示为纯字符串，不引入 TUI 类型） |
| i8 | 动态工具校验链保持 | 现有 binding/turn/revision/schema 测试全绿 |
| i9 | Registry 名唯一 + descriptor revision 确定性 | 同内容 spec 生成同 revision |
| i10 | shell 分类不读取已删除的治理参数 | 类型层面：`ShellExecuteInput` 不含 intent 等字段；测试断言只读命令形态命中快车道 |

不变量测试不是"迁移完成后的跟进项"，而是 Registry 价值本身——没有它们，三个月内会漂移回今天的形态。

---

## 6. 迁移计划

### 阶段 0：漂移止血（1 个 PR，无行为变化 / 仅文本变化）

| 动作 | 位置 | 风险 |
| --- | --- | --- |
| 删除 `match_mode`（Schema + 契约 :102 引导句） | `definitions.ts:139-144`、`tool-contracts.ts:102` | 零：参数本就被丢弃 |
| `force` 错误文本重写，不暴露 Schema | `file.ts:193` | 零：恢复路径本不可达 |
| 删除 `Skill` 请求类型与总是拒绝分支（先 grep 确认无其他调用方） | `tool-requests.ts:189`、`tool-controller.ts:1135`、`tool-capabilities.ts:35` | 低 |
| 删除 `list_files` 幽灵条目 | `tool-capabilities.ts:27`、`skills/catalog.ts:32` | 零 |
| 删除死代码 `toolRequestFromMessage()` | `tool-requests.ts:631` | 零 |
| shell 契约措辞从 "NEVER" 收敛为偏好引导 | `tool-contracts.ts:144-145,173-174,200-201,210` | 低：golden prompt 守护 |
| 标记直调 `.execute()` 的测试为迁移项（本阶段不改） | `tests/tool-definitions.test.ts:120,216,219` | 零 |

### 阶段 1：Registry 骨架 + 六个计算原语

1. 新增 `src/core/tools/registry/`（`spec.ts` / `registry.ts` / `dispatch.ts`）与 §5 一致性测试骨架。
2. 新增 feature flag `toolSpecRegistryV1`（遵循 `docs/active/feature-flags.md`：默认 `false`，双值测试，旧路径保留 ≥2 周；ADR-0026 接受且生产 TUI 路径有 e2e 覆盖后方可默认 `true`）。
3. 按 **read_file → search_files → search_content → write_file → edit_file → shell_execute** 顺序逐工具迁移，每个工具一个 PR：
   - 执行器从 runner 分支移入 `spec.execute`（逻辑搬运，不改语义）；
   - 删除 `definitions.ts` 对应 `tool({...execute})`，改为 Registry 生成的 schema-only 条目；
   - 删除 `tool-requests.ts` 对应解析分支与联合成员（由派生联合替代）；
   - 删除 `tool-contracts.ts` 对应契约（移入 spec）；
   - `tool-capabilities.ts` 静态集合由 spec.effects 投影替代；
   - 测试从直调 `.execute()` 改为经 `dispatch()`。
4. flag 全量且经过 golden 期后，单独清理 PR 删除旧分支。

**`edit_file` / `write_file` 的迁移与 ADR-0025 §1/§2 同批**（先读后改钩子、`mode` 删除），次序仍为 §4（已落地）→ §1 → §2，由 ADR-0026 承载严格 Edit 语义决策。

### 阶段 2：协调类工具

`web_fetch` → MCP 资源三件 + `list_mcp_tools`（与其独立 RFC 的实施合并）→ `task` → skill 三件 → `tool_search` → `ask_user`（`kind: 'interrupt'`）→ plan 三件（仅接入）。controller 内联分支随迁随删。

### 阶段 3：控制平面方向项（独立 RFC，不在本次）

plan 门面 / Runtime Action 化、skill 生命周期事件化。

### 7.4 回放与兼容约束

- 模型可见名保持 snake_case：`state.tools.calls` 中的历史 `ToolCallRecord`、event store 回放、TUI 历史渲染、golden prompt 不受影响。
- `PendingToolRequest` 序列化形状 `{ id?, name, args, reason, protectedCommand }` 不变；`getPendingToolRequest()` 的悬空调用恢复路径（`tool-requests.ts:219`）改由 `registry.parseToolCall` 驱动，行为等价。
- 迁移期双路径由 flag 切换，任一时刻每个工具只有一条生效路径（flag 在 `executeRuntimeTools` 入口按工具名路由，不允许 spec 与旧分支同时生效）。

### 7.5 Prompt cache 约束

- 迁移期间每个工具的 description 保持**逐字节稳定**（契约文本原样移入 spec，`buildDescription` 输出不变），由 `tests/golden/` 守护。
- Schema 变更（`match_mode`、`mode`、shell 治理参数删除）集中在阶段 0 与 ADR-0025 §2 批次，各触发一次性 cache miss，可接受；不得在逐工具迁移 PR 中夹带 Schema 文本变化。

---

## 7. 边界影响

### 7.1 文档映射（实施时随代码同步更新）

`docs/documentation-map.json` 受影响规则：`builtin-tools`、`policy-and-execution`、`capabilities`、`model-and-context`。实施各阶段必须更新的 `docs/active/`：

| 文档 | 更新内容 |
| --- | --- |
| `tool-description-contracts.md` | 契约唯一来源改为 spec.contract；新增"描述不承担权限职责"规则 |
| `tool-gated-autonomy.md` | 审批输入来自 effects 投影，不来自模型参数；inspect 快车道命令形态化 |
| `file-reading-shared-boundary.md` | 读取登记与先读后改钩子的 Registry 落点 |
| `authorization.md` | shell 治理参数移除后的审批语义 |
| `capability-progressive-disclosure.md` | builtin_tool descriptor 投影用途（一致性校验与 Policy 输入；不改变可搜索 Catalog 现状） |

### 7.2 ADR

- **ADR-0026（待提案）**：工具单一事实源 + 严格 Edit 语义（findMatch 默认 exact）+ shell 模型参数收敛。本 RFC 批准是提案的前置输入，不替代 ADR 决策。
- 不改写 ADR-0025；§1/§2 的实施在其既有次序内完成。

### 7.3 不变量保持

CLAUDE.md 八条不变量全部保持：Core 不依赖 App（i7）；RuntimeState 只经 RuntimeEvent（plan 工具语义不动）；discovery 不授权（binding 链不动）；动态调用校验 binding/turn/revision/schema（i8）；外部写入 intent-first（MCP invocation 记录不动）；Required Verification 不可绕过（verification 调度不动）。

---

## 8. 备选方案

### A. 维持现状 + 强化文档同步纪律

拒绝。`docs/space/plans/2026-07-01-web-search-tool.md` 与 MCP inventory RFC 已把"每工具同步 6-13 处"制度化，§1.2 的八条漂移证明人工同步不可靠。文档纪律无法对抗结构性缺失。

### B. 仅 Schema 层单一来源（保留手写请求/runner 分支）

从单一来源生成 description 与 Schema，但 `PendingToolRequest` 解析与 runner 分支继续手写。放弃：能消除描述漂移，但无法消除 match_mode 式字段丢弃（i1 无法成立），双执行路径依旧存在。

### C. 全面更名对齐 Claude Code（Read / Edit / Glob / Grep / Bash / Agent / Skill / ToolSearch）

本阶段拒绝。Kite 的权威身份是 `capabilityId + revision`，模型名经 binding 暴露，治理不键于名字——重命名不承载架构价值。成本却很实：event store 历史 `ToolCallRecord` 回放需要别名表、TUI 历史渲染、`exposedToolName` 与 binding digest、golden prompt 全集、全部测试。保留为独立可选后续项：如未来引入，走"Registry 别名表 + 新名只对新会话生效"，不与本 RFC 捆绑。

### D. 一次性重写工具层

拒绝。双路径风险集中爆发，逐工具 flag 迁移可控、可回滚、可观测。

---

## 9. 回滚方案

- **阶段 0**：全部为删除与文本改动，直接 revert。
- **阶段 1/2**：`toolSpecRegistryV1=false` 回退旧路径（旧分支在 golden 期内保留）；flag 默认 `true` 后的清理 PR 如暴露问题，revert 清理 PR 即恢复双路径可切换状态。
- **严格 Edit（ADR-0026）**：findMatch 降级链的 opt-in 开关即回退点（禁用后退回当前无条件降级行为）。
- **Registry 基建本身为附加代码**，删除不影响任何旧路径。

---

## 10. 风险

| 风险 | 控制 |
| --- | --- |
| 迁移期双路径不一致 | flag 在入口按工具名单路由，任一时刻单路径生效；一致性测试 i2/i3 持续运行 |
| 严格 Edit 抬升模型 edit 失败率 | ADR-0025 已预期初期失败率上升为设计意图（错误信息引导自纠）；golden/e2e 观察，失败引导文本提供重读指引 |
| shell 治理参数移除后审批摩擦变化 | 命令形态快车道已存在（`isReadOnlyShellCommand`），迁移前后对比只读命令免审命中率；`git status` 类命令不应新增审批 |
| prompt cache 抖动 | description 字节稳定 + golden 守护；Schema 变更集中在两个明确批次 |
| preExecute 钩子失败语义改变工具行为 | 钩子 fail-fast 语义与 ADR-0025 §1 一致（拒绝并引导），preimage 钩子沿用 safeRecordPreimage 的"永不使工具失败"包装 |
| plan 工具迁入引入状态机回归 | 本阶段只搬运不改语义；现有 plan 测试（含 e2e）全绿为迁移完成条件 |

---

## 11. 验收条件

- [ ] `createAgentTools()` 产出的工具全部 schema-only（i2）
- [ ] 六个计算原语与协调类工具全部经 Registry 注册与分发；`definitions.ts` 不再拥有真实 `execute()`
- [ ] `toolRequestFromCall` 由 Registry 泛型解析替代；`PendingToolRequest` 为派生联合且序列化形状不变
- [ ] `match_mode`、`force`（模型表面）、`Skill`、`list_files`、`toolRequestFromMessage` 全部消失（全仓 grep 为零）
- [ ] `shell_execute` 模型表面仅 `command / description / timeout_ms / run_in_background`；inspect 快车道纯命令形态驱动（i10）
- [ ] §5 一致性测试 i1-i10 全部存在并通过
- [ ] ADR-0025 §1/§2 以 preExecute 钩子与 Schema 收敛落地（由 ADR-0026 承载）
- [ ] golden prompt 测试证明迁移期 description 字节稳定
- [ ] 受影响 `docs/active/` 与实现同批更新；`documentation-map.json` 映射准确
- [ ] 验证命令全绿：

```bash
bun test
bun run typecheck
bun run check:core-boundary
bun run check:docs
bun run check:docs-impact
bun run test:e2e
```

---

## 附录 A：PendingToolRequest 现存 20 个变体的处置

| 变体 | 目标 kind | 阶段 |
| --- | --- | --- |
| `read_file` / `edit_file` / `write_file` | computer | 1 |
| `search_files` / `search_content` | computer | 1 |
| `shell_execute` | computer（Schema 收敛） | 1 |
| `web_fetch` | computer | 2 |
| `task` | coordination | 2 |
| `tool_search` | coordination | 2 |
| `activate_skill` / `complete_skill` / `read_skill_reference` | coordination | 2 |
| `list_mcp_tools` / `list_mcp_resources` / `read_mcp_resource` | coordination | 2（随 MCP inventory RFC） |
| `ask_user` | interrupt | 2 |
| `read_plan` / `write_plan` / `update_plan` | runtime_action（语义不动） | 2 |
| `mcp__${string}` | 动态，binding 路径不变 | 保持现状 |
| `Skill` | **删除**（阶段 0） | 0 |

## 附录 B：现状文件 → 目标位置

| 现状 | 目标 |
| --- | --- |
| `tools/definitions.ts` 的 Schema + execute | Registry 生成 schema-only ToolSet；execute 移入 spec |
| `tools/tool-contracts.ts` 契约文本 | 移入 spec.contract；`buildDescription` 保留为生成器；`KNOWN_TOOL_NAMES` 由 Registry 派生（i4） |
| `harness/tool-requests.ts` 手写联合与解析 | 派生联合 + `registry.parseToolCall`；`getPendingToolRequest` 恢复路径复用之 |
| `harness/tool-runner.ts` 分支表 | `registry.dispatch` + spec.execute；pre-gates 上提为管线公共段 |
| `policies/tool-capabilities.ts` 静态名集 | spec.effects 投影；命令形态分析（shell）原样复用 |
| `policies/approval-policy.ts` 风险分支 | 消费 effects 投影，不再依赖模型声明的 intent |
| `controllers/tool-controller.ts` 路由表 | binding 校验链保留；内联分支随工具迁移删除 |
| `app/tui/components/render-utils.ts` 展示映射 | 消费 spec.projectResult 的 display 纯字符串提示 |
