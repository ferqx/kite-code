# MCP 工具盘点与能力发现开发方案

**状态：** Proposed
**适用分支：** `mcp`
**目标版本：** MCP Inventory / Capability Discovery 下一阶段
**主要模块：** MCP Runtime、Capability Catalog、Tool Definitions、Model Context、TUI、Tests

---

## 1. 背景

当前 MCP Runtime 已完成两个重要修复：

1. 模型可见的 MCP 工具别名不再作为执行身份反向解析；
2. MCP 调用使用 `capabilityId + expectedRevision`，并在 Manager 内重新验证 revision、schema 和参数。

现阶段问题主要出现在 **能力盘点和模型认知层**。

用户输入：

> 你目前有哪些 MCP 工具？

模型依次调用：

- `list_mcp_resources`
- `capability_search`

随后把"没有静态 Resource"和"当前查询没有匹配结果"错误解释成：

- 没有配置 MCP Server；
- 没有已连接 MCP Server；
- 没有 MCP Capability。

实际上：

- `list_mcp_resources` 只负责静态资源；
- `capability_search` 负责按意图搜索能力；
- Provider 状态由 Provider Directory 单独维护。

现有 Tool Contract 已经说明 Resource 列表与可执行工具搜索是不同功能，但模型仍容易把二者混淆。

此外，当前 MCP inventory 判断（`src/core/capabilities/search.ts` 中的 `isMcpInventoryQuery`）主要识别英文 `available/list/server/tool` 等词汇，中文"有哪些 MCP 工具"无法稳定进入 inventory 分支。

### 1.1 现状对照

| 项目 | RFC 描述 | 代码现状 | 评估 |
|------|----------|----------|------|
| `isMcpInventoryQuery` | 仅识别英文 | `search.ts:148` — 只检查英文 term set，不覆盖中文 | ✅ RFC 判断准确 |
| MCP Tool names 注入 | 逐 tool name 注入 system prompt | `context.ts:320-329` — `mcpCapabilityNames` 映射为 prompt 列表 | ✅ RFC 判断准确 |
| 旧配置路径引用 | `kite-code.jsonc`、`.mcp.json` 仍被引用 | `tool-contracts.ts:339,341`、`definitions.ts:274` | ✅ RFC 判断准确 |
| `McpRuntimeProvider` 接口 | 已提供所需 Snapshot 方法 | `runtime-provider.ts:53-62` — `getCapabilitySnapshot()`、`getProviderDirectorySnapshot()`、`getResourceDirectorySnapshot()` | ✅ RFC 判断准确 |
| `list_mcp_tools` | 不存在 | 全仓搜索无结果 | ✅ 确认 greenfield |
| `capability_search` 零匹配处理 | 无 catalog summary | `tool-controller.ts:576-619` — 零匹配时不返回 catalog 概览 | ✅ RFC 判断准确 |
| TUI `list_mcp_resources` 显示 | 已存在 | `render-utils.ts:24`、`ToolCardBlock.tsx:554-557` | ✅ 需新增 `list_mcp_tools` 映射 |

---

## 2. 目标

### 2.1 功能目标

增加一个确定性的 MCP 工具盘点能力，使以下用户问题得到可靠回答：

- 你目前有哪些 MCP 工具？
- 哪些 MCP 服务已连接？
- GitHub MCP 有哪些工具？
- 当前配置了多少 MCP Server？
- 哪些 MCP 服务需要登录或批准？

### 2.2 架构目标

明确区分三种用户意图：

| 用户意图                       | 使用工具                                       |
| ------------------------------ | ---------------------------------------------- |
| 盘点当前 MCP Server 和 Tool    | `list_mcp_tools`                               |
| 寻找能完成某项任务的能力       | `capability_search`                            |
| 查看或读取 MCP 静态资源        | `list_mcp_resources` / `read_mcp_resource`     |

### 2.3 安全目标

盘点功能只能返回脱敏元数据，不得返回：

- Capability ID
- revision
- binding token
- 完整 input/output schema
- transport 配置
- HTTP header
- credential
- OAuth 信息
- 本地命令和环境变量

### 2.4 非目标

本阶段不包括：

- 自动配置 MCP Server
- 自动登录或自动批准项目 MCP
- 通过 inventory 结果直接授权工具
- 基于 embedding 的语义检索
- MCP Prompt inventory 重构
- `/mcp` 管理界面的整体重做

---

## 3. 目标用户行为

### 3.1 工具盘点

用户：

> 你目前有哪些 MCP 工具？

模型应调用：

```text
list_mcp_tools({})
```

返回：

