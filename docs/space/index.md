# Space 索引

最后更新：2026-06-10（shell 并发/批量审批、token 统计持久化、SQLite 优化归档）

这是 `docs/space/` 的导航入口。默认不要读取所有记录；应根据下面的范围和“读取时机”只拉取当前任务需要的上下文。

`docs/space/` 不存储每次运行的 `graph.state.plan`。运行时计划仍属于 checkpoint 状态；本索引只跟踪持久项目记录。

状态含义：

- `active`：当前有效规则，会约束其范围内的改动。
- `completed`：历史实现记录和验证证据。
- `understanding`：设计背景或理由。
- `reference`：外部资料摘要。
- `generated`：派生材料，权威性较低。

## 当前规则记录

| 记录 | 状态 | 范围 | 读取时机 |
| --- | --- | --- | --- |
| `execution/active/plan-state-reminder.md` | active | 模型上下文构建、计划投影、缓存敏感 prompt 布局 | 修改 `src/model/context.ts`、`src/model/runtime-context.ts`，或修改计划/上下文投影相关测试。 |
| `execution/active/model-provider-boundary.md` | active | 模型 provider 配置、适配器、provider 专有行为、真实配置模型测试 | 修改 `src/config`、`src/model`、provider 文档或真实模型套件。 |
| `execution/active/tool-gated-autonomy.md` | active | 图路由、审批边界、工具 gating、最终答案自主性 | 修改 `src/harness/graph.ts`、`src/harness/routes.ts`、`src/harness/tool-policy.ts`、`src/harness/tool-runner.ts`，或修改审批/最终路由相关测试。 |
| `execution/active/real-model-test-boundary.md` | active | 测试发现、真实模型端到端套件、package 脚本 | 修改测试命名、`package.json` 测试脚本或真实模型套件。 |
| `execution/active/documentation-language.md` | active | 文档语言、Markdown 内容标准、文档测试 | 创建或修改 README、AGENTS、`docs/space` 或其他 Markdown 文档。 |
| `execution/active/empirical-research-archive.md` | active | 真实模型实验、缓存/性能研究、provider 行为研究、可复用实验归档 | 运行或解释真实 provider 实验、缓存命中率实验、多轮 agent 行为实验，或用户要求研究结论可沉淀。 |
| `execution/active/tool-description-contracts.md` | active | 工具描述契约、ACI 原则、契约结构与验证测试 | 创建或修改工具定义、工具描述、工具行为实现；新增工具注册。 |
| `execution/active/project-conventions.md` | active | 文档语言、注释规范、测试纪律、CLI 行为、提交粒度、仓库卫生、TypeScript 类型安全 | 修改 Markdown 文档、测试、CLI、提交规范、仓库布局约束或 TypeScript 类型声明时。 |
| `execution/active/tui-e2e-standards.md` | active | TUI E2E 测试标准、响应分配器、Harness 增强、P0-P3 覆盖分层 | 编写或修改 TUI E2E 测试、调整 mock agent 行为、新增 E2E 场景。 |
| `execution/active/e2e-test-restructure.md` | active | E2E 测试用例体系重构方案 — 3 文件 60 测试覆盖 P0-P3 | E2E 测试重构、新增测试层级、调整测试文件组织。 |
| `execution/active/tui-textinput-wrapping-spec.md` | active | `CtrlSafeTextInput` 软换行、光标边界、IME 空格清理、CJK/ASCII 混合输入行为 | 修改 `CtrlSafeTextInput` 软换行、光标移动、IME 处理或 `maxWidth` 传播逻辑时。 |
| `execution/active/tui-footer-resize-stability.md` | active | TUI 终端缩放刷新方案 — resize 事件驱动 + 清屏 + key remount + 输入保留 | 修改 TUI resize 逻辑、缩放行为异常时必读。 |
| `execution/active/cancel-resume-cleanup.md` | active | Cancel-Resume 三层清理架构 — graph cleanup 节点 + sanitize + reorder，防止孤儿工具重新执行和 API 400 错误 | 修改 cancel/abort/resume 逻辑、检查点恢复、消息清理时必读。 |
| `execution/active/tui-no-viewport-culling.md` | active | TUI OutputArea 渲染逻辑、App 布局、block 可见性 | 修改 OutputArea.tsx 或 App.tsx 的渲染/overflow 逻辑，讨论视口剔除或虚拟滚动。 |
| `execution/active/layer-boundary-enforcement.md` | active | 三层架构分层边界强制：core 禁止导入 app/tui、禁止展示层格式化、中立数据类型规范 | **修改 `src/core/` 任何文件时必读**。新增 core 模块、添加 import、做文本截断/格式化时。 |
| `execution/active/shell-platform-compatibility.md` | active | Shell 工具 Windows 兼容性、bash 选择策略、WSL 桩排除、vendored MSYS2 DLL 依赖 | 修改 shell.ts/bash-path.ts、调整 bash 选择逻辑、新增/升级 coreutils、排查 Windows shell 异常。 |

