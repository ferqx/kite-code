# TUI 会话导航与历史

产品预期见[会话操作](../../../docs/handbook/clients/tui/guides/sessions.md)。实现入口为[SessionNavigationAuthority](../src/tui/session-navigation.ts)、[SessionSelector](../src/tui/components/SessionSelector.tsx)及[TUI bootstrap](../src/tui/index.tsx)。

历史读取通过 injected HistoryClient 向前分页取得 closed transcript，再进入与 live 相同的 reducer；subscription replay/gap snapshot 不能替代完整历史。打开历史先等待 typed readiness/recovery，随后才提交 navigation。

会话目录任一页失败都向选择器报告明确错误，不能把已读取部分或空数组冒充完整成功；读取失败不会删除原会话。启动期异步准入的 readiness Promise 在创建时即观察拒绝，避免尚无等待者时导致 TUI 退出，之后等待 readiness 的调用仍接收原错误。真实多页故障验证见[历史分页错误场景](../../../tests/tui-system/scenarios/session-history-page-error.test.ts)。

load token 只允许当前请求提交。切换到已注册会话会使旧 load 失效，同目标第二次 load 也取代第一次；迟到成功、错误和 rollback 都不能覆盖新选择。模型、模式、context 和 Runtime projection 按 Session 恢复，不继承上一 Session transient state。

独立子 Session 使用[只读面板](../src/tui/components/ChildSessionPanel.tsx)与父作用域 `childSessionReader`，不进入 `SWITCH_SESSION`、注册表或主 Composer。服务端先核对准确父子血缘，再以 `history/load_child_session` 分页读取安全历史；面板将 transcript 转为普通历史 UI block，仅供阅读。父 Session 变化使在途子请求失效，面板期间输入与全局变更快捷键禁用。验证见[面板测试](../test/child-session-panel.test.tsx)及[Runtime Client 契约](../test/isolated/tui-runtime-client-conformance.test.ts)。

Agent 邮箱状态由当前 Session 的持久事件投影为内容为空的提示。`agent.mail_accepted` 显示“已受理，等待目标读取”，`agent.mail_input_prepared` 才显示“已准备进入目标模型输入”，`agent.followup_turn_settled` 显示准确续轮结果；重复历史事件按消息或提交身份合并。父 Session 的受理提示不推断子 Session 已读取，子线程的输入和结果事实须读取其授权历史。私有正文及 Artifact 引用不进入提示。

普通切换不取消后台 Run。异步 slash 结果绑定发起 Session 与 turn count，不能把本地尾部写入后来选择的 Session。队列绑定 Session，见[输入与命令](input-and-commands.md)。

TUI 子 Agent 卡片区分创建、运行、审批等待、自动审查、完成、中断、取消和失败。会话关闭或用户取消后，本地展示先停止活动动画并等待服务核对，不将缺失的子 Agent 终态写成“已取消”或“已完成”；服务后续的真实终态仍可覆盖等待状态。仅有暂停状态而没有审批事实时显示“等待结果核对”，不提示用户批准。

删除当前 Session 后建立新的可输入 Session；删除不等于恢复工作区文件。`/rewind` 的确认与执行分别防重复，历史恢复先完成数据与 writer 准入，再交给展示；不能把旧 viewport 当成新 fork 已完成。

验证：[导航竞态](../test/session-navigation.test.ts)、[PTY 切换](../../../tests/tui-system/scenarios/session-switch.test.ts)、[会话持久化](../../../tests/tui-system/scenarios/session-persistence.test.ts)。

发布构建通过锁文件应用 `ink-virtual-list@0.2.3` 的[JSX 入口补丁](../../../patches/ink-virtual-list@0.2.3.patch)。该版本发布的 dist 使用开发 JSX API，在 production React 下会使会话选择器崩溃；补丁使用生产 JSX 入口，保留原组件行为。验证见[编译版列表回归](../../../tests/release/oss-candidate.test.ts)。
