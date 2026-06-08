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
| Agent 工具 | 9 个内置工具：read_file、edit_file、write_file、shell_execute、read_mcp_resource、update_plan、ask_user、Skill、task |
| 工具安全策略 | 风险分类（read/plan/write_file/execute_code/destructive/network/vcs_mutation/mcp） |
| SQLite 持久化 | LangGraph checkpoint，会话回溯和断点续接 |
| Token / Cache 统计 | `cache-metrics.ts` 提取 prompt cache 指标（命中/未命中 tokens），StatsLine 展示 token 用量（仅 DeepSeek provider 展示 cache/think） |
| 跨平台 | Windows / Unix 双平台 |
| 事件协议 | 标准化事件流，TUI 和 CLI 共享同一 runner |
| 三层架构 | protocol → core → app 清晰分层 |
| MCP 协议支持 | stdio + streamable HTTP transport，工具命名 `mcp__servername__toolname`，`/mcp` 管理面板 |
| MCP Resources | `resources/list` + `resources/read`，`read_mcp_resource` 工具注入 agent 上下文 |
| Rewind（会话回溯） | `/rewind` 命令 + `Esc Esc`，checkpoint 列表 → Revert/Fork，对齐 Claude Code Rewind |
| Skills 系统 | agentskills.io 开放标准，`Skill` 工具 + `/skill-name` 斜杠命令，项目/用户级 skills 目录 |
| 错误分类 | runner 层区分网络超时/速率限制（可恢复）vs 配置/权限（不可恢复） |
| 多 Agent 协作 | Task Tool 模式，3 个内置角色（Explore/Code/Review），星型拓扑，上下文隔离，TUI 实时渲染 |
| 多会话并发 | 独立 AbortController，会话间互不污染 |
| 双主题 | dark / light，通过 `openpx.jsonc` 的 `theme` 字段切换 |

## 已知产品缺口（深度用户反馈）

2026-06-01 基于深度使用 Claude Code 的用户视角，识别出以下从"能工作的 agent 框架"到"愿意日常使用的 agent 产品"之间的关键差距。

### 一票否决级（缺了就不会用）

| 缺口 | 现状 | 影响 |
|------|------|------|
| **默认强模型绑定** | 多 provider 是架构优势，但产品层面缺少「开箱即用」的推荐模型。用户接入弱模型后 agent 连续犯错，第一反应是换产品而非调配置 | provider-agnostic 将模型选择风险转嫁用户，阻碍首次体验 |
| **跨会话记忆系统** | 仅支持同会话内 checkpoint 回溯，无跨会话持久记忆 | 每次新会话 agent 都是陌生人，重度使用场景不可接受 |
| **Web Search 工具** | 工具体系中不存在 web search | 无法查最新文档、API 变更、社区讨论，现代编码 agent 的基础能力缺失 |

### 严重影响使用意愿

| 缺口 | 现状 | 影响 |
|------|------|------|
| **Hooks 系统** | 标为「缓后」，无 PreToolUse / PostToolUse 机制 | 深度用户无法定制 agent 行为，长时间 session 中摩擦持续累积 |
| **Diff 渲染** | edit_file 仅返回文本匹配成功/失败，TUI 中无 diff 展示 | 用户需额外开终端 `git diff` 验证改动，打断工作流 |
| **子 Agent 自定义 + 递归** | 仅 3 个内置角色，depth=0 不可递归 | 无法定制专用子 agent（如 DB migration review），复杂任务受限 |

### 中等摩擦

| 缺口 | 现状 | 影响 |
|------|------|------|
| **仅 TUI/CLI 通道** | 无 IDE 插件 | 多文件重构时需频繁切换终端和编辑器，上下文割裂 |
| **无图片支持** | 不支持多模态输入 | 无法让 agent 看图（截图、架构图、UI mockup），限制 debug/设计场景 |
| **无 Token / 成本展示** | TUI 不展示 token 用量或成本 | 深度用户无法感知 session 消耗，缺乏成本控制 |
| **update_plan 纯声明式无约束** | plan 永远是 `ok: true`，无验证 | 长任务中 plan 状态可能与实际进度脱节，误导用户 |

