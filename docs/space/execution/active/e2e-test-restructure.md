# 方案：E2E 测试用例体系重构

状态：active
创建：2026-05-25

## 背景

当前 `tests/e2e/startup.test.tsx` 有 13 个测试，覆盖基础启动、消息发送/响应、多轮对话、会话切换等 happy path，但在实际体验中仍发现大量问题（如 P0: agentLoopActive 时序、SET_SESSIONS 覆盖 blocks、Kitty 键盘协议方向键解析错误）。

根据 `docs/space/execution/active/tui-e2e-standards.md` 规范中的 Bug 修复必须通过 e2e 快照验证原则，需要将 e2e 测试从"基础链路验证"升级为"全面交互场景覆盖"。

## 目标

- 覆盖从单个按键到多步骤工作流的完整交互频谱
- 按 P0-P3 优先级分层，P0 严防历史回归，P1-P3 覆盖常规到极端场景
- 新增响应分配器解决模型响应顺序管理痛点
- 增强 test harness 支持审批流、浮层、多会话等复杂交互测试
- 配套补充 unit test 中缺失的 reducer action 覆盖

## 文件结构

```
tests/e2e/
├── render-tui.tsx              # 增强：新增审批/浮层/状态检测辅助方法
├── response-plan.ts            # 新增：响应分配器
├── startup.test.tsx            # 重构：P0 核心回归防护（~18 tests）
├── interaction.test.tsx        # 新增：P1 关键用户工作流（~28 tests）
├── advanced.test.tsx           # 新增：P2+P3 高级交互 + 集成场景（~25 tests）
├── types.ts                    # 不变
└── freeze.ts                   # 不变

tests/
├── tui-reducer.test.ts         # 补充：~20 个新测试覆盖缺失的 42 种 action
└── tui-layout.test.tsx         # 不变（已有较完整覆盖）
```

## 测试分层

### P0 — 核心回归防护（~18 个测试，文件：`startup.test.tsx`）

历史上出过 P0 bug 的链路 + 中断/取消这类一旦出错就不可用的场景：

| # | 场景 | 检测回归 |
|---|------|---------|
| 1 | 启动 → 渲染不崩溃（已有） | TDZ、导入失败 |
| 2 | 启动 → 自动创建会话（已有） | SessionManager 未初始化 |
| 3 | 发送消息 → 用户消息块出现（已有） | handleInput 未调用 |
| 4 | 发送消息 → Agent 响应出现（已有） | runTask→runAgent 链路 |
| 5 | 发送消息 → 恢复 idle（已有） | 状态机恢复 |
| 6 | 会话 A 发消息 → 切到 B → 切回 A → 消息历史仍在 | SET_SESSIONS 覆盖 blocks + SWITCH_SESSION 不回存（P0 已踩坑） |
| 7 | 新建会话 → Sidebar ● 指向新会话 → 发消息 → 消息写入新会话 | activeSessionId 未同步 |
| 8 | Tab → UpArrow → DownArrow → Enter 完整序列 | Kitty 协议方向键解析为 Enter（P0 已踩坑） |
| 9 | 发送消息但 Agent 静默不执行 | agentLoopActive 时序错误（P0 已踩坑） |
| 10 | Agent 运行中 Ctrl+C → 恢复 idle → 可继续输入 | 中断链路、abortController |
| 11 | Ctrl+C 双击退出（非运行态） | exitRequested 连锁 |
| 12 | Escape 多层状态级联行为（浮层→leader→中断→运行→空闲） | ESCAPE reducer 优先级 |
| 13 | 模型错误 → TUI 不挂死（已有） | 错误处理链路 |
| 14 | Tool call 渲染（已有） | tool_card block |
| 15 | 多轮对话（已有） | _callCount 共享 |
| 16 | 退出摘要（已有） | exit summary |
| 17 | 多会话计数（已有） | NEW_SESSION |
| 18 | 会话切换 + 消息历史加载（已有） | 方向键+Enter 全链路 |

### P1 — 关键用户工作流（~28 个测试，文件：`interaction.test.tsx`）

用户每次使用必然涉及的完整操作闭环：

**工具审批闭环（4 tests）**：
| # | 场景 |
|---|------|
| 19 | Agent 调用需审批工具 → `[A/S/F/D]` 审批块出现 → 用户按 A 批准 → 工具执行 → tool_card done |
| 20 | Agent 调用工具 → 审批块出现 → 用户按 D 拒绝 → tool_card 标记 error/cancelled |
| 21 | Agent 调用工具 → 审批块出现 → 用户按 S 跳过 → 工具不执行 |
| 22 | Ctrl+R 切换到 full_access → 工具调用自动通过 → 不出现审批块 |

**Agent 提问闭环（2 tests）**：
| 23 | Agent 调用 ask_user → 问题块出现（含选项）→ 用户输入选择 → Agent 继续 |
| 24 | 问题等待中按 Esc 取消 → interrupt 清除 |

