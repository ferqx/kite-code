# ADR-0176：稳定 Daemon 生命周期协议与显式重启

**Status**: accepted

**Date**: 2026-09-06

**Decision makers**: @chenchao

## Context

用户在源码启动 Web 时遇到存活旧 daemon 拒绝当前业务协议，客户端不能通过该协议管理服务。错误分类修复可以改进诊断，但不能解决正式版本升级后的停止与接续。用户确认需要合理的软件工程规范设计。

## Decision

在现有 owner-only endpoint 上提供独立于业务 initialize 的稳定生命周期 v1，最小操作为 status 与绑定预期实例的 shutdown。由同一 daemon owner 管理 admission、取消、资源释放和 endpoint 退出。

升级制品与切换进程分开。新增显式 restart，默认只停止 idle 实例，--cancel 明确授权取消活动执行；普通 start/status/web 和安装不替换服务。并发依赖实例校验、现有排他 endpoint ownership 与最终目标核实，不建立第二个 manager、持久替换队列或自动强杀回退。

本决策处于设计完成、尚未实现状态。具体命令、失败处理、支持范围、分期与验收见[实施设计](../plans/daemon-upgrade-lifecycle.md)。实施后当前规范归回 owner 与 active，历史 ADR 不充当运行手册。

## Alternatives

- 仅改善 mismatch 提示：不能闭合正式升级路径。
- 保留旧业务客户端执行 shutdown：引入旧版本分发与业务协议兼容负担。
- 按 PID 自动终止或 build 改变即替换：不能提供活动任务保护，且身份检查与进程控制之间有竞争窗口。
- 恢复常驻 manager 或引入 OS service：超出本机显式 daemon 当前需求。
- 新建独立控制 socket：增加第二个端点的占用和清理状态；当前可以在既有连接首帧分流。

## Consequences

生命周期协议需要独立兼容承诺与跨版本制品测试；任务 admission 与 idle 停止必须原子协调。重启有停止到启动之间的可见空窗，启动失败不自动回滚存储或旧进程。当前未发布开发实例使用一次性显式处理，不建设历史开发协议兼容层。

## Rollback

实施前可撤销计划并记录后续决策；发布后不能直接删除已承诺的 lifecycle v1。若撤回 restart 的便利入口，必须保留受支持版本的管理能力与明确替代流程，不回退到静默 PID 强杀。
