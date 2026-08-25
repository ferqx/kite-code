# ADR-0140：Workspace 文档权威与影响门禁 V2

状态：accepted

日期：2026-08-25

决策者：用户直接指令

相关：ADR-0128、ADR-0130、`docs/README.md`、`docs/documentation-map.json`

## 背景

Runtime workspace 已经完成物理切换，但当前行为仍集中重复写在 package README、52 份
`docs/active/`、book、计划和完成证据中。旧 `documentation-map.json` 允许 ADR、book、plan 或索引替代
current 文档，并包含空 source 和门禁无法识别的通配表达式。旧 CI 又只读取 staged files，在 clean checkout
中实际不会检查 Pull Request 的实现差异。

## 决策

1. Workspace README 是模块职责、依赖、公开入口和局部不变量的当前权威；必要的详细规范位于同 workspace
   的 `docs/` 并由 README 索引。
2. `docs/active/` 只拥有跨 workspace 行为、安全、恢复兼容、持久化、发布和运维规则。
3. ADR 保留已接受决策，book 只做导览，plan/completed/design/deprecated 只做历史或未来材料；它们都不能
   满足当前文档影响门禁。
4. 文档影响映射使用 schema V2：每条规则包含非空 `sources` 和 `authorities`。路径只接受精确值或末尾
   `/**`；重叠规则分别收敛。
5. 工作树审计覆盖 staged、unstaged、deleted、renamed 和 untracked；pre-commit 只检查 staged；CI 通过
   base SHA 与 HEAD 的 range 检查真实提交差异。

## 后果

- 模块局部知识与代码同目录演进，中央 active 页面不再重复包级事实。
- 历史资料继续可审计，但修改它们不能掩盖 current 文档缺失。
- CI、pre-commit 和人工检查使用相同判断逻辑但不同变更作用域。
- 行为无变化的内部重构若暴露过宽映射，应收窄映射，不制造无意义文档改动。

## 回滚

可以调整规则粒度或 workspace 本地文档划分，但不得恢复历史资料可满足 current 影响门禁、无法执行的通配语法，
或 CI clean checkout 下的空检查。
