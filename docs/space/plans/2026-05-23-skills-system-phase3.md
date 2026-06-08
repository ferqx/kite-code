# Phase 3: Skills 系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：archived（2026-06-08 归档）

**Goal:** 实现 agentskills.io 开放标准的 Skills 系统 — 按需加载 Markdown 指令文件，通过 `Skill` 工具和 `/skill-name` 斜杠命令触发。

**Architecture:** `src/core/skills/` 新建 4 文件（types/loader/skill-tool/index）负责扫描 4 目录、解析 YAML frontmatter、去重覆盖、按需热加载。`Skill` 工具通过 `createAgentTools` 注册，system prompt 追加 Available Skills 区段。TUI 启动时扫描，斜杠命令动态匹配 skill 名。

**Tech Stack:** Bun, TypeScript ESM, `@langchain/core` StructuredTool, Ink, 手写 YAML frontmatter 解析器

---

## 文件结构一览

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/core/skills/types.ts` | SkillManifest, ValidatedSkill, SkillScanOptions 类型 |
| 新增 | `src/core/skills/loader.ts` | scanSkills() 扫描 4 目录 + getSkillContent() 热加载 |
| 新增 | `src/core/skills/skill-tool.ts` | createSkillTool() — LangChain StructuredTool |
| 新增 | `src/core/skills/index.ts` | 对外导出 |
| 新增 | `tests/skills/loader.test.ts` | 扫描、解析、去重覆盖、校验、getContent |
| 新增 | `tests/skills/skill-tool.test.ts` | Skill 工具注册、调用、不存在 |
| 修改 | `src/core/config/paths.ts` | 新增 skillDirs(workspace) |
| 修改 | `src/core/tools/definitions.ts` | CreateAgentToolsInput 新增 skills/skillOptions; builtinTools +Skill |
| 修改 | `src/core/harness/tool-policy.ts` | Skill 工具 → risk: "read" |
| 修改 | `src/core/model/context.ts` | buildStaticSystemPrompt 追加 Available Skills 区段 |
| 修改 | `src/core/runner.ts` | RunAgentInput + skills/skillOptions, 传入 buildCodeAgentGraph |
| 修改 | `src/core/harness/graph.ts` | BuildCodeAgentGraphInput + skills/skillOptions, 传入 createAgentTools |
| 修改 | `src/app/tui/types.ts` | TuiState 新增 pendingSkills, skillManifests |
| 修改 | `src/app/tui/App.tsx` | 新增 ACTIVATE_SKILL/DEACTIVATE_SKILL/LIST_SKILLS/SET_SKILL_MANIFESTS |
| 修改 | `src/app/tui/index.tsx` | 启动扫描 skills, 传递到 slash command + runner |
| 修改 | `src/app/tui/hooks/useSlashCommand.ts` | 识别 /skill-name, 支持 /skill-name <task> |
| 修改 | `src/app/tui/hooks/useSlashSuggestions.ts` | 补全列表追加 skill 名称 |
| 修改 | `src/app/cli/index.ts` | ParsedArgs + parseArgs 新增 --skill 多值参数 |
| 修改 | `tests/tool-policy.test.ts` | Skill 工具策略测试 |
| 修改 | `tests/context.test.ts` | Available Skills 区段测试 |
| 修改 | `tests/tui-reducer.test.ts` | ACTIVATE_SKILL/DEACTIVATE_SKILL/LIST_SKILLS/SET_SKILL_MANIFESTS |
| 修改 | `tests/cli.test.ts` | --skill 参数解析测试 |

---

### Task 1: 类型定义 + 路径工具

**Files:**
- Create: `src/core/skills/types.ts`
- Create: `src/core/skills/index.ts`（初始导出）
- Modify: `src/core/config/paths.ts`

- [ ] **Step 1: 创建 types.ts**

```typescript
// src/core/skills/types.ts

export interface SkillManifest {
  name: string;          // frontmatter name, unique identifier
  description: string;   // frontmatter description
  source: "project" | "user";
  origin: ".openpx" | ".agents";
}

export interface ValidatedSkill {
  name: string;
  description: string;
  content: string;       // SKILL.md body without frontmatter
}

export interface SkillScanOptions {
  userOpenpxSkillsDir: string;
  userAgentsSkillsDir: string;
  projectOpenpxSkillsDir: string;
  projectAgentsSkillsDir: string;
}
```

- [ ] **Step 2: 创建 index.ts**

```typescript
// src/core/skills/index.ts

export type { SkillManifest, ValidatedSkill, SkillScanOptions } from "./types";
```

- [ ] **Step 3: paths.ts 新增 skillDirs()**

在 `src/core/config/paths.ts` 末尾新增。`homedir` 已在文件顶部从 `node:os` 导入。

```typescript
import type { SkillScanOptions } from "@/core/skills/types";

export function skillDirs(workspace: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(workspace, ".openpx", "skills"),
    projectAgentsSkillsDir: join(workspace, ".agents", "skills"),
    userOpenpxSkillsDir: join(OPENPX_DIR, "skills"),
    userAgentsSkillsDir: join(homedir(), ".agents", "skills"),
  };
}
```

- [ ] **Step 4: 运行 typecheck**

```bash
bun run typecheck
```
Expected: 无新增错误。

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/types.ts src/core/skills/index.ts src/core/config/paths.ts
git commit -m "feat: skills 类型定义 + skillDirs 路径工具"
```

---

