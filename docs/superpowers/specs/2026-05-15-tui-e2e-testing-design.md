# TUI E2E Testing Framework Design

## 动机

TUI 开发过程中频繁遇到渲染、交互、Agent 行为、状态管理等多类问题。这些问题难以口头描述（不像 Web E2E 可以截图对比），需要一套可录制、可回放、可 diff 的 TUI E2E 测试框架。

核心目标：**让 Code Agent 在测试失败后，能直接从 diff 定位到源码并自动修复。**

## 设计原则

- **一场景一测试**：每个 E2E 测试对应一个完整的用户交互场景
- **仅断点 snapshot**：不在 Agent 输出过程中逐帧拍摄，只在"等待用户操作"和"终态"两个时刻拍快照
- **双重快照**：每个 snapshot 包含 ANSI 文本（肉眼审查）和 reducer state JSON（Agent 自动修复用）
- **Mock 优先**：测试不依赖真实 LLM，用预置的 Agent 行为序列模拟

## 目录结构

```
tests/e2e/
├── mock-agent.ts                 # 核心：runTuiE2E(scenario) → { snapshots, pass }
├── scenarios/
│   ├── approval-flow.ts          # 场景定义（steps 数组）
│   ├── file-edit-question.ts
│   └── ...
├── fixtures/
│   ├── approval-flow/
│   │   ├── 001.ansi              # ANSI 快照
│   │   ├── 001.state.json        # reducer state 快照
│   │   ├── 002.ansi
│   │   └── 002.state.json
│   └── file-edit-question/
│       └── ...
├── approval-flow.test.ts         # 测试入口
└── file-edit-question.test.ts
```

## 核心概念

### Scenario（场景定义）

每个场景是一个 `.ts` 文件，导出一个 `Scenario` 对象：

```ts
export interface Scenario {
  /** 终端宽度（列数），固定以确保跨环境一致 */
  terminalWidth: number;
  /** Agent 行为步骤序列 */
  steps: Step[];
  /** 单步超时（ms），默认 5000 */
  stepTimeout?: number;
  /** 动态值冻结列表，这些值在 snapshot 中会被替换为占位符 */
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount">;
}
```

### Step（步骤类型）

```ts
type Step =
  | { type: "agent-text"; text: string }
  | { type: "tool-call"; tool: string; args: unknown }
  | { type: "tool-result"; output: string }
  | { type: "agent-reason"; text: string }
  | { type: "agent-done" }
  | { type: "user-action"; action: UserAction }
  | { type: "user-input"; text: string }
  | { type: "expect-mode"; mode: "approval" | "question" }
      // 等待 TUI 进入指定模式，进入后自动 snapshot
  | { type: "assert-snapshot" }
      // 显式 snapshot（用于终态或非标准断点）
```

### Snapshot（快照）

```ts
interface Snapshot {
  /** 序号，从 1 开始 */
  index: number;
  /** 快照的原因 */
  reason: "approval-wait" | "question-wait" | "terminal" | "explicit";
  /** 原始 ANSI 转义文本（冻结了动态值） */
  ansi: string;
  /** reducer state 的 JSON 快照（冻结了动态值） */
  state: Record<string, unknown>;
}
```

### 自动 Snapshot 触发规则

TUI 在以下两种时刻自动触发 snapshot：

1. **交互断点**：TUI 的 InputLine mode 变为 `approval` / `question` / `awaiting-input`
2. **终态**：Agent 停止运行，TUI 回到 `prompt` 模式且 agent 未在执行

此外，`assert-snapshot` step 允许测试编写者显式请求 snapshot。

### 动态值冻结

以下值在 snapshot 前被替换为固定占位符：

| 字段 | 占位符 | 影响范围 |
|------|--------|---------|
| Timer 显示 | `<TIMER>` | StatusBar, Footer |
| 时间戳 | `<TIMESTAMP>` | Header, StatusBar |
| Cache 命中率 | `<CACHE_HIT_RATE>` | StatusBar |
| Cache Token 数 | `<CACHE_TOKEN_COUNT>` | StatusBar |
| 日期 | `<DATE>` | Header |

