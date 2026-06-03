# TUI 消息列表 Turn 模型重构完成记录

状态：completed
日期：2026-06-04

## 改动摘要

将 `TuiState.blocks: OutputBlock[]` 替换为 `turns: Turn[]`，每个 Turn 对应一次「用户提问 → Agent 回复」往复。

### 数据结构变化

- 新增 `Turn { blocks: OutputBlock[] }` 接口
- `TuiState.blocks` → `TuiState.turns`
- `SessionSnapshot.blocks` → `SessionSnapshot.turns`
- `OutputBlock` 9 种 discriminated union 不变（`streaming` 字段保留）

### 新增文件

- `src/app/tui/reducers/helpers.ts` — 7 个 helper 函数，统一 `replaceBlock` 模式
  - `appendBlock`、`findBlockById`、`updateLastBlock`、`replaceBlockById`
  - `finalizeLastTurnStreaming`、`reconstructTurns`、`lastTurn`

### 核心简化

OutputArea 的 Static/Dynamic 分割逻辑从 50+ 行扫描退化为：

```typescript
const settledTurns = running ? turns.slice(0, -1) : turns;
const activeTurn   = running ? turns.at(-1) : undefined;
```

不再需要 `rawSplitIdx`、`maxSplitRef` monotonic guard、手动枚举 dynamic block 类型。

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/app/tui/types.ts` | 新增 `Turn`；`TuiState.blocks` → `turns`；`SessionSnapshot.blocks` → `turns` |
| `src/app/tui/reducers/helpers.ts` | 新文件，7 个 helper |
| `src/app/tui/reducers/handleEvent.ts` | 所有 EVENT handler 适配 turn；移除本地 `replaceBlock` |
| `src/app/tui/reducers/agentReducer.ts` | 生命周期 action 适配 turn；移除 `replaceBlock`/`finalizeStreaming` |
| `src/app/tui/reducers/sessionReducer.ts` | `USER_MESSAGE` 创建新 turn；`LOAD_SESSION` 调用 `reconstructTurns` |
| `src/app/tui/reducers/uiReducer.ts` | Toggle 用 `findBlockById` + `replaceBlockById` |
| `src/app/tui/reducers/skillReducer.ts` | `blocks` → `turns` |
| `src/app/tui/OutputArea.tsx` | Props: `blocks` → `turns`；简化 split 为 `slice(-1)` |
| `src/app/tui/App.tsx` | `state.turns` 传递；`interruptBlock` 跨 turn 查找 |
| `src/app/tui/index.tsx` | 导出 uses `turns.flatMap` |
| `src/app/tui/session-manager.ts` | `getSnapshot` 中 `blocks: []` → `turns: []` |

### 验证结果

- `bun run typecheck` — src/ 零错误
- `bun test tests/tui-reducer.test.ts` — 111 pass
- `bun test tests/tui-layout.test.tsx` — 94 pass
- 全量单元/集成测试 — 265 pass, 0 fail
- e2e — 17 pass / 4 fail（与重构前相同，preexisting）
- 手动验证 TUI — 消息渲染无重复、无闪烁

### 设计文档

- `understanding/2026-06-03-tui-block-turn-model-design.md`

### Commits (9)

```
0a91d17 docs: 添加 TUI 消息列表 Turn 模型重构设计文档
e9379d1 test: 适配 Turn 模型测试
36aebf7 refactor: OutputArea 适配 Turn 模型，简化 Static/Dynamic 分割为 slice(-1)
9eef4ab refactor: uiReducer/skillReducer/session-manager 适配 Turn 模型
9f3c425 refactor: sessionReducer 适配 Turn 模型，USER_MESSAGE 创建新 turn
5f35cbf refactor: agentReducer 适配 Turn 模型
f0b46d7 refactor: handleEvent 适配 Turn 模型，移除本地 replaceBlock
dbe9b46 feat: 新增 TUI block 操作 helpers，统一 replaceBlock 模式
bc84e93 refactor: 新增 Turn 接口，TuiState 和 SessionSnapshot 使用 turns
```
