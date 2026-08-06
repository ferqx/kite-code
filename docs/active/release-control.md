# 开源候选版本控制

状态：active

读取时机：修改 release manifest、候选构建/校验/安装脚本、三平台 workflow、Release Profile、Gate、rollback 或发布状态展示时。

验证：`bun test tests/release`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0051、ADR-0052、ADR-0059、ADR-0065、ADR-0068、ADR-0069、`open-source-first-release.md`。

## 首发权威

首个开源版本以 ADR-0068/ADR-0069 的 G0/G1 为唯一必要 Gate。旧 Release Evidence、Gate replay、
Sigstore、attestation、provenance、platform signer、external rollout 和 maturity 控制面只可保留为
fail-closed 历史 contract；它们没有发布权威，不属于当前或后续路线图，也不得产生通过结论。

G0 验证本地正确性、安全边界、P0/P1、安装/回滚。G1 验证 GitHub-hosted macOS/Ubuntu/Windows
构建、安装、启动、TUI/CLI smoke、DeepSeek 与阿里千问 OpenAI-compatible route 的真实最小调用，以及
release notes/known limitations。缺任何真实结果时保持 blocked 或未验证。

ADR-0070 的 AQ-1 source-owned qualification Matrix 只生成独立的 diagnostic inventory/source digest；它不输入
候选 bundle、现有 Gate evaluator 或 G0/G1 判断。即使 inventory 的 structural suite 通过，也不表示候选获得
发布准入、production content admission 或对 G1 route 的额外结论。

AQ-2 的 `AgentQualificationEvidenceV1` 与 `LiveCompatibilityObservationV1` 仍是完全独立的 diagnostic
record。它们只共享 artifact/execution identity primitive 与 canonical digest，不继承、扩展或模拟旧 Release
Evidence；release evidence parser、bundle、replay 和 Gate evaluator 都没有接收 diagnostic record 的 adapter。
跨平台 diagnostic closure 也不是 candidate ID：每个平台必须给出自己的完整 artifact identity，不能把另一平台
payload/manifest 代表为当前平台。即使一个 diagnostic verifier 返回 `qualified`，它也只是将来 behavioral suite
下的 scope-local 诊断状态，绝不影响 G0/G1、既有 DeepSeek/Qwen `qwen3.6-flash` smoke 或任何发布许可。
`LiveCompatibilityObservationV1` 的专用 verifier 只会返回独立的 `observed`/`blocked` observation report；它要求
diagnostic candidate closure 与 local-synthetic execution、scope profile、runner 等 identity 的精确闭合，但没有
candidate aggregate 或 release admission 输出形状。

AQ-3 的 `qualification-l0-contract-v1` 现在可在完全独立的 diagnostic path 中，为一个精确 source-owned
Feature/scope 重建 deterministic L0 receipt 与 `qualified` report。该结论固定为
`authority='diagnostic'` / `evidenceEligible=false`，且通用 verifier 不接收 behavioral context；只有 source-owned
wrapper 在重建 Matrix、suite、evaluator/corpus/oracle/verifier/runner、receipt、candidate、execution 与 governance
identity 后才能导出它。L0 的四个 contract adapter 和十条 Sentinel journey map 不修改任何 release parser、candidate
workflow、G0/G1 evaluator、G1 DeepSeek/Qwen smoke 或 production content admission；缺任一 L0 record/receipt 只表示
对应 diagnostic scope `blocked`，不是发布阻塞或准入结论。

AQ-4 的 L1 Tool/Approval/Verification fixture 及 `SentinelJourneyMapV2` 同样只产生独立 diagnostic record。
V2 的 journey 1–2 即使在 candidate-bound behavioral、CLI 和 TUI receipt 均经专用 source-owned verifier 重建后
成为 `observed`，也不输入 candidate workflow、release parser/bundle、Gate evaluator、G0/G1 或 production content
admission；其余 journey 与 V1 snapshot 保持 `blocked`。L1 没有改变现有 DeepSeek/Qwen `qwen3.6-flash` G1 smoke，
也不把 scripted fixture 的结果写成当前发布准入结论。

