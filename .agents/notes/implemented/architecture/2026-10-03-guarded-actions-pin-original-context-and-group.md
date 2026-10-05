# Agent Note: guarded Action 保留原上下文与完整执行组派发边界

Status: implemented

## Problem

需要物理恢复的普通 Action 不能只看单个 Run inactive 或有限 view。另一个 Run、child、runless/detached Job 或未决申请可能仍改变同一执行组；prepare 到人类 Ask 决定之间也可能出现新完整消息或选择。如果审批后用最新静止读集替换原 prepare，未被原计划消费的上下文会得到旧计划的派发权。原记录 absence 被合法 adapter 写入后再机械要求 absence，则又会阻止该 adapter 的独立后继 Job。

## Decision

可信 Host 在普通 Action prepare 注册 `requireExecutionGroupQuiescent`，实际 Store 查询绑定 root 创建主体与完整父子树。静止事实包含原组全部 active Run、pending Command 与planned/dispatching/running/unknown Execution，仅排除准确原intake/carrier。records.get/list完整投影、revision、missing与分页absence和原contextRevision一并封存；每类最多8192事实，无法闭合就拒绝。

Ask后仅刷新当前静止谓词，原records与contextRevision不替换。最终OwnedWrite派发事务先核全组静止，再核原contextRevision与records，零event/adapter失败封闭。contextRevision绑定全组实际Session/selection、完整Messages/Part revisions，排除自己的Command/Ask分配水位。guarded carrier成为持久root fence，阻挡后继Run/Execution/child/compression/resume；cancel请求或crash/unknown/cold query不解除，只有实际已知终态释放，另root继续。

最终原prepare核验通过、进入adapter之后，合法写入可消费原missing-record。子Job不继承父Action collector/guard authority，仍核原外部source和自身独立当前权限/read-set；不能把这段后继检查省掉。Core不识别Files业务ID或提供外部文件事务，业务leaf继续负责原Source/Artifact/physical baseline和per-file intent。

runless 多跳后继以最多64个实际Execution节点及准确Operation Command闭合原Action来源，包含当前与原anchor；同Store/Session/rootWork/主体、请求/取消边和已派发祖先均核，不能只比direct parent。真实authorization.review按封存purpose仅允许观察其准确planned target；这不是collector/guard或派发权限。

自身reviewer新建私有Session及完整消息不属于原Action消费的业务上下文，但只能在真实完成、唯一Run/Model、原两Command/两完整Message与parts、原selector、无额外工作/后代的纯用途闭包有效时排除context摘要。完整组安全、unknown和最终审阅/Ask证明仍核所有实际工作；新增或漂移即失去排除资格，保原pin拒绝，不改变人类回答可保存的语义。

大 reviewer 输出先由 Core 从同一次 getModelOutputSnapshot 捕获的 descriptor 沿原 Model scope 验完整 EOF，再严格解析 decision/reason。闭合六字段凭据只保存原 Model ID、完整 descriptor 摘要、原始全文 hash 与有限答案，发布为原 reviewer Model execution scope 的不可变 Artifact；carrier details 不携私有 head/subject/reference。final SQL 保原唯一 Run/Model、purpose、binding、空 tools 和终态核验，另核当前完整 descriptor 摘要、确定凭据登记的准确 scope/MIME/hash/size、inline 全文重新解析或原 carrier Artifact 的 hash/bytes/scope。冷 proof 只核已存在 metadata，不重读 graph、调用 Provider 或再发布。凭据未登记、carrier 未成功、取消、恢复新 Store 或任何当前 descriptor/身份漂移均不能建立批准。

## Alternatives considered

- 单Run inactive或getView：不能覆盖child/runless/detached与真实pending，采用完整原root事实。
- Ask后重做整个prepare并替换原pin：会让未消费的新上下文和新记录使用旧计划，保原pin仅刷新静止。
- Action持久fence随cancel或冷重开释放：不能证明效果已停止，保unknown阻挡。
- 子Job每次重核父已被合法写入消费的absence：真实未见扩展因此无法启动后继Job，改为adapter entry前最终核验，entry后继续核外部source与子自身条件。
- 把文件checkpoint名字写进Core或承诺SQLite与任意外部writer原子：违反generic边界且无法证明，不采用。
- 把继承来源仅限直接Action父节点：真实Action→Tool→Job误要求已关闭collector；改核有限真实多跳链而不传Action authority。
- 对所有reviewer或整个child组无条件排除context：额外Run使proof unavailable后仍能发生目标效果，真实反例拒绝该选择；只排除准确自身已完成纯用途闭包，其他事实仍核。

- 把大输出 preview 当全文答案：真实原 Model/carrier succeeded 且完整 EOF/hash 可读，仍误拒合法 6000 字符 reason，不能保留。
- 在 SQL proof 中打开完整 graph 并解析大原正文：把外部 I/O 和增长全文引入短派发事务，改为 Core 验 EOF 与 SQL 有限 immutable metadata 分工。
- 只在可变 carrier details 保存有限答案和原全文 hash：合法大 whitespace 使有限答案字节无法反算 raw hash，单改答案缺少独立绑定；将同一 canonical 有限凭据登记为原 Model scope 的不可变 Artifact，再由 SQL 核登记 hash/size。

## Consequences

实际原pin十例58断言、四文件26/308邻接核Ask自身可继续、另Run完整消息或selection变化不能刷新原pin。完整组原十三文件96/1251和MCP三文件12/222保各冻结scope；独立未见扩展五例294/十一文件47/631核合法消费missing后实际独立Job及外部source Ask后漂移零adapter。默认Files实际两个Run/四write、184003字节完整预像和独立runless人类Ask恢复另有1/76主链及7文件41/495去重邻接。该决定不代表全部E14/§35、默认安装与所有平台完成。

新增真实SQLite来源链28/130、Runtime审阅15/138和独立上下文负例13/83均全绿；负例保真实reviewer Model与独立Ask，额外工作明确为owned SQLite故障且逐例零目标效果/dispatch事件。原extraRun效果1、guarded自身context漂移及Skill两跳collector失败日志均保留。六文件邻接52/750通过；固定历史JS样本恢复既存准确原字节且保原SHA断言，未重建prior。大 ModelOutput 原红例1pass/1fail/29assert保留；完整输出修复后实际17/403/0，包含76039字节合法原JSON whitespace、72000字节reasoning、原Model一次/独立Ask/效果一次、有限答案与descriptor及两类登记metadata故障零目标dispatch。三个合法proof另由真实cold readonly Store查回、cursor不变、Provider不增。原来源/上下文与17MiB输出/child五文件64/429/0；冷proof不等于冷时物理graph重新EOF，未注入任意全ledger伪造或本片物理Blob损坏，不由局部资格推导全部§35完成。

现行实现与验证归[Store owner](../../../../packages/agent/src/storage/README.md)、[Host](../../../../packages/agent/src/extensions/host.ts)、[完整组测试](../../../../packages/agent/test/isolated/storage/execution-group-dispatch.test.ts)、[未见扩展](../../../../tests/isolated/unified-agent/extension-unseen.test.ts)和[Files owner](../../../../packages/agent/src/business/file-checkpoints/README.md)。原控制revision与grant仍由[持久权限读集](2026-10-02-persisted-permission-controls-and-dispatch-read-set.md)决定，本记录不替代它。
