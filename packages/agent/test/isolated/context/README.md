# Core result checkpoint evidence

[sources.test.ts](sources.test.ts)继续核单请求项目指令与路径守卫，批量捕获用例提供80个完整原请求、321个合并目录，各请求仍在原预算内；最后不同输入路径的symlink拒绝整批，新检查点核新增指令及同mtime/大小字节变更。实际来源按ID去重，不能把全部请求的目录并集当单请求预算，或复用跨检查点的旧字节。默认Service的257次Files实际请求链另由[长任务用例](../../../../../apps/service/test/isolated/long-run-sources.test.ts)负责。

`result-checkpoints.test.ts` uses real temporary SQLite Workers, ordinary Tool → detached Job admission, fixed Model requests and controlled physical ledger gates. It verifies immutable dispatched requests, exact low-trust `user` result source IDs at the next checkpoint, idle reads without Model or writes, frozen completion-cursor pagination including a later lower-ID result, and late completion after original work cancellation without revival. Its trusted Store proxy only delays a real pending-page response; it does not fabricate or manually consume terminal results.

## Selected context pagination

`selection-runtime.test.ts` drives the actual single Loop through 201 paired Tools and 101 counted Jobs. The next Model request exhausts both selected-message and result-source cursors. After a rewind retaining consumed sources, 101 exact public Includes reuse their original IDs without Model or Job work; an explicit new task reads all of them. The original-work continuation fence remains intact. An earlier rewind excludes both the sources and their Include qualification while raw history and original immutable executions remain readable. The external ledger stays at 101 starts throughout, with exactly four Model requests and the original immutable body/hash checks.

[active-include.test.ts](active-include.test.ts) 使用真实 Core/SQLite 的已派发 Model 与 approval 屏障：活动选入受理但未应用时来源不出现在 selected context/resultAcceptance；旧 Model 原请求不变，下一 Model 使用准确唯一低信任 source。原 Tool 只执行一次，精确取消选入零后续 source，审批中的旧未派发 Tool 收束为 superseded 且零效果。store.test.ts 另外覆盖真实应用事务触发器 rollback、同 ID 重试零新事件、旧 Run 不投向后来前台；原 idle/restore/Rewind 证据仍保留。

[store.test.ts](store.test.ts) 区分已保留历史与新选入：同会话普通输入先读唯一完整 automatic Source，准确 Include 发布后才投影为同一身份的 explicit，原 Source 行／Execution 接纳不变。仅排除 Include 的 Rewind 恢复 automatic 读取；真正早于 Source 的边界则使其从下一 Model 消失，重查旧 Include 回执与冷读都不能恢复分支，原 Job 始终一次。活动 Include 在检查点前不取得 explicit 资格，原已冻结 Model 不变；应用后下一 Model 核完整来源，并保旧审批取消、工具未派发和零效果。

[fork.test.ts](fork.test.ts) 使用真实 SQLite/Core：新分支只复制当前所选的完整配对历史及已接纳结果来源，不复制执行/owner/扩展资格。实际下一 Model 读取原 ≥17MiB Artifact 正文和准确 source IDs；同 ID 重试零新事件、真实触发器 rollback、未来格式保留但零 Provider、空/Rewind 排除边界以及活动/未知效果的拒绝均有独立断言。公开 Fork 为 root-only，扩展 namespace 默认省略并明确回执，扩展 copy/rebuild 尚未覆盖。

[restored-origin.test.ts](restored-origin.test.ts)通过普通 Core Run、固定 Model 与一次 harmless fixture Tool 保存四条完整用户／Model／Tool 消息，明确 Fork 后严格关闭并使用公开维护备份恢复为新 Store。冷只读 `getMessageOrigin` 返回各条原 Message 与固定原 Store，消息／水位、Model 两次和效果一次保持；没有手工改 Store 身份、补来源 Run 后来状态或恢复执行。本例只证明 Core 原出处，实际默认问答与原 PC 组件资格归[安装版 Native](../../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

[compression.test.ts](compression.test.ts) 使用真实 Core/SQLite/Artifact 和固定 Model，证明手动/自动共用原 Loop、独立 Model usage、贡献→压缩→必要完成策略顺序、冲突/权限零调用、原始历史与摘要范围、完整 ≥17MiB Fork/原正文 cold readonly、损坏正文零下一 Provider。真实 Provider 故障、取消 partial、新输入、压缩/最终 Run SQL rollback 都不能发布摘要；无新历史不再次收费，reset 安全预检/unsafe 保点/零 Provider/noop 有实际断言。默认算法与上层客户端装配不由这些 Core fixture 证明。

同一 fixture 还验证完整大 focus/算法说明、可信摘要拒绝保旧点、自动 Provider 失败后旧上下文继续、未变化输入不重复压缩、新输入和手动重试。持久 SQL 失败不会降级成安全继续；未知 Part 可读历史但不进入下一 Model。reset 使用实际 Step capability 快照，目录变化仍保旧点，不能跳过 freshness。

普通输入沿原公开 Command 的 `receipt.runId` 定位实际 Run；新的 `run.start` 以原 Command 为 origin／rootWork，不因正文含“继续”或“新任务”派生另一条业务命令。历史 Source 保原出处，不能把原执行重标为新 Run。压缩的 `append` 安全反例用可信 Store 的 accept/apply 向准确维护 Run 真实提交新 Message 后再验证零生效摘要；公开人类输入在维护期间排队并不等于压缩输入已新增 Message。原 6 秒 barrier、测试预算与 finally 释放保持。

2026-10-22，macOS arm64／Bun 1.4.2，以 `89b0929ec` 加本次测试／文档修改复核八个既有失败：六项沿用已退役的 `businessCommandId`／正文选工作预期，两项沿用技术 rootWork 过滤已保留历史的旧预期；按[执行手册](../../../../../docs/handbook/features/execution.md#工作选择审批与恢复)核对后修正，Agent／Store 生产源码未改。五个文件保持原完整正文、双游标、固定水位、审批、取消、freshness、101 次实际效果及零重放断言；新增完整低信任来源及原身份、真正排除 Source 的 Rewind／旧 Include 重查反例，并在 101 个旧 Execution 的 Include 前、后及新 Run 后逐一比较，证明当前分支未取得旧接纳。全部 16 个 context 文件使用精确绝对路径、`bun test --parallel=1 --max-concurrency=1` 执行，85 项／2070 断言通过；普通输入、热冷配置、通知与报告事务四个整文件另 27 项／267 断言通过，Agent typecheck 和五文件 Biome 通过。准确日志归 `dist/acceptance/context-repair-20261022/context-final.log` 与 `direct-input-results.log`；先前失败继续保留，真实模型和桌面验证沿生产输入未变的原范围核对，不由固定模型测试重新赋予资格。
