# 参考：OpenAI Harness Engineering

状态：reference
来源：https://openai.com/zh-Hans-CN/index/harness-engineering/
阅读日期：2026-04-27
相关本地记录：

- `../index.md`
- `../understanding/space-system-design.md`

## 摘要

OpenAI 的 Codex harness engineering 文章把仓库描述为 agent 工作的主要记录系统。对本仓库最重要的启发不是增加更多 prompt 文本，而是让仓库更容易被 agent 导航、检查、验证和维护。

对本仓库的关键启发：

- `AGENTS.md` 应保持为简短地图，而不是长篇手册。
- 持久知识应进入结构化文档树，并通过索引链接。
- 持久计划和执行记录应是一等的版本化工件。
- agent 应使用渐进式披露：从稳定入口开始，再按链接读取相关细节。
- 文档需要新鲜度和垃圾回收规则；如果 agent 会把过期记录当作当前事实，过期文档比没有文档更危险。
- generated 材料在晋升为 active 本地规则前，必须有明确降级边界。
- 知识库结构应尽量通过机械检查验证，而不是只依赖 agent 指令。

## 本地影响

`docs/space/` 应提供：

- `README.md` 作为短入口。
- `index.md` 作为目录和状态视图。
- `../active/` 保存当前实现约束。
- `execution/completed/` 保存历史变更记录和验证。
- `references/` 保存非绑定外部摘要。
- `generated/` 保存不能自动成为规则的派生材料。

该参考支持一个本地规则：后续 agent 应先读索引，然后只读取与任务范围匹配的记录。

对本仓库而言，这并不意味着把每次运行的 `graph.state.plan` 写成文件。checkpoint 仍是每次运行计划状态的事实来源；`docs/space` 只记录围绕该行为的持久设计决策。

## 本地练习

2026-04-27 已将该指导落地为 `tests/docs-space.test.ts`：该测试验证 active `docs/space` 记录已被索引且真实存在，并验证 `docs/superpowers/` 不包含生成的计划文档。