```json
{
  "ok": true,
  "configured_provider_count": 2,
  "callable_provider_count": 1,
  "available_tool_count": 8,
  "providers": [
    {
      "name": "github",
      "status": "ready",
      "required": false,
      "source": "user",
      "available_tool_count": 8
    },
    {
      "name": "database",
      "status": "login_required",
      "required": false,
      "source": "project",
      "available_tool_count": 0,
      "next_action": "authenticate"
    }
  ],
  "tools": [
    { "provider": "github", "name": "create_issue" },
    { "provider": "github", "name": "get_pull_request" }
  ],
  "truncated": false
}
```

模型应回答：

> 当前配置了 2 个 MCP 服务。GitHub 已连接并提供 8 个工具；database 已配置，但需要登录。目前可用工具包括……

不得回答：

> 当前没有 MCP 服务。

### 3.2 语义搜索

用户：

> 有没有能创建 GitHub Issue 的工具？

模型应调用：

```text
capability_search({ "query": "create GitHub issue" })
```

搜索成功后，在下一个 model turn 获得 Runtime-issued binding。

### 3.3 MCP Resource

用户：

> MCP 有没有提供 API 文档或其他资源？

模型应调用：

```text
list_mcp_resources({})
```

静态 Resource 为空时只能说明：

> 当前没有发现静态 MCP Resources。

不得推断：

> 当前没有 MCP Server 或 MCP Tool。

---

## 4. 总体架构

新增一个纯函数 Inventory Builder，基于现有两个 Snapshot 构建模型可见结果：

```text
CapabilitySnapshot
        +
McpProviderDirectorySnapshot
        ↓
buildMcpInventory()
        ↓
list_mcp_tools result
```

不建议给 `McpRuntimeProvider` 新增 `getInventorySnapshot()`。

现有 Provider 已经提供（`src/core/mcp/runtime-provider.ts:53-62`）：

```ts
getCapabilitySnapshot(): CapabilitySnapshot;
getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
getResourceDirectorySnapshot(): McpResourceDirectorySnapshot;
```

Inventory 是前两个 Snapshot 的派生投影，不应成为新的事实源。

推荐新增文件：

```text
src/core/mcp/inventory.ts
```

---

## 5. 数据结构设计

### 5.1 内部类型

```ts
export interface McpInventoryQuery {
  provider?: string;
  limit?: number;
  cursor?: string;
}

export interface McpInventoryProviderSummary {
  name: string;
  status: McpProviderDirectoryStatus;
  required: boolean;
  source: McpConfigSourceKind | 'explicit';
  availableToolCount: number;
  lastKnownToolCount: number;
  nextAction?: McpInventoryNextAction;
  diagnosticCode?: McpDiagnosticCode;
}

export interface McpInventoryToolSummary {
  provider: string;
  name: string;
}

export interface McpInventorySuccess {
  ok: true;
  configuredProviderCount: number;
  callableProviderCount: number;
  availableToolCount: number;
  providers: McpInventoryProviderSummary[];
  tools: McpInventoryToolSummary[];
  truncated: boolean;
  nextCursor?: string;
}

export interface McpInventoryFailure {
  ok: false;
  code:
    | 'invalid_cursor'
    | 'stale_cursor'
    | 'unknown_provider'
    | 'invalid_limit';
  message: string;
}

export type McpInventoryResult =
  | McpInventorySuccess
  | McpInventoryFailure;
```

### 5.2 Callable 定义

Provider 的模型可见状态已经被归一化为（`runtime-provider.ts:6-15`）：

```text
pending_approval
rejected
disabled
login_required
connecting
ready
degraded
failed
quarantined
```

Inventory 中：

```ts
const callable =
  provider.status === 'ready' ||
  provider.status === 'degraded';
```

使用 `callable_provider_count`，而不是 `connected_provider_count`，避免把 degraded 错误描述成完全健康。

### 5.3 Tool 来源

只列出当前 Catalog 中满足以下条件的 Descriptor：

```ts
descriptor.kind === 'mcp_tool'
descriptor.availability === 'available'
```

Tool 输出只包含：

```ts
{
  provider: descriptor.provider.id,
  name: descriptor.displayName
}
```

不得包含：

```ts
descriptor.capabilityId
descriptor.revision
descriptor.inputSchema
descriptor.outputSchema
descriptor.policy
```

### 5.4 Provider 合并规则

Provider 列表应使用以下集合的并集：

```text
Provider Directory 中的 Provider
+
Capability Snapshot 中 MCP Tool 的 provider.id
```

正常生产路径下 Provider Directory 应是主要来源；Capability Snapshot 补集只用于防御性兼容和测试注入。

Provider 必须稳定排序：

```text
provider.name ascending
```

Tool 必须稳定排序：

```text
provider ascending → tool name ascending
```

