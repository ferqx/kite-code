# MCP 工具盘点与能力发现实施计划

状态：active
优先级：P0
创建日期：2026-07-19
来源：[`2026-07-19-mcp-tool-inventory-rfc.md`](../../design/2026-07-19-mcp-tool-inventory-rfc.md)
依赖：MCP Phase 0–5（已完成）、ADR-0009、ADR-0010、ADR-0011、ADR-0013、ADR-0017

## 一、目标与验收

### 目标

增加确定性 MCP 工具盘点能力 (`list_mcp_tools`)，重构 `capability_search` 职责边界，修复中文 inventory 查询路由，确保三类 MCP 用户意图（盘点 / 搜索 / 资源）正交且不被模型混淆。

### 非目标

- 不实现自动配置、自动登录、自动批准
- 不实现 embedding 语义检索
- 不重构 `/mcp` 管理界面
- 不重构 MCP Prompt inventory

### 验收标准

- [ ] "你目前有哪些mcp工具"调用 `list_mcp_tools`，不调用 `list_mcp_resources`
- [ ] Tool 有、Resource 无时仍能列出 Tool，不误答"没有 MCP Server"
- [ ] `capability_search` 0 match 不等于 Catalog 为空，返回 catalog_summary
- [ ] Provider 配置为空和 Provider 不可用可区分
- [ ] pending_approval、login_required、disabled、failed 状态准确展示 next_action
- [ ] Inventory 不签发 binding、不加载 Capability、不触发网络请求
- [ ] Inventory 输出不包含 capabilityId、revision、schema、transport、credential、header
- [ ] Tool 数量超过 limit 时支持稳定分页；Snapshot 变化后旧 cursor fail closed
- [ ] TUI 使用 `Listed MCP tools`，不复用 `Listed MCP resources`
- [ ] 中文 inventory 查询不依赖空格分词
- [ ] Typecheck、Core boundary、MCP tests、TUI tests、E2E 全部通过

---

## 二、系统设计

### 2.1 数据流

```text
CapabilitySnapshot (mcpManager.getCapabilitySnapshot())
        +
McpProviderDirectorySnapshot (mcpManager.getProviderDirectorySnapshot())
        ↓
buildMcpInventory({ capabilities, providers, query })
        ↓
McpInventoryResult → JSON stdout → model
```

新增纯函数 `buildMcpInventory()` 在 `src/core/mcp/inventory.ts`，不新增 Provider 方法。

### 2.2 工具路由

`list_mcp_tools` 沿袭 `list_mcp_resources` 的现有模式：

- **`definitions.ts`**：使用 `tool()` 声明 schema（非 `dynamicTool()`，因为 schema 编译期已知）
- **`tool-runner.ts`**：实现执行逻辑（同步读取 Snapshot，无需访问远端）
- **`tool-controller.ts`**：Policy 路由（read_only 无审批）

与 `capability_search` 不同：不通过 `tool-controller.ts` 内联处理，因为不需要发出复杂 Runtime Event。

### 2.3 安全分类

| 维度 | 分类 |
|------|------|
| `effectClass` | `read_only` |
| `sideEffect` | `false` |
| `approval` | `none` |
| `network` | `none`（仅读取 Runtime 内存 Snapshot） |

---

## 三、实施任务

### Task 1：Inventory 纯函数核心

**文件**：
- 新增 `src/core/mcp/inventory.ts`
- 新增 `tests/mcp-inventory.test.ts`

**实现内容**：

#### 1a. 类型定义

```ts
// src/core/mcp/inventory.ts

import type { McpDiagnosticCode } from './diagnostics';
import type {
  McpProviderDirectorySnapshot,
  McpProviderDirectoryStatus,
} from './runtime-provider';
import type { CapabilitySnapshot } from '@/protocol/capabilities';
import type { McpConfigSourceKind } from '@/core/config/mcp-config';

export type McpInventoryNextAction =
  | 'approve_project_provider'
  | 'review_project_approval'
  | 'enable_provider'
  | 'authenticate'
  | 'wait_or_retry'
  | 'retry_connection'
  | 'retry_if_needed'
  | 'fix_configuration_or_schema';

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
  code: 'invalid_cursor' | 'stale_cursor' | 'unknown_provider' | 'invalid_limit';
  message: string;
}

export type McpInventoryResult = McpInventorySuccess | McpInventoryFailure;
```

