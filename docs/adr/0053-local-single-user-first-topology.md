# ADR-0053：首发仅支持本地单用户拓扑，hosted 形态独立准入

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Release + Platform + Evaluation，single-maintainer）
关联：D-04、Phase 1B、Phase 2A

## 背景

本地单用户控制不能直接证明多租户身份、服务端 secret custody、tenant isolation、远程 runner
和跨设备控制安全。把本地证据外推到 hosted 会造成错误支持声明。

## 决策

1. 首个 `limited-production` 只支持单个本地 OS 用户、单个已信任 Workspace、本地 TUI，以及
   同一用户启动且用户在场的前台 Headless CLI。
2. 正式支持集合必须逐项绑定 platform、sandbox backend、入口和 provider route 的 native
   artifact evidence；未验证组合不进入 manifest。
3. Web、多租户/共享服务、远程托管 runner、跨设备控制、服务端 credential custody 和无人值守
   SaaS/共享 CI writer 保持 No-Go。
4. hosted/multi-tenant 需要独立 RFC 和 identity/RBAC、tenant、secret、egress、retention、
   abuse 与 incident 准入，不能通过 profile flag 打开。

## 备选方案

- 声明“best effort”支持所有平台/入口：拒绝，无法绑定 native evidence。
- 复用本地 sandbox 证明 hosted isolation：拒绝，信任与攻击面不同。

## 后果

首批支持矩阵可能很小；未验证平台必须明确排除。产品文案、manifest 和 evidence 必须使用相同
拓扑边界。

## 回滚

可以缩小支持矩阵、关闭入口或撤回 artifact；不能把缺少 hosted 准入的旧远程/多租户路径重新
宣传为 production supported。
