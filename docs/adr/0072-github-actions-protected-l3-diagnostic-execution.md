# ADR-0072：GitHub-hosted 受保护工作流的真实 Agent 诊断报告

状态：accepted
日期：2026-08-06
决策者：`github:@ferqx`（授权将 AQ-8–AQ-10 的真实评估执行面调整为 GitHub Actions）
补充：ADR-0070、ADR-0071、ADR-0068、ADR-0069
关联：[Agent 发布资格化实施方案](../space/plans/2026-08-05-agent-release-qualification.md)

## 背景

ADR-0071 为未来的 `ephemeral_local` L3 路径冻结了 root-owned Linux supervisor、实际 scratch
删除证明和 OS 级隔离。那是 owner-local secret execution 的高保证边界，不能用临时目录或普通 child
process 冒充。本次目标不同：在 GitHub-hosted Actions 中手动、低频地驱动一个真实 Agent 完成
source-owned synthetic task，以尽早发现模型、Agent Runtime 与受限工具链的兼容性问题。维护者明确
授权增加这条执行面，不要求先部署 self-hosted Linux service。

当前仓库是 public；现有 `main` protection、GitHub Environment 和 review/bypass 配置并非本仓库源码
可以证明的事实。公共 Actions log 和 artifact 也不具备 ADR-0070 `protected_ci_retained` profile 要求的
`protected_ci_maintainers` ACL。因此，不能把一次公开 GitHub Actions run 伪装成
`LiveCompatibilityObservationV1` 或 retained qualification evidence。

## 决策

### 1. 新执行面只产生公开安全的运行报告

新增 `GitHubActionsAgentEvaluationRunReportV1`，它是一次真实运行的 public-safe diagnostic report，而不是
qualification evidence：

- `authority` 固定为 `diagnostic`，`evidenceEligible` 固定为 `false`；
- 它不是 `AgentQualificationEvidenceV1`、`LiveCompatibilityObservationV1`、`ReleaseEvidenceV1` 或其输入；
- 现有 qualification evidence verifier、release parser、release bundle、release gate、G0/G1 evaluator 一律
  拒绝它；它没有发布、production-content 或支持等级 authority；
- report 必须用 strict exact-key schema 和 domain-separated canonical digest 绑定 source-owned case/suite/oracle,
  runner、policy、tool catalog 与 workflow identity；caller 不能注入 ref、SHA、route、case、
  fixture、command 或 digest。

该 report 只允许输出：case ID、`passed`/`failed`/`blocked`/`cancelled`、封闭 reason code、route/model alias、
有限 duration/token bucket、固定 digest 和 GitHub workflow identity。它不得输出或上传 credential、完整 endpoint、
prompt、response、reasoning、fixture/source/workspace/session body、absolute path、command、child output、raw
provider error 或 stack trace。没有 artifact、ledger、Issue/PR comment、release bundle 或跨 run retained report。
GitHub Actions stdout/log 是 public-safe transport，不是 evidence storage、ACL witness、retention witness
或删除证明。

### 2. GitHub Actions workflow 的可测试边界

独立 workflow 只能以 `workflow_dispatch` 启动，且没有 inputs。真实 job 必须同时满足：

1. 无密钥 preflight 只在 fixed canonical repository 的 `refs/heads/main` 运行，用于在缺保护前提时写出脱敏
   `blocked/github_context_invalid` report；live job 额外固定 `github.ref_protected == true`。PR、
   `pull_request_target`、push、tag、fork、arbitrary SHA/ref、用户 fixture/command/route 选择均无入口。
2. checkout 固定 `github.sha`、`persist-credentials: false`；Actions 使用 commit pin；权限仅 `contents: read`。
3. live job 使用专用 GitHub Environment。Environment secret 只以 step-level environment variable 注入真实
   model-dispatch step；checkout、install、preflight、report verification 与 summary step 都没有该 secret。
4. workflow-level `concurrency` 只用于避免两个 live job 并发调度，不是 ADR-0070 的 atomic quota reservation 或
   audit ledger。runner 对单 job 硬限制一次 suite attempt、固定 model-call、output-token、observed input-token 和
   wall-clock ceiling；usage 缺失、token overage、deadline 或无法确认 terminal state 时为 `blocked`。该 public-safe
   report 不主张 priced cost accounting，`costBucket` 固定 `not_observed`。

管理员在首次 live run 前必须在 GitHub 外部配置并复核：`main` protection、仅允许 `main` 的
`agent-live-eval` Environment、required reviewer、无 bypass，以及只在该 Environment 保存的诊断 secret。
这些是运行前提，不是 workflow 能自行证明的 protection snapshot。前提未配置或 `github.ref_protected` 为 false 时，
live job 不取 secret、不做 Provider 网络调用，并只报告脱敏 `blocked`。

### 3. 真实 Agent case 的低保证能力边界

首版 suite 必须实际运行 source-owned `runRuntimeAgent`，以 checked-in safe synthetic fixture、固定 task 和
postcondition oracle 检查真实模型的 tool-call / answer cycle；不得把单纯 ACK transport 冒充 Agent evaluation。

为保持这条低保证路线可控，首版只允许由 sealed in-process catalog 暴露的 `read_file`：fixture materialize 到临时
read-only workspace，Agent Runtime 只可读取该 workspace 内的已知 synthetic file。Shell、stdio child、MCP、Skill、
Subagent、write/network tool、任意可执行 fixture、普通 config loader、project/session/workspace overlay 和
artifact collector 一律禁用。临时 HOME/config/data/state/cwd、无内容 session logging 和清理是防误用及完整性
措施，不是 hostile-code OS isolation 证明。

