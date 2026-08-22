# 当前规则：实证研究归档

状态：active
最后更新：2026-05-01
最后验证：2026-05-01
范围：

- `docs/space/**`
- 真实模型、provider 行为、prompt cache、性能和上下文布局实验
- `packages/builtin-runtime/src/model/**`
- `packages/agent-kernel/src/**`
- `packages/runtime-host/src/**`
- `apps/kite/src/bootstrap/runtime/**`
- 与实证结论直接相关的测试文件

读取时机：

- 运行真实 provider 实验、缓存命中率实验、性能实验或多轮 agent 行为实验。
- 根据实验结果修改模型上下文、provider 适配、运行时事件、缓存指标或工具协议。
- 用户要求“研究”“实验”“对比”“归档”“记录”某类可复用工程结论。
- 某个结论如果被未来 agent 遗忘，可能导致重复实验、错误回滚或重新踩坑。

当前版本没有 evaluation 或真实 Provider 测试入口；未来重新建立实验框架时必须先创建新计划、明确数据边界和
显式发现规则，不能恢复已删除的 `scripts/evals` / `tests/evals`。

相关：

- `docs/space/understanding/space-system-design.md`
- `documentation-language.md`
- `plan-state-reminder.md`
- `docs/space/execution/completed/2026-05-01-prompt-cache-runtime-state-research.md`

验证：

- `bun test tests/docs-space.test.ts`
- `git diff --check`

## 规则

当 agent 做了会影响未来实现判断的实证研究时，必须在同一任务中创建或更新 `docs/space` 记录，除非用户明确要求不要写文档。

应归档的研究包括：

- 真实模型或 provider 行为，例如 DeepSeek prompt cache、tool call 兼容性、system message 处理差异。
- prompt 或上下文布局实验，例如消息顺序、消息 role、压缩策略、运行时状态投影。
- 会影响架构选择的性能、可靠性、恢复执行或缓存命中率数据。
- 用户要求“以后 agent 自动理解”“积累记录”“避免未来忘记”的主题。

归档位置按用途选择：

- 形成当前约束时，更新或新增 `docs/active/` 记录。
- 记录一次已完成实验、实现和验证时，新增 `execution/completed/` 记录。
- 只解释背景和思路、不直接约束未来改动时，新增或更新 `understanding/` 记录。
- 外部资料摘要放入 `references/`，不能直接替代本地实验记录。

实证归档至少应包含：

- 研究问题或假设。
- 运行环境和关键边界，例如 provider、访问模式、上下文预算、是否真实模型。
- 变量和对照，例如消息 role、消息顺序、是否读取新文件、是否更新 plan。
- 精确指标，例如 `inputTokens`、`cacheHitTokens`、`cacheMissTokens`、命中率和是否计入标准。
- 结论、限制和剩余风险。
- 影响到的源码、测试和文档。
- 已运行的验证命令。

记录数据时应使用精确数字，不用“很好”“很差”替代指标。短轮次、warmup、首次读取大文件这类会影响解释的条件必须写清楚。

## 不要做

- 不要只把实验结论留在聊天记录里。
- 不要只记录符合预期的数据，失败实验和反例也要归档。
- 不要把 checkpoint 数据库、密钥、本地配置或大型工具输出原文写进文档。
- 不要为了归档而复制整段命令输出；应摘要命令目标、变量和关键指标。
- 不要让 completed 记录变成当前规则；需要约束未来行为时必须更新 active 记录。

## 测试期望

`tests/docs-space.test.ts` 应继续保证：

- 所有 active 记录都由 `docs/space/index.md` 的兼容索引覆盖。
- active 记录包含中文元数据标签。
- 仓库内没有 `docs/superpowers/` 生成物。