冻结逻辑在 mock-agent 中实现，操作 ANSI 文本和 state JSON 中的对应字段。

## 核心模块

### `mock-agent.ts`

```
runTuiE2E(scenario: Scenario) → Promise<{ snapshots: Snapshot[]; pass: boolean }>
```

职责：
1. 设置 `process.env.OPENPX_MOCK = "true"`，以 mock 模式渲染 TUI App
2. 设置 `process.stdout.columns = scenario.terminalWidth`
3. 用 `ink-testing-library` 的 `render()` + `stdin.write()` 注入 step
4. `expect-mode` step：等待 TUI 进入指定 mode，自动 snapshot
5. `assert-snapshot` step：立即 snapshot 当前帧
6. 冻结动态值后保存 ANSI 和 state JSON 到 fixtures 目录
7. 逐个 step 执行，step 超时则失败并返回 `pass = false`

返回值 `pass`：`true` 表示所有 step 执行完毕且无超时/异常。snapshot 比对由测试用例自行通过 `expect` 完成。

mock 模式要求：
- Agent 不发起真实 LLM 请求
- Agent 不创建真实文件/运行真实 shell 命令
- TUI 的定时器、日期等动态组件在 snapshot 前替换为 `<TIMER>` `<DATE>` 占位符

### 测试入口

```ts
import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import { approvalFlow } from "./scenarios/approval-flow";

describe("approval flow", () => {
  test("snapshots match", async () => {
    const { snapshots, pass } = await runTuiE2E(approvalFlow);
    expect(pass).toBe(true);
    // 附加快照断言，Bun 的 toMatchSnapshot 可以用于 ANSI
  });
});
```

### Snapshot 更新

使用 Bun 内置的 `--update-snapshots` 标志：`bun test tests/e2e/ --update-snapshots`

## 失败输出格式

当测试失败时，输出应该是：

```
✗ approval-flow > snapshot[0] changed

── diff: fixtures/approval-flow/001.state.json ──
  blocks[2].grant: "approve_once" → "approve_always"
  blocks[2].risk: "high" → "low"

── diff: fixtures/approval-flow/001.ansi ──
-┌ Approve ──────────┐
-│ [A]pprove once    │ ← red
+┌ Approve ──────────┐
+│ [A]pprove always  │ ← yellow
```

- `state.json` diff 直接指向变更发生的组件字段，Agent 据此定位源码
- `ansi` diff 提供肉眼可读的终端外观对比

## 与现有测试的关系

| 测试层 | 文件 | 用途 |
|--------|------|------|
| 组件单元测试 | `tui-layout.test.tsx` | 验证每个组件独立渲染 |
| 交互单元测试 | `tui-interaction.test.tsx` | 验证键盘输入处理 |
| Reducer 测试 | `tui-reducer.test.ts` | 验证状态迁移逻辑 |
| Provider 测试 | `tui.test.ts` | 验证事件/动作桥接 |
| **E2E 测试（新）** | `tests/e2e/*.test.ts` | 验证完整交互流程的终端输出 |

E2E 测试是顶层的集成验证。单元测试仍然保留，用于快速定位组件级回归。

## 实施约束

1. **不修改 TUI 源码的行为逻辑**，只通过 mock 模式注入 Agent 行为
2. mock 模式通过环境变量 `OPENPX_MOCK=true` 或类似机制标志
3. 固定终端宽度：在 `runTuiE2E` 中设置 `process.stdout.columns = scenario.terminalWidth`
4. Step 超时：每个 step 用 `Promise.race` 包裹，超时后返回失败结果并标记 `pass = false`
5. ANSI 文本生成：通过 `ink-testing-library` 的 `lastFrame()` 获取

## 未来扩展

- **录制模式**：允许真人操作 TUI 录制 step 序列 + snapshot，自动生成 scenario fixture
- **真实模型场景**：`--model real` 模式连真实 LLM 做一拨回归（慢，需手工审）
- **多场景编排**：多个 scenario 串联成完整工作流
