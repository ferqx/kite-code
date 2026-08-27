# ADR-0146：Workspace Scope 以重新授权收敛，不升级跨层兼容门禁

状态：accepted

日期：2026-08-27

决策者：用户直接指令

相关：ADR-0145、`docs/active/workspace-trust.md`

## 背景

ADR-0145确立了Workspace关联external-read roots不按命令名分类，而是在Workspace确认中展示并授权。初始实现又把
Workspace Trust DTO变化绑定到App Contract根revision、Local Runtime client contract、Service instance handshake和
manager lifecycle，且TUI在scope/revision conflict后进入保存失败状态。这把一个可通过再次确认自然收敛的授权变化
扩大成跨层不兼容与用户不可继续的门禁。

用户要求的实际策略更简单：已有授权与当前scope匹配就进入；不匹配、缺失或scope变化就展示当前值并重新授权。
普通授权变化不应被解释为Service故障，也不需要更高强度的跨层安全机制。

## 决策

1. 保留ADR-0145的Workspace级、非命令级external-read scope发现与展示。授权记录的Workspace identity和scope digest
   与当前snapshot匹配时直接进入。
2. 未命中、legacy记录缺少当前scope、scope新增/移除/变化或decision CAS conflict统一重新query；只要最新snapshot
   `canDecide`，TUI立即回到普通授权选项。系统不自动重放decision，但用户再次确认后即可继续。
3. scope drift不是`unavailable`、repository invalid、Service incompatible或永久deny。只有trust store真实不可读、
   不可写或损坏才显示故障。
4. Workspace Trust external scope是现有v1 App route的向后兼容可选扩展。当前encoder始终发送scope；decoder对缺少
   新字段的旧v1 payload投影empty scope。根`kite-app-contract-v1`、Local Runtime client contract、instance
   handshake和manager lifecycle revision不因该字段联动升级。
5. 用户确认后native sandbox仍只获得当前snapshot列出的read-only roots；这项实现约束不产生额外用户门禁，也不把
   approval提升为Git write、external mutation、network或Full权限。

## 替代关系

- 部分替代ADR-0145第3、4、6项中“conflict/scope drift fail-closed”的交互结论：scope不匹配改为可重复授权状态，
  真实存储故障仍保留错误。
- 替代ADR-0145“App Contract与Local Runtime跨层revision升级”的后果；external scope采用v1兼容扩展。
- 不改变ADR-0145的非命令级scope归属、canonical roots展示和native read-only投影。

## 后果

- linked worktree或其他Workspace关联外部root变化时，用户看到更新后的路径并再次确认，不会停在“无法保存工作区
  信任设置”。
- lost response和conflict仍不自动重放mutation；再次提交来自用户明确操作。
- 旧v1 Trust payload可继续解码，不把普通App DTO增量扩大成Service manager不兼容。
