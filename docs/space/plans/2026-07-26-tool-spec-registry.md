# ToolSpec Registry 实施计划

状态：active
创建：2026-07-26
优先级：P0
依赖：ADR-0026（已接受）
替代：无
设计依据：[`docs/design/2026-07-26-tool-spec-registry-rfc.md`](../../design/2026-07-26-tool-spec-registry-rfc.md)

## 目标

落实 ADR-0026：把模型工具层收口为单一事实源（ToolSpec Registry），消除八点已核实漂移；模型 ToolSet 全部 schema-only；副作用与审批输入不再信任模型自我声明。本计划覆盖阶段 0（漂移止血）与阶段 1（Registry 骨架 + 六个计算原语）；阶段 2/3 见 RFC §6，另行细化。

## 范围

- `src/core/tools/`（definitions.ts、tool-contracts.ts、file.ts、新增 registry/）
- `src/core/harness/`（tool-requests.ts、tool-runner.ts）
- `src/core/policies/`（tool-capabilities.ts、approval-policy.ts）
- `src/core/controllers/tool-controller.ts`
- `src/core/skills/catalog.ts`
- `src/app/tui/components/render-utils.ts`（仅删除死映射）
- 相关测试（approval-policy.test.ts、tool-policy.test.ts、tool-definitions.test.ts、新增一致性测试）
- 文档（ADR-0026、active 记录随实施更新）

## 阶段 0：漂移止血（无行为变化 / 仅文本变化）

- [x] **S0.1 删除 `match_mode`**
  - 改动：`definitions.ts:139-144` Schema 字段删除；`tool-contracts.ts` edit failureHandling 删除 `match_mode: 'trimmed'` 引导句（保留对现有降级行为的准确描述）。
  - 依据：该参数在请求解析（`tool-requests.ts:349-368`）与执行（`tool-runner.ts:332`）中本就被丢弃，删除零行为变化。
  - 验证：`bun run typecheck`；全仓 grep `match_mode` 为零。

- [x] **S0.2 `read_file` 二进制错误文本重写**
  - 改动：`file.ts:193` 错误不再要求 "Use force: true to read anyway"（模型表面无 `force`，恢复路径不可达），改为引导向用户确认；底层 `opts.force` 保留供内部与测试。
  - 验证：grep `Use force: true` 为零；`bun test` 文件工具用例。

- [x] **S0.3 删除旧 `Skill` 遗留**
  - 改动：`tool-requests.ts` 联合变体（:186-195）与 `toolRequestFromCall` 解析分支（:531-540）；`tool-controller.ts:1135-1143` 总是拒绝分支；`tool-capabilities.ts:35`、`approval-policy.ts:449-458`、`render-utils.ts:21` 对应条目；`tests/policies/approval-policy.test.ts:753-763`、`tests/tool-policy.test.ts:383-392` 对应测试。
  - 依据：模型表面无 `Skill` 工具（`tool-definitions.test.ts:361` 断言）；遗留调用经 `toolRequestFromCall` 返回 null 后走统一未知工具拒绝路径，语义与旧"总是拒绝"一致。
  - 验证：`bun run typecheck`；相关测试套件。

- [x] **S0.4 删除 `list_files` 幽灵条目**
  - 改动：`tool-capabilities.ts:27`、`skills/catalog.ts:32`。
  - 验证：grep `list_files` 在 src 下为零。

- [x] **S0.5 删除死代码 `toolRequestFromMessage()`**
  - 改动：`tool-requests.ts:630-828`（全仓库零调用，与 `toolRequestFromCall` 逐分支重复）。
  - 验证：`bun run typecheck`；grep `toolRequestFromMessage` 为零。

- [x] **S0.6 shell/搜索契约措辞收敛**
  - 改动：`tool-contracts.ts` 中 search_content（:144-145）、search_files（:173-174）、shell_execute（:200-201、:210）的权限式 "NEVER use grep/rg/find" 改为一句话偏好引导（专用工具提供 .gitignore 处理与结构化结果）。**不动** `intent` / `grant_request` 相关句子（:204、:208）——参数收敛是阶段 1 的 Schema 联动项，阶段 0 保持契约与 Schema 一致。
  - 验证：golden 测试（已核实 tests/golden 不引用这些字符串）；`bun test`。

