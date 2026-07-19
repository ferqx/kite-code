# Skills 系统设计

日期：2026-05-23
状态：approved（已确认，待制定实施计划）
参考：`plans/2026-05-22-production-gaps-closure.md` Phase 3（替代原 Hooks+自定义命令方案）
规范：https://agentskills.io/

---

## 目标

为 Kite Code 实现 Skills（技能）系统，严格遵循 agentskills.io 开放标准。Skill 是按需加载的 Markdown 指令文件，通过 `Skill` 工具和 `/skill-name` 斜杠命令两种方式触发。

---

## Section 1: SKILL.md 格式与校验

严格遵循 agentskills.io 规范。

### Frontmatter 必填字段

| 字段 | 约束 |
|------|------|
| `name` | 1–64 字符，`[a-z0-9]+(-[a-z0-9]+)*`（小写字母、数字、连字符），必须与父目录名一致 |
| `description` | 1–1024 字符，描述「做什么」和「何时使用」，包含触发关键词 |

### Frontmatter 可选字段

| 字段 | 约束 |
|------|------|
| `license` | 许可证名称或引用 |
| `compatibility` | 环境要求，≤500 字符 |
| `metadata` | 自由 key-value 映射（author, version, tags 等） |
| `allowed-tools` | 实验性字段，保留不解析 |

### 目录结构

```
skill-name/          # 目录名必须 === frontmatter name
├── SKILL.md         # 必需：YAML frontmatter + Markdown body（建议 <500 行、<5,000 tokens）
├── scripts/         # 可选：可执行脚本
├── references/      # 可选：补充文档
└── assets/          # 可选：模板、图片等
```

### 校验规则

Skill 加载采用容错策略：所有异常情况静默跳过，**不抛出异常、不在 TUI 展示错误、不影响启动**。仅通过 debug/warn 日志记录。

| 场景 | 行为 | 日志级别 |
|------|------|---------|
| 目录无 SKILL.md | 跳过该目录 | warn |
| YAML frontmatter 解析失败 | 跳过该 skill | warn |
| `name` 字段缺失 | 跳过该 skill | warn |
| `name` 包含非法字符 | 跳过该 skill | warn |
| `name` 与目录名不一致 | 跳过该 skill | warn |
| `description` 字段缺失 | 跳过该 skill | warn |
| frontmatter 超过 1024 字符 | 截断并 warn | warn |
| body 为空 | 允许加载，body = "" | debug |
| body 超过 100KB | 截断到 100KB | warn |
| SKILL.md 文件读取失败 | 跳过该 skill | warn |

---

## Section 2: 存放路径与优先级

Skill 从 4 个目录扫描，同名 skill 按以下优先级覆盖：

```
1. 项目 .kite-code/skills/    (最高)
2. 项目 .agents/skills/
3. 用户 ~/.kite-code/skills/
4. 用户 ~/.agents/skills/  (最低)
```

同名判定依据 `name` 字段值（而非目录名）。覆盖后低优先级 skill 不可用。

---

## Section 3: 架构与模块

### 文件结构

```
src/core/skills/
├── types.ts          # SkillManifest, ValidatedSkill 类型
├── loader.ts         # 扫描、解析、校验、去重覆盖、按需读取
├── skill-tool.ts     # Skill 工具定义（LangChain tool）
└── index.ts          # 对外导出
```

### 类型定义（types.ts）

```typescript
export interface SkillManifest {
  name: string;          // frontmatter name，唯一标识
  description: string;   // frontmatter description
  source: "project" | "user";
  origin: ".kite-code" | ".agents";  // 具体来源目录
  dirPath: string;       // Skill 目录绝对路径
}

export interface ValidatedSkill {
  name: string;
  description: string;
  content: string;       // SKILL.md body（去除 frontmatter 后的 Markdown）
}
```

### Loader（loader.ts）

```typescript
/** 扫描所有 skill 目录，返回去重覆盖后的 manifest 列表 */
export function scanSkills(): SkillManifest[];

/** 按名称读取 skill 完整内容（热加载：每次重新读取文件，不缓存） */
export function getSkillContent(
  manifests: SkillManifest[], name: string
): ValidatedSkill | null;
```

**热加载策略：** `getContent()` 每次重新从磁盘读取 SKILL.md，不缓存 body。用户编辑 SKILL.md 后下次触发即生效，无需重启 Kite Code。SKILL.md 文件很小（规范建议 <500 行），磁盘 I/O 可忽略。

