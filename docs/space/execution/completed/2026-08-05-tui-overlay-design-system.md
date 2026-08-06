# TUI Overlay 统一设计系统完成记录

状态：completed
完成日期：2026-08-05
计划：[`../../plans/2026-08-04-tui-overlay-design-system.md`](../../plans/2026-08-04-tui-overlay-design-system.md)

## 完成范围

- `OverlayFrame` 成为标题、正文、可选消息和快捷键区域的统一 spacing 所有者；
- 新增 `OverlaySection`、`OverlayList`、`OverlayListRow`、`OverlayDetailList`、`OverlayMessage` 和 `OverlayEmptyState`；
- `OverlayChoiceList` 收敛为通用列表行 preset；
- MCP 的纯 list/detail/tools/form/auth/approval/confirm 视图拆入 `McpViews.tsx`，宿主继续持有 route、input 和 controller 编排；
- MCP Server 名称/状态成为主行，配置路径/capability 数量成为次级行；
- Model、Session、Checkpoint、Slash Suggestion、Help 和文件匹配列表迁入共享 primitive；
- Approval、Plan Review、InputBlock 的导航词汇与 Frame 外层间距收敛；
- 新增当前 Overlay contract、文档影响映射和组件 contract 测试。

未改变 MCP config revision、project approval digest、OAuth flow、credential cleanup、catalog binding、会话切换、Runtime interrupt 或 Core API。

## 验证证据

以下验证在 2026-08-05 的 `feat/unify-tui-overlays` 工作树通过：

```text
bun run typecheck
bun test tests/overlay-frame.test.tsx tests/tui-overlay-choice-list.test.tsx tests/tui-slash-suggestion-overlay.test.tsx tests/tui-checkpoint-selector.test.tsx tests/mcp-panel.test.tsx tests/tui-layout.test.tsx
  230 pass, 0 fail

bun test --parallel=1 --max-concurrency=1 \
  tests/tui-system/scenarios/mcp-management-readonly.test.ts \
  tests/tui-system/scenarios/mcp-project-approval.test.ts \
  tests/tui-system/scenarios/slash-commands.test.ts
  12 pass, 0 fail

bun test --parallel=1 --max-concurrency=1 \
  tests/tui-system/scenarios/mcp-authentication.test.ts \
  tests/tui-system/scenarios/approval.test.ts \
  tests/tui-system/scenarios/approval-escape.test.ts \
  tests/tui-system/scenarios/ask-user.test.ts \
  tests/tui-system/scenarios/ask-user-esc.test.ts \
  tests/tui-system/scenarios/plan-review.test.ts
  9 pass, 0 fail

bun run test
bun run check:docs-impact
bun run check:docs
git diff --check
```

定向覆盖包含长配置路径、中文宽字符、命令列对齐、低高度可视窗口、动态 MCP 状态、认证、审批、问答取消和安全默认确认。默认测试套件完整通过。
