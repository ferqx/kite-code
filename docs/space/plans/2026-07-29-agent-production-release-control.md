# Agent 生产化 Phase 2A：Release Profile、制品证据与 Gate 计划

状态：active
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
Foundation 依赖：仅 Phase 0
RC Assembly 依赖：Phase 1A、1B、1C、Phase 2B 和 Phase 3
设计依据：RFC §8–§10、§15、§20

2026-08-02：D-06 已按 ADR-0062 关闭。Task 2A.0–2A.7 已由恢复点
`2e98681c800a2f1f745bc18e41ac682d9c09e84b` 收口；53 个 release 定向测试、synthetic
build/verify/bootstrap 与 deterministic foundation Gate replay 全部通过，Task 2A.7 唯一产生
`MS:2A-F`。真实 Sigstore/attestation/GitHub Release 保持 disabled，D-04 production support set
为空；Task 2A.8–2A.11 尚未完成。完成证据见
[Release Contract Foundation 完成记录](../execution/completed/2026-07-30-agent-production-release-control.md)。

同日 2A.8 的 manual-only/no-publish workflow、synthetic SBOM/provenance/platform smoke contract
已经本地实现，但 D-04 支持集为空且真实 audit、平台签名、actual artifact smoke、Sigstore 与 attestation
均未发生，所以保持 `in_progress`。2A.9 的 disable-only loader/cache 也仅完成公开 synthetic key
contract；D-03 仍 open，真实 rollout signing/service 保持 disabled。2A.10/2A.11 尚未完成。

## 目标

建立独立于 Runtime 的发布控制面，使每个可分发制品都能回答：

- 包含哪些 capability、成熟度和最大 rollout；
- 允许何种权限、预算、日志和数据 route；
- 对应哪一个 commit、实际行为 bundle 和构建配方；
- 哪些测试、真实 Provider、平台、任务和运营证据为它放行；
- 哪个 Gate 通过或阻断；
- 如何只关闭一个 capability 或回退 artifact。

## 非目标

- 不把 release maturity 写入 Runtime lifecycle；
- 不让模型或 Workspace 决定 release profile；
- 首个 limited 不依赖远程 rollout 服务；
- 不在本计划实现 Agent task/compaction evaluator；
- 不为缺失 evidence 选择“最近一次绿色结果”；
- 不用普通 waiver 绕过 G0/G1。

## 主要改动范围

- `src/core/config/`
- TUI/CLI composition root
- `scripts/release/`
- `tests/release/`
- `.github/workflows/`
- `package.json`
- artifact packaging/version/changelog/security docs
- active、book、ADR 和 documentation map

## 共享 schema ownership

本计划是 `ReleaseProfileV1`、`ReleaseManifestV1` 和 `ReleaseEvidenceV1` 的首个实现计划，Release
与 Security 分别按治理表审批。它只消费 1A 的 `ProviderDataPolicyV1` 和 1C 的
`RuntimeSchedulingPolicyV1` canonical snapshot/digest，不得复制 producer schema 或 Runtime
安全语义。

## 实施步骤

### 任务执行矩阵

