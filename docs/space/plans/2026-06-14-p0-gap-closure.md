# P0 缺口补齐：Web Search + Token 展示 + 开箱即用

> Status: draft
>
> 关联：2026-06-14 竞品全面对比分析（Claude Code / Codex CLI / Gemini CLI / OpenCode）
>
> 背景：`PRODUCT.md` 已知产品缺口章节 + `backlog/2026-06-08-product-experience-gaps.md` B27-B33

## 目标

补齐 3 个 P0（一票否决级）功能缺口，让 Kite Code 具备现代编码 agent 的基础能力面。

## 范围

| 模块 | 涉及子系统 |
|------|-----------|
| Web Search + WebFetch | protocol（新事件）、core/tools（2 个新工具）、core/harness（风险分类）、TUI（渲染 block） |
| Token 展示增强 | protocol（补充 output tokens）、core/cache-metrics（提取 output tokens）、core/model（非 DeepSeek provider 回调）、TUI（StatsLine 展示 output tokens） |
| 默认推荐模型 + 首次体验 | core/config（presets）、TUI（OnboardingWizard、ModelSelector 推荐标签、配置模板生成） |
| 工作空间授权 | TUI（WorkspaceConfirmOverlay）、`~/.kite-code/trusted_workspaces.json`（受信目录持久化） |

明确不做（本计划）：
- 跨会话记忆系统（独立方案，另行计划）
- 配置验证 / 诊断工具
- Provider 特定的 system prompt 微调
- 成本估算（$ 展示）

---

## Task 1：Web Search + WebFetch 工具

### 总体策略

Agent 工具集中内置 `web_search` 和 `web_fetch`，但搜索能力**完全由用户自配的 MCP server 提供**。Kite Code 自身不内置任何搜索 API 调用，避免：

1. 共享免费搜索端点导致速率限制和不可用
2. 将第三方搜索资源消耗转嫁给开源项目
3. 与 provider-agnostic 原则冲突（搜索 provider 也是 provider）

工具实现只做一件事：查找用户配置的 MCP web search server，调用其 `search` 方法。如果 MCP server 不可用，返回清晰的配置指引。

用户可选择接入的 MCP server（示例）：
- Brave Search MCP server（需 Brave API key）
- Tavily Search MCP server（需 Tavily API key）
- SearXNG MCP server（自托管，无需第三方 key）
- 任何实现 search 接口的 MCP server

### Task 1.1 — 协议层：新增 search 相关事件类型

- **文件**：`src/protocol/events.ts`
- **依赖**：无
- **改动内容**：

在 `AgentEvent` 联合类型中新增：

```typescript
| { type: "web_search_start"; data: WebSearchStartPayload }
| { type: "web_search_result"; data: WebSearchResultPayload }
| { type: "web_fetch_start"; data: WebFetchStartPayload }
| { type: "web_fetch_result"; data: WebFetchResultPayload }
```

新增 payload 类型：

```typescript
interface WebSearchStartPayload {
  query: string;
}

interface WebSearchResultPayload {
  query: string;
  results: WebSearchResultItem[];
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface WebFetchStartPayload {
  url: string;
}

interface WebFetchResultPayload {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
}
```

- **验证**：`bun run typecheck` 零错误

### Task 1.2 — Core 层：实现 web_search 工具

- **文件**：新增 `src/core/tools/search.ts`
- **依赖**：无
- **改动内容**：

```typescript
// web_search 工具实现
// 搜索策略：
//   1. 查找用户配置的 MCP web search server
//   2. MCP server 不可用时返回配置指引（含推荐 server 列表和安装命令）

export async function webSearch(params: {
  query: string;
  mcpManager?: McpManager;
  webSearchServerName?: string; // 默认 "web-search"
}): Promise<WebSearchResult> {
  // 1. 检查 MCP manager 可用性
  // 2. 查找指定名称的 MCP server
  // 3. 调用 server.search({ query })
  // 4. 格式化结果返回（最多 5 条）
  // 5. server 不存在时返回 { ok: false, error: "未配置 Web Search 服务..." } + 配置示例
}
```

- 安全约束：
  - query 长度限制（max 500 字符）

- **验证**：`bun test tests/tools.test.ts`

