# Agent 生产化 Phase 2A Release Contract Foundation 完成记录

状态：completed
日期：2026-08-02
计划：
[`2026-07-29-agent-production-release-control.md`](../../plans/2026-07-29-agent-production-release-control.md)
执行者：`github:@ferqx`
激活基线：`d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0`
实现提交：`2e98681c800a2f1f745bc18e41ac682d9c09e84b`

## Gate 决策

结论：`approved_to_complete_2A.0–2A.7`，由 Task 2A.7 唯一产生 `MS:2A-F`。

该 milestone 只表示 non-production Release Contract Foundation 已具备可重复的 payload、manifest、
profile、behavior identity、evidence 与 deterministic Gate contract。Foundation decision 为
`approved_foundation`，只包含 G0/G1 passed；G2–G5 均为 `not_applicable`。它不生成可分发制品，
不启用真实 Sigstore、artifact attestation、GitHub Release、平台代码签名或 remote rollout signing，
不改变 D-04 的 `accepted_empty_support_set`，也不替代后续 RC、canary SLO 或第三方安全评审。

## Task 2A.0：payload、detached manifest 与 pre-exec verifier

- 实现 `canonical-json.ts`、artifact layout/build/verify/bootstrap 入口与 package scripts；payload、
  canonical manifest 和 detached signature 分离，外层 storage identity 不写回 manifest；
- pre-exec verifier 在 callback 可达前验证 regular/no-link、strict canonical JSON、exact schema、
  synthetic signature 和 payload digest，并把已验证 bytes 直接交给 caller；
- 当前 trust root 明确为 `synthetic-ed25519-fixture-v1`、`distributable=false`、
  `realSigstoreSigningEnabled=false`，不能转换为 production authority；
- 定向验证：artifact/bootstrap tests 全部通过，synthetic build/verify/bootstrap 均成功。

## Task 2A.1：Release Profile schema

- 新增稳定 capability ID、严格 `ReleaseProfileV1` schema、四个 embedded profile 与默认关闭的
  `releaseProfileV1`；
- D-04 空支持集下全部 embedded capability rollout 为 off，预算、route、logging、telemetry 和
  network 均保持最严格关闭；production profile 缺 flag 或支持集时 fail closed；
- 定向验证：release-profile tests 全部通过。

## Task 2A.2：单调组合

- composer 对 capability/content 使用 deny-wins，对 allowlist 取交集，对 deny/protected 集合取并集，
  对预算/权限/retention/classification/approval/Verification 取更严格值；
- project、user、CLI 与 rollout layer 只能收紧 embedded ceiling；顺序变化不改变安全结果，未知安全
  字段、非法 profile 或权限抬高全部拒绝；
- 定向验证：composition property tests 全部通过。

## Task 2A.3：App composition 与状态入口

- App composition root 把 artifact authority 与 rollout authority 分离；两者都满足后才可组合 profile，
  普通开发 CLI/TUI 不获得 artifact authority；
- CLI `--release-status` 与 TUI `/release` 只投影脱敏状态；CLI 直接启用
  `releaseProfileV1=true` 在 Runtime/MCP/Skill 创建前拒绝，false 仍可收紧；
- D-04 空支持集下 production composition 返回 `production_support_set_empty`；
- 定向验证：release-status tests 与 TUI `/release` PTY scenario 全部通过。

## Task 2A.4：BehaviorDigestV1

- 对 12 类实际解析/生成后的 behavior component 计算 domain-separated item/aggregate SHA-256；
- canonicalization 只规范 CRLF/LF，不做 Unicode normalize，不排序有语义数组；missing、unknown、
  identity/digest mismatch 与非 JSON 输入 fail closed；
- non-production cross-platform golden 与输入 fixture 已固定并由独立 rebuild 验证；
- 定向验证：behavior-digest tests 全部通过。

## Task 2A.5：ReleaseManifestV1

- manifest 绑定 payload、commit、Runtime schema、platform、Provider、aggregate behavior digest 与
  关键 component digest；
- bootstrap verifier 是真实性边界，Runtime loader 只在 pre-exec 之后复核运行时一致性；
- synthetic fixture 无法被改写为 production trust root，payload/manifest/platform/provider tamper
  全部拒绝；
- 定向验证：manifest/bootstrap tamper tests 与 `release:verify` 全部通过。

## Task 2A.6：ReleaseEvidenceV1

- strict evidence schema 要求全部 result 绑定同一 artifact identity、execution identity、suite 与
  digest URI；不接收 transcript、用户正文或未知字段；
- stale、identity splice、bundle tamper、synthetic distributability 抬高、G0/G1 exception 全部拒绝；
- 定向验证：evidence bundle/rebuild/tamper tests 全部通过。