`2A-F` 与 `2A-RC` 是两个独立完成点。章节顺序不表示可以跳过 `dependsOn`。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 2A.0 | `T:0:0.2`、`D-06:CLOSED`、`D-12:CLOSED` | `scripts/release/artifact-layout.ts`、`build-artifact.ts`、`verify-artifact.ts`、`bootstrap-verifier.ts`、`package.json`、`tests/release/artifact-layout.test.ts`、`bootstrap-verifier.test.ts` | `bun test tests/release/artifact-layout.test.ts tests/release/bootstrap-verifier.test.ts`；`bun run release:build`；`bun run release:verify` | 构建工具无 Runtime flag；pre-exec 验签失败不执行 payload |
| 2A.1 | `T:0:0.3`、2A.0 | `src/core/config/release-profile.ts`、`release-capabilities.ts`、embedded profiles、`tests/release/release-profile.test.ts` | `bun test tests/release/release-profile.test.ts` | `releaseProfileV1=false` 起步；production profile 要求开启，否则拒绝启动 |
| 2A.2 | 2A.1 | `src/core/config/release-profile-composer.ts`、property tests | `bun test tests/release/release-profile-composition.test.ts` | 与 2A.1 同 flag；回滚只能收紧为 embedded ceiling |
| 2A.3 | 2A.2 | `src/app/release/composition-root.ts`、`status-projection.ts`、`src/app/cli/index.ts`、`src/app/tui/session-manager.ts`、`tests/release/release-status.test.ts`、`tests/tui-system/scenarios/release-status.test.ts` | `bun test tests/release/release-status.test.ts`；`bun test tests/tui-system/scenarios/release-status.test.ts` | 开发入口可关闭状态 UI；production 不得绕过 profile loader |
| 2A.4 | 2A.0–2A.2 | `scripts/release/behavior-digest.ts`、`RuntimeSchedulingPolicyV1` consumer、system/tool/default-runner canonical inputs、cross-platform golden | `bun test tests/release/behavior-digest.test.ts` | 无 Runtime flag；digest 改变使旧 evidence 失效 |
| 2A.5 | 2A.0、2A.4 | `scripts/release/generate-manifest.ts`、`bootstrap-verifier.ts`、`src/app/release/manifest-loader.ts`、`tests/release/manifest.test.ts`、tamper fixtures | `bun test tests/release/manifest.test.ts tests/release/bootstrap-verifier.test.ts`；`bun run release:verify` | launcher 先验签/验 payload；Runtime loader 仅一致性复核 |
| 2A.6 | 2A.5 | `scripts/release/evidence-schema.ts`、`evidence-bundle.ts`、evidence tests | `bun test tests/release/evidence.test.ts` | 无 Runtime flag；缺失或陈旧 evidence 不自动回退 |
| 2A.7 | 2A.3、2A.6 | `scripts/release/gate-evaluator.ts`、gate policy/fixtures/tests、foundation Gate record；唯一产生 `MS:2A-F` | `bun test tests/release/gate-evaluator.test.ts`；clean-environment replay | Gate policy versioned；回滚 policy 必须重新评估全部 evidence |
| 2A.8 | 2A.0、2A.3、2A.5、2A.7、`D-04:CLOSED`、`D-06:CLOSED` | `.github/workflows/release-candidate.yml`、`scripts/release/platform-smoke.ts`、`scripts/run-default-tests.ts`、`generate-sbom.ts`、`verify-provenance.ts`、tamper smoke | `bun run test`、`bun run release:smoke`；各声明支持平台 workflow | workflow/tamper smoke 失败不发布；不得回退为源码 smoke |
| 2A.9 | 2A.7、`D-03:CLOSED`、`D-06:CLOSED`、`D-13:CLOSED` | `src/app/release/rollout-manifest-loader.ts`、`rollout-cache.ts`、`scripts/release/sign-rollout-manifest.ts`、`tests/release/disable-only-rollout.test.ts` | `bun test tests/release/disable-only-rollout.test.ts` | 可选且默认不开启；故障回到 embedded ceiling，不能扩大权限 |
| 2A.10 | 2A.1–2A.8 | active/book/README/map/ADR/changelog/support matrix | `bun run check:docs-impact`、`bun run check:docs` | 文档与实现不一致时阻断 2A-RC |
| 2A.11 | `MS:1A-DONE`、`MS:1B-DONE`、`MS:1C-DONE`、`MS:2B-DONE`、`MS:3-OPS-READY`、2A.8、2A.10 | `scripts/release/assemble-rc.ts`、`replay-gate.ts`、schema upgrade/rollback rehearsal、`tests/release/rc-assembly.test.ts`、`schema-rollback.test.ts`、RC workflow；唯一产生 `MS:2A-RC` | `bun test tests/release/rc-assembly.test.ts tests/release/schema-rollback.test.ts`；`bun run release:build`；`bun run release:verify`；Gate replay | Gate 失败不发布；回滚完整 payload/manifest/evidence identity |

### Task 2A.0：冻结 payload、detached manifest 与打包入口

release bundle 固定为：

```text
release bundle
├── immutable payload artifact
├── <payload>.manifest.json
└── <payload>.manifest.sig / provenance（按 profile 要求）
```

要求：

- `payloadSha256` 只 hash payload bytes，不包含 manifest/signature；
- manifest 使用 canonical JSON，签名对象是 canonical manifest bytes；
- 外层目录、压缩包或 registry object 可以有独立 storage identity，但不能写回 manifest；
- build、verify、smoke 使用同一 artifact layout library；
- 外层 installer/package 使用平台代码签名；其中的最小 launcher 在执行 payload 前验证
  canonical manifest signature 和 payload hash，构成 pre-exec trust root；
- payload 内 `src/app/release/manifest-loader.ts` 只重新检查 schema/profile/digest 一致性，
  不承担供应链真实性；
