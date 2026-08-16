# 产品体验缺口

日期：2026-06-08
来源：Kite Code 项目审查 — 从"能工作的 agent 框架"到"愿意日常使用的 agent 产品"之间的关键缺口

---

## B27 — 跨会话记忆系统

- **位置**：全局（新系统）
- **问题**：仅支持同会话内 checkpoint 回溯，无跨会话持久记忆。每次新会话 agent 不记得用户偏好、技术栈、架构决策、项目约定。
- **影响**：P0（一票否决级）。重度使用场景不可接受，与 Claude Code auto-memory 差距明显。
- **建议方向**：`.kite-code/memory/` 持久记忆目录，`MEMORY.md` 入口 + 分 topic 文件。agent 在会话开始时自动读取，结束时写入更新。
- **参考**：PRODUCT.md 已知产品缺口章节

---

## B28 — Web Search 工具

- **位置**：`src/core/tools/`（需新增工具）
- **问题**：工具体系中不存在 web search 能力。agent 无法查最新文档、API 变更、社区 Issue/PR 讨论。
- **影响**：P0。现代编码 agent 的基础能力缺失。
- **建议方向**：先对接现成 MCP web search server（快速落地），后续考虑内置 web search 实现。

---

## B29 — 默认推荐模型 + 开箱即用体验

- **位置**：`src/core/model/`、`src/core/config/`
- **问题**：provider-agnostic 将模型选择风险转嫁用户。用户接入弱模型后 agent 连续犯错，第一反应是换产品而非调配置。
- **影响**：P0。阻碍首次体验，用户留存的关键瓶颈。
- **建议方向**：提供 `kite-code.jsonc` 默认配置模板，针对一个强模型（DeepSeek V3+ 或 Claude 兼容）优化 system prompt 和工具描述，首次启动引导。

---

## B30 — Token / 成本展示

- **位置**：`src/core/cache-metrics.ts` → `src/app/tui/StatsLine.tsx` 或 StatusBar
- **问题**：cache-metrics.ts 已实现 prompt cache 指标提取，但 TUI 不展示 token 用量或估算成本。深度用户无法感知 session 消耗。
- **影响**：P1。深度用户缺乏成本控制感知。
- **建议方向**：在 TUI StatusBar 或 StatsLine 展示当前 session token 用量和估算成本，对齐 Claude Code 体验。

---

## B31 — Diff 渲染

- **位置**：`src/app/tui/components/`（需新增 diff 展示组件）
- **问题**：`edit_file` / `write_file` / `apply_patch` 结果仅返回文本匹配成功/失败文本，TUI 中无 diff 展示。用户需额外开终端 `git diff` 验证改动。
- **影响**：P1。打断工作流，累积摩擦。
- **建议方向**：在 TUI 中展示彩色 diff 块，类似 Claude Code 的 diff 渲染。需考虑如何从 tool result 中提取实际改动内容。

---

## B32 — Hook 系统（PreToolUse / PostToolUse）

- **位置**：`src/core/harness/tool-runner.ts`、`src/core/harness/tool-policy.ts`（需新增机制）
- **问题**：无 PreToolUse / PostToolUse 机制。深度用户无法定制 agent 行为（如自动 lint、编译验证、日志记录）。
- **影响**：P1（已升优先级）。长时间 session 中摩擦持续累积。
- **建议方向**：定义 Hook 接口和触发时机，支持用户配置 shell hook 脚本；先做 PreToolUse（执行前验证/准备），再做 PostToolUse（执行后检查/记录）。

---

## B33 — 多 provider 与产品体验的张力

- **位置**：产品层面（架构 vs 产品定位）
- **问题**："多 provider" 和 "好用的产品" 之间存在内在矛盾。架构层已经做到 provider 无关，但产品层需要绑定一个推荐模型来定义"好的体验"。当前没有任何机制帮用户选择或调优。
- **影响**：P0-P1 跨层问题。影响首次体验和深度用户双端。
- **建议方向**：在 `kite-code.jsonc` 中支持 `defaultPreset` 字段，预置针对 DeepSeek / OpenAI / Ollama 的调优配置（system prompt、温度、max tokens 等）。用户选择 preset 即可获得该 provider 下的最优体验，同时保留细粒度覆盖能力。

---

## 关联文档

- [`docs/space/backlog/2026-06-01-deep-user-audit.md`](2026-06-01-deep-user-audit.md) — B14-B26 工程债务清单
- [`docs/space/backlog/tui-issues.md`](tui-issues.md) — B01-B13 TUI 修复项清单
