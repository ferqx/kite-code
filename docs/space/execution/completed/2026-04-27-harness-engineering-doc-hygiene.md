# 完成记录：harness engineering 文档卫生

日期：2026-04-27
状态：completed
相关：

- `../active/model-provider-boundary.md`
- `../active/real-model-test-boundary.md`
- `../../references/openai-harness-engineering.md`

## 变更

为仓库知识系统新增默认测试：

- `docs/space/execution/active/*.md` 记录必须列在 `docs/space/index.md` 中。
- 索引中列出的 active 记录必须真实存在。
- active 记录必须包含中文元数据：`状态：active`、`读取时机：` 和 `验证：`。
- `docs/space` 记录不能重新使用旧英文元数据标签。
- `docs/superpowers/` 不能包含生成的计划文档。

同时记录 agent 何时应把反复出现的 `docs/space` 知识晋升为 `ARCHITECTURE.md` 或 `SECURITY.md` 这类顶层入口文档，让未来 agent 不必等待用户直接提醒。

## 理由

OpenAI harness engineering 文章建议把 `AGENTS.md` 保持为地图，把持久知识移动到结构化仓库文档中，并用机械检查强制文档结构。本变更将该建议落成一个随默认本地测试运行的小 guardrail。

## 验证

已验证：

```bash
bun test tests/docs-space.test.ts
bun run typecheck
```
