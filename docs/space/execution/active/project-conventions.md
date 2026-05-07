# 当前规则：项目约定

状态：active
最后更新：2026-05-07
最后验证：2026-05-07
范围：

- 所有 Markdown 文档与注释
- 测试行为与纪律
- CLI 接口与行为
- Git 提交与仓库卫生

读取时机：

- 修改文档、注释、测试行为、CLI 或提交规范时。
- CLAUDE.md 中引用本文件作为补充约定的场景。

相关：

- `model-provider-boundary.md`
- `documentation-language.md`
- `../completed/2026-04-27-harness-engineering-doc-hygiene.md`

验证：

- `bun test tests/docs-space.test.ts`

> CLAUDE.md 之外的补充约定。需要时查阅，不占用每次会话的上下文。

## 文档与注释

- 创建或修改 Markdown 文档以中文为标准；命令、路径、配置键、provider 类型等机器可读 token 保留原文。
- 注释只写在「不看上下文就难以理解」的地方，避免把显而易见的代码翻译成注释。
- 修改文档文件（README、AGENTS.md、注释）时不夹带功能性代码改动（除非任务明确要求）。

## 模型与 Provider

- **模型服务不是 DeepSeek-only**：修改 `src/config`、`src/model`、真实模型测试或 provider 文档前，先读 `docs/space/execution/active/model-provider-boundary.md`。
- 不要把真实模型端到端测试当成默认验证手段；只有改动涉及真实模型链路或用户明确要求时才运行。
- 真实模型测试文件命名不能是 `*.test.ts` / `*.spec.ts`，避免裸 `bun test` 误触发。

## 测试纪律

- 不在未说明原因的情况下跳过相关测试。
- 不要为让测试通过而改弱约束；优先修正实现，使行为继续满足既有测试语义。
- 如果现有测试和实现冲突，先确认哪一边表达的是当前真实规则，再决定修改测试还是实现。

## CLI 与接口

- 改了 CLI 行为或参数必须同步更新 `README.md` 和相关测试。

## 仓库卫生

- 不要提交本地 checkpoint、临时文件、密钥配置或 `tests/.tmp-*` 下的运行产物。
- 不要创建 `docs/superpowers/` 或 Superpowers 计划文档；需要持久项目规则时使用 `docs/space/`。
- 不要把 `tests/.tmp-*` 下的文件当成正式源码或稳定夹具。

## 提交粒度

- 只改完成当前任务所必需的内容，避免顺手重构无关模块。
- 如果只是帮助理解代码而不改变行为，可以只补注释，但不要顺手改写逻辑。
