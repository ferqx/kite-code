# Runtime 工程护栏建设方案

状态：**completed**
优先级：P0
依赖：`2026-07-08-agent-kernel-incremental-evolution.md`（Phase 1-5 已完成）
替代：无（全新方案）
最后更新：2026-07-12（全部 Phase 完成；27 份 active 文档已迁移，旧路径保留兼容符号链接）

> 背景：Runtime Kernel 重构（state / reducer / scheduler / events / kernel / store）已基本完成，38 种 RuntimeEvent 覆盖完整生命周期，InteractionState 统一了交互状态，LangGraph 已彻底移除。但工程护栏层面存在 10 项缺口——无 feature flag、无 golden test、无失败分类、无授权来源追踪、无 replay 工具、无 ADR、无核心准入标准、无边界检查脚本、无文档分层、无 prompt 治理。

> 实施审计（2026-07-12）：方案中的 `full_access` 是授权状态，而 `full` 是交互模式；实现中保持二者分离。历史 `tool.failed.error` 和授权记录必须兼容既有持久化数据，因此结构化字段采用渐进迁移。P3 的 `docs/active` 物理搬迁会破坏大量内部链接，先由 `docs/README.md` 建立等价的读取优先级，待链接可原子迁移时再执行目录重组。

> 复核状态（2026-07-12）：P0 的 Golden pre-commit、Kernel 驱动 fixture 与 flag 双路径测试已完成；P1 的失败分类持久化、模型/工具/审批来源覆盖已完成；P3 的边界、prompt 契约与文档分层已完成。27 份 active 记录已迁移至 `docs/active/`，旧路径保留兼容符号链接以保证既有引用有效。

---

## 0. 一句话总结

**在 Runtime Kernel 之上建立工程护栏层：feature flag 灰度、golden test 回归防护、FailureKind 失败分类、AuthorizationState.source 授权溯源、Replay 回放调试、ADR 决策记录、核心准入标准、边界检查脚本、文档分层、Prompt 契约治理。**

---

## 1. 动机：为什么 Kernel 重构后必须补护栏

### 1.1 当前状况

Runtime Kernel 重构完成后，核心架构质量显著提升：

```
已完成 ✅
  Runtime Kernel（kernel / reducer / scheduler / state / events / store）
  38 种 RuntimeEvent（tool / user_input / plan / approval / auto_review / model / turn / run / subagent）
  InteractionState 统一交互状态（idle / awaiting_* ）
  PlanningState 替代 planReviewed boolean
  ToolCallStatus 12 状态机
  RUNTIME_STATE_SCHEMA_VERSION = 3 + 迁移逻辑
  LangGraph 彻底移除
  Session-logger trace 系统（1094 行，OTel 兼容，JSONL 写入）

未开始 🔴
  无 feature flag → 无法灰度/回滚
  无 golden test → 无核心状态回归防护
  无 FailureKind → 失败处理靠字符串匹配
  AuthorizationState 无 source → 无法区分授权来源
  无 replay 工具 → trace 数据无法回放
  无 ADR → 重构级设计决策未固化
  无核心准入标准 → 新功能无分类无门槛
  无边界检查脚本 → 架构边界靠文档约定
  无文档分层 → 旧文档可能被 AI 误读
  无 prompt 契约测试 → 系统提示词行为无保障
```

### 1.2 风险

如果不补这些护栏，后续加 `loop-mode`、更强 `auto-mode`、`subagent` 编排、`MCP` 扩展时会面临：

1. **每次大改直接替换主路径** → 无灰度，出问题只能回滚代码
2. **改核心逻辑无回归测试** → 只能靠手工验证 + E2E PTY 测试（不够快/不够稳定）
3. **失败处理不一致** → auto-mode 不知道什么时候 retry、什么时候 escalate
4. **授权来源不可追溯** → 安全审计时无法判断 full_access 是谁给的
5. **设计决策只存脑中** → 后续 AI coding 会重新打穿边界

---

## 2. 目标架构

### 2.1 护栏分层模型

```
┌─────────────────────────────────────────────────┐
│                 工程护栏层                        │
│  Feature Flags  │  Golden Tests  │  ADR         │
│  FailureKind   │  Auth Source   │  Replay Tool │
│  Replay Tool   │  准入标准       │  边界检查     │
│  文档分层       │  Prompt 契约    │              │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────┐
│               Runtime Kernel 层                   │
│  Kernel  │  Reducer  │  Scheduler  │  Events     │
│  State   │  Store    │  Effects    │  Executor   │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────┐
│               Policy / Controller 层              │
│  PlanPolicy  │  ApprovalPolicy  │  ModePolicy   │
│  ModelController  │  ToolController             │
└─────────────────────────────────────────────────┘
```

