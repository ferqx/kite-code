# 完成记录：工具描述即契约

日期：2026-05-06
状态：completed

## 改了什么

- 新建 `src/tools/tool-contracts.ts`，定义 `ToolContract` 类型和 7 个工具的结构化契约（含未接入的 `apply_patch`），每份契约包含 `whenToUse`、`commonMistakes`、`outputFormat`、`failureHandling` 四个验证段。
- 更新 `src/tools/definitions.ts`，将 6 个注册工具的硬编码 `description` 字符串替换为对应契约引用。
- 扩展 `tests/tool-definitions.test.ts`，新增 10 个契约验证测试覆盖契约存在性、section 完整性、描述一致性、替代工具引用、失败模式、输出字段和恢复步骤。

## 为什么改

- 遵循 Anthropic ACI 原则："invest as much effort in ACI as in HCI"。
- 原有工具描述仅为功能性说明，缺少何时选择此工具而非彼工具、常见误用模式、输出格式约定和失败恢复指导。
- 结构化契约使描述可通过测试机械验证，避免回归。

## 涉及文件

- `src/tools/tool-contracts.ts`（新增，231 行）
- `src/tools/definitions.ts`（修改，6 处 description 替换）
- `tests/tool-definitions.test.ts`（修改，新增契约验证测试块）

## 验证

- `bun test tests/tool-definitions.test.ts`：17 pass，0 fail
- `bun test`：151 pass，0 fail（全量）
- `bun run typecheck`：通过

## 风险或未完成项

- `APPLY_PATCH_CONTRACT.description` 保留原始 `APPLY_PATCH_DESCRIPTION` 常量，未经由 `buildDescription()` 从 section 生成。当 `apply_patch` 接入工具列表时需决定是否统一格式。
- `tool-runner.ts` 的 `toolUsageGuidance()` 运行时提示与契约 `failureHandling` 存在功能重叠但层次不同（契约=主动指令，runtime=失败后响应）。已确认当前两者语义一致，无漂移。
- 契约内容准确性已验证（逐工具交叉比对 `file.ts`、`shell.ts`、`tool-runner.ts`、`tool-policy.ts`），但未来工具行为变更时需同步更新契约。