---

## 6. 分页设计

默认：

```text
limit = 50
```

限制：

```text
1 <= limit <= 100
```

Cursor 使用 opaque base64url 数据：

```ts
interface McpInventoryCursor {
  catalogRevision: string;
  providerDirectoryRevision: string;
  offset: number;
  provider?: string;
}
```

接收到 cursor 时必须验证：

- Catalog revision 是否仍一致
- Provider Directory revision 是否仍一致
- provider filter 是否一致
- offset 是否为非负整数

Snapshot 变化时返回：

```json
{
  "ok": false,
  "code": "stale_cursor",
  "message": "The MCP inventory changed. Restart listing without a cursor."
}
```

Cursor 不需要加密，因为其中不含敏感信息，但必须：

- 严格解析
- 限制长度（输入 `z.string().max(2048)`）
- 拒绝未知字段
- 拒绝异常 offset

---

## 7. 新增 `list_mcp_tools`

### 7.1 Tool Contract

在 `src/core/tools/tool-contracts.ts` 中增加：

```ts
export const LIST_MCP_TOOLS_CONTRACT: ToolContract = {
  name: 'list_mcp_tools',
  sections: {
    whenToUse:
      'List currently configured MCP providers and executable MCP tools. ' +
      'Use this when the user asks which MCP tools, servers, providers, ' +
      'or capabilities are currently available. ' +
      'Use capability_search instead when looking for a tool that can perform ' +
      'a specific action. Use list_mcp_resources only for static MCP resources.',

    commonMistakes:
      'Do not use list_mcp_resources to list executable tools. ' +
      'Do not treat an empty resource list as proof that no MCP tools exist. ' +
      'Do not treat a zero-match capability search as proof that the catalog is empty.',

    outputFormat:
      'JSON: configured_provider_count, callable_provider_count, ' +
      'available_tool_count, providers, tools, truncated, and optional next_cursor.',

    failureHandling:
      'If the cursor is stale, restart without a cursor. ' +
      'If a provider is unavailable, report its exact status and next_action. ' +
      'Do not claim a provider is unconfigured unless it is absent from the provider directory.'
  },
  description: ''
};
```

同时注册到 `TOOL_CONTRACTS` Map 和 `KNOWN_TOOL_NAMES` 数组中。

### 7.2 Tool 定义

在 `src/core/tools/definitions.ts` 中，参考现有 `listMcpResources`（定义在 `definitions.ts:220`）的模式，使用 `tool()` 注册：

```ts
const listMcpToolsTool = tool({
  description: LIST_MCP_TOOLS_CONTRACT.description,
  inputSchema: zodSchema(
    z.object({
      provider: z.string().trim().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(2048).optional()
    })
  ),
  // execute 由 Runtime Tool Controller 接管，此处仅声明 schema
});
```

加入 builtin tools：

```ts
list_mcp_tools: listMcpToolsTool
```

> **实施备注**：当前代码库中 MCP 绑定工具（`definitions.ts:516`）使用 `dynamicTool()` 以便运行时注入 schema。`list_mcp_tools` 作为 builtin 工具，其 schema 在编译期完全已知，应使用 `tool()` 以与其他 builtin 工具保持一致。实际实施时需确认 `tool-controller.ts` 中该工具的处理分支是否需要 `execute` 函数或完全由 Controller 接管。

### 7.3 Tool Request

在 `PendingToolRequest`（`src/core/harness/tool-requests.ts`）中新增 union variant：

```ts
{
  id?: string;
  name: 'list_mcp_tools';
  args: {
    provider?: string;
    limit?: number;
    cursor?: string;
  };
  reason: string;
  protectedCommand: string;
}
```

分类：

```text
effectClass: read
sideEffect: false
approval: none
network: none
```

该 Tool 只读取 Runtime 内存 Snapshot，不直接访问远端 Provider。

### 7.4 Runtime 执行

在 `tool-controller.ts` 中增加处理分支（参考现有 `capability_search` 在 `tool-controller.ts:576` 的处理模式）：

```ts
if (request.name === 'list_mcp_tools') {
  if (!mcpManager) {
    return {
      ok: true,
      configured_provider_count: 0,
      callable_provider_count: 0,
      available_tool_count: 0,
      providers: [],
      tools: [],
      truncated: false
    };
  }

  const result = buildMcpInventory({
    capabilities: mcpManager.getCapabilitySnapshot(),
    providers: mcpManager.getProviderDirectorySnapshot(),
    query: request.args
  });

  return normalizeInventoryResult(result);
}
```

`mcpManager` 不存在不应返回执行错误，因为"当前没有初始化 MCP Runtime"本身是合法盘点结果。

---

## 8. Provider 状态映射

