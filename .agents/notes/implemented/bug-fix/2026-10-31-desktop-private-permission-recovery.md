# Agent Note: Windows Desktop 显式私有权限恢复

Status: implemented

## Problem

Windows 沙箱或其他工具可能向 Kite 私有数据根追加只读用户组授权。正常 current SID 私有政策正确拒绝，但通用 `windows_access_unavailable` 不能帮助用户判断对象和安全恢复方式。直接递归重置权限还会掩盖可写暴露、改变未确认对象或在活跃使用者期间改动数据边界。

## Decision

按用户确认的生产权限错误与恢复目标，保留普通 Bun／Native／Service 准入的全部拒绝条件。Desktop Main 在可信候选准入后、renderer／Service／SQLite 之前检查固定所选 Profile 元数据，默认退出，重查只读。仅 current SID owner、原 owner-FA 和适用 protected DACL 完整、所有额外 ACE 仅只读／执行时提供明确的备份并修复选择；不把可能曾被其他写入者改写的数据通过重置 ACL 变成安全。

原生 observation 封存 root／target FileID 与原 ACL；确认后以 dataRoot 的 MAXIMUM_ALLOWED HANDLE 排除现有消费者并阻止新消费者，重核身份／快照，CREATE_NEW 私有权限备份并完整写入／Flush 后，只对原 target HANDLE 改 DACL。该访问模式下 SetSecurityInfo 不向子项传播，见 [Windows API 合同](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)。不修改 owner/group/SACL、不使用管理员权限，不自动恢复旧授权。busy、漂移、备份失败、写后结果／关闭未知保持阻断；原生资源严格关闭，退出期间迟到确认无写入，成功后仍通过全部原准入。

此项仅为用户明确发起的 Desktop 维护例外；[原对象保护决定](2026-10-17-windows-original-object-sharing.md)中的祖先 pin、独立使用锁、候选创建链和关闭未知约束仍适用，普通准入不修既有 ACL 的约束保持。当前行为与实现归 [Desktop owner](../../../../apps/desktop/README.md#windows-数据权限预检与恢复)，跨包边界归 [发布控制](../../../../docs/active/release-control.md)。

## Alternatives considered

- 将 CodexSandboxUsers 或其他工具组列入私有政策白名单：把当前用户之外的访问授予了正常业务读取，违背现有安全要求。
- 启动时自动修复或递归重置：绕过用户对已有授权的选择，扩大修改范围，并可能掩盖可写暴露。
- 只给出 icacls 命令让用户操作：无法在产品内绑定原 FileID、备份与活跃使用者排除，容易误改路径或权限。
- 仅按路径重读后写 ACL：确认期间对象／授权可能变化，不能证明修改的是同一观察到的对象。
- 自动回滚旧 ACL：可能重新开放原有不安全授权；保留备份供人工核对，unknown 不自动重试。

## Consequences

恢复范围有意局限于固定 Profile 启动元数据及可证明只有额外只读授权的对象。其他情况仍须检查权限与数据完整性，不能承诺一键修复。备份文件保留于数据根，用户确认并重核后才能继续；恢复不运行模型或重放历史任务。

流程／Main 原模块端口回归与真实 Windows Electron Node-API 回归覆盖取消、备份与单对象修改、子项 ACL／原数据保留、busy、身份／ACL 漂移、write／deny／未保护／hardlink 拒绝、伪造 receiver，以及修复后原 SQLite／Store／草稿冷读取。实际执行与窗口证据范围归 Desktop owner；这些结果不代替完整 installed Native、发布者或其他平台资格。
