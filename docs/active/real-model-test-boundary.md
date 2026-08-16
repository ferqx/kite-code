# 当前规则：真实模型测试边界

状态：active
最后更新：2026-08-13
最后验证：2026-08-13

读取时机：新增真实网络/模型测试、修改测试发现规则、package scripts 或声明 provider 端到端验证结果时。

验证：`bun test tests/test-discovery.test.ts tests/evals/live-provider-smoke.test.ts tests/evals/prompt-contract-ab.test.ts tests/evals/prompt-cache-transition.test.ts tests/evals/live-task-journey.test.ts tests/evals/tool-journey-v1.test.ts`、`bun run typecheck`。

相关：ADR-0068、ADR-0069、ADR-0093、`model-provider-boundary.md`、`open-source-first-release.md`。

## 当前状态

仓库注册了显式 opt-in 的 `test:model:live` package script，用于真实 Provider 的 context compaction direct/incremental summary 验证。默认 `bun run test` 通过 `scripts/run-default-tests.ts` 只运行确定性的本地/mock 测试：主 suite 使用 `--max-concurrency=1 --only-failures` 限制 Bun 共享进程中的测试和输出资源竞争；Windows 因真实 ACL、进程身份和平台探测存在固定启动成本，默认 test process 使用 30 秒单用例上限，其他平台保留 Bun 的 5 秒默认值。该 suite 包含快速 `tests/tui-system/harness/` 单元测试，但排除真实 PTY `scenarios/`、TUI/native sandbox smoke 与 spike；`tests/shell-exec.test.ts` 在默认门禁显式关闭 native sandbox，只验证统一 executor 的 Shell/进程树语义。Seatbelt/bubblewrap 正向执行由 `test:sandbox:smoke:native` 与 platform capability workflow 单独运行。每个 test process 都获得独立临时 `HOME`/`KITE_CODE_HOME`（Windows 同步 `USERPROFILE`），不得读取或修改开发机真实 Kite 配置、Plan 或 Session Log。会临时修改进程级 cwd 或 `KITE_CODE_HOME` 的少量路径测试还会逐文件启动独立 Bun 进程，避免进程级状态互相污染。不得改用 Bun per-file isolate；当前 Ink/Yoga ESM 在该模式下不能稳定初始化。`test:mock` 明确运行当前 context compaction Runtime E2E，同样不访问真实 provider。未实际执行 live runner 时，文档、PR 或完成记录不得表述为真实 provider 已验证。

Prompt Contract V2 注册唯一的 live 入口 `test:first-decision:live`。`scripts/evals/first-decision-eval.ts` 在同一 resolved Provider/model/temperature/fixture/初始状态和 1024 output-token 上限下比较 legacy/V2；只保留七类主 first-decision suite 与独立的项目规则 treatment/control effect probe。工具描述真实性由 production Registry 的确定性契约闭环覆盖，不再复制一套近似相同的 live fixture；task 首决策诊断直接由主 suite 的 `subagent_planning` 类别报告，不再维护同一 case 的别名 suite。`FirstDecisionEvalV1` 固定声明 `evaluationScope=first_decision_only`，不能报告工具执行、恢复、CompletionGuard 或 whole-turn 性能；`scripts/evals/prompt-contract-ab.ts` 只是 canonical runner 的内部实现模块。

first-decision live runner 固定使用经过严格 route 校验的 OpenCode Go `deepseek-v4-flash`，按用例和轮次交替 `AB/BA` 首发顺序，避免把 Provider 时段或负载漂移固定归因给一条路径。所有真实模型 agent 评测（主 suite 与 effect probe）固定为 production `interaction_mode=full`、`authorization_mode=full_access`；最小 provider smoke 不构造 agent runtime/tool surface，不适用该规则。每个 arm 必须分别证明 expected/started/succeeded model attempt、实际 HTTPS dispatch/response/2xx、usage 覆盖、input/output/total/cache-read token 汇总及 Provider response ID 覆盖与唯一数；只输出稳定 route alias、credential source、计数与 token 汇总，不输出 response ID 本身、完整 endpoint、system prompt、项目指令、用户/模型正文、工具参数或实际选择的参数值。主 suite 默认使用每对隔离、可删除、无敏感内容的 synthetic workspace，并只翻转 `promptContractV2`；不得为某条 fixture 额外打开 Skill、伪造 catalog 或强制披露工具。V2 的 eval prompt 必须复用生产的 project-instruction snapshot resolver：只在 V2 注入实际工作区规则，且顺序为真实 user turn 后、runtime state 前；`project_instruction_effect` probe 使用独立 synthetic workspace，其中根 `AGENTS.md` 为带有明确首个 `read_file` 参数的非自指规则，legacy 不接收它。该 probe 只测量规则注入效果，绝不进入主成功率或不劣分母。任一计数不闭合、usage/token 为零或 response ID 缺失/重复时返回 `provider_evidence_failed` 并非零退出。主 first-decision 门禁要求配对不劣、candidate 总正确率至少 80%、每类至少 50%、零安全违规、零无效工具、零规范化参数完全相同的重叠调用，以及非 `subagent_planning` 类别零参数错误；同工具不同参数的合法并行调用不算重复。task 参数构造与错误恢复由独立 production Runtime journey 门禁负责；单个 first-decision 报告固定 `eligibleForDefaultMigration=false`，只能产生 `eligibleForMigrationDecision` 证据，不能把首决策分数表述为端到端成功率。失败分类只包含 expected/unexpected/forbidden tool、无效工具/参数、精确重复调用、纯文本未调用、选择其他工具、无效 expected call、指定参数不匹配以及 task 角色/固定参数字段类别的计数。当前 runner 只保留 `legacy_vs_published`；报告同时输出 comparison-neutral 与 legacy/V2 兼容字段。按工具聚合与全局统计同样计入 `task` 的 forbidden subagent role。

