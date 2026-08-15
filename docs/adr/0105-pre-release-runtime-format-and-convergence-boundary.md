# ADR-0105：预发布 Runtime 格式与收敛边界

状态：accepted

日期：2026-08-15

决策者：github:@ferqx

相关：ADR-0028、ADR-0043、ADR-0096、`docs/space/plans/2026-08-15-runtime-architecture-convergence.md`

## 背景

项目尚未发布正式版本，但在线 Runtime 仍保留 V2–V22 snapshot migration、历史 ToolOutcome
decoder、legacy Plan/Subagent recovery 和多套 App/Runtime action 协议。这些路径扩大了当前状态机、
调度器和工具控制器的权威范围，也让新的内部重构必须持续维护尚未形成公开承诺的数据格式。

同时，收敛工作不能以建立通用 Ports/Adapters、Runtime slice 框架或第二套 Tool 抽象替代旧的重复
路径。衡量标准必须是权威、入口、分支或错误依赖的实际减少。

## 决策

1. 在线 Runtime 只接受当前源码声明的精确 schema version 与 format epoch。任一不匹配都必须在
   event decode、reducer、scheduler、Tool 或外部 adapter dispatch 前 fail closed。
2. 不提供旧 Runtime 数据的 migration、import/export、只读 replay 或恢复 UI。旧数据库和 Artifact
   不主动删除、搬移或改写。
3. 删除 V2–V22 migration、historical event/ToolOutcome decoder、legacy Plan/Subagent recovery 及只
   服务这些路径的状态、effect 和 flag。
4. 正式版发布前可以再次破坏 Runtime 格式，但变更时必须更新 format epoch，并在同一改动中删除
   被替代实现，不积累新的 migration 链。
5. 物理依赖继续保持 `app → core → protocol`。Protocol 不得导入 Core/App，Core 不得导入 App。
6. 架构收敛禁止只新增抽象。新增接口、factory 或入口必须在同一改动中替代并删除旧权威；完整
   Ports/Adapters、Runtime slice、release composition 或公共版本化 API 不属于本决策的目标。

## 备选方案

- 保留最近若干 schema migration：拒绝。当前没有正式发布兼容承诺，收益不足以覆盖持续维护成本。
- 自动隔离或搬移旧数据库：拒绝。它会引入新的数据管理和恢复产品面；明确拒绝读取即可。
- 先搭建目标分层再迁移旧代码：拒绝。中间态会增加第二套模型，违背净减少门禁。

## 后果

- 本地旧会话可能无法恢复，但文件保持原样，用户可以创建新会话。
- Runtime restore 路径、测试和 active 文档显著缩短，不再证明未发布历史格式。
- 后续每个架构改动都必须指出删除项和下降指标，不能把目录或接口数量增加描述为收敛。

## 回滚

本决策不通过重新接入在线 migration 回滚。若正式发布需要兼容已有公开数据，应新增 ADR 定义公开
格式、支持窗口和独立离线迁移工具，再基于真实发布承诺实现。
