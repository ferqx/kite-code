# Agent Note: 权限策略与 Shell 分析归属独立 Agent 模块

Status: implemented

## Problem

三策略和 Shell 语义原放在 Service，宿主装配与规则判断混在同一 owner。用户明确要求权限策略和 Shell 命令分析统一放到 Agent 独立模块，Service 只保留接口、身份校验和装配。只搬分类器仍会留下命令摘要、批准范围解释和审批约束，形成不完整边界。

## Decision

`packages/agent/src/permissions/` 通过 `@kite-ai/agent/permissions` 和 `/permissions/shell` 提供现有工厂。三策略、可信 builtin effects（含 Task 与 MCP source/auth 固定分类）、规划权限交集、默认 Task／follow-up 后续汇报许可、Workflow 最低审批、明确恢复审批、Shell AST/危险拒绝、命令摘要和最终 scope 解释归 Agent；完整 Shell 工厂一起迁移。Service 读取原主体/Store/Workspace/Run/控制记录与真实来源，提供可信路径和环境并调用工厂。原 Loop 只认识通用授权结果，实际审核、人工接纳和 SQL 最终复核保持。

Shell 工厂保留原 `@kite-ai/agent/jobs/shell` 与 `/shell` 公共原语装配边界。真实制品测试证实包内相对导入让 Bun splitting 将 supervisor 定位函数提升到根共享 chunk，破坏原 import.meta.url 相对资产路径；沿 public entry 配合原 --packages=external 保住 Jobs 的独立资产位置，原路径断言和完整性校验保持。

默认 after-turn policy 只接角色 id/version 和可信当前读取 port，原 role/source/root work／request/apply／取消／删除判定及 revision 摘要保持。Service 旧实现退役；Planning 默认装配直接调用 Agent 工厂和原状态 reader，单次转发工厂／重复 options 删除。职责迁移与净精简分别报告；Core 激活、报告应用和 SQL 最终 read-set/CAS 有独立事实与时刻，不能合并为策略的一次读取。

固定 parser 依赖与两个公共 build entry 属于 Agent。正式 Terminal/Native 沿原 workspace manifest 与依赖图包含 WASM；predecessor 守卫只接纳本次准确 exports/build/owner 字节增量，不放宽任意版本或未知依赖。静态守卫沿真实 exports/barrel 拒绝权限模块反向依赖 Service，以及 Service 自有 parser npm 和原策略/范围工厂实现。

## Alternatives considered

- 只搬三策略和 AST 两个文件：会在 Service 留下批准范围、命令摘要、启动前硬拒绝和审批组合，不满足已确认边界。
- 把产品模式硬编码进唯一 Loop：会让通用执行核心反向依赖产品规则；保留既有 Permissions 注入接口。
- 在 Service 留兼容转发文件：延续旧 owner 入口、增加双位置；正式调用者直接使用 Agent public exports。
- 将全部配置、来源与宿主身份读取一并迁出：超出本次策略边界，且混入无关业务装配；只搬规则与 Shell 工厂，原可信事实读者保持。

## Consequences

用户入口、三种模式、极危险拒绝、独立文件/网络范围、reason、摘要/快照、准确审批、取消与恢复合同保持。原三策略/解析/scoped 测试初始迁移只改 import/URL，逆向后原全文字节相等，随后仅按原 hook 格式化；现有 macOS 正式调用链和构建闭包实际验证归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11权限与-shell-分析迁到-agent)。

原[单次权限范围决定](2026-10-11-shell-per-call-permission-scopes.md)继续指导行为。本次只闭合模块归属与正式装配迁移，Win/Linux 原生资格、Windows Shell 后端、RSS 超限和完整 Runtime 观测门禁保留，不据本机结果宣布 V1.3 阶段退出。