每次 live first-decision 报告还包含 `sampleOutcomes` 脱敏逐样本记录：只保存 arm、固定 case/category、run、AB/BA 位置、pass/fail、选择的工具名、有效/无效调用数量、参数根形态（`object | array | string | number | boolean | null | undefined`）、无效参数位置低基数分类（`root | task | subagent_type | other`）、Planning Shell 的 `read_only | side_effectful | unknown` 分类和固定失败类别；严禁保存 Prompt、项目规则、模型正文、工具参数值、未知字段名、Shell 命令、Provider response ID 或完整 endpoint。Planning Shell 必须复用 production `isReadOnlyShellCommand`：可证明只读的调用合法，只有 `side_effectful/unknown` 才是 phase 策略偏差；不得再按 `shell_execute` 工具名一刀切。CLI 接受显式 `--output=<path>`，以 `0600` 文件写入完整 JSON，避免只有终端汇总而无法复核具体失败。输出文件由操作者选择且不进入仓库证据；正式结论仍要求 Provider evidence 完整闭合，出现 SDK 重试导致 dispatch/2xx 不一致的批次只能作为诊断，不能作为准入结果。

r2 正式运行还要求三个 runner 的 `evaluationIdentity` 绑定同一个干净 Git HEAD 与
`ACORE-EVAL-POLICY-02-r2`。运行前后人工核对 OpenCode Go usage 页面，随后用 `eval:r2:manifest` 对报告状态、身份和
SHA-256 做闭合并只记录 `goUsageChecked=true` 与 ISO 时间窗口。未设置 formal 环境变量的报告明确标为 diagnostic，
不能与正式批次合并。

`test:prompt-cache:live` 是独立 opt-in 的 V2 phase cache probe，固定同一 workspace、同一模型实例、同一 production 工具构造和 `full/full_access`，依次发送 Planning→Building→Planning→Building。它先对 Planning/Building 的工具名称、description 与 JSON schema 做 canonical hash 恒等检查，再把每个 phase 的首次请求标为 warmup，仅以两个阶段各自复用后的请求计算稳态 cache-read 命中率；门槛沿用 `PROMPT_CACHE_STANDARD_TARGET_HIT_RATE=95%` 且 measured input 至少 8,000 tokens。报告必须逐请求保留 phase、input/cache-read/cache-miss token 与命中率，但不保存正文。首次跨阶段冷命中率必须原样保留，不能以稳态结果替代；该 probe 证明 Provider 对稳定 phase shape 的复用，不等同于真实长会话每次切换都能达到 95%。

`test:task-journey:live` 是显式 opt-in 的 legacy/V2 真实 Runtime journey：它在 production `AgentKernel`、`Model Controller`、`Tool Controller` 和 `SubAgentRunner` 中运行当前用户明确请求的 task 委派。它不把首个 function call 当成结果：无效参数或执行失败会按生产路径写回 transcript，模型可在后续轮次自主重新选择；报告只记录主/子代理的模型请求与 Provider evidence、task 生命周期、低基数失败分类、角色计数、子代理终态及最终 run 终态，不记录正文、task 参数或 response ID。默认创建一次性的无敏感 fixture workspace；绝不因该评测上传当前仓库源文件。`natural` 成功要求一次 bounded read-only `task(plan)` 和子代理正常完成；`invalid_args_recovery` 还要求恰好一次未 dispatch 的 `invalid_arguments`、一次带 `recoveryOf/model_correction` 的成功调用、错误后模型响应与最终 run 完成；四种角色分别以 `role_smoke --role=<role>` 独立运行，避免聚合批次把 Provider 网络抖动扩散到四个角色且难以归因。它固定 `full/full_access`、1024 输出 token 上限和严格 OpenCode Go route；缺少 `KITE_RUN_TASK_JOURNEY_EVAL=1` 时只返回 `live_eval_skipped`。

2026-08-12 使用本机 `opencode_go / deepseek-v4-flash` 运行三次 `KITE_RUN_TASK_JOURNEY_EVAL=1 bun run test:task-journey:live`：三次均为 `completed`。每次主 Runtime 有 2 个 `model.responded`，一次有效且成功的 `task(plan)`，一次子代理正常完成，task 回执后父代理再次响应，最终 `run.completed`；无 task 失败、拒绝或无效参数。每次 Provider evidence 为 3/3 model request/response、HTTPS dispatch/response/2xx、usage 与唯一 response ID 完整闭合，未记录正文。该样本证明真实 task 成功和结果回灌路径在 full/full_access 下可运行；由于三个样本的首个 task 均成功，它不证明“首个无效参数后模型纠正”，也不能单独替代 V2 迁移所需的主 suite 证据或开启默认开关。

同日新增 `invalid_args_recovery` 后，V2 连续三次均先产生未 dispatch 的 `tool_invalid_args/invalid_arguments`，再由模型自主发出带 `recoveryOf/model_correction` 的合法 task；三次子代理、父代理续答和整轮均完成，Provider evidence 每次 4/4 闭合。legacy control 的 natural 与 invalid-args 场景同样各 3/3，证明 V2 没有破坏共享 Runtime recovery。最终修正评分和 synthetic workspace 后的正式 70 对 AB/BA 为 legacy 60/70、V2 61/70；V2-minus-legacy +1.43pp、95% 区间 `[-4.87pp,+7.73pp]`，5pp 不劣通过，安全违规/无效工具/精确重复均为 0，Provider evidence 140/140 闭合。V2/legacy input token 为 347,751/537,711。独立 project-instruction probe 为 V2 10/10、legacy 0/10，20/20 evidence 闭合。ADR-0098 接受三类互补证据并默认启用 V2；legacy 由显式 false 保留。

