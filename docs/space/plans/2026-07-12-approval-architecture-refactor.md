# 审批体系重构方案

状态：archived（已实施；当前规则见 `docs/active/tool-gated-autonomy.md` 与 `authorization.md`）
范围：`src/core/policies/`、`src/core/controllers/`、`src/core/harness/`、`src/core/runtime/`
读取时机：修改审批流程、新增 mode、调整工具权限时必须对照。

> 审计报告：本文档基于 [[2026-07-11-merge-exit-plan-mode]] 实施后的全面审计。

---

## 一、现状诊断

### 1.1 核心问题：审批决策分散在三处，各自独立

```
当前审批流程（每个工具调用）：
  
  tool-controller.ts
    ├── 1) evaluateToolApproval()           ← approval-policy.ts，用 authorization.mode
    │      └── 返回 { allowed, requiresApproval, risk, ... }
    │
    ├── 2) acceptsWorkspaceEdits 硬编码检查   ← tool-controller.ts 内联，用 state.mode
    │      └── mode==='accept_edits' && (write_file||edit_file) → 跳过交互
    │
    ├── 3) auto-review 硬编码检查            ← tool-controller.ts 内联，用 state.mode
    │      └── mode==='auto' && risk!=='destructive' → auto_review.requested
    │      └── 否则 → approval.requested
    │
    └── 4) runApprovedTool()                ← tool-runner.ts
           └── defense-in-depth: approvedGrant==='none' 则拒绝
           └── accept_edits 豁免: 再次硬编码检查
```

### 1.2 死代码层

`mode-policy.ts`（~330 行）定义了 5 种 mode 的完整策略，`RuntimePolicy` 接口的 6 个方法中，**5 个在运行时从未被调用**：

| 方法 | 运行时调用者 |
|------|------------|
| `shouldApproveTool` | 无 |
| `shouldReviewPlan` | 无 |
| `shouldRequirePlan` | 无 |
| `shouldAutoReview` | 无 |
| `shouldContinueLoop` | 无 |
| `shouldAskUser` | `tool-runner.ts:326`（唯一，且本地创建 policy，不走 kernel） |

`AgentKernel.getPolicy()` 也没有任何调用者。

### 1.3 两套并行 mode 字段

| 字段 | 值域 | 用途 | 设置方式 |
|------|------|------|---------|
| `state.mode` | ask / auto / accept_edits / full | tool-controller 用于路由 | plan.approved 或 /permissions 命令 |
| `state.authorization.mode` | default / full_access | `evaluateToolApproval` 用于 full_access 放行 | shell 审批 grant 或 /permissions full |
| `state.planning.executionMode` | auto / accept_edits / manual | 审批后执行模式（仅记录） | plan.approved |

`state.mode = 'full'` 时，TUI reducer `agentReducer.ts:376` 额外设置 `authorization.mode = 'full_access'`，形成隐式耦合。

### 1.4 `PolicyInput` 类型缺口

```typescript
interactionMode: 'ask' | 'auto' | 'full';  // ← 缺少 'accept_edits'
```

导致 `tool-runner.ts:323` 必须做：
```typescript
(interactionMode === 'accept_edits' ? 'ask' : interactionMode) as 'ask' | 'auto' | 'full'
```

### 1.5 已修复的 Critical Bug（本次审计中发现并修复）

| Bug | 修复 |
|-----|------|
| auto-review 通过后 `approvalGrant` 未写入 call record，defense-in-depth 拒绝 | `reducer.ts` 写入 `approvalGrant` |
| `evaluateCircuitBreaker` 从未被调用，circuit breaker 永远不触发 | `reducer.ts` 调用 `evaluateCircuitBreaker`，更新 `autoReview` 状态 |

---

## 二、目标架构

### 2.1 单一审批入口

```
每个工具调用 → evaluateToolApproval():
  1. Phase check: planning 阶段拒绝 mutation
  2. Risk classification: read / write_file / execute_code / destructive / ...
  3. Mode policy: 根据 risk + state.mode + authorization.mode → allow | need_approval | need_auto_review | deny
  4. 返回统一的 ApprovalDecision
```

tool-controller 不再自行判断 mode，只根据 `ApprovalDecision` 决定下一步：
- `allow` → 直接执行
- `need_approval` → 创建 `approval.requested` 交互
- `need_auto_review` → 创建 `auto_review.requested` 交互
- `deny` → `tool.rejected`

### 2.2 mode-policy 成为决策核心

`RuntimePolicy.shouldApproveTool(input)` 是审批链中唯一需要知道 mode 的地方。它整合了当前分散的：
- `acceptsWorkspaceEdits` 硬编码检查
- auto-review 硬编码检查
- full_access 放行检查

```typescript
// 伪代码
shouldApproveTool(input): PolicyDecision {
  // 1. full_access 全局放行
  if (input.authorizationMode === 'full_access') return { kind: 'allow' };
  
  // 2. planning 阶段已在 evaluateToolApproval 的 phase check 处理，这里不重复
  
  // 3. mode 特定逻辑
  switch (input.interactionMode) {
    case 'accept_edits':
      if (input.toolRisk === 'write_file') return { kind: 'allow' };
      // fall through to ask behavior
    case 'ask':
      if (input.toolRisk === 'destructive') return { kind: 'deny', ... };
      if (requiresApproval(input.toolRisk)) return { kind: 'need_approval', ... };
      return { kind: 'allow' };
    case 'auto':
      if (input.toolRisk === 'destructive') return { kind: 'deny', ... };
      if (requiresApproval(input.toolRisk)) return { kind: 'need_auto_review', ... };
      return { kind: 'allow' };
  }
}
```

