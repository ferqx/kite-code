# Shell 工具并发执行 + 批量审批流程

状态：understanding
最后更新：2026-06-10
范围：`src/core/harness/graph.ts`、`src/core/harness/routes.ts`、`src/core/harness/state.ts`、`src/app/tui/components/ApprovalBlock.tsx`

相关：
- `execution/active/tool-gated-autonomy.md` — 工具审批边界规则
- `understanding/2026-05-11-three-layer-architecture-design.md` — 三层架构

## 背景

此前工具执行器（`tools` 节点）对 task 工具使用 `Promise.all` 并行执行，但其他工具（shell、read_file、write_file 等）是**串行**执行的。当一个 agent turn 同时发出多个 shell 命令时，串行执行导致不必要的等待。

同时，审批流程存在两个问题：
1. **无限递归**：无需审批的工具（如 `read_file`）进入 approval 节点后没有直接放行，导致 `approval → tools → agent → approval` 循环直到 `recursionLimit=60`
2. **审批粒度不匹配**：每个工具单独走 `approval → tools → agent` 全程，无法批量审批

## 设计方案

### 1. 新增 `approvedBatch` 状态注解

```typescript
// src/core/harness/state.ts
approvedBatch: Annotation<Record<string, "approve_once" | "same_command" | "full_access">>({
  reducer: (_left, right) => right,
  default: () => ({}),
}),
```

- Key：`call_id`（工具请求 ID）
- Value：授权类型
- 在 approval 节点中**累积**写入，tools 节点消费后**清空**

### 2. approval 节点：批量积累 + 自动放行

```
approval 节点逻辑：

1. 遍历待处理工具列表，找第一个未在 batch 中的工具
2. 如果 full_access 已授予 → 所有剩余工具自动标记为 full_access，直接返回
3. 如果工具无需审批（如 read_file）→ 标记为 approve_once，跳过中断，直接返回
4. 否则中断等待用户审批

用户审批后：
- 如果授权类型是 full_access → 自动标记所有剩余工具为 full_access
- 将当前工具写入 approvedBatch
```

**关键：无需审批的工具直接跳过**

```typescript
// 0555098 — approval 节点内
if (!policy.requiresApproval) {
  if (request.id) batch[request.id] = "approve_once";
  return { approvedBatch: batch, approvedToolRequest: null, approvedToolGrant: null };
}
```

这解决了 `recursionLimit=60` 不够用的问题。当 agent 连续发出多个只读工具时，不再反复进入 approval 中断。

### 3. 路由变化：approval → approval 循环

```typescript
// routeAfterApproval
export function routeAfterApproval(state: CodeAgentState): "approval" | "tools" | "agent" {
  // full_access → 跳过审批，直接进 tools
  // 同批次还有未审批工具 → 循环回 approval（不回到 agent）
  // 全部已审批 → tools
}
```

**路由拓扑对比**：

```
旧: agent → approval → tools → agent
         ↑                      ↓
         └──── (新工具需审批) ────┘
         每次都要回到 agent 重新推理

新: agent → approval → approval → ... → tools → agent
                    ↑         ↑              ↑
                    └─ 累加 ──┘              └─ 批量执行
         full_access 时跳过整个审批循环
```

### 4. tools 节点：全量并行

```typescript
// 旧：task 并行，其他串行
for (const req of otherRequests) {
  results.push(await executeOneTool(req, state, grantUsed));
}

// 新：全部并行，各自使用自己的 approvedBatch 授权
const otherResults = await Promise.all(
  otherRequests.map((req) => {
    const reqGrant = (req.id && batch[req.id]) ? batch[req.id] : "none";
    return executeOneTool(req, state, reqGrant);
  }),
);
```

- task 工具使用 `"none"`（子 agent 自行管理授权）
- 其他工具各自从 `approvedBatch` 取授权
- 执行完后清空 `approvedBatch`

### 5. recursionLimit 提升

`1973d61`: `recursionLimit` 从 60 → 9999999

原因：
- 批量审批让每个工具不再触发 agent 推理，大幅减少递归次数
- 但 `approval → approval` 循环本身消耗步数（N 个待审批工具 = N 步 approval）
- 极端场景（如 agent 一次发出 100 个工具）仍需足够大的上限
- `9999999` 是 LangGraph 的 hackable cap，实际由其他守卫（如 token 限制）控制

## TUI 侧变更

### ApprovalBlock 紧凑布局 (1962f38)

- 从 97 行精简到 78 行（-20%）
- 2 行紧凑布局：标题行 + 控制行
- 审批等待期间 shell_execute 不显示无效计时器 (887d3b4)

### Batch 计数显示

工具栏标题显示 `Approval (2/5)` 表示「第 2 个/共 5 个待审批」。

## 验证

| 点 | 命令 |
|----|------|
| 并发执行 | `bun test tests/graph.test.ts` |
| 审批路由 | `bun test tests/graph.test.ts` |
| 批量审批 + 仅一次审批 | `bun test tests/graph.test.ts` |
| TUI 渲染 | `bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx` |
