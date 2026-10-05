# Agent Note: TUI 原身份草稿与退出保存边界

Status: implemented

## Problem

V1.3 要求真实未提交文本持久化，并在会话删除、恢复换 Store 或提交回复未知时保留原内容。异步提交与会话切换可能交错；仅比较文本会把“修改后又改回”的新编辑误作旧提交。多 TUI 宿主还可能同时编辑同一 profile，Service 崩溃不能使仍活着的编辑器失去维护协调。

## Decision

[CLI 文件 owner](../../../../apps/cli/host/tui-drafts.ts)用闭合 v1 `ui/tui.json` 保存原 Store/Workspace/Session、Decimal64 revision 和完整未提交文本。记录 ID 由完整三元组派生，原关联不存在或恢复后 Store 改变时仍可只读查看，不重绑、不填入当前编辑器、不自动发送。此文件不虚构主题、语言、待执行队列或审批答案。

[编辑接缝](../../../../apps/cli/host/tui-draft-port.ts)以180ms合并文件发布，切换、EOF和退出同步最后编辑。每次发布取得原共享 lease 下固定用途短锁，核对文件摘要和原记录版本，私有权限下原子发布。格式损坏、未来格式、链接或容量超限保留原字节；竞争失败保留本地输入，不拿新版本自动覆盖。16MiB与4096记录的上限明确失败，不淘汰或截断旧记录。

[共享 TUI](../../../../packages/ui/src/tui/controller.ts)按原 scope 与本地编辑版本记录提交。只有原命令 accepted/applied 才清除准确原编辑版本，未知结果等待原命令核实；包括成功后切换视图的 slash 命令，也只消费原命令文本。并发新编辑、ABA文本及原先不同的未提交草稿不能被迟到成功删除。

正常 Ctrl+Q 或 `/exit` 最后保存失败时保持编辑器和宿主共享 lease，显示保存失败；不能在 flush 返回失败后仍关闭并丢失唯一内存文本。SIGTERM 属于强制退出，保存失败返回1，不宣称落盘，也不能承诺强杀保存尚未发布的输入。`/drafts` 只列磁盘上的持久记录，冲突的本地文本继续留在编辑器中，不冒称目录已保存它。

宿主从打开 UI 到完成最后文件操作独立持有[profile 使用锁](2026-10-02-private-ui-profile-use-lock.md)。配套 Service 死亡保留本地编辑器与共享 lease，维护仍应 busy，直到宿主实际退出。离线备份和恢复采集原文件及原身份，不替换为新 Store。

## Alternatives considered

- 每个按键重写完整JSON：大草稿产生重复 I/O，因此合并编辑并在明确边界同步。
- 只比较提交前后字符串：无法识别 ABA 新编辑，因此使用原编辑版本。
- CAS冲突后刷新revision并覆盖：会丢失另一个宿主的文本，因此保留两边原内容并显示失败。
- 最后保存失败仍正常关闭：可能删除唯一的本地文本，因此正常退出被阻止；强制退出单独报告失败。
- 恢复后按Session ID重新关联：会混淆新旧Store身份，因此旧记录保持只读原关联。

## Consequences

草稿与业务提交回执各自拥有身份和保存边界。编辑器中的未保存文本不等于磁盘目录中的持久记录，目录只读查看不赋予发送权。固定容量失败需要用户保留当前文本，不通过自动淘汰降低数据保留约束。

[文件与CAS测试](../../../../apps/cli/test/tui-drafts.test.ts)覆盖9MiB全文、100次编辑合并一次发布、损坏/权限/链接/容量与竞争；[UI测试](../../../../packages/ui/test/tui/drafts.test.ts)覆盖原版本清除、ABA、删除保原文和迟到Fork；[实际包外PTY](../../../../apps/cli/test/isolated/tui-drafts-host.test.ts)覆盖冷开、Service强杀后维护busy、保存冲突阻止正常退出、强制退出失败及恢复旧关联零Provider。当前证据限macOS开发制品，正式入口和三平台资格仍由[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)记录。
