# TUI 会话导航与历史

产品预期见[会话操作](../../../docs/handbook/clients/tui/guides/sessions.md)。实现入口为[SessionNavigationAuthority](../src/tui/session-navigation.ts)、[SessionSelector](../src/tui/components/SessionSelector.tsx)及[TUI bootstrap](../src/tui/index.tsx)。

历史读取通过 injected HistoryClient 向前分页取得 closed transcript，再进入与 live 相同的 reducer；subscription replay/gap snapshot 不能替代完整历史。打开历史先等待 typed readiness/recovery，随后才提交 navigation。

load token 只允许当前请求提交。切换到已注册会话会使旧 load 失效，同目标第二次 load 也取代第一次；迟到成功、错误和 rollback 都不能覆盖新选择。模型、模式、context 和 Runtime projection 按 Session 恢复，不继承上一 Session transient state。

普通切换不取消后台 Run。异步 slash 结果绑定发起 Session 与 turn count，不能把本地尾部写入后来选择的 Session。队列绑定 Session，见[输入与命令](input-and-commands.md)。

删除当前 Session 后建立新的可输入 Session；删除不等于恢复工作区文件。`/rewind` 的确认与执行分别防重复，历史恢复先完成数据与 writer 准入，再交给展示；不能把旧 viewport 当成新 fork 已完成。

验证：[导航竞态](../test/session-navigation.test.ts)、[PTY 切换](../../../tests/tui-system/scenarios/session-switch.test.ts)、[会话持久化](../../../tests/tui-system/scenarios/session-persistence.test.ts)。