统一在 `inventory.ts` 中定义：

```ts
function nextActionForProvider(
  status: McpProviderDirectoryStatus
): McpInventoryNextAction | undefined
```

建议映射（使用机器可读的短码，区别于 `search.ts:353-371` 中现有 `providerNextAction` 的自然语言描述）：

| 状态                 | next_action                      |
| -------------------- | -------------------------------- |
| `pending_approval`   | `approve_project_provider`       |
| `rejected`           | `review_project_approval`        |
| `disabled`           | `enable_provider`                |
| `login_required`     | `authenticate`                   |
| `connecting`         | `wait_or_retry`                  |
| `failed`             | `retry_connection`               |
| `degraded`           | `retry_if_needed`                |
| `quarantined`        | `fix_configuration_or_schema`    |
| `ready`              | 无                               |

不要返回完整错误文本，只允许返回 `diagnostic_code`。详细技术错误继续留在 `/mcp` 管理界面。

> **设计决策**：`search.ts` 中现有的 `providerNextAction()` 使用完整英文句子（如 `"Complete the MCP project approval prompt."`），适合作为人类可读的 `capability_search` 返回。Inventory 使用短码，便于模型作为结构化信号消费并在回答中自行组织自然语言。两者不矛盾，但需在代码中明确注释区分。

---

## 9. 重构 `capability_search`

### 9.1 收窄职责

`capability_search` 只回答：

> 哪个 Capability 可以完成这个动作？

不再承担：

- 全量 MCP Tool inventory
- Server inventory
- Resource inventory
- Provider 状态全量盘点

### 9.2 Inventory 查询重定向

保留一个轻量的 inventory intent 判断，仅用于阻止误用。

当前 `isMcpInventoryQuery`（`search.ts:148-165`）仅覆盖英文。需要扩展为：

```ts
export function isMcpInventoryIntent(query: string): boolean
```

覆盖：

```text
what MCP tools are available
list MCP tools
which MCP servers are configured
你有哪些 MCP 工具
有哪些mcp工具
列出 MCP 服务
当前可用的 MCP 能力
显示mcp工具
```

中文检测不能依赖空格分词，至少使用显式正则：

```ts
const containsMcp = /mcp/i.test(query);

const chineseInventory =
  /(有哪些|有什么|列出|显示|查看|当前|可用).{0,10}(工具|服务|服务器|能力)/u.test(query) ||
  /(工具|服务|服务器|能力).{0,10}(有哪些|有什么|列表|清单)/u.test(query);
```

> **实施备注**：当前 `isMcpInventoryQuery` 要求所有 term 都在预定义集合中（`queryTerms.every(term => MCP_INVENTORY_TERMS.has(term))`），这个逻辑对中文不适用。建议重构为两阶段：先检测是否为 inventory 意图（包含中英文），再根据语言选择不同的 term-matching 策略。中文走正则，英文保留现有 set-based 逻辑。

检测到 inventory intent 时返回：

```json
{
  "ok": false,
  "code": "inventory_query",
  "message": "Use list_mcp_tools to enumerate MCP providers and tools.",
  "next_tool": "list_mcp_tools"
}
```

这只是错误恢复机制，不能成为 inventory 的主要实现。

### 9.3 零匹配结果

普通搜索返回 0 条时，增加 Catalog Summary：

```json
{
  "ok": true,
  "match_count": 0,
  "candidates": [],
  "catalog_summary": {
    "available_mcp_tool_count": 8,
    "available_skill_count": 3,
    "configured_provider_count": 2,
    "unavailable_provider_count": 1
  },
  "message": "No capabilities matched this query. This does not mean the capability catalog is empty."
}
```

避免模型把 `zero matches` 解释成 `empty catalog`。

### 9.4 查询规范化

在 Tool Contract 中要求模型使用简短动作查询：

```text
创建 GitHub Issue       → create GitHub issue
查询数据库表             → query database table
```

本阶段不实现翻译器或 embedding。

---

## 10. Model Context 调整

当前模型上下文会注入 MCP Tool names-only 列表（`context.ts:320-329`，通过 `mcpCapabilityNames` 映射为 `## Available MCP Tool Names` 段落）。

建议分两步迁移。

### 10.1 第一阶段（与 `list_mcp_tools` 同批上线）

保留现有 names-only 列表，同时增加固定语义规则。在 `buildStaticSystemPrompt` 中（或 `system-prompt.txt` 中）增加：

```text
## MCP Capability Usage

- Use `list_mcp_tools` when the user asks which MCP tools,
  providers, servers, or capabilities are available.
- Use `capability_search` when looking for a capability
  that performs a specific action.
- Use `list_mcp_resources` only for static resources.
- An empty resource list does not mean there are no MCP tools.
- A capability search with zero matches does not mean
  the MCP catalog is empty.
- Never infer provider connection state from resource results.
```

