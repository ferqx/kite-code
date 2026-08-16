# Private immutable Artifact storage

状态：active

读取时机：修改 `PrivateImmutableArtifactStorageV1`、`ModelArtifactStoreV1`、模型 evidence
Artifact 的路径、权限、完整性 key、并发发布、retention 或 GC 时。

验证：`bun test tests/private-immutable-artifacts.test.ts tests/model-artifacts.test.ts tests/model-surface.test.ts tests/runtime/capability-artifacts.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0056、ADR-0109、ADR-0110、`model-provider-boundary.md`、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`。

## 当前边界

MS-02 新增 `src/core/persistence/private-immutable-artifacts.ts` 作为私有、不可变、内容寻址
Artifact 的共享安全原语，并新增尚未接入 production dispatch 的 `ModelArtifactStoreV1`。Model store
使用独立的 `~/.kite-code/model-artifacts/` root 与三个内容 schema 分区：

```text
model-artifacts/
  surfaces/<opaqueArtifactId>.json
  responses/<opaqueArtifactId>.json
  provider-options/<opaqueArtifactId>.json
```

`ModelSurfaceV1`、`ModelResponseRecordV1` 与大尺寸 canonical Provider options 在写入和读取时都重新
验证严格 canonical JSON 与对应 schema。单个 Model Artifact 当前上限为 16 MiB。store 不接受或持久化
credential；Provider options 仍先经过 Model Surface canonicalizer 的 secret/endpoint exclusion。

现有 `CapabilityArtifactStore` 在 TP-03 前仍是 Capability receipt 的当前实现。Model 与 Capability
namespace、schema、访问策略和 retention 不得合并；TP-03 只能让 Capability store 复用同一个 private
immutable storage primitive，不能直接改用 Model 分区或 Model ref。

## 身份、key 与公开引用

共享原语内部使用 SHA-256 识别内容，但不会把 raw content digest 暴露到 ref、Runtime Event、Session
Logger 或遥测。调用方必须注入至少 32 bytes 的 canonical-private integrity key；原语不生成、不记录、
不回退加载该 key。key 缺失、长度不足或使用错误 key 读取既有 Artifact 都 fail closed。

`PrivateArtifactRefV1` 对外只包含：

- keyed opaque `artifactId`；
- 封闭 `kind`；
- 独立 domain 的 keyed `integrityIdentifier`；
- UTF-8 byte length。

ref 不包含绝对/相对路径或 raw content digest。相同 namespace、kind、key 和 canonical bytes 得到相同 ref；
不同正文不能复用既有 opaque identity。完整性校验失败不得修复、覆盖或降级读取 Artifact。

## 文件系统发布边界

受管 root 必须以 namespace 命名并位于一个 owner-only anchor 下。root、分区与操作期间捕获的 ancestry
都固定 dev/inode 与 canonical realpath；symlink/reparse point、祖先替换、非当前 OS owner 或非目录
节点全部拒绝。POSIX 目录固定 `0700`、文件固定 `0600`；Windows 对对应路径应用 owner-only、禁继承
ACL。已存在但权限更宽的 POSIX 目录不会被静默接管。

写入使用同目录 `O_EXCL`/no-follow temporary file，验证 regular file、`nlink=1` 与 owner，写入后执行
file fsync，再用 atomic rename 发布，重新读取并按 keyed identity 校验，最后 fsync 分区、root 与 anchor
目录。同内容并发发布者收敛为同一 ref；发布后、目录 fsync 前失败会留下可由同 key 幂等读取的完整
Artifact，调用方本次仍收到 typed failure。发布前失败不产生可读取 Artifact。读取始终固定 no-follow
descriptor 并在前后重验文件与目录 identity；symlink、hardlink、权限漂移、大小漂移和正文损坏都 fail
closed。

Artifact 正文永不进入 Session Logger。MS-02 没有新增 Runtime Event、State、Store row、Gateway、attempt
acknowledgement 或 replay catalog，也没有改变当前五类模型调用、Capability dispatch 或 Runtime format
epoch。

## Reachability 与 GC

GC 调用方必须提供 `complete=true` 的可达性快照，其 `reachable` 是所有 retained session 及其全部 fork
所引用 Model Artifact 的并集；重复 ref 表示共享不可变 Artifact，不会复制或提前删除。缺失/损坏的
reachable ref、错误 integrity key、不完整快照、未知目录条目、symlink/hardlink、身份漂移或超过 scan
entry budget 时，扫描在任何删除前 fail closed。

只有完整验证扫描完成后，GC 才按 `(mtime, path)` 稳定顺序删除早于调用方 minimum retention 的
unreachable Artifact。符合封闭命名的旧 temporary crash residue使用相同 retention；其他 residue
视为未知条目。默认 scan entry 上限为 10,000，调用方可以进一步收紧。每次 unlink 前重验文件和目录
identity，并在删除后 fsync 目录链。

MS-03 才会定义 Runtime invocation ref 的生产持久化和 restore 终态：completed invocation 的 Artifact
缺失/损坏将禁止 strict replay，pending invocation 将收敛为 interrupted/unknown。MS-02 的 GC API 不得
自行推断 Runtime reachability，也不能把 Artifact 存在或缺失直接解释为 Runtime 状态转换。
