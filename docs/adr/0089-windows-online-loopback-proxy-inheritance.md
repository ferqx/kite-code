# ADR-0089: Windows Online 调用继承发起用户的本地代理

状态：accepted

日期：2026-08-07

## 背景

Windows 已审批的 `allow_all` Shell 调用按 ADR-0083 与 ADR-0085 切换到
`KiteSandboxOnline` 登录会话。该身份拥有独立 HKCU，因此看不到发起用户在 WinINet
`Internet Settings` 中配置的代理。即使宿主已使用 `127.0.0.1:7890` 等本地代理，沙箱内的
`curl`、包管理器和运行时仍尝试直连。

把宿主的全部 proxy environment 或任意远程代理复制到 child 会扩大隐式配置与凭据泄露面；
把代理加入 `networkMode=off` 又会破坏本地命令的最小环境约束。

## 决策

1. 只有已审批并切换到受管 Online 身份的 `allow_all` invocation 才能继承代理。
2. 受信 native parent 在切换身份前读取发起用户 HKCU 的 `ProxyEnable` 与 `ProxyServer`。
3. 只接受 `localhost`、`127.0.0.1` 或 `::1` 的固定非零端口，并拒绝用户名、密码、路径、
   query、fragment、未知 scheme 与远程 host。
4. 单一 WinINet proxy 投影为大小写两套 `HTTP_PROXY`/`HTTPS_PROXY`；分协议配置分别投影，
   `socks` 投影为 `ALL_PROXY`。不复制 PAC、AutoConfigURL 或 proxy bypass。
5. adapter 继续从普通 restricted-token request 中移除所有 proxy environment。native parent 只向
   转发给 Online child 的 request 增加通过验证的值。
6. 代理是纯增强：`ProxyEnable` 关闭、`ProxyServer` 缺失/为空或配置不受支持时，不注入任何
   proxy environment，Online child 继续使用原有 direct network path，不报代理错误。
7. 该行为是 development `allow_all` 的可用性兼容层，不构成 network allowlist、network-off
   enforcement 或 production qualification。

## 后果

- 使用当前用户 loopback 代理的 Windows 用户，在批准联网 Shell 后可继续使用同一代理。
- 没有代理的用户保持原有 direct behavior，不需要新增配置或 setup。
- 本地 `networkMode=off` 命令、startup probe 与未审批命令仍看不到任何代理设置。
- 远程企业代理、带凭据代理与 PAC 暂不支持；若未来支持，必须单独设计凭据和 endpoint policy。
