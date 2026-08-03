# Release Profile、制品身份与 Gate

状态：active
读取时机：修改 Release Profile、制品布局、manifest/签名、behavior digest、evidence、Gate、
发布状态入口或 release workflow 时。
验证：`bun test tests/release`、`bun run release:build`、`bun run release:verify`、
`bun run release:smoke`、`bun run release:gate:foundation`、
`bun run release:smoke:execution`。
相关：ADR-0051、ADR-0052、ADR-0059、ADR-0060、ADR-0062、ADR-0067、D-04、D-06、Phase 2A。

## 当前发布边界

- `releaseProfileV1` 默认关闭。普通 user/project/CLI 配置不能取得 artifact authority；CLI 直接把
  它设为 true 会在 Runtime、MCP、Skill 或 Provider 创建前拒绝，只允许 false 收紧。
- App composition root 同时要求 release artifact ceiling 与 rollout flag。发行 identity registry 固定
  为 `macos-15-arm64`、`ubuntu-24.04-x64`、`windows-2025-x64`，它只证明目标 artifact identity，
  与 D-04 的空 effectful execution support registry 正交。由于 authenticated production artifact receipt
  尚无 producer/trust root，App composition 对所有 `production=true` 固定返回
  `production_artifact_authority_unconfigured`，controlled config 也拒绝调用者伪造 active production
  composition。registry membership 只能用于 manifest/分发候选 contract，不能由布尔值变成 Runtime authority。
- 六个 embedded profile（含 manual/auto compaction）只是严格 schema/组合 fixture：所有 capability rollout=`off`、资源预算为
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
未启用。平台原生签名/launcher qualification 仍是硬门禁。ADR-0067 已把另一位真人的第三方安全
评审改为可选增强；发布仍必须有绑定不可变 candidate 的 single-maintainer security review。

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
Evidence kind 明确区分 Phase 3 limited cohort 的 `limited_slo` 与后续 capability canary 的
`canary_slo`；二者不能互相替代或复用 milestone。

GitHub release policy 必须恰好包含一个全局、不可 waiver 且带 freshness 的
`maintainer_security_review` requirement。Manual approval 只由绑定同一 candidate 的具名维护者 review
满足；过期、identity mismatch、未覆盖五个固定安全范围、存在未关闭 P0/P1 或任一适用自动 Gate 非
passed 都全局阻塞。review execution identity 还必须绑定 canonical repository/ID、release workflow
path/ref/SHA、tag、run/attempt 和 GitHub OIDC issuer，且 workflow actor 与 reviewer 都必须精确为
`github:@ferqx`。维护者可以按 ADR-0067 承担该 review，但不能自批 G0/G1 例外，也不能把
结果声明为 independent/third-party reviewed。第三方 review 可作为附加 evidence，不是
`approved_candidate` 的必需 trust root。

`release:gate:foundation` 只产生固定 synthetic/non-production、可供 `MS:2A-F` 完成记录引用的
contract fixture；命令本身不写计划 milestone。其 G0/G1 验证 canonical/pre-exec/Gate replay，
不能替代 RC 的供应链、平台、运营、产品、canary SLO 或 candidate-bound maintainer review。

RC 本地控制面现补齐三个独立 contract：`gate-replay.ts` 对 retained decision 做 byte-equivalent
deterministic replay；`schema-rollback.ts` 用 synthetic fixture 验证 durable fact 保留、unknown external
effect 永不盲重放；`assemble-rc.ts` 要求 MS:1A/1B/1C/2B/3、2A.8/2A.10、Gate replay、rollback 与
candidate-bound maintainer review 全部绑定 exact candidate identity；detached manifest、evidence bundle、release Gate、supply-chain、
Gate replay 与 rollback 六项关键输入还必须各自绑定 digest/artifact/verification receipt，并进入 assembly
digest。assembler 是纯 Gate，不写 bundle、不发布；它只消费源码中预登记的 exact verified statements，
本身不是密码学 verifier。当前 registry 为空，因此尚不存在 `passed/distributable` 路径；Task 2A.11 未来仍是
`MS:2A-RC` 的唯一 producer。source-owned RC authority 与任一真实 dependency evidence 缺失时固定 blocked、
`distributable=false`、`milestone=null`。

