# ADR-0120：Windows strict Full 候选采用临时 AppContainer profile

状态：accepted

日期：2026-08-18

## 背景

ADR-0081 的 `windows_restricted_token` 是无需 UAC 的默认开发 backend，但 Windows restricted
token 本身不提供任意 descendant 的结构性 network-off。ADR-0088 因 private Workspace staging 的
复制、回写和 POSIX runtime 兼容性问题删除了旧 AppContainer backend；它不允许以旧 staging 方案重新
开放 Full。

用户要求 Windows Full 不创建 Windows 登录账户、不保存密码，也不以管理员安装作为普通 Shell
调用的前置条件。

## 决策

1. 新增独立的 `windows_appcontainer_strict` 候选，而不提升或改变 `windows_restricted_token` 的
   assurance。后者继续是普通开发 backend。
2. strict 候选每次 invocation 创建随机命名的 Classic AppContainer profile，使用后在 Job 已清空、
   ACL 已回收后删除。profile 是 Windows sandbox identity，不是本地登录账户：不调用
   `CreateProcessWithLogonW`，不保存密码，也不请求 UAC。
3. strict 候选只操作 canonical 真实 Workspace；不得恢复 repository staging、完整复制、差异回写或
   旧 AppContainer ACL journal。Shell/runtime/Workspace 的最小 ACE 仅在 invocation 生命周期内存在。
4. `networkMode=off` 使用零 capability AppContainer；已批准 `allow_all` 使用独立、短生命周期的
   internet-capable AppContainer identity。两个 profile 绝不复用，且均必须处于 invocation Job 中。
5. Full 的开放条件不是 profile 创建成功：必须同时具备 native negative evidence（offline 网络、
   Workspace 外 read/write、protected-path）、Job cleanup、ACL/profile 删除确认、动态 protected-name
   enforcement，以及 TUI/foreground CLI composition evidence。任何一项未知都 fail closed，Full 继续禁用。

## 后果

- 本 ADR 仅取代 ADR-0088 中“未来 strict profile 不能使用 AppContainer”的绝对限制；ADR-0088 对旧
  private staging/reconciliation 的移除继续有效。
- 严格 backend 在证据齐备前是未选择的 candidate，不改变 release production support 或现有 Full
  UI 行为。
- native protocol、manifest、capability evidence 和 backend selection 必须显式携带新的 backend，不能
  让 V6 direct restricted-token runner 静默解释 strict 请求。