### Skill 工具（skill-tool.ts）

```typescript
export function createSkillTool(
  manifests: SkillManifest[]
): StructuredTool {
  return tool(
    async ({ skill }) => {
      const result = getSkillContent(manifests, skill);
      if (!result) {
        return JSON.stringify({ ok: false, error: `Skill not found: ${skill}` });
      }
      return JSON.stringify({ ok: true, name: result.name, content: result.content });
    },
    {
      name: "Skill",
      description: "Invoke a skill to get specialized instructions when its description matches your task.",
      schema: z.object({
        skill: z.string().describe("Name of the skill to invoke"),
      }),
    },
  );
}
```

**安全策略：** `risk: "read"`，免审批。Skill 内容为纯指令文本，无副作用。

---

## Section 4: System Prompt — Available Skills 区段

在 `context.ts` 的 `buildStaticSystemPrompt` 末尾追加：

```markdown
## Available Skills

The following skills are available. Use the `Skill` tool to invoke a skill when its
description matches your task. Invoking a skill loads detailed instructions you MUST follow.

- <name>: <description>
- <name>: <description>
...

IMPORTANT: If there is even a 1% chance a skill might apply, invoke it.
```

**规则：**
- 仅在 manifests 非空时输出此区段
- 仅列出 name + description，不注入 body 内容
- 排序：按优先级链（项目 `.kite-code/` → 项目 `.agents/` → 用户 `~/.kite-code/` → 用户 `~/.agents/`）
- `description` 原样使用（不强制改写），对齐 agentskills.io 规范

**Token 估算：** 20 个 skill × 平均 100 字符 description ≈ 2000 字符（~500 tokens），可接受。

---

## Section 5: 数据流

### 三层加载模型（Progressive Disclosure）

对齐 agentskills.io 的渐进式上下文效率模型：

| 阶段 | 加载内容 | 时机 |
|------|---------|------|
| **Discovery** | name + description（~100 tokens/skill） | TUI 启动时一次性扫描 |
| **Activation** | 完整 SKILL.md body | 用户 `/skill-name` 或 Agent 调用 `Skill` 工具时 |
| **On-demand** | scripts/references/assets 中文件 | Agent 在执行 skill 指令时按需引用 |

### 启动流程

```
TUI mount
  → loader.scan() → SkillManifest[]
    → system prompt "Available Skills" 区段
    → 斜杠补全列表
    → runner 持有 manifests 引用
```

### 用户激活流程

```
用户输入: /tdd write tests for foo.ts
  → useSlashCommand("/tdd write tests for foo.ts")
  → 解析: skill="tdd" + task="write tests for foo.ts"
  → loader.getContent("tdd")
  → 拼接: "[SKILL CONTENT]\n\n---\n\nUser task: write tests for foo.ts"
  → runTask(拼接后的完整输入)
```

用户可连续激活多个 skill，按序拼接：
```
[SKILL A CONTENT]

---

[SKILL B CONTENT]

---

User task: ...
```

### Agent 自激活流程

```
Turn N:
  Agent 读取 system prompt 中 Available Skills 区段
  Agent 判断 "systematic-debugging" 匹配当前任务
    → 调用 Skill({skill: "systematic-debugging"})
    → skill-tool 执行 → 返回 ToolMessage { ok, name, content }

Turn N+1:
  Agent 读取 Skill tool result (skill 完整内容)
  Agent 遵循 skill 指令继续任务
```

---

## Section 6: TUI 集成

### App.tsx 新增 Actions

```typescript
| { type: "ACTIVATE_SKILL"; name: string; content: string }
| { type: "DEACTIVATE_SKILL"; name: string }
| { type: "LIST_SKILLS" }
```

Reducer 处理：
- `ACTIVATE_SKILL` → 追加到 `state.pendingSkills: string[]`
- `DEACTIVATE_SKILL` → 从队列移除
- `LIST_SKILLS` → 生成 text block 列出所有可用 skill 的 name + description

### 斜杠命令

`useSlashCommand.ts` 处理逻辑：
1. 先走现有内置命令匹配（`/thinking`, `/model`, `/clear`, ...）
2. 不命中 → 查 skill manifests
3. 命中 skill → `getContent()` → dispatch `ACTIVATE_SKILL`
4. 支持组合形式 `/skill-name <task>`