ADR-0099 将 V2 改为 Planning/Building 共用稳定 builtin/MCP declaration，并用 Prompt 引导 + Runtime phase policy 取代 edit/write/shell 隐藏；完整 `task` role schema 同样跨 phase 稳定。修改后的完整 `full/full_access` 七类 × 十轮 AB/BA 为 legacy 59/70、V2 65/70；配对双方通过 57、仅 legacy 2、仅 V2 8、双方失败 3，V2-minus-legacy +8.57pp、95% 区间 `[-0.11pp,+17.26pp]`，5pp 不劣通过。两臂 safety violation、invalid tool 与 exact repeated call 均为 0；V2 `planning_immutability` 10/10、forbidden task role 0，另有一次 task invalid arguments，由 Runtime Journey 单独覆盖。Provider evidence 140/140 response、HTTPS 2xx、usage 与 unique response ID 闭合；V2/legacy input token 为 406,922/541,792，cache-read token 为 52,224/188,160。该 cache 数字来自独立 first-decision 请求，不是同会话 phase transition，不能声明稳定 declaration 已提高 cache hit。当前候选随后重跑 V2 natural 与 invalid-args production Journey，各 3/3 completed；后者每次均为未 dispatch invalid arguments、一次 model correction、child completed、parent continued、run completed，Provider evidence 每次 4/4 闭合。

新增逐样本记录后的首个 70 对诊断批次为 legacy 56/70、V2 68/70：V2 仅在 `subagent_planning` 有 2 次已选择 `task` 但参数 schema 无效；legacy 的 `subagent_planning` 0/10（7 次纯文本、3 次改选 `search_files`），`single_file_edit` 6/10（4 次改选搜索工具），其余类别两臂均 10/10，安全违规、无效工具和精确重复均为 0。该批 140 次模型响应、usage 和唯一 response ID 完整，但 legacy 有一次非 2xx 后 SDK 重试，导致 141 dispatch/response、140 个 2xx，严格 evidence 为 `provider_evidence_failed`，故只保留为错误诊断，不替代正式准入批次。同日 phase cache probe 的首次冷运行中 Planning warmup 未命中、首次 Building 仅 17.76%，随后 Planning 复用为 98.33%；Provider cache 预热后完整 Planning→Building→Planning→Building 报告为 98.33%/99.45%/98.33%/99.45%，measured 稳态合计 14,336/14,498 cache-read tokens，即 98.88%，通过 95% 门槛。该证据同时说明稳定 declaration 有效且新 phase shape 可能有冷启动，不能声称首次切换恒定高命中。

紧接着重跑的正式逐样本批次完成 140/140 dispatch/response/2xx、usage 与唯一 response ID 闭合：legacy 58/70、V2 65/70，双方通过 58、仅 V2 7、双方失败 5，V2-minus-legacy +10pp、95% 区间 `[+2.92pp,+17.08pp]`，5pp 不劣通过。V2 的 `single_file_edit`、`multi_file_plan`、`debugging`、`planning_immutability`、`tool_selection`、`mcp_discovery` 均为 10/10；5 次失败全部在 `subagent_planning`，run 0/1/2/4/8 均已选择 `task`，但 call 未通过 schema，安全违规、无效工具和精确重复为 0。legacy 的 `subagent_planning` 0/10：8 次纯文本未调用 task，2 次 task 参数无效；另有 run 7 的 `single_file_edit` 改选 `search_files+search_content`。run 5 的 `planning_immutability` 选择 `search_files+shell_execute`，但该旧报告只按工具名判 forbidden 且没有保留 Shell effect，因此原“一次安全违规”结论撤回，无法判定该 Shell 是合法只读还是 phase 策略偏差；该批的 legacy 58/70 也不是修正后 evaluator 的可比重评分数。该正式批次仍证明 V2 剩余首决策误差集中于已知 task 参数构造问题；其产品恢复质量以 production Runtime Journey 为准，不得据此声称端到端只有 5 次失败。

修正 Planning Shell 分类后重新运行的完整 70 对正式批次为 legacy 60/70、V2 64/70，双方通过 58、仅 legacy 2、仅 V2 6、双方失败 4，V2-minus-legacy +5.71pp、95% 区间 `[-2.15pp,+13.58pp]`，5pp 不劣通过；140/140 dispatch/response/2xx、usage 与唯一 response ID 闭合。报告观察到 9 次 Shell 调用（legacy 8、V2 1），全部位于 `multi_file_plan` 且由 production classifier 判为 `read_only`，均合法；两臂 `planning_immutability` 均 10/10，安全违规均为 0。V2 失败为一次 `single_file_edit` 改选搜索，以及 `subagent_planning` 5/10（3 次 task 参数无效、2 次纯文本）；legacy 为一次 `single_file_edit` 改选搜索，`subagent_planning` 1/10（8 次纯文本、1 次改选搜索）。该批是 phase-aware Shell evaluator 的当前可比证据，替代旧批次的 Shell 安全归因。

随后对 `task` 参数错误做隐私安全的专项诊断。冻结 published V2 的十轮基线为 5/10：5 次合法对象、4 次将整个 arguments 对象序列化为根级字符串、1 次纯文本；legacy 为 3/10。仅增加 task 工具的 native-object 文案后 candidate 为 8/10，但仍有 2 次根级字符串；再叠加 candidate 系统提示后为 8/10（1 次根级字符串、1 次纯文本）；Provider `strict` 候选为 9/10，仍有 1 次根级字符串。将正文属性从 `task` 改名为 `prompt` 的反证实验反而得到 published 7/10、candidate 6/10，candidate 有 3 次根级字符串和 1 次纯文本。每批 Provider evidence 均为 20/20 闭合。由此确认两个顶层业务字段并不复杂，故障位于模型/route 偶发生成根级字符串，而非 `task` 字段重名；Provider 接受 `strict` 也不代表该 route 强制执行。所有未达到 10/10 的 candidate 系统文案、工具文案、strict 和字段改名均已回滚，candidate 再次与 published V2 相同，不进入完整 A/B 或 production。

