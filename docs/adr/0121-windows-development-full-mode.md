# ADR-0121：Windows direct backend 开放开发期 Full

状态：accepted

日期：2026-08-18

## 背景

Windows 的 `windows_restricted_token` 已是可执行的 direct Workspace sandbox：runner 使用
当前登录用户 token、restricted SID 与 Job Object，且 normal shell 和逐次批准的 `allow_all`
都不创建 Windows 登录账户、不请求 UAC。用户要求在该 backend 被实际选中时可使用 Full，不能让
尚未完成 production qualification 的严格 backend 阻塞开发期工作流。

ADR-0081、ADR-0082 和 ADR-0120 曾将 Windows Full UI 与 production strict qualification
绑定；这会把两个不同层次的产品语义混为一谈。

## 决策

1. `windows_restricted_token` 被 Runtime 实际选中时，TUI 和 foreground CLI 可进入开发期 Full。
   backend 为 `none` 或启动失败时仍 fail closed，Full 不可用。
2. 此 Full 是交互/授权模式：已有 Full policy 仍逐调用生成授权，不扩大未批准命令的权限；已批准
   `allow_all` 仍仅使用当前登录用户 token 执行 exact invocation。
3. 这不改变 `productionSupported=false`、D-04 production capability verdict，亦不表示 Windows
   已有结构性 network-off、动态 protected-name 或 Workspace 外读取的 strict negative evidence。
4. ADR-0120 的 `windows_appcontainer_strict` 继续是 production-strict 候选；其证据不再阻塞
   开发期 Full UI，仍是将来宣称 Windows production Full 的前置条件。

## 后果

- 当前 active 文档必须将 Windows direct backend 标记为“开发 Full 可用、production excluded”，而非
  把它描述为无 Full backend。
- 任何 release 或 production surface 不得据此提升 Windows 支持级别；production admission 仍需
  独立、完整的 strict backend evidence。