#### 1b. Cursor 编解码

```ts
interface McpInventoryCursor {
  catalogRevision: string;
  providerDirectoryRevision: string;
  offset: number;
  provider?: string;
}

function encodeCursor(data: McpInventoryCursor): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(raw: string): McpInventoryCursor | null {
  try {
    if (raw.length > 2048) return null;
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.catalogRevision !== 'string' ||
      typeof parsed.providerDirectoryRevision !== 'string' ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      (parsed.provider !== undefined && typeof parsed.provider !== 'string')
    ) {
      return null;
    }
    // 拒绝未知字段
    const allowed = new Set(['catalogRevision', 'providerDirectoryRevision', 'offset', 'provider']);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) return null;
    return parsed as McpInventoryCursor;
  } catch {
    return null;
  }
}
```

#### 1c. 状态映射

```ts
function nextActionForProvider(status: McpProviderDirectoryStatus): McpInventoryNextAction | undefined {
  switch (status) {
    case 'pending_approval': return 'approve_project_provider';
    case 'rejected':         return 'review_project_approval';
    case 'disabled':         return 'enable_provider';
    case 'login_required':   return 'authenticate';
    case 'connecting':       return 'wait_or_retry';
    case 'failed':           return 'retry_connection';
    case 'degraded':         return 'retry_if_needed';
    case 'quarantined':      return 'fix_configuration_or_schema';
    default:                 return undefined;
  }
}
```

#### 1d. 核心构建函数

