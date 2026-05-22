# Skills 系统方案

> 状态：draft | 优先级：P1 | 创建：2026-05-22

## 概述

为 OpenPX 实现 Skills（技能）系统，与 Claude Code 的对齐点为：

1. **Skill 是 Markdown 文件** — YAML frontmatter（name, description）+ Markdown body（指令/提示词）
2. **Skill 是工具** — 通过 `Skill` 工具按需加载内容，而非预注入 system prompt
3. **Content 在对话框中** — skill 内容作为 ToolMessage 或用户消息出现在对话历史中，透明可审计
4. **Agent 自主匹配** — agent 通过 system prompt 中的 Available Skills 列表判断是否需要调用 Skill 工具
5. **用户显式触发** — `/skill-name` 斜杠命令直接加载 skill 内容

### 与 Claude Code 的对齐对比

| 维度 | Claude Code | OpenPX 本方案 | 对齐 |
|------|------------|-------------|------|
| Skill 格式 | YAML frontmatter + Markdown body | 同 | ✅ |
| 存放位置 | `~/.claude/skills/` + `.claude/skills/` | `~/.openpx/skills/` + `.openpx/skills/` | ✅ |
| 内容加载 | 按需加载，不在 system prompt 中 | 同 | ✅ |
| 用户触发 | `/skill-name` 斜杠命令 | 同 | ✅ |
| Agent 触发 | Agent 调用 Skill 工具 | 同 | ✅ |
| Available Skills | system prompt 中列出 name + description | 同 | ✅ |
| 去重覆盖 | 项目级覆盖用户级同名 | 同 | ✅ |
| max_results | Skill 工具支持搜索 | 同 | ✅ |
| Special tags | `<HARD-GATE>`, `<EXTREMELY-IMPORTANT>`, `<SUBAGENT-STOP>` | 支持原样保留 | ✅ |

## Skill 文件规范

### 目录结构

```
~/.openpx/skills/              # 用户级（跨所有项目可用）
  my-skill/
    SKILL.md                   # 必需：YAML frontmatter + Markdown body
    heavy-reference.md         # 可选：超长参考文档（body 内按名引用）
    scripts/                   # 可选：可执行资源

.openpx/skills/                # 项目级（跟随 git，团队成员共享）
  project-rule/
    SKILL.md
```

### 优先级

- 项目级 skill 覆盖用户级同名 skill
- 同名判定依据：`name` 字段值（非目录名）
- 覆盖后 user 级 skill 不可用

### SKILL.md 格式

```markdown
---
name: my-skill                # 必填：字母、数字、连字符
description: Use when [触发条件]  # 必填：第三人称，Use when 开头，只描述触发条件
---

# Skill 标题（可选，前端展示用）

[Markdown body — agent 加载后的行为指令]

<!-- 支持的特殊标签 -->
<HARD-GATE>
不可逾越的硬约束
</HARD-GATE>

<EXTREMELY-IMPORTANT>
最高优先级指令
</EXTREMELY-IMPORTANT>

<SUBAGENT-STOP>
子 agent 跳过此块
</SUBAGENT-STOP>
```

### Frontmatter 约束

- 总计 ≤ 1024 字符
- `name`（必填）：仅 `[a-zA-Z0-9-]+`，1-64 字符
- `description`（必填）：第三人称，以 "Use when..." 开头，只描述触发条件而非 workflow 总结，1-500 字符

被跳过的 skill 不会出现在 Available Skills 列表中。

### 目录级校验

- Skill 目录下必须存在 `SKILL.md`
- SKILL.md 必须有有效的 YAML frontmatter
- 校验失败 → 跳过该 skill，debug log 记录原因

## 架构设计

### 模块职责

