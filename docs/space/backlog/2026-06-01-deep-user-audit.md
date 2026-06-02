# 深度用户审查：代码与设计债务

日期：2026-06-01
来源：对 PRODUCT.md、ROADMAP.md、`src/` 核心代码的逐层审查

---

## B14 — `apply_patch` 死代码：契约存在但工具未注册

- **位置**：
  - `src/core/tools/tool-contracts.ts` — `APPLY_PATCH_CONTRACT` 已定义
  - `src/core/tools/apply-patch.ts` — 解析和应用逻辑已实现
  - `src/core/tools/definitions.ts` — `createAgentTools()` 未创建该工具
  - `src/core/prompts/system-prompt.txt` — 未提及
- **影响**：`KNOWN_TOOL_NAMES` 和 `TOOL_CONTRACTS` Map 中包含它，但 agent 实际拿不到。代码和文档不一致。
- **建议**：要么在 `createAgentTools` 中注册并在 system prompt 添加使用说明；要么从 `KNOWN_TOOL_NAMES`/`TOOL_CONTRACTS` 移除，标记为预留。倾向于后者（`apply_patch` 的 Codex 格式解析复杂度高，`edit_file` 已覆盖核心场景）。

---

## B15 — `shell_execute` schema 臃肿

- **位置**：`src/core/tools/definitions.ts:109-147`
- **问题**：8 个可选元数据字段中，`description`、`intent`、`grant_request` 参与执行逻辑（intent 影响审批），其余 5 个（`objective`、`justification`、`expected_observation`、`failure_strategy`、`prefix_rule`）仅在审批 UI 透传展示，不影响执行结果。
- **影响**：每次 tool call 约浪费 ~200 tokens 在不会被消费的元数据上。模型还需额外推理「该填什么」。
- **建议**：精简为 `description` + `intent` + `grant_request`。如果审批 UI 确实需要其他字段，确保它们在审批卡片中真正展示。

---

## B16 — 模块级可变缓存存在并发竞态

- **位置**：`src/core/tools/definitions.ts:46-53`
- **代码**：
  ```typescript
  let _cachedKey: string | null = null;
  let _cachedTools: any[] | null = null;
  ```
- **问题**：两个 session 如果 workspace 不同但工具配置相同（相同 provider、相同 MCP server、相同 skills），cache key 匹配，后一次调用覆盖前一次的数组引用。多 session 并发时工具引用可能被意外替换。
- **建议**：cache key 加入 `threadId`；或改为 `Map<string, any[]>`；或直接去掉缓存（工具创建开销远小于模型调用延迟，不值得为它引入并发风险）。

---

## B17 — `sanitizeToolCallPairs` 是 checkpoint 不一致的事后补丁

- **位置**：`src/core/model/context.ts:64-100`
- **问题**：当 checkpoint 中存在「AIMessage 有 tool_calls 但无对应 ToolMessage」的孤儿消息时，此函数清理它们。注释明确说「修复 checkpoint 中因中断/崩溃导致的消息不对齐」。
- **影响**：说明 interrupt/resume 流程会在 checkpoint 中遗留脏数据。这个 cleanup 正确，但不应该需要存在 — 更好的方案是在 checkpoint 写入前确保消息配对完整。
- **建议**：在 graph 的 interrupt 节点和 resume 入口处添加断言/修复逻辑，从源头避免孤儿消息写入 checkpoint。`sanitizeToolCallPairs` 保留作为防御层。

---

## B18 — 系统提示中文 vs 工具描述英文

- **位置**：`src/core/prompts/system-prompt.txt`（全中文）vs `src/core/tools/definitions.ts`（所有 schema description 为英文）
- **影响**：模型在两种语言间切换。工具参数命名是英文 snake_case，提示中说中文术语。增加认知负担但不一定导致错误。
- **建议**：统一为英文（system prompt 和工具描述一致），与国际开发者社区对齐。或全中文（面向国内用户）。当前混用是最差选项。

---

## B19 — `edit_file` 无容错匹配

- **位置**：`src/core/tools/file.ts`
- **问题**：`old_string` 必须逐字匹配文件内容。契约文档自己写的 common mistake：「whitespace, indentation, or blank lines differ」。模型从 tool result 剪贴代码时，多一个 trailing space 就失败。
- **建议**：提供 `match_mode` 参数：`exact`（当前行为，默认）和 `trimmed`（忽略每行首尾空白后匹配）。

