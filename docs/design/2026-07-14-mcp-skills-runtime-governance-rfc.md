# MCP 与 Skills 的 Runtime 治理重构 RFC（已实施）

状态：approved（实施完成）
审核日期：2026-07-14
实施批准：2026-07-14
实施完成：2026-07-15
代码基线：`sp-0.1.0` / `bdc315e0bbee88d4fbfc9aad6a369de71d00bec9`
范围：MCP、Skills、工具绑定、授权、执行证据、验证与恢复
分类：Capability + Policy + Lifecycle + Engine

相关：

- [`../active/core-entry-criteria.md`](../active/core-entry-criteria.md)
- [`../active/tool-gated-autonomy.md`](../active/tool-gated-autonomy.md)
- [`../active/authorization.md`](../active/authorization.md)
- [`../active/feature-flags.md`](../active/feature-flags.md)
- [`../active/failure-classification.md`](../active/failure-classification.md)
- [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)
- [`../active/verification-governance.md`](../active/verification-governance.md)
- [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)
- [`../adr/0001-runtime-kernel.md`](../adr/0001-runtime-kernel.md)
- [`../adr/0007-capability-bindings.md`](../adr/0007-capability-bindings.md)
- [`../adr/0008-verification-completion-semantics.md`](../adr/0008-verification-completion-semantics.md)
- [`../space/plans/2026-07-14-mcp-runtime-governance-p0.md`](../space/plans/2026-07-14-mcp-runtime-governance-p0.md)（Phase 0 + 1，已完成）
- [`../space/plans/2026-07-14-mcp-skills-runtime-governance-followup.md`](../space/plans/2026-07-14-mcp-skills-runtime-governance-followup.md)（Phase 2–5，已完成）
- [`../space/execution/completed/2026-07-14-mcp-runtime-governance-p0.md`](../space/execution/completed/2026-07-14-mcp-runtime-governance-p0.md)（Phase 0 + 1 完成记录）
- [`../space/execution/completed/2026-07-15-mcp-skills-runtime-governance.md`](../space/execution/completed/2026-07-15-mcp-skills-runtime-governance.md)（Phase 2–5 完成记录）
- [`../space/understanding/2026-05-23-skills-system-design.md`](../space/understanding/2026-05-23-skills-system-design.md)

> 本文是设计基线，不描述完整的当前行为，也不能直接作为实现依据。当前行为以 `docs/active/`、ADR 和实现代码为准；实施过程与验证证据见对应计划和完成记录。

## 实施结果

RFC 的 Phase 0–5 已全部完成。Phase 0 + 1 的实现提交为 `b470ad0`；Phase 2–5 的实现提交依次为 `7f0b8d2`、`c67c0f0`、`3740558`、`8a76657`、`8cabc35`。最终形成 MCP Runtime 治理、分级验证和 progressive disclosure 三份 active 规则。

实施相对审核稿有三项收敛，以下结论覆盖正文中的早期建议：

1. `capabilitySearchV1=false` 恢复 revisioned Runtime 全量治理 binding，而不是仅保留显式配置的有限 binding；任何情况下都不恢复旧 MCP adapter 或 Skill 正文注入。
2. Runtime schema v10 在 capability state 中增加一次性 `pendingSearch` 与 turn-scoped `disclosures`，用于保证搜索候选只在下一轮按 revision 生成有限 binding。
3. 模型可见 MCP schema 会移除远端 `description`、`title`、`$comment`、`examples` 和 `default` 等自然语言注释；参数校验仍使用原始 revisioned schema。

## 一、审核结论

原方案的核心判断成立：Kite Code 不应把 MCP 仅视为动态工具列表，也不应把 Skill 仅视为一段注入模型的文本；二者都需要进入 Runtime Kernel 的能力发现、策略、执行、观测和恢复边界。

审核结论为“有条件通过”。以下内容保留：

1. 建立统一 Capability Catalog；
2. 使用不可变 revision 和 turn-scoped binding，避免按工具数量缓存；
3. 保留 MCP 结构化结果、错误、资源与元数据；
4. MCP annotations 只作为不可信提示，本地策略拥有最终决定权；
5. Skill 激活必须显式进入 Runtime，而不是由 TUI 拼接用户任务；
6. 外部写入必须有可恢复的 invocation 记录和执行结果；
7. 对需要验证的任务建立 Verify → Repair/Replan 闭环。

本审核不保留旧 Skill、旧 MCP 执行路径或旧 checkpoint 的兼容行为。原方案进入实施前只需做以下五项架构修正：

1. **不新增一套与现有 Kernel 平行的总状态机。** `UNDERSTANDING → DISCOVERING → ...` 只能作为概念流程；持久状态仍由 Runtime event/reducer 管理，只增加确有恢复价值的状态。
2. **所有 Kite Skill 统一为 Workflow Contract。** 不再为开放 Agent Skills 格式或旧 Prompt Loader 保留兼容层；`SKILL.md` 直接承载 Kite 的完整 manifest 和执行指令。
3. **不让所有任务都强制通过验证才能结束。** 验证分为 `not_required`、`best_effort`、`required`；Skill workflow、外部写入和高风险任务必须验证，普通问答不引入 stop-check。
4. **不承诺通用 exactly-once。** 对不受控外部系统只能实现持久化 intent、幂等键、at-most-once 自动重放和崩溃后的 reconciliation，目标是 effective-once，而不是无法证明的 exactly-once。
5. **P0 先修复已经断开的 MCP 垂直链路。** Skill Workflow、全局验证器和完整 Supervisor 属于后续阶段，不能阻塞 MCP 基本可用性恢复。

## 二、代码事实审核

审核基线分支 `sp-0.1.0` 与当前 `mcp` 分支指向同一提交。附件中的主要现状诊断均可由代码验证。

