# OpenPX 路线图

最后更新：2026-05-23

---

## 当前阶段：生产就绪补齐

TUI 生产就绪 4 步路线图已完成，当前重点补齐遗留缺口，对标 Claude Code CLI 核心体验。

### ✅ 已完成 — TUI 生产就绪（2026-05-20 ~ 2026-05-21）

| 步骤 | 内容 |
|------|------|
| 稳定性基线 | 错误红色渲染、⊘ Cancelled 标记、provider 超时（5min）、编辑器容错、HelpPanel 修正、StatusBar 接入、/sessions、recoverable 标志、防御性 interrupt 清理 |
| 感知闭环 | 流式 `❯` 指示器、Plan 进度数据链路、Phase 切换确认 |
| 防御纵深 | React Error Boundary、Checkpoint 句柄不泄漏、编辑器 temp 文件清理 |
| 功能补齐 | 手动 Compaction（`/compact` + `Ctrl+X c` 实际触发 graph 压缩） |

> 详见 [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md)

---

## 🔜 下一步：生产就绪补齐

> 详见 [`docs/space/plans/2026-05-22-production-gaps-closure.md`](docs/space/plans/2026-05-22-production-gaps-closure.md)

### Phase 1：MCP 核心 + 事件闭环 + 错误分类 ✅

**主攻方向 — MCP 协议支持**（对齐 Claude Code MCP 实现）：

- **MCP Client**：stdio + streamable HTTP transport，JSON-RPC 2.0 协议
- **工具集成**：MCP tool → LangChain StructuredTool，前缀 `mcp__servername__toolname`
- **安全策略**：MCP 工具默认需要审批，可在配置中降级
- **连接管理**：并行启动 + 失败不阻断 + HTTP 自动重连（指数退避）

**配套补齐**：

- **Compact 事件闭环**：graph 压缩后通过 runner emit `compact_begin`/`compact_end`
- **Compacting UI**：StatusBar 展示 `⏳ Compacting...` 状态
- **Retry 事件清理**：移除死事件 `retry`，统一使用 `model_retry`
- **Recoverable 错误分类**：runner 区分网络/超时（可恢复）和配置/权限（不可恢复）
- **Session 命名修复**：API key 缺失时 fallback 为截断的用户输入

### Phase 2：MCP Resources + Rewind ✅

- **MCP Resources**：`resources/list` + `resources/read`，通过内置工具注入 agent 上下文
- **Rewind（会话回溯）**：对齐 Claude Code `/rewind` 模型，基于已有 checkpoint 链的回溯
  - `/rewind` 命令 → checkpoint 列表 → fork 新会话
  - 不实现 Ctrl+Z/Ctrl+Y 逐次撤销

### Phase 3：Skills 系统

> 详见 [`docs/space/understanding/2026-05-23-skills-system-design.md`](docs/space/understanding/2026-05-23-skills-system-design.md)

- **Skills 系统**：严格遵循 agentskills.io 开放标准，按需加载 Markdown 指令文件
  - `Skill` 工具：Agent 根据 Available Skills 区段自主匹配调用
  - `/skill-name` 斜杠命令：用户显式激活
  - 4 目录扫描：`.openpx/skills/` > `.agents/skills/` > `~/.openpx/skills/` > `~/.agents/skills/`
  - 容错优先：所有校验异常静默跳过，不阻断 TUI

### 后续（暂缓）

- **Hooks 系统**：`PreToolUse` / `PostToolUse` hook — 当前优先级不高，延后
- **自定义斜杠命令**：`customCommands` 配置段 — Skills 系统实现后可复用其机制

---

## 未纳入本阶段的长期目标

- **多会话并发**（需 checkpoint 线程安全先行）
- **主题定制**（单一 dark theme 满足当前需求）
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
| [`docs/space/plans/2026-05-22-production-gaps-closure.md`](docs/space/plans/2026-05-22-production-gaps-closure.md) | 生产就绪补齐方案 — 3 阶段详细设计 |
| [`docs/space/backlog/tui-issues.md`](docs/space/backlog/tui-issues.md) | TUI 已知问题清单 — 缺陷和清理项 |
| [`docs/space/understanding/2026-05-20-tui-known-issues.md`](docs/space/understanding/2026-05-20-tui-known-issues.md) | TUI 深度审查报告 — 死事件、协议缺口、设计分析 |
