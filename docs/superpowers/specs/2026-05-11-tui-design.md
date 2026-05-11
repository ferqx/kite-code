# TUI Design Spec

> Status: draft | Date: 2026-05-11
> Ref: `docs/space/understanding/2026-05-11-three-layer-architecture-design.md`

## 1. Overview

为 openpx 添加终端 UI（TUI）模块，作为三层架构中 `src/app/` 层的第二个渲染适配器。使用 React Ink 实现，替换当前 CLI headless 模式的 NDJSON 输出 + stdin 交互。

### 1.1 目标

- 流式渲染 Agent 输出（Markdown、推理过程、工具调用卡片）
- 交互式中断处理（审批弹窗、提问弹窗）
- 全局状态栏（phase / plan 进度 / token 用量）
- 多会话管理
- 快捷键和主题

### 1.2 非目标（V1）

- 桌面端 GUI（留待未来 `src/app/desktop/`）
- 远程 Web 访问
- 插件系统

## 2. Architecture

```
src/app/
├── cli/index.ts          # 现有 CLI（headless，NDJSON 输出）
├── tui/                   # 新增：React Ink TUI
│   ├── index.tsx          # 入口：mount TUI → 创建 provider → 调用 runAgent
│   ├── provider.ts        # TuiUserInputProvider 实现
│   ├── App.tsx            # 根组件：布局分发
│   ├── OutputArea.tsx     # 主输出区：流式文本 + 推理折叠
│   ├── ToolCard.tsx       # 工具调用卡片
│   ├── DiffPreview.tsx    # edit_file / write_file diff 预览
│   ├── ApprovalDialog.tsx # 审批弹窗
│   ├── InputDialog.tsx    # 提问弹窗
│   ├── StatusBar.tsx      # 全局状态栏
│   ├── SessionList.tsx    # 会话列表
│   ├── theme.ts           # 主题配色
│   └── types.ts           # TUI 内部类型
```

### 2.1 Data Flow

```
                  ┌──────────────────┐
                  │   runAgent()     │  src/core/runner.ts
                  │   (AsyncGenerator)│
                  └──────┬───────────┘
                         │ AgentEvent (yield)
                         ▼
              ┌──────────────────────┐
              │ TuiUserInputProvider │  src/app/tui/provider.ts
              │  .onEvent(event)     │──▶ dispatch to Ink state
              │  .requestAction(p)   │◀── wait for user input
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   React Ink App      │  src/app/tui/App.tsx
              │   ┌───────────────┐  │
              │   │ OutputArea    │  │  流式文本 + 推理
              │   │ ToolCard[]    │  │  工具执行状态
              │   │ DiffPreview   │  │  文件变更预览
              │   │ Dialog overlay│  │  审批/提问弹窗
              │   │ StatusBar     │  │  底部状态栏
              │   │ SessionList   │  │  侧栏（可选）
              │   └───────────────┘  │
              └──────────────────────┘
```

### 2.2 TuiUserInputProvider

```typescript
class TuiUserInputProvider implements UserInputProvider {
  private dispatch: (event: AgentEvent) => void;
  private resolveAction?: (action: UserAction) => void;

  constructor(dispatch: (event: AgentEvent) => void) {
    this.dispatch = dispatch;
  }

  onEvent(event: AgentEvent): void {
    this.dispatch(event);  // 推入 Ink 状态树
  }

  async requestAction(payload: InterruptPayload): Promise<UserAction> {
    // 阻塞等待用户在弹窗中操作
    return new Promise((resolve) => {
      this.resolveAction = resolve;
      this.dispatch({ type: "__ui_interrupt__", payload } as any);
    });
  }
}
```

## 3. View Layers

### 3.1 主输出区（OutputArea）

**事件消费：** `text`, `reason`

- Markdown 渲染：标题、列表、代码块（着色）
- `reason` 事件默认折叠为 `▶ Thinking...`，可展开
- 自动滚动到最新输出
- 保留历史缓冲区（可回看）

### 3.2 工具执行面板（ToolCard / DiffPreview）

**事件消费：** `tool_call`, `tool_done`, `file_change`

- `tool_call` → 创建卡片，显示工具名 + 参数摘要，状态：`⏳ running`
- `tool_done` → 更新卡片，成功 `✓` / 失败 `✗`，展开可看输出摘要
- `file_change` → inline diff 预览（+ 绿色 / - 红色）
  - 协议已有 `file_change` 类型，但 `chunkToEvents` 未发射，需补齐
- 多个卡片垂直排列，完成后可折叠

### 3.3 中断弹窗

**事件消费：** `need_approval`, `need_input`

审批弹窗（ApprovalDialog）：
- 命令原文高亮
- 风险等级标签（颜色区分：read=蓝, write_file=黄, destructive=红）
- 摘要描述
- 选项按钮：`[A]pprove once` `[S]ame command` `[F]ull access` `[R]eject`

