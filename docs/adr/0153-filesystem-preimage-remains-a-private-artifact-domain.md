# ADR-0153：Filesystem preimage 保持独立 Private Artifact 领域

状态：accepted

日期：2026-08-30

决策者：用户批准的单 Service / 单 SQLite 实施，源码与现有 strict reader 复核

相关：ADR-0110、ADR-0111、ADR-0152、[`Private immutable Artifact storage`](../active/private-artifact-storage.md)。

## 背景

ADR-0152 将 Store checkpoint 的 `runtime_file_preimages` 与 Builtin filesystem mutation 的
`filesystem-preimages` 合并描述为同一表。实施时复核确认两者不是同一语义：前者按 Session、path、event position 保存 rewind/fork
checkpoint；后者在 mutation commit grant 之前保存 invocation-bound、content-addressed、path-free private evidence，并由
`FilesystemPreimageArtifactStore` 执行独立 schema、digest、size 与 owner reader。

把后者塞入 checkpoint 表会要求伪造 Session/path/event-position identity，或失去现有 private Artifact ref 与 reader 约束；把它塞入
`capability_artifacts` 又会混淆 result evidence 与 mutation preimage 的 retention、owner 和恢复规则。

## 决策

Store 9 增加专用 `filesystem_preimage_artifacts` 表。该表保存既有 path-free ref、invocation ID、operation digest、target identity
digest、artifact format version、canonical JSON、byte length 与 created time。

`runtime_file_preimages` 继续只保存 Runtime checkpoint/rewind 事实。两个表不互相 fallback、不 dual write，也不建立 generic Artifact
blob 表。Builtin reader/writer 通过 App 注入的 typed backend 使用新表；legacy filesystem root 只作为一次性离线迁移 source。

## 后果

- Store 9 exact inventory由19张表调整为20张表，named index仍为5个。
- 单 SQLite仍只有一个writer connection；新增的是领域表，不是第二数据库、第二root或第二authority。
- 迁移必须分别验证并复制 checkpoint preimage 与 private filesystem-preimage Artifact，不能以其中一类存在推断另一类已保存。
- ADR-0152中“filesystem preimage继续使用`runtime_file_preimages`，不复制第二份”的局部结论由本ADR替代；其余单Service、单SQLite与
  禁止generic blob的决策不变。

## 回滚

只可在Store 9尚未发布、且所有legacy source仍完整时删除目标表并丢弃exact target。发布后不得把private preimage正文降级到event、
snapshot、capability result或filesystem fallback。
