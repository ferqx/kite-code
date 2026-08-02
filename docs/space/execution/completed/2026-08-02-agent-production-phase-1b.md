# Agent 生产化 Phase 1B 完成记录

状态：completed
日期：2026-08-02
计划：[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
Executor：`github:@ferqx`
默认分支基线：`dc64d25d67c9e40330676668b5f039872d04269a`
实现 PR：[#21](https://github.com/ferqx/kite-code/pull/21)
正式 workflow：[Execution Boundary Artifact Conformance run 30739946155](https://github.com/ferqx/kite-code/actions/runs/30739946155)

## 完成结论

Task 1B.6–1B.9 已完成，Task 1B.9 唯一产生 `MS:1B-DONE`。这是 D-04 空支持集的
**负向完成**：它证明所有候选平台和未获 admission 的 adversarial 路径都被稳定排除，不是
production platform qualification，也不产生可分发制品。

- 1B.6：typed worktree/branch controller、binary-safe change handoff、Git identity/filter/
  replacement/graft 隔离和 active-only recovery 已收敛；失败不会触碰共享 checkout。
- 1B.7：CLI/TUI/status 投影展示 effective boundary；展示层失败不改变 admission。
- 1B.8：MCP transport 绑定 invocation permit、boundary revision 与 receipt；local stdio 和缺少
  App receipt controller 的 production TUI 继续关闭。
- 1B.9：默认分支三平台 synthetic bundle、bootstrap verification 和八类 adversarial negative
  conformance 全部通过。

## 整体 Review 与验证

完整实现 diff 的两路独立只读复核最终均为 GO：Reviewer A（架构、依赖、治理、ADR、文档和
Release Gate）P0/P1/P2=`0/0/0`；Reviewer B（安全边界、故障语义、artifact 身份、测试真实性、
回滚与 adversarial bypass）P0/P1/P2=`0/0/0`。PR #21 的 Required、Execution Boundary、Keyring
三平台门禁全部通过；合并提交为 `dc64d25d67c9e40330676668b5f039872d04269a`。

合并前最终本地验证包括：默认测试 2700 pass/7 skip、Runtime fault 31 pass/1 skip、Runtime soak
7/7、TUI PTY 38 scenarios、release/evaluation/operations 242 pass、worktree 20 pass，以及
typecheck、format、lint、core boundary、docs impact/docs 和 `git diff --check` 全绿。

## 默认分支 artifact 身份

run `30739946155` / attempt `1` 由 `workflow_dispatch` 在 repository `ferqx/kite-code`
（repository ID `1218896626`）、ref `refs/heads/main`、head
`dc64d25d67c9e40330676668b5f039872d04269a` 上运行。workflow path 为
`.github/workflows/execution-boundary-conformance.yml`，workflow ID `325434919`，该 head 上的
workflow blob SHA 为 `0df8ba3a4e57f8b04d0865488b1cdd9cda924b36`。三个原生 job 均为 success：

| Runner | Job ID | Artifact | Artifact ID | GitHub archive digest |
| --- | ---: | --- | ---: | --- |
| `macos-15` | `91475435557` | `execution-boundary-negative-conformance-macos-15` | `8830927216` | `sha256:30ec7696e0b472911e636bb8fd7a98558c65b9f6d2cb822b63b9f7e9131d9dfe` |
| `ubuntu-24.04` | `91475435555` | `execution-boundary-negative-conformance-ubuntu-24.04` | `8830930305` | `sha256:b3e5eaa20cede96ab67d5d956219eace6994126b6bc61ac756e43c2c956f132e` |
| `windows-2025` | `91475435521` | `execution-boundary-negative-conformance-windows-2025` | `8830937470` | `sha256:b84871331dec6aec84108f6e5a531e414e9da8095ddf5d722885b8f5faa7e752` |

三个下载 artifact 均未过期，并由独立 verifier 完成以下重建与检查：

- `ExecutionBoundaryArtifactSmokeV1` canonical JSON 与 domain-separated report digest 重算一致；
- `status=passed_negative_conformance`、3 个唯一 target、8 个唯一 adversarial case，全部 target
  为 `excluded`、全部 case 为 `excluded_not_admitted`；
- `artifactClass=synthetic_non_production`、`productionSupported=false`、
  `supportedCombinationCount=0`、`distributable=false`、`realSigstoreSigningEnabled=false`；
- 三个平台的 payload digest 均为
  `sha256:6404737e03f794e11dab05e95af422f64fd3376e4649bba85fc654ac1130cf42`，canonical
  manifest digest 均为
  `sha256:6e922aacc6cc134599af871106a3331467d8093f20f793d38428949cbd2e70a6`，report digest 均为
  `sha256:24f4ad4aa300e1cf98090a675fd7c6931f05c26b77a0494bb358eaf6a0563d47`；
- `scripts/release/bootstrap-verifier.ts` 对每个实际 synthetic bundle 的 manifest、detached
  fixture signature 和 payload 均验证通过。

## 安全边界、偏差与回滚

D-04 仍是 `accepted_empty_support_set`：macOS/Seatbelt、Ubuntu/bubblewrap、Windows/none 都没有
进入 production 支持矩阵。当前没有 production artifact、真实 Sigstore signing/attestation、
external canary、SLO 或第三方安全评审。foreground Headless CLI writer 保持只读；local stdio MCP
和缺少 App receipt controller 的 production TUI remote MCP 保持关闭。

发生回归时只能收紧：network 退回 off、write/process surface 退回 verified in-process read-only、
writer/MCP capability 关闭、cohort 归零。不得回滚为裸 shell、共享 checkout、环境代理 allowlist 或
可自动恢复的 provisioning worktree。任何未来非空平台支持仍需追加 ADR、真实原生 qualification、
供应链 evidence 和第三方安全评审。