### 斜杠补全

`useSlashSuggestions.ts`：现有 `SLASH_COMMANDS` 数组动态追加 loaded skill names。

---

## Section 7: CLI 支持

```bash
bun run agent run --task "fix bug" --skill debugging
bun run agent run --task "fix bug" --skill debugging --skill tdd
```

`--skill` 可重复指定，按序激活。CLI 模式下 skill content 注入 initial task 前缀（与 TUI 拼接逻辑相同）。CLI 不做 auto-matching。

---

## Section 8: 特殊标签

Skill body 中保留 agentskills.io 标准特殊标签，由模型解读，不在 Kite Code 运行时解析：

| 标签 | 含义 |
|------|------|
| `<SUBAGENT-STOP>` | 子 agent 应忽略的内容块 |
| `<HARD-GATE>` | 不可逾越的硬约束 |
| `<EXTREMELY-IMPORTANT>` | 最高优先级指令 |

---

## Section 9: 变更影响面

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/core/skills/types.ts` | SkillManifest、ValidatedSkill 类型 |
| 新增 | `src/core/skills/loader.ts` | 扫描 4 目录、解析 YAML、去重覆盖、按需读取 |
| 新增 | `src/core/skills/skill-tool.ts` | Skill 工具定义 |
| 新增 | `src/core/skills/index.ts` | 对外导出 |
| 新增 | `tests/skills/loader.test.ts` | 扫描、解析、去重、覆盖、校验、getContent 测试 |
| 新增 | `tests/skills/skill-tool.test.ts` | Skill 工具注册、调用、返回、不存在测试 |
| 修改 | `src/core/tools/definitions.ts` | `createAgentTools` 新增 Skill 工具 |
| 修改 | `src/core/harness/tool-policy.ts` | Skill 工具分类为 risk: read |
| 修改 | `src/core/model/context.ts` | `buildStaticSystemPrompt` 追加 Available Skills 区段 |
| 修改 | `src/core/runner.ts` | RunAgentInput 新增 skills: SkillManifest[] |
| 修改 | `src/core/harness/graph.ts` | createAgentTools 传入 skills |
| 修改 | `src/app/tui/App.tsx` | 新增 ACTIVATE_SKILL、DEACTIVATE_SKILL、LIST_SKILLS |
| 修改 | `src/app/tui/index.tsx` | 启动扫描 skills，传递给 runner |
| 修改 | `src/app/tui/hooks/useSlashCommand.ts` | 识别 /skill-name |
| 修改 | `src/app/tui/hooks/useSlashSuggestions.ts` | 补全列表加入 skill 名称 |
| 修改 | `src/app/tui/types.ts` | 新增 pendingSkills 状态字段 |
| 修改 | `src/app/cli/index.ts` | 支持 --skill 参数 |
| 修改 | `tests/tool-policy.test.ts` | 新增 Skill 工具策略测试 |
| 修改 | `tests/context.test.ts` | 新增 Available Skills 区段测试 |
| 修改 | `tests/tui-reducer.test.ts` | 新增 ACTIVATE_SKILL、DEACTIVATE_SKILL、LIST_SKILLS 测试 |
| 修改 | `tests/tui-layout.test.tsx` | 新增 skill 补全渲染测试 |

---

## Section 10: 不做

- `user_invocable: false` frontmatter 字段 — 所有 skill 均可被用户和 agent 调用
- Skill 依赖声明 / 版本管理 / Skill 市场 / 远程加载
- 文件监控 / 缓存失效 — 保持热加载
- `allowed-tools` 字段解析 — 实验性字段，保留不处理
- `matcher.ts` / `injector.ts` — agent 通过 Skill 工具自主判断，不做关键词匹配或预注入

---

## 依赖

- Phase 1 + Phase 2 MCP 核心、工具体系（已完成）
- 无外部新依赖（YAML frontmatter 解析可用 `Bun` 内置或手写轻量解析）

## 相关文档

- [`2026-05-22-production-gaps-closure.md`](../plans/2026-05-22-production-gaps-closure.md) — 总体补齐方案（Phase 3 已调整）
- [`2026-05-22-skills-system.md`](../plans/2026-05-22-skills-system.md) — 原始 draft（本设计替代）
- [agentskills.io 规范](https://agentskills.io/) — Skills 开放标准
- [skills-ref 校验工具](https://github.com/agentskills/agentskills) — 官方参考实现
