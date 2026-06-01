# 第十一章 MCP 与 Skills 扩展

## 11.1 MCP 协议支持

### 概述

MCP（Model Context Protocol）是一个开放协议，允许 AI 应用连接外部工具服务器。

| Transport | 配置方式 | 适用场景 |
|-----------|----------|----------|
| stdio | `command` + `args` | 本地进程（如 filesystem server） |
| streamable HTTP | `url` + `headers` | 远程服务（如 GitHub MCP） |

### 工具命名规则

MCP 工具以 `mcp__<server>__<tool>` 格式命名，例如：
- `mcp__filesystem__read_file`
- `mcp__github__create_issue`

### 安全策略

```
MCP 工具默认需要审批（risk: mcp）
  ├─ server config 中声明 risk: "read" → 直接放行
  ├─ full_access 模式 → 直接放行
  └─ 其他情况 → 触发审批
```

### 超时配置

| 操作 | 默认超时 | 可配置 |
|------|----------|--------|
| 连接 | 5 秒 | 否 |
| 工具调用 | 30 秒 | 是（per-server `timeout` 字段） |
| 资源读取 | 10 秒 | 是（per-server `timeout` 字段） |

在 `openpx.jsonc` 的 `mcpServers` 中可为每个 server 配置 `timeout`（毫秒），覆盖默认值。

### MCP 连接生命周期

```
useMcpConnection hook
  → loadMcpConfig() 读取 mcpServers 配置
  → new McpManager()
  → manager.connectAll(servers)
  → 成功后构建 promptRegistry
  → 组件卸载时 manager.disconnectAll()
```

## 11.2 MCP Resources

MCP Resources 允许 Agent 读取外部资源注入上下文。

### 工具：read_mcp_resource

```typescript
{
  name: "read_mcp_resource",
  schema: { server: string, uri: string }
}
```

`read_mcp_resource` 被归类为只读工具，始终不需要审批。

## 11.3 MCP 提示（Prompts）

MCP Prompts 可注册为斜杠命令：

```
manager.getPromptRegistry() → Map<string, { server, prompt }>
  → 用户输入 /mcp__servername__promptname
  → dispatch INJECT_MCP_PROMPT
```

## 11.4 /mcp 管理面板

```
触发：/mcp → SHOW_MCP → McpPanel

显示：已连接服务器列表、状态、transport 类型、工具数量、风险级别
```

---

## 11.5 Skills 系统

### 概述

Skills 系统对齐 [agentskills.io](https://agentskills.io) 开放标准，允许用户通过 Markdown 文件定义可复用的技能指令。

### 技能文件结构

```
.openpx/skills/          # 项目级（优先）
~/.openpx/skills/        # 用户级（fallback）
├── code-review/
│   └── SKILL.md
├── refactor/
│   └── SKILL.md
└── test/
    └── SKILL.md
```

### SKILL.md 格式

```markdown
---
name: code-review
description: 代码审查技能
---

你是一个代码审查专家。请按以下标准审查代码：
1. 代码风格一致性
2. 潜在 bug
3. 性能问题
4. 安全漏洞
```

### 技能激活方式

1. **斜杠命令**：`/code-review 检查 src/App.tsx`
   - 解析技能名 → `getSkillContent()` 读取 SKILL.md → dispatch `ACTIVATE_SKILL`
   - 如有附带任务，组合为 `skillContent + task` 发送给 agent

2. **Skill 工具**：Agent 自主调用
   - Agent 识别到需要特定技能时，调用 `Skill` 工具
   - 工具返回 SKILL.md 内容作为上下文

### Skill 工具安全策略

`Skill` 始终不需要审批（risk: `read`），不受 `read-only` 访问权限阻止。

### 技能与前缀缓存

`Skill` 工具在基集中的固定位置：`read_mcp_resource` 之后、`update_plan` 之前。此顺序保证前缀缓存稳定性。

---

## 11.6 扩展能力对比

| 维度 | MCP Tools | Skills |
|------|-----------|--------|
| 来源 | 外部服务器进程 | 本地 Markdown 文件 |
| 能力 | 执行操作（读写、API 调用） | 注入指令（提示词增强） |
| 注册时机 | MCP 连接成功后 | 启动时扫描 |
| 安全策略 | 默认需审批 | 始终直通 |
| 使用方式 | Agent 自主调用 | 斜杠命令或 Agent 调用 |
| 命名格式 | `mcp__<server>__<tool>` | `/<skill-name>` |
