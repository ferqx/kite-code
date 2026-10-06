# Agent Note: TUI 普通文字与回车的合并输入

Status: implemented

## Problem

普通 Enter 应提交当前草稿，但真实 PTY 中先写文字、随后写回车并不保证 Ink 收到两个事件。当前安装 parser 会将普通文字和尾 CR 保存在同一 native input 中，只有单 CR 被标记为 Return。原 Composer 因此将回车保存为正文，任务仍 Idle；原导出测试在业务开始前超时。主输入还必须保留文件候选首次补全、完整命令路由与 bracketed paste 的原换行，不能用修复普通提交改变这些行为。

## Decision

[Composer 接缝](../../../../packages/ui/src/tui/composer-input.tsx)只识别无 Ctrl/Meta/Shift、非空普通前缀不含 C0/DEL 且恰有一个尾 CR 的 native input。它先将前缀写入原 buffer 并同步 controller 草稿，再沿原 Return 分支处理。Return 重新取得更新后的 slash 候选和 file token，ready paths 必须匹配当前 token key；新引用或编辑后的引用等待其原只读结果，补全后另一次 Return 才提交。

真正 bracketed paste 仍由独立 usePaste 消费，原 CRLF、Unicode 和 Ctrl 字节只是正文，不自动提交或取消。已有[原 question 的 pure Ctrl+C 与 paste 边界](../architecture/2026-10-06-original-question-schema-forms.md)继续适用；本次没有替代 question、审批或辅助面板输入。实际目标、stale/unknown、准确 Command 与持久申请由原 controller/host 拥有。

当前行为由[输入指南](../../../../docs/handbook/clients/tui/guides/input-and-queue.md)与[TUI owner](../../../../packages/ui/src/tui/README.md)维护。

## Alternatives considered

- 只延迟原 PTY 的回车或增加等待期限：输入块合并是实际 native 输入行为，延迟不能保证事件边界，等待也不会提交已保存为正文的 CR；因此保留原测试的输入和期限，修复生产接缝。
- 在所有输入中拆分控制字符或建立通用键盘路由：会扩大 Ctrl、组合键和其他面板语义；当前缺陷只需普通前缀加一个尾 CR，因此限定主 Composer 的这一组合。
- 插入前缀后沿上一帧候选处理 Return：旧 ready 文件路径可能被用于新 token；改用刚更新的 buffer 与准确 token key，不通过延迟提交等下一帧来重新绑定目标。

## Consequences

普通一次提交与 slash 路由沿原 controller 合同，文件首次补全和 paste 保真保持。只识别有限 native 输入形状，其他控制组合没有新增解释规则。

[实际 Ink 回归](../../../../packages/ui/test/tui/controller.test.tsx)在原实现复现三个失败；修复后的 editor/controller 三文件 48 tests / 363 assertions 通过。原[真实导出 PTY](../../../../apps/cli/test/isolated/tui-export-host.test.ts)无文件改动，保持30秒步骤和90秒总期限，1 test / 13 assertions通过，保9MiB全文、reasoning、0600、原Store/Run及正常生命周期。运行版本、原失败与整体未覆盖范围见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。这些有限结果不代替当前完整默认图或其他平台/终端组合键资格。
