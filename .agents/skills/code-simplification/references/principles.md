# 来源与取舍

以下资料用于形成判断准则，不替代当前仓库的需求、契约和运行证据，也不形成额外审批门禁。

| 来源 | 用于本 Skill 的判断 |
| --- | --- |
| [Martin Fowler, Refactoring](https://martinfowler.com/books/refactoring.html) 与[重构目录](https://refactoring.com/catalog/index.html) | 重构保持外部行为；Inline Function、Remove Middle Man、Remove Dead Code 等只是候选手法，须以具体调用链与测试判断。 |
| [Google, What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html) | 以整体设计、复杂度和代码健康衡量，警惕过度通用化及尚无需求的机制；删除代码时核对文档。 |
| [Google, Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html) | 用自洽的小改动降低审查与回退成本；重构通常与功能修改分开，纯重构也需要相关测试覆盖。 |
| [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments#interfaces) | 无实际使用场景时慎加接口；Go 的具体语法建议不直接移植为其他语言的硬规则。 |
| [Linux kernel coding style](https://cdn.kernel.org/doc/html/latest/process/coding-style.html) | 复杂表达式、一行多语句和过深嵌套会损害可读性；其代码风格约束不是本仓库的格式规范。 |
| [社区 code-simplifier Skill](https://github.com/codebeat/agent-skills-codex/blob/main/skills/code-simplifier/SKILL.md) | 参考其“范围、约束、候选、修改、验证”的工作流组织；不照搬其规则或将它视为权威。 |
| [DeepSeek Harness 的 dsh-find-simplifications Skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-find-simplifications/SKILL.md) 与[历史案例](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-find-simplifications/references/historical-patterns.md) | 借鉴完整效果路径、权威数据与重复状态、信任和生命周期 owner、净维护成本及反证的审查方法。决策记录按本仓 [Agent Notes 规范](../../../notes/README.md)执行；特定架构禁区及可接受行为收窄的取舍不直接移植，本 Skill 仍遵循当前仓库授权与契约。 |
