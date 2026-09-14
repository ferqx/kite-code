# ADR-0186：会话权限设置与执行准备分离

状态：accepted
日期：2026-09-14

## 背景

目标工作区准入修复后，权限命令仍在 Host 入口取得执行租约，并由 Service 为历史会话恢复完整 Runtime。已结束任务留下的 recovery_required 因而可以阻止权限修改，失效的模型配置也会成为设置的前置条件。这些依赖超出了设置命令实际需要的写入范围。

## 决定

权限命令继续使用同一 Host mailbox、Kernel 决定、State、事件和持久回执。已有本地 coordinator 时沿其执行 fence 提交，保持活动 Runtime 的唯一 State；否则直接从持久 State 形成权限决定，在现有 SQLite writer 的同一事务内验证没有执行 owner 且版本未变化。允许 idle 与 recovery_required，拒绝 active 与 detached；不因租约过期就自行接管或恢复。

设置路径不写 Run、Effect、cleanup 或 execution authority，不初始化模型、MCP 或完整 Runtime，不增加 desired/effective 双份设置。模式的业务规则仍归 Kernel；权限成功不等于任务可以恢复或副作用已完成。命令回执重放不恢复 Runtime，多进程同命令竞态由已提交回执确认。

不增加第二个 Store、配置表、后台协调进程、自动修复或协议方法。工作区 Trust 和执行命令的项目边界保持现有约束。

## 影响与证据

历史会话的权限可以独立保存；执行恢复仍是单独的必要条件。当前机制见 [Service owner](../../apps/kite-service/docs/runtime-application.md#app-controlhistory-与-mutation) 与 [Store 事务](../../packages/runtime-storage-sqlite/docs/transactions-and-state.md)。[多工作区回归](../../apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts)覆盖配置不可用、恢复记录不变、版本冲突、并发回执和重启；[Store 回归](../../packages/runtime-storage-sqlite/test/isolated/kite-session-runtime-storage.test.ts)覆盖执行者 fencing 与失败回滚。