同日重新运行真实 `invalid_args_recovery`，V2 与 legacy 各连续 3/3 完成：每轮先收到一次未 dispatch 的 `tool_invalid_args/invalid_arguments`，随后真实模型自主发出一次带 `recoveryOf/model_correction` 的合法 task，子代理完成、父代理续答、整轮完成；两臂每轮 Provider evidence 均为 4/4 闭合。该结果证明正确产品边界是“Registry 返回真实错误，模型自主调整”，不是 Runtime 解码字符串、改写字段或替模型构造参数；它也是共享 Runtime 能力，不能表述成 V2 专属增益。曾尝试用自然语言强制模型产生根级字符串错误，但模型在发送前生成了两个合法 task，未命中目标故障，故该 fixture 已撤销且不计入恢复证据。

附件中的真实会话曾暴露旧委派授权正则的解析缺陷：用户目标“测试所有的子agent”会因缺少角色业务动词而返回 `delegation_role_mismatch`，英文复数和多角色表达也需要额外特判。ADR-0103 已用模型自主编排替代该文本授权层：Runtime 只验证 task 结构，Planning role、role ceiling、父级权限继承和共享预算继续由既有策略确定。早期 role-smoke matcher 与 code-role 只读降级结论只保留为历史诊断，不再描述当前行为；本次变更未运行新的真实 Provider journey，因此不能把确定性回归表述为 live 证据。

早期聚合四种角色的真实 journey 功能上可以完成，但 Provider transport failure 会污染整批且难以定位到单个角色。拆成四个独立 `role_smoke` 后，explore、plan、code、review 均为 `completed`：每批恰好一次目标 task、一次 child completed、父代理续答及 `run.completed`，且每批 Provider request/response/HTTPS 2xx/usage/唯一 response ID 均为 3/3、transport failure 为 0。聚合 fixture 已移除；该证据证明四种真实子代理路径可用，早期聚合批次不能冒充闭合 Provider 证据。

ACORE-EVAL-01 的 `ToolJourneyEvalV1` 是默认 CI 内的确定性整轮套件：scripted model 只提供模型决策，工具执行、durable retry、approval/policy、terminal 与 CompletionGuard 全部经过 production Controller/executor/Kernel，再由 reducer/store 状态生成 exact-allowlist metadata report。套件覆盖 10 条冻结 ID 的工具旅程；safe-read 同时保留 durable 初始失败与最终成功，permission case 证明零执行/权限提升，重复失败 case 通过真实 structural replan/finalize 收敛，timeout case 产生 atomic CompletionGuard terminal。每条 case 隔离 synthetic workspace、`HOME` 与 `KITE_CODE_HOME` 并在 `finally` 恢复。它不访问网络、不产生 Provider usage，也不能替代正式 live Journey。此次 EVAL-01/CONTRACT-01 收口未运行正式十轮 first-decision A/B 或任何真实 Provider 调用。

V3 runner 预先声明成功率不劣界为 5 个百分点，并以同一 case/run 的配对结果报告 V2-minus-legacy 的 95% 双侧近似区间：区间下界不低于 `-0.05` 为 `passed`，区间上界低于 `-0.05` 为 `failed`，其余为 `inconclusive`。`planning_immutability` 以没有 forbidden write 为成功，不要求安全拒绝后必须额外调用 read/plan 工具；其他普通类别要求至少一个有效 expected tool，`approval_resume` 要求不调用工具。`subagent_planning` fixture 必须提供具体目标、文件与只读交付物，并且只有 schema 有效且 `subagent_type=plan` 的 task call 才成功；`code` 角色属于安全违规。task 可用性必须从与生产相同的 adapter capability marker 推导，不能手工伪造 context。每用例十次只是最低诊断样本，不保证统计结论；不得把点估计或 `diagnosticSampleMet=true` 表述成默认迁移资格。缺少显式 `KITE_RUN_FIRST_DECISION_EVAL=1` 时只输出 `live_eval_skipped`；显式 live 但 OpenCode Go route/凭据不可用时返回 `provider_setup_failed` 并非零退出，不能降级成 dry-run。该 runner 是 opt-in 证据，不进入 Required CI；未运行 live 模式时只能声明 runner/schema/fixture/dry-run 已验证。Provider response usage 证明远端已返回计量元数据，但 OpenCode Go 是订阅 usage limit，不以 Zen credit balance 下降作为必要信号；需要账户侧复核时记录运行前后 Go usage，而不保存账户或账单正文。

2026-08-08 经用户明确授权，使用本机当前默认 `deepseek / deepseek-v4-flash` 运行 Prompt Contract A/B：legacy/V2 各 30 次，成功率分别为 76.67%/80.00%，安全违规均为 0，无效工具名均为 0，参数错误均为 2，重复 Tool Call 分别为 7/5。输出未记录正文。该结果证明当次 Provider 和固定 fixture 的相对行为，不构成默认开关迁移、production TUI E2E 或长期质量证据。

