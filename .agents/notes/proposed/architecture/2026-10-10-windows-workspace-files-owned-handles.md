# Agent Note: Windows Workspace Files 的原 HANDLE 后端

Status: proposed

## Problem

V1.3 的正式 CLI／TUI／Native 已从同一公开入口注册六个 Files 工具，检查点恢复也沿 `WorkspaceFiles` 读取、恢复和反向删除原字节。但原工厂只允许 Darwin／Linux，Windows 在真实文件能力创建时拒绝；历史结果可读、客户端按钮存在和 Windows 私有媒体发布均不能补齐普通文件操作。这个缺口独立于 Shell 的任意后代权限后端、RSS 和全 Runtime 观测。

## Proposal

本轮已接入源码：保留原 `WorkspaceFiles` 工具及恢复语义，以私有 `WorkspaceFileIo` 分派 POSIX 原 FD 和 Windows 原 HANDLE。Windows owner 持原根、祖先及逐段父链；`NtCreateFile.RootDirectory` 只使用此前取得的原 HANDLE。完整 volume／128-bit FileID、LastWriteTime／ChangeTime、EOF／hash／size 和 canonical 长名共同复核，不把数字 HANDLE 或名称缓存当控制权。

普通 Workspace 沿宿主已有 DACL，不修用户权限；新 temporary 使用当前 SID 私有权限，对应原 POSIX 0600。严格字节恢复另核父链／文件的当前 SID owner 和 nlink1，不把私有媒体的固定目录和 FR DACL 套到用户文件。现有[Windows 私有与公开 scope 提案](2026-10-04-windows-private-and-workspace-scope-paths.md)继续拥有 Profile／Store／配置政策，不由这个文件后端取代。

发布由完整临时字节、file flush、再次完整基线复核、原临时 HANDLE 向原父 HANDLE 的相对 rename 和实际 postimage 组成；删除用原对象 disposition、关闭和缺失确认。派发后的确认或关闭未知保原结果未知及原 owner，阻止正常资源释放。固定 System DLL 是惰性进程寿命 API，不为每次 Workspace 关闭而释放；无 caller DLL／SID／HANDLE 注入。

Windows directory sync 只复核原目录身份，file flush 不声明 POSIX directory fsync 或断电持久性。源码和本机 POSIX 通过不能完成 Windows syscall、正式客户端、安装制品或崩溃持久性资格。当前完整合同归 [Files owner](../../../../packages/agent/src/tools/files/README.md#windows-workspace-文件源码)，实施证据归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-普通-files-与检查点恢复源码)；原生验收未完成，本文保持 proposed。

## Alternatives considered

- 仅删平台拒绝、改成普通路径 open／rename：不能绑定原父对象，也会弱化 reparse、祖先替换和原对象删除边界，不采用。
- 直接复用 Windows 私有 Artifact／GC 工厂：它们有固定媒体布局和精确私有 ACL，不能作为普通用户 Workspace 的一般文件权限，不采用。
- 复制六工具、UTF-8、分页、Artifact、diff 和恢复业务形成独立 Windows 实现：产生第二套用户语义与来源检查；只分离实际 I/O，保原公共消费者。
- 等 Windows Shell 权限方向或 RSS／观测结果再实施：Files 是可信宿主对已选择 Workspace 的直接操作，没有这项依赖，不采用全局等待。
- 用 file flush 文本替代目录／断电资格：官方只明确指定文件 HANDLE 的缓冲写出，不采用等价声明；平台资格必须如实保留。

## Acceptance criteria

- 实际 Windows 经正式 Service／Client 的同一六工具完成原文本、完整基线、分页、精确 edit、create-only／CAS、真实变更 receipt 与完整 Artifact／下一 Model 输入；不恢复旧 Provider 或弱路径 fallback。
- 原检查点流程实际恢复完整 binary／BOM／CRLF、创建与反向删除；首 preimage／末 postimage、原 Command／Execution／Store 及恢复后新 Store 来源保持，冷读取零效果重放。
- ADS、设备名、尾点／空格、短名别名、reparse、保护路径大小写等价与根改绑不能获得目标读取或写入。合法普通大小写变体保同一对象，不制造额外私有 Workspace ACL要求。
- 完整实际 Win32 文件和原 HANDLE 确认、关闭未知强持及适用制品资格成立；非 Windows skip、纯 parser 或源码检查不算原生通过。原完整共享测试不删断言、不降低预算、不用过滤回避真实失败。

## Risks

Windows 共享模式、权限或文件系统不支持实际 API时必须明确失败；不合作外部 writer 的最终核对到发布竞态与原 POSIX一样，不宣称任意外部编辑原子 CAS。原文件 flush／目录身份与正常进程重开不证明 power-loss durability。HANDLE／LocalFree 未确认时强持原 owner 会保留资源，这是诚实的 unknown 边界，不能由强制释放或数值重试掩盖。

API依据为 [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)、[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)和 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。