### Task 1.3 — Core 层：实现 web_fetch 工具

- **文件**：新增 `src/core/tools/fetch.ts`
- **依赖**：新增依赖 `@mozilla/readability` + `turndown` + `linkedom`（`bun add @mozilla/readability turndown linkedom`）
- **改动内容**：

对齐 Claude Code / Codex CLI / Gemini CLI 的通用做法，采用 Readability + Turndown 管线：

```
URL → HTTP GET (browser-mimic headers) → Readability (extract main content) → Turndown (HTML→Markdown) → truncate
```

```typescript
// web_fetch 工具实现
// 对齐 Claude Code / Codex CLI / Gemini CLI 的业界标准管线

export async function webFetch(params: {
  url: string;
  maxContentLength?: number; // 默认 8000
}): Promise<WebFetchResult> {
  // 1. URL 安全校验（禁止 localhost、内网 IP、file://）
  // 2. fetch() 获取内容，设置浏览器级 headers：
  //    User-Agent: Chrome 130-alike
  //    Accept: text/html,application/xhtml+xml
  //    Accept-Language: en-US,en;q=0.9
  // 3. Content-Type 检查（仅 text/html、text/plain）
  // 4. linkedom 解析 HTML → Readability 提取正文
  // 5. Turndown 将正文 HTML 转为 Markdown
  // 6. 截断到 maxContentLength
  // 7. 返回 { ok, url, title, content, truncated }
}
```

- 依赖说明：
  - `@mozilla/readability` — Firefox Reader View 的同款算法，专用于提取页面正文（去除导航、广告、侧栏）
  - `turndown` — 标准的 HTML→Markdown 转换器，LLM 天然理解 Markdown
  - `linkedom` — 轻量 DOM 实现，不依赖 jsdom 的沉重 Native 模块，兼容 Bun
- 安全约束（与之前一致）：
  - 禁止内网地址：`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`localhost`、`[::1]`
  - 禁止 `file://` 协议
  - 响应大小限制（拒绝 >5MB）
  - 超时：10s

- **验证**：`bun test tests/tools.test.ts`

### Task 1.4 — Core 层：定义工具契约

- **文件**：`src/core/tools/tool-contracts.ts`
- **依赖**：无（契约描述的是工具行为规范，可与实现并行编写）
- **改动内容**：

新增 `WEB_SEARCH_CONTRACT`：
- `whenToUse`：搜索最新文档、API 变更、社区讨论、技术方案对比。已知代码库内的搜索用 `shell_execute intent=inspect`（grep/rg）或 glob
- `commonMistakes`：搜索词太泛导致不相关结果；不限定日期范围搜索已过时文档；一次搜索多个不相关问题
- `outputFormat`：JSON 含 `results[]`（title/url/snippet），最多 5 条
- `failureHandling`：无结果时尝试更具体的关键词；MCP server 不可用时提示用户配置 web search server

新增 `WEB_FETCH_CONTRACT`：
- `whenToUse`：需要阅读具体页面内容、官方文档页、GitHub issue/PR 详情。搜索返回的 snippet 不够时用 fetch
- `commonMistakes`：Fetch 搜索结果中不存在的 URL；抓取需要登录的页面（会得到登录页 HTML）；不先搜索就直接抓取
- `outputFormat`：JSON 含 title/content/truncated 标志。content 为 Markdown 格式（由 Readability + Turndown 管线产出）
- `failureHandling`：403/404 不可恢复，改用 web_search 找替代源；超时可重试 1 次

- **验证**：`bun test tests/tool-definitions.test.ts` — 新工具契约格式校验通过

### Task 1.5 — Core 层：注册工具 + 风险分类 + System Prompt

- **文件**：`src/core/tools/definitions.ts`、`src/core/harness/tool-policy.ts`、`src/core/prompts/system-prompt.txt`
- **依赖**：Task 1.4
- **改动内容**：

1. `definitions.ts`：在 `createAgentTools()` 中注册 `web_search` 和 `web_fetch`。需要 `McpManager` 注入
2. `tool-policy.ts`：
   - `web_search` → `risk: "network"`，读操作，走审批放行（类似 `shell_execute intent=inspect` 可直通）
   - `web_fetch` → `risk: "network"`，读操作，审批放行
