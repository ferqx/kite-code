# Agent Note: 当前 TUI 材料与底部控件的原生滚动

Status: implemented

## Problem

[终端手册](../../../../docs/handbook/clients/tui/guides/terminal-behavior.md)要求状态刷新保留上滚阅读位置和原正文。[完成正文决定](2026-10-06-completed-tui-scrollback.md)已将稳定前缀交给 Ink，但完整活动正文或长待决问题仍在动态帧。真实80×24 PTY 中，35行原问题与 running Tool/原 Run 同时存在，上滚后仅改变连接状态或编辑输入便输出3J、重发完成正文，viewportY从290变为0；原题目末行仍在，失败是阅读位置和重放。较早活动项后的完成项也必须保留原展示顺序。

现行[工具指南](../../../../docs/handbook/clients/tui/guides/tools-and-subagents.md)与[键盘参考](../../../../docs/handbook/clients/tui/reference/keyboard.md)还要求空 Enter 切换当前尾部结果、Ctrl+T 查看已保存思考。当前共享正式 renderer 原先没有接这两项：空 Enter 只到无效果的 send，reasoning 已能读取／导出但不展示。真实按键先复现两项失败，不能以历史完整回归通过覆盖手册承诺。

## Decision

[TuiHistory](../../../../packages/ui/src/tui/index.tsx)将当前消息、非Model执行及原卡材料全部按原展示顺序交给同一 Ink Static，每项固定该次实际材料版本。状态、选择和草稿只改变底部控件；原正文/全文/执行结果或原卡身份、题目步骤、附件改变时仍替换展示代次。Static 保持在各面板共同布局的首项。此决定部分替代完成正文决定中的连续稳定前缀和活动动态尾部；该记录中 Ink 自有 writer 清理、完整 snapshot 与只读边界的理由继续适用。

既有空主输入 Enter 与 Ctrl+T 由同一 TuiSessionView 接入。折叠位只以原 Store/Session/Execution 为键，思考展示位只归当前宿主 Store/Session；不另存业务正文。同会话刷新、输入和清屏后结果版本变化保留选择，切 Scope 重置，只在完整 snapshot 删除原执行时清折叠键。空 Enter 只隐藏结果正文，原标题／ID／状态仍在；非空 Enter 保原提交。Ctrl+T 沿既有 loadOutput 与 loadedOutputBodies，未读时只读当前尾部 assistant 的原完整输出；已读复用同一原结果，卡片／面板焦点不接管，unavailable／unsupported 明确显示。主动显示选择成为 Static 材料的展示版本变化，继续用原 writer 替换代次，普通状态与编辑仍不重发。隐藏思考不删除已加载原文或改变既有导出输入。

[QuestionMaterial](../../../../packages/ui/src/tui/question-panel.tsx)保留完整原题目、选项文案/描述与稳定序号；底部显示当前题号、选择序号/Custom；私有 TuiAnswerInput 由普通自由输入及复杂 question 的原 JSON 共同消费，只显示光标附近五个 ComposerBuffer 行。复杂问题草稿沿完整 interactionKey 保留并复用 ComposerBuffer；Enter 仍通过原 controller 解析原 JSON 值，Shift+Enter 换行与方向键/Home/End 编辑不提交中间答案。缓冲区及折叠 paste 保持完整原文，普通步骤的原 Up/Down、Enter、Esc、Shift+Enter 和原值提交语义保持。显示与键盘移动共用当前列宽和本地化 Answer 前缀；软换行边界沿 row 的当前行及 endAffinity 只画一个光标，不建立新的阅读按键或数据协议。

原 schema、附件完整读取、stale/loading、未知原回答命令及原 Store/Session/card/revision 仍由已有 controller 和宿主拥有。当前完整实现归[TUI owner](../../../../packages/ui/src/tui/README.md)，实际消费者范围归[CLI owner](../../../../apps/cli/README.md#tui-原生滚动与清屏)，用户操作归[问题指南](../../../../docs/handbook/clients/tui/guides/approvals-and-questions.md)。

## Alternatives considered

- 仅提交连续稳定前缀：保留了原顺序，却不能阻止当前活动或待决长尾使动态帧超高；本次真实状态/输入反例要求把原材料与动态控件分开。
- 只提交所有已完成项：既有 Ink 反例将后来完成项提前到较早活动正文前，仍不满足原顺序；当前方案提交所有当前材料的固定版本。
- 将活动文本视作永久只追加的前缀：实际 Agent 在超过 inline 阈值后会切换 artifact preview，公开 Message.content 不保证单调增长；使用真实材料版本替换，未新建稳定前缀 DTO。
- 继续完整打印复杂 JSON 草稿：30项Unicode JSON paste在实际PTY发出3J并重发材料；保留完整原值、复用已有答案窗口及字符簇缓冲区即可解决，未为JSON建立新输入模型。
- 建立应用内视口、历史缓存或新的阅读键：已有完整 snapshot、Ink 静态字节与终端原生滚动足以解决本次状态/输入反例；未增加第二份历史权威或公共接口。

## Consequences

新增两项真实按键覆盖空／非空 Enter、排队原文、同会话刷新、clear 后版本变化、思考缓存／原文控制字符、焦点及跨 Session。完整本机 Terminal 候选包的正式 entrypoints/tui.js、包内 Bun/Service 与默认 Profile 从 checkout 外的真实80×24 PTY 另核9MiB原全文、准确尾部 Artifact refs 收起／展开、原 reasoning 显示／隐藏及两次0600导出、Provider精确2次与原SQL事实和所属正常退出；17个断言通过，原90秒预算保持。夹具独立 SQL reader 在首DB前核并选择候选的完整 SQLite manifest/source identity。原有限port/headless VT 169断言复验，仍保状态／输入／长问题／JSON的上滚位置与零业务调用。准确运行、原红和当前完整默认归[整体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08正式-tui-的工具结果与思考查看)。这些结果不替代安装指针切换、GUI终端、其他平台或全能力退出。

实际有限port/80×24 PTY 保留90段完成正文、40段活动正文、35行原问题及60行选项描述，状态/编辑/改选不重发材料且上滚位置保持；多行自由输入与软换行另核光标。复杂 question 的30项Unicode原JSON paste及12行逐行输入也保上滚位置和零重发，原JSON值、字符簇编辑与卡/revision草稿隔离由实际键盘验证。源码外默认 Process/Service/SQLite/Client/ask_user 与 compatible Provider 仍只提交唯一原答案、保持 Unicode/空格/多行及同字自由ID，9MiB全文/导出消费者保持原全文尾部、文件和正常退出。实际运行、冻结输入、原失败及未覆盖范围归[整体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

真正的正文版本变化仍重绘并清理旧原生历史；持续流式变化的上滚位置未闭合。任意长诊断、notice/回执、审批/方案文本和其他管理面板的动态高度尚未全面验证，不能从本次有限场景推出所有帧都在视口内。GUI终端、其他平台、正式安装、完整默认图和持续Soak仍需各自证据。