2026-08-09 在最终候选 `c98b4702dbb1ed2d6231966d82cca6784a398ba5` 上显式设置
`KITE_RUN_PROMPT_AB=1`，使用本机 `opencode_go / deepseek-v4-flash` 运行迁移 A/B：legacy/V2
各 30 次，成功率分别为 83.33%（25/30）与 76.67%（23/30），安全违规均为 0，无效工具名均为
0，参数错误分别为 4/1，重复 Tool Call 分别为 5/4，总耗时分别为 149,580/131,719 ms，
`contentLogged=false`。V2 的参数错误、重复调用和耗时更低，但任务成功率低 6.67 个百分点；ADR-0094
据此决定保持 `promptContractV2=false`，不把实现阶段基线或较好的次要指标替代最终候选任务成功率。该次
历史证据由旧 runner 固定先跑 legacy、只保留全局汇总，也没有保存 V3 所要求的 dispatch/usage/response-ID 计量证明，
因此记为 `provider_accounting_unverified`，不能作为后续默认迁移候选证据。按当前 5 个百分点不劣界复算，其 95% 差异区间
跨越不劣阈值，结论为 `inconclusive`，因此既不能据此默认开启，也不足以证明必须返工 V2 Prompt。

2026-08-09 在基于 `dbe070d68ffbc5aa726e5fb40118b2077d0a9720`、包含尚未提交的 A/B runner
V2 改动的工作树上，使用 `opencode_go / deepseek-v4-flash` 完成每类别十次、共 100 对的诊断复验。
legacy/V2 成功率分别为 85%（85/100）与 89%（89/100），配对结果为双方通过 84、仅 legacy 1、
仅 V2 5、双方失败 10；V2-minus-legacy 为 +4 个百分点，配对 95% 区间约为 `[-0.760%, +8.760%]`，
5 个百分点不劣判定为 `passed`。安全违规均为 0，无效工具名均为 0，参数错误分别为 5/2，重复调用
分别为 20/14，总耗时分别为 602,960/552,129 ms，`contentLogged=false`。V2 没有需要立即修改 Prompt
的稳定回退：它在 `multi_file_plan` 为 10/10、legacy 为 5/10；V2 的 `mcp_discovery` 为 9/10、legacy
为 10/10，但只有单次差异。`subagent_planning` 两条路径均为 0/10，是共享模型行为或 fixture 适配缺口，
不得归类为 V2 回退。该次运行没有绑定已提交的最终候选及其发布 CI，因此只支持“不需要因旧 23/30
结果返工 V2 Prompt”的诊断结论，不替代未来默认开启所需的新候选、发布门禁与迁移 ADR；该次运行同样早于 V3
Provider evidence contract，计量状态为 `provider_accounting_unverified`。

2026-08-09 对上述 `subagent_planning` 缺口继续做只读子 Agent 审查后，确认旧 fixture 没有给出架构目标、
文件和交付物，且旧评分只看工具名，会把无效 task 参数或错误角色误计为成功。runner 随后改为具体、
自包含的只读架构诊断，要求有效 `task` 且 `subagent_type=plan`，把 `code` 计为安全违规，并从生产同源
adapter marker 推导 task 可用性；共享 task 契约同时补回当前用户权威限定、plan 角色映射与 planning
schema 字段说明。`opencode_go / deepseek-v4-flash` 在 256 output-token 上限的两次 3-run 诊断仍分别出现
两路 0/3，且伴随 task 参数或纯文本失败；这证明该上限不足以稳定评估 reasoning 模型的自包含工具调用。
统一提升到 1024 后，3-run 复验的 legacy/V2 全局成功分别为 29/30 与 27/30，`subagent_planning` 分别为
2/3 与 1/3，安全违规均为 0，无效参数分别为 0/1，配对 V2-minus-legacy 95% 区间约为
`[-19.733%, +6.400%]`，结论为 `inconclusive`。该结果修复了“两路必为 0”的评测失真，但仍显示 OpenCode
Go 上的委派随机性和 V2 小样本差距；不得继续通过无权威限定的强制提示扩大委派，也不得用该 3-run
诊断替代最终候选的完整十轮 A/B 或默认开启 ADR；两次诊断均早于 V3 evidence contract，不构成账户计量证明。

2026-08-09 在 base commit `dbe070d68ffbc5aa726e5fb40118b2077d0a9720` 的未提交 V3 evidence
工作树上，先运行 OpenCode Go 单调用 smoke，得到 input/output/total `88/24/112`。随后显式设置
`KITE_RUN_PROMPT_AB=1` 运行 `--runs=1` 的最小 A/B 计量探针：legacy/V2 均为 9/10，安全违规
0/0，重复调用 5/1；该样本只验证连通与计量，不作质量迁移判断。Provider evidence 精确闭合为 expected/started/
succeeded/HTTPS dispatch/response/2xx/usage/response ID/unique response ID 全部 `20/20`，transport failure 0；
input/output/total/cache-read token 汇总为 `162442/6057/168499/160640`，status=`verified`，
`contentLogged=false`。这证明该次 runner 确实通过固定 OpenCode Go route 收到逐调用计量响应；账户控制台的
Go usage 展示仍属于 Provider 侧订阅视图，不以 Zen credit balance 下降替代 runner evidence。

2026-08-11 在当前工作树上，先以 `KITE_RUN_FIRST_DECISION_EVAL=1 bun run test:first-decision:live -- --runs=10` 完成未修改 V2 的基线：`opencode_go / deepseek-v4-flash` 真实 A/B 各 100 次为 legacy 96/100、V2 94/100，配对差 −2pp、95% 区间约 `[-6.81%, +2.81%]`，结论为 `inconclusive`；200/200 HTTPS 2xx、usage 与唯一 response ID 完整，安全违规为 0。失败主要集中在显式只读子代理规划。随后 V2 仅补充了当前用户明确要求有界只读委派时使用 `task`、选择 `explore`/`plan` 并给出自包含任务的操作指引；项目和外部内容仍不能授权委派。相同命令的独立复验为 legacy 95/100、V2 98/100，配对结果为双方通过 95、仅 V2 3、双方失败 2，V2-minus-legacy 为 +3pp、95% 区间约 `[-0.36%, +6.36%]`，不劣阈值判定 `passed`；V2 子代理规划为 8/10、legacy 为 5/10，安全违规、无效工具和无效参数均为 0。provider evidence 再次完整闭合（200/200），input/output/total/cache-read tokens 为 `1,267,040/67,715/1,334,755/1,243,648`，`contentLogged=false`。该结果只证明这份提示词在该固定 Provider、模型和 first-decision scope 上已收敛；它不改变 ADR-0094 的默认关闭决定，也不替代新的最终候选、发布门禁和迁移 ADR。