Provider credential 由已审查的 protected `main` runner 在 model binding 中使用，随后从 process environment 删除；sealed
read-only surface 会使 generic Tool/Skill/Subagent controller 不接收 `taskModel`。GitHub job 内的 checked-out code
与 runner 仍是同一 OS principal。因此本 ADR 的信任边界是已审查的 protected-main code 与 GitHub Environment
secret issuance，**不**声称 ADR-0071 的 native isolation、secret broker、child non-observability 或 scratch
deletion proof。任何需要 hostile-code proof、child execution、MCP/Skill/Subagent、可写 fixture 或 retained
qualification observation 的 case 仍只能走 ADR-0070/0071 的高保证路径。

### 4. AQ-8–AQ-10 的调整与不变项

- AQ-8 在本 ADR scope 内完成的是“真实 Agent diagnostic report”：真实模型驱动受限 Runtime task、自动 oracle、
  public-safe report 和 fail-closed workflow。原 AQ-8 的正式 `LiveCompatibilityObservationV1` retained evidence
  不因该 report 而完成，继续保持 safe-disabled。
- AQ-9A 继续是无密钥、确定性的 injected failure contract，验证 summary/provider/network failure 后当前 turn
  停止、下一 user turn 才 retry，以及仅内存中的 8,192 token threshold。
- AQ-9B 已实现独立的 `GitHubActionsAutoCompactionDiagnosticReportV1` runner，只有 AQ-10 同一 job 一次取得的
  opaque one-shot fixed-case lease binding 才能触达 Provider；它不读取 credential、普通 config、workspace/project/session
  overlay 或 formal L3 resolver。lease 的 custom fetch 固定唯一 endpoint、`POST`、redirect deny、每 case output/attempt cap 与
  全 job `2 + 2 + 1` cap；其 ordinal acknowledgement 只能在 captured platform fetch 已返回 operation 后发生。runner 在临时
  HOME/config/data/state/cwd 与空的只读 synthetic root 内，以产品
  `AgentKernel → ModelController → compactor → scheduler` 构造 9–10K 安全 context，并仅在内存中以 8,192 token
  absolute threshold 触发 automatic compaction。它不读取、设置或推断产品 `contextWindowTokens`，也不改变默认 flag。
  success case 固定 summary + primary 两次调用；cancel case 只有一次 summary 调用，harness 必须在 bound model 的 captured
  Provider fetch acknowledgement 已确认后才 abort。只有收到 `summary_aborted`、current turn 停止、primary
  零 dispatch，且 next user turn 到达 scheduler retry preflight（第二个 automatic request 在 summary dispatch 前被
  runner 截止）时，cancel 才是 `passed_client_abort_after_transport_entry`。这不是远端 Provider 已确认取消。usage 缺失仍
  blocked；仅该已证明的 client-abort phase 以保守 reservation charge 投影为 `conservative_abort_charge`，绝不伪称 observed
  usage。report 另行绑定 fixture/corpus/oracle/evaluator/verifier/runner/policy/workflow/candidate identity，且同样不能生成
  formal L3 observation 或进入 release path。本地 contract binding 可覆盖产品状态机，但固定产生
  `blocked/transport_proof_unavailable`，不能表述为真实调用。
- AQ-10 已将 AQ-8、AQ-9B success 与 AQ-9B cancel 接入同一个 manual protected-main job/process；aggregate fresh-verify
  三份 public-safe child report 的 source suite、candidate commit、workflow/run/attempt/job identity、provider fetch provenance
  与精确 `2 + 2 + 1` calls，并施加 180 秒 suite deadline。缺失、drift、contract-only、超额或 timeout 都是
  `blocked/not_observed`；aggregate 不是 retained evidence，不能输入任何 release path。

ADR-0071 的本机 supervisor 历史结论保持不变：它继续是 future local high-assurance branch 的唯一 activation
前提。本 ADR 仅为 GitHub-hosted 的低保证真实评估增加并行路径，不改写 ADR-0068、ADR-0069、ADR-0070 或
ADR-0071 的历史结论，也不改变现有 DeepSeek 与 Qwen `qwen3.6-flash` G1 smoke。

## 后果

- Required PR CI 仍无 Provider secret；G0/G1 的 workflow、route 和语义不变。
- 未配置外部 GitHub protection/Environment/secret 时，仓库仍能通过 deterministic contract 测试，但不能把它
  表述为一次真实模型评估已经发生。
- 公开 report 牺牲 retained-evidence 的治理强度，以换取在 GitHub-hosted runner 上直接、低风险地发现真实
  Agent failure；它必须始终以 diagnostic result 报告，不能写作发布准入结论。
- 若未来需要跨 run/day/month quota、private ACL、retention/deletion witness、独立 credential broker 或 hostile-code
  isolation，必须另行 ADR，不能把本报告 schema 或 workflow 扩张为 formal evidence。

## 回滚

禁用 workflow、移除 Environment secret 或移除该 suite 即停止真实 dispatch。回滚不影响 Required、G0/G1、
release control、ADR-0068/0069、ADR-0070 或 ADR-0071。不得通过回滚恢复 PR secret、任意 ref、child credential
inheritance、content-bearing output，或把 public report 作为 release evidence。