AQ-5 的 `qualification-l1-skill-mcp-v1` 和其 specialized evidence verifier 仍是完全独立的
diagnostic path。六个 Skill/MCP source-owned receipt 只有在 fresh reconstruction 精确闭合 candidate、execution、
governance、Matrix、suite、corpus、evaluator、verifier、fixture/runner 与 source binding 后，才可影响
`SentinelJourneyMapV2` 的 journey 3–6 diagnostic state；`SentinelJourneyMapV1` 保持全 `blocked`。完整 J3–J6
没有现成的端到端 CLI/TUI projection 时，V2 记录结构化 `entrypoint_not_exposed`，不以局部 TUI provider-action
prompt 补足。任何 AQ-5 outcome 都不进入 candidate workflow、Release Evidence/parser/bundle、Gate evaluator、
G0/G1 或 production content admission，也不改变 DeepSeek/Qwen `qwen3.6-flash` G1 smoke。

AQ-6 的 `qualification-l1-subagent-recovery-v1` 也只是一条独立 diagnostic path。它以
`L1SubagentRecoveryReceiptV1` 验证 parent/child reservation、approval resume claim、local terminal
consumption、restart unknown、late terminal、parallel cancel 与 fork tightening；receipt 的
`authority='diagnostic'` / `evidenceEligible=false` 与 candidate/execution/governance closure 仍由专用
verifier 精确重建。这里的“single consumption”只表示 Runtime 的 durable claim 与 canonical ToolMessage
不变量，绝不表示外部 Provider/Tool 的 distributed exactly-once。已 dispatch 无 terminal 的 effect 只能
unknown/reconcile，不能以 AQ-6 的绿色记录自动 replay 或成功化。

AQ-6 已由 `SourceOwnedSentinelJourneyMapV2InputV3` 收敛为独立 diagnostic record：它保留 input v1/v2 的
fresh reconstruction，精确闭合 AQ-4/AQ-5/AQ-6 candidate-bound record 后才将 journey 7–10 标为 `observed`。
J7–J9 的 CLI/TUI 都没有公开端到端入口；它们仅通过 source-owned collector 的
`not_applicable` / `entrypoint_not_exposed` record 表达，不能手写 N/A 或伪造 projection receipt。

J10 不同：CLI 只有 collector 证明不存在入口时才是该 N/A，TUI `/rewind` 则是 `required` public surface，且已由
独立的 `qualification-l1-tui-rewind-fork-projection-v1` receipt 走真实 `/rewind` 解析 → `useSlashCommand` →
`dispatchTuiRewindRequest` → `useRunRewind` → `forkSession` 路径，验证 fork 的权限与 continuation 收紧。该
diagnostic receipt 不可替代为 AQ-4 通用 projection、局部 UI state 或 Runtime receipt。无论这些 AQ-6 state 如何，
它们都不输入 candidate workflow、Release Evidence/parser/bundle、Gate evaluator、G0/G1、现有 DeepSeek/Qwen
`qwen3.6-flash` G1 smoke 或 production content admission。

AQ-7 的 L2 native conformance 是独立 diagnostic path，不是 candidate workflow 或 release-control authority。它从
source-owned distribution target、D-04 declaration 与 standalone candidate contract 派生 exact
`target × capability` scope；其 contract/transport 固定 `authority='diagnostic'`、`evidenceEligible=false`。generic
qualification verifier 继续拒绝 GitHub execution，任何 narrow L2 receipt 验证必须 fresh reconstruct source binding、
Matrix、candidate/execution/probe、suite/evaluator/report 与治理 closure。当前 native-conformance workflow 因缺少
可审计的 protected-CI ledger、maintainer authorization 与 protection witness，在 candidate/probe/build/smoke 之前只写
metadata-only blocked transport。这不改变 release-candidate workflow、D-04 empty support set、DeepSeek/Qwen
`qwen3.6-flash` G1 smoke 或 ADR-0068/ADR-0069 的历史结论；L2 output 也没有 release parser、bundle、Gate evaluator
或 production content admission 的输入位置。

AQ-8 的 L3 live compatibility path 同样与 release-control 隔离，且**当前安全停用**：fixed source-byte binding 后，
checked-in `liveScratchSupervisorActivationIsImplementedV1()===false` 在读取 caller environment/ledger 或创建
resolver/reservation/credential lease/scratch/child 之前返回零网络 `blocked`。因此 opt-in、credential、ledger root
或 health JSON 都不能 dispatch；public entrypoint 只返回脱敏、有界的 blocked run report，不产生 observation、receipt、
retained/observed report 或 evidence。ADR-0071 已接受，但只有其可验证 persistent-supervisor service identity、受保护
control plane、Linux native isolation 与 normal-exit/crash deletion proof 都完成后，才可重新审查 future live branch；届时 explicit opt-in、
source-owned route/policy/identity、profile-wide reservation、sealed synthetic root、allowlist child environment 与 output
guard 仍必须全部成立。未来 `LiveCompatibilityObservationV1` 也固定 `authority='diagnostic'` /
`evidenceEligible=false`，没有 candidate workflow、`ReleaseEvidenceV1`、release parser/bundle、G0/G1 evaluator、
release Gate 或 production content admission 的输入位；G1/mock 不能替代它。