```
src/core/skills/
  types.ts             # SkillManifest, ValidatedSkill 类型定义
  loader.ts            # 扫描、解析、校验、读取

src/core/tools/
  skill-tool.ts        # Skill 工具实现

src/core/model/
  context.ts           # [MODIFIED] buildStaticSystemPrompt 加入 Available Skills 区段

src/core/
  runner.ts            # [MODIFIED] RunAgentInput 新增 skills: SkillManifest[]
  harness/graph.ts     # [MODIFIED] createAgentTools 接收 skills loader

src/app/tui/
  hooks/
    useSlashCommand.ts       # [MODIFIED] 动态识别 /skill-name
    useSlashSuggestions.ts   # [MODIFIED] 补全列表加入 skill 名称
  App.tsx                    # [MODIFIED] 新增 ACTIVATE_SKILL, LIST_SKILLS Actions
  index.tsx                  # [MODIFIED] 启动加载 skills，传递给 runner

src/app/cli/
  index.ts                   # [MODIFIED] 支持 --skill <name> 参数
```

### 职责边界

| 模块 | 职责 | 不做什么 |
|------|------|----------|
| `types.ts` | 定义 SkillManifest (name, description, filePath)、ValidatedSkill (name, content) | — |
| `loader.ts` | 扫描目录 → 解析 YAML → 去重（项目覆盖用户）→ 校验 → 返回 SkillManifest[]；getContent(name) → 返回 ValidatedSkill | 不做匹配、不做注入 |
| `skill-tool.ts` | 实现 Skill 工具，调用 loader.getContent()，返回 skill 内容 | 不做扫描、不做覆盖逻辑 |
| `context.ts`（改） | 构建 "Available Skills" 区段，列出 name + description | 不注入 skill 内容 |
| `runner.ts`（改） | 传递 skills 列表给 graph | — |

### 不再需要的模块（相比最初方案）

- ❌ `matcher.ts` — agent 通过 Skill 工具自主判断，不做外部关键词匹配
- ❌ `injector.ts` — skill 内容作为工具结果出现在对话中，不预注入 system prompt

## 核心数据流

### 三层数据流

```
[启动时]
  loader.scan()
    → SkillManifest[]
      → system prompt: "Available Skills" 区段（仅 name + description）
      → TUI: 斜杠命令补全列表

[运行时 — 用户 /skill-name]
  用户输入 "/tdd"
    → useSlashCommand 匹配 skill 名
    → loader.getContent("tdd")
    → dispatch ACTIVATE_SKILL { name, content }
    → skill content 注入到下次 agent turn（作为 human message 或 system message 追加）

[运行时 — Agent 调用 Skill 工具]
  Agent 判断需要 skill → 调用 Skill({skill: "tdd"})
    → skill-tool.ts 执行: loader.getContent("tdd")
    → 返回 ToolMessage: { ok: true, name: "tdd", content: "[SKILL.md body]" }
    → Agent 在下一 turn 读取 tool result 并遵循 instruction
```

### 被移除的设计路径

- ~~自动关键词匹配~~ → agent 判断是否调用 Skill 工具（对齐 Claude Code）
- ~~预注入 system prompt~~ → 内容按需加载，出现在对话历史中（对齐 Claude Code）

## 核心模块详细设计

### 1. loader.ts

```typescript
export interface SkillManifest {
  name: string;          // YAML frontmatter name 字段
  description: string;   // YAML frontmatter description 字段
  source: "user" | "project";
  dirPath: string;       // Skill 目录路径
  filePath: string;      // SKILL.md 完整路径
}

export interface ValidatedSkill {
  name: string;
  description: string;
  content: string;       // SKILL.md body（去除 frontmatter 后）
}

// 扫描所有 skill 目录，返回去重合并后的 manifest 列表
export function scanSkills(): SkillManifest[];

// 按名称读取 skill 的完整内容（按需加载）
export function getSkillContent(
  manifests: SkillManifest[], name: string
): ValidatedSkill | null;
```

**加载时序**：TUI 启动时调 `scanSkills()`，TUI 持有 manifests 列表。`getSkillContent()` 在用户调 `/skill-name` 或 agent 调 Skill 工具时才执行。

**热加载**：每次 `getSkillContent()` 重新读取文件，不缓存 body 内容。用户编辑 SKILL.md 后立即生效。

