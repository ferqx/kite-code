# 输入、队列与命令

产品入口：[输入](../../../docs/handbook/clients/tui/guides/input-and-queue.md)、[命令](../../../docs/handbook/clients/tui/reference/commands.md)、[按键](../../../docs/handbook/clients/tui/reference/keyboard.md)。源码：[InputLine](../src/tui/components/InputLine.tsx)、[CtrlSafeTextInput](../src/tui/components/CtrlSafeTextInput.tsx)、[slash handler](../src/tui/hooks/useSlashCommand.ts)、[FIFO](../src/tui/prompt-submission-queue.ts)。

非空输入 Enter 只有 InputLine 消费，OutputArea 通过当前 prompt ref 禁止同次 Enter 展开工具。suggestion 只拥有补全，完整命令走主输入提交一次。Modal 可见时隐藏主输入和 suggestion，嵌套 Esc 按局部 owner 返回。

输入使用 display width；软换行优先显式换行、ASCII 空白、脚本边界，最后按可容纳字符。CJK/数字间空格不强制换行；光标预留列，Home/End 按视觉行，跨行移动保持目标列。长粘贴为原子占位，提交还原原文。

新 prompt 的本地 reservation 立即回显并显示 Working，不创建 Server Run identity。durable echo 原位补齐 identity；同文的独立消息不合并。失败只撤销未接受的 pending echo。

活动 Run 的后继输入先留在按 Session 绑定的 FIFO 与 Footer queued 层，不创建当前 Turn block。receipt 与 durable user.message 乱序都按稳定 submission identity 收敛为唯一用户块。runtime_busy 使用新 command identity 有界退避，revision_conflict 在同 command identity 等待 authoritative idle/cleanup 后重试；不能清空队列或取消仍运行的 Subagent。

后继 accepted revision 之前的旧 terminal 不能结束后继 Run。排队 chrome 不参与消息区高度预算，queue-only 更新不能重挂载状态行或改变展开。异步本地命令绑定 Session 与 turn count，不能把迟到结果写入新会话。

命令 metadata、解析与生产 callback 三者共同决定可用性。`/compact reset` 已接入 bootstrap 的 handleContextReset，先预检再清除 active checkpoint；失败保留旧 checkpoint。帮助中 Ctrl+E/`?` 与实际处理的差异记录在开发 backlog，不借文档修改产品代码。

验证：[slash parser](../test/tui-slash-command.test.ts)、[suggestions](../test/slash-suggestions.test.ts)、[FIFO](../test/prompt-submission-queue.test.ts)。

## 当前差异：排队失败的会话归属

上文的 Session 隔离是预期。当前 [TUI 提交回调](../src/tui/index.tsx) 捕获 submittedSessionId 并绑定队列项，但 observeTuiPromptSubmission 的 onFailure 只按 id 移除队列，然后发无 Session 的 LOCAL_TEXT；[reducer](../src/tui/reducers/index.ts) 将它追加到当前视图。因此 A 的排队提交在切换到 B 后失败，错误可能出现在 B。成功路径的身份保护不能证明失败路径同样安全。

修复需让失败投影绑定提交时 Session/queue identity，补充 A 排队→切到 B→延迟失败的断言；[FIFO tests](../test/prompt-submission-queue.test.ts) 只验证队列与回调，尚不能证明集成后的视图隔离。本轮文档修正未改变该实现。