- 平台没有可验证 installer/launcher identity 时标记 unsupported，不允许“启动后自检”替代；
- 本任务新增 `release:build`、`release:verify` 和 `release:smoke` package scripts；
- 尚未确定跨平台可重复 payload 格式时，2A.4/2A.5 不得开始。

建议落点：

- `scripts/release/artifact-layout.ts`
- `scripts/release/build-artifact.ts`
- `scripts/release/verify-artifact.ts`
- `scripts/release/bootstrap-verifier.ts`
- `tests/release/artifact-layout.test.ts`
- `tests/release/bootstrap-verifier.test.ts`
- `package.json`

### Task 2A.1：实现 Release Profile schema

实现：

- `ReleaseCapability` 稳定枚举；
- `CapabilityMaturity` 与 `RolloutStage` 正交；
- `ReleaseProfileV1`；
- RFC `resources` 字段及其有限非负整数、embedded ceiling 和只能收紧的组合校验；1C 消费
  累计/tool/shell invocation/wait limits，1B 消费 process-tree limit；
- limited/internal/canary/ga embedded profiles；
- capability maturity/rollout 合法组合校验；
- 安全敏感未知字段 fail closed。

建议落点：

- 新增 `src/core/config/release-profile.ts`
- 新增 `src/core/config/release-capabilities.ts`
- embedded profile 由构建生成或静态模块导入
- `tests/release/release-profile.test.ts`

首个 limited：

- 允许 builtin read/write/shell、Plan、Tool Search、白名单 MCP read；
- `accept_edits`/`auto` 仅在 Phase 1B 边界满足时；
- 关闭 MCP write、Skills、manual/auto compaction、`full`；
- Verification 未开启时不显示“已验证完成”。

### Task 2A.2：实现字段单调组合

组合层：

```text
Embedded Profile
  + optional disable-only rollout
  + admin requirements
  + user preference
  + trusted project config
  + one-run CLI restriction
  -> Effective Runtime Configuration
```

实现规则：

- capability/content：deny-wins；
- allowlist：交集；
- denylist/protected path：并集；
- 权限/预算/retention/data classification：取更严格；
- approval/verification：风险偏序取更严格；
- rollout：只能缩小；
- 普通偏好：在 ceiling 内按既有 precedence。

测试：

- property tests 验证增加限制层不会扩大权限；
- 顺序变化不改变安全结果；
- 空 allowlist 保持空；
- project/CLI 尝试抬高时在 Runtime/MCP/Skill 创建前失败；
- 新安全字段遇到旧 evaluator fail closed。

### Task 2A.3：Composition Root 与状态入口

TUI/CLI：

- 加载 embedded profile；
- 求值 effective config；
- 注入 Runtime，而不是让 Core 读取 App 类型；
- 提供本地状态命令/面板：
  version/channel/profile/capability maturity/rollout/关闭原因/
  sandbox/filesystem/network/worktree/logging/telemetry/data route/Verification；
- 不把完整 profile、cohort key、credential 或 Workspace path 给模型。

Headless CLI：

- 输出稳定 machine-readable status；
- 生产 artifact 中越过 ceiling 的 `--feature` 非零退出；
- 未信任 Workspace 时在 profile 求值前保持既有 fail closed。

### Task 2A.4：生成 behavior digests

规范化并 hash 实际打包/解析后的：

- agent/system contract；
- system prompt 与 `ask_user` canonical questions schema/rejection contract；
- compaction prompt/policy；
- model-visible Tool Registry 名称、schema 和 effect 分类；
- Runtime 导出的 `RuntimeSchedulingPolicyV1` canonical snapshot；2A 不复制 parallel-read
  allowlist、shell overlap、approval、admission 或 late-event 常量；
- 内建 Skill contracts；
- default config/feature/预算/权限；
- Provider Data Policy；
- Release Profile；
- Gate policy；
- build recipe，包括 `package.json` 默认 test script、实际打包的
  `scripts/run-default-tests.ts` 与 process-isolated test 清单；
- lockfile。

要求：

- 不能只 hash 源目录；
- map/key 顺序、换行和平台不导致非语义漂移；
- 语义变化必须改变 digest；
- artifact smoke 重新计算并比对；
- digest 规则有跨平台 golden fixture；
- synthetic fixture 可在 2A-F 验证 canonicalizer；production snapshot 只有 1C 产生，并在
  2A.11 从实际 payload 重新导出；
- 任何 digest 变化使旧 task/live evidence 失效。

### Task 2A.5：实现 Release Manifest

