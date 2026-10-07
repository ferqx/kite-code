# 不可变 Artifact leaf

公开 `@kite-ai/agent/artifacts` import 不打开资源。宿主显式选择 profile、Store 与读写范围；知道 hash 或文件路径不能取得引用授权。发布按照临时私有文件、完整 hash/size、必要同步、不覆盖的不可变文件发布、完整内容复核和 Store 登记的顺序进行。POSIX 保留原 hardlink 分支。失败可能留下孤立已发布字节，不能成功引用缺失内容。MIME 属于准确引用，同字节多 MIME 引用共享一个物理 Blob，原引用 metadata 不可更改。

`publishStream` 接受具 scope 的发布 metadata 和 Iterable/AsyncIterable<Uint8Array>；每次移交块在写入前复制为最多 64 KiB 的工作块。总大小使用 Decimal64，限制只来自 SQLite signed integer 表示资格与真实 IO，不设旧 16 MiB 或累计产物额度。source 异常、取消或非法 chunk 会清理临时文件且不登记引用。`publish(Uint8Array)` 是完整 bytes 的便利入口，会复制调用时数据，受真实内存能力影响。

`readStream` 先核准确 Store、Session、subject 和 scope，再 no-follow 打开只读不可变 Blob，逐块完整核 hash、size 和 FD 前后 identity。**只有成功 EOF 才证明完整内容**；提前停止、取消或末尾校验错误不能把已接收前缀称为全文。消费者必须完成迭代或调用 iterator.return，close 会排空真实在途操作后释放 profile 使用权。`read` 便利入口收集完整 bytes 并在成功完整校验后返回。

`readReference({expectedStoreId, reference})` 在同一个在途读取中实时查询准确 scope 的登记引用，逐项保持完整原 metadata（含出处、MIME、hash 和 size）的 canonical 相等，再沿同一完整文件验证返回 bytes；不缓存引用或授权。`expectedStoreId` 是当前连接准入，`reference.storeId` 是原引用出处，恢复后不能互换。中立 `ArtifactContentStore` 将这个入口设为可选：Runtime 使用它避免先查询、再由默认 `read` 重复查询同一引用；未提供该入口的自定义端口保留原 Runtime metadata 校验与 `read` 路径。包装读取的端口需要明确包装所提供的两个入口，不能把一个入口的阻塞或取消钩子当作另一个入口也已执行。Runtime 在读取前后仍核取消并复核完整 bytes 的 size/hash，发布、owner 守卫和每段持久检查点保持。

Store 登记使用 `verifyPublishedArtifact` 固定工作内存复核全文，不把整 Blob 分配到 Worker 事务中。Windows x64 使用下面的固定原生实现；其他 Windows architecture 仍明确 unsupported。本机 macOS 证据不代表 Windows/Linux、独立安装或跨平台发行资格。

Windows [内部媒体 leaf](../platform/windows-artifact-files.ts)仅在实际调用时加载固定 System DLL，读取当前 token SID，不接受 caller HANDLE、SID、ACL 或 DLL。Profile/blob 目录仍用原 [Windows 私有路径政策](../platform/windows-path-security.README.md)，未改变 Profile/config 的 FA DACL。实际流写入使用原子 CREATE_NEW 私有 temporary 和原 HANDLE，每块最多 64 KiB，保 signed-64 总字节计数。只有这个新建 temporary 可通过 SetSecurityInfo 减权为 protected currentSID-only FILE_GENERIC_READ；已有对象 ACL 不修复。owner 主动改 ACL 与 POSIX owner 主动 chmod 类似，不属于防御同一 owner 的独立安全边界。

这项独立 FR 政策、不覆盖发布和 SQL 失败保 orphan 的原因见[媒体发布提案](../../../../.agents/notes/proposed/architecture/2026-10-04-windows-artifact-handle-publication.md)。原生 Windows 资格尚未完成，提案状态不把本机 POSIX 证据扩大到 Windows。

publication 保留 Profile、blobs、hash-prefix 的目录 HANDLE 并禁止 DELETE sharing，原目标身份在调用前后核验。`FileRenameInfo` 以保留的 hash-prefix HANDLE 和相对 hash 名发布，`ReplaceIfExists=false`，不使用路径式源 rename、跨卷复制或覆盖。只有 FILE_EXISTS/ALREADY_EXISTS 冲突走既有 blob 的完整 EOF/hash 核验，其他失败不当作幂等成功。正常最终文件必须 regular、非 reparse、nlink1、currentSID owner 和精确只读 DACL；读前后还核原 HANDLE/当前路径 volume/file identity、change time、完整 size/hash。reader 允许原可信 publisher 的旧 WRITE/DELETE HANDLE 完成 flush，新写打开仍被只读 DACL拒绝；读取时变更依靠完整 EOF与最终 identity/hash 复核拒绝。提前 return 或失败也关闭文件和全部保留目录 HANDLE。

temporary 在 rename 前后通过原 writer HANDLE FlushFileBuffers，关闭 writer 后才完整复核并登记 SQL reference。未发布 temporary 的清理由原先获得 DELETE 权限的 HANDLE执行 FileDispositionInfo，FR减权后也不修 ACL；已发布文件在后续失败中仅留下 orphan，不删除。正常 API 返回与进程强杀窗口不等于断电证明：微软的 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)契约只明确指定文件的缓冲写出；本实现未证明 Windows power-loss 下的 directory durability，也不声称 SQLite/文件系统原子事务。no-overwrite/目录 HANDLE 语义依据 [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)和 [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)，不是将 MoveFileEx 旗标冒充 POSIX directory fsync。

[Windows 专项](../../test/isolated/artifacts/windows.test.ts)在 actual win32 必须执行原生正文/取消/close drain、SQL失败 orphan、错误 hash、hardlink/宽 ACL/junction和进程强杀；没有 backend availability skip。源码树外编译公共 Store/Artifact 两进程同 hash与冷只读在本机也运行，Node/POSIX import 验证不加载 DLL。Windows 原生场景未在本机运行，不能把本机非 Windows skip 当资格；实际 Windows CI结果仍须独立提供。强杀第二窗口准确是内部 native publication 后、SQL reference 提交前，不冒充已成功的公共发布。

验证位于 [scope/发布回归](../../test/isolated/artifacts/artifacts.test.ts)、[大流式正文](../../test/isolated/artifacts/stream.test.ts)及[真实 Core Files 大正文](../../test/isolated/files/large.test.ts)。流式 Artifact、完整文件产物与模型实际正文输入是不同事实；[Runtime 正文交接](../model-body/README.md)用准确原 scope 验证和实际 Model 回执分别证明后者，引用自身不代替全文。

恢复后的 `expectedStoreId` 只校验当前连接准入；返回引用的 `storeId` 保留真实 `blob_ref.origin_store_id`。执行 scope 另核引用出处与原 Execution/Command 一致，Session、subject、准确 scope 校验不变。旧引用不能在新 Store 重新登记或重绑定；发布、执行和 owner 资格仍要求当前 Store。实际恢复读、新 Run 展开与跨出处拒绝见[恢复正文回归](../../test/isolated/restored-media/read.test.ts)。
