# Agent Note: 宿主收集与模型轮次、历史快照分离

Status: implemented

## Problem

普通 Shell 可以制作办公文件，但它的执行结束、用户文件交付和下一次编辑是三个不同结果。若靠模型补发文件清单，额外调用和重试会改变原轮次；若界面按当前路径读取，后续同名修改又会改写历史。收集失败也不能触发原 Shell 重跑或让未知进程失去原清理责任。

## Decision

每个真实 Shell 在启动前取得专属最终输出目录。成功终态与收集意图在原事务内登记，再由短 Action 安排宿主 collector；它不占模型或 Shell 槽、不产生续轮、不投递普通后台业务消息。原 producer 身份、停止证明和未知结果围栏保持，不按任务名称授予例外。

默认 Service 的 collector 能力只来自真实宿主注册和同一事务内的完整来源证明；当前 attempt、startCommand 与调用 intent 还须匹配。读取身份绑定的自有 staging、保存原 Store 的私有 Artifact/记录及清理原自有目录按内部 `read`＋`record_write` 归档分类，而不是 safeRead 或任意外部文件写。它沿原 trust/currentPolicy/注入 ceiling，不在模型 Run 中新增能力，也不要求三种模式重复批准已授权输出的内部归档。

已知未进 adapter 的拒绝只能收口为可见失败，不能恢复为新工作或通过普通“重试整理”重放；冷恢复保留原拒绝 result/revision。无重试资格与有限保留分开：私有 cleanupAfter 控制7天后清理，不能借 retryUntil 给拒绝重新开放执行；未知 producer/collector 仍不得删除。

交付按准确 Store、Session、producer 和相对路径取得稳定身份，以不可变 Artifact 保存；文件列表与来源轮次通过索引独立读取，不进入模型正文。部分成功重试只补首次冻结集合，不重新执行生产者，不把后来新增文件混入旧结果。继续编辑必须经过合法 input import 和绑定 command 的工作副本；命令受理后不能以重试或恢复覆盖已修改的副本。

原生目录枚举具有独立的有界能力。旧同 ABI addon 没有该能力时明确拒绝收集，不能退回先枚举完整目录的兼容路径。旧无限额 Files 调用保持原合同，未为局部实现升级 Tool 或 native 协议版本。

## Alternatives considered

- 让模型主动调用发布工具或在回复后补清单：将交付可靠性绑定于模型选择，并增加调用与上下文；本次使用最终目录表达意图。
- 扫描整个 Workspace 或监视所有修改：无法区分过程脚本、日志与最终文件，也扩大访问和归档范围；只收集本次准确输出目录。
- 由 producer 内联完成归档：会让原工具终态等待大文件归档；改用可恢复的宿主短 Action 与 collector，但保留原事务和权限边界。
- 将 Blob 原件作为可写输入或每次发送重新覆盖工作稿：破坏历史快照或恢复后的编辑；改为持久映射、创建时校验和受理后不覆盖。
- 为旧 native addon 默默使用无限额枚举：上层条目上限无法约束底层先物化的单目录；改为缺能力时明确拒绝。
- 新建通用 outbox、版本图或文件管理器：超出办公交付需求；复用原执行、extension_record、Artifact 与引用体系。

## Consequences

同日按用户确认的基础交互范围，新增的预览选区与PPT插入仍遵守上述分离：固定isolated world只返回有界描述，可信工具栏经有限命令操作宿主私有副本；不为文档HTML开放preload／Native bridge。曾考虑让HTML直接写回或每次插入再调用模型，前者扩大不可信内容权限，后者增加轮次且难以确定保存版本，均未采用。编辑副本作为新的准确InputFile进入原工作副本链，不伪造成Shell生产的输出，也不覆盖历史Artifact。当前范围和实际验证由[Desktop owner](../../../../apps/desktop/README.md#办公输出文件)负责。

生产、归档、另存和预览分别报告结果。列表及预览不能取得执行权；Fork只继承已验证原快照，不继承待收集任务。文件损坏、暂存过期、清理未知与平台未验证都必须保持可见，不能以另一路径成功替代。

准确状态、预算、恢复和性能证据由[收集 owner](../../../../packages/agent/src/business/output-collection.README.md)维护；工作副本与Artifact授权由[存储边界](../../../../docs/active/private-artifact-storage.md)维护；预览与完整窗口验收归[Desktop owner](../../../../apps/desktop/README.md)。本决定记录已实现的宿主与快照边界，不授予全部办公界面、三平台受管执行或发布资格。