新增 `ReleaseManifestV1` 生成和读取：

- product version、commit、build time、Bun；
- payload SHA-256；
- profile/lockfile/behavior/data/gate/build digests；
- 独立的 Runtime scheduling policy digest；
- Runtime schema；
- supported platform/provider type。

要求：

- detached manifest 与 payload 一起分发，并通过 `payloadSha256` 单向绑定；
- manifest/signature bytes 不进入 `payloadSha256`；
- 平台签名 installer/package 中的 launcher 在执行 payload 前验 manifest signature/hash；
- Runtime loader 启动后再次校验 schema/profile/digest，但其结果不是真实性信任根；
- mismatch/unknown schema 拒绝 production profile；
- buildTimestamp 只用于身份诊断，不进入 Runtime replay。

建议落点：

- `scripts/release/generate-manifest.ts`
- `scripts/release/bootstrap-verifier.ts`
- `src/app/release/manifest-loader.ts`
- `tests/release/manifest.test.ts`

### Task 2A.6：实现 Release Evidence

Evidence bundle 至少聚合：

- manifest identity；
- clean install；
- required jobs；
- platform artifact smoke；
- unit/contract/E2E/PTY；
- lint warning budget；
- dependency audit、license、SBOM、provenance；
- live MCP/model route；
- Provider Data Policy/privacy；
- Agent task suite；
- compaction semantic/continuation；
- soak/resource/failure matrix；
- tool/shell invocation permit/saturation、process-tree enforcement、batch admission、
  approval/cancel/late-event conformance；
- Runtime schema migration/rollback、system/tool/scheduling contract 与默认测试 runner
  identity；
- rollback/incident rehearsal；
- canary SLO window/sample；
- risks 和有限例外。

规则：

- 原始用户内容不进入 bundle；
- URI 必须带 digest；
- result 绑定 job commit、start/end 和 route identity；
- evidence freshness 由 policy 定义；
- missing/mismatch 不是 success。

### Task 2A.7：实现 deterministic Gate Evaluator

Gate：

- G0 安全与状态完整性；
- G1 Required CI；
- G2 平台/供应链；
- G3 capability quality；
- G4 运营；
- G5 产品可用性。

输出：

- artifact overall decision；
- per-capability decision；
- 失败项和 evidence identity；
- required manual approval；
- waiver validity。

规则：

- G0/G1 不可普通 waiver；
- G3 失败只关闭对应 capability，除非破坏全局安全；
- Gate 先校验 identity/digest，再读取结果；
- Gate policy 自身有版本/digest；
- decision 可在 clean environment 重放。

### Task 2A.8：供应链与平台流水线

新增/强化：

- clean checkout + `bun install --frozen-lockfile`；
- 执行 `bun run test`，验证 `package.json` 默认入口解析到制品内绑定的
  `scripts/run-default-tests.ts`，并运行清单中的主 deterministic suite 与全部
  process-isolated tests；入口或隔离清单变化必须改变 build recipe digest；
- dependency vulnerability、license、SBOM；
- artifact provenance 和签名/校验；
- Linux/macOS/Windows artifact build/smoke；
- tampered payload、manifest、launcher/platform signature 三类负向 smoke；
- 启动、Workspace trust、文件、shell、sandbox、session recovery、MCP auth、TUI/CLI；
- registry 不可用时 audit fail closed；
- actual artifact smoke，不从源码替代。

当前 Required CI 保持确定性；nightly/live/RC workflow 按 evidence 类型分层。

### Task 2A.9：可选 disable-only rollout

本任务默认延后到外部 canary 需要分钟级 kill switch 时：

- canonical manifest；
- signed、issuedAt/expiresAt/keyId/sequence；
- embedded trust bundle 和 key rotation；
- replay/降序/clock-skew；
- identity-bound cache；
- 只能 disable、降 cohort、缩 allowlist；
- 服务不可用使用 embedded ceiling；
- mandatory admin requirements 无有效 identity-bound cache 时拒绝受管 session。

远程 rollout 未实现不阻塞首个 contactable limited cohort。

### Task 2A.10：文档与发布流程

新增/更新：

- active Release Profile/Gate 记录；
- `docs/active/feature-flags.md`；
- `docs/active/model-provider-boundary.md`；
- `README.md` 与 CLI 配置；
- `docs/book/09-CLI模式与配置.md`；
- `docs/book/12-测试体系.md`；
- `docs/documentation-map.json`；
- release ADR、changelog、安全与支持矩阵。

