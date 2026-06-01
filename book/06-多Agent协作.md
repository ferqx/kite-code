# 第六章 核心层：多 Agent 协作

## 6.1 设计目标

| 场景 | 说明 |
|------|------|
| 并行执行 | 一个任务拆成多个子任务，不同子 agent 同时工作 |
| 角色分工 | 不同 agent 有不同专长和能力边界 |
| 长任务自治 | agent 可脱离用户交互在后台持续运行 |

### 明确不做

| 不做 | 理由 |
|------|------|
| 多 Agent 协作（peer-to-peer） | 工程复杂度远超收益 |
| 自定义 Agent 配置 | 先用内置固定角色验证稳定性 |
| 子 Agent 嵌套（depth > 0） | 防止无限递归派生 |

## 6.2 核心架构：Task Tool 模式

### 拓扑

```
主 Agent Graph（现有，不变）
  │
  ├─ agent 节点
  │   └─ 模型调用 task 工具
  │
  └─ tools 节点（新增 task 处理）
      └─ SubAgentRunner 启动独立 Agent 实例
           ├─ 独立上下文窗口
           ├─ 独立工具集
           ├─ 独立 AbortController
           └─ 运行至完成 → 返回摘要注入主对话
```

### 设计原则

- **上下文隔离**：子 agent 拥有独立上下文窗口，不共享主 agent 消息历史
- **单向通信**：主 agent 派发任务 → 子 agent 返回最终摘要，无双向交互
- **主 Agent 是唯一决策者**：Plan 模式由主 agent 把控，子 agent 只做执行和研究

## 6.3 内置角色

| 角色 | 工具集 | System Prompt 职责 |
|------|--------|-------------------|
| **Explore** | `read_file`、`shell_execute`（只读）、`read_mcp_resource` | 穷尽搜索，返回完整证据链 |
| **Code** | 全部 8 个工具（含完整写入权限，无 task） | 严格按照指令实现，完成后运行测试 |
| **Review** | 同 Explore（只读） | 批判性审查：bug、安全漏洞、逻辑矛盾 |

Explore 和 Review 工具集完全相同（都是只读），区别完全在 system prompt。

## 6.4 生命周期管理

| 参数 | 值 | 说明 |
|------|-----|------|
| 超时 | 30 分钟 | 从启动到强制终止的最大时长 |
| 最大并发 | 10 | 同时运行的子 agent 数量上限 |
| 嵌套深度 | 0 | 子 agent 不可调用 `task` 工具 |
| 独立 checkpoint | 无 | 子 agent 是一次性的 |

### 并发控制

```
subagent.activeCount ≤ subagent.maxConcurrent (10)
```

超过上限时，新请求直接拒绝（返回 `ok: false` 错误）。

### 中止

- 用户按 `Ctrl+C`：中止当前前端 agent 及其所有活跃子 agent
- 子 agent 超时：`AbortController.abort()` → `SubAgentTimeoutError`

## 6.5 审批策略

```
Code 子 agent 执行工具前：
  1. Explore / Review — 只有只读工具，永不触发审批
  2. Code —
     a. 查主 agent 的 authorization 状态
     b. 已授权 → 直接执行
     c. 未授权 → 敏感操作触发审批
```

子 agent 触发审批时，TUI 在子 agent block 内嵌入审批卡片，同一时间只有一个子 agent 可以等待审批（串行排队）。

## 6.6 TUI 渲染

### Block 类型：subagent

```
运行中：
▸ Explore · 搜索 UserService 引用...
  ├─ Grep: UserService                    [1.2s]
  ├─ Read: src/services/user.ts           [0.3s]
  └─ Grep: UserService\.getById           [0.8s]

完成（折叠）：
▼ Explore · 搜索 UserService 引用 — 3 次工具调用，2.3s
  │ 找到 8 处引用，分布在 5 个文件中：
  │ - src/controllers/auth.ts:45, 78
  │ - src/middleware/session.ts:23

错误：
✗ Code · 实现新功能 — 超时 (30min)
```

### 事件协议

```
subagent_start → subagent_step → subagent_tool_result → ... → subagent_done
                                                              → subagent_error（异常时）
```
