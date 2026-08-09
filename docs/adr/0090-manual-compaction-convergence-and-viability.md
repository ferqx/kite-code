# ADR-0090: 手动压缩的可行性预检与终态收敛

状态：accepted

日期：2026-08-08

## 背景

ADR-0022 要求 summary candidate 至少减少 1024 个估算 token，并把 projection environment drift
定义为不生成 lifecycle event 的 stale discard。实际手动 `/compact` 暴露出三个问题：短历史仍会消耗一次
Provider 调用后以低收益失败；idle standalone command 的 stale discard 会让 durable pending 永久保留；
同一 session 的快速重复命令可能创建多个 Kernel 并发推进同一 Runtime Store。

带 custom instructions 的连续压缩还有一条不可满足的隐含路径：active checkpoint 已覆盖全部 safe
history 时，系统仍调用 Provider 重写 narrative，但新 candidate 依然必须额外减少 1024 tokens，因此正常
的简短 narrative 几乎必然失败。

## 决策

1. Compactor 在 Provider dispatch 前用最小有效 narrative 构造 candidate projection，计算当前 source
   理论上能够获得的最大缩减。最大缩减低于 1024 tokens 时生成 `insufficient_reduction` 终态，Provider
   call count 必须为零。
2. active checkpoint 后没有新增 safe history 时，无论是否带 custom instructions，都以
   `No new messages to compact.` 收敛且不调用 Provider。Custom instructions 只改变包含新 source 的
   summary 侧重点；`/compact` 不承担已有 narrative 编辑功能。
3. Kernel revision/turn lease 变 stale 时仍由最新 RuntimeState 决定重新调度；只有模型调用期间
   projection environment digest 变化时生成 retryable `stale_context` failed event。该事件清除 pending、
   不激活 checkpoint、也不创建 correctness hard block。这一条取代 ADR-0022 中 environment drift
   “不生成 lifecycle event”的局部结论。
4. App 对同一 session 的手动压缩完整串行 command、request、effect 与 terminal lifecycle。只在
   Provider 调用周围设置 in-flight 标记不足以保护 Runtime Store revision。
5. 手动 request estimate 使用与 `/context`、模型调用和 candidate validation 相同的完整 projection
   environment。TUI 继续脱敏 Provider 正文，但按 low-gain、stale、输入过大、输出不可用、candidate
   invalid 和通用 Provider request failure 给出不同恢复建议。

## 备选方案

- 继续按 settled turn 数量判断：轮数与可缩减 token 没有稳定关系，拒绝。
- 对 stale environment 静默重试：可能在变化中的 MCP/Skill 环境内无限循环，拒绝。
- 允许 custom instructions 无条件重写 checkpoint：与 checkpoint 的容量压缩和绝对缩减不变量冲突，
  拒绝；若未来需要 narrative editor，应建立独立命令与验收契约。
- 只依赖 SQLite busy timeout：它只能串行数据库写锁，不能保证多个内存 Kernel 的 revision/lease 一致，
  拒绝。

## 后果

- 短会话和无新增 source 的连续命令不再产生模型费用或通用 recoverable error。
- Environment drift 会留下一个可诊断、可重试且已收敛的 durable fact，不会形成永久 pending。
- 同一 session 的重复手动命令按提交顺序执行，不会由多个 standalone Kernel 竞争 snapshot。
- `stale_context` 扩展 context compaction error kind，但不改变 Runtime schema version；事件 JSON 仍是
  向后兼容的字符串字段。

## 回滚

可以移除 best-case preflight、App 串行器和 `stale_context` producer，并恢复 ADR-0022 的 silent
discard；回滚时必须同时恢复旧提示和测试。不得只移除 failed event 而保留一次性 standalone executor，
否则会重新引入永久 pending。
