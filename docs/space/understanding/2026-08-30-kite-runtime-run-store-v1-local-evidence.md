# Kite Runtime Run Store V1 03B 本地实施证据

状态：local evidence；不是 KRSRUN-03B completion record

日期：2026-08-30

实现基线：本分支待提交 reviewed head；GitHub-hosted evidence 以最终 commit SHA 绑定

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
| default tests | passed | 359 个 workspace test files、99 个 integration files、61 个 isolated files 全部通过；Web Gateway production fixture 已按 current authority 使用 opaque `workerScopeId` 作为 `workspaceId` |
| aggregate implementation suite | 3403 pass / 4 skip | 并行资源争用导致 2 个环境性失败；相关 Coordinator fd/readiness 与 POSIX supervisor 文件串行复跑为 22 pass / 1 skip / 0 fail |
| runtime fault | 36 pass / 0 fail | `bun run test:runtime:fault` |
| runtime CI-profile soak | 7/7 passed | canonical report digest `sha256:c91a603e5ef88a4c5552e2bb8c14972c78d955741e83a18aa2dfc5663ac7fcd6`；不是 formal qualification |
| release tests | 210 pass / 0 fail | 包含 source entrypoint、manager 与 maintenance composition |
| final focused regression | 38 pass / 0 fail | migration、Coordinator client/control plane/carrier 与 Service composition |
| TUI system | shards 0/4、1/4、2/4、3/4 passed | 首次配置、Store5隔离、连续rewind、Controller clean-exit、Session restart与Shell/Thought均通过 |
| Web Gateway close race | 600 pass / 0 fail | `carrier.test.ts --rerun-each 50`；in-flight bootstrap不再被forced listener stop reset |
| format | passed with baseline warnings | 无本 diff format error；Biome 只报告仓库既有 warning/info |

## 4. GitHub 首轮反馈与本地收敛

PR首轮 Required run `33277355089` 与 Candidate run `33277355078` 不是最终证据：macOS/Linux candidate job通过，Windows在
release contract tests中因read-only file descriptor执行`fsync`返回`EPERM`而失败；Required同时暴露Web Gateway forced stop的
`ECONNRESET`、旧Store6/Store5 TUI断言、Store-only Session subscriber未被query projection唤醒、first-run Provider尚未配置时Worker
提前组合Runtime、以及clean exit把idle Controller错误detach等问题。

第二轮implementation head `8dd77d0d`的Required run `33280371984`在首轮单次TUI PTY排队场景失败后重跑成功；同一场景本地连续
30次通过，因此未增加推测性Runtime状态。Candidate run `33280372007`的macOS/Linux完整通过，Windows已越过read-only `EPERM`，但
write-capable Bun `fsync`对每个launcher约长阻塞10秒，使60秒测试超时并触发fixture cleanup级联失败。该run的artifact同样因后续source
修复作废；installer改为复用Builtin Filesystem现有Windows native locked-directory/write-through publication，一次完成二进制launcher、
active pointer与marker的locked-directory publication；launcher/pointer先普通原子发布，最终marker才形成一次write-through commit，partial
publish由marker/pointer/checksum交叉验证fail closed。release不重复高延迟的逐文件flush/move，也不建立第二套Windows I/O owner。

后续两个独立Required首轮又在同一“当前轮运行时排队第二条消息”PTY场景复现：第二次模型请求已到达fixture，但回答未进入viewport。
确定性Native client测试证明，第一轮terminal携带active projection时建立的idle waiter可在event-free idle已结束第一轮后仍处于finally；
旧实现只保存一个session级Promise，因而第二轮terminal无法建立自己的query waiter，run promise与Ink flush一起悬挂。当前实现把waiter绑定
每轮`resolveRun` identity，只有自己的finally可清理该identity；CI环境排队场景本地重复30次、first-run清理场景30项均通过。

本轮其余问题已分别收敛为：Gateway graceful stop刷完已生成response；Host query snapshot经
NotificationProjector hydrate pending subscriber；默认Worker保持Store5 source不可见；Worker用lazy Workspace template在first-run完成后才
组合execution context；TUI按权威projection执行idle release或active/pending/unknown detach。旧run的通过job与artifact均被本轮source变化
作废，不能登记为最终三平台evidence。

## 5. 本地候选包

最终本地候选：

```text
target: macos-arm64
candidateId: af43f919f756c276fb945834
archiveSha256: sha256:53268efa7340d5f223fd3e28c31aab792e85329d31f672e694868b73d550bba0
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

## 6. 未关闭 Gate

仍需把同一 reviewed implementation head 放到 GitHub-hosted macOS、Ubuntu 与 Windows runner，分别完成 native candidate build、verify、
install、正式 maintenance command、process/lock/ACL/atomic replace negatives、upgrade/rollback/uninstall，并登记 run、attempt、artifact 与
digest。只有三平台全部成功、证据绑定提交且 document-before-commit staged 边界复核通过，才可：

1. 创建 KRSRUN-03B completion record；
2. 将 Runtime Run Store V1 子计划迁入 completed；
3. 关闭父 KASAPI-03A，并允许 KASAPI-03B 开始 mutation mapper。
