# OpenPX 路线图

最后更新：2026-05-27

---

## 当前阶段：稳定期

所有计划内功能已交付，OpenPX 已具备对标 Claude Code CLI 的核心体验。当前进入稳定期，重点转向验收、打磨和文档收尾。

---

## ✅ 已完成

### TUI 生产就绪（2026-05-20 ~ 2026-05-21）

| 步骤 | 内容 |
|------|------|
| 稳定性基线 | 错误红色渲染、⊘ Cancelled 标记、provider 超时（5min）、编辑器容错、HelpPanel 修正、StatusBar 接入、/sessions、recoverable 标志、防御性 interrupt 清理 |
| 感知闭环 | 流式 `❯` 指示器、Plan 进度数据链路、Phase 切换确认 |
| 防御纵深 | React Error Boundary、Checkpoint 句柄不泄漏、编辑器 temp 文件清理 |
| 功能补齐 | 手动 Compaction（`/compact` + `Ctrl+X c` 实际触发 graph 压缩） |

> 详见 [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md)

### 生产就绪补齐 — Phase 1（2026-05-22）

| 任务 | 内容 |
|------|------|
| MCP 协议支持 | stdio + streamable HTTP transport，工具命名 `mcp__servername__toolname`，`/mcp` 面板，安全策略集成 |
| 事件闭环 | `compact_begin` / `compact_end` 事件接入 graph → runner → TUI 全链路 |
| Compact UI 消费 | StatusBar 展示 `⏳ Compacting...` |
| Retry 事件清理 | 移除死代码 `retry` 事件，统一使用 `model_retry` |
| Recoverable 错误分类 | `isRecoverableError` 区分网络超时/速率限制 vs 配置/权限错误 |
| Session 命名修复 | API key 缺失时 fallback 为用户输入截断 |

> 详见 [`docs/space/plans/2026-05-22-production-gaps-phase1.md`](docs/space/plans/2026-05-22-production-gaps-phase1.md)

### 生产就绪补齐 — Phase 2（2026-05-23）

| 任务 | 内容 |
|------|------|
| Rewind（会话回溯） | `/rewind` 命令 + `Esc Esc`，checkpoint 列表 → Revert/Fork，对齐 Claude Code Rewind 模型 |
| MCP Resources | `resources/list` + `resources/read`，`read_mcp_resource` 工具注入 agent 上下文 |

> 详见 [`docs/space/plans/2026-05-22-production-gaps-phase2.md`](docs/space/plans/2026-05-22-production-gaps-phase2.md)

### 生产就绪补齐 — Phase 3：Skills 系统（2026-05-23）

| 任务 | 内容 |
|------|------|
| Skills 系统 | agentskills.io 标准，`Skill` 工具 + `/skill-name` 斜杠命令，`.openpx/skills/` → `~/.openpx/skills/` 路径查找，容错静默跳过 |

> 详见 [`docs/space/plans/2026-05-23-skills-system-phase3.md`](docs/space/plans/2026-05-23-skills-system-phase3.md)

### 多会话并发（2026-05-24）

| 任务 | 内容 |
|------|------|
| 多会话并发执行 | 独立 AbortController、后台 agent 不污染前台、pendingSessionRef 竞态修复 |

> 详见 [`docs/space/plans/2026-05-24-multi-session-concurrency.md`](docs/space/plans/2026-05-24-multi-session-concurrency.md)

### E2E 测试重构（2026-05-25）

| 任务 | 内容 |
|------|------|
| 测试套件重构 | ~71 tests，P0-P3 分层，mock agent 无真实模型依赖 |

> 详见 [`docs/space/plans/2026-05-25-e2e-restructure.md`](docs/space/plans/2026-05-25-e2e-restructure.md)

### TUI Claude Code 全面对标（2026-05-26）