## Execution artifact conformance

`release:smoke:execution` 对实际 synthetic bundle 执行 bootstrap verification，再把 D-04 的三个
候选逐项投影为 `excluded`。报告的八类 adversarial contract 只证明测试来源存在并随 workflow
运行；其 outcome 是 `excluded_not_admitted`，不是平台支持。任何脚本、profile 或 support matrix
出现非空 production support 都立即失败。默认分支
[run 30739946155](https://github.com/ferqx/kite-code/actions/runs/30739946155) 的 macOS 15、Ubuntu
24.04、Windows 2025 artifact 已通过独立 canonical/report digest 重建和 bootstrap verification，
因此 1B.9 以 negative conformance 完成并唯一产生 `MS:1B-DONE`。结果仍固定
`productionSupported=false`、supported count=0、`distributable=false`、真实 signing disabled；
它不满足 2A.8 的 production platform、供应链或 candidate-bound maintainer review 证据。

## Supply chain 与 disable-only rollout 的当前边界

`release-candidate.yml` 当前只有手动、无发布权限的 contract workflow；所有 Actions 固定 immutable
commit，production signing job 永不运行。SBOM、provenance 与三平台 launcher smoke 只能生成或校验
`nonDistributable=true` synthetic fixture；registry vulnerability/license audit、真实平台签名、实际制品
smoke、OIDC Sigstore/attestation 和 GitHub Release 尚未发生。2A.8 因真实 build/audit、发布者身份、
平台原生签名/notarization、provenance/attestation、actual artifact smoke 与 candidate-bound maintainer review 均缺失而
保持 blocked；D-04 空 support set 只阻止 effectful execution capability，不阻止普通跨平台 TUI/CLI
artifact 的构建与资格验证。
三平台 contract 命令必须使用显式、Workspace-relative 测试路径；不得依赖 Bash glob 展开，因为
Windows PowerShell 会把未展开的 wildcard 原样交给 Bun，造成测试未执行而不是有效的负向证据。

禁用的 production job 已具备独立 verifier 骨架：canonical repo 的 numeric ID `1218896626` 用于
GitHub/OIDC certificate identity，GraphQL node ID `R_kgDOSKbi8g` 用于 Release Gate artifact identity；
tag/ref、commit、workflow ref/SHA、run/attempt 必须同时匹配。所有输入先经 no-follow、unique-inode、
bounded regular-file 检查并复制到 verifier-owned immutable snapshot。`gh`、`cosign`、`codesign`、
`spctl`/PowerShell 只允许来自 OS 管理、普通 runner 身份不可写的受保护安装树，并要求显式
path+SHA-256 tool receipt、执行前后 digest 一致和命令超时；Windows 只接受 system volume 上的精确
`GitHub CLI`、`PowerShell 7` 与 `Kite Verifiers/cosign.exe` allowlist（依赖标准 Program Files ACL），
拒绝其他 volume 或任意 Program Files 子路径。user-writable tool cache 或 verifier 同 UID
可改写的临时 executable 不属于信任边界。Windows PowerShell 从完整受保护安装目录原位运行，不复制
孤立 `pwsh.exe`。

上述工具所有权只在隔离 verifier job 内构成信任边界：该 matrix job 使用新的 GitHub-hosted VM，
不 checkout、安装或执行 candidate source，只从 protected variable 指定的已评审 verifier commit 安装
冻结依赖；checkout 后、任何 setup/install 前必须证明变量是 40 位小写 commit SHA 且实际 `HEAD` 精确
相等，branch/tag/短 SHA 均 fail closed。job 通过 pinned `download-artifact` 把 build job 产物作为
opaque input 下载。候选代码即使在
build job 启动 sudo/admin 同权限后台进程也不能跨 VM 进入 verifier；缺失 protected verifier commit、
下载 artifact 或任一 receipt 时直接失败。
该 exact verifier commit 同时进入 expected identity、maintainer security-review record 与 verifier 返回
identity；Gate decision 通过 evidence bundle digest 绑定该 review。修改 protected variable 会使既有
review/Gate digest 全部失效，
不能在 workflow SHA 不变时静默更换判定实现。

外层 `tar.gz` 只接受 canonical USTAR regular/directory entry、精确双零块终止与零 padding；拒绝
PAX/GNU long-name/global metadata、link、`.`/`..`/空路径段、非规范 UTF-8/NUL padding 和规范化后的
重复路径。payload 必须包含固定平台路径的精确 native launcher，提取成员 bytes 与独立签名对象
digest 一致；canonical manifest 再绑定 archive digest、commit 与单一 distribution identity。GitHub
attestation 覆盖 payload/native launcher/manifest/SBOM/provenance/Gate policy/evidence bundle/Gate
decision/maintainer review/rollback replay report/compatibility replay report 十一个 subject。后两项必须是
strict、candidate-bound、带 verifier receipt 的实际文件；review 绑定其 canonical record digest，不能用
命令行传入的裸 digest 代替。Linux launcher 使用
keyless Sigstore；macOS 从同一受控 archive 安全重建完整 `Kite.app`，要求 launcher、`Info.plist` 与
`_CodeSignature/CodeResources`，对 app bundle 执行 deep/strict external requirement、固定 Developer ID
Team ID、leaf certificate SHA-256 与 Gatekeeper notarization assessment，而不是只验证内部 executable；
Windows 固定 Authenticode signer certificate/SPKI、trusted root 与 timestamp certificate。
G0–G5 必须全部 `passed`，G5 还必须绑定 `github:@ferqx` 的 candidate-bound maintainer review evidence；
verifier 会从受保护 Gate policy 和完整 evidence bundle 重放 exact Gate decision，并通过 GitHub Actions
run API 验证 `actor`/`triggering_actor=ferqx`、run/attempt、成功终态和真实
`created_at/run_started_at/updated_at`。review/Gate/evidence 时间必须落入该认证 run 窗口且相对 verifier
当前时间未过 freshness。producer/review run 必须先结束并产出绑定自身 run ID/attempt 的候选；后续独立
admission run 使用 protected source run ID/attempt 下载该前序 artifact 并查询其成功终态，不能在当前
run 尚未结束时把当前 run 伪装为 completed。workflow 使用只读 `actions: read` 与 `github.token` 查询该记录。review 进入
Gate/evidence digest，但不再要求独立
reviewer public key 或单独 Cosign signature。`not_applicable`
不能绕过 maintainer security review，review 也不能覆盖 G0/G1 或未关闭 P0/P1。
当前 job 固定 `if: false && github.workflow_sha == protected expected workflow SHA`、无
OIDC/attestation/write 权限、trusted verifier commit/expected workflow SHA 未配置且 Gate digest 故意
无效；即使误删一个条件也会
fail closed。verifier 已有源码内 exact trusted-verifier-commit registry 驱动的条件式 production receipt；
registry 当前为空，所以完整真实验证前仍只返回 blocked、`productionReceipt=null`。

Windows、Linux 与 macOS 是发行目标，但这不把任一平台自动加入 production execution support
set。普通跨平台 launcher/TUI contract 使用 GitHub-hosted matrix；Shell/writer 等 effectful
capability 仍按精确平台 evidence 单独准入。常规发行不要求 self-hosted Ubuntu。

platform capability workflow 现在把 canonical repository、numeric repository ID、head/ref、workflow
path/ref/SHA、run/attempt、封闭 runner class 全部写入来源，并在上传前由独立 verifier 从环境提供的
expected source 重建 exact schema、digest、outcome 与 limitations；未知字段或 source splice 直接失败。
该 verifier 固定只接受 `productionSupported=false` 的 candidate evidence，不能提升 D-04。

disable-only rollout loader/cache 已实现严格 canonical/signature/identity/sequence/expiry/replay 与 0600、
no-follow、atomic cache contract。fixture trust root 是公开 synthetic key，
`realRolloutSigningEnabled=false`。远程 manifest 只能关闭能力、降低 cohort 和缩 allowlist，再由 profile
composer 二次拒绝扩大；invalid/unavailable 回 embedded ceiling，mandatory admin 无有效 cache 时 denied。
D-03 已关闭并要求 external canary 使用独立显式 opt-in、匿名无正文 telemetry；external canary
composition 不再接受 caller-provided artifact/feature booleans，而只消费 release-owned production
canary profile ceiling。当前所有 embedded capability 与 telemetry ceiling 均 off。真实 rollout
service/signing、exporter、baseline 和 observation 仍未启用，因此该实现不产生远程控制能力或
2A-RC evidence。

## Phase 6 本地 Gate contract

跨 capability maturity Gate 已预构建 canary → beta → stable 的严格顺序与 exact identity chain，要求
预注册 observation window/sample/error budget、G3–G5、`github:@ferqx` 具名单维护者 approval、用户理解度、rollback 和
freshness。production authentication subject、attestation/verifier identity 与 source-owned exact
verified-record lookup 已实现；仓库代码不执行 attestation 密码学验证，受信 evidence authority、已验证
前序 decision 与已验证维护者 approval registry 各自固定为空。
shape-valid production observation 或只填充其中一个身份
集合仍只能 blocked，不能产生 promotion 或被 Phase 6 selection 当作 stable decision。

`release/ga-selection-v1.json` 当前 selected capability 为空，并显式把全部 15 个 Release Capability
forced off。validator 要求每个 selected capability 绑定精确且 fresh 的 stable decision，并要求 selected/
forced-off 对全集做无重叠分区。当前 GA Gate 因 `MS:LIM-APPROVED`、`MS:LIMITED-SLO`、
`MS:2A-RC`、`MS:3-OPS-READY`、candidate-bound maintainer review、非空 production support set 与 stable selection
全部缺失而 blocked；它不能 assemble 或 publish artifact。GA 前置不再接受调用者布尔值，而要求
artifact/profile/route/cohort 一致的 typed decision records；source-owned exact dependency record 还绑定
完整 canonical selection digest（包含 capability set、stable decision digest 与 approval）。它不是密码学
verifier 且 registry 为空，因此即使提供 shape-valid fixture 也固定 `gaEligible=false`。

Auto Compaction admission contract 消费同一 candidate identity 的 typed dependency decisions 与
G0/G1 ledger digest，所有前置 identity 都进入 decision digest；dependency statement 与 safety observation
分别要求源码内 exact verified record，不能只认证 dependency 后由调用者自报零事故；两个 registry 都为空，
所以 fixture 永远 blocked、`auto_compaction` 为 off/cohort 0。评估自身固定零 summary dispatch、零
checkpoint write。GA compatibility
replay 只使用 `synthetic_contract_only` fixture，验证 transcript/Plan/Receipt/Verification/checkpoint
事实不被删除、unknown external effect 不重放；`productionEvidence=false`，不能作为发布或观察证据。

`assemble-ga.ts` 现提供纯 GA assembly/replay Gate，绑定 candidate/artifact/profile/route/cohort、canonical
selection、rollback/compatibility replay 与 candidate-bound maintainer review。它没有 filesystem、network 或 publish 路径；
replay wrapper 必须携带 verifier identity、completion time 与 verification receipt digest，review 必须晚于
dependency verification 和两项 replay completion；未来 source-owned authority 必须用不可拆分的 exact
kind/verifier/receipt/candidate/selection/report record 固定 replay，不能分别维护 verifier/receipt allowlist
或只信任调用方时间。
production assembly authority 为空时固定不写 bundle、不发布、`milestone=null`。
