# Agent Note: 实际 mutation 事实驱动同 Loop 验证

Status: implemented

## Problem

模型表示完成、管理 Tool 返回 succeeded 或旧一次检查通过，都不能证明最后实际文件修改已验证。逐文件注册不可撤回 RequirementRef 又会把文件数量变成 Run 的隐式额度；只依赖 Model 主动调用验证，会在停止候选和后续修改之间遗失必要义务。跨文件系统与 SQL 的结算也不能被描述为全局原子成功。

本决定仅描述新统一 Agent 的可信自动验证装配与同 Loop 完成治理，预期来自 [V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)，当前实现由 [planning owner](../../../../packages/agent/src/business/planning/README.md)维护。

## Decision

宿主明确选择准确 mutation definition/version/effects 与独立 checker；JSONC 只选择已有能力，不能启用治理 hook 或隐式授予 checker。实际装配目前为 files.write/edit@2 与 files.read@3，validation.auto_check@1 仍须普通选择。策略独立于 requirePlan/manual validation，在首个 Model 派发前封存 Run 的不可撤回义务。

Core 只提供通用 mutation/completion governance 边界。派发前登记潜在事实，真实 Execution 结算与事实状态/revision 在同一短 SQL 事务落定。事实 append-only、head 有限，具体文件通过分页读取；整个 Run 仅使用原策略义务，不按文件创建额外 refs 或累计次数限制。

普通 Tool 再调用 runless Files Tool 仍属于同一真实工作：`planExecution` 从实际 SQL 父封存原 refs，进程内评估使用该返回快照，最终派发和结算读取同一持久列。准确重放不因晚登记改变旧快照，runless 后代继续继承直属父的原 refs；最终 checker 沿有限真实 Store/Session/root work 父链核原 Run，而不是要求每个 Tool 都直接绑定 Run ID。这里修复原普通嵌套能力的断点，不新增 caller 提供的权限或第二执行链。

checker 的当前 owner/generation 控制新检查写入；已知 terminal target 只提供原事实，不因合法 resume 换代取得执行许可，也不重封历史代次。对 target 增加现行代次相等限制会误拒绝原成功工作，故只核其原 Store/Session/Run 父链及准确结果、intent/head，原 checker 写权限与 unknown 拒绝保持。

完成候选通过原 Loop 的普通 auto_check，再由 operations.ensure 派发独立获准的真实 Files read。只有当前完整 baseline/hash 与最终 head CAS 能满足义务。失败诊断作为低权限输入供模型修复并重验；known unavailable/denied checker 为 inconclusive，未确认 transport/效果保持 unknown，取消不发起修复续轮。后序同 Store/Run/路径的真实成功 mutation 可将旧 hash 验证标为 superseded，仍保存原事实，最新修改必须实际检查。

## Alternatives considered

- 每个文件一条不可撤回 RequirementRef：未采用。有限身份集合会意外限制正常多文件/多次修复；原义务与分页事实足以表达相同完成条件。
- 由模型自报 passed 或以管理 Tool 成功回执完成：未采用。它不证明独立 checker 实际读取了当前内容，无法抵抗后序修改或迟到检查。
- 在 Loop 外增加验证 manager/第二次执行调度：未采用。普通 Tool、嵌套 operation 与现有完成边界可以保留一致的权限、取消、原 scope 和监督证据。
- 把文件效果与 SQL 结算声称为全局原子：未采用。非合作文件系统写入和未知提交窗口仍须真实未知结论及恢复证据。
- 只取消 checker target 的直接 Run 限制：未采用。没有持久继承 refs 时，最终派发和同事务结算仍会漏掉嵌套 mutation；必须同时闭合继承与实际父链，不能只使一条查询返回成功。
- 由进程内 scope 或调用者传入继承 refs：未采用。使用已经核实的 SQL 父与现有持久列，可以保持最终事务、冷读和幂等重放的同一原身份，不另建可自报的继承接口。

## Consequences

已封存的治理不会因后续工厂参数移除而消失，缺 checker 也不会暗装能力或标 passed。65 次实际 mutation 的回归证明没有 64 refs 的隐式终止；同路径后序修改保留旧事实而检查最新内容。诊断、信息 receipt 和公开 JSON 都不能制造原 policy 或实际执行证明。

[嵌套 Store 门禁](../../../../packages/agent/test/isolated/storage/nested-tool-requirements.test.ts)核原 refs、晚登记与准确重放、后代继承、缺 evaluation/intent 的最终拒绝及准确 settlement；[真实 Service/Client/Files](../../../../apps/service/test/isolated/automatic-validation-nested-tools.test.ts)核普通 wrapper 的 write→edit→完整 hash 校验→原 Run 完成与冷读零重放。三平台使用同一通用路径和便携测试准备；本机实际通过仅授 macOS 所列能力，不替代后置 Win/Linux 原生资格。

[公开恢复门禁](../../../../packages/agent/test/isolated/storage/mutation-check-resume.test.ts)通过真实 cold reopen 与 verify/begin/commitRunResume，核旧 terminal 代次/结果/refs不变、新 checker 可保存 inconclusive、旧 owner写拒绝与零效果重放。该 Store 诊断不伪造 file-hash passed，也不解除原 completion requirement。

[实际自动治理回归](../../../../packages/agent/test/isolated/business/automatic-validation.test.ts) 15 tests/86 assertions、[默认实际 SDK/Files 装配](../../../../apps/service/test/isolated/automatic-validation-configuration.test.ts)与相邻 planning/permissions 18/174，以及 child/conditions 19/388 通过。本机固定 Provider/临时 SQLite 只证明所列机制；Shell network-off、MCP/外部 checker、正式业务面板、跨平台与发行资格仍未由这些测试建立。