```ts
export function buildMcpInventory(input: {
  capabilities: CapabilitySnapshot;
  providers: McpProviderDirectorySnapshot;
  query: McpInventoryQuery;
}): McpInventoryResult {
  const { capabilities, providers, query } = input;
  const limit = Math.max(1, Math.min(100, query.limit ?? 50));

  // 验证 limit
  if (query.limit != null && (query.limit < 1 || query.limit > 100)) {
    return { ok: false, code: 'invalid_limit', message: 'limit must be between 1 and 100.' };
  }

  // 验证 provider filter
  const providerSet = new Set(providers.entries.map((e) => e.providerId));
  const capabilityProviderIds = new Set(
    capabilities.descriptors
      .filter((d) => d.kind === 'mcp_tool' && d.availability === 'available')
      .map((d) => d.provider.id),
  );
  const allProviderIds = new Set([...providerSet, ...capabilityProviderIds]);

  if (query.provider && !allProviderIds.has(query.provider)) {
    return { ok: false, code: 'unknown_provider', message: `Unknown provider: ${query.provider}` };
  }

  // 解析 cursor
  let offset = 0;
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return { ok: false, code: 'invalid_cursor', message: 'Invalid cursor.' };
    }
    if (
      cursor.catalogRevision !== capabilities.revision ||
      cursor.providerDirectoryRevision !== providers.revision ||
      cursor.provider !== (query.provider ?? undefined)
    ) {
      return {
        ok: false,
        code: 'stale_cursor',
        message: 'The MCP inventory changed. Restart listing without a cursor.',
      };
    }
    offset = cursor.offset;
  }

  // 构建 Provider 摘要
  const providerMap = new Map<string, McpInventoryProviderSummary>();
  
  // Provider Directory 为主源
  for (const entry of providers.entries) {
    if (query.provider && entry.providerId !== query.provider) continue;
    const toolCount = capabilities.descriptors.filter(
      (d) =>
        d.kind === 'mcp_tool' &&
        d.availability === 'available' &&
        d.provider.id === entry.providerId,
    ).length;
    providerMap.set(entry.providerId, {
      name: entry.providerId,
      status: entry.status,
      required: entry.required,
      source: entry.source,
      availableToolCount: toolCount,
      lastKnownToolCount: entry.lastKnownCapabilityNames.length,
      nextAction: nextActionForProvider(entry.status),
      ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
    });
  }

  // Capability Snapshot 补集（防御性兼容）
  for (const capId of capabilityProviderIds) {
    if (!providerMap.has(capId)) {
      if (query.provider && capId !== query.provider) continue;
      const toolCount = capabilities.descriptors.filter(
        (d) =>
          d.kind === 'mcp_tool' &&
          d.availability === 'available' &&
          d.provider.id === capId,
      ).length;
      providerMap.set(capId, {
        name: capId,
        status: 'ready',
        required: false,
        source: 'explicit' as McpConfigSourceKind,
        availableToolCount: toolCount,
        lastKnownToolCount: toolCount,
      });
    }
  }

  // 构建 Tool 摘要（去重、稳定排序）
  const allTools: McpInventoryToolSummary[] = [];
  const seen = new Set<string>();
  for (const d of capabilities.descriptors) {
    if (d.kind !== 'mcp_tool' || d.availability !== 'available') continue;
    if (query.provider && d.provider.id !== query.provider) continue;
    const key = `${d.provider.id}::${d.displayName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allTools.push({ provider: d.provider.id, name: d.displayName });
  }
  allTools.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  // 稳定排序 provider
  const providerList = [...providerMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // 分页
  const sliced = allTools.slice(offset, offset + limit);
  const truncated = offset + limit < allTools.length;
  const nextCursor = truncated
    ? encodeCursor({
        catalogRevision: capabilities.revision,
        providerDirectoryRevision: providers.revision,
        offset: offset + limit,
        provider: query.provider,
      })
    : undefined;

  const callable = providerList.filter(
    (p) => p.status === 'ready' || p.status === 'degraded',
  );

  return {
    ok: true,
    configuredProviderCount: providerList.length,
    callableProviderCount: callable.length,
    availableToolCount: allTools.length,
    providers: providerList,
    tools: sliced,
    truncated,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
```

#### 1e. 单元测试覆盖（`tests/mcp-inventory.test.ts`）

需覆盖 20 个场景（详见 [RFC §14.1](../../design/2026-07-19-mcp-tool-inventory-rfc.md#141-inventory-单元测试)）：

1. 空 Provider、空 Tool
2. 一个 ready Provider、多个 Tool
3. ready Provider，Resource 为 0
4. login_required Provider
5. pending_approval Provider
6. degraded Provider
7. disabled Provider
8. Provider 存在但 Tool 为 0
9. Capability Snapshot 有 Provider 但 Directory 无
10. Directory 有 Provider 但 Snapshot 无 Tool
11. provider 精确过滤
12. unknown provider → `unknown_provider`
13. stable sorting
14. limit
15. cursor 翻页
16. stale cursor → `stale_cursor`
17. invalid cursor → `invalid_cursor`
18. duplicate descriptor 去重
19. quarantined Tool 不进入 available
20. Skill 不进入 inventory

**构建测试数据的 helper**：

```ts
// 使用 createSnapshot 和现有的 CapabilityDescriptor 类型构造测试数据
import { createSnapshot } from '@/core/capabilities/catalog';
```

---

### Task 2：Runtime Tool 注册与执行

**文件**：
- `src/core/tools/tool-contracts.ts`
- `src/core/tools/definitions.ts`
- `src/core/harness/tool-requests.ts`
- `src/core/harness/tool-runner.ts`
- `src/core/policies/tool-capabilities.ts`
- `src/core/policies/approval-policy.ts`

#### 2a. Tool Contract（`tool-contracts.ts`）

新增 `LIST_MCP_TOOLS_CONTRACT` 并注册：

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
      'Do not claim a provider is unconfigured unless it is absent from the provider directory.',
  },
  description: '',
};
LIST_MCP_TOOLS_CONTRACT.description = buildDescription(LIST_MCP_TOOLS_CONTRACT.sections);
```

在 `KNOWN_TOOL_NAMES` 数组中加入 `'list_mcp_tools'`。

在 `TOOL_CONTRACTS` Map 中加入 `['list_mcp_tools', LIST_MCP_TOOLS_CONTRACT]`。

#### 2b. Tool Definition（`definitions.ts`）

在 `listMcpResources` 定义旁（`definitions.ts:220` 后）新增：

```ts
const listMcpTools = tool({
  description: LIST_MCP_TOOLS_CONTRACT.description,
  inputSchema: zodSchema(
    z.object({
      provider: z.string().trim().min(1).max(128).optional()
        .describe('Optional provider name to filter results'),
      limit: z.number().int().min(1).max(100).optional()
        .describe('Maximum tools to return (default 50, max 100)'),
      cursor: z.string().max(2048).optional()
        .describe('Opaque cursor for pagination'),
    }),
  ),
  // execute 由 tool-runner.ts 接管，此处仅声明 schema
  execute: async () => JSON.stringify({ ok: false, stderr: 'Handled by tool runner.' }),
});
```

在 `builtinTools` 对象（`definitions.ts:472` 附近）中加入：

```ts
list_mcp_tools: listMcpTools,
```

位置与 `list_mcp_resources: listMcpResources` 相邻。

> **设计决策**：虽然 `listMcpResources` 的 `execute` 有完整实现（`definitions.ts:227-258`），但 `listMcpResources` 被两处调用：AI SDK 直接调用和 `tool-runner.ts` 兜底。`list_mcp_tools` 统一在 `tool-runner.ts` 中处理，`definitions.ts` 中的 `execute` 只做 fallback。

#### 2c. Tool Request（`tool-requests.ts`）

在 `PendingToolRequest` union 中（`tool-requests.ts` 内 `list_mcp_resources` 成员附近）新增：

```ts
| {
    id?: string;
    name: 'list_mcp_tools';
    args: { provider?: string; limit?: number; cursor?: string };
    reason: string;
    protectedCommand: string;
  }
```

在 `toolRequestFromCall()` 函数中新增解析分支（`list_mcp_resources` 分支附近）：

```ts
if (call.name === 'list_mcp_tools') {
  const args = call.args as { provider?: unknown; limit?: unknown; cursor?: unknown };
  return {
    id: call.id,
    name: 'list_mcp_tools',
    args: {
      ...(typeof args.provider === 'string' && args.provider.trim().length > 0
        ? { provider: args.provider.trim().slice(0, 128) }
        : {}),
      ...(typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? { limit: Math.max(1, Math.min(100, Math.floor(args.limit))) }
        : {}),
      ...(typeof args.cursor === 'string' && args.cursor.length <= 2048
        ? { cursor: args.cursor }
        : {}),
    },
    reason: 'Model requested MCP tool inventory',
    protectedCommand: 'list_mcp_tools',
  };
}
```

#### 2d. Tool Runner（`tool-runner.ts`）

在 `list_mcp_resources` 处理分支后（`tool-runner.ts:507` 后）新增：

```ts
if (request.name === 'list_mcp_tools') {
  if (!mcpManager) {
    return withFailureGuidance(request, {
      ok: true,
      command: request.protectedCommand,
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        configured_provider_count: 0,
        callable_provider_count: 0,
        available_tool_count: 0,
        providers: [],
        tools: [],
        truncated: false,
      }),
      stderr: '',
    });
  }
  const result = buildMcpInventory({
    capabilities: mcpManager.getCapabilitySnapshot(),
    providers: mcpManager.getProviderDirectorySnapshot(),
    query: {
      provider: request.args.provider,
      limit: request.args.limit,
      cursor: request.args.cursor,
    },
  });
  return withFailureGuidance(request, {
    ok: result.ok,
    command: request.protectedCommand,
    exitCode: result.ok ? 0 : -1,
    stdout: JSON.stringify(result),
    stderr: '',
  });
}
```

> **注意**：`mcpManager` 不存在时返回合法空 inventory（非执行错误），与 RFC §7.4 一致。

需要在文件顶部新增 import：

```ts
import { buildMcpInventory } from '@/core/mcp/inventory';
```

#### 2e. Capability 分类（`tool-capabilities.ts`）

在 `READ_ONLY_TOOLS` Set（`tool-capabilities.ts:25`）中加入：

```ts
'list_mcp_tools',
```

位置与 `'list_mcp_resources'` 相邻。

#### 2f. Approval Policy（`approval-policy.ts`）

在 `list_mcp_resources` 的 allow 分支（`approval-policy.ts:372`）中补充 `list_mcp_tools`：

```ts
if (toolName === 'list_mcp_tools' || toolName === 'list_mcp_resources' || toolName === 'read_mcp_resource') {
```

`list_mcp_tools` 复用与 `list_mcp_resources` 相同的 `risk: 'read'` 分类和 userVisibleSummary 文案。

---

### Task 3：Capability Search 收窄

**文件**：
- `src/core/capabilities/search.ts`
- `src/core/controllers/tool-controller.ts`

#### 3a. 中文 Inventory Intent 检测（`search.ts`）

重构 `isMcpInventoryQuery` → `isMcpInventoryIntent`：

```ts
export function isMcpInventoryIntent(query: string): boolean {
  const normalized = query.trim().slice(0, 512).toLocaleLowerCase();

  // 检测 MCP 关键词（英文 + 中文拼音）
  const containsMcp = /mcp/i.test(normalized);

  // 中文 inventory 模式（不依赖空格分词）
  const chineseInventory =
    /(有哪些|有什么|列出|显示|查看|当前|可用).{0,10}(工具|服务|服务器|能力)/u.test(normalized) ||
    /(工具|服务|服务器|能力).{0,10}(有哪些|有什么|列表|清单)/u.test(normalized);

  if (!containsMcp && !chineseInventory) return false;

  // 英文 set-based 检测（保留现有逻辑）
  const queryTerms = terms(normalized);
  if (
    containsMcp &&
    queryTerms.some((term) =>
      ['available', 'catalog', 'configured', 'list', 'server', 'servers', 'tool', 'tools'].includes(term),
    )
  ) {
    return queryTerms.every((term) => MCP_INVENTORY_TERMS.has(term)) ||
      /(?:what|which)\s+(?:mcp\s+)?tools?/u.test(normalized);
  }

  // 中文检测通过即返回 true
  return chineseInventory;
}
```

#### 3b. Inventory Redirect 返回（`search.ts`）

新增 redirect 结果类型：

```ts
export interface CapabilitySearchInventoryRedirect {
  ok: false;
  code: 'inventory_query';
  message: string;
  next_tool: 'list_mcp_tools';
}
```

在 `searchCapabilities` 调用前检测：

```ts
export function checkInventoryRedirect(query: string): CapabilitySearchInventoryRedirect | null {
  if (isMcpInventoryIntent(query)) {
    return {
      ok: false,
      code: 'inventory_query',
      message: 'Use list_mcp_tools to enumerate MCP providers and tools.',
      next_tool: 'list_mcp_tools',
    };
  }
  return null;
}
```

#### 3c. 零匹配 Catalog Summary（`tool-controller.ts`）

在 `capability_search` 处理分支（`tool-controller.ts:663` 附近）的 `tool.finished` 事件中，当 `candidates.length === 0` 且 `lastKnownTools.length === 0` 且 `providers.length === 0` 时，在 stdout JSON 中增加 `catalog_summary` 字段。

需要先从 `mcpManager` 获取目录信息，在 `stdout` JSON 中 render：

```ts
catalog_summary: {
  available_mcp_tool_count: mcpToolCount,
  available_skill_count: skillCount,
  configured_provider_count: providerCount,
  unavailable_provider_count: unavailableCount,
},
message: 'No capabilities matched this query. This does not mean the capability catalog is empty.',
```

#### 3d. Inventory Redirect in tool-controller.ts

在 `capability_search` 处理分支的早期（`tool-controller.ts:586` 附近），增加 redirect 检测：

```ts
const redirect = checkInventoryRedirect(request.args.query);
if (redirect) {
  events.push({
    type: 'tool.finished',
    toolCallId,
    name: request.name,
    result: {
      ok: true,
      command: request.name,
      exitCode: 0,
      stdout: JSON.stringify(redirect),
      stderr: '',
    },
    summary: 'Use list_mcp_tools for inventory',
  });
  continue;
}
```

---

### Task 4：Model Context 语义规则注入

**文件**：
- `src/core/model/context.ts`
- `src/core/prompts/system-prompt.txt`

#### 4a. System Prompt 规则（`system-prompt.txt`）

在 Tool Strategy 段落末尾（`system-prompt.txt` 中 `shell_execute` 段落之后）增加段落：

```text
# MCP Capability Usage

- Use `list_mcp_tools` when the user asks which MCP tools, providers,
  servers, or capabilities are available.
- Use `capability_search` when looking for a capability that performs
  a specific action.
- Use `list_mcp_resources` only for static resources.
- An empty resource list does not mean there are no MCP tools.
- A capability search with zero matches does not mean the MCP
  catalog is empty.
- Never infer provider connection state from resource results.
```

此文本应直接写入 `system-prompt.txt`（静态文件），避免在 `buildStaticSystemPrompt` 中通过代码拼接（确保其进入 prompt cache 稳定前缀）。

#### 4b. Context Builder 微调

**本阶段保留** `mcpCapabilityNames` 和 `capabilityNameSummary()` 的 names-only 注入。移除操作在 Task 7（Phase 5 / 独立提交）中执行。

确认 `buildStaticSystemPrompt` 的 MCP section（`context.ts:321-329`）中提示文案为：

```text
MCP schemas are loaded on demand. Use `capability_search` before calling a tool that is not already available.
```

这一行可保留，因为它鼓励按需加载。

---

### Task 5：TUI 显示

**文件**：
- `src/app/tui/components/render-utils.ts`
- `src/app/tui/components/ToolCardBlock.tsx`

#### 5a. ACTION_NAMES（`render-utils.ts:24`）

在 `ACTION_NAMES` 对象中加入：

```ts
list_mcp_tools: 'Listed MCP tools',
```

#### 5b. toolNameDisplay 特殊处理（`render-utils.ts:108`）

当前 `render-utils.ts:108` 对 `capability_search` 和 `list_mcp_resources` 有特殊处理（跳过 summary line 截断）。`list_mcp_tools` 也应加入：

```ts
if (name === 'capability_search' || name === 'list_mcp_resources' || name === 'list_mcp_tools') return raw;
```

#### 5c. ToolCardBlock 渲染（`ToolCardBlock.tsx`）

在 `displayName` 计算逻辑中（`ToolCardBlock.tsx:539` 附近）增加 `list_mcp_tools` 分支：

```tsx
: block.name === 'list_mcp_tools'
  ? block.status === 'done'
    ? 'Listed MCP tools'
    : 'MCP tool listing failed'
```

在结果摘要区域，解析 inventory JSON 并渲染：

```tsx
{block.name === 'list_mcp_tools' && block.status === 'done' && inventorySummary && (
  <Box flexDirection="column" marginTop={1}>
    <Text color={dt.dim}>
      {inventorySummary.configured_provider_count} providers · {inventorySummary.callable_provider_count} callable · {inventorySummary.available_tool_count} available tools
    </Text>
    {inventorySummary.unavailableProviders.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        {inventorySummary.unavailableProviders.map(p => (
          <Text key={p.name} color={dt.warning}>  {p.name} · {p.status.replace(/_/g, ' ')}</Text>
        ))}
      </Box>
    )}
  </Box>
)}
```

**空结果区分**：
- 配置为空 → `"No MCP providers are currently configured"`
- 配置存在但 callable=0 → `"N providers configured · 0 currently callable"`

---

### Task 6：配置路径文案清理

**文件**：
- `src/core/tools/tool-contracts.ts`（line 339, 341）
- `src/core/tools/definitions.ts`（line 274）
- `src/core/tools/tool-runner.ts`（相关 stderr 消息）

#### 6a. tool-contracts.ts

修改 `READ_MCP_RESOURCE_CONTRACT.failureHandling`：

```diff
- "If 'Unknown MCP server': verify the server name matches the configuration in kite-code.jsonc or .mcp.json. "
+ "If 'Unknown MCP server': verify the server name in /mcp or <project>/.kite-code/mcp.json. "
- "If 'No MCP manager available': configure mcpServers in kite-code.jsonc to enable MCP integration. "
+ "If 'No MCP manager available': open /mcp to manage MCP providers. Canonical config files are <project>/.kite-code/mcp.json and ~/.kite-code/mcp.json. "
```

#### 6b. definitions.ts

修改 `readMcpResource` 的 stderr（line 274）：

```diff
- stderr: 'No MCP manager available. Configure mcpServers in kite-code.jsonc.',
+ stderr: 'No MCP manager available. Open /mcp to manage MCP providers.',
```

#### 6c. 其他文件

检查 `README.md`、`docs/book/` 和 TUI error messages 中是否有旧路径引用，统一替换为规范路径引导。

---

### Task 7：上下文优化（独立提交，可回滚）

**文件**：
- `src/core/model/context.ts`
- `src/core/capabilities/search.ts`

在 Task 4 验证通过（E2E + 真实模型测试）后，作为独立提交执行。

#### 7a. 移除 MCP Tool Names 注入

删除 `ModelContextState.mcpCapabilityNames` 字段（`context.ts:41`）。

删除 `buildStaticSystemPrompt` 的 `mcpCapabilityNames` 参数及相关 MCP section 生成代码（`context.ts:320-329`）。

删除 `capabilityNameSummary()` 函数（`search.ts:168-180`）。

#### 7b. 清理调用链

追索 `mcpCapabilityNames` 的所有赋值点，逐一移除。

> **实施注意**：此步骤可能涉及 `kernel.ts`、`scheduler.ts` 或 `agent.ts` 中对 context state 的构建逻辑。需在实施时确认调用链的完整范围。

---

### Task 8：测试收敛与文档门禁

**文件**：
- `tests/runtime/list-mcp-tools.test.ts`（新增）
- `tests/e2e/mcp-inventory.test.ts`（新增）
- `tests/golden/golden.test.ts`（更新）
- `docs/active/mcp-runtime-governance.md`（更新）
- `docs/book/11-MCP与Skills扩展.md`（更新）
- `docs/documentation-map.json`（更新）

#### 8a. Runtime Tool 测试

`tests/runtime/list-mcp-tools.test.ts`：验证

- 不需要审批
- 不产生 binding / loaded capability / execution receipt
- Provider unavailable 不导致 Tool Call 失败
- mcpManager 缺失时返回合法空 inventory

#### 8b. Capability Search 测试

在现有 `tests/runtime/capability-search.test.ts`（如果存在）或新测试中覆盖：

- 中英文 inventory 查询 → `inventory_query` redirect
- 普通查询仍正常搜索
- 零匹配返回 catalog_summary

#### 8c. Golden 测试更新

运行 `bun test tests/golden/golden.test.ts` 确认无回归，如有依赖 MCP tool name 注入的断言则同步更新。

#### 8d. 文档同步

- `docs/active/mcp-runtime-governance.md`：记录 `list_mcp_tools` 能力、capability_search 职责收窄
- `docs/book/11-MCP与Skills扩展.md`：更新用户引导，补充三种 MCP 工具的正交用途说明
- `docs/documentation-map.json`：如有映射遗漏则修正

---

### Task 9：E2E 验证

新增 `tests/e2e/mcp-inventory.test.ts`，覆盖 5 个场景（详见 [RFC §14.5](../../design/2026-07-19-mcp-tool-inventory-rfc.md#145-e2e-场景)）：

| 场景 | 描述 | 期望 |
|------|------|------|
| A | Tool 有、Resource 无 | 只调 `list_mcp_tools`，列 5 个 Tool，不调 `list_mcp_resources` |
| B | login_required Provider | "已配置，但需要登录" |
| C | pending_approval Provider | "项目 MCP 已发现，等待批准" |
| D | 搜索无匹配但 Catalog 非空 | "没有匹配到能力" ≠ "没有 MCP 工具" |
| E | 120 tools 分页 | 50 → 50 → 20，顺序稳定，Snapshot 变化旧 cursor fail closed |

---

## 四、提交拆分

按顺序提交，每步独立验证：

```text
1. feat(mcp): add pure MCP inventory projection
   → src/core/mcp/inventory.ts + tests/mcp-inventory.test.ts

2. feat(tools): add list_mcp_tools runtime tool
   → tool-contracts.ts, definitions.ts, tool-requests.ts, tool-runner.ts,
     tool-capabilities.ts, approval-policy.ts

3. fix(capabilities): separate inventory from semantic search
   → search.ts (isMcpInventoryIntent, checkInventoryRedirect, catalog_summary)
   → tool-controller.ts (redirect handling)

4. fix(prompt): clarify MCP tools resources and provider status
   → system-prompt.txt, context.ts (minor)

5. fix(tui): render MCP tool inventory summaries
   → render-utils.ts, ToolCardBlock.tsx

6. docs(mcp): document inventory and canonical config paths
   → tool-contracts.ts, definitions.ts (config path cleanup)
   → docs/active/, docs/book/, README.md

7. test(mcp): cover multilingual inventory discovery
   → tests/runtime/list-mcp-tools.test.ts, tests/e2e/mcp-inventory.test.ts
   → golden test updates

8. refactor(prompt): remove per-tool MCP name injection
   → context.ts, search.ts (独立提交，可回滚)
```

---

## 五、验证命令

每个 Task 完成后运行：

```bash
# 类型检查
bun run typecheck

# Core 边界
bun run check:core-boundary

# 文档影响
bun run check:docs-impact
bun run check:docs

# 单元测试
bun test tests/mcp-inventory.test.ts
bun test tests/runtime/list-mcp-tools.test.ts
bun test tests/mcp-tool-runner.test.ts
bun test tests/mcp-manager.test.ts
bun test tests/mcp-supervisor.test.ts
bun test tests/capability-search.test.ts

# Golden 回归
bun test tests/golden/golden.test.ts

# TUI
bun test tests/tui-layout.test.tsx
bun test tests/tui-system/scenarios/mcp-management-readonly.test.ts --timeout 60000

# E2E
bun test tests/e2e/mcp-inventory.test.ts
```

提交前必须执行项目 `document-before-commit` Skill。

---

## 六、不变量

1. Core 不得依赖 App/TUI（`src/core/mcp/inventory.ts` 是纯函数，无 UI 依赖）
2. Inventory 只返回 provider/name 两个脱敏字段，绝不返回 capabilityId、revision、schema、binding、credential、transport、header
3. `list_mcp_tools` 不签发 binding、不加载 Capability、不产生 execution receipt
4. `mcpManager` 缺失返回合法空 inventory（非执行错误）
5. `capability_search` 的 inventory redirect 只作为错误恢复，不作为主要实现
6. Provider、Tool、Resource 三个概念正交：任一为空不能推出另外两个为空
7. 兼容路径可出现在 migration 文档中，但不能作为推荐写入位置

---

## 七、风险与缓解

| 风险 | 缓解 |
|------|------|
| 模型仍误选 Resource Tool | 强化 Contract + System Prompt + E2E |
| Provider 状态在盘点期间变化 | 不可变 Snapshot + cursor 绑定 revision |
| Inventory 泄露内部身份 | 专用 serializer + 测试断言 |
| Tool 数量过大 | 默认 limit 50 + cursor 分页 |
| 中文变体遗漏 | 正则 `.` 通配 + 多场景测试 |
| Task 7 回滚风险 | 独立提交，可单独 revert |

---

## 八、依赖关系

```text
Task 1 (inventory.ts)
  ↓
Task 2 (runtime tool) ← 可部分并行编写，但测试依赖 Task 1
  ↓
Task 3 (capability_search 收窄) ← 可并行 Task 4/5/6
  ↓
Task 4 (prompt)
  ↓
Task 5 (TUI) ← 可并行 Task 4/6
  ↓
Task 6 (config paths) ← 可并行 Task 4/5
  ↓
Task 7 (上下文优化) ← 必须在 Task 2-6 验证通过后
  ↓
Task 8 (测试 & 文档收敛)
  ↓ (可并行)
Task 9 (E2E) ← 依赖 Task 2/3/5
```
