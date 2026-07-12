# 当前规则：工具描述即契约

状态：active
最后更新：2026-05-06
最后验证：2026-05-06
范围：

- `src/tools/tool-contracts.ts`
- `src/tools/definitions.ts`（description 字段）
- `src/tools/apply-patch.ts`（APPLY_PATCH_DESCRIPTION 常量）
- `tests/tool-definitions.test.ts`（契约验证测试）

读取时机：

- 创建或修改工具定义，包括新增工具、调整 schema 或修改 description。
- 修改 `src/tools/tool-contracts.ts` 中的契约结构或内容。
- 修改工具的实际行为（`src/tools/file.ts`、`src/tools/shell.ts`、`src/tools/apply-patch.ts`），需要同步更新契约。
- 修改 `src/harness/tool-runner.ts` 中的工具执行逻辑、错误处理或 `toolUsageGuidance()`。
- 新增工具注册到 `definitions.ts` 的 `createAgentTools()`。

相关：

- `./tool-gated-autonomy.md`
- `docs/space/execution/completed/2026-05-06-tool-description-contracts.md`
- `docs/space/understanding/space-system-design.md`

验证：

- `bun test tests/tool-definitions.test.ts`
- `bun run typecheck`

## 规则

### 核心原则

工具描述是 ACI（Agent-Computer Interaction）一等 UX，投资程度应与 HCI 等同。每份工具描述必须是可验证的契约，而不仅仅是功能说明。

### 契约结构

每个工具的契约必须包含四个 section：

1. **whenToUse** — 何时使用此工具，以及何时应改用其他工具。必须至少提及一个替代工具名称。
2. **commonMistakes** — 模型常见的误用模式，描述具体的错误行为和后果。
3. **outputFormat** — 期望的 JSON 返回格式，包括关键字段名和成功/失败时的典型值。
4. **failureHandling** — 失败后应如何解读错误信息、采取什么恢复步骤。

### 契约存放与绑定

- 所有契约定义在 `src/tools/tool-contracts.ts` 中，以 `export const XXX_CONTRACT` 形式导出。
- 契约通过 `TOOL_CONTRACTS` Map 注册，key 为工具名称。
- `definitions.ts` 中的 `tool()` 调用必须使用对应契约的 `.description` 字段，不得硬编码 description 字符串。
- 契约的 `description` 字段由 `buildDescription()` 从四个 section 拼接生成，格式为：

  ```
  [whenToUse]
  Common mistakes: [commonMistakes]
  Output: [outputFormat]
  Failure: [failureHandling]
  ```

### 契约与实现的同步

- 修改工具实现行为时必须同步更新对应契约的四个 section。
- 修改 `tool-runner.ts` 中的执行结果格式、错误信息或 `toolUsageGuidance()` 时，必须检查契约的 `outputFormat` 和 `failureHandling` 是否一致。
- 新增工具时必须先创建契约，再在 `definitions.ts` 中注册。

### apply_patch 特殊处理

`APPLY_PATCH_CONTRACT` 的 `description` 字段保留原始 `APPLY_PATCH_DESCRIPTION` 常量（Codex 风格的补丁格式规范），不经由 `buildDescription()` 生成。当 `apply_patch` 工具接入 `definitions.ts` 时，需决定是否将四个 section 合并到最终 description。

## 不要做

- 不要在 `definitions.ts` 中硬编码 description 字符串；必须引用契约的 `.description`。
- 不要把契约 section 视为自由文本；它们必须反映实际工具行为，不能美化或隐藏限制。
- 不要修改工具实现后不同步更新契约。
- 不要新增工具却不创建对应契约。
- 不要让契约测试只检查"非空"；测试必须验证四个 section 各自满足质量标准（替代工具引用、失败模式关键词、JSON 字段提及、恢复步骤可操作性）。

## 测试期望

`tests/tool-definitions.test.ts` 中 `tool contracts (ACI)` describe 块应断言：

- 每个注册工具都有对应契约。
- 每个契约的四个 section 长度均大于合理阈值。
- 每个契约的 `description` 包含所有 section 内容（部分验证一致性）。
- `definitions.ts` 中 `tool().description` 必须完全等于对应契约的 `description`。
- 每个工具的 `whenToUse` 至少提及一个其他工具名称。
- 每个工具的 `commonMistakes` 包含可识别的失败模式关键词。
- 每个工具的 `outputFormat` 提及 `ok` 字段。
- 每个工具的 `failureHandling` 包含可执行的恢复动作。
- `shell_execute` 契约专项覆盖 intent 枚举和审批拒绝场景。
- `apply_patch` 契约已存在且结构完整。
