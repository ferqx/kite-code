# 交互模式 /mode 快捷指令

状态：completed
创建：2026-07-02
关联方案：`docs/space/plans/2026-06-30-approval-execution-sandbox.md`（阶段四：无人值守自动审核）

## 变更概要

将审批交互模式从仅 CLI/配置文件可设，扩展为 TUI 内 `/mode` 快捷指令可随时切换，并重新设计审批确认面板。

## 命名变更

| 旧 | 新 | 含义 |
|----|-----|------|
| `interactive` | `ask` | 每次工具调用都需要用户审批 |
| `auto_review` | `auto` | 模型自动审核，不确定时询问 |
| `unattended` | —（移除，合并到 full） | — |
| —（新增） | `full` | 完全自主，全部放行 = autonomous + full_access |

## 核心改动

### 协议层

- `src/protocol/events.ts` — 新增 `InteractionMode` 常量对象 + `isFullAccessMode()` 判断函数
- 规则：禁止裸字符串比较，统一使用 `InteractionMode.Ask/Auto/Full`

### 核心层

- **审批节点** (`graph.ts`)：`full` 模式等同于 `full_access`，自动签发 Permit；`auto` 模式走自动审核；子 agent 审批拒绝修复死循环
- **路由** (`routes.ts`)：`full` 模式 `ask_user` 路由到 tools（不挂起）
- **执行层** (`tool-runner.ts`)：`full` 模式拒绝 `ask_user` 时返回 `FULL_NO_USER_INTERACTION` replan
- **状态** (`state.ts`)：`interactionMode` 注解使用 `InteractionMode` 类型
- **Fork** (`runner.ts`)：继承源 session 的 `interactionMode`

### TUI 层

- **`/mode` 快捷指令** — 支持 `ask/auto/full` + 简写 `a/f`，无参循环切换
- **`SET_INTERACTION_MODE` reducer** — full 时自动联动 `full_access` 授权
- **审批面板重设计** — Yes（仅本次）/ Auto（切自动审批）/ Full（切完全权限）/ Deny
- **状态栏** — 非默认模式显示 `[自动审批]` / `[完全权限]`，默认 ask 无标签
- **移除 `/auth`** — 功能合并到 `/mode full`
- **移除 `── File Changes ──`** — 文件变更由 tool_card 独立展示

### CLI

- `--interactive` → `--ask`，`--auto-review` → `--auto`，`--unattended` 移除
- 新增 `--full` 标志

## 设计决策

- **模式枚举常量**：`InteractionMode` 使用 `as const` 对象 + 派生 type，杜绝裸字符串
- **full = autonomous + full_access**：`/mode full` 同时设置交互模式和授权模式
- **审批面板联动**：按 `Full` 自动切换 `/mode full`；按 `Auto` 自动切换 `/mode auto`
- **Windows 不限制 full**：不做沙箱降级，用户自主选择

## 测试覆盖

| 文件 | 测试数 | 覆盖 |
|------|--------|------|
| `tests/execution/reviewer.test.ts` | 30 (+26) | config 校验、CLI 解析、路由、auto-review、autoReviewConfig、执行层拒绝 |
| `tests/tui-reducer.test.ts` | +7 | SET_INTERACTION_MODE + toggle + auth 联动 |
| `tests/tui-slash-command.test.ts` | +8 | /mode 解析（含简写 a/f/au） |
| `tests/e2e/interaction-mode.test.tsx` | +4 | StatsLine 标签显示 |
| `tests/tui-layout.test.tsx` | +3 | 新标签断言 |
| `tests/graph.test.ts` | baseState | interactionMode = 'ask' |

## 关联规则

- `docs/space/execution/active/project-conventions.md` — 模式枚举常量规则