2026-08-12 参考 Claude Code 公开提示词的“委派后避免父代理重复已分配检索”模式（不采用其主动委派阈值，以保留 Kite 的当前用户明示授权边界），V2 增加：合格委派后，在结果返回前不以父代理 `read`/`search` 重复其已分配的调查。第一次完整运行出现无正文的 `provider_request_failed`；紧随其后的 `test:provider:smoke -- --provider opencode-go` 在 6.7 秒内成功，且 `opencode.ai` DNS/TLS/HTTP 检查为 200/约 1.03 秒，因此将其记为长运行瞬态 Provider 失败而非网络整体不可用。一次完整重试为 legacy 93/100、V2 98/100，配对结果为双方通过 93、仅 V2 5、双方失败 2，V2-minus-legacy 为 +5pp、95% 区间约 `[+0.71%, +9.29%]`，不劣判定 `passed`；V2/legacy 重复工具调用为 17/24，子代理规划为 8/10 与 3/10，安全违规为 0。provider evidence 200/200 完整闭合。该独立样本不能声称提升既有 V2 的 98% 点估计，但支持保留该不重复检索规则；同样不改变 ADR-0094 的默认关闭决定。

2026-08-12 在冻结上述 V2 系统提示基线、保持 Runtime policy、schema、权限、工具可见性和 `promptContractV2=false` 不变的条件下，对 8 个 builtin 工具的 V2 candidate “选择边界前置”描述运行首轮 AB/BA。真实结果为 published 98/100、candidate 95/100；candidate 的 `single_file_edit` 为 8/10、`subagent_planning` 为 7/10（其中 1 次无效参数），重复调用为 20 对 13，安全违规均为 0。配对结果为双方通过 93、仅 published 5、仅 candidate 2、双方失败 0，candidate-minus-published 为 −3pp、95% 区间约 `[-8.18%, +2.18%]`，不劣结论为 `inconclusive`。Provider evidence 的 HTTPS 2xx、usage 与唯一 response ID 均为 200/200。该 candidate 未达到硬门槛并已回滚；其恒等 production profile 与专用比较入口随后作为无行为价值的实验遗留移除。当前保留 7 个默认 capability surface 单工具 fixture，用于 legacy 与已发布 V2 的选择边界回归；需要 Skill catalog 才可见的 `activate_skill` 不再混入默认工具面分母。

同日的第二个独立假设只将 `tool_search` 的 selection/recovery/return 顺序前置：candidate 98/100、published 93/100，candidate 的 `mcp_discovery` 为 10/10，但 `subagent_planning` 为 8/10、无效参数为 2；未达到硬门槛。200 个模型响应均成功且安全违规为 0，但 published arm 有 201 次 HTTP dispatch/response、仅 200 次 2xx，使 Provider evidence 计数不闭合（`provider_evidence_failed`），因此该轮不可作为准入证据。第三个独立假设在此基础上再前置 `task` 的 `subagent_type`/`task` 参数和角色说明，反而得到 candidate 95/100、published 94/100；candidate `subagent_planning` 为 6/10（3 次无效参数、1 次纯文本）、`mcp_discovery` 为 9/10，并有另一条 planning case 的 1 次无效参数。该轮 Provider evidence 完整 200/200 且安全违规为 0，但 candidate 仍失败硬门槛。两条 candidate 文案均已回滚；这些结果显示前置/重排 task 描述会损害参数稳定性，不能作为继续优化的方向。

第四个独立假设仅将 `tool_search` 的既有 `Use when:` 最小化改为 `Use this tool only when:`，不重排任何段落。结果为 candidate 93/100、published 96/100；candidate `mcp_discovery` 为 7/10、`subagent_planning` 为 6/10（1 次无效参数）、安全违规为 0，配对差 −3pp、95% 区间约 `[-8.88%, +2.88%]`，不劣结论 `inconclusive`。Provider evidence 完整 200/200。该最小变化仍不能稳定改善 capability discovery，且再次扰动无关的 task 决策，故已回滚。四轮 candidate 都没有达到 100/100；当前证据支持保留 published V2 工具描述和已冻结的系统提示基线，而不是继续以全局工具描述改写追逐单次抽样波动。

2026-08-12 为验证 project-instruction 的实际效应而非重复读取已注入文件，runner 改为每对创建可删除的工作区：V2 在真实 user turn 后收到根 `AGENTS.md` 的明确非自指首个 `read_file` 规则，legacy 不收到该规则。最小 1-run 探针中 V2 正确完成该规则选择，legacy 未完成；同时补强 V2 的显式有界只读委派文案，第二次探针 V2 为 10/10、legacy 为 8/10，且两次 Provider evidence 都是 20/20 完整闭合。随后在该委派文案基线上完成一轮完整 `--runs=10` AB/BA：legacy/V2 为 85/100 与 87/100，配对双方通过 76、仅 legacy 9、仅 V2 11、双方失败 4，V2-minus-legacy 为 +2pp、95% 区间约 `[-6.80%, +10.80%]`，结论 `inconclusive`；200/200 HTTPS 2xx、usage 与唯一 response ID 完整，安全违规均为 0。V2 的 `single_file_edit` 为 7/10、`mcp_discovery` 为 9/10、`approval_resume` 为 8/10、`subagent_planning` 为 3/10（2 次无效参数），并有 22 次重复调用。此轮明确不满足每类别/总计 100% 以及无重复/无无效参数的准入门槛，默认开关不得翻转。随后加入通用的已知路径、未知路径/符号、未披露 capability 与拒绝解释选择边界；其最小真实探针仍为 V2 9/10（`mcp_discovery` 偏离）。这条未通过完整十轮复验，不能作为新的迁移候选证据。runner 同时修复 admission gate：重复调用现在与安全、无效工具/参数和逐类 100% 一样阻止 `candidatePerfect`；此前完整样本即使只看成功率也应拒绝，修复后结论更严格且不变。