护栏层不改变 Runtime Kernel 的核心逻辑，而是在其之上提供：

- **灰度能力**（feature flag）→ 新功能渐进启用
- **回归防护**（golden test）→ 固定输入验证固定输出
- **失败语义**（FailureKind）→ 结构化失败分类
- **授权溯源**（AuthorizationState.source）→ 安全审计
- **可回放性**（Replay）→ 从 trace 重建状态
- **决策可追溯**（ADR）→ 设计决策文档化
- **边界自动化**（check:core-boundary）→ 架构约束自动化
- **文档新鲜度**（active / design / deprecated）→ AI 不误读旧文档
- **准入门槛**（Capability / Policy / Lifecycle / Engine）→ 新功能分级
- **Prompt 稳定性**（contract test）→ 系统提示词行为验证

---

## 3. Phase 1：Feature Flags + Golden Tests（P0，目标 2 周）

这两个是最高优先级的"安全网"——没有它们，后面的所有改动都在裸奔。

### 3.1 Feature Flag 系统

#### 3.1.1 设计

在 `~/.kite-code/kite-code.jsonc` 中新增 `features` 字段：

```jsonc
{
  "features": {
    "planLifecycleV2": true,        // PlanningState 替代 boolean（已稳定，默认开）
    "interactionControllerV2": true, // InteractionState 统一交互（已稳定，默认开）
    "autoReviewV2": false,           // 新版 auto-review 策略（灰度中）
    "runtimeProjectionV2": false,    // 新版 TUI 状态投影（开发中）
    "nativeLoopEngine": false,       // 自研 loop engine 替代 LangGraph（开发中）
    "loopMode": false                // loop-mode 功能（未实现）
  }
}
```

#### 3.1.2 实现

**新增文件**：

```
src/core/config/features.ts   — FeatureFlags 类型 + 读取 + 默认值
tests/config/features.test.ts  — 测试
```

**类型定义**：

```ts
// src/core/config/features.ts

export interface FeatureFlags {
  /** PlanningState 替代 planReviewed boolean */
  planLifecycleV2: boolean;
  /** InteractionState 统一交互管理 */
  interactionControllerV2: boolean;
  /** 新版 auto-review 策略 */
  autoReviewV2: boolean;
  /** 新版 TUI 状态投影 */
  runtimeProjectionV2: boolean;
  /** 自研 loop engine */
  nativeLoopEngine: boolean;
  /** loop-mode 功能开关 */
  loopMode: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  planLifecycleV2: true,
  interactionControllerV2: true,
  autoReviewV2: false,
  runtimeProjectionV2: false,
  nativeLoopEngine: false,
  loopMode: false,
};
```

**使用模式**：

```ts
// 在 kernel / policy / controller 中使用
import { getFeatureFlags } from '@/core/config/features';

const flags = getFeatureFlags(config);
if (flags.autoReviewV2) {
  // 新版路径
} else {
  // 旧版路径
}
```

#### 3.1.3 规则

1. 每个新 flag 默认 `false`（opt-in），稳定后改默认 `true`
2. 旧路径保留至少 2 周，确认新版稳定后删除
3. flag 名称必须在 `FeatureFlags` 接口中注册，不允许临时字符串
4. 测试必须覆盖 flag=true 和 flag=false 两条路径
5. CLI 支持 `--feature autoReviewV2` 临时覆盖

#### 3.1.4 验收标准

- [ ] `FeatureFlags` 类型定义 + 默认值
- [ ] 从 config 文件读取 + CLI flag 覆盖
- [ ] 至少 1 个现有功能（如 auto-review）接入 flag 系统
- [ ] 测试覆盖 flag 开关两条路径
- [ ] 文档：`docs/space/execution/active/feature-flags.md`

### 3.2 Golden Tests 基础设施

#### 3.2.1 设计

Golden test = 固定初始状态 + 固定模型输出 + 固定用户操作 → 验证事件序列 + 最终状态。