### 2.3 两套 mode 字段的关系澄清

```
state.mode               → 用户选择的交互模式（何时弹窗、弹什么窗）
state.authorization.mode → 用户赋予的信任级别（是否跳过弹窗）

关系：
- state.mode = 'full' ⇔ authorization.mode = 'full_access'（互推）
- 其他 mode 下 authorization.mode = 'default'（除非 shell grant 提升为 full_access）
- authorization.mode = 'full_access' 在任何 mode 下都生效（全局放行）
```

这个关系应该在创建 RuntimePolicy 时注入，而不是在 tool-controller 中 ad-hoc 检查：

```typescript
// kernel.ts
getPolicy(): RuntimePolicy {
  return createModePolicy(this.state.mode, {
    authorizationMode: this.state.authorization.mode,
    sandboxAvailable: this.sandboxAvailable,
  });
}
```

### 2.4 PolicyInput 类型修正

```typescript
// 修正前
interactionMode: 'ask' | 'auto' | 'full';

// 修正后
interactionMode: 'ask' | 'auto' | 'accept_edits' | 'full';
```

清除 `tool-runner.ts:323` 中的 `as` 类型转换。

---

## 三、实施计划

### Phase 1：修复类型系统（低风险，为后续铺路）

| 序号 | 文件 | 变更 |
|------|------|------|
| 1.1 | `runtime-policy.ts` | `PolicyInput.interactionMode` 新增 `'accept_edits'` |
| 1.2 | `mode-policy.ts` | accept_edits mode 的 `shouldApproveTool` 和 `shouldReviewPlan` 合并到 ask mode 的逻辑（accept_edits = ask + file edit auto-allow） |
| 1.3 | `tool-runner.ts:322-324` | 移除 `accept_edits → ask` 的手工映射 |
| 1.4 | `runtime-policy.ts` | `PolicyInput` 新增 `authorizationMode` 字段，供 mode-policy 统一判断 full_access 放行 |

### Phase 2：连接 mode-policy 到审批链（核心重构）

| 序号 | 文件 | 变更 |
|------|------|------|
| 2.1 | `approval-policy.ts` | `evaluateToolApproval` 拆为两步：① `classifyToolRisk`（纯风险分类）② `checkPhaseConstraint`（phase 拒绝） |
| 2.2 | `tool-controller.ts` | 审批路由从硬编码改为调用 `kernel.getPolicy().shouldApproveTool()` |
| 2.3 | `tool-controller.ts` | 删除 `acceptsWorkspaceEdits` 变量，由 mode-policy 统一判断 |
| 2.4 | `tool-controller.ts` | 删除 auto-review 硬编码 `mode==='auto'` 检查，由 mode-policy 返回 `need_auto_review` |
| 2.5 | `tool-runner.ts` | defense-in-depth 检查改为只校验 `approvedGrant`，不再重复检查 `isAcceptEditsFileEdit`（由 mode-policy 在更上层保证） |
| 2.6 | `kernel.ts` | `getPolicy()` 传入 `authorizationMode`；使 policy 成为真正的运行时决策点 |

### Phase 3：清理和测试补全

| 序号 | 文件 | 变更 |
|------|------|------|
| 3.1 | `mode-policy.test.ts` | 更新 accept_edits 测试，验证 `PolicyInput.interactionMode='accept_edits'` 的完整行为 |
| 3.2 | `tool-controller.test.ts` | 新增 auto-review 全链路测试（tool → auto_review → approved → 执行成功） |
| 3.3 | `tool-controller.test.ts` | 新增 circuit breaker 集成测试（连续拒绝 → breaker trip → 降级到人工审批） |
| 3.4 | `reducer.test.ts` | 新增 auto_review 审批后 `approvalGrant` 写入验证 |
| 3.5 | `reducer.test.ts` | 新增 circuit breaker 状态更新验证 |

---

## 四、影响评估

### 保持不变
- `plan.review_requested` / `plan.approved` 事件流程
- `approval.requested` / `approval.granted` 交互流程
- Shell `approve_once` / `same_command` / `full_access` grant 机制
- PlanReviewBlock UI 组件

### 删除
- tool-controller 中的 `acceptsWorkspaceEdits` 硬编码变量
- tool-controller 中的 `mode==='auto'` auto-review 硬编码路由
- tool-runner 中的 `isAcceptEditsFileEdit` defense-in-depth 豁免
- tool-runner 中的 `accept_edits → ask` 手工类型映射

### 新增
- `PolicyInput.authorizationMode` 字段
- `PolicyInput.interactionMode` 支持 `'accept_edits'`
- `evaluateToolApproval` 对 mode-policy 的委托调用
- kernel.getPolicy() 的调用链

---

## 五、风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| mode-policy 连接后与当前硬编码行为不一致 | 中 | Phase 1 先用类型约束，Phase 2 逐模式验证；现有 1206 个测试保护 |
| full_access 放行路径被 mode-policy 重复处理或遗漏 | 低 | `PolicyInput.authorizationMode` 统一入口，mode-policy 优先检查 full_access |
| 重构期间工具审批行为短暂退化 | 低 | 渐进式重构，每个 phase 独立可验证；commit 粒度小 |
