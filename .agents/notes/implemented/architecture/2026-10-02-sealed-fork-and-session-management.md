# Agent Note: 原 Session 管理回执与 Fork 历史出处

Status: implemented

## Problem

Fork 复制历史到新 Session，却不能把原 Model Execution、BodyRef、审批或外部效果改成新 Session 的 authority。直接用复制后的 sessionId/runId 读正文会使 >17MiB 的合法原输出无法打开；若相信业务 JSON 自报来源，又可能绕过原主体和 Artifact 范围。Session 管理的回执也不能因后来标题或删除状态改变而悄悄变成另一意图。

该决定适用于新统一 Agent 的 Core/Store/HTTP/Client，旧正式调用者仍遵循其当前负责文档。它保留[数据操作删除决定](2026-09-29-data-only-session-deletion.md)的“不等待资源收尾”理由；本切片软删除保留历史，物理 GC 和 Workspace 批量资格尚待实现。

## Decision

Fork 保存新的 `session.create` Command、准确源 selection/上界及新 Session 身份。消息 SQL 保存原 message ID，出处遍历核 creator/主体、角色、状态、source 和原 Parts，不把公开 JSON 当许可。公开 `originMessage` 只含原 Store/Session/Message/Run；完整 Model 输出仍由原 Execution scope 读取和校验。新显式 Run 完整展开原正文/Tool 配对，旧 Run/Execution/owner/授权不复制，旧外部效果不重放。未来 Part 原样保留，公开预览标明不可解释，继续请求在 Provider 前拒绝。

重命名和删除按原 root creator、准确 Store、Command ID 和 Decimal64 `ifRevision` 在同事务 CAS。原 ID 重试返回保存的 Session 提交快照，不以当前元数据替换；改变原字段为 conflict。Client 发送前克隆原意图，收到响应核持久命令、修订、原 Session 和回执内容；物理丢回复或不可信回执只查原命令，不自动 POST。

删除一个事务保存整组 tombstone、真实毫秒 deletedAt、停止边界和已有工作取消标志，最终派发/迟到创建事务复核。Runtime 只通过既有观察路径停止其实际拥有对象；管理 Runtime 不取得另一 owner 或调用 Provider。`delete_requested/stopConfirmed:false` 不把请求当停止或把 unknown 改成功。目录隐藏后准确旧 ID 历史仍可读。

## Alternatives considered

- 用复制后新 Session/空 Run 去验证原 Model 输出：真实 HTTP/DOM 接入显示其破坏合法完整正文读取；改写原 BodyRef 或旧 Execution 则破坏不可变事实，故保留原 scope 并提供已核出处。
- 接受消息业务 JSON 的 `forkOrigin` 声明：它是低信任内容，无法证明原 creator/主体和 Parts。SQL 保存的复制关系及一致读验证才能提供出处。
- 管理回执返回当前 Session：第二次重命名会改变第一次意图的查回结果，无法安全判断断线后的原提交。保存原提交快照并严格核 command digest。
- 删除等待所有资源终态或先消除 unknown：不符合数据操作与迟到派发关闭要求。先保存 tombstone，再交真实 owner 收尾；未知保留其实际结论。

## Consequences

Fork 和历史读取不初始化 Provider。普通 Model output snapshot 的 body/hash/原请求事实不变，`snapshotCursor` 仍反映每次实际一致读水位。默认扩展业务状态 omit 明示，copy/rebuild 不能从这项出处推导执行资格。

当前验证包含 Core Fork 5/111、管理新场景 3/51 与取消/child 组合 15/166；真实公共 Fork >17MiB 1/38、Session 管理物理丢回复/回执篡改/CAS 1/42、SDK Fork 1/15 和共享 Model output DOM 5/31。第二 Runtime 提交删除，原 owner 停止真实 Tool/Job；Cookie 和 readonly cold 读原正文零 Provider。正式调用者、完整恢复/GC/export、扩展生命周期及平台发行资格按[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)继续核实。


## 后续 namespace 与原文导出

[Namespace Fork](2026-10-02-namespace-fork-provenance.md)已补上可信 copy/rebuild 与派生资格；[原始导出](2026-10-02-session-export-frozen-read-set.md)保留未知原文和来源。两者沿用本记录的 sealed 原正文、主体与原命令边界。原段落中的待验证范围反映该切片首次交付时点，当前完整状态回到[实施证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。


## 正式 TUI 目录删除确认

正式 Terminal 与开发 TUI 的 `/resume` 使用同一公共单会话删除边界。先读目标 root 控制元数据，再核原 Store/Workspace/Session 和控制 revision；确认默认保留，不先切换目标或加载其历史。这样用户在 A 运行期间确认删除 B 时，准备确认不会变成对 B 的 resume，也不会把后续意图绑定到 A。搜索、取消确认和主草稿都由本地视图负责。

删除失回复沿既有管理意图保存原 Command ID，重开只展示未知，显式 R 才查询原结果；确认当前会话已受理删除后，新建回调最多一次。意图仍在当前进程的有限管理 map，不建立另一个冷恢复协议。新建／重发一条删除去“恢复确认”会改变原意图；先选中目标再确认会改变前台和草稿作用域，均未采用。`delete_requested` 保留停止未确认，工作区批量删除和物理 GC 仍是独立的未实现范围。

验证由[选择器测试](../../../../packages/ui/test/tui/session-chooser.test.tsx)和[正式共享终端](../../../../tests/isolated/unified-agent/formal-terminal-entrypoints.test.ts)覆盖。后者使用源码外完整候选、真实 80×24 PTY 和实际 SQLite，核默认零删除、仅 B 的原 Command、A 的活动 Run／取消标志保持和两个原 Run 最终完成；平台、完整阶段与剩余删除能力仍回到当前进度。
