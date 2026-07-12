# 当前规则：文档语言

状态：active
最后更新：2026-04-27
最后验证：2026-04-27
范围：

- `README.md`
- `AGENTS.md`
- `docs/**/*.md`
- 文档结构测试

读取时机：

- 创建或修改任何 Markdown 文档。
- 修改 `docs/space` 记录格式。
- 修改文档结构或文档索引测试。

相关：

- `docs/space/understanding/space-system-design.md`
- `docs/space/execution/completed/2026-04-27-harness-engineering-doc-hygiene.md`
- `docs/space/execution/completed/2026-04-27-documentation-language-standard.md`

验证：

- `bun test tests/docs-space.test.ts`
- `git diff --check`

## 规则

仓库文档内容以中文为标准。Markdown 中的标题、段落、列表说明、元数据标签和维护规则都应使用中文。

可以保留英文的内容：

- 命令、路径、包名、类型名、函数名、配置键、provider 类型等机器可读 token。
- 代码块中的示例代码、JSON、shell 命令和测试名称。
- 外部项目或产品的正式名称，例如 OpenAI、Codex、LangGraph、DeepSeek、Opencode。
- 状态枚举值，例如 `active`、`completed`、`understanding`、`reference`、`generated`。

## 不要做

- 不要新增以英文段落为主的 Markdown 文档。
- 不要把英文元数据标签（例如 `Status:`、`Read when:`、`Verification:`）作为 `docs/space` 的标准格式。
- 不要为了翻译而改动代码行为、测试语义或配置键。

## 测试期望

`tests/docs-space.test.ts` 应检查 `docs/active/` 记录使用中文元数据标签，并继续检查 active 记录被 `docs/space/index.md` 的兼容索引覆盖。