### 代码与设计债务

2026-06-01 深度审查发现的工程问题：

| 问题 | 位置 | 严重程度 |
|------|------|----------|
| `apply_patch` 是死代码 — 契约和实现存在但 `createAgentTools()` 未注册 | `tool-contracts.ts`, `apply-patch.ts`, `definitions.ts` | 中 |
| `shell_execute` schema 臃肿 — 8 个可选元数据字段，多数不参与执行逻辑 | `definitions.ts` | 低（累积效应） |
| 模块级可变缓存 `_cachedKey/_cachedTools` — 多 session 并发时可能竞态覆盖 | `definitions.ts` | 中 |
| `sanitizeToolCallPairs` 是 checkpoint 不一致的事后补丁 | `context.ts` | 中 |
| 系统提示中文 vs 工具描述英文 — 语言不一致 | `system-prompt.txt`, `definitions.ts` | 低 |
| `edit_file` 无容错匹配 — 多余空白即失败 | `file.ts` | 中 |
| `write_file` 无 append 模式 — 追加内容必须传完整文件 | `file.ts` | 低 |
| 无二进制文件检测机制 | `file.ts` | 中 |
| 子 Agent 无独立模型/thinking 配置 — Explore/Code/Review 共用主 agent 模型 | `subagent/` | 低 |
| 全局快捷键仅 3 个 — 缺少 Ctrl+L 清屏、Ctrl+R 历史搜索等 | `useGlobalKeys.ts` | 低 |

## 规划中

按深度用户反馈重排优先级：

| 优先级 | 方向 | 状态 | 说明 |
|--------|------|------|------|
| **P0** | 默认推荐模型 + 体验优化 | 待启动 | 围绕一个强模型优化 system prompt、工具描述和默认配置，确保开箱即用体验对标 Claude Code |
| **P0** | 跨会话记忆系统 | 待启动 | agent 在 `.openpx/memory/` 下维护持久记忆，自动读写，记住用户偏好、技术栈、架构决策 |
| **P0** | Web Search 工具 | 待启动 | 内置 web search 能力，支持查最新文档、API 变更、社区讨论 |
| **P1** | Hooks 系统 | 提升优先级 | PreToolUse / PostToolUse shell hook，原为「缓后」，现提升为 P1 |
| **P1** | Diff 渲染 | 待启动 | TUI 中展示实际 diff（对标 Claude Code），非仅 old_string/new_string 匹配结果 |
| **P2** | 自定义子 Agent 配置 | 待启动 | `.openpx/agents/*.md` 定义角色，超越内置 3 个；评估放开 depth > 0 |
| **P2** | 图片输入支持 | 待启动 | 多模态输入，支持截图、架构图、UI mockup |
| — | 自定义斜杠命令 | 缓后 | `customCommands` 配置段，`/` 补全集成，可复用 Skills 机制实现 |

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
| 跨会话记忆 | 无 | 已支持（auto-memory） | — |
| Hooks | 规划中（P1） | 已支持 | — |
| Web Search | 规划中（P0） | 已支持 | 已支持 |
| Diff 渲染 | 规划中（P1） | 已支持 | — |
| 图片输入 | 规划中（P2） | 已支持 | — |

## 关联文档

- [`ROADMAP.md`](ROADMAP.md) — 路线图：当前阶段、已完成项、后续方向
- [`docs/space/plans/index.md`](docs/space/plans/index.md) — 方案注册表：详细实施方案
- [`docs/space/`](docs/space/) — 设计决策、规则、完成记录
- [`docs/space/backlog/`](docs/space/backlog/) — 已知问题清单
- `ARCHITECTURE.md`（待建）— 架构全景
