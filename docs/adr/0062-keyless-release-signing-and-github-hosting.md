# ADR-0062：开源发布使用 GitHub OIDC、keyless Sigstore 与 GitHub Releases

状态：accepted
日期：2026-08-02
决策者：`github:@ferqx`（Release + Security & Privacy，single-maintainer）
关联：D-06、Phase 2A、ADR-0052、ADR-0059、ADR-0060

## 背景

项目当前只有一位维护者，未来计划开源并接受外部 Pull Request。把长期制品签名私钥放在维护者
本机或仓库 secret 中，会把发布真实性绑定到单一设备和长期 secret；允许 PR、fork 或普通分支
取得签名权，则会让外部贡献路径越过发布 Gate。项目还需要把可下载制品、detached manifest、
SBOM、构建 provenance 和实际 GitHub workflow identity 绑定在一起，但当前 private 仓库阶段不应
为了实现 foundation fixture 就产生可分发制品或公开透明日志记录。

## 决策

1. 首个开源发布的真实性入口使用 GitHub Actions OIDC 和 keyless Sigstore/Cosign。发布 workflow
   对 RFC 8785 canonical `ReleaseManifestV1` UTF-8 bytes 执行 `cosign sign-blob`，保存 detached
   Sigstore bundle；不为首发建立长期 Ed25519 私钥、KMS key 或维护者本机签名路径。
2. GitHub artifact attestation 记录 payload、canonical manifest、SBOM 和构建 provenance；GitHub
   Releases 托管经过 Gate 放行的完整可分发 bundle。外层 Release/ZIP storage identity 不写回
   manifest，也不参与 `payloadSha256`。
3. verifier 必须同时固定 canonical repository `ferqx/kite-code`、GitHub repository ID
   `R_kgDOSKbi8g`、release workflow path、OIDC issuer
   `https://token.actions.githubusercontent.com`、受保护 tag/ref、commit、workflow SHA、run ID、
   run attempt 和 artifact digest。任一 identity 缺失、未知或 mismatch 都 fail closed。
4. PR、fork、普通 branch workflow 和维护者本机均不得产生可分发签名或 Release。真实发布 workflow
   只允许从受保护的 release tag/default-branch source 进入，使用最小 `id-token: write`，GitHub
   Actions 依赖固定到不可变 commit，并在签名/attestation 前完成同 identity Gate replay。
5. 仓库公开前，2A Foundation 只能使用标为 `synthetic`、`nonDistributable=true` 的测试 trust root
   和 tamper fixture；真实 Sigstore signing、GitHub attestation 与 GitHub Release workflow 保持
   disabled。fixture 通过不能产生 production artifact、platform qualification 或发布结论。
6. 远程 rollout signing 按 ADR-0059 继续 disabled；它不阻塞首个 contactable limited cohort，
   也不能复用本 ADR 的 release workflow 权限来扩大 artifact ceiling。
7. Sigstore/attestation 不替代 macOS Developer ID/notarization、Windows Authenticode、Linux package
   分发约束或平台 launcher 的 pre-exec 验证。每个平台仍需自己的原生签名、installer/launcher
   identity 与 qualification；当前 D-04 production support set 继续为空。
8. ADR-0060 的 external release 前第三方安全评审仍是硬门禁。keyless 签名只证明受约束 workflow
   产生了某组 bytes，不证明该 candidate 的安全或产品 Gate 已获独立批准。

## 备选方案

- 维护者本机长期私钥：拒绝，单设备泄露、备份和轮转风险高，也难以绑定实际 workflow identity。
- GitHub repository secret 保存长期私钥：首发拒绝；增加 secret custody 和轮转负担，不优于 OIDC
  短期身份。
- PR/fork 构建直接签名：拒绝，外部贡献输入不能拥有发布 authority。
- 只发布 checksum 或只依赖 GitHub Release HTTPS：拒绝，不能独立验证 canonical manifest 的
  workflow identity 与 provenance。
- private 阶段直接产生 transparency-log 记录：拒绝，foundation 不需要泄露未发布 artifact
  identity，也不能把 synthetic fixture 冒充正式签名。

## 后果

- 单维护者不需要保管长期 release 私钥，外部贡献也不会因为合入代码而自动取得签名权限。
- verifier 和 workflow 需要严格维护 repository/workflow/ref/run/artifact identity；仓库迁移或
  workflow path 变化会主动使旧 policy 失效，并要求追加决策与重新 qualification。
- 仓库保持 private 时可以完成 schema、canonicalization、tamper、Gate 与 synthetic replay，但
  真实 signing/attestation/hosting evidence 必须等待公开仓库和受保护发布 workflow。
- 平台原生签名与第三方安全评审仍会在后续 candidate 阶段产生真实外部成本。

## 回滚

可以继续把真实 signing/release 保持 disabled、删除未发布的 synthetic fixture 或回退完整
payload/manifest/evidence bundle。若未来需要 KMS/HSM、其他托管后端或 repository migration，必须
新增 ADR 和 trust-policy revision；不能回滚为 unsigned 分发、PR/fork signing、长期私钥散落本机、
identity mismatch 继续执行 payload，或用 synthetic bundle 冒充正式 release evidence。