```
tests/golden/
  fixtures/
    plan-approval.json           # 方案审核：write_plan → review → approve
    plan-revision.json           # 方案审核：write_plan → review → request_revision → revise → approve
    ask-user-option.json         # ask_user：options → select → continue
    ask-user-free-text.json      # ask_user：free_text → input → continue
    auto-review-approve.json     # auto-review：工具请求 → auto-review → approve
    auto-review-escalate.json    # auto-review：工具请求 → auto-review → escalate to human
    tool-chain-read-edit.json    # 工具链：read_file + edit_file
    multi-turn-plan-resume.json  # 多轮：plan approved turn1 → tool execution → turn2 resume
    authorization-change.json    # 授权变更：default → full_access → default
    error-recovery-tool-fail.json # 错误恢复：tool_failed → model retry
```

#### 3.2.2 Fixture 格式

```json
{
  "name": "plan-approval",
  "description": "Model drafts a plan, user approves, plan enters executing state",
  "initialState": {
    "interactionMode": "accept_edits",
    "authorization": "default"
  },
  "modelOutputs": [
    {
      "type": "tool_calls",
      "calls": [
        {
          "id": "call_1",
          "name": "write_plan",
          "args": {
            "action": "submit",
            "plan": {
              "title": "Test Plan",
              "steps": [
                { "description": "Step 1", "status": "pending" },
                { "description": "Step 2", "status": "pending" }
              ]
            }
          }
        }
      ]
    }
  ],
  "userActions": [
    { "type": "approve_plan" }
  ],
  "expectedEvents": [
    "model.requested",
    "model.responded",
    "tool.queued",
    "tool.started",
    "plan.review_requested",
    "plan.approved",
    "tool.finished"
  ],
  "expectedFinalState": {
    "planning.kind": "executing",
    "interactions.kind": "idle"
  }
}
```

#### 3.2.3 实现

**新增文件**：

```
tests/golden/
  run.ts                         — Golden test runner
  helpers.ts                     — createInitialState, mockModel, applyUserActions
  fixtures/
    plan-approval.json
    plan-revision.json
    ask-user-option.json
    ask-user-free-text.json
    auto-review-approve.json
    auto-review-escalate.json
    tool-chain-read-edit.json
    multi-turn-plan-resume.json
    authorization-change.json
    error-recovery-tool-fail.json
```

**Runner 设计**：

```ts
// tests/golden/run.ts — 伪代码

interface GoldenFixture {
  name: string;
  description: string;
  initialState: Partial<RuntimeState>;
  modelOutputs: MockModelOutput[];
  userActions: MockUserAction[];
  expectedEvents: string[];         // event type 名称列表
  expectedFinalState: Record<string, unknown>; // dot-path → expected value
}

async function runGoldenTest(fixture: GoldenFixture) {
  const kernel = new AgentKernel({
    initialState: createInitialState(fixture.initialState),
    modelProvider: createMockModel(fixture.modelOutputs),
  });

  const events: string[] = [];

  // Run until idle or max steps
  for await (const event of kernel.run()) {
    events.push(event.type);

    // Inject user actions at appropriate times
    const action = fixture.userActions.find(a => a.triggerEvent === event.type);
    if (action) {
      kernel.dispatchUserAction(action);
    }
  }

  // Verify events
  for (const expected of fixture.expectedEvents) {
    assert(events.includes(expected), `Expected event ${expected} not found`);
  }

  // Verify final state
  const state = kernel.getState();
  for (const [path, expected] of Object.entries(fixture.expectedFinalState)) {
    const actual = getByPath(state, path);
    assert.deepEqual(actual, expected, `State mismatch at ${path}`);
  }
}
```

#### 3.2.4 验收标准

- [ ] `tests/golden/run.ts` 通用 runner 实现
- [ ] `createMockModel()` mock 模型提供者
- [ ] 至少 5 个 golden fixture（覆盖 plan / ask_user / approval / auto-review / error）
- [ ] `bun test tests/golden/` 可运行，全部通过
- [ ] Golden tests 在 CI / pre-commit 中运行（~2-5s，不应跳过）
- [ ] 文档：`tests/golden/README.md`

---

## 4. Phase 2：FailureKind + AuthorizationState.source（P1，目标 1 周）

这两个改善当前系统的错误处理和安全审计能力。

### 4.1 FailureKind 失败分类系统

#### 4.1.1 设计

