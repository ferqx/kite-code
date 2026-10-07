# Agent Note: Windows Artifact 发布使用独立的只读 HANDLE 政策

Status: proposed

## Problem

不可变 Artifact 既要完整流式读取和同 hash 幂等发布，又要阻止既有对象被修复、覆盖或替换。Windows 的 POSIX mode 位不能证明只读权限；现有 Profile 私有 FA 政策允许写入，直接用于最终 blob 会与不可变读取冲突。路径 rename 和目录同步也不能被未经验证地当作 POSIX hardlink/fsync。

## Proposal

保持公共 Artifact/Store API 与原 Profile/config FA 政策，新增 lazy Windows x64 内部媒体 leaf。当前 token SID、固定系统 DLL、原文件和保留目录 HANDLE 决定身份，调用者不能提供 HANDLE/SID/DACL。新建 temporary 使用 protected currentSID-only FA，逐块最多64KiB计数；只有这个新对象在发布前减权为精确 protected FR，已有对象一律核验而不修 ACL。

以保留的 hash-prefix 目录 HANDLE 和相对 hash 执行 no-overwrite FileRenameInfo。只有明确 FILE_EXISTS/ALREADY_EXISTS 冲突能在完整 EOF/hash 验证后复用。原 writer flush/close 后再次全量核内容，才登记 SQL reference；SQL失败保 orphan。未发布 temporary 通过原 DELETE HANDLE清理，不恢复权限、不删除已发布对象。

reader 完成 EOF 时核完整 size/hash、原 HANDLE/路径 volume-file identity、change time、nlink1、regular/non-reparse 与精确 owner/DACL。提前 return、取消和异常也关闭文件及保留目录；close 排空真实在途 I/O。已取得的可信 publisher WRITE HANDLE可以完成 flush；该机制不防御同 owner 主动改ACL，范围与 POSIX owner主动chmod相当。

六路径当前代码已实现，POSIX/source-free公共Store与Artifact邻接18项241断言、独立2项17断言通过。实际原生Windows场景未运行，因此保留proposed，不能由类型/构建或非Windows skip标implemented。现行合同与精确验证入口见[Artifact owner](../../../../packages/agent/src/artifacts/README.md)，Profile/Workspace角色分离见[相关提案](2026-10-04-windows-private-and-workspace-scope-paths.md)。

## Alternatives considered

- 去掉 Windows guard 后复用 POSIX chmod/hardlink：不能核实际只读 DACL、原生 HANDLE和目录身份，未采用。
- 放宽原私有 FA verifier 接受任意“只读”对象：会改变 Profile/config安全政策并接受不明确的权限组合；最终 blob使用独立精确 FR政策。
- 将既有 blob的ACL修复为当前 SID：会改变原不安全对象、掩盖内容与路径替换；只核验、拒绝且不修复。
- 用路径 MoveFileEx 或跨卷复制替代不覆盖发布：源/目录 identity不由原HANDLE保持，不能保证实际 no-overwrite范围；使用相对FileRenameInfo。
- 把 SQL失败清理为删除最终 blob：可能删除已被其他真实发布者或引用采用的同hash内容；只清未发布 temporary，发布后保orphan。

## Acceptance criteria

actual Windows x64必须执行原生完整正文、取消和close drain、真实SQL失败orphan、错误hash/size、hardlink/宽ACL/junction以及publication前和内部native publication后/SQL前SIGKILL，无backend availability skip。Node/POSIX import必须无DLL/token I/O，源码外两进程同hash复用与cold读保持原metadata。默认paired Service的原大正文须经sealer与公开typed Model reader核完整EOF/hash及原S/W/Run，冷读不能增加Provider或登记。

## Risks

Bun FFI和Windows x64 ABI仍待actual CI。FlushFileBuffers原文件回执与进程强杀不证明断电后的directory durability；本方案不声称SQLite与文件系统原子事务。ARM64尚unsupported，且该媒体政策不能被套用于普通Workspace或安装candidate根目录。原生HANDLE、读共享、碰撞错误码和所有失败关闭路径必须由实际平台证据核对。

Windows维护文件端口现已接入原API与开发CLI，完整角色、原HANDLE/FD/SQL生命周期、发布屏障与未验范围见[维护提案](2026-10-07-windows-maintenance-file-publication.md)。本篇其余角色与安全理由保持，实际原生资格仍未取得。
