# 渐进式上下文缩减真实模型 Pilot

状态：completed
完成日期：2026-08-12
计划：[`../../plans/2026-08-12-progressive-context-effectiveness-evaluation.md`](../../plans/2026-08-12-progressive-context-effectiveness-evaluation.md)
当前规则：[`../../../active/real-model-test-boundary.md`](../../../active/real-model-test-boundary.md)、
[`../../../active/three-tier-context-reduction.md`](../../../active/three-tier-context-reduction.md)

## 运行

- Provider/model：`deepseek / deepseek-v4-flash`；
- 网络条件：本机正常网络；
- 命令：`KITE_RUN_LIVE_CONTEXT_STRATEGY_PILOT=1 bun run eval:context:live-pilot`；
- 运行形态：第一轮历史 fixture 运行一次真实 summary，随后各一次真实 raw、simple `summary + tail` 与
  progressive Working Set continuation；第二轮合并入口额外验证 direct/incremental summary compatibility，再运行
  三个 continuation。不记录 prompt、summary、模型输出、工具正文、路径或凭据。

## 脱敏聚合结果

| Profile | 关键事实恢复 | Provider input/output tokens | 时延 |
| --- | ---: | ---: | ---: |
| raw | 4/4 | 19,748 / 228 | 2,139ms |
| rolling summary | 0/4 | 4,721 / 256 | 2,937ms |
| progressive Working Set | 0/4 | 4,721 / 256 | 2,731ms |

首轮 summary checkpoint 的 self-reported projection token 数为 22,373 → 7,304。合并入口的第二轮中，direct
checkpoint 为 16,833 → 5,070，incremental checkpoint 为 18,570 → 7,493；direct/incremental compatibility 均通过。
第二轮 raw/rolling/progressive 的输入 token 分别为 14,208 / 482 / 2,478，但两个压缩 arm 在这个固定事实恢复用例上
仍完全丢失 4 个关键事实。因此本次结果是**失败信号**。不得将 token 节省视为质量通过，也不得据此开启任何默认开关、
取得 route qualification 或声称完整策略有效。

## 后续

本 pilot 还不是预注册的四臂 coding-agent benchmark：它没有 Micro/L2.5 专门触发、没有隔离 workspace
oracle、没有多次重复或 paired bootstrap CI。下一步应排查 summary 的事实保留，并在修正后运行计划定义的
4 case × 4 arm × 3 次真实 agent-task pilot；若仍不能满足非劣门槛，应停止扩展并评估删除/保持关闭。