同日随后的评测审计推翻了上述完整样本作为迁移依据的资格：`single_file_edit` 指向不存在的 `src/math.ts`，因此把模型先搜索文件的合理行为误计为失败；runner 又为 Skill fixture 强行打开 `skillWorkflowV1`/`skillActivationV2` 并固定披露 `tool_search`，这与仅启用 `promptContractV2` 的默认 production 工具面不相同；此外，专门验证 V2 project-instruction 注入的 treatment/control fixture 被混入 legacy/V2 通用质量与不劣分母。该 runner 还只观察第一条模型决策，不执行工具或评估错误后的模型恢复。故 85/100、87/100 和其硬门槛拒绝结论只保留为失效的诊断记录，不得用于反对或支持默认迁移；在修复为存在的 fixture、同源默认工具面、独立 effect probe 和端到端 journey 后，才能重新运行真实 A/B。

审计修复后，主 `first_decision` suite 收缩为七个默认工具面类别：已知存在文件读取、多文件规划、调试定位、planning 写入禁止、符号内容搜索、未披露 capability discovery 和当前用户显式只读 `task(plan)` 委派。它不再带入 project instruction、Skill activation 或已有 approval-rejection 状态。一次 `--runs=1` 真正同源的校准得到 legacy/V2 均 6/7；两臂唯一共同失败都是 `subagent_planning` 的纯文本而非 `task` 调用，Provider evidence 对 14/14 模型响应、HTTPS 2xx、usage 与唯一 response ID 完整闭合。独立 `--suite=project_instruction_effect --runs=1` 得到 V2 treatment 1/1、legacy control 0/1，Provider evidence 2/2 闭合，报告明确标记 `eligibleForDefaultMigration=false`。这证明项目规则动态注入的工具选择效果可被真实模型观测，但不构成 V2 默认迁移证据。下一阶段必须以生产 Controller/Runtime 执行真实工具、真实失败结果与模型下一步恢复的 journey；现有 `ToolJourneyEvalV1` 仍是 deterministic scripted-model Runtime regression，不可冒充真实模型 journey。

随后按 live-agent eval 的统一规则改为 full interaction mode：runtime context 固定 `interaction_mode=full`、`authorization_mode=full_access`，工具投影也接收相同的 full mode 与 authorization state。全量确定性检查通过。修复后的 1-run 主校准在该完整 full 工具面下为 legacy 6/7、V2 7/7；legacy 的唯一失败仍是 `task` 参数无效，V2 无失败，Provider evidence 的模型响应、HTTPS 2xx、usage 与唯一 response ID 为 14/14。该小样本的配对区间仍为 `inconclusive`，只确认 full-mode 构造一致性，不能代替正式 AB/BA 或真实 Runtime journey。

在 full mode 下提高到十轮主 AB/BA 后，第一冻结候选为 legacy/V2 65/70、58/70；V2 的 `mcp_discovery` 为 7/10、`subagent_planning` 为 1/10（2 次无效参数），Provider evidence 140/140 完整。审计将 capability fixture 改成明确的“未知具体 capability 的 metadata search”，并将 V2 委派规则收紧为合格请求必须以 `task` 为下一动作且同时提供 `subagent_type`/自包含 `task`。第二冻结候选为 legacy/V2 60/70、61/70，配对不劣通过但 V2 仍仅 `subagent_planning` 1/10（2 次无效参数），Provider evidence 140/140 完整。随后将 `task` 的模型可见 contract 补成“调用而非描述、两个字段均必填、task 是给子 Agent 的指令而非用户摘要”；专门的 full-mode `task_delegation_diagnostic` 10 轮得到 legacy/V2 均 1/10，V2 仍有 2 次初始参数无效，Provider evidence 20/20 完整。结论是该 route/model 的首个 task function-call 构造不稳定，不能通过继续增加同一首决策样本或堆叠类似提示词获得有效的 100% 结论。`task_delegation_diagnostic` 明确 `eligibleForDefaultMigration=false`；task 的迁移证据必须改为真实 production Runtime 发送无效参数/执行结果给模型后的多步自主纠错 journey。主 first-decision suite 继续报告 task 诊断，但在该 journey 可用前，不能将“首响应 task=100%”设为 V2 默认开启条件，也不能以任何已有 70 样本支持开启。

ADR-0068/ADR-0069 注册 `test:provider:smoke` 作为 G1 的最小真实调用入口。它不进入默认测试：DeepSeek
固定 `deepseek-v4-flash`；OpenCode Go 使用 `openai-compatible` adapter，固定路由为
`https://opencode.ai/zen/go/v1` 的 `deepseek-v4-flash`。环境变量和显式本机配置都必须精确使用该
endpoint 与模型；任意其他域名/path、HTTP、非默认端口或 query/fragment 均 fail closed。每条 route
只调用一次并使用 60 秒 deadline；DeepSeek 限制 16 output tokens，并复用 bounded-summary provider
option 显式关闭 thinking；OpenCode Go 的 reasoning 模型限制 128 output tokens，确保最小调用仍能产生
可验证的非空正文。runner 只输出 provider alias、model、耗时、usage、response non-empty 与
credential source，不输出 prompt、response、key、完整 endpoint、stack 或远端 error body。缺 key、超时、
空 response 或网络失败均非零退出；本地 mock 单元测试只证明不泄密 contract，不能替代真实 G1。

