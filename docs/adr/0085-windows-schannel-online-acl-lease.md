# ADR-0085：Windows Schannel 联网调用使用 Online 非管理员令牌与 ACL lease

状态：accepted

日期：2026-08-06

相关：ADR-0081、ADR-0082、ADR-0083、ADR-0084

## 背景

ADR-0083 认为真实 `KiteSandboxOnline` 登录后再派生 restricted token 可以同时保留 filesystem capability
与修复 Schannel。原生验证否定了这一点：账户 setup、`CreateProcessWithLogonW` 和 profile load 均成功后，
系统 curl 与 PowerShell 仍在 `AcquireCredentialsHandle(Schannel)` 返回 `SEC_E_NO_CREDENTIALS`；Node 自带
TLS 继续成功。Microsoft 的 SSPI contract 明确 restricted/constrained security context 可能没有可用的
outbound credentials。

Codex 的强 Windows sandbox 可以把 restricted Offline/Online token 与代理/WFP 网络架构组合。Kite 当前
development `allow_all` 没有 TLS-terminating proxy，不能仅复制 token flags 就声称 Schannel 可执行。

## 决策

1. `networkMode=off` 保持 ADR-0081 的 current-user write-restricted token 路径。
2. 已审批 `allow_all` 仍必须切换到 setup 完成的 `KiteSandboxOnline` 非管理员真实登录会话，但 command
   child 不再从该登录令牌二次派生 restricted token。runner 使用 `LOGON_WITH_PROFILE`，suspended 创建
   child，先加入 kill-on-close/active-process-limit Job，再 resume。
3. Online command 的 filesystem write boundary 由 per-invocation ACL lease 提供。原发起用户的 parent
   runner 只对 Workspace、runtime、固定 Shell runtime 与受信 runner state 授予 Online SID 所需权限；
   对所有当前存在的 protected paths 写入 Online SID deny。grant/deny 前持久化 recovery journal，Job 清空
   后逐项撤销，cleanup 未确认时不得返回成功 receipt。
4. runner-managed Coreutils 文件必须在切换 Online 登录之前由发起用户 materialize。这样 secondary-logon
   default DACL 不会阻止原用户枚举和删除 invocation runtime。
5. 每次消费 managed identity 时必须重新验证账户 SID、真实登录和非管理员成员关系。账户被外部加入
   Administrators 后，status/command 必须 fail closed。
6. 该路径仍是 development `allow_all`：没有域名 allowlist、代理/WFP、structural network-off、动态 future
   `.env.*` creation interception 或 production qualification，Full 继续不可用。

## 后果

- 系统 curl、PowerShell/Schannel 和 Node HTTPS 在同一 approved network 语义下可运行。
- local-only 命令继续使用 restricted token；只有已审批联网 invocation 使用专用 Online primary token。
- 当前已存在的 `.env` 等 protected paths 通过 Online SID deny 抵抗间接脚本写入；未来创建的动态名称仍不
  构成 strict protected-path guarantee。
- 与 Codex 的共同点是显式 onboarding、专用 Online identity、credential custody、Job 与 ACL lifecycle；
  不同点是 Kite 尚无 Codex 的代理/WFP，因此不能保留 restricted token 并同时依赖 Schannel direct TLS。

## 对既有决策的影响

本 ADR 取代 ADR-0083 第 2 项中“Online 登录后再次派生 restricted command token”的部分，并保留其专用
登录身份、pipe、Job、ACL lease 与 fail-closed cleanup 决策。ADR-0084 的显式 setup 生命周期不变。
