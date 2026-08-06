# ADR-0071：L3 资格化受保护 scratch supervisor、生命周期 journal 与删除证明

状态：accepted
日期：2026-08-06
决策者：`github:@ferqx`（已授权 Linux root-owned service、native helper 与 immutable worker bundle 的范围）
补充：ADR-0070、ADR-0054、ADR-0056、ADR-0068、ADR-0069
关联：[Agent 发布资格化实施方案](../space/plans/2026-08-05-agent-release-qualification.md)

## 背景

ADR-0070 要求 `ephemeral_local` L3 scratch 在正常退出立即删除、在 crash-recovery 时不晚于
86,400 秒删除，并要求 Provider credential 不进入 workspace、project/session overlay、Tool、Skill、MCP、
Subagent 或 stdio child。当前 AQ-8 的安全停用实现故意没有把这些要求伪装成已满足：
`health.v1.json` 只是同一 local owner 可写目录中的有界 wire-shape/freshness record，现有
`scratchDeletionWitness` 是 reservation 时的 retention-policy 声明，parent 自己创建/删除 scratch，且 child
与 checkout 使用同一 OS principal。

因此，仅将 `liveScratchSupervisorActivationIsImplementedV1()` 改为 `true`、扩大 health record，或让一个
同 UID detached Bun child 清理目录，均不能证明 service identity、worker reaping、实际删除、离线期限或
workspace/session 的 OS 级不可读性。这些方式必须保持拒绝。

本 ADR 只讨论 AQ-8/AQ-9B 的 diagnostic control plane。它不修改 ADR-0068/ADR-0069 的历史结论，不接入
`ReleaseEvidenceV1`、release bundle、release Gate、G0/G1 或 production content admission；也不授权真实 L3
调用或 secret CI dispatch。

## 决策

### 1. 仅受保护的 Linux control plane 才能成为 future activation 候选

首个可能启用的实现目标限定为 Linux，且必须同时具备：

1. root-owned `systemd` system service、root-owned unit/install manifest、daemon/worker immutable bundle 和
   native cleanup/reaping helper；所有对象必须是单 link、不可 group/world write，并由 checked manifest digest
   精确绑定。
2. scratch 只能由该服务创建在已验证的 `/run` tmpfs 子树。mount type、owner、mode、link、inode 与 mount
   identity 任一无法验证即零网络 `blocked`。tmpfs 的 reboot 消失性质避免把“机器离线超过一天后才开机清理”误写成
   已满足 86,400 秒保留上限。
3. daemon 用 manifest 中固定的 service identity/private key 对 client nonce 产生短时 attestation；client 同时
   校验 root-protected manifest、nonce、service epoch、worker/daemon/protocol/policy/fixture/runner binding digest
   与允许的 maintainer UID。user-writable health 文件、caller-provided socket/root/path、布尔 flag、任意 ref/SHA
   或可重放 token 都不能 activation。
4. macOS 与 Windows 在拥有各自的 root-protected service、RAM-backed scratch、native process containment 和
   隔离 probe 之前均为 `unsupported`/zero-network `blocked`。不得把 `/private/tmp` health shape、`launchd` user
   agent、detached child 或 `taskkill` 视为等价替代。
5. repository、CLI 与 package scripts 不得使用 `sudo`，也不得自动安装、启动、reload 或卸载该服务。实际 host
   installation、key rotation、service start/stop 与 future secret CI dispatch 均是独立、显式的 operator action；
   untrusted checkout、PR、workflow input 或 CI 不得选择、安装或更新任何 service object。

此限定是安全前置，不是对 Linux/macOS/Windows 产品支持的声明；AQ-7 的 platform support 语义保持不变。

### 2. 服务是 scratch 与 worker 生命周期的唯一权威

future service 必须是 scratch 的唯一 allocator、worker 的实际父进程、process containment/reaping 的唯一权威、
最终 scrub 的唯一执行者和 deletion proof 的唯一签发者。public runner、fixture、workspace、session、CLI input、
environment 与 ledger 都不能指定 socket、state root、command、entrypoint、fixture bytes、route、policy 或 cleanup
target。

持久 journal 采用严格 exact-key、append-only/hash-chain 与每一状态转换后的 fsync。其状态单向为：

```text
intent → allocated → worker_contained → credential_window_open
       → dispatch_known | dispatch_unknown → process_reaped
       → root_deleted → deletion_proof_finalized
       → quota_reconciled_or_expired
```