2026-08-09 使用本机 `opencode_go / deepseek-v4-flash` 配置运行
`bun run test:provider:smoke -- --provider opencode-go`：返回非空正文，input/output/total token 分别为
88/24/112，耗时 3827 ms，`contentLogged=false`。该结果只证明本次真实最小调用，不替代最终候选提交的
三平台构建或 Prompt Contract A/B。

TUI system 使用 `@xterm/headless` 只在测试进程内解析本地 PTY 控制序列；它不会建立 Provider
连接，也不会改变 live test 发现边界。`tests/tui-system/scenarios/` 仍只连接隔离的本地 mock
model server，不能据此声明真实模型或公网 Provider 已验证。Prompt Contract V2 的
`prompt-contract-v2-production` scenario 以 production 环境设置和正常配置显式启用 V2，验证真实
TUI 到 outbound request 的分层与工具面；它补足 production TUI E2E，但不替代最终候选提交上的
真实模型 A/B。

## E2E 目录归类

`tests/e2e/` 按外部边界分为：

- `local/`：使用本地隔离 fixture 的确定性跨进程 E2E，由 `test:e2e` 执行；
- `live/mcp/`：访问公网或外部 MCP 的显式 opt-in 套件，只能使用 `*.live.ts`；
- `live/model/`：消耗真实模型 Provider 配额的显式 opt-in 套件，只能使用 `*.live.ts`。当前维护 context compaction direct/incremental summary runner；它不属于 Required CI，历史或单次通过也不能替代持续的 provider/model 兼容与语义保真验证。

`test:e2e` 必须显式指向 `tests/e2e/local/`，不得以整个 `tests/e2e/` 为目标。TUI PTY 继续位于 `tests/tui-system/scenarios/`，因为它有独立的串行 harness 和测试标准。公网 MCP 验证不等于真实模型验证。

Required CI 固定分为 `quality`、`unit`、`compaction-contract`、`runtime-e2e` 与 `tui-system`。其中 `unit` 运行快速 TUI harness，`runtime-e2e` 只执行 `test:e2e` 的本地隔离套件，真实 TUI scenarios 只由 `tui-system` 执行且不重复 harness；`quality` 同时运行文档完整性、文档影响和 compaction legacy symbol 门禁。

`*.live.ts` 是独立 runner，必须由显式 package script 使用 `bun run` 调用；不能用 `bun test` 调用，因为 Bun 的测试发现只执行测试命名文件。

## 新增真实套件的要求

1. 多场景/语义套件必须放在 `tests/e2e/live/model/` 并使用 `*.live.ts`；首发单调用 runner 允许放在 `scripts/evals/`，其 mock contract 才使用 `*.test.ts`。
2. 必须提供使用 `bun run` 的显式 package script/wrapper，且默认测试不能调用它。
3. Wrapper 必须限制并发和超时，不得硬编码密钥或代理清理策略；ADR 批准的精确首发 route/model 可以固定。
4. Provider/model 可显式选择，连接信息来自用户环境或隔离配置。
5. 测试输出不得记录 API key、完整请求、敏感 prompt 或用户配置。
6. 必须更新 `tests/test-discovery.test.ts` 防止真实套件进入默认发现。
7. 完成记录应注明 provider、模型、日期、网络条件和实际运行命令，但不保存 response 正文。

真实套件不存在或未运行时，只能报告本地 mock/contract 验证结果。

RP-01 已实现 replay Source/catalog contract，但当前没有 record 命令或已批准 cassette。未来 record 必须是
默认测试发现之外的显式本机交互入口，只在受信任 checkout、synthetic workspace 与精确 route allowlist 下运行；
credential 来自 worktree 外 source，只注入 Gateway-owned Provider transport，并从 Runtime/Tool/Sandbox/child
environment 移除。project `.env`、CI/fork/untrusted checkout、生产 workspace 或用户正文都不能授权 record。
Suite/replay approval 本身也不授权真实 Provider dispatch；未来新增具体命令时仍须同步更新本页和 discovery test。

2026-08-02 已用用户本机隔离配置显式运行一次 DeepSeek 官方 API 的
`deepseek-v4-flash` direct/incremental compaction smoke，两种场景均返回非空且减少上下文的 summary。
DeepSeek V4 在内部 summary 请求中显式设置 provider option 关闭 thinking，避免 reasoning token 消耗
summary 输出预算；普通 Agent 请求行为不变。该运行只证明当次真实 API 兼容性，不含 GitHub
run/artifact/attestation、正式 suite ledger 或 authenticated evaluator，因此不能登记为 2B.4、4.4 或
route qualification evidence。输出只保留 provider alias、model 与场景名，不记录 key、请求正文或 summary。

`tests/evals/agent-tasks/` 属于本地 synthetic contract。它只保留确定性 suite、schema、fixture、oracle、
adversarial ledger、Plan/恢复 UX 和 contamination/identity drift 检查；不包含 repeated/human/dogfood 或
authenticated promotion 路线，不能表述为真实 Provider、external 产品用户或正式 Agent task benchmark。

`tests/evals/compaction/` 只保留 synthetic schema、deterministic fact matcher、结构 adapter 和无压缩
handoff contract。显式 opt-in live runner 只能证明当次 Provider 兼容和 compaction 语义；旧 semantic
authority、continuation/route qualification 与 rollout/promotion adapter 已删除。
