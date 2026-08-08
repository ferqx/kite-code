# ADR-0088: 移除 Windows AppContainer backend

状态：accepted

日期：2026-08-07

## 背景

ADR-0072、ADR-0073 与 ADR-0078 引入了 Classic AppContainer、invocation-private Workspace
staging、Bun runtime copy 和 reconciliation。后续 ADR-0079 至 ADR-0086 已建立默认的
`windows_restricted_token` 直接 Workspace 路径，并为审批后的联网命令增加受管 Online 登录身份。

AppContainer 路径没有成为 production-qualified backend。它还要求在每次调用前枚举和复制仓库、在
调用后回写差异，并维护第二套 ACL、协议、预算与错误语义。实际验证也表明 vendored POSIX runtime
不能在 Classic AppContainer 中可靠初始化。因此继续保留该实验路径只会扩大安全和维护表面。

Codex CLI 的 Windows sandbox 方向同样采用受限 token、专用身份、ACL 和网络策略，而没有采用
AppContainer。这与 Kite Code 已经落地的 direct Workspace 架构一致。

## 决策

1. 删除 `windows_appcontainer` backend、实验环境变量选择逻辑、Classic AppContainer native launch
   代码及其测试。
2. 删除 invocation-private repository staging、预算 Worker、repository copy、reconciliation 和
   AppContainer ACL journal。Windows 命令始终直接使用 canonical Workspace。
3. Windows native runner 只承载 `windows_restricted_token`：本地命令使用 restricted current-user
   token；审批联网命令使用既有受管 Online 登录身份与临时 ACL lease；所有命令仍受 Job Object 约束。
4. native invocation protocol 提升到 V5，删除 backend mode 和 AppContainer identity 字段。release
   manifest schema 仍为 V1，但必须固定 protocol V5 与 runner 0.7.0+。
5. `KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL` 不再是受支持配置；设置它不会改变 backend 选择。
6. Windows 仍是 development-only、production excluded，且不能开启 Full。移除 AppContainer 不降低
   当前已声明的 production 能力，因为该实验 backend 从未取得 production qualification。

## 后果

- 大仓库不再为 Windows 沙箱调用产生完整副本，命令输出直接落到真实 Workspace。
- runner、adapter、probe 和错误分类只有一套 Windows backend 语义。
- 当前 lower-assurance 边界不变：restricted token 不能证明结构性 network-off、任意 host read deny
  或 future root `.env.*` 动态名称保护。
- 若未来需要 strict Windows profile，应在 direct Workspace 架构上增加独立 Offline/Online principal、
  descendant-safe firewall/WFP 与动态 protected-name enforcement，并通过新的 ADR 和原生证据准入；
  不恢复 repository staging 或 AppContainer。

## 取代关系

本 ADR 取代 ADR-0072、ADR-0073、ADR-0078 中关于当前 AppContainer backend 与 private staging 的
决策，并取代 ADR-0079 至 ADR-0082 中“保留 AppContainer 实验路径”的部分。旧 ADR 保留原文作为历史。
