# Private immutable Artifact storage

状态：active

读取时机：修改 Model、Capability、Filesystem preimage、Sandbox preparation 或 Subagent private Artifact 的 ref、路径、schema、发布、读取、retention 或 GC 时。

验证：`bun test packages/builtin-runtime/test/isolated/private-immutable-artifacts.test.ts tests/integration/model-artifacts.test.ts tests/isolated/runtime/capability-artifacts.test.ts packages/builtin-runtime/test/persistence/filesystem-preimage-artifacts.test.ts apps/kite-service/test/subagent-artifacts.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0056、ADR-0109/0110/0114/0115、ADR-0127、ADR-0152、ADR-0153、`model-provider-boundary.md`。

## 当前存储模型

`packages/builtin-runtime/src/model/private-immutable-artifacts.ts` 是共享的私有、不可变、内容寻址原语。每个实例必须在App注入的durable
backend与filesystem root之间二选一；不能同时写两者或运行时fallback。当前single-Service production注入Store 9专用表且不fallback，
下面的root只保留给显式旧owner和Builtin owner-local测试：

```text
model-artifacts/{surfaces,responses,provider-options}/
capability-artifacts/results/
filesystem-preimages/preimages/
sandbox-preparations/plans/
subagent-tasks/{requests,tasks}/
subagent-continuations/continuations/
subagent-lifecycles/handles/
```

Store 9对应`model_artifacts`、`plan_artifacts`、`capability_artifacts`、`filesystem_preimage_artifacts`、
`sandbox_preparation_artifacts`、`subagent_task_artifacts`、`subagent_lifecycle_artifacts`与`subagent_continuation_artifacts`。
`filesystem_preimage_artifacts`是mutation ready-before-commit evidence；它与Session checkpoint用的`runtime_file_preimages`不是同一领域，
不得合表或相互fallback，见ADR-0153。

Host `ArtifactPort` 只提供 type-erased namespace registry；它不统一 ref/schema，不读取正文，也不把 Notification 或 Mailbox fact 当成 Artifact receipt。Builtin 是每种正文 schema 与交叉绑定的唯一 owner，App 只注入 access object。

## Ref 与完整性

Artifact ref 只包含 path-free `artifactId`、封闭 `kind`、`sha256:` integrity identifier 与 UTF-8 byte length。ID 和 integrity identifier 都从 domain-separated canonical bytes 的 SHA-256 得到；它们用于内容寻址、损坏检测和 identity mixup 检测，不是密码学 authenticity，也不抵御能够改写文件并重算 digest 的同用户 attacker。

Runtime 不创建或加载 `model-artifacts.key`、installation integrity key 或其他 Artifact secret。不存在 key loss 启动终态、wrong-key reader、替代 key 生成或无 Artifact dispatch fallback。真实 API credential/OAuth secret 不允许进入 Artifact ref 或正文。

所有 reader 都重新验证 exact ref shape、kind、byte length、canonical JSON、domain schema 和 Runtime receipt/expected owner identity。missing、tamper、unknown field、cross-kind/cross-attempt/cross-child splice 或 digest drift 都 fail closed。Artifact 不能自证其 Runtime owner。

## Legacy文件系统边界

受管 root 必须是 owner-only、非 link、非 broad root 的 canonical directory。POSIX 目录/文件分别为 `0700`/`0600`；Windows 应用 owner-only、禁继承 ACL。root、partition 与操作期间的 ancestry 固定 dev/inode；symlink、hardlink、祖先替换、owner/permission 漂移或未知条目全部拒绝。

发布使用同目录 `O_EXCL` no-follow 临时文件、file fsync、atomic rename、严格回读与目录 fsync。同内容并发发布收敛到同一 ref；发布前失败没有可读取 Artifact，发布后目录 fsync 前失败留下完整内容但本次仍返回 typed failure。读取使用 no-follow descriptor 并在前后重验文件和目录 identity。

Store 9 backend不解析root/path或创建Artifact目录；它按领域调用同一writer connection上的typed table port，并在返回ref前用同一Builtin
reader重新readback canonical bytes。Plan的既有path字段在DB backend中只是`kite.sqlite#...`逻辑位置，不能交给filesystem API。

单个 Model/Capability Artifact 默认上限为 16 MiB。具体领域可以更严格，但不能扩大到无界 payload。

## Runtime 生命周期

- Model Gateway 在 Provider attempt 前持久化 Surface ref；成功 response 必须写入 Response ref。五种模型 purpose 共用同一 Gateway owner。
- Capability success/known failure 写入 result Artifact，并与 Tool terminal 在 Runtime transaction 中交叉绑定；publish uncertain 按 external dispatch certainty 收敛为 unknown。
- Filesystem mutation 在零写入 prepare 后保存完整 preimage，ready ack 成功后才可签发 commit grant。
- Sandbox allocating prepare 保存 exact plan/cleanup recovery payload，ready ack 前不得 spawn；restore 先严格回读并绑定外层 invocation facts。
- Subagent request/task/continuation/lifecycle handle 只以 private ref 进入 Runtime；正文、child message 与完整 continuation 不进入 Event、Session Logger 或遥测。

## Reachability 与 GC

GC 只接受 `complete=true` 的可达性 union，必须覆盖所有 retained Session 与 fork。扫描先完整验证 reachable ref、目录身份和 entry budget，再按稳定顺序删除超过 minimum retention 的 unreachable Artifact。缺失 reachable ref、未知条目、symlink/hardlink、身份漂移、scan limit 或不完整快照都会在任何删除前 fail closed。

Runtime restore/fork 对已完成 Model invocation 严格回读 Surface/Response；证据缺失或损坏保留已确认 transcript，但禁止 strict replay。pending attempt 按 durable attempt ack 收敛为 undispatched/unknown，不自动重放。
