# ADR-0010: MCP 连接由 Supervisor 统一投影到 control snapshot

**Status**: accepted
**Date**: 2026-07-15
**Decision makers**: @chenchao

## Context

Phase 0 的 TUI 直接持有 `McpManager`，读取其内部 Server Map，并在项目审批变化后整体替换 Manager。该方式无法可靠表达后台连接、单 Server retry、list-changed、迟到异步回调和后续配置 reconcile，也让展示层获得了 SDK client 所在对象。

Runtime 需要继续使用唯一 MCP SDK client 路径，但 App 需要一个不暴露 client、可订阅且包含配置门禁状态的 control plane。

## Decision

引入 Core `McpSupervisor`，由它组合 source-aware config catalog、项目审批门禁和唯一 `McpManager`。Supervisor 向 App 发布不可变、带稳定 revision/generation 的 `McpControlSnapshot`，并提供 start、stop、reload、单 Server retry 和 `McpRuntimeProvider`。

Manager 负责 transport、discovery、调用和 capability snapshot；每个连接保存 generation，旧 generation 的 connect/discovery/list-changed 结果不得更新当前状态。失效顺序固定为先撤销未来 capability/binding 可见性，再关闭旧 client。

TUI 通过 App 层 controller 与 `useSyncExternalStore` 消费 control snapshot，不直接依赖 Manager。Runtime 只依赖 `McpRuntimeProvider`，不依赖 Supervisor 或 TUI。

## Alternatives

- 让 TUI 轮询或继续读取 Manager Map：无法提供稳定订阅、配置门禁条目和异步 generation 保护。
- 在 TUI 创建第二套 SDK client：破坏唯一连接路径，并使 Runtime 与 UI discovery 可能分叉。
- 把 config、auth 和 UI route 全部放入 Manager：混合 transport、持久配置和展示职责，阻碍后续 Phase 2/3 reconcile。

## Consequences

- App 可以在连接完成前立即展示完整配置目录，并响应 health/list/retry 变化；
- 需要维护 control snapshot 与 capability snapshot 两种用途不同的不可变投影；
- Manager 的内部迁移读取 API 不再是生产 frontend contract；
- 后续配置和认证阶段必须接入 Supervisor reconcile，不得另建 client 路径。

## Rollback

可以替换 Supervisor 或 snapshot 的具体实现，但必须保留项目 transport 前置门禁、唯一 SDK client 路径、generation 迟到结果隔离、先失效后关闭以及 Runtime/TUI 依赖分离。不得回滚为 TUI 直接读取或修改 Manager Map。
