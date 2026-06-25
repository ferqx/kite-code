# Phase 3: Skills 系统完成记录

状态：archived
日期：2026-05-23（完成），2026-06-08（归档）

## 改动摘要

实现 agentskills.io 开放标准的 Skills 系统。

### 核心机制

- **按需加载**：Skill 是 Markdown 文件（YAML frontmatter + body），通过 `Skill` 工具和 `/skill-name` 斜杠命令触发
- **目录优先级**：`.kite-code/skills/` > `.agents/skills/`（项目级）> `~/.kite-code/skills/` > `~/.agents/skills/`（用户级）
- **去重覆盖**：项目级覆盖用户级同名 skill
- **容错**：校验异常静默跳过，不 throw、不 crash

### 触发方式

- **Agent 自激活**：system prompt 中 `Available Skills` 区段列出所有 skill，Agent 调用 `Skill` 工具加载
- **用户显式触发**：`/skill-name` 斜杠命令，支持 `/skill-name <task>` 组合

### 新增模块

```
src/core/skills/
  types.ts       — SkillManifest, ValidatedSkill
  loader.ts      — scanSkills() 4 目录扫描 + getSkillContent() 热加载
  skill-tool.ts  — createSkillTool() LangChain StructuredTool
  index.ts
tests/skills/
  loader.test.ts
  skill-tool.test.ts
```

### Commits (11)

```
bca86e7 feat: skills 类型定义 + skillDirs 路径工具
5e4a732 feat: skills loader — YAML frontmatter 解析 + 4 目录扫描 + 去重覆盖 + 热加载
7f83522 feat: Skill 工具定义 — createSkillTool, LangChain StructuredTool
c4f8449 feat: 工具体系集成 Skill — definitions 注册 + tool-policy risk:read
1ccd605 feat: system prompt 追加 Available Skills 区段
1b27534 feat: runner + graph 传递 skills/skillOptions，打通 core 层链路
79b3899 feat: TUI Skills actions — ACTIVATE/DEACTIVATE/LIST_SKILLS + SET_SKILL_MANIFESTS
3972a68 feat: slash commands 识别 /skill-name + 补全追加 skill 列表
c2bf520 feat: TUI 启动集成 Skills — 扫描 + useSlashCommand 接线 + runner 传递
513e21a feat: CLI --skill 多值参数 + skills 内容注入 task 前缀
db803dc fix: Skill 执行路由 + Available Skills 区段模型上下文
```

### 设计文档

- `understanding/2026-05-23-skills-system-design.md`
- `plans/2026-05-23-skills-system-phase3.md`