该文本应放入稳定 System Prompt，使其进入 prompt cache 稳定前缀。建议放在 `system-prompt.txt` 中 Tool Strategy 段落附近或作为独立段落。

### 10.2 第二阶段（独立提交）

在 E2E 和真实模型测试通过后，移除逐 Tool 名称注入：

```ts
mcpCapabilityNames         // ModelContextState 字段
capabilityNameSummary()    // search.ts:168
```

系统提示只保留工具语义规则。

收益：

- 降低 context 占用
- 避免 Tool 数量增长导致 prompt 膨胀
- 强化 progressive disclosure
- 让 inventory 只有一个权威入口

第二阶段不应和 `list_mcp_tools` 首次上线放在同一个提交中。

---

## 11. TUI 行为

### 11.1 Tool 摘要

现有 TUI 映射位置：

- `src/app/tui/components/render-utils.ts:24` — `ACTION_NAMES` 映射表
- `src/app/tui/components/ToolCardBlock.tsx:554-557` — `list_mcp_resources` 特殊渲染逻辑

需要在以下位置增加 `list_mcp_tools` 的支持：

**`render-utils.ts` 中 `ACTION_NAMES`：**

```ts
list_mcp_tools: 'Listed MCP tools',
```

**`render-utils.ts` 中的 `toolNameDisplay` 或类似函数**（当前 `render-utils.ts:108` 对 `capability_search` 和 `list_mcp_resources` 有特殊处理，`list_mcp_tools` 也应加入）：

```ts
if (name === 'capability_search' || name === 'list_mcp_resources' || name === 'list_mcp_tools') return raw;
```

**`ToolCardBlock.tsx`**：增加 `list_mcp_tools` 的分支处理，解析 inventory 结果并渲染 provider/tool 统计摘要。具体实现参考现有 `list_mcp_resources`（`ToolCardBlock.tsx:539-557`）的处理模式。

不要复用 `Listed MCP resources` 文案。

### 11.2 结果显示

TUI 默认只显示简短摘要：

```text
● Listed MCP tools

  2 providers · 1 callable · 8 available tools
```

模型最终回答负责列出 Tool 名称。

如果结果包含 unavailable Provider，可以显示：

```text
  database · login required
```

但不得直接显示 credential、URL 或 raw error。

### 11.3 空结果

配置为空：

```text
● Listed MCP tools

  No MCP providers are currently configured
```

配置存在但不可用：

```text
● Listed MCP tools

  2 providers configured · 0 currently callable
```

这两个状态必须区分。

---

## 12. 配置路径文案清理

规范配置位置为：

```text
<project>/.kite-code/mcp.json
~/.kite-code/mcp.json
```

当前配置加载优先级（`src/core/config/mcp-config.ts:317-337`）：

| 优先级 | Kind              | 路径                                    |
| ------ | ----------------- | --------------------------------------- |
| 10     | `user_legacy`     | `~/.kite-code/kite-code.jsonc`          |
| 20     | `project_legacy`  | `<project>/.kite-code/kite-code.jsonc`  |
| 30     | `project_mcp_json`| `<project>/.mcp.json`                   |
| 40     | `local`           | `~/.kite-code/projects/<key>/mcp.jsonc` |
| 50     | `user`            | `~/.kite-code/mcp.json`                 |
| 60     | `project`         | `<project>/.kite-code/mcp.json`         |

旧 `.mcp.json` 和 `kite-code.jsonc#mcpServers` 只作为兼容或迁移来源，不得作为推荐写入位置。

需要全仓检查并替换以下用户引导中出现的旧路径：

**已知需修改位置：**

- `src/core/tools/tool-contracts.ts:339` — `READ_MCP_RESOURCE_CONTRACT.failureHandling` 提到 `kite-code.jsonc or .mcp.json`
- `src/core/tools/tool-contracts.ts:341` — 同上，提到 `kite-code.jsonc`
- `src/core/tools/definitions.ts:274` — `readMcpResource` 的错误消息中提到 `kite-code.jsonc`

**建议统一文案：**

```text
Open /mcp to manage MCP providers.
Canonical configuration files are:
- <project>/.kite-code/mcp.json
- ~/.kite-code/mcp.json
```

重点检查：

```text
src/core/tools/tool-contracts.ts
src/core/tools/definitions.ts
src/core/prompts/
README.md
docs/active/
docs/book/
TUI error messages
tests/golden/
```

兼容路径可以出现在 migration 文档中，但不能作为推荐写入位置。

---

## 13. 文件级实施清单