## 理解记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `understanding/space-system-design.md` | understanding | 定义 `docs/space` 如何作为仓库本地记录系统工作。 |
| `understanding/2026-04-26-plan-state-context-projection.md` | understanding | 解释为什么将 `graph.state.plan` 作为运行时状态投影，而不是依赖工具消息历史或 system prompt。 |
| `understanding/2026-05-10-authorization-mode-switch-design.md` | understanding | 授权模式切换（default/full_access）的设计规范，包含 AuthorizationOverride 内存覆盖和 set_authorization_mode 工具的设计决策。 |
| `understanding/2026-05-11-three-layer-architecture-design.md` | understanding | 三层分离架构（protocol/core/app）设计规范，将 Agent 核心重构为纯逻辑库，支持 TUI/Desktop 多前端。 |
| `understanding/2026-05-12-tui-overhaul-design.md` | understanding | TUI 全面重构设计 — 交互式对话循环、流式 markdown 渲染、快捷键体系、slash 命令等 9 维度改版。 |
| `understanding/2026-05-17-sessions-command-design.md` | understanding | /sessions 会话列表、断点续接、智能命名、模型配置持久化设计。 |
| `understanding/2026-05-20-tui-known-issues.md` | understanding | TUI 已知问题清单：死事件类型、compacting 字段、recoverable 标志、手动 compaction 空壳、剩余未修复项。 |

| `understanding/2026-05-22-rewind-mcp-resources-design.md` | understanding | Rewind（Revert + Fork）和 MCP Resources 的设计规范。 |
| `understanding/2026-05-23-skills-system-design.md` | understanding | Skills 系统设计 — 对齐 agentskills.io 开放标准，按需加载 + Skill 工具 + Available Skills 区段 + /skill-name。 |
| `understanding/2026-05-24-multi-session-concurrency-design.md` | understanding | 多会话并发执行设计规范。 |
| `understanding/2026-05-26-tui-claude-code-parity-design.md` | understanding | TUI Claude Code 对标设计 — 布局重构、快捷键精简、功能补全、配置、主题、实施记录。 |
| `understanding/2026-05-30-multi-agent-design.md` | understanding | 多 Agent 架构设计 — Task Tool 模式、3 个内置角色（Explore/Code/Review）、星型拓扑、生命周期、审批策略、TUI 渲染。 |
| `understanding/2026-06-02-ink-rendering-scroll-selection-issue.md` | understanding | Ink 渲染机制导致的滚动和文本选择问题 — 根本原因分析、已尝试方案、可能解决方向。 |
| `understanding/2026-06-03-tui-block-turn-model-design.md` | completed | TUI 消息列表重构 — 引入 Turn 模型替代 flat OutputBlock[]，简化 Static/Dynamic 分割逻辑。 |
| `understanding/2026-06-08-prefix-cache-hit-rate-analysis.md` | understanding | 前缀缓存命中率分析 — DeepSeek KV cache 机制、前缀大小与命中率关系、当前 OpenPX 前缀构成、影响因素和优化方向。 |
| `understanding/2026-06-09-prompt-cache-optimization.md` | understanding | Prompt Cache 优化：合并 SystemMessage、清理死参数、修复 reasoning_content 注入 key 碰撞、TUI 缓存日志、子 agent 缓存震荡根因、对标 Claude Code/Codex/OpenCode 子 agent 结果回传机制。 |
| `understanding/2026-06-09-token-stats-persistence-design.md` | understanding | Token 统计持久化系统：手动统计（不依赖 provider）、SQLite 持久化跨重启保留、useEffect 自动保存消除 stateRef 滞后、getSnapshot 内存缓存消除回车卡顿。 |
| `understanding/2026-06-10-shell-concurrent-execution-design.md` | understanding | Shell 工具并发执行 + 批量审批流程：`approvedBatch` 状态注解、approval→approval 循环路由、全量并行执行、full_access 自动放行、recursionLimit 9999999。 |

