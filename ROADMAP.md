# OpenPX 路线图

最后更新：2026-06-01

---

## 当前阶段：从 Agent 框架到 Agent 产品

基础设施已完备（MCP、Rewind、Skills、多 Agent 协作），但深度用户反馈揭示了从"能工作"到"愿意日常使用"之间的关键差距。当前阶段聚焦补齐这些产品化缺口，将 OpenPX 从"好的 agent 框架"升级为"好的 agent 产品"。

核心矛盾：架构优雅（三层分离、事件协议、provider 无关）≠ 产品竞争力。产品竞争力来自**模型能力 + 功能深度**。

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

### 多 Agent 协作（2026-05-30）

| 任务 | 内容 |
|------|------|
| Task Tool 模式 | 主 Agent 通过 `task` 工具派发子 Agent（星型拓扑），独立上下文窗口，单向摘要回报 |
| 3 个内置角色 | Explore（只读搜索）/ Code（完整工具集）/ Review（批判性审查），Plan 由主 Agent 把控 |
| 生命周期管理 | 30min 超时、10 并发、深度 0（不可递归）|
| TUI 渲染 | `subagent` block 类型，运行中/完成/错误三态，折叠+展开 |
| 审批策略 | 继承主 Agent 授权 + 敏感操作独立审批 |

> 详见 [`docs/space/understanding/2026-05-30-multi-agent-design.md`](docs/space/understanding/2026-05-30-multi-agent-design.md) |

> 详见 [`docs/space/plans/2026-05-26-tui-claude-code-parity.md`](docs/space/plans/2026-05-26-tui-claude-code-parity.md)

---

## 🔜 产品化补齐路线

> 来源：2026-06-01 深度用户反馈缺口分析。详见 [`PRODUCT.md`](PRODUCT.md)「已知产品缺口」章节。

### P0 — 决定用户是否愿意尝试（一票否决级）

| 任务 | 内容 | 状态 |
|------|------|------|
| **默认推荐模型 + 体验优化** | 围绕一个强模型（建议 Claude 兼容或 DeepSeek V3+）优化 system prompt、工具描述和默认配置。provider-agnostic 是架构原则，但产品层面必须有"开箱即用"的最佳体验路径 | 🔴 待启动 |
| **跨会话记忆系统** | `.openpx/memory/` 持久记忆目录，agent 自动读写。记忆按 topic 组织（`MEMORY.md` 入口 + 分 topic 文件），跨会话保留用户偏好、技术栈、架构决策、项目约定。对齐 Claude Code auto-memory 体验 | 🔴 待启动 |
| **Web Search 工具** | 内置 web search 能力（可先对接 MCP web search server，后续内置）。支持查最新文档、API 变更、社区 issue/PR 讨论 | 🔴 待启动 |
| **专用 search_code 工具** | 新增 `search_code`（底层复用 `rg --json`），返回结构化匹配列表（文件:行号:内容），替代 `shell_execute intent=inspect` 做代码搜索。支持 .gitignore 感知过滤 | 🔴 待启动 |
| **Token 消耗展示** | TUI StatusBar 展示当前 session 的 token 用量和估算成本，对标 Claude Code | 🔴 待启动 |

### P1 — 决定深度用户是否留下来

| 任务 | 内容 | 状态 |
|------|------|------|
| **Hooks 系统** | `PreToolUse` / `PostToolUse` shell hook，定义 hook 接口和触发时机。原为暂缓项，现提升为 P1 | 🟡 已升优先级 |
| **Diff 渲染** | TUI 中 `edit_file` / `write_file` / `apply_patch` 结果以 diff 形式展示（对标 Claude Code），非仅 old_string/new_string 匹配成功/失败文本 | 🔴 待启动 |
| **`shell_execute` schema 精简** | 8 个可选元数据字段 → 保留 `description` + `intent` + `grant_request`，其余砍掉或确保审批 UI 真正消费。减少 token 浪费和模型填写错误 | 🔴 待启动 |
| **`edit_file` 容错匹配** | 支持忽略行首尾空白的匹配模式，减少因 trailing space 导致的匹配失败 | 🔴 待启动 |
| **二进制文件检测** | `read_file` 前检测文件类型，二进制文件直接拒绝并提示，防止 agent 误读 | 🔴 待启动 |

### P2 — 扩大适用场景

| 任务 | 内容 | 状态 |
|------|------|------|
| **自定义子 Agent 配置** | `.openpx/agents/*.md` 定义角色（system prompt + 工具集），超越内置 3 个。评估放开 depth > 0 嵌套 | 🔴 待启动 |
| **图片输入支持** | 多模态输入，支持截图（debug）、架构图（design review）、UI mockup（前端开发） | 🔴 待启动 |
| **`write_file` append 模式** | 支持追加写入，避免修改大文件时必须传完整内容 | 🔴 待启动 |
| **子 Agent 独立模型配置** | Explore/Code/Review 可按角色指定不同模型（Explore 用便宜模型，Code 用强模型），独立超时设置 | 🔴 待启动 |
| **`apply_patch` 工具接线** | 将已实现的 apply_patch 注册到 `createAgentTools()`，系统提示中补充使用说明。或正式标记为预留 | 🔴 待启动 |
| **中英文语言一致性** | 统一 system prompt 和工具描述的语言（建议全英文，或全中文） | 🔴 待启动 |

### 工程债务清理

| 任务 | 内容 | 状态 |
|------|------|------|
| **模块级缓存并发隔离** | `definitions.ts` 中 `_cachedKey/_cachedTools` 加入 `threadId` 隔离或改用 WeakMap | 🔴 待启动 |
| **checkpoint 一致性修复** | 定位 `sanitizeToolCallPairs` 的上游根因（interrupt/resume 时消息不对齐），从事后补丁改为源头消除 | 🔴 待启动 |
| **全局快捷键补充** | 至少补上 Ctrl+L（清屏/重绘），评估恢复常用 leader key | 🔴 待启动 |

### 持续工程项

- **文档收尾**：清理已完成的 plan 文件，更新 backlog 状态
- **真实场景验证**：使用真实模型链路验收完整体验
- **代码质量**：TypeScript strict 模式、API 文档生成
- **性能优化**：前缀缓存命中率监控、checkpoint 压缩、大文件 diff 性能
  - [x] TUI 输入卡顿：用 Ink `<Static>` 将已完成 block 移出交互渲染树
  - [x] `<Static>` Header 顺序修复：Header 注入 `<Static>` items 哨兵值

### 暂缓项

- **自定义斜杠命令**：`customCommands` 配置段 — 可复用 Skills 机制实现

---

## 未纳入本阶段的长期目标

- **IDE 插件 / Web 前端**（不在当前规划中）

---

## 长期愿景

### 从 Agent 框架到 Agent 产品

当前 protocol → core → app 三层已运行，基础设施完备。下一步：让 OpenPX 成为开发者**愿意每天使用**的产品，而非仅能展示架构能力的框架。补齐 P0/P1 能力后，TUI 体验可对标 Claude Code CLI。

### 三层架构收官

TUI 是第一个完整前端。未来前端（Desktop、Web）可直接复用 core 层。

### 工具生态

通过 MCP + Hooks + Web Search 建立可扩展的工具链，覆盖现代编码 agent 的完整能力面。

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