### 新增

```text
src/core/mcp/inventory.ts
tests/mcp-inventory.test.ts
tests/runtime/list-mcp-tools.test.ts
tests/e2e/mcp-inventory.test.ts
```

### 修改

```text
src/core/tools/tool-contracts.ts       — 新增 LIST_MCP_TOOLS_CONTRACT，注册到 TOOL_CONTRACTS 和 KNOWN_TOOL_NAMES
src/core/tools/definitions.ts          — 新增 list_mcp_tools 的 tool() 定义
src/core/harness/tool-requests.ts      — 新增 PendingToolRequest union variant
src/core/harness/tool-runner.ts        — 新增 list_mcp_tools 路由（如需要）
src/core/policies/tool-capabilities.ts — 新增 effectClass/approval 分类
src/core/controllers/tool-controller.ts— 新增 list_mcp_tools 执行分支
src/core/capabilities/search.ts        — 重构 isMcpInventoryQuery → isMcpInventoryIntent，增加中文检测和 redirect 返回
src/core/model/context.ts              — Phase 1 增加 MCP 使用规则段落
src/core/prompts/system-prompt.txt     — 增加 MCP Capability Usage 规则
src/app/tui/components/render-utils.ts — ACTION_NAMES 增加 list_mcp_tools
src/app/tui/components/ToolCardBlock.tsx — 增加 list_mcp_tools 渲染分支
docs/active/mcp-runtime-governance.md  — 更新治理文档
docs/book/11-MCP与Skills扩展.md         — 更新用户文档
README.md                              — 更新配置路径引导（如存在）
```

---

## 14. 测试方案

### 14.1 Inventory 单元测试

覆盖：

1. 无 Provider、无 Tool
2. 一个 ready Provider、多个 Tool
3. Provider ready，但 Resource 为 0
4. Provider login_required
5. Provider pending_approval
6. Provider degraded
7. Provider disabled
8. Provider 存在但 Tool 为 0
9. Capability Snapshot 中存在 Provider，但 Directory 缺失
10. Directory 中存在 Provider，但 Capability Snapshot 无 Tool
11. provider 精确过滤
12. unknown provider
13. stable sorting
14. limit
15. cursor 翻页
16. stale cursor
17. invalid cursor
18. duplicate descriptor 去重
19. quarantined Tool 不进入 available tools
20. Skill 不进入 MCP inventory

### 14.2 Capability Search 测试

覆盖：

```text
what MCP tools are available
list mcp tools
你有哪些 MCP 工具
你有哪些mcp工具
列出当前可用的mcp服务
显示 MCP 能力
```

以上查询必须返回：

```text
inventory_query
next_tool: list_mcp_tools
```

普通查询：

```text
create GitHub issue
query database
read documentation
```

仍按原语义搜索。

零匹配时必须包含非歧义 message 和 catalog summary。

### 14.3 Tool Controller 测试

验证：

- `list_mcp_tools` 不需要审批
- 不产生 binding
- 不写 loaded capability set
- 不创建 Execution Receipt 的外部副作用记录
- 不访问远端 MCP Server
- Provider unavailable 不导致 Tool Call 失败
- mcpManager 缺失时返回合法空 inventory

### 14.4 TUI 测试

验证：

- 显示 `Listed MCP tools`
- 不显示 `Listed MCP resources`
- 配置为空和配置不可用显示不同文案
- 中文询问不会产生"没有 Server"的错误结论
- Tool 名称过多时摘要不会撑满界面

### 14.5 E2E 场景

#### 场景 A：Tool 有、Resource 无

Provider：

```text
status: ready
tools: 5
resources: 0
```

用户：

```text
你目前有哪些mcp工具
```

期望：

- 只调用 `list_mcp_tools`
- 列出 5 个 Tool
- 不调用 `list_mcp_resources`
- 不回答"没有 MCP Server"

#### 场景 B：登录未完成

Provider：

```text
status: login_required
tools: 0
```

期望回答：

```text
已配置，但需要登录
```

#### 场景 C：项目待批准

Provider：

```text
status: pending_approval
```

期望回答：

```text
项目 MCP 已发现，等待批准
```

#### 场景 D：搜索无匹配但 Catalog 非空

Catalog：

```text
8 MCP tools
```

查询：

```text
send SMS
```

期望：

```text
没有匹配到发送短信的能力
```

不得回答：

```text
没有 MCP 工具
```

#### 场景 E：分页

Provider：

```text
120 tools
```

期望：

- 第一页 50
- 第二页 50
- 第三页 20
- 顺序稳定
- Snapshot 变化后旧 cursor fail closed

---

## 15. 实施阶段

### Phase 1：Inventory 核心

