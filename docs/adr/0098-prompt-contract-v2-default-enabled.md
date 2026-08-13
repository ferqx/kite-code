# ADR-0098：Prompt Contract V2 默认启用并保留 legacy 回滚

状态：accepted
日期：2026-08-12
决策者：github:@ferqx
取代：ADR-0094 的默认关闭决策；不删除 ADR-0092 定义的 legacy 回滚路径

## 背景

ADR-0094 根据旧最终候选的 30 次首决策样本保持 `promptContractV2=false`。后续审计确认旧评测把不存在的
文件、非默认 Skill/capability 工具面、project-instruction treatment 和普通质量用例混入同一分母，并且只看
首个模型响应，不能观察工具错误后的自主恢复。ADR-0096 已明确要求把首决策选择与真实 Runtime Journey 分开。

本次候选固定使用 OpenCode Go `deepseek-v4-flash`、1024 output-token 上限、`full/full_access`，主 A/B 的
每一对使用一次性无敏感工作区，project-instruction effect 使用独立 synthetic treatment/control。关键候选文件
SHA-256 为：

- `system-prompt-v2.txt`：`a24ace180ae746b3730a505808a877d0ff5e293bbef8e8ddf7134e0638906b97`；
- `tool-contracts.ts`：`e09047f684ee4ff3d82b46e0c6147b60a2d759e1b5756de64a27f125cb9c882d`；
- `context-projection.ts`：`5521d4b55c512778e02aa3c15879bf710a0dbc80994f23ffa454213367c0dafa`；
- `subagent/runner.ts`：`8ff50cd7eef7ef112356bfd3aa4ed0688923989e3ba32c4ad4448db9de146070`。

修正后的正式证据为：

1. 七类 × 十轮 legacy/V2 AB/BA：legacy 60/70（85.71%），V2 61/70（87.14%）；配对 V2-minus-legacy
   为 +1.43 个百分点，95% 区间 `[-4.87pp, +7.73pp]`，5pp 不劣门槛通过。两臂安全违规、无效工具和
   精确重叠调用均为 0；140/140 model response、HTTPS 2xx、usage 与唯一 Provider response ID 完整闭合。
   V2/legacy input token 为 347,751/537,711，V2 减少约 35%。
2. 独立 project-instruction effect probe：V2 10/10、legacy 0/10；20/20 Provider evidence 完整闭合。
   它只证明动态项目规则注入的因果效果，不进入主 A/B 分母。
3. production Runtime task journey：natural delegation 与 `invalid_arguments → model_correction` 各运行三次；
   V2 和 legacy 两臂均为 3/3。纠错场景每次都先产生未 dispatch 的 `tool_invalid_args/invalid_arguments`，
   再由模型发出带 `recoveryOf` 的合法调用，子 Agent 完成、父 Agent 在 Tool Result 后继续并以
   `run.completed` 收敛。V2 每次 4/4 Provider evidence 完整闭合。
4. 默认 production TUI 场景验证 V2 system/cache/project/runtime 消息顺序、planning 工具面与完整 Plan lifecycle；
   确定性 ToolSpec、Runtime recovery、类型和文档门禁继续作为必要条件。

首决策不再要求随机模型每类 10/10。门禁要求配对不劣、零安全违规、零无效工具、零精确重叠调用，以及
非 `subagent_planning` 类别零参数错误；task 参数构造与恢复由独立 production Runtime journey 负责。
`candidatePerfect` 继续作为诊断字段，但不能替代或否定整轮证据。

## 决策

1. `DEFAULT_FEATURE_FLAGS.promptContractV2` 改为 `true`，新会话默认使用 V2 system/tool prompt、动态项目规则、
   phase-aware 工具面与 Runtime state 投影。
2. 保留 `--feature promptContractV2=false` 和配置中的 false 作为 legacy 回滚；本 ADR 不授权删除 legacy 文案、
   schema 或测试。
3. 项目 `CLAUDE.md`/`AGENTS.md` 继续在每次模型请求时从磁盘刷新，位于 durable transcript 之后、Runtime state
   之前；它是 synthetic user context，不能提升权限或改变 Runtime Policy。
4. task 参数/执行错误只返回结构化工具结果，由模型自主调整；Runtime 不替模型生成参数，也不自动重放
   `correct_args` 调用。
5. 后续修改 V2 system prompt、published tool description、项目规则顺序或 task recovery 门禁，必须重新运行
   匹配改动面的真实证据；不得沿用本 ADR 自动接受新候选。

## 备选方案

1. **继续默认关闭直到 first-decision 70/70**：拒绝。它把随机模型首调用当成产品整轮成功，并与 ADR-0096
   的恢复评测决策冲突；受控真实 Journey 已证明参数错误能自主收敛。
2. **删除 legacy**：拒绝。默认迁移仍需要低成本、明确的运行时回滚面。
3. **只依据 project-instruction 10/10 开启**：拒绝。effect probe 不覆盖普通工具选择、安全和 Runtime 恢复；
   本决策使用三类互补证据共同准入。

## 影响

- 未显式配置该 flag 的新运行默认使用 V2；已有显式 false 配置保持 legacy。
- V2 默认读取工作区项目规则，仍受文件/快照/token 预算和低权限上下文边界限制。
- 真实模型评测只保存聚合计数，不保存 prompt、response、工具参数、Provider response ID 或仓库正文。
- ADR-0094 保留为历史决策，不改写其当时结论。

## 回滚

将 `DEFAULT_FEATURE_FLAGS.promptContractV2` 改回 false，或在单次运行/配置中显式设置
`promptContractV2=false`。回滚不删除 project-instruction/capability revision、Plan、Runtime history 或
typed tool outcome；正确性和安全修复不随 prompt flag 回滚。