## Backlog（工作待办）

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `backlog/README.md` | active | 定义 backlog 目录用途和使用规范。 |
| `backlog/tui-issues.md` | active | TUI 待修复项清单：已知缺口、清理方向、依赖项。 |
| `backlog/2026-06-01-deep-user-audit.md` | active | B14-B26 工程债务清单：死代码、缓存竞态、schema 臃肿、语言一致性等。 |
| `backlog/2026-06-08-product-experience-gaps.md` | active | B27-B33 产品体验缺口：跨会话记忆、Web Search、默认模型、Diff 渲染、Token 展示等。 |

## Plans（实施计划）

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `plans/README.md` | active | 定义 plans 目录用途、格式规范和生命周期。 |
| `plans/index.md` | active | 所有计划的全局注册表：状态、优先级、依赖、分叉关系。 |
| `plans/2026-05-20-tui-production-roadmap.md` | archived | TUI 生产就绪四步路线图：感知闭环 → 防御纵深 → 功能补齐。 |
| `plans/2026-05-22-production-gaps-closure.md` | archived | 生产就绪补齐 3 阶段方案。Phase1 ✅，Phase2 ✅，Phase3 ✅。 |
| `plans/2026-05-22-production-gaps-phase1.md` | archived | Phase 1 实施记录（8 commits）。MCP + 事件闭环 + 错误分类。 |
| `plans/2026-05-22-production-gaps-phase2.md` | archived | Phase 2 实施计划（7 tasks）。Rewind + MCP Resources。 |
| `plans/2026-05-22-skills-system.md` | superseded | 被 [`understanding/2026-05-23-skills-system-design.md`](../understanding/2026-05-23-skills-system-design.md) 替代。 |
| `plans/2026-05-23-skills-system-phase3.md` | archived | Phase 3 实施计划（Skills 系统，11 tasks）。 |
| `plans/2026-05-24-multi-session-concurrency.md` | archived | 多会话并发执行（3 tasks）。 |
| `plans/2026-05-25-e2e-restructure.md` | archived | E2E 测试套件重构（~71 tests，P0-P3 分层）。 |
| `plans/2026-05-26-tui-claude-code-parity.md` | archived | TUI Claude Code 全面对标（14 tasks）：布局、快捷键、功能、配置、主题。 |

