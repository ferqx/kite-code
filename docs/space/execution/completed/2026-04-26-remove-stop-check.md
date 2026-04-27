# 完成记录：移除 stop-check

日期：2026-04-26
状态：completed
相关 active 规则：`../active/tool-gated-autonomy.md`

## 变更

从 LangGraph 循环中移除最终答案 stop-check 机制。

实现形态：

- 移除 `src/harness/stop-check.ts`。
- 移除 `stop_check` 图节点和条件边。
- 移除 `routeAfterStopCheck`。
- plan 模式和 builder 模式的最终答案现在直接路由到 `END`。
- 移除 plan 完成时的非危险 `mode_confirmation` interrupt。
- 保留受保护 builder 工具执行的 approval。
- 保留 plan 模式 tools 层对写入或执行尝试的拒绝。

## 理由

harness 应更多信任模型遵循 prompt 约束，只在危险或越权工具执行时中断用户。最终答案质量约束应属于 agent contract 和测试，而不是硬编码的 post-final reviewer。

这让本地行为符合 harness 设计原则：在工具边界强制安全，在普通模型输出周围避免不必要的控制流门。

## 验证

已验证：

```bash
bun test tests/graph.test.ts
bun run typecheck
```