提问弹窗（InputDialog）：
- 问题文本
- 选项列表（方向键选择 + Enter 确认）
- 自由文本输入框（支持 allow_free_text 时启用）

### 3.4 全局状态栏（StatusBar）

**事件消费：** `state_change`, `cache_metrics`

- 左侧：Phase（planning / building）+ Plan 进度（N/M steps）
- 中间：Auth 模式（default / full_access）
- 右侧：Token 用量（hit rate %，总消耗）
- 固定于终端底部

## 4. Cross-cutting

### 4.1 会话管理（SessionList）

- 左侧面板（Tab 或快捷键切换）
- 显示历史 thread ID 列表 + 最后任务描述
- 切换 thread 后重新 mount runAgent（新 session）
- thread 元数据存本地 JSON（`~/.openpx/sessions.json`）

### 4.2 快捷键

| 键 | 功能 |
|----|------|
| `↑↓` | 选项/列表导航 |
| `Enter` | 确认选择 |
| `Esc` | 取消/关闭弹窗 |
| `Ctrl+C` | 退出（含确认） |
| `Tab` | 切换面板焦点 |

### 4.3 主题（theme.ts）

```typescript
interface Theme {
  primary: string;      // 主色调
  success: string;      // 成功 ✓
  error: string;        // 失败 ✗
  warning: string;      // 警告
  muted: string;        // 次要文本
  bg: string;           // 背景
  // risk 颜色
  risk: Record<ToolRisk, string>;
}

const darkTheme: Theme = { ... };
const lightTheme: Theme = { ... };
```

环境变量 `OPENPX_THEME=light|dark` 或配置文件控制。

## 5. Protocol Gaps to Fill

### 5.1 `file_change` 事件发射（runner.ts）

`file_change` 类型已在 `src/protocol/events.ts:12` 定义：

```typescript
{ type: "file_change"; data: { path: string; kind: "add" | "edit" | "delete" } }
```

需要在 `chunkToEvents` 中增加检测逻辑：
- 检测 `write_file` / `edit_file` tool 调用中的 path 参数
- 在 `tool_done` ok=true 后发射对应的 `file_change` 事件

### 5.2 会话元数据存储

新增 `~/.openpx/sessions.json`：
```json
{
  "sessions": [
    { "threadId": "xxx", "task": "...", "workspace": "...", "updatedAt": "..." }
  ]
}
```

由 TUI 层管理（不侵入 core），通过 `runAgent` 的 `threadId` 参数关联。

## 6. File Changes Summary

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/app/tui/index.tsx` | 新增 | 入口 |
| `src/app/tui/provider.ts` | 新增 | TuiUserInputProvider |
| `src/app/tui/App.tsx` | 新增 | 布局根组件 |
| `src/app/tui/OutputArea.tsx` | 新增 | 流式输出 |
| `src/app/tui/ToolCard.tsx` | 新增 | 工具卡片 |
| `src/app/tui/DiffPreview.tsx` | 新增 | diff 预览 |
| `src/app/tui/ApprovalDialog.tsx` | 新增 | 审批弹窗 |
| `src/app/tui/InputDialog.tsx` | 新增 | 提问弹窗 |
| `src/app/tui/StatusBar.tsx` | 新增 | 状态栏 |
| `src/app/tui/SessionList.tsx` | 新增 | 会话列表 |
| `src/app/tui/theme.ts` | 新增 | 主题 |
| `src/app/tui/types.ts` | 新增 | 内部类型 |
| `src/core/runner.ts` | 修改 | `file_change` 事件发射 |
| `package.json` | 修改 | 添加 `react` + `ink` 依赖 + `tui` 脚本 |
| `tsconfig.json` | 修改 | JSX 配置（如需要） |

## 7. Testing

### 7.1 单元测试

- `TuiUserInputProvider` 的行为测试（不依赖 Ink）
- 事件分发逻辑测试

### 7.2 集成测试

- 使用 `FakeChatModel` 跑完整 `runAgent → TUI Provider` 链路
- 验证 `file_change` 事件正确发射
- 使用 `bun test` 框架，测试文件 `tests/tui.test.ts`

### 7.3 E2E 测试

- 真实模型测试：复用现有 `real-agent.real.ts` 中的测试场景
- 但通过 TUI Provider 而非 test provider 执行
- 验证 DiffPreview 在真实 write_file/edit_file 场景下渲染正确

## 8. Implementation Phases

| Phase | 范围 | 预估 |
|-------|------|------|
| P1 | 框架搭建：Ink 集成 + Provider + App 骨架 + StatusBar | 基础跑通 |
| P2 | 主输出区：OutputArea + ToolCard + 流式渲染 | 核心体验 |
| P3 | 中断弹窗：ApprovalDialog + InputDialog | 完整交互 |
| P4 | Diff 预览 + file_change 协议补齐 | 差异化能力 |
| P5 | 会话管理 + 主题 + 快捷键 | 产品化 |