journal 只保留 safe IDs、canonical digests、受限计数、时间、service epoch、lease fingerprint、前一 record digest 和
匿名 scratch handle/inode digest；不得保存 absolute path、UID/PID、credential、endpoint、prompt、response、reasoning、
source/workspace/session 内容、command 或 child output。active root 由编译固定的 `/run` parent directory fd 加
allocation ID 用 `openat`/`unlinkat` 派生，record 永不保存 path；root helper 也不得接受可替换的 delete target。raw
single-use capability 只在内存存在，journal 仅保留其 domain-separated hash。service 重启首先重放所有 nonterminal
record、以 containment identity 而非裸 PID 终止/确认 worker、scrub root、fsync recovery record；在完成或记录所有
遗留 incident 前不得签发新 lease。

active lifecycle journal 位于 root-owned tmpfs control root，遵循 `ephemeral_local` 的 process-exit/86,400-second
删除目标，terminal 后立即移除。**在创建任何 `/run` root 之前**，service 还必须向 root-owned persistent recovery
index 写入并 fsync 无路径 `allocation_commitment`：只含 allocation ID、safe policy/runner/service digest、lease
fingerprint、boot/mount identity、allocated timestamp、anonymous scratch handle digest 与 chain predecessor。该 index
是 ADR-0071 的 metadata-only operational recovery state，不是 `EvidenceGovernanceProfileV1` evidence、retained artifact
或额外 release input；它不能收集任何超出 ADR-0070 `ephemeral_local` allowed metadata 的字段，不能向用户/CI/Issue
直接外发，且必须 root-only、单 link、no-follow、local disk encryption、append-only audit，最长保留 7,776,000 秒后由
root janitor 删除。index 不可读、不可删、无法 fsync、顺序/boot/mount identity 不可证明时 service degraded/fail-closed。

root-private recovery index 不替代 ADR-0070 的 profile ACL。完成删除后，service 只能把签名且经 schema scrub 的
`LiveScratchLifecycleReceiptV1` 投影给既有 `local_owner_only` diagnostic governance ledger；该 projection 使用
ADR-0070 固定的 `local_owner_disk_encryption` / `local_metadata_audit` storage vocabulary、90-day ledger-audit retention
和其 existing authorizer/Issue default-deny rules。root index 的 terminal receipt/incident 永远不是 evidence witness；
只有这个 exact owner-only projection 才能被 future reconciliation/verifier 读取。audit retention 到期后 root janitor
必须删除 root-private record；不能证明删除时，service degraded/fail-closed。

若 allocation deadline、clock/boot continuity、journal order/integrity、worker absence、inode identity 或 deletion
无法证明，service 必须持久化 degraded incident、拒绝所有新 L3 lease。`/run` 在 reboot 后消失本身不是 deletion
receipt：service 必须从 pre-allocation fsynced recovery commitment 重建 boot ID、mount identity、last trusted clock 和
conservative reboot/deletion timestamp；只有能证明 tmpfs destruction/deletion 不晚于 `allocatedAt + 86,400 seconds`
才可将 recovery receipt 投影到 owner-only ledger。否则它是 retention breach，full-charge/expired，且不得被“下一次
启动已删除”改写为 success/cancelled。

### 3. 实际 deletion proof 是 observation/reconciliation 的必需输入

新增的 `LiveScratchLifecycleReceiptV1`（具体 schema 需在实现 Task 内冻结）必须固定为 diagnostic metadata-only record，
并绑定：governance profile/policy/route/runner/worker/service identity digest、reservation ID、service epoch、opaque lease
fingerprint、journal chain predecessor、anonymous scratch handle digest、allocated/deleted timestamp、deletion trigger 和
proof digest。它不能替代 `EvidenceRetentionWitnessV1`：后者继续只表示 retention policy。

normal-exit receipt 只允许在 worker exit、process containment absence、safe deletion 与 journal fsync 后产生。crash
recovery receipt 还必须证明 `deletedAt <= allocatedAt + 86,400 seconds`。缺 proof、过期、replay、错 reservation/policy/
runner/service epoch binding、早于 deletion 或 deadline breach 时，quota 必须 full-charge/expired，report 为
`blocked/not_observed`，不得构建 observation、AQ-9B semantic receipt 或任何 aggregate evidence。

### 4. 特权 IPC、credential window 与真实文件隔离

client 只连接 compiled-in、root-owned fixed Unix-domain control socket；service 必须在 server side 以
`SO_PEERCRED`（或等效 kernel peer credential）校验 allowlisted maintainer UID，并独立重验 root-owned manifest、unit、
daemon/worker/helper bundle、public key、service epoch、fixed route/fixture/policy/runner digest 与 cgroup/lease binding。
client 传入的 socket、pathname、FD、command、ref/SHA、fixture、route/policy 或 identity 一律无效；client-side validation
只能是额外防线，不是服务授权根。root-only installation/update/uninstall tool 必须在每次操作验证 checked manifest 与
bundle digests，并提供 attestation key 的 rotation/revocation；任何 key、manifest 或 bundle drift 使 service fail closed。