## 完成执行记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `execution/completed/2026-04-26-plan-state-reminder.md` | completed | 记录把计划状态移动到尾部合成用户侧提醒的实现和验证。 |
| `execution/completed/2026-04-26-remove-stop-check.md` | completed | 记录移除最终答案 stop-check 和非危险模式确认门。 |
| `execution/completed/2026-04-26-remove-internal-ledgers.md` | completed | 记录移除 evidence/progress 账本和 watchdog 式进度推断。 |
| `execution/completed/2026-04-26-real-model-test-boundary.md` | completed | 记录真实模型测试从 Bun 默认发现中隔离，以及显式真实测试脚本修复。 |
| `execution/completed/2026-04-27-harness-engineering-doc-hygiene.md` | completed | 记录 `docs/space` 索引和生成文档边界的默认测试覆盖。 |
| `execution/completed/2026-04-27-documentation-language-standard.md` | completed | 记录仓库 Markdown 文档以中文为标准，并增加中文元数据检查。 |
| `execution/completed/2026-05-01-prompt-cache-runtime-state-research.md` | completed | 归档 DeepSeek prompt cache 标准、运行时状态投影实验、失败反例和最终消息布局结论。 |
| `execution/completed/2026-05-06-tool-description-contracts.md` | completed | 记录工具描述从功能字符串升级为结构化 ACI 契约的实现和验证。 |
| `execution/completed/2026-05-10-authorization-mode-switch.md` | completed | 记录授权模式切换功能的实现，包括 AuthorizationOverride、set_authorization_mode 工具、CLI --authorization-mode 标志和测试覆盖。 |
| `execution/completed/2026-05-16-remove-viewport-culling.md` | completed | 记录移除 TUI 视口剔除逻辑，让终端原生 scrollback 处理溢出；补齐 e2e 验证体系（88 个 e2e 测试、6 种严格断言类型、真实 agent 运行器）。 |
| `execution/completed/2026-05-17-sessions-command-implementation.md` | completed | /sessions 功能的完整实现记录 — 23 文件变更、SessionSelector 覆盖层、checkpoint 消息加载、中断恢复、智能命名、模型配置持久化。 |
| `execution/completed/2026-05-20-tui-production-roadmap.md` | archived | TUI 生产就绪四步路线图：感知闭环、防御纵深、手动 Compaction。 |
| `execution/completed/2026-05-22-production-gaps-closure.md` | archived | 生产就绪补齐 3 阶段统筹方案，Phase 1/2/3 全部完成。 |
| `execution/completed/2026-05-22-production-gaps-phase1.md` | archived | Phase 1: MCP 核心 + 事件闭环 + 错误分类（8 commits）。 |
| `execution/completed/2026-05-22-production-gaps-phase2.md` | archived | Phase 2: Rewind + MCP Resources（2 commits）。 |
| `execution/completed/2026-05-23-skills-system-phase3.md` | archived | Phase 3: Skills 系统，agentskills.io 标准（11 commits）。 |
| `execution/completed/2026-05-24-multi-session-concurrency.md` | archived | 多会话并发执行：SessionManager + SessionRuntime + Sidebar。 |
| `execution/completed/2026-05-25-e2e-restructure.md` | archived | E2E 测试套件重构：3 文件 ~71 tests，P0-P3 分层。 |
| `execution/completed/2026-05-26-tui-claude-code-parity.md` | archived | TUI Claude Code 全面对标：布局、快捷键、功能、配置、主题（14 commits）。 |
| `execution/completed/2026-05-28-static-header-ordering-fix.md` | completed | 修复 Ink `<Static>` 与 Header 顺序冲突，Header 注入 Static items 保持四层布局。（已被 2026-06-02 方案替代） |
| `execution/completed/2026-06-02-remove-static-react-memo.md` | completed | 移除 Ink `<Static>`，改用 React.memo block 组件 + 引用稳定 reducer。（已被 2026-06-03 方案替代） |
| `execution/completed/2026-06-03-restore-static-height-zero.md` | completed | 恢复 `<Static>` 渲染架构解决 Windows 输入卡顿，用 `<Box height={0}>` 消除布局空白。 |
| `execution/completed/2026-06-04-turn-model-refactor.md` | completed | Turn 模型重构 — 引入 `Turn` 替代 flat `OutputBlock[]`，将 Static/Dynamic 分割退化为 `slice(-1)`。 |
| `execution/completed/2026-06-09-sqlite-reliability-optimization.md` | completed | SQLite 连接管理、写入可靠性、WAL 清理、会话列表索引优化。 |

## 参考资料

| 记录 | 状态 | 来源 |
| --- | --- | --- |
| `references/openai-harness-engineering.md` | reference | OpenAI 关于 Codex harness engineering 和仓库知识系统的文章。 |
| `references/opencode-codex-plan-handling.md` | reference | Opencode 与 Codex 计划处理方式的本地对比。 |
| `references/claude-code-codex-architecture-research.md` | reference | Claude Code 与 OpenAI Codex 多端架构对比调研 — 入口分离 vs App Server，对 OpenPX 的建议。 |

## 生成材料边界

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `generated/README.md` | generated | 定义生成材料的较低权威性和晋升规则。 |

## 维护规则

- 保持 `AGENTS.md` 简短，把它作为指向本索引的地图。
- 可能影响未来实现的记录必须包含状态、范围、相关记录和验证说明。
- 只有在形成具体本地规则，并且可行时配套测试后，才能把 generated 或 reference 记录晋升到 `execution/active/`。
- 退役过期 active 规则时，应更新记录状态，必要时移出 active，并补充说明理由的 completed 记录。
