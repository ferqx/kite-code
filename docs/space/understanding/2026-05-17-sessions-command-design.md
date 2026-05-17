# /sessions 会话列表与断点续接设计

日期：2026-05-17
状态：understanding
相关：
- `../execution/completed/2026-05-17-sessions-command-implementation.md`
- `../execution/active/tui-no-viewport-culling.md`

## 概述

TUI `/sessions` 快捷指令：列出历史会话，选中后加载消息记录并支持从断点继续对话。会话名称由模型智能生成并在创建时持久化。

## 架构

新增 4 个模块：

- `src/core/persistence/sessions.ts` — 会话列表查询、消息加载、智能命名
- `src/app/tui/hooks/useSessionList.ts` — React hook：异步加载会话数据
- `src/app/tui/components/SessionSelector.tsx` — 覆盖层：会话列表选择器
- `tests/sessions.test.ts` — 22 个测试

修改 19 个文件，涉及 checkpoint 迁移、AgentState、模型工厂、TUI reducer、index.tsx 会话加载。

## 数据流

```
用户输入 /sessions
  → useSlashCommand 派发 SHOW_SESSIONS
  → reducer: showSessions = true
  → App 条件渲染 <SessionSelector>
  → mount 时 useSessionList hook 异步查询 SQLite
  → 渲染会话列表 (上/下导航, Enter 选中, Esc 关闭)
  → 用户选中某会话
    → loadSession(threadId) 读取最新 checkpoint
    → 提取 messages → OutputBlock[]
    → 检查 __interrupt__ pendingWrites
    → 回调 onSelect → LOAD_SESSION_PENDING → async load → LOAD_SESSION
    → reducer: blocks 替换, interrupt 设置, 模型信息写入 status
    → SessionSelector 关闭
    → 用户后续输入从 threadId 对应的 checkpoint 继续
```

## 数据库变更

checkpoints 表新增 `created_at TEXT` 列。`CREATE TABLE` 包含 `DEFAULT (datetime('now'))`（新数据库），`ALTER TABLE` 无 DEFAULT（存量数据库，存量行 created_at 为 NULL）。`put()` 写入 `datetime('now')`。

## 会话名称

三级兜底：
1. **cached metadata**：检查 `session_name` 字段（由智能命名写入）
2. **截断首条消息**：取第一条 HumanMessage 内容，过滤 `User: ` 前缀，截断至 40 字符 + `...`
3. **threadId**：兜底显示原始 thread ID

智能命名在会话创建时 fire-and-forget 调用模型生成，不在列表渲染时执行。

## 消息加载

`loadSession()` 使用 `BunSqliteSaver.getTuple()` 通过 proper serde 反序列化，映射消息到 OutputBlock。中断检测检查 `__interrupt__` pendingWrites（非 channel_values，因为 `interrupt()` 抛出 GraphInterrupt 时状态更新尚未返回）。

## 模型与思考配置持久化

AgentState 新增 `modelProvider`、`modelName`、`thinkingLevel` 通道。graph agent 节点写入当前配置到 state。会话加载时从 checkpoint 恢复，优先 checkpoint 值，fallback 到当前 config。`thinkingLevel` 透传到 `reasoning_effort`。

## SessionSelector 组件

仿 ModelSelector 覆盖层模式：带边框列表、`useRef+useInput` 键盘导航、Esc 关闭、Enter 选中。ESCAPE 优先级：`HelpPanel > SessionSelector > ModelSelector > LeaderPending > Interrupt`。

## 快捷键

- `/sessions`、`Ctrl+X L`：打开会话列表
- `/new`、`Ctrl+N`：新建会话