3. `system-prompt.txt`：在 `# Tool Strategy` 章节新增 "Web Search" 小节，说明何时用 `web_search` vs `web_fetch` vs `shell_execute + grep`

- **验证**：`bun test tests/tool-policy.test.ts`、`bun test tests/tool-definitions.test.ts`

### Task 1.6 — TUI 层：渲染搜索结果

- **文件**：
  - 新增 `src/app/tui/components/WebSearchBlock.tsx`
  - 修改 `src/app/tui/types.ts`（OutputBlock 新增 union member）
  - 修改 `src/app/tui/reducers/handleEvent.ts`（处理新事件类型）
- **依赖**：Task 1.5
- **改动内容**：

`types.ts` 新增 OutputBlock 类型：
```typescript
| { id: number; kind: "web_search"; status: "running" | "done" | "error" | "cancelled"; query: string; results?: WebSearchResultItem[] }
| { id: number; kind: "web_fetch"; status: "running" | "done" | "error" | "cancelled"; url: string; title?: string; content?: string; truncated?: boolean }
```

`WebSearchBlock.tsx` 渲染：
- 搜索中：`🔎 Searching: "query" ...`
- 搜索结果：可折叠卡片，展示 title + url + snippet（3-5 条）
- Fetch 结果：标题 + Markdown 内容（复用现有 MarkdownBlock 渲染），折叠/展开

- **验证**：`bun test tests/tui-reducer.test.ts`、`bun test tests/e2e/`

### Task 1.7 — Runner 层：事件流对接

- **文件**：`src/core/harness/tool-runner.ts`
- **依赖**：Task 1.5, 1.6
- **改动内容**：

在 tool runner 中：
- 调用 `web_search` 前 emit `web_search_start`
- 调用后 emit `web_search_result`
- 调用 `web_fetch` 前 emit `web_fetch_start`
- 调用后 emit `web_fetch_result`

- **验证**：`bun test tests/graph.test.ts`、`bun test tests/integration.test.ts`

---

## Task 2：Token 展示增强

### 总体策略

Token 统计持久化系统已完成（参见 `understanding/2026-06-09-token-stats-persistence-design.md`）。StatsLine 已展示 cache hit% 和 total tokens（仅 DeepSeek）。

补齐方向：
1. Output token 累计统计
2. 非 DeepSeek provider（OpenAI、Ollama）的 token 事件覆盖

明确不做：成本估算（$ 展示）。

### Task 2.1 — 补齐 output token 统计

- **文件**：`src/core/cache-metrics.ts`、`src/protocol/events.ts`
- **依赖**：无
- **改动内容**：

1. `events.ts`：`CacheMetricsPayload` 新增 `outputTokens: number`
2. `cache-metrics.ts`：`extractPromptCacheMetrics()` 补充提取 `output_tokens`
3. `StatusState` 新增 `outputTokens` 字段（`src/app/tui/types.ts`）
4. `session_stats` 表新增 `output_tokens` 列（`src/core/persistence/checkpoint.ts`）

- **验证**：`bun test tests/checkpoint.test.ts`

### Task 2.2 — 非 DeepSeek provider 的 token 事件全覆盖

- **文件**：`src/core/model/factory.ts`
- **依赖**：Task 2.1
- **改动内容**：

当前 `cache_metrics` 事件仅在 DeepSeek 路径 emit。需要在 `RetryingChatOpenAI` 和 `RetryingChatOllama` 的 `_generate` 中也添加 usage 回调。

统一回调接口：
```typescript
// factory.ts
export type TokenUsageCallback = (usage: {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}) => void;

// RetryingChatOpenAI 和 RetryingChatOllama 的 _generate 中：
// 调用 super._generate() 后，从 result.llmOutput?.usage 提取 token 数据
// 如果有 _usageCallback 则调用
```

- **验证**：`bun test tests/graph.test.ts`

### Task 2.3 — TUI 层：StatsLine 展示 output tokens

- **文件**：`src/app/tui/StatsLine.tsx`
- **依赖**：Task 2.1, 2.2
- **改动内容**：

当前 StatsLine 展示：`modelName │ think: max │ cache: 78% │ tokens: 45.2k │ [安全]`

