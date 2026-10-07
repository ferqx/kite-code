# Agent Note: Windows 私有 Profile 与不可信 Workspace 声明的原生路径策略

Status: proposed

## Problem

Windows 的 POSIX mode 位不能证明 owner-only ACL。Profile、Store、协调锁和凭据 metadata 要求实际 current SID 私有访问；普通用户 Workspace 则常继承宽 ACL，不能因配置读取而修改它。把两者都判为 private 会拒绝合法 Workspace，把普通配置策略扩到 Profile 又会弱化安全边界。

## Proposal

固定 lazy Bun Windows x64 backend，使用实际 SystemDirectory 的 native API、当前 process token SID 与原 HANDLE 核类型、reparse、nlink、volume/file identity、owner/DACL。import 在 Node/POSIX 无 DLL/token I/O。新 managed private 对象原生 CREATE_NEW/私有 descriptor；既有不安全对象拒绝，不修 ACL。

可信 host 按实际角色选择 scope/private：Workspace JSONC/MCP 原声明采用 bounded scope read，Profile/user/approval/auth、host key、Skill flags 和 TUI preferences 明确 private。选择不来自 Model、HTTP 或 JSONC。实际 scope read 在同 HANDLE 有限读取并核前后路径；私有 sibling 锁、publication temporary 和 repair backup 仍使用 strict private policy，不修改 Workspace ACL。

代码已实现这些部分，POSIX 邻接已通过；本提案保持 proposed，因为实际 native Windows CI 场景尚未执行。本提案只负责 Profile/Workspace 分角色路径；Windows ArtifactStore 已有独立原生实现但尚未取得实际 Windows 资格，见[媒体发布提案](2026-10-04-windows-artifact-handle-publication.md)。Node/Electron 独立使用权正在实施，原因与资格边界见[各进程原生使用锁提案](2026-10-04-windows-node-owned-profile-and-artifact-leases.md)；maintenance 原生运行与完整安装器仍有独立未验或未实现范围。当前合同见 [Windows leaf](../../../../packages/agent/src/platform/windows-path-security.README.md)。

## Alternatives considered

- 在 Windows 继续使用 POSIX mode 检查：不能核实际 DACL，已有 `icacls` 反例计划要求真实权限拒绝。
- 所有 Workspace config 都要求私有 DACL：普通继承 ACL 的项目会被拒，且与 POSIX untrusted scope 语义不一致；明确区分实际路径角色。
- 自动修复既有 ACL：掩盖不安全或被替换的原对象，并改变用户 Workspace；拒绝且零 repair。
- 私有策略通过配置字段或任意 SID/descriptor 注入：会把安全决策交给不可信声明；固定 current token 与 trusted host 选项。
- 读取后只核 Node path：无法证明被读取的对象就是当前路径；采用原 HANDLE 和前后 identity 校验，保留非原子 publication 的真实限制。

## Acceptance criteria

实际 Windows x64 必须执行 private Profile/Store/Worker/WAL/SHM 和活锁反例，无 availability skip；外部 hardlink、junction/reparse、宽 DACL 或 foreign owner 拒绝且原字节/ACL不变。

普通继承 ACL Workspace 的 absent/read/edit/repair 保注释、unknown fields 与 CRLF，Workspace ACL 不变；用户 MCP 私有 metadata/CAS 与项目 raw scope 分别核验。最终 host validation 后替换路径的 hardlink 反例必须零覆写。三平台 CI 结果绑定实际 Bun、源码身份和 native backend，类型/构建/POSIX 邻接不能替代 Windows 证据。

## Risks

Bun FFI 属实验接口，ABI 和 Windows x64 资格依赖实际运行时；ARM64 尚不支持。最后 path/ETag/活锁检查与 rename 仍不是对不合作编辑器的原子 CAS；filesystem 与 SQLite 回执不是同一媒体，未知发布保原意图，不重做。该分角色合同不能据此放行其他 Windows 文件/锁实现。

Windows维护文件端口现已接入原API与开发CLI，完整角色、原HANDLE/FD/SQL生命周期、发布屏障与未验范围见[维护提案](2026-10-07-windows-maintenance-file-publication.md)。本篇其余角色与安全理由保持，实际原生资格仍未取得。
