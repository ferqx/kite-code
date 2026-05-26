# TUI 待修复项

日期：2026-05-20
来源：TUI 生产就绪度深度审查
最后更新：2026-05-27（B01–B12 全部已修复，仅 B13 暂缓）

---

## 已修复（B01–B12）

所有 12 个项目已于 2026-05-22 ~ 2026-05-26 期间修复，详见：

| 编号 | 内容 | 修复日期 | 关联计划 |
|------|------|---------|---------|
| B01 | `/sessions <id>` 直接加载空分支 | 05-20 | TUI 生产就绪 |
| B02 | `error.recoverable` 上游未利用 | 05-22 | Phase 1 错误分类 |
| B03 | UNDO/REDO → Rewind | 05-23 | Phase 2 Rewind |
| B04 | 手动 Compaction | 05-22 | Phase 1 事件闭环 |
| B05 | `retry` 事件 → `model_retry` | 05-22 | Phase 1 事件闭环 |
| B06 | `compact_begin`/`compact_end` 事件路径 | 05-22 | Phase 1 事件闭环 |
| B07 | `compacting` 字段 UI 消费 | 05-22 | Phase 1 事件闭环 |
| B08 | React Error Boundary | 05-23 | 防御纵深 |
| B09 | Checkpoint 句柄泄漏 | 05-22 | 防御纵深 |
| B10 | 编辑器 temp 文件清理 | 05-23 | 防御纵深 |
| B11 | Session 命名 fallback | 05-22 | Phase 1 Session 命名 |
| B12 | 多会话并发 | 05-24 | 多会话并发执行 |

> 实施记录见 [`plans/`](../plans/) 目录下各对应计划文件。

---

## 暂缓

### B13 — 自定义斜杠命令 / Hook 系统

- 依赖：插件架构设计
- 状态：暂缓，待需求确认后启动
- 相关：Hooks（PreToolUse / PostToolUse）和 `customCommands` 配置段
- 备注：自定义斜杠命令可复用 Skills 加载机制
