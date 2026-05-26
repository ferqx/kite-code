# OpenPX 产品定义

## 一句话定位

OpenPX 是一个开源、多模型、跨平台的终端代码 Agent —— 不绑定特定 AI provider，在 LangGraph 生态之上提供可审计的人机协作编程体验。

## 目标用户

- **专业开发者**：需要在终端中与 AI 协作完成代码任务的工程师
- **多模型用户**：需要灵活切换 DeepSeek / OpenAI / Ollama 等 provider 的用户
- **对安全可控有要求的团队**：需要审批机制、工具策略、风险分类的团队

## 核心特性（已实现）

| 特性 | 说明 |
|------|------|
| 交互式 TUI | React Ink 终端界面，Markdown 渲染、键盘快捷键、多轮对话，四层布局（Header/Body/Footer/Overlay） |
| CLI 入口 | 单次 `run` + `resume` 模式，适合脚本/CI |
| 多 provider 支持 | DeepSeek、OpenAI、OpenAI-compatible、Ollama，模型列表从配置动态加载 |
| 审批机制 | 受保护工具人工审批，支持单次/同命令/完全授权 |
| Agent 工具 | 6 个内置工具：read_file、edit_file、write_file、shell_execute、update_plan、ask_user |
| 工具安全策略 | 风险分类（read/plan/write_file/execute_code/destructive/network/vcs_mutation/mcp） |
| SQLite 持久化 | LangGraph checkpoint，会话回溯和断点续接 |
| 上下文压缩 | 自动检测 overflow → 规则压缩 → LLM 摘要三层策略，支持手动 `/compact` 触发 |
| 跨平台 | Windows / Unix 双平台 |
| 事件协议 | 标准化事件流，TUI 和 CLI 共享同一 runner |
| 三层架构 | protocol → core → app 清晰分层 |
| MCP 协议支持 | stdio + streamable HTTP transport，工具命名 `mcp__servername__toolname`，`/mcp` 管理面板 |
| MCP Resources | `resources/list` + `resources/read`，`read_mcp_resource` 工具注入 agent 上下文 |
| Rewind（会话回溯） | `/rewind` 命令 + `Esc Esc`，checkpoint 列表 → Revert/Fork，对齐 Claude Code Rewind |
| Skills 系统 | agentskills.io 开放标准，`Skill` 工具 + `/skill-name` 斜杠命令，项目/用户级 skills 目录 |
| 错误分类 | runner 层区分网络超时/速率限制（可恢复）vs 配置/权限（不可恢复） |
| 多会话并发 | 独立 AbortController，会话间互不污染 |
| 双主题 | dark / light，通过 `openpx.jsonc` 的 `theme` 字段切换 |

## 明确不做（当前）

| 不做 | 理由 |
|------|------|
| **IDE 插件** | TUI 是唯一前端交互通道；GUI/IDE 集成不在当前范围内 |
| **托管 SaaS** | 仅本地运行，不提供远程 agent 托管 |
| **移动端** | 仅终端环境 |
| **代码审查 Bot** | 对 PR 的自动化评论不属于交互式 agent 的职责 |
| **CI/CD 原生集成** | CLI 可用于 CI，但不提供专用 CI 适配器 |
| **自然语言数据库查询** | 不内置数据库 schema 理解和 SQL 生成 |
| **Web 前端** | 不在当前规划中 |

## 规划中

| 方向 | 状态 | 说明 |
|------|------|------|
| Hooks 系统 | 缓后 | PreToolUse / PostToolUse shell hook，需明确定义 hook 接口和触发时机 |
| 自定义斜杠命令 | 缓后 | `customCommands` 配置段，`/` 补全集成，可复用 Skills 机制实现 |

> 详见 [`docs/space/plans/2026-05-22-production-gaps-closure.md`](docs/space/plans/2026-05-22-production-gaps-closure.md)

## 暂不排期

| 方向 | 理由 |
|------|------|
| IDE 插件 / Web 前端 | 不在当前规划中 |

## 架构原则

1. **Provider 无关** — 核心逻辑不绑定特定 AI provider；provider 专有行为隔离在适配器层
2. **可审计** — 所有工具调用留下审批记录和 checkpoint；用户可以回溯任何决策
3. **渐进式自主** — agent 能力可逐级放权（default → shell 授权 → full_access），不强制二元开关
4. **事件驱动** — TUI 和 CLI 通过统一的标准化事件协议消费；新前端只需对接事件流
5. **跨平台优先** — 所有新功能必须在 Windows/Unix 双平台通过测试
6. **LangGraph 生态内** — 不做轮子，利用上游 checkpoint、stream、interrupt 机制

## 与竞品的差异

| 维度 | OpenPX | Claude Code | Open Code |
|------|--------|-------------|-----------|
| 模型绑定 | 无（多 provider） | 绑定 Claude | 无 |
| 前端形式 | TUI + CLI | TUI + IDE 插件 | IDE + TUI |
| 审批粒度 | 工具级 + 命令级 | 工具级 | 工具级 |
| 架构分层 | protocol/core/app 三层 | 单体 | — |
| 持久化 | SQLite checkpoint 链 | SQLite | — |
| MCP | 已支持 | 已支持 | — |
| Rewind | 已支持 | 已支持 | — |
| Skills | 已支持 | 已支持 | — |
| Hooks | 缓后 | 已支持 | — |

## 关联文档

- [`ROADMAP.md`](ROADMAP.md) — 路线图：当前阶段、已完成项、后续方向
- [`docs/space/plans/index.md`](docs/space/plans/index.md) — 方案注册表：详细实施方案
- [`docs/space/`](docs/space/) — 设计决策、规则、完成记录
- [`docs/space/backlog/`](docs/space/backlog/) — 已知问题清单
- `ARCHITECTURE.md`（待建）— 架构全景