### Task 2A.11：RC bundle 与最终 Gate assembly

本任务是 2A 的第二个里程碑，只在 Phase 1A–1C、2B、3 完成后执行：

- 从 clean checkout 生成真实 payload、detached manifest、signature/provenance；
- 从实际 payload 导出 `RuntimeSchedulingPolicyV1`，与 manifest digest、1C evidence 和
  synthetic canonical golden 交叉比对；
- 只消费各计划按 2A Foundation contract 生成且 identity/freshness 匹配的 evidence；
- 以 schema v18 为当前复核基线，分别执行 v16→v17→v18、v18→最终 1C schema upgrade 和
  artifact rollback rehearsal，验证 `aborted/completed` turn、pending interaction、permit
  waiter 与 late tool event 不被错误重开；
- 运行 actual artifact smoke，不从源码目录替代；
- 重放 G0–G5，输出 artifact overall 和 per-capability decision；
- limited Gate 未通过时不发布 payload，也不把计划局部完成宣传为 production ready。

建议落点：

- `scripts/release/assemble-rc.ts`
- `scripts/release/replay-gate.ts`
- `tests/release/rc-assembly.test.ts`
- `tests/release/schema-rollback.test.ts`
- `.github/workflows/release-candidate.yml`

## 里程碑

### 2A-F：Release Contract Foundation

Task 2A.0–2A.7 使用 synthetic payload/evidence fixture 全部通过并进入可追溯恢复点后完成。2B 和 3 只依赖
`MS:2A-F`，不依赖真实 limited artifact 已生成。Task 2A.7 是该 milestone 的唯一
producer；任一前置 Task 或 foundation Gate 失败时不得写入。

### 2A-RC：Release Candidate Assembly

Task 2A.8、2A.10、2A.11 完成；Task 2A.9 只有在决策要求分钟级远程 kill switch 时才进入
该里程碑。Task 2A.11 是 `MS:2A-RC` 的唯一 producer。该 milestone 只表示 candidate
assembly，不产生 `MS:LIM-APPROVED`；ADR-0060 的 single-maintainer 模式必须在后续人工发布
评审中附加由不同真人完成、绑定 candidate identity 的第三方安全评审。

## 验收条件

- [ ] embedded profile 不能被 project/user/CLI 抬高；
- [ ] maturity/rollout 合法组合有 schema 与测试；
- [ ] field composition property tests 通过；
- [ ] TUI/CLI 状态投影准确且不泄密；
- [ ] behavior digest 跨平台稳定、语义变化敏感；
- [ ] scheduling policy digest 来自实际 Runtime canonical snapshot，没有 release 平行配置；
- [ ] detached manifest 在实际 payload 上完成单向 SHA 校验，无自引用；
- [ ] evidence identity mismatch 阻断；
- [ ] Gate decision 可重放；
- [ ] G0/G1 无普通 waiver；
- [ ] dependency/license/SBOM/provenance 与三平台 artifact smoke 完成；
- [ ] schema upgrade/rollback rehearsal 在 1C 完成后的 RC 阶段通过；
- [ ] limited artifact 只在 Phase 1A–3 与 2B Gate 全部满足后由 Task 2A.11 生成。
- [ ] single-maintainer external release 在 `MS:LIM-APPROVED` 前有有效第三方安全评审，且
  维护者没有自批 G0 例外。

## 回滚

- capability 级 off；
- cohort 置 0；
- profile 回退；
- artifact 回退；
- schema 数据只在兼容证明后回退；
- 不允许通过删除 profile loader 回到普通 feature flag 可抬高；
- 不删除 Runtime transcript/Plan/Verification/checkpoint；
- evidence mismatch 时拒绝启动 production profile，而不是使用开发默认。

## 风险

| 风险 | 控制 |
| --- | --- |
| digest 对平台换行敏感 | canonicalization golden |
| digest 未覆盖生成后的 prompt/schema | 对实际 bundle hash，artifact smoke 重算 |
| Gate 读取错 artifact 结果 | manifest identity 先验校验 |
| workflow 绿色但 audit 未实际执行 | network error 为 failure |
| rollout 服务成为授权控制面 | disable-only + artifact ceiling |
| release profile 侵入 Runtime state | composition root 注入，不持久化 maturity |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-release-control.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- limited candidate manifest/evidence；
- Gate replay 输出；
- 三平台 artifact smoke；
- SBOM/license/audit/provenance；
- composition property report；
- behavior digest golden；
- capability status TUI/CLI snapshot；
- rollback rehearsal。
