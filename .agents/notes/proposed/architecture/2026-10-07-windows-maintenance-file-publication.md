# Agent Note: Windows 维护按原文件身份和实际发布屏障接入

Status: proposed

## Problem

完整备份、检查和新 Store 恢复要保持源 DB/WAL、被引用媒体、原配置与请求身份，以及 Profile 外稳定锁和明确 journal 决定。Windows 的 mode/目录 fsync 不能证明实际 DACL 或发布持久性；只去掉平台拒绝会将 POSIX 假设带进完整用户维护流程。已有 scope reader 的 8MiB 上限也不能承载既有16MiB caller 资产。

## Proposal

沿当前 maintenance/开发 CLI 原入口接入固定 Bun x64 private 文件端口。metadata 核 current SID/FA，blob 单独核 protected 精确 FR；源文件与祖先 pin 保留至 FD/readonly SQL 真正关闭，完整读取保持原资产限额与结构检查。SQLite 只打开本次 scratch 或候选，原 DB/WAL 的 presence、实体和全 bytes 仍独立核对。

metadata 的 GENERIC_WRITE HANDLE执行 FlushFileBuffers；ready/journal/Profile 使用 same-volume MoveFileExW WRITE_THROUGH，保原 source HANDLE 与父祖先至移动验证完成。媒体复用原独立 publisher，只有新 temporary 可减权，以 write-through 原 writer flush/相对 no-overwrite rename。Windows syncDirectory只核私有目录，不冒称 POSIX fsync 或断电资格。

外置 stable Profile-use EX、原 four-phase journal、新 Store fencing、保旧目录、原请求不改标/不自动重放和 profileComplete:false保持。本轮代码已接入，但实际 Windows ABI/DACL/sharing/CLI流程尚未运行，因此保留 proposed。当前完整合同归[maintenance owner](../../../../packages/agent/src/maintenance/README.md#windows-维护文件端口与验收边界)。本提案增加维护 port，不替代[private/scope角色](2026-10-04-windows-private-and-workspace-scope-paths.md)或[immutable媒体](2026-10-04-windows-artifact-handle-publication.md)的仍适用理由，不放行 Windows installed Native 加载前身份。

## Alternatives considered

Windows managed Terminal 的原生前门、外置安装协调及版本选择现另接入源码，见 [安装提案](2026-10-10-windows-managed-terminal-frontdoor.md)。安装源码不替代本篇维护/恢复合同、完整 GC 或原生验收，本篇继续 proposed。

- 去掉平台 guard 后继续用 chmod和目录 fsync：不能证明 Windows 权限和发布屏障；保实际 native文件角色和单独资格。
- 复用 bounded scope reader：会截断或拒绝合法8–16MiB caller元数据；使用原HANDLE pin与完整FD读取，维持现有业务上限。
- 放宽 private FA verifier接纳FR或为既有文件修ACL：会混淆metadata与不可变media，掩盖原不安全对象；FR独立且仅新媒体temporary可减权。
- 只在SQLite前检查然后关闭原文件：SQL连接期间没有原对象身份约束；Windows readonly connection保pin至严格关闭。

## Acceptance criteria

actual Windows x64必须在固定实际 Bun和selected engine上执行开发CLI backup/inspect/restore/status/reconcile及negative ACL/link/junction、busy、取消、源 DB/WAL/SHM状态和全字节保持、17MiB媒体与超过8MiB原caller正文。新Store保旧来源/原意图、fencing与冷读无重放，明确complete/rollback须匹配原ID/digest并核完整相应目录。原pin实际阻止写入、文件与祖先rename，close后可移动；FA/FR不混用、不修现有ACL。backend缺失不得availability skip。

POSIX原维护、源码外CLI、Native私有资产与冷Node导入需复验。Windows完整installer/标准PATH/Native bootstrap和SIGKILL全矩阵仍由实际入口独立完成；本维护源码、类型、macOS邻接及平台skip不能代替它们或整个V1.3。

## Risks

Bun FFI、Windows x64 ABI、sharing和SQLite VFS行为须实际执行；Windows ARM64不支持。最后path验证和路径move不是对同owner不合作编辑器的原子CAS，媒体/SQL/目录也不构成跨介质原子事务。write-through/flush和进程中断不证明断电后的全部目录持久性；未知发布保原journal，不能自动选择complete/rollback。独立审查尚受工具线程限额限制，主Agent自检不等同新Reviewer。