service 创建唯一的 one-shot Unix `socketpair`/equivalent credential channel，并把两个端点分别以 kernel-controlled fd
handoff 绑定给 attested lease/worker/service epoch；不得接受 caller-created socket/FD。service 不读取该 channel 的
payload，source parent 也永不接收 raw worker output：worker 只能将固定 schema、metadata-only terminal frame 交回 service
relay。lease/worker/epoch mismatch、replay、父进程断连、unknown dispatch 或 channel error 都关闭 credential window、reap
worker 并得到 full-charge `blocked`。

service、journal 与 cleanup helper 永不接触 Provider credential。只有在 fixed worker 已由受保护 service containment
登记且 journal fsync 后，source-owned parent resolver/model boundary 才能经一次私有 channel 发送 credential；它不得出现在
argv、environment、file、socket audit payload、stdout/stderr、error、artifact、telemetry 或 report 中。

worker 必须来自 immutable sealed runtime snapshot/bundle，而非直接从 checkout 执行。macOS future implementation 需要最小
Seatbelt profile；Linux implementation 需要等价的 mount/process/network boundary（例如 reviewed bubblewrap/native helper）：
只允许 immutable runtime deps、read-only sealed synthetic fixture、专属 scratch 和 fixed diagnostic provider egress。它必须
拒绝 workspace、project overlay、session overlay、ordinary HOME/config、ledger/control root 与任意其他 absolute path 的读写。
若任一 native isolation proof 不可用，平台保持 zero-network `blocked`。

### 5. CI 与 release 的边界不变

本 ADR 不创建带 secret 的 CI workflow。任何 future diagnostic secret job 都必须另有受保护-ref execution record，且仅能在
固定 `refs/heads/main` 的 reviewed `push` job 中运行；禁止 `pull_request_target`、fork、tag、arbitrary SHA/ref、
workflow input checkout、untrusted fixture/candidate executable 与自动 Issue/PR/artifact externalization。既有 G1
DeepSeek/Qwen `qwen3.6-flash` smoke 不受影响。

## 备选方案

1. **把现有 health JSON 或 checked-in boolean 升格为 activation。** 拒绝：同一 owner 可伪造的 wire record 不能证明
   service identity、worker containment、deletion 或 retention deadline。
2. **使用 local-owner detached Bun daemon 与 `/var/tmp`/`/private/tmp`。** 拒绝：它无法在恶意同 UID、host offline、
   PID reuse、parent crash cutpoint 与 workspace absolute-path read 下提供本 ADR 所需证明。
3. **让 public runner 自己 `mkdtemp`/`rmSync`，随后把结果写入 ledger。** 拒绝：在 allocation、PID registration、
   credential dispatch 与 cleanup 之间存在不可审计竞态，预留 policy witness 也不能追溯为实际删除。
4. **允许未 sandbox 的 fixed child 只靠临时 HOME/cwd。** 拒绝：同 UID child 仍可用 absolute path 读取 workspace、
   project/session overlay 或普通 config。
5. **将 L3 接入现有 G0/G1 或先复用其 G1 smoke。** 拒绝：违反 ADR-0068/0069 与 ADR-0070 的 diagnostic-only boundary。

## 后果

- 在受保护 Linux service、native containment、sealed runtime snapshot、actual deletion proof、negative tests 与独立
  AQ-8 review 全部完成前，当前 AQ-8/AQ-9B activation 必须保持 `false`；public wrapper 继续在读取 credential/resolver/
  reservation/scratch/child 前 zero-network `blocked`。
- 一个满足本 ADR 的实现需要受保护系统文件、native helper、Linux host probe 和部署权限；它不能由当前 macOS worktree 的
  TypeScript-only contract 静默替代。接受本 ADR 只批准架构边界，不安装、启动或调用服务。
- 它仍仅可生成独立 `authority='diagnostic'` / `evidenceEligible=false` 的 observation，不能成为发布结论。

## 回滚

撤销或停止受保护 supervisor service、删除其 approved diagnostic route/deployment manifest，或将 capability activation
保持为 `false`。任何回滚都必须先由 service reaping/scrub active roots 并写 metadata-only incident/receipt；不得回退到
health JSON、caller cleanup、ordinary config loader、child credential inheritance 或 G0/G1 integration。
