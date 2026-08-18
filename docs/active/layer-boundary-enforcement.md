# 当前规则：分层边界强制

状态：active
最后更新：2026-08-17
范围：

- `src/core/` 所有模块
- `src/app/` 所有模块
- `src/protocol/` 类型定义

读取时机：

- 在 `src/core/` 中新增或修改任何文件时。
- 在 `src/core/` 或 `src/protocol/` 中添加 `import` 语句时。
- 在 core 模块中进行文本格式化（截断、省略号、展示文案）时。
- Code agent 生成代码涉及跨层引用时。

相关：

- `understanding/2026-05-11-three-layer-architecture-design.md` — 三层分离架构设计规范
- `project-conventions.md` — 类型定义层级规则（互补）

验证：

```bash
bun run check:core-boundary
```

## 核心原则

物理依赖方向固定为 `app → core → protocol`：Protocol 不得依赖 Core/App，Core 不得依赖 App。

**core 模块只关心数据结构和业务逻辑，不关心任何 UI 端的展示格式。**

core 的返回值应可被 CLI、Web、桌面客户端等**任意前端**直接消费，无需依赖 TUI 的类型或工具函数。

## 禁止事项

### 🔴 禁止：core 导入 app/tui 的任何符号

```typescript
// ✗ 禁止 — core 层不应依赖 TUI 类型
import type { OutputBlock, InterruptState } from "../../app/tui/types.js";

// ✗ 禁止 — core 层不应依赖 TUI 渲染工具
import { getToolDetail, getToolPreview } from "../../app/tui/components/render-utils.js";

// ✗ 禁止 — core 层不应依赖任何 app/ 子目录
import { ... } from "../../app/...";
```

**合规方式**：
- core 定义中立的数据类型（如 `SessionData`、`ReplayInterrupt`），不含 `blockId`、`preview`、`detail`、`expanded`、`folded` 等展示字段。
- TUI 层通过适配器函数（如 `sessionDataToUI()`）将中立数据转为 TUI 专用类型。

### 🔴 禁止：protocol 导入 core/app

`src/protocol/` 只保存跨层共享、JSON-safe 且不拥有 Runtime 调度语义的数据。它不得导入
`src/core/`、`src/app/` 或通过 alias、相对路径、barrel、静态/动态 import 间接取得这些类型。
RuntimeState、RuntimeEvent、RuntimeAction 与 provider 接口属于 Core 当前内部 API，不因多个 App
消费者而整体搬入 Protocol。

`check:core-boundary` 使用 TypeScript AST 解析 module specifier 与符号来源，覆盖 alias、相对路径、
多行 import/export、dynamic import/require，以及被重命名、括号或注释包围的 Registry dispatch 调用。
基于单行文本或精确调用字符串的检查不构成分层门禁。

PS-01 还增加 filesystem seam 的静态所有权：只有规范路径
`src/core/execution/workspace-filesystem/local-provider.ts` 可为受治理 Workspace capability 导入 Node
filesystem API；该 Local Provider 不得导入 Policy、Runtime authority 或 App。production filesystem
consumer 不得导入已删除的旧 `src/core/tools/file.ts`/`search.ts` 路径，也不得导入
`tests/helpers/` 中的 Fake、legacy dispatcher 或差分 oracle。ToolSpec、Controller、Runner 与 Pipeline
只能依赖 Protocol operation/observation、Provider interface 或注入的 dispatcher，不能保留失败时直连旧
实现的 fallback。

Tool Pipeline 的 process-local dispatch stage authority 也有独立静态所有权。authority module 只能由
`dispatch.ts` issuer 与 `receipt.ts` verifier 导入；Recorded/Dispatched issuer 只能在 dispatch adapter 内调用。
Controller 可调用的唯一例外是 dispatch module 暴露的 confirmed-failure 专用投影，它不接受通用
`ToolExecutionResult`，不能签发 success 或注入 filesystem/Runtime 字段。任何新增通用 seal/factory、从其他
Core 模块导入 authority，或手造 `stage: 'dispatched'` 进入 receipt 都属于边界绕过。