实现：

- `inventory.ts`
- 内部类型
- 排序、过滤、状态映射
- cursor
- 纯函数单元测试

完成标准：

```text
bun test tests/mcp-inventory.test.ts
```

全部通过。

### Phase 2：Runtime Tool

实现：

- `LIST_MCP_TOOLS_CONTRACT`
- Tool Definition
- Tool Request
- Runtime 执行分支
- Policy 分类
- TUI Tool summary

完成标准：

- 中文和英文用户输入均能触发该 Tool
- Tool 不需要审批
- Tool 输出不含敏感字段

### Phase 3：Capability Search 收窄

实现：

- inventory intent redirect
- 零匹配 catalog summary
- 删除 inventory 全量搜索职责
- 逐步移除 `lastKnownMcpToolMetadata` 的 inventory fallback

完成标准：

- `capability_search` 不再用于全量枚举
- 搜索 0 条不再被解释成 Catalog 为空

### Phase 4：Prompt 和模型行为

实现：

- 固定 MCP 工具选择规则
- 真实 DeepSeek/OpenAI-compatible 模型测试
- Golden prompt 更新

暂时保留 MCP Tool names-only 注入。

完成标准：

- 用户询问 inventory 时，首个 Tool Call 为 `list_mcp_tools`
- 不再出现 `list_mcp_resources → capability_search → 空系统结论` 链路

### Phase 5：上下文优化（独立提交）

在模型回归稳定后：

- 移除逐 Tool name 注入
- 删除不再使用的 `mcpCapabilityNames`
- 保留固定 MCP 使用规则

完成标准：

- 不同规模 Catalog 下 prompt 大小基本稳定
- 能力仍可通过 inventory 和 search 正确发现

### Phase 6：文档与发布

更新：

- 治理文档
- 用户文档
- 配置路径
- E2E 说明
- 迁移说明

---

## 16. 提交拆分建议

不要将所有变化放在一个提交。

推荐：

```text
feat(mcp): add pure MCP inventory projection
feat(tools): add list_mcp_tools runtime tool
fix(capabilities): separate inventory from semantic search
fix(prompt): clarify MCP tools resources and provider status
fix(tui): render MCP tool inventory summaries
docs(mcp): document inventory and canonical config paths
test(mcp): cover multilingual inventory discovery
refactor(prompt): remove per-tool MCP name injection
```

最后一个 prompt refactor 应单独提交，方便回滚。

---

## 17. 风险与控制

### 风险 1：模型仍误选 Resource Tool

控制：

- 强化 Tool Contract
- 固定 System Prompt 规则
- 增加真实模型 Golden/E2E
- 在 `capability_search` 中提供 inventory redirect

### 风险 2：Provider 状态在盘点期间变化

控制：

- 每次调用读取不可变 Snapshot
- cursor 绑定 Snapshot revision
- 旧 cursor fail closed

### 风险 3：Inventory 泄露内部能力身份

控制：

- 只返回 provider/name
- 建立专门 model-visible serializer
- 测试断言结果中不存在：
  - `capabilityId`
  - `revision`
  - `schema`
  - `binding`
  - `credential`
  - `transport`
  - `header`

### 风险 4：Tool 数量过大

控制：

- 默认 limit 50
- 最大 100
- 稳定 cursor
- TUI 只显示摘要

### 风险 5：旧配置文案继续诱导错误路径

控制：

- 仓库级搜索旧路径
- doc check 增加 forbidden recommendation 规则
- 旧路径只能出现在 migration/compatibility 段落

### 风险 6：中文空格变体导致检测遗漏

控制：

- 正则使用 `.{0,10}` 而非依赖空格分词
- 覆盖"有哪些mcp工具"等无空格变体
- 测试覆盖中英文及混合场景

---

## 18. 验收标准

功能完成必须满足：

- [ ] "你目前有哪些mcp工具"调用 `list_mcp_tools`
- [ ] 不需要用户在 `mcp` 前后输入空格
- [ ] Tool 有、Resource 无时仍能列出 Tool
- [ ] Search 0 match 不等于 Catalog 为空
- [ ] Provider 配置为空和 Provider 不可用可以区分
- [ ] pending approval、login required、disabled、failed 状态准确展示
- [ ] Inventory 不签发 binding
- [ ] Inventory 不加载 Capability
- [ ] Inventory 不触发 Provider 网络请求
- [ ] Inventory 输出不包含敏感字段
- [ ] Tool 数量超过 limit 时支持稳定分页
- [ ] Snapshot 变化后旧 cursor 被拒绝
- [ ] TUI 使用 `Listed MCP tools`
- [ ] 用户引导只推荐 `/mcp` 和两个规范 `mcp.json` 路径
- [ ] Typecheck、Core boundary、MCP tests、TUI tests、E2E 全部通过