```ts
// src/core/runtime/failures.ts

export type FailureKind =
  // 模型层
  | 'model_invalid_tool_args'      // 模型生成了不合法工具参数
  | 'model_refused'                // 模型拒绝执行（safety refusal）
  | 'model_timeout'                // 模型调用超时
  | 'model_rate_limited'           // API 限流
  | 'model_server_error'           // API 服务端错误
  // 策略层
  | 'policy_denied'                // 策略拒绝（如 planning 阶段不允许 shell_execute）
  | 'approval_rejected'            // 用户拒绝审批
  | 'auto_review_rejected'         // auto-review 拒绝
  | 'plan_revision_requested'      // 用户要求修改方案
  // 工具层
  | 'tool_runtime_error'           // 工具执行时出错
  | 'tool_timeout'                 // 工具执行超时
  | 'tool_invalid_args'            // 工具参数不合法（不是模型问题）
  | 'tool_not_found'               // 工具不存在
  // 交互层
  | 'user_input_cancelled'         // 用户取消交互（Esc）
  | 'user_input_timeout'           // 交互超时
  // 系统层
  | 'sandbox_error'                // 沙箱错误
  | 'checkpoint_restore_error'     // checkpoint 恢复失败
  | 'transcript_invariant_error'   // transcript 不变量被打破
  | 'loop_exhausted'               // 循环耗尽
  | 'budget_exceeded'              // 超出预算
  | 'unknown';                     // 未知错误

export interface ClassifiedFailure {
  kind: FailureKind;
  message: string;
  /** 是否可以自动重试 */
  retryable: boolean;
  /** 是否可以交给模型修复 */
  modelFixable: boolean;
  /** 是否需要用户介入 */
  needsUserIntervention: boolean;
  /** 是否应该终止当前 turn */
  terminatesTurn: boolean;
  /** 是否应该写入 execution journal */
  journal: boolean;
}

export function classifyFailure(
  kind: FailureKind,
  message: string,
): ClassifiedFailure {
  // 根据 kind 返回标准化的处理策略
  const strategies: Record<FailureKind, Omit<ClassifiedFailure, 'kind' | 'message'>> = {
    model_invalid_tool_args:    { retryable: true,  modelFixable: true,  needsUserIntervention: false, terminatesTurn: false, journal: true },
    model_refused:              { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    model_timeout:              { retryable: true,  modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: false },
    model_rate_limited:         { retryable: true,  modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: false },
    model_server_error:         { retryable: true,  modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: false },
    policy_denied:              { retryable: false, modelFixable: true,  needsUserIntervention: false, terminatesTurn: false, journal: true },
    approval_rejected:          { retryable: false, modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: true },
    auto_review_rejected:       { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: false, journal: true },
    plan_revision_requested:    { retryable: false, modelFixable: true,  needsUserIntervention: true,  terminatesTurn: false, journal: true },
    tool_runtime_error:         { retryable: true,  modelFixable: true,  needsUserIntervention: false, terminatesTurn: false, journal: true },
    tool_timeout:               { retryable: true,  modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: true },
    tool_invalid_args:          { retryable: false, modelFixable: true,  needsUserIntervention: false, terminatesTurn: false, journal: true },
    tool_not_found:             { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    user_input_cancelled:       { retryable: false, modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: false },
    user_input_timeout:         { retryable: false, modelFixable: false, needsUserIntervention: false, terminatesTurn: false, journal: false },
    sandbox_error:              { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    checkpoint_restore_error:   { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    transcript_invariant_error: { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    loop_exhausted:             { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    budget_exceeded:            { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
    unknown:                    { retryable: false, modelFixable: false, needsUserIntervention: true,  terminatesTurn: true,  journal: true },
  };
  return { kind, message, ...strategies[kind] };
}
```

#### 4.1.2 集成点

将现有 `ToolFailedEvent` 的 `error: string` 替换为 `failure: ClassifiedFailure`：

```ts
export interface ToolFailedEvent {
  type: 'tool.failed';
  toolCallId: string;
  failure: ClassifiedFailure;  // 替代 error: string
  // ...
}
```

并在 `ToolController`、`ModelController` 中使用 `classifyFailure()` 生成标准化的失败事件。

#### 4.1.3 验收标准

- [ ] `FailureKind` 类型 + `classifyFailure()` 函数
- [ ] `ToolFailedEvent.failure` 替代 `error: string`
- [ ] 至少 3 个 controller 中使用 `classifyFailure()`
- [ ] 测试：每种 FailureKind 的策略正确性
- [ ] 文档：`docs/space/execution/active/failure-classification.md`

### 4.2 AuthorizationState.source 授权溯源

#### 4.2.1 设计

扩展现有 `ThreadAuthorizationState`：

