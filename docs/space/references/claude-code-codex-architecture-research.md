# Claude Code / Codex 架构调研：多端支持模式

状态：reference
来源：Web 调研
最后更新：2026-06-10

## 调研目的

OpenPX 当前是单 TUI 前端直接调用 core。未来引入 Web/客户端后，需要一个不引入过度复杂度的多端架构方案。本调研分析 Claude Code 和 OpenAI Codex 的架构设计，提取可复用的模式。

---

## 1. Claude Code 架构

### 六层架构

```
┌──────────────────────────────────────────────────┐
│  接入层：CLI / VSCode / SDK / Desktop / Remote    │
├──────────────────────────────────────────────────┤
│  交互控制层：REPL、命令路由(80+)、权限管理          │
├──────────────────────────────────────────────────┤
│  核心引擎层：QueryEngine、Agent Loop、Token控制    │
├──────────────────────────────────────────────────┤
│  工具执行层：40+ 工具 (Bash/File/Web/LSP/Agent)   │
├──────────────────────────────────────────────────┤
│  Agent 编排层：Subagent / Swarm / Coordinator      │
├──────────────────────────────────────────────────┤
│  基础设施层：MCP/OAuth/遥测/沙箱/Bridge            │
└──────────────────────────────────────────────────┘
```

### 关键设计

- **AsyncGenerator**：`query()` 是核心入口，产出事件流，CLI 和 SDK 共享同一接口
- **QueryEngine**：`submitMessage()` 管理会话状态，`ask()` 做无状态单次调用
- **双轨状态**：`Bootstrap State`（全局单例）+ `AppState`（不可变，每 Agent 独立）
- **入口检测**：`CLAUDE_CODE_ENTRYPOINT` 环境变量区分 CLI / SDK / Bridge 模式
- **IDE Bridge**：HTTP/WebSocket 桥接层，供 VS Code Extension 连接

### 多端方案：入口分离 + SDK 模式

不设独立服务层。通过不同入口文件适配各端：

| 模式 | 入口 | 说明 |
|------|------|------|
| CLI/TUI | `main.tsx` | 默认，React+Ink REPL |
| SDK | `entrypoints/agentSdkTypes.ts` | 暴露 `QueryEngine` API |
| IDE Bridge | `bridgeMain.ts` | HTTP/WS 桥接 |
| Headless | `-p` flag | CI/CD 无交互 |

### 技术栈

TypeScript + Bun + React + Ink。同进程架构，无网络边界，改动量小。

---

## 2. Codex 架构

### 四层架构

```
┌──────────────────────────────────────────────────┐
│  TUI │ Exec │ VS Code │ Desktop App │ Web App     │
└────────────────┬─────────────────────────────────┘
                 │ JSON-RPC 2.0 / stdio (JSONL)
┌────────────────▼─────────────────────────────────┐
│  App Server (codex-app-server)                    │
│  MessageProcessor → SQ/EQ → ThreadManager         │
└────────────────┬─────────────────────────────────┘
                 │
┌────────────────▼─────────────────────────────────┐
│  codex-core (~60 Rust crates)                     │
│  Agent Loop │ Tools │ Sandbox │ MCP │ Config      │
└────────────────┬─────────────────────────────────┘
                 │  Streaming HTTP
┌────────────────▼─────────────────────────────────┐
│  OpenAI Responses API                             │
└──────────────────────────────────────────────────┘
```

### 关键设计

- **SQ/EQ 模式**：Submission Queue / Event Queue 异步解耦 core 和前端
- **JSON-RPC 2.0 over stdio**：`Op::UserTurn` → core，`EventMsg::AgentMessageDelta` → 前端
- **App Server**：所有前端通过统一的 JSONL 流协议与 core 通信
- **Thread/Turn/Item 三级会话模型**：Thread（持久化容器）→ Turn（单次工作）→ Item（原子 I/O）
- **Rust 技术栈**：跨平台编译，每个客户端 bundle 平台特定二进制

### 为什么不用 MCP

Codex 最初尝试用 MCP 做 IDE 集成层，发现 MCP 的 tool-oriented 模型无法表达 agent 专属语义（流式 diff、审批流、会话分叉），因此自建 JSON-RPC 协议。

---

## 3. 对比分析

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| **多端方式** | 入口分离 + SDK | App Server + JSON-RPC |
| **传输层** | 进程内（默认）/ HTTP-WS（Bridge） | stdio JSONL |
| **复杂度** | 低——同进程 | 高——跨进程 |
| **协议** | AsyncGenerator 类型 | 自定义 Op/Event JSON |
| **适用场景** | 本地多形态 | 本地+远程+Web 全场景 |
| **改动量** | 小（加入口文件） | 中（加协议序列化层） |

---

## 4. 对 OpenPX 的建议

OpenPX 当前已具备两个关键资产：

- `AgentEvent` 协议（23 种事件类型）— 天然 wire format
- `SessionData` / `ReplayInterrupt` — 中性可序列化数据结构

**建议走 Claude Code 路线**：先不引入网络边界，通过 SDK 入口做多端适配。

```
src/
├── protocol/       # AgentEvent — 已是协议
├── core/           # runner.ts — AsyncGenerator<AgentEvent>
├── sdk/            # 新增：对外的稳定接口
│   └── index.ts    # runAgent(), resumeAgent(), loadSession()
├── app/
│   ├── tui/        # TUI 前端（消费 sdk）
│   └── cli/        # CLI 入口
└── entrypoints/    # 未来：不同运行模式入口
    ├── tui.ts      # bun run tui
    ├── headless.ts # bun run exec
    └── server.ts   # 未来：JSONL server → Web/Desktop
```

未来需要远程/Web 端时，再加 `entrypoints/server.ts` 做 JSONL 传输（借鉴 Codex App Server 模式），不推翻现有架构。
