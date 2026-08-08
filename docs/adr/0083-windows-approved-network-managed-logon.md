# ADR-0083：Windows 已审批联网调用使用受管登录身份

状态：accepted

日期：2026-08-06

相关：ADR-0079、ADR-0081、ADR-0082

## 背景

ADR-0081 选择 current-user restricted token 作为无 UAC 的 Windows 默认开发路径，ADR-0082
又把 macOS/Linux 的逐调用 `off | allow_all` 授权投影带到该路径。实际验证表明，批准后的 TCP、明文
HTTP 和 Node 自带 TLS 可以工作，但 Windows Schannel 客户端（包括系统 curl 与
`Invoke-WebRequest`）在 current-user restricted token 中以 `SEC_E_NO_CREDENTIALS` 失败。

Codex CLI 的 Windows 实现没有移除 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`。其需要
网络代理强制执行的路径会切换到由 `CreateProcessWithLogonW` 建立的专用本地账户会话，再从该会话
创建 restricted token。真实登录会话与受限命令令牌是两个独立层次。

## 决策

1. 普通 `networkMode=off` 调用继续使用 ADR-0081 的无 UAC current-user restricted-token 路径；启动
   probe 和本地命令不得因为受管联网身份尚未安装而失败或弹出 UAC。
2. 已经通过工具授权的 `networkMode=allow_all` 调用不得再直接使用 current-user restricted token。
   native runner 必须确保专用非管理员账户 `KiteSandboxOnline` 已安装，并通过
   `CreateProcessWithLogonW` 在该账户的真实登录会话中重启受信 runner。只有重启后的 runner 才能用
   原有三项 flag 创建命令 restricted token、验证 child token、加入 Job Object 并 resume。
3. 首个已审批联网调用可以触发一次明确的 Windows UAC 安装。安装创建/轮换随机账户密码，状态只保存
   DPAPI 密文与预期 SID。用户取消或安装、SID 校验、登录失败时，本次调用 fail closed；不得回退 host
   Shell，也不得去掉 restricted-token flag。
4. current-user runner 与受管 runner 只通过随机命名、拒绝远程客户端且 DACL 限定到该身份的 named
   pipes 交换 framed protocol。受管 runner 从 manifest 已验证的父 runner 复制到独立只读执行目录；
   不从 WindowsApps 或任意 PATH 重新解析可执行文件。
5. 受管 runner 执行前所需的 Workspace、runtime、固定 Shell runtime 与 ledger ACL 是临时 lease。
   同一用户的联网调用串行持有命名 mutex，grant 前写 recovery journal，命令树清空后撤销账户 SID ACE。
   宿主 ACL lease 清理完成前不得转发成功 receipt；cleanup 失败必须把 receipt 降级为 fail closed。
6. native invocation protocol 升为 V4。V1/V2/V3 runner 不理解受管联网登录语义，adapter 必须因版本
   不匹配拒绝它们。
7. 本决策修复 development `allow_all` 的 Windows/Schannel 可执行性，但不把它升级成 allowlist、代理或
   production network boundary。Codex 风格 Offline 身份、仅回环代理端口、防火墙/WFP、逐域名策略和
   rustls 上游代理仍是独立的下一阶段。

## 后果

- `echo`、`ls`、版本查询等本地命令保持无 UAC 快路径。
- `curl https://...`、PowerShell HTTPS 和其他 Schannel 调用在获得网络审批后运行于真实的专用登录会话。
- 首次联网比后续调用多一次 UAC/账户安装成本；拒绝 UAC 等价于拒绝本次网络执行。
- `allow_all` 仍允许该命令树任意直连网络，不能表示成按域名代理或结构性 network-off 证据。
- Windows production support、Full 和动态 future `.env.*` 保证不因本决策改变。

## 对既有决策的影响

本 ADR 仅取代 ADR-0081/ADR-0082 中“批准后的 `allow_all` 仍直接使用 current-user restricted token”的
部分。ADR-0081 的普通无 UAC默认路径和低保证定位继续有效；ADR-0079 的完整 managed
Offline/Online、WFP/代理与更强 profile 仍未被本 ADR 完成。