| 原判断 | 审核结果 | 代码证据 | 说明 |
| --- | --- | --- | --- |
| MCP 已连接但工具没有进入 Agent 工具集 | 成立 | `src/core/tools/definitions.ts` | `createAgentTools()` 明确暂时跳过 MCP tool synthesis；`@ai-sdk/mcp` 虽已安装，但其直接 ToolSet 执行模型不适合当前 Kernel。 |
| 动态 MCP 调用不能通过工具请求解析 | 成立 | `src/core/harness/tool-requests.ts` | `PendingToolRequest` 不包含动态 MCP 变体，`toolRequestFromCall()` 对 `mcp__*` 返回 `null`；下游虽有 `startsWith('mcp__')` 执行分支，但正常调用到不了该分支。 |
| MCP 结果被降级成字符串 | 成立 | `src/core/mcp/manager.ts` | `callTool()` 只拼接 text content，导致 `structuredContent`、`isError`、resource link、embedded resource 和 `_meta` 等信息丢失或模糊。 |
| MCP schema 适配 fail-open | 成立 | `src/core/mcp/tool-adapter.ts` | 未支持或空 schema 退化为 `z.any()`；当前依赖已能直接接受 JSON Schema，没有继续维护简化转换器的必要。 |
| MCP 工具缓存只依赖数量 | 成立 | `src/core/tools/definitions.ts` | cache key 使用 `mcpToolCount`；同数量替换工具或修改 schema 不能可靠失效。 |
| Skill 只是按需加载 Prompt | 成立 | `src/core/skills/skill-tool.ts`、`src/core/skills/loader.ts` | `Skill` 返回正文，没有 activation/frame、依赖、能力上限、验证或恢复状态。 |
| 用户激活的 Skill 直接拼接进任务 | 成立 | `src/app/tui/run-agent.ts`、`src/app/tui/session-manager.ts` | `pendingSkillsContent + task + shellContext` 绕过 Runtime 的显式生命周期。 |
| Skill frontmatter 解析不完整且错误静默 | 成立 | `src/core/skills/loader.ts` | 自定义解析器跳过嵌套字段，扫描异常静默忽略，正文超过 100KB 直接截断。 |
| Runtime 已具备可扩展的事件化基础 | 成立 | `src/core/runtime/*`、ADR-0001 | Kernel、reducer、scheduler、effect、审批、Plan Artifact 与恢复边界应复用，不应推倒重写。 |
| 模型停止即可触发任务完成 | 成立，但需谨慎修正 | `src/core/runtime/scheduler.ts`、`runner.ts` | `transcript.final` 直接形成 `emit_final → run.completed`；应只对 `required` 验证任务增加门禁，避免重新引入全局 stop-check。 |

### 2.1 当前最危险的断裂

当前 MCP 存在“展示能力”和“执行能力”不一致：连接、工具枚举、TUI 展示与策略分支都存在，但模型拿不到可执行 MCP tool；即便手工重新注入旧 adapter，正常 tool call 仍会在 `toolRequestFromCall()` 被丢弃。

这不是单点 TODO，而是四段契约同时断开：

```text
MCP discovery
  → model-visible tool binding       当前禁用
  → runtime invocation parsing       当前不接受动态 MCP
  → policy / approval                已有名称级策略，但粒度不足
  → result normalization             当前降级为字符串
```

因此 P0 必须以端到端垂直切片修复，不能只取消 `definitions.ts` 中的注释。

## 三、公开机制核验后的边界

### 3.1 可借鉴的事实

- Codex 将 sandbox 与 approval 视为不同控制层；MCP/app 的副作用调用同样可进入审批。
- Codex Skills 采用渐进披露：初始仅提供名称、描述和路径，激活后再读取完整 `SKILL.md`；Skill 可携带 scripts、references 和 assets。
- Claude Code 支持 MCP tool search、Skill 的 `context: fork`、生命周期 hooks 与工具权限配置。
- MCP 规范支持 `structuredContent`、`outputSchema`、多种 content block、`isError` 和 tool annotations；规范明确要求不可信 server 的 annotations 不能直接作为安全决策依据。
- Agent Skills 的 scripts/references/assets 目录组织仍值得借鉴，但 Kite 不承诺 manifest 字段或授权语义兼容。

### 3.2 不能直接照搬的部分

- Claude Code 的 `allowed-tools` 可以在 Skill 激活期间免除逐次确认；Kite 的安全模型不应让项目仓库中的 Skill 自行授予权限。
- Claude 的 tool search 依赖具体模型/provider 能力；Kite 是多 provider 系统，必须有 provider 无关的 fallback。
- MCP annotations 是 hint，不是 capability sandbox。远端 MCP server 可以错误标注甚至撒谎，本地 Runtime 只能约束“是否调用”和“向它发送什么”，不能保证远端实际副作用。
- Codex/Claude 的产品行为只能作为参考，不能代替 Kite 自己的 event、policy、checkpoint 和恢复不变量。

### 3.3 MCP SDK 选型结论

**唯一 MCP 协议实现选用 `@modelcontextprotocol/sdk`。不使用 `@ai-sdk/mcp`，并在迁移完成后删除该依赖。**

职责划分：

```text
@modelcontextprotocol/sdk
  transport / initialize / notifications / list / call / resources / prompts
  protocol schema validation / structured result / cancellation

ai
  dynamicTool() / jsonSchema()
  只生成模型可见的工具声明，不连接 MCP，也不执行 MCP tool

Kite Runtime
  binding / policy / approval / persistence / retry / result normalization
```

选择依据：

1. 当前 `invokeBoundModel()` 会主动移除 tool definition 的 `execute`，确保工具只能由 Runtime Kernel 执行；`@ai-sdk/mcp` 主要提供带 `execute` 的 AI SDK ToolSet，与此边界相反。
2. 当前版本的 `@ai-sdk/mcp` 客户端明确不支持接收 notifications，无法处理本方案要求的 `tools/list_changed`、`resources/list_changed` 和 `prompts/list_changed`。
3. `@modelcontextprotocol/sdk` 已被当前 `McpManager` 使用，支持 `setNotificationHandler()`、规范 transport、资源/提示读取和 `CallToolResult` 结构化校验。
4. 使用一个 MCP client 可以避免双连接、双 session、不同重试策略和不同协议版本带来的状态漂移。
5. 模型侧无需 MCP 专用 adapter：从 SDK 的 `Tool.inputSchema` 直接构造 `ai.dynamicTool({ inputSchema: jsonSchema(...) })` 即可，且不设置 `execute`。