推荐验证命令：

```text
bun run typecheck
bun run check:core-boundary
bun run check:docs
bun test tests/mcp-inventory.test.ts
bun test tests/runtime/list-mcp-tools.test.ts
bun test tests/mcp-tool-runner.test.ts
bun test tests/mcp-manager.test.ts
bun test tests/mcp-supervisor.test.ts
bun test tests/golden/golden.test.ts
```

---

## 19. 最终设计原则

MCP 对用户暴露的三个概念必须保持正交：

```text
Provider
  → 是否配置、是否可调用、需要什么恢复动作

Tool / Capability
  → 当前可执行什么，或者什么能力能完成目标

Resource
  → Provider 暴露了哪些静态内容
```

任何一个结果为空，都不能自动推出另外两个为空。

最终职责应稳定为：

```text
list_mcp_tools       → 确定性盘点
capability_search    → 按意图发现能力
list_mcp_resources   → 静态资源目录
/mcp                 → 配置、认证、批准和连接管理
```

这能让 MCP Runtime 的安全边界、progressive disclosure 和用户可理解性保持一致。

---

## 附录 A：Review 意见

以下为对原始方案的 review，已体现在上述正文中。

### A.1 已修正

1. **Section 2.3 安全目标列表格式**：原文 `  -完整 input/output schema；` 前缀短横误放，已在正文修正。
2. **Section 9.2 中文正则**：原文使用 `.*` 进行匹配，可能过于宽松。已改为 `.{0,10}` 限制中间字符数，同时确保能覆盖"有哪些mcp工具"这类无空格的变体。
3. **Section 7.2 `dynamicTool()` vs `tool()`**：原文建议使用 `dynamicTool()`。经核实，`dynamicTool()` 在代码库中用于运行时注入 schema 的 MCP 绑定工具（`definitions.ts:516`），而 `list_mcp_tools` 的 schema 在编译期已知，应使用 `tool()` 与其他 builtin 工具保持一致。
4. **Section 8 next_action 码值**：原文未说明为何用短码而非现有 `search.ts:353` 中的完整句子。已在正文增加设计决策说明。
5. **Section 9.2 `isMcpInventoryQuery` 现有逻辑**：原文未讨论现有实现 `search.ts:148` 中 `every(term => MCP_INVENTORY_TERMS.has(term))` 对中文不适用的原因。已在实施备注中说明需重构为两阶段检测。
6. **Section 11 TUI 文件路径**：原文使用了占位性的 `src/app/tui/reducers/consolidateTools.ts`。已根据实际代码库（`render-utils.ts`、`ToolCardBlock.tsx`）修正了文件名和具体行号。
7. **Section 12 配置路径**：已补充实际代码库中 `mcp-config.ts:317-337` 的完整优先级表，与 RFC 描述一致。
8. **新增风险 6**：中文空格变体（如"有哪些mcp工具"）可能导致检测遗漏，已在风险表中补充。

### A.2 已确认正确的设计决策

1. **`McpRuntimeProvider` 已提供所需接口**：`getCapabilitySnapshot()`、`getProviderDirectorySnapshot()` 已在 `runtime-provider.ts` 中定义，不需要新增 `getInventorySnapshot()`。
2. **`McpProviderDirectoryStatus` 与 RFC 列出的状态完全一致**：`pending_approval`、`rejected`、`disabled`、`login_required`、`connecting`、`ready`、`degraded`、`failed`、`quarantined` 九个状态无需修改。
3. **先保留再移除 names-only 注入的策略**（两阶段迁移）：分阶段降低回滚风险是合理做法。
4. **Phase 5 独立提交**：移除 per-tool name injection 的 prompt refactor 独立提交，方便回滚。

### A.3 建议后续关注

1. **`tool-controller.ts` 的处理模式**：当前 `capability_search`（line 576）和 `read_mcp_resource`（line 1861）在 `tool-controller.ts` 中有显式的内联处理分支。`list_mcp_tools` 应采用相同模式，或者如果工具数量持续增长，考虑提取为策略注册表。本 RFC 不强制要求重构，但实施时值得评估。
2. **Golden test 更新**：`tests/golden/golden.test.ts` 中可能存在依赖 MCP tool name 注入的断言，Phase 5 移除注入时需要同步更新。
3. **`searchUnavailableProviders` 与 inventory 的关系**：`search.ts:240` 中 `searchUnavailableProviders` 提供与 inventory 类似的不可用 provider 诊断。建议在 Phase 3 明确两者的职责边界：inventory 做确定性全量盘点，search 做按意图过滤的 provider 诊断。
