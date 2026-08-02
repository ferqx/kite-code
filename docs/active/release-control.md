# Release Profile、制品身份与 Gate

状态：active
读取时机：修改 Release Profile、制品布局、manifest/签名、behavior digest、evidence、Gate、
发布状态入口或 release workflow 时。
验证：`bun test tests/release`、`bun run release:build`、`bun run release:verify`、
`bun run release:smoke`、`bun run release:gate:foundation`、
`bun run release:smoke:execution`。
相关：ADR-0051、ADR-0052、ADR-0059、ADR-0060、ADR-0062、D-04、D-06、Phase 2A。

## 当前发布边界

- `releaseProfileV1` 默认关闭。普通 user/project/CLI 配置不能取得 artifact authority；CLI 直接把
  它设为 true 会在 Runtime、MCP、Skill 或 Provider 创建前拒绝，只允许 false 收紧。
- App composition root 同时要求 release artifact ceiling 与 rollout flag。当前 D-04
  production-supported platform 集合为空，因此 `limited/canary/ga` profile admission、production
  payload assembly 和 production Runtime 创建全部 fail closed。
- 四个 embedded profile 只是严格 schema/组合 fixture：所有 capability rollout=`off`、资源预算为
  0、network/logging/telemetry/route 全部关闭。它们不表示可分发产品配置。
- CLI `--release-status` 与 TUI `/release` 只显示脱敏 profile/capability/rollout/execution/logging/
  telemetry/data route count/Verification 状态；不显示 credential、Workspace path、route 名称、
  cohort key 或完整 profile。普通开发入口显示 `artifact_disabled`。

## 制品与 trust root

Foundation bundle 固定为 immutable payload、canonical detached `manifest.json` 与 detached
`manifest.sigstore.json` 槽位。`payloadSha256` 只覆盖 payload bytes，外层目录/ZIP/Release storage
identity 不写回 manifest。pre-exec verifier 在 payload callback 可达前依次验证 regular-file/no-link、
严格 canonical JSON、exact schema、pinned detached signature 和 payload digest，并把已验证 bytes
直接交给 caller，不重新打开路径。

仓库公开前该槽位只接受内嵌测试私钥生成的 `synthetic-ed25519-fixture-v1`：
`distributable=false`、`realSigstoreSigningEnabled=false`。它只能 qualification canonicalization、
tamper 和 pre-exec 顺序，不能产生 production artifact。公开后的目标方案由 ADR-0062 固定为：

- GitHub Actions OIDC + keyless Sigstore/Cosign 签 canonical `ReleaseManifestV1` bytes；
- GitHub artifact attestation 绑定 payload、manifest、SBOM 与 provenance；
- GitHub Releases 托管 Gate 放行 bundle；
- verifier 固定 `ferqx/kite-code`、repository ID `R_kgDOSKbi8g`、workflow/ref/commit/run/attempt/
  artifact identity；
- PR、fork、普通 branch 与维护者本机无签名/发布 authority。

真实 Sigstore、attestation、GitHub Release workflow、平台代码签名与 remote rollout signing 当前均
未启用。平台原生签名/launcher qualification 和 external 第三方安全评审仍分别是硬门禁。

## Behavior、Evidence 与 Gate

Behavior digest 从 12 类已解析/生成后的 canonical snapshot 计算逐项及 aggregate
domain-separated SHA-256：agent/system、ask_user、compaction、tool registry、Runtime scheduling、
Skills、default config、Provider Data Policy、Release Profile、Gate policy、build recipe/default
runner/process-isolated list、lockfile。仅 CRLF/LF 是 transport normalization；不做 Unicode
normalize，也不排序有语义的数组。missing/unknown/空 snapshot/identity mismatch 全部拒绝。

`ReleaseManifestV1` 绑定 aggregate behavior digest、各关键 component digest、payload、commit、
Runtime schema、平台和 Provider type。Runtime-side loader 只做 pre-exec 之后的一致性复核，不是
真实性 trust root；synthetic signature 不能转换为 production admission。

`ReleaseEvidenceV1` 的每项结果绑定同一 artifact identity、commit、start/end、suite、route/
platform（适用时）及带 digest URI；strict schema 不接收 transcript 或用户正文。freshness、identity、
bundle digest mismatch 都是 blocked。G0/G1 不可普通 waiver；G3 capability-specific failure 只关闭
对应 capability；未在 policy 要求的 G2–G5 显示 `not_applicable`，不得显示为 passed。

`release:gate:foundation` 只产生固定 synthetic/non-production、可供 `MS:2A-F` 完成记录引用的
contract fixture；命令本身不写计划 milestone。其 G0/G1 验证 canonical/pre-exec/Gate replay，
不能替代 RC 的供应链、平台、运营、产品、canary SLO 或第三方评审 evidence。

## Execution artifact conformance

`release:smoke:execution` 对实际 synthetic bundle 执行 bootstrap verification，再把 D-04 的三个
候选逐项投影为 `excluded`。报告的八类 adversarial contract 只证明测试来源存在并随 workflow
运行；其 outcome 是 `excluded_not_admitted`，不是平台支持。任何脚本、profile 或 support matrix
出现非空 production support 都立即失败。默认分支三平台 workflow artifact 尚未产生前，1B.9
保持 `in_progress`，`MS:1B-DONE` 不产生。