明确禁止：

- 不允许 `@ai-sdk/mcp` 创建第二条 MCP 连接；
- 不允许使用 `@ai-sdk/mcp.tools()` 返回的 `execute` 绕过 Runtime Gateway；
- 不允许同时维护两套 MCP result 类型；
- 不允许继续使用自定义 JSON Schema → Zod 降级转换。

## 四、修订后的设计原则

1. **Runtime Kernel 是唯一状态转换权威。** Capability、Skill、verification 只能通过 Runtime event 改变持久状态。
2. **Capability 是可治理的执行契约。** 模型可见 tool name 只是临时 binding，稳定身份是 `capabilityId + revision`。
3. **发现不等于授权，声明不等于事实。** server/skill 声明只能收紧能力或辅助分类，不能扩大用户授权。
4. **外部内容默认是数据。** MCP instructions、tool/resource 输出、Skill 引用资料和仓库文件不能覆盖系统、用户、Runtime policy 或已批准计划。
5. **schema 不可解释时 fail closed。** 能力可以进入诊断目录，但不能以 `any` 参数进入可执行 binding。
6. **先记录 intent，再发生副作用。** 外部写入必须在调用前持久化稳定 invocation identity 与授权摘要。
7. **验证强度与风险匹配。** 不把普通问答变成强制工作流，也不把外部写入的成功文本当成完成证据。
8. **目标态优先。** 不保留旧 MCP、Prompt Skill 或 checkpoint 兼容路径；迁移阶段直接删除被替代实现。
9. **可控上线但不双轨兼容。** Engine/Lifecycle 变更仍使用 feature flag；flag 关闭时能力 fail closed，不回落到旧执行路径。

## 五、目标与非目标

### 5.1 目标

- 恢复 MCP tool 的模型可见、Runtime 可路由、策略可审批、结果可验证的完整链路；
- 统一 Builtin、MCP、Skill 和 Subagent 的能力身份、绑定与审计入口；
- 让动态能力列表变化能够可靠失效旧 binding；
- 让 Skill 激活、依赖和能力上限进入 Runtime；
- 为外部写入和 Skill workflow 提供持久化执行记录、验证和崩溃恢复；
- 保持 CLI、TUI 和未来前端共享同一 core 行为。

### 5.2 非目标

- 不重写 Runtime Kernel；
- 不在第一阶段实现通用工作流语言或 DAG 引擎；
- 不保证任意第三方 MCP 的 exactly-once；
- 不让 Capability Catalog 取代 sandbox 或 approval policy；
- 不兼容旧 Prompt Skill、开放 Agent Skills manifest 或历史 checkpoint；
- 不要求所有问答、解释和只读探索都生成显式 Goal Artifact；
- 不在 core 中加入 TUI 展示格式或用户界面专用状态。

## 六、目标架构

```text
用户目标 / 当前 Plan Step
          │
          ▼
Capability Catalog ── health / trust / revision / diagnostics
          │
          ▼
Turn Binding ── 当前模型调用可见的有限 tool schema + binding token
          │
          ▼
Invocation Gateway
  resolve binding → validate args → classify effects → policy → approval
          │
          ▼
Provider Adapter
  builtin / MCP / skill workflow / subagent
          │
          ▼
Normalized Result + Runtime Events
          │
          ├── verification not required → 继续模型循环
          ├── best effort              → 记录结果并允许带风险完成
          └── required                 → Verify → Repair / Replan / User Decision
```

架构只增加能够被恢复、重放或策略使用的状态。意图理解和一般模型推理不单独持久化成阶段枚举。

## 七、Capability Catalog 与 Binding

### 7.1 CapabilityDescriptor

```ts
type CapabilityKind =
  | 'builtin_tool'
  | 'mcp_tool'
  | 'mcp_resource'
  | 'mcp_prompt'
  | 'skill'
  | 'subagent';

interface CapabilityDescriptor {
  capabilityId: string; // 例如 mcp:github/create_issue
  revision: string;     // descriptor 的规范化内容摘要
  kind: CapabilityKind;
  displayName: string;
  description: string;

  provider: {
    type: 'builtin' | 'mcp' | 'skill' | 'subagent';
    id: string;
    version?: string;
    provenance: 'builtin' | 'admin' | 'user' | 'project' | 'remote';
  };

  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  declaredEffects: EffectProfile;
  effectiveEffects: EffectProfile;

  execution: {
    timeoutMs: number;
    retry: 'never' | 'safe_read' | 'idempotency_key';
    cancellable: boolean;
  };

  policy: {
    workspaceTrustRequired: boolean;
    minimumApproval: 'none' | 'auto_review' | 'user';
  };

  availability: 'available' | 'degraded' | 'unavailable' | 'quarantined';
  diagnostics: string[];
}
```

`declaredEffects` 保存 provider 的原始声明；`effectiveEffects` 是本地配置、trust、annotations 和保守默认值合并后的策略输入。二者不能覆盖写入，以便审计“server 声明了什么”和“Runtime 实际相信什么”。

### 7.2 Snapshot 与 revision

每次 MCP `tools/list`、`resources/list`、`prompts/list` 或 Skill 扫描形成不可变 snapshot。revision 必须对以下规范化字段计算摘要：

- capability identity；
- input/output schema；
- annotations 与本地 policy override；
- provider/version/provenance；
- availability；
- Skill manifest、正文、脚本、引用和资源摘要。

