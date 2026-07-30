# ADR-0057：Compaction 发布资格使用结构、语义与 continuation 三层门禁

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Capability + Evaluation + Release，single-maintainer）
补充：ADR-0021、ADR-0022、ADR-0024
关联：D-01、Phase 4

## 背景

结构正确的 checkpoint 仍可能丢失关键事实；单次主观样例也不能证明真实 provider route 在多轮
压缩后的 continuation 非劣。发布质量控制不应借机改变已接受的单 narrative checkpoint 契约。

## 决策

1. 保持单次、无工具、零 SDK retry 的 Markdown narrative、原 transcript 不变和唯一
   `summary:string` checkpoint；发布评估不新增 production fact ledger/reviewer。
2. qualification 依次要求结构 conformance、版本化 synthetic semantic facts/forbidden claims、
   control-treatment continuation non-inferiority。
3. case、matcher/rubric、route/model/provider/platform/prompt、预算与 scorer 都进入 qualification
   identity；任一变化使旧 evidence 失效。
4. deterministic matcher 优先；semantic evaluator 只处理预注册项，真实用户正文默认不得进入
   evaluator、benchmark 或人工 review。
5. critical fact loss、invalid checkpoint、tool pair/replay/state 损坏均为 G0 且容忍度为 0。
6. internal manual/auto 与 external manual 分开 Gate；external auto 不在 Phase 4 开启。

## 备选方案

- 只跑结构测试：拒绝，无法发现事实丢失和后续任务劣化。
- production checkpoint 增加第二份事实 ledger：拒绝，属于新的 Runtime/隐私 ADR。
- 只保留最好一次 live 结果：拒绝，不能代表 route 分布。

## 后果

qualification 成本增加，route 变化会频繁失效；无资格 route 的 manual/auto 保持 off，并提供无压缩
handoff。

## 回滚

可以关闭单个 route、manual/auto capability 或 cohort；不能恢复只凭结构绿色放行、复用陈旧 route
evidence、吞掉 critical fact loss，或用发布回滚删除 transcript/checkpoint 的旧路径。