### Task 2: Loader — 扫描、解析、校验、去重覆盖、按需读取

**Files:**
- Create: `src/core/skills/loader.ts`
- Create: `tests/skills/loader.test.ts`
- Modify: `src/core/skills/index.ts`

- [ ] **Step 1: 创建 loader.ts**

```typescript
// src/core/skills/loader.ts

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillManifest, ValidatedSkill, SkillScanOptions } from "./types";

/** Parse YAML frontmatter from SKILL.md content */
function parseFrontmatter(
  content: string,
): { fields: Record<string, string>; body: string } | null {
  if (!content.startsWith("---")) return null;
  const afterStart = content.slice(3);
  const nextNewline = afterStart.indexOf("\n");
  if (nextNewline === -1) return null;
  const fmStart = nextNewline + 1;

  const endMatch = afterStart.slice(fmStart).match(/\n---(\n|$)/);
  if (!endMatch || endMatch.index === undefined) return null;

  const fmText = afterStart.slice(fmStart, fmStart + endMatch.index);
  const bodyStart = fmStart + endMatch.index + endMatch[0].length;
  const body = afterStart.slice(bodyStart);

  const fields: Record<string, string> = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      // Nested block (e.g. metadata:) → skip indented continuation lines
      if (value === "" || value === "|" || value === ">") {
        i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          i++;
        }
        continue;
      }
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fields[key] = value;
    }
    i++;
  }

  return { fields, body };
}

const VALID_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function scanDir(
  dirPath: string,
  source: "project" | "user",
  origin: ".openpx" | ".agents",
): SkillManifest[] {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) return [];

  const manifests: SkillManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return [];
  }

  for (const entry of entries) {
    try {
      const entryPath = join(resolved, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      const skillMdPath = join(entryPath, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const raw = readFileSync(skillMdPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const { fields } = parsed;
      const name = fields.name;
      const description = fields.description;

      if (!name || !VALID_SKILL_NAME.test(name)) continue;
      if (name !== entry) continue;
      if (!description) continue;

      manifests.push({ name, description, source, origin });
    } catch {
      // Skip individual broken skill directories silently
    }
  }

  return manifests;
}

/** Scan all 4 skill directories, return deduplicated manifest list (higher priority wins) */
export function scanSkills(options: SkillScanOptions): SkillManifest[] {
  const all: SkillManifest[] = [];

  // Priority order: project .openpx > project .agents > user .openpx > user .agents
  all.push(...scanDir(options.projectOpenpxSkillsDir, "project", ".openpx"));
  all.push(...scanDir(options.projectAgentsSkillsDir, "project", ".agents"));
  all.push(...scanDir(options.userOpenpxSkillsDir, "user", ".openpx"));
  all.push(...scanDir(options.userAgentsSkillsDir, "user", ".agents"));

  // Dedup: first occurrence wins (highest priority)
  const seen = new Set<string>();
  const deduped: SkillManifest[] = [];
  for (const m of all) {
    if (!seen.has(m.name)) {
      seen.add(m.name);
      deduped.push(m);
    }
  }
  return deduped;
}

/** Read full skill content by name (hot-reload: reads from disk every call) */
export function getSkillContent(
  manifests: SkillManifest[],
  name: string,
  options: SkillScanOptions,
): ValidatedSkill | null {
  const manifest = manifests.find((m) => m.name === name);
  if (!manifest) return null;

  const dirKey = manifest.source === "project"
    ? (manifest.origin === ".openpx" ? "projectOpenpxSkillsDir" : "projectAgentsSkillsDir")
    : (manifest.origin === ".openpx" ? "userOpenpxSkillsDir" : "userAgentsSkillsDir");
  const skillMdPath = join(options[dirKey], manifest.name, "SKILL.md");

  try {
    if (!existsSync(skillMdPath)) return null;
    const raw = readFileSync(skillMdPath, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    let body = parsed.body.trimStart();
    // Truncate bodies over 100KB
    if (body.length > 100 * 1024) {
      body = body.slice(0, 100 * 1024);
    }

    return {
      name: manifest.name,
      description: manifest.description,
      content: body,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 写测试 — tests/skills/loader.test.ts**

```typescript
// tests/skills/loader.test.ts

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills, getSkillContent } from "../../src/core/skills/loader";
import type { SkillScanOptions } from "../../src/core/skills/types";

function makeOptions(base: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(base, "project-openpx"),
    projectAgentsSkillsDir: join(base, "project-agents"),
    userOpenpxSkillsDir: join(base, "user-openpx"),
    userAgentsSkillsDir: join(base, "user-agents"),
  };
}

