# 完成记录：文档中文标准

日期：2026-04-27
状态：completed
相关：

- `../active/documentation-language.md`
- `../../understanding/space-system-design.md`

## 变更

将仓库 Markdown 文档标准调整为中文：

- `README.md` 改为中文说明。
- `docs/space` 的索引、active 规则、completed 记录、understanding 记录、reference 记录和 generated 边界说明改为中文。
- `AGENTS.md` 增加文档中文标准提醒。
- `tests/docs-space.test.ts` 增加检查，防止 `docs/space` 重新使用旧英文元数据标签。

## 理由

后续 agent 的主要协作语言应与仓库文档保持一致。中文作为文档标准可以减少规则解释时的语言切换，也能让 `AGENTS.md`、`README.md` 和 `docs/space` 形成统一入口。

命令、路径、配置键、包名、provider 类型和正式项目名仍保留原文，以避免破坏机器可读语义。

## 验证

已验证：

```bash
bun test tests/docs-space.test.ts
git diff --check
```