```ts
// src/core/types.ts

export type AuthorizationSource = 'user' | 'config' | 'test' | 'system';

export interface ToolGrant {
  workspace: string;
  threadId: string;
  command: string;
  /** 授权来源 */
  source: AuthorizationSource;
  /** 授权时间 */
  grantedAt: string;
  /** 过期时间（可选） */
  expiresAt?: string;
}

export interface ThreadAuthorizationState {
  mode: 'default' | 'full_access';
  /** full_access 的来源 */
  modeSource?: AuthorizationSource;
  /** full_access 的授予时间 */
  modeGrantedAt?: string;
  commandGrants: Record<string, ToolGrant>;
}
```

#### 4.2.2 关键规则

在 `mode-policy.ts` 中强制：

```ts
// 硬规则
if (mode === 'full_access' && !sandboxAvailable) {
  // full mode 必须 sandbox available
  throw new PolicyError('full_access requires sandbox');
}
if (autoReview && grant.source === 'system') {
  // auto-review 不能授予 full_access
  throw new PolicyError('auto-review cannot grant full_access');
}
if (loopMode && mode === 'default') {
  // loop-mode 不能自动提升 authorization
  throw new PolicyError('loop-mode cannot auto-elevate authorization');
}
```

#### 4.2.3 验收标准

- [ ] `AuthorizationSource` 类型 + `ToolGrant.source` 字段
- [ ] `ThreadAuthorizationState.modeSource` / `modeGrantedAt` 字段
- [ ] CLI `--full-access` → source='config'；TUI 用户点击 → source='user'；测试注入 → source='test'
- [ ] mode-policy.ts 中实现 3 条硬规则
- [ ] 测试：各 source 正确设置 + 硬规则拦截
- [ ] 文档：更新 `docs/space/execution/active/authorization.md`（如有）

---

## 5. Phase 3：Replay Tool + ADR + 核心准入标准（P2，目标 1 周）

### 5.1 Replay 回放工具

#### 5.1.1 设计

利用现有的 session-logger JSONL 数据，新增 CLI 命令：

```bash
# 回放某个 thread 的所有 turn
bun run agent trace ~/.kite-code/logs/tui/<threadId>/events.jsonl

# 回放某个具体 turn
bun run agent trace ~/.kite-code/logs/tui/<threadId>/events.jsonl --turn 12

# 输出为结构化 JSON（供 replay test 使用）
bun run agent trace ~/.kite-code/logs/tui/<threadId>/events.jsonl --format json
```

#### 5.1.2 输出格式

```
Turn 1
  ├─ turn.started
  ├─ model.requested
  ├─ model.responded
  ├─ tool.queued (call_1: write_plan)
  ├─ tool.started (call_1)
  ├─ plan.review_requested
  ├─ ── user approved plan ──
  ├─ plan.approved
  ├─ tool.finished (call_1)
  └─ turn.completed

Turn 2
  ├─ turn.started
  ├─ user.message_appended
  ├─ model.requested
  ├─ model.responded
  ├─ tool.queued (call_2: read_file)
  ├─ tool.started (call_2)
  ├─ tool.finished (call_2)
  ├─ model.requested
  ├─ model.responded
  ├─ tool.queued (call_3: edit_file)
  ├─ tool.started (call_3)
  ├─ approval.requested (call_3)
  ├─ ── user approved tool ──
  ├─ approval.granted (call_3)
  ├─ tool.finished (call_3)
  └─ turn.completed
```

#### 5.1.3 实现

**新增文件**：

```
src/app/cli/trace.ts              — trace 命令实现
src/core/session-logger/replay.ts  — JSONL 解析 + 格式化输出
tests/cli/trace.test.ts            — 测试
```

#### 5.1.4 验收标准

- [ ] `bun run agent trace <path>` CLI 命令
- [ ] 支持 `--turn <n>` 筛选单个 turn
- [ ] 支持 `--format json` 结构化输出
- [ ] 彩色终端输出（event type 不同颜色）
- [ ] 测试：覆盖正常 trace / 空文件 / 损坏 JSONL

### 5.2 ADR 架构决策记录

#### 5.2.1 目录结构和模板

```
docs/adr/
  README.md                        — ADR 索引 + 状态说明
  0001-runtime-kernel.md           — Runtime Kernel 架构决策
  0002-plan-lifecycle.md           — PlanningState 替代 planReviewed
  0003-auto-review-policy.md       — auto-review 策略设计
  0005-interaction-state.md        — InteractionState 统一交互
  0006-loop-mode-design.md         — loop-mode 设计（预留）
  template.md                      — ADR 模板
```