function writeSkill(baseDir: string, name: string, fm: Record<string, string>, body = "Skill body content.") {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fmLines}\n---\n\n${body}`);
}

describe("scanSkills", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when no dirs exist", () => {
    expect(scanSkills(makeOptions(join(tmp, "nope")))).toEqual([]);
  });

  it("scans a single dir and returns valid skills", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userOpenpxSkillsDir, "my-skill", { name: "my-skill", description: "A test skill" });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0].name).toBe("my-skill");
    expect(ms[0].source).toBe("user");
    expect(ms[0].origin).toBe(".openpx");
  });

  it("skips dir without SKILL.md", () => {
    const opts = makeOptions(tmp);
    mkdirSync(join(opts.userOpenpxSkillsDir, "empty-skill"), { recursive: true });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips skill with missing name", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "bad-skill", { description: "No name" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips skill with missing description", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "no-desc", { name: "no-desc" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips skill with uppercase name", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "Bad-Name", { name: "Bad-Name", description: "Uppercase invalid" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips skill where name != directory name", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "my-skill", { name: "other-name", description: "Mismatch" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips name starting with hyphen", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "-bad", { name: "-bad", description: "Starts with hyphen" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("skips name with consecutive hyphens", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "bad--skill", { name: "bad--skill", description: "Consecutive hyphens" });
    expect(scanSkills(opts)).toEqual([]);
  });

  it("deduplicates: project .openpx overrides user .openpx", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userOpenpxSkillsDir, "shared", { name: "shared", description: "User" });
    writeSkill(opts.projectOpenpxSkillsDir, "shared", { name: "shared", description: "Project" });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0].description).toBe("Project");
    expect(ms[0].source).toBe("project");
  });

  it("deduplicates: project .openpx overrides project .agents", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectAgentsSkillsDir, "shared", { name: "shared", description: ".agents" });
    writeSkill(opts.projectOpenpxSkillsDir, "shared", { name: "shared", description: ".openpx" });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0].description).toBe(".openpx");
  });

  it("sorts by priority: high to low", () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userAgentsSkillsDir, "low", { name: "low", description: "Lowest" });
    writeSkill(opts.projectOpenpxSkillsDir, "high", { name: "high", description: "Highest" });
    const ms = scanSkills(opts);
    expect(ms[0].name).toBe("high");
    expect(ms[1].name).toBe("low");
  });

  it("handles frontmatter with metadata block (nested YAML)", () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, "meta-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---
name: meta-skill
description: Has metadata
metadata:
  author: test
  version: "1.0"
---

Body here.`);
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0].name).toBe("meta-skill");
  });

  it("handles empty body", () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, "empty-body");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: empty-body\ndescription: No content\n---\n");
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
  });
});

describe("getSkillContent", () => {
  let tmp: string;
  let opts: SkillScanOptions;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, "tdd", { name: "tdd", description: "Write tests first" }, "Step 1: Red.\nStep 2: Green.");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns full content by name", () => {
    const ms = scanSkills(opts);
    const result = getSkillContent(ms, "tdd", opts);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("tdd");
    expect(result!.content).toContain("Step 1: Red.");
  });

  it("returns null for unknown name", () => {
    expect(getSkillContent(scanSkills(opts), "nope", opts)).toBeNull();
  });

  it("returns null for empty manifests", () => {
    expect(getSkillContent([], "anything", opts)).toBeNull();
  });

  it("hot-reloads: picks up file changes", () => {
    const ms = scanSkills(opts);
    expect(getSkillContent(ms, "tdd", opts)!.content).toContain("Step 1:");

    const p = join(opts.projectOpenpxSkillsDir, "tdd", "SKILL.md");
    writeFileSync(p, "---\nname: tdd\ndescription: Updated\n---\nUpdated content.");
    expect(getSkillContent(ms, "tdd", opts)!.content).toBe("Updated content.");
  });

  it("truncates body over 100KB", () => {
    const bigBody = "x".repeat(101_000);
    writeSkill(opts.projectOpenpxSkillsDir, "big", { name: "big", description: "Big skill" }, bigBody);
    const ms = scanSkills(opts);
    const result = getSkillContent(ms, "big", opts);
    expect(result).not.toBeNull();
    expect(result!.content.length).toBeLessThanOrEqual(100 * 1024);
  });

  it("returns null when SKILL.md deleted after scan", () => {
    const ms = scanSkills(opts);
    rmSync(join(opts.projectOpenpxSkillsDir, "tdd"), { recursive: true, force: true });
    expect(getSkillContent(ms, "tdd", opts)).toBeNull();
  });
});
```

- [ ] **Step 3: 更新 index.ts**

```typescript
// src/core/skills/index.ts

export type { SkillManifest, ValidatedSkill, SkillScanOptions } from "./types";
export { scanSkills, getSkillContent } from "./loader";
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/skills/loader.test.ts
```
Expected: ~20 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/loader.ts src/core/skills/index.ts tests/skills/loader.test.ts
git commit -m "feat: skills loader — YAML frontmatter 解析 + 4 目录扫描 + 去重覆盖 + 热加载"
```

---

### Task 3: Skill 工具 — skill-tool.ts

**Files:**
- Create: `src/core/skills/skill-tool.ts`
- Create: `tests/skills/skill-tool.test.ts`
- Modify: `src/core/skills/index.ts`

- [ ] **Step 1: 创建 skill-tool.ts**

```typescript
// src/core/skills/skill-tool.ts

import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { SkillManifest, SkillScanOptions } from "./types";
import { getSkillContent } from "./loader";

export function createSkillTool(manifests: SkillManifest[], options: SkillScanOptions) {
  return tool(
    async ({ skill }: { skill: string }) => {
      const result = getSkillContent(manifests, skill, options);
      if (!result) {
        return JSON.stringify({ ok: false, error: `Skill not found: ${skill}` });
      }
      return JSON.stringify({ ok: true, name: result.name, content: result.content });
    },
    {
      name: "Skill",
      description:
        "Invoke a skill to get specialized instructions when its description matches your task. " +
        "Available skills are listed in the system prompt. " +
        "Invoking a skill loads detailed instructions you MUST follow.",
      schema: z.object({
        skill: z.string().describe("Name of the skill to invoke"),
      }),
    },
  );
}
```