### 2. skill-tool.ts

LangChain `tool()` 定义，加入 `createAgentTools` 返回的数组：

```typescript
{
  name: "Skill",
  description: "Invoke a skill to get specialized instructions. Available skills are listed in system prompt.",
  schema: z.object({
    skill: z.string().describe("Name of the skill to invoke"),
  }),
  func: async ({ skill }) => {
    const result = getSkillContent(manifests, skill);
    if (!result) return JSON.stringify({ ok: false, error: `Skill not found: ${skill}` });
    return JSON.stringify({ ok: true, name: result.name, content: result.content });
  }
}
```

**名称**：`Skill`（首字母大写），与 Claude Code 对齐。

**返回格式**：`{ ok, name, content }` — `content` 字段包含 SKILL.md 完整 body。

### 3. context.ts — Available Skills 区段

在 `buildStaticSystemPrompt` 末尾追加：

```markdown
## Available Skills

The following skills are available. Use the `Skill` tool to invoke a skill when its description matches
your current task. Invoking a skill loads detailed instructions you MUST follow.

- <name>: <description>
- <name>: <description>
...

IMPORTANT: Check if any skill applies before starting work. If there is even a small chance a skill is
relevant, invoke it.
```

**约束**：
- 仅列出 skill 的 name 和 description，不注入 body 内容
- 排序：项目级 skill 在前，用户级在后
- 去重后的 skill 始终列出（即使当前 turn 未激活）
- `manifests` 为空数组时，不输出 "Available Skills" 区段

**token 预算考虑**：假设 20 个 skill，每个 description 平均 100 字符，总计约 2000 字符（~500 tokens），可接受。

### 4. 特殊标签处理

Skill 内容中的特殊标签原样传递给 agent，由 agent 自行解读：

| 标签 | 含义 |
|------|------|
| `<HARD-GATE>` | 不可违背的约束，agent 必须在任何操作前优先检查 |
| `<EXTREMELY-IMPORTANT>` | 最高优先级的指令，覆盖默认行为 |
| `<SUBAGENT-STOP>` | 标记子 agent/子任务应忽略的内容块 |

这些标签不在 OpenPX 运行时解析，保留在 skill body 中由模型理解。

## TUI 集成

### 新增 Action

```typescript
// App.tsx Action 联合类型扩展
| { type: "ACTIVATE_SKILL"; name: string; content: string }
| { type: "DEACTIVATE_SKILL"; name: string }
| { type: "LIST_SKILLS"; manifests: SkillManifest[] }
```

### Reducer 处理

- `ACTIVATE_SKILL` → 将 skill 追加到等待注入队列（`state.pendingSkills: string[]`）
- `DEACTIVATE_SKILL` → 从队列移除
- `LIST_SKILLS` → 生成 text block 展示所有可用 skill

### 斜杠命令扩展

在 `useSlashCommand.ts` 中：

```
输入: /tdd

1. 先走现有内置命令匹配（/thinking, /model, /clear, ...）
2. 不命中 → 查 skill manifests 列表
3. 命中 skill → dispatch ACTIVATE_SKILL
4. 不命中 → 返回 unknown
```

### 斜杠补全

在 `useSlashSuggestions.ts` 中，`SLASH_COMMANDS` 数组动态追加 loaded skills：

```typescript
const SLASH_COMMANDS = [
  // ...内置命令
  ...skillManifests.map(s => ({ command: `/${s.name}`, description: s.description })),
];
```

### TUI 启动流程

```
TuiBootstrap mount
  → scanSkills()
  → manifests 存入 useRef
  → 传递给 runTask / runner
  → useSlashSuggestions 消费 manifests 做补全
```

### 用户激活流程

