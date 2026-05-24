# OpenPX 路线图

最后更新：2026-05-24

---

## 当前阶段：生产就绪补齐 ✅ 已完成

3 个 Phase 全部完成，OpenPX 已具备对标 Claude Code CLI 的核心体验。

### ✅ 已完成 — TUI 生产就绪（2026-05-20 ~ 2026-05-21）

| 步骤 | 内容 |
|------|------|
| 稳定性基线 | 错误红色渲染、⊘ Cancelled 标记、provider 超时（5min）、编辑器容错、HelpPanel 修正、StatusBar 接入、/sessions、recoverable 标志、防御性 interrupt 清理 |
| 感知闭环 | 流式 `❯` 指示器、Plan 进度数据链路、Phase 切换确认 |
| 防御纵深 | React Error Boundary、Checkpoint 句柄不泄漏、编辑器 temp 文件清理 |
| 功能补齐 | 手动 Compaction（`/compact` + `Ctrl+X c` 实际触发 graph 压缩） |

> 详见 [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md)

---

## 🔜 后续：稳定期 + 暂缓项评估

生产就绪补齐 3 个 Phase 已全部完成，当前进入稳定期。下一步方向：

### 可即时推进

- **ROADMAP 收尾**：清理已完成的 plan 文件，更新 backlog 状态
- **代码质量**：TypeScript strict 模式、API 文档生成
- **真实场景验证**：使用真实模型链路验收 MCP + Skills + Rewind 完整体验
- **性能优化**：前缀缓存命中率监控、checkpoint 压缩、大文件 diff 性能

### 暂缓项（待需求确认后启动）

- **Hooks 系统**：`PreToolUse` / `PostToolUse` hook — 需要明确定义 hook 接口和触发时机
- **自定义斜杠命令**：`customCommands` 配置段 — 可复用 Skills 机制实现

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
