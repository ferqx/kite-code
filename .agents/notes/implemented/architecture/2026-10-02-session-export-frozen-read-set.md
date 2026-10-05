# Agent Note: 原始 Session 导出使用冻结读集与明确完成标记

Status: implemented

## Problem

多个分页 GET 可能跨过业务提交或数据库连接变化。若把这些页面直接拼成成功文件，导出就可能遗漏记录、截断未知原文或混入不同时间的状态。完整原始记录还必须排除宿主秘密，并保持原媒体授权范围。

## Decision

采用同 Worker 的 begin/page/text/final verify。manifest 固定原 Store、根会话与主体、真实 child 关系、全局 cursor、SQLite data_version 和 11 个 section 的 Decimal64 上界与计数。每次短只读事务重新验证完整读集；观察到变化即失败，换 Worker 必须重新 begin。data_version 不保证监视任意不合作的文件改写。

导出使用显式列集合，排除配置、凭据、锁与执行 authority。未知 Part、扩展 JSON 和 Fork provenance 保原文本。实际文本列超过 64KiB 后使用原行/字段的 byte-range descriptor，不能从 payload hash 推导附件权限。Native 与 Cookie SDK 完整校验页面、文本 EOF/hash，最终 SQL proof 成功后才输出 complete。早停、取消、物理断线或错误 proof 不产生成功标记。

媒体只保原 scope 引用，沿已有 reader 独立核验；完成标记不承诺跨介质瞬间原子。TUI 已加载对话 Markdown 与数据库备份各自保留其目的和 owner。

## Alternatives considered

- 跨请求长期占用生产事务：会延长锁与 WAL 生命周期，未采用。
- 任意表导出或 renderer 解释后重写未知记录：会泄漏宿主信息或丢失未来原文，采用显式原始列集合。
- 单次无限 JSON 或只输出页预算内前缀：不能提供完整大原文，采用局部分页与文本分块。
- 仅凭 hash 读取媒体或以下载 EOF 当一致性证明：缺少 scope 与最终读集核验，未采用。

## Consequences

持续写入会让一次导出明确失效，调用者可发起新的读取；接口不会自动暂停业务。SDK 逐帧拉取，但单个待验文本的完整 hash 当前可能占用对应正文内存，不宣称常量内存下载。

[Core owner](../../../../packages/agent/src/storage/sqlite/export/README.md)、[Client owner](../../../../packages/client/README.md)分别描述读集与公开协议。[真实 HTTP/Cookie](../../../../tests/isolated/unified-agent/session-export.test.ts)2/50 包含 210 记录、9MiB 未知原文、17MiB 原媒体、私有配置排除、物理断线和冷只读零 Provider；[Core 测试](../../../../packages/agent/test/isolated/export/session-export.test.ts)还核 70KiB provenance 原字节。备份、恢复、GC 及全部导出用户入口仍按[整体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)验证。
