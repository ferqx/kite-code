# Agent Note: 工具定义的会话范围与稳定策略绑定

Status: implemented

## Problem

单一命令摘要和完整单次 policy revision 无法表达文件 edit 批准后对同位置 write 新正文的许可，也不能精确描述 worktree create 的父目录直接子项。把每种领域算法放进 Loop、Interaction 和 SQL 会要求新增工具时改写核心；若直接忽略完整 revision 的某些字段，又无法证明旧批准仍满足当前策略。授权复用还必须与独立 checker、用户撤销及未知效果区分。

## Decision

有限范围由相邻工具 owner 产生，可信宿主绑定真实定义对象与准确 kind/id/version。核心只处理规范候选、冻结 options、稳定策略 bindings、当前许可和原最终派发事务。范围授权保存原卡/原定义/原完整输入/accepted revision；消费定义另存，不能把来源 edit 伪装为 write，不能拼接多个授权。正文、baseline 和单次完整 inputDigest 不进入稳定 revision，当前调用仍各自完整核验。

所有真实 AND 参与策略都须为每个能力提供稳定许可，包括已 allowed 的一侧；双方待批候选精确相交，独立 checker 和明确人工条件继续保留。grant 满足默认审核须由工具行为与当前可信策略显式声明，不能因工具名称或存在范围授权而跳过 checker。最终派发仍核 Session epoch、控制、owner、原批准及必要条件，不由 SQL 运行领域 I/O。

规则采用静态可信装配，不建立持久注册表或激活代次。规则暂时缺失/不兼容时不消费；相同兼容合同恢复后，尚未撤销且满足当前策略的授权可以再次使用。A→B→A 不当作用户撤销；明确 clear 的单调 epoch 与 revoked_seq 则永久阻止旧授权复活。语义不兼容的规则更换已确认合同身份，不能按标签猜测等价。

最初采用格式2与新版-only交付时移除旧 child 审核的回执解析、公开 Store 适配、ownership 交接、context 排除和最终派发映射；当前 check 的人类／审核投影、Artifact 归属与准确 fencing 保留。它部分替代[无 child 内部模型决定](2026-10-22-internal-model-calls-without-child-agents.md)中历史兼容部分，不把不支持的旧结果映射为新批准。

2026-11-07 用户确认当前尚未投产，仅将本次改造的 Store 与内部审核回执编号统一还原为1，API 继续 `/v1`，既有 Tool／Job、Native 私库、备份清单及其他独立版本保持。当前 reviewed schema、行为绑定、归一答案和最终派发／恢复链不回退；同为 major 1 的历史旧结构仍不取得兼容资格。Profile 另保存本轮 baseline 的 schemaChecksum，在 SQLite 打开前拒绝旧标记，避免拒绝旧库时改动其 WAL／SHM；数据库完整 schema 与 migration checksum 仍独立核，清单指纹不授予执行权。

本决定部分替代[持久权限控制决定](2026-10-02-persisted-permission-controls-and-dispatch-read-set.md)中专用 same_command、全输入缺省和“当前必须展示选项”的范围消费合同。该决定的 Store/subject/真实 Session、控制 CAS、原意图查询、最终 read-set 和撤销竞态理由继续适用。当前实现与完整字段归[权限 owner](../../../../packages/agent/src/permissions/README.md)和[grant owner](../../../../packages/agent/src/storage/sqlite/permission-grants.README.md)，不从本 Note 推导客户端或平台验收资格。

## Alternatives considered

- 保留 Shell 专用授权并为 Files/Worktree 另建状态机：未采用。重复接纳、撤销与恢复链，新增工具还需要改核心。
- 按完整单次 revision 匹配，或从旧 revision 删除正文字段：未采用。前者无法跨新正文复用；后者没有真实稳定策略结构，也无法表达所有 AND 上限。
- 采用持久 registry generation、A→B→A 永久失效和全局激活 owner：未采用。用户选择同合同恢复时可重用；明确撤销已有 epoch 机制，不需要第二个控制面。
- 仅命中 scope 就跳过审核：未采用。人工范围证明与模型风险判断不同，独立 checker 和明确人工条件必须继续执行。

## Consequences

统一候选和 optionId 减少领域特例，但工具 owner 必须提供准确、有限、可兑现的 scope；缺少规则或稳定许可就只保留单次。文件位置与本次 baseline 分离，原子替换不自动永久撤销位置授权，冲突仍零发布；worktree create 另外固定真实 commit 和父目录身份，变化时零 mutation。clear 与 dispatch 的先后由原事务决定，不承诺撤销已经发生的效果或用 grant 重放 unknown。

真实 Runtime/Worker、跨定义新正文、第三工具拒绝、独立 checker、Session 隔离、clear 派发竞争、输入事务故障和冷读验证沿上述 owner 链接维护。记录中的统一机制不替代真实模型性能、完整客户端过程或其他平台资格。