```
用户: /tdd [Enter]
  → useSlashCommand("/tdd")
  → 识别为 skill "tdd"
  → loader.getContent("tdd")
  → dispatch ACTIVATE_SKILL({ name: "tdd", content })
  → TUI 显示: "Skill 'tdd' activated. Send your task."

用户: write tests for foo.ts
  → runTask("write tests for foo.ts")
  → 在 initial task 前拼接 skill content:
    "[SKILL CONTENT]\n\n---\n\nUser task: write tests for foo.ts"
  → agent 看到 skill 内容 + 用户任务
```

### `/skill-name <task>` 组合形式

```
用户: /tdd write tests for foo.ts

处理:
1. 解析为 skill=tdd + task="write tests for foo.ts"
2. 激活 skill + 立即 runTask(task)
```

## CLI 支持

```bash
# 单 skill 激活
bun run agent run --task "fix bug" --skill debugging

# 多 skill 激活
bun run agent run --task "fix bug" --skill debugging --skill tdd
```

CLI 不做 auto-matching（非交互式），仅支持显式 `--skill`。

## Agent 自激活流程

```
Turn N:
  Agent 读取 system prompt 中 Available Skills section
  Agent 判断 "systematic-debugging" 匹配当前任务 → 调用 Skill({skill: "systematic-debugging"})
  skill-tool.ts 执行 → 返回 ToolMessage { ok, name, content }

Turn N+1:
  Agent 读取 Skill tool result (skill content)
  Agent 遵循 skill instructions 完成任务
```

## 错误处理矩阵

| 场景 | 行为 | 日志级别 |
|------|------|---------|
| SKILL.md 不存在（目录无 SKILL.md） | 跳过该目录 | warn |
| YAML frontmatter 解析失败 | 跳过该 skill | warn |
| `name` 字段缺失或非法字符 | 跳过该 skill | warn |
| `description` 字段缺失 | 跳过该 skill | warn |
| body 为空 | 允许加载（仅 name + description），body = "" | debug |
| frontmatter 超过 1024 字符 | 截断并 warn | warn |
| 项目/用户同名 skill | 项目级覆盖，用户级跳过 | debug |
| `getContent()` 找不到 skill | 返回 null，caller 处理 | debug |
| Skill 工具被调用时 skill 不存在 | 返回 `{ ok: false, error: "Skill not found: X" }` | — |
| Skill body 过大（>100KB） | 截断到 100KB，warn | warn |

## 测试策略

| 测试文件 | 覆盖范围 |
|---------|---------|
| `tests/skills/loader.test.ts` | 扫描、解析、去重、覆盖、校验、getContent |
| `tests/skills/skill-tool.test.ts` | Skill 工具注册、调用、返回、skill 不存在 |
| `tests/context.test.ts`（扩展） | Available Skills 区段、无 skills 时不输出区段 |
| `tests/tool-definitions.test.ts`（扩展） | Skill 工具在 createAgentTools 返回中 |
| `tests/tui-reducer.test.ts`（扩展） | ACTIVATE_SKILL、DEACTIVATE_SKILL、LIST_SKILLS |
| `tests/cli.test.ts`（扩展） | --skill 参数解析 |
| `tests/e2e/skills/` | 完整链路：用户激活 → agent 使用 → tool 调用 → agent 遵循 |
| `tests/tui-layout.test.tsx`（扩展） | 斜杠命令补全含 skill 名称 |

## 与现有路线的集成

本方案与 `2026-05-22-production-gaps-closure.md` 的关系：

| 关联项 | 关系 | 说明 |
|--------|------|------|
| Phase 3: 自定义斜杠命令 | 互补 | Skills 实现后，`customCommands` 可直接复用 skills 机制 |
| Phase 3: Hooks 系统 | 并行 | PreToolUse/PostToolUse hook 可感知 Skill 工具调用 |
| MCP 协议支持 | 独立 | Skills 与 MCP 无耦合，可独立开发部署 |

## 不纳入 Phase 1

- `user_invocable: false` frontmatter 字段（所有 skill 均可被用户和 agent 调用）
- Skill 依赖声明（skill A 依赖 skill B）
- Skill 版本管理
- Skill 市场/远程加载
- Skill 调用统计/分析