不能使用工具数量、数组引用或连接布尔值作为 revision。`list_changed` 后计算新 snapshot，Catalog 原子替换；已有 binding 不被静默改写，而是在执行时因 revision 不匹配而失败并要求重新绑定。

### 7.3 Turn-scoped binding

模型不能直接凭任意 `capabilityId` 调用 Catalog。每次模型请求只接收当前 turn 的有限 binding：

```ts
interface CapabilityBinding {
  bindingId: string;
  capabilityId: string;
  capabilityRevision: string;
  exposedToolName: string;
  schemaDigest: string;
  issuedForTurnId: string;
  expiresAt?: string;
}
```

执行入口按 `bindingId/toolCallId` 解析，不按模型生成的自由字符串从全局 Catalog 查找。工具列表变化、schema 变化或 turn 结束后，旧 binding 不能用于新调用。

### 7.4 Progressive disclosure

分三层披露：

1. Catalog index：名称、短描述、kind、availability；
2. Candidate contract：完整输入 schema、输出摘要、effect 与审批要求；
3. Bound execution：当前 turn 真正可调用的工具定义。

第一阶段允许在严格 allowlist 和 context budget 内直接绑定全部 MCP 工具，以尽快恢复链路；工具较多时再启用 `capability_search`。`capability_search` 只返回候选元数据，并触发下一轮重新绑定，不提供绕过 schema/policy 的通用执行后门。

不推荐向模型暴露裸 `capability_invoke({ capability_id, arguments })`。该形式会弱化每个工具的 schema、provider tool choice 与审批展示质量。

## 八、统一 Invocation，但保留内置强类型

原方案直接用一个完全动态接口替换 `PendingToolRequest`，会让内置文件、shell、计划和用户输入工具失去编译期收窄。建议先引入公共 envelope：

```ts
interface InvocationEnvelope<TArgs = unknown> {
  invocationId: string;
  toolCallId: string;
  binding: CapabilityBinding;
  args: TArgs;
  intent?: {
    objective?: string;
    expectedObservation?: string;
    failureStrategy?: string;
  };
  context: {
    threadId: string;
    turnId: string;
    taskId?: string;
    planId?: string;
    stepId?: string;
    skillActivationId?: string;
  };
}

type RuntimeInvocation =
  | BuiltinInvocation // 现有判别联合，经 adapter 生成
  | InvocationEnvelope<unknown>; // 动态 MCP / Skill workflow
```

迁移顺序：

1. 为 `mcp__*` 增加动态解析分支，打通当前阻塞；
2. 让所有请求都携带 invocation/binding/context envelope；
3. 将 Builtin 的名称分支移动到 provider adapter；
4. 只有在测试证明收益后，才考虑删除旧判别联合。

## 九、MCP Provider 重构

### 9.1 模块职责

```text
McpManager（生命周期聚合入口，逐步变薄）
  ├── McpConnection：transport、protocol client、initialize result
  ├── McpDiscovery：tools/resources/prompts snapshot 与 revision
  ├── McpProviderAdapter：schema、调用、结果归一化
  └── McpHealth：连接状态、退避、熔断和 quarantine
```

不要求在 P0 一次性拆出所有类。先建立接口和测试缝，再逐段迁移现有 `McpManager`。

### 9.2 Schema 处理

删除自定义 `jsonSchemaToZod()` 的 fail-open 路径。`@modelcontextprotocol/sdk` 负责协议 schema 与结果校验；模型侧直接使用 `ai` 包导出的 `dynamicTool()` 和 `jsonSchema()` 生成无 `execute` 的工具声明。

规则：

- 保存 server 原始 JSON Schema；
- 注册时进行 meta-schema/支持性检查；
- 可直接传递的 schema 不做有损转换；
- provider 不支持的合法 schema 将能力标记为 `unavailable` 并显示诊断；
- 不合法 schema 进入 `quarantined`；
- 任意 schema 降级都必须显式配置，默认禁止；
- output schema 存在时必须验证 `structuredContent`。

### 9.3 结构化结果

```ts
interface CapabilityResult {
  status: 'success' | 'partial' | 'error' | 'cancelled' | 'unknown';
  content: CapabilityContent[];
  structuredContent?: unknown;
  error?: ClassifiedFailure;
  observedEffects: EffectObservation[];
  evidence: EvidenceReference[];
  providerMeta?: Record<string, unknown>;
}
```

MCP adapter 必须保留：

- `content` 的 text、image、audio、resource link 和 embedded resource；
- `structuredContent`；
- `isError`；
- output schema 验证结果；
- `_meta` 中允许持久化的白名单字段。

`_meta`、resource 和 text 可能包含密钥或隐私数据。原始结果可以写入有大小上限和访问控制的 Artifact Store；Runtime event 只保存摘要、digest、handle 与安全审计字段。不得把完整结果无条件写入 checkpoint 或日志。

### 9.4 健康状态

连接状态至少区分：

```text
disconnected → connecting → discovering → ready
                               ├→ degraded
                               ├→ circuit_open
                               └→ quarantined
```

删除 `connected: boolean` 及其分支，所有调用方直接消费 health state。

### 9.5 Effect 与审批

本地分类优先级：

```text
管理员/用户 per-tool override
  > 本地静态分类规则
  > 可信 server annotations
  > 保守默认值
```

不可信或没有 annotations 的 MCP tool 默认视为 `externalState: unknown`，等同高风险写入，需要人工审批；不能仅因 server 级 `risk: read` 就把所有工具降级为只读。

审批至少绑定：

```text
capabilityId
capabilityRevision
argumentsDigest
effectiveEffectsDigest
taskId / planStepId
singleUse
expiresAt
```

参数、schema、effect 或 capability revision 任一变化，旧审批失效。

### 9.6 重试与崩溃恢复

- 只读调用可按 failure classification 退避重试；
- 外部写调用默认不自动重试；
- 只有可信能力明确支持 idempotency key，且 Runtime 重用同一个 key 时，才允许自动重试；
- 调用前持久化 invocation intent，调用后记录 success/error/unknown；
- 进程在“请求已发出、结果未持久化”之间崩溃时，状态必须是 `unknown`；
- 恢复后优先使用 provider 查询、read-after-write 或外部引用 reconciliation；
- 无法确认时请求用户决策，不得重新写入。

