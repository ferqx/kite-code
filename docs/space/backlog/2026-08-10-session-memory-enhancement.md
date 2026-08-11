# 可选 Session Memory 增强

状态：backlog
日期：2026-08-10
关联：ADR-0099、ADR-0100

## 问题

当前压缩主链使用活动 checkpoint summary 作为长期前缀，已经可以独立完成三级压缩。Session Memory 可能在
更长会话中改善目标、约束、决定和未完成事项的保留率，但它需要额外模型调用、生命周期、持久化、恢复、隐私
和语义资格，当前没有必要让这些复杂度阻断压缩主链。

## 建议方向

未来只有在 checkpoint 工作集的长会话 continuation evidence 显示明确缺口时，才评估实现低权限
`CompactPrefixProvider`：

- provider 缺失、过期或无效时回退 `ActiveCheckpointSummary`，不能阻断请求；
- memory 不能成为 Plan、Verification、授权、Tool、Skill 或 Runtime 状态权威；
- bootstrap/incremental update、source coverage、rewind/fork/reset、费用/延迟和隐私必须独立设计；
- ADR-0099 接受并创建独立 active plan 前，不新增 memory schema、event、config、runner 或发布声明。
