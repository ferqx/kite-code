# OpenPX 路线图

最后更新：2026-05-20

---

## 当前阶段：TUI 生产就绪

TUI 对话体验已可用，正在补齐稳定性、感知反馈和错误恢复。

### ✅ 已完成 — 稳定性基线（2026-05-20）

- 错误文本以红色渲染，中断取消标记 ⊘ Cancelled
- provider 超时保护（5 分钟）、编辑器容错
- HelpPanel 文档修正，StatusBar 接入布局
- `/sessions <id>` 直接加载，`recoverable` 标志接入
- 移除死代码（UNDO/REDO），防御性 interrupt 清理

### 🔜 下一步 — 感知闭环

- **流式输出指示器**：模型输出期间显示"正在生成"的视觉信号
- **Plan 进度接入**：StatusBar 实时展示当前 plan step 进度
- **Phase 切换**：Planning ↔ Building 状态在 StatusBar 正确反映

> 详见 [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md)

---

## 下一阶段：防御纵深

### 崩溃可恢复

- React Error Boundary — render 错误不应崩进程
- Checkpoint 句柄泄漏修复 — Ctrl+C 时正确关闭 SQLite
- 编辑器 temp 文件泄漏修复

---

## 后续阶段：功能补齐

### 对标 Claude Code CLI 核心体验

- **Undo/Redo**：利用 checkpoint 链实现对话回溯
- **手动 Compaction**：`/compact` 从空壳变为实际触发
- **MCP 协议支持**：接入 Model Context Protocol 工具生态
- **Hooks 系统**：工具执行前后的可配置 shell hook
- **自定义斜杠命令**：用户可扩展命令

### 暂不排期

- 多会话并发（需 checkpoint 线程安全先行）
- 主题定制（单一 dark theme 满足当前需求）
- IDE 插件 / Web 前端

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
| [`docs/space/plans/2026-05-20-tui-production-roadmap.md`](docs/space/plans/2026-05-20-tui-production-roadmap.md) | TUI 四步方案 — 详细实施步骤 |
| [`docs/space/backlog/tui-issues.md`](docs/space/backlog/tui-issues.md) | TUI 已知问题清单 — 缺陷和清理项 |
| [`docs/space/understanding/2026-05-20-tui-known-issues.md`](docs/space/understanding/2026-05-20-tui-known-issues.md) | TUI 深度审查报告 — 死事件、协议缺口、设计分析 |