- [ ] **Step 2: 写测试 — tests/skills/skill-tool.test.ts**

```typescript
// tests/skills/skill-tool.test.ts

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills } from "../../src/core/skills/loader";
import { createSkillTool } from "../../src/core/skills/skill-tool";
import type { SkillScanOptions } from "../../src/core/skills/types";

function makeOptions(base: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(base, "project-openpx"),
    projectAgentsSkillsDir: join(base, "project-agents"),
    userOpenpxSkillsDir: join(base, "user-openpx"),
    userAgentsSkillsDir: join(base, "user-agents"),
  };
}

describe("createSkillTool", () => {
  let tmp: string;
  let opts: SkillScanOptions;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, "tdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---
name: tdd
description: Use when writing tests before implementation
---

Always write tests first. Follow red-green-refactor.`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns skill content when skill exists", async () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    const result = await skillTool.invoke({ skill: "tdd" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe("tdd");
    expect(parsed.content).toContain("Always write tests first.");
  });

  it("returns error when skill not found", async () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    const result = await skillTool.invoke({ skill: "nope" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Skill not found");
  });

  it("has correct name and description", () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    expect(skillTool.name).toBe("Skill");
    expect(skillTool.description).toContain("Invoke a skill");
  });

  it("works with empty manifests", async () => {
    const skillTool = createSkillTool([], opts);
    const result = await skillTool.invoke({ skill: "anything" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
  });
});
```

- [ ] **Step 3: 更新 index.ts 导出**

```typescript
// src/core/skills/index.ts

export type { SkillManifest, ValidatedSkill, SkillScanOptions } from "./types";
export { scanSkills, getSkillContent } from "./loader";
export { createSkillTool } from "./skill-tool";
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/skills/skill-tool.test.ts
```
Expected: ~4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/skill-tool.ts src/core/skills/index.ts tests/skills/skill-tool.test.ts
git commit -m "feat: Skill 工具定义 — createSkillTool, LangChain StructuredTool"
```

---

### Task 4: 工具体系集成 — definitions.ts + tool-policy.ts

**Files:**
- Modify: `src/core/tools/definitions.ts`
- Modify: `src/core/harness/tool-policy.ts`
- Modify: `tests/tool-policy.test.ts`

- [ ] **Step 1: definitions.ts — 扩展 CreateAgentToolsInput + 新增 Skill 到 builtinTools**

在 `CreateAgentToolsInput` interface（约第 22-29 行）中新增两个字段：

```typescript
export interface CreateAgentToolsInput {
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: import("@/core/mcp/manager").McpManager;
  skills?: import("@/core/skills/types").SkillManifest[];
  skillOptions?: import("@/core/skills/types").SkillScanOptions;
}
```

在文件顶部 import 区添加：

```typescript
import { createSkillTool } from "@/core/skills/skill-tool";
```

在 `createAgentTools` 函数体内部，`builtinTools` 数组上一行（约第 143 行附近）新增：

```typescript
  let skillTool: ReturnType<typeof createSkillTool> | null = null;
  if (input.skills && input.skills.length > 0 && input.skillOptions) {
    skillTool = createSkillTool(input.skills, input.skillOptions);
  }

  const builtinTools = [
    readFileTool,
    editFileTool,
    writeFileTool,
    shellExecute,
    readMcpResource,
    ...(skillTool ? [skillTool] : []),
    createUpdatePlanTool(),
    createAskUserTool(),
    createSetAuthorizationModeTool(),
  ];
```

- [ ] **Step 2: tool-policy.ts — Skill 工具 risk: "read"**

在 `evaluateToolPolicy` 函数内，`read_file` case 之后（约第 203 行后）新增：

```typescript
  if (request.name === "Skill") {
    return allow({
      risk: "read",
      reason: "Skill invocation loads read-only instructions into conversation context.",
      userVisibleSummary: `Load skill: ${request.args.skill ?? "?"}`,
      expectedEffects: ["Loads skill instructions into conversation context", "No side effects"],
    });
  }
```

- [ ] **Step 3: 更新 tests/tool-policy.test.ts**

在现有 `read_mcp_resource` 测试附近新增：

```typescript
  it("allows Skill without approval", () => {
    const decision = evaluateToolPolicy({
      request: { name: "Skill", args: { skill: "tdd" }, protectedCommand: "" },
      workspaceAccess: "write",
      phase: "building",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe("read");
  });
```

- [ ] **Step 4: 运行 typecheck + 测试**

```bash
bun run typecheck
bun test tests/tool-policy.test.ts tests/tool-definitions.test.ts
```
Expected: typecheck 无新增错误，所有测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/definitions.ts src/core/harness/tool-policy.ts tests/tool-policy.test.ts
git commit -m "feat: 工具体系集成 Skill — definitions 注册 + tool-policy risk:read"
```

---

### Task 5: System Prompt — Available Skills 区段

**Files:**
- Modify: `src/core/model/context.ts`
- Modify: `tests/context.test.ts`

- [ ] **Step 1: context.ts — buildStaticSystemPrompt 新增 skills 参数**

修改 `buildStaticSystemPrompt` 签名和实现（约第 124 行）：

```typescript
import type { SkillManifest } from "@/core/skills/types";

