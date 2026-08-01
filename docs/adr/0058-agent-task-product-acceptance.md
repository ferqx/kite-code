# ADR-0058：Agent task、diff、test 与 review 结果是产品验收主证据

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Evaluation/Product + Release，single-maintainer）
关联：D-07、Phase 2B

## 背景

单元测试与模型 final 不能证明 Agent 在代表性仓库中交付了正确、可 review、可集成且没有越权
副作用的变更。只展示平均成功率或最好一次结果会隐藏回归和失败分布。

## 决策

1. `AgentTaskCaseV1` 版本化目标人群、任务 taxonomy、fixture repo/baseline、预算、预期 diff、
   checks、禁止副作用、review rubric 与 terminal oracle。
2. 每个 case 在独立可核验 worktree/环境执行，交付 baseline identity、完整 diff/无变更证据、
   tests/Verification、未运行项、风险和外部副作用。
3. 确定性 artifact/diff/check oracle 优先；人工 review 使用预注册、盲化、可退出流程，真实用户
   正文不进入 release bundle。
4. 重复运行保留全部结果与分布；suite、oracle、scorer、route、profile 和随机策略进入 evidence
   identity，变更后旧结果失效。
5. 未授权副作用、sandbox/trust/secret 绕过、false completion 和 required verification bypass
   为零容忍；无数据、样本不足或 scorer mismatch 为 unknown/blocked。

## 备选方案

- 只使用 unit/E2E 数量：拒绝，不能证明产品任务完成质量。
- 让模型自评 final：拒绝，不是独立 oracle。
- 只报告最佳运行：拒绝，掩盖稳定性。

## 后果

评估更慢且需要 fixture 维护、contamination governance 和受控人工流程；但 Gate 可以区分实现、
产品体验与安全失败。

## 回滚

可以撤回 suite revision、关闭某 capability 或把 Gate 降为 blocked；不能恢复模型自评完成、
丢弃失败运行、共享 checkout 污染 fixture 或用缺失证据宣称产品通过的旧路径。