## Task 2A.7：deterministic Gate Evaluator

- identity-first evaluator 固定 policy digest，G0/G1 不可 waiver；G3 capability-specific failure 只
  关闭对应 capability，global failure 阻断整体；未要求的 G2–G5 为 `not_applicable`；
- GitHub release candidate 必须带 GitHub Actions identity，第三方安全评审 evidence 必须来自
  external reviewer identity；synthetic bundle 永远不能成为 candidate；
- deterministic foundation replay 结果：policy digest
  `sha256:24c58f186316d11dbd17889776bf1ff040d80333ba3ee3915746d8032d09c7f0`，evidence bundle
  digest `sha256:406882b0be2a5814ae3cf13cd72971f6873d11d981ed3d0ac3b956a85d24be35`，decision
  digest `sha256:ca24e4cebceacb0832078cefff5028fa0d5083251fe0c19d66abc3d8dca4ac23`；
- 定向验证：gate evaluator tests 与 `release:gate:foundation` clean replay 全部通过。

## 共同验证命令与结果

- `bun run typecheck`：通过；
- `bun test tests/release`：53 pass、0 fail、401 expect；
- `bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/sandbox-mode.test.ts`：
  3 pass、0 fail；
- `bun run release:build`、`bun run release:verify`、`bun run release:smoke`：全部验证
  non-distributable synthetic fixture；payload digest
  `sha256:6404737e03f794e11dab05e95af422f64fd3376e4649bba85fc654ac1130cf42`，manifest digest
  `sha256:6e922aacc6cc134599af871106a3331467d8093f20f793d38428949cbd2e70a6`；
- `bun run release:gate:foundation`：`approved_foundation`，G0/G1 passed，G2–G5
  `not_applicable`；
- `bun run release:smoke:execution`：`passed_negative_conformance`，supported count=0，3 个 target
  excluded，8 个 adversarial contract 为 `excluded_not_admitted`，report digest
  `sha256:24f4ad4aa300e1cf98090a675fd7c6931f05c26b77a0494bb358eaf6a0563d47`；该结果属于
  1B.9 本地证据，不完成 1B.9；
- `bun run format:check`、`bun run lint`：成功退出，仅保留仓库既有 warning/info；
- `bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、
  `git diff --check`：全部通过；
- commit pre-hook：Core boundary、docs、docs-impact、format、10 个 golden、typecheck 全部通过。

## 文档与 ADR 收敛

- 当前行为同步到 `docs/active/release-control.md`、feature flags、execution platform、Runtime
  qualification、TUI standards、README 与 book 第 8/9/12 章；
- `docs/documentation-map.json` 新增 release-control 映射，计划门禁同步当前 1B.9 状态；
- 用户批准 D-06 后新增 accepted ADR-0062，固定未来公开仓库使用 GitHub Actions OIDC/keyless
  Sigstore、GitHub artifact attestation 与 GitHub Releases；private 阶段真实 signing/release disabled；
- ADR-0060 的 external release 前不同真人第三方安全评审仍是硬门禁。

## 未运行项与真实 evidence waiting

- 未运行真实 Sigstore/Cosign signing、GitHub artifact attestation、GitHub Release 或
  `.github/workflows/release-candidate.yml`；Task 2A.8–2A.11 尚未完成；
- 未生成 SBOM/provenance/platform-native launcher qualification 或可分发 RC；
- 1B.9 的默认分支 macOS/Ubuntu/Windows workflow artifact 尚未运行，故 1B.9 与
  `MS:1B-DONE` 保持 pending；
- 未运行 external canary、limited cohort SLO、maturity/GA observation 或第三方安全评审；
- 没有 capability 获得 production support，所有 production capability 仍 off/excluded。

## 风险、偏差与回滚

- synthetic Ed25519 只验证 contract 与 tamper 顺序，不能提供 OIDC identity、transparency log 或
  supply-chain provenance；任何调用方若把它当作 production root 必须 fail closed；
- Foundation 的 fixed all-zero commit、`example.invalid` URI 与 epoch timestamp 是显式
  non-production fixture identity，不得替换为貌似真实的本地值；
- 计划原列独立 `release-status.test.ts` PTY 文件；实际把 `/release` 场景并入现有
  `sandbox-mode.test.ts`，共享同一开发 composition fixture，不改变验收强度；
- 回滚可以移除 ordinary CLI/TUI status 入口、禁用 package scripts 或回退完整
  `2e98681c800a2f1f745bc18e41ac682d9c09e84b`；`releaseProfileV1=false`、artifact authority 缺失、
  D-04 空支持集和 synthetic non-distributable 标记均保持 fail closed，不能只回滚 verifier 或
  Gate policy 后继续接受旧 evidence。