export function buildStaticSystemPrompt(
  _role: AgentRole,
  skills?: SkillManifest[],
): string {
  const base = systemPrompt;
  if (!skills || skills.length === 0) return base;

  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  const section = [
    "",
    "## Available Skills",
    "",
    "The following skills are available. Use the `Skill` tool to invoke a skill when its",
    "description matches your task. Invoking a skill loads detailed instructions you MUST follow.",
    "",
    ...lines,
    "",
    "IMPORTANT: If there is even a 1% chance a skill might apply, invoke it.",
  ].join("\n");

  return base + section;
}
```

- [ ] **Step 2: 更新 prepareModelContext 调用点**

在 `prepareModelContext` 函数内（约第 58 行），`buildStaticSystemPrompt` 的调用处：

检查是否已有调用 `buildStaticSystemPrompt(role)` — 如果有，不变（第二个参数可选）。后续在 graph.ts 中会将 skills 传给 context builder。这步无需改动，因为 `buildStaticSystemPrompt` 的第二个参数是可选的。

- [ ] **Step 3: 更新 tests/context.test.ts**

在文件末尾新增：

```typescript
import type { SkillManifest } from "../src/core/skills/types";

describe("buildStaticSystemPrompt with skills", () => {
  it("includes Available Skills section when skills provided", () => {
    const skills: SkillManifest[] = [
      { name: "tdd", description: "Use when writing tests", source: "project", origin: ".openpx" },
      { name: "debugging", description: "Use when debugging", source: "user", origin: ".agents" },
    ];
    const prompt = buildStaticSystemPrompt("agent", skills);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("- tdd: Use when writing tests");
    expect(prompt).toContain("- debugging: Use when debugging");
    expect(prompt).toContain("`Skill`");
  });

  it("does not include section when skills empty", () => {
    const prompt = buildStaticSystemPrompt("agent", []);
    expect(prompt).not.toContain("## Available Skills");
  });

  it("does not include section when skills undefined (backwards compat)", () => {
    const prompt = buildStaticSystemPrompt("agent");
    expect(prompt).not.toContain("## Available Skills");
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/context.test.ts
```
Expected: 全部 PASS（含新增测试）

- [ ] **Step 5: Commit**

```bash
git add src/core/model/context.ts tests/context.test.ts
git commit -m "feat: system prompt 追加 Available Skills 区段"
```

---

### Task 6: Runner + Graph — skills/skillOptions 传递链路

**Files:**
- Modify: `src/core/runner.ts`
- Modify: `src/core/harness/graph.ts`

- [ ] **Step 1: runner.ts — RunAgentInput 新增字段，传入 buildCodeAgentGraph**

在 `RunAgentInput` interface（约第 36-55 行）中新增：

```typescript
export interface RunAgentInput {
  // ... 现有字段保持不变 ...
  skills?: import("@/core/skills/types").SkillManifest[];
  skillOptions?: import("@/core/skills/types").SkillScanOptions;
}
```

在 `runAgent` 函数中 `buildCodeAgentGraph()` 调用处（约第 120 行）加入新参数：

```typescript
    const { graph, checkpointer } = buildCodeAgentGraph({
      config: input.config,
      checkpointPath: input.checkpointPath,
      shellExecutor: input.shellExecutor,
      authorizationOverride: input.authorizationOverride,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      skills: input.skills,
      skillOptions: input.skillOptions,
    });
```

同理更新 `revertToCheckpoint` 和 `forkFromCheckpoint` 中 `buildCodeAgentGraph` 调用，加入 `skills` 和 `skillOptions`（值从 input 传入，设为 `undefined` 即可，rewind 不需要带 skill）。

- [ ] **Step 2: graph.ts — BuildCodeAgentGraphInput 新增字段，传入 createAgentTools**

在 `BuildCodeAgentGraphInput` interface（约第 54-69 行）中新增：

```typescript
export interface BuildCodeAgentGraphInput {
  // ... 现有字段保持不变 ...
  skills?: import("@/core/skills/types").SkillManifest[];
  skillOptions?: import("@/core/skills/types").SkillScanOptions;
}
```

在 `agent` 节点中 `createAgentTools()` 调用处（约第 89-93 行）加入新参数：

```typescript
        const tools = createAgentTools({
          workspace: state.workspace,
          shellExecutor: input.shellExecutor,
          mcpManager: input.mcpManager,
          skills: input.skills,
          skillOptions: input.skillOptions,
        });
```

- [ ] **Step 3: 运行 typecheck + 测试**

```bash
bun run typecheck
bun test tests/runner.test.ts tests/graph.test.ts
```
Expected: typecheck 无新增错误，所有现有测试 PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/runner.ts src/core/harness/graph.ts
git commit -m "feat: runner + graph 传递 skills/skillOptions，打通 core 层链路"
```

---

### Task 7: TUI State + Reducer — Skills Actions

**Files:**
- Modify: `src/app/tui/types.ts`
- Modify: `src/app/tui/App.tsx`
- Modify: `tests/tui-reducer.test.ts`

- [ ] **Step 1: types.ts — TuiState 新增字段**

在 `TuiState` interface 的 `rewindCounter` 之后（约第 37 行）新增：

```typescript
  pendingSkills: string[];
  skillManifests: import("@/core/skills/types").SkillManifest[];
```

- [ ] **Step 2: App.tsx — initial state 默认值**

在 `initialState` 对象中（约第 560 行 `sessionError: false` 之后）新增：

```typescript
  pendingSkills: [],
  skillManifests: [],
```

- [ ] **Step 3: App.tsx — Action union 新增 4 个 action**

在 `Action` 联合类型中，`SET_CHECKPOINTS` 之后新增：

```typescript
  | { type: "ACTIVATE_SKILL"; name: string; content: string }
  | { type: "DEACTIVATE_SKILL"; name: string }
  | { type: "LIST_SKILLS" }
  | { type: "SET_SKILL_MANIFESTS"; manifests: import("@/core/skills/types").SkillManifest[] }
```

- [ ] **Step 4: App.tsx — Reducer 新增 4 个 case**

在 reducer 函数中，`case "SET_CHECKPOINTS":` 之后新增：

```typescript
    case "SET_SKILL_MANIFESTS":
      return { ...state, skillManifests: action.manifests };
    case "ACTIVATE_SKILL": {
      const content = `[SKILL: ${action.name}]\n\n${action.content}\n\n---\n\n`;
      return { ...state, pendingSkills: [...state.pendingSkills, content] };
    }
    case "DEACTIVATE_SKILL":
      return { ...state, pendingSkills: [] };
    case "LIST_SKILLS": {
      if (state.skillManifests.length === 0) {
        return {
          ...state,
          blocks: [...state.blocks, {
            id: Date.now(),
            kind: "text" as const,
            content: "No skills available.",
          }],
        };
      }
      const lines = state.skillManifests.map(
        (s) => `- **${s.name}**: ${s.description} (${s.source}/${s.origin})`,
      );
      return {
        ...state,
        blocks: [...state.blocks, {
          id: Date.now(),
          kind: "text" as const,
          content: "## Available Skills\n\n" + lines.join("\n"),
        }],
      };
    }
```

- [ ] **Step 5: tests/tui-reducer.test.ts — 新增测试**

在文件末尾新增：

```typescript
describe("ACTIVATE_SKILL", () => {
  it("adds skill content to pendingSkills", () => {
    const state = createInitialState();
    const next = eventReducer(state, { type: "ACTIVATE_SKILL", name: "tdd", content: "Always test first." });
    expect(next.pendingSkills).toHaveLength(1);
    expect(next.pendingSkills[0]).toContain("[SKILL: tdd]");
    expect(next.pendingSkills[0]).toContain("Always test first.");
  });

  it("appends multiple skills in activation order", () => {
    const state = createInitialState();
    const s1 = eventReducer(state, { type: "ACTIVATE_SKILL", name: "a", content: "A" });
    const s2 = eventReducer(s1, { type: "ACTIVATE_SKILL", name: "b", content: "B" });
    expect(s2.pendingSkills).toHaveLength(2);
    expect(s2.pendingSkills[0]).toContain("[SKILL: a]");
    expect(s2.pendingSkills[1]).toContain("[SKILL: b]");
  });
});

describe("DEACTIVATE_SKILL", () => {
  it("clears pendingSkills", () => {
    const state = createInitialState();
    const withSkills = eventReducer(state, { type: "ACTIVATE_SKILL", name: "tdd", content: "test" });
    const cleared = eventReducer(withSkills, { type: "DEACTIVATE_SKILL", name: "tdd" });
    expect(cleared.pendingSkills).toEqual([]);
  });
});

describe("LIST_SKILLS", () => {
  it("adds text block listing all skills", () => {
    const state: TuiState = {
      ...createInitialState(),
      skillManifests: [
        { name: "tdd", description: "Write tests", source: "project", origin: ".openpx" },
      ],
    };
    const next = eventReducer(state, { type: "LIST_SKILLS" });
    const last = next.blocks[next.blocks.length - 1];
    expect(last.kind).toBe("text");
    if (last.kind === "text") expect(last.content).toContain("tdd");
  });

  it("shows no-skills message when manifests empty", () => {
    const state = createInitialState();
    const next = eventReducer(state, { type: "LIST_SKILLS" });
    const last = next.blocks[next.blocks.length - 1];
    expect(last.kind).toBe("text");
    if (last.kind === "text") expect(last.content).toContain("No skills available");
  });
});

describe("SET_SKILL_MANIFESTS", () => {
  it("sets skillManifests in state", () => {
    const state = createInitialState();
    const manifests = [
      { name: "tdd", description: "Write tests", source: "project" as const, origin: ".openpx" as const },
    ];
    const next = eventReducer(state, { type: "SET_SKILL_MANIFESTS", manifests });
    expect(next.skillManifests).toEqual(manifests);
  });
});
```

- [ ] **Step 6: 运行测试**

```bash
bun test tests/tui-reducer.test.ts
```
Expected: 所有测试 PASS（含新增 ~8 tests）

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/types.ts src/app/tui/App.tsx tests/tui-reducer.test.ts
git commit -m "feat: TUI Skills actions — ACTIVATE/DEACTIVATE/LIST_SKILLS + SET_SKILL_MANIFESTS"
```

---

### Task 8: TUI 斜杠命令 + 补全 — /skill-name 集成

**Files:**
- Modify: `src/app/tui/hooks/useSlashCommand.ts`
- Modify: `src/app/tui/hooks/useSlashSuggestions.ts`
- Modify: `tests/tui-layout.test.tsx`

- [ ] **Step 1: useSlashCommand.ts — 新增 skills 参数 + skill 匹配逻辑**

在 `useSlashCommand` 函数签名中新增参数。修改签名（约第 48-53 行）：

```typescript
import { getSkillContent } from "@/core/skills/loader";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";

export function useSlashCommand(
  dispatch: Dispatch<any>,
  onExit?: () => void,
  onCompactRequest?: () => void,
  mcpPromptRegistry?: ReadonlyMap<string, { server: string; prompt: { name: string; description?: string; arguments?: any[] } }>,
  skillManifests?: SkillManifest[],
  skillOptions?: SkillScanOptions,
  onRunTask?: (task: string) => void,
) {
```

在 `useCallback` 的 deps 数组中加入 `skillManifests, skillOptions, onRunTask`（约第 128 行）。

在 `default` case 中（约第 114-125 行），MCP prompt 检查之后（`return false` 之前），新增 skill 检查：

```typescript
        // Check skills
        const raw = action.raw;
        if (action.type === "unknown" && skillManifests && skillOptions) {
          const parts = raw.slice(1).trim().split(/\s+/);
          const skillName = parts[0];
          const matched = skillManifests.find((s) => s.name === skillName);
          if (matched) {
            const skillResult = getSkillContent(skillManifests, skillName, skillOptions);
            if (skillResult) {
              const taskPart = parts.slice(1).join(" ");
              dispatch({ type: "ACTIVATE_SKILL", name: skillResult.name, content: skillResult.content });
              if (taskPart && onRunTask) {
                const combined = skillResult.content + "\n\n---\n\nUser task: " + taskPart;
                onRunTask(combined);
              }
            }
            return true;
          }
        }
        return false;
```

- [ ] **Step 2: useSlashSuggestions.ts — 补全追加 skill 名称**

修改 `useSlashSuggestions` 签名接受 skills 列表：

```typescript
export function useSlashSuggestions(
  inputValue: string,
  skillManifests?: import("@/core/skills/types").SkillManifest[],
) {
```

在 `useMemo` 中（约第 43 行），`SLASH_COMMAND_DEFS` filter 之后，追加 skill 匹配：

```typescript
    // Also check skill manifests
    if (skillManifests && skillManifests.length > 0) {
      const skillMatches = skillManifests
        .filter((s) => s.name.startsWith(partial))
        .map((s) => ({
          command: s.name,
          aliases: [] as string[],
          description: s.description,
        }));

      if (skillMatches.length > 0) {
        commands.push(...skillMatches);
      }
    }
```

放在 `commands` 过滤逻辑之后（约第 63 行后），`if (commands.length === 0) return null;` 之前。

- [ ] **Step 3: 验证 — typecheck + e2e**

```bash
bun run typecheck
bun test tests/e2e/
```
Expected: typecheck 无新增错误，e2e 测试 PASS。`useSlashSuggestions` 的参数变更由 typecheck 验证；slash 补全的 skill 集成通过 e2e 覆盖。

- [ ] **Step 4: 运行 typecheck**

```bash
bun run typecheck
```
Expected: 无新增错误（注意 `useSlashCommand` 调用点尚未传入新参数，需在 Task 9 中接线）

- [ ] **Step 5: Commit**

```bash
git add src/app/tui/hooks/useSlashCommand.ts src/app/tui/hooks/useSlashSuggestions.ts
git commit -m "feat: slash commands 识别 /skill-name + 补全追加 skill 列表"
```

---

### Task 9: TUI 启动集成 — index.tsx 接线

**Files:**
- Modify: `src/app/tui/index.tsx`

- [ ] **Step 1: 新增 import**

在文件顶部 import 区新增：

```typescript
import { scanSkills, getSkillContent } from "@/core/skills/loader";
import { skillDirs } from "@/core/config/paths";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
```

- [ ] **Step 2: 新增 skills ref + useEffect 初始化**

在 `TuiBootstrap` 函数中（约第 40 行，`mcpManagerRef` 之后）新增 refs：

```typescript
  const skillManifestsRef = React.useRef<SkillManifest[]>([]);
  const skillOptionsRef = React.useRef<SkillScanOptions | null>(null);
```

在 MCP manager lifecycle `useEffect`（约第 174 行 `}, []);`）之后新增 Skills 扫描逻辑：

```typescript
  // Skills loader: scan on mount
  React.useEffect(() => {
    const opts = skillDirs(workspace);
    skillOptionsRef.current = opts;
    const manifests = scanSkills(opts);
    skillManifestsRef.current = manifests;
    dispatch({ type: "SET_SKILL_MANIFESTS", manifests });
  }, [workspace, dispatch]);
```

- [ ] **Step 3: 更新 useSlashCommand 调用（约第 215-220 行）**

```typescript
  const handleSlashCommand = useSlashCommand(
    dispatch,
    handleExit,
    () => { provider.compactRequested = true; },
    mcpPromptRegistry,
    skillManifestsRef.current,
    skillOptionsRef.current ?? undefined,
    runTask,
  );
```

- [ ] **Step 4: 更新 runTask — 注入 pendingSkills + 传递 skills 到 runner**

在 `runTask` 中（约第 231 行），构造 `fullTask` 处（约第 249 行）：

```typescript
      // Prepend any activated skills
      let pendingSkillsContent = "";
      if (state.pendingSkills && state.pendingSkills.length > 0) {
        pendingSkillsContent = state.pendingSkills.join("");
        dispatch({ type: "DEACTIVATE_SKILL", name: "" }); // clear after injection
      }
      
      const shellContext = conversationHistoryRef.current.length > 0
        ? "\n" + conversationHistoryRef.current.join("\n")
        : "";
      const fullTask = pendingSkillsContent + task + shellContext;
```

在 `runAgent` 调用处（约第 257 行）新增 `skills` 和 `skillOptions`：

```typescript
      const generator = runAgent(provider, {
        task: fullTask,
        userId: "tui-user",
        threadId: threadIdRef.current,
        workspace,
        checkpointPath: defaultCheckpointPath(),
        config,
        shellExecutor,
        signal: abortController.signal,
        thinkingLevel: thinkingLevelRef.current,
        skills: skillManifestsRef.current,
        skillOptions: skillOptionsRef.current ?? undefined,
      });
```

- [ ] **Step 5: 运行 typecheck**

```bash
bun run typecheck
```
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/index.tsx
git commit -m "feat: TUI 启动集成 Skills — 扫描 + useSlashCommand 接线 + runner 传递"
```

---

### Task 10: CLI — --skill 参数支持

**Files:**
- Modify: `src/app/cli/index.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: cli/index.ts — ParsedArgs 新增 skills 字段**

在 `ParsedArgs` interface（约第 10-25 行）中新增：

```typescript
  skills: string[];
```

初始值（约第 118 行 `command: "help"` 之后）：

```typescript
    skills: [],
```

在 `parseArgs` 函数中新增参数解析（约第 140 行 `--task` 解析之后）：

```typescript
    skills: multi("--skill"),
```

需要新增 `multi` helper 或直接在现有模式中追加。查看 `parseArgs` 中是否已有 `multi` 函数 — 如果没有，添加：

```typescript
    const multi = (flag: string): string[] => {
      const values: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === flag && i + 1 < args.length) {
          values.push(args[i + 1]);
          i++;
        }
      }
      return values;
    };
```

- [ ] **Step 2: cli/index.ts — 注入 skill content 到 task**

在 runner 调用处（找到 `runAgent` 的调用），初始化 task 前拼接 skill 内容：

```typescript
    // Load skill contents and prepend to task
    if (parsed.skills.length > 0) {
      const opts = skillDirs(parsed.workspace);
      const manifests = scanSkills(opts);
      const skillContents: string[] = [];
      for (const name of parsed.skills) {
        const result = getSkillContent(manifests, name, opts);
        if (result) {
          skillContents.push(`[SKILL: ${result.name}]\n\n${result.content}\n\n---\n\n`);
        }
      }
      task = skillContents.join("") + task;
    }
```

同时将 `skills` 和 `skillOptions` 传入 `runAgent` 调用。

需要在文件顶部新增 import：

```typescript
import { scanSkills, getSkillContent } from "@/core/skills/loader";
import { skillDirs } from "@/core/config/paths";
```

- [ ] **Step 3: tests/cli.test.ts — 新增 --skill 参数测试**

在现有 `parseArgs` 测试区域新增：

```typescript
  it("parses --skill flag", () => {
    const result = parseArgs(["run", "--task", "fix", "--skill", "tdd"]);
    expect(result.skills).toContain("tdd");
  });

  it("parses multiple --skill flags", () => {
    const result = parseArgs(["run", "--task", "fix", "--skill", "tdd", "--skill", "debugging"]);
    expect(result.skills).toEqual(["tdd", "debugging"]);
  });

  it("defaults skills to empty array", () => {
    const result = parseArgs(["run", "--task", "fix"]);
    expect(result.skills).toEqual([]);
  });
```

- [ ] **Step 4: 运行 typecheck + 测试**

```bash
bun run typecheck
bun test tests/cli.test.ts
```
Expected: typecheck 无新增错误，测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/cli/index.ts tests/cli.test.ts
git commit -m "feat: CLI --skill 多值参数 + skills 内容注入 task 前缀"
```

---

### Task 11: 端到端验证

- [ ] **Step 1: 类型检查**

```bash
bun run typecheck
```
Expected: 无新增错误。

- [ ] **Step 2: Skills 单元测试**

```bash
bun test tests/skills/
```
Expected: ~24 tests PASS

- [ ] **Step 3: 受影响模块测试**

```bash
bun test tests/tool-policy.test.ts tests/tool-definitions.test.ts tests/context.test.ts tests/tui-reducer.test.ts tests/cli.test.ts
```
Expected: 全部 PASS

- [ ] **Step 4: 核心测试套件**

```bash
bun test tests/graph.test.ts tests/runner.test.ts tests/integration.test.ts
```
Expected: 全部 PASS（无回归）

- [ ] **Step 5: 全量测试**

```bash
bun test
```
Expected: 与 Phase 2 完成时持平或改善。

- [ ] **Step 6: 更新 plan status + commit**

```bash
git add docs/space/
git commit -m "docs: Phase 3 (Skills) 实施计划完成，更新 plan 状态"
```

---

## 依赖关系

```
Task 1 (types+paths) ──→ Task 2 (loader) ──→ Task 3 (skill-tool)
                                                  │
                    ┌─────────────────────────────┘
                    ↓
              Task 4 (tool integration: definitions + tool-policy)
              Task 5 (system prompt)
              Task 6 (runner + graph)

Task 7 (TUI state+reducer) ──→ Task 8 (slash commands) ──→ Task 9 (startup wiring)
Task 6 ──→ Task 9
Task 1 ──→ Task 10 (CLI)

Task 4,5,6,7,8,9,10 ──→ Task 11 (verification)
```

Tasks 2+3 不可并行（3 依赖 2）。Tasks 4,5,6 可并行。Tasks 7→8→9 串行。Task 10 可并行于 7-9。
