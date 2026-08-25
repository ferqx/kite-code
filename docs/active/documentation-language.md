# 当前规则：文档语言

状态：active
最后更新：2026-08-26
最后验证：2026-08-26
范围：

- `README.md`
- `README.zh-CN.md`
- `AGENTS.md`
- `docs/**/*.md`
- `packages/*/README.md`、`packages/*/docs/**/*.md`
- `apps/*/README.md`、`apps/*/docs/**/*.md`
- `tests/README.md`
- 文档结构与链接检查（`scripts/check-docs.ts`）

读取时机：

- 创建或修改任何 Markdown 文档。
- 修改 `docs/space` 记录格式。
- 修改文档结构或文档索引测试。

相关：

- `docs/space/understanding/space-system-design.md`
- `docs/space/execution/completed/2026-04-27-harness-engineering-doc-hygiene.md`
- `docs/space/execution/completed/2026-04-27-documentation-language-standard.md`

验证：

- `bun run check:docs`
- `bun test tests/integration/docs-space.test.ts`
- `bun test tests/integration/docs-impact.test.ts`
- `git diff --check`

## 规则

除根 README 的双语入口外，仓库 current 文档内容以中文为标准。Workspace README、本地文档、测试入口、Markdown 标题、段落、列表说明、元数据标签和维护规则都使用中文。`README.md` 是默认显示的英文入口，`README.zh-CN.md` 是对应的中文入口；两份文件必须保持事实、命令和链接同步，并通过顶部语言链接互相跳转。

可以保留英文的内容：

- 命令、路径、包名、类型名、函数名、配置键、provider 类型等机器可读 token。
- 代码块中的示例代码、JSON、shell 命令和测试名称。
- 外部项目或产品的正式名称，例如 OpenAI、Codex、LangGraph、DeepSeek、Opencode。
- 状态枚举值，例如 `active`、`completed`、`understanding`、`reference`、`generated`。
- 根 `README.md` 的英文正文；其中文对应版本必须保留在 `README.zh-CN.md`。

## 不要做

- 不要新增以英文段落为主的 Markdown 文档。
- 不要把英文元数据标签（例如 `Status:`、`Read when:`、`Verification:`）作为 `docs/space` 的标准格式。
- 不要为了翻译而改动代码行为、测试语义或配置键。

## 测试期望

文档影响规则以行为 owner 为粒度，而不是以整个 workspace 树为粒度。通用 package/App 规则只覆盖生产
`src/**` 与 manifest；普通 owner test、fixture 和本地文档不触发架构文档。Model、MCP、Sandbox、TUI、
qualification、release/platform 与 observability 使用专业规则，并从通用规则排除。代表路径测试必须证明
纯测试改动不触发架构 authority、专业路径只命中对应规则、测试 runner/CI 基础设施仍命中 `tests/README.md`。

`tests/integration/docs-space.test.ts` 应检查 `docs/active/` 记录使用中文元数据标签，并继续检查 active 记录被 `docs/space/index.md` 的兼容索引覆盖。

`bun run check:docs` 必须检查根 README、workspace README/本地文档、测试入口、active、book、runbook 与当前索引的本地链接可解析、不得使用未渲染的 `[[wiki-link]]` 语法、每份 active 记录在首个章节前恰好声明一次必填元数据，并完整验证 `docs/documentation-map.json` V2。ADR、plan、completed、design 与 deprecated 保留实施当时的路径事实，不因后续 current 文档搬迁改写，也不作为当前链接门禁输入。代码块和行内代码中的 Markdown 示例不属于链接校验对象。
