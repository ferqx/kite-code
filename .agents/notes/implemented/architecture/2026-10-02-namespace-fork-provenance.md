# Agent Note: Namespace Fork 由显式规则复制或重建并保留派生来源

Status: implemented

## Problem

业务记录对 Fork 的含义不同。直接复制旧计划或 Task 记录可能使新分支借用原执行资格；一律省略又无法保留扩展明确支持的业务状态。宿主按业务名称猜测规则会把扩展语义写入核心。

## Decision

可信 RecordDefinition 注册 omit/copy/rebuild，Runtime 构造时捕获 schema、版本和纯回调。copy 表示 Fork 受理时已提交业务快照；依赖所选消息边界的状态交给 rebuild。缺少规则默认 omit，公开 namespaceReport 与原命令 receipt 一致，HTTP 不能注入内部计划。

准备在写事务外运行，最终短事务复核完整 source key 集、revision、raw digest、origin/provenance 与所选消息读集。新 Session、历史、派生记录及回执一起提交或回滚。同命令查回不重复准备。

仅新增 fork_provenance_json 保存派生因果。copy 保原 originStoreId 与 raw；rebuild 的 origin 为 null，记录准确规则和来源。普通 CAS 不能擦除 provenance，派生历史不能取得原 operation/child plan/必要义务执行资格；新的明确工作使用新 key 与命令。媒体继续原 scope，不复制 owner、授权或执行行。

## Alternatives considered

- 按业务名称自动复制或修复记录：核心无法证明业务语义，采用扩展显式声明。
- 把复制来源改成当前 Store：会使历史看起来具有新的执行资格，保留原 origin。
- 同时增加 eligibility 布尔状态：会形成第二份需同步的资格事实，使用已有来源检查和单一 provenance。
- 在 SQL 事务内运行回调或接受 renderer 准备计划：会扩大锁时间和 authority 边界，准备由可信宿主完成后再原子核读集。

## Consequences

准备页和内部计划保留有限安全边界，超限明确失败，不把截断记录当完整复制。未知格式保原文并按规则 omit/reject。全部业务扩展仍须逐个登记适用规则。

[生命周期 owner](../../../../packages/agent/src/extensions/fork/README.md)与[Core 测试](../../../../packages/agent/test/isolated/extensions/fork-lifecycle.test.ts)核 copy/rebuild、CAS/触发器回滚、旧执行资格、17MiB 原媒体；与导出和 requirements/read-set 最终组合24/452通过。[公开 HTTP](../../../../tests/isolated/unified-agent/client-fork-namespaces.test.ts)和[SDK](../../../../packages/client/test/isolated/fork.test.ts)2/57核原报告、派生再 Fork、省略状态及 provenance 导出。该决定补充[sealed Fork 与管理](2026-10-02-sealed-fork-and-session-management.md)，不改变原正文出处与删除停止边界。
