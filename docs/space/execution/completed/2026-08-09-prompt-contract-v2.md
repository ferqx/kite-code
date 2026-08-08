# Prompt Contract V2 完成记录

状态：completed
完成日期：2026-08-09
计划：[`../../plans/2026-08-08-prompt-contract-v2.md`](../../plans/2026-08-08-prompt-contract-v2.md)
架构：[`../../../adr/0090-prompt-contract-v2.md`](../../../adr/0090-prompt-contract-v2.md)

## 完成范围

- 将模型上下文拆分为稳定 System Prompt、cacheable environment、带来源的项目指令和唯一动态 Runtime 状态；
- 新增默认关闭的 `promptContractV2`，legacy/V2 共用正确的 sandbox、Skill 名称和工具事实；
- 支持 Workspace 内 `CLAUDE.md`/`AGENTS.md` 的父子 scope、大小/token/link 门禁和写前 revision 刷新；
- ToolSpec 从同一结构化契约生成 legacy 与 concise 描述，输出格式与 `projectResult()` 一致；
- V2 planning 隐藏 write/edit/shell，并将 Task 子类型和动态 MCP 能力限制为只读 surface；
- MCP description 增加 provenance、清理、512 code point 上限、generated fallback 和 revision binding；
- Subagent 继承项目指令 snapshot，移除旧 `Skill` 和审批规避提示；
- 增加固定 token gate 与 opt-in 真实模型 A/B runner，runner 仅保存聚合与脱敏失败分类；
- 收敛 Windows 全量门禁中的 ACL、reparse point、路径分隔符、POSIX mode、opaque inode、测试 deadline 和 fixture 平台假设。

## 验证证据

- Token fixture：legacy 9,288（System 2,578 + tools 6,710），V2 3,729（System 457 + tools 3,272），下降 59.85%，低于 70% 门槛 6,501；
- 真实默认模型 `deepseek/deepseek-v4-flash`：legacy 23/30（76.67%），V2 24/30（80.00%）；安全违规 0/0，invalid tool 0/0，invalid args 2/2，重复 Tool Call 7/5，`contentLogged=false`；
- Prompt Contract 最终专项复验：173 pass、0 fail；
- `bun run test`：主 suite 3,127 pass、7 skip、0 fail，5 个 process-isolated 文件全部通过；
- `bun run typecheck`、`bun run format:check`、`bun run lint`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、`git diff --check` 全部通过；format/lint 仅保留仓库既有测试的 18 条 `noExplicitAny` warning。

`promptContractV2` 仍默认关闭。关闭 Flag 可回滚 V2 排布、项目指令投影、phase 工具裁剪和可信 MCP 语义投影，但不会恢复已修正的错误 sandbox、旧 Skill 名、虚假工具结果说明或安全缺陷。默认值改为 `true` 仍需独立的生产 TUI E2E 与后续决策。
