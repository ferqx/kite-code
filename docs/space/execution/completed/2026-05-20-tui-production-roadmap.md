# TUI 生产就绪路线图完成记录

状态：archived
日期：2026-05-21（完成），2026-06-08（归档）

## 改动摘要

将 TUI 从"可用终端聊天 Agent"提升到"生产级开发者工具"，分四步实施。

### 第二步：感知闭环

- 流式输出 `❯` 指示器
- Plan 进度数据链路验证
- Phase 切换确认测试

### 第三步：防御纵深

- React Error Boundary 包裹 TUI 根组件
- Checkpoint 句柄关闭（移除 `signal.aborted` 守卫）
- 编辑器 temp 文件 cleanup

### 第四步：功能补齐

- 手动 Compaction：`/compact` + `Ctrl+X c` 触发 graph 压缩
- Undo/Redo → 后续由 Rewind（Phase 2）替代
- 自定义斜杠命令 → 暂缓

### Commits

```
a62014d feat: TUI 生产就绪 — 感知闭环、防御纵深、手动 Compaction
a930166 test: 补全测试覆盖、修复 tools.test 平台路径、清理冗余 e2e
```

### 关联

- 被 `2026-05-22-production-gaps-closure.md` 延续（Phase 1-3）
- Rewind 替代了原 Undo/Redo 设计
