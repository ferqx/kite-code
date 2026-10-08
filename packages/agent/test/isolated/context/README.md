# Core result checkpoint evidence

`result-checkpoints.test.ts` uses real temporary SQLite Workers, ordinary Tool → detached Job admission, fixed Model requests and controlled physical ledger gates. It verifies immutable dispatched requests, exact low-trust `user` result source IDs at the next checkpoint, idle reads without Model or writes, frozen completion-cursor pagination including a later lower-ID result, and late completion after original work cancellation without revival. Its trusted Store proxy only delays a real pending-page response; it does not fabricate or manually consume terminal results.

## Selected context pagination

`selection-runtime.test.ts` drives the actual single Loop through 201 paired Tools and 101 counted Jobs. The next Model request exhausts both selected-message and result-source cursors. A rewind retaining consumed sources preserves their exact IDs; an earlier rewind excludes them while raw history and original immutable executions remain readable. The external ledger stays at 101 starts throughout.

[active-include.test.ts](active-include.test.ts) 使用真实 Core/SQLite 的已派发 Model 与 approval 屏障：活动选入受理但未应用时来源不出现在 selected context/resultAcceptance；旧 Model 原请求不变，下一 Model 使用准确唯一低信任 source。原 Tool 只执行一次，精确取消选入零后续 source，审批中的旧未派发 Tool 收束为 superseded 且零效果。store.test.ts 另外覆盖真实应用事务触发器 rollback、同 ID 重试零新事件、旧 Run 不投向后来前台；原 idle/restore/Rewind 证据仍保留。

[fork.test.ts](fork.test.ts) 使用真实 SQLite/Core：新分支只复制当前所选的完整配对历史及已接纳结果来源，不复制执行/owner/扩展资格。实际下一 Model 读取原 ≥17MiB Artifact 正文和准确 source IDs；同 ID 重试零新事件、真实触发器 rollback、未来格式保留但零 Provider、空/Rewind 排除边界以及活动/未知效果的拒绝均有独立断言。公开 Fork 为 root-only，扩展 namespace 默认省略并明确回执，扩展 copy/rebuild 尚未覆盖。

[restored-origin.test.ts](restored-origin.test.ts)通过普通 Core Run、固定 Model 与一次 harmless fixture Tool 保存四条完整用户／Model／Tool 消息，明确 Fork 后严格关闭并使用公开维护备份恢复为新 Store。冷只读 `getMessageOrigin` 返回各条原 Message 与固定原 Store，消息／水位、Model 两次和效果一次保持；没有手工改 Store 身份、补来源 Run 后来状态或恢复执行。本例只证明 Core 原出处，实际默认问答与原 PC 组件资格归[安装版 Native](../../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

[compression.test.ts](compression.test.ts) 使用真实 Core/SQLite/Artifact 和固定 Model，证明手动/自动共用原 Loop、独立 Model usage、贡献→压缩→必要完成策略顺序、冲突/权限零调用、原始历史与摘要范围、完整 ≥17MiB Fork/原正文 cold readonly、损坏正文零下一 Provider。真实 Provider 故障、取消 partial、新输入、压缩/最终 Run SQL rollback 都不能发布摘要；无新历史不再次收费，reset 安全预检/unsafe 保点/零 Provider/noop 有实际断言。默认算法与上层客户端装配不由这些 Core fixture 证明。

同一 fixture 还验证完整大 focus/算法说明、可信摘要拒绝保旧点、自动 Provider 失败后旧上下文继续、未变化输入不重复压缩、新输入和手动重试。持久 SQL 失败不会降级成安全继续；未知 Part 可读历史但不进入下一 Model。reset 使用实际 Step capability 快照，目录变化仍保旧点，不能跳过 freshness。