---

## B20 — `write_file` 无 append 模式

- **位置**：`src/core/tools/file.ts`
- **问题**：只能全量覆写。追加一行日志或配置文件项也要传整个文件内容。大文件场景下严重浪费 context window。
- **建议**：新增 `mode: "overwrite" | "append"` 参数，默认 `"overwrite"` 保持向后兼容。

---

## B21 — 无二进制文件检测

- **位置**：`src/core/tools/file.ts` — `readFile` 函数
- **问题**：如果 agent 尝试读取 PNG、`.o`、`.wasm` 等二进制文件，会得到乱码内容，可能误导模型或导致编码错误。
- **建议**：`readFile` 在读取前检测文件大小，对 >1MB 文件拒绝；读取后检测是否包含 null byte（\0），若包含则返回 `ok: false, error: "Binary file detected"`。

---

## B22 — 全局快捷键过少

- **位置**：`src/app/tui/hooks/useGlobalKeys.ts`
- **问题**：仅 Ctrl+C（取消）、Ctrl+T（展开推理）、Ctrl+E（展开输入框）。缺少 Ctrl+L（清屏/重绘）、无输入历史搜索。
- **建议**：至少补上 Ctrl+L（清屏重绘 TUI）。评估是否需要 `Ctrl+R` 搜索历史。

---

## B23 — 子 Agent 无独立模型/超时配置

- **位置**：`src/core/subagent/types.ts`、`src/core/subagent/runner.ts`
- **问题**：子 agent 继承主 agent 的模型配置。Explore 和 Review（只读）用和 Code（全工具）同样的模型，无法为低成本角色指定便宜模型。30min 超时硬编码，不能按角色或任务调整。
- **建议**：`SubAgentRoleConfig` 新增可选 `model` 和 `timeoutMs` 字段，未指定时 fallback 到主 agent 配置。

---

## B24 — `update_plan` 无约束

- **位置**：`src/core/tools/definitions.ts:237-271`
- **问题**：实现是 `return JSON.stringify({ ok: true, plan: ... })`，永远成功。模型可以声明「step 3 已完成」而从未执行对应工具调用。长任务中 plan 状态可能与实际进度脱节。
- **结论**：won't fix。plan 定位是 advisory（类似 Claude Code 的 TodoWrite），不需要工具调用级别的校验框架。用户可通过中断纠正偏差。

---

## B25 — Skill 工具只是文本注入，无语义权重

- **位置**：`src/core/skills/skill-tool.ts`
- **问题**：Skill 工具返回 body 文本作为 ToolMessage，模型在下个 turn 看到它。它与普通 tool result 无区别。如果 skill 说「你 MUST 先读 CLAUDE.md」，这个指令和其他内容混在一起，优先级不高于 system prompt 中任何一句话。
- **已修复**：`<EXTREMELY-IMPORTANT>` 标签内容自动提取并注入 runtime context SystemMessage（与静态 system prompt 之后的缓存边界之后，不影响前缀缓存命中），效力和系统提示同级。

---

## B26 — 无 session crash recovery 保证

- **位置**：`src/core/persistence/checkpoint.ts`、`src/core/runner.ts`
- **问题**：checkpoint 通过 LangGraph SQLite 持久化，但如果终端被 kill -9 或 SSH 断连，最后一个 checkpoint 是否完整写入？无明确的 crash recovery 语义。
- **结论**：SQLite WAL 模式默认保证单次事务完整性；kill -9 后未提交事务被丢弃，上次完整 checkpoint 保持不变；resume 时 LangGraph 从最近完整 checkpoint 恢复，`sanitizeToolCallPairs` 在 rebuild context 时清理孤儿消息。无需额外 crash recovery 机制。

---

## 关联文档

- [`PRODUCT.md`](../../PRODUCT.md) — 「代码与设计债务」章节
- [`ROADMAP.md`](../../ROADMAP.md) — 产品化补齐路线中的工程债务清理
- [`tui-issues.md`](tui-issues.md) — TUI 已知问题清单（B01-B13）