改为：`modelName │ ↑ 45k ↓ 12k │ cache: 78% │ [安全]`

其中 `↑` 是 output tokens，`↓` 是 input tokens（cache miss），不做 cost 转换。使用 ASCII 兼容的 `↑` `↓` 而非 `⬆` `⬇`——后者在某些终端/字体下渲染为 2 列宽，可能导致排版错位。

Non-DeepSeek provider 也展示 token 数据。

- **验证**：`bun test tests/tui-layout.test.tsx`

---

## Task 3：默认推荐模型 + 开箱即用体验

### 总体策略

不改变 provider-agnostic 架构。增加产品层面的"推荐路径"：
1. Presets：预置常见 provider 的调优配置
2. 首次启动引导：交互式配置生成
3. 模型推荐标签：ModelSelector 中标注

### Task 3.1 — Preset 系统

- **文件**：新增 `src/core/config/presets.ts`
- **依赖**：无
- **改动内容**：

```typescript
interface ModelPreset {
  id: string;
  label: string;
  provider: ModelProviderType;
  modelName: string;
  baseURL: string;
  envVar: string;      // "DEEPSEEK_API_KEY"
  helperText: string;  // "获取 API Key: https://platform.deepseek.com/api_keys"
  recommended: boolean;
  reasoningEffort?: string | null;
}

const BUILTIN_PRESETS: ModelPreset[] = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    modelName: "deepseek-v4-pro",
    baseURL: "https://api.deepseek.com/v1",
    envVar: "DEEPSEEK_API_KEY",
    helperText: "Get API Key: https://platform.deepseek.com/api_keys",
    recommended: true,
    reasoningEffort: "high",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    modelName: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com/v1",
    envVar: "DEEPSEEK_API_KEY",
    helperText: "Get API Key: https://platform.deepseek.com/api_keys",
    recommended: false,
  },
  {
    id: "ollama-local",
    label: "Ollama (本地)",
    provider: "ollama",
    modelName: "deepseek-v4",
    baseURL: "http://localhost:11434",
    envVar: "",
    helperText: "Make sure Ollama is running: ollama serve",
    recommended: false,
  },
];
```

- **验证**：`bun run typecheck` + 新增 `tests/config-presets.test.ts`

### Task 3.2 — 首次启动引导（Onboarding Wizard）

- **文件**：新增 `src/app/tui/OnboardingWizard.tsx`
- **依赖**：Task 3.1
- **改动内容**：

触发条件：无 `~/.kite-code/kite-code.jsonc` 且无 `.kite-code/kite-code.jsonc`

三步骤交互流程：
1. **Provider 选择**：列表展示 BUILTIN_PRESETS，默认选中 `recommended: true` 的 preset。方向键导航、Enter 确认。
2. **API Key 输入**：文本输入框，提示 `export {ENV_VAR}=xxx` 或直接输入。Ctrl+C 可跳过（生成空配置文件）
3. **确认写入**：展示配置摘要，提示生成的文件路径 `~/.kite-code/kite-code.jsonc`，Enter 启动。Skip 则使用 DeepSeek 默认值

UI 样式：作为 Overlay 层弹出（类似 ModelSelector），使用 `borderStyle="round"` 卡片 + 步骤指示器 `● Step 1/3`

TUI state 新增字段：`showOnboarding: boolean`（`src/app/tui/types.ts`）

- **验证**：`bun test tests/e2e/startup.test.tsx` — 添加 onboarding 场景

### Task 3.3 — ModelSelector 推荐标签

- **文件**：`src/app/tui/components/ModelSelector.tsx`、`src/core/config/index.ts`
- **依赖**：Task 3.1
- **改动内容**：

1. `AvailableModel` 新增 `recommended: boolean` 字段
2. `listAvailableModels()` 对 preset 模型附加 `recommended: true`
3. ModelSelector 渲染时，推荐模型显示 `★ 推荐` 标记（黄色）
4. 推荐模型排在最前面（sort：recommended first, then by name）

- **验证**：`bun test tests/tui-layout.test.tsx`

### Task 3.4 — 配置模板生成

- **文件**：`src/core/config/index.ts`
- **依赖**：Task 3.1
- **改动内容**：

