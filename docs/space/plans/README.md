# Plans

`plans/` 保存实施计划文档 — 事前规划"怎么做"的方案。

> **入口**：所有计划的首个入口是 [`index.md`](index.md) — 全局注册表，记录每个计划的状态、依赖和分叉关系。

## 与其他类别的区别

| 类别 | 时态 | 用途 |
|------|------|------|
| `backlog/` | 将来 | 已知问题列表，轻量标记，不含实施方案 |
| **`plans/`** | **将来** | **详细实施方案：步骤、涉及文件、依赖顺序、验证方法** |
| `../active/` | 现在 | 约束当前行为的强制性规则 |
| `execution/completed/` | 过去 | 已完成实现记录和验证证据 |
| `understanding/` | 过去 | 设计理由、心智模型、背景解释 |

关键区分：
- `backlog/tui-issues.md` 说"这个问题存在，影响是什么，大概方向是什么" — 一个 item 一行
- `plans/xxx-roadmap.md` 说"分四步解决，每一步涉及哪些文件，怎么验证" — 可执行的工程计划

## 计划文档格式

每条一个文件，命名 `YYYY-MM-DD-<slug>.md`。内容应包含：

- **目标** — 要解决什么问题
- **范围** — 涉及的文件或子系统
- **步骤** — 有序的实施步骤，每步包含：
  - 具体改动描述
  - 涉及文件
  - 依赖项（前置步骤）
  - 验证方法（测试命令、检查点）
  - feature flag/迁移策略；不适用时显式写明原因
  - rollback/失败时的安全状态
- **风险** — 已知难点或依赖

多步骤计划应在步骤正文前提供任务执行矩阵，最少包含：

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `<稳定 ID>` | `<前置 Task/Gate>` | `<代码、测试、文档>` | `<可执行命令/检查点>` | `<flag、兼容、rollback>` |

矩阵的一行必须唯一对应一个正文 Task。计划级“主要改动范围”或最终验收清单不能代替逐 Task
文件、依赖和验证。尚未确定执行人、branch 或 baseline commit 时，计划必须保持 `draft`；
激活 Task 前再写入可审计 execution binding，不得用虚构人员或占位 identity 越过门禁。

每个 Task 的完成记录可汇总到同一 Phase 文件，但计划必须写出具体
`docs/space/execution/completed/YYYY-MM-DD-*.md` 目标路径，完成记录内按 Task ID 分节，并逐项
记录实现/测试/文档影响、实际 commit/artifact、运行命令与结果、未运行项、风险、Gate、偏差和
rollback。`N/A` 必须在同一字段内用括号说明原因。

2026-07-29 Agent 生产就绪计划组额外运行：

```bash
bun run scripts/check-plan-execution-matrix.ts
```

该门禁检查矩阵与正文 Task 一一对应、`dependsOn` 稳定语法、跨计划引用、依赖环、milestone
唯一 producer、完成记录目标以及 D-01–D-14 的必填字段。当前 1B.1/1B.4/1A.6 completion ratchet
与 1A.7 completion ratchet 还会锁定计划验收、注册表状态、roadmap 基线、decision revision、
独立复核结论和 production qualification 限制；1B.2/1B.3 completion ratchet 还会锁定三平台
raw candidate artifact、明确 `excluded` 负向结论、D-04 空支持集不变、完成记录与 1B.5 激活
基线，绿色 probe 不能被误写为 production qualification 或 `MS:1B-DONE`；1B.5 completion
ratchet 锁定 shared evaluator、Registry/Harness/Sub-agent/native projection evidence、最终独立
复核、空支持集、完成记录以及 Revision 18 当时 1B.6/1B.8 仅 ready 未绑定的历史边界；Revision 20
进一步锁定 Revision 20 当时 1B.6–1B.8 的 `in_progress` binding、本地定向证据、D-09 Headless
只读与 MCP 负向开放边界；Revision 22 锁定当时 1B.9 的本地 negative conformance 与默认分支
三平台 artifact 等待项，并禁止在最终整体 Review 前把 1B.6–1B.9 或 `MS:1B-DONE` 写成完成；
Revision 28 在保留这些历史 ratchet 的基础上，进一步锁定两路最终 GO、PR #21 默认分支 head、
run 30739946155、三平台 artifact ID/archive digest、3 target/8 case、独立 digest/bootstrap 重建和
D-04 空支持集，才允许 1B.6–1B.9 completed 与唯一 `MS:1B-DONE`。1C.5 completion
ratchet 则锁定激活基线、实现与 qualification commit、全绿 CI、execution binding、完成记录及
1C.7 激活历史；1C closure ratchet 进一步锁定默认分支 Ubuntu run 的 source identity、正式 artifact、
7 case/56 probe、资源样本、72 条 actual Runtime ledger receipt、零 orphan/residual、canonical
digest、1C.7/1C.8 完成 binding 与 `MS:1C-DONE`。上述门禁在 Pull Request quality job 中使用完整 Git
历史验证 evidence commit 存在并可从 PR merge
`HEAD` 到达；squash/rebase 合入后的 push 仍校验记录字段，但不把被历史重写替换的原 SHA 强制
当作新主干祖先。`bun run check:docs` 已包含该门禁。

