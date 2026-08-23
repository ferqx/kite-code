# ADR-0128：未发布阶段的无版本命名与领域模块边界

- 状态：accepted
- 日期：2026-08-23

## 背景

Kite Code 仍处于未发布阶段。迁移任务编号和格式版本曾进入生产文件名、实体名与跨包入口，导致模块身份、持久格式 metadata 与历史执行阶段混在一起。现有 Runtime 仍必须保持单一 Workspace authority、Host transaction owner、ack/receipt/terminal 顺序与 recovery 语义。

## 决策

1. 生产模块、类型、函数、类和测试路径使用领域/职责命名；schema、protocol、format epoch 和数据库字段版本只作为 metadata 数据存在。
2. 未发布阶段采用 clean cutover：消费者直接迁移到当前入口，不保留旧名 alias、双 codec、旧格式 fallback 或长期兼容 façade。
3. App 是唯一 concrete composition root；Runtime Contract、Kernel、SPI、Host、Builtin 与 SQLite storage 保持既有七 workspace 依赖方向。
4. 跨包领域能力优先通过 package subpath 暴露；根 barrel 只保留 composition surface。新增模块必须通过 `check:pre-release-architecture`、workspace boundary、typecheck 与文档影响门禁。
5. 当前行为语义不因命名迁移改变；格式不匹配继续 fail closed，不执行兼容恢复。

## 后果

迁移会产生 breaking clean cutover，历史实现和旧调用方不再是当前实现依据。拆分必须逐批保持唯一 authority owner，并在同一批次更新 active 文档、manifests 与 focused tests。SQLite 旧格式分支仍需后续批次完成删除后，才能宣称本 ADR 的全部实现条件闭合。

## 验证

`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、`bun run typecheck` 及相关 workspace tests。