### 🔴 禁止：core 做展示层文本格式化

下列操作属于**展示层格式化**，不允许出现在 core 中：

| 禁止的模式 | 示例 | 说明 |
|-----------|------|------|
| 硬编码字符截断 | `text.slice(0, 40) + "..."` | 截断长度、"..." 后缀是 UI 约定 |
| 硬编码行数截断 | `lines.slice(0, 6).join("\n")` | 预览行数是 UI 布局决策 |
| 硬编码展示文案 | `"(file too large for preview)"` | 不同 UI 需要不同语言/风格的文案 |
| 空字符串变 `undefined` | `str \|\| undefined` | 仅在需要区分「无内容」vs「空内容」的展示场景有意义 |

**合规方式**：
- core 返回**完整数据**（全文本、全量行数），由 TUI 层做截断和格式化。
- 如需数据约束（如防止事件过大），使用技术常量（如 `slice(0, 1024)` 防止 1MB+ 内容进事件），并注释说明是数据约束而非展示格式化。

### 🟡 灰色地带：协议事件中的格式化

跨层 DTO（例如 `src/protocol/events.ts` 中的计划、审批和用户输入载荷）位于 core 的下游。如果字段
包含展示倾向的数据：

- **可接受**：事件携带原始数据片段（如文件前 1KB 内容），各端自行格式化。
- **不可接受**：事件携带已格式化的展示文本（如 6 行截断 + "..." + 英文文案）。

### 🟢 允许：core 做数据/技术约束

以下截断是合理的**数据约束**，不是展示格式化：

| 场景 | 示例 | 理由 |
|------|------|------|
| 事件数据大小限制 | `error.slice(0, 200)` | 防止巨型错误消息撑爆事件 |
| Token 限制 | `text.slice(0, MAX_TOKENS * 4)` | LLM 上下文窗口硬约束 |
| 技能体大小限制 | `body.slice(0, 100 * 1024)` | 防止巨型技能文件占用内存 |
| 工具输出摘要 | `summary = content.slice(0, 200)` | 协议事件的数据字段，非展示 |

## 架构检查清单

新增或修改 `src/core/` 代码时，确认以下问题：

1. Core 是否导入 App，或 Protocol 是否导入 Core/App？→ 有则删除反向边。
2. 这个函数返回的数据结构里有没有 `preview`、`detail`、`expanded`、`folded` 字段？→ 移到 App 层。
3. 这行 `.slice(0, N)` 是为了展示美观还是数据约束？→ 美观则移到 App，数据约束加注释。
4. 这个字符串是用户可见的文案吗？→ 如果是，由 App 本地化；Protocol 只保留中立载荷。
5. 新增接口是否替代并删除了旧入口或错误依赖？→ 没有则不属于架构收敛。
6. Workspace filesystem I/O 是否只由 Local Provider 拥有，Fake/legacy oracle 是否严格 test-only？→ 否则拒绝。
7. Recorded/Dispatched stage 是否只由 ack 后的 Pipeline issuer 签发，receipt 是否拒绝 clone/手造 token？→ 否则拒绝。

## 历史：本轮重构解决的问题

| 提交 | 问题 | 修复 |
|------|------|------|
| `9fe064b` | `getToolDetail`/`getToolPreview` 在 core 和 TUI 各有一份 | 统一到 `render-utils.ts`，sessions.ts 导入共享版 |
| `32f1dc7` | `sessions.ts` 导入 `OutputBlock`/`InterruptState`，返回 TUI 类型 | 定义中立 `SessionData`/`ReplayInterrupt`，构建逻辑移到 `replay-blocks.ts` |
| `3f28bba` | `checkpoint.ts` 和 `sessions.ts` 硬编码 40/60 字符截断 + "..." | 展示截断移到 `SessionSelector.tsx` / `CheckpointSelector.tsx` |
| `73aa079` | `runner.ts` 硬编码 6 行预览截断 + 英文错误文案 | 只传原始内容片段，格式化移到 `handleEvent.ts` |