新增 `generateConfigTemplate(preset: ModelPreset, apiKey?: string): string` 函数，返回带注释的 JSONC 字符串：

```jsonc
{
  // 模型和 Provider 配置
  "provider": {
    "deepseek": {
      "type": "deepseek",
      // "apiKey": "sk-xxx",  // 或通过 DEEPSEEK_API_KEY 环境变量设置
      "models": [
        { "name": "deepseek-v4-pro", "default": true },
        { "name": "deepseek-v4-flash" }
      ]
    }
  },
  "theme": "dark",
  "mcpServers": {}
}
```

- **验证**：`bun test tests/cli.test.ts`

### Task 3.5 — 无配置时的默认 fallback

- **文件**：`src/core/config/index.ts`
- **依赖**：Task 3.1
- **改动内容**：

当前 `defaultKiteCodeConfig()` 只返回 DeepSeek provider。保持不变——无配置文件的默认值不变，确保向后兼容。

首次启动时 OnboardingWizard 会让用户显式选择，如果跳过则使用当前 `defaultKiteCodeConfig()`。

- **验证**：`bun test tests/cli.test.ts`

---

## Task 4：工作空间授权确认

### 总体策略

对标 Claude Code 的 `respectGitignore` 权限体系和新目录权限确认。Kite Code 是一个能读、写、执行 shell 命令的 agent，需要在进入新工作空间时获得用户明示授权，防止在非预期目录运行。

**受信工作空间持久化**：`~/.kite-code/trusted_workspaces.json`，格式为 JSON 数组，每项为 `realpath` 解析后的绝对路径。

```json
["/Users/user/project-one", "/Users/user/work/other-project"]
```

每次 TUI 启动时检查 `process.cwd()` 的 realpath 是否在受信列表中。不在则弹出确认覆盖层；用户确认后写入列表。

### Task 4.1 — 受信列表读写

- **文件**：新增 `src/core/config/trust.ts`
- **依赖**：无
- **改动内容**：

```typescript
// 受信工作空间持久化 / Trusted workspace persistence
// 文件：~/.kite-code/trusted_workspaces.json

import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getOpenpxDir } from "./paths";

const TRUSTED_WORKSPACES_FILE = "trusted_workspaces.json";

function trustedFile(): string {
  return join(getKiteCodeDir(), TRUSTED_WORKSPACES_FILE);
}

export function isWorkspaceTrusted(workspace: string): boolean {
  const rp = realpathSync(workspace);
  const list = loadTrusted();
  return list.includes(rp);
}

export function loadTrusted(): string[] {
  try {
    if (!existsSync(trustedFile())) return [];
    const raw = readFileSync(trustedFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addTrustedWorkspace(workspace: string): string[] {
  const rp = realpathSync(workspace);
  const list = loadTrusted();
  if (list.includes(rp)) return list;
  list.push(rp);
  const dir = dirname(trustedFile());
  mkdirSync(dir, { recursive: true });
  writeFileSync(trustedFile(), JSON.stringify(list, null, 2), { encoding: "utf-8", mode: 0o600 });
  return list;
}
```

- **验证**：`bun test tests/cli.test.ts` — 新增 trust 读写测试

### Task 4.2 — TUI 确认覆盖层

- **文件**：新增 `src/app/tui/WorkspaceConfirm.tsx`
- **依赖**：Task 4.1
- **改动内容**：

Ink 组件，样式类似 OnboardingWizard 的卡片式覆盖层：

```
┌──────────────────────────────────────────────┐
│  Kite Code — 工作空间授权                         │
│                                               │
│  Kite Code 请求访问工作目录：                       │
│                                               │
│  /Users/user/work/new-project                 │
│                                               │
│  Agent 拥有在此目录下 读写文件 / 执行 shell       │
│  的能力。请确认这是你预期的工作目录。              │
│                                               │
│  Enter 确认 · Esc 拒绝并退出                      │
└──────────────────────────────────────────────┘
```

- TUI state 新增字段：`showWorkspaceConfirm: boolean`、`workspaceConfirmPath: string`（`src/app/tui/types.ts`）
- 新增 actions：`SHOW_WORKSPACE_CONFIRM`、`CONFIRM_WORKSPACE`、`DENY_WORKSPACE`（`src/app/tui/reducers/actions.ts`）
- `uiReducer` 中新增开关逻辑，`ESCAPE` case 中关闭

