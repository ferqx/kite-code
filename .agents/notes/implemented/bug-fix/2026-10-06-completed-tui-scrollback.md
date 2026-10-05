# Agent Note: 已完成 TUI 正文的原生滚动

Status: implemented

## Problem

[终端手册](../../../../docs/handbook/clients/tui/guides/terminal-behavior.md)承诺完成输出保留在原生历史，状态更新不重复正文或拉回上滚位置。原 renderer 将完整历史放在动态帧中；真实80×24 PTY 的状态更新清除原生历史并重放90段正文，上滚100行的读者回到底部。`/clear` 又须仅隐藏显示基线，保留历史、全文和业务状态。

## Decision

[TuiHistory](../../../../packages/ui/src/tui/index.tsx)使用 Ink `Static` 提交原消息顺序的连续稳定前缀；仅在消息全部稳定后追加连续已结束非Model执行。活动项及其后续项保留动态顺序。普通状态和输入保持同一Static实例；resize复用Ink重排。原Store/Workspace/Session、呈现偏好，或已提交正文/全文/执行结果版本变化时才替换展示代次。

语义替换在Ink提交前清理旧原生历史，使用Ink自有stdout writer恢复当前动态输入栏及光标。`/clear` 仍消费controller已有显示基线，原snapshot、全文和导出输入不变；不增加公共port、DTO、执行manager或第二份历史缓存。当前完整结论归[TUI owner](../../../../packages/ui/src/tui/README.md)，消费者归[CLI owner](../../../../apps/cli/README.md#tui-原生滚动与清屏)。

## Alternatives considered

- 保留完整动态历史：真实状态更新仍清历史并移动阅读位置，无法恢复既有承诺。
- 所有稳定项直接Static：实际Ink反例把后来完成的用户消息放到较早活动模型正文之前；改为连续前缀并在顺序变化时替换。
- 直接写stdout清屏：真实PTY显示 `/clear` 后输入栏消失；Ink未认为未变footer需要重绘。改用Ink持有的writer，让其恢复当前动态帧，无需人为更改footer版本。
- 再加历史缓存或展示台账：已有controller snapshot及Ink自有静态字节足以拥有本次边界；未引入第二份历史权威。

## Consequences

状态与编辑不再重发已完成前缀；正文替换、全文读取、清屏、切会话和偏好变化仍允许语义重绘。原顺序和输入栏成为明确回归约束，见[Ink测试](../../../../packages/ui/test/tui/scrollback.test.tsx)和[真实PTY/headless VT测试](../../../../apps/cli/test/isolated/tui-scrollback-pty.test.ts)。默认问题与实际9MiB全文/导出消费者另核原答案、文件及正常退出；当前运行与原红证据归[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

本决定只闭合完成前缀造成的状态重绘。活动或待决动态尾部超过视口仍可能触发Ink全屏清理并重放静态字节，与手册预期的剩余差异继续保留；GUI终端、其他平台、完整持续负载及发布资格不由本机有限port或局部PTY通过推导。