#### 5.2.2 ADR 模板

```markdown
# ADR-NNNN: <标题>

**状态**：proposed | accepted | deprecated | superseded
**日期**：YYYY-MM-DD
**决策者**：@chenchao
**替代**：ADR-NNNN（如有）

## 1. 背景

<为什么需要做这个决策？上下文是什么？>

## 2. 决策

<我们决定做什么？>

## 3. 备选方案

<为什么不选其他方案？>

| 方案 | 优点 | 缺点 | 为什么不选 |
|------|------|------|-----------|
| A    | ...  | ...  | ...       |
| B    | ...  | ...  | ...       |

## 4. 影响

<这个决策影响哪些边界？哪些模块？哪些文件？>

## 5. 回滚计划

<如果这个决策需要回滚，怎么做？回滚阈值是什么？>

## 6. 后果

<这个决策带来的正面和负面影响>
```

#### 5.2.3 验收标准

- [ ] `docs/adr/` 目录 + `template.md` 模板
- [ ] 至少 4 个 ADR（runtime-kernel / plan-lifecycle / auto-review-policy / interaction-state）
- [ ] `docs/adr/README.md` 索引
- [ ] 所有后续 ADR 的提交模板

### 5.3 核心准入标准

#### 5.3.1 设计

创建 `docs/space/execution/active/core-entry-criteria.md`，定义新功能进入核心前的分类和门槛：

```markdown
# 核心准入标准

任何进入 `src/core/` 的新功能，先判断属于哪一类：

## 分类

### Capability
普通能力扩展，不改变 runtime 决策方式。
- 示例：web_fetch、Skill、MCP、新工具
- 门槛：可直接接入，需要单测
- 审批：代码 review

### Policy
改变是否审批、是否自动执行、是否继续循环、是否需要计划。
- 示例：auto-mode、plan-mode、loop-mode
- 门槛：必须有单测 + 状态机图 + 文档
- 审批：代码 review + 架构 review

### Lifecycle
改变 plan / tool / turn / approval / user input 的状态流转。
- 示例：新的 InteractionState.kind、新的事件类型
- 门槛：必须有状态机图 + replay 测试 + ADR
- 审批：架构 review

### Engine
改变模型调用、工具循环、checkpoint、resume、stream 行为。
- 示例：native runtime、新执行引擎、checkpoint 格式变更
- 门槛：必须走 feature flag（不能直接替换主路径）+ ADR
- 审批：架构 review + 灰度验证

## 已有功能分类

| 功能 | 分类 | 备注 |
|------|------|------|
| web_fetch | Capability | 已实现 |
| Skill | Capability | 已实现 |
| MCP | Capability | 已实现 |
| auto-mode | Policy + Lifecycle | 已实现，需补 ADR |
| plan-mode | Policy + Lifecycle | 已实现 |
| interaction-mode (full/accept_edits) | Policy | 已实现 |
| Runtime Kernel | Engine | Phase 1-5 已完成 |
| loop-mode | Policy + Lifecycle + Engine | 未实现 |

## 准入检查清单

- [ ] 功能分类确定？
- [ ] 对应门槛满足？（单测/状态机图/replay 测试/ADR）
- [ ] 是否需要 feature flag？
- [ ] 是否影响现有 InteractionState？
- [ ] 是否引入新的 lifecycle 状态？
- [ ] 是否打穿 layer boundary？
- [ ] 是否绕过 policy / authorization？
```

#### 5.3.2 验收标准

- [ ] `docs/space/execution/active/core-entry-criteria.md` 完成
- [ ] 所有现有功能已按分类标记
- [ ] 准入检查清单可供后续使用

---

## 6. Phase 4：文档分层 + 边界检查 + Prompt 契约（P3，目标 1 周）

### 6.1 文档分层

#### 6.1.1 目标结构

```
docs/
  adr/                              ← Phase 3 新建
  active/                           ← 重命名自 execution/active/
    runtime-kernel.md
    runtime-events.md
    plan-lifecycle.md
    interaction-state.md
    tool-lifecycle.md
    failure-classification.md        ← Phase 2
    feature-flags.md                 ← Phase 1
    core-entry-criteria.md           ← Phase 3
    layer-boundary-enforcement.md
    project-conventions.md

  design/                           ← 新建
    native-loop-engine-rfc.md
    mcp-v2-rfc.md
    (未来 design proposals)

  deprecated/                       ← 新建
    old-plan-mode.md
    old-readonly-mode.md
    langgraph-engine.md              ← 移除 LangGraph 的设计记录

  book/                             ← 保留，长篇参考文档
  space/                            ← 保留，项目规划/执行跟踪
    plans/
    understanding/
    backlog/
    references/
```