- [x] **S0.7 全量验证**
  - 命令：`bun run typecheck`、`bun test`、`bun run check:core-boundary`、`bun run check:docs`、`bun run check:docs-impact`。
  - 完成标准：全部通过；直调 `.execute()` 的测试（`tool-definitions.test.ts:120,216,219`）本阶段仅登记为阶段 1 迁移项，不改动。

## 阶段 1：Registry 骨架 + 六个计算原语

- [x] **S1.1 Registry 基建**
  - 新增：`src/core/tools/registry/spec.ts`（ToolSpec 接口、ToolKind、ToolEffects、ProjectedToolResult）、`registry.ts`（注册/查找/availableIn/toSchemaOnlyToolSet/parseToolCall/descriptorOf）、`dispatch.ts`（pre-gates 上提 + preExecute 钩子 + execute + projectResult）。
  - 新增一致性测试 `tests/tools/tool-registry-conformance.test.ts`：RFC §5 不变量 i1-i10 骨架（i1 args 透传恒等、i2 schema-only、i3/i4 名集闭合、i5 写工具 mutation scope、i6 描述纯函数、i9 revision 确定性、i10 shell 分类不读治理参数）。
  - 新增 feature flag `toolSpecRegistryV1`（`src/core/config/features.ts`，默认 false，双值测试；遵循 `docs/active/feature-flags.md`）。
  - 验证：`bun test tests/tools/tool-registry-conformance.test.ts`、`bun test tests/config/features.test.ts`。

- [ ] **S1.2 逐工具迁移**（每工具一个 PR，flag 在 `executeRuntimeTools` 入口按工具名单路由，任一时刻单路径生效）
  - 已迁移：`read_file`（2026-07-26：spec + Registry 泛型解析委托 + runner dispatch 收敛 + schema-only 模型条目）。
  - 已迁移：`search_content`、`search_files`（2026-07-26：同模式；直调 execute 的测试改为经 dispatch 验证）。
  - 顺序：`read_file` → `search_files` → `search_content` → `write_file` → `edit_file` → `shell_execute`。
  - 每个工具：执行器从 runner 分支搬入 `spec.execute`（不改语义）→ 删除 definitions.ts 的带 execute 条目与 tool-requests/tool-contracts/tool-capabilities 对应分支 → description 逐字节稳定（golden 守护）→ 直调 execute 的测试改为经 dispatch。
  - `shell_execute` 迁移**含** ADR-0026 §2 参数收敛：`ShellActionEnvelope` 删七个治理字段；inspect 快车道纯命令形态化（审计 approval-policy 对 intent 的依赖）；`action` 元数据改为分类派生。
  - `edit_file` 迁移**含** ADR-0026 §3 与 ADR-0025 §1/§2：findMatch 默认 exact（降级链 opt-in）、先读后改/过期拒绝 preExecute 钩子、write_file 删除 `mode` 与 append 分支。
  - 验证：每 PR 跑 `bun test`、`bun run typecheck`、golden、`bun run test:e2e` 相关子集。

- [ ] **S1.3 flag 全量化与旧路径清理**
  - 前置：ADR-0026 已接受（✅）、生产 TUI 路径 e2e 覆盖、flag 双值灰度 ≥2 周。
  - 改动：`toolSpecRegistryV1` 默认 true → 独立清理 PR 删除 runner/requests/policy 旧分支与 flag。
  - 验证：全量 `bun test`、`bun run test:e2e`、golden。

## 风险

- **双路径不一致**：flag 按工具名单路由保证单路径生效；一致性测试 i2/i3 持续运行。
- **严格 Edit 抬高失败率**：ADR-0025 已预期为设计意图；失败引导文本提供重读指引；e2e 观察。
- **shell 快车道命中率回归**：迁移前后对比只读命令免审命中率；`git status` 类命令不得新增审批。
- **prompt cache 抖动**：description 字节稳定由 golden 守护；Schema 变更集中在 S0 与 S1.2 的 edit/write/shell 批次。
- **回放兼容**：`PendingToolRequest` 序列化形状与模型名不变；`getPendingToolRequest` 悬空调用恢复路径改由 `registry.parseToolCall` 驱动，行为等价。

## 完成定义

- RFC §11 验收条件全部满足；
- 阶段完成后按 `docs/space/` 生命周期转入 `execution/completed/`，受影响 `docs/active/`（tool-description-contracts、tool-gated-autonomy、authorization、file-reading-shared-boundary、capability-progressive-disclosure）已与实现同批更新。
