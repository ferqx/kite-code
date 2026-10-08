# Agent Note: Workspace 原受理回执与离线无引用附件回收

Status: implemented

## Problem

原 PC 的空间移除需要一次处理全部根及子会话；逐会话循环会产生部分删除和重复等待，回复丢失后又不能用新 commandId 重做。普通目录隐藏并不证明 owned 资源已经结束或正文已物理擦除。已发布却未被 Core 引用的附件还需要明确离线回收，不能在正常历史读取或删除受理时隐式猜测。

本记录只解释当前批量封锁、原申请和孤儿附件回收决定。永久历史清理的产品承诺尚未交付；它不取代[原删除与资源收尾](2026-09-29-session-deletion-live-execution.md)的产品理由或旧路径的已实施机制。[Session 管理](2026-10-02-sealed-fork-and-session-management.md)的 tombstone／准确旧 ID 历史边界仍适用。

## Decision

在现有 Workspace metadata 保留闭合 `removal@1`，一次具名事务核全部根的原创建主体并保存原 receipt、整组 tombstone、停止边界及取消／delivery／Interaction 意图。Store 不逐根等待，不改写 unknown，不提升另一 Runtime owner。原 commandId／规范请求摘要返回同一原计数与时间，目录隐藏与迟到工作拒绝共用提交事实，无新 Core 基线表。

沿用原侧栏和 Main 原生确认，默认保留。确认后 fresh 核原 scope／名称／根，Node 在一次 FULL 事务惰性建 DB8 表并存完整原申请，然后仅 POST 一次。冷、submitting、unknown 只有原 GET 资格；恢复到新 Store 时保原字节并在 HTTP 前拒绝改绑。DB8 由专属 closed manifest v17 采集，旧 v2–v16 grammar 和 DB7 默认未移除路径保持。

显式 `collectProfileGarbage` 与 CLI GC 取得同一外置 profile-use 排他锁，核准确当前 Store与私有 DB/WAL副本，只清生成附件 namespace 中过宽限期的无引用 published／temporary。现有 `blob_ref`／`execution_output` 的引用保留；预检全 namespace，published 全量 SHA和原实体复核后才 unlink。异步扫描结束前私有副本及原源证明保持。当前确认框明确说明历史物理清理尚未完成，避免将原产品承诺说成已实现。

## Alternatives considered

- 复用逐会话删除并在 UI 等待所有收尾：循环不能形成 Workspace 原子结果，旧 ID 未知也不能成为重发依据；当前原批量事务保存一次受理事实，收尾仍由真实 owner 观察。
- 新 Core receipt 表并修改未发布基线：当前需要一个不可变 Workspace marker，现有 metadata 能明确表达并闭合解析；不为这一单项增加 schema 和基线 checksum 变更。
- 复用普通 caller Command 保存空间级请求：该 carrier 需要准确 Session，移除空 Workspace 或其全部根之后不能选另一个 Session 代替；保存在同一 Native private DB 的专属有限行，主线 UI复用而身份职责明确。
- 删除受理顺便擦附件／自动 GC：仍被历史引用的对象必须保留，在线 owner 和发布者也在使用同一 Profile；显式离线排他、准确引用和宽限边界才能限定当前回收范围。
- 用当前 Store 重标恢复申请：它会把已备份旧意图变成新 Store 写许可；保原请求字节，只允许真实原 Store 的原结果查询。

## Consequences

目录和工作封锁原子提交，但真正资源终态另行确认。准确旧 ID 历史／控制回执／正文引用／已保存草稿仍保留，GC 不实现永久关系数据清理。同目录重加使用新 Workspace ID；项目文件不删除。Node DB8 回退到不识别的新旧 builder、已发布版本样本、Windows GC和完整平台资格尚未验证，不能将本决定解释为完整 W19或V1.3退出。

实现、数据合同与实际验证由 [Native owner](../../../../apps/desktop/README.md#native-空间批量移除)、[Store owner](../../../../packages/agent/src/storage/sqlite/session-management/README.md#workspace-原子移除)、[maintenance owner](../../../../packages/agent/src/maintenance/README.md#desktop-db8-与-manifest-v17)和[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-空间批量移除与显式附件-gc)维护。双 Worker 原事务、真实 owned Tool／Job取消、实际 Node backup／restore／cold以及 SDK原回执反例均按有限证据核，不替代独立审查或整个阶段回归。