### Task 4.3 — 启动时检查 + 拒绝退出

- **文件**：`src/app/tui/index.tsx`
- **依赖**：Task 4.1, 4.2
- **改动内容**：

启动时在 TUI 初始化完成后，调用 `isWorkspaceTrusted(cwd)`。不在受信列表时 dispatch `SHOW_WORKSPACE_CONFIRM`。

```typescript
// 在 initialized 的 useEffect 之后
React.useEffect(() => {
  if (!initialized) return;
  if (!isWorkspaceTrusted(workspace)) {
    dispatch({ type: "SHOW_WORKSPACE_CONFIRM", workspace });
  }
}, [initialized]);
```

确认时 dispatch `CONFIRM_WORKSPACE`，调用 `addTrustedWorkspace(cwd)`，关闭覆盖层，继续正常流程。

拒绝时 dispatch `DENY_WORKSPACE`，调用 `handleExit()` 退出。

- **验证**：`bun test tests/e2e/startup.test.tsx` — 新增 workspace 授权场景
  - env `KITE_CODE_SKIP_WORKSPACE_CONFIRM=true` 或 `KITE_CODE_PTY=true` 时跳过授权（避免阻塞 CI/E2E 测试）

### Task 4.4 — 与 OnboardingWizard 的协作

- **文件**：`src/app/tui/index.tsx`
- **依赖**：Task 4.2, 4.3（以及 Task 3 的 OnboardingWizard）
- **改动内容**：

两个覆盖层不会同时出现。启动检查顺序：
1. 先检查 workspace 是否受信
2. 受信后再检查是否需要 onboarding（无配置文件）
3. workspace 确认和 onboarding 互斥，前者先于后者

- **验证**：`bun test tests/tui-reducer.test.ts`

---

## 依赖关系图

```
Task 1.1 (events) ── Task 1.6 (TUI) ── Task 1.7 (runner)
Task 1.2 (search) ──┐
Task 1.3 (fetch)  ──┼── Task 1.5 (register + policy + prompt)
Task 1.4 (contract) ┘

Task 2.1 (output tokens) ──┬── Task 2.3 (StatsLine)
Task 2.2 (non-DS provider) ┘

Task 3.1 (presets) ──┬── Task 3.3 (selector tags)
                     ├── Task 3.4 (template gen)
                     └── Task 3.2 (onboarding) ── Task 3.5 (fallback)

Task 4.1 (trust store) ── Task 4.2 (confirm overlay) ── Task 4.3 (startup check) ── Task 4.4 (onboarding协作)
```

---

## 并行推进建议

| 批次 | 任务 | 预估改动量 | 可并行 |
|------|------|-----------|--------|
| Batch A | Task 2.1 + 2.2 + 2.3（Token 展示） | 小（已有基础） | ✅ |
| Batch B | Task 1.1 + 1.2 + 1.3 + 1.4（Web Search 核心，可全部并行） | 中 | ✅ |
| Batch C | Task 3.1 + 3.4（Presets + 模板） | 小 | ✅ |
| Batch D | Task 4.1 + 4.2 + 4.3 + 4.4（工作空间授权，完全独立链路） | 小 | ✅ |
| Batch E | Task 1.5 + 1.6 + 1.7（Web Search 接入 + TUI） | 中 | 依赖 Batch B |
| Batch F | Task 3.2 + 3.3 + 3.5（Onboarding + 标签） | 中 | 依赖 Batch C |

- Batch A、B、C、D 可完全并行（不同模块，无依赖冲突）

---

## 风险

| 风险 | 缓解 |
|------|------|
| 新用户可能不知道如何配置 MCP web search server | 工具返回错误时附带清晰的配置示例（`.mcp.json` 片段，推荐 server 列表）；可在 `system-prompt.txt` 中内置推荐说明 |
| 首次引导流程与 E2E 测试冲突 | 在测试环境中通过环境变量 `KITE_CODE_SKIP_ONBOARDING=true` 跳过引导 |
| 工作空间授权阻塞 CI/E2E | 通过 `KITE_CODE_SKIP_WORKSPACE_CONFIRM=true` 跳过授权检查 |