这提供 effective-once 体验，但不对不受控远端系统作 exactly-once 保证。

## 十、Skills：统一 Workflow Contract

### 10.1 唯一 Skill 模型

Kite 只保留一种 Skill：具有输入、依赖、能力上限、副作用、执行指令、输出、验证和恢复策略的 Workflow Contract。

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
├── assets/
└── evals/
```

`SKILL.md` 是唯一 manifest 与指令入口，不使用 sidecar，也不兼容旧的 `name + description + prompt body` 格式。缺少必需契约字段的目录不是 Skill。

### 10.2 Skill Manifest

```yaml
---
name: create-release
version: 1.0.0
description: Create and verify a release.

invocation:
  allow_implicit: false
  allow_manual: true

context:
  mode: fork
  agent: code

input_schema:
  type: object
  required: [version]
  properties:
    version:
      type: string

output_schema:
  type: object
  required: [release_url, tag]

capabilities:
  require:
    - builtin:read_file
    - builtin:shell_execute
    - mcp:github/create_release
  deny:
    - mcp:github/delete_repository

effects:
  filesystem: write
  network: write
  external_state: write

approval:
  minimum: user

execution:
  timeout_ms: 300000
  max_attempts: 1

verification:
  mode: required
  strategy: script
  entrypoint: scripts/verify.ts
  timeout_ms: 30000

recovery:
  retry: never
  compensation: scripts/rollback.ts
---

# 执行步骤

1. 检查输入版本和仓库状态。
2. 生成并提交 release。
3. 运行 verifier 并输出 release URL 与 tag。
```

manifest schema 必须版本化并严格校验。未知顶层字段、缺少必填字段、不可解析 schema、缺失 capability、脚本越界或 effect 声明矛盾都会使 Skill 进入 `invalid`，不能激活。

### 10.3 Skill Compiler

```text
discover
→ parse complete YAML
→ validate manifest version/schema
→ resolve dependencies and capability revisions
→ verify effect/approval consistency
→ verify scripts/references/assets/evals
→ compute immutable revision
→ compile Skill execution contract
→ register Capability Catalog
```

要求：

- 使用完整 YAML parser，不再自定义按行解析；
- 所有加载错误形成结构化 diagnostics，并在 TUI/CLI 可查询；
- 单个损坏 Skill 不阻塞启动，但绝不能静默跳过；
- 不截断后假装完整加载，超限文件直接使编译失败或转为显式 artifact/reference；
- project/user/admin/builtin 的来源与覆盖规则写入 provenance；
- Skill revision 必须覆盖 manifest、正文、脚本、引用、资源和 evals；
- 任一依赖 capability revision 变化后，旧 activation 立即失效。

Skill 的声明只能收紧权限。最终可用能力为：

```text
组织策略
∩ Workspace Trust
∩ Session/User 授权
∩ Skill capability ceiling
∩ Capability effect policy
∩ Sandbox 技术边界
```

### 10.4 Skill Activation 与执行

旧 `Skill` Prompt Loader 直接删除。模型调用或用户显式触发都创建 activation：

```ts
interface SkillActivation {
  activationId: string;
  skillId: string;
  skillRevision: string;
  taskId: string;
  input: unknown;
  contextMode: 'inline' | 'fork';
  capabilityCeiling: string[];
  verificationMode: 'not_required' | 'best_effort' | 'required';
}
```

激活后 Runtime 验证 input schema，创建持久 Skill Frame，绑定 capability ceiling 内的有限能力，并按 `inline` 或 `fork` 执行正文步骤。每次能力调用仍经过全局 policy；Skill 声明不能预批准工具。

Skill 结束前必须：

1. 关闭所有未决 invocation；
2. 生成符合 output schema 的结构化结果；
3. 按 manifest 运行 verifier；
4. required verification 通过或由用户显式 waive；
5. 关闭 Skill Frame 并释放临时 binding。

TUI 不再把 `pendingSkillsContent` 拼到用户 task，也不存在“只加载正文但未创建 activation”的路径。

### 10.5 默认禁止隐式触发的 Skill

下列 Skill 强制 `allow_implicit: false`：

- 发布、部署或产生费用；
- 创建、合并或关闭 PR；
- 发送消息或修改外部工单；
- 删除外部资源；
- 修改账号、凭据或权限；
- 执行不可逆或难补偿操作。

模型可以建议激活，但不能代表用户隐式启动。

## 十一、Execution Record、Evidence 与 Verification

### 11.1 事件是事实源

不新增与 Runtime Store 平行的独立账本。执行记录由 Runtime events 形成投影：

```text
capability.invocation_recorded  // 外部副作用前持久化 intent
capability.execution_started
capability.execution_succeeded
capability.execution_failed
capability.execution_unknown
verification.requested
verification.passed
verification.failed
verification.inconclusive
```

`ExecutionReceipt` 是这些事件的查询投影，不是第二套可独立写入的事实源：

```ts
interface ExecutionReceipt {
  invocationId: string;
  capabilityId: string;
  capabilityRevision: string;
  argumentsDigest: string;
  authorizationDecisionId: string;
  status: 'success' | 'partial' | 'error' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  observedEffects: EffectObservation[];
  evidence: EvidenceReference[];
  idempotencyKey?: string;
  externalReferences?: string[];
}
```

### 11.2 分级验证策略

```ts
type VerificationMode = 'not_required' | 'best_effort' | 'required';
```

| 模式 | 适用场景 | 完成语义 |
| --- | --- | --- |
| `not_required` | 普通问答、解释、无可判定后置条件的只读对话 | 无未解决调用/交互即可结束，不新增 stop-check。 |
| `best_effort` | 代码阅读、调研、低风险本地修改 | 尽力执行验证；无法执行时可结束，但最终结果必须标明未验证及原因。 |
| `required` | 外部写入、部署/发布、Skill workflow 明确要求、用户明确要求验证 | `passed` 或用户显式 `waived` 前不得标记为已验证完成。 |

以下条件只能提升验证强度，不能由 Skill 或模型降低：

- effective effect 为 external write/destructive/unknown；
- 用户明确要求测试、验证、发布或确认外部状态；
- Skill manifest 声明 `required`；
- policy 将 capability 归为高风险；
- 恢复时存在状态为 `unknown` 的 invocation。

### 11.3 VerificationSpec

```ts
interface VerificationSpec {
  mode: VerificationMode;
  assertions: Array<
    | { type: 'file_exists'; path: string }
    | { type: 'file_contains'; path: string; pattern: string }
    | { type: 'command_succeeds'; command: string }
    | { type: 'schema'; source: EvidenceReference; schema: JsonSchema }
    | { type: 'mcp_read_after_write'; capabilityId: string }
    | { type: 'external_reference_resolves'; reference: string }
    | { type: 'reviewer'; rubric: string }
  >;
  allRequired: boolean;
}
```

验证优先级：

```text
确定性本地断言
  > provider 结构化查询 / read-after-write
  > 测试、构建和静态检查
  > 独立 reviewer 读取原始 evidence
  > 主模型自我判断
