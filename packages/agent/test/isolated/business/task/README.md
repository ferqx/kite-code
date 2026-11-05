# 子 Agent 协作测试

当前测试使用真实 Runtime／SQLite 和六个协作工具，或者明确的通用 Operation 扩展；没有旧 Task 执行夹具。合同归[协作 owner](../../../../src/extensions/task/README.md)。固定模型证明实际目录、输入与持久事实，不替代真实 Provider 或客户端过程验收。

| 场景 | 测试与断言 |
| --- | --- |
| 六工具与身份 | [collaboration-surface](collaboration-surface.test.ts)：实际目录、丢响应重试、queued 引导、idle 复用、直接父子和错误三态 |
| 创建／续作准备失败 | [preparation-failure](preparation-failure.test.ts)：可信未受理说明进入下一模型、原身份二次核对、并发唯一受理、原子结果保真；取消、清理未确认、读取失败和受理后异常不冒充未受理 |
| 单层创建拒绝说明 | [creation-denied-feedback](creation-denied-feedback.test.ts)：可信拒绝明确让子 Agent 交回父 Agent，同码后置异常不冒充未受理，原 call/source 和英文原因进入下一模型 |
| 首次激活 | [collaboration-first-activation](collaboration-first-activation.test.ts)：取消前零派发证明、稳定 Session 复用、历史和实际输入 |
| 邮件 | [mailbox](mailbox.test.ts)：父子双向全文、唯一低信任来源、事务回滚、未知／取消目标和冷只读 |
| 统一邮箱 | [unified-inbox](unified-inbox.test.ts)：引导与 typed 邮件同轮汇合、active 结果唯一 Source、idle 通知权限及损坏 marker 拒绝 |
| idle 接纳 | [mail-adoption](mail-adoption.test.ts)：51封邮件跨页、明确新轮与双水位、重试不扩集合、晚确认留队及根停止 |
| 问题及追发 | [question-loop](question-loop.test.ts)：父普通完成后 child 有限观察、如实待决、答复与 follow-up 进入原 Session、压缩和取消 |
| 观察 | [collaboration-observation](collaboration-observation.test.ts)：多 Agent 分页、压缩、完整来源、固定上界、游标缺口及冷读零重放 |
| 后台结算 | [attached-job-settlement](attached-job-settlement.test.ts)：attached 排队／运行 Job 等待、detached 独立、取消和 close drain |
| 文件协作 | [collaboration-files](collaboration-files.test.ts)：兄弟冲突、fresh read、部分成功及未知发布不重放 |
| 交付纠错 | [delivery-correction](delivery-correction.test.ts)：准确原委派、错误文件读回后同 child 明确续作、真实 baseline 修正原目标、原 GET 仅一次、idle 消息不激活、旧结果不冒充本轮完成；正常交付、权限拒绝及未知效果均可按事实正常停止 |
| 原配置继续 | [collaboration-config-continuation](collaboration-config-continuation.test.ts)：A/B 配置切换后原 A 结果、当前权限及唯一 Source |
| 冷结果交接 | [collaboration-cold-report](collaboration-cold-report.test.ts)：结果订阅、明确继续和原历史来源 |
| 公平预留 | [capacity](capacity.test.ts)：ChildSlots 预留与释放 |

[child-tool-evidence](child-tool-evidence.test.ts)核宿主证据封存、完整结果和有界预览；父级仍需核关键来源，工具成功不证明主张正确。[human-work-runtime](human-work-runtime.test.ts)核普通输入不触发旧自然语言分类控制链。

[原结果恢复 Store](../../recovery/job-report-resume-store.test.ts)与[Runtime](../../recovery/job-report-resume-runtime.test.ts)使用当前 agent_completion 邮箱订阅，核原配置、当前授权、原义务继承、事务回滚、停止和资源释放。[执行组恢复](../../recovery/run-resume-group-runtime.test.ts)以隔离固定 Operation 扩展制造真实崩溃点，不恢复旧 Task 参数；原 carrier／Run、审批、排队、后代配置生命周期与 unknown 拒绝均保留。

2026-11-03，Windows x64／Bun1.4.3：本轮当前协作目录79项通过，修复后的原结果恢复／通知／Service装配五文件38项通过，执行组恢复19项通过。后台目录与工作交接两文件12项通过；TUI、Desktop、Web按各自隔离进程验证，不能把共享DOM全局污染或目录名匹配到dist历史副本当作产品回归。根及八workspace类型检查、正式Agent构建、API／边界／归属／文档门禁通过。

本轮没有取得完整终端制品与千级压力资格：[源码外打包](../../../../../../apps/service/test/isolated/task-packaged-default.test.ts)在业务启动前被Windows artifact_scope_denied拒绝；[1003子Agent顺序复用](../../child/history-runtime.test.ts)修正Windows临时profile创建后，在原250秒上限内只完成约590项，原数量与期限保留。其他通用child十文件中的66项通过，不以这些通过覆盖未完成的压力范围，也没有因此恢复旧Task或放宽权限／unknown门禁。
