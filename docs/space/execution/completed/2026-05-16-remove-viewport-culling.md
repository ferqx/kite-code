# 完成记录：移除 TUI 视口剔除，补齐 e2e 验证体系

日期：2026-05-16
状态：completed
相关：

- `execution/active/tui-no-viewport-culling.md`
- `understanding/2026-05-12-tui-overhaul-design.md`

## 变更

### 生产代码

- `src/app/tui/OutputArea.tsx`：删除视口剔除逻辑（~80 行 → ~30 行）。移除 `blockLineEstimate`、`autoScrollRef`、`visibleStart`/`visibleEnd` 计算、压缩估算 guard。改为始终渲染所有 `blocks`。
- `src/app/tui/App.tsx`：移除根 Box 的 `height="100%"`，移除 `maxHeight` prop。让内容自然溢出到终端缓冲区。

### 测试基础设施

- `tests/e2e/types.ts`：新增 8 种断言类型（`contains-in-order`、`blocks-equal`、`block-kinds-in-order`、`blocks-of-kind-count`、`all-blocks-non-streaming` 等）
- `tests/e2e/helpers.ts`：新增对应验证函数
- `tests/e2e/real-agent.tsx`：新建，将 `runAgent()` + `StreamingMockModel` 接入完整 TUI 渲染
- `tests/e2e/scenarios/keyboard-shortcuts.ts`：新建，10 个快捷键场景
- `tests/e2e/scenarios/real-agent-conversation.ts`：新建，5 个真实 agent 对话场景
- `tests/e2e/scenarios/settings-session.ts`：新建，7 个设置/会话/退出场景
- `tests/e2e/scenarios/slash-commands.ts`：新建，12 个斜杠命令场景
- `tests/e2e/scenarios/viewport-culling.ts`：新建，3 个视口回归场景
- `tests/tui-reducer.test.ts`：新增 6 个 SET_EXITED / 流式文本去重测试

### 其他修复

- `tests/e2e/mock-agent.tsx`：`agent-done` 步骤增加 `SET_EXITED` 派发
- `tests/e2e/freeze.ts`：新增退出摘要耗时冻结模式
- `src/app/tui/App.tsx`：修复流式文本 block 重复累积（text 事件去重）

## 理由

1. **视口剔除导致用户困惑**：自动滚动到底部时，旧 block（用户消息、工具调用记录）从渲染树中消失，用户误以为数据丢失。实际数据在 state 中保留，但渲染层不可见。
2. **Ink 没有原生滚动**：之前用视口剔除模拟滚动，但终端本身有 scrollback buffer。移除剔除后，内容超出终端高度时终端自带滚动条。
3. **e2e 测试缺乏内容验证**：之前只检查状态契约（interrupt 是否为 null），不检查渲染输出。新增断言类型覆盖 ANSI 内容验证、block 序列完整性、streaming 清理等。

## 验证

```
bun test                           # 574 pass, 0 fail
bun test tests/e2e/                # 88 pass, 0 fail
bun test tests/tui-layout.test.tsx # 90 pass, 0 fail
bun test tests/tui-reducer.test.ts # 56 pass, 0 fail
```
