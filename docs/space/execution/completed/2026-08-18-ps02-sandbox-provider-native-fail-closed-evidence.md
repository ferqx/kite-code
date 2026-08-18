# PS-02 Sandbox Provider 与原生 fail-closed 证据完成记录

状态：completed

日期：2026-08-18

关联计划：[`2026-08-16-trustworthy-runtime-convergence.md`](../../plans/2026-08-16-trustworthy-runtime-convergence.md)

决策：ADR-0111、ADR-0116

## 结论

PS-02 已完成 `SandboxExecutionProviderV1` 的 protocol-first Local seam、durable allocating
preparation/ready/dispatch/disposal lifecycle、private exact preparation Artifact、consumer-owned
single-use spawn、restore reconciliation、fork gate 与 static no-bypass 验收。旧 Windows direct
executor 与 ToolSpec 裸 Shell fallback 已删除；Provider 缺失、原生 cleanup 无法证明或 receipt
未确认时只能 fail closed。

绑定提交 `28e857f8f41913feee5eacd17a2e61fe6cbb439e` 的
[Platform Capability Probe run 32096568806](https://github.com/ferqx/kite-code/actions/runs/32096568806)
在 GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025` 三个 Required job 上全部成功。
每个 job 都完成了平台 conformance、probe、独立 verifier 和不可变 artifact upload。

## 证据身份

| runner class | verification | evidence digest | 结论 |
| --- | --- | --- | --- |
| `macos-15-arm64-github-hosted` | `verified_non_production_candidate` | `sha256:ba0016cc5d92e544e05fc9ce4f2aed5929134f3a20a59d2a576247a56b5dcff4` | `excluded`、`productionSupported=false` |
| `ubuntu-24.04-x64-github-hosted` | `verified_non_production_candidate` | `sha256:9023330ff608f959aeaadc529299f0074051bda31e21b1dfdd9ec0d914d6c077` | `excluded`、`productionSupported=false` |
| `windows-2025-x64-github-hosted` | `verified_non_production_candidate` | `sha256:35d2422de603a53b191e047c02d55a152fa8c6d6f1809228902e33d369205548` | `excluded`、`productionSupported=false` |

三份 source identity 均绑定 repository `ferqx/kite-code`、branch
`codex/trustworthy-runtime-convergence`、workflow SHA/head SHA `28e857f8...`、run ID
`32096568806`、attempt `1` 与封闭 runner class。Linux cgroup descendant cleanup 与 full-chain
产物仍标记 `candidate_only`、`productionEvidence=false`、`productionSupported=false`，不属于
Required platform evidence。

## Windows 负向原生合约

Windows runner 的可重现构建、Cargo 测试、protocol evidence 和提交 pin 校验全部在原生 job
上通过。真实 App composition 的 command 调用则先记录 acknowledged preparation intent，
随后 Local Provider 在 ready/dispatch 前以
`windows_handle_relative_runtime_cleanup_unavailable` 拒绝。Runtime test oracle 记录
`reconcile_preparation_intent`、`prepared=null`、`disposed=false` receipt；没有用户命令输出、
没有 workspace mutation、没有 host/native success fallback。

这是当前权威行为的负向证据，不是成功 native command qualification。未来若要打开
Windows allocating execution，必须用新 ADR 和 handle-relative/no-follow cleanup 实现重新资格化。

## 本地验证

- Windows/App/Provider/workflow 定向套件：65 pass、2 platform-conditioned skip、0 fail。
- `bun run test`：主套件 3715 pass、9 skip、0 fail；5 个 process-isolated 文件全部通过。
- `bun run typecheck`
- `bun run check:core-boundary`
- `bun run check:docs-impact`
- `bun run check:docs`
- `bun run format:check`（仅仓库既有 16 条 `any` warning，exit 0）
- `git diff --check`

## 交付边界

PS-02 的 `completed` 只表示 Provider seam 实现和 Required native fail-closed evidence 齐备。
Darwin、Linux 与 Windows 仍没有非空 production support qualification；
`release/platform-capabilities/support-matrix-v1.json` 仍是空 support set。Runtime schema 仍为 v24，
format epoch 仍为 `kite-runtime-2026-08-15`，`CUT-01` 仍为 `pending`。
