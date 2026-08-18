# ADR-0122：Windows Workspace mutation 使用 handle-locked 发布

状态：accepted

日期：2026-08-18

## 背景

ADR-0113 正确拒绝了 Windows 上未经保护的 path-based rename；但它也使 Windows 的
`write_file` 与 `edit_file` 在所有 mutation 前 fail closed，和可用的 development sandbox
工作流不相容。

Windows 能够以目录 handle 的 sharing mode 阻止目录在持有期间被删除或重命名。这个 native
机制可在不引入 Windows 登录账户、UAC 或 path-based fallback 的情况下固定 publication parent。

## 决策

1. Windows Local Provider 在确认 preimage 后，以 `CreateFileW` 和
   `FILE_FLAG_OPEN_REPARSE_POINT` 打开 nearest-existing ancestor 及每个 parent；每个 handle
   排除 `FILE_SHARE_DELETE`，且只接受非 reparse directory。
2. 生命周期内创建唯一 temporary sibling、写入并 flush；最终以 `MoveFileExW` replacement
   发布。所有路径操作只发生在仍被这些 handle 锁定的目录内。
3. final identity check 仍在 publish 前执行。若 parent 在此前已变更则保持零写入；若 final check
   后有人尝试替换 parent，Windows sharing lock 拒绝该操作，直到 temporary publication 与 cleanup
   结束。
4. 此决定取代 ADR-0113 中 Windows 没有安全 mutation backend、必须一律 fail closed 的结论；Unix
   `openat`/`renameat` 路径和其余 ADR-0113 结论不变。

## 后果

- Windows 受治理的 Workspace 内 mutation 与已批准的 external mutation 可正常执行，并仍遵循 sealed
  grant、preimage、ready acknowledgement、single-use commit 与 typed failure。
- Windows 不以 POSIX mode bits 表示访问控制；temporary file 从受锁 parent 继承 Windows ACL，测试不把
  POSIX `chmod` 作为 Windows 拒绝写入的证据。
- Windows native conformance 必须覆盖 normal write/edit、MSYS2 path normalization，以及 final-check
  时 parent rename 被 handle lock 拒绝。