```

Reviewer 不能只读取主模型结论；它必须获得原始 receipt/evidence handle。模型判断不能证明外部副作用确已发生。

### 11.4 完成语义

Scheduler 不应无条件把所有 `transcript.final` 改成 `run_verification`。修订规则：

```text
存在未解决 tool / interaction       → 继续处理
存在 required verification pending  → run_verification
required verification failed         → repair / replan / awaiting_user
required verification passed/waived  → emit_final
其他任务出现 final                   → emit_final
```

`waived` 必须来自用户的结构化决定，并保留“未验证完成”的结果状态；模型不能自行豁免。

### 11.5 修复预算

必须配置：

- 每个 invocation 最大尝试次数；
- 每类 capability 的重试策略；
- 单 task effect budget；
- verification/repair 循环上限；
- circuit breaker 条件；
- compensation 触发条件。

预算耗尽进入结构化 failure 或 `awaiting_user`，不能无限自我修复。

## 十二、Runtime 集成方式

### 12.1 不新增平行总状态机

原方案的阶段图保留为解释模型，但不直接变成 `RuntimeState.phase`。真正新增的 durable state 仅包括：

```ts
interface CapabilityRuntimeState {
  catalogRevision: string;
  bindings: Record<string, CapabilityBinding>;
  invocations: Record<string, InvocationRecord>;
}

interface SkillRuntimeState {
  activations: Record<string, SkillActivationRecord>;
}

interface VerificationRuntimeState {
  mode: VerificationMode;
  status: 'idle' | 'pending' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'waived';
  attempt: number;
}
```

协议事件 payload 放在 `src/protocol/`；core 中只实现 catalog、policy、adapter、scheduler 与 reducer，遵守 `app → core → protocol` 边界。

### 12.2 Effect 扩展

建议增加最小 effect：

```text
refresh_capabilities
run_capability
run_verification
reconcile_invocation
```

`repair` 和 `replan` 优先复用现有 model/plan effect，而不是创建另一套执行器。

### 12.3 事件不变量

- Controller 只发事实事件，不直接修改 RuntimeState；
- 外部写入的 `invocation_recorded` 必须先于 provider call 持久化；
- reducer 是状态转换唯一入口；
- binding revision 不匹配时不能执行；
- `run.completed` 不能跨过 pending required verification；
- replay 不得重新触发已经有终态 receipt 的外部写入；
- 日志和 checkpoint 中的敏感数据必须经过白名单/脱敏处理。

## 十三、代码映射

建议逐步增加：

```text
src/core/capabilities/
├── catalog.ts
├── descriptor.ts
├── snapshot.ts
├── binding.ts
├── invocation.ts
├── result.ts
└── diagnostics.ts

src/core/mcp/
├── discovery.ts
├── provider-adapter.ts
├── result-normalizer.ts
└── health.ts

src/core/skills/
├── schema.ts
├── compiler.ts
├── catalog.ts
├── activation.ts
├── runtime.ts
├── verifier.ts
└── diagnostics.ts

