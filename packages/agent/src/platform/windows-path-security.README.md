# Default Windows private paths

The Bun host selects a lazy, fixed native Windows x64 policy. Importing this leaf in Node or POSIX does not load a DLL or inspect a token. Windows uses kernel32 and the actual SystemDirectory advapi32, the current process token SID, and handle-based owner/DACL inspection. There is no configuration, Model, HTTP, arbitrary descriptor or SID input.

New managed directories and coordination files are created with an owner-only protected descriptor. Directory inheritance gives SQLite-created WAL/SHM and configuration temporary files their private initial ACL. Existing objects are verified, never repaired into apparent safety. Verification rejects reparse paths, hardlinked files, foreign owners, null DACLs, additional ACEs, and unexpected rights. A live lock compares the original handle's volume/file identity to the current path and checks both ACLs. Concurrent creation may adopt only an already-existing object that passes the same verification.

Public Profile and configuration leaves choose this backend by default. Trusted explicit injection remains possible, but the fixed native Worker/lock checks still apply. SQLite validates profile/database/WAL/SHM and profile metadata before opening and after initialization. Private Profile and coordination directories still require the fixed current-user DACL.

Host-selected Workspace declarations use a separate scope path policy. `verifyScopeDirectory` checks non-reparse directory identity without demanding a private DACL. `readScopeFile` performs bounded reads using the actual native handle, checks regular/nlink1 and current path identity before and after the read, and can additionally require the private ACL. It does not reinterpret Workspace content as trusted authorization. `writePrivateFile` uses CREATE_NEW with the private descriptor and writes/flushes/verifies the same native handle; it never repairs an existing ACL.

General configuration options expose the trusted host-only `windowsPathPolicy: 'scope' | 'private'`, defaulting to scope to match the existing POSIX declaration contract. A host reading private Profile configuration must choose private explicitly. MCP distinguishes its actual Profile/user/approval/auth paths from the Workspace raw declaration itself; metadata stays private. Workspace sibling locks, publication temporaries and repair backups remain private even in an ordinary inherited-ACL Workspace. No Workspace directory ACL is modified.

Neither handle verification nor the final byte check and rename forms an atomic compare-and-swap against non-cooperating editors. Path changes observed during a native read or at the final publication recheck fail locally; an editor racing after the last check can still conflict with publication. Filesystem and SQLite notification remain separate media; publication uncertainty must retain the original operation identity rather than automatically retrying.

## 维护原文件与发布端口

`retainPrivateFile` 返回不暴露 HANDLE 的 verify/close 能力：原文件持有 GENERIC_READ，允许 read sharing、拒绝 write/delete sharing；整条祖先链保留原 identity 并拒绝 delete sharing。普通文件仍核 current SID/FA；`retainReadOnlyFile` 单独要求 protected、无继承 flag 的精确 FR，供不可变 blob 使用，不放宽配置或协调锁政策。关闭失败仅移除成功关闭的 HANDLE，剩余对象可重试；verify 拒绝已关闭的原文件或身份/ACL/时间变化。[维护 FD 与 SQL owner](../maintenance/README.md#windows-维护文件端口与验收边界)负责将 pin 保留至实际读者关闭。

`syncPrivateFile` 使用实际 GENERIC_WRITE、write-through 文件 HANDLE 与 FlushFileBuffers，既有对象只验证、不改 ACL。`movePrivateEntry` 保留 source/target 父祖先，原 source HANDLE 允许本次 rename；MoveFileExW 使用 WRITE_THROUGH，拒绝跨卷复制和延迟重启，成功路径重核 published FileID 是原 source。它不构成对同 owner 不合作编辑器的原子 CAS，也不授予目录 fsync 或断电持久性证明。平台依据为 [CreateFileW sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FlushFileBuffers access](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)与 [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)。

Windows 测试在 actual win32 没有 availability skip；macOS 结果只证明 Node/Bun 惰性 import 和 POSIX 邻接。Windows ARM64、原生维护验收、Node inherited locks/artifacts、完整安装与 Native 加载前身份仍未取得资格。Bun FFI 是实验接口；必须绑定实际运行时与原生 Windows 结果，类型或构建成功不能代替 OS 证据。
