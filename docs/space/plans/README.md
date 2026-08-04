# Plans

`plans/` 保存实施计划。当前行为以源码/测试、`docs/active/` 和已接受 ADR 为准，计划不能覆盖它们。

## 计划格式

多步骤计划应包含目标、范围、依赖、风险、rollback、定向验证和 Task 执行矩阵：

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `<稳定 ID>` | `<前置 Task/Gate>` | `<代码、测试、文档>` | `<命令>` | `<安全状态>` |

矩阵的一行对应一个正文 Task。完成记录可按 Phase 汇总到 `docs/space/execution/completed/`。历史计划
不得删除；新的架构决定通过追加 ADR 取代旧决定。

## 单维护者开源首发

ADR-0068/ADR-0069 已取代 2026-07-29 生产计划组的企业式首发 Gate 和发布后资格路线。总路线图
`2026-07-29-agent-production-readiness-roadmap.md` 已完成并归档，验证证据保存在
`docs/space/execution/completed/2026-08-04-single-maintainer-open-source-first-release.md`；十个旧 Phase
子计划均标记 `superseded`，只保留 Task ID、详细设计和历史证据。

当前 Task 权威是 `release/oss-first-release/task-status-v2.json`：108 个 Task 精确分类为 83
`completed`、25 `superseded`、0 optional。没有发生的外部签名、attestation 或运营事实不得登记为通过。

文档门禁运行：

```bash
bun run scripts/check-plan-execution-matrix.ts
bun run check:docs
```

门禁验证十份旧计划的矩阵/正文 ID、ADR-0069、active 首发规则、decision Revision 45、README、文档映射
和 108 Task 终态注册表。它不再接受 optional、旧 milestone、Sigstore authority、独立 evaluator 或
external rollout 作为发布路线。

## 生命周期

1. `draft`：尚未批准或依赖未满足。
2. `active`：当前可执行入口。
3. `completed`：计划原范围已完成并有验证记录。
4. `superseded`：被新 ADR/计划取代，保留历史但不作为当前实现依据。
5. `archived`：完成后归档的历史计划。

行为变化必须同步 active 文档；架构变化必须新增 ADR。当前首发路线图不保留 optional Task；未来新增
产品工作必须新建立项，不能复用已 supersede 的 Task。
