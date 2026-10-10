# Agent Note: 完整来源请求的检查点内捕获

Status: implemented

## Problem

主Run承诺没有工具调用的累计额度，但来源请求Map曾在256个不同完整输入后结束任务。同一工具的不同文件目标可以引入不同祖先指令；删除旧请求或按工具名合并会丢失后续新鲜性核验依据。简单逐项捕获又会在每个检查点重复读取相同目录、Skill catalogue和计划；历史恢复还需要从完整旧Model输出重建这些请求。

## Decision

Runtime保留定义ID与完整输入语义摘要对应的原请求，移除请求累计256门禁。宿主`ContextSources`和扩展`Extension.context`可选`captureBatch`，接收当前检查点的全部原请求；没有选择批量回调时保持原逐项捕获。批量不是按工具名挑代表输入。Core仍核来源格式、同ID摘要一致及最多256个当前唯一来源；扩展仍核全部原Session、自有namespace及每次最多128项，并强制低权限user。

默认项目来源只在一次批量捕获内复用可信Workspace root、已核目标链/目录和实际指令字节。每个原请求保路径/NUL/越界/depth/target/directory/byte限制；目录并集不冒充单请求，实际字节仍核nofollow、原文件实体和UTF8。下一检查点重新捕获，新增指令和同mtime/大小的重写不会借跨检查点缓存获得资格。Service同次复用Skill catalogue及已加载正文，Planning同次读取真实计划；所选MCP仍逐原请求走原scope/read-set，Workflow fence保持。

安全接续完整旧来源与全历史CAS归[原Run决定](2026-10-02-durable-run-resume-checkpoints.md)，不在此增加恢复资格。当前实现由[Runtime owner](../../../../packages/agent/README.md)、[Service owner](../../../../apps/service/README.md)与[跨包边界](../../../../docs/active/unified-agent-boundary.md)维护。

## Alternatives considered

- 保留累计请求256限制：把请求种类当主任务额度，与现行执行手册冲突。
- 按工具名合并或驱逐旧请求：不同输入对应不同实际文件祖先、扩展贡献和来源，无法保持完整原依据。
- 所有来源持续逐项捕获：正确性可保持，但重复读取同检查点的公共目录/字节与计划；扩展保留此兼容入口，已知默认owner选择完整批量。
- 按mtime/size或跨检查点缓存：无法发现同metadata的实际字节重写及新增祖先指令，不能用于freshness。
- 一次合并所有目标后套单请求目录预算：将多个合法请求的并集误判为超限；仍逐原请求验证预算，当前真实唯一来源另由Core限额。

## Consequences

长Run保全部不同输入来源，来源Map及准备成本随原请求种类增长；批量减少本检查点的重复I/O，没有承诺内存恒定或任意规模固定时延。文件捕获与后续SQLite/外部效果不是原子事务，原实际派发新鲜性与文件安全校验仍必需。这个决定不改变Provider单次能力、child每个新Run的30分钟期限、权限/取消/read-set/未知效果守卫。

## Verification

默认paired Service、公开Client和compatible SDK在同一原Run完成257次不同Files读取，完整原指令进入18个真实请求，两次cold只读保275个原执行及零重放。恢复原累计guard时，同一完整用例以`context_source_budget_exceeded`失败，脚本finally精确还原。原项目来源完整文件7项/34断言，扩展完整文件5项/281断言覆盖不同输入、刷新、namespace/数量/摘要/scope拒绝。实际19个唯一完整文件90项/7222断言及保留失败归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10长-run-完整来源与原任务安全接续)；不把该限定macOS证据当installed全客户端、RSS/观测、平台或阶段完成。
