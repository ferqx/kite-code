# Kite Runtime Run Store V1 03B 本地实施证据

状态：local evidence；不是 KRSRUN-03B completion record

日期：2026-08-30

实现基线：`d5e7f81cbf95d4852bdfc6dd906c0c5f13fb71d4`

相关：[`Runtime Run Store V1 子计划`](../plans/2026-08-29-kite-runtime-run-store-v1.md)、
[`release authority`](../../active/release-control.md)、
[`runtime resilience authority`](../../active/runtime-resilience-qualification.md)。

## 1. 本地结论

KRSRUN-03B 已在 macOS arm64 本地实现正式 Store 7→Store 8 运维入口，并完成当前 diff 的 owner、fault、soak、release 与
installed-candidate 验证。实现保持 fail closed：CLI 不能自造 maintenance barrier；Coordinator 必须先通过 authenticated v2
stop 进入 draining，并在 response flush 后关闭；manager 随后确认 exact process exit，持有 Coordinator lifecycle lock，并在锁内
再次确认 descriptor、endpoint、launch intent 与 instance lock 均不存在，再按
持久 process identity 收敛 Gateway 与 idle Worker。Host State、SQLite authority/effect/WAL 与 migration source deep validation
任一不确定时，命令返回 `blocked` 且不切换 active generation。

本地结果不能替代 GitHub-hosted macOS/Linux/Windows 文件系统、ACL、lock、atomic replace 和 installed-candidate 结果。因此：

- KRSRUN-03B、父 KASAPI-03A 与整个 Runtime Run Store V1 计划仍为 active/blocked-on-hosted-evidence；
- 不创建 `docs/space/execution/completed/` 记录，不开放 Public Run route，不声明 ServerInfo `runs` capability；
- 当前 candidate 为 dirty-source 本地诊断证据，不可发布，也不是 G1 evidence。

## 2. 实现与 focused evidence

正式命令：

```text
kite maintenance migrate-run-store \
  --target-generation <fresh-generation> \
  [--kite-home <absolute>]
```

关键 focused 验证覆盖：CLI parser/typed blocked exit、empty Store 7→Store 8 E2E、Coordinator lifecycle lock contention、
authenticated stop/draining、carrier response-flush shutdown、late shutdown waiter、real Coordinator source process exact exit、Worker busy/
uncertain/corrupt refusal、Coordinator stop/status 与 acquire 之间的并发 ensure 窗口，以及 Service-owned Host State settlement predicate。
最后一次串行 focused 回归为 38 pass / 0 fail。

## 3. 本地 Gate 记录

| Gate | 结果 | 说明 |
| --- | --- | --- |
| 15-workspace typecheck | passed | root 与 15 个 workspace 全部通过 |
| 15-workspace build | passed | 全部 workspace 通过；最终候选构建再次编译 release production entrypoints |
| runtime package/static/docs gates | passed | runtime packages、pre-release architecture、core boundary、test ownership、Agent API packages、docs impact 与 docs |
| default tests | baseline exception | 本任务相关 target 通过；只复现既有 `web-gateway-production.test.ts` 的 `workspaceId` 期望差异，本任务未吸收该无关改动 |
| aggregate implementation suite | 3403 pass / 4 skip | 并行资源争用导致 2 个环境性失败；相关 Coordinator fd/readiness 与 POSIX supervisor 文件串行复跑为 22 pass / 1 skip / 0 fail |
| runtime fault | 36 pass / 0 fail | `bun run test:runtime:fault` |
| runtime CI-profile soak | 7/7 passed | canonical report digest `sha256:10a3c8bd419d95c14d741c10c25341cbf9c1b711c0c1b5e5465178a8bbda00d1`；不是 formal qualification |
| release tests | 210 pass / 0 fail | 包含 source entrypoint、manager 与 maintenance composition |
| final focused regression | 38 pass / 0 fail | migration、Coordinator client/control plane/carrier 与 Service composition |
| format | passed with baseline warnings | 无本 diff format error；Biome 只报告仓库既有 warning/info |

## 4. 本地候选包

最终本地候选：

```text
target: macos-arm64
candidateId: 172fcbd79dce619bb82048ec
archiveSha256: sha256:e8931fb83ea576cedf6cb759b724ed96d4045c85a59315e255ffc043e7ab6eab
sourceDirty: true
```

`release:build`、`release:verify` 与 `release:smoke` 全部通过。installed-candidate smoke 的闭合检查为：

```text
verify
install
cli-help-version
run-store-maintenance-fail-closed
tui-version-pty-startup
service-companion
coordinator-worker-gateway-companion-assets
web-payload-assets
mcp-stdio-authenticated-wrapper
upgrade
active-pointer
immutable-candidate-roots
rollback
uninstall
```

其中 `run-store-maintenance-fail-closed` 在 fresh home 上显式运行 installed CLI，要求返回 exact
`blocked/maintenance_required` 且进程非零退出，证明候选包没有把空源或不满足 barrier 的场景误判成成功。

## 5. 未关闭 Gate

仍需把同一 reviewed implementation head 放到 GitHub-hosted macOS、Ubuntu 与 Windows runner，分别完成 native candidate build、verify、
install、正式 maintenance command、process/lock/ACL/atomic replace negatives、upgrade/rollback/uninstall，并登记 run、attempt、artifact 与
digest。只有三平台全部成功、证据绑定提交且 document-before-commit staged 边界复核通过，才可：

1. 创建 KRSRUN-03B completion record；
2. 将 Runtime Run Store V1 子计划迁入 completed；
3. 关闭父 KASAPI-03A，并允许 KASAPI-03B 开始 mutation mapper。