#### 6.1.2 规则

```markdown
# docs/README.md

## 文档分层规则

- **active/** — 和当前代码一致的文档。代码变更时必须同步更新。
  AI coding 时优先读取此目录。
- **design/** — 讨论未来的设计方案。不保证和当前代码一致。
  实现前需转化为 plans/ 中的实施计划。
- **deprecated/** — 已废弃，**不作为实现依据**。仅保留作为历史参考。
- **adr/** — 架构决策记录。每个重大决策一个文件，编号递增。
- **book/** — 长篇参考文档（教程、技术栈说明）。
- **space/** — 项目规划、执行跟踪、方案设计。
```

#### 6.1.3 验收标准

- [ ] `docs/active/` 目录 + 迁移 `execution/active/` 下所有文件
- [ ] `docs/design/` 目录（初始为空或少量 RFC）
- [ ] `docs/deprecated/` 目录 + 迁移已废弃的设计文档
- [ ] `docs/README.md` 包含分层规则说明
- [ ] 清理 `docs/space/execution/` 的旧 active 目录

### 6.2 边界检查脚本

#### 6.2.1 设计

在 `package.json` 中新增脚本：

```json
{
  "scripts": {
    "check:core-boundary": "bun run scripts/check-core-boundary.ts"
  }
}
```

#### 6.2.2 检查项

```ts
// scripts/check-core-boundary.ts

const CHECKS = [
  {
    name: 'app → core import direction',
    command: 'grep -rn "from.*\'@/core/" src/app/ --include="*.ts" --include="*.tsx"',
    // 允许 app → core，不允许 core → app
  },
  {
    name: 'core → app import (forbidden)',
    command: 'grep -rn "from.*\'@/app/" src/core/ --include="*.ts"',
    expectEmpty: true,
    message: 'core 不允许 import app 层代码',
  },
  {
    name: 'no LangGraph imports',
    command: 'grep -rn "from.*@langchain/langgraph" src/ --include="*.ts"',
    expectEmpty: true,
    message: 'LangGraph 已被移除，禁止重新引入',
  },
  {
    name: 'no direct plan state mutation outside reducer',
    // 检查是否有文件直接修改 RuntimeState.planning（应该通过 reducer）
    command: 'grep -rn "state\\.planning\\s*=" src/core/ --include="*.ts" | grep -v reducer.ts | grep -v state.ts',
    expectEmpty: true,
    message: 'planning state 只能通过 reducer 修改',
  },
  {
    name: 'no bypass policy tool execution',
    // 检查是否有直接调用工具执行而不走 policy
    command: 'grep -rn "executeTool\\|runTool" src/core/ --include="*.ts" | grep -v tool-controller | grep -v tool-runner',
    expectEmpty: true,
    message: '工具执行必须走 ToolController 或 tool-runner',
  },
  {
    name: 'no mode if/else outside policy files',
    command: 'grep -rn "interactionMode\\s*===\\|mode\\s*===" src/core/ --include="*.ts" | grep -v policies/ | grep -v types.ts | grep -v config/',
    expectEmpty: true,
    message: 'mode 判断应集中在 policy 文件中',
  },
  {
    name: 'no UI parsing runtime internals',
    command: 'grep -rn "LangGraph\\|checkpoint\\|Channel" src/app/ --include="*.ts" --include="*.tsx"',
    expectEmpty: true,
    message: 'TUI 不应直接解析 runtime 内部数据结构',
  },
];
```

#### 6.2.3 验收标准

- [ ] `scripts/check-core-boundary.ts` 脚本实现
- [ ] `bun run check:core-boundary` 命令可用
- [ ] 集成到 lefthook pre-commit
- [ ] 当前代码库零违规（或记录已知例外）

### 6.3 Prompt 契约治理

#### 6.3.1 设计

在 `src/core/prompts/` 下建立治理结构：

```
src/core/prompts/
  system-prompt.txt                     # 现有文件
  contract.md                           # 行为契约
  tests/
    plan-drafting.test.ts               # 复杂任务应先 read/search 再 write_plan
    plan-execution.test.ts              # plan approved 后不应重复输出 plan summary
    ask-user.test.ts                    # 模糊需求应 ask_user
    no-ask-user-in-full-mode.test.ts    # full mode 不应 ask_user
```

