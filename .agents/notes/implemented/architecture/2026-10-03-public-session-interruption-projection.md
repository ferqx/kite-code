# Agent Note: 公共遗留执行组中断只投影原事实

Status: implemented

## Problem

通用 Runtime 已有准确根执行组的冷中断，但客户端无法显式调用。直接公开内部恢复请求或报告会把 owner generation 交给 HTTP 调用者；回执丢失后以新 ID 再中断也可能改变后来工作。V1.3 §18.5/22/35 要求服务提供真实主体和来源，历史读取不启动恢复，可能已发生的外部效果不能盲目重放。

## Decision

Native `session.recover` 只接受原 Store、路径 Session、申请 ID 和 `decision:interrupt`。Service 从真实 Session 或同 ID 原持久请求读取内部 generation，认证提供主体；原 Runtime OS 锁和 Store fencing 继续复核，不由 HTTP 建立第二恢复算法。

POST 和原 Command GET 使用同一公开投影，只有原中断/结算/未知/取消/partial ID 集与 Decimal64 观察水位，省略 previous/current generation 和 lease。SDK 克隆原意图、发送一次并核原连接与回执；丢失或不可信结果保持 unknown，只 GET 原 ID。未知外部效果不会因为中断成功而得到普通执行资格。

## Alternatives considered

- 让客户端携带 owner generation：拒绝，用户观察水位不能充当内部执行权威，同 ID 重读后来 generation 也会改变原摘要。
- 在 Service 重建中断和结算逻辑：拒绝，原 Core/Store 已持有执行组事实及锁，第二路径会造成不同 fencing 和未知判定。
- 丢回执后自动重新 POST：拒绝，用户必须核原申请；SDK 没有以新 ID 中断后来工作的授权。
- 公共响应完全禁止新增字段：未采用。已有公共响应兼容新增字段；本入口仍显式拒绝私有 owner fence，生成闭合请求与原 Service 投影保持。

## Consequences

该决定交付公共原申请调用与纯回执校验，不意味着 CLI/TUI/Native 完整恢复面板或跨应用强杀申请 journal 已完成。live/frozen 原进程仍持 OS 锁时拒绝；Tool/Job 可能已派发保持 unknown，Model 前缀保留。

当前真实 macOS owned 子进程 SIGKILL、SQLite 和 loopback Service 测试两项92断言通过；SDK 协议反例一项106断言覆盖 alias、十类物理丢失/坏回执及零自动 GET/重 POST。与原 Run、Job 报告组合共6项353断言通过，日志 `/private/tmp/kite-session-recovery-resume-combination-first.log`。首 HTTP 清理误用不存在的 closeHttp、首 SDK private-generation 接受以及 fixture 字面量类型失败均保留独立日志，修后 Service/Client 类型检查通过。证据限当前公共入口，不外推三平台或完整恢复消费者。

负责事实见 [Service](../../../../apps/service/README.md#显式遗留执行组中断)、[Client](../../../../packages/client/README.md) 与[统一边界](../../../../docs/active/unified-agent-boundary.md)。
