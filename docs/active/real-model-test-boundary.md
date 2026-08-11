# 当前规则：真实模型测试边界

状态：active
最后更新：2026-08-09
最后验证：2026-08-09

读取时机：新增真实网络/模型测试、修改测试发现规则、package scripts 或声明 provider 端到端验证结果时。

验证：`bun test tests/test-discovery.test.ts tests/evals/live-provider-smoke.test.ts`、`bun run typecheck`。

相关：ADR-0068、ADR-0069、ADR-0093、`model-provider-boundary.md`、`open-source-first-release.md`。

## 当前状态

仓库注册了显式 opt-in 的 `test:model:live` package script，用于真实 Provider 的 context compaction direct/incremental summary 验证。`qualify:context:produce` 与 `qualify:context:verify` 只生成和独立验证渐进式三级压缩的确定性本地资格工件；它们验证 canonical blocks、事实保留、continuation、延迟和内存门槛，但没有 Provider dispatch，不能表述为真实模型或 route qualification。默认 `bun run test` 通过 `scripts/run-default-tests.ts` 只运行确定性的本地/mock 测试：主 suite 使用 `--max-concurrency=1 --only-failures` 限制 Bun 共享进程中的测试和输出资源竞争；Windows 因真实 ACL、进程身份和平台探测存在固定启动成本，默认 test process 使用 30 秒单用例上限，其他平台保留 Bun 的 5 秒默认值。该 suite 包含快速 `tests/tui-system/harness/` 单元测试，但排除真实 PTY `scenarios/`、TUI/native sandbox smoke 与 spike；`tests/shell-exec.test.ts` 在默认门禁显式关闭 native sandbox，只验证统一 executor 的 Shell/进程树语义。Seatbelt/bubblewrap 正向执行由 `test:sandbox:smoke:native` 与 platform capability workflow 单独运行。每个 test process 都获得独立临时 `HOME`/`KITE_CODE_HOME`（Windows 同步 `USERPROFILE`），不得读取或修改开发机真实 Kite 配置、Plan 或 Session Log。会临时修改进程级 cwd 或 `KITE_CODE_HOME` 的少量路径测试还会逐文件启动独立 Bun 进程，避免进程级状态互相污染。不得改用 Bun per-file isolate；当前 Ink/Yoga ESM 在该模式下不能稳定初始化。`test:mock` 明确运行当前 context compaction Runtime E2E，同样不访问真实 provider。未实际执行 live runner 时，文档、PR 或完成记录不得表述为真实 provider 已验证。

Prompt Contract V2 另注册 `test:prompt:live`。`scripts/evals/prompt-contract-ab.ts` 以十个类别在同一 resolved Provider/model/temperature/fixture/初始状态下比较 legacy/V2，默认每用例三次；缺少显式 `KITE_RUN_PROMPT_AB=1` 或可用凭据时只输出 `live_eval_skipped`，并以 dry-run contract 成功结束。runner 只保存/输出聚合成功率、工具参数错误、重复调用、安全违规与脱敏失败分类，不记录 system prompt、项目指令、用户正文、模型正文或工具参数。该 runner 是 opt-in 证据，不进入 Required CI；未运行 live 模式时只能声明 runner/schema/fixture/dry-run 已验证。

2026-08-08 经用户明确授权，使用本机当前默认 `deepseek / deepseek-v4-flash` 运行 Prompt Contract A/B：legacy/V2 各 30 次，成功率分别为 76.67%/80.00%，安全违规均为 0，无效工具名均为 0，参数错误均为 2，重复 Tool Call 分别为 7/5。输出未记录正文。该结果证明当次 Provider 和固定 fixture 的相对行为，不构成默认开关迁移、production TUI E2E 或长期质量证据。

2026-08-09 在最终候选 `c98b4702dbb1ed2d6231966d82cca6784a398ba5` 上显式设置
`KITE_RUN_PROMPT_AB=1`，使用本机 `opencode_go / deepseek-v4-flash` 运行迁移 A/B：legacy/V2
各 30 次，成功率分别为 83.33%（25/30）与 76.67%（23/30），安全违规均为 0，无效工具名均为
0，参数错误分别为 4/1，重复 Tool Call 分别为 5/4，总耗时分别为 149,580/131,719 ms，
`contentLogged=false`。V2 的参数错误、重复调用和耗时更低，但任务成功率低 6.67 个百分点；ADR-0094
据此决定保持 `promptContractV2=false`，不把实现阶段基线或较好的次要指标替代最终候选任务成功率。

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

2026-08-02 已用用户本机隔离配置显式运行一次 DeepSeek 官方 API 的
`deepseek-v4-flash` direct/incremental compaction smoke，两种场景均返回非空且减少上下文的 summary。
DeepSeek V4 在内部 summary 请求中显式设置 provider option 关闭 thinking，避免 reasoning token 消耗
summary 输出预算；普通 Agent 请求行为不变。该运行只证明当次真实 API 兼容性，不含 GitHub
run/artifact/attestation、正式 suite ledger 或 authenticated evaluator，因此不能登记为 2B.4、4.4 或
route qualification evidence。输出只保留 provider alias、model 与场景名，不记录 key、请求正文或 summary。

`tests/evals/agent-tasks/` 当前同样属于本地 synthetic contract。它覆盖确定性 suite、adversarial ledger、
false completion 与 identity/digest 篡改拒绝；旧重复运行、external participant 与 authenticated promotion
schema 只作为 blocked/failed 负向资产，不再对应产品路线或待完成 Task。nightly dry-run 零 network
dispatch，不能表述为真实 Provider、external 产品用户或正式 Agent task benchmark 已运行。

`tests/evals/compaction/` 也只验证 synthetic schema/matcher/blocked Gate；其中 formal semantic evidence
测试会重建 opaque blind item/receipt ledger、逐项 candidate commitment 和完整 Release/GitHub identity，
但 production OIDC/attestation verifier 为空，不能把 fixture 升级为正式证据。显式 opt-in live runner
只能证明当次 Provider 兼容和 compaction 语义；旧 Phase 4 rollout/promotion adapter 已被取代，不产生
milestone 或后续路线图状态。