**Slash 命令全量（10 tests）**：
| 25-34 | /help, /model, /model list, /model <name>, /plan, /auth, /clear, /thinking, /sessions, /new |

**Slash 建议下拉交互（5 tests）**：
| 35-39 | 输入 `/` 触发 → ↑↓ 导航 → Tab 补全 → Enter 提交 → Esc 关闭 |

**@文件搜索交互（4 tests）**：
| 40-43 | 输入 `@` 触发 → ↑↓ 导航 → Tab/Enter 选择 → Esc 关闭 |

**Sidebar 焦点切换（3 tests）**：
| 44-46 | Tab 切到 Sidebar → 显示 "Sidebar focused" → Tab 再切回 → 焦点在 Sidebar 时普通字符不进入输入框 |

### P2 — 重要交互模式（~15 个测试，文件：`advanced.test.tsx`）

**Input 高级交互（5 tests）**：
| 47-51 | Shift+Enter 换行 → 多行提交 / 历史导航 ↑↓ / 粘贴 >100 字符占位 / Esc 清除占位 / 空输入拒绝 |

**Leader Keys（5 tests）**：
| 52-56 | Ctrl+X c 压缩 / Ctrl+X m 模型选择器 / Ctrl+X l 会话列表 / 无效键取消 / Esc 取消 |

**Global Shortcuts（5 tests）**：
| 57-61 | Ctrl+L 清屏 / Ctrl+N 新会话 / Ctrl+R 切换 auth / Ctrl+T 折叠推理 / Ctrl+H 帮助面板 |

### P3 — 复杂多步骤集成场景（~10 个测试，文件：`advanced.test.tsx`）

| 62-71 | Checkpoint revert/fork / 多会话并发 / 中断跨会话保留 / /clear 后重新对话 / 思考模式切换 / Sidebar 虚拟窗口 overflow / 会话状态指示器 ⏳⚠ / 连续快速操作 / 超长输出不崩溃 |

## Test Harness 增强

### 新增 TuiHarness 方法

```typescript
// 审批流
waitForApproval(timeout?: number): Promise<void>
approve(key: "A" | "S" | "F" | "D"): Promise<void>

// Agent 提问
waitForQuestion(timeout?: number): Promise<void>
answerQuestion(text: string): Promise<void>

// 浮层检测
waitForOverlay(name: string, timeout?: number): Promise<void>
waitForOverlayGone(name: string, timeout?: number): Promise<void>

// 状态查询
getAuthMode(): "default" | "full_access" | null
isSidebarFocused(): boolean
getSidebarSelection(): number | null
```

### 响应分配器（`response-plan.ts`）

```typescript
class ResponseAllocator {
  // 声明该测试组需要的响应数量，返回起始索引
  allocate(group: string, count: number): number
  // 测试结束后校验所有响应被消费
  verifyAllConsumed(): void
}
```

## 配套单元测试补充

`tests/tui-reducer.test.ts` 需新增约 20 个测试，覆盖当前缺失的 action：

| Action | 说明 |
|--------|------|
| `LOAD_SESSION` | 重置 nextId、合并 blocks/interrupt/status |
| `COMPACT_CONTEXT` | 运行中/非运行中分支 |
| `LEADER_PENDING` / `LEADER_CANCEL` | 标志位切换 |
| `SHOW_SESSIONS` / `HIDE_SESSIONS` | 开关 |
| `SHOW_REWIND` / `HIDE_REWIND` / `SET_CHECKPOINTS` | checkpoint 回退 |
| `SHOW_MCP` / `HIDE_MCP` / `INJECT_MCP_PROMPT` | MCP 面板 |
| `EXPORT_SESSION` | 导出功能 |
| `REVERT_TO_CHECKPOINT` / `FORK_FROM_CHECKPOINT` | rewind 核心 |
| `Event.error` 设置 `sessionError` | 非可恢复错误标记 |
| `SET_SESSIONS` 新增 session（不在 existing 中） | merge 边界 |

## 验证

```bash
bun test tests/e2e/            # 全部 e2e
bun test tests/e2e/startup.test.tsx   # 仅 P0
bun test tests/e2e/interaction.test.tsx  # 仅 P1
bun test tests/e2e/advanced.test.tsx    # 仅 P2+P3
bun test tests/tui-reducer.test.ts      # reducer unit
bun test                           # 全量回归
```

## 执行顺序

1. 新增 `response-plan.ts`
2. 增强 `render-tui.tsx`（新增 harness 方法）
3. 重构 `startup.test.tsx`（P0 测试）
4. 新增 `interaction.test.tsx`（P1 测试）
5. 新增 `advanced.test.tsx`（P2+P3 测试）
6. 补充 `tui-reducer.test.ts`（缺失 action 覆盖）
7. `bun test` 全量回归
