# 第六章 Subagent 协作

Subagent 是能够在隔离上下文中完成部分任务的 Capability。主 Agent 保持最终编排权，子 Agent 不形成 peer-to-peer 网络。

## 6.1 内置角色

| 角色 | 用途 | 默认能力边界 |
| --- | --- | --- |
| `explore` | 搜索和理解代码 | 只读工具 |
| `plan` | 调研并形成方案 | 只读工具 |
| `code` | 实现明确任务 | 完整工具集，但仍受 Runtime policy |
| `review` | 独立检查结果 | 只读工具 |

角色配置位于 `src/core/subagent/roles.ts`。允许的工具集合是能力上限，不是授权授予。

## 6.2 运行结构

```text
主 Agent 调用 task capability
  → Runtime/Policy 校验
  → Task Tool 创建 SubAgentRunner
  → 独立模型上下文和 AbortController
  → 工具调用仍走执行与策略边界
  → 生命周期事件投影给主 Runtime/TUI
  → 返回结构化结果或 continuation
```

Subagent 默认不读取主 Agent 的完整消息历史，只接收任务、角色 prompt、必要上下文和 Runtime 签发的有限能力。

## 6.3 审批暂停与恢复

子 Agent 遇到需要用户审批的操作时不能自行批准。Runner 产生 blocked tool 与可序列化 continuation，主 Runtime 请求用户决策；批准后恢复同一个调用身份和执行上下文，拒绝则把结构化拒绝结果反馈给子 Agent。

continuation codec 保存消息、步骤、journal 和阻塞请求，并在恢复时严格校验。它不是让子 Agent绕过审批的离线执行通道。

## 6.4 Skill fork

声明 `context: fork` 的 Skill 可在隔离 Subagent 中执行。它只能获得 Skill capability ceiling 派生出的 Runtime binding；MCP capability 在执行前再次核对 revision、schema digest 和参数。

## 6.5 并发与边界

Task Tool 按 Runtime/线程限制活动数量。取消通过 AbortController 传播。子 Agent 不递归无限派生，也不能修改主 RuntimeState；其结果必须通过主 Runtime Event 合并。