已接受 ADR-0072 的 AQ-8/AQ-9B child reports 与 AQ-10 `GitHubActionsAgentDiagnosticAggregateReportV1` 是另一条
public-safe、手动 GitHub Actions 诊断路径，不能被误认作上述 formal L3 observation。AQ-10 在同一次受保护 workflow 内以
one-shot lease 固定运行三 case，fresh-verify case/suite/oracle/runner/policy/tool catalog、candidate commit、workflow identity
和精确 `2 + 2 + 1` Provider fetch provenance；contract-only、drift、缺失或超额都 fail closed。它没有 release parser、bundle、
gate、G0/G1 evaluator 或 production-content admission 的输入位置；无 artifact/ledger 的 Actions stdout 不是 retained evidence。
正式 ADR-0071 activation 仍为 false，二者不能互相补足。

AQ-9A 的 `qualification-l1-auto-compaction-failure-v1` 也不增加 release-control authority。它是 zero-network、
source-owned local contract，三条 `L1AutoCompactionFailureReceiptV1` 均固定 `authority='diagnostic'` 与
`evidenceEligible=false`，并由专用 verifier fresh reconstruct source binding、Matrix、suite/corpus/oracle/evaluator/
verifier/runner、candidate/execution/scope、governance/retention 及 record/report digest。它只证明 injected
summary/provider/provider-network fault 在当前 turn 停止、阻止普通 dispatch，并在下一 user turn 重试；每种 fault
仍映射产品既有 `summary_model_failed`。这些 receipt 没有 `ReleaseEvidenceV1`、release parser/bundle、Gate evaluator、
G0/G1、G1 smoke 或 production content admission 的输入位置；自动压缩默认关闭状态保持不变。

AQ-9B 的 `qualification-l3-live-auto-compaction-v1` 同样没有 release-control authority，且 public
`:success` / `:cancel` wrapper 当前受同一 `activation=false` gate 安全停用：它们不会读取 caller environment/ledger，
也不会创建 resolver/reservation/lease/scratch/child 或 dispatch。当前只能得到脱敏、有界的 blocked run report；不产生
`LiveAutoCompactionSemanticReceiptV1`、outer `LiveCompatibilityObservationV1`、retained/observed report 或 evidence。
future-only 的两种 diagnostic record 仍固定 `authority='diagnostic'`、`evidenceEligible=false`，并由专用
registry/verifier 重建 candidate/execution、Matrix/suite/corpus/oracle/evaluator/verifier/runner、route/policy/capability、
governance/retention 与 record/report digest。它们不是 AQ-8 `test:model:live`、ADR-0068/0069 G1 smoke、release candidate
workflow 或任何 release input；只有 ADR-0071 protected-supervisor implementation、native isolation 与 deletion proof 完成后才可重新审查实际
success/cancel。届时也不能提升到 release evidence、bundle、Gate、G0/G1 或 production content admission，unknown dispatch、
tool-call/non-allowed effect、cap/identity drift 或 cleanup failure 都 full-charge 后 `blocked`。

## 候选制品

`bun run release:build` 使用 Bun standalone executable 编译当前平台的 `kite` 与 `kite-tui`，输出：

- gzip tar 候选包；
- exact-key JSON manifest，绑定产品版本、Git commit、Bun、target 和逐文件 SHA-256；
- archive SHA-256 sidecar；
- release notes、known limitations 与普通维护者检查清单。

