# Default Windows private paths

Owner/DACL 查询由[固定 reader](windows-security-descriptor.ts)对原 HANDLE 调用系统 `GetKernelObjectSecurity`，逐项保留原 SID、protected/present DACL、ACE 与全部有效 grant 检查，不修既有 ACL。`writePrivateArtifactFiles`/`copyPrivateArtifactFiles` 在一次有限库存内共享原父目录持有，叶子仍 CREATE_NEW、protected SID DACL、准确短读写、每文件 Flush、原身份/ACL 复核和严格关闭；source 原只读 pin 在复制结束前保持。关闭未知保原 source/target owner，不按路径递归清理未知对象。完整合同及反例归 [platform owner](README.md)与[闭包成本决定](../../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。

The Bun host selects a lazy, fixed native Windows x64 policy. Importing this leaf in Node or POSIX does not load a DLL or inspect a token. Windows uses kernel32 and the actual SystemDirectory advapi32, the current process token SID, and handle-based owner/DACL inspection. There is no configuration, Model, HTTP, arbitrary descriptor or SID input.

`TOKEN_USER` 的 SID 指向原返回缓冲区内部；原生调用前即分配显式 ArrayBuffer backing，避免当前 Bun 小 TypedArray 首次读取 `.buffer` 时移动存储而使指针失效。私有路径、媒体、候选scope与daemon security同样保持这一要求，并保留原缓冲区到全部SID比较结束；不靠放宽owner／DACL检查或修复既有ACL解决失败。

使用期原祖先HANDLE现在显式请求FILE_TRAVERSE，使no-delete sharing真实生效；仅属性探针不充当持有期保护。实际文件读取、CREATE_NEW、短写/Flush、发布身份及关闭未知保原owner的合同保持，依据及真实改写/重命名反例归[原对象决定](../../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

2026-10-14 Windows本机已实际通过原private Profile／Worker／WAL／config／cold logs和unsafe ACL拒绝两项，但完整原文件仍有媒体发布错误87及普通Workspace配置写入失败；这里的scope支持仍是应满足的合同，不能据源码接口当作本机已通过。原命令、有限通过和剩余缺口见[本机证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-14windows-本机首次实际验证)。后文旧“未运行”描述对应原轮次，完整维护／发行资格继续未取得。

New managed directories and coordination files are created with an owner-only protected descriptor. Directory inheritance gives SQLite-created WAL/SHM and configuration temporary files their private initial ACL. Existing objects are verified, never repaired into apparent safety. Verification rejects reparse paths, hardlinked files, foreign owners, null DACLs, additional ACEs, and unexpected rights. A live lock compares the original handle's volume/file identity to the current path and checks both ACLs. Concurrent creation may adopt only an already-existing object that passes the same verification.

上述 Bun 普通准入保持拒绝且不修既有 ACL。Windows Desktop 另有[用户明确选择的权限维护](../../../../apps/desktop/README.md#windows-数据权限预检与恢复)：仅原 current SID 私有对象的额外只读授权可在私有备份、原对象／快照复核和数据根排他 pin 后定点移除，不递归、不接 arbitrary descriptor，不修可写暴露。维护成功仍须重新通过这里的原私有政策；不能以 ACL 修复证明曾暴露给写入者的数据完整。

Public Profile and configuration leaves choose this backend by default. Trusted explicit injection remains possible, but the fixed native Worker/lock checks still apply. SQLite validates profile/database/WAL/SHM and profile metadata before opening and after initialization. Private Profile and coordination directories still require the fixed current-user DACL.

Host-selected Workspace declarations use a separate scope path policy. `verifyScopeDirectory` checks non-reparse directory identity without demanding a private DACL. `readScopeFile` performs bounded reads using the actual native handle, checks regular/nlink1 and current path identity before and after the read, and can additionally require the private ACL. It does not reinterpret Workspace content as trusted authorization. `writePrivateFile` uses CREATE_NEW with the private descriptor and writes/flushes/verifies the same native handle; it never repairs an existing ACL.

General configuration options expose the trusted host-only `windowsPathPolicy: 'scope' | 'private'`, defaulting to scope to match the existing POSIX declaration contract. A host reading private Profile configuration must choose private explicitly. MCP distinguishes its actual Profile/user/approval/auth paths from the Workspace raw declaration itself; metadata stays private. Workspace sibling locks, publication temporaries and repair backups remain private even in an ordinary inherited-ACL Workspace. No Workspace directory ACL is modified.

Neither handle verification nor the final byte check and rename forms an atomic compare-and-swap against non-cooperating editors. Path changes observed during a native read or at the final publication recheck fail locally; an editor racing after the last check can still conflict with publication. Filesystem and SQLite notification remain separate media; publication uncertainty must retain the original operation identity rather than automatically retrying.

## TUI 私有记录端口

`retainPrivateRecordFile(path,maxBytes)` 为可信 TUI host 提供 1—16 MiB 的原文件 pin／单次完整读取；`writePrivateRecordFile(path,bytes)` 仅新建最多 16 MiB 的私有记录。原 scope/config `readScopeFile`／`writePrivateFile` 的 8 MiB 和明确 artifact 的 1 GiB 合同保持，不能用扩大通用配置上限来容纳原 journal。CLI 仍拥有九份闭合文件名、codec、etag 和原容量，其中 recovery 读取仍限 262144 字节。

读取用原只读 HANDLE 拒绝 write/delete sharing，祖先拒绝 delete sharing；完整 EOF、原 size、FileID／时间／nlink1／reparse／current-SID FA 及路径映射均复核。新写入采用 CREATE_NEW、private descriptor、有限块及短写循环、Flush 与严格 Close；既有 ACL 不修复。成功才返回撤销能力，撤销以本次已创建原对象的 DELETE HANDLE、祖先、原 FileID／stamp 和 disposition 删除并确认关闭／缺失。CREATE_NEW 失败不能撤销别人已存在的 temporary；写失败在未取得完整创建证据时可能留下私有未发布文件，不猜所有权清理。

[CLI host](../../../../apps/cli/host/windows-tui-private-files.ts)在原短锁下核完整 temporary、同步 owner recheck、原字节 CAS、`movePrivateEntry` 和发布读回。可能打开探针的准入复核前，Profile facade 已把操作挂到原 SH／EX；严格 Close 未确认保原 region 与首次错误，不能让 finally 把未知当已交接。已确认未发布时才调用原撤销能力，无按路径删除兜底。该发布仍非不合作编辑器的原子 CAS，不提供目录 fsync／断电证明。

[完整私有记录测试](../../../../apps/cli/test/isolated/windows-tui-private-files.test.ts)包含九份冷读、9 MiB 全文／CAS、原 recovery／config 上限及 hardlink／rebound 拒绝；只在 actual Windows 执行原生分支，无 backend availability skip。macOS 的非平台与验证期 Close mock 只证明对应控制流；Windows/Linux 实际资格留后续 Actions。

## 维护原文件与发布端口

`retainPrivateFile` 返回不暴露 HANDLE 的 verify/close 能力：原文件持有 GENERIC_READ，允许 read sharing、拒绝 write/delete sharing；整条祖先链保留原 identity 并拒绝 delete sharing。普通文件仍核 current SID/FA；`retainReadOnlyFile` 单独要求 protected、无继承 flag 的精确 FR，供不可变 blob 使用，不放宽配置或协调锁政策。关闭失败仅移除成功关闭的 HANDLE，剩余对象可重试；verify 拒绝已关闭的原文件或身份/ACL/时间变化。[维护 FD 与 SQL owner](../maintenance/README.md#windows-维护文件端口与验收边界)负责将 pin 保留至实际读者关闭。

`syncPrivateFile` 使用实际 GENERIC_WRITE、write-through 文件 HANDLE 与 FlushFileBuffers，既有对象只验证、不改 ACL。`movePrivateEntry` 保留 source/target 父祖先，原 source HANDLE 允许本次 rename；MoveFileExW 使用 WRITE_THROUGH，拒绝跨卷复制和延迟重启，成功路径重核 published FileID 是原 source。它不构成对同 owner 不合作编辑器的原子 CAS，也不授予目录 fsync 或断电持久性证明。平台依据为 [CreateFileW sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FlushFileBuffers access](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)与 [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)。

Windows 测试在 actual win32 没有 availability skip；macOS 结果只证明 Node/Bun 惰性 import 和 POSIX 邻接。Windows ARM64、原生维护验收、Node inherited locks/artifacts、完整安装与 Native 加载前身份仍未取得资格。Bun FFI 是实验接口；必须绑定实际运行时与原生 Windows 结果，类型或构建成功不能代替 OS 证据。