Revision 23 进一步锁定 D-06/ADR-0062、2A.0–2A.7 completed binding、真实恢复点、逐 Task 完成记录、
53 个 release 测试与 foundation policy/evidence/decision digest；它只允许 Task 2A.7 产生
`MS:2A-F`，并同时锁定 G2–G5 N/A、真实 signing/release disabled、D-04 空支持集和 production
capability 全部 off/excluded，防止 synthetic fixture 被升级为 production release claim。

Revision 24 锁定 2A.8、2A.9、2B.1–2B.9、3.1–3.8/3.10 的本地 fail-closed contract 与当时的
evidence-waiting 边界；当时只有依赖已满足的 2A.8 建立 `in_progress` binding，D-03/D-07、
`MS:1B-DONE` 与正式平台/供应链/human/adversarial/incident/SLO/signing evidence 仍缺失。
后续 revision 可以用真实决策或证据逐项关闭依赖，但门禁继续禁止把本地 synthetic/blocked 测试
升级为正式 evidence 或后续 milestone。

Revision 25 关闭 D-10 并锁定 Skill unknown/effect/dependency drift 的保守分类，同时锁定 Phase 4、
Phase 5 与 Phase 6 的本地 schema/conformance/profile/selection/Gate contract。只有依赖已满足的 5.1
建立 `in_progress` binding；route/profile/cohort 仍为 off/empty/0，formal task/live/canary/maturity/
GA/第三方评审 evidence 缺失时不得完成后续 Task 或产生 stable/GA milestone。

Revision 26 按用户批准关闭 D-07，锁定 single-maintainer-first 的 12-case 精确分层、确定性单次与
非确定性 route-change=8/RC=20、G0/false-completion 零容忍、90% aggregate/80% per-case 门槛，
并激活 2B.1。维护者 dogfood 仅是 internal evidence；external 仍需至少 3 名 opt-in 用户、每人 4
tasks，且不替代独立第三方安全评审。真实 route/样本缺失时 Gate 继续 blocked/not_observed。

Revision 29 在两路最终 GO 与 `MS:1B-DONE` 后批量锁定新的 dependency-ready closure：
2B.1–2B.3/2B.8、4.1–4.3/4.6/4.8、5.1/5.2/5A.1/5A.2/5C.1/5C.2/5.4 completed；
2B.4/2B.5 与 4.4 只进入 `in_progress`。对应完成记录分别绑定 63/36/29 个本地测试、默认分支
reviewed baseline 与所有 off/blocked 边界。authenticated live route/attempt/adversarial/semantic
authority 缺失时不得继续提升，且不产生 2B、Compaction 或 Capability maturity milestone。

Revision 30 补齐三个仍为 `in_progress`/blocked 的本地独立证据面：2B 从精确 96/240 retained attempts
重建 D-07 Gate，并把完整 21-case formal adversarial 绑定同一 source/candidate；Phase 3 以时间单调、
digest-chained admission/terminal receipts 重建 Limited SLO 并拒绝 outer identity splice；4.4 重建 opaque
blind semantic item/receipt/aggregate，并绑定逐项 candidate commitment 与受信 deterministic outcome。
三者都复用完整 Release artifact identity，production OIDC/Sigstore/attestation verifier/route registry 仍为空，
因此不关闭 Task、不产生 milestone，也不替代真实 run。

Required CI 的 `runtime-fault-soak` job 只运行 fault contract 与 bounded CI profile，负责阻止
case、状态不变量、终态分类、清理或报告 schema 回归。它不替代 release qualification：1C.7 的
正式资源证据已由手动 `Runtime Resilience Qualification` workflow 的 Ubuntu
[run 30710906064](https://github.com/ferqx/kite-code/actions/runs/30710906064) 运行 8 轮并以独立
verifier 收口；后续回归仍须保持上传 artifact 为 `status=passed`，`failed`/`inconclusive` 不能按
通过处理。

## 生命周期

1. 创建：识别到需要多步骤实施的任务时，从 backlog 或审查中提取
2. 执行中：随着进展更新各步骤状态
3. 完成后：
   - 将计划状态改为 `completed`，完成记录确认后再改为 `archived`
   - 保留 `plans/` 中的文件作为历史设计参考，不删除、不再作为当前实现依据
   - 在 `execution/completed/` 中创建完成记录
   - 如有新的约束规则，在 `../active/` 中创建
   - 如有未完成项，更新 `backlog/`
