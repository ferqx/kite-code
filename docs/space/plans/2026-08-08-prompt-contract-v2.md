# Prompt Contract V2 实施计划

状态：archived
日期：2026-08-08
关联：ADR-0090、`docs/active/tool-description-contracts.md`、`docs/active/plan-state-reminder.md`、`docs/active/capability-progressive-disclosure.md`

## 目标

把模型可见上下文拆分为稳定 System Prompt、项目指令、单一动态 Runtime 状态和准确工具契约，修复当前 sandbox、Skill、工具结果和 MCP 语义漂移。固定 fixture 中，V2 的静态 System Prompt、cacheable runtime context 与默认内置工具声明合计不得超过 legacy 的 70%。

## 范围与依赖

本计划覆盖 `src/core/model/`、`src/core/prompts/`、ToolSpec Registry、MCP capability descriptor、Subagent prompt、相关测试与文档。Runtime Kernel 仍是状态权威，Core 不依赖 App/TUI 类型，工具披露不替代 Policy、审批、sandbox、binding 或 verification。

依赖现有 ToolSpec Registry、Workspace Trust、项目 MCP approval、Feature Flag、Context Projection 和 token counter。不新增外部依赖，不要求真实 Provider 凭据才能完成本地实现。

## 设计约束

1. `promptContractV2` 默认关闭；legacy 与 V2 共用正确性修复。
2. `AGENTS.md` 为主、`CLAUDE.md` 兼容；同目录 CLAUDE 先、AGENTS 后，子目录晚于父目录。项目内容以 synthetic user context 注入，不能覆盖系统安全和 Runtime Policy。
3. 项目指令只读取 Workspace 内普通 UTF-8 文件；单文件 16 KiB、总计 64 KiB、总计 16,384 tokens，不跟随外部 symlink/junction/reparse point。
4. Planning V2 不披露 writer 或 Shell；动态 MCP 只披露 effective effects 不超过 read 的能力。
5. MCP 原始描述只在用户/本地/显式配置或已批准项目来源下经过清理、512 code point 截断后进入 `modelDescription`；其他来源使用工具名和参数名生成摘要。
6. 工具描述声明真实模型输出，不再统一虚构 `{ok, content, error}` JSON。
7. V1 不实现用户全局 Claude memory、`.claude/rules/` 或 `@import`。

## Tasks

### PCV2-01：文档与基线

登记 ADR、计划、文档映射和 legacy/V2 token fixture，保存可复现基线而非手工估算。

### PCV2-02：Prompt 与项目指令分层

新增 V2 System Prompt 和 ProjectInstructionSnapshot。首轮读取 Workspace 根规则；从 transcript 中的文件目标加载嵌套 scope。项目指令独立于 System Prompt，并在真实用户消息之前投影。

### PCV2-03：动态 Runtime 投影

把实际 sandbox backend 传入 Context Projection；合并重复 plan reminder，生成唯一 `<runtime-state>`；digest 纳入 Prompt 版本和项目指令 revision。

### PCV2-04：工具契约与 Phase surface

结构化 ToolContract，提供 legacy/concise formatter；修正文件/Web 工具返回说明。V2 Planning 隐藏 edit/write/shell，Task schema 只允许 explore/plan，动态 MCP 过滤 effectful/unknown capability。

### PCV2-05：MCP 描述 admission

为 CapabilityDescriptor 增加 description provenance 和 modelDescription；按配置来源决定 trusted/generated，统一清理、截断、搜索索引、动态 Tool projection 和 revision identity。

### PCV2-06：Subagent 与评测

移除旧 Skill 和审批规避文本；Subagent 接收项目指令。增加 token gate 与 opt-in live A/B runner，只保存聚合与脱敏结果。

### PCV2-07：文档收敛与验证

更新 active/book 文档并执行 typecheck、format、lint、core boundary、docs impact、docs 和默认测试。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| PCV2-01 | 无 | Plan、ADR、索引、token fixture | `bun run check:docs` | 文档可独立回退 |
| PCV2-02 | PCV2-01 | Prompt V2、project instruction loader | Prompt/instruction 单测 | Flag 关闭不投影 V2 |
| PCV2-03 | PCV2-02 | Context Projection、runtime snapshot | context/runtime-context 单测 | legacy 同样保留正确 sandbox |
| PCV2-04 | PCV2-03 | ToolSpec contract、phase surface | tool registry/controller 单测 | legacy formatter 保留两周 |
| PCV2-05 | PCV2-03 | MCP descriptor/admission | MCP supervisor/search 单测 | 缺失字段按 generated fallback |
| PCV2-06 | PCV2-02,PCV2-04 | Subagent、token gate、live runner | subagent/eval 单测 | live 无凭据报告 skipped |
| PCV2-07 | PCV2-02..06 | active/book 文档、验证记录 | 全部门禁 | Flag=false 回滚整体 V2 |