#### 6.3.2 契约内容

```markdown
# Prompt Contract

## 模型行为约束

### Plan 生命周期
- [ ] 复杂任务必须先 read/search 再 write_plan
- [ ] plan approved 后必须进入 building phase，不应重复输出 plan summary
- [ ] plan rejected 时必须等待用户新的 write_plan
- [ ] update_plan 只能用于进度更新，不能用于结构性变更
- [ ] 结构性变更必须先请求 plan review

### Ask User
- [ ] 模糊需求（缺少关键参数）应 ask_user
- [ ] full mode 不应 ask_user（用户已授权全自动执行）
- [ ] ask_user 必须是 2-4 个选项或自由文本，不能两者都没有
- [ ] ask_user options 必须有清晰的标签和描述

### Approval
- [ ] destructive shell（rm -rf, sudo, chmod 777 等）必须请求审批
- [ ] network access 工具在 default mode 下必须请求审批
- [ ] VCS mutation（git push --force, hard reset 等）必须请求审批
- [ ] 不能主动请求 full_access 提升

### Shell Execute
- [ ] intent='inspect' 只用于只读命令
- [ ] 不允许在 planning 阶段执行非只读 shell 命令
- [ ] 不允许绕过 sandbox 执行命令
```

#### 6.3.3 验收标准

- [ ] `src/core/prompts/contract.md` 完成
- [ ] 至少 3 个 prompt contract test（mock model 验证行为）
- [ ] Prompt 变更时必须同步更新 contract.md
- [ ] 文档：说明如何添加新的 contract rule

---

## 7. 实施顺序与依赖

```
Phase 1（P0，2 周）
  ├─ Feature Flag 系统
  │   └─ 无依赖，可直接开始
  └─ Golden Tests 基础设施
      └─ 依赖 Runtime Kernel 稳定

Phase 2（P1，1 周）
  ├─ FailureKind 系统
  │   └─ 依赖 Phase 1 Feature Flag（可选择新旧路径）
  └─ AuthorizationState.source
      └─ 无依赖，可直接开始

Phase 3（P2，1 周）
  ├─ Replay Tool
  │   └─ 依赖 session-logger 已有数据
  ├─ ADR
  │   └─ 无依赖，可直接开始（补写历史决策）
  └─ 核心准入标准
      └─ 无依赖，可直接开始

Phase 4（P3，1 周）
  ├─ 文档分层
  │   └─ 依赖 ADR 目录已建立
  ├─ 边界检查脚本
  │   └─ 无依赖，可直接开始
  └─ Prompt 契约治理
      └─ 依赖 Golden Tests 基础设施（prompt contract test 复用 golden 模式）
```

## 8. 不在此方案范围内

以下事项有意不做：

| 事项 | 原因 |
|------|------|
| Runtime DevTools（`bun run agent inspect`） | 当前 CheckpointSelector（`/rewind`）已提供基本状态查看，完整 DevTools 延后到 loop-mode 实现后 |
| 工具 Schema Version（`toolSchemaVersion`） | 当前工具定义通过 Zod schema 已有类型安全，版本化需求不紧迫 |
| Controller 拆分（ApprovalController 等独立文件） | `tool-controller.ts` 当前功能正确，拆分是代码组织优化，不改变行为 |
| RuntimeBudget 资源预算系统 | 当前无自主多轮执行（loop-mode 未实现），单 turn 内资源消耗天然受限。已有 `maxEffects` + `doomLoopRepeatThreshold` + 断路器提供基本防护。延后至 loop-mode 方案作为前置条件 |
| loop-mode 实现 | 属于功能开发，不在护栏建设范围内 |
| CI/CD 集成 | Golden tests 在 pre-commit 中运行即可，CI 延后到有 CI 环境后 |

## 9. 风险

| 风险 | 缓解 |
|------|------|
| Golden tests 维护成本高 | 只覆盖核心状态流转（10 个 fixture），不覆盖 UI 渲染 |
| Feature flags 增加代码分支 | 每个 flag 有明确生命周期（默认 false → 默认 true → 删除旧路径），不永久保留 |
| ADR 写完后不被维护 | ADR 是历史记录不修改，新决策写新 ADR + 标记旧 ADR 为 superseded |
| 文档分层后旧链接失效 | 在旧位置保留重定向说明至少 2 周 |
