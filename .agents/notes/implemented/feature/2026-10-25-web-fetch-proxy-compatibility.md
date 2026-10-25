# Agent Note: Web Fetch 自动代理与 Fake-IP 兼容

Status: implemented

## Problem

普通网页请求即使已获 Core 批准，仍可能因本机 TUN 的 Fake-IP DNS 被公网目的地检查拒绝。要求用户分别排除域名或关闭 DNS 模式会增加使用成本；直接放开保留 IP 又会失去真实目的地证明。

## Decision

默认 Service 在含网页工具的 Run 绑定时读取已登记 HTTP(S) 环境或系统代理，用户级手动设置只作覆盖。全部候选均为已识别 Fake-IP 时使用固定 HTTPS wire DNS 恢复真实地址。私网、混合地址及字面 Fake-IP 不回退；全部真实结果、每次重定向和原权限继续检查。代理 CONNECT 只发送已检查的字面 IP，TLS 保留原目标名称与证书验证。代理入口是可信用户设置，页面或模型不能修改；不扫描端口、不执行 PAC、不在代理错误后直连。

实际传输选择封存于原 `snapshot.web`，冷恢复在凭据读取前比较；旧默认快照不会隐式采用新网络。相同当前选择复用最近工厂的 robots/队列，配置变化建立新工厂，已有 Run 保留原网络和独立解析 scope。不缓存无限历史选择。

## Alternatives considered

- 手工配置每个域名的 Fake-IP 排除：可作运维绕行，不能满足默认自适应需求。
- 放开 Fake-IP 或把域名交给代理重新解析：无法证明真实目标仍为公网，拒绝。
- 只支持显式用户代理与 DNS：安全但增加每台设备的配置成本，改为自动读取已有设置并保留手动覆盖。
- 扫描常用代理端口、执行 PAC 或代理失败后尝试直连：引入不可核实的出口和网络效果，本轮不采用。

## Consequences

新增固定解析服务依赖；仅全部 Fake-IP 时默认向 Cloudflare 发送域名，不发送 URL 路径或正文，企业可在用户配置选择其他可信 HTTPS 解析服务。注册过程不连接目标，自动发现错误局限于网页 Tool；显式配置无效则准确拒绝绑定。不支持 SOCKS、PAC/WPAD 和代理认证，已有设置未暴露时仍需用户提供可用 HTTP(S) 出口。

当前实现、配置和证据归 [Web Fetch owner](../../../../packages/agent/src/tools/web-fetch/README.md)、[Service](../../../../apps/service/README.md)及[手册](../../../../docs/handbook/features/models-and-configuration.md#网页网络配置)。隔离真实 socket/TLS/Core 测试和 Windows 真实代理探测不代表 macOS/Linux 原生资格或远端网站稳定性；既有权限、取消与恢复边界保持。