| 任务 | 内容 |
|------|------|
| 布局重构 | Header（cat + 产品名 + hints）/ Body（OutputArea flexGrow）/ Footer（StatusBar + 交互行 + StatsLine）/ Overlay 四层 |
| 快捷键精简 | 10+ leader key → 仅 Ctrl+C / Ctrl+T / Ctrl+E |
| Markdown 链接 | `[text](url)` 渲染支持 |
| .gitignore 感知搜索 | @file 搜索遵循 .gitignore 规则 |
| /export 命令 | 会话导出接线 |
| 动态模型列表 | 模型列表从 `openpx.jsonc` 加载，替换硬编码 |
| 主题支持 | dark / light 双主题，通过 `theme` 字段配置 |

> 详见 [`docs/space/plans/2026-05-26-tui-claude-code-parity.md`](docs/space/plans/2026-05-26-tui-claude-code-parity.md)

---

## 🔜 后续方向

### 可即时推进

- **文档收尾**：清理已完成的 plan 文件，更新 PRODUCT.md 和 backlog 状态
- **真实场景验证**：使用真实模型链路验收 MCP + Skills + Rewind 完整体验
- **代码质量**：TypeScript strict 模式、API 文档生成
- **性能优化**：前缀缓存命中率监控、checkpoint 压缩、大文件 diff 性能

### 暂缓项（待需求确认后启动）

- **Hooks 系统**：`PreToolUse` / `PostToolUse` hook — 需要明确定义 hook 接口和触发时机
- **自定义斜杠命令**：`customCommands` 配置段 — 可复用 Skills 机制实现

---

## 未纳入本阶段的长期目标

- **IDE 插件 / Web 前端**（不在当前规划中）

---

## 长期愿景

### 三层架构收官

当前 protocol → core → app 三层已运行，TUI 是第一个完整前端。未来前端（Desktop、Web）可直接复用 core 层。

### 工具生态

通过 MCP + Hooks 建立可扩展的工具链，让 OpenPX 从"内置 6 个工具的 agent"进化为"可接入任意工具的 agent 框架"。

---

## 关联文档

| 文档 | 用途 |
|------|------|
| [`PRODUCT.md`](PRODUCT.md) | 产品定义 — 该不该做某个功能的判断准绳 |
| [`docs/space/plans/index.md`](docs/space/plans/index.md) | 方案注册表 — 所有实施计划的全局状态 |
| [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md) | TUI 四步方案 — 已完成的实施步骤 |
| [`docs/space/plans/2026-05-22-production-gaps-closure.md`](docs/space/plans/2026-05-22-production-gaps-closure.md) | 生产就绪补齐方案 — 3 阶段总览 |
| [`docs/space/plans/2026-05-22-production-gaps-phase1.md`](docs/space/plans/2026-05-22-production-gaps-phase1.md) | Phase 1 详细实施 — MCP + 事件闭环 + 错误分类 |
| [`docs/space/plans/2026-05-22-production-gaps-phase2.md`](docs/space/plans/2026-05-22-production-gaps-phase2.md) | Phase 2 详细实施 — Rewind + MCP Resources |
| [`docs/space/plans/2026-05-23-skills-system-phase3.md`](docs/space/plans/2026-05-23-skills-system-phase3.md) | Phase 3 详细实施 — Skills 系统 |
| [`docs/space/plans/2026-05-24-multi-session-concurrency.md`](docs/space/plans/2026-05-24-multi-session-concurrency.md) | 多会话并发执行 |
| [`docs/space/plans/2026-05-25-e2e-restructure.md`](docs/space/plans/2026-05-25-e2e-restructure.md) | E2E 测试套件重构 |
| [`docs/space/plans/2026-05-26-tui-claude-code-parity.md`](docs/space/plans/2026-05-26-tui-claude-code-parity.md) | TUI Claude Code 全面对标 |
| [`docs/space/backlog/tui-issues.md`](docs/space/backlog/tui-issues.md) | TUI 已知问题清单 — 缺陷和清理项 |
| [`docs/space/understanding/2026-05-20-tui-known-issues.md`](docs/space/understanding/2026-05-20-tui-known-issues.md) | TUI 深度审查报告 — 死事件、协议缺口、设计分析 |