## 风险与回滚

- 项目指令可能放大不可信仓库内容：保持 user-role、范围/大小/链接门禁，系统安全优先。
- Phase 裁剪可能减少规划能力：保留 read/search/web/plan/ask_user 和 explore/plan Task；Runtime Policy 仍是最终权威。
- MCP 描述可能包含提示注入：只对 admitted 来源采用，标记为外部元数据，未信任来源永不投影原文。
- 双 formatter 可能漂移：两者从同一结构化 ToolContract 生成；旧 formatter 至少保留两周，后续 ADR/证据再改默认。
- 回滚设置 `promptContractV2=false`；不得恢复错误 sandbox、旧 Skill 名或虚假输出格式。

## 验收

- V2 固定 token fixture ≤ legacy 70%，单工具描述和项目指令上限可诊断。
- Planning 不披露 edit/write/shell，Task 只允许 explore/plan，effectful MCP 不披露。
- 项目指令顺序、scope、变更刷新、大小和链接边界有确定性测试。
- 动态状态只有一个 block，包含真实 sandbox backend 和完整 plan lifecycle。
- 工具契约与实际 ProjectedToolResult 格式一致；旧 Skill/审批规避文本为零。
- live A/B runner 可 dry-run；无凭据显式 `live_eval_skipped`。
- `bun run check:docs-impact`、`bun run check:docs` 和相关验证全部通过。

## 2026-08-08 验收记录

实现任务 PCV2-01 至 PCV2-07 已落地。固定 fixture 计入 14 个默认内置工具，结果为 legacy 9,288 tokens（System 2,578 + tools 6,710），V2 3,729 tokens（System 457 + tools 3,272），下降 59.85%；70% 门槛为 6,501 tokens。

以下门禁通过：

- Prompt/context/tool/MCP/Planning/Subagent/instruction/eval 专项：280 pass、0 fail；
- `bun run typecheck`；
- `bun run format:check`；
- `bun run lint`（仅仓库既有测试文件的 18 条 `noExplicitAny` warning）；
- `bun run check:core-boundary`；
- `bun run check:docs-impact`；
- `bun run check:docs`；
- `git diff --check`；
- `bun run test:prompt:live` dry-run：10 个类别，`live_eval_skipped`，`contentLogged=false`。

同日经用户明确授权，使用当前默认 `deepseek / deepseek-v4-flash` 完成真实 A/B：legacy 30 次中通过 23 次（76.67%），V2 30 次中通过 24 次（80.00%），相对提升 3.33 个百分点；两组 invalid tool calls 均为 0、invalid argument calls 均为 2，重复 Tool Call 从 legacy 7 次降为 V2 5 次，安全违规均为 0。总耗时分别为 60,813 ms 与 61,656 ms，`contentLogged=false`。因此真实模型层面的安全、成功率、参数错误率和无效重复调用验收均满足本轮阈值；该证据不替代 production TUI E2E 或下述默认全套测试门禁。

## 2026-08-09 完成记录

Windows 全量门禁已收敛。修复内容包括：用 `System32` 的 `whoami.exe`/`icacls.exe` 实施并验证 owner-only、禁继承 ACL；允许不需要开发者模式的目录 junction 覆盖 Windows reparse-point 测试，同时把只能由 POSIX 文件 symlink 表达的断言保留在对应平台；移除 POSIX mode 和路径分隔符的跨平台假设；接受 Windows 大于 safe-integer 上限的 opaque inode；使测试 fixture 使用实际存在且仍受 allowlist 保护的 verifier；为真实 Windows ACL/进程身份/平台探测配置 30 秒外层测试预算；零延迟 TUI helper 不再创建数百个零毫秒 timer。所有改动均保留产品侧 fail-closed 语义。

最终 `bun run test` 在当前 Windows 主机成功退出：主 suite 3,127 pass、7 skip、0 fail（3,134 tests），随后 5 个 process-isolated 文件全部通过（8 + 6 + 6 + 2 + 4 pass）。Prompt Contract 专项复验 173 pass、0 fail；token fixture 结果保持 legacy 9,288、V2 3,729，下降 59.85%。最终 `typecheck`、`format:check`、`lint`、`check:core-boundary`、`check:docs-impact`、`check:docs` 与 `git diff --check` 全部通过，lint/format 仍只报告仓库既有的 18 条 `noExplicitAny` warning。PCV2-01 至 PCV2-07 的实现、文档、确定性门禁与真实模型证据均已完成，本计划关闭。