build 不读取 Provider secret，不自动加载 `.env`/`bunfig`，也不把环境变量内联到 executable。
manifest/checksum 是完整性数据，不是代码签名、notarization、provenance 或身份认证。
归档 writer 规范化 tar entry 时间戳并重算 header checksum；同一 target、manifest 与 payload
重复构建必须字节一致，构建墙钟不得改变 archive SHA-256。
PR candidate job 固定 checkout `pull_request.head.sha`，并通过 `KITE_EXPECTED_CANDIDATE_COMMIT` 要求
manifest `commitSha` 精确匹配；GitHub 临时 merge ref 不能充当最终候选 identity。
构建器只接受与当前 host OS/architecture 完全一致的 native target，不 cross-compile，也不下载另一平台的
Bun runtime；三平台候选分别在对应 GitHub-hosted runner 上生成。Ink 的可选 React devtools 路径在
生产候选构建时固定为空实现，不成为依赖或网络下载入口。

源码通过 Bun 运行时继续使用 `@napi-rs/keyring` 的系统凭据库。由于 Bun standalone 不能在三平台上
稳定封装该 N-API binding，预构建候选把该 adapter 固定为方法级 `unavailable`：构造和普通启动不失败，
但任何 credential get/put/delete 都 fail closed。它不回退到文件、环境变量或明文存储；该限制必须在
release notes 中披露，解除前预构建候选不声称支持持久 MCP 凭据。

候选 executable 由 `scripts/release/entrypoints/` 的无 guard 薄入口显式调用 CLI `main()` 或 TUI
`runTui()`；不能依赖 compiled runtime 对 `import.meta.main` 的平台相关判定。源码入口仍保留自身 guard，
避免被测试或其他模块导入时自动启动。

`bun run release:verify` 在执行任何 binary 前解析 archive，拒绝未知/缺失/重复路径、绝对路径、父目录
跳转、link、schema 漂移、target 不匹配和任一 checksum 不一致。只有 verifier 通过后 smoke 才可以
启动 payload。GitHub-hosted candidate job 额外使用 `--require-clean-source`，dirty-source manifest
不得上传为候选 artifact。

## 安装、回滚和卸载

安装器只接受显式 archive 和 prefix。prefix 不能是 filesystem root、用户 home、仓库 root、symlink
或 reparse point。第一次安装创建自身 marker；后续替换、回滚或卸载要求 marker 的 canonical root
与实际目标完全一致。安装器不接管无 marker 的已有目录。

每个候选保存到 `releases/<candidateId>`，`bin/` 只保存当前激活 binary。新安装原子更新 current/previous
指针；rollback 只可切换到已验证、仍位于同一 managed root 的 previous candidate。uninstall 在删除前
精确枚举受管树并校验 marker、release checksum、launcher 与允许的目录结构；发现未知文件、目录或 link
立即停止，不删除任何内容，也不扩大删除范围。

`bun run release:smoke` 在新临时目录中完成 verify、install、CLI help/version、TUI version/start probe、
第二候选安装、rollback 和 uninstall。任一步非零都使 smoke 失败。
固定 `--help`/`--version` 启动失败时，报告只保留退出码与 stdout/stderr 各 240 个清洗后的字符；这些
入口不读取 Provider 凭据或模型正文，诊断不写入候选 artifact。

## GitHub-hosted workflow

`.github/workflows/release-candidate.yml` 在 pull request、`main` push 和手动触发时运行
`macos-15`、`ubuntu-24.04`、`windows-2025` 矩阵。每个 job 安装锁定 Bun 版本，执行定向 release
tests、native build/verify/smoke 和 TUI startup scenario，然后上传候选 artifact。

workflow 只有 `contents: read`；不得申请 `id-token: write`、`attestations: write`、`contents: write` 或
`packages: write`，不得调用 `gh release` 或 npm publish。上传 artifact 是 CI 交付，不是公开 Release。

## Release Profile 与能力

Release Profile 的字段组合继续 deny-wins，只能收紧 embedded ceiling。普通候选包可以运行 TUI/CLI，
但不会因此开放未获本机安全 admission 的 effectful execution。MCP write、effectful Skills、remote
telemetry 与其他高风险 capability 默认 off；Auto Compaction 首版默认 off。

disable-only rollout、旧 production supply-chain verifier 与 promotion Gate 没有删除；它们在未配置
authority 时继续 fail closed，但只属于历史安全 contract，不参与 G0/G1，也不绑定后续 Task。

## 维护者发布边界

唯一检查清单是 `release/oss-first-release/MAINTAINER_CHECKLIST.md`。单维护者可以完成同一候选的实现、
复核和批准，不需要另一个账号或独立签名。正式 GitHub Release、npm publish 和其他不可逆公开动作
必须获得用户单独授权。