src/core/verification/
├── policy.ts
├── runner.ts
├── assertions.ts
└── recovery.ts
```

现有文件的迁移职责：

### `src/core/tools/definitions.ts`

- 移除按 `mcpToolCount` 缓存；
- 接收当前 binding snapshot/revision；
- 使用原生 JSON Schema 创建动态 MCP tool definition；
- 保持内置工具 schema 顺序稳定；
- 在 progressive disclosure 启用时只加入本 turn 已绑定工具。

### `src/core/harness/tool-requests.ts`

- P0 先支持动态 `mcp__*` request；
- 再引入 InvocationEnvelope；
- 内置工具继续使用判别联合和强类型 adapter；
- 未绑定、过期或 revision 不匹配的动态工具 fail closed。

### `src/core/controllers/model-controller.ts`

- 模型调用前读取 Catalog snapshot；
- 按 provider 能力和 context budget 选择全部绑定或搜索模式；
- 保存本 turn binding；
- 不允许模型通过自由字符串调用未绑定能力。

### `src/core/controllers/tool-controller.ts` / `src/core/runtime/executor.ts`

统一执行顺序：

```text
resolve binding
→ validate arguments
→ resolve effective effects
→ policy / approval
→ persist invocation intent
→ provider call
→ normalize result
→ emit terminal execution event
→ schedule verification when required
```

### `src/core/mcp/manager.ts`

- `callTool()` 返回原始规范结果或无损内部类型，不再返回拼接字符串；
- discovery 生成 revisioned snapshot；
- 连接状态升级为 health projection；
- 逐步将 transport/session 与 catalog adapter 分离。

### `src/core/mcp/tool-adapter.ts`

- 删除简化 JSON Schema → Zod 转换；
- 仅使用 `@modelcontextprotocol/sdk` 的 Tool/CallToolResult 类型；
- 用 `ai.dynamicTool()` + `ai.jsonSchema()` 生成无 `execute` 的模型工具声明；
- 不在 adapter 内直接执行绕过 Runtime gateway 的 provider call。

### `src/core/skills/loader.ts`

- 使用标准 YAML parser；
- 严格编译完整 Workflow Contract；
- 输出 catalog entry + diagnostics；
- revision 变化必须使旧 activation 失效。

### `src/core/skills/skill-tool.ts`

- 删除返回正文的 `Skill` 工具；
- 新工具只请求 Skill activation，并返回 activation ID；
- Skill Frame 和正文注入完全由 Runtime 驱动。

### `src/app/tui/run-agent.ts`

- 删除 `pendingSkillsContent + task`；
- 用户 slash/显式选择转换为 `skill.activation_requested` action/event；
- TUI 只渲染 diagnostics、activation 和 verification，不决定 core 策略。

### `src/core/runtime/*`

- events/state/reducer 增加 capability、skill activation 和分级 verification 投影；
- scheduler 只对 required verification 插入 effect；
- store 保证外部副作用 intent 的持久化顺序；
- replay/golden 测试覆盖崩溃边界；历史 snapshot 不提供兼容回放。

## 十四、迁移计划

### Phase 0：基线、ADR 与安全测试

- 记录当前 MCP discovery、binding、policy、执行和结果链路；
- 增加断链回归测试，明确“能展示但不能执行”的当前失败；
- 为动态 schema、prompt injection、list change、写超时和崩溃恢复建立 fixture；
- 提交 Capability identity/binding ADR；
- 提交 verification completion semantics ADR；
- 注册默认关闭的 feature flags。

退出标准：能够通过 trace 回答能力来自哪里、为何可见、为何被允许、是否执行以及结果如何解释。

### Phase 1（P0）：恢复安全的 MCP 垂直链路

- 确立 `@modelcontextprotocol/sdk` 为唯一 MCP client；
- 使用 `ai.dynamicTool()` + `ai.jsonSchema()` 生成无执行器的模型工具声明；
- 删除 `@ai-sdk/mcp` 依赖和旧 `jsonSchemaToZod()`；
- 支持动态 MCP invocation envelope；
- 使用原生 JSON Schema，拒绝不兼容 schema；
- 以 Catalog revision 替换数量缓存；
- `callTool()` 返回结构化结果；
- 保留现有 policy gateway，并将审批绑定参数/revision digest；
- 覆盖 text、structured、resource、`isError` 和 list_changed。

退出标准：fixture server 的读工具可直接运行，写工具必须审批；新增/删除/修改 schema 后旧 binding 不能执行；正常链路不再出现 `Unsupported tool`。

### Phase 2（P0/P1）：Health、Execution Record 与恢复

- 引入 health projection、退避、circuit breaker、quarantine；
- 外部写入前持久化 invocation intent；
- 形成 receipt projection；
- 实现 idempotency key 和 unknown 状态 reconciliation；
- 对大结果使用 Artifact Store handle。

退出标准：崩溃恢复不会盲目重复外部写入，任何外部写入都可查询授权、参数摘要、结果和外部引用。

### Phase 3（P1）：Skill Workflow Compiler 与 Activation

- 完整 YAML parser、严格 manifest schema 和结构化 diagnostics；
- input/output schema、capability ceiling、effect、approval 和 execution contract；
- 引入 activation event/frame；
- 删除 TUI task 字符串拼接；
- 删除旧 Prompt Skill loader、类型和测试；
- 对大 references/scripts 按需读取；
- 明确 project Skill 不提升权限。

退出标准：所有 Skill 都编译为 Workflow Contract；可查询来源、revision、激活者、生命周期和能力上限；损坏 Skill 可见诊断但不能激活。

### Phase 4（P1/P2）：Skill Verifier 与分级 Verification

- Skill output schema、verifier、context fork；
- `not_required/best_effort/required` 验证策略；
- deterministic assertions、read-after-write 和 reviewer；
- repair/replan/waive/compensation 路径；
- effect/repair budget。

退出标准：Skill workflow 的输出通过 schema 与 verifier；required verification 未通过时不能宣称已验证完成。

### Phase 5（P2）：Progressive Disclosure

- 按 provider/context budget 启用 `capability_search`；
- 有限 turn binding 和搜索后的下一轮绑定；
- 验证大规模 MCP/Skill catalog 的 context budget 和搜索召回率；
- 搜索失败或 provider 不支持时 fail closed，不回落到旧工具注入路径。

退出标准：大量 MCP/Skill 不会无界占用上下文，所有执行仍只能经过 binding 与 policy gateway。

## 十五、Feature Flag 与回滚

建议按现有命名规则注册，默认均为 `false`：

```text
capabilityCatalogV1
mcpRuntimeBindingV1
mcpExecutionRecordV1
skillActivationV2
skillWorkflowV1
verificationV1
capabilitySearchV1
```

回滚原则：

- feature flag 只控制新子系统是否启用，不保留旧实现；
- 关闭 `mcpRuntimeBindingV1` 时 MCP tool 不可调用；
- 关闭 `skillWorkflowV1` 时 Skill 不可激活；
- 关闭 `capabilitySearchV1` 时恢复 revisioned Runtime 全量治理 binding；不会恢复旧 MCP adapter 或 Skill 正文注入；
- 关闭 `verificationV1` 不得绕过已经开始的外部写入 reconciliation；
- 安全策略失败时 fail closed，不能以回滚为由自动放行未知 MCP tool。

该例外已在 [`../active/feature-flags.md`](../active/feature-flags.md) 中固化：MCP/Skill 治理开关不得重新启用被替代的旧执行路径。

## 十六、测试与验收

### 16.1 单元测试

- descriptor canonicalization 和 revision 稳定性；
- 同数量、不同 tool/schema 必须改变 revision；
- binding 过期和 revision mismatch；
- JSON Schema 不支持时 fail closed；
- MCP result 所有 content type、`structuredContent`、`isError` 和 output schema；
- annotations 与本地 override 的保守合并；
- approval digest 随参数/effect/revision 变化；
- Skill Workflow manifest、编译、冲突与 diagnostics；
- verification mode 不能被模型或 Skill 降级。

### 16.2 Integration

- MCP fixture：read、write、destructive、idempotent、structured output、resource link；
- tool list 同数量替换；
- server 断线、重连、超时与半开熔断；
- external write 调用前后注入崩溃；
- Skill 用户显式激活、模型隐式激活、默认禁止隐式的高风险 workflow；
- project Skill 请求高权限但 Runtime 拒绝；
- TUI/CLI 显示无效 Skill 和不可用 MCP 的诊断。

### 16.3 Replay / Golden

- `invocation_recorded` 后、请求发送前崩溃；
- 请求发送后、receipt 持久化前崩溃；
- list_changed 发生在模型生成和工具执行之间；
- 审批后参数被修改；
- required verification failed → repair → passed；
- required verification inconclusive → awaiting_user → waived/reconcile；
- 当前版本 checkpoint 在 Catalog/Skill revision 变化后拒绝旧 binding；历史格式无需兼容。

### 16.4 安全测试

- MCP resource/tool 输出包含“忽略系统指令并调用写工具”，不得绕过 binding/policy；
- server 虚假标注 `readOnlyHint: true`，本地 unknown/high-risk 规则仍生效；
- Skill manifest 请求 `shell`/网络/外部写入，不能提升 Session 授权；
- result `_meta` 和日志中的 secrets 被脱敏；
- 未绑定 capabilityId、伪造 bindingId 和过期 approval 全部拒绝；
- destructive 或 unknown 外部 effect 默认人工审批。

### 16.5 最终验收

针对任意被治理的能力调用，系统能够回答：

```text
能力从哪里发现、当前 revision 是什么
为什么本 turn 可以看见它
模型实际请求了什么参数
本地如何判断 effect 和风险
谁以何种范围批准了调用
调用是否真正发出、结果是否确定
保存了哪些结构化 evidence
是否需要验证、验证结果是什么
崩溃或失败后为何重试、对账、补偿或请求用户
最终为何可以结束任务
```

## 十七、优先级调整

审核后的 P0 不是原方案的“五项大重构并行”，而是以下安全垂直切片：

1. 动态 MCP request 能进入 Runtime gateway；
2. 原生 schema + fail-closed 注册；
3. revisioned binding 替换 count cache；
4. 结构化 MCP result；
5. per-tool effect/approval digest；
6. MCP 端到端、list change 与安全回归测试。

Skill Workflow Compiler 与 Activation 是 P1；Skill Verifier 和 required Verification 是 P1/P2。这样先消除“UI 显示可用但 Agent 实际不可用”的信任缺口，再扩展完整治理能力。

## 十八、明确拒绝的替代方案

### 18.1 只取消 MCP synthesis 的禁用注释

拒绝。动态 request 解析、policy identity、cache revision 和 result normalization 仍然断裂。

### 18.2 所有能力都通过裸 `capability_invoke`

拒绝。它会弱化工具级 schema、provider tool choice、审批摘要和模型可理解性，并扩大任意字符串调用面。

### 18.3 用完全动态类型一次替换所有 Builtin union

拒绝。当前内置工具从判别联合获得的编译期安全有价值，应通过 adapter 渐进统一。

### 18.4 把 Skill 保留为 Prompt Loader

拒绝。Kite Skill 的唯一语义是 Workflow Contract；只返回正文无法表达输入、依赖、能力上限、输出、验证和恢复。

### 18.5 所有 final 前运行强制 verification

拒绝。它会重新引入全局 stop-check，妨碍问答类任务，并与现有工具边界自治规则冲突。只对 `required` 模式设置完成门禁。

### 18.6 先完整重写 McpSupervisor 再恢复工具

拒绝。当前首要问题是断开的执行链，应先完成可回滚的垂直切片，再演进连接生命周期。

### 18.7 宣称通用 exactly-once

拒绝。没有远端幂等或查询协议时无法证明；设计只承诺持久 intent、保守重放和 reconciliation。

### 18.8 使用 `@ai-sdk/mcp` 作为 MCP client

拒绝。它的直接 ToolSet 执行模型与 Runtime Gateway 冲突，且当前客户端不接收 MCP notifications，无法支撑 revisioned discovery。项目只保留 `@modelcontextprotocol/sdk`。

## 十九、实施前置决策

进入 `docs/space/plans/` 前必须明确：

1. Catalog/binding 类型哪些属于 `src/protocol`，哪些属于 `src/core`；
2. MCP 原始大结果的 Artifact Store 复用或新建方案；
3. invocation intent 与 provider call 之间的持久化边界；
4. trusted MCP server 的建立、撤销和 per-tool override 配置格式；
5. `SKILL.md` Workflow Manifest 的 schema/version 与未知字段策略；
6. verification mode 的确定性升级规则和用户 waive 交互；
7. provider 不支持动态 tool search 时的 context budget fallback；
8. feature flag 关闭即 fail closed 的新规则及对应 ADR；
9. 删除 `@ai-sdk/mcp` 后的 lockfile、测试和依赖边界。

## 二十、外部依据

- [OpenAI：Build skills](https://learn.chatgpt.com/docs/build-skills.md)
- [OpenAI：Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security.md)
- [OpenAI：Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp.md)
- [Anthropic：Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)
- [Anthropic：Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Anthropic：Hooks reference](https://code.claude.com/docs/en/hooks)
- [Model Context Protocol：Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Agent Skills：Specification](https://agentskills.io/specification)
