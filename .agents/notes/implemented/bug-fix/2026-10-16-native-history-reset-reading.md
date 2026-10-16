# Agent Note: Native 历史 reset 保留当前只读正文

Status: implemented

## Problem

[桌面手册](../../../../docs/handbook/clients/desktop/README.md)承诺临时断线和内部恢复期间保留已有会话内容，操作等待重新核对。[Native owner](../../../../apps/desktop/README.md)的真实 HTTP 410 窗口也要求重读期间正文保留且禁写。但 `NativeHistory.select()` 用同一个 generation／epoch 判断同时控制观察有效性与活动正文，SSE 缺口增加 epoch 后会把同 Store／Session 的当前正文清空。

原真实窗口在第二次 410、校准后页被暂停时从 5051 条变为 0，尚未到释放后页或新 EOF。原断言反映既有产品要求，不能将它改为接受空页面。[阅读生命周期决定](../architecture/2026-10-15-native-session-reading-lifecycle.md)中“新 epoch 不复用旧数据”仍适用于非活动缓存和读取资格，不应扩展为删除当前只读展示。

## Decision

`NativeHistory` 分别判断原观察与当前阅读身份。generation 或 epoch 改变仍清非活动缓存；仅同 generation、Store、Session 的已发布活动正文可以跨 epoch 保留。`preview()` 刚取出的旧非活动快照不具有这个资格，不能借暂时相同的 Session 身份保留到新 epoch。

旧读取仍按准确 readId 取消、关闭；新 scope 立即发布 loading 并从序号零完整校准。取消标记和 scope 对象身份隔离迟到页及旧 finally。新 EOF 精确替换正文，包括删除已消失记录；失败保留合法前缀和此前其余阅读内容。新 generation、Store／Session 切换、确认 Store 移除与卸载仍清除相应正文。

不修改 Main 的 epoch、失效或授权判断，也不把保留正文种成新的完成资格。renderer 的发送、审批、文件入口等继续等待完整历史和当前事实；Model 正文及辅助读取仍使用各自新 scope／lease 校验。

## Alternatives considered

- 修改真实窗口断言或手册来接受清空：会覆盖已有产品承诺，拒绝。
- 删除 history epoch、跳过重读或恢复旧 readId：会混淆观察缺口与执行资格，拒绝。
- 对同 Store／Session 的所有缓存一律保留：会让 preview 取出的旧非活动快照越过失效边界，拒绝。只保留当前活动阅读身份，不改变缓存预算。
- 新增第二套历史 owner 或权限状态：现有 scope、loading、完整扫描和 Main 门禁已能表达区别，无需新增 authority。

## Consequences

这是对既有阅读行为的修复，独立于本轮[内部算法复用](../simplification/2026-10-16-owner-local-algorithm-reuse.md)。[完整 reader 回归](../../../../apps/desktop/test/native-history.test.ts)核 generation／Store／Session 隔离、epoch 的当前与非当前区别、preview、迟到页及关闭、EOF 替换、失败与重试；[真实窗口](../../../../apps/desktop/test/isolated/native-history-electron.test.ts)继续保留两次物理 HTTP 410、5051 条／超过 8MiB 全文、禁写、切换、零 Model 和所属进程退出的原断言与期限。运行证据只适用于实际执行的平台与场景，不授予其他平台或完整发行资格。
