# 完成记录：/sessions 会话列表与断点续接

日期：2026-05-17
状态：completed
相关 active 规则：
- `../active/tui-no-viewport-culling.md`
- `../active/tool-gated-autonomy.md`
相关 understanding：
- `../../understanding/2026-05-17-sessions-command-design.md`

## 变更

新增 4 个文件，修改 19 个文件：

| 文件 | 变更 |
|------|------|
| `src/core/persistence/sessions.ts` | 新增：listSessions、loadSession、generateSessionName、persistSessionName、enrichSessionNames |
| `src/app/tui/components/SessionSelector.tsx` | 新增：覆盖层组件 |
| `src/app/tui/hooks/useSessionList.ts` | 新增：异步加载 hook |
| `tests/sessions.test.ts` | 新增：22 个测试 |
| `src/core/persistence/checkpoint.ts` | created_at 列迁移、CREATE TABLE 含 created_at、put() 写入 datetime('now') |
| `src/core/harness/state.ts` | 新增 modelProvider、modelName、thinkingLevel 通道 |
| `src/core/harness/graph.ts` | BuildCodeAgentGraphInput 新增 thinkingLevel；agent 节点写入模型配置到 state |
| `src/core/runner.ts` | RunAgentInput/StreamCodeAgentInput 新增 thinkingLevel；initialState 含模型配置 |
| `src/core/config/index.ts` | AgentConfig 新增 reasoningEffort |
| `src/core/model/deepseek.ts` | createDeepSeekModel 透传 reasoningEffort |
| `src/core/model/factory.ts` | createOpenAICompatibleModel 透传 reasoningEffort |
| `src/app/tui/types.ts` | TuiState 新增 showSessions |
| `src/app/tui/App.tsx` | 新增 SHOW_SESSIONS/HIDE_SESSIONS/LOAD_SESSION/LOAD_SESSION_PENDING action；ESCAPE 优先级；SessionSelector 渲染 |
| `src/app/tui/index.tsx` | dispatchSessionLoad 包装器；threadId lazy init；thinkingLevelRef；智能命名 fire-and-forget |
| `src/app/tui/hooks/useSlashCommand.ts` | /sessions → SHOW_SESSIONS；/new → NEW_SESSION |
| `src/app/tui/hooks/useSlashSuggestions.ts` | 新增 /new 命令定义 |
| `src/app/tui/hooks/useGlobalKeys.ts` | Ctrl+N → NEW_SESSION；去除 Ctrl+X N leader key |
| `tests/e2e/` | show-sessions-is 断言；sessionsList/sessionsEscape 场景 |
| `tests/tui-*.test.tsx` | 更新 fakeState 含 showSessions |

## 关键设计决策

### 中断检测使用 __interrupt__ pendingWrites

`interrupt()` 抛出 GraphInterrupt 时，状态更新（approvedToolRequest/approvedToolGrant）尚未返回，channel_values 中这些字段始终为 null。正确做法是检查 `CheckpointTuple.pendingWrites` 中的 `__interrupt__` 通道。

### 智能命名在创建时执行

会话名称在 `runTask` 的 agent 执行完成后 fire-and-forget 调用 `generateSessionName + persistSessionName`，不在列表渲染时触发。避免列表加载时的网络延迟。

### threadId 延迟初始化

threadIdRef 初始为 `""`，仅在第一条用户消息发出后才生成 `tui-<base36 ts>`。避免创建空会话。

### 模型配置持久化

AgentState 携带 modelProvider/modelName/thinkingLevel，graph agent 节点写入，resume 时从 checkpoint 恢复。thinkingLevelRef 在 index.tsx 中跟踪当前会话的思考程度，传递给 runAgent。

## 验证

```bash
bun test                              # 594 pass, 1 skip, 1 fail (pre-existing)
bun test tests/sessions.test.ts       # 21 pass, 1 skip
bun test tests/e2e/tui-e2e-all.test.ts  # 73 pass
bun run typecheck                     # 0 new errors
```
