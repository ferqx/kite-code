# ADR-0059：远程 rollout manifest 可选且只能签名降级

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Release + Security，single-maintainer）
关联：D-03、D-06、D-13、Phase 2A、Phase 3

## 背景

首个 limited artifact 不需要远程配置服务，但外部 canary 可能需要分钟级 kill switch。普通 HTTPS
下载不能证明内容授权、抗重放、过期、identity binding 或只降级。

## 决策

1. signed rollout manifest 是可选能力，不阻塞首个 limited artifact；需要分钟级 kill switch
   的 external canary 前成为 G4。
2. remote manifest 只能关闭 capability、降低 cohort/预算、提高审批/verification、关闭 logging/
   telemetry 或缩短 retention；不能超过 embedded artifact ceiling，也不能注入 credential、
   prompt、Skill、MCP config 或扩大 Workspace trust。
3. manifest 使用 canonical bytes、signature、keyId、issuedAt/expiresAt、单调 sequence 与 artifact/
   profile identity；实现包含内嵌 trust bundle、重叠轮转、重放/降序拒绝、有界 clock skew 和
   identity-bound cache。
4. signature/schema/expiry/identity 失败时忽略 remote 内容并保留 embedded ceiling；缓存只可继续
   执行未过期的降级。
5. mandatory enterprise policy 无有效 identity-bound cache 时拒绝受管 session；普通可选服务
   不可用时保留 embedded profile。

## 备选方案

- 普通 HTTPS JSON 作为 kill switch：拒绝，缺少真实性与抗重放。
- remote manifest 可开启新能力：拒绝，破坏 artifact ceiling。
- rollout 服务阻塞首个 limited：拒绝，首发可用小 cohort 与直接联系完成遏制。

## 后果

外部 canary 前可能需要密钥轮转、缓存和 clock-skew conformance；普通 limited 构建可以保持该
能力 disabled。

## 回滚

可以禁用 rollout loader、把 cohort 置 0 或回退 artifact；不能恢复 unsigned remote override、
过期/降序内容生效、远程抬高权限或 mandatory admin policy 静默绕过的旧路径。
